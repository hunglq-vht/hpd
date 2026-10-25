# Learning Q&A: rendering many live drones smoothly

My clarification questions while learning this solution, each with a summary of the answer.

**Two codebases are referenced:**

- **Questions 1–6: this repo (HPDMB).** Paths are relative to the repo root. Those answers describe `main`. On the branch `implement-functional-component`, the `Controller` class was split into hooks and components. Its animation loop (shader clock + camera follow) now lives in `frontend/src/map/DroneLayer.tsx`, and its viewport logic in `frontend/src/map/ViewportSync.tsx`.
- **Questions 7–11: the demo project from guide #2.** It lives at `C:\Users\T480S\AppData\Local\Temp\claude\D--HPDMB\a3961ac7-b920-4776-8e5f-99f318bb0fe5\scratchpad\drones-demo`. That's a temp folder, so copy it somewhere permanent to keep it.

**Guides written during this session:**

- [Smooth Live Drones: A Beginner's Build Guide](https://claude.ai/artifact/PGZubESghCftDKcS7x2ceM) applies the scheme to fe-monorepo. Its code was not compiled.
- [Build a Live Drone Map from Scratch](https://claude.ai/artifact/E5TnUtbKz3ALdEPMqNVJP9) is a standalone guide. Its code was compiled and run: 100k drones at about 60 fps.

## Contents

1. [Where does the smooth motion happen?](#1-where-does-the-smooth-motion-happen)
2. [Does the backend send only coordinates, with the frontend interpolating?](#2-does-the-backend-send-only-coordinates-with-the-frontend-interpolating)
3. [Where are the track icons stored?](#3-where-are-the-track-icons-stored)
4. [Is drawing icons in code faster than PNG + SDF?](#4-is-drawing-icons-in-code-faster-than-png--sdf)
5. [What should I read, and how does the solution flow?](#5-what-should-i-read-and-how-does-the-solution-flow)
6. [How could this scheme go into fe-monorepo's track-layer-1.tsx?](#6-how-could-this-scheme-go-into-fe-monorepos-track-layer-1tsx)
7. [What is a typed array?](#7-what-is-a-typed-array)
8. [How does typed-array storage get evicted when drones disappear?](#8-how-does-typed-array-storage-get-evicted-when-drones-disappear)
9. [What do the ToWorker and FromWorker messages mean?](#9-what-do-the-toworker-and-fromworker-messages-mean)
10. [What does "glide" mean?](#10-what-does-glide-mean)
11. [How does DroneLayer.ts work, compared with GeoJSON drawing?](#11-how-does-dronelayerts-work-compared-with-geojson-drawing)
12. [Open items](#open-items)

---

## 1. Where does the smooth motion happen?

> "Where is the part that make the tracks move smoothly?"

Two pieces work together. Once per update, the CPU (in the worker) sets up a short movement segment for each drone. On every frame, the GPU moves each drone along its segment.

**The GPU vertex shader**, `frontend/src/map/TrackLayer.ts:27-32`:

```glsl
float f = clamp((u_now - a_meta.x) / u_interp, 0.0, 1.0);   // progress 0→1 since t0
vec2 pos = mix(a_seg.xy, a_seg.zw, f);                        // start → end
float d = a_meta.z - a_meta.y;
d -= TAU * floor((d + 3.14159265) / TAU);                     // turn the short way
float h = a_meta.y + d * f - u_bearing;
```

Each drone carries a start point, an end point and a start time `t0`. The shader places it between the two points based on the time since `t0`. Data arrives at 1 Hz, but drones move at the screen's refresh rate, and the CPU does no per-drone work per frame. The clock (`u_now`) is set on every `requestAnimationFrame`: `layer.now = …` in `frontend/src/map/DroneLayer.tsx:24` on the branch, `controller.ts:176-178` on `main`.

**`TrackStore.commit()` builds the segments**, `frontend/src/shared/trackStore.ts:131-157`, in the worker. A new segment starts from where the drone is currently drawn, not from the last reported point:

```ts
const f = Math.min(1, Math.max(0, (now - t0[s]) / interp));
px[s] += (cx[s] - px[s]) * f;   // new start = current drawn position
py[s] += (cy[s] - py[s]) * f;
ph[s] = lerpAngle(ph[s], h[s], f);
cx[s] = nx[s];                  // new end = newest reported position
cy[s] = ny[s];
```

So an early or late update changes the drone's course without making it jump.

**The 1.15× glide time.** `interp` = 1.15 × the update interval (`trackStore.ts:46`, `tracks.worker.ts:68`). The extra 15% keeps each drone moving until the next update arrives, so drones never stop and start. The cost is that the display runs about one interval behind. See `docs/IMPLEMENTATION.md` §4.3.

---

## 2. Does the backend send only coordinates, with the frontend interpolating?

> "So the backend only send coordinate updates, then the frontend side interpolate the continuous position?"

**Yes.**

**The backend** (`backend/internal/sim/publish.go`) publishes once per tick (1 Hz): one binary snapshot per zoom-13 tile over NATS, 16 bytes per drone (id, position in tile, altitude, heading, speed, type, battery). These are full snapshots, not changes. The backend does nothing for smooth motion.

**The frontend:**

1. The worker decodes the snapshot (`TrackStore.ingest`).
2. `commit()` builds a segment from the drone's drawn position to the new report.
3. The vertex shader computes the in-between position on every frame.

**It's interpolation, not prediction.** The frontend only moves drones between positions it has already received, so it runs about one interval behind. Speed and heading are reported, but they're only shown in the panel and used to rotate the icon. `docs/ASSESSMENT.md:60` lists dead reckoning (predicting from heading and speed) as a way to cut the lag.

---

## 3. Where are the track icons stored?

> "In this repo, where are the icon of tracks stored? Or these icons are declared inside code?"

**In code.** There are no icon image files. `frontend/src/map/droneAtlas.ts` → `drawDroneAtlas()` draws them on an offscreen `<canvas>` as one 256×64 atlas, with a 64×64 cell per drone type:

| Cell | Type | Colour | Drawn by |
|---|---|---|---|
| 0 | Quadcopter | `#38bdf8` | `drawMulticopter(g, 4, …)` |
| 1 | Hexacopter | `#4ade80` | `drawMulticopter(g, 6, …)` |
| 2 | Fixed-wing | `#fbbf24` | `drawFixedWing` |
| 3 | Emergency | `#f87171` | `drawMulticopter(…, emergency=true)`, adds a white cross |

Every icon points north, and the shader rotates it.

- **Upload:** `TrackLayer.ts:161-169` premultiplies the alpha (MapLibre's blend format) and uploads the atlas as a texture.
- **Cell choice:** the fragment shader picks the cell from `v_kind`.
- **Shader effects, not in the atlas:** the low-battery blink (`TrackLayer.ts:57-58`) and the selection ring (`FS_RING`).

The type is packed as `kind + 4` for low battery and decoded with `mod(a_kind, 4.0)`, which limits it to 4 types.

---

## 4. Is drawing icons in code faster than PNG + SDF?

> "Does self-drawing improve the performance compared to importing png (+sdf to change color)"

**No measurable difference.**

- **Per frame:** either way the GPU ends up with a small RGBA texture and does one lookup per pixel. An SDF adds a few shader instructions, which is negligible.
- **Startup:** drawing on a canvas takes under 1 ms and is synchronous. A PNG means one small request plus a decode. It's asynchronous, so you write extra code for "texture not ready yet."
- **The real bottleneck** is uploading the instance buffer (`docs/PERFORMANCE.md:61-63`): at about 470k instances, `bufferSubData` jumps from about 3 ms to about 55 ms. The icon texture isn't a factor.

| | Canvas in code | PNG | SDF |
|---|---|---|---|
| Loading | none, synchronous | fetch + decode, async | fetch + decode + an SDF generation step |
| Multi-colour detail | ✓ | ✓ | ✗ one tint (single-channel) |
| Sharp when scaled up a lot | soft | soft | ✓ |
| Designer-editable | ✗ | ✓ | ✓ |
| Per-drone recolour | ✓ shader tint | ✓ | ✓, cleanest |

You don't need an SDF to recolour: the shader can tint an RGBA icon. These detailed, multi-colour icons, which only vary in size between 0.85× and 1.15×, don't need the SDF's main strength of staying sharp at any scale. The choice comes down to who maintains the icons, not speed.

---

## 5. What should I read, and how does the solution flow?

> "The techniques used in this solution are quite new to me … Recommend documents for me to start and make a clear flow of how the solution works"

**The core idea:** data arrives about once per second, but the screen redraws about 60 times per second. The CPU handles each drone once per update. The GPU handles every drone on every frame.

```
BACKEND (Go), every 1 s
 ① move 1 M drones             backend/internal/sim/fleet.go
 ② group by z13 tile           backend/internal/sim/publish.go
 ③ encode a snapshot per tile  backend/internal/wire/wire.go  (32 B header + 16 B/drone)
 ④ publish to NATS             tracks.13.<x>.<y>
                │
          NATS server ──► api: /api/stats (clusters, zoom < 13), /api/topics (subjects for a viewport)
                │
                ▼ WebSocket /nats (only the subjects the browser asked for)
UI THREAD (React + MapLibre)                 WEB WORKER (tracks.worker.ts)
camera moves → ViewportSync (was Controller)
  zoom < 13 → /api/stats → circle layers
  zoom ≥ 13 → /api/topics ── subjects ──►   ⑤ subscribe / unsubscribe
                                            ⑥ each message: TrackStore.ingest()
                                            ⑦ frameLoop: commit(), evict(), pack 9 floats/drone
TrackLayer.setFrame() ◄── transferred ArrayBuffer
⑧ requestAnimationFrame: layer.now = shared clock
⑨ TrackLayer.render(): upload if new, ONE drawArraysInstanced
GPU ⑩ vertex shader: pos = mix(start, end, (now − t0)/interp), rotate, fixed pixel size
    ⑪ fragment shader: sample icon atlas, battery blink, ring pulse
```

**Three rules** (`docs/IMPLEMENTATION.md` lines 3–12):

1. Receive only what the screen can show.
2. Keep heavy work off the UI thread.
3. Let the GPU do the per-frame work.

**Learning path, in order:**

1. **Maps and tiles:** [Slippy map tilenames](https://wiki.openstreetmap.org/wiki/Slippy_map_tilenames), [Tiles à la Google Maps](https://docs.maptiler.com/google-maps-coordinates-tile-bounds-projection/)
2. **Messaging:** [NATS Subjects](https://docs.nats.io/nats-concepts/subjects)
3. **Threads and binary data:** [MDN Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers), [Transferable objects](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects), [Typed arrays](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Typed_arrays)
4. **Smooth motion:** [Entity Interpolation (Gambetta)](https://www.gabrielgambetta.com/entity-interpolation.html), [Snapshot Interpolation (Gaffer On Games)](https://gafferongames.com/post/snapshot_interpolation/)
5. **GPU / WebGL2:** [WebGL2 Fundamentals](https://webgl2fundamentals.org/): Fundamentals, [How It Works](https://webgl2fundamentals.org/webgl/lessons/webgl-how-it-works.html), Shaders and GLSL, Textures, [Instanced Drawing](https://webgl2fundamentals.org/webgl/lessons/webgl-instanced-drawing.html). [The Book of Shaders](https://thebookofshaders.com/) covers `mix`, `smoothstep` and `clamp`.
6. **WebGL inside MapLibre:** [Add a custom style layer](https://maplibre.org/maplibre-gl-js/docs/examples/add-a-custom-style-layer/)

**Reading order for this repo:**

1. `README.md`
2. `docs/PROTOCOL.md`
3. `docs/IMPLEMENTATION.md` §1 and §4
4. The code, in data order: `publish.go` → `wire.ts` → `tracks.worker.ts` → `trackStore.ts` → `map/*.tsx` → `TrackLayer.ts`

**Experiments:**

- Change `s * 1.15` to `s * 0.05` in `tracks.worker.ts:68` and drones jump instead of gliding.
- Run with `TICK_MS=3000` for longer, easier-to-see glides.
- Try the Stress test in the Performance panel.

---

## 6. How could this scheme go into fe-monorepo's track-layer-1.tsx?

> "…check for newly added repository fe-monorepo how can I add this scheme to the apps/utm/.../track-layer-1.tsx for displaying large number of drones like that"

**Why the current layer slows down with many drones:**

1. `useLiveTracks()` has 4 callers (`track-layer-1.tsx`, `alert-panel.tsx`, `watchlist-panel.tsx`, `track-detail.tsx`). Each one runs zod on the full list on the main thread on every message, and re-renders.
2. The full list is copied to `convert-worker.ts`, GeoJSON comes back (a second copy), and `<Source data>` copies it again. MapLibre then rebuilds the clusters and the symbol layout on every message.
3. There's no interpolation, so icons jump.
4. The alert ring calls `setPaintProperty` on every frame.

**Plan.** Each step can ship on its own:

1. **Engine worker:**
   - Move the WebSocket into a worker. Cookie auth still works there; for password-grant, pass `protocols` in the init message.
   - Port the typed-array store with a JSON ingest.
   - Move the alert, lost-link and watchlist logic into the worker.
2. **WebGL layer:**
   - Port `TrackLayer.ts` and keep the id `track-layer-1`.
   - Store a status colour per instance and tint `drone1_out.png` in the shader.
   - Draw the glow, tech ring and alert pulse in the shader from `u_now`. That removes `setPaintProperty`.
3. **Clusters below zoom 11:** a grid computed in the worker, at most once per second, drawn by the existing circle layers without `cluster: true`.
4. **Picking:** `queryRenderedFeatures` can't see custom layers, so click, hover and box select ask the worker instead.
5. **Labels:** keep a capped symbol layer for tracks in view. Labels update once per second and don't glide.
6. **Backend:** needed for very large counts. Today every client gets every track; 100k tracks is roughly 30–40 MB/s of JSON per client (my estimate). The fix is area filtering, binary records and server-side cluster stats.

```tsx
function TrackDataHandler({ watchlistTrackIds }: TrackDataHandlerProps = {}) {
  const engine = useTrackEngine()        // worker: WS, typed-array store, frames, picks
  useTrackAlertSync(engine)
  useTrackWatchlist(engine, watchlistTrackIds)
  return (
    <>
      <TrackGlLayer engine={engine} />       {/* custom layer + rAF clock */}
      <TrackClusterLayers engine={engine} /> {/* zoom < 11 */}
      <TrackLabelLayer engine={engine} />    {/* zoom >= 12, capped */}
    </>
  )
}
```

Guide #1 walks through this step by step.

---

## 7. What is a typed array?

> "I have not got the idea of typed array. Make an example"

A typed array is a **fixed-length list of numbers of one type, packed side by side in one block of memory** (an `ArrayBuffer`). A normal array holds pointers to objects scattered around memory.

```js
const a = new Uint8Array(3)   // 3 slots of 1 byte (0..255)
a[1] = 300                    // wraps to 44
a[2] = 3.7                    // becomes 3
a.push                        // undefined: fixed length; to grow, make a bigger one and .set(old)

new Float32Array([0.123456789])[0]   // 0.12345679104328156 (about 7 digits)
new Float64Array([0.123456789])[0]   // 0.123456789         (about 16 digits)

const buf = new ArrayBuffer(8)       // a typed array is a VIEW on raw bytes
new Float32Array(buf)[0] = 1
new Uint8Array(buf)                  // [0, 0, 128, 63, 0, 0, 0, 0]
```

**Struct of arrays:** instead of `drones[i].x`, keep one typed array per field, and slot `i` is the same drone in every array:

```js
const ids = new Uint32Array([7, 9])
const xs  = new Float64Array([0.79, 0.80])
xs[1] += 0.001   // move the second drone
```

**Measured with 1,000,000 drones (Node, this laptop):**

| | Objects | Typed arrays |
|---|---|---|
| Memory | 114 MB | 24 MB |
| Move every drone once | 14.0 ms | 4.3 ms |
| Send to another thread | 744 ms (copied) | 0.12 ms (transferred) |

**Why the gap:** no per-object overhead, numbers sit in a row (CPU cache friendly, nothing for the GC to track), and a buffer can be **transferred** instead of copied.

**The catches:**

- One number type per array.
- Fixed length, so growing means allocate and copy.
- Numbers only.
- After a transfer, the sender's buffer is empty (`byteLength` 0).

---

## 8. How does typed-array storage get evicted when drones disappear?

> "So how does the typed array get evicted when some or all of drones"

**Nothing is erased and the arrays never shrink.** The store keeps a counter `n`: slots `0 … n-1` are live, and anything beyond is ignored leftovers. `remove(s)` does a **swap-remove**: it copies the last drone into slot `s`, does `n--`, and updates the id→slot map. `sweep()` removes drones that have been silent for 3 intervals, walking the slots **backwards**, so a drone moved into a hole has already been checked.

Traced with the demo's real `DroneStore` (capacity 8):

| Time | What happened | `ids[0..n)` | `n` | Array length |
|---|---|---|---|---|
| t=0 | five drones report | `[10, 20, 30, 40, 50]` | 5 | 8 |
| t=1 | 20 and 40 silent for 1 s | unchanged | 5 | 8 |
| t=4 | sweep removes 40 (50 moves to slot 3), then 20 (50 moves to slot 1) | `[10, 50, 30]` | 3 | 8 |
| t=5 | new drone 60 reuses slot 3 | `[10, 50, 30, 60]` | 4 | 8 |
| t=20 | every drone silent | `[]` | 0 | 8 |

- **On screen:** the next frame carries the new `n`, and the GPU draws exactly `n` instances. Stale values beyond `n` are never drawn. With `n = 0`, nothing is drawn.
- **Selected drone evicted:** `selected` becomes `null`, so the panel closes and follow stops.
- **Gap in the guide's code:** `sweep` runs only when a message arrives. If **all** messages stop, nothing is evicted and the drones freeze. The fix is to also sweep in the worker's 1-second timer:

  ```ts
  const before = store.n
  store.sweep(clock(), 3 * intervalS)
  if (store.n !== before) { dirty = true; sendClusters() }
  ```

- **When memory is freed:**
  - Never during normal running, by design: no allocations and no garbage. That's about 69 B per drone of capacity, so about 7 MB for 100k.
  - When `grow()` replaces the arrays, the GC frees the old ones.
  - `worker.terminate()` and `onRemove` free everything.
  - To shrink, allocate a smaller array and copy, for example `if (n < cap / 4 && cap > 1024) grow(cap / 2)`. It's rarely worth it.

---

## 9. What do the ToWorker and FromWorker messages mean?

> "Explain the actions meaning in ToWorker and FromWorker"

The page and the worker can only talk through `postMessage`. `src/shared/protocol.ts` defines both directions, and both sides import it. The `type` field lets `switch (m.type)` narrow each message's fields in TypeScript.

**ToWorker (page → worker):**

| Message | Sent when | Worker does |
|---|---|---|
| `init { url, epochMs }` | once, by `createEngine` | Saves the shared clock's time zero, opens the WebSocket, starts the frame loop and the 1 s stats timer |
| `view { zoom, bbox, origin }` | map moves (throttled 150–600 ms) and on mount | Saves the zoom (clusters below 12), bbox (cluster area) and origin (map centre, for float32 precision). Repacks the next frame and recomputes clusters. |
| `select { id }` | after a click, or `null` from Close | Remembers `selectedId`, so frames include that drone |
| `pick { reqId, mx, my, radius }` | click at zoom ≥ 12 | Finds the nearest drone at its drawn position within 16 px and replies with `picked` |
| `release { buf }` | the layer has uploaded or dropped a frame | Puts the buffer back in the pool, `inFlight--` |

**FromWorker (worker → page):**

| Message | Sent when | Page does |
|---|---|---|
| `status { state }` | the WebSocket connects, opens or closes | Updates the HUD's "Connection" row |
| `frame` | the frame loop runs, the data is `dirty` and fewer than 3 buffers are out | `layer.setFrame()`: keeps the newest frame and repaints. `selected.inst` drives the ring and follow, `selected.info` fills the panel. |
| `clusters { data }` | after each message or view, zoom < 12 | Feeds the GeoJSON cluster source |
| `picked { reqId, id }` | reply to `pick` | Resolves the waiting Promise, then calls `engine.select(id)` |
| `stats { … }` | every second | Adds the page's draws/s and updates the HUD |

**Why `epochMs`:** the page and the worker each have their own `performance.now()` starting point. A shared time zero puts the worker's `t0` and the shader's `now` on one clock.

**Pairs to notice:**

- **`frame` and `release`** pass the same buffer back and forth with zero copies. `inFlight < 3` is the brake.
- **`pick` and `picked`** are a question and its answer, matched by `reqId`, so `engine.pick()` can be awaited. A click runs `pick → picked → select`.
- **`view`** drives both the frames (origin) and the clusters (zoom and bbox).

---

## 10. What does "glide" mean?

> "What does the "glide" means in context of the solution?"

A **glide** is one short straight movement of an icon, **from where it is drawn right now to the newest reported position**, lasting `interp` seconds. Every update starts a new glide.

**It's four numbers per drone:**

- `px, py`: the start (the drawn position when the update arrived)
- `cx, cy`: the end (the newest report)
- `t0`: the start time
- `interp`: the glide time, 1.15 × the measured interval

The heading glides the same way, always turning the short way.

- **Started** in the worker, once per update (`startSegment` in `store.update()`).
- **Played** on the GPU every frame: `pos = mix(start, end, clamp((now − t0)/interp, 0, 1))`. The worker's `drawnX()` uses the same formula, so picking matches what you see.

**Worked example:** 100 m/s, a report every 1 s, interp 1.15 s.

| Time | Event | Drawn position | New glide |
|---|---|---|---|
| 0.0 | report 0 m | 0 | still |
| 1.0 | report 100 m | 0 | 0 → 100 |
| 1.5 | frame | 43 m | |
| 2.0 | report 200 m | 87 m | 87 → 200 |
| 3.0 | report 300 m | 185 m | 185 → 300 |
| steady | | about 15 m behind the latest report | 115 m per 1.15 s = 100 m/s |

**Why it's built this way:**

- Starting from the drawn position means no teleporting.
- The extra 15% means the icon never stops between updates, at the cost of a small constant lag.
- If a report is late, the icon reaches the end and waits. It never guesses.
- The interval is measured, so glides adapt to the server's rate.

---

## 11. How does DroneLayer.ts work, compared with GeoJSON drawing?

> "Explain how DroneLayer.ts works (especially the webGL, add detail instructions since I am new to this), compare to the traditional geojson drawing"

### WebGL basics

The GPU is a separate processor with its own memory. You:

1. upload data into **buffers**,
2. give it two GLSL programs (shaders),
3. say "draw".

The **vertex shader** runs once per corner and decides where it lands on screen. The **fragment shader** runs once per covered pixel and decides its colour. WebGL is a **state machine**: you bind an object, then calls act on it.

| Term | Meaning |
|---|---|
| Buffer (VBO) | A block of GPU memory |
| Attribute (`in`) | Input that changes per corner, or per drone with instancing |
| Uniform | Input that's the same for the whole draw call (matrix, time) |
| Varying (`out` → `in`) | A value passed from the vertex shader to the fragment shader, blended across the triangle |
| Texture | An image the shaders can read |
| Program | A compiled vertex + fragment shader pair |
| VAO | A saved recipe of which buffer feeds which attribute, and how |
| Instancing | Drawing one shape n times in one call |
| Clip space | Screen coordinates from −1 to +1, +y up |

### Structure

`DroneLayer` implements MapLibre's `CustomLayerInterface`:

- `onAdd` (once): create the GPU objects.
- `render` (every map frame): draw.
- `onRemove`: delete the GPU objects.

`setFrame()` does no GL work. It stores the newest frame, releases an older unused one, and requests a repaint. **MapLibre shares its GL context**, so the layer must leave GL state as it found it.

**GPU objects:**

- `quad`: 4 corners, shared by every drone.
- `instVbo`: n × 32 bytes, the worker's frame.
- `selVbo`: the selected drone.
- Two VAOs, the icon texture, and two programs (icon, ring).

Per drone, floats 0–3 are `a_seg` (start.xy, end.xy) and floats 4–7 are `a_meta` (t0, heading0, heading1, kind).

### onAdd

1. `link()` compiles and links the shaders and throws the GLSL log on errors. Both programs share one vertex shader.
2. `getUniformLocation` finds each uniform's handle.
3. The square is uploaded with `STATIC_DRAW`. `TRIANGLE_STRIP` turns the 4 corners into 2 triangles.
4. `makeVao` records which attribute reads what:

   ```ts
   gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 0)   // a_seg: 4 floats, every 32 bytes
   gl.vertexAttribDivisor(1, 1)                           // ← advance once per DRONE, not per corner
   gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 16)  // a_meta: from byte 16
   gl.vertexAttribDivisor(2, 1)
   ```

   **The divisor is the instancing trick.** Every corner of drone k gets drone k's 8 floats.
5. The icon is uploaded as a texture, with mipmaps so it looks smooth when drawn smaller. `UNPACK_FLIP_Y` is saved and restored because the context is shared.

### upload()

`bufferData(size)` allocates fresh storage ("orphaning"), so we never overwrite memory the GPU may still be reading. `bufferSubData` copies the frame in, and the buffer is then released back to the worker.

### render()

1. **Matrix:** MapLibre's `mainMatrix` maps world coordinates (0..1) to clip space. Positions are relative to an origin, because float32 near 0.8 can only land about every 8 px at zoom 18 and icons would jitter. `translated()` folds the origin back into the matrix in 64-bit on the CPU.
2. **Uniforms:** matrix, `now`, `interp`, viewport, size × device pixel ratio, bearing, colours. Only a few calls, whatever n is.
3. **GL state:** depth, stencil and cull off; blending on with `ONE, ONE_MINUS_SRC_ALPHA` (premultiplied alpha, like MapLibre).
4. **Texture:** bind it to unit 0 and set the sampler uniform to 0.
5. **Draw:** `drawArraysInstanced(TRIANGLE_STRIP, 0, 4, n)` draws every drone in one call.
6. **Selected drone:** a pulsing ring at 3× size, then the icon at 1.4× on top, while the others are dimmed to 60%.
7. **Finish:** unbind, then `triggerRepaint()`. Positions depend on time, so the layer keeps drawing.

### The shaders

The vertex shader runs per corner in five steps:

1. Glide progress `f`, then `pos = mix(start, end, f)`.
2. Heading turns the short way, minus the map's bearing.
3. Centre `clip = u_matrix * vec4(pos, 0, 1)`.
4. Rotate the corner by the heading.
5. `clip.xy += corner * u_size / u_viewport * clip.w` keeps the icon a constant pixel size.

It also outputs `v_uv` (texture coordinates) and a `flat` `v_kind`.

- **Icon fragment shader:** the icon is white, so its alpha is the shape. Colour = type colour × alpha × opacity (premultiplied). The y flip is there because canvas row 0 is the top.
- **Ring fragment shader:** a band of distance from the centre via `smoothstep`, pulsing with `sin(u_now * 4)`. No image needed.

### Compared with GeoJSON

A traditional layer is `addSource({type: 'geojson'})` + a `symbol` layer, then `setData(featureCollection)` on every update. Each `setData`:

1. builds n objects,
2. copies them to MapLibre's worker,
3. re-tiles (geojson-vt),
4. re-runs symbol layout and collision,
5. rebuilds vertex buffers,
6. re-uploads them.

The custom layer does one `bufferSubData` of n × 32 bytes.

| | GeoJSON + symbol layer | DroneLayer |
|---|---|---|
| Data | n JS objects | one Float32Array, 32 B/drone |
| Per update | re-tile + re-layout everything | one buffer copy |
| Motion between updates | none, icons jump (smooth motion would need `setData` about 60×/s) | GPU computes it from time |
| Per frame JS | MapLibre redraws tiles | about 25 GL calls, whatever n is |
| Click | `queryRenderedFeatures` built in | your own (worker `pick`) |
| Styling | expressions, labels, collision, no code | shader code |
| Clustering | `cluster: true` built in | your own (worker grid) |
| Projection | all, including globe | Mercator matrix only |
| Effort | low | higher |
| Best for | ≤ a few thousand, slowly changing, labels | tens of thousands to a million moving points |

The custom layer was measured at 57–60 draws/s with 20k drones and 59–60 with 100k. A GeoJSON version was not benchmarked. The demo uses **both**: GeoJSON for the clusters (few features, labels, hit-testing) and the custom layer for the drones. **Rule of thumb:** GeoJSON by default, a custom layer only for the one thing that is large *and* moving.

**Experiments:**

1. Set `float f = 1.0;` in the vertex shader and the drones jump.
2. Comment out the `vertexAttribDivisor` lines and the drawing turns into a garbled mess.
3. Remove the final `triggerRepaint()` and drones move only while you pan.
4. Set `ICON_PX = 60` and icons stay 60 px at every zoom.
5. Add a GLSL typo and the compile log shows up in the console.

---

## Open items

- The branch `implement-functional-component` is not committed yet.
- fe-monorepo questions still open:
  - Expected track count and message rate, and whether each message is the full list.
  - Whether the backend can change (area filtering, binary format).
  - Whether labels must glide.
  - Whether the other panels need the full list.
  - Which branch step 1 should go on.
- `fe-monorepo/` sits untracked inside HPDMB. Consider adding it to `.gitignore`.
- Guide #2 could get the timer-based `sweep` fix from question 8.
