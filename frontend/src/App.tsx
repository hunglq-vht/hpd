import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import MapGL, { Layer, NavigationControl, ScaleControl, Source } from "react-map-gl/maplibre";
import * as maplibregl from "maplibre-gl";
import type { CircleLayerSpecification, SymbolLayerSpecification } from "maplibre-gl";
import { api, type AppConfig } from "./api.ts";
import { CLUSTER_LAYER, Controller } from "./map/controller.ts";
import { Toolbar } from "./components/Toolbar.tsx";
import { PerfHud } from "./components/PerfHud.tsx";
import { TrackPanel } from "./components/TrackPanel.tsx";

const MAP_STYLE =
  (import.meta.env.VITE_MAP_STYLE as string | undefined) ?? "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

const circlePaint: CircleLayerSpecification["paint"] = {
  "circle-radius": ["interpolate", ["linear"], ["sqrt", ["get", "count"]], 1, 7, 10, 11, 30, 16, 100, 24, 300, 34],
  "circle-color": ["step", ["get", "count"], "#22d3ee", 50, "#818cf8", 500, "#e879f9", 5000, "#fb7185", 30000, "#f97316"],
  "circle-opacity": 0.82,
  "circle-stroke-width": 1.5,
  "circle-stroke-color": "rgba(255,255,255,0.55)",
};

const labelLayout: SymbolLayerSpecification["layout"] = {
  "text-field": ["get", "label"],
  // the exact font stack the CARTO style uses, so its glyph server can serve it
  "text-font": ["Montserrat SemiBold", "Open Sans Bold", "Noto Sans Regular", "Noto Sans CJK JP Regular"],
  "text-size": 11,
  "text-allow-overlap": true,
  "text-ignore-placement": true,
};

export default function App() {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.config().then(setCfg, (e: Error) => setError(e.message));
  }, []);
  if (!cfg)
    return (
      <div className="splash">
        <div className="splash-card">
          <h1>Drone Tracks</h1>
          <p>{error ? `Cannot reach the API: ${error}` : "Loading tiling agreement…"}</p>
        </div>
      </div>
    );
  return <TrackingMap cfg={cfg} />;
}

function TrackingMap({ cfg }: { cfg: AppConfig }) {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const controller = useMemo(
    () => new Controller(cfg, { margin: params.has("margin") ? Number(params.get("margin")) : undefined }),
    [cfg, params],
  );
  useEffect(() => () => controller.detach(), [controller]);
  const s = useSyncExternalStore(controller.subscribe, controller.getState);

  const initialViewState = {
    // Southeast Asia, where the simulator flies every drone
    longitude: Number(params.get("lon") ?? 113),
    latitude: Number(params.get("lat") ?? 8),
    zoom: Number(params.get("zoom") ?? 3.6),
  };
  const showClusters = s.mode === "cluster" || (s.mode === "realtime" && !s.realtimeReady);
  const visibility = showClusters ? "visible" : "none";

  return (
    <div className="app">
      <MapGL
        mapLib={maplibregl}
        initialViewState={initialViewState}
        mapStyle={MAP_STYLE}
        style={{ position: "absolute", inset: 0 }}
        maxPitch={60}
        attributionControl={{ compact: true }}
        interactiveLayerIds={[CLUSTER_LAYER]}
        cursor={s.mode === "cluster" ? "default" : "crosshair"}
        onLoad={(e) => {
          controller.attach(e.target);
          const stress = params.get("stress") ?? (params.get("firehose") === "1" ? "all" : null);
          if (stress) void controller.setStress(stress === "all" ? -1 : Number(stress));
        }}
      >
        <Source id="clusters" type="geojson" data={s.clusters}>
          <Layer id={CLUSTER_LAYER} type="circle" paint={circlePaint} layout={{ visibility }} />
          <Layer
            id="clusters-label"
            type="symbol"
            layout={{ ...labelLayout, visibility }}
            paint={{ "text-color": "#ffffff", "text-halo-color": "rgba(15,23,42,0.85)", "text-halo-width": 1.2 }}
          />
        </Source>
        <NavigationControl position="bottom-right" visualizePitch />
        <ScaleControl position="bottom-right" />
      </MapGL>

      <Toolbar state={s} controller={controller} />
      <PerfHud state={s} />
      {s.selectedId !== null && <TrackPanel state={s} controller={controller} />}
    </div>
  );
}
