# Plan: bring the solutions into fe-monorepo step by step

This file is a plan for moving the HPDMB solutions (Web Worker, typed-array store, GPU-interpolated
WebGL layer, worker clusters, region subscriptions) into fe-monorepo `apps/utm`. Each step is one MR,
ships on its own, and comes with a demonstration that shows the step makes the app faster.

The hands-on instructions, with type-checked code for every step, are in
[`FE-MONOREPO-IMPLEMENTATION-GUIDE.md`](FE-MONOREPO-IMPLEMENTATION-GUIDE.md).

**Scope and state:**

- `apps/utm` only. Paths are relative to `apps/utm/src` unless they start with `packages/` or `frontend/`.
  `frontend/` is this repo's demo client, the source of the code to port.
- Based on fe-monorepo **`origin/dev` at `39b40e0f0`** (2026-10-26). The first version of this plan
  read `main`, which is 1191 commits behind; dev already contains part of steps 1 and 2.
- The demonstrations say **what to record and what to look for**. The cost table below is a Node
  estimate for planning, not a browser measurement.
- The feature-by-feature check is in [`UTM-TRACK-FEATURES.md`](UTM-TRACK-FEATURES.md). It was written
  against `main`; its file paths for the monitor page are out of date (see [What dev changed](#what-dev-changed)).

## Contents

1. [What dev changed](#what-dev-changed)
2. [Where the time goes on dev](#where-the-time-goes-on-dev)
3. [Rules for every step](#rules-for-every-step)
4. [Step overview](#step-overview)
5. [Step 0: demo harness and baseline](#step-0-demo-harness-and-baseline)
6. [Step 1: the live-tracks worker builds the map data](#step-1-the-live-tracks-worker-builds-the-map-data)
7. [Step 2: grid clusters in the worker](#step-2-grid-clusters-in-the-worker)
8. [Step 3: terrain spike](#step-3-terrain-spike)
9. [Step 4: WebGL track layer behind a flag](#step-4-webgl-track-layer-behind-a-flag)
10. [Step 5: make WebGL the default, remove the old path](#step-5-make-webgl-the-default-remove-the-old-path)
11. [Step 6: the page gets only what it reads, then the socket in the worker](#step-6-the-page-gets-only-what-it-reads-then-the-socket-in-the-worker)
12. [Step 7: region subscriptions (needs the backend)](#step-7-region-subscriptions-needs-the-backend)
13. [Code to port](#code-to-port)
14. [Open questions](#open-questions)

---

## What dev changed

| Area | `main` | `origin/dev` | Effect on this plan |
|---|---|---|---|
| Socket | 7 `useLiveTracks()` hooks, each with `JSON.parse` + zod and its own React state | One `LiveTracksConnection` with `disableJson`, `filter: () => false`; `onMessage` posts the raw string to `worker/live-tracks-worker.ts` | Step 1 "parse once, off the main thread" is **done** |
| Validation | zod `looseObject` on the main thread, per subscriber | zod `object` in the worker, once per message | The zod cost is off the main thread |
| Store | React state per hook | Module store in `use-live-tracks.tsx`: `Map` by ID, ID/TrackNumber alias, `useSyncExternalStore`, `useLiveTrackById`, `useLiveTrackPresence`, `useLiveTrackListener` | The small hooks of step 1 are **done**. ID-or-TrackNumber is resolved once (`getCurrentLiveTrack`) |
| Message shape | Full list every second | **Partial batches**; the store merges them, skips older `UpdatedAt`, expires a track after 30 s silent | The mock and the demonstrations must send partial batches |
| Publish rate | Every message | Every batch below 1000 tracks; above, the fleet snapshot is rebuilt at most 4 times per second | Bounded, but each rebuild is a full-fleet copy |
| GeoJSON | Full list to `convert-worker`, full GeoJSON back, `setData` | Binary packet (`worker/track-position-packet.ts`) to `convert-worker`; from 1000 tracks, zoom â‰¥ 11 and pitch 0, the worker and the main thread drop tracks outside the view + 128 px; `getTrackSourceDiff` sends `updateData` diffs | Step 2 viewport culling is **partly done** |
| Clusters | `clusterMaxZoom` 10 | `clusterMaxZoom` 16 | supercluster now groups up to zoom 16; step 2 must decide this |
| Follow | `easeTo` per message in React | `shared/map/selected-track-follower.tsx`: store listener, one `easeTo` per frame at most | Partly done; step 4 still replaces it with a per-frame `jumpTo` |
| Monitor page | `routes/.../monitor/monitor-page.tsx` | `features/dashboard/monitor-page.tsx`, `monitor-map.tsx`, `monitor-map-interactions.tsx`; `shared/map/selected-feature-state-sync.tsx` | New paths for steps 4 and 5 |
| More consumers | â€” | CUAV: `features/cuav/cuav-map.tsx` (uses `trackLayer`), `features/cuav/dashboard/dashboard-map.tsx` (own `usePositionWorker`) | The engine must serve these maps, or they keep the GeoJSON path |
| MapLibre | 5.24 | 6.12 (same as `frontend/`) | `TrackLayer.ts` ports without an API change |
| Tests | jsdom only | Vitest browser mode (`*.browser.test.tsx`), e.g. `live-track-pipeline.browser.test.tsx`: 15k fleet from 50 batches of 300 within 1 s | The worker and WebGL can be tested in a real browser |
| Code rules | â€” | No direct `useEffect`, `useMemo`, `useCallback` (`useMountEffect`, `useConstant`); fallow boundaries | Ported code must follow them |
| Wire flag | `VITE_BYPASS_WIRE_VALIDATION` | Removed | â€” |

**Bugs still present on dev:**

| Bug | Where | Fix |
|---|---|---|
| LOST_LINK never fires | `worker/convert-worker.ts:63,71-72`: `lastSeen = now` is set, then `now - lastSeen > 5000` is checked in the same pass | Use the store's `lastReceivedAtById` (it exists on dev; tracks expire after 30 s) once the rule is chosen |
| Selection highlight misses tracks selected by TrackNumber | `shared/domain/replay-monitor/select-monitor-track.ts:28`: `featureId: trackId` even when the match was by TrackNumber | `featureId: currentTrack?.ID ?? trackId` |
| The track layer re-renders up to 4 times per second | `track-layer-1.tsx:347` calls `useLiveTracks()` but only needs the count and a listener | Use `useLiveTrackListener` and `getCurrentLiveTracks()` |

## Where the time goes on dev

Load: the browser test's shape, a 15k fleet with 50 batches of 300 tracks per second, at most 4 fleet
publishes per second. Node 24, zod 4.6.7, es-toolkit 1.53, on this laptop. `structuredClone` measures
both sides of a `postMessage`; the main thread pays the deserialize part, so the real main-thread figure
is somewhere in the range shown.

| Stage | Thread | Cost per second |
|---|---|---:|
| `JSON.parse`, 50 Ã— 300 | live-tracks worker | ~27 ms |
| zod `safeParse`, 50 Ã— 300 | live-tracks worker | ~8.5 ms |
| `Track[]` objects copied to the main thread, 50 batches | **main** | ~30â€“60 ms |
| Store publish (`Array.from` + alias `Map`), 4 Ã— 15k | **main** | ~7 ms |
| `encodeTrackPositions`, 4 Ã— 15k | **main** | ~5 ms |
| GeoJSON back from `convert-worker` + colour map, 4 Ã— 15k (zoom < 11 or pitched: no culling) | **main** | ~140â€“270 ms |
| `getTrackSourceDiff` with `isEqual`, 4 Ã— 15k (same case) | **main** | ~180 ms |
| **Main thread, zoomed out or pitched** | | **~370â€“530 ms** |
| **Main thread, zoom â‰¥ 11, pitch 0, ~1000 tracks in view** | | **~80â€“100 ms** |

Not counted: MapLibre's own copy of the data into its worker, supercluster, symbol layout, garbage
collection, and React renders.

**What this means:**

- zod is no longer a main-thread cost. Turning it off saves ~8.5 ms per second of worker time and
  nothing on screen.
- The cost is now the **relay through the main thread**: socket â†’ main â†’ worker A â†’ main (objects) â†’
  worker B â†’ main (GeoJSON) â†’ diff â†’ MapLibre worker. Each hop copies the data.
- The worst case is the **zoomed-out or pitched view**, where culling is off and the full fleet makes
  the whole round trip 4 times per second.
- The diff saves little when every track moves each second: almost every feature is an update, so
  `isEqual` runs on all of them and `updateData` still sends all of them.

## Rules for every step

- **One MR per step**, small enough to review. Each MR leaves the app working.
- **A/B on the same build where a step changes the drawing.** Step 4 sits behind the `track-webgl`
  feature flag (`VITE_ENABLE_FEAT`, the app's existing flag catalog), with a `?trackRenderer=webgl|geojson`
  override in dev builds. Steps 1 and 2 change no pixels, so they compare against the previous MR's build.
- **Same demo, every step.** Step 0 makes one scenario. Every later step runs it before and after and
  keeps the output in the MR.
- **Feature parity first.** Each step lists the features it touches and checks them in the demonstration.
- **Tests:** logic as plain functions (node); the engine, worker and WebGL in Vitest browser mode,
  like `live-track-pipeline.browser.test.tsx`; components in jsdom with a fake engine.
- **Follow the dev code rules:** `useMountEffect`, `useConstant`, `useAsRef`, no direct `useEffect` /
  `useMemo` / `useCallback`; check `CODING_STANDARDS.md` and `lint:fallow:boundaries`.

## Step overview

| Step | Change | State on dev | What the demonstration shows |
|---|---|---|---|
| 0 | Mock load with partial batches, perf overlay, scenario script | To do | Baseline at 2k / 15k / 30k tracks |
| 1 | The live-tracks worker also keeps the fleet, alerts and map views, and sends each map a ready diff of its visible tracks | Parse-once **done**; merge to do | No GeoJSON round trip, encode or `isEqual` diff on the main thread |
| 2 | Worker grid clusters replace supercluster | To do | A zoomed-out map gets a few hundred features, whatever the fleet size |
| 3 | Terrain spike (throwaway) | To do | Go/no-go for a custom layer with terrain |
| 4 | WebGL layer + glide + shader effects + picking, behind the switch | To do | Flat frame time when track count rises; no per-frame paint calls |
| 5 | WebGL default, delete the old path | To do | Same scenario on by default; less code |
| 6 | Page gets only the tracks it reads; then the WebSocket inside the worker | Optional | No per-batch object copy, then no main-thread task per batch |
| 7 | u1 region subscriptions over NATS | Needs backend | Bytes and messages per client follow the view, not the fleet |

---

## Step 0: demo harness and baseline

**Goal:** a repeatable way to load the app with a production-like feed and see where the time goes.

| Item | Change |
|---|---|
| `tests/mocks/handlers/track-ws.ts` (msw `ws`, used by `mock-ws-server.ts` and tests) | `MOCK_TRACK_COUNT` (default 30, as today) and `MOCK_TRACK_BATCHES_PER_SECOND` (default 1 = full list, as today; 50 for the test shape). The fleet area grows with the count so density stays realistic. |
| Dev perf overlay | Shown with `?perf`. Batches/s, main-thread time per second, React commits/s, map fps, long animation frames (`PerformanceObserver` type `long-animation-frame`). Also `window.__TRACK_PERF__` for scripts. Port the idea of `frontend/src/components/PerfHud.tsx`. |
| `scripts/perf/live-tracks-scenario.ts` | Playwright or `agent-browser`. Opens the monitor page, logs in, and for each switch value: hold still 15 s at zoom 14, pan 10 s, zoom 14 â†’ 8 â†’ 14, pitch 45Â°, select a drone and follow 10 s. Saves a Chrome trace, `__REACT_SCAN_DEBUG__.getEvents()`, `__TRACK_PERF__` samples and a screen recording in `perf-out/<step>/<switch>/<count>/`. |
| Browser perf test | Extend `live-track-pipeline.browser.test.tsx` style: fixed load, assert main-thread time per second below a budget, so a regression fails CI. |

**Demonstration (baseline), at 2k / 15k / 30k tracks, 50 batches per second:**

1. Trace: per-batch main-thread tasks for the `Track[]` copy; 4 per second for publish + encode +
   GeoJSON receive + `getTrackSourceDiff`; MapLibre worker time for `updateData` and supercluster;
   per-frame `setPaintProperty` while an alert is in view.
2. Compare zoom 14 (culling on) with zoom 8 and with pitch 45Â° (culling off).
3. react-scan: which components render 4 times per second (expected: `TrackDataHandler`, `WatchlistPanel`).
4. Recording: icons jump each second; pan stutter at 15k when zoomed out.

## Step 1: the live-tracks worker builds the map data

**Goal:** stop sending the fleet through the main thread for the map. The live-tracks worker, which
already parses each batch, also keeps the fleet, the alerts and one view per map, and sends each map a
ready MapLibre diff of its visible tracks. How: [guide, step 1](FE-MONOREPO-IMPLEMENTATION-GUIDE.md#step-1-the-live-tracks-worker-builds-the-map-data).

| Item | Change |
|---|---|
| Worker | Adds the fleet `Map` (dev's merge rules: skip older `UpdatedAt`, 30 s expiry), alert state (from `convert-worker.ts`), views (padded view polygon, zoom, selected ID, watchlist), culling at every zoom and pitch, and the diff. At most 4 updates per second per view; at once when a view's selected track reports. |
| Main-thread store | Unchanged: it still receives each batch, so `useLiveTrackById`, presence, follow, history and the panels do not change. Reducing this copy is step 6. |
| `track-layer-1.tsx` | Registers its map as a view and applies the worker's `setData` / `updateData`. No `usePositionWorker`, `encodeTrackPositions`, `getTrackSourceDiff` or `useLiveTracks()` re-render. |
| Bugs | LOST_LINK from receipt time (5 s, rule still open: question 2); `select-monitor-track.ts` `featureId` fix; selected ID resolved by ID, then TrackNumber, in the worker. |
| CUAV dashboard map | Keeps `usePositionWorker` until step 5. |

**Demonstration:** scenario at 15k and 30k, before and after.

- **Trace:** the 4-per-second encode, GeoJSON receive, colour map and `isEqual` diff tasks are gone; one
  `VIEW_UPDATE` per map per flush, sized by the tracks in view. The zoomed-out and pitched phases improve most.
- **react-scan:** `TrackDataHandler` no longer renders on publish.
- **Parity check:** alert colours and pulse, acknowledge, watchlist mode, alert panel click, toast
  focus, follow, track detail, history line, manage-dashboard mini map, CUAV map. LOST_LINK turns grey.

## Step 2: grid clusters in the worker

**Goal:** a zoomed-out map gets a few hundred features, whatever the fleet size. How:
[guide, step 2](FE-MONOREPO-IMPLEMENTATION-GUIDE.md#step-2-grid-clusters-in-the-worker).

| Item | Change |
|---|---|
| Clusters | Up to zoom 16 (dev's `clusterMaxZoom`), the worker groups the tracks in view into 80 px grid cells (dev's `clusterRadius`). A cell with one track stays a track, like a supercluster leaf. Remove `cluster: true` from the source. |
| Layers | Unchanged: cluster features carry `point_count` and `point_count_abbreviated`. |

**Demonstration:** scenario at 15k and 30k, step 1 against step 2: no supercluster in the zoom-8 phase,
and the update size stays flat when the mock fleet doubles. Note in the MR that grid grouping differs a
little from supercluster.
## Step 3: terrain spike

**Goal:** answer one risk before building the WebGL layer. The app can turn on terrain
(`features/dashboard/components/terrain-effect-layer.tsx`). GeoJSON layers follow the terrain; a
custom layer that uses `mainMatrix` draws at sea level.

**Work:** a throwaway branch with `frontend/src/map/TrackLayer.ts` (already MapLibre 6.12, the same
as dev) added to `monitor-map.tsx`. Turn on terrain, pitch the map, and compare drone positions with
the GeoJSON icons. Check if MapLibre 6.12 gives custom layers the terrain height, or if the worker
must get the elevation per track.

**Output:** a note in the step 4 MR: works as is / needs elevation per track (how) / fall back to the
GeoJSON path while terrain is on.

## Step 4: WebGL track layer behind a flag

**Goal:** draw the drones with one instanced draw call per pass and move them on the GPU. Behind the
`track-webgl` flag; GeoJSON stays the default. How: [guide, step 4](FE-MONOREPO-IMPLEMENTATION-GUIDE.md#step-4-webgl-drone-layer-behind-a-flag).

| Item | Change |
|---|---|
| Store | A typed-array store in the worker, next to the fleet `Map`: glide segments, swap-remove, origin re-base, a style per track (status, hidden when clustered or filtered). |
| Frames | Transferred `ArrayBuffer`s, at most 3 in flight, every 33 ms to 1 s by size. |
| Layer | A MapLibre custom layer: `drone1_out.png` with MapLibre's SDF edge, tinted by status; glow, tech ring and alert pulse in the shader, so `TrackAlertAnimation` goes away. |
| Labels and clusters | Stay GeoJSON from step 1 and 2; the `track-layer-1` symbol layer stays but hidden, so `interactiveLayerIds` and box select keep working. |
| Picking | Click (only when no other layer was hit), hover and ctrl-drag box select are answered by the worker from the drawn positions. |
| Selection | The view's selected ID drives the highlight overlay; no `setFeatureState` needed for drones. |
| Follow | `SelectedTrackGlFollower`: `jumpTo` the gliding position each frame unless the map moves. |
| CUAV map | Stays GeoJSON until its click code uses the worker pick. |

**Demonstration:** scenario at 2k, 15k and 30k, `?trackRenderer=geojson` against `?trackRenderer=webgl`.

- **Recording:** drones glide instead of jumping. Pan and zoom stay smooth at 15k.
- **Trace:** no `setPaintProperty` per frame; no MapLibre worker work for drone icons; per-frame
  main-thread work is a few uniforms plus one buffer upload when a frame arrives.
- **Overlay:** map fps and long animation frames stay about the same from 15k to 30k.
- **Ceiling:** one run at 60k (mock only). Expect `JSON.parse` in the worker to be the first limit
  (~110 ms per second at 60k, from the table above).
- **Parity check:** sections B and D of `UTM-TRACK-FEATURES.md`, plus screenshots of each status
  colour, hover, selection, pulse and labels at zoom 11, 14 and 17, both renderers.

## Step 5: make WebGL the default, remove the old path

**Goal:** one code path. Only after step 4 has run in staging and the open questions are answered.

**Changes:** remove the flag and the GeoJSON drone layers, `TrackAlertAnimation` and `SelectedTrackCamera`.
Move the CUAV map click and the CUAV dashboard map to the worker, then delete `convert-worker.ts`,
`use-position-worker.ts` and `track-position-packet.ts`.

**Demonstration:** the step 4 scenario on by default, plus `size-limit` and the count of removed lines.
The parity check runs as e2e on the mock.

## Step 6: the page gets only what it reads, then the socket in the worker

**Goal:** remove the last per-batch main-thread work. Optional.

**Changes:**

1. The worker posts only the tracks the page reads (selected, alerts, watchlist, history targets) plus
   the full list at most once per second while a `useLiveTracks()` reader is mounted. Saves the
   ~30–60 ms per second of `Track[]` copies at 15k.
2. If the trace still shows a task per batch: the worker opens the WebSocket. Cookie auth works in a
   worker; for Direct Password-Grant, pass the `protocols` from `createUtmWebSocketOptions` and send a
   new token on refresh. Port reconnect and backoff (20 attempts, up to 10 s).

**Demonstration:** scenario at 15k, step 5 against step 6: no main-thread task when a batch arrives.
Also test token refresh, server restart and tab sleep.
## Step 7: region subscriptions (needs the backend)

**Goal:** the client receives only tracks near the view. Dev can already point the track service at
`u1-track-manager` (`config/services.ts`, prefix `u1`), but it still reads the full-fleet
`/ws/tracks` WebSocket; region subjects over NATS need the contract in `U1-BACKEND-INTEGRATION.md`.

**Changes:** port `frontend/src/source.ts`, `frontend/src/shared/u1.ts` and the subscription diff in
`frontend/src/worker/tracks.worker.ts` (3 s linger). Clusters from `regions/stats`. The step 4 store
and layer do not change. Short-lived NATS credentials per user, not `VITE_*` passwords.

**Demonstration:** `frontend/mock/u1-mock.ts` with a large fleet in several cities. Messages/s and
bytes/s follow the view and stay flat when the fleet grows. Compare with step 6 at the same fleet size.

---

## Code to port

The ported code, adapted to the dev code rules, is in [`fe-monorepo-guide/code/`](fe-monorepo-guide/code),
one folder per step with fe-monorepo paths. [`fe-monorepo-guide/verify/`](fe-monorepo-guide/verify)
type-checks it, runs its tests and runs the step 4 code in Chrome.

| From `frontend/` | Became (under `apps/utm/src/`) |
|---|---|
| `components/PerfHud.tsx` (idea) | `shared/domain/replay-monitor/track-perf.ts`, `track-perf-overlay.tsx` |
| `map/tracking.ts`, `shared/protocol.ts` | `shared/domain/replay-monitor/live-tracks-channel.ts`, `live-tracks.types.ts` |
| `map/ViewportSync.tsx` | `shared/domain/replay-monitor/use-track-view-sync.ts` |
| `shared/regions.ts` (grid idea) | `worker/live-tracks/track-clusters.ts` |
| `shared/trackStore.ts`, `shared/clock.ts` | `worker/live-tracks/track-store.ts`, the clock in `live-tracks-channel.ts` |
| `map/TrackLayer.ts`, `map/DroneLayer.tsx` | `shared/domain/replay-monitor/track-gl-layer.ts`, `track-gl-layer-view.tsx`, `track-follow.ts` |
| `map/MapInteractions.tsx` (pick) | `shared/domain/replay-monitor/pick-live-track.ts` |
| `source.ts`, `shared/u1.ts`, `worker/tracks.worker.ts` (subscriptions) | Not yet: step 7 |
## Open questions

1. What fleet size and batch rate are expected in production? The dev browser test uses 15k tracks in
   50 batches of 300 per second. Is that the target?
2. LOST_LINK rule: server `UpdatedAt` or receipt time, after how many seconds, and how long does a
   silent track stay grey before the 30 s expiry?
3. Must Mode3a labels glide with the icons, or is once per second OK?
4. When a click hits a drone and a station or zone, which wins?
5. Is about 1 s of display lag (the cost of the glide) OK for operators?
6. With terrain on, should drones sit on the terrain or at their reported `Altitude`?
7. Is the app's `VITE_ENABLE_FEAT` catalog the right place for the temporary `track-webgl` flag, or does
   the team want a different rollout switch?
8. Will u1-track-manager offer region subjects over NATS, and when? Step 7 depends on it.
9. Why did dev raise `clusterMaxZoom` from 10 to 16, and must step 2 keep clusters up to zoom 16?
