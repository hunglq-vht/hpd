// Client-side track table. Runs in the web worker (and in the Node benchmark).
//
// * Struct-of-arrays keyed by slot; a Map gives id -> slot. Removal is swap-with-last, so slots
//   0..n-1 are always dense and can be drawn with one instanced draw call.
// * `ingest` decodes a tile snapshot straight from the NATS payload into "pending" fields.
// * `commit` turns pending updates into GPU interpolation segments: each track animates from the
//   position it is currently displayed at to its newest reported position over `interp` seconds.
// * `inst` is the GPU instance buffer (float32, positions relative to an origin so that float32
//   keeps sub-pixel precision at street level).

import { HEADER_SIZE, HEADING_SCALE, RECORD_SIZE, readHeader, type TileHeader } from "./wire.ts";

/** Floats per instance: prev.xy, curr.xy, t0, prevHeading, heading, altitude, kind+flags. */
export const STRIDE = 9;

const F_DIRTY = 1;
const F_NEW = 2;

export interface TrackInfo {
  id: number;
  slot: number;
  lon: number;
  lat: number;
  mx: number;
  my: number;
  alt: number;
  speed: number;
  heading: number; // degrees
  kind: number;
  battery: number;
  lastSeen: number; // shared-clock seconds
  tileX: number;
  tileY: number;
}

export interface IngestResult {
  header: TileHeader | null;
  tracks: number;
}

export class TrackStore {
  n = 0;
  cap: number;
  /** seconds a track takes to glide to its newest position (slightly longer than the tick) */
  interp = 1.15;
  ox = 0.5;
  oy = 0.5;

  ids!: Uint32Array;
  slotOf = new Map<number, number>();
  px!: Float64Array; py!: Float64Array; // displayed segment start (absolute mercator)
  cx!: Float64Array; cy!: Float64Array; // displayed segment end
  nx!: Float64Array; ny!: Float64Array; // newest reported position (pending)
  t0!: Float64Array;
  ph!: Float32Array; h!: Float32Array; nh!: Float32Array;
  alt!: Float32Array; speed!: Float32Array;
  kind!: Uint8Array; battery!: Uint8Array; flags!: Uint8Array;
  lastSeen!: Float64Array;
  tile!: Int32Array;
  dirty!: Int32Array;
  dirtyN = 0;
  inst!: Float32Array;

  constructor(initialCap = 16384) {
    this.cap = 0;
    this.grow(initialCap);
  }

  private grow(cap: number) {
    const n = this.n;
    const f64 = (a?: Float64Array) => { const b = new Float64Array(cap); if (a) b.set(a.subarray(0, n)); return b; };
    const f32 = (a?: Float32Array) => { const b = new Float32Array(cap); if (a) b.set(a.subarray(0, n)); return b; };
    const u8 = (a?: Uint8Array) => { const b = new Uint8Array(cap); if (a) b.set(a.subarray(0, n)); return b; };
    this.ids = (() => { const b = new Uint32Array(cap); if (this.ids) b.set(this.ids.subarray(0, n)); return b; })();
    this.px = f64(this.px); this.py = f64(this.py);
    this.cx = f64(this.cx); this.cy = f64(this.cy);
    this.nx = f64(this.nx); this.ny = f64(this.ny);
    this.t0 = f64(this.t0); this.lastSeen = f64(this.lastSeen);
    this.ph = f32(this.ph); this.h = f32(this.h); this.nh = f32(this.nh);
    this.alt = f32(this.alt); this.speed = f32(this.speed);
    this.kind = u8(this.kind); this.battery = u8(this.battery); this.flags = u8(this.flags);
    this.tile = (() => { const b = new Int32Array(cap); if (this.tile) b.set(this.tile.subarray(0, n)); return b; })();
    const dirty = new Int32Array(cap);
    if (this.dirty) dirty.set(this.dirty.subarray(0, this.dirtyN));
    this.dirty = dirty;
    const inst = new Float32Array(cap * STRIDE);
    if (this.inst) inst.set(this.inst.subarray(0, n * STRIDE));
    this.inst = inst;
    this.cap = cap;
  }

  /** Decodes one tile snapshot. `now` is the shared clock in seconds. */
  ingest(data: Uint8Array, now: number): IngestResult {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const header = readHeader(data, dv);
    if (!header) return { header: null, tracks: 0 };
    const { x, y, count } = header;
    const scale = 1 / 2 ** header.zoom;
    const key = (x << header.zoom) | y;
    if (this.n + count > this.cap) this.grow(Math.max(this.cap * 2, this.n + count));

    const { slotOf, nx, ny, nh, alt, speed, kind, battery, lastSeen, tile, flags, dirty } = this;
    let o = HEADER_SIZE;
    for (let i = 0; i < count; i++, o += RECORD_SIZE) {
      const id = dv.getUint32(o, true);
      let s = slotOf.get(id);
      if (s === undefined) {
        s = this.n++;
        this.ids[s] = id;
        slotOf.set(id, s);
        flags[s] = F_NEW;
      }
      nx[s] = (x + dv.getUint16(o + 4, true) / 65536) * scale;
      ny[s] = (y + dv.getUint16(o + 6, true) / 65536) * scale;
      alt[s] = dv.getUint16(o + 8, true) / 10;
      nh[s] = dv.getUint16(o + 10, true) * HEADING_SCALE;
      speed[s] = dv.getUint16(o + 12, true) / 100;
      kind[s] = data[o + 14];
      battery[s] = data[o + 15];
      lastSeen[s] = now;
      tile[s] = key;
      if (!(flags[s] & F_DIRTY)) {
        flags[s] |= F_DIRTY;
        dirty[this.dirtyN++] = s;
      }
    }
    return { header, tracks: count };
  }

  /** Starts new interpolation segments for every track updated since the last commit. */
  commit(now: number): number {
    const { px, py, cx, cy, nx, ny, t0, ph, h, nh, flags, dirty, interp } = this;
    const count = this.dirtyN;
    for (let k = 0; k < count; k++) {
      const s = dirty[k];
      if (flags[s] & F_NEW) {
        px[s] = cx[s] = nx[s];
        py[s] = cy[s] = ny[s];
        ph[s] = h[s] = nh[s];
      } else {
        const f = Math.min(1, Math.max(0, (now - t0[s]) / interp));
        px[s] += (cx[s] - px[s]) * f;
        py[s] += (cy[s] - py[s]) * f;
        ph[s] = lerpAngle(ph[s], h[s], f);
        cx[s] = nx[s];
        cy[s] = ny[s];
        h[s] = nh[s];
      }
      t0[s] = now;
      flags[s] = 0;
      this.writeInst(s);
    }
    this.dirtyN = 0;
    return count;
  }

  /** Drops tracks not seen since `before`. Must run after commit (no pending dirty slots). */
  evict(before: number): number {
    let removed = 0;
    for (let s = this.n - 1; s >= 0; s--) {
      if (this.lastSeen[s] < before) {
        this.remove(s);
        removed++;
      }
    }
    return removed;
  }

  /** Marks every track of the given tiles as stale, so the next evict removes them. */
  dropTiles(keys: Set<number>) {
    if (keys.size === 0) return;
    for (let s = 0; s < this.n; s++) if (keys.has(this.tile[s])) this.lastSeen[s] = -Infinity;
  }

  clear() {
    this.n = 0;
    this.dirtyN = 0;
    this.slotOf.clear();
  }

  private remove(s: number) {
    const last = this.n - 1;
    this.slotOf.delete(this.ids[s]);
    if (s !== last) {
      this.ids[s] = this.ids[last];
      this.px[s] = this.px[last]; this.py[s] = this.py[last];
      this.cx[s] = this.cx[last]; this.cy[s] = this.cy[last];
      this.nx[s] = this.nx[last]; this.ny[s] = this.ny[last];
      this.t0[s] = this.t0[last]; this.lastSeen[s] = this.lastSeen[last];
      this.ph[s] = this.ph[last]; this.h[s] = this.h[last]; this.nh[s] = this.nh[last];
      this.alt[s] = this.alt[last]; this.speed[s] = this.speed[last];
      this.kind[s] = this.kind[last]; this.battery[s] = this.battery[last]; this.flags[s] = this.flags[last];
      this.tile[s] = this.tile[last];
      this.inst.copyWithin(s * STRIDE, last * STRIDE, last * STRIDE + STRIDE);
      this.slotOf.set(this.ids[s], s);
    }
    this.n--;
  }

  /** Re-bases float32 instance positions; call when the subscribed area moves. */
  setOrigin(ox: number, oy: number) {
    if (ox === this.ox && oy === this.oy) return false;
    this.ox = ox;
    this.oy = oy;
    for (let s = 0; s < this.n; s++) this.writeInst(s);
    return true;
  }

  private writeInst(s: number) {
    const b = s * STRIDE;
    const inst = this.inst;
    inst[b] = this.px[s] - this.ox;
    inst[b + 1] = this.py[s] - this.oy;
    inst[b + 2] = this.cx[s] - this.ox;
    inst[b + 3] = this.cy[s] - this.oy;
    inst[b + 4] = this.t0[s];
    inst[b + 5] = this.ph[s];
    inst[b + 6] = this.h[s];
    inst[b + 7] = this.alt[s];
    inst[b + 8] = this.kind[s] + (this.battery[s] < 20 ? 4 : 0);
  }

  /** Displayed (interpolated) absolute position of slot s at time now. */
  displayed(s: number, now: number): [number, number] {
    const f = Math.min(1, Math.max(0, (now - this.t0[s]) / this.interp));
    return [this.px[s] + (this.cx[s] - this.px[s]) * f, this.py[s] + (this.cy[s] - this.py[s]) * f];
  }

  /** Nearest displayed track within radius (mercator units), or -1. */
  pick(mx: number, my: number, radius: number, now: number): number {
    let best = -1;
    let bestD = radius * radius;
    for (let s = 0; s < this.n; s++) {
      const [x, y] = this.displayed(s, now);
      const dx = x - mx;
      const dy = y - my;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  info(id: number): TrackInfo | null {
    const s = this.slotOf.get(id);
    if (s === undefined) return null;
    const mx = this.nx[s];
    const my = this.ny[s];
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI;
    return {
      id, slot: s, mx, my, lon: mx * 360 - 180, lat,
      alt: this.alt[s], speed: this.speed[s], heading: (this.nh[s] * 180) / Math.PI,
      kind: this.kind[s], battery: this.battery[s], lastSeen: this.lastSeen[s],
      tileX: this.tile[s] >> 13, tileY: this.tile[s] & 8191,
    };
  }
}

export function lerpAngle(a: number, b: number, f: number): number {
  let d = b - a;
  if (d > Math.PI) d -= 2 * Math.PI;
  else if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * f;
}
