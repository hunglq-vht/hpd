// Binary tile snapshot decoder (docs/PROTOCOL.md section 3). Shared by the web worker and the
// Node benchmark, so it must stay free of DOM APIs.

export const WIRE_VERSION = 1;
export const MSG_TILE_SNAPSHOT = 1;
export const HEADER_SIZE = 32;
export const RECORD_SIZE = 16;

export interface TileHeader {
  zoom: number;
  x: number;
  y: number;
  seq: number;
  publishedAt: number; // unix ms
  count: number;
  intervalMs: number;
  part: number;
  parts: number;
}

/** Returns the header, or null if the message is malformed or of an unknown version. */
export function readHeader(data: Uint8Array, dv: DataView): TileHeader | null {
  if (data.byteLength < HEADER_SIZE || data[0] !== WIRE_VERSION || data[1] !== MSG_TILE_SNAPSHOT) return null;
  const count = dv.getUint32(24, true);
  if (data.byteLength < HEADER_SIZE + count * RECORD_SIZE) return null;
  return {
    zoom: data[2],
    x: dv.getUint32(4, true),
    y: dv.getUint32(8, true),
    seq: dv.getUint32(12, true),
    publishedAt: dv.getFloat64(16, true),
    count,
    intervalMs: dv.getUint16(28, true),
    part: data[30],
    parts: data[31],
  };
}

export const HEADING_SCALE = (2 * Math.PI) / 65536; // u16 -> radians

/** Test helper: encodes a snapshot the same way the Go simulator does. */
export function encodeSnapshot(
  h: Omit<TileHeader, "count">,
  recs: { id: number; lx: number; ly: number; altDm: number; heading: number; speedCms: number; type: number; battery: number }[],
): Uint8Array {
  const b = new Uint8Array(HEADER_SIZE + recs.length * RECORD_SIZE);
  const dv = new DataView(b.buffer);
  b[0] = WIRE_VERSION;
  b[1] = MSG_TILE_SNAPSHOT;
  b[2] = h.zoom;
  dv.setUint32(4, h.x, true);
  dv.setUint32(8, h.y, true);
  dv.setUint32(12, h.seq, true);
  dv.setFloat64(16, h.publishedAt, true);
  dv.setUint32(24, recs.length, true);
  dv.setUint16(28, h.intervalMs, true);
  b[30] = h.part;
  b[31] = h.parts;
  recs.forEach((r, i) => {
    const o = HEADER_SIZE + i * RECORD_SIZE;
    dv.setUint32(o, r.id, true);
    dv.setUint16(o + 4, r.lx, true);
    dv.setUint16(o + 6, r.ly, true);
    dv.setUint16(o + 8, r.altDm, true);
    dv.setUint16(o + 10, r.heading, true);
    dv.setUint16(o + 12, r.speedCms, true);
    b[o + 14] = r.type;
    b[o + 15] = r.battery;
  });
  return b;
}
