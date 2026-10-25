// Map input: a click picks a drone (or zooms into a cluster), dragging stops camera follow and Esc
// clears the selection. While following, wheel and pinch zoom pivot on the screen centre, that is,
// on the followed drone.

import { useEffect } from "react";
import { useMap } from "react-map-gl/maplibre";
import type { MapMouseEvent } from "maplibre-gl";
import { lonLatToMerc } from "../shared/tiles.ts";
import { useTracking, useUiSelector } from "./TrackingProvider.tsx";
import { CLUSTER_LAYER } from "./tracking.ts";

export function MapInteractions() {
  const tracking = useTracking();
  const mapRef = useMap().current!;
  const following = useUiSelector((s) => s.follow && s.selectedId !== null);

  useEffect(() => {
    const map = mapRef.getMap();
    const { cfg, store } = tracking;

    const onClick = async (e: MapMouseEvent) => {
      if (store.get().mode === "cluster") {
        const hit = map.queryRenderedFeatures(e.point, { layers: [CLUSTER_LAYER] })[0];
        if (hit && hit.geometry.type === "Point") {
          const z = map.getZoom();
          map.easeTo({ center: hit.geometry.coordinates as [number, number], zoom: z >= 10 ? cfg.realtimeMinZoom + 0.5 : z + 2.5, duration: 800 });
        }
        return;
      }
      const [mx, my] = lonLatToMerc(e.lngLat.lng, e.lngLat.lat);
      tracking.select(await tracking.pick(mx, my, 16 / (512 * 2 ** map.getZoom())));
    };
    const onDragStart = () => {
      const s = store.get();
      if (s.follow && s.selectedId !== null) store.set({ follow: false });
    };
    // logs the map zoom once per settled zoom change (gesture, fly-to, buttons) and on mount
    const logZoom = () => console.info(`[map] zoom ${map.getZoom().toFixed(2)}`);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") tracking.select(null);
    };

    map.on("click", onClick);
    map.on("dragstart", onDragStart);
    map.on("zoomend", logZoom);
    window.addEventListener("keydown", onKey);
    logZoom();
    return () => {
      map.off("click", onClick);
      map.off("dragstart", onDragStart);
      map.off("zoomend", logZoom);
      window.removeEventListener("keydown", onKey);
    };
  }, [mapRef, tracking]);

  useEffect(() => {
    const map = mapRef.getMap();
    const around = following ? { around: "center" as const } : undefined;
    map.scrollZoom.disable();
    map.scrollZoom.enable(around);
    map.touchZoomRotate.disable();
    map.touchZoomRotate.enable(around);
  }, [mapRef, following]);

  return null;
}
