// Dev-server login for u1-track-manager, which sits behind SSO. The Vite dev server logs in with the
// OAuth2 password grant (the endpoints of fe-monorepo's direct-password-grant mode), keeps the
// tokens in memory, renews them before they expire and adds "Authorization: Bearer" to the proxied
// requests. The browser, the bundle and the disk never see a token. Development only: a production
// build talks to the API with the SSO cookie instead.

import type { Plugin, ProxyOptions } from "vite";

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_expires_in?: number;
  token_type?: string;
  error?: string;
  error_description?: string;
}

interface Session {
  access: string;
  renewAt: number; // unix ms; a minute before expiry, or at 3/4 of a short lifetime
  refresh?: string;
  refreshUntil: number;
}

export interface SsoCredentials {
  /** e.g. https://dev.utm.io.vn/utm-qg; tokens come from <authUrl>/oauth2/token */
  authUrl: string;
  username: string;
  password: string;
}

export type RenewEvent = { how: "login" | "refresh"; ttlS: number };

/** Access tokens: cached, renewed before expiry (refresh token first, then a new login), one request at a time. */
export function createTokenSource(cred: SsoCredentials, onRenew?: (e: RenewEvent) => void, now = Date.now) {
  const base = cred.authUrl.replace(/\/+$/, "");
  let session: Session | null = null;
  let pending: Promise<Session> | null = null;

  async function grant(path: "token" | "refresh_token", body: Record<string, string>): Promise<Session> {
    const r = await fetch(`${base}/oauth2/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(body),
    });
    const t = (await r.json().catch(() => ({}))) as TokenResponse;
    // error texts come from the auth server and never contain the password or a token
    if (!r.ok || !t.access_token || !t.expires_in) throw new Error(`${path} ${r.status}: ${t.error_description ?? t.error ?? "no access token"}`);
    if (t.token_type && t.token_type.toLowerCase() !== "bearer") throw new Error(`${path}: unsupported token type ${t.token_type}`);
    const at = now();
    const ttl = t.expires_in * 1000;
    onRenew?.({ how: path === "token" ? "login" : "refresh", ttlS: t.expires_in });
    return {
      access: t.access_token,
      renewAt: at + Math.max(ttl - 60_000, ttl * 0.75),
      refresh: t.refresh_token,
      refreshUntil: t.refresh_token ? at + (t.refresh_expires_in ?? t.expires_in) * 1000 : 0,
    };
  }

  async function renew(): Promise<Session> {
    const s = session;
    if (s?.refresh && now() < s.refreshUntil - 5_000) {
      try {
        return await grant("refresh_token", { grant_type: "refresh_token", refresh_token: s.refresh });
      } catch {
        // the refresh token was revoked or expired: log in again
      }
    }
    return grant("token", { grant_type: "password", username: cred.username, password: cred.password });
  }

  return {
    async token(): Promise<string> {
      if (session && now() < session.renewAt) return session.access;
      pending ??= renew()
        .then((s) => (session = s))
        .finally(() => {
          pending = null;
        });
      return (await pending).access;
    },
    /** Drops the access token (after a 401), so the next request renews it. */
    invalidate() {
      if (session) session.renewAt = 0;
    },
  };
}

/**
 * Adds the SSO token to every dev-server request under `path`: a middleware that runs before
 * Vite's proxy sets the header, and a proxy hook drops the token when the API answers 401.
 * Without credentials it does nothing, so the local mock keeps working.
 */
export function u1SsoProxy(o: { path: string; authUrl?: string; username?: string; password?: string }): {
  plugin: Plugin;
  configureProxy?: ProxyOptions["configure"];
} {
  if (!o.authUrl || !o.username || !o.password) return { plugin: { name: "u1-sso (off: no U1_USERNAME / U1_PASSWORD)" } };
  const { username } = o;
  let log = (msg: string) => console.log(msg);
  const tokens = createTokenSource({ authUrl: o.authUrl, username, password: o.password }, (e) =>
    log(`[u1-sso] ${e.how === "login" ? `logged in as ${username}` : "token refreshed"}; valid for ${e.ttlS} s`),
  );

  const plugin: Plugin = {
    name: "u1-sso",
    configureServer(server) {
      log = (msg) => server.config.logger.info(msg, { timestamp: true });
      server.middlewares.use(o.path, async (req, res, next) => {
        try {
          req.headers.authorization = `Bearer ${await tokens.token()}`;
          delete req.headers.cookie; // cookies of localhost mean nothing to the API
          next();
        } catch (e) {
          const message = `dev SSO login failed: ${(e as Error).message}`;
          server.config.logger.error(`[u1-sso] ${message}`, { timestamp: true });
          res.statusCode = 502;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ message }));
        }
      });
    },
  };

  const configureProxy: ProxyOptions["configure"] = (proxy) => {
    proxy.on("proxyRes", (res) => {
      if (res.statusCode === 401) tokens.invalidate();
    });
  };
  return { plugin, configureProxy };
}
