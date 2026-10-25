/// <reference types="vite/client" />

// Build-time settings (frontend/.env.u1). VITE_* values are embedded in the bundle, so anyone who
// loads the app can read them, including VITE_NATS_PASS.
interface ImportMetaEnv {
  /** "u1" talks to u1-track-manager; anything else to this repo's Go backend */
  readonly VITE_TRACK_BACKEND?: string;
  /** u1: base URL of u1-track-manager (default /u1-track-manager, proxied in dev) */
  readonly VITE_TRACK_API_BASE?: string;
  /** u1: subject prefix before ".xyz.<z>.<x>.<y>" (default u1.track.region) */
  readonly VITE_TRACK_SUBJECT_PREFIX?: string;
  /** u1: expected publish interval in ms until the worker has measured it (default 1000) */
  readonly VITE_TRACK_INTERVAL_MS?: string;
  /** u1: a silent track is dropped after this many publish intervals (default 3) */
  readonly VITE_TRACK_STALE_FACTOR?: string;
  /** u1: limits sent to resolve (default 36 / 4000) */
  readonly VITE_MAX_PARTITIONS?: string;
  readonly VITE_MAX_CACHED_TRACKS?: string;
  /** NATS WebSocket URL (default same origin /nats) and credentials; override the demo API config */
  readonly VITE_NATS_WS_URL?: string;
  readonly VITE_NATS_USER?: string;
  readonly VITE_NATS_PASS?: string;
  readonly VITE_API_BASE?: string;
  readonly VITE_MAP_STYLE?: string;
}
