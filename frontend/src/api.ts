// HTTP client for the tile API (docs/PROTOCOL.md section 4).

export interface AppConfig {
  tileScheme: string;
  topicZoom: number;
  realtimeMinZoom: number;
  statsMaxLevel: number;
  statsLevelOffset: number;
  subjectPattern: string;
  publishIntervalMs: number;
  staleFactor: number;
  defaultMargin: number;
  maxTopics: number;
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

export interface TopTile {
  subject: string;
  count: number;
  lon: number;
  lat: number;
}

export type BBox = [w: number, s: number, e: number, n: number];

const base = (import.meta.env?.VITE_API_BASE as string | undefined) ?? "";

async function getJSON<T>(path: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(base + path, { signal });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

const bboxParam = (b: BBox) => b.map((v) => v.toFixed(6)).join(",");

export const api = {
  config: () => getJSON<AppConfig>("/api/config"),
  stats: (b: BBox, zoom: number, signal?: AbortSignal) =>
    getJSON<StatsResponse>(`/api/stats?bbox=${bboxParam(b)}&zoom=${zoom.toFixed(3)}`, signal),
  topics: (b: BBox, zoom: number, margin: number, signal?: AbortSignal) =>
    getJSON<TopicsResponse>(`/api/topics?bbox=${bboxParam(b)}&zoom=${zoom.toFixed(3)}&margin=${margin}`, signal),
  topTiles: (limit: number) => getJSON<{ total: number; tiles: TopTile[] }>(`/api/tiles/top?limit=${limit}`),
};

/** NATS WebSocket URL: explicit from config, otherwise same-origin (proxied by nginx / Vite). */
export function natsUrl(cfg: AppConfig): string {
  if (cfg.nats.wsUrl) return cfg.nats.wsUrl;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${cfg.nats.wsPath}`;
}
