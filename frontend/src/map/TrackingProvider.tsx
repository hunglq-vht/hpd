// React access to the tracking pipeline. The provider creates it in an effect, so render stays
// pure, and tears it down on unmount. Components read UI state with useUiState / useUiSelector and
// act through useTrackingActions.

import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useMap } from "react-map-gl/maplibre";
import { api, type AppConfig } from "../api.ts";
import { lonLatToMerc } from "../shared/tiles.ts";
import { createTracking, type Stress, type Tracking, type UiState } from "./tracking.ts";

/** id of the tracking map in react-map-gl's MapProvider, so panels outside <Map> can reach it */
export const MAP_ID = "tracking";

const TrackingContext = createContext<Tracking | null>(null);

export function TrackingProvider({ cfg, margin, children }: { cfg: AppConfig; margin: number; children: ReactNode }) {
  const [tracking, setTracking] = useState<Tracking | null>(null);
  useEffect(() => {
    const t = createTracking(cfg, margin);
    setTracking(t);
    return () => {
      t.dispose();
      setTracking(null);
    };
  }, [cfg, margin]);
  return tracking && <TrackingContext.Provider value={tracking}>{children}</TrackingContext.Provider>;
}

export function useTracking(): Tracking {
  const t = useContext(TrackingContext);
  if (!t) throw new Error("useTracking must be used inside <TrackingProvider>");
  return t;
}

export function useUiState(): UiState {
  const { store } = useTracking();
  return useSyncExternalStore(store.subscribe, store.get);
}

/** Re-renders only when the selected value changes; `select` must return a primitive or a stored reference. */
export function useUiSelector<T>(select: (s: UiState) => T): T {
  const { store } = useTracking();
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}

/** UI actions. Fly-to and stress tests need the map; the others only the store and the worker. */
export function useTrackingActions() {
  const tracking = useTracking();
  const { store, live } = tracking;
  const map = useMap()[MAP_ID]?.getMap();

  const flyTo = (lon: number, lat: number, zoom: number) => {
    store.set({ follow: false });
    map?.flyTo({ center: [lon, lat], zoom, speed: 1.6, curve: 1.5, essential: true });
  };

  return {
    select: tracking.select,
    setFollow: (follow: boolean) => store.set({ follow }),
    // ViewportSync refreshes the topics when the margin or the stress mode changes
    setMargin: (margin: number) => store.set({ margin }),
    async setStress(stress: Stress) {
      if (!map) return;
      let subjects: string[] | null = null;
      if (stress < 0) subjects = ["tracks.>"];
      else if (stress > 0) subjects = (await api.topTiles(stress)).tiles.map((t) => t.subject);
      const c = map.getCenter();
      tracking.post({ type: "override", subjects, origin: lonLatToMerc(c.lng, c.lat) });
      live.realtimeSince = performance.now();
      store.set({ stress, realtimeReady: false });
    },
    flyTo,
    async flyToHottest() {
      const top = await api.topTiles(1);
      if (top.tiles[0]) flyTo(top.tiles[0].lon, top.tiles[0].lat, 14);
    },
  };
}
