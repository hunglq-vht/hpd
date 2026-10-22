// Messages between the UI thread and the tracks worker.
import type { LatencySummary } from "./metrics.ts";
import type { TrackInfo } from "./trackStore.ts";

export type ToWorker =
  | { type: "init"; url: string; user: string; pass: string; epochMs: number; intervalMs: number; staleFactor: number }
  | { type: "topics"; subjects: string[]; origin: [number, number] }
  /** Stress tests: subscribe exactly these subjects (e.g. ["tracks.>"]) instead of the viewport cover; null restores it. */
  | { type: "override"; subjects: string[] | null; origin: [number, number] }
  | { type: "select"; id: number | null }
  | { type: "pick"; reqId: number; mx: number; my: number; radius: number }
  | { type: "release"; buf: ArrayBuffer };

export interface SelectedFrame {
  info: TrackInfo | null; // null when the track is no longer in the store
  inst: Float32Array | null; // its STRIDE floats (relative to the frame origin)
}

export type FromWorker =
  | { type: "status"; state: "connecting" | "connected" | "reconnecting" | "disconnected" | "error"; detail?: string }
  | { type: "frame"; buf: ArrayBuffer; n: number; ox: number; oy: number; interp: number; selected: SelectedFrame | null }
  | { type: "picked"; reqId: number; id: number | null }
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
  latency: LatencySummary;
  clockOffsetMs: number;
  clockRttMs: number;
  reconnects: number;
  slowConsumer: number;
  badMessages: number;
}
