import type { Track } from '@platform/utm/shared/wire/track-wire'
import { describe, expect, it } from 'vite-plus/test'

import { abbreviateCount, clusterTrackFeatures } from './track-clusters'
import { toTrackFeature } from './track-view'

const colors = { NORMAL: 'normal', WARNING: 'warning', CRITICAL: 'critical', LOST_LINK: 'lost-link', PROCESSING: 'processing', LOST_CONTROL: 'lost-control' }

function makeTrack(id: number, longitude: number, latitude: number): Track {
  return { ID: id, TrackNumber: id + 100, Longitude: longitude, Latitude: latitude, Altitude: 100, AircraftType: 1, Identification: 1, Heading: 90, Velocity: 10, Serial: '', CreatedAt: 0, UpdatedAt: 0, ListSources: [], Mode3a: `UAV-${id}` }
}

describe('live track clusters', () => {
  it('keeps a lone track as a track and groups nearby tracks into one cluster', () => {
    expect.hasAssertions()

    const features = [makeTrack(1, 105, 21), makeTrack(2, 105.00001, 21), makeTrack(3, 106, 21)].map(track => toTrackFeature(track, 'NORMAL', colors))
    const result = clusterTrackFeatures(features, 10)
    const cluster = result.features.find(feature => 'cluster' in feature.properties)
    const single = result.features.find(feature => !('cluster' in feature.properties))

    expect(result.features).toHaveLength(2)
    expect([...result.clusteredIds].sort()).toEqual([1, 2])
    expect(cluster?.properties).toMatchObject({ cluster: true, point_count: 2, point_count_abbreviated: '2' })
    expect(cluster?.properties.id).toBeLessThan(0)
    expect(single?.properties.id).toBe(3)
  })

  it('abbreviates counts like supercluster', () => {
    expect.hasAssertions()

    expect(abbreviateCount(999)).toBe('999')
    expect(abbreviateCount(1234)).toBe('1.2k')
    expect(abbreviateCount(15000)).toBe('15k')
  })
})
