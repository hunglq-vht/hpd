// Messages between the UI thread and the tracks worker.
import type { LatencySummary } from "./metrics.ts";
import type { BBox, ClusterResult, TopTile } from "./regions.ts";
import type { TrackInfo } from "./trackStore.ts";

/** demo: this repo's Go backend (binary tile snapshots). u1: u1-track-manager (JSON events). */
export type Backend = "demo" | "u1";

/** Requests the worker answers with a "reply" carrying the same reqId. */
export type Query =
  | { q: "pick"; mx: number; my: number; radius: number }
  /** u1 only: cluster cells built from GET tracks/regions/stats */
  | { q: "clusters"; bbox: BBox; level: number }
  /** u1 only: the busiest regions from GET tracks/regions/stats */
  | { q: "top"; limit: number };

export interface QueryResult {
  pick: number | null;
  clusters: ClusterResult;
  top: TopTile[];
}

export type QueryFn = <Q extends Query>(query: Q) => Promise<QueryResult[Q["q"]]>;

export type ToWorker =
  | {
      type: "init"; backend: Backend; url: string; user: string; pass: string;
      epochMs: number; intervalMs: number; staleFactor: number;
      /** u1: absolute URL of GET tracks/regions/stats */
      statsUrl: string;
    }
  | { type: "topics"; subjects: string[]; origin: [number, number] }
  /** Stress tests: subscribe exactly these subjects (e.g. ["tracks.>"]) instead of the viewport cover; null restores it. */
  | { type: "override"; subjects: string[] | null; origin: [number, number] }
  | { type: "select"; id: number | null }
  | { type: "query"; reqId: number; query: Query }
  | { type: "release"; buf: ArrayBuffer };

export interface SelectedFrame {
  info: TrackInfo | null; // null when the track is no longer in the store
  inst: Float32Array | null; // its STRIDE floats (relative to the frame origin)
}

export type FromWorker =
  | { type: "status"; state: "connecting" | "connected" | "reconnecting" | "disconnected" | "error"; detail?: string }
  | { type: "frame"; buf: ArrayBuffer; n: number; ox: number; oy: number; interp: number; selected: SelectedFrame | null }
  | { type: "reply"; reqId: number; data?: unknown; error?: string }
  | { type: "stats"; stats: WorkerStats };

export interface WorkerStats {
  subscriptions: number;
  tracks: number;
  msgsPerSec: number;
  tracksPerSec: number;
  bytesPerSec: number;
  /** ms of worker CPU per second spent decoding + committing + building frames */
  busyMsPerSec: number;
  decodeUsPerMsg: number;
  framesPerSec: number;
  framesSkipped: number;
  frameBytes: number;
  /** publish interval the glide uses: from the snapshot header (demo) or measured per track (u1) */
  updateIntervalMs: number;
  latency: LatencySummary;
  clockOffsetMs: number;
  clockRttMs: number;
  reconnects: number;
  slowConsumer: number;
  badMessages: number;
}
