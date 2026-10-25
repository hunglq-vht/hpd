// Keeps the data source in step with the camera. Below realtimeMinZoom it loads cluster stats
// (after every debounced camera change and every tick); from there up it sends the worker the NATS
// subjects covering the viewport. A new prefetch margin or stress mode re-runs it.

import { useEffect } from "react";
import { useMap } from "react-map-gl/maplibre";
import { api, type BBox } from "../api.ts";
import { lonLatToMerc, statsLevel } from "../shared/tiles.ts";
import { useTracking, useUiSelector } from "./TrackingProvider.tsx";
import { compact, type Mode } from "./tracking.ts";

export function ViewportSync() {
  const tracking = useTracking();
  const mapRef = useMap().current!;
  const margin = useUiSelector((s) => s.margin);
  const stress = useUiSelector((s) => s.stress);

  useEffect(() => {
    const map = mapRef.getMap();
    const { cfg, store, layer, live, post } = tracking;
    const life = new AbortController();
    let abort: AbortController | null = null;
    let reqSeq = 0;
    let timer = 0;
    let deadline = 0;

    const bbox = (): BBox => {
      const b = map.getBounds();
      return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    };
    const center = () => {
      const c = map.getCenter();
      return lonLatToMerc(c.lng, c.lat);
    };
    const fail = (e: unknown) => {
      if ((e as Error).name !== "AbortError") store.set({ error: (e as Error).message });
    };

    const loadClusters = async (zoom: number, signal: AbortSignal, seq: number) => {
      const stats = await api.stats(bbox(), zoom, signal);
      if (seq !== reqSeq || store.get().mode !== "cluster") return;
      const features = stats.cells.map(([x, y, count, lon, lat]) => ({
        type: "Feature" as const,
        id: x * 65536 + y,
        geometry: { type: "Point" as const, coordinates: [lon, lat] },
        properties: { count, label: compact(count) },
      }));
      store.set({
        clusters: { type: "FeatureCollection", features },
        cluster: { level: statsLevel(zoom), inView: stats.inView, total: stats.total, cells: stats.cells.length },
        error: null,
      });
    };

    /** In cluster mode a selected track keeps its own tile (+ ring) subscribed, so it stays live. */
    const keepSelectionSubscribed = async (signal: AbortSignal, seq: number) => {
      const s = store.get();
      const info = live.sel?.info ?? s.selected;
      if (s.selectedId === null || !info) {
        post({ type: "topics", subjects: [], origin: center() });
        return;
      }
      const d = 0.0005;
      const t = await api.topics([info.lon - d, info.lat - d, info.lon + d, info.lat + d], cfg.realtimeMinZoom, 0, signal);
      if (seq !== reqSeq) return;
      post({ type: "topics", subjects: t.topics.map((x) => x.subject), origin: [info.mx, info.my] });
    };

    const refresh = async () => {
      const zoom = map.getZoom();
      const seq = ++reqSeq;
      abort?.abort();
      abort = new AbortController();
      const { signal } = abort;
      const s = store.get();
      const mode: Mode = stress ? "stress" : zoom >= cfg.realtimeMinZoom ? "realtime" : "cluster";
      if (mode !== s.mode) {
        if (mode === "realtime") live.realtimeSince = performance.now();
        store.set({ mode, realtimeReady: mode === "cluster" ? false : s.realtimeReady && s.mode !== "cluster" });
      }
      store.set({ zoom });
      layer.mode = mode === "cluster" ? "selected" : "all";

      try {
        if (mode === "stress") return;
        if (mode === "realtime") {
          const t = await api.topics(bbox(), zoom, margin, signal);
          if (seq !== reqSeq) return;
          post({ type: "topics", subjects: t.topics.map((x) => x.subject), origin: center() });
          store.set({
            topics: { count: t.topics.length, viewportTiles: t.viewportTiles, expectedTracks: t.expectedTracks, viewportTracks: t.viewportTracks, truncated: t.truncated },
            error: null,
          });
          // clusters stay on screen until the first live frame (or 2 s) to avoid a blank map
          if (!store.get().realtimeReady && performance.now() - live.realtimeSince > 2000) store.set({ realtimeReady: true });
        } else {
          await Promise.all([loadClusters(zoom, signal, seq), keepSelectionSubscribed(signal, seq)]);
        }
      } catch (e) {
        fail(e);
      }
    };

    const scheduleRefresh = () => {
      const now = performance.now();
      if (!timer) deadline = now + 600; // max wait while moving continuously
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = 0;
        void refresh();
      }, Math.max(0, Math.min(150, deadline - now)));
    };

    const pollStats = () => {
      const s = store.get();
      if (s.mode === "cluster" && !document.hidden) loadClusters(map.getZoom(), life.signal, reqSeq).catch(fail);
      else if (s.mode === "realtime" && !s.realtimeReady && performance.now() - live.realtimeSince > 2000) store.set({ realtimeReady: true });
    };

    map.on("move", scheduleRefresh);
    map.on("moveend", scheduleRefresh);
    const poll = window.setInterval(pollStats, cfg.publishIntervalMs);
    void refresh();
    return () => {
      map.off("move", scheduleRefresh);
      map.off("moveend", scheduleRefresh);
      clearTimeout(timer);
      clearInterval(poll);
      abort?.abort();
      life.abort();
    };
  }, [mapRef, tracking, margin, stress]);

  return null;
}
