import { createRoot } from "react-dom/client";
import { setWorkerUrl } from "maplibre-gl";
// MapLibre 6 loads its tile worker relative to its own module URL, which a bundler rewrites.
// Let Vite bundle the worker (with its shared chunk) and tell MapLibre where it ended up.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import App from "./App.tsx";

setWorkerUrl(maplibreWorkerUrl);

// No StrictMode: the map controller owns a worker and a WebGL layer whose lifetime must match the
// map's, and StrictMode's double mount in development would tear them down once.
createRoot(document.getElementById("root")!).render(<App />);
