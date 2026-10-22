import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, the API and the NATS WebSocket are proxied so the app is single-origin, exactly like
// the nginx container in production (`/api` -> api:8090, `/nats` -> nats:8080).
const API = process.env.API_URL ?? "http://localhost:8090";
const NATS_WS = process.env.NATS_WS_URL ?? "ws://localhost:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: API, changeOrigin: true },
      "/nats": { target: NATS_WS, ws: true, changeOrigin: true, rewrite: () => "/" },
    },
  },
  worker: { format: "es" },
  build: { target: "es2022", sourcemap: true, chunkSizeWarningLimit: 1500 },
});
