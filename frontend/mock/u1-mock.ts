// Local stand-in for u1-track-manager, so the u1 path of the app runs without the real backend.
//   GET  /u1-track-manager/tracks/regions/stats
//   POST /u1-track-manager/tracks/subscriptions/resolve
//   NATS u1.track.region.xyz.13.<x>.<y>: one JSON track.update per track per tick, and a track.leave
//        on the old region when a track crosses into another one
// It publishes over NATS WebSocket as the `backend` user, so only the nats container is needed:
//   docker compose up -d nats
//   npm run mock:u1 -- --tracks 3000      # options: --port 8091 --ws ws://localhost:8080 --tick 1000
//   npm run dev:u1                         # http://localhost:5173/?lon=105.84&lat=21.03&zoom=14

import { createServer, type IncomingMessage } from "node:http";
import { wsconnect, type NatsConnection } from "@nats-io/nats-core";
import { lonLatToMerc, mercPerMeter, mercToLonLat, tileXY, TOPIC_ZOOM } from "../src/shared/tiles.ts";
import { REGION_SCHEME, type U1Event, type U1Region } from "../src/shared/u1.ts";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const TRACKS = Number(opt("tracks", "3000"));
const PORT = Number(opt("port", "8091"));
const WS = opt("ws", "ws://localhost:8080");
const TICK_MS = Number(opt("tick", "1000"));
const PREFIX = opt("prefix", "u1.track.region");
const BASE = "/u1-track-manager";

// tracks fly around these centres, within r metres
const CENTRES = [
  { lon: 105.8342, lat: 21.0278, r: 15000 }, // Hanoi
  { lon: 106.6297, lat: 10.8231, r: 20000 }, // Ho Chi Minh City
  { lon: 108.2022, lat: 16.0544, r: 8000 }, // Da Nang
];
const MODELS = ["quadcopter", "quadcopter", "hexacopter", "aircraft"];

let seed = 42;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
const subject = (x: number, y: number) => `${PREFIX}.xyz.${TOPIC_ZOOM}.${x}.${y}`;
const region = (x: number, y: number): U1Region => ({ scheme: REGION_SCHEME, zoom: TOPIC_ZOOM, x, y });

const createdAt = Math.floor(Date.now() / 1000);
const tracks = Array.from({ length: TRACKS }, (_, i) => {
  const c = CENTRES[i % CENTRES.length];
  const [cx, cy] = lonLatToMerc(c.lon, c.lat);
  const k = mercPerMeter(cy);
  const a = rnd() * 2 * Math.PI;
  const d = Math.sqrt(rnd()) * c.r;
  const mx = cx + Math.sin(a) * d * k;
  const my = cy - Math.cos(a) * d * k;
  const [x, y] = tileXY(TOPIC_ZOOM, mx, my);
  return {
    id: i + 1, cx, cy, r: c.r, mx, my, x, y,
    heading: rnd() * 360, // degrees, clockwise from north
    speed: 8 + rnd() * 40, // m/s
    alt: 50 + rnd() * 400,
    model: MODELS[i % MODELS.length],
    // octal digits; one track in 500 squawks the emergency code
    mode3a: i % 500 === 0 ? "7700" : Array.from({ length: 4 }, () => Math.floor(rnd() * 8)).join(""),
  };
});

const counts = new Map<string, number>(); // region subject -> tracks, for regions/stats
let nc: NatsConnection | null = null;
let published = 0;

function publish(subj: string, ev: U1Event) {
  if (!nc || nc.isClosed()) return;
  nc.publish(subj, JSON.stringify(ev));
  published++;
}

function tick() {
  const dt = TICK_MS / 1000;
  const now = Math.floor(Date.now() / 1000);
  counts.clear();
  for (const t of tracks) {
    const k = mercPerMeter(t.my);
    const east = (t.mx - t.cx) / k;
    const south = (t.my - t.cy) / k;
    t.heading =
      Math.hypot(east, south) > t.r
        ? ((Math.atan2(-east, south) * 180) / Math.PI + 360) % 360 // head back towards the centre
        : (t.heading + (rnd() - 0.5) * 20 + 360) % 360;
    const h = (t.heading * Math.PI) / 180;
    t.mx += Math.sin(h) * t.speed * dt * k;
    t.my -= Math.cos(h) * t.speed * dt * k;

    const [x, y] = tileXY(TOPIC_ZOOM, t.mx, t.my);
    if (x !== t.x || y !== t.y) {
      publish(subject(t.x, t.y), {
        type: "track.leave", timestamp: now, region: region(t.x, t.y),
        leave: { track_id: t.id, to_region: region(x, y), updated_at: now },
      });
      t.x = x;
      t.y = y;
    }
    const [lon, lat] = mercToLonLat(t.mx, t.my);
    const subj = subject(x, y);
    publish(subj, {
      type: "track.update", timestamp: now, region: region(x, y),
      track: {
        ID: t.id, TrackNumber: t.id, Latitude: round(lat, 6), Longitude: round(lon, 6),
        Velocity: round(t.speed, 1), Altitude: round(t.alt, 1), Heading: round(t.heading, 1),
        Model: t.model, Mode3a: t.mode3a, UpdatedAt: now, CreatedAt: createdAt,
      },
    });
    counts.set(subj, (counts.get(subj) ?? 0) + 1);
  }
}

interface ResolveBody {
  viewport: { west: number; south: number; east: number; north: number };
  preferred_partition?: { scheme?: string; zoom?: number };
  limits?: { max_partitions?: number; max_cached_tracks?: number };
}

/**
 * Like the dev server (checked 2026-10-26): the viewport's z13 regions only (no neighbour ring), or
 * HTTP 422 when they exceed max_partitions or hold more than max_cached_tracks; only zoom 13.
 */
function resolve({ viewport: v, preferred_partition: p, limits }: ResolveBody): [status: number, body: unknown] {
  if (p?.zoom !== undefined && p.zoom !== TOPIC_ZOOM)
    return [400, { code: 400, message: `partition zoom ${p.zoom} not supported (only ${TOPIC_ZOOM})` }];
  const [x0, y0] = tileXY(TOPIC_ZOOM, ...lonLatToMerc(v.west, v.north));
  const [x1, y1] = tileXY(TOPIC_ZOOM, ...lonLatToMerc(v.east, v.south));
  const topics: string[] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) topics.push(subject(x, y));
  const estimated = topics.reduce((sum, t) => sum + (counts.get(t) ?? 0), 0);
  const maxPartitions = limits?.max_partitions ?? 36;
  const maxTracks = limits?.max_cached_tracks ?? 4000;
  const refuse = (limit: string, message: string, applied: object, partitions: number): [number, unknown] => [
    422,
    { code: "SUBSCRIPTION_LIMIT_EXCEEDED", limit, limits_applied: applied, message: `SUBSCRIPTION_LIMIT_EXCEEDED: ${message}`, required: { estimated_cached_tracks: estimated, partition_count: partitions } },
  ];
  if (topics.length > maxPartitions)
    return refuse("max_partitions", `partition_count ${topics.length} exceeds max_partitions ${maxPartitions} (estimated tracks ${estimated})`, { max_cached_tracks: 0, max_partitions: maxPartitions }, topics.length);
  if (estimated > maxTracks)
    return refuse("max_cached_tracks", `estimated_cached_tracks ${estimated} exceeds max_cached_tracks ${maxTracks}`, { max_cached_tracks: maxTracks, max_partitions: 0 }, 0);
  return [
    200,
    {
      effective_partition: { scheme: REGION_SCHEME, zoom: TOPIC_ZOOM, x: 0, y: 0 },
      viewport_with_buffer: v,
      partition_count: topics.length,
      estimated_cached_tracks: estimated,
      topics,
      resolved_at: Math.floor(Date.now() / 1000),
    },
  ];
}

async function readJSON<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

createServer(async (req, res) => {
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method === "GET" && req.url === `${BASE}/tracks/regions/stats`)
      return send(200, { regions: [...counts].map(([topic, n]) => ({ topic, active_track_count: n })) });
    if (req.method === "POST" && req.url === `${BASE}/tracks/subscriptions/resolve`)
      return send(...resolve(await readJSON<ResolveBody>(req)));
    send(404, { error: `no route for ${req.method} ${req.url}` });
  } catch (e) {
    send(400, { error: String(e) });
  }
}).listen(PORT, () => console.log(`u1 mock: http://localhost:${PORT}${BASE}, ${TRACKS} tracks every ${TICK_MS} ms`));

// The client's own first-connect retry (waitOnFirstConnect) never recovered when NATS started
// after the mock, so retry here and say why nothing is published. Later drops reconnect by themselves.
async function connectNats() {
  for (let warned = false; ; warned = true) {
    try {
      nc = await wsconnect({ servers: WS, user: opt("user", "backend"), pass: opt("pass", "backend-secret"), name: "u1-mock", maxReconnectAttempts: -1 });
      console.log(`u1 mock: publishing to ${WS} as ${PREFIX}.xyz.13.<x>.<y>`);
      return;
    } catch (e) {
      const why = (e as Error).message ? ` (${(e as Error).message})` : "";
      if (!warned) console.error(`u1 mock: cannot reach NATS at ${WS}${why}. Start it with "docker compose up -d nats"; retrying every 2 s`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
void connectNats();

tick();
setInterval(tick, TICK_MS);
setInterval(() => {
  const state = nc ? `${(published / 10).toFixed(0)} msgs/s` : `waiting for NATS at ${WS}`;
  console.log(`u1 mock: ${state}, ${counts.size} regions`);
  published = 0;
}, 10_000);
