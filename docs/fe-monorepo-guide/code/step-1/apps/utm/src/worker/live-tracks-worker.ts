import { catchErrorSync } from '@platform/lib/shared/error/handle-error'
import type { LiveTracksWorkerRequest, LiveTracksWorkerResponse, TrackView, TrackViewUpdate } from '@platform/utm/shared/domain/replay-monitor/live-tracks.types'
import type { TrackStatus } from '@platform/utm/shared/domain/replay-monitor/status-colors'
import type { Track } from '@platform/utm/shared/wire/track-wire'
import { z } from 'zod'

import { diffTrackFeatures, getTrackStatus, isEmptyDiff, isInViewArea, isInWatchlist, toTrackFeature, toViewArea } from './live-tracks/track-view'
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

const tracks = new Map<number, LiveTrack>()
const alerts: TrackAlerts = new Map()
const views = new Map<number, ViewState>()
let colors: Record<TrackStatus, string> = { NORMAL: '', WARNING: '', CRITICAL: '', LOST_LINK: '', PROCESSING: '', LOST_CONTROL: '' }
let lastFlushAt = 0
let flushTimer: ReturnType<typeof setTimeout> | null = null

function post(message: LiveTracksWorkerResponse) {
  globalThis.postMessage(message)
}

function resolveTrackId(id: number | null): number | null {
  if (id === null || tracks.has(id)) return id
  // README: Panels select alerts by track_id, which can be a TrackNumber.
  for (const entry of tracks.values()) if (entry.track.TrackNumber === id) return entry.track.ID
  return id
}

function ingestTracks(updates: readonly Track[], receivedAt: number) {
  for (const track of updates) {
    const current = tracks.get(track.ID)
    // README: Receipt keeps a track alive, but an older measurement must not rewind its position.
    if (current && track.UpdatedAt < current.track.UpdatedAt) {
      current.receivedAt = receivedAt
      continue
    }
    tracks.set(track.ID, { track, receivedAt })
  }
}

function expireTracks(now: number) {
  for (const [id, entry] of tracks) {
    if (now - entry.receivedAt < TRACK_EXPIRY_MS) continue
    tracks.delete(id)
    alerts.delete(id)
    alerts.delete(entry.track.TrackNumber)
  }
}

function buildViewUpdate(viewId: number, state: ViewState, now: number): TrackViewUpdate | null {
  const { view } = state
  const visible: TrackFeature[] = []
  let hasAlertInView = false
  for (const entry of tracks.values()) {
    const { track } = entry
    if (!isInWatchlist(track, state.watchlistIds)) continue
    if (track.ID !== view.selectedId && !isInViewArea(state.area, track.Longitude, track.Latitude)) continue
    const status = getTrackStatus(entry, alerts, now)
    if (status === 'WARNING' || status === 'CRITICAL') hasAlertInView = true
    visible.push(toTrackFeature(track, status, colors))
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

function setView(viewId: number, view: TrackView | null, shouldReset: boolean) {
  if (!view) {
    views.delete(viewId)
    return
  }
  const previous = views.get(viewId)
  views.set(viewId, {
    view: { ...view, selectedId: resolveTrackId(view.selectedId) },
    area: toViewArea(view),
    watchlistIds: view.watchlistIds ? new Set(view.watchlistIds) : null,
    sent: shouldReset ? null : (previous?.sent ?? null),
  })
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
      setInterval(() => {
        expireTracks(Date.now())
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
      // README: Socket batches can arrive before the API; keep their positions.
      for (const track of message.tracks) if (!tracks.has(track.ID)) tracks.set(track.ID, { track, receivedAt })
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
  }
}
