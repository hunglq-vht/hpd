// Headless client benchmark over NATS WebSocket, using the *same* decoder and track store as the
// browser worker (src/shared). It measures how much realtime load one client can absorb:
// throughput, decode cost, CPU, event-loop lag and publish->receive latency (clock-corrected).
//
//   node bench/ws-bench.ts                          # tier suite: densest 10/25/50/100/200/400 tiles + firehose
//   node bench/ws-bench.ts --tiles 50 --duration 30 # one tier
//   node bench/ws-bench.ts --firehose               # tracks.> (all 1M tracks)
//   node bench/ws-bench.ts --clients 20 --tiles 50  # fan-out: 20 independent connections
//   node bench/ws-bench.ts --subjects tracks.13.1.2,tracks.13.1.3   # explicit subjects (no API needed)
// Options: --ws ws://localhost:8080  --api http://localhost:8090  --duration 15  --json out.json

import { wsconnect, type Msg, type NatsConnection } from "@nats-io/nats-core";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { TrackStore } from "../src/shared/trackStore.ts";
import { ClockOffset, LatencyWindow } from "../src/shared/metrics.ts";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const WS = opt("ws", "ws://localhost:8080");
const API = opt("api", "http://localhost:8090");
const DURATION = Number(opt("duration", "15"));
const CLIENTS = Number(opt("clients", "1"));
const wall = () => performance.timeOrigin + performance.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Client {
  nc: NatsConnection;
  store: TrackStore;
  lat: LatencyWindow;
  clock: ClockOffset;
  msgs: number;
  tracks: number;
  bytes: number;
  busyMs: number;
  slow: number;
  disconnects: number;
}

async function newClient(): Promise<Client> {
  const nc = await wsconnect({ servers: WS, user: "viewer", pass: "viewer", name: "ws-bench", maxReconnectAttempts: -1 });
  const c: Client = { nc, store: new TrackStore(), lat: new LatencyWindow(), clock: new ClockOffset(), msgs: 0, tracks: 0, bytes: 0, busyMs: 0, slow: 0, disconnects: 0 };
  for (let i = 0; i < 6; i++) {
    try {
      const t0 = wall();
      const r = await nc.request("svc.time", undefined, { timeout: 1000 });
      const t1 = wall();
      c.clock.add(t0, new DataView(r.data.buffer, r.data.byteOffset, 8).getFloat64(0, true), t1);
    } catch {
      if (i === 0) console.warn("svc.time unavailable: assuming synchronised clocks (offset 0)");
      c.clock.offsetMs = 0;
      break;
    }
  }
  (async () => {
    for await (const s of nc.status()) {
      if (s.type === "slowConsumer") c.slow++;
      if (s.type === "disconnect") c.disconnects++;
    }
  })();
  return c;
}

function subscribe(c: Client, subjects: string[]) {
  const t0 = performance.timeOrigin;
  const cb = (err: Error | null, msg: Msg) => {
    if (err) return;
    const recv = wall();
    const t = performance.now();
    const r = c.store.ingest(msg.data, (recv - t0) / 1000);
    if (!r.header) return;
    c.msgs++;
    c.tracks += r.tracks;
    c.bytes += msg.data.byteLength;
    c.lat.add(recv + c.clock.offsetMs - r.header.publishedAt);
    c.busyMs += performance.now() - t;
  };
  return subjects.map((s) => c.nc.subscribe(s, { callback: cb }));
}

interface Row {
  tier: string;
  clients: number;
  tiles: number;
  expectedTracksPerSec: number;
  tracksPerSec: number;
  msgsPerSec: number;
  MBps: number;
  storeUsPerTrack: number;
  cpuPct: number;
  loopLagP99ms: number;
  latP50: number;
  latP95: number;
  latP99: number;
  latMax: number;
  tracksInStore: number;
  slowConsumer: number;
  disconnects: number;
}

async function runTier(tier: string, subjects: string[], expected: number): Promise<Row> {
  const clients = await Promise.all(Array.from({ length: CLIENTS }, newClient));
  const subs = clients.map((c) => subscribe(c, subjects));
  // the worker's frame loop: commit + evict every 33 ms
  const frame = setInterval(() => {
    const now = (wall() - performance.timeOrigin) / 1000;
    for (const c of clients) {
      const t = performance.now();
      c.store.commit(now);
      c.store.evict(now - 1.5);
      c.busyMs += performance.now() - t;
    }
  }, 33);
  await sleep(3000); // warm-up: first snapshots, JIT
  for (const c of clients) {
    c.msgs = c.tracks = c.bytes = c.busyMs = 0;
    c.lat.take();
  }
  const lag = monitorEventLoopDelay({ resolution: 5 });
  lag.enable();
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  await sleep(DURATION * 1000);
  const secs = (performance.now() - t0) / 1000;
  const cpu = process.cpuUsage(cpu0);
  lag.disable();
  clearInterval(frame);

  const sum = (f: (c: Client) => number) => clients.reduce((a, c) => a + f(c), 0);
  const lats = clients.map((c) => c.lat.take());
  const avg = (f: (l: (typeof lats)[0]) => number) => lats.reduce((a, l) => a + f(l), 0) / lats.length;
  const tracks = sum((c) => c.tracks);
  const row: Row = {
    tier,
    clients: CLIENTS,
    tiles: subjects.length,
    expectedTracksPerSec: expected * CLIENTS,
    tracksPerSec: Math.round(tracks / secs),
    msgsPerSec: Math.round(sum((c) => c.msgs) / secs),
    MBps: +(sum((c) => c.bytes) / secs / 1e6).toFixed(2),
    storeUsPerTrack: +((sum((c) => c.busyMs) * 1000) / Math.max(1, tracks)).toFixed(3),
    cpuPct: +(((cpu.user + cpu.system) / 1e6 / secs) * 100).toFixed(1),
    loopLagP99ms: +(lag.percentile(99) / 1e6).toFixed(1),
    latP50: +avg((l) => l.p50).toFixed(1),
    latP95: +avg((l) => l.p95).toFixed(1),
    latP99: +avg((l) => l.p99).toFixed(1),
    latMax: +Math.max(...lats.map((l) => l.max)).toFixed(1),
    tracksInStore: Math.round(sum((c) => c.store.n) / CLIENTS),
    slowConsumer: sum((c) => c.slow),
    disconnects: sum((c) => c.disconnects),
  };
  for (const s of subs.flat()) s.unsubscribe();
  await Promise.all(clients.map((c) => c.nc.close()));
  return row;
}

async function topTiles(n: number) {
  const r = await fetch(`${API}/api/tiles/top?limit=${n}`);
  const j = (await r.json()) as { tiles: { subject: string; count: number }[] };
  return { subjects: j.tiles.map((t) => t.subject), expected: j.tiles.reduce((a, t) => a + t.count, 0) };
}

const rows: Row[] = [];
const print = (r: Row) => {
  rows.push(r);
  console.log(
    `${r.tier.padEnd(12)} tiles=${String(r.tiles).padStart(5)} tracks/s=${String(r.tracksPerSec).padStart(8)} (exp ${r.expectedTracksPerSec}) ` +
      `msgs/s=${String(r.msgsPerSec).padStart(6)} ${String(r.MBps).padStart(6)} MB/s  store=${r.storeUsPerTrack}µs/track cpu=${r.cpuPct}% ` +
      `lag99=${r.loopLagP99ms}ms  latency p50/p95/p99/max=${r.latP50}/${r.latP95}/${r.latP99}/${r.latMax} ms  slow=${r.slowConsumer} disc=${r.disconnects}`,
  );
};

if (argv.includes("--subjects")) {
  const subjects = opt("subjects", "").split(",").filter(Boolean);
  print(await runTier(`explicit-${subjects.length}`, subjects, Number(opt("expected", "0"))));
} else if (argv.includes("--firehose")) {
  const total = ((await (await fetch(`${API}/api/health`)).json()) as { total: number }).total;
  print(await runTier("firehose", ["tracks.>"], total));
} else if (argv.includes("--tiles")) {
  const n = Number(opt("tiles", "50"));
  const t = await topTiles(n);
  print(await runTier(`top-${n}`, t.subjects, t.expected));
} else {
  for (const n of [10, 25, 50, 100, 200, 400]) {
    const t = await topTiles(n);
    print(await runTier(`top-${n}`, t.subjects, t.expected));
  }
  const total = ((await (await fetch(`${API}/api/health`)).json()) as { total: number }).total;
  print(await runTier("firehose", ["tracks.>"], total));
}
const json = opt("json", "");
if (json) writeFileSync(json, JSON.stringify(rows, null, 2));
process.exit(0);
