# Guide: implement the live-track solution in fe-monorepo by hand

This guide is the step-by-step instruction for [`FE-MONOREPO-INTEGRATION-PLAN.md`](FE-MONOREPO-INTEGRATION-PLAN.md).
Each step is one MR on fe-monorepo `dev`. For each step it says which files to add, which lines of existing
dev files to change, which tests to write first, and how to show that the step makes the app faster.

**Scope and state:**

- Written against fe-monorepo `origin/dev` at `39b40e0f0` (2026-10-26). Paths are relative to the fe-monorepo
  root.
- The new files are in [`fe-monorepo-guide/code/`](fe-monorepo-guide/code), one folder per step, with the
  same paths as in fe-monorepo. Copy them; do not retype them.
- **What was checked** (with [`fe-monorepo-guide/verify/`](fe-monorepo-guide/verify), see [Check the guide's code](#check-the-guides-code)):
  - every new file type-checks (strict, `noUncheckedIndexedAccess`) against zod 4.6.7, MapLibre 6.12, React 19 and msw 3;
  - the unit tests in `code/` pass;
  - the step 4 code runs in Chrome with MapLibre 6.12 and 5000 tracks in 10 batches per second: worker clusters,
    culling, GPU frames, drawing, glide, picking, alerts and follow all work.
- **What was not checked:** the edits to existing dev files in this guide were written against the dev source
  but not compiled inside fe-monorepo, and oxlint, fallow and the dev test suites were not run. Expect small fixes.

## Contents

1. [Before you start](#before-you-start)
2. [Step 0: demo harness and baseline](#step-0-demo-harness-and-baseline)
3. [Step 1: the live-tracks worker builds the map data](#step-1-the-live-tracks-worker-builds-the-map-data)
4. [Step 2: grid clusters in the worker](#step-2-grid-clusters-in-the-worker)
5. [Step 3: terrain spike](#step-3-terrain-spike)
6. [Step 4: WebGL drone layer behind a flag](#step-4-webgl-drone-layer-behind-a-flag)
7. [Step 5: make WebGL the default and remove the old path](#step-5-make-webgl-the-default-and-remove-the-old-path)
8. [Steps 6 and 7](#steps-6-and-7)
9. [Behaviour changes to list in the MRs](#behaviour-changes-to-list-in-the-mrs)
10. [Check the guide's code](#check-the-guides-code)

---

## Before you start

### Commands

| What | Command (from the fe-monorepo root) |
|---|---|
| Branch | `git switch dev && git pull && git switch -c feat/utm-live-tracks-step-0` (one branch per step) |
| Install | `pnpm install` |
| Mock app | `pnpm --filter @platform/utm dev:mock` (portless name `utm-mock`) |
| Real backend | `pnpm dev:p` |
| Unit + browser tests | `pnpm --filter @platform/utm test` |
| Browser tests only | `pnpm --filter @platform/utm test:browser` |
| Types, lint | `pnpm --filter @platform/utm typecheck`, `pnpm --filter @platform/utm lint` |

### Rules the code follows

These come from `CODING_STANDARDS.md` and `.agents/skills/no-use-effect`. Keep them when you change the code.

| Rule | How the new code follows it |
|---|---|
| No direct `useEffect`, `useMemo`, `useCallback` | `useMountEffect`, `useConstant`, `useAsRef`, `useSyncExternalStore` |
| Functions over classes | The store and the WebGL layer are factory functions (`createTrackStore`, `createTrackGlLayer`) |
| Comments start with one tag | `README:`, `DEVMODE:`, `TEMP:`, `QUESTION:` |
| `setTimeout` only with a reason | Each use has a `README:` comment |
| Tests first | Each step lists its tests before its code |
| No backward compatibility | The `track-webgl` flag is `TEMP:` and step 5 removes it with the old path |

### File map

| File (under `apps/utm/`) | New or changed | Step |
|---|---|---|
| `src/config/env/server.ts`, `mock-ws-server.ts`, `src/tests/mocks/handlers/track-ws.ts` | changed | 0 |
| `src/shared/domain/replay-monitor/track-perf.ts`, `track-perf-overlay.tsx`, `scripts/perf/live-tracks-scenario.ts` | new | 0 |
| `src/shared/domain/replay-monitor/live-tracks.types.ts`, `live-tracks-channel.ts`, `use-track-view-sync.ts` | new | 1 (types and channel grow in 2 and 4) |
| `src/worker/live-tracks/track-view.ts` | new | 1 |
| `src/worker/live-tracks-worker.ts` | replaced | 1, 2, 4 |
| `src/shared/domain/replay-monitor/use-live-tracks.tsx`, `track-layer-1.tsx`, `select-monitor-track.ts` | changed | 1 |
| `src/worker/live-tracks/track-clusters.ts` | new | 2 |
| `src/worker/live-tracks/track-store.ts`, `src/shared/domain/replay-monitor/track-gl-layer.ts`, `track-gl-layer-view.tsx`, `track-follow.ts`, `pick-live-track.ts`, `track-renderer.ts` | new | 4 |
| `src/config/env/public-runtime-env.ts`, `src/features/dashboard/monitor-map.tsx`, `monitor-map-interactions.tsx`, `src/shared/map/selected-track-follower.tsx`, `src/features/cuav/cuav-map.tsx` | changed | 4 |

---

## Step 0: demo harness and baseline

**Goal:** load the app with a production-like feed and record where the time goes. No product change.

### 0.1 Mock fleet size and batch rate

1. Replace `apps/utm/src/tests/mocks/handlers/track-ws.ts` with
   [`code/step-0/.../track-ws.ts`](fe-monorepo-guide/code/step-0/apps/utm/src/tests/mocks/handlers/track-ws.ts).
   It keeps `trackWsHandler` (30 tracks, full list every second, as today) and adds
   `createTrackWsHandler({ trackCount, batchesPerSecond })`. The first 30 tracks are the old mock tracks, so the
   REST mock still matches.
2. In `apps/utm/src/config/env/server.ts`, add two fields under `MOCK_WS_PORT`:

   ```ts
       MOCK_TRACK_COUNT: z.coerce.number().int().min(1).default(30),
       MOCK_TRACK_BATCHES_PER_SECOND: z.coerce.number().int().min(1).max(100).default(1),
   ```

3. In `apps/utm/mock-ws-server.ts`, use the factory:

   ```ts
   import { createTrackWsHandler } from './src/tests/mocks/handlers/track-ws'

   const server = createServer(
     http.get('/healthcheck', () => HttpResponse.json({ ok: true })),
     createTrackWsHandler({ trackCount: env.MOCK_TRACK_COUNT, batchesPerSecond: env.MOCK_TRACK_BATCHES_PER_SECOND }),
   )
   ```

4. Run it: `MOCK_TRACK_COUNT=15000 MOCK_TRACK_BATCHES_PER_SECOND=50 pnpm --filter @platform/utm dev:mock`.
   50 batches of 300 per second is the shape of dev's `live-track-pipeline.browser.test.tsx`.

### 0.2 Perf overlay

1. Copy [`track-perf.ts`](fe-monorepo-guide/code/step-0/apps/utm/src/shared/domain/replay-monitor/track-perf.ts) and
   [`track-perf-overlay.tsx`](fe-monorepo-guide/code/step-0/apps/utm/src/shared/domain/replay-monitor/track-perf-overlay.tsx)
   to `apps/utm/src/shared/domain/replay-monitor/`. The overlay shows raw JSON, so it has no UI copy to translate.
2. In `apps/utm/src/features/dashboard/monitor-map.tsx`, render `<TrackPerfOverlay />` after
   `<SelectionBoxOverlay coords={boxCoords} />`.
3. In `use-live-tracks.tsx`, count batches. In `worker.onmessage`, after `if (updates.length === 0) return`, add
   `countTrackBatch(updates.length)` (import it from `./track-perf`).
4. Open the monitor page with `?perf`. Every second the overlay shows batches/s, tracks/s, map fps, and long
   animation frames (count, total ms, blocking ms). The same numbers are in `window.__TRACK_PERF__`.

### 0.3 Scenario script

1. Copy [`scripts/perf/live-tracks-scenario.ts`](fe-monorepo-guide/code/step-0/apps/utm/scripts/perf/live-tracks-scenario.ts)
   to `apps/utm/scripts/perf/`. It runs with plain `node` (Node 24 strips the types).
2. Log in once and save the session: `node scripts/perf/live-tracks-scenario.ts --login --url <monitor URL>`.
   Use the monitor URL of the mock app, for example `https://utm-mock.localhost/monitor` (check the locale prefix
   in your browser).
3. Each run: `node scripts/perf/live-tracks-scenario.ts --url <monitor URL> --label step0-15k --renderer geojson`.
   It holds still at zoom 14, pans, zooms out to 8 and back, then pitches 45°. It writes a Chrome trace
   (`trace.json`, open it in DevTools > Performance), `samples.json` (`__TRACK_PERF__` each second),
   `react-renders.json` (react-scan) and a video to `perf-out/<label>/<renderer>/`.
4. Add `perf-out/` to `apps/utm/.gitignore`.

### Demonstration (baseline)

Run the scenario at 2000, 15000 and 30000 tracks (50 batches per second). Keep the output; every later step
compares against it. In the trace, look for:

- one main-thread task per batch for the `Track[]` copy from the worker;
- 4 times per second: `publishLiveTracks`, `encodeTrackPositions`, the GeoJSON message from `convert-worker`,
  `getTrackSourceDiff` (`isEqual`);
- the zoomed-out and pitched phases: these tasks grow with the whole fleet, because culling is off there;
- `setPaintProperty` every frame while an alert is in view.

In `react-renders.json`, `TrackDataHandler` and `WatchlistPanel` render up to 4 times per second.

**Done when:** the overlay, the script and the baseline output exist. No product behaviour changed.

---

## Step 1: the live-tracks worker builds the map data

**Goal:** the worker that already parses each batch also keeps the fleet, the alert state and the map views,
and sends each map only its visible tracks as a ready MapLibre diff. The main thread no longer encodes the
fleet, receives GeoJSON for the whole fleet or runs `isEqual`. Nothing changes on screen.

The main-thread store in `use-live-tracks.tsx` stays as it is (it still receives each batch), so
`useLiveTrackById`, `useLiveTrackPresence`, the follower, the history and the panels do not change.

### 1.1 Tests first

1. Add [`src/worker/live-tracks/track-view.test.ts`](fe-monorepo-guide/code/step-1/apps/utm/src/worker/live-tracks/track-view.test.ts):
   mercator projection, LOST_LINK after 5 s, alerts found by TrackNumber, culling with a pitched trapezoid and
   another world copy, and the diff (add, changed fields only, remove).
2. Rewrite `src/shared/domain/replay-monitor/live-track-pipeline.browser.test.tsx`. Keep its `useWebSocket` mock,
   `makeTrack` and the 15k API snapshot. Replace the hook and the test body:

   ```tsx
   import { setLiveTrackView, subscribeLiveTrackView } from './live-tracks-channel'
   import type { TrackViewUpdate } from './live-tracks.types'
   import { LiveTracksProvider, useLiveTrackListener } from './use-live-tracks'

   function applyViewUpdate(features: Map<number | string, GeoJSON.Feature>, update: TrackViewUpdate) {
     if (update.data) {
       features.clear()
       for (const feature of update.data.features) features.set(feature.properties.id, feature)
       return
     }
     for (const id of update.diff?.remove ?? []) features.delete(id)
     for (const feature of update.diff?.add ?? []) features.set(feature.id ?? '', feature)
     for (const change of update.diff?.update ?? []) {
       const feature = features.get(change.id)
       if (feature && change.newGeometry) features.set(change.id, { ...feature, geometry: change.newGeometry })
     }
   }

   it('sends a map view only its visible tracks of a 15k fleet, plus the selected track', async () => {
     expect.hasAssertions()

     // ...setQueryDefaults / setQueryData with 15000 tracks at 105.5 as before...
     view = renderHook(() => useLiveTrackListener(() => undefined), { wrapper: PipelineWrapper })
     const nearView = new Map<number | string, GeoJSON.Feature>()
     const farView = new Map<number | string, GeoJSON.Feature>()
     subscribeLiveTrackView(1, update => applyViewUpdate(nearView, update))
     subscribeLiveTrackView(2, update => applyViewUpdate(farView, update))
     setLiveTrackView(1, { corners: [[105.9, 21.1], [106.1, 21.1], [106.1, 20.9], [105.9, 20.9]], zoom: 17, selectedId: null, watchlistIds: null, renderer: 'geojson' }, true)
     setLiveTrackView(2, { corners: [[99.9, 10.1], [100.1, 10.1], [100.1, 9.9], [99.9, 9.9]], zoom: 17, selectedId: 1, watchlistIds: null, renderer: 'geojson' }, true)

     const frames = Array.from({ length: 50 }, (_, batch) => JSON.stringify(Array.from({ length: 300 }, (_, index) => makeTrack(batch * 300 + index + 1, 106))))
     await act(async () => {
       for (const data of frames) transport.receive(new MessageEvent('message', { data }))
       await expect.poll(() => nearView.size, { timeout: 5000 }).toBe(15000)
     })

     expect([...farView.keys()]).toEqual([1])
   })
   ```

   The views use zoom 17, so the test stays valid after step 2 (clusters stop at zoom 16).
3. Update `src/worker/live-tracks-worker.test.ts`: the worker now receives
   `{ type: 'BATCH', data: JSON.stringify(...) }` instead of the raw string. The expected `TRACKS_READY` message
   does not change.
4. Delete `src/shared/domain/replay-monitor/track-source-diff.test.ts` (its function moves into the worker and is
   covered by `track-view.test.ts`).
5. Keep `track-source-sync.browser.test.tsx` as the parity suite: style reload, offscreen pan, selected icon,
   heading and colour, follow. Its `blockFleetConversion()` blocks `TRANSFORM_TRACK_POSITIONS`, which the track
   layer no longer sends, so those cases now prove that the selected icon moves on its own report (the worker
   flushes a view at once when its selected track reports). Fix only the plumbing; keep the assertions.

### 1.2 New files

Copy from [`code/step-1/`](fe-monorepo-guide/code/step-1/apps/utm/src):

| File | What it does |
|---|---|
| `shared/domain/replay-monitor/live-tracks.types.ts` | Messages between the page and the worker; `TrackView` (padded view corners, zoom, selected ID, watchlist, renderer) |
| `shared/domain/replay-monitor/live-tracks-channel.ts` | The page side of the worker: `attachLiveTracksWorker`, `forwardLiveTrackBatch`, `sendLiveTrackSnapshot`, `sendLiveTrackAlerts`, `setLiveTrackView`, `subscribeLiveTrackView`. Queues alerts and the API snapshot until the worker starts. Resolves the status colours with the first map view. |
| `shared/domain/replay-monitor/use-track-view-sync.ts` | Registers a map as a view, sends the view on move (at most every 250 ms) and on selection, and applies `setData` or `updateData` to the track source. Asks for full data after a style reload. |
| `worker/live-tracks/track-view.ts` | Pure functions: mercator, status (alerts and LOST_LINK), culling, feature, diff |
| `worker/live-tracks-worker.ts` | Replaces dev's file. Same zod schema and `TRACKS_READY`. Adds the fleet `Map`, the 30 s expiry, alerts, views, and the view output (at most 4 per second, at once when a selected track reports). |

### 1.3 Changes to `use-live-tracks.tsx`

1. Import the channel:

   ```ts
   import { attachLiveTracksWorker, forwardLiveTrackBatch, sendLiveTrackSnapshot } from './live-tracks-channel'
   ```

2. Delete `type LiveTracksReadyMessage` and `const workerRef = useRef<Worker | null>(null)`.
3. Replace `initializeLiveTracksWorker`. The callback body is dev's `worker.onmessage` body, unchanged:

   ```tsx
   useMountEffect(function initializeLiveTracksWorker() {
     const worker = new Worker(new URL('../../../worker/live-tracks-worker.ts', import.meta.url), { type: 'module' })
     return attachLiveTracksWorker(worker, updates => {
       if (updates.length === 0) return
       countTrackBatch(updates.length)
       const receivedAt = Date.now()
       // README: Each socket batch contains only part of the fleet, never a complete snapshot.
       for (const track of updates) {
         // ...dev's loop, unchanged...
       }
       publishSocketTracks()
     })
   })
   ```

4. In `forwardTrackMessage`, replace `workerRef.current?.postMessage(message.data)` with
   `forwardLiveTrackBatch(message.data)`.
5. In `InitializeLiveTracks`, at the end of `initializeLiveTracksFromApi` (after `publishLiveTracks()`), add
   `sendLiveTrackSnapshot(latestTracksRef.current)`.

### 1.4 Changes to `track-layer-1.tsx`

1. Imports: remove `useAsRef`, `getCurrentLiveTrack`, `getCurrentLiveTracks`, `useLiveTracks`, `usePositionWorker`,
   `isEqual`, `GeoJSONFeatureDiff`, `GeoJSONSource`, `GeoJSONSourceDiff`, `useSelectedFeatureStore`, `Track` and
   `./track-viewport`. Add:

   ```ts
   import type { Map as MapLibreMap, MapGeoJSONFeature } from 'maplibre-gl'

   import { sendLiveTrackAlerts } from './live-tracks-channel'
   import type { TrackAlert } from './live-tracks.types'
   import { useTrackViewSync } from './use-track-view-sync'
   ```

2. Delete `getTrackSourceDiff` and `applySelectedTrackPosition`.
3. Move `processWebsocketAlert` out of the component to module level, unchanged except for three lines:
   - its parameter type becomes `ReturnType<typeof useMapsStore.getState>['latestWsAlertEvent']` (as before);
   - `alertActionsRef.current.removeAlertIds(removePayload)` becomes `sendLiveTrackAlerts([], removePayload)`;
   - `const alertWithLevels: Parameters<...>[0] = []` becomes `const alertWithLevels: TrackAlert[] = []`, and
     `alertActionsRef.current.setAlertIds(alertWithLevels)` becomes `sendLiveTrackAlerts(alertWithLevels, [])`.
4. Replace `TrackDataHandler` with:

   ```tsx
   function TrackDataHandler({ watchlistTrackIds }: TrackDataHandlerProps = {}) {
     const { current: map } = useMap()
     useTrackDroneIcon(map)
     // README: Keeps LiveTracksConnection, and so the worker, mounted while this layer is on a map.
     useLiveTrackListener(() => undefined)
     if (!map) return null
     return (
       <TrackDataBinding
         mapTarget={map.getMap()}
         watchlistTrackIds={watchlistTrackIds}
       />
     )
   }

   function TrackDataBinding({ mapTarget, watchlistTrackIds }: { mapTarget: MapLibreMap; watchlistTrackIds?: ReadonlyArray<number | string> }) {
     const [hasAlertInView, setHasAlertInView] = useState(false)
     const isMapLoaded = useMapsStore(s => s.isLoaded)
     useTrackViewSync({ mapTarget, sourceId: TRACK_SOURCE_ID, renderer: 'geojson', watchlistTrackIds, onAlertInViewChange: setHasAlertInView })

     useMountEffect(function listenForMapAlertClear() {
       const handleClearMapAlert = (e: Event) => {
         const detail: unknown = e instanceof CustomEvent ? e.detail : undefined
         const type = parseStringProperty(detail, 'type') ?? 'ALL'
         sendLiveTrackAlerts([], parseNumberArrayProperty(detail, 'trackIds').map(trackId => ({ trackId, type })))
       }
       window.addEventListener('map:clear-alert', handleClearMapAlert)
       return () => window.removeEventListener('map:clear-alert', handleClearMapAlert)
     })

     useMountEffect(function subscribeToWebsocketAlertEvents() {
       processWebsocketAlert(useMapsStore.getState().latestWsAlertEvent)
       return useMapsStore.subscribe((state, previous) => {
         if (state.latestWsAlertEvent !== previous.latestWsAlertEvent) processWebsocketAlert(state.latestWsAlertEvent)
       })
     })

     return (
       <>
         <TrackDataLayers />
         {hasAlertInView && isMapLoaded && <TrackAlertAnimation />}
       </>
     )
   }
   ```

   Alerts are now global (one worker), not one copy per layer. Two maps that both send the same alert event
   write the same keys, so this is safe.

### 1.5 Other changes

- `select-monitor-track.ts` (fixes the highlight for alerts that carry a TrackNumber):

  ```ts
      featureId: currentTrack?.ID ?? trackId,
      // ...
      properties: {
        ...additionalProperties,
        track_id: currentTrack?.ID ?? trackId,
  ```

- Delete `src/shared/domain/replay-monitor/track-viewport.ts`. Remove the now unused `getViewport` parameter of
  `usePositionWorker` if fallow flags it. Keep `convert-worker.ts`, `use-position-worker.ts` and
  `track-position-packet.ts`: the CUAV dashboard map (`features/cuav/dashboard/dashboard-map.tsx`) still uses them.

### Demonstration

Run the scenario at 15k and 30k with the step 0 labels and with `--label step1-...`. Compare:

- **Trace:** the 4-per-second `encodeTrackPositions`, GeoJSON receive, colour map and `getTrackSourceDiff` tasks
  are gone. In their place is one small `VIEW_UPDATE` message per map per flush, sized by the tracks in view.
  The zoomed-out and pitched phases improve most (the old path sent the whole fleet there).
- **Overlay:** `blockingMsPerSecond` and long frames drop; `mapFps` holds during pan at 15k.
- **react-scan:** `TrackDataHandler` no longer renders on publish.
- **Parity:** colours, alert pulse, acknowledge, watchlist mode, selection highlight (now also for alerts that
  carry a TrackNumber), follow, detail panel, history, manage-dashboard mini map, CUAV map. LOST_LINK now turns a
  silent track grey after 5 s (it never fired before; confirm the rule, open question 2 of the plan).

---

## Step 2: grid clusters in the worker

**Goal:** stop sending the fleet to supercluster. The worker groups the tracks in view into 80 px grid cells up
to zoom 16 (dev's `clusterMaxZoom` and `clusterRadius`), so a zoomed-out map gets a few hundred features.

### 2.1 Tests first

Add [`track-clusters.test.ts`](fe-monorepo-guide/code/step-2/apps/utm/src/worker/live-tracks/track-clusters.test.ts):
a lone track stays a track, nearby tracks become one cluster with a negative ID, counts are abbreviated like
supercluster (`1.2k`, `15k`).

### 2.2 Code

1. Copy [`track-clusters.ts`](fe-monorepo-guide/code/step-2/apps/utm/src/worker/live-tracks/track-clusters.ts) to
   `src/worker/live-tracks/`.
2. Replace `live-tracks.types.ts` and `live-tracks-worker.ts` with the [`code/step-2/`](fe-monorepo-guide/code/step-2/apps/utm/src)
   versions. The only worker change: at zoom 16 and below, `buildViewUpdate` returns the clustered features as
   full data.
3. In `track-layer-1.tsx`, remove `cluster`, `clusterMaxZoom` and `clusterRadius` from `<Source>` and from
   `trackLayer.sourceExtraProps`, and delete `TRACK_CLUSTER_MAX_ZOOM`. The cluster and single-bubble layers stay:
   the worker's cluster features carry `point_count` and `point_count_abbreviated` like supercluster's.

### Demonstration

Scenario at 15k and 30k, step 1 against step 2: in the zoom-8 phase the trace no longer shows supercluster in the
MapLibre worker, and the `VIEW_UPDATE` size stays a few hundred features when the mock fleet doubles. Parity:
cluster colours and sizes, single bubbles below zoom 11. Grouping differs a little (grid cells, not a radius);
say so in the MR.

---

## Step 3: terrain spike

A throwaway branch, not an MR. Copy the step 4 files, turn the flag on (`?trackRenderer=webgl` in dev), turn on
terrain (`features/dashboard/components/terrain-effect-layer.tsx`), pitch the map, and compare the drones with the
labels (labels are GeoJSON and follow the terrain). If the drones float or sink, decide one of:

- the worker samples the elevation per track (the page sends `map.queryTerrainElevation` results in the view), or
- step 4 falls back to `renderer: 'geojson'` while terrain is on.

Write the answer in the step 4 MR.

---

## Step 4: WebGL drone layer behind a flag

**Goal:** draw every drone with one instanced draw call per pass, glide it on the GPU between reports, and draw
the glow, tech ring and alert pulse in the shader. Behind the `track-webgl` flag; GeoJSON stays the default.

### 4.1 Tests first

1. Add [`track-store.test.ts`](fe-monorepo-guide/code/step-4/apps/utm/src/worker/live-tracks/track-store.test.ts):
   the glide starts at the drawn position, slots stay dense after removal, hidden tracks are not picked.
2. Add a browser test for the layer, modelled on the smoke test in
   [`verify/check.mjs`](fe-monorepo-guide/verify/check.mjs) and [`verify/smoke/main.ts`](fe-monorepo-guide/verify/smoke/main.ts):
   render the monitor map with `?trackRenderer=webgl`, feed batches, and assert (by reading canvas pixels and
   picks) that drones are drawn at zoom 17, nothing is drawn at zoom 10, a pick returns the track, and the image
   changes between two frames (glide).
3. In `live-tracks-worker.test.ts`, the worker now posts with a transfer list: expect
   `toHaveBeenCalledWith({ type: 'TRACKS_READY', data: [track] }, { transfer: [] })`.

### 4.2 New and replaced files

Copy from [`code/step-4/`](fe-monorepo-guide/code/step-4/apps/utm/src):

| File | What it does |
|---|---|
| `worker/live-tracks/track-store.ts` | Typed-array store: glide segments, swap-remove, origin re-base, pick, box pick, measured update interval |
| `worker/live-tracks-worker.ts` (replace) | Adds the store, styles per track (status, hidden when clustered or filtered), GPU frames (transferred, at most 3 in flight, 33 ms to 1 s by size), hover, pick and box queries |
| `shared/domain/replay-monitor/live-tracks.types.ts`, `live-tracks-channel.ts` (replace) | Adds frames, selection, hover, queries and the shared clock |
| `shared/domain/replay-monitor/track-gl-layer.ts` | The MapLibre custom layer. Icon: `drone1_out.png` with MapLibre's SDF edge (0.75), 256 px × 0.115. Glow 32 px, ring 22 px, pulse 22 → 60 px over 1.6 s, hover and selection overlay. |
| `shared/domain/replay-monitor/track-gl-layer-view.tsx` | `TrackGlLayerView` (adds the layer under the labels, hover pick, cursor) and `SelectedTrackGlFollower` |
| `shared/domain/replay-monitor/track-follow.ts` | Per-frame `jumpTo` on the gliding position; skips while the map moves, so it never cancels a `flyTo` |
| `shared/domain/replay-monitor/pick-live-track.ts` | Click and box picks in the worker (16 px radius; none below zoom 11, like the old symbol layer) |
| `shared/domain/replay-monitor/track-renderer.ts` | `isTrackWebGlEnabled()`: the flag, with a `?trackRenderer=` override in dev for side-by-side demos |

### 4.3 The flag

In `src/config/env/public-runtime-env.ts`:

```ts
const enabledFeatCatalog = ['track-webgl'] as const
// ...
type UtmFeatureFlag = FeatureFlag<UtmFeatureKey>
```

Turn it on with `VITE_ENABLE_FEAT=track-webgl` (dev `.env.local`, or the runtime environment of a deployment).

### 4.4 Changes to `track-layer-1.tsx`

1. Import `TrackGlLayerView` from `./track-gl-layer-view`, `isTrackWebGlEnabled` from `./track-renderer` and
   `type TrackRenderer` from `./live-tracks.types`.
2. Add `renderer?: TrackRenderer` to `TrackDataHandlerProps`, export `TrackDataHandler`, and pass the renderer on:

   ```tsx
   export function TrackDataHandler({ watchlistTrackIds, renderer = isTrackWebGlEnabled() ? 'webgl' : 'geojson' }: TrackDataHandlerProps = {}) {
     // ...as in step 1...
     return (
       <TrackDataBinding
         mapTarget={map.getMap()}
         watchlistTrackIds={watchlistTrackIds}
         renderer={renderer}
       />
     )
   }
   ```

3. In `TrackDataBinding`, take `renderer`, pass it to `useTrackViewSync`, and render:

   ```tsx
   return (
     <>
       <TrackDataLayers isWebGl={renderer === 'webgl'} />
       {renderer === 'webgl' && (
         <TrackGlLayerView
           mapTarget={mapTarget}
           beforeLayerId={TRACK_LABEL_LAYER_ID}
         />
       )}
       {renderer === 'geojson' && hasAlertInView && isMapLoaded && <TrackAlertAnimation />}
     </>
   )
   ```

4. In `TrackDataLayers({ isWebGl }: { isWebGl: boolean })`, when `isWebGl` is true:
   - do not render the alert-bound, glow and tech-ring layers. Write `{isWebGl ? null : <Layer ... />}` for each:
     react-map-gl's `<Source>` clones its direct children, so do not wrap layers in a fragment;
   - keep the `track-layer-1` symbol layer with `layout={{ ...TRACK_STYLES.DRONE_ICON_LAYOUT, visibility: 'none' }}`.
     It must exist: `interactiveLayerIds` and the box select look it up, and a missing layer makes MapLibre's
     feature queries fail for every layer. It is hidden, so it never returns a feature;
   - keep the label, cluster and single-bubble layers. Labels move once per report while icons glide.

### 4.5 Clicks, box select and follow

1. `src/features/dashboard/monitor-map-interactions.tsx`: change `import type { useMapsStore }` to a value
   import, import `pickLiveTrackAt`, `pickLiveTracksInBox` and `isTrackWebGlEnabled`, and add:

   ```ts
   export async function handleMonitorMapClick(e: MapLayerMouseEvent & { features?: GeoJSONFeature[] }, handlers: Parameters<typeof handleMapFeatureClick>[1]) {
     // README: Another layer's feature wins over a drone, as before; drones are picked in the worker only when nothing else was hit.
     const track = e.features?.[0]?.layer.id || !isTrackWebGlEnabled() ? undefined : await pickLiveTrackAt(e.target, e.point)
     if (!track) {
       handleMapFeatureClick(e, handlers)
       return
     }
     const trackId = String(track.track_id)
     if (e.originalEvent.ctrlKey || e.originalEvent.metaKey) handlers.toggleId(trackId)
     else handlers.setIds([trackId])
     handlers.toggleSelected({ type: 'track', featureId: track.id, sourceId: 'track-source-1', layerId: 'track-layer-1', lngLat: [e.lngLat.lng, e.lngLat.lat], properties: { ...track } })
     useMapsStore.getState().setSelectedTrackId(track.id)
   }
   ```

   In `handleSelectionBoxMouseUp`, after the `getLayer('track-layer-1')` check:

   ```ts
   if (isTrackWebGlEnabled()) {
     void pickLiveTracksInBox(e.target, boxCoords.start, boxCoords.end).then(tracks => {
       const foundIds = tracks.map(track => String(track.track_id))
       if (foundIds.length > 0) setIds(uniq([...useSelectionStore.getState().selectedIds, ...foundIds]))
     })
     setBoxCoords(null)
     e.target.dragPan.enable()
     return
   }
   ```

2. `src/features/dashboard/monitor-map.tsx`: `onClick={e => void handleMonitorMapClick(e, { handlersMap, clearSelectionStore, clearSelected, setIds, toggleId, toggleSelected })}`.
3. `src/shared/map/selected-track-follower.tsx`:

   ```tsx
   export function SelectedTrackFollower() {
     const { current: map } = useMap()
     if (!map) return null
     // TEMP: Remove the GeoJSON branch in step 5.
     if (isTrackWebGlEnabled()) return <SelectedTrackGlFollower mapTarget={map.getMap()} />
     return <SelectedTrackCamera mapTarget={map.getMap()} />
   }
   ```

4. `src/features/cuav/cuav-map.tsx` has its own click and follow code, so it stays on GeoJSON for now:
   replace `const CuavTracks = trackLayer.DataHandlerComponent` with

   ```tsx
   // TODO: Move CUAV clicks to pickLiveTrackAt, then use the WebGL renderer here too.
   function CuavTracks() {
     return <TrackDataHandler renderer="geojson" />
   }
   ```

   The manage-dashboard mini map has no click or follow, so it can use WebGL as is. Only one map per page draws
   with WebGL (the worker sends one frame stream).

### Demonstration

Scenario at 2k, 15k and 30k, `--renderer geojson` against `--renderer webgl` on the same build:

- **Video:** drones glide instead of jumping once per report; pan and zoom stay smooth at 15k.
- **Trace:** no `setPaintProperty` per frame; no MapLibre worker work for drone icons; per frame, a few uniforms
  plus one buffer upload when a frame arrives.
- **Overlay:** `mapFps` and long frames stay about the same from 15k to 30k (they fall with `geojson`).
- **Ceiling:** one run at 60k. Expect `JSON.parse` in the worker to become the first limit.
- **Parity:** sections B and D of `UTM-TRACK-FEATURES.md`; screenshots of each status colour, hover, selection,
  pulse and labels at zoom 11, 14 and 17, both renderers; click, ctrl-click, box select, follow, alert-panel
  fly-to (follow must not cancel it).

---

## Step 5: make WebGL the default and remove the old path

Only after step 4 ran in staging and the plan's open questions are answered.

1. Default to WebGL: delete `track-renderer.ts`, the `track-webgl` catalog entry and every `isTrackWebGlEnabled()`
   branch; keep `renderer: 'webgl'` paths only.
2. Delete the GeoJSON drone layers (alert bound, glow, tech ring), `TrackAlertAnimation` and `SelectedTrackCamera`.
3. Move the CUAV map click to `pickLiveTrackAt`, then the CUAV dashboard map (`dashboard-map.tsx`) to a view of
   the worker. Then delete `convert-worker.ts`, `use-position-worker.ts`, `track-position-packet.ts` and their tests.
4. Run the step 4 scenario on the default build and the e2e parity checks.

---

## Steps 6 and 7

- **Step 6** (optional): the worker still posts every batch to the main-thread store (`TRACKS_READY`), about
  30–60 ms per second at 15k. Post only the tracks the page reads (selected, alerts, watchlist, history targets)
  plus the full list at most once per second while a full-list reader (`useLiveTracks`) is mounted. Then, if the
  trace still shows a task per batch, open the WebSocket inside the worker.
- **Step 7** (backend): region subscriptions over NATS, see the plan and `U1-BACKEND-INTEGRATION.md`. The step 4
  store and layer do not change.

---

## Behaviour changes to list in the MRs

| Change | Step |
|---|---|
| LOST_LINK fires: a track silent for 5 s turns grey (it never did) | 1 |
| Alert highlight works for alerts that carry a TrackNumber | 1 |
| Clusters are grid cells, not supercluster radius groups | 2 |
| Drones glide; the drawn position is about one report interval behind the newest report | 4 |
| Icons rotate with the map when the map is rotated (the old symbol layer kept them screen-aligned) | 4 |
| Mode3a labels jump once per report while the icon glides under them | 4 |
| Hover and selection glow is drawn as an overlay, so it is slightly brighter than the old 0.4 opacity | 4 |
| Drones are drawn at sea level when terrain is on, unless step 3 says otherwise | 4 |

## Check the guide's code

[`fe-monorepo-guide/verify/`](fe-monorepo-guide/verify) checks the files in `code/` outside fe-monorepo. It
overlays `code/step-0` up to the chosen step on small stubs of the dev modules they import (`stubs/`), then:

```bash
cd docs/fe-monorepo-guide/verify
npm ci
node check.mjs              # type check (strict) and unit tests for steps 0, 1, 2 and 4
node check.mjs --smoke      # also runs the step 4 code in Chrome (or Edge) with MapLibre 6.12 and 5000 tracks
```

The smoke test reads the drone icon from the fe-monorepo clone next to this repo (`--fe-monorepo <path>` to
change it) and needs Chrome or Edge (`--chrome <path>`). Its checks: no errors; frames carry the whole fleet;
clusters and no icons at zoom 10; icons and no clusters at zoom 17; a pick returns the CRITICAL alert that was
queued before the worker started and keyed by TrackNumber; drones glide; the selected alert drone is red with its
pulse; follow keeps the drone at the map centre.

The stubs are not the real dev modules. When dev changes `track-wire.ts`, `status-colors.ts`,
`selected-feature-store.ts` or the `@platform/lib` helpers, update `stubs/` too.
