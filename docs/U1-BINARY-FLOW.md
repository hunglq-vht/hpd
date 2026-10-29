# Reading guide: the binary track path

This guide follows one tick of drone positions in the **binary** wire format, from the simulator to the icons on the map. In this format every message is a batch: all the tracks inside one z13 region, as 16-byte records behind a 32-byte header ([PROTOCOL.md](PROTOCOL.md) section 3). It is the format that kept up with 185k tracks in the browser ([U1-SIM.md](U1-SIM.md#measurements-2026-10-28)).

Read the steps in order. Each one names the file, the functions to read, and what to notice there. Functions are named instead of line numbers, so search for them.

## Contents

1. [The path at a glance](#the-path-at-a-glance)
2. [Run it while you read](#run-it-while-you-read)
3. [Step 1: the contract](#step-1-the-contract)
4. [Step 2: the simulator tick](#step-2-the-simulator-tick)
5. [Step 3: records are encoded while drones move](#step-3-records-are-encoded-while-drones-move)
6. [Step 4: one message per region](#step-4-one-message-per-region)
7. [Step 5: NATS in the middle](#step-5-nats-in-the-middle)
8. [Step 6: which regions to subscribe to](#step-6-which-regions-to-subscribe-to)
9. [Step 7: receiving in the worker](#step-7-receiving-in-the-worker)
10. [Step 8: decoding into the track table](#step-8-decoding-into-the-track-table)
11. [Step 9: building a GPU frame](#step-9-building-a-gpu-frame)
12. [Step 10: drawing](#step-10-drawing)
13. [Step 11: measuring and testing](#step-11-measuring-and-testing)
14. [Questions to check your reading](#questions-to-check-your-reading)

---

## The path at a glance

```
u1sim (Go, in Docker)
  tick loop                    backend/cmd/u1sim/main.go         once per TICK_MS
  Fleet.Step                   backend/internal/sim/fleet.go     move drones, write each one's 16 B record
  Publisher.Publish            backend/internal/sim/publish.go   group by region, one message per region,
                                                                 stamp publishedAt, nc.Publish
      |  subject u1.track.bin.xyz.13.<x>.<y>, TCP :4222
      v
NATS                           nats/nats.conf                    fan-out to subscribers, WebSocket :8080
      |  WebSocket (dev: Vite proxies /nats to ws://localhost:8080)
      v
Web Worker                     frontend/src/worker/tracks.worker.ts
  onMsg -> TrackStore.ingest   frontend/src/shared/trackStore.ts  records into "pending" fields
  frameLoop -> commit          start a glide segment per updated track, write the GPU instance buffer
  postFrame                    transfer that buffer to the UI thread
      |  postMessage with a transferable ArrayBuffer
      v
UI thread                      frontend/src/map/tracking.ts, TrackLayer.ts, DroneLayer.tsx
  TrackLayer.setFrame/upload   one bufferSubData per frame
  TrackLayer.render            one instanced draw call; the vertex shader moves each icon over time
```

The subjects come from the UI thread too: `ViewportSync` asks the API which regions cover the view and sends the list to the worker ([step 6](#step-6-which-regions-to-subscribe-to)).

## Run it while you read

```bash
FORMATS=binary docker compose --profile u1 up -d nats u1sim   # binary only: the sim needs less CPU
cd frontend
npm run dev:u1sim
# open http://localhost:5173/?format=binary&lon=105.80&lat=21.03&zoom=14
```

In PowerShell, set the variable first: `$env:FORMATS='binary'; docker compose --profile u1 up -d nats u1sim`.

Keep the Performance panel open. `docker compose logs -f u1sim` prints, every 10 ticks, how many messages and MB each format sent and how long it took.

## Step 1: the contract

Read:
- [PROTOCOL.md](PROTOCOL.md) section 3
- [backend/internal/wire/wire.go](../backend/internal/wire/wire.go): `PutHeader`, `PutRecord`, `ParseHeader`
- [frontend/src/shared/wire.ts](../frontend/src/shared/wire.ts): `readHeader`, and `encodeSnapshot` (the test helper that writes what the Go side writes)

Notice:
- The Go writer and the TypeScript reader use the same offsets, little-endian. `publishedAt` is a float64 of Unix ms at offset 16.
- A message holds **every** track in the region at tick `seq`. It is a snapshot, not a delta, so a lost message costs one tick, and a drone that crosses a region edge simply shows up in the neighbour's next message.
- `MaxRecordsPerMsg = 65000` keeps a message under NATS' `max_payload: 1MB`. A bigger region is split, and `part`/`parts` number the pieces.
- Positions are tile-local u16 (`lx`, `ly`, about 7.5 cm at z13). That is how a full track fits in 16 bytes.

## Step 2: the simulator tick

Read [backend/cmd/u1sim/main.go](../backend/cmd/u1sim/main.go): `main`, the `FORMATS` switch, then the `for ticks := 1; ; ticks++` loop.

Notice:
- `case u1.FormatBinary`: the binary format reuses the demo's `sim.Publisher` unchanged. Only `SubjectOf` differs. It names the subject with `u1.Subject`, which gives `u1.track.bin.xyz.13.<x>.<y>`.
- `connect` opens `PUBLISHERS` (default 2) NATS connections per format.
- Each tick runs `fleet.Step`, then `tracker.Update` (region counts for the HTTP API, and the JSON formats), then one goroutine per format. For binary, that goroutine calls `p.bin.Publish(fleet)`.
- "tick overran its interval" in the log means the tick took longer than `TICK_MS`. The Go ticker then drops ticks rather than queueing them.

## Step 3: records are encoded while drones move

Read [backend/internal/sim/fleet.go](../backend/internal/sim/fleet.go): the `Fleet` struct (`Keys`, `Rec`), `Step`, and the end of `stepOne`.

Notice:
- `Step` splits the drones across `WORKERS` goroutines.
- At the end of `stepOne`, each drone writes its region into `Keys[i]` (`tileKey<<32 | index`) and its finished 16-byte record into `Rec[i*16:]` with `wire.PutRecord`. Encoding happens here, in parallel. The publisher later only copies bytes.
- The quantisation helpers are in wire.go: `LocalUint16` (position), `Sat16` (altitude, speed), `EncodeHeading`.

## Step 4: one message per region

Read [backend/internal/sim/publish.go](../backend/internal/sim/publish.go): `Publisher.Publish`, then `radixSort`, `gather` and `publishBatch`.

`Publish` runs four phases, timed in `TickStats`:

| Phase | Code | What it does |
|---|---|---|
| Sort | `radixSort(f.Keys)` | Sorts a copy of `Keys` by region in two 13-bit passes. It is stable, so drones keep their order inside a region. |
| Split | the loop that fills `p.runs` | Each run of equal keys becomes a `msgRun`, split in parts above 65,000 records. `lastSeq` finds regions that just became empty and adds one empty message for each. |
| Gather | `gather` | Copies each drone's record from `Rec` into its place in one contiguous tick buffer, split across workers. |
| Publish | `publishBatch` | One goroutine per connection. Writes the header with `PutHeader` right before `nc.Publish`. |

Notice:
- `r.key % len(p.pubs)`: a region always goes out on the same connection, so its messages stay in order.
- `PublishedAt` is stamped per message just before sending. The latency the browser reports therefore leaves out the sort and gather time.
- `Spread` and `Slices` (`PUBLISH_SPREAD_MS`, `PUBLISH_SLICES`) pace a tick over time instead of sending one burst.
- The tick buffer is reused on the next tick. That is safe because `nats.Conn.Publish` copies the bytes (see the `PublishFunc` comment).

## Step 5: NATS in the middle

Read [nats/nats.conf](../nats/nats.conf), [nats/auth.conf](../nats/auth.conf), the `nats` and `u1sim` services in [docker-compose.yml](../docker-compose.yml), and the proxy in [frontend/vite.config.ts](../frontend/vite.config.ts).

Notice:
- u1sim publishes over TCP :4222 as user `backend`. The browser connects to the WebSocket on :8080 as `viewer`, which may only subscribe to `tracks.>`, `u1.track.>` and `_INBOX.>`.
- `max_payload: 1MB` is why large regions are split. `max_pending: 64MB` is how much NATS buffers for one client before it drops that client as a slow consumer.
- NATS keeps no last value. A new subscriber waits up to one tick for its first message.
- In dev the browser does not reach :8080 directly: Vite proxies `/nats` to `ws://localhost:8080`, and `/nats-z` to the compressed server on :8081 (`compress=1`, which saves nothing on binary).

## Step 6: which regions to subscribe to

This part runs on the UI thread. Read in this order:

1. [frontend/src/api.ts](../frontend/src/api.ts) `u1Config`: `?format=binary` sets `subjectPrefix` to `VITE_TRACK_BINARY_PREFIX` (`u1.track.bin`). `natsUrl` builds the WebSocket URL.
2. [frontend/src/map/tracking.ts](../frontend/src/map/tracking.ts) `createTracking`: starts the worker and posts `init` (format, URL, credentials, `epochMs`, interval, stale factor).
3. [frontend/src/map/ViewportSync.tsx](../frontend/src/map/ViewportSync.tsx) `refresh`: at zoom 13 and above, it calls `source.topics(bbox, ...)`.
4. [frontend/src/source.ts](../frontend/src/source.ts) `createTrackSource`, u1 branch: `u1Api.resolve` (POST `tracks/subscriptions/resolve`) answers with JSON subjects (`u1.track.region...`), and `toWire` swaps the prefix to `u1.track.bin...`. A refusal (`overLimit`, HTTP 422) keeps the current subscriptions.
5. Back in `refresh`: `post({ type: "topics", subjects, origin })`.

Stress tests take another route: `setStress` in [TrackingProvider.tsx](../frontend/src/map/TrackingProvider.tsx) sends `override` with the N densest regions, or with the firehose `u1.track.bin.>`.

## Step 7: receiving in the worker

Read [frontend/src/worker/tracks.worker.ts](../frontend/src/worker/tracks.worker.ts): `ctx.onmessage` (cases `init` and `topics`), `connect`, `applyTopics`, `onMsg`, `decode`.

Notice:
- `init` starts three things: `connect`, `frameLoop` ([step 9](#step-9-building-a-gpu-frame)) and `reportStats` once a second.
- `applyTopics` subscribes new subjects with `callback: onMsg`. Subjects no longer wanted linger for 3 s (`LINGER_S`) in case the user pans back.
- `onMsg` calls `decode`, which for `format === "binary"` calls `store.ingest(msg.data, clock())`. JSON goes through `applyU1Event` instead. Everything after the store is shared by all formats.
- `decode` also reads `header.intervalMs` and calls `setInterval_`, which sets the glide time (`interp`, 1.15 intervals) and the stale time (`staleFactor` intervals).
- The latency sample is `recvWall + clockOffset.offsetMs - publishedAt`. The u1 backend has no `svc.time` responder, so the offset stays 0, and the figure relies on the Docker clock matching the host's.

## Step 8: decoding into the track table

Read [frontend/src/shared/trackStore.ts](../frontend/src/shared/trackStore.ts): the header comment, the field list, `ingest` and `grow`.

Notice:
- The store is struct-of-arrays: one typed array per field, indexed by slot. `slotOf` maps a track id to its slot. `remove` swaps the last slot into the hole, so slots `0..n-1` stay dense and can be drawn in one call.
- `ingest` reads straight from the NATS payload through a `DataView`. Nothing is copied and no object is created per track.
- For each record it finds or creates the slot (a new one gets `F_NEW`), converts the tile-local `lx`/`ly` to absolute mercator (`(x + lx/65536) / 2^13`), writes the **pending** fields (`nx`, `ny`, `nh`, `alt`, `speed`, `kind`, `battery`, `lastSeen`, `tile`), and adds the slot to `dirty` once.
- `part`/`parts` are ignored. State is keyed by id, so each part stands on its own. An empty snapshot changes nothing: its tracks expire through `evict` ([step 9](#step-9-building-a-gpu-frame)).
- Binary carries no Mode3a, serial or model text, so the info panel shows less, and `trackNo` is the id.

## Step 9: building a GPU frame

Read `frameLoop` and `postFrame` in [tracks.worker.ts](../frontend/src/worker/tracks.worker.ts), then `commit`, `writeInst` and `evict` in [trackStore.ts](../frontend/src/shared/trackStore.ts).

Notice:
- `commit(now)` starts a new segment for every dirty slot. The segment runs from where the icon is drawn **now** (`px`/`py` moved forward by the elapsed fraction) to the newest position (`cx`/`cy`), starting at `t0 = now`. That is why motion stays smooth when a message comes early or late.
- `writeInst` writes 9 floats per track (`STRIDE`): prev.xy, curr.xy, t0, previous heading, heading, altitude, and kind (+4 when the battery is under 20 %). Positions are relative to an origin (`ox`, `oy`, set by `topics`), so float32 keeps sub-pixel precision at street level.
- `evict(now - staleSec)` drops tracks not seen for `staleFactor` intervals. `expireLingering` drops regions that are no longer wanted.
- `postFrame` copies `inst` into a pooled `ArrayBuffer` and **transfers** it, so nothing is copied between threads. At most 3 buffers are in flight (`MAX_OUTSTANDING`). Past that, the frame is skipped and counted in `framesSkipped`. The loop runs every 33 ms, or less often for a big store (`UPLOAD_BUDGET_BPS`).

## Step 10: drawing

Read the `"frame"` case of `worker.onmessage` in [tracking.ts](../frontend/src/map/tracking.ts); `setFrame`, `upload`, `render` and the vertex shader `VS` in [TrackLayer.ts](../frontend/src/map/TrackLayer.ts); `loop` in [DroneLayer.tsx](../frontend/src/map/DroneLayer.tsx); and [clock.ts](../frontend/src/shared/clock.ts).

Notice:
- `setFrame` keeps only the newest frame and hands older ones straight back to the worker's pool (`release`).
- `upload` orphans the GPU buffer (`bufferData`), fills it with one `bufferSubData`, then returns the `ArrayBuffer` to the worker.
- `render` draws every track with one `drawArraysInstanced` call, then calls `triggerRepaint` to keep animating.
- The vertex shader computes `f = (u_now - t0) / u_interp` and draws each icon at `mix(prev, curr, f)`. Data that arrives once a second animates at 60 fps with no per-frame CPU work.
- `u_now` comes from the animation loop in `DroneLayer` (`layer.now = clock()`). The worker's `t0` comes from the same clock (`makeClock(epochMs)`, with `epochMs` sent in `init`), so the two agree.

## Step 11: measuring and testing

- **Performance panel.** Every second the worker's `reportStats` sends messages/s, tracks/s, bytes/s, decode µs per message, busy ms/s and latency p50/p99. `measure` in `DroneLayer` adds fps, uploads and draw time.
- **Headless.** `npm run probe:u1 -- --local --format binary` ([frontend/bench/u1-probe.ts](../frontend/bench/u1-probe.ts)).
- **Tests.** In `backend/`: `go test ./internal/wire ./internal/sim` (`TestRoundTrip`, `TestPublishRoundTrip`, `TestEmptyTileSnapshot`). In `frontend/`: `npm test` (trackStore.test.ts among others).

## Questions to check your reading

1. **A drone flies from region A into region B. What removes it from A on the client?**
   Nothing explicit. The id is the key, so B's next snapshot updates the same slot and its `tile`. ([Step 8](#step-8-decoding-into-the-track-table))
2. **Why does a region always use the same NATS connection?**
   NATS keeps order per connection, so this keeps a region's messages in order. ([Step 4](#step-4-one-message-per-region))
3. **Why are the GPU positions relative to an origin?**
   Absolute mercator in float32 loses sub-pixel precision at street zoom. ([Step 9](#step-9-building-a-gpu-frame))
4. **What does the binary latency figure leave out?**
   The simulator's sort and gather (the header is stamped after them), and everything after `ingest`: commit, frame, upload and draw. ([Steps 4](#step-4-one-message-per-region) and [7](#step-7-receiving-in-the-worker))
5. **What happens when the UI thread is slower than the worker?**
   The worker skips frames once 3 are in flight, and `setFrame` keeps only the newest one, so the map shows fewer updates instead of falling behind. ([Steps 9](#step-9-building-a-gpu-frame) and [10](#step-10-drawing))
