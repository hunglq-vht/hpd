import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { setWorkerUrl } from "maplibre-gl";
// MapLibre 6 loads its tile worker relative to its own module URL, which a bundler rewrites.
// Let Vite bundle the worker (with its shared chunk) and tell MapLibre where it ended up.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import App from "./App.tsx";

setWorkerUrl(maplibreWorkerUrl);

// The tracks worker, the WebGL layer and the map listeners are created and released by effects, so
// StrictMode's development double mount only tears them down and builds them again.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
