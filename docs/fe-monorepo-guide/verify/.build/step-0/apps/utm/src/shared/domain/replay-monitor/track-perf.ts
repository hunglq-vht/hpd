// DEVMODE: Counters for the ?perf overlay and window.__TRACK_PERF__, used by scripts/perf/live-tracks-scenario.ts. Not shown in production.

type TrackPerfSnapshot = {
  batchesPerSecond: number
  tracksPerSecond: number
  mapFps: number
  longFramesPerSecond: number
  longFrameMsPerSecond: number
  blockingMsPerSecond: number
}

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- IMPOSSIBLE TO FIX: global declaration merging requires an interface.
  interface Window {
    __TRACK_PERF__?: TrackPerfSnapshot
  }
}

type LongAnimationFrameEntry = PerformanceEntry & { blockingDuration: number }

const counters = { batches: 0, tracks: 0, animationFrames: 0, longFrames: 0, longFrameMs: 0, blockingMs: 0 }
const listeners = new Set<() => void>()
let snapshot: TrackPerfSnapshot | null = null

export function countTrackBatch(trackCount: number) {
  counters.batches++
  counters.tracks += trackCount
}

export function getTrackPerfSnapshot(): TrackPerfSnapshot | null {
  return snapshot
}

export function subscribeTrackPerf(listener: () => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

export function startTrackPerf(): () => void {
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      counters.longFrames++
      counters.longFrameMs += entry.duration
      counters.blockingMs += 'blockingDuration' in entry ? (entry as LongAnimationFrameEntry).blockingDuration : 0
    }
  })
  if (PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')) observer.observe({ type: 'long-animation-frame' })
  const countFrame = () => {
    counters.animationFrames++
    animationFrame = requestAnimationFrame(countFrame)
  }
  let animationFrame = requestAnimationFrame(countFrame)
  const interval = setInterval(() => {
    snapshot = {
      batchesPerSecond: counters.batches,
      tracksPerSecond: counters.tracks,
      mapFps: counters.animationFrames,
      longFramesPerSecond: counters.longFrames,
      longFrameMsPerSecond: Math.round(counters.longFrameMs),
      blockingMsPerSecond: Math.round(counters.blockingMs),
    }
    for (const key of Object.keys(counters) as Array<keyof typeof counters>) counters[key] = 0
    window.__TRACK_PERF__ = snapshot
    for (const listener of listeners) listener()
  }, 1000)
  return () => {
    observer.disconnect()
    cancelAnimationFrame(animationFrame)
    clearInterval(interval)
  }
}
