import { MercatorCoordinate } from 'maplibre-gl'
import type { Map as MapLibreMap, PointLike } from 'maplibre-gl'

import { queryLiveTracks } from './live-tracks-channel'
import type { TrackFeatureProperties } from './live-tracks.types'

// README: Icons are drawn from zoom 11, like the old track-layer-1 symbol layer. Picks use about the icon's radius.
const ICON_MIN_ZOOM = 11
const PICK_RADIUS_PX = 16

function toMercator(mapTarget: MapLibreMap, point: PointLike): [number, number] {
  const { x, y } = MercatorCoordinate.fromLngLat(mapTarget.unproject(point))
  return [x, y]
}

export async function pickLiveTrackAt(mapTarget: MapLibreMap, point: PointLike): Promise<TrackFeatureProperties | undefined> {
  const zoom = mapTarget.getZoom()
  if (zoom < ICON_MIN_ZOOM) return undefined
  const [track] = await queryLiveTracks({ kind: 'pick', mercator: toMercator(mapTarget, point), radius: PICK_RADIUS_PX / (512 * 2 ** zoom) })
  return track
}

export async function pickLiveTracksInBox(mapTarget: MapLibreMap, start: [number, number], end: [number, number]): Promise<TrackFeatureProperties[]> {
  if (mapTarget.getZoom() < ICON_MIN_ZOOM) return []
  const [minX, maxX] = [Math.min(start[0], end[0]), Math.max(start[0], end[0])]
  const [minY, maxY] = [Math.min(start[1], end[1]), Math.max(start[1], end[1])]
  // README: The unprojected box is a trapezoid when the map is pitched; the worker tests it as a convex polygon.
  const polygon = [
    toMercator(mapTarget, [minX, minY]),
    toMercator(mapTarget, [maxX, minY]),
    toMercator(mapTarget, [maxX, maxY]),
    toMercator(mapTarget, [minX, maxY]),
  ]
  return queryLiveTracks({ kind: 'box', polygon })
}
