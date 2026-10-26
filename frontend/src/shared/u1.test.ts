import { test } from "node:test";
import assert from "node:assert/strict";
import { TrackStore } from "./trackStore.ts";
import { applyU1Event, kindOf, regionKey, toMs } from "./u1.ts";
import { lonLatToMerc, subjectTileKey, tileKey } from "./tiles.ts";

const region = (x: number, y: number) => ({ scheme: "web_mercator_xyz", zoom: 13, x, y });
const update = (id: number, lon: number, lat: number, extra: Record<string, unknown> = {}, r = region(6504, 3606)) =>
  JSON.stringify({
    type: "track.update",
    timestamp: 1730000000,
    region: r,
    track: { ID: id, TrackNumber: id + 100, Latitude: lat, Longitude: lon, Velocity: 42.7, Altitude: 350.5, Heading: 90, Model: "aircraft", Mode3a: "7400", UpdatedAt: 1730000000, CreatedAt: 1729999500, ...extra },
  });
const leave = (id: number, from: [number, number], to: [number, number]) =>
  JSON.stringify({ type: "track.leave", timestamp: 1730000050, region: region(...from), leave: { track_id: id, to_region: region(...to), updated_at: 1730000050 } });

const HERE = tileKey(6504, 3606);
const EAST = tileKey(6505, 3606);
const all = () => true;
const none = () => false;

test("region subjects and region objects map to the same tile key", () => {
  assert.equal(subjectTileKey("u1.track.region.xyz.13.6504.3606"), HERE);
  assert.equal(subjectTileKey("utm.track.region.xyz.13.6504.3606"), HERE);
  assert.equal(subjectTileKey("u1.track.region.>"), -1);
  assert.equal(regionKey(region(6504, 3606)), HERE);
  assert.equal(regionKey({ scheme: "web_mercator_xyz", zoom: 12, x: 1, y: 1 }), -1);
  assert.equal(toMs(1730000000), 1730000000000);
  assert.equal(toMs(1730000000123), 1730000000123);
});

test("kind comes from emergency Mode 3/A codes, then from the model", () => {
  assert.equal(kindOf("quadcopter", "1200"), 0);
  assert.equal(kindOf("Hexacopter X6", "1200"), 1);
  assert.equal(kindOf("aircraft", "7400"), 2);
  assert.equal(kindOf("aircraft", "7700"), 3);
});

test("track.update fills the store with the u1 fields", () => {
  const s = new TrackStore();
  const r = applyU1Event(update(7, 105.84, 21.03), -1, 10, s, all);
  assert.deepEqual(r, { type: "track.update", timestampMs: 1730000000000 });
  s.commit(10);
  const t = s.info(7)!;
  const [mx, my] = lonLatToMerc(105.84, 21.03);
  assert.ok(Math.abs(t.mx - mx) < 1e-15 && Math.abs(t.my - my) < 1e-15);
  assert.ok(Math.abs(t.lon - 105.84) < 1e-9);
  assert.equal(Math.round(t.heading), 90);
  assert.ok(Math.abs(t.speed - 42.7) < 1e-5);
  assert.ok(Math.abs(t.alt - 350.5) < 1e-4);
  assert.equal(t.kind, 2);
  assert.equal(t.battery, null);
  assert.equal(t.trackNo, 107);
  assert.equal(t.mode3a, "7400");
  assert.equal(t.model, "aircraft");
  assert.equal(t.updatedAt, 1730000000000);
  assert.equal(s.tile[t.slot], HERE);
});

test("track.leave keeps a track moving to a region we listen to, and drops it otherwise", () => {
  const s = new TrackStore();
  applyU1Event(update(1, 105.84, 21.03), -1, 0, s, all);
  applyU1Event(update(2, 105.84, 21.03), -1, 0, s, all);
  s.commit(0);
  applyU1Event(leave(1, [6504, 3606], [6505, 3606]), -1, 0.5, s, (k) => k === EAST);
  applyU1Event(leave(2, [6504, 3606], [6505, 3606]), -1, 0.5, s, none);
  s.commit(0.5);
  assert.equal(s.evict(0), 1);
  assert.equal(s.info(2), null);
  assert.equal(s.tile[s.info(1)!.slot], EAST);
});

test("a late track.leave from the old region does not drop a track already updated by the new one", () => {
  const s = new TrackStore();
  applyU1Event(update(1, 105.84, 21.03), -1, 0, s, all);
  applyU1Event(update(1, 105.85, 21.03, {}, region(6505, 3606)), -1, 0.9, s, all);
  applyU1Event(leave(1, [6504, 3606], [6505, 3606]), -1, 1, s, none);
  s.commit(1);
  assert.equal(s.evict(0), 0);
  assert.equal(s.tile[s.info(1)!.slot], EAST);
});

test("the update interval is measured from consecutive reports of the same track", () => {
  const s = new TrackStore();
  for (let tick = 0; tick < 3; tick++) {
    for (let id = 1; id <= 20; id++) applyU1Event(update(id, 105.84, 21.03), -1, tick * 2, s, all);
    s.commit(tick * 2);
  }
  s.interp = 2.3; // gaps longer than 3 * interp are ignored
  for (let id = 1; id <= 20; id++) applyU1Event(update(id, 105.84, 21.03), -1, 6, s, all);
  assert.equal(s.takeUpdateInterval(), 2);
  assert.equal(s.takeUpdateInterval(), 0, "the sum resets");
});

test("malformed events are rejected", () => {
  const s = new TrackStore();
  assert.equal(applyU1Event("{not json", -1, 0, s, all), null);
  assert.equal(applyU1Event(JSON.stringify({ type: "track.update" }), -1, 0, s, all), null);
  assert.equal(applyU1Event(update(-1, 105.84, 21.03), -1, 0, s, all), null);
  assert.equal(applyU1Event(update(1, 105.84, 21.03, { Latitude: "north" }), -1, 0, s, all), null);
  assert.equal(applyU1Event(JSON.stringify({ type: "track.other" }), -1, 0, s, all), null);
  assert.equal(s.n, 0);
});

test("state_updated_at (ms, sent by the dev server) is preferred over the whole-second timestamp", () => {
  const s = new TrackStore();
  const ev = JSON.parse(update(1, 105.84, 21.03));
  ev.state_updated_at = 1730000000437;
  assert.equal(applyU1Event(JSON.stringify(ev), -1, 0, s, all)?.timestampMs, 1730000000437);
});

test("numeric strings are accepted, and the subject gives the tile when the region is missing", () => {
  const s = new TrackStore();
  const ev = JSON.stringify({ type: "track.update", timestamp: 1, track: { ID: "9", Latitude: "21.03", Longitude: 105.84, Mode3a: 7700 } });
  assert.ok(applyU1Event(new TextEncoder().encode(ev), HERE, 0, s, all));
  const t = s.info(9)!;
  assert.equal(t.kind, 3);
  assert.equal(s.tile[t.slot], HERE);
});
