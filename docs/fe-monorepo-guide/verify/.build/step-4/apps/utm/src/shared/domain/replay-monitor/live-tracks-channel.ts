import { getCssColor } from '@platform/lib/shared/css/get-css-color'
import type { LiveTracksWorkerRequest, LiveTracksWorkerResponse, TrackAlert, TrackAlertRemoval, TrackFeatureProperties, TrackFrame, TrackQuery, TrackView, TrackViewUpdate } from '@platform/utm/shared/domain/replay-monitor/live-tracks.types'
import { STATUS_COLORS } from '@platform/utm/shared/domain/replay-monitor/status-colors'
import type { TrackStatus } from '@platform/utm/shared/domain/replay-monitor/status-colors'
import type { Track } from '@platform/utm/shared/wire/track-wire'

type ViewListener = (update: TrackViewUpdate) => void
type FrameListener = (frame: TrackFrame) => void
type SelectionListener = (selection: Pick<TrackFrame, 'selected' | 'origin' | 'glideSeconds'>) => void

// README: One clock for the page, the worker and the shader: seconds since this epoch keep float32 precision on the GPU.
const LIVE_TRACK_EPOCH_MS = performance.timeOrigin + performance.now()

let liveTracksWorker: Worker | null = null
let statusColors: Record<TrackStatus, string> | null = null
let frameListener: FrameListener | null = null
let nextRequestId = 1
const views = new Map<number, TrackView>()
const viewListeners = new Map<number, ViewListener>()
const selectionListeners = new Set<SelectionListener>()
const pendingReplies = new Map<number, (tracks: TrackFeatureProperties[]) => void>()
const queuedMessages: LiveTracksWorkerRequest[] = []

function postToWorker(message: LiveTracksWorkerRequest, transfer: Transferable[] = []) {
  if (liveTracksWorker) {
    liveTracksWorker.postMessage(message, { transfer })
    return
  }
  // README: Alerts and the API snapshot can arrive before the worker starts; views are re-sent from `views`.
  if (message.type === 'ALERTS' || message.type === 'SNAPSHOT') queuedMessages.push(message)
}

export function getLiveTrackClockSeconds(): number {
  return (performance.timeOrigin + performance.now() - LIVE_TRACK_EPOCH_MS) / 1000
}

/** README: Called by LiveTracksConnection. Returns the cleanup. `onTracks` receives each validated batch for the main-thread store. */
export function attachLiveTracksWorker(worker: Worker, onTracks: (tracks: Track[]) => void): () => void {
  liveTracksWorker = worker
  worker.onmessage = (event: MessageEvent<LiveTracksWorkerResponse>) => {
    const message = event.data
    switch (message.type) {
      case 'TRACKS_READY': {
        onTracks(message.data)
        break
      }
      case 'VIEW_UPDATE': {
        viewListeners.get(message.viewId)?.(message)
        break
      }
      case 'FRAME': {
        for (const listener of selectionListeners) listener({ selected: message.selected, origin: message.origin, glideSeconds: message.glideSeconds })
        if (frameListener) frameListener(message)
        else postToWorker({ type: 'RELEASE', buffer: message.buffer }, [message.buffer])
        break
      }
      case 'REPLY': {
        pendingReplies.get(message.requestId)?.(message.tracks)
        pendingReplies.delete(message.requestId)
        break
      }
    }
  }
  postToWorker({ type: 'INIT', epochMs: LIVE_TRACK_EPOCH_MS })
  if (statusColors) postToWorker({ type: 'COLORS', colors: statusColors })
  for (const [viewId, view] of views) postToWorker({ type: 'VIEW', viewId, view, shouldReset: true })
  for (const message of queuedMessages.splice(0)) postToWorker(message)

  return () => {
    worker.terminate()
    liveTracksWorker = null
    for (const resolve of pendingReplies.values()) resolve([])
    pendingReplies.clear()
  }
}

export function forwardLiveTrackBatch(data: string) {
  postToWorker({ type: 'BATCH', data })
}

export function sendLiveTrackSnapshot(tracks: Track[]) {
  postToWorker({ type: 'SNAPSHOT', tracks })
}

export function sendLiveTrackAlerts(add: TrackAlert[], remove: TrackAlertRemoval[]) {
  if (add.length === 0 && remove.length === 0) return
  postToWorker({ type: 'ALERTS', add, remove })
}

export function setLiveTrackView(viewId: number, view: TrackView | null, shouldReset = false) {
  // README: Resolve theme colors with the first map view: the map's CSS is loaded by then, and jsdom tests without maps never need them.
  if (view && !statusColors) {
    statusColors = {
      NORMAL: getCssColor(STATUS_COLORS.NORMAL),
      WARNING: getCssColor(STATUS_COLORS.WARNING),
      CRITICAL: getCssColor(STATUS_COLORS.CRITICAL),
      LOST_LINK: getCssColor(STATUS_COLORS.LOST_LINK),
      PROCESSING: getCssColor(STATUS_COLORS.PROCESSING),
      LOST_CONTROL: getCssColor(STATUS_COLORS.LOST_CONTROL),
    }
    postToWorker({ type: 'COLORS', colors: statusColors })
  }
  if (view) views.set(viewId, view)
  else views.delete(viewId)
  postToWorker({ type: 'VIEW', viewId, view, shouldReset })
}

export function subscribeLiveTrackView(viewId: number, listener: ViewListener): () => void {
  viewListeners.set(viewId, listener)
  return () => {
    if (viewListeners.get(viewId) === listener) viewListeners.delete(viewId)
  }
}

export function subscribeLiveTrackFrames(listener: FrameListener): () => void {
  frameListener = listener
  return () => {
    if (frameListener === listener) frameListener = null
  }
}

/** README: The selected track's glide segment from each frame, for camera follow. */
export function subscribeLiveTrackSelection(listener: SelectionListener): () => void {
  selectionListeners.add(listener)
  return () => void selectionListeners.delete(listener)
}

export function releaseLiveTrackFrame(buffer: ArrayBuffer) {
  postToWorker({ type: 'RELEASE', buffer }, [buffer])
}

export function setHoveredLiveTrack(trackId: number | null) {
  postToWorker({ type: 'HOVER', trackId })
}

export function queryLiveTracks(query: TrackQuery): Promise<TrackFeatureProperties[]> {
  if (!liveTracksWorker) return Promise.resolve([])
  const requestId = nextRequestId++
  return new Promise(resolve => {
    pendingReplies.set(requestId, resolve)
    postToWorker({ type: 'QUERY', requestId, query })
  })
}
