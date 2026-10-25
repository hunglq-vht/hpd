import { test } from "node:test";
import assert from "node:assert/strict";
import { clusterRegions, parseRegionStats, topRegions } from "./regions.ts";
import { mercToLonLat } from "./tiles.ts";

const body = {
  regions: [
    { topic: "u1.track.region.xyz.13.6503.3605", active_track_count: 63 },
    { topic: "u1.track.region.xyz.13.6504.3605", active_track_count: 52 },
    { topic: "u1.track.region.xyz.13.6505.3605", active_track_count: 10 },
    { topic: "u1.track.region.xyz.12.1.1", active_track_count: 5 }, // other zoom: skipped
    { topic: "u1.track.region.xyz.13.1.1", active_track_count: 0 }, // empty: skipped
    { nope: true },
  ],
};

test("region stats keep the z13 regions with tracks", () => {
  const st = parseRegionStats(body);
  assert.equal(st.n, 3);
  assert.equal(st.total, 125);
  assert.deepEqual([st.x[1], st.y[1], st.count[1]], [6504, 3605, 52]);
  assert.equal(parseRegionStats(null).n, 0);
});

test("clusters sum regions into coarser cells at the count-weighted centroid", () => {
  const st = parseRegionStats(body);
  const r = clusterRegions(st, [105.7, 21.0, 106.0, 21.2], 12);
  assert.equal(r.level, 12);
  assert.equal(r.total, 125);
  // z12 cells: 6503 >> 1 = 3251, while 6504 and 6505 share 3252
  const cells = new Map(r.cells.map((c) => [c[0], c]));
  assert.equal(cells.get(3251)![2], 63);
  const shared = cells.get(3252)!;
  assert.equal(shared[2], 62);
  const [lon] = mercToLonLat((52 * 6504.5 + 10 * 6505.5) / 62 / 8192, 0.5);
  assert.ok(Math.abs(shared[3] - lon) < 1e-9);
  // levels above the region zoom stay at the region zoom
  assert.equal(clusterRegions(st, [105.7, 21.0, 106.0, 21.2], 15).level, 13);
});

test("only cells touching the bbox are returned, and inView counts the regions inside it", () => {
  const st = parseRegionStats(body);
  // a bbox inside region 6504 only
  const r = clusterRegions(st, [105.83, 21.06, 105.85, 21.07], 13);
  assert.deepEqual(r.cells.map((c) => c[0]), [6504]);
  assert.equal(r.inView, 52);
});

test("top regions are the busiest first", () => {
  const top = topRegions(parseRegionStats(body), 2);
  assert.deepEqual(top.map((t) => t.subject), ["u1.track.region.xyz.13.6503.3605", "u1.track.region.xyz.13.6504.3605"]);
});
