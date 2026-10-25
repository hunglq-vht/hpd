# UTM drone-track features vs. the new rendering solution

This file lists every live-track feature in fe-monorepo `apps/utm`, and checks whether each one still works with the new solution (Web Worker + typed-array store + GPU-interpolated WebGL layer).

**Scope and method:**

- `apps/utm` only. The logistic app was not checked.
- Found by reading the code on 2026-10-25. Nothing was changed, and the app was not run.
- Paths are relative to `apps/utm/src` unless they start with `packages/`.

**Short answer:** the new solution can be applied without losing any feature. Most features need an adapter, because several rely on MapLibre finding GeoJSON features on the map, and a custom WebGL layer has none. A few features behave differently and need a decision. One feature (LOST_LINK) is broken today and would be fixed.

## Contents

1. [Verdicts](#verdicts)
2. [Feature list](#feature-list)
3. [Changes needed](#changes-needed)
4. [Bugs found in the current code](#bugs-found-in-the-current-code)
5. [Behavior changes and risks](#behavior-changes-and-risks)
6. [Suggestions](#suggestions)
7. [Open questions](#open-questions)
8. [Sources](#sources)

---

## Verdicts

| Verdict | Meaning | Count |
|---|---|---|
| **Keep** | No change needed | 6 |
| **Adapt** | Works after the change listed | 18 |
| **Decide** | Behavior differs; needs a decision | 1 |
| **Fix** | Fixes a current bug | 1 |

## Feature list

### A. Live data feed

| # | Feature | Today | With the new solution | Verdict |
|---|---|---|---|---|
| 1 | Track feed | REST snapshot `/utm-track-manager/tracks`, then WebSocket `/utm-track-manager/ws/tracks`. The mock sends the full list every 1 s. Auth by cookie, or `protocols` for Direct Password-Grant. 20 reconnects, backoff up to 10 s. | Keep `useWebSocket` on the page. Forward each raw message to the worker in `onMessage`, and add `filter: () => false` so React does not re-render per message. The worker parses, validates and stores. The REST snapshot is posted to the worker once. | Adapt |
| 2 | Fan-out to consumers | `useLiveTracks()` has 7 call sites in 6 files. Each one parses the JSON, runs zod over the full list and renders twice per message. | Replace with small hooks fed by the worker (see [Changes needed](#changes-needed), item 3) | Adapt |

The 7 `useLiveTracks()` call sites:

- `shared/domain/replay-monitor/track-layer-1.tsx:254`
- `routes/_protected-layout/_main-layout/monitor/monitor-page.tsx:286` (`SelectedTrackFollower`)
- `routes/_protected-layout/_main-layout/monitor/monitor-page.tsx:1086` (`useMonitorPageState`: alert pruning, alert select)
- `features/dashboard/components/alert-panel.tsx:54`
- `features/dashboard/components/watchlist-panel.tsx:31`
- `features/dashboard/model/use-pending-alert-map-focus.ts:12`
- `shared/domain/replay-monitor/track-detail.tsx:381`

### B. Map drawing (`track-layer-1.tsx`)

| # | Feature | Today | With the new solution | Verdict |
|---|---|---|---|---|
| 3 | Drone icon (zoom >= 11) | `drone1_out.png` as SDF, size 0.115, rotated by heading, colored by status. White on hover or selection, unless the drone has an alert. | Shader: PNG alpha as the shape, one status value per drone mapped to `STATUS_COLORS`, plus the glide | Adapt |
| 4 | Glow aura and tech ring | Circle layers: glow radius 32 (opacity 0.15, or 0.4 on hover/selection); ring radius 22 | Computed in the shader | Adapt |
| 5 | Alert radar pulse | WARNING/CRITICAL drones get a ring growing 22 to 60 px over 1.6 s, driven by `setPaintProperty` every frame | Time-driven in the shader. The per-frame `setPaintProperty` goes away. | Adapt |
| 6 | Mode3a label (zoom >= 12) | Symbol layer, status color, halo | Keep a symbol layer, fed by the worker with visible tracks only, capped. Labels update at a fixed rate; at 1 Hz they jump while icons glide. | Decide |
| 7 | Clusters (zoom <= 10) and single-drone bubbles (zoom < 11) | supercluster, radius 80, color/size steps at 100 and 750, abbreviated count | Worker grid clusters sent as GeoJSON, same paint. A 1-drone cell covers the "cluster of 1" case, so 2 layers go away. Grouping differs slightly (grid vs. radius). Clusters are not clickable today, so no click flow is lost. | Adapt |
| 8 | Watchlist-mode filter | `createTrackLayer` keeps tracks whose ID, TrackNumber or Mode3a is in the list | A `filter` message to the worker. Frames, clusters and picks all use the filtered set. | Adapt |
| 9 | Manage-dashboard mini map (`map-panel.tsx`) | Uses the same `trackLayer`, no click handling | Same layer component, one engine per page | Adapt |

### C. Track status

| # | Feature | Today | With the new solution | Verdict |
|---|---|---|---|---|
| 10 | Alert status from the alerts stream | `latestWsAlertEvent` sends `ALERT_TRACKS` / `REMOVE_ALERT_TRACKS`. Victim and secondary drones are forced to WARNING. Resolved events remove by type. Priority: CRITICAL > WARNING > LOST_CONTROL > PROCESSING. | Same logic moves into the new worker and sets each drone's status value | Keep |
| 11 | Acknowledge / dismiss | Window event `map:clear-alert` removes alerts for the track and its victim | Same listener, posting to the new worker | Keep |
| 12 | LOST_LINK grey | **Broken** (see [Bugs found](#bugs-found-in-the-current-code)) | The store already keeps `lastSeen` per drone: hold a silent drone N seconds, draw it grey, then evict it | Fix (needs a rule) |

### D. Map interaction

| # | Feature | Today | With the new solution | Verdict |
|---|---|---|---|---|
| 13 | Click to select | `interactiveLayerIds` + `e.features` build a `SelectedFeatureInfo` (type `track`, `featureId` = `properties.id`, source `track-source-1`, layer `track-layer-1`), then `toggleSelected`. Ctrl adds to `useSelectionStore`. `trackLayer.onClick` sets `selectedTrackId`. Clicking empty map clears all. | A custom layer gives no `e.features`. In `handleClick`, when no feature was hit, await `engine.pick()` **before** clearing. The worker returns the same properties, so the same `SelectedFeatureInfo` is built. | Adapt |
| 14 | Hover | `setFeatureState({hover})` + pointer cursor | Mousemove pick, throttled to one per frame, sends a hover id to the layer and sets the cursor | Adapt |
| 15 | Ctrl-drag box select | `queryRenderedFeatures(box, {layers: ['track-layer-1']})` | Unproject the 4 box corners; the worker tests drawn positions against that shape. Works with rotation and pitch. | Adapt |
| 16 | Selection highlight | `SelectedFeatureStateSync` calls `setFeatureState(source, id)`. Panels select with `featureId = alert.track_id`, which can be a TrackNumber. | For type `track`, call `engine.select(id)` instead. The worker resolves by ID first, then TrackNumber. | Adapt |
| 17 | Follow target | `easeTo` over 1000 ms on every message. Drag pauses it; the detail panel toggles it; selecting a track turns it on. | Every frame, `jumpTo` the drone's current gliding position, unless the map is already moving | Adapt |

### E. Panels that read live data

| # | Feature | Today | With the new solution | Verdict |
|---|---|---|---|---|
| 18 | Track detail | REST extended info, plus live lat/lon/alt/velocity/heading/UpdatedAt found in the full track list | The worker sends the selected track's raw fields about 4 times per second; a `useLiveTrack` hook reads them | Adapt |
| 19 | Alert panel click | Finds the track's position (falls back to the alert's detected position), then flies to zoom 17 and selects | `engine.lookup(id)`: async request/response, like pick | Adapt |
| 20 | Alert pruning + toast auto-dismiss (`monitor-page.tsx`) | An alert shows only while its `track_id` is in the live list. Before any data arrives, all show. | The worker watches the alert track ids and returns the alive subset per message. Keep "show all until the first data". | Adapt |
| 21 | Watchlist panel | Matches items to live tracks (Mode3a, ID or TrackNumber vs. `drone_id` / `registration_id`, lowercase). Live first; search includes TrackNumber; shows live values. Select flies to zoom 17. | Same matching rules run in the worker and return a small result per message | Adapt |
| 22 | Alert toast focus on the monitor page | Looks up the track, flies to zoom 16, selects | `engine.lookup` | Adapt |

### F. Not affected

| # | Feature | Notes | Verdict |
|---|---|---|---|
| 23 | Selected track history line + arrows | REST `track-histories`, polled every 1 s, drawn as GeoJSON. The line ends at the latest report while the icon glides about 1.15 s behind, so the line tip can lead the icon slightly. | Keep |
| 24 | Altitude realtime chart | Same REST poll | Keep |
| 25 | Stat bar collapse on selection (`measurement-bar.tsx`) | Reads only the selection stores | Keep |
| 26 | Replay page (dynamic and static replay) | Not the live feed. Dynamic replay could later use the same engine, fed from replay chunks. | Keep |

## Changes needed

1. **Own the engine at page level.** Use a provider in `MainMapComponent` and `MapPanel`, not inside the layer component. `createTrackLayer` builds a new component function on every call; if its identity changes, the layer remounts and would recreate the worker.
2. **Feed path: page `useWebSocket` to worker.** This keeps auth, reconnect, socket sharing and the mock WebSocket server. Moving the socket into the worker can come later.
3. **Worker messages beyond the demo's:**
   - **Page to worker:** filter, alert add/remove, select (by ID or TrackNumber), pick, box pick, hover, lookup, watch alert ids, watchlist items.
   - **Worker to page:** the matching answers, plus frames, clusters, labels, the selected track, status and stats.
4. **Keep the `SelectedFeatureInfo` shape and the ids `track-source-1` / `track-layer-1`.** The detail-panel lookup, the stat bar and the selection stores depend on them.
5. **Remove `track-layer-1` from `interactiveLayerIds`**, and skip `setFeatureState` for type `track`.
6. **Tests.** The `pruneTrackState` test in `worker/convert-worker.test.ts` moves with that logic. jsdom has no Worker or WebGL, so put the engine behind an interface and mock it in tests.
7. **Style parity in shaders.** PNG alpha mask tinted by `STATUS_COLORS` (NORMAL `#39FF14`, WARNING `#FFD600`, CRITICAL `#FF2B2B`, LOST_LINK `#9CA3AF`, PROCESSING `#00BFFF`, LOST_CONTROL `#FF2B2B`), glow, tech ring, pulse.

## Bugs found in the current code

| Bug | Where | Effect | Fixed by the new solution? |
|---|---|---|---|
| LOST_LINK never fires | `worker/convert-worker.ts:97-108` | `lastSeen = now` is set for every track in the message, then `now - lastSeen > 5000` is checked in the same pass, so it is never true. Tracks missing from a message are dropped at once. | Yes, after a rule is chosen |
| Selection highlight misses some tracks | `monitor-page.tsx` `SelectedFeatureStateSync` | Panels select with `alert.track_id`. When that is a TrackNumber, `setFeatureState` targets an id that does not exist. | Yes (`engine.select` resolves ID, then TrackNumber) |
| Follow probably cancels fly-to (not seen in a browser) | `monitor-page.tsx` `SelectedTrackFollower` | Selecting an alert flies to zoom 17 over 2 s and turns follow on. The next message's `easeTo` would cancel that fly-to partway. | Yes (follow skips frames while the map moves) |

## Behavior changes and risks

- **Display lag.** Icons show about 1.15 s behind the latest report. Panels show the raw latest values. Today icons jump straight to each report.
- **History line tip leads the icon** by that same lag.
- **3D terrain.** Users can turn on terrain (`setTerrain`, exaggeration 1.2, `terrain-effect-layer.tsx`). GeoJSON layers follow the terrain, but a custom layer using `mainMatrix` draws at sea level, so icons would be offset when the map is pitched. I don't know whether MapLibre 5.24 gives custom layers access to terrain height. This needs a small test first.
- **Click priority.** A drone pick and other layers' features (stations, zones) can both hit the same click. A rule is needed.
- **Cluster grouping** changes slightly (grid cells instead of supercluster radius).

## Suggestions

- **Ship in two MRs.**
  - MR 1: add the engine and the small hooks, but keep the current GeoJSON layer, fed from the worker once per second. This removes the 7x parse and render cost with no visual change, and can be measured.
  - MR 2: swap in the WebGL layer.
- **Resolve "ID or TrackNumber" once, in the worker.** Today that check is copied into five places.
- **Add a small dev performance overlay** (messages/s, frame time), like the demo's HUD, to measure each step.

## Open questions

1. What track count and message rate are expected in production, and is every message the full list? The mock sends the full list every second.
2. What is the LOST_LINK rule: server `UpdatedAt` or receive time, and how long does a silent track stay on the map?
3. Must Mode3a labels move smoothly with the icons?
4. When a click hits both a drone and a station or zone, which wins?
5. Is about 1 s of display lag acceptable?
6. With terrain on, should drones sit on the terrain, or at their reported `Altitude`?

## Sources

- `apps/utm/src/shared/domain/replay-monitor/track-layer-1.tsx`
- `apps/utm/src/shared/domain/replay-monitor/use-live-tracks.ts`
- `apps/utm/src/shared/domain/replay-monitor/use-position-worker.ts`
- `apps/utm/src/shared/domain/replay-monitor/track-layer-styles.ts`
- `apps/utm/src/shared/domain/replay-monitor/track-detail.tsx`
- `apps/utm/src/shared/domain/replay-monitor/track-altitude-realtime-chart.tsx`
- `apps/utm/src/shared/domain/replay-monitor/get-tracks.ts`
- `apps/utm/src/shared/domain/replay-monitor/get-track-history.ts:76`
- `apps/utm/src/shared/domain/replay-monitor/track-replay-dynamic-layer.tsx`
- `apps/utm/src/shared/domain/replay-monitor/use-track-playback.ts`
- `apps/utm/src/worker/convert-worker.ts:97-108`
- `apps/utm/src/routes/_protected-layout/_main-layout/monitor/monitor-page.tsx:245-344, 379-488, 1006-1013, 1085-1123, 1188-1262`
- `apps/utm/src/features/dashboard/components/alert-panel.tsx`
- `apps/utm/src/features/dashboard/components/watchlist-panel.tsx`
- `apps/utm/src/features/dashboard/components/track-history-layer.tsx`
- `apps/utm/src/features/dashboard/components/measurement-bar.tsx`
- `apps/utm/src/features/dashboard/components/terrain-effect-layer.tsx`
- `apps/utm/src/features/dashboard/model/use-pending-alert-map-focus.ts`
- `apps/utm/src/features/dashboard/lib/apply-alerts-stream-message.ts`
- `apps/utm/src/features/manage-dashboard/components/map-panel.tsx`
- `apps/utm/src/shared/map/selected-feature-store.ts`
- `apps/utm/src/shared/map/map.types.ts`
- `apps/utm/src/shared/auth/utm-websocket-options.ts`
- `apps/utm/mock-ws-server.ts`
- `packages/lib/src/websocket/core/use-websocket.ts`
- `packages/lib/src/websocket/connection/attach-shared-listeners.ts`
- `packages/ui/src/components/map/core/store/maps-store.ts`
- `pnpm-workspace.yaml` (maplibre-gl ^5.24.0, react-map-gl ^8.1.3)
