import { subjectOf } from "../api.ts";
import { useTracking, useTrackingActions, useUiState } from "../map/TrackingProvider.tsx";
import { KIND_COLORS, KIND_NAMES } from "../map/droneAtlas.ts";

const CARDINALS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export function TrackPanel() {
  const s = useUiState();
  const { cfg } = useTracking();
  const { select, setFollow } = useTrackingActions();
  const t = s.selected;
  const lost = s.selectionLost;
  const kind = t ? Math.min(3, t.kind) : 0;
  return (
    <section className="panel track" aria-label="Selected track">
      <header>
        <span className="kind-dot" style={{ background: KIND_COLORS[kind] }} />
        <div>
          <h2>Drone #{s.selectedId}</h2>
          <p className="muted">{t ? (t.model ?? KIND_NAMES[kind]) : "waiting for data…"}</p>
        </div>
        <span className={`badge ${lost ? "bad" : "ok"}`}>{lost ? "signal lost" : "live"}</span>
        <button className="icon-btn" onClick={() => select(null)} aria-label="Close (Esc)" title="Close (Esc)">
          ×
        </button>
      </header>

      <form className="track-form" onSubmit={(e) => e.preventDefault()}>
        <Field label="Longitude" value={t ? `${t.lon.toFixed(6)}°` : ""} />
        <Field label="Latitude" value={t ? `${t.lat.toFixed(6)}°` : ""} />
        <Field label="Altitude" value={t ? `${t.alt.toFixed(1)} m` : ""} />
        <Field label="Speed" value={t ? `${t.speed.toFixed(1)} m/s · ${(t.speed * 3.6).toFixed(0)} km/h` : ""} />
        <Field label="Heading" value={t ? `${t.heading.toFixed(0)}° ${CARDINALS[Math.round(t.heading / 45) % 8]}` : ""} />
        {cfg.backend === "u1" ? (
          <>
            <Field label="Mode 3/A" value={t?.mode3a ?? ""} mono />
            <Field label="Track number" value={t ? String(t.trackNo) : ""} />
            <Field label="Reported at" value={t?.updatedAt ? new Date(t.updatedAt).toLocaleTimeString() : ""} />
          </>
        ) : (
          <label className="ff">
            <span>Battery</span>
            <div className="battery">
              <div className={`fill ${t?.battery != null && t.battery < 20 ? "low" : ""}`} style={{ width: `${t?.battery ?? 0}%` }} />
              <b>{t?.battery != null ? `${t.battery}%` : ""}</b>
            </div>
          </label>
        )}
        <Field label="Topic" value={t ? subjectOf(cfg, t.tileX, t.tileY) : ""} mono />
        <Field label="Last update" value={t ? `${Math.round(t.ageMs)} ms ago` : ""} />
      </form>

      <footer>
        <label className="toggle">
          <input type="checkbox" checked={s.follow} onChange={(e) => setFollow(e.target.checked)} />
          <span>Follow</span>
        </label>
        <span className="muted small">Drag to stop following · Esc to close</span>
      </footer>
    </section>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <label className="ff">
      <span>{label}</span>
      <input readOnly value={value} className={mono ? "mono" : ""} tabIndex={-1} />
    </label>
  );
}
