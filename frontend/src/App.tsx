import { useEffect, useMemo, useState } from "react";
import MapGL, { MapProvider, NavigationControl, ScaleControl } from "react-map-gl/maplibre";
import * as maplibregl from "maplibre-gl";
import { api, type AppConfig } from "./api.ts";
import { ClusterLayers } from "./map/ClusterLayers.tsx";
import { DroneLayer } from "./map/DroneLayer.tsx";
import { MapInteractions } from "./map/MapInteractions.tsx";
import { MAP_ID, TrackingProvider, useTracking, useTrackingActions, useUiSelector } from "./map/TrackingProvider.tsx";
import { CLUSTER_LAYER } from "./map/tracking.ts";
import { ViewportSync } from "./map/ViewportSync.tsx";
import { Toolbar } from "./components/Toolbar.tsx";
import { PerfHud } from "./components/PerfHud.tsx";
import { TrackPanel } from "./components/TrackPanel.tsx";

const MAP_STYLE =
  (import.meta.env.VITE_MAP_STYLE as string | undefined) ?? "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

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
  const margin = params.has("margin") ? Number(params.get("margin")) : cfg.defaultMargin;
  return (
    <TrackingProvider cfg={cfg} margin={margin}>
      <MapProvider>
        <TrackingView params={params} />
      </MapProvider>
    </TrackingProvider>
  );
}

function TrackingView({ params }: { params: URLSearchParams }) {
  const tracking = useTracking();
  const { setStress } = useTrackingActions();
  const mode = useUiSelector((s) => s.mode);
  const hasSelection = useUiSelector((s) => s.selectedId !== null);
  // the map-bound hooks need a loaded style (the custom layer cannot be added before)
  const [loaded, setLoaded] = useState(false);

  const initialViewState = {
    // Southeast Asia, where the simulator flies every drone
    longitude: Number(params.get("lon") ?? 113),
    latitude: Number(params.get("lat") ?? 8),
    zoom: Number(params.get("zoom") ?? 3.6),
  };

  return (
    <div className="app">
      <MapGL
        id={MAP_ID}
        mapLib={maplibregl}
        initialViewState={initialViewState}
        mapStyle={MAP_STYLE}
        style={{ position: "absolute", inset: 0 }}
        maxPitch={60}
        attributionControl={{ compact: true }}
        interactiveLayerIds={[CLUSTER_LAYER]}
        cursor={mode === "cluster" ? "default" : "crosshair"}
        onLoad={(e) => {
          (window as unknown as { __app: unknown }).__app = { map: e.target, tracking }; // for automation / devtools
          setLoaded(true);
          const stress = params.get("stress") ?? (params.get("firehose") === "1" ? "all" : null);
          if (stress) void setStress(stress === "all" ? -1 : Number(stress));
        }}
      >
        <ClusterLayers />
        {loaded && (
          <>
            <DroneLayer />
            <ViewportSync />
            <MapInteractions />
          </>
        )}
        <NavigationControl position="bottom-right" visualizePitch />
        <ScaleControl position="bottom-right" />
      </MapGL>

      <Toolbar />
      <PerfHud />
      {hasSelection && <TrackPanel />}
    </div>
  );
}
