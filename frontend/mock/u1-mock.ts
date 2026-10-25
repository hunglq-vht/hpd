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
  limits?: { max_partitions?: number };
}

/** The viewport's z13 regions plus one ring, nearest to the centre first, capped at max_partitions. */
function resolve({ viewport: v, limits }: ResolveBody): string[] {
  const [x0, y0] = tileXY(TOPIC_ZOOM, ...lonLatToMerc(v.west, v.north));
  const [x1, y1] = tileXY(TOPIC_ZOOM, ...lonLatToMerc(v.east, v.south));
  const max = 2 ** TOPIC_ZOOM - 1;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const tiles: [number, number][] = [];
  for (let x = Math.max(0, x0 - 1); x <= Math.min(max, x1 + 1); x++)
    for (let y = Math.max(0, y0 - 1); y <= Math.min(max, y1 + 1); y++) tiles.push([x, y]);
  tiles.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
  return tiles.slice(0, limits?.max_partitions ?? 36).map(([x, y]) => subject(x, y));
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
      return send(200, { topics: resolve(await readJSON<ResolveBody>(req)) });
    send(404, { error: `no route for ${req.method} ${req.url}` });
  } catch (e) {
    send(400, { error: String(e) });
  }
}).listen(PORT, () => console.log(`u1 mock: http://localhost:${PORT}${BASE}, ${TRACKS} tracks every ${TICK_MS} ms`));

wsconnect({ servers: WS, user: opt("user", "backend"), pass: opt("pass", "backend-secret"), name: "u1-mock", maxReconnectAttempts: -1, waitOnFirstConnect: true })
  .then((c) => {
    nc = c;
    console.log(`u1 mock: publishing to ${WS} as ${PREFIX}.xyz.13.<x>.<y>`);
  })
  .catch((e) => console.error(`u1 mock: NATS ${WS}: ${e}`));

tick();
setInterval(tick, TICK_MS);
setInterval(() => {
  console.log(`u1 mock: ${(published / 10).toFixed(0)} msgs/s, ${counts.size} regions`);
  published = 0;
}, 10_000);
