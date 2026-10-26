import type { TrackView } from '@platform/utm/shared/domain/replay-monitor/live-tracks.types'
import type { Track } from '@platform/utm/shared/wire/track-wire'
import { describe, expect, it } from 'vite-plus/test'

import { diffTrackFeatures, getTrackStatus, isInViewArea, lonLatToMercator, toTrackFeature, toViewArea } from './track-view'
import type { TrackAlerts, TrackFeature } from './track-view'

const colors = { NORMAL: 'normal', WARNING: 'warning', CRITICAL: 'critical', LOST_LINK: 'lost-link', PROCESSING: 'processing', LOST_CONTROL: 'lost-control' }

function makeTrack(id: number, longitude: number, latitude: number): Track {
  return { ID: id, TrackNumber: id + 100, Longitude: longitude, Latitude: latitude, Altitude: 100, AircraftType: 1, Identification: 1, Heading: 90, Velocity: 10, Serial: '', CreatedAt: 0, UpdatedAt: 0, ListSources: [], Mode3a: `UAV-${id}` }
}

describe('live track view', () => {
  it('projects longitude and latitude to web mercator', () => {
    expect.hasAssertions()

    expect(lonLatToMercator(0, 0)[0]).toBe(0.5)
    expect(lonLatToMercator(0, 0)[1]).toBeCloseTo(0.5, 12)
    expect(lonLatToMercator(0, 85.0511287798)[1]).toBeCloseTo(0, 6)
  })

  it('marks a track silent for more than 5 s as LOST_LINK and finds alerts by TrackNumber', () => {
    expect.hasAssertions()

    const alerts: TrackAlerts = new Map([
      [
        101,
        new Map([
          ['intrusion', 'WARNING'],
          ['collision', 'CRITICAL'],
        ]),
      ],
    ])
    const entry = { track: makeTrack(1, 105, 21), receivedAt: 1000 }

    expect(getTrackStatus(entry, alerts, 2000)).toBe('CRITICAL')
    expect(getTrackStatus(entry, alerts, 7000)).toBe('LOST_LINK')
    expect(getTrackStatus({ track: makeTrack(2, 105, 21), receivedAt: 1000 }, alerts, 2000)).toBe('NORMAL')
  })

  it('culls with the view polygon, also for a pitched trapezoid and another world copy', () => {
    expect.hasAssertions()

    const view: TrackView = {
      corners: [
        [105, 22],
        [107, 22],
        [108, 20],
        [104, 20],
      ],
      zoom: 12,
      selectedId: null,
      watchlistIds: null,
      renderer: 'geojson',
    }
    const area = toViewArea(view)

    expect(isInViewArea(area, 106, 21)).toBe(true)
    expect(isInViewArea(area, 104.6, 21.8)).toBe(false)
    expect(isInViewArea(area, 104.6, 20.2)).toBe(true)
    expect(isInViewArea(area, 106 + 360, 21)).toBe(true)
  })

  it('sends added features, then only changed fields, then removals', () => {
    expect.hasAssertions()

    const sent = new Map<number, TrackFeature>()
    const first = diffTrackFeatures(sent, [toTrackFeature(makeTrack(1, 105, 21), 'NORMAL', colors), toTrackFeature(makeTrack(2, 105, 21), 'NORMAL', colors)])
    const moved = makeTrack(1, 105.1, 21)
    const second = diffTrackFeatures(sent, [toTrackFeature(moved, 'WARNING', colors)])
    const third = diffTrackFeatures(sent, [toTrackFeature(moved, 'WARNING', colors)])

    expect(first.add).toHaveLength(2)
    expect(second.remove).toEqual([2])
    expect(second.update?.[0]?.newGeometry).toEqual({ type: 'Point', coordinates: [105.1, 21] })
    expect(second.update?.[0]?.addOrUpdateProperties?.map(change => change.key).sort()).toEqual(['alert', 'alert_level', 'color', 'status'])
    expect(third.update).toHaveLength(0)
  })
})
