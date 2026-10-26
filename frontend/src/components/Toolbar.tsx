import { compact, type UiState } from "../map/tracking.ts";
import type { OverLimit } from "../source.ts";
import { useTracking, useTrackingActions, useUiState } from "../map/TrackingProvider.tsx";
import { CITIES } from "../cities.ts";

const MARGINS: { v: number; label: string }[] = [
  { v: 0, label: "0" },
  { v: 0.25, label: "¼" },
  { v: 0.5, label: "½" },
  { v: 1, label: "1" },
  { v: 2, label: "2" },
];

export function Toolbar() {
  const s = useUiState();
  const { cfg, source } = useTracking();
  const actions = useTrackingActions();
  const total = s.cluster?.total;
  const connected = s.status.state === "connected";
  return (
    <section className="panel toolbar">
      <header className="brand">
        <div className="logo" aria-hidden>
          <span />
          <span />
          <span />
          <span />
        </div>
        <div>
          <h1>Drone Tracks</h1>
          <p className="muted">
            {total ? `${total.toLocaleString()} drones live` : "1M drones"} · {cfg.publishIntervalMs / 1000}s ticks
          </p>
        </div>
        <span className={`dot ${connected ? "ok" : s.status.state === "error" ? "bad" : "warn"}`} title={`NATS ${s.status.state} ${s.status.detail ?? ""}`} />
      </header>

      <ModeLine s={s} firehose={source.firehose} />

      <div className="row">
        <label className="field">
          <span>Fly to</span>
          <select
            value=""
            onChange={(e) => {
              const c = CITIES.find((x) => x.name === e.target.value);
              if (c) actions.flyTo(c.lon, c.lat, 13.6);
            }}
          >
            <option value="" disabled>
              City…
            </option>
            {CITIES.map((c) => (
              <option key={c.name}>{c.name}</option>
            ))}
          </select>
        </label>
        <button className="btn" onClick={() => void actions.flyToHottest()} title="Fly to the z13 tile with the most drones">
          Densest tile
        </button>
      </div>

      <div className="row">
        <span className="field-label" title="Prefetched area around the viewport, in viewport sizes per side">
          Prefetch
        </span>
        <div className="seg" role="group" aria-label="Prefetch margin">
          {MARGINS.map((m) => (
            <button key={m.v} className={s.margin === m.v ? "on" : ""} onClick={() => actions.setMargin(m.v)}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <label className="field" title={`Ignore the viewport and subscribe to the densest tiles, or to ${source.firehose} (every drone)`}>
        <span>Stress test</span>
        <select value={s.stress} onChange={(e) => void actions.setStress(Number(e.target.value))}>
          <option value={0}>Off (viewport topics)</option>
          <option value={100}>Densest 100 tiles</option>
          <option value={400}>Densest 400 tiles</option>
          <option value={-1}>Firehose: all 1M drones</option>
        </select>
      </label>

      {s.mode === "cluster" && <p className="hint">Zoom to 13+ or click a cluster to see individual drones.</p>}
      {s.mode !== "cluster" && s.topics?.truncated && <p className="hint warn">Topic list capped at {cfg.maxTopics} tiles.</p>}
      {s.mode !== "cluster" && s.topics?.overLimit && <p className="hint warn">{overLimitText(s.topics.overLimit)}</p>}
      {s.error && <p className="hint bad">{s.error}</p>}
    </section>
  );
}

function overLimitText(o: OverLimit): string {
  const max = o.max.toLocaleString();
  if (o.limit === "max_partitions") return `${o.regions} regions in view, over the limit of ${max}. Zoom in to see live tracks.`;
  if (o.regions <= 1) return `This region alone has about ${compact(o.estimated)} tracks, over the limit of ${max}, so it cannot be shown live.`;
  return `About ${compact(o.estimated)} tracks in ${o.regions} regions, over the limit of ${max}. Zoom in to see live tracks.`;
}

function ModeLine({ s, firehose }: { s: UiState; firehose: string }) {
  if (s.mode === "stress")
    return (
      <div className="mode stress">
        <b>STRESS</b> {s.stress < 0 ? firehose : `densest ${s.stress} tiles`} · {compact(s.worker?.tracks ?? 0)} in memory
      </div>
    );
  if (s.mode === "realtime") {
    const inView = s.topics?.viewportTiles;
    const expected = s.topics?.expectedTracks;
    return (
      <div className="mode realtime">
        <b>REALTIME</b> {s.topics?.count ?? 0} topics{inView != null && ` (${inView} in view)`} ·{" "}
        {expected != null ? `~${compact(expected)}` : compact(s.worker?.tracks ?? 0)} tracks
      </div>
    );
  }
  return (
    <div className="mode cluster">
      <b>CLUSTERS</b> z{s.zoom.toFixed(1)} → L{s.cluster?.level ?? "–"} · {s.cluster?.cells ?? 0} cells · {compact(s.cluster?.inView ?? 0)} in view
    </div>
  );
}
