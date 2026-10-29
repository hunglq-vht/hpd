# u1 simulator and wire formats

`backend/cmd/u1sim` stands in for u1-track-manager when the dev server sends too little to load the app (on 2026-10-28 it sent about 2,000 tracks in all, against about 100k in central Hanoi alone on 2026-10-26). It serves the same API and the same JSON messages, and also publishes the same tracks in other formats, so formats can be compared under one load.

## Contents

1. [Run it](#run-it)
2. [What it serves](#what-it-serves)
3. [Wire formats](#wire-formats)
4. [Default load](#default-load)
5. [Measurements (2026-10-28)](#measurements-2026-10-28)
6. [Settings](#settings)

---

## Run it

```bash
docker compose --profile u1 up -d nats nats-compressed u1sim   # API :8091, NATS ws :8080 and :8081 (compressed)
cd frontend
npm run dev:u1sim                                                # http://localhost:5173/?lon=105.80&lat=21.03&zoom=14
npm run probe:u1 -- --local --format batch --compressed          # headless measurement, see below
docker compose --profile u1 stop u1sim nats-compressed           # when done: u1sim uses about 2 cores
```

- `npm run dev:u1sim` uses `frontend/.env.u1sim`, so it ignores the real server settings in `.env.u1.local`. `npm run dev:u1` still talks to the real server.
- The toolbar's **Wire** row picks the format and **Plain / Deflate** the transport. Switching reloads the page at the same view, so every run starts with a fresh worker and fresh metrics. The same choice in the URL is `?format=json|batch|binary&compress=1`.
- The Performance panel shows the active wire, the payload after inflating, and decode cost per message and per track.
- Without Docker: run `nats-server -c nats/nats.conf`, `NATS_ROUTE=nats://127.0.0.1:6222 nats-server -c nats/nats-compressed.conf` and `go run ./cmd/u1sim` (from `backend/`).
- The Node mock (`npm run mock:u1`) still works for light tests. It uses the same port 8091, so run one or the other.

## What it serves

| Part | Behaviour |
|---|---|
| `POST /u1-track-manager/tracks/subscriptions/resolve` | Like the dev server on 2026-10-26: the z13 regions the viewport touches, no neighbour ring. `422 SUBSCRIPTION_LIMIT_EXCEEDED` (not a shorter list) over `max_partitions` or `max_cached_tracks`; a refusal on track count reports `partition_count: 0`. `400 partition zoom N not supported (only 13)`. No login: the dev proxy's SSO token is ignored. |
| `GET /u1-track-manager/tracks/regions/stats` | Every non-empty region with its count, as the u1 spec describes (the dev server has not deployed it), so the cluster view works |
| NATS | Every track once per tick in each format in `FORMATS`, each format on its own connections so none waits behind another |
| `nats-compressed` | A second NATS server in the same cluster whose WebSocket (:8081) compresses with permessage-deflate. Same messages, same users. |

Resolve and regions/stats name the JSON subjects. A client of another format swaps the prefix, keeping the region (`u1.track.region.xyz.13.6503.3606` becomes `u1.track.bin.xyz.13.6503.3606`).

## Wire formats

| Format | Subject | One message holds | Per track |
|---|---|---|---|
| `json` | `u1.track.region.xyz.13.<x>.<y>` | one `track.update`, field for field like the dev server on 2026-10-28; a `track.leave` on the old region when a track crosses into another | about 420 B |
| `batch` | `u1.track.batch.xyz.13.<x>.<y>` | `track.batch`: all tracks of the region (the same track objects, at most 2,000 per message) plus `leaves` | about 264 B |
| `binary` | `u1.track.bin.xyz.13.<x>.<y>` | the demo's tile snapshot: 32 B header and 16 B per track ([PROTOCOL.md](PROTOCOL.md)) | 16 B |

```json
{"type":"track.batch","timestamp":1793198912021,"state_updated_at":1793198911825,
 "region":{"scheme":"web_mercator_xyz","zoom":13,"x":6503,"y":3606},
 "tracks":[{"ID":1,"TrackNumber":1,"Altitude":87.5,"Latitude":21.0293,"Longitude":105.79834,"Velocity":11.2,"Heading":92.5,"Quantity":0,"Model":"Simulation Drone","Mode3a":"03-N-3164-OU","Serial":"03-N-3164-OU","UpdatedAt":1793198911,"CreatedAt":0}],
 "leaves":[{"track_id":7,"to_region":{"scheme":"web_mercator_xyz","zoom":13,"x":6504,"y":3606},"updated_at":1793198911}]}
```

The binary format carries no Mode3a, Serial or model text, so the info panel shows less for it.

Latency is measured from `state_updated_at` (the position time) for JSON and from the snapshot header's publish time for binary, so binary figures leave out the encoding time (a few tens of ms).

## Default load

`TRACKS` defaults to 236,000 over five Vietnamese hotspots. Hanoi (190,000) is centred on region 6503.3606 and sized so that once the drones have spread along their routes (about 10 minutes after start) about 100k tracks are in the 15 regions of central Hanoi and about 20k in 6503.3606, as on the dev server on 2026-10-26 (`TestDefaultLoadMatchesDevServer`). Right after start the figures are lower (about 83k and 14k).

## Measurements (2026-10-28)

All on one ThinkPad T480s, which also ran u1sim (about 170 % CPU), NATS (about 80 %) and Docker. Treat the figures as relative.

**Probe** (`npm run probe:u1 -- --local`, central Hanoi, about 85k tracks, 15 s each). Wire bytes were counted by a TCP relay in front of the WebSocket, so they include NATS and WebSocket framing and show what compression saves.

| Format | Wire B/track, plain | Wire B/track, deflate | Central Hanoi needs (plain / deflate) | Arrived (plain / deflate) | Delay p50 (plain / deflate) | Decode µs/track |
|---|---|---|---|---|---|---|
| JSON per track | 473 | 79 | 39 / 6.8 MB/s | 81 % / 54 % | 2.6 / 4.8 s, growing | 9.5 / 12 |
| JSON per region | 264 | 50 | 22 / 4.4 MB/s | 100 % / 98 % | 0.40 / 0.47 s | 4.7 / 4.1 |
| Binary | 16 | 16 | 1.4 / 1.4 MB/s | 100 % / 100 % | 0.06 / 0.08 s | 0.7 / 0.7 |

**App in headless Chrome**, stress test on the 100 densest regions (about 185k tracks, read after 12 s):

| Format | Track updates/s received | Tracks on the map | Latency p50 | Worker busy | fps |
|---|---|---|---|---|---|
| JSON per track (plain / deflate) | 11k / 13k | 34k / 54k | 9.1 / 9.4 s | 34 / 51 % | 60 |
| JSON per region (plain / deflate) | 31k / 42k | 152k / 185k | 7.7 / 7.3 s | 30 / 41 % | 60 |
| Binary (plain / deflate) | 186k–249k | 185k | 0.25 / 0.17 s | 18 / 15 % | 60 |

What they show:

- **Bandwidth.** Against the 2.1 MB/s measured from this laptop to dev.utm.io.vn, only binary carries central Hanoi (1.4 MB/s). Compression cuts JSON 5–6× (per track 6.8 MB/s, per region 4.4 MB/s), still 2–3 times what that link carries.
- **Compression and binary.** Deflate gains nothing on binary: the records are already dense.
- **Client CPU.** One message per track is the costliest to receive: a single client tops out well below 100k messages/s, and deflate makes it worse (inflating every frame). Batching per region halves the per-track cost and removes most per-message overhead; binary costs about 1/13 of JSON per track.
- **Dense views.** In the browser only binary kept up with 185k tracks/s. Both JSON formats fell several seconds behind.

## Settings

`u1sim` environment (`docker-compose.yml` passes `FORMATS` and `TICK_MS` through):

| Variable | Default | Meaning |
|---|---|---|
| `FORMATS` | `json,batch,binary` | Formats to publish; fewer formats cost less CPU |
| `TRACKS` | 236000 | Drones, shared out by the hotspot weights |
| `TICK_MS` | 1000 | Publish interval |
| `PUBLISH_SPREAD_MS` / `PUBLISH_SLICES` | 0 / 20 | Spread a tick's messages over this time in this many steps; 0 sends one burst, like the dev server |
| `PUBLISHERS` | 2 | NATS connections per format |
| `HTTP_ADDR` | `:8091` | API address |
| `NATS_URL` | `nats://backend:backend-secret@127.0.0.1:4222` | Where to publish |
| `JSON_PREFIX` / `BATCH_PREFIX` / `BINARY_PREFIX` | `u1.track.region` / `u1.track.batch` / `u1.track.bin` | Subject prefixes; the frontend reads `VITE_TRACK_SUBJECT_PREFIX`, `VITE_TRACK_BATCH_PREFIX`, `VITE_TRACK_BINARY_PREFIX` |
