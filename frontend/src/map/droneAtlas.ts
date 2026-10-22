// Draws the drone icons (one 64x64 cell per type) into a canvas at runtime, so the app ships no
// image assets. Every icon points north (up); the shader rotates it by heading.

export const ATLAS_CELL = 64;
export const ATLAS_KINDS = 4;

export const KIND_NAMES = ["Quadcopter", "Hexacopter", "Fixed-wing", "Emergency"] as const;
export const KIND_COLORS = ["#38bdf8", "#4ade80", "#fbbf24", "#f87171"] as const;

export function drawDroneAtlas(): ImageData {
  const c = document.createElement("canvas");
  c.width = ATLAS_CELL * ATLAS_KINDS;
  c.height = ATLAS_CELL;
  const g = c.getContext("2d")!;
  for (let k = 0; k < ATLAS_KINDS; k++) {
    g.save();
    g.translate(k * ATLAS_CELL + ATLAS_CELL / 2, ATLAS_CELL / 2);
    g.shadowColor = "rgba(0,0,0,0.75)";
    g.shadowBlur = 4;
    if (k === 2) drawFixedWing(g, KIND_COLORS[k]);
    else drawMulticopter(g, k === 1 ? 6 : 4, KIND_COLORS[k], k === 3);
    g.restore();
  }
  return g.getImageData(0, 0, c.width, c.height);
}

function drawMulticopter(g: CanvasRenderingContext2D, arms: number, color: string, emergency: boolean) {
  const armLen = arms === 6 ? 19 : 17;
  const rotorR = arms === 6 ? 7 : 9;
  const start = arms === 6 ? 0 : Math.PI / 4;
  g.lineCap = "round";
  // arms
  g.strokeStyle = "#cbd5e1";
  g.lineWidth = 4;
  for (let i = 0; i < arms; i++) {
    const a = start + (i * 2 * Math.PI) / arms;
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(Math.sin(a) * armLen, -Math.cos(a) * armLen);
    g.stroke();
  }
  // rotors
  for (let i = 0; i < arms; i++) {
    const a = start + (i * 2 * Math.PI) / arms;
    const x = Math.sin(a) * armLen;
    const y = -Math.cos(a) * armLen;
    g.beginPath();
    g.arc(x, y, rotorR, 0, Math.PI * 2);
    g.fillStyle = "rgba(226,232,240,0.30)";
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = "rgba(241,245,249,0.95)";
    g.stroke();
  }
  // body
  g.shadowBlur = 0;
  g.fillStyle = color;
  roundRect(g, -8, -9, 16, 18, 5);
  g.fill();
  g.lineWidth = 1.5;
  g.strokeStyle = "rgba(15,23,42,0.9)";
  g.stroke();
  if (emergency) {
    g.fillStyle = "#ffffff";
    g.fillRect(-1.5, -6, 3, 12);
    g.fillRect(-6, -1.5, 12, 3);
  }
  // nose
  g.fillStyle = "#ffffff";
  g.beginPath();
  g.moveTo(0, -15);
  g.lineTo(4.5, -8.5);
  g.lineTo(-4.5, -8.5);
  g.closePath();
  g.fill();
}

function drawFixedWing(g: CanvasRenderingContext2D, color: string) {
  g.fillStyle = color;
  g.strokeStyle = "rgba(15,23,42,0.9)";
  g.lineWidth = 1.5;
  g.beginPath();
  // fuselage + wings + tail, nose up
  g.moveTo(0, -26);
  g.quadraticCurveTo(4, -20, 4, -8);
  g.lineTo(27, 2);
  g.lineTo(27, 7);
  g.lineTo(4, 3);
  g.lineTo(3, 16);
  g.lineTo(11, 22);
  g.lineTo(11, 26);
  g.lineTo(0, 23);
  g.lineTo(-11, 26);
  g.lineTo(-11, 22);
  g.lineTo(-3, 16);
  g.lineTo(-4, 3);
  g.lineTo(-27, 7);
  g.lineTo(-27, 2);
  g.lineTo(-4, -8);
  g.quadraticCurveTo(-4, -20, 0, -26);
  g.closePath();
  g.fill();
  g.shadowBlur = 0;
  g.stroke();
  g.fillStyle = "rgba(255,255,255,0.85)";
  g.beginPath();
  g.ellipse(0, -15, 2, 4, 0, 0, Math.PI * 2);
  g.fill();
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Canvas ImageData is straight alpha; MapLibre blends premultiplied. */
export function premultiply(img: ImageData): Uint8Array {
  const src = img.data;
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3] / 255;
    out[i] = src[i] * a;
    out[i + 1] = src[i + 1] * a;
    out[i + 2] = src[i + 2] * a;
    out[i + 3] = src[i + 3];
  }
  return out;
}
