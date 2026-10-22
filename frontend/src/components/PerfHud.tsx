import { useState } from "react";
import type { UiState } from "../map/controller.ts";

const n0 = (v: number) => Math.round(v).toLocaleString();
const n1 = (v: number) => v.toFixed(1);
const kb = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)} MB/s` : `${(v / 1e3).toFixed(0)} KB/s`);

export function PerfHud({ state: s }: { state: UiState }) {
  const [open, setOpen] = useState(true);
  const w = s.worker;
  const m = s.main;
  return (
    <section className={`panel hud ${open ? "" : "closed"}`}>
      <button className="hud-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>Performance</span>
        <span className="muted">{m ? `${m.fps} fps` : ""}</span>
      </button>
      {open && (
        <div className="hud-body">
          <h3>NATS → worker</h3>
          <Row k="Subscriptions" v={w ? n0(w.subscriptions) : "–"} />
          <Row k="Messages" v={w ? `${n0(w.msgsPerSec)} /s` : "–"} />
          <Row k="Track updates" v={w ? `${n0(w.tracksPerSec)} /s` : "–"} />
          <Row k="Payload" v={w ? kb(w.bytesPerSec) : "–"} />
          <Row k="Decode" v={w ? `${n1(w.decodeUsPerMsg)} µs/msg` : "–"} />
          <Row k="Worker busy" v={w ? `${n1(w.busyMsPerSec / 10)} %` : "–"} warn={!!w && w.busyMsPerSec > 500} />
          <Row
            k="Latency p50/p99"
            v={w && w.latency.samples ? `${n1(w.latency.p50)} / ${n1(w.latency.p99)} ms` : "–"}
            warn={!!w && w.latency.p99 > 500}
          />
          <Row k="Clock offset" v={w && isFinite(w.clockRttMs) ? `${n1(w.clockOffsetMs)} ms (rtt ${n1(w.clockRttMs)})` : "–"} />
          <h3>Worker → GPU</h3>
          <Row k="Tracks in memory" v={w ? n0(w.tracks) : "–"} />
          <Row k="Frames posted" v={w ? `${w.framesPerSec} /s${w.framesSkipped ? ` (${w.framesSkipped} skipped)` : ""}` : "–"} />
          <Row k="GPU upload" v={m ? `${n1(m.uploadMBps)} MB/s · ${m.uploadMsAvg.toFixed(2)} ms` : "–"} />
          <Row k="Draw (CPU)" v={m ? `${m.drawMsAvg.toFixed(2)} ms` : "–"} />
          <Row k="Render" v={m ? `${m.fps} fps` : "–"} warn={!!m && m.fps < 30} />
          {m?.heapMB != null && <Row k="JS heap (UI)" v={`${n0(m.heapMB)} MB`} />}
          {w && (w.reconnects > 0 || w.slowConsumer > 0 || w.badMessages > 0) && (
            <Row k="Reconnects / slow / bad" v={`${w.reconnects} / ${w.slowConsumer} / ${w.badMessages}`} warn />
          )}
        </div>
      )}
    </section>
  );
}

function Row({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return (
    <div className={`hud-row ${warn ? "warn" : ""}`}>
      <span>{k}</span>
      <b>{v}</b>
    </div>
  );
}
