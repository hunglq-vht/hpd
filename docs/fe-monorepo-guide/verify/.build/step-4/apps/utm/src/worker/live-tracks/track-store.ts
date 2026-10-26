import { isInConvexPolygon } from './track-view'

/** README: Floats per GPU instance: start.xy, end.xy (mercator, relative to the origin), t0, start heading, end heading, style. */
export const TRACK_INSTANCE_STRIDE = 8
/** README: style = status index (TRACK_STATUSES order) + TRACK_STYLE_HIDDEN when the track is clustered or filtered out. */
export const TRACK_STYLE_HIDDEN = 8

const FLAG_DIRTY = 1
const FLAG_NEW = 2

function lerpAngle(from: number, to: number, fraction: number): number {
  let delta = to - from
  if (delta > Math.PI) delta -= 2 * Math.PI
  if (delta < -Math.PI) delta += 2 * Math.PI
  return from + delta * fraction
}

/** README: Struct-of-arrays track table for the GPU layer. Slots 0..count-1 stay dense (swap-remove), so one instanced draw call covers every track. Times are shared-clock seconds. */
export function createTrackStore(initialCapacity = 4096) {
  let count = 0
  let capacity = 0
  let glideSeconds = 1.15
  let originX = 0.5
  let originY = 0.5
  let gapSum = 0
  let gapCount = 0
  let dirtyCount = 0
  const slotById = new Map<number, number>()
  let ids = new Float64Array(0)
  let startX = new Float64Array(0)
  let startY = new Float64Array(0)
  let endX = new Float64Array(0)
  let endY = new Float64Array(0)
  let nextX = new Float64Array(0)
  let nextY = new Float64Array(0)
  let t0 = new Float64Array(0)
  let lastSeen = new Float64Array(0)
  let startHeading = new Float32Array(0)
  let endHeading = new Float32Array(0)
  let nextHeading = new Float32Array(0)
  let style = new Uint8Array(0)
  let flags = new Uint8Array(0)
  let dirty = new Int32Array(0)
  let instances = new Float32Array(0)

  function grow(nextCapacity: number) {
    const copy64 = (from: Float64Array) => {
      const to = new Float64Array(nextCapacity)
      to.set(from.subarray(0, count))
      return to
    }
    const copy32 = (from: Float32Array) => {
      const to = new Float32Array(nextCapacity)
      to.set(from.subarray(0, count))
      return to
    }
    const copy8 = (from: Uint8Array) => {
      const to = new Uint8Array(nextCapacity)
      to.set(from.subarray(0, count))
      return to
    }
    ids = copy64(ids)
    startX = copy64(startX)
    startY = copy64(startY)
    endX = copy64(endX)
    endY = copy64(endY)
    nextX = copy64(nextX)
    nextY = copy64(nextY)
    t0 = copy64(t0)
    lastSeen = copy64(lastSeen)
    startHeading = copy32(startHeading)
    endHeading = copy32(endHeading)
    nextHeading = copy32(nextHeading)
    style = copy8(style)
    flags = copy8(flags)
    const nextDirty = new Int32Array(nextCapacity)
    nextDirty.set(dirty.subarray(0, dirtyCount))
    dirty = nextDirty
    const nextInstances = new Float32Array(nextCapacity * TRACK_INSTANCE_STRIDE)
    nextInstances.set(instances.subarray(0, count * TRACK_INSTANCE_STRIDE))
    instances = nextInstances
    capacity = nextCapacity
  }

  function writeInstance(slot: number) {
    const base = slot * TRACK_INSTANCE_STRIDE
    instances[base] = (startX[slot] ?? 0) - originX
    instances[base + 1] = (startY[slot] ?? 0) - originY
    instances[base + 2] = (endX[slot] ?? 0) - originX
    instances[base + 3] = (endY[slot] ?? 0) - originY
    instances[base + 4] = t0[slot] ?? 0
    instances[base + 5] = startHeading[slot] ?? 0
    instances[base + 6] = endHeading[slot] ?? 0
    instances[base + 7] = style[slot] ?? 0
  }

  function markDirty(slot: number) {
    if ((flags[slot] ?? 0) & FLAG_DIRTY) return
    flags[slot] = (flags[slot] ?? 0) | FLAG_DIRTY
    dirty[dirtyCount++] = slot
  }

  function displayedAt(slot: number, now: number): [number, number] {
    const fraction = Math.min(1, Math.max(0, (now - (t0[slot] ?? 0)) / glideSeconds))
    const fromX = startX[slot] ?? 0
    const fromY = startY[slot] ?? 0
    return [fromX + ((endX[slot] ?? 0) - fromX) * fraction, fromY + ((endY[slot] ?? 0) - fromY) * fraction]
  }

  grow(initialCapacity)

  return {
    get count() {
      return count
    },
    get instances() {
      return instances
    },
    get origin(): [number, number] {
      return [originX, originY]
    },
    get glideSeconds() {
      return glideSeconds
    },
    /** README: Writes the newest report; the glide starts at the next commit. Heading in radians. */
    put(id: number, x: number, y: number, heading: number, now: number) {
      let slot = slotById.get(id)
      if (slot === undefined) {
        if (count === capacity) grow(capacity * 2)
        slot = count++
        ids[slot] = id
        slotById.set(id, slot)
        flags[slot] = FLAG_NEW
      } else {
        const gap = now - (lastSeen[slot] ?? now)
        if (gap > 0.05 && gap < 3 * glideSeconds) {
          gapSum += gap
          gapCount++
        }
      }
      nextX[slot] = x
      nextY[slot] = y
      nextHeading[slot] = heading
      lastSeen[slot] = now
      markDirty(slot)
    },
    /** README: Returns true when the style changed, so the caller knows a new frame is needed. */
    setStyle(id: number, value: number): boolean {
      const slot = slotById.get(id)
      if (slot === undefined || style[slot] === value) return false
      style[slot] = value
      instances[slot * TRACK_INSTANCE_STRIDE + 7] = value
      return true
    },
    remove(id: number) {
      const slot = slotById.get(id)
      if (slot === undefined) return
      const last = count - 1
      slotById.delete(id)
      if (slot !== last) {
        const lastId = ids[last] ?? 0
        for (const field of [ids, startX, startY, endX, endY, nextX, nextY, t0, lastSeen]) field[slot] = field[last] ?? 0
        for (const field of [startHeading, endHeading, nextHeading]) field[slot] = field[last] ?? 0
        style[slot] = style[last] ?? 0
        flags[slot] = flags[last] ?? 0
        instances.copyWithin(slot * TRACK_INSTANCE_STRIDE, last * TRACK_INSTANCE_STRIDE, (last + 1) * TRACK_INSTANCE_STRIDE)
        slotById.set(lastId, slot)
        // README: The moved track may sit in the dirty list under its old slot. A duplicate entry only restarts its glide.
        for (let index = 0; index < dirtyCount; index++) if (dirty[index] === last) dirty[index] = slot
      }
      count--
    },
    /** README: Starts a glide for every track updated since the last commit, from where it is drawn now to its newest report. */
    commit(now: number): number {
      const committed = dirtyCount
      for (let index = 0; index < committed; index++) {
        const slot = dirty[index] ?? 0
        if (slot >= count) continue
        if ((flags[slot] ?? 0) & FLAG_NEW) {
          startX[slot] = endX[slot] = nextX[slot] ?? 0
          startY[slot] = endY[slot] = nextY[slot] ?? 0
          startHeading[slot] = endHeading[slot] = nextHeading[slot] ?? 0
        } else {
          const fraction = Math.min(1, Math.max(0, (now - (t0[slot] ?? 0)) / glideSeconds))
          const [x, y] = displayedAt(slot, now)
          startX[slot] = x
          startY[slot] = y
          startHeading[slot] = lerpAngle(startHeading[slot] ?? 0, endHeading[slot] ?? 0, fraction)
          endX[slot] = nextX[slot] ?? 0
          endY[slot] = nextY[slot] ?? 0
          endHeading[slot] = nextHeading[slot] ?? 0
        }
        t0[slot] = now
        flags[slot] = 0
        writeInstance(slot)
      }
      dirtyCount = 0
      return committed
    },
    setOrigin(x: number, y: number) {
      originX = x
      originY = y
      for (let slot = 0; slot < count; slot++) writeInstance(slot)
    },
    /** README: Mean seconds between two reports of the same track since the last call; 0 when there are too few samples. */
    takeUpdateInterval(): number {
      const interval = gapCount >= 20 ? gapSum / gapCount : 0
      gapSum = 0
      gapCount = 0
      return interval
    },
    setGlideSeconds(seconds: number) {
      glideSeconds = seconds
    },
    instanceOf(id: number): Float32Array | null {
      const slot = slotById.get(id)
      if (slot === undefined) return null
      return instances.slice(slot * TRACK_INSTANCE_STRIDE, (slot + 1) * TRACK_INSTANCE_STRIDE)
    },
    /** README: Nearest drawn track within `radius` mercator units of the point, or null. */
    pick(x: number, y: number, radius: number, now: number): number | null {
      let bestId: number | null = null
      let bestDistance = radius * radius
      for (let slot = 0; slot < count; slot++) {
        if ((style[slot] ?? 0) >= TRACK_STYLE_HIDDEN) continue
        const [trackX, trackY] = displayedAt(slot, now)
        const distance = (trackX - x) ** 2 + (trackY - y) ** 2
        if (distance >= bestDistance) continue
        bestDistance = distance
        bestId = ids[slot] ?? null
      }
      return bestId
    },
    /** README: Drawn tracks inside a convex mercator polygon (the unprojected selection box). */
    pickInPolygon(polygon: readonly [number, number][], now: number): number[] {
      const found: number[] = []
      for (let slot = 0; slot < count; slot++) {
        if ((style[slot] ?? 0) >= TRACK_STYLE_HIDDEN) continue
        const [x, y] = displayedAt(slot, now)
        if (isInConvexPolygon(polygon, x, y)) found.push(ids[slot] ?? 0)
      }
      return found
    },
  }
}
