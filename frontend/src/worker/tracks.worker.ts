// Tracks worker: owns the NATS WebSocket connection, the subscriptions and the track table, so
// decoding never competes with rendering on the UI thread. It ships the GPU instance buffer to
// the UI thread as transferable ArrayBuffers (pooled; at most MAX_OUTSTANDING in flight).

import { wsconnect, type Msg, type NatsConnection, type Subscription } from "@nats-io/nats-core";
import { STRIDE, TrackStore } from "../shared/trackStore.ts";
import { ClockOffset, LatencyWindow } from "../shared/metrics.ts";
import { makeClock, wallMs } from "../shared/clock.ts";
import { subjectTileKey } from "../shared/tiles.ts";
import type { FromWorker, SelectedFrame, ToWorker } from "../shared/protocol.ts";

const ctx = self as unknown as {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
};
const post = (m: FromWorker, transfer: Transferable[] = []) => ctx.postMessage(m, transfer);

const LINGER_S = 3; // keep a dropped subscription alive briefly in case the user pans back
const MAX_OUTSTANDING = 3; // frame buffers in flight to the UI thread
const UPLOAD_BUDGET_BPS = 50e6; // adapt the frame rate so huge stores do not flood the UI thread

let nc: NatsConnection | null = null;
let clock = () => 0;
const store = new TrackStore();
let staleSec = 1.5;
let staleFactor = 1.5;
let intervalS = 1;

const subs = new Map<string, { sub: Subscription; lingerUntil: number }>();
let wanted: string[] = [];
let override: string[] | null = null;
let selectedId: number | null = null;
let frameDirty = true;
let lastEvict = 0;

const pool: ArrayBuffer[] = [];
let outstanding = 0;

// metrics for the current 1 s window
const m = { msgs: 0, tracks: 0, bytes: 0, busyMs: 0, decodeMs: 0, frames: 0, skipped: 0, frameBytes: 0 };
let bad = 0;
let reconnects = 0;
let slowConsumer = 0;
const latency = new LatencyWindow();
const clockOffset = new ClockOffset();

function onMsg(err: Error | null, msg: Msg) {
  if (err) return;
  const recvWall = wallMs();
  const t = performance.now();
  const r = store.ingest(msg.data, clock());
  if (!r.header) {
    bad++;
    return;
  }
  m.msgs++;
  m.tracks += r.tracks;
  m.bytes += msg.data.byteLength;
  latency.add(recvWall + clockOffset.offsetMs - r.header.publishedAt);
  if (r.header.intervalMs && r.header.intervalMs / 1000 !== intervalS) setInterval_(r.header.intervalMs / 1000);
  const dt = performance.now() - t;
  m.decodeMs += dt;
  m.busyMs += dt;
}

function setInterval_(s: number) {
  intervalS = s;
  store.interp = s * 1.15;
  staleSec = s * staleFactor;
}

function applyTopics() {
  if (!nc) return;
  const now = clock();
  const want = new Set(override ?? wanted);
  for (const s of want) {
    const e = subs.get(s);
    if (e) e.lingerUntil = 0;
    else subs.set(s, { sub: nc.subscribe(s, { callback: onMsg }), lingerUntil: 0 });
  }
  for (const [s, e] of subs) if (!want.has(s) && e.lingerUntil === 0) e.lingerUntil = now + LINGER_S;
}

function expireLingering(now: number) {
  let dropped: Set<number> | null = null;
  for (const [s, e] of subs) {
    if (e.lingerUntil && now >= e.lingerUntil) {
      e.sub.unsubscribe();
      subs.delete(s);
      (dropped ??= new Set()).add(subjectTileKey(s));
    }
  }
  if (dropped) store.dropTiles(dropped);
}

function setOverride(list: string[] | null) {
  override = list;
  for (const e of subs.values()) e.sub.unsubscribe();
  subs.clear();
  store.clear();
  frameDirty = true;
  applyTopics();
}

function selectedFrame(): SelectedFrame | null {
  if (selectedId === null) return null;
  const info = store.info(selectedId);
  const inst = info ? store.inst.slice(info.slot * STRIDE, info.slot * STRIDE + STRIDE) : null;
  return { info, inst };
}

function postFrame() {
  if (outstanding >= MAX_OUTSTANDING) {
    m.skipped++;
    frameDirty = true;
    return;
  }
  const floats = store.n * STRIDE;
  const need = floats * 4;
  let i = pool.findIndex((b) => b.byteLength >= need);
  let buf: ArrayBuffer;
  if (i >= 0) {
    buf = pool[i];
    pool.splice(i, 1);
  } else {
    buf = new ArrayBuffer(Math.max(4096, Math.ceil((need * 1.25) / 4096) * 4096));
  }
  new Float32Array(buf, 0, floats).set(store.inst.subarray(0, floats));
  outstanding++;
  m.frames++;
  m.frameBytes += need;
  frameDirty = false;
  post({ type: "frame", buf, n: store.n, ox: store.ox, oy: store.oy, interp: store.interp, selected: selectedFrame() }, [buf]);
}

function frameLoop() {
  const t = performance.now();
  const now = clock();
  const committed = store.commit(now);
  let removed = 0;
  if (now - lastEvict > 0.25) {
    expireLingering(now);
    removed = store.evict(now - staleSec);
    lastEvict = now;
  }
  if (committed || removed || frameDirty) postFrame();
  m.busyMs += performance.now() - t;
  const interval = Math.min(1000, Math.max(33, ((store.n * STRIDE * 4) / UPLOAD_BUDGET_BPS) * 1000));
  setTimeout(frameLoop, interval);
}

function reportStats() {
  const lat = latency.take();
  post({
    type: "stats",
    stats: {
      subscriptions: subs.size,
      tracks: store.n,
      msgsPerSec: m.msgs,
      tracksPerSec: m.tracks,
      bytesPerSec: m.bytes,
      busyMsPerSec: m.busyMs,
      decodeUsPerMsg: m.msgs ? (m.decodeMs * 1000) / m.msgs : 0,
      framesPerSec: m.frames,
      framesSkipped: m.skipped,
      frameBytes: m.frames ? m.frameBytes / m.frames : 0,
      latency: lat,
      clockOffsetMs: clockOffset.offsetMs,
      clockRttMs: clockOffset.rttMs,
      reconnects,
      slowConsumer,
      badMessages: bad,
    },
  });
  for (const k of Object.keys(m) as (keyof typeof m)[]) m[k] = 0;
}

async function syncClock(samples: number) {
  for (let i = 0; i < samples && nc && !nc.isClosed(); i++) {
    try {
      const sent = wallMs();
      const r = await nc.request("svc.time", undefined, { timeout: 2000 });
      const recv = wallMs();
      const server = new DataView(r.data.buffer, r.data.byteOffset, 8).getFloat64(0, true);
      clockOffset.add(sent, server, recv);
    } catch {
      /* the responder may be starting; try again later */
    }
    await new Promise((res) => setTimeout(res, 150));
  }
}

async function connect(url: string, user: string, pass: string) {
  post({ type: "status", state: "connecting", detail: url });
  try {
    nc = await wsconnect({
      servers: url,
      user,
      pass,
      name: "drone-viewer",
      maxReconnectAttempts: -1,
      reconnectTimeWait: 1000,
      waitOnFirstConnect: true,
      pingInterval: 20_000,
    });
  } catch (e) {
    post({ type: "status", state: "error", detail: String(e) });
    return;
  }
  post({ type: "status", state: "connected", detail: nc.getServer() });
  applyTopics();
  void syncClock(6);
  setInterval(() => {
    clockOffset.rttMs = Infinity; // re-estimate periodically: clocks drift
    void syncClock(3);
  }, 30_000);
  (async () => {
    for await (const s of nc!.status()) {
      switch (s.type) {
        case "disconnect":
          post({ type: "status", state: "disconnected", detail: s.server });
          break;
        case "reconnecting":
          post({ type: "status", state: "reconnecting" });
          break;
        case "reconnect":
          reconnects++;
          post({ type: "status", state: "connected", detail: s.server });
          break;
        case "slowConsumer":
          slowConsumer++;
          break;
        case "error":
          post({ type: "status", state: "error", detail: String(s.error) });
          break;
      }
    }
  })();
}

ctx.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case "init":
      clock = makeClock(msg.epochMs);
      staleFactor = msg.staleFactor;
      setInterval_(msg.intervalMs / 1000);
      void connect(msg.url, msg.user, msg.pass);
      setTimeout(frameLoop, 33);
      setInterval(reportStats, 1000);
      break;
    case "topics":
      wanted = msg.subjects;
      if (store.setOrigin(msg.origin[0], msg.origin[1])) frameDirty = true;
      applyTopics();
      break;
    case "override":
      store.setOrigin(msg.origin[0], msg.origin[1]);
      setOverride(msg.subjects);
      break;
    case "select":
      selectedId = msg.id;
      frameDirty = true;
      break;
    case "pick": {
      const s = store.pick(msg.mx, msg.my, msg.radius, clock());
      post({ type: "picked", reqId: msg.reqId, id: s >= 0 ? store.ids[s] : null });
      break;
    }
    case "release":
      outstanding = Math.max(0, outstanding - 1);
      if (pool.length < MAX_OUTSTANDING) pool.push(msg.buf);
      break;
  }
};
