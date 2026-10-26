// HTTP clients and app config for both backends:
//  * demo: this repo's Go tile API (docs/PROTOCOL.md section 4), which also serves the config
//  * u1:   u1-track-manager; its config comes from VITE_* env variables (frontend/.env.u1)

import type { Backend } from "./shared/protocol.ts";
import { readResolve, type BBox, type ResolveResult, type TopTile } from "./shared/regions.ts";
import { REALTIME_MIN_ZOOM, STATS_LEVEL_OFFSET, TOPIC_ZOOM } from "./shared/tiles.ts";
import { REGION_SCHEME } from "./shared/u1.ts";

export type { BBox, TopTile };

export interface AppConfig {
  backend: Backend;
  /** u1: base URL of u1-track-manager, e.g. "/u1-track-manager" */
  apiBase: string;
  tileScheme: string;
  topicZoom: number;
  realtimeMinZoom: number;
  statsMaxLevel: number;
  statsLevelOffset: number;
  subjectPrefix: string;
  subjectPattern: string;
  publishIntervalMs: number;
  staleFactor: number;
  defaultMargin: number;
  /** demo: API cap on subjects; u1: limits.max_partitions sent to resolve */
  maxTopics: number;
  /** u1: limits.max_cached_tracks sent to resolve */
  maxCachedTracks: number;
  wireVersion: number;
  nats: { wsUrl: string; wsPath: string; user: string; pass: string };
}

export interface StatsResponse {
  level: number;
  seq: number;
  updatedAt: number;
  total: number;
  inView: number;
  cells: [x: number, y: number, count: number, lon: number, lat: number][];
}

export interface TopicsResponse {
  level: number;
  viewportTiles: number;
  expectedTracks: number;
  viewportTracks: number;
  truncated: boolean;
  topics: { subject: string; x: number; y: number; count: number; inView: boolean }[];
}

const base = (import.meta.env?.VITE_API_BASE as string | undefined) ?? "";

async function getJSON<T>(path: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(base + path, { signal });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

const bboxParam = (b: BBox) => b.map((v) => v.toFixed(6)).join(",");

/** demo backend */
export const api = {
  config: () => getJSON<Omit<AppConfig, "backend" | "apiBase" | "maxCachedTracks">>("/api/config"),
  stats: (b: BBox, zoom: number, signal?: AbortSignal) =>
    getJSON<StatsResponse>(`/api/stats?bbox=${bboxParam(b)}&zoom=${zoom.toFixed(3)}`, signal),
  topics: (b: BBox, zoom: number, margin: number, signal?: AbortSignal) =>
    getJSON<TopicsResponse>(`/api/topics?bbox=${bboxParam(b)}&zoom=${zoom.toFixed(3)}&margin=${margin}`, signal),
  topTiles: (limit: number) => getJSON<{ total: number; tiles: TopTile[] }>(`/api/tiles/top?limit=${limit}`),
};

/** u1 backend */
export const u1Api = {
  /**
   * POST tracks/subscriptions/resolve: the region subjects that cover a viewport (no neighbour ring),
   * or a refusal (HTTP 422) when they hold more tracks or regions than the limits sent.
   */
  async resolve(cfg: AppConfig, bbox: BBox, zoom: number, signal?: AbortSignal): Promise<ResolveResult> {
    const [west, south, east, north] = bbox;
    const path = `${cfg.apiBase}/tracks/subscriptions/resolve`;
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        viewport: { west, south, east, north },
        map_zoom: Math.round(zoom * 100) / 100,
        preferred_partition: { scheme: cfg.tileScheme, zoom: cfg.topicZoom },
        limits: { max_partitions: cfg.maxTopics, max_cached_tracks: cfg.maxCachedTracks },
      }),
    });
    const text = await r.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON: reported below
    }
    const result = readResolve(r.status, body, bbox);
    if (!result) throw new Error(`${path}: ${r.status} ${text}`);
    return result;
  },
  /** Absolute URL of GET tracks/regions/stats, which the worker fetches. */
  statsUrl: (cfg: AppConfig) => new URL(`${cfg.apiBase}/tracks/regions/stats`, location.href).href,
};

const env = import.meta.env;
const envNum = (v: string | undefined, d: number) => (v ? Number(v) : d);

function u1Config(): AppConfig {
  const prefix = env.VITE_TRACK_SUBJECT_PREFIX || "u1.track.region";
  return {
    backend: "u1",
    apiBase: (env.VITE_TRACK_API_BASE || "/u1-track-manager").replace(/\/$/, ""),
    tileScheme: REGION_SCHEME,
    topicZoom: TOPIC_ZOOM,
    realtimeMinZoom: REALTIME_MIN_ZOOM,
    statsMaxLevel: TOPIC_ZOOM,
    statsLevelOffset: STATS_LEVEL_OFFSET,
    subjectPrefix: prefix,
    subjectPattern: `${prefix}.xyz.{z}.{x}.{y}`,
    publishIntervalMs: envNum(env.VITE_TRACK_INTERVAL_MS, 1000),
    staleFactor: envNum(env.VITE_TRACK_STALE_FACTOR, 3),
    defaultMargin: 0, // resolve adds no neighbour ring, but every prefetched region costs track budget
    maxTopics: envNum(env.VITE_MAX_PARTITIONS, 36),
    maxCachedTracks: envNum(env.VITE_MAX_CACHED_TRACKS, 4000),
    wireVersion: 0,
    nats: { wsUrl: "", wsPath: "/nats", user: "", pass: "" },
  };
}

/** u1: from env only. demo: GET /api/config. VITE_NATS_* env variables override the NATS settings of both. */
export async function loadConfig(): Promise<AppConfig> {
  const cfg: AppConfig =
    env.VITE_TRACK_BACKEND === "u1"
      ? u1Config()
      : { ...(await api.config()), backend: "demo", apiBase: "", maxCachedTracks: 0 };
  cfg.nats = {
    ...cfg.nats,
    wsUrl: env.VITE_NATS_WS_URL || cfg.nats.wsUrl,
    user: env.VITE_NATS_USER || cfg.nats.user,
    pass: env.VITE_NATS_PASS || cfg.nats.pass,
  };
  return cfg;
}

/** NATS WebSocket URL: explicit from config, otherwise same-origin (proxied by nginx / Vite). */
export function natsUrl(cfg: AppConfig): string {
  if (cfg.nats.wsUrl) return cfg.nats.wsUrl;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${cfg.nats.wsPath}`;
}

/** The subject of a z13 tile, e.g. "tracks.13.6504.3606" or "u1.track.region.xyz.13.6504.3606". */
export const subjectOf = (cfg: AppConfig, x: number, y: number) =>
  cfg.subjectPattern.replace("{z}", String(cfg.topicZoom)).replace("{x}", String(x)).replace("{y}", String(y));
