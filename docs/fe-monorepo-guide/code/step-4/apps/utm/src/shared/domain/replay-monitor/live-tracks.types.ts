import type { TrackStatus } from '@platform/utm/shared/domain/replay-monitor/status-colors'
import type { Track } from '@platform/utm/shared/wire/track-wire'
import type { GeoJSONSourceDiff } from 'maplibre-gl'

export type TrackRenderer = 'geojson' | 'webgl'

export type TrackView = {
  /** README: Padded viewport corners as [longitude, latitude], in screen order top-left, top-right, bottom-right, bottom-left. A pitched view is a trapezoid. */
  corners: [number, number][]
  zoom: number
  selectedId: number | null
  watchlistIds: string[] | null
  renderer: TrackRenderer
}

export type TrackAlert = { trackId: number; type: string; level: TrackStatus }
export type TrackAlertRemoval = { trackId: number; type: string }

export type TrackFeatureProperties = {
  id: number
  track_id: number
  track_number: number
  status: TrackStatus
  color: string
  heading: number
  velocity: number
  alert: boolean
  alert_level: TrackStatus | null
  mode3a: string
}

export type TrackClusterProperties = {
  id: number
  cluster: true
  point_count: number
  point_count_abbreviated: string
}

export type TrackFeatureCollection = GeoJSON.FeatureCollection<GeoJSON.Point, TrackFeatureProperties | TrackClusterProperties>

export type TrackQuery = { kind: 'pick'; mercator: [number, number]; radius: number } | { kind: 'box'; polygon: [number, number][] }

export type LiveTracksWorkerRequest =
  | { type: 'INIT'; epochMs: number }
  | { type: 'COLORS'; colors: Record<TrackStatus, string> }
  | { type: 'BATCH'; data: string }
  | { type: 'SNAPSHOT'; tracks: Track[] }
  | { type: 'VIEW'; viewId: number; view: TrackView | null; shouldReset: boolean }
  | { type: 'ALERTS'; add: TrackAlert[]; remove: TrackAlertRemoval[] }
  | { type: 'HOVER'; trackId: number | null }
  | { type: 'QUERY'; requestId: number; query: TrackQuery }
  | { type: 'RELEASE'; buffer: ArrayBuffer }

export type TrackViewUpdate = {
  type: 'VIEW_UPDATE'
  viewId: number
  /** README: Full data replaces the source; a diff updates it. Exactly one is set. */
  data: TrackFeatureCollection | null
  diff: GeoJSONSourceDiff | null
  hasAlertInView: boolean
}

export type TrackFrame = {
  type: 'FRAME'
  buffer: ArrayBuffer
  count: number
  origin: [number, number]
  glideSeconds: number
  selected: Float32Array | null
  hovered: Float32Array | null
}

export type LiveTracksWorkerResponse =
  | { type: 'TRACKS_READY'; data: Track[] }
  | TrackViewUpdate
  | TrackFrame
  | { type: 'REPLY'; requestId: number; tracks: TrackFeatureProperties[] }
