// Adds the WebGL track layer to the map and drives it from one animation loop: the shared clock
// for the shader, camera follow, the selected-track panel (4 Hz) and the render stats (1 Hz).

import { useEffect } from "react";
import { useMap } from "react-map-gl/maplibre";
import { mercToLonLat } from "../shared/tiles.ts";
import { useTracking } from "./TrackingProvider.tsx";

export function DroneLayer() {
  const tracking = useTracking();
  const mapRef = useMap().current!;

  useEffect(() => {
    const map = mapRef.getMap();
    const { clock, layer, live, store } = tracking;
    map.addLayer(layer);
    let raf = 0;
    let frames = 0;
    let lastSelPush = 0;
    let last = { ...layer.stats };

    const loop = () => {
      const now = clock();
      layer.now = now;
      frames++;
      const sel = live.sel;
      if (sel?.inst && store.get().follow) {
        const i = sel.inst;
        const f = Math.min(1, Math.max(0, (now - i[4]) / sel.interp));
        const [lon, lat] = mercToLonLat(sel.ox + i[0] + (i[2] - i[0]) * f, sel.oy + i[1] + (i[3] - i[1]) * f);
        // never fight a gesture or animation; zoom gestures pivot on the centre while following
        if (!map.isMoving()) map.jumpTo({ center: [lon, lat] });
      }
      if (sel?.info && performance.now() - lastSelPush > 250) {
        lastSelPush = performance.now();
        store.set({ selected: { ...sel.info, ageMs: Math.max(0, (now - sel.info.lastSeen) * 1000) } });
      }
      raf = requestAnimationFrame(loop);
    };

    const measure = () => {
      const s = layer.stats;
      const uploads = s.uploads - last.uploads;
      const uploadMs = s.uploadMs - last.uploadMs;
      const rendered = s.framesRendered - last.framesRendered;
      const drawMs = s.drawMs - last.drawMs;
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      store.set({
        main: {
          fps: frames,
          uploadsPerSec: uploads,
          uploadMBps: (s.uploadBytes - last.uploadBytes) / 1e6,
          uploadMsAvg: uploads ? uploadMs / uploads : 0,
          drawMsAvg: rendered ? drawMs / rendered : 0,
          heapMB: mem ? mem.usedJSHeapSize / 1e6 : null,
          tracksDrawn: layer.count,
        },
      });
      last = { ...s };
      frames = 0;
    };

    raf = requestAnimationFrame(loop);
    const timer = window.setInterval(measure, 1000);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(timer);
      if (map.getLayer(layer.id)) map.removeLayer(layer.id);
    };
  }, [mapRef, tracking]);

  return null;
}
