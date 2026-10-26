import type { TrackClusterProperties } from '@platform/utm/shared/domain/replay-monitor/live-tracks.types'

import { lonLatToMercator } from './track-view'
import type { TrackFeature } from './track-view'

export type TrackClusterFeature = GeoJSON.Feature<GeoJSON.Point, TrackClusterProperties>
type ClusterCell = { count: number; sumX: number; sumY: number; members: TrackFeature[] }

// README: Same values as the old supercluster source (clusterMaxZoom 16, clusterRadius 80).
export const TRACK_CLUSTER_MAX_ZOOM = 16
const CLUSTER_CELL_PX = 80

export function abbreviateCount(count: number): string {
  if (count >= 10000) return `${Math.round(count / 1000)}k`
  if (count >= 1000) return `${Math.round(count / 100) / 10}k`
  return String(count)
}

function mercatorToLonLat(x: number, y: number): [number, number] {
  return [x * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI]
}

/** README: Groups tracks into grid cells 80 px wide at the integer zoom. A cell with one track stays a track feature, like a supercluster leaf. */
export function clusterTrackFeatures(features: readonly TrackFeature[], zoom: number): { features: Array<TrackFeature | TrackClusterFeature>; clusteredIds: Set<number> } {
  const cellSize = CLUSTER_CELL_PX / (512 * 2 ** Math.floor(zoom))
  const cells = new Map<number, ClusterCell>()
  for (const feature of features) {
    const [longitude, latitude] = feature.geometry.coordinates
    if (longitude === undefined || latitude === undefined) continue
    const [x, y] = lonLatToMercator(longitude, latitude)
    const key = Math.floor(x / cellSize) * 2 ** 21 + Math.floor(y / cellSize)
    const cell = cells.get(key)
    if (cell) {
      cell.count++
      cell.sumX += x
      cell.sumY += y
      cell.members.push(feature)
    } else {
      cells.set(key, { count: 1, sumX: x, sumY: y, members: [feature] })
    }
  }

  const output: Array<TrackFeature | TrackClusterFeature> = []
  const clusteredIds = new Set<number>()
  for (const [key, cell] of cells) {
    const [single] = cell.members
    if (cell.count === 1 && single) {
      output.push(single)
      continue
    }
    for (const member of cell.members) clusteredIds.add(member.properties.id)
    // README: Negative IDs never collide with track IDs in the promoted `id` property.
    const id = -1 - key
    output.push({
      type: 'Feature',
      id,
      geometry: { type: 'Point', coordinates: mercatorToLonLat(cell.sumX / cell.count, cell.sumY / cell.count) },
      properties: { id, cluster: true, point_count: cell.count, point_count_abbreviated: abbreviateCount(cell.count) },
    })
  }
  return { features: output, clusteredIds }
}
