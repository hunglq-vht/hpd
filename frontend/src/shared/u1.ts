// Decoder for the u1-track-manager NATS events: JSON, one track per message, on the region subjects
// "<prefix>.xyz.13.<x>.<y>".
//   track.update  { type, timestamp, region, track: { ID, TrackNumber, Latitude, Longitude, Velocity,
//                   Altitude, Heading, Model, Mode3a, UpdatedAt, CreatedAt } }
//   track.leave   { type, timestamp, region, leave: { track_id, to_region, updated_at } }
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
  | { type: "track.update"; timestamp: number; region: U1Region; track: U1Track }
  | { type: "track.leave"; timestamp: number; region: U1Region; leave: { track_id: number; to_region: U1Region; updated_at: number } };

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
  /** publish time, unix ms */
  timestampMs: number;
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
  const rk = regionKey(ev.region as Partial<U1Region>);
  const from = rk >= 0 ? rk : subjectKey;

  if (ev.type === "track.update") {
    const t = ev.track as Partial<Record<keyof U1Track, unknown>> | undefined;
    if (!t) return null;
    const id = num(t.ID, -1);
    const lon = num(t.Longitude, NaN);
    const lat = num(t.Latitude, NaN);
    if (!isId(id) || !(Math.abs(lon) <= 180) || !(Math.abs(lat) <= 90)) return null;
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
    report.tile = from;
    report.trackNo = num(t.TrackNumber, id);
    report.mode3a = mode3a;
    report.model = model;
    report.updatedAt = t.UpdatedAt === undefined ? 0 : toMs(num(t.UpdatedAt, 0));
    store.put(report, now);
    return { type: "track.update", timestampMs: toMs(num(ev.timestamp, 0)) || report.updatedAt };
  }

  if (ev.type === "track.leave") {
    const l = ev.leave as { track_id?: unknown; to_region?: Partial<U1Region> } | undefined;
    const id = num(l?.track_id, -1);
    if (!isId(id)) return null;
    const to = regionKey(l?.to_region);
    store.leave(id, from, to, to >= 0 && listening(to));
    return { type: "track.leave", timestampMs: toMs(num(ev.timestamp, 0)) };
  }
  return null;
}
