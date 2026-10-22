# Performance: the frontend listening to NATS

All numbers were measured on one laptop that ran the whole stack at once: the 1M-drone simulator,
NATS, the tile monitor and the client.

| | |
|---|---|
| Machine | ThinkPad T480s: Intel i5-8350U (4 cores / 8 threads, 1.7 GHz), 16 GB RAM, Intel UHD 620 (integrated) |
| Backend | Docker Desktop (WSL2 VM, 8 vCPU / 8 GB): `nats:2.12-alpine`, Go 1.26 simulator + tile monitor |
| Browser | Chrome (headless, real GPU via ANGLE/Direct3D11), 1600×900 viewport |
| Load | 1 000 000 drones, 1 Hz, about 45 400 non-empty z13 tiles, 17.5 MB/s published |

How to reproduce (stack running with `docker compose up -d`, from `frontend/`):
```bash
node bench/ws-bench.ts                   # Node client tiers: densest 10..400 tiles + firehose
node bench/ws-bench.ts --clients 10 --tiles 10      # fan-out
node bench/browser-bench.ts perf --url http://localhost:3000   # the real app in Chrome
node bench/browser-bench.ts smoke --url http://localhost:3000  # screenshots of every mode
```
The browser numbers come from `window.__perf`, the same counters the in-app **Performance** HUD
shows. Latency is publish→receive, corrected for the clock offset measured over the `svc.time`
request/reply service (NTP style, lowest-RTT sample).

## 1. What a real viewport costs (the expected case)

The real app in Chrome. The viewport is 1600×900 and the prefetch margin is given per side, as a
fraction of the viewport.

| Scenario | Subscriptions | Tracks/s | Payload | Worker busy | Latency p50 / p99 | Render | GPU upload |
|---|---:|---:|---:|---:|---:|---:|---:|
| Tokyo z14, margin ½ | 20 | 20 300 | 0.32 MB/s | 1.0 % | 29 / 43 ms | 56 fps | 0.30 ms |
| Tokyo z13, margin ½ | 35 | 24 400 | 0.39 MB/s | 1.2 % | 33 / 52 ms | 55 fps | 0.29 ms |
| Singapore z13, margin 1 | 66 | 22 300 | 0.36 MB/s | 1.3 % | 40 / 65 ms | 55 fps | 0.31 ms |
| Singapore z13, margin 2 | 170 | 22 700 | 0.37 MB/s | 1.3 % | 45 / 72 ms | 56 fps | 0.29 ms |

* Even over the densest city (Singapore holds the hottest z13 tile, about 4 600 drones), one viewport
  plus its prefetch ring is around **20–25 k tracks/s, about 0.4 MB/s and about 1 % of one core**.
  Render rate stays at vsync (the integrated GPU tops out at about 56 fps in headless Chrome).
* Larger prefetch margins add subscriptions and messages but few tracks here: at z13 a margin of 2
  already covers all of Singapore's about 22 k drones. In a continuous megacity a margin of 2 means
  5× the area, so 5× the tracks.
* Decode cost in the worker is 0.26–0.43 µs per track, which is 50–260 µs per tile message of 150–1 000 tracks.

## 2. Ceiling of one browser client (stress tiers)

The app's **Stress test** selector ignores the viewport and subscribes to the N densest tiles, or to
`tracks.>`.

| Stress tier | Tracks in memory | Tracks/s received | Payload | Worker busy | Latency p50 / p99 | Render | GPU upload / frame |
|---|---:|---:|---:|---:|---:|---:|---:|
| densest 100 tiles | 216–220 k | 216–219 k | 3.5 MB/s | 17 % | 42–54 / 97–119 ms | 52 fps | 1.7–2.0 ms |
| densest 200 tiles | 331–334 k | 330–333 k | 5.3 MB/s | 23 % | 92–106 / 200–221 ms | 47 fps | 2.7 ms |
| densest 400 tiles | 440–470 k | 413–471 k | 6.6–7.5 MB/s | 29–34 % | **0.5–1.3 s** / 0.8–1.6 s | 39–40 fps | **50–61 ms** |
| densest 1000 tiles | 633 k | 442 k (of ~630 k) | 7.1 MB/s | 40 % | 5.2 s (backlog) | 39 fps | 66 ms |
| firehose `tracks.>` (1 M) | ~400 k | 240 k (of 1 M) | 4.2 MB/s | 46 % | 5.5 s, then **disconnected as slow consumer** | 43 fps | 12 ms |

**Reading it:** on this 2017 ultrabook one browser tab sustains about **300 k track updates/s** with
interactive frame rates (≥ 45 fps) and p99 latency ≈ 200 ms. That is **more than 10× the realistic
per-viewport load** in section 1. Above about 400 k/s the client falls behind. The first limits are:

1. **The integrated GPU.** Re-uploading and drawing about 470 k instances (36 B each, about 17 MB per
   refresh) makes the UI thread wait for the GPU: `bufferSubData` jumps from about 3 ms to about 55
   ms. Buffer orphaning and chunked uploads did not change this. It is a hardware limit, not an
   API-usage problem.
2. **WebSocket + NATS protocol parsing in the worker.** At 43 k msgs/s (firehose) the worker's own
   decode code is only about 46 % busy, yet messages arrive at a quarter of the published rate. The
   rest of the thread goes to Chrome's WebSocket delivery, `nats-core` parsing and GC.
3. **Protection works as designed.** When a tab cannot keep up, NATS drops it as a slow consumer
   (`max_pending: 64MB`, see `/varz` → `slow_consumers`) instead of buffering without limit. The
   client reconnects and resubscribes automatically.

## 3. The same client code in Node (no rendering)

`bench/ws-bench.ts` runs `src/shared/trackStore.ts` (the worker's decoder and store) over a NATS
WebSocket, connected directly to `ws://localhost:8080` from Windows. This is the cost of
listening alone, without rendering.

| Tier | Tiles | Tracks/s | Msgs/s | MB/s | Store cost | Process CPU | Event-loop lag p99 | Latency p50 / p95 / p99 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| densest 10 | 10 | 39 765 | 10 | 0.64 | 0.81 µs/track | 4.3 % | 21 ms | 22 / 52 / 60 ms |
| densest 25 | 25 | 82 409 | 25 | 1.32 | 0.95 µs | 10.4 % | 21 ms | 21 / 49 / 58 ms |
| densest 50 | 50 | 140 697 | 50 | 2.25 | 0.99 µs | 18.9 % | 23 ms | 24 / 54 / 66 ms |
| densest 100 | 100 | 223 761 | 100 | 3.58 | 0.81 µs | 26.1 % | 24 ms | 18 / 57 / 71 ms |
| densest 200 | 200 | 334 466 | 200 | 5.36 | 0.82 µs | 34.5 % | 29 ms | 19 / 55 / 70 ms |
| densest 400 | 400 | 458 592 | 400 | 7.35 | 0.81 µs | 48.1 % | 51 ms | 20 / 58 / 71 ms |
| **firehose** | `tracks.>` | **999 837** | 43 286 | 17.38 | 0.56 µs | 67.6 % | 517 ms | 47 / 127 / 162 ms |
| firehose via nginx `/nats` | `tracks.>` | 1 005 727 | 42 610 | 17.46 | 0.62 µs | 72.9 % | 427 ms | 50 / 129 / 159 ms |

* "Store cost" is decode, id→slot lookup, interpolation commit and eviction, averaged per track. At
  about 0.6–1 µs per track, one core could absorb over 1 M track updates per second. The decoder is
  not the bottleneck.
* A headless consumer (recorder, analytics, a server-side gateway) can take the **entire 1M/s
  firehose** on one core. The nginx WebSocket proxy adds almost nothing.

### Fan-out (server side)

30 WebSocket clients (3 processes × 10), each subscribed to the 10 densest tiles (40 k tracks/s each):

| Aggregate tracks/s delivered | WS egress | NATS CPU | Latency p50 / p99 | Slow consumers |
|---:|---:|---:|---:|---:|
| 1.19 M | 19 MB/s (+17.5 MB/s ingest, +17.5 MB/s to the monitor) | 1.15 cores | 47–50 / 118–125 ms | 0 |

Latency rises here because 3 client processes, NATS, the simulator and the monitor all share 4
physical cores. In production the clients are on other machines.

## 4. Backend numbers

| Component | Measurement |
|---|---|
| Simulator tick, 1 M drones (Go benchmark, 8 threads) | move 81 ms, radix sort by tile 9 ms, parallel gather 9 ms. The first naive version took 312 ms (single-threaded encode was 228 ms) |
| Simulator in Docker (4 move threads, paced publish) | move ≈ 215 ms, sort ≈ 10 ms, gather ≈ 14 ms, publish spread over 600 ms; ≈ 810 ms of each 1 s tick |
| Published | ≈ 45 400 messages and 17.46 MB per tick (16 B per track + 32 B per message) |
| Tile monitor | 1.15 M tracks/s and 51 k msgs/s consumed. 4×4 sub-cell sums per tile, z15→z0 pyramid rebuilt every second (≈ 100–150 ms). Publish→monitor latency p50 8.6 ms / p99 14.7 ms |
| Images | simulator 9.4 MB, api 10.3 MB (static binaries on `scratch`), web 101 MB (nginx + assets) |

### Latency lesson: do not publish a tick as one burst

Client latency (densest 20 tiles, Node client in the Docker network) as the publisher changed:

| Publisher | Monitor | Latency p50 / p99 |
|---|---|---:|
| 1 connection, 17.5 MB burst per tick | on | 58 / 85 ms (Windows host) |
| 4 connections, burst (publish loop 168 → 17 ms) | on | 149 / 240 ms |
| 4 connections, burst | **off** | 64 / 130 ms |
| **4 connections, 20 slices over 600 ms, monitor aggregates outside its lock** | on | **14 / 59 ms** |

Publishing faster made latency worse: the burst only moves into socket and server buffers. Each
inbound connection is processed by one server goroutine, and the monitor's single `tracks.13.>`
subscription is a serialization point that every message must pass through. Pacing (which is what
independent real producers do anyway) removed the queueing. A production monitor should be
sharded, with a queue group or per-region subscriptions.

## 5. Capacity model

```
client bandwidth  ≈ tracks_in_subscribed_tiles × (16 B × rate) + messages × (32 B + ~40 B NATS/WS framing)
client CPU        ≈ tracks/s × ~0.5–1 µs  (decode + store)  + WebSocket/NATS parsing
GPU upload        ≈ tracks × 36 B × refreshes/s  (worker caps refreshes at ~50 MB/s)
server egress     ≈ Σ clients' bandwidth   (fan-out: a hot tile is sent once per subscriber)
```

A dense-city viewport is ≈ 25 k tracks/s ≈ 0.4 MB/s. 1 000 such viewers need ≈ 400 MB/s of
egress, which is the case for leaf nodes or gateways near the users (see `ASSESSMENT.md`).

## 6. Recommendations from the measurements

1. **Enforce a per-client budget** (for example 100 k tracks/s). `/api/topics` already returns
   `expectedTracks`. Stay in cluster mode, or switch to finer/LOD topics, when the viewport would
   exceed the budget.
2. **Shrink GPU traffic** for very dense views: upload only changed instances, pack the instance to 24
   B (half floats for heading and altitude), or keep positions in a texture.
3. **Pace producers and shard consumers** (see the latency lesson above).
4. Keep WebSocket compression off. The binary format is already compact, and compression would cost
   CPU on both ends.
