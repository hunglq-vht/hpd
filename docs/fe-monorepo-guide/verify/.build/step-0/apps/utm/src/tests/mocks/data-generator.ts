// Stub of apps/utm/src/tests/mocks/data-generator.ts (two tracks are enough for type checks).
import type { Track } from '@platform/utm/shared/wire/track-wire'

type TrackWithMeta = Track & { categoryId: string }

export const mockTracks: TrackWithMeta[] = [1001, 1002].map(id => ({ ID: id, TrackNumber: id, Longitude: 105.8, Latitude: 21.2, Altitude: 100, AircraftType: 1, Identification: id, Heading: 0, Velocity: 6, Serial: `DRN-${id}`, CreatedAt: 0, UpdatedAt: 0, ListSources: [], Mode3a: '89-K-2035249-TN', categoryId: 'uav' }))

export function toTrack({ categoryId: _categoryId, ...track }: TrackWithMeta): Track {
  return track
}
