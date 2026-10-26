import { catchErrorSync } from '@platform/lib/shared/error/handle-error'
import type { LiveTracksWorkerRequest, LiveTracksWorkerResponse, TrackFeatureProperties, TrackView, TrackViewUpdate } from '@platform/utm/shared/domain/replay-monitor/live-tracks.types'
import { TRACK_STATUSES } from '@platform/utm/shared/domain/replay-monitor/status-colors'
import type { TrackStatus } from '@platform/utm/shared/domain/replay-monitor/status-colors'
import type { Track } from '@platform/utm/shared/wire/track-wire'
import { z } from 'zod'

import { clusterTrackFeatures, TRACK_CLUSTER_MAX_ZOOM } from './live-tracks/track-clusters'
import { createTrackStore, TRACK_INSTANCE_STRIDE, TRACK_STYLE_HIDDEN } from './live-tracks/track-store'
import { diffTrackFeatures, getTrackStatus, isEmptyDiff, isInViewArea, isInWatchlist, lonLatToMercator, toTrackFeature, toViewArea } from './live-tracks/track-view'
import type { LiveTrack, TrackAlerts, TrackFeature, ViewArea } from './live-tracks/track-view'

const trackSourceSchema = z.strictObject({
  SourceName: z.string(),
  TrackNumber: z.string(),
})

const trackSchema = z.object({
  ID: z.number(),
  TrackNumber: z.number(),
  Longitude: z.number(),
  Latitude: z.number(),
  Altitude: z.number(),
  AircraftType: z.number(),
  Identification: z.number(),
  Quantity: z.number().optional(),
  Model: z.string().optional(),
  Heading: z.number().optional().default(0),
  Velocity: z.number().optional().default(0),
  Quality: z.number().optional(),
  PrimarySource: trackSourceSchema.nullish(),
  Serial: z.string().optional().default(''),
  Shape: z.string().optional(),
  CreatedAt: z.number(),
  UpdatedAt: z.number(),
  ListSources: z.array(trackSourceSchema).optional().default([]),
  Mode3a: z.string(),
})

const trackListSchema = z.array(trackSchema)

const wrappedTrackListSchema = z.object({
  data: z.union([
    z.object({
      items: trackListSchema,
    }),
    trackListSchema,
  ]),
})

function parseLiveTracksMessage(message: unknown): Track[] | null {
  const directTracks = trackListSchema.safeParse(message)
  if (directTracks.success) return directTracks.data

  const wrappedTracks = wrappedTrackListSchema.safeParse(message)
  if (!wrappedTracks.success) return null

  return Array.isArray(wrappedTracks.data.data) ? wrappedTracks.data.data : wrappedTracks.data.data.items
}

type ViewState = { view: TrackView; area: ViewArea; watchlistIds: Set<string> | null; sent: Map<number, TrackFeature> | null }

const TRACK_EXPIRY_MS = 30000
const VIEW_UPDATE_MS = 250
const MAX_FRAMES_IN_FLIGHT = 3
const STATUS_INDEX = new Map(TRACK_STATUSES.map((status, index) => [status, index]))

const tracks = new Map<number, LiveTrack>()
const alerts: TrackAlerts = new Map()
const views = new Map<number, ViewState>()
const store = createTrackStore()
const framePool: ArrayBuffer[] = []
let colors: Record<TrackStatus, string> = { NORMAL: '', WARNING: '', CRITICAL: '', LOST_LINK: '', PROCESSING: '', LOST_CONTROL: '' }
let epochMs = performance.timeOrigin
let hoveredId: number | null = null
let framesInFlight = 0
let isFrameDirty = false
let lastFlushAt = 0
let flushTimer: ReturnType<typeof setTimeout> | null = null

function post(message: LiveTracksWorkerResponse, transfer: Transferable[] = []) {
  globalThis.postMessage(message, { transfer })
}

function getClockSeconds(): number {
  return (performance.timeOrigin + performance.now() - epochMs) / 1000
}

function getWebGlView(): ViewState | undefined {
  for (const state of views.values()) if (state.view.renderer === 'webgl') return state
  return undefined
}

function resolveTrackId(id: number | null): number | null {
  if (id === null || tracks.has(id)) return id
  // README: Panels select alerts by track_id, which can be a TrackNumber.
  for (const entry of tracks.values()) if (entry.track.TrackNumber === id) return entry.track.ID
  return id
}

function putTrack(track: Track, receivedAt: number, now: number) {
  tracks.set(track.ID, { track, receivedAt })
  const [x, y] = lonLatToMercator(track.Longitude, track.Latitude)
  store.put(track.ID, x, y, (track.Heading * Math.PI) / 180, now)
}

function ingestTracks(updates: readonly Track[], receivedAt: number) {
  const now = getClockSeconds()
  for (const track of updates) {
    const current = tracks.get(track.ID)
    // README: Receipt keeps a track alive, but an older measurement must not rewind its position.
    if (current && track.UpdatedAt < current.track.UpdatedAt) {
      current.receivedAt = receivedAt
      continue
    }
    putTrack(track, receivedAt, now)
  }
}

function expireTracks(now: number) {
  for (const [id, entry] of tracks) {
    if (now - entry.receivedAt < TRACK_EXPIRY_MS) continue
    tracks.delete(id)
    store.remove(id)
    alerts.delete(id)
    alerts.delete(entry.track.TrackNumber)
  }
}

function buildViewUpdate(viewId: number, state: ViewState, now: number): TrackViewUpdate | null {
  const { view } = state
  const isWebGl = view.renderer === 'webgl'
  const visible: TrackFeature[] = []
  const statusById = new Map<number, TrackStatus>()
  let hasAlertInView = false
  for (const entry of tracks.values()) {
    const { track } = entry
    const isListed = isInWatchlist(track, state.watchlistIds)
    const status = getTrackStatus(entry, alerts, now)
    statusById.set(track.ID, status)
    if (!isListed) continue
    if (track.ID !== view.selectedId && !isInViewArea(state.area, track.Longitude, track.Latitude)) continue
    if (status === 'WARNING' || status === 'CRITICAL') hasAlertInView = true
    visible.push(toTrackFeature(track, status, colors))
  }

  const clustered = view.zoom <= TRACK_CLUSTER_MAX_ZOOM ? clusterTrackFeatures(visible, view.zoom) : null
  if (isWebGl) {
    const visibleIds = new Set(visible.map(feature => feature.properties.id))
    for (const [id, status] of statusById) {
      const isHidden = !visibleIds.has(id) || (clustered?.clusteredIds.has(id) ?? false)
      if (store.setStyle(id, (STATUS_INDEX.get(status) ?? 0) + (isHidden ? TRACK_STYLE_HIDDEN : 0))) isFrameDirty = true
    }
  }

  if (clustered) {
    // README: Cluster output is bounded by the screen (one feature per 80 px cell), so replace the source.
    state.sent = null
    return { type: 'VIEW_UPDATE', viewId, data: { type: 'FeatureCollection', features: clustered.features }, diff: null, hasAlertInView }
  }
  if (!state.sent) {
    state.sent = new Map(visible.map(feature => [feature.properties.id, feature]))
    return { type: 'VIEW_UPDATE', viewId, data: { type: 'FeatureCollection', features: visible }, diff: null, hasAlertInView }
  }
  const diff = diffTrackFeatures(state.sent, visible)
  return isEmptyDiff(diff) ? null : { type: 'VIEW_UPDATE', viewId, data: null, diff, hasAlertInView }
}

function flushViews() {
  if (flushTimer !== null) clearTimeout(flushTimer)
  flushTimer = null
  lastFlushAt = performance.now()
  const now = Date.now()
  for (const [viewId, state] of views) {
    const update = buildViewUpdate(viewId, state, now)
    if (update) post(update)
  }
}

function isSelectedInAnyView(id: number): boolean {
  for (const state of views.values()) if (state.view.selectedId === id) return true
  return false
}

function scheduleFlush() {
  if (flushTimer !== null) return
  // README: setTimeout coalesces socket batches, so each view gets at most four updates per second.
  flushTimer = setTimeout(flushViews, Math.max(0, VIEW_UPDATE_MS - (performance.now() - lastFlushAt)))
}

function postFrame() {
  if (framesInFlight >= MAX_FRAMES_IN_FLIGHT) {
    isFrameDirty = true
    return
  }
  const floats = store.count * TRACK_INSTANCE_STRIDE
  const poolIndex = framePool.findIndex(buffer => buffer.byteLength >= floats * 4)
  const buffer = (poolIndex >= 0 ? framePool.splice(poolIndex, 1)[0] : undefined) ?? new ArrayBuffer(Math.max(4096, Math.ceil((floats * 4 * 1.25) / 4096) * 4096))
  new Float32Array(buffer, 0, floats).set(store.instances.subarray(0, floats))
  framesInFlight++
  isFrameDirty = false
  const selectedId = getWebGlView()?.view.selectedId ?? null
  post(
    {
      type: 'FRAME',
      buffer,
      count: store.count,
      origin: store.origin,
      glideSeconds: store.glideSeconds,
      selected: selectedId === null ? null : store.instanceOf(selectedId),
      hovered: hoveredId === null || hoveredId === selectedId ? null : store.instanceOf(hoveredId),
    },
    [buffer],
  )
}

function runFrameLoop() {
  const committed = store.commit(getClockSeconds())
  if ((committed > 0 || isFrameDirty) && getWebGlView()) postFrame()
  // README: setTimeout paces frames by upload size: every 33 ms for small fleets, slower for huge ones (50 MB/s budget). The shader animates between frames.
  setTimeout(runFrameLoop, Math.min(1000, Math.max(33, (store.count * TRACK_INSTANCE_STRIDE * 4) / 50_000)))
}

function answerQuery(requestId: number, query: Extract<LiveTracksWorkerRequest, { type: 'QUERY' }>['query']) {
  const now = getClockSeconds()
  const pickedId = query.kind === 'pick' ? store.pick(query.mercator[0], query.mercator[1], query.radius, now) : null
  const ids = query.kind === 'pick' ? (pickedId === null ? [] : [pickedId]) : store.pickInPolygon(query.polygon, now)
  const found: TrackFeatureProperties[] = []
  for (const id of ids) {
    const entry = tracks.get(id)
    if (entry) found.push(toTrackFeature(entry.track, getTrackStatus(entry, alerts, Date.now()), colors).properties)
  }
  post({ type: 'REPLY', requestId, tracks: found })
}

function setView(viewId: number, view: TrackView | null, shouldReset: boolean) {
  if (!view) {
    views.delete(viewId)
    return
  }
  const previous = views.get(viewId)
  const area = toViewArea(view)
  views.set(viewId, {
    view: { ...view, selectedId: resolveTrackId(view.selectedId) },
    area,
    watchlistIds: view.watchlistIds ? new Set(view.watchlistIds) : null,
    sent: shouldReset ? null : (previous?.sent ?? null),
  })
  if (view.renderer === 'webgl') {
    // README: Re-base float32 instance positions when the view moves far, so icons keep sub-pixel precision.
    const centerX = area.polygon.reduce((sum, [x]) => sum + x, 0) / area.polygon.length
    const centerY = area.polygon.reduce((sum, [, y]) => sum + y, 0) / area.polygon.length
    const [originX, originY] = store.origin
    if (Math.abs(centerX - originX) > 0.01 || Math.abs(centerY - originY) > 0.01) store.setOrigin(centerX, centerY)
    isFrameDirty = true
  }
  scheduleFlush()
}

function applyAlerts(message: Extract<LiveTracksWorkerRequest, { type: 'ALERTS' }>) {
  for (const { trackId, type, level } of message.add) {
    const levels = alerts.get(trackId) ?? new Map<string, TrackStatus>()
    levels.set(type, level)
    alerts.set(trackId, levels)
  }
  for (const { trackId, type } of message.remove) {
    if (type === 'ALL') {
      alerts.delete(trackId)
      continue
    }
    const levels = alerts.get(trackId)
    levels?.delete(type)
    if (levels?.size === 0) alerts.delete(trackId)
  }
  scheduleFlush()
}

globalThis.onmessage = (event: MessageEvent<LiveTracksWorkerRequest>) => {
  const message = event.data
  switch (message.type) {
    case 'INIT': {
      epochMs = message.epochMs
      runFrameLoop()
      setInterval(() => {
        expireTracks(Date.now())
        const interval = store.takeUpdateInterval()
        if (interval > 0) store.setGlideSeconds(interval * 1.15)
        // README: Status changes (LOST_LINK) also happen without new batches.
        flushViews()
      }, 1000)
      break
    }
    case 'COLORS': {
      colors = message.colors
      scheduleFlush()
      break
    }
    case 'BATCH': {
      const [parseError, updates] = catchErrorSync(() => parseLiveTracksMessage(JSON.parse(message.data)))
      if (parseError || !updates || updates.length === 0) return
      ingestTracks(updates, Date.now())
      post({ type: 'TRACKS_READY', data: updates })
      // README: A selected track is redrawn as soon as it reports, like the old immediate selected-icon update.
      if (updates.some(track => isSelectedInAnyView(track.ID))) flushViews()
      else scheduleFlush()
      break
    }
    case 'SNAPSHOT': {
      const receivedAt = Date.now()
      const now = getClockSeconds()
      // README: Socket batches can arrive before the API; keep their positions.
      for (const track of message.tracks) if (!tracks.has(track.ID)) putTrack(track, receivedAt, now)
      scheduleFlush()
      break
    }
    case 'VIEW': {
      setView(message.viewId, message.view, message.shouldReset)
      break
    }
    case 'ALERTS': {
      applyAlerts(message)
      break
    }
    case 'HOVER': {
      hoveredId = message.trackId
      isFrameDirty = true
      break
    }
    case 'QUERY': {
      answerQuery(message.requestId, message.query)
      break
    }
    case 'RELEASE': {
      framesInFlight = Math.max(0, framesInFlight - 1)
      if (framePool.length < MAX_FRAMES_IN_FLIGHT) framePool.push(message.buffer)
      break
    }
  }
}
