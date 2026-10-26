// Cluster cells for the u1 backend. GET tracks/regions/stats returns one count per z13 region for
// the whole map (no bbox, no centroid), so the worker sums the regions into coarser cells itself.
// Shared by the worker and the Node tests, so it must stay free of DOM APIs.

import { lonLatToMerc, mercToLonLat, subjectTileKey, tileXY, TOPIC_ZOOM } from "./tiles.ts";

export type BBox = [w: number, s: number, e: number, n: number];

/** One cluster: cell x/y at the cluster level, track count, centroid lon/lat. */
export type ClusterCell = [x: number, y: number, count: number, lon: number, lat: number];

export interface ClusterResult {
  level: number;
  total: number;
  inView: number;
  cells: ClusterCell[];
}

export interface TopTile {
  subject: string;
  count: number;
  lon: number;
  lat: number;
}

/** Parsed regions stats: struct-of-arrays over the regions with a known subject format. */
export interface RegionStats {
  n: number;
  total: number;
  topics: string[];
  x: Int32Array;
  y: Int32Array;
  count: Float64Array;
}

const MASK = 2 ** TOPIC_ZOOM - 1;

export function parseRegionStats(body: unknown): RegionStats {
  const list = (body as { regions?: unknown } | null)?.regions;
  const regions = (Array.isArray(list) ? list : []) as { topic?: unknown; active_track_count?: unknown }[];
  const st: RegionStats = {
    n: 0,
    total: 0,
    topics: [],
    x: new Int32Array(regions.length),
    y: new Int32Array(regions.length),
    count: new Float64Array(regions.length),
  };
  for (const r of regions) {
    const c = Number(r?.active_track_count);
    const key = typeof r?.topic === "string" ? subjectTileKey(r.topic) : -1;
    if (key < 0 || !(c > 0)) continue;
    st.topics.push(r.topic as string);
    st.x[st.n] = key >> TOPIC_ZOOM;
    st.y[st.n] = key & MASK;
    st.count[st.n] = c;
    st.total += c;
    st.n++;
  }
  return st;
}

/**
 * Sums the regions into cells at `level` (at most the topic zoom) for the cells that touch `bbox`.
 * Each cell sits at the count-weighted mean of its regions' centres, so clusters follow the traffic.
 */
export function clusterRegions(st: RegionStats, bbox: BBox, level: number): ClusterResult {
  const L = Math.max(0, Math.min(TOPIC_ZOOM, level));
  const shift = TOPIC_ZOOM - L;
  const [tx0, ty0] = tileXY(TOPIC_ZOOM, ...lonLatToMerc(bbox[0], bbox[3]));
  const [tx1, ty1] = tileXY(TOPIC_ZOOM, ...lonLatToMerc(bbox[2], bbox[1]));
  const cx0 = tx0 >> shift;
  const cy0 = ty0 >> shift;
  const cx1 = tx1 >> shift;
  const cy1 = ty1 >> shift;
  const size = 2 ** TOPIC_ZOOM;

  const index = new Map<number, number>(); // cell key -> offset into acc
  const acc: number[] = []; // per cell: x, y, count, sum(count * mx), sum(count * my)
  let inView = 0;
  for (let i = 0; i < st.n; i++) {
    const x = st.x[i];
    const y = st.y[i];
    const c = st.count[i];
    if (x >= tx0 && x <= tx1 && y >= ty0 && y <= ty1) inView += c;
    const cx = x >> shift;
    const cy = y >> shift;
    if (cx < cx0 || cx > cx1 || cy < cy0 || cy > cy1) continue;
    const k = cx * 65536 + cy;
    let o = index.get(k);
    if (o === undefined) {
      o = acc.length;
      index.set(k, o);
      acc.push(cx, cy, 0, 0, 0);
    }
    acc[o + 2] += c;
    acc[o + 3] += (c * (x + 0.5)) / size;
    acc[o + 4] += (c * (y + 0.5)) / size;
  }

  const cells: ClusterCell[] = [];
  for (let o = 0; o < acc.length; o += 5) {
    const c = acc[o + 2];
    const [lon, lat] = mercToLonLat(acc[o + 3] / c, acc[o + 4] / c);
    cells.push([acc[o], acc[o + 1], c, lon, lat]);
  }
  return { level: L, total: st.total, inView, cells };
}

/** The `limit` busiest regions, with their centres. */
export function topRegions(st: RegionStats, limit: number): TopTile[] {
  const order = Array.from({ length: st.n }, (_, i) => i).sort((a, b) => st.count[b] - st.count[a]);
  const size = 2 ** TOPIC_ZOOM;
  return order.slice(0, limit).map((i) => {
    const [lon, lat] = mercToLonLat((st.x[i] + 0.5) / size, (st.y[i] + 0.5) / size);
    return { subject: st.topics[i], count: st.count[i], lon, lat };
  });
}

/** Number of z13 regions a bbox touches. */
export function regionCount([w, s, e, n]: BBox): number {
  const [x0, y0] = tileXY(TOPIC_ZOOM, ...lonLatToMerc(w, n));
  const [x1, y1] = tileXY(TOPIC_ZOOM, ...lonLatToMerc(e, s));
  return (x1 - x0 + 1) * (y1 - y0 + 1);
}

/** Answer of POST tracks/subscriptions/resolve. */
export type ResolveResult =
  | { ok: true; topics: string[]; partitions: number; estimatedTracks: number | null }
  /** HTTP 422 SUBSCRIPTION_LIMIT_EXCEEDED: the view needs more than the client's limits allow */
  | { ok: false; limit: string; max: number; estimatedTracks: number; partitions: number };

interface ResolveBody {
  topics?: unknown;
  partition_count?: unknown;
  estimated_cached_tracks?: unknown;
  code?: unknown;
  limit?: unknown;
  limits_applied?: Record<string, unknown>;
  required?: { estimated_cached_tracks?: unknown; partition_count?: unknown };
}

/** Reads a resolve answer for the requested bbox; null when it is neither a topic list nor a limit refusal. */
export function readResolve(status: number, body: unknown, bbox: BBox): ResolveResult | null {
  const b = (body ?? {}) as ResolveBody;
  if (status >= 200 && status < 300 && Array.isArray(b.topics)) {
    const topics = b.topics.filter((t): t is string => typeof t === "string");
    const estimated = Number(b.estimated_cached_tracks ?? NaN);
    return { ok: true, topics, partitions: Number(b.partition_count) || topics.length, estimatedTracks: Number.isFinite(estimated) ? estimated : null };
  }
  if (status === 422 && b.code === "SUBSCRIPTION_LIMIT_EXCEEDED") {
    const limit = String(b.limit ?? "");
    return {
      ok: false,
      limit,
      max: Number(b.limits_applied?.[limit]) || 0,
      estimatedTracks: Number(b.required?.estimated_cached_tracks) || 0,
      // a refusal on track count reports 0 partitions, so count the regions here
      partitions: Number(b.required?.partition_count) || regionCount(bbox),
    };
  }
  return null;
}
