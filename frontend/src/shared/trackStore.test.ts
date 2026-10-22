import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeSnapshot } from "./wire.ts";
import { STRIDE, TrackStore } from "./trackStore.ts";
import { lonLatToMerc, mercToLonLat, subjectTileKey, tileKey, tileXY } from "./tiles.ts";

const hdr = (x: number, y: number, seq = 1) => ({ zoom: 13, x, y, seq, publishedAt: 1, intervalMs: 1000, part: 0, parts: 1 });
const rec = (id: number, lx: number, ly: number) => ({ id, lx, ly, altDm: 1234, heading: 16384, speedCms: 1500, type: 2, battery: 15 });

test("tile math matches the Go side", () => {
  const [mx, my] = lonLatToMerc(105.8342, 21.0278);
  assert.deepEqual(tileXY(13, mx, my), [6504, 3606]);
  const [lon, lat] = mercToLonLat(mx, my);
  assert.ok(Math.abs(lon - 105.8342) < 1e-9 && Math.abs(lat - 21.0278) < 1e-9);
  assert.equal(subjectTileKey("tracks.13.6504.3606"), tileKey(6504, 3606));
  assert.equal(subjectTileKey("tracks.12.1.2"), -1);
});

test("ingest decodes records and commit builds GPU segments", () => {
  const s = new TrackStore(2);
  const r = s.ingest(encodeSnapshot(hdr(6504, 3606), [rec(7, 32768, 0), rec(9, 0, 65535)]), 10);
  assert.equal(r.tracks, 2);
  assert.equal(s.n, 2);
  assert.equal(s.commit(10), 2);
  const info = s.info(7)!;
  assert.ok(Math.abs(info.mx - (6504.5 / 8192)) < 1e-12);
  assert.ok(Math.abs(info.alt - 123.4) < 1e-4);
  assert.equal(info.speed, 15);
  assert.equal(Math.round(info.heading), 90);
  assert.equal(info.kind, 2);
  // new tracks start stationary: prev == curr; low battery flag (+4) is packed with the type
  const b = info.slot * STRIDE;
  assert.equal(s.inst[b], s.inst[b + 2]);
  assert.equal(s.inst[b + 8], 2 + 4);

  // second update: the segment starts where the track is displayed now, halfway through
  s.interp = 1;
  s.ingest(encodeSnapshot(hdr(6504, 3606, 2), [rec(7, 32768 + 1000, 0)]), 10.5);
  s.commit(10.5);
  const [dx] = s.displayed(info.slot, 10.5);
  assert.ok(Math.abs(dx - info.mx) < 1e-15, "no jump at segment start");
  const [ex] = s.displayed(info.slot, 11.5);
  assert.ok(Math.abs(ex - (6504 + 33768 / 65536) / 8192) < 1e-15, "reaches the new fix after interp");
});

test("eviction is swap-remove and keeps the id map consistent", () => {
  const s = new TrackStore(4);
  s.ingest(encodeSnapshot(hdr(1, 1), [rec(1, 0, 0), rec(2, 0, 0), rec(3, 0, 0)]), 0);
  s.commit(0);
  s.ingest(encodeSnapshot(hdr(1, 1), [rec(2, 0, 0), rec(3, 0, 0)]), 5);
  s.commit(5);
  assert.equal(s.evict(3), 1);
  assert.equal(s.n, 2);
  assert.equal(s.slotOf.get(1), undefined);
  for (const id of [2, 3]) assert.equal(s.ids[s.slotOf.get(id)!], id);

  s.dropTiles(new Set([tileKey(1, 1)]));
  assert.equal(s.evict(0), 2);
  assert.equal(s.n, 0);
});

test("growth preserves state and origin rebasing rewrites instances", () => {
  const s = new TrackStore(1);
  const recs = Array.from({ length: 100 }, (_, i) => rec(i + 1, i * 100, i * 100));
  s.ingest(encodeSnapshot(hdr(10, 20), recs), 0);
  s.commit(0);
  assert.equal(s.n, 100);
  const slot = s.slotOf.get(50)!;
  const before = s.inst[slot * STRIDE] + s.ox;
  s.setOrigin(0.25, 0.75);
  assert.ok(Math.abs(s.inst[slot * STRIDE] + 0.25 - before) < 1e-6);
});

test("pick finds the nearest displayed track within the radius", () => {
  const s = new TrackStore();
  s.ingest(encodeSnapshot(hdr(100, 100), [rec(1, 1000, 1000), rec(2, 60000, 60000)]), 0);
  s.commit(0);
  const p = s.info(2)!;
  assert.equal(s.ids[s.pick(p.mx + 1e-9, p.my, 1e-6, 0)], 2);
  assert.equal(s.pick(0.9, 0.9, 1e-6, 0), -1);
});

test("malformed messages are rejected", () => {
  const s = new TrackStore();
  assert.equal(s.ingest(new Uint8Array(10), 0).header, null);
  const bad = encodeSnapshot(hdr(1, 1), [rec(1, 0, 0)]);
  assert.equal(s.ingest(bad.subarray(0, bad.length - 1), 0).header, null);
});
