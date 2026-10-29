# Study guide: the WebGL2 part

This guide is for learning the WebGL2 code that draws the drones: [frontend/src/map/TrackLayer.ts](../frontend/src/map/TrackLayer.ts), and the data it gets from `writeInst` in [frontend/src/shared/trackStore.ts](../frontend/src/shared/trackStore.ts). It says what to study, in which order, and then walks through the code piece by piece. For how the data reaches this layer, see [U1-BINARY-FLOW.md](U1-BINARY-FLOW.md) (steps 9 and 10).

Functions are named instead of line numbers, so search for them.

## Contents

1. [GLSL first, or the WebGL2 API first?](#glsl-first-or-the-webgl2-api-first)
2. [What the code uses](#what-the-code-uses)
3. [Study order](#study-order)
4. [WebGL1 tutorials: what changed in WebGL2](#webgl1-tutorials-what-changed-in-webgl2)
5. [Walkthrough of TrackLayer.ts](#walkthrough-of-tracklayerts)
6. [Debugging tools](#debugging-tools)
7. [Exercises](#exercises)
8. [Questions to check your understanding](#questions-to-check-your-understanding)
9. [References](#references)

---

## GLSL first, or the WebGL2 API first?

Learn them **together**, starting from the WebGL2 API. The GLSL here is small: one vertex shader of about 25 lines and two short fragment shaders. Most of `TrackLayer.ts` is API code: buffers, attribute layout, instancing, textures and blending, and GLSL alone does not explain any of that. A good WebGL2 course teaches GLSL as it goes.

## What the code uses

| Concept | Where in `TrackLayer.ts` | What it does here |
|---|---|---|
| Shaders, `in`/`out`, uniforms | `VS`, `FS_ICON`, `FS_RING`, `link()` | Moves and rotates each icon; picks it from the atlas |
| Buffers, VAO, stride and offset | `makeVao()` (stride 36 B, offsets 0, 16, 32) | Matches the 9 floats per track that `writeInst` writes |
| Instancing | `vertexAttribDivisor`, `drawArraysInstanced` | One draw call for every drone: one quad of 4 corners, repeated per track |
| Textures, mipmaps, premultiplied alpha | `onAdd`, `uploadIcons`, `blendFunc(ONE, ONE_MINUS_SRC_ALPHA)` | The icon atlas |
| Clip space and matrices | `translated()`, `clip.xy += corner * size / u_viewport * clip.w` | Map projection, and icons of a fixed size in pixels |
| Streaming buffer updates | `upload()`: `bufferData` (orphan), then `bufferSubData` | A new frame from the worker every tick |
| MapLibre custom layer | `onAdd`, `render`, `onRemove`; restoring `pixelStorei` | Shares the map's GL context without breaking its state |

## Study order

Each stage ends with the part of the code you should now be able to read.

| # | Study | Then read |
|---|---|---|
| 1 | [WebGL2 Fundamentals](https://webgl2fundamentals.org/): *Fundamentals*, *How It Works*, *Shaders and GLSL*. This is the pipeline (vertex shader, rasterising, fragment shader) and all the GLSL needed here: `vec2`/`vec4`, `mix`, `clamp`, `step`, `in`/`out`, uniforms, `precision`. | `link()`, the three shader strings (without the maths yet) |
| 2 | Same site: *WebGL2 State Diagram* (interactive). It shows what a VAO, an array buffer and the texture units hold. | `makeVao()` |
| 3 | *2D Matrices*, then the 3D lessons up to *Perspective*. Learn what clip space is and why the GPU divides by `w`. | `translated()`, the `clip` lines of `VS` |
| 4 | *Textures*, then *WebGL2 and Alpha* (premultiplied alpha). | `uploadIcons`, `FS_ICON`, `premultiply` in [droneAtlas.ts](../frontend/src/map/droneAtlas.ts), the `blendFunc` call |
| 5 | *Instanced Drawing*. This is the idea that turns 185k drones into one draw call. | `vertexAttribDivisor`, `drawArraysInstanced` |
| 6 | The MapLibre example **"Add a custom style layer"** ([examples](https://maplibre.org/maplibre-gl-js/docs/examples/)) and the `CustomLayerInterface` API page. This is the bridge from plain WebGL2 to a layer inside the map. | `onAdd`, `render`, `onRemove`, `triggerRepaint` |
| 7 | Read `TrackLayer.ts` from top to bottom with `writeInst` open beside it, using the [walkthrough](#walkthrough-of-tracklayerts) below. | All of it |

Keep the Khronos **WebGL 2.0 reference card** (it includes GLSL ES 3.00) for lookups. You do not need to study it. *The Book of Shaders* is only worth it if you want effects like the pulsing ring in `FS_RING`.

## WebGL1 tutorials: what changed in WebGL2

Many tutorials are WebGL1 (GLSL ES 1.00). This code is WebGL2 (`#version 300 es`). Prefer WebGL2 sources, or translate with this table:

| WebGL1 / GLSL ES 1.00 | WebGL2 / GLSL ES 3.00 (this code) |
|---|---|
| no version line | `#version 300 es` must be the very first line |
| `attribute vec2 a_pos;` | `in vec2 a_pos;`, here with `layout(location = N)` |
| `varying` (both shaders) | `out` in the vertex shader, `in` in the fragment shader |
| `gl_FragColor = ...` | declare `out vec4 fragColor;` and assign it |
| `texture2D(tex, uv)` | `texture(tex, uv)` |
| `ANGLE_instanced_arrays` extension | `gl.vertexAttribDivisor`, `gl.drawArraysInstanced` built in |
| `OES_vertex_array_object` extension | `gl.createVertexArray`, `gl.bindVertexArray` built in |

## Walkthrough of TrackLayer.ts

### The data: 9 floats per drone

The worker's `writeInst` (trackStore.ts) writes 9 floats per track (`STRIDE = 9`). `makeVao` tells the GPU how to read them, 36 bytes per track:

| Floats | Byte offset | Shader input | Meaning |
|---|---|---|---|
| 0, 1 | 0 | `a_seg.xy` (location 1) | start of the glide: mercator position minus the origin |
| 2, 3 | 8 | `a_seg.zw` | end of the glide: the newest reported position |
| 4 | 16 | `a_meta.x` (location 2) | `t0`: when the glide started, in shared-clock seconds |
| 5 | 20 | `a_meta.y` | heading at the start (radians, clockwise from north) |
| 6 | 24 | `a_meta.z` | newest heading |
| 7 | 28 | `a_meta.w` | altitude in metres |
| 8 | 32 | `a_kind` (location 3) | type 0 to 3, plus 4 when the battery is under 20 % |

Location 0, `a_corner`, comes from a separate buffer: the 4 corners of a square, `(-1,-1) (1,-1) (-1,1) (1,1)`, drawn as a `TRIANGLE_STRIP`.

**Why positions are relative to an origin:** float32 has about 7 significant digits. Absolute mercator positions (0 to 1) lose sub-pixel precision at street zoom, which makes icons jitter. Small offsets from an origin near the view keep the precision.

### `onAdd(map, gl)`: create everything once

- `link(gl, VS, FS_ICON)` and `link(gl, VS, FS_RING)`: compile two programs that share the vertex shader. `link` throws with the GL error log if a shader does not compile.
- `getUniformLocation` for each uniform name, stored in `iconU` and `ringU`.
- `quad`: the corner buffer (`STATIC_DRAW`, never changes).
- `instVbo`: the per-drone buffer, refilled every frame by `upload`.
- `selVbo`: one instance (9 floats) for the selected drone.
- `makeVao` twice: the same layout over `instVbo` (all drones) and over `selVbo` (the selected one).
- The texture: filters and wrap mode, then `uploadIcons`.

### `makeVao(gl, inst)`: describe the memory layout

- A VAO stores the attribute setup, so `render` only has to bind it.
- Location 0 reads `quad` with divisor 0: one value **per vertex**.
- Locations 1 to 3 read `inst` with `vertexAttribDivisor(loc, 1)`: one value **per instance** (per drone). Every drone reuses the same 4 corners with its own data.
- `vertexAttribPointer(loc, size, FLOAT, false, stride, offset)`: size 4, 4 and 1 floats, `stride = STRIDE * 4 = 36` bytes, offsets 0, 16 and 32.

### `uploadIcons(gl)` and `setIcons(atlas)`: the atlas

- The atlas is 256 x 64 pixels: one 64 x 64 cell per type, drawn on a canvas by `drawDroneAtlas` or `imageAtlas` ([droneAtlas.ts](../frontend/src/map/droneAtlas.ts)).
- `premultiply` multiplies RGB by alpha on the CPU. Blending is `ONE, ONE_MINUS_SRC_ALPHA`, the formula for premultiplied colours, which avoids dark fringes around icons.
- `pixelStorei(UNPACK_FLIP_Y_WEBGL / UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)` and then restoring the old values: the GL context belongs to MapLibre, so any state the layer changes must be put back.
- `generateMipmap` and `LINEAR_MIPMAP_LINEAR`: smaller copies of the atlas, so icons drawn at 16 to 46 px stay smooth.
- `setIcons` only stores the new atlas and sets `iconsDirty`. The upload happens in the next `render`, the only place where the layer can use `gl`.

### `setFrame(f)` and `upload(gl)`: a new frame from the worker

- `setFrame` keeps only the newest frame. An older one that was not drawn yet goes straight back to the worker (`release`).
- `upload` runs at the start of `render`:
  - `bufferData(ARRAY_BUFFER, capacity, STREAM_DRAW)` **orphans** the buffer: the driver gives new memory, so it does not wait for the GPU to finish reading last frame's data.
  - `bufferSubData` copies `n * 9` floats in one call.
  - `capacity` grows by 25 % at a time, so the size changes rarely.
  - Then the `ArrayBuffer` goes back to the worker's pool.

### `render(gl, args)`: every frame

1. `uploadIcons` if the atlas changed; `upload` if a new frame came.
2. `translated(args.defaultProjectionData.mainMatrix, ox, oy)`: MapLibre's matrix (mercator to clip space) multiplied by a translation to the origin, computed in float64 in JS, then sent as float32.
3. The icon size in device pixels: `iconPx = clamp(18 + (zoom - 13) * 5.5, 16, 46) * devicePixelRatio`.
4. GL state: depth, stencil and face culling off (MapLibre may leave them on), blending on.
5. Icons: `useProgram(iconProg)`, uniforms, texture unit 0, `bindVertexArray(vao)`, `drawArraysInstanced(TRIANGLE_STRIP, 0, 4, n)`. With a selected drone, the other drones are drawn at 75 % opacity.
6. Selected drone: the ring program at 3 x the icon size, then the icon at 1.35 x, both one instance from `selVao`.
7. Unbind the VAO and the texture (MapLibre's state again).
8. `triggerRepaint()`: positions are a function of time, so the map has to redraw every frame.

### The vertex shader `VS`, line by line

```glsl
float f = clamp((u_now - a_meta.x) / u_interp, 0.0, 1.0);
```
How far along the glide the drone is: 0 at `t0`, 1 after `u_interp` seconds (1.15 x the publish interval). `u_now` comes from the same clock as `t0` (see `DroneLayer.tsx` and `clock.ts`).

```glsl
vec2 pos = mix(a_seg.xy, a_seg.zw, f);
```
Position on the glide: `start + (end - start) * f`. This is how 1 Hz data moves smoothly at 60 fps.

```glsl
float d = a_meta.z - a_meta.y;
d -= TAU * floor((d + 3.14159265) / TAU);
float h = a_meta.y + d * f - u_bearing;
```
Heading, also interpolated. The second line brings the difference into [-pi, pi), so a turn from 350 to 10 degrees goes 20 degrees the short way, not 340 degrees back. Subtracting `u_bearing` keeps icons correct when the map is rotated.

```glsl
vec4 clip = u_matrix * vec4(pos, 0.0, 1.0);
```
Map position to clip space. The origin is already in `u_matrix` (see `translated`).

```glsl
vec2 corner = vec2(a_corner.x * c + a_corner.y * s, -a_corner.x * s + a_corner.y * c);
```
Rotates the corner clockwise by `h` (clockwise, because headings are clockwise from north and clip-space y points up).

```glsl
float size = u_size * (0.85 + 0.3 * clamp(a_meta.w / 400.0, 0.0, 1.0));
clip.xy += corner * size / u_viewport * clip.w;
```
Drones are drawn from 0.85 x the base size (on the ground) to 1.15 x (400 m and higher). The corner offset is in pixels, turned into clip units: the viewport is 2 units wide, so the square comes out `size` pixels wide. It is multiplied by `clip.w` because the GPU divides by `w` afterwards. This keeps the icon size constant when the map is pitched.

```glsl
v_uv = a_corner * 0.5 + 0.5;
v_kind = mod(a_kind, 4.0);
v_low = step(3.5, a_kind);
```
Outputs for the fragment shader: texture coordinates from 0 to 1 across the square, the type, and the low-battery flag (`kind + 4`).

### The fragment shaders

**`FS_ICON`:**
- `uv.x = (floor(v_kind + 0.5) + v_uv.x) / ATLAS_KINDS` picks the type's cell in the atlas.
- `1.0 - v_uv.y` flips vertically. Canvas row 0 is the top of the image, and the top of the square (`v_uv.y = 1`) must show the top of the icon, the nose.
- Low battery: `sin(u_now * 9.0)` blinks the colour toward red. The red is multiplied by `c.a` to stay premultiplied.
- `fragColor = c * u_opacity`: with premultiplied colours, multiplying all four channels fades correctly.

**`FS_RING`:** no texture, everything is computed from `r`, the distance from the square's centre. `smoothstep` gives soft edges to the ring band, `sin(u_now * 4.0)` makes the halo pulse, and `fract(u_now * 0.8)` sends a wave outward once every 1.25 s.

### `translated(m, ox, oy)`

MapLibre's matrices are column-major (16 numbers, column after column). Multiplying by a translation only changes the last column: `out[12 + i] = m[i] * ox + m[4 + i] * oy + m[12 + i]`. This is done in float64 in JS and only the result is sent as float32. It is the other half of the origin trick from [the data section](#the-data-9-floats-per-drone).

## Debugging tools

- **Spector.js** (browser extension): capture one frame of the map and step through every GL call this layer makes, with buffer contents, the bound texture and uniform values. Start here when something does not draw.
- **Shader errors:** `link()` throws with the compiler log. Look for it in the browser console.
- **`gl.getError()`:** put one call after a suspect call while you debug. It returns 0 when there is no error. Do not leave it in: it slows every frame.
- **The Performance panel** in the app shows uploads per second, upload ms, draw ms and fps for this layer (`DroneLayer.measure`).
- **`chrome://gpu`** shows whether WebGL2 is hardware accelerated on this machine.

## Exercises

Do them in order. Each one adds a new part of the pipeline.

1. **Icon size (JS only).** Change the `iconPx` formula in `render` so icons are 25 % bigger at zoom 13.
   *Done when* the icons at zoom 13 are clearly bigger and the size still grows with zoom.
2. **Fade by altitude (GLSL, new varying).** Make low drones (under 50 m) half transparent. The fragment shader cannot read `a_meta.w`: pass it from the vertex shader with a new `out float v_alt;` and `in float v_alt;`, then multiply `fragColor` by a factor.
   *Done when* low drones look faded and high ones do not.
3. **Heading nose for the UTM icon (canvas or GLSL).** The UTM icon is symmetric, so heading is not visible. Either draw a small white triangle at the top of each cell in `imageAtlas`, or draw it in `FS_ICON` from `v_uv`.
   *Done when* you can see which way each UTM icon flies.
4. **A new per-drone value: colour by speed (every layer).** This one touches the whole path:
   - `STRIDE` from 9 to 10 in trackStore.ts, and `writeInst` writes `this.speed[s]` at `b + 9`.
   - In `makeVao`, location 4: 1 float at byte offset 36, divisor 1. The stride follows `STRIDE` by itself.
   - In `VS`, `layout(location = 4) in float a_speed;`, passed on in a varying. In `FS_ICON`, tint fast drones (for example over 15 m/s).
   - Check the other users of `STRIDE`: `postFrame` and `selectedFrame` in the worker, and `upload`. The follow camera in `DroneLayer.tsx` reads `inst[0..4]`, which do not move.

   *Done when* fast drones are tinted, and the selected drone, the follow camera and picking still work.
5. **Look inside a frame.** Capture one frame with Spector.js. Find `drawArraysInstanced` and check that its instance count equals "Tracks drawn" in the Performance panel. Open the instance buffer and find one drone's 9 floats.

## Questions to check your understanding

1. **What does `vertexAttribDivisor(loc, 1)` change?**
   The attribute advances once per instance instead of once per vertex, so all 4 corners of a drone's square see the same drone data. ([makeVao](#makevaogl-inst-describe-the-memory-layout))
2. **Why is the corner offset multiplied by `clip.w`?**
   The GPU divides `xy` by `w` after the vertex shader. Multiplying first cancels that division, so the offset stays in pixels. ([VS](#the-vertex-shader-vs-line-by-line))
3. **Why are positions relative to an origin, and where is the origin added back?**
   For float32 precision at street zoom. It is added back in float64 by `translated()`, inside `u_matrix`. ([data](#the-data-9-floats-per-drone), [translated](#translatedm-ox-oy))
4. **Why premultiply the atlas, and which blend function goes with it?**
   To avoid dark fringes at the icon edges. The matching blend function is `ONE, ONE_MINUS_SRC_ALPHA`. ([atlas](#uploadiconsgl-and-seticonsatlas-the-atlas))
5. **Why call `bufferData` before `bufferSubData` on every upload?**
   It orphans the old storage, so the CPU does not wait for the GPU to finish reading last frame's data. ([upload](#setframef-and-uploadgl-a-new-frame-from-the-worker))
6. **Why does the layer restore `pixelStorei` and unbind its VAO and texture?**
   It shares one GL context with MapLibre, and state left changed breaks MapLibre's own drawing. ([render](#rendergl-args-every-frame))
7. **How do drones move smoothly when data comes once a second?**
   Each drone carries a segment and a start time, and the vertex shader computes the position from `u_now` on every frame. The CPU does nothing per frame. ([VS](#the-vertex-shader-vs-line-by-line))

## References

- [WebGL2 Fundamentals](https://webgl2fundamentals.org/): the lessons named in the [study order](#study-order), plus its State Diagram tool
- [MapLibre GL JS examples](https://maplibre.org/maplibre-gl-js/docs/examples/): "Add a custom style layer", and the `CustomLayerInterface` page in the API docs
- Khronos WebGL 2.0 reference card (with GLSL ES 3.00): search "WebGL 2.0 reference card" on khronos.org
- [Spector.js](https://spector.babylonjs.com/)
- [The Book of Shaders](https://thebookofshaders.com/) (optional)
- In this repo: [TrackLayer.ts](../frontend/src/map/TrackLayer.ts), [trackStore.ts](../frontend/src/shared/trackStore.ts) (`writeInst`), [droneAtlas.ts](../frontend/src/map/droneAtlas.ts), [DroneLayer.tsx](../frontend/src/map/DroneLayer.tsx), [clock.ts](../frontend/src/shared/clock.ts), [U1-BINARY-FLOW.md](U1-BINARY-FLOW.md)
