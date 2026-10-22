// Tiling agreement shared with the Go backend (backend/internal/tiles, docs/PROTOCOL.md).

export const TOPIC_ZOOM = 13;
export const STATS_MAX_LEVEL = 15;
export const STATS_LEVEL_OFFSET = 3;
export const REALTIME_MIN_ZOOM = 13;
export const MAX_LAT = 85.0511287798066;
export const EARTH_CIRCUMFERENCE_M = 40075016.68557849;

export function lonLatToMerc(lon: number, lat: number): [number, number] {
  const l = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const s = Math.sin((l * Math.PI) / 180);
  return [(lon + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
}

export function mercToLonLat(mx: number, my: number): [number, number] {
  return [mx * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI];
}

/** Mercator units per ground metre at mercator y. */
export function mercPerMeter(my: number): number {
  return Math.cosh(Math.PI * (1 - 2 * my)) / EARTH_CIRCUMFERENCE_M;
}

export function tileXY(z: number, mx: number, my: number): [number, number] {
  const n = 2 ** z;
  const c = (v: number) => Math.max(0, Math.min(n - 1, Math.floor(v * n)));
  return [c(mx), c(my)];
}

/** 26-bit key of a z13 tile, identical to the Go side. */
export const tileKey = (x: number, y: number) => (x << TOPIC_ZOOM) | y;

export const subjectFor = (x: number, y: number) => `tracks.${TOPIC_ZOOM}.${x}.${y}`;

/** Parses "tracks.13.<x>.<y>" into a tile key, or -1. */
export function subjectTileKey(subject: string): number {
  const p = subject.split(".");
  if (p.length !== 4 || p[1] !== String(TOPIC_ZOOM)) return -1;
  const x = Number(p[2]);
  const y = Number(p[3]);
  return Number.isInteger(x) && Number.isInteger(y) ? tileKey(x, y) : -1;
}

export function statsLevel(zoom: number): number {
  return Math.max(0, Math.min(STATS_MAX_LEVEL, Math.floor(zoom) + STATS_LEVEL_OFFSET));
}
