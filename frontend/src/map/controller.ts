// UI-thread brain of the map. Decides cluster vs realtime mode, asks the API for cluster stats or
// for the NATS topics covering the viewport, drives the tracks worker, picks and follows tracks.
// React reads its state through subscribe/getState (useSyncExternalStore); nothing here runs per
// React render.

import type { FeatureCollection, Point } from "geojson";
import type { Map as MlMap, MapMouseEvent } from "maplibre-gl";
import { api, natsUrl, type AppConfig, type BBox } from "../api.ts";
import { makeClock, wallMs } from "../shared/clock.ts";
import type { FromWorker, ToWorker, WorkerStats } from "../shared/protocol.ts";
import { lonLatToMerc, mercToLonLat, statsLevel } from "../shared/tiles.ts";
import type { TrackInfo } from "../shared/trackStore.ts";
import { TrackLayer } from "./TrackLayer.ts";

export type Mode = "cluster" | "realtime" | "stress";

/** Stress test: 0 = off, N > 0 = the N densest tiles, -1 = every tile (tracks.>). */
export type Stress = number;

export interface MainStats {
  fps: number;
  uploadsPerSec: number;
  uploadMBps: number;
  uploadMsAvg: number;
  drawMsAvg: number;
  heapMB: number | null;
  tracksDrawn: number;
}

export interface UiState {
  mode: Mode;
  zoom: number;
  status: { state: string; detail?: string };
  cluster: { level: number; inView: number; total: number; cells: number } | null;
  topics: { count: number; viewportTiles: number; expectedTracks: number; viewportTracks: number; truncated: boolean } | null;
  worker: WorkerStats | null;
  main: MainStats | null;
  selected: (TrackInfo & { ageMs: number }) | null;
  selectedId: number | null;
  selectionLost: boolean;
  follow: boolean;
  margin: number;
  stress: Stress;
  clusters: FeatureCollection<Point, { count: number; label: string }>;
  realtimeReady: boolean;
  error: string | null;
}

const EMPTY: FeatureCollection<Point, { count: number; label: string }> = { type: "FeatureCollection", features: [] };
export const CLUSTER_LAYER = "clusters-circle";

interface SelState {
  info: TrackInfo | null;
  inst: Float32Array | null;
  ox: number;
  oy: number;
  interp: number;
}

export class Controller {
  readonly cfg: AppConfig;
  readonly epochMs = wallMs();
  readonly clock = makeClock(this.epochMs);
  private state: UiState;
  private listeners = new Set<() => void>();
  private worker: Worker;
  private layer: TrackLayer;
  private map: MlMap | null = null;
  private sel: SelState | null = null;
  private raf = 0;
  private timers: number[] = [];
  private refreshTimer = 0;
  private refreshDeadline = 0;
  private abort: AbortController | null = null;
  private reqSeq = 0;
  private pickSeq = 0;
  private picks = new Map<number, (id: number | null) => void>();
  private frames = 0;
  private lastLayerStats = { uploads: 0, uploadBytes: 0, uploadMs: 0, drawMs: 0, framesRendered: 0 };
  private lastSelPush = 0;
  private realtimeSince = 0;

  constructor(cfg: AppConfig, opts: { margin?: number } = {}) {
    this.cfg = cfg;
    this.state = {
      mode: "cluster", zoom: 0, status: { state: "connecting" }, cluster: null, topics: null, worker: null, main: null,
      selected: null, selectedId: null, selectionLost: false, follow: true,
      margin: opts.margin ?? cfg.defaultMargin, stress: 0, clusters: EMPTY, realtimeReady: false, error: null,
    };
    this.worker = new Worker(new URL("../worker/tracks.worker.ts", import.meta.url), { type: "module", name: "tracks" });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onWorker(e.data);
    this.layer = new TrackLayer("tracks", (buf) => this.post({ type: "release", buf }, [buf]));
    this.post({
      type: "init", url: natsUrl(cfg), user: cfg.nats.user, pass: cfg.nats.pass, epochMs: this.epochMs,
      intervalMs: cfg.publishIntervalMs, staleFactor: cfg.staleFactor,
    });
  }

  // ---- store -------------------------------------------------------------------------------
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getState = () => this.state;
  private set(p: Partial<UiState>) {
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  }

  private post(m: ToWorker, transfer: Transferable[] = []) {
    this.worker.postMessage(m, transfer);
  }

  // ---- lifecycle ---------------------------------------------------------------------------
  attach(map: MlMap) {
    this.map = map;
    (window as unknown as { __app: unknown }).__app = { map, controller: this }; // for automation / devtools
    map.addLayer(this.layer);
    map.on("move", this.scheduleRefresh);
    map.on("moveend", this.scheduleRefresh);
    map.on("click", this.onClick);
    map.on("dragstart", this.onDragStart);
    map.on("zoomend", this.logZoom);
    this.logZoom();
    this.raf = requestAnimationFrame(this.loop);
    this.timers.push(window.setInterval(this.pollStats, this.cfg.publishIntervalMs));
    this.timers.push(window.setInterval(this.measure, 1000));
    window.addEventListener("keydown", this.onKey);
    this.refresh();
  }

  detach() {
    cancelAnimationFrame(this.raf);
    this.timers.forEach(clearInterval);
    window.removeEventListener("keydown", this.onKey);
    const map = this.map;
    if (map) {
      map.off("move", this.scheduleRefresh);
      map.off("moveend", this.scheduleRefresh);
      map.off("click", this.onClick);
      map.off("dragstart", this.onDragStart);
      map.off("zoomend", this.logZoom);
      if (map.getLayer(this.layer.id)) map.removeLayer(this.layer.id);
    }
    this.worker.terminate();
    this.map = null;
  }

  // ---- worker ------------------------------------------------------------------------------
  private onWorker(m: FromWorker) {
    switch (m.type) {
      case "status":
        this.set({ status: { state: m.state, detail: m.detail } });
        break;
      case "frame":
        this.layer.setFrame({ buf: m.buf, n: m.n, ox: m.ox, oy: m.oy, interp: m.interp, selectedInst: m.selected?.inst ?? null });
        this.sel = m.selected ? { info: m.selected.info, inst: m.selected.inst, ox: m.ox, oy: m.oy, interp: m.interp } : null;
        if (!this.state.realtimeReady && m.n > 0 && this.state.mode !== "cluster") this.set({ realtimeReady: true });
        if (this.state.selectedId !== null) {
          const lost = !m.selected?.info;
          if (lost !== this.state.selectionLost) this.set({ selectionLost: lost });
        }
        break;
      case "stats":
        (window as unknown as { __perf: unknown }).__perf = { ...m.stats, main: this.state.main, mode: this.state.mode, topics: this.state.topics };
        this.set({ worker: m.stats });
        break;
      case "picked":
        this.picks.get(m.reqId)?.(m.id);
        this.picks.delete(m.reqId);
        break;
    }
  }

  // ---- animation loop: shared clock for the GPU + camera follow ------------------------------
  private loop = () => {
    const now = this.clock();
    this.layer.now = now;
    this.frames++;
    const map = this.map;
    const sel = this.sel;
    if (map && sel?.inst && this.state.follow) {
      const i = sel.inst;
      const f = Math.min(1, Math.max(0, (now - i[4]) / sel.interp));
      const [lon, lat] = mercToLonLat(sel.ox + i[0] + (i[2] - i[0]) * f, sel.oy + i[1] + (i[3] - i[1]) * f);
      // never fight a gesture or animation; zoom gestures pivot on the centre while following
      if (!map.isMoving()) map.jumpTo({ center: [lon, lat] });
    }
    if (sel?.info && performance.now() - this.lastSelPush > 250) {
      this.lastSelPush = performance.now();
      this.set({ selected: { ...sel.info, ageMs: Math.max(0, (now - sel.info.lastSeen) * 1000) } });
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  private measure = () => {
    const s = this.layer.stats;
    const d = {
      uploads: s.uploads - this.lastLayerStats.uploads,
      uploadBytes: s.uploadBytes - this.lastLayerStats.uploadBytes,
      uploadMs: s.uploadMs - this.lastLayerStats.uploadMs,
      drawMs: s.drawMs - this.lastLayerStats.drawMs,
      framesRendered: s.framesRendered - this.lastLayerStats.framesRendered,
    };
    this.lastLayerStats = { ...s };
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    this.set({
      main: {
        fps: this.frames,
        uploadsPerSec: d.uploads,
        uploadMBps: d.uploadBytes / 1e6,
        uploadMsAvg: d.uploads ? d.uploadMs / d.uploads : 0,
        drawMsAvg: d.framesRendered ? d.drawMs / d.framesRendered : 0,
        heapMB: mem ? mem.usedJSHeapSize / 1e6 : null,
        tracksDrawn: this.layer.count,
      },
    });
    this.frames = 0;
  };

  // ---- viewport -> cluster stats or NATS topics ---------------------------------------------
  private scheduleRefresh = () => {
    const now = performance.now();
    if (!this.refreshTimer) this.refreshDeadline = now + 600; // max wait while moving continuously
    clearTimeout(this.refreshTimer);
    const delay = Math.max(0, Math.min(150, this.refreshDeadline - now));
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = 0;
      this.refresh();
    }, delay);
  };

  private bbox(): BBox {
    const b = this.map!.getBounds();
    return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  }

  private center(): [number, number] {
    const c = this.map!.getCenter();
    return lonLatToMerc(c.lng, c.lat);
  }

  refresh = async () => {
    const map = this.map;
    if (!map) return;
    const zoom = map.getZoom();
    const seq = ++this.reqSeq;
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    const realtime = zoom >= this.cfg.realtimeMinZoom;
    const mode: Mode = this.state.stress ? "stress" : realtime ? "realtime" : "cluster";
    if (mode !== this.state.mode) {
      if (mode === "realtime") this.realtimeSince = performance.now();
      this.set({ mode, realtimeReady: mode === "cluster" ? false : this.state.realtimeReady && this.state.mode !== "cluster" });
    }
    this.set({ zoom });
    this.layer.mode = mode === "cluster" ? "selected" : "all";

    try {
      if (mode === "stress") return;
      if (mode === "realtime") {
        const t = await api.topics(this.bbox(), zoom, this.state.margin, abort.signal);
        if (seq !== this.reqSeq) return;
        this.post({ type: "topics", subjects: t.topics.map((x) => x.subject), origin: this.center() });
        this.set({
          topics: { count: t.topics.length, viewportTiles: t.viewportTiles, expectedTracks: t.expectedTracks, viewportTracks: t.viewportTracks, truncated: t.truncated },
          error: null,
        });
        // clusters stay on screen until the first live frame (or 2 s) to avoid a blank map
        if (!this.state.realtimeReady && performance.now() - this.realtimeSince > 2000) this.set({ realtimeReady: true });
      } else {
        await Promise.all([this.loadClusters(zoom, abort.signal, seq), this.keepSelectionSubscribed(abort.signal, seq)]);
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") this.set({ error: (e as Error).message });
    }
  };

  private pollStats = () => {
    if (this.map && this.state.mode === "cluster" && !document.hidden) {
      const zoom = this.map.getZoom();
      this.loadClusters(zoom, undefined, this.reqSeq).catch((e) => this.set({ error: (e as Error).message }));
    } else if (this.state.mode === "realtime" && !this.state.realtimeReady && performance.now() - this.realtimeSince > 2000) {
      this.set({ realtimeReady: true });
    }
  };

  private async loadClusters(zoom: number, signal: AbortSignal | undefined, seq: number) {
    const s = await api.stats(this.bbox(), zoom, signal);
    if (seq !== this.reqSeq || this.state.mode !== "cluster") return;
    const features = s.cells.map(([x, y, count, lon, lat]) => ({
      type: "Feature" as const,
      id: x * 65536 + y,
      geometry: { type: "Point" as const, coordinates: [lon, lat] },
      properties: { count, label: compact(count) },
    }));
    this.set({
      clusters: { type: "FeatureCollection", features },
      cluster: { level: statsLevel(zoom), inView: s.inView, total: s.total, cells: s.cells.length },
      error: null,
    });
  }

  /** In cluster mode a selected track keeps its own tile (+ ring) subscribed, so it stays live. */
  private async keepSelectionSubscribed(signal: AbortSignal, seq: number) {
    const info = this.sel?.info ?? this.state.selected;
    if (this.state.selectedId === null || !info) {
      this.post({ type: "topics", subjects: [], origin: this.center() });
      return;
    }
    const d = 0.0005;
    const t = await api.topics([info.lon - d, info.lat - d, info.lon + d, info.lat + d], this.cfg.realtimeMinZoom, 0, signal);
    if (seq !== this.reqSeq) return;
    this.post({ type: "topics", subjects: t.topics.map((x) => x.subject), origin: [info.mx, info.my] });
  }

  // ---- interaction --------------------------------------------------------------------------
  private onClick = async (e: MapMouseEvent) => {
    const map = this.map!;
    if (this.state.mode === "cluster") {
      const hit = map.queryRenderedFeatures(e.point, { layers: [CLUSTER_LAYER] })[0];
      if (hit && hit.geometry.type === "Point") {
        const z = map.getZoom();
        map.easeTo({ center: hit.geometry.coordinates as [number, number], zoom: z >= 10 ? this.cfg.realtimeMinZoom + 0.5 : z + 2.5, duration: 800 });
      }
      return;
    }
    const [mx, my] = lonLatToMerc(e.lngLat.lng, e.lngLat.lat);
    const radius = 16 / (512 * 2 ** map.getZoom());
    const reqId = ++this.pickSeq;
    const id = await new Promise<number | null>((res) => {
      this.picks.set(reqId, res);
      this.post({ type: "pick", reqId, mx, my, radius });
    });
    this.select(id);
  };

  private onDragStart = () => {
    if (this.state.follow && this.state.selectedId !== null) this.setFollow(false);
  };

  /** Logs the map zoom once per settled zoom change (gesture, fly-to, buttons) and on attach. */
  private logZoom = () => {
    if (this.map) console.info(`[map] zoom ${this.map.getZoom().toFixed(2)}`);
  };

  private onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") this.select(null);
  };

  select(id: number | null) {
    this.sel = null;
    this.post({ type: "select", id });
    this.set({ selectedId: id, selected: null, selectionLost: false });
    this.setFollow(id !== null);
  }

  setFollow(follow: boolean) {
    this.set({ follow });
    const map = this.map;
    if (!map) return;
    // while following, wheel/pinch zoom pivots on the followed track instead of the cursor
    const around = follow ? { around: "center" as const } : undefined;
    map.scrollZoom.disable();
    map.scrollZoom.enable(around);
    map.touchZoomRotate.disable();
    map.touchZoomRotate.enable(around);
  }

  setMargin(margin: number) {
    this.set({ margin });
    this.refresh();
  }

  async setStress(stress: Stress) {
    if (!this.map) return;
    let subjects: string[] | null = null;
    if (stress < 0) subjects = ["tracks.>"];
    else if (stress > 0) subjects = (await api.topTiles(stress)).tiles.map((t) => t.subject);
    this.post({ type: "override", subjects, origin: this.center() });
    this.set({ stress, realtimeReady: false });
    this.realtimeSince = performance.now();
    this.refresh();
  }

  flyTo(lon: number, lat: number, zoom: number) {
    this.setFollow(false);
    this.map?.flyTo({ center: [lon, lat], zoom, speed: 1.6, curve: 1.5, essential: true });
  }

  async flyToHottest() {
    const top = await api.topTiles(1);
    if (top.tiles[0]) this.flyTo(top.tiles[0].lon, top.tiles[0].lat, 14);
  }
}

export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}
