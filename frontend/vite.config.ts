import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, the API and the NATS WebSocket are proxied so the app is single-origin, exactly like
// the nginx container in production (`/api` -> api:8090, `/nats` -> nats:8080). `/u1-track-manager`
// goes to u1-track-manager (`npm run dev:u1`), by default the local mock (`npm run mock:u1`).
const API = process.env.API_URL ?? "http://localhost:8090";
const TRACK_API = process.env.TRACK_API_URL ?? "http://localhost:8091";
const NATS_WS = process.env.NATS_WS_URL ?? "ws://localhost:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: API, changeOrigin: true },
      "/u1-track-manager": { target: TRACK_API, changeOrigin: true },
      "/nats": { target: NATS_WS, ws: true, changeOrigin: true, rewrite: () => "/" },
    },
  },
  worker: { format: "es" },
  build: { target: "es2022", sourcemap: true, chunkSizeWarningLimit: 1500 },
});
