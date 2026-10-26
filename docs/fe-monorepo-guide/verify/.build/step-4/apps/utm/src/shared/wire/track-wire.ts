// Stub of fe-monorepo dev apps/utm/src/shared/wire/track-wire.ts (Track output type only).
export type TrackSource = { SourceName: string; TrackNumber: string }
export type Track = {
  ID: number
  TrackNumber: number
  Longitude: number
  Latitude: number
  Altitude: number
  AircraftType: number
  Identification: number
  Heading: number
  Velocity: number
  Serial: string
  CreatedAt: number
  UpdatedAt: number
  ListSources: TrackSource[]
  Mode3a: string
}
