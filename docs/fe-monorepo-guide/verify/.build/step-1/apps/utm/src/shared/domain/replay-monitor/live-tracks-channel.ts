import { getCssColor } from '@platform/lib/shared/css/get-css-color'
import type { LiveTracksWorkerRequest, LiveTracksWorkerResponse, TrackAlert, TrackAlertRemoval, TrackView, TrackViewUpdate } from '@platform/utm/shared/domain/replay-monitor/live-tracks.types'
import { STATUS_COLORS } from '@platform/utm/shared/domain/replay-monitor/status-colors'
import type { TrackStatus } from '@platform/utm/shared/domain/replay-monitor/status-colors'
import type { Track } from '@platform/utm/shared/wire/track-wire'

type ViewListener = (update: TrackViewUpdate) => void

let liveTracksWorker: Worker | null = null
let statusColors: Record<TrackStatus, string> | null = null
const views = new Map<number, TrackView>()
const viewListeners = new Map<number, ViewListener>()
const queuedMessages: LiveTracksWorkerRequest[] = []

function postToWorker(message: LiveTracksWorkerRequest) {
  if (liveTracksWorker) {
    liveTracksWorker.postMessage(message)
    return
  }
  // README: Alerts and the API snapshot can arrive before the worker starts; views are re-sent from `views`.
  if (message.type === 'ALERTS' || message.type === 'SNAPSHOT') queuedMessages.push(message)
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
    }
  }
  postToWorker({ type: 'INIT' })
  if (statusColors) postToWorker({ type: 'COLORS', colors: statusColors })
  for (const [viewId, view] of views) postToWorker({ type: 'VIEW', viewId, view, shouldReset: true })
  for (const message of queuedMessages.splice(0)) postToWorker(message)

  return () => {
    worker.terminate()
    liveTracksWorker = null
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
