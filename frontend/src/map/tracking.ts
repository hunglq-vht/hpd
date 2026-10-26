// UI-thread side of the tracks pipeline, independent of React and of the map: the tracks worker,
// the WebGL layer it feeds, the shared clock and the UI state store. React reads the state through
// useSyncExternalStore (TrackingProvider.tsx); the map hooks write it from events and timers, so
// nothing per-frame goes through React.

import type { FeatureCollection, Point } from "geojson";
import { natsUrl, u1Api, type AppConfig } from "../api.ts";
import { makeClock, wallMs } from "../shared/clock.ts";
import type { FromWorker, QueryFn, ToWorker, WorkerStats } from "../shared/protocol.ts";
import { createTrackSource, type OverLimit, type TrackSource } from "../source.ts";
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

export type Clusters = FeatureCollection<Point, { count: number; label: string }>;

export interface UiState {
  mode: Mode;
  zoom: number;
  status: { state: string; detail?: string };
  cluster: { level: number; inView: number; total: number; cells: number } | null;
  topics: { count: number; viewportTiles: number | null; expectedTracks: number | null; truncated: boolean; overLimit: OverLimit | null } | null;
  worker: WorkerStats | null;
  main: MainStats | null;
  selected: (TrackInfo & { ageMs: number }) | null;
  selectedId: number | null;
  selectionLost: boolean;
  follow: boolean;
  margin: number;
  stress: Stress;
  clusters: Clusters;
  realtimeReady: boolean;
  error: string | null;
}

export const CLUSTER_LAYER = "clusters-circle";

const EMPTY: Clusters = { type: "FeatureCollection", features: [] };

// ---- store ---------------------------------------------------------------------------------
export interface Store<T> {
  get: () => T;
  set: (p: Partial<T>) => void;
  subscribe: (l: () => void) => () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (p) => {
      state = { ...state, ...p };
      for (const l of listeners) l();
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
}

// ---- tracking ------------------------------------------------------------------------------
/** The selected track's newest instance from the worker, read every animation frame. */
export interface SelState {
  info: TrackInfo | null;
  inst: Float32Array | null;
  ox: number;
  oy: number;
  interp: number;
}

export interface Tracking {
  readonly cfg: AppConfig;
  readonly source: TrackSource;
  readonly store: Store<UiState>;
  /** shared-clock seconds; the worker and the shader use the same time base */
  readonly clock: () => number;
  readonly layer: TrackLayer;
  /** non-reactive values shared by the map hooks */
  readonly live: { sel: SelState | null; realtimeSince: number };
  post(m: ToWorker, transfer?: Transferable[]): void;
  /** Asks the worker; resolves with its reply. */
  query: QueryFn;
  /** Nearest displayed track within `radius` (mercator units), found by the worker. */
  pick(mx: number, my: number, radius: number): Promise<number | null>;
  select(id: number | null): void;
  /** Terminates the worker and its NATS connection. */
  dispose(): void;
}

export function createTracking(cfg: AppConfig, margin: number): Tracking {
  const epochMs = wallMs();
  const store = createStore<UiState>({
    mode: "cluster", zoom: 0, status: { state: "connecting" }, cluster: null, topics: null, worker: null, main: null,
    selected: null, selectedId: null, selectionLost: false, follow: true,
    margin, stress: 0, clusters: EMPTY, realtimeReady: false, error: null,
  });
  const live: Tracking["live"] = { sel: null, realtimeSince: 0 };
  const pending = new Map<number, { resolve: (data: never) => void; reject: (e: Error) => void }>();
  let reqSeq = 0;

  const worker = new Worker(new URL("../worker/tracks.worker.ts", import.meta.url), { type: "module", name: "tracks" });
  const post = (m: ToWorker, transfer: Transferable[] = []) => worker.postMessage(m, transfer);
  const layer = new TrackLayer("tracks", (buf) => post({ type: "release", buf }, [buf]));

  worker.onmessage = (e: MessageEvent<FromWorker>) => {
    const m = e.data;
    const s = store.get();
    switch (m.type) {
      case "status":
        store.set({ status: { state: m.state, detail: m.detail } });
        break;
      case "frame":
        layer.setFrame({ buf: m.buf, n: m.n, ox: m.ox, oy: m.oy, interp: m.interp, selectedInst: m.selected?.inst ?? null });
        live.sel = m.selected ? { info: m.selected.info, inst: m.selected.inst, ox: m.ox, oy: m.oy, interp: m.interp } : null;
        if (!s.realtimeReady && m.n > 0 && s.mode !== "cluster") store.set({ realtimeReady: true });
        if (s.selectedId !== null) {
          const lost = !m.selected?.info;
          if (lost !== s.selectionLost) store.set({ selectionLost: lost });
        }
        break;
      case "stats":
        (window as unknown as { __perf: unknown }).__perf = { ...m.stats, main: s.main, mode: s.mode, topics: s.topics };
        store.set({ worker: m.stats });
        break;
      case "reply": {
        const p = pending.get(m.reqId);
        pending.delete(m.reqId);
        if (m.error !== undefined) p?.reject(new Error(m.error));
        else p?.resolve(m.data as never);
        break;
      }
    }
  };
  post({
    type: "init", backend: cfg.backend, url: natsUrl(cfg), user: cfg.nats.user, pass: cfg.nats.pass, epochMs,
    intervalMs: cfg.publishIntervalMs, staleFactor: cfg.staleFactor,
    statsUrl: cfg.backend === "u1" ? u1Api.statsUrl(cfg) : "",
  });

  const query: QueryFn = (q) =>
    new Promise((resolve, reject) => {
      const reqId = ++reqSeq;
      pending.set(reqId, { resolve, reject });
      post({ type: "query", reqId, query: q });
    });

  return {
    cfg,
    source: createTrackSource(cfg, query),
    store,
    clock: makeClock(epochMs),
    layer,
    live,
    post,
    query,
    pick: (mx, my, radius) => query({ q: "pick", mx, my, radius }),
    select(id) {
      live.sel = null;
      post({ type: "select", id });
      store.set({ selectedId: id, selected: null, selectionLost: false, follow: id !== null });
    },
    dispose: () => worker.terminate(),
  };
}

export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}
