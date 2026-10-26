import { describe, expect, it } from 'vite-plus/test'

import { createTrackStore, TRACK_STYLE_HIDDEN } from './track-store'

describe('live track GPU store', () => {
  it('starts each glide where the track is drawn now, not at its last report', () => {
    expect.hasAssertions()

    const store = createTrackStore()
    store.put(1, 0.1, 0.1, 0, 0)
    store.commit(0)
    store.put(1, 0.2, 0.1, 0, 1)
    store.commit(1)
    // README: 0.575 s into a 1.15 s glide from x=0.1 to x=0.2, the track is drawn at x=0.15.
    store.put(1, 0.3, 0.1, 0, 1.575)
    store.commit(1.575)
    const [startX = 0, , endX = 0] = store.instanceOf(1) ?? []

    expect(startX + store.origin[0]).toBeCloseTo(0.15, 6)
    expect(endX + store.origin[0]).toBeCloseTo(0.3, 6)
  })

  it('keeps slots dense after removal and grows past its first capacity', () => {
    expect.hasAssertions()

    const store = createTrackStore(2)
    for (const id of [1, 2, 3]) store.put(id, id / 10, id / 10, 0, 0)
    store.commit(0)
    store.remove(1)

    expect(store.count).toBe(2)
    expect(store.instanceOf(1)).toBeNull()
    expect(store.pick(0.3, 0.3, 0.01, 1)).toBe(3)
  })

  it('does not pick hidden (clustered or filtered) tracks', () => {
    expect.hasAssertions()

    const store = createTrackStore()
    store.put(2, 0.2, 0.2, 0, 0)
    store.put(3, 0.3, 0.3, 0, 0)
    store.commit(0)

    expect(store.setStyle(3, TRACK_STYLE_HIDDEN)).toBe(true)
    expect(store.pick(0.3, 0.3, 0.01, 1)).toBeNull()
    expect(
      store.pickInPolygon(
        [
          [0.15, 0.15],
          [0.35, 0.15],
          [0.35, 0.35],
          [0.15, 0.35],
        ],
        1,
      ),
    ).toEqual([2])
  })
})
