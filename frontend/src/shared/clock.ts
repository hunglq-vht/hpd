// A shared time base for the UI thread, the worker and the GPU: seconds since `epochMs`.
// performance.timeOrigin + performance.now() is comparable across the page and its workers,
// and small values keep float32 precision on the GPU.

export const wallMs = () => performance.timeOrigin + performance.now();

export function makeClock(epochMs: number) {
  return () => (wallMs() - epochMs) / 1000;
}
