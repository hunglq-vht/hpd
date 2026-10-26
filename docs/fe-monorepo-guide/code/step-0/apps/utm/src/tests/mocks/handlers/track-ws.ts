import { utmServicePath } from '@platform/utm/config/services'
import type { Track } from '@platform/utm/shared/wire/track-wire'
import { mockTracks, toTrack } from '@platform/utm/tests/mocks/data-generator'
import { ws } from 'msw/ws'

type TrackWsOptions = { trackCount: number; batchesPerSecond: number }
type FleetBounds = { lngMin: number; lngMax: number; latMin: number; latMax: number }

const FLEET_CENTER = [105.82, 21.22] as const
// README: 30 tracks fill 0.06 degrees; larger fleets grow the square so density stays the same.
const DEFAULT_SIDE_DEGREES = 0.06
const tracksLink = ws.link(utmServicePath('track-manager', '/ws/tracks'))
const isE2eRuntime = import.meta.env?.MODE === 'e2e'

function getFleetBounds(trackCount: number): FleetBounds {
  const half = (DEFAULT_SIDE_DEGREES * Math.sqrt(Math.max(1, trackCount / mockTracks.length))) / 2
  return { lngMin: FLEET_CENTER[0] - half, lngMax: FLEET_CENTER[0] + half, latMin: FLEET_CENTER[1] - half, latMax: FLEET_CENTER[1] + half }
}

function createFleet(trackCount: number, bounds: FleetBounds): Track[] {
  return Array.from({ length: trackCount }, (_, index) => {
    const template = mockTracks[index % mockTracks.length]
    const track = template ? toTrack(template) : undefined
    if (index < mockTracks.length && track) return track
    // README: Golden-ratio steps give a deterministic, even spread, so every run sees the same fleet.
    const longitude = bounds.lngMin + ((index * 0.618033988749895) % 1) * (bounds.lngMax - bounds.lngMin)
    const latitude = bounds.latMin + ((index * 0.754877666246693) % 1) * (bounds.latMax - bounds.latMin)
    const id = 1001 + index
    return {
      ID: id,
      TrackNumber: id,
      Longitude: longitude,
      Latitude: latitude,
      Altitude: track?.Altitude ?? 100,
      AircraftType: track?.AircraftType ?? 1,
      Identification: id,
      Heading: (index * 37) % 360,
      Velocity: 6 + (index % 12),
      Serial: `DRN-${id}`,
      CreatedAt: track?.CreatedAt ?? Date.now(),
      UpdatedAt: Date.now(),
      ListSources: track?.ListSources ?? [],
      Mode3a: `MOCK-${id}`,
    }
  })
}

function advanceTrack(track: Track, bounds: FleetBounds): Track {
  const headingRad = (track.Heading * Math.PI) / 180
  const step = (track.Velocity / 10) * 0.00015
  return {
    ...track,
    Longitude: Math.max(bounds.lngMin, Math.min(bounds.lngMax, track.Longitude + step * Math.cos(headingRad))),
    Latitude: Math.max(bounds.latMin, Math.min(bounds.latMax, track.Latitude + step * Math.sin(headingRad))),
    Heading: (track.Heading + (Math.random() - 0.5) * 4 + 360) % 360,
    UpdatedAt: Date.now(),
  }
}

/** README: Sends the whole fleet on connect, then `batchesPerSecond` partial batches per second that together cover the fleet once per second, like the real feed. */
export function createTrackWsHandler({ trackCount, batchesPerSecond }: TrackWsOptions) {
  const bounds = getFleetBounds(trackCount)
  const fleet = createFleet(trackCount, bounds)
  const batchSize = Math.ceil(fleet.length / batchesPerSecond)

  return tracksLink.addEventListener('connection', ({ client }) => {
    let batchIndex = 0
    const sendBatch = () => {
      const start = batchIndex * batchSize
      const batch: Track[] = []
      for (let index = start; index < Math.min(start + batchSize, fleet.length); index++) {
        const current = fleet[index]
        if (!current) continue
        const next = advanceTrack(current, bounds)
        fleet[index] = next
        batch.push(next)
      }
      if (batch.length > 0) client.send(JSON.stringify(batch))
      batchIndex = (batchIndex + 1) % batchesPerSecond
    }

    client.send(JSON.stringify(fleet))
    const interval = isE2eRuntime ? undefined : setInterval(sendBatch, 1000 / batchesPerSecond)

    client.addEventListener('close', () => {
      if (interval) clearInterval(interval)
    })
  })
}

export const trackWsHandler = [createTrackWsHandler({ trackCount: 30, batchesPerSecond: 1 })]
