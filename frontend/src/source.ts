// Where the map data comes from, behind one interface so the map and the panels work with either
// backend:
//  * demo: GET /api/stats, /api/topics, /api/tiles/top (this repo's Go api)
//  * u1:   POST tracks/subscriptions/resolve for the topics; the worker fetches
//          GET tracks/regions/stats (the whole map, no bbox) and builds the clusters from it.
//          Both name the JSON subjects; for another wire format the prefix is swapped.

import { api, u1Api, type AppConfig, type BBox, type TopTile } from "./api.ts";
import type { QueryFn } from "./shared/protocol.ts";
import type { ClusterResult } from "./shared/regions.ts";
import { MAX_LAT, statsLevel } from "./shared/tiles.ts";

/** The server refused the view: it needs more tracks or regions than the client's limits allow. */
export interface OverLimit {
  limit: string; // "max_cached_tracks" or "max_partitions"
  max: number;
  estimated: number; // tracks
  regions: number;
}

export interface TopicsResult {
  subjects: string[];
  /** null when the backend does not say */
  viewportTiles: number | null;
  expectedTracks: number | null;
  truncated: boolean;
  /** u1: set instead of subjects when the server refused the view */
  overLimit: OverLimit | null;
}

export interface TrackSource {
  /** Cluster cells for the viewport (below realtimeMinZoom). */
  clusters(bbox: BBox, zoom: number, signal: AbortSignal): Promise<ClusterResult>;
  /** Subjects that cover the viewport, grown by `margin` viewport sizes on each side. */
  topics(bbox: BBox, zoom: number, margin: number, signal: AbortSignal): Promise<TopicsResult>;
  /** The busiest regions, for "Densest tile" and the stress tests. */
  top(limit: number): Promise<TopTile[]>;
  /** Subject that matches every region (stress test "firehose"). */
  readonly firehose: string;
}

export function createTrackSource(cfg: AppConfig, query: QueryFn): TrackSource {
  if (cfg.backend === "u1") {
    const from = `${cfg.topicPrefix}.`;
    const toWire = (s: string) => (s.startsWith(from) ? `${cfg.subjectPrefix}.${s.slice(from.length)}` : s);
    return {
      clusters: (bbox, zoom) => query({ q: "clusters", bbox, level: statsLevel(zoom) }),
      async topics(bbox, zoom, margin, signal) {
        const r = await u1Api.resolve(cfg, grow(bbox, margin), zoom, signal);
        if (!r.ok) {
          const overLimit = { limit: r.limit, max: r.max, estimated: r.estimatedTracks, regions: r.partitions };
          return { subjects: [], viewportTiles: null, expectedTracks: null, truncated: false, overLimit };
        }
        // the server refuses rather than truncates, so a returned list is always complete
        return { subjects: r.topics.map(toWire), viewportTiles: r.partitions, expectedTracks: r.estimatedTracks, truncated: false, overLimit: null };
      },
      top: async (limit) => (await query({ q: "top", limit })).map((t) => ({ ...t, subject: toWire(t.subject) })),
      firehose: `${cfg.subjectPrefix}.>`,
    };
  }
  return {
    async clusters(bbox, zoom, signal) {
      const s = await api.stats(bbox, zoom, signal);
      return { level: s.level, total: s.total, inView: s.inView, cells: s.cells };
    },
    async topics(bbox, zoom, margin, signal) {
      const t = await api.topics(bbox, zoom, margin, signal);
      return { subjects: t.topics.map((x) => x.subject), viewportTiles: t.viewportTiles, expectedTracks: t.expectedTracks, truncated: t.truncated, overLimit: null };
    },
    top: async (limit) => (await api.topTiles(limit)).tiles,
    firehose: `${cfg.subjectPrefix}.>`,
  };
}

/** resolve takes only a viewport, so the prefetch margin is added to the bbox. */
function grow([w, s, e, n]: BBox, margin: number): BBox {
  const dx = (e - w) * margin;
  const dy = (n - s) * margin;
  return [w - dx, Math.max(-MAX_LAT, s - dy), e + dx, Math.min(MAX_LAT, n + dy)];
}
