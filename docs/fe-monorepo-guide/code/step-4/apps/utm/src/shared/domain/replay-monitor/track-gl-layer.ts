import { TRACK_INSTANCE_STRIDE } from '@platform/utm/worker/live-tracks/track-store'
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl'

import type { TrackFrame } from './live-tracks.types'

export type Rgba = [number, number, number, number]
/** README: status follows TRACK_STATUSES order; pulse is [WARNING, CRITICAL]. */
export type TrackGlColors = { status: Rgba[]; pulse: [Rgba, Rgba]; neutral: Rgba }
export type TrackGlLayer = CustomLayerInterface & { setFrame: (frame: TrackFrame) => void }

type CreateTrackGlLayerOptions = {
  id: string
  icon: HTMLImageElement
  colors: TrackGlColors
  getNow: () => number
  releaseBuffer: (buffer: ArrayBuffer) => void
}

// README: Matches track-layer-1: icons from zoom 11, icon 256 px * icon-size 0.115, glow 32 px, tech ring 22 px, pulse 22 -> 60 px over 1.6 s.
const ICON_MIN_ZOOM = 11
const ICON_HALF_SIZE_PX = (256 * 0.115) / 2
const EFFECT_HALF_SIZE_PX = 33
const PULSE_HALF_SIZE_PX = 62
const PASS_EFFECTS = 0
const PASS_PULSE = 1
const PASS_ICON = 2

const VERTEX_SHADER = `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_segment;
layout(location = 2) in vec4 a_meta;
uniform mat4 u_matrix;
uniform float u_now;
uniform float u_glide;
uniform vec2 u_viewport;
uniform float u_half_size;
uniform float u_bearing;
uniform int u_pass;
uniform bool u_highlight;
uniform vec4 u_colors[6];
uniform vec4 u_pulse_colors[2];
uniform vec4 u_neutral;
out vec2 v_uv;
flat out vec4 v_color;

const float TAU = 6.28318530718;

void main() {
  int status = int(mod(a_meta.w, 8.0) + 0.5);
  bool isHidden = a_meta.w >= 7.5;
  bool isPulsing = status == 1 || status == 2;
  v_uv = a_corner;
  v_color = vec4(0.0);
  if (isHidden || (u_pass == ${PASS_PULSE} && !isPulsing)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  bool isAlert = status == 1 || status == 2 || status == 4 || status == 5;
  v_color = u_colors[status];
  if (u_pass == ${PASS_PULSE}) v_color = u_pulse_colors[status - 1];
  if (u_pass == ${PASS_ICON} && u_highlight && !isAlert) v_color = u_neutral;

  float f = clamp((u_now - a_meta.x) / u_glide, 0.0, 1.0);
  vec4 clip = u_matrix * vec4(mix(a_segment.xy, a_segment.zw, f), 0.0, 1.0);
  vec2 corner = a_corner;
  if (u_pass == ${PASS_ICON}) {
    float d = a_meta.z - a_meta.y;
    d -= TAU * floor((d + 3.14159265) / TAU);
    float heading = a_meta.y + d * f - u_bearing;
    corner = vec2(a_corner.x * cos(heading) + a_corner.y * sin(heading), -a_corner.x * sin(heading) + a_corner.y * cos(heading));
  }
  clip.xy += corner * u_half_size * 2.0 / u_viewport * clip.w;
  gl_Position = clip;
}`

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
in vec2 v_uv;
flat in vec4 v_color;
uniform int u_pass;
uniform float u_now;
uniform float u_half_size;
uniform float u_pixel_ratio;
uniform float u_glow_opacity;
uniform sampler2D u_icon;
out vec4 fragColor;

float ring(float r, float inner, float width) {
  return smoothstep(inner - 0.5, inner + 0.5, r) - smoothstep(inner + width - 0.5, inner + width + 0.5, r);
}

void main() {
  float px = u_pixel_ratio;
  float r = length(v_uv) * u_half_size;
  float alpha = 0.0;
  if (u_pass == ${PASS_EFFECTS}) {
    float glow = (1.0 - smoothstep(3.2 * px, 32.0 * px, r)) * u_glow_opacity;
    float fill = (1.0 - smoothstep(22.0 * px - 0.5, 22.0 * px + 0.5, r)) * 0.15;
    float stroke = ring(r, 22.0 * px, 1.2 * px) * 0.85;
    alpha = 1.0 - (1.0 - glow) * (1.0 - fill) * (1.0 - stroke);
  }
  if (u_pass == ${PASS_PULSE}) {
    float elapsed = fract(u_now / 1.6);
    alpha = ring(r, (22.0 + elapsed * 38.0) * px, 1.5 * px) * (1.0 - elapsed);
  }
  if (u_pass == ${PASS_ICON}) {
    float distance = texture(u_icon, vec2(v_uv.x * 0.5 + 0.5, 0.5 - v_uv.y * 0.5)).a;
    // README: Same edge as MapLibre SDF icons: buffer 0.75, gamma 0.105 / (icon-size * pixel ratio).
    float gamma = 0.105 / (0.115 * px);
    alpha = smoothstep(0.75 - gamma, 0.75 + gamma, distance);
  }
  float a = alpha * v_color.a;
  fragColor = vec4(v_color.rgb * a, a);
}`

const UNIFORMS = ['u_matrix', 'u_now', 'u_glide', 'u_viewport', 'u_half_size', 'u_bearing', 'u_pass', 'u_highlight', 'u_colors', 'u_pulse_colors', 'u_neutral', 'u_pixel_ratio', 'u_glow_opacity', 'u_icon'] as const

function compileProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const program = gl.createProgram()
  for (const [type, source] of [
    [gl.VERTEX_SHADER, VERTEX_SHADER],
    [gl.FRAGMENT_SHADER, FRAGMENT_SHADER],
  ] as const) {
    const shader = gl.createShader(type)
    if (!shader) throw new Error('Track layer: createShader failed')
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Track layer shader: ${gl.getShaderInfoLog(shader) ?? ''}`)
    gl.attachShader(program, shader)
  }
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Track layer program: ${gl.getProgramInfoLog(program) ?? ''}`)
  return program
}

/** README: mainMatrix * translate(origin), in float64 on the CPU, so the GPU only sees small relative positions. */
function translateMatrix(matrix: ArrayLike<number>, [originX, originY]: [number, number]): Float32Array {
  const translated = new Float32Array(16)
  for (let index = 0; index < 12; index++) translated[index] = matrix[index] ?? 0
  for (let index = 0; index < 4; index++) translated[12 + index] = (matrix[index] ?? 0) * originX + (matrix[4 + index] ?? 0) * originY + (matrix[12 + index] ?? 0)
  return translated
}

function createVertexArray(gl: WebGL2RenderingContext, quad: WebGLBuffer, instances: WebGLBuffer): WebGLVertexArrayObject {
  const vertexArray = gl.createVertexArray()
  gl.bindVertexArray(vertexArray)
  gl.bindBuffer(gl.ARRAY_BUFFER, quad)
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
  gl.bindBuffer(gl.ARRAY_BUFFER, instances)
  for (const [location, offset] of [
    [1, 0],
    [2, 16],
  ] as const) {
    gl.enableVertexAttribArray(location)
    gl.vertexAttribPointer(location, 4, gl.FLOAT, false, TRACK_INSTANCE_STRIDE * 4, offset)
    gl.vertexAttribDivisor(location, 1)
  }
  gl.bindVertexArray(null)
  return vertexArray
}

/** README: MapLibre custom layer that draws every live track with one instanced draw call per pass. The GPU moves each drone along its glide segment, so no per-frame CPU work depends on the track count. */
export function createTrackGlLayer({ id, icon, colors, getNow, releaseBuffer }: CreateTrackGlLayerOptions): TrackGlLayer {
  let map: MapLibreMap | undefined
  let program: WebGLProgram | undefined
  let quad: WebGLBuffer | undefined
  let instanceBuffer: WebGLBuffer | undefined
  let overlayBuffer: WebGLBuffer | undefined
  let vertexArray: WebGLVertexArrayObject | undefined
  let overlayVertexArray: WebGLVertexArrayObject | undefined
  let texture: WebGLTexture | undefined
  let capacityBytes = 0
  let count = 0
  let origin: [number, number] = [0.5, 0.5]
  let glideSeconds = 1.15
  let overlays: Float32Array[] = []
  let pending: TrackFrame | null = null
  const uniforms = new Map<(typeof UNIFORMS)[number], WebGLUniformLocation | null>()

  function upload(gl: WebGL2RenderingContext) {
    const frame = pending
    if (!frame || !instanceBuffer || !overlayBuffer) return
    pending = null
    const bytes = frame.count * TRACK_INSTANCE_STRIDE * 4
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer)
    // README: Orphan the old storage instead of overwriting a buffer the GPU may still read.
    if (bytes > capacityBytes) capacityBytes = Math.ceil(bytes * 1.25)
    gl.bufferData(gl.ARRAY_BUFFER, capacityBytes, gl.STREAM_DRAW)
    if (bytes > 0) gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array(frame.buffer, 0, frame.count * TRACK_INSTANCE_STRIDE))
    overlays = [frame.hovered, frame.selected].filter(instance => instance !== null)
    if (overlays.length > 0) {
      const overlayData = new Float32Array(overlays.length * TRACK_INSTANCE_STRIDE)
      for (const [index, overlay] of overlays.entries()) overlayData.set(overlay, index * TRACK_INSTANCE_STRIDE)
      gl.bindBuffer(gl.ARRAY_BUFFER, overlayBuffer)
      gl.bufferData(gl.ARRAY_BUFFER, overlayData, gl.DYNAMIC_DRAW)
    }
    count = frame.count
    origin = frame.origin
    glideSeconds = frame.glideSeconds
    releaseBuffer(frame.buffer)
  }

  function drawPass(gl: WebGL2RenderingContext, pass: number, halfSizePx: number, instanceCount: number, options: { glowOpacity: number; isHighlight: boolean }) {
    const pixelRatio = globalThis.devicePixelRatio || 1
    gl.uniform1i(uniforms.get('u_pass') ?? null, pass)
    gl.uniform1f(uniforms.get('u_half_size') ?? null, halfSizePx * pixelRatio)
    gl.uniform1f(uniforms.get('u_glow_opacity') ?? null, options.glowOpacity)
    gl.uniform1i(uniforms.get('u_highlight') ?? null, options.isHighlight ? 1 : 0)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instanceCount)
  }

  return {
    id,
    type: 'custom',
    renderingMode: '2d',
    setFrame(frame: TrackFrame) {
      if (pending) releaseBuffer(pending.buffer)
      pending = frame
      map?.triggerRepaint()
    },
    onAdd(nextMap: MapLibreMap, gl: WebGL2RenderingContext) {
      map = nextMap
      program = compileProgram(gl)
      for (const name of UNIFORMS) uniforms.set(name, gl.getUniformLocation(program, name))
      quad = gl.createBuffer()
      gl.bindBuffer(gl.ARRAY_BUFFER, quad)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
      instanceBuffer = gl.createBuffer()
      overlayBuffer = gl.createBuffer()
      vertexArray = createVertexArray(gl, quad, instanceBuffer)
      overlayVertexArray = createVertexArray(gl, quad, overlayBuffer)
      texture = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, icon)
      // README: Linear without mipmaps, like MapLibre's SDF icon atlas.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.bindTexture(gl.TEXTURE_2D, null)
    },
    onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext) {
      if (pending) releaseBuffer(pending.buffer)
      pending = null
      gl.deleteProgram(program ?? null)
      for (const buffer of [quad, instanceBuffer, overlayBuffer]) gl.deleteBuffer(buffer ?? null)
      for (const array of [vertexArray, overlayVertexArray]) gl.deleteVertexArray(array ?? null)
      gl.deleteTexture(texture ?? null)
    },
    render(gl: WebGL2RenderingContext, options: CustomRenderMethodInput) {
      upload(gl)
      if (!map || !program || !vertexArray || !overlayVertexArray || count === 0 || map.getZoom() < ICON_MIN_ZOOM) return
      gl.useProgram(program)
      gl.uniformMatrix4fv(uniforms.get('u_matrix') ?? null, false, translateMatrix(options.defaultProjectionData.mainMatrix, origin))
      gl.uniform1f(uniforms.get('u_now') ?? null, getNow())
      gl.uniform1f(uniforms.get('u_glide') ?? null, glideSeconds)
      gl.uniform2f(uniforms.get('u_viewport') ?? null, gl.drawingBufferWidth, gl.drawingBufferHeight)
      gl.uniform1f(uniforms.get('u_bearing') ?? null, (map.getBearing() * Math.PI) / 180)
      gl.uniform1f(uniforms.get('u_pixel_ratio') ?? null, globalThis.devicePixelRatio || 1)
      gl.uniform4fv(uniforms.get('u_colors') ?? null, colors.status.flat())
      gl.uniform4fv(uniforms.get('u_pulse_colors') ?? null, colors.pulse.flat())
      gl.uniform4fv(uniforms.get('u_neutral') ?? null, colors.neutral)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, texture ?? null)
      gl.uniform1i(uniforms.get('u_icon') ?? null, 0)
      gl.disable(gl.DEPTH_TEST)
      gl.disable(gl.STENCIL_TEST)
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

      gl.bindVertexArray(vertexArray)
      drawPass(gl, PASS_EFFECTS, EFFECT_HALF_SIZE_PX, count, { glowOpacity: 0.15, isHighlight: false })
      drawPass(gl, PASS_PULSE, PULSE_HALF_SIZE_PX, count, { glowOpacity: 0, isHighlight: false })
      drawPass(gl, PASS_ICON, ICON_HALF_SIZE_PX, count, { glowOpacity: 0, isHighlight: false })
      if (overlays.length > 0) {
        gl.bindVertexArray(overlayVertexArray)
        drawPass(gl, PASS_EFFECTS, EFFECT_HALF_SIZE_PX, overlays.length, { glowOpacity: 0.4, isHighlight: true })
        drawPass(gl, PASS_ICON, ICON_HALF_SIZE_PX, overlays.length, { glowOpacity: 0, isHighlight: true })
      }
      gl.bindVertexArray(null)
      gl.bindTexture(gl.TEXTURE_2D, null)
      // README: Positions are a function of time, so keep rendering while tracks are drawn.
      map.triggerRepaint()
    },
  }
}
