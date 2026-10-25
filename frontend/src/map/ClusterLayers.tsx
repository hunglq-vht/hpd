// Cluster view (zoom < realtimeMinZoom): one circle and one label per stats cell. The layers stay
// visible after switching to realtime until the first live frame arrives, so the map is never blank.

import { Layer, Source } from "react-map-gl/maplibre";
import type { CircleLayerSpecification, SymbolLayerSpecification } from "maplibre-gl";
import { useUiSelector } from "./TrackingProvider.tsx";
import { CLUSTER_LAYER } from "./tracking.ts";

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

export function ClusterLayers() {
  const clusters = useUiSelector((s) => s.clusters);
  const visible = useUiSelector((s) => s.mode === "cluster" || (s.mode === "realtime" && !s.realtimeReady));
  const visibility = visible ? "visible" : "none";
  return (
    <Source id="clusters" type="geojson" data={clusters}>
      <Layer id={CLUSTER_LAYER} type="circle" paint={circlePaint} layout={{ visibility }} />
      <Layer
        id="clusters-label"
        type="symbol"
        layout={{ ...labelLayout, visibility }}
        paint={{ "text-color": "#ffffff", "text-halo-color": "rgba(15,23,42,0.85)", "text-halo-width": 1.2 }}
      />
    </Source>
  );
}
