import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createTokenSource } from "./u1-sso.ts";

// A fake OAuth2 server: /oauth2/token (password grant) and /oauth2/refresh_token.
const calls: { path: string; body: URLSearchParams }[] = [];
let refreshFails = false;
let seq = 0;
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const body = new URLSearchParams(raw);
  calls.push({ path: req.url ?? "", body });
  const send = (code: number, json: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(json));
  };
  if (req.url === "/realm/oauth2/token") {
    if (body.get("password") !== "secret-pw") return send(401, { error: "invalid_grant", error_description: "Invalid user credentials" });
    return send(200, { access_token: `login-${++seq}`, expires_in: 300, refresh_token: "r1", refresh_expires_in: 1800, token_type: "Bearer" });
  }
  if (req.url === "/realm/oauth2/refresh_token") {
    if (refreshFails) return send(400, { error: "invalid_grant" });
    return send(200, { access_token: `refreshed-${++seq}`, expires_in: 300, refresh_token: "r2", refresh_expires_in: 1800, token_type: "bearer" });
  }
  send(404, {});
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const authUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/realm/`;
after(() => server.close());

const reset = () => {
  calls.length = 0;
  refreshFails = false;
};

test("logs in once with the password grant and caches the token", async () => {
  reset();
  const t = createTokenSource({ authUrl, username: "u", password: "secret-pw" });
  const [a, b] = await Promise.all([t.token(), t.token()]);
  assert.equal(a, b);
  assert.equal(await t.token(), a);
  assert.equal(calls.length, 1, "concurrent and later calls share one login");
  assert.equal(calls[0].path, "/realm/oauth2/token");
  assert.equal(calls[0].body.get("grant_type"), "password");
});

test("renews with the refresh token a minute before expiry, and logs in again if that fails", async () => {
  reset();
  let clock = 1_000_000;
  const events: string[] = [];
  const t = createTokenSource({ authUrl, username: "u", password: "secret-pw" }, (e) => events.push(e.how), () => clock);
  const first = await t.token();
  clock += 239_000; // 4 min - 1 s: still valid
  assert.equal(await t.token(), first);
  clock += 2_000; // inside the last minute of 5 min
  const second = await t.token();
  assert.match(second, /^refreshed-/);
  assert.equal(calls.at(-1)!.body.get("refresh_token"), "r1");

  refreshFails = true;
  t.invalidate(); // as after a 401 from the API
  const third = await t.token();
  assert.match(third, /^login-/);
  assert.deepEqual(events, ["login", "refresh", "login"]);
});

test("a failed login reports the server's reason, never the password", async () => {
  reset();
  const t = createTokenSource({ authUrl, username: "u", password: "wrong-pw" });
  await assert.rejects(t.token(), (e: Error) => {
    assert.match(e.message, /401: Invalid user credentials/);
    assert.ok(!e.message.includes("wrong-pw"));
    return true;
  });
});
