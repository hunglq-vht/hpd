# Frontend on the u1-track-manager contract

This file covers how the HPDMB frontend was changed to work with the u1-track-manager backend, how it was tested, and which backend changes would improve performance.

**Scope and state:**

- HPDMB `frontend/` only. fe-monorepo comes later.
- Uncommitted changes on the branch `implement-functional-component`, written on 2026-10-25.
- The frontend keeps working with this repo's Go backend (the "demo" backend). A build setting picks which backend it talks to.

## Contents

1. [The u1 contract](#the-u1-contract)
2. [How the contract fits the frontend](#how-the-contract-fits-the-frontend)
3. [Changes by file](#changes-by-file)
4. [Environment variables](#environment-variables)
5. [How to run](#how-to-run)
6. [Test results](#test-results)
7. [Backend suggestions](#backend-suggestions)
8. [Assumptions and open questions](#assumptions-and-open-questions)

---

## The u1 contract

| Part | Shape |
|---|---|
| `GET /u1-track-manager/tracks/regions/stats` | `{ regions: [{ topic, active_track_count }] }` for the whole map |
| `POST /u1-track-manager/tracks/subscriptions/resolve` | Request: `{ viewport: {west, south, east, north}, map_zoom, preferred_partition: {scheme: "web_mercator_xyz", zoom: 13}, limits: {max_partitions, max_cached_tracks} }`. Response: `{ topics: ["u1.track.region.xyz.13.<x>.<y>", ...] }`. |
| NATS WebSocket | Login with a user name and password |
| `track.update` | `{ type, timestamp, region: {scheme, zoom, x, y}, track: {ID, TrackNumber, Latitude, Longitude, Velocity, Altitude, Heading, Model, Mode3a, UpdatedAt, CreatedAt} }`. One message per track. |
| `track.leave` | `{ type, timestamp, region, leave: {track_id, to_region, updated_at} }`. Sent when a track moves to another region. |

## How the contract fits the frontend

| New backend | Old (demo) backend | Frontend change |
|---|---|---|
| `POST tracks/subscriptions/resolve` | `GET /api/topics` | Same flow: the subjects in the response go to the worker, which subscribes and unsubscribes |
| `u1.track.region.xyz.13.x.y` subjects | `tracks.13.x.y` | The tile is read from the last 3 parts of the subject, so any prefix works |
| `track.update`, JSON, one track per message | Binary tile snapshot, many tracks per message | New decoder in the worker. It writes into the same typed-array store, so the WebGL layer and the glide do not change. |
| `track.leave` | Old timeout only | If the drone moves to a region the client still listens to, keep it. Otherwise remove it now, not after the timeout. A `track.leave` that arrives after the new region's update is ignored. |
| `GET tracks/regions/stats` (whole map, counts only) | `GET /api/stats?bbox&zoom` (server clusters with centre points) | The worker downloads the list (at most once per publish interval) and groups the regions into cluster cells |
| NATS user and password from env variables | `/api/config` | `VITE_NATS_USER`, `VITE_NATS_PASS` and `VITE_NATS_WS_URL`, passed to the worker's NATS connection |
| No publish interval in messages | Interval in the snapshot header | The worker measures the time between reports of the same track and sets the glide length to match |
| No clock service | `svc.time` | Clock sync runs only for the demo backend |

## Changes by file

Paths are relative to `frontend/` unless stated.

### Config

| File | Change |
|---|---|
| `.env.u1` (new) | u1 settings for `npm run dev:u1` / `build:u1`. Defaults match the local mock. |
| `src/vite-env.d.ts` | Types for all `VITE_*` variables |
| `src/api.ts` | `loadConfig()` builds the u1 config from env variables (demo: `GET /api/config`). `VITE_NATS_*` override the NATS settings in both modes. New `u1Api.resolve()` and `u1Api.statsUrl()`. New `subjectOf()` for the panel's topic field. |
| `src/App.tsx` | Calls `loadConfig()` instead of `api.config()` |
| `package.json` | New scripts `dev:u1`, `build:u1`, `mock:u1` |
| `vite.config.ts` | Forwards `/u1-track-manager` to `TRACK_API_URL` (default `http://localhost:8091`, the mock) |
| `tsconfig.json` | Includes `mock/` |
| `../.gitignore` | Adds `*.local`, for `.env.u1.local` with real credentials |

### Data source

| File | Change |
|---|---|
| `src/source.ts` (new) | One `TrackSource` interface (`clusters`, `topics`, `top`, `firehose`) with a demo version and a u1 version. The u1 version widens the viewport by the prefetch margin before it calls resolve. |
| `src/map/tracking.ts` | Adds `source` and a general `query()` (request/reply with the worker). `pick()` now uses `query()`. `UiState.topics` allows unknown counts (u1 does not send them). |
| `src/map/ViewportSync.tsx` | Uses `tracking.source` for clusters and topics, including keeping the selected track subscribed in cluster view |
| `src/map/TrackingProvider.tsx` | "Densest tile" and the stress test use `source.top()` and `source.firehose` |

### Decoding (worker side)

| File | Change |
|---|---|
| `src/shared/u1.ts` (new) | Decoder for `track.update` and `track.leave`. Accepts numbers or numeric strings; rejects bad messages. Converts second timestamps to milliseconds. Picks the icon: `Model` containing "hexa" gives hexacopter; fixed, wing, plane or aircraft gives fixed-wing; anything else gives quadcopter. Mode 3/A codes 7500, 7600 and 7700 give the Emergency icon. |
| `src/shared/trackStore.ts` | New `put()` (one decoded report) and `leave()`. New typed-array fields: track number, Mode 3/A, model, UpdatedAt. Repeated text is stored once in a lookup table. Battery can be "unknown". New `takeUpdateInterval()`, which measures the time between reports. The binary `ingest()` is unchanged except that it fills the new fields. |
| `src/shared/regions.ts` (new) | Reads the region stats into typed arrays. Groups regions into cells at the cluster zoom level (at most 13), each placed at the count-weighted centre. Finds the busiest regions. |
| `src/shared/tiles.ts` | `subjectTileKey()` reads the last 3 parts of any subject (`tracks.13.x.y` and `u1.track.region.xyz.13.x.y`) |
| `src/shared/protocol.ts` | `init` carries `backend` and `statsUrl`. New `query`/`reply` messages (`pick`, `clusters`, `top`). New `updateIntervalMs` stat. |
| `src/worker/tracks.worker.ts` | Picks the decoder by backend. Keeps the set of subscribed region keys for `track.leave`. Downloads region stats and answers `clusters`/`top`. Runs `svc.time` only for the demo backend. Applies the measured update interval every second. |

### UI

| File | Change |
|---|---|
| `src/components/TrackPanel.tsx` | u1: Mode 3/A, track number, "Reported at" and the model name. Demo: battery as before. The topic field uses the configured subject pattern. |
| `src/components/Toolbar.tsx` | Shows topic counts without "in view" numbers for u1, the stored track count, and the right "all regions" subject for the stress test |
| `src/components/PerfHud.tsx` | New "Update interval" row |

### Local development and docs

| File | Change |
|---|---|
| `mock/u1-mock.ts` (new) | A local stand-in for u1-track-manager. It serves both endpoints on port 8091 and publishes JSON `track.update` / `track.leave` to NATS as the `backend` user. The default is 3000 drones around Hanoi, Ho Chi Minh City and Da Nang. |
| `../nats/nats.conf` | The `viewer` user may now subscribe to `u1.track.region.>` |
| `../README.md` | New section "Against u1-track-manager" and updated layout |

### Tests

| File | Covers |
|---|---|
| `src/shared/u1.test.ts` (new, 8 tests) | Subject and region keys, icon mapping, update fields, leave (keep or drop), late leave, measured interval, bad messages, numeric strings |
| `src/shared/regions.test.ts` (new, 4 tests) | Reading stats, grouping and centre points, cells and counts limited to the view, busiest regions |

## Environment variables

All values are set at build time. Every `VITE_*` value ends up in the JavaScript bundle, so anyone who loads the app can read it, including `VITE_NATS_PASS`.

| Variable | Default | Meaning |
|---|---|---|
| `VITE_TRACK_BACKEND` | (demo) | `u1` talks to u1-track-manager |
| `VITE_TRACK_API_BASE` | `/u1-track-manager` | Base URL of u1-track-manager |
| `VITE_TRACK_SUBJECT_PREFIX` | `u1.track.region` | Prefix before `.xyz.<z>.<x>.<y>`. Used for the "all regions" subject. |
| `VITE_NATS_WS_URL` | (same origin `/nats`) | NATS WebSocket URL |
| `VITE_NATS_USER` / `VITE_NATS_PASS` | `viewer` / `viewer` in `.env.u1` | NATS login |
| `VITE_TRACK_INTERVAL_MS` | 1000 | Publish interval used until the worker has measured it |
| `VITE_TRACK_STALE_FACTOR` | 3 | A silent track is removed after this many intervals |
| `VITE_MAX_PARTITIONS` / `VITE_MAX_CACHED_TRACKS` | 36 / 4000 | `limits` sent to resolve |

Shell variables for the Vite dev proxy: `TRACK_API_URL` (default `http://localhost:8091`) and `NATS_WS_URL` (default `ws://localhost:8080`).

## How to run

```bash
docker compose up -d nats   # restart it so viewer may subscribe to u1.track.region.>
cd frontend
npm run mock:u1             # stand-in backend on :8091 (3000 tracks)
npm run dev:u1              # http://localhost:5173/?lon=105.84&lat=21.03&zoom=14
```

For a remote backend, set `TRACK_API_URL` and `NATS_WS_URL` for the dev proxy. Alternatively, set absolute `VITE_TRACK_API_BASE` / `VITE_NATS_WS_URL`; the backend then needs CORS.

## Test results

**Static checks:** `tsc --noEmit` is clean. 18 of 18 unit tests pass.

**u1 mode against the mock, in headless Chrome:**

| Step | Result |
|---|---|
| Hanoi, zoom 14 | 20 topics, about 599 drones (server count for those regions: about 595), about 603 messages/s, 0 bad messages, 52–55 fps |
| Select a drone | Panel shows longitude, latitude, altitude, speed, heading, Mode 3/A, track number, "Reported at", topic, last update |
| Zoom 10 | 43 cluster cells built from the region stats; the selected drone stays live |
| Zoom 5.5 | 3 cells, 3000 drones in total |
| "Densest tile" | Flies to Da Nang, zoom 14, about 900 drones |
| Console | No errors or warnings |

**Demo mode against the running Go stack:** 43k drones from 16 binary messages/s, server clusters, "Densest tile", and the panel with battery all still work.

**Not tested:**

- The real u1-track-manager.
- The new `nats.conf` rule. The Docker command line hangs on this machine, so NATS could not be restarted to load it. For the test, the mock published under the prefix `tracks.u1.track.region`, which the old `viewer` permission (`tracks.>`) allows.
- NATS reconnects in u1 mode.

## Backend suggestions

### Measured cost per drone

Same browser, same laptop:

| Format | Messages | Bytes per drone | Decode time per drone |
|---|---|---|---|
| Binary, one message per tile (demo) | 16 /s for about 43k drones | 16 | 0.34 µs |
| JSON, one message per drone (u1) | one per drone | 327 | about 33 µs |

At the 4000-drone limit, JSON costs about 13 % of one CPU core in the worker. That is acceptable at 4000, but it is the upper limit of what this format can handle.

### Suggestions, in order of value

| # | Suggestion | Effort | Why |
|---|---|---|---|
| 1 | Send `timestamp` and `UpdatedAt` in milliseconds | Small | Whole seconds make the latency figure meaningless: it read 180 ms in one run and 954 ms in another, only from where in the second the message was sent. Two updates in the same second also can't be put in order. |
| 2 | Group one region's drones into one message per tick (for example a JSON array) | Medium | Removes most of the per-message overhead in NATS, the WebSocket and the client |
| 3 | Filter `regions/stats` by viewport and zoom, and return centre points | Small | Today the client downloads the whole map every second in cluster view. Without centre points, clusters sit on a grid of tile centres. |
| 4 | Use one subject prefix | Small | The examples use both `utm.track.region` and `u1.track.region` |
| 5 | Return the publish interval in the resolve response | Small | The client now measures it; a declared value is simpler and exact |
| 6 | Return more from resolve: drone count per topic, viewport or prefetch flag, a `truncated` flag | Small | The UI can show expected counts and warn when the list is cut |
| 7 | Review `max_partitions` 36 | Small | A 1920×1080 view at zoom 13 covers about 28 regions, 54 with the ring. Either raise the limit or start live view at zoom 14. |
| 8 | Send the current state when a client subscribes (for example JetStream's last message per subject) | Medium | A new region stays empty for up to one tick |
| 9 | Add a `track.end` event for drones that land or lose signal | Small | Clients can remove a drone at once instead of waiting for the timeout. This also helps the LOST_LINK state in fe-monorepo. |
| 10 | Give each user short-lived NATS credentials (token or JWT), subscribe-only on `u1.track.region.>` | Medium | A password in `VITE_*` variables is public |
| 11 | Document units | Small | Velocity (m/s?), Heading (degrees clockwise from true north?), Altitude (above sea level or above ground?) |

The bigger step: a binary or compact format per region, like the demo's, cuts the decode cost by about 100× and the size by about 20×.

## Assumptions and open questions

1. Is `ID` always a number below 2³²? Other IDs are rejected as bad messages now.
2. Units: the frontend assumes Velocity in m/s, Heading in degrees clockwise from north, and Altitude in metres.
3. Does resolve always add the ring of neighbour regions? The example (a small viewport gives 9 topics) suggests yes, so the u1 prefetch margin defaults to 0.
4. Does `regions/stats` always return the whole map? The frontend assumes yes.
5. Is the missing comma after `Velocity` in the example message a typo? The frontend assumes yes.
6. The icon mapping from `Model` and Mode 3/A is a guess. It needs the real list of model values.
