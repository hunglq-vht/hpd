import assert from "node:assert/strict";
import { describe, it } from "node:test";
// .build/step-2/vite-plus-test.ts
function describe$1(name, run) {
	describe(name, run);
}
function it$1(name, run) {
	it(name, run);
}
function isSubset(actual, expected) {
	if (typeof expected !== "object" || expected === null) return Object.is(actual, expected);
	if (typeof actual !== "object" || actual === null) return false;
	return Object.entries(expected).every(([key, value]) => isSubset(actual[key], value));
}
function createMatchers(actual) {
	return {
		toBe: (expected) => assert.equal(actual, expected),
		toEqual: (expected) => assert.deepEqual(actual, expected),
		toBeNull: () => assert.equal(actual, null),
		toBeCloseTo: (expected, digits = 2) => assert.ok(Math.abs(Number(actual) - expected) < 10 ** -digits / 2, `${String(actual)} is not close to ${expected}`),
		toBeLessThan: (expected) => assert.ok(Number(actual) < expected, `${String(actual)} is not less than ${expected}`),
		toHaveLength: (expected) => assert.equal(actual?.length, expected),
		toMatchObject: (expected) => assert.ok(isSubset(actual, expected), `${JSON.stringify(actual)} does not match ${JSON.stringify(expected)}`)
	};
}
const expect = Object.assign(createMatchers, { hasAssertions: () => void 0 });
// .build/step-2/apps/utm/src/worker/live-tracks/track-view.ts
const LOST_LINK_MS = 5e3;
const ALERT_PRIORITY = [
	"CRITICAL",
	"WARNING",
	"LOST_CONTROL",
	"PROCESSING"
];
const ALERT_STATUSES = new Set(ALERT_PRIORITY);
const DIFF_PROPERTY_KEYS = [
	"track_number",
	"status",
	"color",
	"heading",
	"velocity",
	"alert",
	"alert_level",
	"mode3a"
];
function lonLatToMercator(longitude, latitude) {
	const sin = Math.sin(latitude * Math.PI / 180);
	return [(longitude + 180) / 360, .5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)];
}
function getTrackStatus(entry, alerts, now) {
	if (now - entry.receivedAt > LOST_LINK_MS) return "LOST_LINK";
	const levels = alerts.get(entry.track.TrackNumber) ?? alerts.get(entry.track.ID);
	if (!levels) return "NORMAL";
	const values = new Set(levels.values());
	return ALERT_PRIORITY.find((level) => values.has(level)) ?? "NORMAL";
}
function toViewArea(view) {
	return {
		centerLongitude: view.corners.reduce((sum, [longitude]) => sum + longitude, 0) / view.corners.length,
		polygon: view.corners.map(([longitude, latitude]) => lonLatToMercator(longitude, latitude))
	};
}
function isInConvexPolygon(polygon, x, y) {
	let side = 0;
	for (const [index, [ax, ay]] of polygon.entries()) {
		const [bx, by] = polygon[(index + 1) % polygon.length] ?? [ax, ay];
		const cross = Math.sign((bx - ax) * (y - ay) - (by - ay) * (x - ax));
		if (cross === 0) continue;
		if (side === 0) side = cross;
		if (cross !== side) return false;
	}
	return true;
}
function isInViewArea(area, longitude, latitude) {
	const [x, y] = lonLatToMercator(longitude + 360 * Math.round((area.centerLongitude - longitude) / 360), latitude);
	return isInConvexPolygon(area.polygon, x, y);
}
function toTrackFeature(track, status, colors) {
	const label = track.Mode3a || "-";
	return {
		type: "Feature",
		id: track.ID,
		geometry: {
			type: "Point",
			coordinates: [track.Longitude, track.Latitude]
		},
		properties: {
			id: track.ID,
			track_id: track.ID,
			track_number: track.TrackNumber,
			status,
			color: colors[status],
			heading: track.Heading,
			velocity: track.Velocity,
			alert: ALERT_STATUSES.has(status),
			alert_level: status === "NORMAL" ? null : status,
			mode3a: label.length > 24 ? label.slice(-15) : label
		}
	};
}
/** README: Builds the MapLibre diff from the features last sent to this view, and updates `sent` to the new features. */
function diffTrackFeatures(sent, next) {
	const add = [];
	const update = [];
	const nextIds = /* @__PURE__ */ new Set();
	for (const feature of next) {
		const id = feature.properties.id;
		nextIds.add(id);
		const previous = sent.get(id);
		sent.set(id, feature);
		if (!previous) {
			add.push(feature);
			continue;
		}
		const [longitude, latitude] = feature.geometry.coordinates;
		const [previousLongitude, previousLatitude] = previous.geometry.coordinates;
		const change = { id };
		if (longitude !== previousLongitude || latitude !== previousLatitude) change.newGeometry = feature.geometry;
		for (const key of DIFF_PROPERTY_KEYS) {
			if (feature.properties[key] === previous.properties[key]) continue;
			change.addOrUpdateProperties ??= [];
			change.addOrUpdateProperties.push({
				key,
				value: feature.properties[key]
			});
		}
		if (change.newGeometry || change.addOrUpdateProperties) update.push(change);
	}
	const remove = [];
	for (const id of sent.keys()) {
		if (nextIds.has(id)) continue;
		remove.push(id);
		sent.delete(id);
	}
	return {
		add,
		remove,
		update
	};
}
// .build/step-2/apps/utm/src/worker/live-tracks/track-view.test.ts
const colors = {
	NORMAL: "normal",
	WARNING: "warning",
	CRITICAL: "critical",
	LOST_LINK: "lost-link",
	PROCESSING: "processing",
	LOST_CONTROL: "lost-control"
};
function makeTrack(id, longitude, latitude) {
	return {
		ID: id,
		TrackNumber: id + 100,
		Longitude: longitude,
		Latitude: latitude,
		Altitude: 100,
		AircraftType: 1,
		Identification: 1,
		Heading: 90,
		Velocity: 10,
		Serial: "",
		CreatedAt: 0,
		UpdatedAt: 0,
		ListSources: [],
		Mode3a: `UAV-${id}`
	};
}
describe$1("live track view", () => {
	it$1("projects longitude and latitude to web mercator", () => {
		expect.hasAssertions();
		expect(lonLatToMercator(0, 0)[0]).toBe(.5);
		expect(lonLatToMercator(0, 0)[1]).toBeCloseTo(.5, 12);
		expect(lonLatToMercator(0, 85.0511287798)[1]).toBeCloseTo(0, 6);
	});
	it$1("marks a track silent for more than 5 s as LOST_LINK and finds alerts by TrackNumber", () => {
		expect.hasAssertions();
		const alerts = /* @__PURE__ */ new Map([[101, /* @__PURE__ */ new Map([["intrusion", "WARNING"], ["collision", "CRITICAL"]])]]);
		const entry = {
			track: makeTrack(1, 105, 21),
			receivedAt: 1e3
		};
		expect(getTrackStatus(entry, alerts, 2e3)).toBe("CRITICAL");
		expect(getTrackStatus(entry, alerts, 7e3)).toBe("LOST_LINK");
		expect(getTrackStatus({
			track: makeTrack(2, 105, 21),
			receivedAt: 1e3
		}, alerts, 2e3)).toBe("NORMAL");
	});
	it$1("culls with the view polygon, also for a pitched trapezoid and another world copy", () => {
		expect.hasAssertions();
		const area = toViewArea({
			corners: [
				[105, 22],
				[107, 22],
				[108, 20],
				[104, 20]
			],
			zoom: 12,
			selectedId: null,
			watchlistIds: null,
			renderer: "geojson"
		});
		expect(isInViewArea(area, 106, 21)).toBe(true);
		expect(isInViewArea(area, 104.6, 21.8)).toBe(false);
		expect(isInViewArea(area, 104.6, 20.2)).toBe(true);
		expect(isInViewArea(area, 466, 21)).toBe(true);
	});
	it$1("sends added features, then only changed fields, then removals", () => {
		expect.hasAssertions();
		const sent = /* @__PURE__ */ new Map();
		const first = diffTrackFeatures(sent, [toTrackFeature(makeTrack(1, 105, 21), "NORMAL", colors), toTrackFeature(makeTrack(2, 105, 21), "NORMAL", colors)]);
		const moved = makeTrack(1, 105.1, 21);
		const second = diffTrackFeatures(sent, [toTrackFeature(moved, "WARNING", colors)]);
		const third = diffTrackFeatures(sent, [toTrackFeature(moved, "WARNING", colors)]);
		expect(first.add).toHaveLength(2);
		expect(second.remove).toEqual([2]);
		expect(second.update?.[0]?.newGeometry).toEqual({
			type: "Point",
			coordinates: [105.1, 21]
		});
		expect(second.update?.[0]?.addOrUpdateProperties?.map((change) => change.key).sort()).toEqual([
			"alert",
			"alert_level",
			"color",
			"status"
		]);
		expect(third.update).toHaveLength(0);
	});
});
export {};
