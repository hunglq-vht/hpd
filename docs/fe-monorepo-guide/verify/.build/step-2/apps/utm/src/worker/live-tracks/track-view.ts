import type { TrackFeatureProperties, TrackView } from '@platform/utm/shared/domain/replay-monitor/live-tracks.types'
import type { TrackStatus } from '@platform/utm/shared/domain/replay-monitor/status-colors'
import type { Track } from '@platform/utm/shared/wire/track-wire'
import type { GeoJSONFeatureDiff, GeoJSONSourceDiff } from 'maplibre-gl'

export type LiveTrack = { track: Track; receivedAt: number }
export type TrackAlerts = Map<number, Map<string, TrackStatus>>
export type TrackFeature = GeoJSON.Feature<GeoJSON.Point, TrackFeatureProperties>
export type ViewArea = { polygon: [number, number][]; centerLongitude: number }

// QUESTION: LOST_LINK rule is not decided (receipt time vs UpdatedAt, and the delay). 5 s matches the old LOST_LINK_THRESHOLD.
const LOST_LINK_MS = 5000
const ALERT_PRIORITY: readonly TrackStatus[] = ['CRITICAL', 'WARNING', 'LOST_CONTROL', 'PROCESSING']
const ALERT_STATUSES = new Set<TrackStatus>(ALERT_PRIORITY)
const DIFF_PROPERTY_KEYS = ['track_number', 'status', 'color', 'heading', 'velocity', 'alert', 'alert_level', 'mode3a'] as const

export function lonLatToMercator(longitude: number, latitude: number): [number, number] {
  const sin = Math.sin((latitude * Math.PI) / 180)
  return [(longitude + 180) / 360, 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)]
}

export function getTrackStatus(entry: LiveTrack, alerts: TrackAlerts, now: number): TrackStatus {
  if (now - entry.receivedAt > LOST_LINK_MS) return 'LOST_LINK'
  // README: Alert events carry track_number || track_id, so look up both keys.
  const levels = alerts.get(entry.track.TrackNumber) ?? alerts.get(entry.track.ID)
  if (!levels) return 'NORMAL'
  const values = new Set(levels.values())
  return ALERT_PRIORITY.find(level => values.has(level)) ?? 'NORMAL'
}

export function toViewArea(view: TrackView): ViewArea {
  const centerLongitude = view.corners.reduce((sum, [longitude]) => sum + longitude, 0) / view.corners.length
  return { centerLongitude, polygon: view.corners.map(([longitude, latitude]) => lonLatToMercator(longitude, latitude)) }
}

export function isInConvexPolygon(polygon: readonly [number, number][], x: number, y: number): boolean {
  let side = 0
  for (const [index, [ax, ay]] of polygon.entries()) {
    const [bx, by] = polygon[(index + 1) % polygon.length] ?? [ax, ay]
    const cross = Math.sign((bx - ax) * (y - ay) - (by - ay) * (x - ax))
    if (cross === 0) continue
    if (side === 0) side = cross
    if (cross !== side) return false
  }
  return true
}

export function isInViewArea(area: ViewArea, longitude: number, latitude: number): boolean {
  // README: Move the track to the world copy nearest the view centre before the test.
  const wrappedLongitude = longitude + 360 * Math.round((area.centerLongitude - longitude) / 360)
  const [x, y] = lonLatToMercator(wrappedLongitude, latitude)
  return isInConvexPolygon(area.polygon, x, y)
}

export function isInWatchlist(track: Track, watchlistIds: ReadonlySet<string> | null): boolean {
  if (!watchlistIds) return true
  return watchlistIds.has(String(track.ID)) || watchlistIds.has(String(track.TrackNumber)) || (track.Mode3a !== '' && watchlistIds.has(track.Mode3a))
}

export function toTrackFeature(track: Track, status: TrackStatus, colors: Record<TrackStatus, string>): TrackFeature {
  const label = track.Mode3a || '-'
  return {
    type: 'Feature',
    id: track.ID,
    geometry: { type: 'Point', coordinates: [track.Longitude, track.Latitude] },
    properties: {
      id: track.ID,
      track_id: track.ID,
      track_number: track.TrackNumber,
      status,
      color: colors[status],
      heading: track.Heading,
      velocity: track.Velocity,
      alert: ALERT_STATUSES.has(status),
      alert_level: status === 'NORMAL' ? null : status,
      mode3a: label.length > 24 ? label.slice(-15) : label,
    },
  }
}

/** README: Builds the MapLibre diff from the features last sent to this view, and updates `sent` to the new features. */
export function diffTrackFeatures(sent: Map<number, TrackFeature>, next: readonly TrackFeature[]): GeoJSONSourceDiff {
  const add: TrackFeature[] = []
  const update: GeoJSONFeatureDiff[] = []
  const nextIds = new Set<number>()
  for (const feature of next) {
    const id = feature.properties.id
    nextIds.add(id)
    const previous = sent.get(id)
    sent.set(id, feature)
    if (!previous) {
      add.push(feature)
      continue
    }
    const [longitude, latitude] = feature.geometry.coordinates
    const [previousLongitude, previousLatitude] = previous.geometry.coordinates
    const change: GeoJSONFeatureDiff = { id }
    if (longitude !== previousLongitude || latitude !== previousLatitude) change.newGeometry = feature.geometry
    for (const key of DIFF_PROPERTY_KEYS) {
      if (feature.properties[key] === previous.properties[key]) continue
      change.addOrUpdateProperties ??= []
      change.addOrUpdateProperties.push({ key, value: feature.properties[key] })
    }
    if (change.newGeometry || change.addOrUpdateProperties) update.push(change)
  }
  const remove: number[] = []
  for (const id of sent.keys()) {
    if (nextIds.has(id)) continue
    remove.push(id)
    sent.delete(id)
  }
  return { add, remove, update }
}

export function isEmptyDiff(diff: GeoJSONSourceDiff): boolean {
  return !diff.add?.length && !diff.remove?.length && !diff.update?.length
}
