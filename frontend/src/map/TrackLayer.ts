// MapLibre custom WebGL2 layer that draws every live track as an instanced, heading-rotated
// drone icon. Motion is interpolated on the GPU: each instance carries a segment (prev -> curr)
// and its start time, so 1 Hz updates animate at display refresh rate with no per-frame CPU work.

import type { CustomLayerInterface, CustomRenderMethodInput, Map as MlMap } from "maplibre-gl";
import { STRIDE } from "../shared/trackStore.ts";
import { ATLAS_CELL, ATLAS_KINDS, drawDroneAtlas, premultiply } from "./droneAtlas.ts";

const VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_seg;   // prev.xy, curr.xy (mercator, relative to origin)
layout(location = 2) in vec4 a_meta;  // t0, prevHeading, heading, altitude
layout(location = 3) in float a_kind; // type + 4 * lowBattery
uniform mat4 u_matrix;
uniform float u_now;
uniform float u_interp;
uniform vec2 u_viewport;
uniform float u_size;
uniform float u_bearing;
out vec2 v_uv;
out float v_kind;
out float v_low;

const float TAU = 6.28318530718;

void main() {
  float f = clamp((u_now - a_meta.x) / u_interp, 0.0, 1.0);
  vec2 pos = mix(a_seg.xy, a_seg.zw, f);
  float d = a_meta.z - a_meta.y;
  d -= TAU * floor((d + 3.14159265) / TAU);
  float h = a_meta.y + d * f - u_bearing;
  vec4 clip = u_matrix * vec4(pos, 0.0, 1.0);
  float c = cos(h);
  float s = sin(h);
  vec2 corner = vec2(a_corner.x * c + a_corner.y * s, -a_corner.x * s + a_corner.y * c);
  float size = u_size * (0.85 + 0.3 * clamp(a_meta.w / 400.0, 0.0, 1.0));
  clip.xy += corner * size / u_viewport * clip.w;
  gl_Position = clip;
  v_uv = a_corner * 0.5 + 0.5;
  v_kind = mod(a_kind, 4.0);
  v_low = step(3.5, a_kind);
}`;

const FS_ICON = `#version 300 es
precision highp float;
in vec2 v_uv;
in float v_kind;
in float v_low;
uniform sampler2D u_tex;
uniform float u_now;
uniform float u_opacity;
out vec4 fragColor;
void main() {
  vec2 uv = vec2((floor(v_kind + 0.5) + v_uv.x) / ${ATLAS_KINDS}.0, 1.0 - v_uv.y);
  vec4 c = texture(u_tex, uv);
  float blink = v_low * (0.5 + 0.5 * sin(u_now * 9.0));
  c.rgb = mix(c.rgb, vec3(1.0, 0.25, 0.15) * c.a, 0.45 * blink);
  fragColor = c * u_opacity;
}`;

const FS_RING = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform float u_now;
out vec4 fragColor;
void main() {
  float r = length(v_uv * 2.0 - 1.0);
  float pulse = 0.5 + 0.5 * sin(u_now * 4.0);
  float ring = smoothstep(0.78, 0.84, r) * (1.0 - smoothstep(0.90, 0.96, r));
  float halo = (1.0 - smoothstep(0.2, 0.95, r)) * 0.22 * pulse;
  float wave = smoothstep(0.0, 0.04, 0.03 - abs(r - fract(u_now * 0.8))) * (1.0 - fract(u_now * 0.8)) * 0.8;
  float a = clamp(ring * (0.8 + 0.2 * pulse) + halo + wave, 0.0, 1.0);
  fragColor = vec4(vec3(1.0, 0.84, 0.25) * a, a);
}`;

export interface FrameData {
  buf: ArrayBuffer;
  n: number;
  ox: number;
  oy: number;
  interp: number;
  selectedInst: Float32Array | null;
}

export interface LayerStats {
  uploads: number;
  uploadBytes: number;
  uploadMs: number;
  drawMs: number;
  framesRendered: number;
}

export class TrackLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  /** "all" draws every track; "selected" only the selected one (cluster zooms). */
  mode: "all" | "selected" | "none" = "all";
  /** shared-clock seconds for the frame being drawn; set by the UI's animation loop */
  now = 0;
  stats: LayerStats = { uploads: 0, uploadBytes: 0, uploadMs: 0, drawMs: 0, framesRendered: 0 };

  private map?: MlMap;
  private iconProg?: WebGLProgram;
  private ringProg?: WebGLProgram;
  private iconU: Record<string, WebGLUniformLocation | null> = {};
  private ringU: Record<string, WebGLUniformLocation | null> = {};
  private quad?: WebGLBuffer;
  private instVbo?: WebGLBuffer;
  private selVbo?: WebGLBuffer;
  private vao?: WebGLVertexArrayObject;
  private selVao?: WebGLVertexArrayObject;
  private tex?: WebGLTexture;
  private capacity = 0;
  private n = 0;
  private ox = 0.5;
  private oy = 0.5;
  private interp = 1.15;
  private hasSelected = false;
  private pending: FrameData | null = null;
  /** icon atlas; null = drawDroneAtlas() */
  private icons: ImageData | null = null;
  private iconsDirty = false;
  private readonly release: (buf: ArrayBuffer) => void;

  constructor(id: string, release: (buf: ArrayBuffer) => void) {
    this.id = id;
    this.release = release;
  }

  /** Queues a frame from the worker; uploaded on the next render. Older queued frames are returned. */
  setFrame(f: FrameData) {
    if (this.pending) this.release(this.pending.buf);
    this.pending = f;
    this.map?.triggerRepaint();
  }

  /** Replaces the icon atlas (null: the drawn icons); uploaded on the next render. */
  setIcons(atlas: ImageData | null) {
    this.icons = atlas;
    this.iconsDirty = true;
    this.map?.triggerRepaint();
  }

  get count() {
    return this.n;
  }

  onAdd(map: MlMap, gl: WebGL2RenderingContext) {
    this.map = map;
    this.iconProg = link(gl, VS, FS_ICON);
    this.ringProg = link(gl, VS, FS_RING);
    for (const u of ["u_matrix", "u_now", "u_interp", "u_viewport", "u_size", "u_bearing", "u_tex", "u_opacity"]) {
      this.iconU[u] = gl.getUniformLocation(this.iconProg, u);
      this.ringU[u] = gl.getUniformLocation(this.ringProg, u);
    }

    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.instVbo = gl.createBuffer()!;
    this.selVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.selVbo);
    gl.bufferData(gl.ARRAY_BUFFER, STRIDE * 4, gl.DYNAMIC_DRAW);
    this.vao = this.makeVao(gl, this.instVbo);
    this.selVao = this.makeVao(gl, this.selVbo);

    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.uploadIcons(gl);
  }

  /** Icon atlas to the texture, premultiplied, mipmapped; pixel-store state is restored for MapLibre. */
  private uploadIcons(gl: WebGL2RenderingContext) {
    const img = this.icons ?? drawDroneAtlas();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex!);
    const flip = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
    const pre = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, ATLAS_CELL * ATLAS_KINDS, ATLAS_CELL, 0, gl.RGBA, gl.UNSIGNED_BYTE, premultiply(img));
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flip);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, pre);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.iconsDirty = false;
  }

  private makeVao(gl: WebGL2RenderingContext, inst: WebGLBuffer) {
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad!);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, inst);
    const stride = STRIDE * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 32);
    gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);
    return vao;
  }

  onRemove(_map: MlMap, gl: WebGL2RenderingContext) {
    if (this.pending) this.release(this.pending.buf);
    this.pending = null;
    gl.deleteProgram(this.iconProg ?? null);
    gl.deleteProgram(this.ringProg ?? null);
    for (const b of [this.quad, this.instVbo, this.selVbo]) gl.deleteBuffer(b ?? null);
    gl.deleteVertexArray(this.vao ?? null);
    gl.deleteVertexArray(this.selVao ?? null);
    gl.deleteTexture(this.tex ?? null);
  }

  private upload(gl: WebGL2RenderingContext) {
    const f = this.pending;
    if (!f) return;
    this.pending = null;
    const t = performance.now();
    const floats = f.n * STRIDE;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instVbo!);
    // Orphan the old storage rather than overwrite a buffer the GPU may still be reading.
    if (floats * 4 > this.capacity) this.capacity = Math.ceil(floats * 4 * 1.25);
    gl.bufferData(gl.ARRAY_BUFFER, this.capacity, gl.STREAM_DRAW);
    if (floats > 0) gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array(f.buf, 0, floats));
    this.hasSelected = !!f.selectedInst;
    if (f.selectedInst) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.selVbo!);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, f.selectedInst);
    }
    this.n = f.n;
    this.ox = f.ox;
    this.oy = f.oy;
    this.interp = f.interp;
    this.release(f.buf);
    this.stats.uploads++;
    this.stats.uploadBytes += floats * 4;
    this.stats.uploadMs += performance.now() - t;
  }

  render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
    if (this.iconsDirty) this.uploadIcons(gl);
    this.upload(gl);
    if (this.mode === "none" || (this.n === 0 && !this.hasSelected)) return;
    const t = performance.now();
    const map = this.map!;
    const matrix = translated(args.defaultProjectionData.mainMatrix, this.ox, this.oy);
    const dpr = window.devicePixelRatio || 1;
    const zoom = map.getZoom();
    const iconPx = Math.max(16, Math.min(46, 18 + (zoom - 13) * 5.5)) * dpr;
    const bearing = (map.getBearing() * Math.PI) / 180;

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const setCommon = (u: Record<string, WebGLUniformLocation | null>, size: number) => {
      gl.uniformMatrix4fv(u.u_matrix, false, matrix);
      gl.uniform1f(u.u_now, this.now);
      gl.uniform1f(u.u_interp, this.interp);
      gl.uniform2f(u.u_viewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.uniform1f(u.u_size, size);
      gl.uniform1f(u.u_bearing, bearing);
    };

    gl.useProgram(this.iconProg!);
    setCommon(this.iconU, iconPx);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex!);
    gl.uniform1i(this.iconU.u_tex, 0);

    if (this.mode === "all" && this.n > 0) {
      gl.uniform1f(this.iconU.u_opacity, this.hasSelected ? 0.75 : 1);
      gl.bindVertexArray(this.vao!);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.n);
    }
    if (this.hasSelected) {
      gl.useProgram(this.ringProg!);
      setCommon(this.ringU, iconPx * 3);
      gl.bindVertexArray(this.selVao!);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
      gl.useProgram(this.iconProg!);
      setCommon(this.iconU, iconPx * 1.35);
      gl.uniform1f(this.iconU.u_opacity, 1);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
    }
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.stats.drawMs += performance.now() - t;
    this.stats.framesRendered++;
    // keep animating: positions are a function of time
    map.triggerRepaint();
  }
}

/** mainMatrix * translate(ox, oy, 0), computed in float64 and handed to the GPU as float32. */
function translated(m: ArrayLike<number>, ox: number, oy: number): Float32Array {
  const out = new Float32Array(16);
  for (let i = 0; i < 12; i++) out[i] = m[i];
  for (let i = 0; i < 4; i++) out[12 + i] = m[i] * ox + m[4 + i] * oy + m[12 + i];
  return out;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link: ${gl.getProgramInfoLog(p)}`);
  return p;
}
