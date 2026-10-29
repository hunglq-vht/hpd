// Decoder for the u1-track-manager NATS events: JSON, one track per message, on the region subjects
// "<prefix>.xyz.13.<x>.<y>".
//   track.update  { type, timestamp, state_updated_at?, region, track: { ID, TrackNumber, Latitude,
//                   Longitude, Velocity, Altitude, Heading, Model, Mode3a, UpdatedAt, CreatedAt } }
//   track.leave   { type, timestamp, region, leave: { track_id, to_region, updated_at } }
//   track.batch   { type, timestamp, state_updated_at, region, tracks: [track, ...],
//                   leaves?: [{ track_id, to_region, updated_at }] }   (local simulator only)
// `timestamp` is in seconds or ms; the dev server also sends `state_updated_at` in ms, which is
// preferred for latency.
// Shared by the worker, the Node tests and the mock backend, so it must stay free of DOM APIs.

import { lonLatToMerc, tileKey, TOPIC_ZOOM } from "./tiles.ts";
import { BATTERY_UNKNOWN, type TrackReport, type TrackStore } from "./trackStore.ts";

export const REGION_SCHEME = "web_mercator_xyz";

export interface U1Region {
  scheme: string;
  zoom: number;
  x: number;
  y: number;
}

export interface U1Track {
  ID: number;
  TrackNumber?: number;
  Latitude: number;
  Longitude: number;
  Velocity?: number;
  Altitude?: number;
  Heading?: number;
  Model?: string;
  Mode3a?: string;
  UpdatedAt?: number;
  CreatedAt?: number;
}

export type U1Event =
  | { type: "track.update"; timestamp: number; state_updated_at?: number; region: U1Region; track: U1Track }
  | { type: "track.leave"; timestamp: number; region: U1Region; leave: U1Departure }
  | { type: "track.batch"; timestamp: number; state_updated_at?: number; region: U1Region; tracks: U1Track[]; leaves?: U1Departure[] };

export interface U1Departure {
  track_id: number;
  to_region: U1Region;
  updated_at: number;
}

/** Mode 3/A codes for hijack, radio failure and emergency. */
const EMERGENCY_CODES = new Set(["7500", "7600", "7700"]);

/** Icon type (see KIND_NAMES): Emergency for an emergency Mode 3/A code, otherwise from the model text. */
export function kindOf(model: string, mode3a: string): number {
  if (EMERGENCY_CODES.has(mode3a)) return 3;
  const m = model.toLowerCase();
  if (m.includes("hexa")) return 1;
  if (/fixed|wing|plane|aircraft/.test(m)) return 2;
  return 0;
}

/** Tile key of a region object, or -1 unless it is a web_mercator_xyz tile at the topic zoom. */
export function regionKey(r: Partial<U1Region> | null | undefined): number {
  if (!r || r.scheme !== REGION_SCHEME || r.zoom !== TOPIC_ZOOM) return -1;
  const { x, y } = r;
  if (typeof x !== "number" || typeof y !== "number") return -1;
  const n = 2 ** TOPIC_ZOOM;
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < n && y < n ? tileKey(x, y) : -1;
}

/** Unix ms from a timestamp in seconds (as in the examples) or in milliseconds. */
export const toMs = (t: number) => (t < 1e11 ? t * 1000 : t);

const num = (v: unknown, d: number) => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : d;
};
const isId = (v: number) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
const text = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

const decoder = new TextDecoder();
const report: TrackReport = {
  id: 0, mx: 0, my: 0, alt: 0, heading: 0, speed: 0, kind: 0, battery: BATTERY_UNKNOWN,
  tile: -1, trackNo: 0, mode3a: "", model: "", updatedAt: 0,
};

export interface U1Result {
  type: U1Event["type"];
  /** track updates applied */
  tracks: number;
  /** publish time, unix ms */
  timestampMs: number;
}

/** Puts one track object into the store; false when it has no valid id or position. */
function putTrack(t: Partial<Record<keyof U1Track, unknown>> | undefined, tile: number, now: number, store: TrackStore): boolean {
  if (!t || typeof t !== "object") return false;
  const id = num(t.ID, -1);
  const lon = num(t.Longitude, NaN);
  const lat = num(t.Latitude, NaN);
  if (!isId(id) || !(Math.abs(lon) <= 180) || !(Math.abs(lat) <= 90)) return false;
  const [mx, my] = lonLatToMerc(lon, lat);
  const model = text(t.Model);
  const mode3a = text(t.Mode3a);
  report.id = id;
  report.mx = mx;
  report.my = my;
  report.alt = num(t.Altitude, 0);
  report.heading = (num(t.Heading, 0) * Math.PI) / 180;
  report.speed = num(t.Velocity, 0);
  report.kind = kindOf(model, mode3a);
  report.tile = tile;
  report.trackNo = num(t.TrackNumber, id);
  report.mode3a = mode3a;
  report.model = model;
  report.updatedAt = t.UpdatedAt === undefined ? 0 : toMs(num(t.UpdatedAt, 0));
  store.put(report, now);
  return true;
}

/** Applies a departure; false when it has no valid track id. */
function applyLeave(l: Partial<Record<keyof U1Departure, unknown>> | undefined, from: number, store: TrackStore, listening: (key: number) => boolean): boolean {
  const id = num(l?.track_id, -1);
  if (!isId(id)) return false;
  const to = regionKey(l?.to_region as Partial<U1Region> | undefined);
  store.leave(id, from, to, to >= 0 && listening(to));
  return true;
}

/**
 * Applies one event to the store; returns null for a malformed message. `subjectKey` is the tile
 * key of the subject it came on (used when the event has no region). `listening(key)` tells
 * whether the client still receives a region, so a track leaving for it is kept.
 */
export function applyU1Event(
  data: Uint8Array | string,
  subjectKey: number,
  now: number,
  store: TrackStore,
  listening: (key: number) => boolean,
): U1Result | null {
  let ev: Partial<Record<string, unknown>>;
  try {
    ev = JSON.parse(typeof data === "string" ? data : decoder.decode(data));
  } catch {
    return null;
  }
  if (!ev || typeof ev !== "object") return null;
  const sentMs = num(ev.state_updated_at, 0) || toMs(num(ev.timestamp, 0));
  const rk = regionKey(ev.region as Partial<U1Region>);
  const from = rk >= 0 ? rk : subjectKey;

  if (ev.type === "track.update") {
    if (!putTrack(ev.track as Partial<Record<keyof U1Track, unknown>> | undefined, from, now, store)) return null;
    return { type: "track.update", tracks: 1, timestampMs: sentMs || report.updatedAt };
  }

  if (ev.type === "track.leave") {
    if (!applyLeave(ev.leave as Parameters<typeof applyLeave>[0], from, store, listening)) return null;
    return { type: "track.leave", tracks: 0, timestampMs: sentMs };
  }

  if (ev.type === "track.batch") {
    if (!Array.isArray(ev.tracks)) return null;
    let n = 0;
    for (const t of ev.tracks) if (putTrack(t, from, now, store)) n++;
    if (Array.isArray(ev.leaves)) for (const l of ev.leaves) applyLeave(l, from, store, listening);
    return { type: "track.batch", tracks: n, timestampMs: sentMs };
  }
  return null;
}
