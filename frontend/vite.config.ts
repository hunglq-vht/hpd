import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { u1SsoProxy } from "./dev/u1-sso.ts";

// In dev, the API and the NATS WebSocket are proxied so the app is single-origin, exactly like
// the nginx container in production (`/api` -> api:8090, `/nats` -> nats:8080). `/u1-track-manager`
// goes to u1-track-manager (`npm run dev:u1`), by default the local mock (`npm run mock:u1`).
// Settings come from the shell or the mode's .env files (e.g. .env.u1.local). Variables without the
// VITE_ prefix, such as the SSO account, stay in this Node process and never reach the bundle.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const API = env.API_URL || "http://localhost:8090";
  const TRACK_API = env.TRACK_API_URL || "http://localhost:8091";
  const NATS_WS = env.NATS_WS_URL || "ws://localhost:8080";
  const sso = u1SsoProxy({ path: "/u1-track-manager", authUrl: env.U1_AUTH_URL, username: env.U1_USERNAME, password: env.U1_PASSWORD });

  return {
    plugins: [react(), sso.plugin],
    server: {
      port: 5173,
      proxy: {
        "/api": { target: API, changeOrigin: true },
        "/u1-track-manager": { target: TRACK_API, changeOrigin: true, configure: sso.configureProxy },
        "/nats": { target: NATS_WS, ws: true, changeOrigin: true, rewrite: () => "/" },
      },
    },
    worker: { format: "es" },
    build: { target: "es2022", sourcemap: true, chunkSizeWarningLimit: 1500 },
  };
});
