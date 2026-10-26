import { Map as Map$1, MercatorCoordinate } from "maplibre-gl";
// .build/step-4/packages/lib/src/shared/css/get-css-color.ts
const resolvedColors = /* @__PURE__ */ new Map();
function getCssColor(colorReference) {
	const cachedColor = resolvedColors.get(colorReference);
	if (cachedColor !== void 0) return cachedColor;
	const variableName = colorReference.slice(4, -1);
	if (typeof document === "undefined") return colorReference;
	const color = getComputedStyle(document.documentElement).getPropertyValue(variableName).trim();
	const invalidColor = typeof CSS !== "undefined" && typeof CSS.supports === "function" && !CSS.supports("color", color);
	if (color === "" || invalidColor) throw new Error(`Missing or invalid CSS color token: ${variableName}`);
	resolvedColors.set(colorReference, color);
	return color;
}
// .build/step-4/apps/utm/src/shared/domain/replay-monitor/status-colors.ts
const STATUS_COLORS = {
	NORMAL: "var(--color-utm-replay-monitor-normal)",
	WARNING: "var(--color-utm-replay-monitor-warning)",
	CRITICAL: "var(--color-utm-replay-monitor-critical)",
	LOST_LINK: "var(--color-utm-replay-monitor-lost-link)",
	PROCESSING: "var(--color-utm-replay-monitor-processing)",
	LOST_CONTROL: "var(--color-utm-replay-monitor-lost-control)"
};
// .build/step-4/apps/utm/src/shared/domain/replay-monitor/live-tracks-channel.ts
const LIVE_TRACK_EPOCH_MS = performance.timeOrigin + performance.now();
let liveTracksWorker = null;
let statusColors = null;
let frameListener = null;
let nextRequestId = 1;
const views = /* @__PURE__ */ new Map();
const viewListeners = /* @__PURE__ */ new Map();
const selectionListeners = /* @__PURE__ */ new Set();
const pendingReplies = /* @__PURE__ */ new Map();
const queuedMessages = [];
function postToWorker(message, transfer = []) {
	if (liveTracksWorker) {
		liveTracksWorker.postMessage(message, { transfer });
		return;
	}
	if (message.type === "ALERTS" || message.type === "SNAPSHOT") queuedMessages.push(message);
}
function getLiveTrackClockSeconds() {
	return (performance.timeOrigin + performance.now() - LIVE_TRACK_EPOCH_MS) / 1e3;
}
/** README: Called by LiveTracksConnection. Returns the cleanup. `onTracks` receives each validated batch for the main-thread store. */
function attachLiveTracksWorker(worker, onTracks) {
	liveTracksWorker = worker;
	worker.onmessage = (event) => {
		const message = event.data;
		switch (message.type) {
			case "TRACKS_READY":
				onTracks(message.data);
				break;
			case "VIEW_UPDATE":
				viewListeners.get(message.viewId)?.(message);
				break;
			case "FRAME":
				for (const listener of selectionListeners) listener({
					selected: message.selected,
					origin: message.origin,
					glideSeconds: message.glideSeconds
				});
				if (frameListener) frameListener(message);
				else postToWorker({
					type: "RELEASE",
					buffer: message.buffer
				}, [message.buffer]);
				break;
			case "REPLY":
				pendingReplies.get(message.requestId)?.(message.tracks);
				pendingReplies.delete(message.requestId);
		}
	};
	postToWorker({
		type: "INIT",
		epochMs: LIVE_TRACK_EPOCH_MS
	});
	if (statusColors) postToWorker({
		type: "COLORS",
		colors: statusColors
	});
	for (const [viewId, view] of views) postToWorker({
		type: "VIEW",
		viewId,
		view,
		shouldReset: true
	});
	for (const message of queuedMessages.splice(0)) postToWorker(message);
	return () => {
		worker.terminate();
		liveTracksWorker = null;
		for (const resolve of pendingReplies.values()) resolve([]);
		pendingReplies.clear();
	};
}
function forwardLiveTrackBatch(data) {
	postToWorker({
		type: "BATCH",
		data
	});
}
function sendLiveTrackAlerts(add, remove) {
	if (add.length === 0 && remove.length === 0) return;
	postToWorker({
		type: "ALERTS",
		add,
		remove
	});
}
function setLiveTrackView(viewId, view, shouldReset = false) {
	if (view && !statusColors) {
		statusColors = {
			NORMAL: getCssColor(STATUS_COLORS.NORMAL),
			WARNING: getCssColor(STATUS_COLORS.WARNING),
			CRITICAL: getCssColor(STATUS_COLORS.CRITICAL),
			LOST_LINK: getCssColor(STATUS_COLORS.LOST_LINK),
			PROCESSING: getCssColor(STATUS_COLORS.PROCESSING),
			LOST_CONTROL: getCssColor(STATUS_COLORS.LOST_CONTROL)
		};
		postToWorker({
			type: "COLORS",
			colors: statusColors
		});
	}
	if (view) views.set(viewId, view);
	else views.delete(viewId);
	postToWorker({
		type: "VIEW",
		viewId,
		view,
		shouldReset
	});
}
function subscribeLiveTrackView(viewId, listener) {
	viewListeners.set(viewId, listener);
	return () => {
		if (viewListeners.get(viewId) === listener) viewListeners.delete(viewId);
	};
}
function subscribeLiveTrackFrames(listener) {
	frameListener = listener;
	return () => {
		if (frameListener === listener) frameListener = null;
	};
}
/** README: The selected track's glide segment from each frame, for camera follow. */
function subscribeLiveTrackSelection(listener) {
	selectionListeners.add(listener);
	return () => void selectionListeners.delete(listener);
}
function releaseLiveTrackFrame(buffer) {
	postToWorker({
		type: "RELEASE",
		buffer
	}, [buffer]);
}
function queryLiveTracks(query) {
	if (!liveTracksWorker) return Promise.resolve([]);
	const requestId = nextRequestId++;
	return new Promise((resolve) => {
		pendingReplies.set(requestId, resolve);
		postToWorker({
			type: "QUERY",
			requestId,
			query
		});
	});
}
// .build/step-4/apps/utm/src/shared/domain/replay-monitor/pick-live-track.ts
const ICON_MIN_ZOOM$1 = 11;
const PICK_RADIUS_PX = 16;
function toMercator(mapTarget, point) {
	const { x, y } = MercatorCoordinate.fromLngLat(mapTarget.unproject(point));
	return [x, y];
}
async function pickLiveTrackAt(mapTarget, point) {
	const zoom = mapTarget.getZoom();
	if (zoom < ICON_MIN_ZOOM$1) return void 0;
	const [track] = await queryLiveTracks({
		kind: "pick",
		mercator: toMercator(mapTarget, point),
		radius: PICK_RADIUS_PX / (512 * 2 ** zoom)
	});
	return track;
}
// .build/step-4/apps/utm/src/shared/domain/replay-monitor/track-follow.ts
function mercatorToLonLat(x, y) {
	return [x * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI];
}
/** README: Centres the map on the selected drone's drawn (gliding) position every frame. Returns the cleanup. */
function startSelectedTrackFollow(mapTarget, isFollowing) {
	let selection = null;
	let lastCenter = null;
	const unsubscribeSelection = subscribeLiveTrackSelection((next) => {
		selection = next;
	});
	const followSelectedTrack = () => {
		animationFrame = requestAnimationFrame(followSelectedTrack);
		const instance = selection?.selected;
		if (!selection || !instance || !isFollowing() || mapTarget.isMoving()) return;
		const fraction = Math.min(1, Math.max(0, (getLiveTrackClockSeconds() - (instance[4] ?? 0)) / selection.glideSeconds));
		const [startX = 0, startY = 0, endX = 0, endY = 0] = instance;
		const center = mercatorToLonLat(selection.origin[0] + startX + (endX - startX) * fraction, selection.origin[1] + startY + (endY - startY) * fraction);
		if (lastCenter?.[0] === center[0] && lastCenter[1] === center[1]) return;
		lastCenter = center;
		mapTarget.jumpTo({ center });
	};
	let animationFrame = requestAnimationFrame(followSelectedTrack);
	return () => {
		cancelAnimationFrame(animationFrame);
		unsubscribeSelection();
	};
}
// .build/step-4/apps/utm/src/shared/domain/replay-monitor/track-gl-layer.ts
const ICON_MIN_ZOOM = 11;
const ICON_HALF_SIZE_PX = 29.44 / 2;
const EFFECT_HALF_SIZE_PX = 33;
const PULSE_HALF_SIZE_PX = 62;
const PASS_EFFECTS = 0;
const PASS_PULSE = 1;
const PASS_ICON = 2;
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
}`;
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
}`;
const UNIFORMS = [
	"u_matrix",
	"u_now",
	"u_glide",
	"u_viewport",
	"u_half_size",
	"u_bearing",
	"u_pass",
	"u_highlight",
	"u_colors",
	"u_pulse_colors",
	"u_neutral",
	"u_pixel_ratio",
	"u_glow_opacity",
	"u_icon"
];
function compileProgram(gl) {
	const program = gl.createProgram();
	for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX_SHADER], [gl.FRAGMENT_SHADER, FRAGMENT_SHADER]]) {
		const shader = gl.createShader(type);
		if (!shader) throw new Error("Track layer: createShader failed");
		gl.shaderSource(shader, source);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Track layer shader: ${gl.getShaderInfoLog(shader) ?? ""}`);
		gl.attachShader(program, shader);
	}
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Track layer program: ${gl.getProgramInfoLog(program) ?? ""}`);
	return program;
}
/** README: mainMatrix * translate(origin), in float64 on the CPU, so the GPU only sees small relative positions. */
function translateMatrix(matrix, [originX, originY]) {
	const translated = /* @__PURE__ */ new Float32Array(16);
	for (let index = 0; index < 12; index++) translated[index] = matrix[index] ?? 0;
	for (let index = 0; index < 4; index++) translated[12 + index] = (matrix[index] ?? 0) * originX + (matrix[4 + index] ?? 0) * originY + (matrix[12 + index] ?? 0);
	return translated;
}
function createVertexArray(gl, quad, instances) {
	const vertexArray = gl.createVertexArray();
	gl.bindVertexArray(vertexArray);
	gl.bindBuffer(gl.ARRAY_BUFFER, quad);
	gl.enableVertexAttribArray(0);
	gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
	gl.bindBuffer(gl.ARRAY_BUFFER, instances);
	for (const [location, offset] of [[1, 0], [2, 16]]) {
		gl.enableVertexAttribArray(location);
		gl.vertexAttribPointer(location, 4, gl.FLOAT, false, 32, offset);
		gl.vertexAttribDivisor(location, 1);
	}
	gl.bindVertexArray(null);
	return vertexArray;
}
/** README: MapLibre custom layer that draws every live track with one instanced draw call per pass. The GPU moves each drone along its glide segment, so no per-frame CPU work depends on the track count. */
function createTrackGlLayer({ id, icon, colors, getNow, releaseBuffer }) {
	let map;
	let program;
	let quad;
	let instanceBuffer;
	let overlayBuffer;
	let vertexArray;
	let overlayVertexArray;
	let texture;
	let capacityBytes = 0;
	let count = 0;
	let origin = [.5, .5];
	let glideSeconds = 1.15;
	let overlays = [];
	let pending = null;
	const uniforms = /* @__PURE__ */ new Map();
	function upload(gl) {
		const frame = pending;
		if (!frame || !instanceBuffer || !overlayBuffer) return;
		pending = null;
		const bytes = frame.count * 8 * 4;
		gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
		if (bytes > capacityBytes) capacityBytes = Math.ceil(bytes * 1.25);
		gl.bufferData(gl.ARRAY_BUFFER, capacityBytes, gl.STREAM_DRAW);
		if (bytes > 0) gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array(frame.buffer, 0, frame.count * 8));
		overlays = [frame.hovered, frame.selected].filter((instance) => instance !== null);
		if (overlays.length > 0) {
			const overlayData = new Float32Array(overlays.length * 8);
			for (const [index, overlay] of overlays.entries()) overlayData.set(overlay, index * 8);
			gl.bindBuffer(gl.ARRAY_BUFFER, overlayBuffer);
			gl.bufferData(gl.ARRAY_BUFFER, overlayData, gl.DYNAMIC_DRAW);
		}
		count = frame.count;
		origin = frame.origin;
		glideSeconds = frame.glideSeconds;
		releaseBuffer(frame.buffer);
	}
	function drawPass(gl, pass, halfSizePx, instanceCount, options) {
		const pixelRatio = globalThis.devicePixelRatio || 1;
		gl.uniform1i(uniforms.get("u_pass") ?? null, pass);
		gl.uniform1f(uniforms.get("u_half_size") ?? null, halfSizePx * pixelRatio);
		gl.uniform1f(uniforms.get("u_glow_opacity") ?? null, options.glowOpacity);
		gl.uniform1i(uniforms.get("u_highlight") ?? null, options.isHighlight ? 1 : 0);
		gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instanceCount);
	}
	return {
		id,
		type: "custom",
		renderingMode: "2d",
		setFrame(frame) {
			if (pending) releaseBuffer(pending.buffer);
			pending = frame;
			map?.triggerRepaint();
		},
		onAdd(nextMap, gl) {
			map = nextMap;
			program = compileProgram(gl);
			for (const name of UNIFORMS) uniforms.set(name, gl.getUniformLocation(program, name));
			quad = gl.createBuffer();
			gl.bindBuffer(gl.ARRAY_BUFFER, quad);
			gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
				-1,
				-1,
				1,
				-1,
				-1,
				1,
				1,
				1
			]), gl.STATIC_DRAW);
			instanceBuffer = gl.createBuffer();
			overlayBuffer = gl.createBuffer();
			vertexArray = createVertexArray(gl, quad, instanceBuffer);
			overlayVertexArray = createVertexArray(gl, quad, overlayBuffer);
			texture = gl.createTexture();
			gl.bindTexture(gl.TEXTURE_2D, texture);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, icon);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
			gl.bindTexture(gl.TEXTURE_2D, null);
		},
		onRemove(_map, gl) {
			if (pending) releaseBuffer(pending.buffer);
			pending = null;
			gl.deleteProgram(program ?? null);
			for (const buffer of [
				quad,
				instanceBuffer,
				overlayBuffer
			]) gl.deleteBuffer(buffer ?? null);
			for (const array of [vertexArray, overlayVertexArray]) gl.deleteVertexArray(array ?? null);
			gl.deleteTexture(texture ?? null);
		},
		render(gl, options) {
			upload(gl);
			if (!map || !program || !vertexArray || !overlayVertexArray || count === 0 || map.getZoom() < ICON_MIN_ZOOM) return;
			gl.useProgram(program);
			gl.uniformMatrix4fv(uniforms.get("u_matrix") ?? null, false, translateMatrix(options.defaultProjectionData.mainMatrix, origin));
			gl.uniform1f(uniforms.get("u_now") ?? null, getNow());
			gl.uniform1f(uniforms.get("u_glide") ?? null, glideSeconds);
			gl.uniform2f(uniforms.get("u_viewport") ?? null, gl.drawingBufferWidth, gl.drawingBufferHeight);
			gl.uniform1f(uniforms.get("u_bearing") ?? null, map.getBearing() * Math.PI / 180);
			gl.uniform1f(uniforms.get("u_pixel_ratio") ?? null, globalThis.devicePixelRatio || 1);
			gl.uniform4fv(uniforms.get("u_colors") ?? null, colors.status.flat());
			gl.uniform4fv(uniforms.get("u_pulse_colors") ?? null, colors.pulse.flat());
			gl.uniform4fv(uniforms.get("u_neutral") ?? null, colors.neutral);
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, texture ?? null);
			gl.uniform1i(uniforms.get("u_icon") ?? null, 0);
			gl.disable(gl.DEPTH_TEST);
			gl.disable(gl.STENCIL_TEST);
			gl.enable(gl.BLEND);
			gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
			gl.bindVertexArray(vertexArray);
			drawPass(gl, PASS_EFFECTS, EFFECT_HALF_SIZE_PX, count, {
				glowOpacity: .15,
				isHighlight: false
			});
			drawPass(gl, PASS_PULSE, PULSE_HALF_SIZE_PX, count, {
				glowOpacity: 0,
				isHighlight: false
			});
			drawPass(gl, PASS_ICON, ICON_HALF_SIZE_PX, count, {
				glowOpacity: 0,
				isHighlight: false
			});
			if (overlays.length > 0) {
				gl.bindVertexArray(overlayVertexArray);
				drawPass(gl, PASS_EFFECTS, EFFECT_HALF_SIZE_PX, overlays.length, {
					glowOpacity: .4,
					isHighlight: true
				});
				drawPass(gl, PASS_ICON, ICON_HALF_SIZE_PX, overlays.length, {
					glowOpacity: 0,
					isHighlight: true
				});
			}
			gl.bindVertexArray(null);
			gl.bindTexture(gl.TEXTURE_2D, null);
			map.triggerRepaint();
		}
	};
}
// smoke/main.ts
const smoke = {
	viewUpdates: 0,
	lastFeatures: 0,
	lastHasAlert: false,
	frames: 0,
	lastCount: 0,
	errors: [],
	replies: [],
	clusterFeatures: 0,
	batchesToStore: 0
};
Object.assign(globalThis, { __smoke: smoke });
addEventListener("error", (event) => smoke.errors.push(String(event.message)));
function toRgba(color) {
	const canvas = document.createElement("canvas");
	canvas.width = canvas.height = 1;
	const context = canvas.getContext("2d", { willReadFrequently: true });
	if (!context) return [
		1,
		1,
		1,
		1
	];
	context.fillStyle = color;
	context.fillRect(0, 0, 1, 1);
	const [r = 255, g = 255, b = 255, a = 255] = context.getImageData(0, 0, 1, 1).data;
	return [
		r / 255,
		g / 255,
		b / 255,
		a / 255
	];
}
const COUNT = 5e3;
const tracks = Array.from({ length: COUNT }, (_, index) => ({
	ID: index + 1,
	TrackNumber: index + 10001,
	Longitude: 105.84 + index * 7919 % 1e3 / 1e3 * .06 - .03,
	Latitude: 21.03 + index * 104729 % 1e3 / 1e3 * .04 - .02,
	Altitude: 100,
	AircraftType: 1,
	Identification: 1,
	Heading: index * 37 % 360,
	Velocity: 10,
	Serial: "",
	CreatedAt: 0,
	UpdatedAt: 0,
	ListSources: [],
	Mode3a: `UAV-${index + 1}`
}));
sendLiveTrackAlerts(tracks.slice(0, 50).map((track) => ({
	trackId: track.TrackNumber,
	type: "socket.collision",
	level: "CRITICAL"
})), []);
const icon = new Image();
icon.src = "./drone1_out.png";
await icon.decode();
const map = new Map$1({
	container: "map",
	style: {
		version: 8,
		sources: {},
		layers: [{
			id: "bg",
			type: "background",
			paint: { "background-color": "#000000" }
		}]
	},
	center: [105.84, 21.03],
	zoom: 14,
	canvasContextAttributes: { preserveDrawingBuffer: true }
});
await map.once("load");
const layer = createTrackGlLayer({
	id: "track-gl",
	icon,
	colors: {
		status: [
			"#39FF14",
			"#FFD600",
			"#FF2B2B",
			"#9CA3AF",
			"#00BFFF",
			"#FF2B2B"
		].map(toRgba),
		pulse: [toRgba("#FFD600"), toRgba("#FF2B2B")],
		neutral: toRgba("#FFFFFF")
	},
	getNow: getLiveTrackClockSeconds,
	releaseBuffer: releaseLiveTrackFrame
});
map.addLayer(layer);
subscribeLiveTrackFrames((frame) => {
	smoke.frames++;
	smoke.lastCount = frame.count;
	layer.setFrame(frame);
});
subscribeLiveTrackView(1, (update) => {
	smoke.viewUpdates++;
	smoke.lastHasAlert = update.hasAlertInView;
	smoke.lastFeatures = update.data?.features.length ?? smoke.lastFeatures;
	smoke.clusterFeatures = update.data?.features.filter((feature) => "cluster" in feature.properties).length ?? smoke.clusterFeatures;
});
function getView() {
	const canvas = map.getCanvas();
	return {
		corners: [
			[-128, -128],
			[canvas.clientWidth + 128, -128],
			[canvas.clientWidth + 128, canvas.clientHeight + 128],
			[-128, canvas.clientHeight + 128]
		].map(([x = 0, y = 0]) => {
			const { lng, lat } = map.unproject([x, y]);
			return [lng, lat];
		}),
		zoom: map.getZoom(),
		selectedId: 10001,
		watchlistIds: null,
		renderer: "webgl"
	};
}
setLiveTrackView(1, getView(), true);
map.on("moveend", () => setLiveTrackView(1, getView()));
const worker = new Worker("./worker.mjs", { type: "module" });
worker.onerror = (event) => smoke.errors.push(`worker: ${event.message}`);
attachLiveTracksWorker(worker, () => smoke.batchesToStore++);
let batch = 0;
setInterval(() => {
	const batchSize = COUNT / 10;
	const slice = tracks.slice(batch * batchSize, (batch + 1) * batchSize);
	for (const track of slice) {
		const heading = track.Heading * Math.PI / 180;
		track.Longitude += Math.sin(heading) * 8e-5;
		track.Latitude += Math.cos(heading) * 8e-5;
		track.UpdatedAt = Date.now();
	}
	forwardLiveTrackBatch(JSON.stringify(slice));
	batch = (batch + 1) % 10;
}, 100);
Object.assign(globalThis, {
	__pickAt(longitude, latitude) {
		pickLiveTrackAt(map, map.project([longitude, latitude])).then((track) => smoke.replies.push(track ? [track] : []));
	},
	__firstTrack: () => tracks[0],
	__startFollow: () => startSelectedTrackFollow(map, () => true),
	__map: map,
	__countColor(r, g, b) {
		const canvas = map.getCanvas();
		const copy = document.createElement("canvas");
		copy.width = canvas.width;
		copy.height = canvas.height;
		const context = copy.getContext("2d");
		if (!context) return -1;
		context.drawImage(canvas, 0, 0);
		const data = context.getImageData(0, 0, copy.width, copy.height).data;
		let matches = 0;
		for (let index = 0; index < data.length; index += 4) if (Math.abs((data[index] ?? 0) - r) < 40 && Math.abs((data[index + 1] ?? 0) - g) < 40 && Math.abs((data[index + 2] ?? 0) - b) < 40) matches++;
		return matches;
	}
});
