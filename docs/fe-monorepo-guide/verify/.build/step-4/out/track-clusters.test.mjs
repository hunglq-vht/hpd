import assert from "node:assert/strict";
import { describe, it } from "node:test";
// .build/step-4/vite-plus-test.ts
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
const ALERT_STATUSES = /* @__PURE__ */ new Set([
	"CRITICAL",
	"WARNING",
	"LOST_CONTROL",
	"PROCESSING"
]);
function lonLatToMercator(longitude, latitude) {
	const sin = Math.sin(latitude * Math.PI / 180);
	return [(longitude + 180) / 360, .5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)];
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
// .build/step-4/apps/utm/src/worker/live-tracks/track-clusters.ts
const CLUSTER_CELL_PX = 80;
function abbreviateCount(count) {
	if (count >= 1e4) return `${Math.round(count / 1e3)}k`;
	if (count >= 1e3) return `${Math.round(count / 100) / 10}k`;
	return String(count);
}
function mercatorToLonLat(x, y) {
	return [x * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI];
}
/** README: Groups tracks into grid cells 80 px wide at the integer zoom. A cell with one track stays a track feature, like a supercluster leaf. */
function clusterTrackFeatures(features, zoom) {
	const cellSize = CLUSTER_CELL_PX / (512 * 2 ** Math.floor(zoom));
	const cells = /* @__PURE__ */ new Map();
	for (const feature of features) {
		const [longitude, latitude] = feature.geometry.coordinates;
		if (longitude === void 0 || latitude === void 0) continue;
		const [x, y] = lonLatToMercator(longitude, latitude);
		const key = Math.floor(x / cellSize) * 2 ** 21 + Math.floor(y / cellSize);
		const cell = cells.get(key);
		if (cell) {
			cell.count++;
			cell.sumX += x;
			cell.sumY += y;
			cell.members.push(feature);
		} else cells.set(key, {
			count: 1,
			sumX: x,
			sumY: y,
			members: [feature]
		});
	}
	const output = [];
	const clusteredIds = /* @__PURE__ */ new Set();
	for (const [key, cell] of cells) {
		const [single] = cell.members;
		if (cell.count === 1 && single) {
			output.push(single);
			continue;
		}
		for (const member of cell.members) clusteredIds.add(member.properties.id);
		const id = -1 - key;
		output.push({
			type: "Feature",
			id,
			geometry: {
				type: "Point",
				coordinates: mercatorToLonLat(cell.sumX / cell.count, cell.sumY / cell.count)
			},
			properties: {
				id,
				cluster: true,
				point_count: cell.count,
				point_count_abbreviated: abbreviateCount(cell.count)
			}
		});
	}
	return {
		features: output,
		clusteredIds
	};
}
// .build/step-4/apps/utm/src/worker/live-tracks/track-clusters.test.ts
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
describe$1("live track clusters", () => {
	it$1("keeps a lone track as a track and groups nearby tracks into one cluster", () => {
		expect.hasAssertions();
		const result = clusterTrackFeatures([
			makeTrack(1, 105, 21),
			makeTrack(2, 105.00001, 21),
			makeTrack(3, 106, 21)
		].map((track) => toTrackFeature(track, "NORMAL", colors)), 10);
		const cluster = result.features.find((feature) => "cluster" in feature.properties);
		const single = result.features.find((feature) => !("cluster" in feature.properties));
		expect(result.features).toHaveLength(2);
		expect([...result.clusteredIds].sort()).toEqual([1, 2]);
		expect(cluster?.properties).toMatchObject({
			cluster: true,
			point_count: 2,
			point_count_abbreviated: "2"
		});
		expect(cluster?.properties.id).toBeLessThan(0);
		expect(single?.properties.id).toBe(3);
	});
	it$1("abbreviates counts like supercluster", () => {
		expect.hasAssertions();
		expect(abbreviateCount(999)).toBe("999");
		expect(abbreviateCount(1234)).toBe("1.2k");
		expect(abbreviateCount(15e3)).toBe("15k");
	});
});
export {};
