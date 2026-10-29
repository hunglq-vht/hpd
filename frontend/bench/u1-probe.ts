// Load probe for u1-track-manager, the real one or the local simulator (backend/cmd/u1sim): resolves
// a view, subscribes to every region it returns over NATS WebSocket, and records what actually
// arrives, second by second: messages, track updates, payload and wire bytes, delay, decode time,
// tracks on the map, and the connection events (disconnect, reconnect, slow consumer). It uses the
// app's decoders and track store (src/shared), the worker's NATS options and the settings of
// `npm run dev:u1` (.env.u1 + .env.u1.local).
//
//   npm run probe:u1                                   # real server: central Hanoi, limit 200,000, 30 s
//   npm run probe:u1 -- --limit 4000                   # the app's own limit: central Hanoi is refused
//   npm run probe:u1 -- --bbox 105.752,21.052,105.758,21.068 --duration 60   # one quiet region
//   npm run probe:u1 -- --local --format binary --compressed                # u1sim, binary, deflate
// Options: --duration 30  --limit 200000  --partitions 36  --bbox w,s,e,n  --json path
//          --local (u1sim on :8091, NATS ws :8080 / compressed :8081, no SSO)
//          --format json|batch|binary (batch and binary: u1sim only)  --compressed
// Wire bytes are counted by a local TCP relay in front of a ws:// URL, so they show what compression
// saves; over wss:// (TLS) they are not measured.
// The full timeline goes to bench/out/u1-probe-<time>.json (git-ignored) unless --json is given.
// The delay includes any clock difference between the server and this machine (u1 has no svc.time).

import { wsconnect, type Msg } from "@nats-io/nats-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { dirname } from "node:path";
import { loadEnv } from "vite";
import { createTokenSource } from "../dev/u1-sso.ts";
import type { WireFormat } from "../src/shared/protocol.ts";
import { readResolve, regionCount, type BBox, type ResolveResult } from "../src/shared/regions.ts";
import { mercToLonLat, subjectTileKey, TOPIC_ZOOM } from "../src/shared/tiles.ts";
import { TrackStore } from "../src/shared/trackStore.ts";
import { applyU1Event, REGION_SCHEME } from "../src/shared/u1.ts";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const LOCAL = argv.includes("--local");
const COMPRESSED = argv.includes("--compressed");
const FORMAT = opt("format", "json") as WireFormat;
if (!["json", "batch", "binary"].includes(FORMAT)) throw new Error(`--format must be json, batch or binary, not ${FORMAT}`);
const env = loadEnv("u1", process.cwd(), "");
const need = (k: string) => {
  if (!env[k]) throw new Error(`${k} is not set: put it in .env.u1.local (see docs/U1-STATUS.md, How to run), or use --local`);
  return env[k];
};

const DURATION = Number(opt("duration", "30"));
const LIMIT = Number(opt("limit", "200000"));
const APP_LIMIT = Number(env.VITE_MAX_CACHED_TRACKS || 4000);
const PARTITIONS = Number(opt("partitions", env.VITE_MAX_PARTITIONS || "36"));
const INTERVAL_MS = Number(env.VITE_TRACK_INTERVAL_MS || 1000);
const STALE_S = (INTERVAL_MS / 1000) * Number(env.VITE_TRACK_STALE_FACTOR || 3);
const BASE = env.VITE_TRACK_API_BASE || "/u1-track-manager";
const API = `${LOCAL ? "http://localhost:8091" : need("TRACK_API_URL").replace(/\/$/, "")}${BASE}`;
const WS = LOCAL
  ? COMPRESSED ? "ws://localhost:8081" : "ws://localhost:8080"
  : COMPRESSED ? need("VITE_NATS_WS_URL_COMPRESSED") : need("VITE_NATS_WS_URL");
const NATS_USER = LOCAL ? "viewer" : env.VITE_NATS_USER;
const NATS_PASS = LOCAL ? "viewer" : env.VITE_NATS_PASS;
const TOPIC_PREFIX = env.VITE_TRACK_SUBJECT_PREFIX || "u1.track.region";
const PREFIX = { json: TOPIC_PREFIX, batch: env.VITE_TRACK_BATCH_PREFIX || "u1.track.batch", binary: env.VITE_TRACK_BINARY_PREFIX || "u1.track.bin" }[FORMAT];
const wall = () => performance.timeOrigin + performance.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** Bbox inside z13 regions x0..x1, y0..y1, inset ~10 m so it touches no neighbour. */
function tilesBBox(x0: number, x1: number, y0: number, y1: number): BBox {
  const n = 2 ** TOPIC_ZOOM;
  const [w, north] = mercToLonLat(x0 / n, y0 / n);
  const [e, south] = mercToLonLat((x1 + 1) / n, (y1 + 1) / n);
  const d = 1e-4;
  return [w + d, south + d, e - d, north - d];
}
// central Hanoi: regions 6502..6506 x 3605..3607, which include the densest one (6503.3606)
const bbox: BBox = argv.includes("--bbox") ? (opt("bbox", "").split(",").map(Number) as BBox) : tilesBBox(6502, 6506, 3605, 3607);

// the simulator needs no login
const tokens = LOCAL ? null : createTokenSource({ authUrl: need("U1_AUTH_URL"), username: need("U1_USERNAME"), password: need("U1_PASSWORD") });

async function resolve(maxTracks: number): Promise<{ status: number; result: ResolveResult | null; text: string }> {
  const [west, south, east, north] = bbox;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (tokens) headers.Authorization = `Bearer ${await tokens.token()}`;
  const r = await fetch(`${API}/tracks/subscriptions/resolve`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      viewport: { west, south, east, north },
      map_zoom: TOPIC_ZOOM,
      preferred_partition: { scheme: REGION_SCHEME, zoom: TOPIC_ZOOM },
      limits: { max_partitions: PARTITIONS, max_cached_tracks: maxTracks },
    }),
  });
  const text = await r.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON: reported as text
  }
  return { status: r.status, result: readResolve(r.status, body, bbox), text };
}

const describe = (max: number, r: Awaited<ReturnType<typeof resolve>>) => {
  const head = `resolve, max_cached_tracks ${max}: HTTP ${r.status}`;
  if (!r.result) return `${head} ${r.text.slice(0, 200)}`;
  if (r.result.ok) return `${head}, ${r.result.topics.length} topics, server estimate ${r.result.estimatedTracks} tracks`;
  return `${head} refused on ${r.result.limit} (${r.result.estimatedTracks} tracks in ${r.result.partitions} regions, limit ${r.result.max})`;
};

/** A TCP relay in front of a ws:// URL that counts the bytes the server sends, as they cross the wire. */
async function countingRelay(target: URL) {
  let down = 0;
  const srv = createServer((client) => {
    const server = connect(Number(target.port || 80), target.hostname);
    server.on("data", (d: Buffer) => (down += d.length));
    client.pipe(server);
    server.pipe(client);
    const end = () => {
      client.destroy();
      server.destroy();
    };
    for (const s of [client, server]) s.on("error", end).on("close", end);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  return { url: `ws://127.0.0.1:${port}${target.pathname}`, bytes: () => down, close: () => srv.close() };
}

console.log(`bbox ${bbox.map((v) => v.toFixed(4)).join(",")}: ${regionCount(bbox)} z13 regions; API ${API}; NATS ${WS}; ${FORMAT}${COMPRESSED ? ", compressed" : ""}`);
const resolves: { maxCachedTracks: number; status: number; result: ResolveResult | null }[] = [];
for (const max of LIMIT === APP_LIMIT ? [LIMIT] : [APP_LIMIT, LIMIT]) {
  const r = await resolve(max);
  resolves.push({ maxCachedTracks: max, status: r.status, result: r.result });
  console.log(describe(max, r));
}
const last = resolves[resolves.length - 1].result;
if (!last?.ok || last.topics.length === 0) {
  console.log("nothing to subscribe to: raise --limit or pick a smaller --bbox");
  process.exit(1);
}
// resolve names the JSON subjects; the other formats use the same regions under their own prefix
const topics = last.topics.map((t) => (t.startsWith(`${TOPIC_PREFIX}.`) ? PREFIX + t.slice(TOPIC_PREFIX.length) : t));
const estimate = last.estimatedTracks ?? 0;

interface Second {
  t: number;
  msgs: number;
  tracks: number;
  bytes: number;
  wireBytes: number | null;
  bad: number;
  busyMs: number;
  delays: number[];
  onMap: number;
}
interface Event {
  t: number;
  type: string;
  detail?: string;
}

const store = new TrackStore();
const subKeys = new Set(topics.map(subjectTileKey));
const seconds: Second[] = [];
const events: Event[] = [];
const gaps: { t: number; ms: number }[] = [];
let t0 = 0;
let lastRecv = 0;
const at = (w: number) => +((w - t0) / 1000).toFixed(2);
const second = (w: number) => {
  const i = Math.max(0, Math.floor((w - t0) / 1000));
  for (let k = seconds.length; k <= i; k++) seconds.push({ t: k + 1, msgs: 0, tracks: 0, bytes: 0, wireBytes: null, bad: 0, busyMs: 0, delays: [], onMap: 0 });
  return seconds[i];
};

const target = new URL(WS);
const relay = target.protocol === "ws:" ? await countingRelay(target) : null;
const nc = await wsconnect({
  servers: relay?.url ?? WS,
  user: NATS_USER,
  pass: NATS_PASS,
  name: "u1-probe",
  maxReconnectAttempts: -1,
  reconnectTimeWait: 1000,
  pingInterval: 20_000,
});
console.log(`connected to ${WS}${relay ? " (wire bytes counted by a local relay)" : ""}; subscribing to ${topics.length} topics for ${DURATION} s`);
(async () => {
  for await (const s of nc.status()) {
    if (!t0 || !["disconnect", "reconnecting", "reconnect", "slowConsumer", "error", "staleConnection"].includes(s.type)) continue;
    const e: Event = { t: at(wall()), type: s.type };
    if ("server" in s && s.server) e.detail = String(s.server);
    if ("error" in s && s.error) e.detail = String(s.error);
    events.push(e);
    console.log(`  ${e.t.toFixed(2).padStart(6)} s  ${e.type}${e.detail ? ` ${e.detail}` : ""}`);
  }
})();

/** Decodes one message like the worker does: track updates and publish (or state) time, or null. */
function decode(msg: Msg, now: number): { tracks: number; sentMs: number } | null {
  if (FORMAT === "binary") {
    const r = store.ingest(msg.data, now);
    return r.header ? { tracks: r.tracks, sentMs: r.header.publishedAt } : null;
  }
  const r = applyU1Event(msg.data, subjectTileKey(msg.subject), now, store, (k) => subKeys.has(k));
  return r && { tracks: r.tracks, sentMs: r.type === "track.leave" ? 0 : r.timestampMs };
}

const cb = (err: Error | null, msg: Msg) => {
  if (err) return;
  const recv = wall();
  if (lastRecv && recv - lastRecv > 1.5 * INTERVAL_MS) gaps.push({ t: at(lastRecv), ms: Math.round(recv - lastRecv) });
  lastRecv = recv;
  const t = performance.now();
  const r = decode(msg, t / 1000);
  const s = second(recv);
  s.busyMs += performance.now() - t;
  s.msgs++;
  s.bytes += msg.data.byteLength;
  if (!r) s.bad++;
  else {
    s.tracks += r.tracks;
    if (r.sentMs) s.delays.push(recv - r.sentMs);
  }
};

t0 = wall();
const wire0 = relay?.bytes() ?? 0;
const subs = topics.map((s) => nc.subscribe(s, { callback: cb }));
// the worker's frame loop: commit every 33 ms, drop tracks silent for 3 intervals
const frame = setInterval(() => {
  const t = performance.now();
  store.commit(t / 1000);
  store.evict(t / 1000 - STALE_S);
  second(wall()).busyMs += performance.now() - t;
}, 33);

const pct = (a: number[], p: number) => (a.length ? a[Math.min(a.length - 1, Math.floor((a.length * p) / 100))] : NaN);
const sec = (ms: number) => (Number.isFinite(ms) ? (ms / 1000).toFixed(1) : "-");
const mb = (b: number | null) => (b === null ? "     -" : (b / 1e6).toFixed(2).padStart(6));
console.log("     s   msgs/s  tracks/s  payload MB/s  wire MB/s  delay p50/max (s)   busy   on map");
const cpu0 = process.cpuUsage();
let wirePrev = wire0;
for (let i = 0; i < DURATION; i++) {
  await sleep(t0 + (i + 1) * 1000 - wall());
  const s = second(t0 + i * 1000);
  s.onMap = store.n;
  if (relay) {
    s.wireBytes = relay.bytes() - wirePrev;
    wirePrev += s.wireBytes;
  }
  const d = [...s.delays].sort((a, b) => a - b);
  console.log(
    `${String(s.t).padStart(6)} ${String(s.msgs).padStart(8)} ${String(s.tracks).padStart(9)}        ${mb(s.bytes)}     ${mb(s.wireBytes)}   ` +
      `${`${sec(pct(d, 50))} / ${sec(d[d.length - 1])}`.padEnd(18)} ${`${Math.round(s.busyMs / 10)}%`.padStart(5)} ${String(s.onMap).padStart(8)}`,
  );
}
const cpu = process.cpuUsage(cpu0);
clearInterval(frame);
for (const s of subs) s.unsubscribe();
await nc.close();
relay?.close();

const run = seconds.slice(0, DURATION);
const total = (f: (s: Second) => number) => run.reduce((a, s) => a + f(s), 0);
const msgs = total((s) => s.msgs);
const tracks = total((s) => s.tracks);
const bytes = total((s) => s.bytes);
const wire = relay ? total((s) => s.wireBytes ?? 0) : null;
const delays = run.flatMap((s) => s.delays).sort((a, b) => a - b);
const expected = (estimate * DURATION * 1000) / INTERVAL_MS;
const count = (type: string) => events.filter((e) => e.type === type).length;
const disconnects = events.filter((e) => e.type === "disconnect").map((e) => e.t);
const summary = {
  format: FORMAT,
  compressed: COMPRESSED,
  regions: topics.length,
  serverEstimateTracks: estimate,
  expectedTrackUpdates: Math.round(expected),
  receivedTrackUpdates: tracks,
  arrivedPct: expected ? +((tracks / expected) * 100).toFixed(1) : null,
  receivedMsgs: msgs,
  rejectedMsgs: total((s) => s.bad),
  payloadBytesPerTrack: tracks ? +(bytes / tracks).toFixed(1) : 0,
  wireBytesPerTrack: wire !== null && tracks ? +(wire / tracks).toFixed(1) : null,
  avgPayloadMBps: +(bytes / DURATION / 1e6).toFixed(2),
  avgWireMBps: wire !== null ? +(wire / DURATION / 1e6).toFixed(2) : null,
  peakWireMBps: relay ? +(Math.max(...run.map((s) => s.wireBytes ?? 0)) / 1e6).toFixed(2) : null,
  fullFeedWireMBps: wire !== null && tracks ? +((estimate * (wire / tracks)) / (INTERVAL_MS / 1000) / 1e6).toFixed(2) : null,
  delayP50s: +(pct(delays, 50) / 1000).toFixed(2),
  delayP95s: +(pct(delays, 95) / 1000).toFixed(2),
  delayMaxS: +((delays[delays.length - 1] ?? NaN) / 1000).toFixed(2),
  disconnects: count("disconnect"),
  reconnects: count("reconnect"),
  slowConsumer: count("slowConsumer"),
  secondsBetweenDisconnects: disconnects.slice(1).map((t, i) => +(t - disconnects[i]).toFixed(1)),
  gapsOver1_5Intervals: gaps,
  decodeUsPerTrack: tracks ? +((total((s) => s.busyMs) * 1000) / tracks).toFixed(2) : 0,
  decodeBusyAvgPct: +(total((s) => s.busyMs) / DURATION / 10).toFixed(1),
  decodeBusyPeakPct: Math.round(Math.max(...run.map((s) => s.busyMs)) / 10),
  processCpuPct: +((cpu.user + cpu.system) / 1e3 / DURATION / 10).toFixed(1),
};

console.log(`
${tracks} of about ${summary.expectedTrackUpdates} track updates arrived (${summary.arrivedPct}%) in ${msgs} messages, ${summary.rejectedMsgs} rejected by the decoder
payload: ${summary.payloadBytesPerTrack} B per track, average ${summary.avgPayloadMBps} MB/s
wire:    ${wire === null ? "not measured (TLS)" : `${summary.wireBytesPerTrack} B per track, average ${summary.avgWireMBps} MB/s, peak second ${summary.peakWireMBps} MB/s; the full feed of ${estimate} tracks needs about ${summary.fullFeedWireMBps} MB/s`}
delay: p50 ${summary.delayP50s} s, p95 ${summary.delayP95s} s, max ${summary.delayMaxS} s
connection: ${summary.disconnects} disconnects, ${summary.reconnects} reconnects, ${summary.slowConsumer} slow-consumer events; seconds between disconnects: ${summary.secondsBetweenDisconnects.join(", ") || "-"}
gaps over 1.5 intervals: ${gaps.map((g) => `${g.ms} ms at ${g.t} s`).join(", ") || "none"}
this process: decode + store ${summary.decodeUsPerTrack} µs per track, busy ${summary.decodeBusyAvgPct}% on average (peak second ${summary.decodeBusyPeakPct}%), CPU ${summary.processCpuPct}% of one core`);

const out = opt("json", `bench/out/u1-probe-${FORMAT}${COMPRESSED ? "-z" : ""}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify(
    {
      at: new Date(t0).toISOString(),
      api: API,
      nats: WS,
      bbox,
      durationS: DURATION,
      resolves,
      summary,
      events,
      seconds: run.map(({ delays: d, ...s }) => {
        const sorted = [...d].sort((a, b) => a - b);
        return { ...s, busyMs: Math.round(s.busyMs), delayP50ms: Math.round(pct(sorted, 50)), delayMaxMs: Math.round(sorted[sorted.length - 1] ?? NaN) };
      }),
    },
    null,
    2,
  ),
);
console.log(`timeline written to ${out}`);
process.exit(0);
