// Where the map data comes from, behind one interface so the map and the panels work with either
// backend:
//  * demo: GET /api/stats, /api/topics, /api/tiles/top (this repo's Go api)
//  * u1:   POST tracks/subscriptions/resolve for the topics; the worker fetches
//          GET tracks/regions/stats (the whole map, no bbox) and builds the clusters from it

import { api, u1Api, type AppConfig, type BBox, type TopTile } from "./api.ts";
import type { QueryFn } from "./shared/protocol.ts";
import type { ClusterResult } from "./shared/regions.ts";
import { MAX_LAT, statsLevel } from "./shared/tiles.ts";

export interface TopicsResult {
  subjects: string[];
  /** null when the backend does not say */
  viewportTiles: number | null;
  expectedTracks: number | null;
  truncated: boolean;
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
    return {
      clusters: (bbox, zoom) => query({ q: "clusters", bbox, level: statsLevel(zoom) }),
      async topics(bbox, zoom, margin, signal) {
        const subjects = await u1Api.resolve(cfg, grow(bbox, margin), zoom, signal);
        return { subjects, viewportTiles: null, expectedTracks: null, truncated: subjects.length >= cfg.maxTopics };
      },
      top: (limit) => query({ q: "top", limit }),
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
      return { subjects: t.topics.map((x) => x.subject), viewportTiles: t.viewportTiles, expectedTracks: t.expectedTracks, truncated: t.truncated };
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
