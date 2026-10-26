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
const FLAG_DIRTY = 1;
const FLAG_NEW = 2;
function lerpAngle(from, to, fraction) {
	let delta = to - from;
	if (delta > Math.PI) delta -= 2 * Math.PI;
	if (delta < -Math.PI) delta += 2 * Math.PI;
	return from + delta * fraction;
}
/** README: Struct-of-arrays track table for the GPU layer. Slots 0..count-1 stay dense (swap-remove), so one instanced draw call covers every track. Times are shared-clock seconds. */
function createTrackStore(initialCapacity = 4096) {
	let count = 0;
	let capacity = 0;
	let glideSeconds = 1.15;
	let originX = .5;
	let originY = .5;
	let gapSum = 0;
	let gapCount = 0;
	let dirtyCount = 0;
	const slotById = /* @__PURE__ */ new Map();
	let ids = /* @__PURE__ */ new Float64Array(0);
	let startX = /* @__PURE__ */ new Float64Array(0);
	let startY = /* @__PURE__ */ new Float64Array(0);
	let endX = /* @__PURE__ */ new Float64Array(0);
	let endY = /* @__PURE__ */ new Float64Array(0);
	let nextX = /* @__PURE__ */ new Float64Array(0);
	let nextY = /* @__PURE__ */ new Float64Array(0);
	let t0 = /* @__PURE__ */ new Float64Array(0);
	let lastSeen = /* @__PURE__ */ new Float64Array(0);
	let startHeading = /* @__PURE__ */ new Float32Array(0);
	let endHeading = /* @__PURE__ */ new Float32Array(0);
	let nextHeading = /* @__PURE__ */ new Float32Array(0);
	let style = /* @__PURE__ */ new Uint8Array(0);
	let flags = /* @__PURE__ */ new Uint8Array(0);
	let dirty = /* @__PURE__ */ new Int32Array(0);
	let instances = /* @__PURE__ */ new Float32Array(0);
	function grow(nextCapacity) {
		const copy64 = (from) => {
			const to = new Float64Array(nextCapacity);
			to.set(from.subarray(0, count));
			return to;
		};
		const copy32 = (from) => {
			const to = new Float32Array(nextCapacity);
			to.set(from.subarray(0, count));
			return to;
		};
		const copy8 = (from) => {
			const to = new Uint8Array(nextCapacity);
			to.set(from.subarray(0, count));
			return to;
		};
		ids = copy64(ids);
		startX = copy64(startX);
		startY = copy64(startY);
		endX = copy64(endX);
		endY = copy64(endY);
		nextX = copy64(nextX);
		nextY = copy64(nextY);
		t0 = copy64(t0);
		lastSeen = copy64(lastSeen);
		startHeading = copy32(startHeading);
		endHeading = copy32(endHeading);
		nextHeading = copy32(nextHeading);
		style = copy8(style);
		flags = copy8(flags);
		const nextDirty = new Int32Array(nextCapacity);
		nextDirty.set(dirty.subarray(0, dirtyCount));
		dirty = nextDirty;
		const nextInstances = new Float32Array(nextCapacity * 8);
		nextInstances.set(instances.subarray(0, count * 8));
		instances = nextInstances;
		capacity = nextCapacity;
	}
	function writeInstance(slot) {
		const base = slot * 8;
		instances[base] = (startX[slot] ?? 0) - originX;
		instances[base + 1] = (startY[slot] ?? 0) - originY;
		instances[base + 2] = (endX[slot] ?? 0) - originX;
		instances[base + 3] = (endY[slot] ?? 0) - originY;
		instances[base + 4] = t0[slot] ?? 0;
		instances[base + 5] = startHeading[slot] ?? 0;
		instances[base + 6] = endHeading[slot] ?? 0;
		instances[base + 7] = style[slot] ?? 0;
	}
	function markDirty(slot) {
		if ((flags[slot] ?? 0) & FLAG_DIRTY) return;
		flags[slot] = (flags[slot] ?? 0) | FLAG_DIRTY;
		dirty[dirtyCount++] = slot;
	}
	function displayedAt(slot, now) {
		const fraction = Math.min(1, Math.max(0, (now - (t0[slot] ?? 0)) / glideSeconds));
		const fromX = startX[slot] ?? 0;
		const fromY = startY[slot] ?? 0;
		return [fromX + ((endX[slot] ?? 0) - fromX) * fraction, fromY + ((endY[slot] ?? 0) - fromY) * fraction];
	}
	grow(initialCapacity);
	return {
		get count() {
			return count;
		},
		get instances() {
			return instances;
		},
		get origin() {
			return [originX, originY];
		},
		get glideSeconds() {
			return glideSeconds;
		},
		/** README: Writes the newest report; the glide starts at the next commit. Heading in radians. */
		put(id, x, y, heading, now) {
			let slot = slotById.get(id);
			if (slot === void 0) {
				if (count === capacity) grow(capacity * 2);
				slot = count++;
				ids[slot] = id;
				slotById.set(id, slot);
				flags[slot] = FLAG_NEW;
			} else {
				const gap = now - (lastSeen[slot] ?? now);
				if (gap > .05 && gap < 3 * glideSeconds) {
					gapSum += gap;
					gapCount++;
				}
			}
			nextX[slot] = x;
			nextY[slot] = y;
			nextHeading[slot] = heading;
			lastSeen[slot] = now;
			markDirty(slot);
		},
		/** README: Returns true when the style changed, so the caller knows a new frame is needed. */
		setStyle(id, value) {
			const slot = slotById.get(id);
			if (slot === void 0 || style[slot] === value) return false;
			style[slot] = value;
			instances[slot * 8 + 7] = value;
			return true;
		},
		remove(id) {
			const slot = slotById.get(id);
			if (slot === void 0) return;
			const last = count - 1;
			slotById.delete(id);
			if (slot !== last) {
				const lastId = ids[last] ?? 0;
				for (const field of [
					ids,
					startX,
					startY,
					endX,
					endY,
					nextX,
					nextY,
					t0,
					lastSeen
				]) field[slot] = field[last] ?? 0;
				for (const field of [
					startHeading,
					endHeading,
					nextHeading
				]) field[slot] = field[last] ?? 0;
				style[slot] = style[last] ?? 0;
				flags[slot] = flags[last] ?? 0;
				instances.copyWithin(slot * 8, last * 8, (last + 1) * 8);
				slotById.set(lastId, slot);
				for (let index = 0; index < dirtyCount; index++) if (dirty[index] === last) dirty[index] = slot;
			}
			count--;
		},
		/** README: Starts a glide for every track updated since the last commit, from where it is drawn now to its newest report. */
		commit(now) {
			const committed = dirtyCount;
			for (let index = 0; index < committed; index++) {
				const slot = dirty[index] ?? 0;
				if (slot >= count) continue;
				if ((flags[slot] ?? 0) & FLAG_NEW) {
					startX[slot] = endX[slot] = nextX[slot] ?? 0;
					startY[slot] = endY[slot] = nextY[slot] ?? 0;
					startHeading[slot] = endHeading[slot] = nextHeading[slot] ?? 0;
				} else {
					const fraction = Math.min(1, Math.max(0, (now - (t0[slot] ?? 0)) / glideSeconds));
					const [x, y] = displayedAt(slot, now);
					startX[slot] = x;
					startY[slot] = y;
					startHeading[slot] = lerpAngle(startHeading[slot] ?? 0, endHeading[slot] ?? 0, fraction);
					endX[slot] = nextX[slot] ?? 0;
					endY[slot] = nextY[slot] ?? 0;
					endHeading[slot] = nextHeading[slot] ?? 0;
				}
				t0[slot] = now;
				flags[slot] = 0;
				writeInstance(slot);
			}
			dirtyCount = 0;
			return committed;
		},
		setOrigin(x, y) {
			originX = x;
			originY = y;
			for (let slot = 0; slot < count; slot++) writeInstance(slot);
		},
		/** README: Mean seconds between two reports of the same track since the last call; 0 when there are too few samples. */
		takeUpdateInterval() {
			const interval = gapCount >= 20 ? gapSum / gapCount : 0;
			gapSum = 0;
			gapCount = 0;
			return interval;
		},
		setGlideSeconds(seconds) {
			glideSeconds = seconds;
		},
		instanceOf(id) {
			const slot = slotById.get(id);
			if (slot === void 0) return null;
			return instances.slice(slot * 8, (slot + 1) * 8);
		},
		/** README: Nearest drawn track within `radius` mercator units of the point, or null. */
		pick(x, y, radius, now) {
			let bestId = null;
			let bestDistance = radius * radius;
			for (let slot = 0; slot < count; slot++) {
				if ((style[slot] ?? 0) >= 8) continue;
				const [trackX, trackY] = displayedAt(slot, now);
				const distance = (trackX - x) ** 2 + (trackY - y) ** 2;
				if (distance >= bestDistance) continue;
				bestDistance = distance;
				bestId = ids[slot] ?? null;
			}
			return bestId;
		},
		/** README: Drawn tracks inside a convex mercator polygon (the unprojected selection box). */
		pickInPolygon(polygon, now) {
			const found = [];
			for (let slot = 0; slot < count; slot++) {
				if ((style[slot] ?? 0) >= 8) continue;
				const [x, y] = displayedAt(slot, now);
				if (isInConvexPolygon(polygon, x, y)) found.push(ids[slot] ?? 0);
			}
			return found;
		}
	};
}
// .build/step-4/apps/utm/src/worker/live-tracks/track-store.test.ts
describe$1("live track GPU store", () => {
	it$1("starts each glide where the track is drawn now, not at its last report", () => {
		expect.hasAssertions();
		const store = createTrackStore();
		store.put(1, .1, .1, 0, 0);
		store.commit(0);
		store.put(1, .2, .1, 0, 1);
		store.commit(1);
		store.put(1, .3, .1, 0, 1.575);
		store.commit(1.575);
		const [startX = 0, , endX = 0] = store.instanceOf(1) ?? [];
		expect(startX + store.origin[0]).toBeCloseTo(.15, 6);
		expect(endX + store.origin[0]).toBeCloseTo(.3, 6);
	});
	it$1("keeps slots dense after removal and grows past its first capacity", () => {
		expect.hasAssertions();
		const store = createTrackStore(2);
		for (const id of [
			1,
			2,
			3
		]) store.put(id, id / 10, id / 10, 0, 0);
		store.commit(0);
		store.remove(1);
		expect(store.count).toBe(2);
		expect(store.instanceOf(1)).toBeNull();
		expect(store.pick(.3, .3, .01, 1)).toBe(3);
	});
	it$1("does not pick hidden (clustered or filtered) tracks", () => {
		expect.hasAssertions();
		const store = createTrackStore();
		store.put(2, .2, .2, 0, 0);
		store.put(3, .3, .3, 0, 0);
		store.commit(0);
		expect(store.setStyle(3, 8)).toBe(true);
		expect(store.pick(.3, .3, .01, 1)).toBeNull();
		expect(store.pickInPolygon([
			[.15, .15],
			[.35, .15],
			[.35, .35],
			[.15, .35]
		], 1)).toEqual([2]);
	});
});
export {};
