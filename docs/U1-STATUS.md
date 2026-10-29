# u1 integration: current situation

Status of the HPDMB frontend against the real u1-track-manager dev server (`dev.utm.io.vn`), as of 2026-10-26. The full change list and design are in [U1-BACKEND-INTEGRATION.md](U1-BACKEND-INTEGRATION.md).

**In short:**

- The frontend connects to the real NATS feed and the real HTTP API (through SSO), and draws live tracks wherever the view is within the limits.
- Dense areas such as central Hanoi cannot be shown live. The server refuses them under the 4,000-track limit. With a higher limit, the data (about 38 MB/s) is far more than this PC's connection to the server can carry (about 2.1 MB/s).
- Fixing that needs backend changes: compression, a compact format, or less data per region.
- Cluster view has no data, because the region stats endpoint is not deployed.
- All changes since commit `770f9e1` are uncommitted on `implement-functional-component`.

## Contents

1. [What works](#what-works)
2. [What does not work, and why](#what-does-not-work-and-why)
3. [Measurements](#measurements)
4. [Real data compared with the spec](#real-data-compared-with-the-spec)
5. [What the backend can do](#what-the-backend-can-do)
6. [Frontend state](#frontend-state)
7. [How to run](#how-to-run)
8. [Next steps and open questions](#next-steps-and-open-questions)

---

## What works

| Area | State |
|---|---|
| NATS WebSocket | `wss://dev.utm.io.vn/nats-websocket/` (the trailing slash is required). User `monitor` may subscribe to `u1.track.region.>`. Server `dev-k8s-71-u1-nats-0`, NATS 2.11.7. |
| HTTP API behind SSO | The Vite dev server logs in with the OAuth2 password grant (`https://dev.utm.io.vn/utm-qg/oauth2/token`), keeps the token in memory and adds `Authorization: Bearer` to `/u1-track-manager` requests. The browser never sees the token. |
| Resolve | Views within the limits get their topics, plus the server's estimate of tracks and regions |
| Live tracks | One quiet region (6502.3605): about 2.3k tracks, 2.3k messages/s, worker 7–12 % busy, 55–60 fps, no reconnects |
| Decoding | Every real message decoded (over 200k checked, 0 rejected). IDs are stable, and each track reports once per second. |
| Refusals | When the server refuses a view, the app keeps its current live regions and explains why in the toolbar |
| Credentials | The real NATS values and the SSO account are in `frontend/.env.u1.local`, which git and the Docker build ignore. They were never committed. |

## What does not work, and why

| Problem | Cause | Evidence |
|---|---|---|
| Dense views are refused (HTTP 422 `SUBSCRIPTION_LIMIT_EXCEEDED`) | The client asks for at most 4,000 tracks (`VITE_MAX_CACHED_TRACKS`). Central Hanoi at zoom 13 has about 100k tracks in 15 regions. | Resolve answers `estimated_cached_tracks 99996 exceeds max_cached_tracks 4000` |
| Region 6503.3606 can never be live | That one region alone holds about 21k tracks, and the server only offers zoom-13 regions | Resolve refuses even a view inside that region. Other partition zooms return `400 partition zoom N not supported (only 13)`. |
| Raising the limit makes it worse | The server then accepts, but the data rate is about 18× this PC's connection. NATS drops a client that falls behind, which happened every 6–7 s. | See [Measurements](#measurements) |
| Cluster view is empty | `GET tracks/regions/stats` is not deployed | It answers `400 {"error":" invalid id"}`; other paths answer 404 |
| NATS password is visible in the app | `VITE_*` values are copied into the JavaScript bundle. NATS takes credentials inside the WebSocket stream, so the dev proxy cannot add them. | Acceptable for local development only |

## Measurements

All from this laptop (ThinkPad T480s) on 2026-10-26.

| What | Value |
|---|---|
| Download speed from dev.utm.io.vn | 2.7 MB file in about 1.3 s, so about 2.1 MB/s |
| Size of one real message | about 377 B of JSON |
| Data for central Hanoi at zoom 13 | about 100k tracks/s × 377 B, so about 38 MB/s |
| Same data with WebSocket compression | 5.9× smaller (64 B per message), so about 6.4 MB/s. Compression is currently off on the server. |
| Same data in the demo's binary format | 16 B per track, so about 1.6 MB/s |
| Delay on one quiet region | about 0.9 s from `state_updated_at` to arrival, including any clock difference |

What the WebSocket did on the 15 Hanoi topics (30 s, limit raised to 200,000):

1. Messages arrived for 4–7 s at about 4–9k per second, while the delay grew by about 1 s every second.
2. Nothing arrived for 2–4 s, then a burst of 25–44k messages.
3. The server dropped the connection; the client reconnected within 0.1 s, and the cycle repeated.
4. On average, under 10 % of what was published arrived. Everything published during a gap was lost.

In the app this shows as drones arriving later and later, freezing, disappearing after 3 s, and coming back after each reconnect.

## Real data compared with the spec

| Field | Spec | Real |
|---|---|---|
| `state_updated_at` (top level) | not in the spec | Unix ms. The frontend uses it for latency. |
| `track.Model` | string | Missing, so every icon is a quadcopter |
| `track.Mode3a` | squawk code (`"7400"`) | Registration-like text (`"27-E-3969-KI"`) |
| `track.CreatedAt` / `UpdatedAt` | seconds | `CreatedAt` in ms, `UpdatedAt` in seconds |
| `track.Quantity` | not in the spec | `1` |
| Resolve answer | `{ topics }` | Also `partition_count`, `estimated_cached_tracks`, `effective_partition`, `viewport_with_buffer`, `resolved_at` |
| Resolve over a limit | not in the spec | HTTP 422 with `code`, `limit`, `limits_applied` and `required`. It refuses rather than trims the list. |
| Neighbour regions | not stated | None are added; only the regions the view touches |
| Changes seen on 2026-10-28 | | `timestamp` now in ms, `Model` is `"Simulation Drone"`, a new `Serial` field equals `Mode3a`, `CreatedAt` is 0, `Quantity` 0, and every track has `Velocity` and `Heading` 0. The server sent only about 2,000 tracks in all. |

## What the backend can do

In order of value:

| # | Change | Effort | Effect |
|---|---|---|---|
| 1 | Turn on WebSocket compression in NATS (`websocket { compression: true }`) | Configuration | About 6× less data (measured). Costs server CPU. |
| 2 | Send one message per region per tick, in a compact or binary format | Medium | Down to about 1.6 MB/s for 100k tracks, which fits this connection |
| 3 | Send fewer tracks in dense areas: smaller partitions (zoom 14+), sampling, or a cap per region | Medium | Dense areas become viewable within the limit |
| 4 | Return the track count per region in resolve, including in 422 refusals | Small | A refused client could still show the central regions that fit |
| 5 | Deploy `tracks/regions/stats`, filtered by view and zoom, with centre points | Small | Cluster view works |
| 6 | Use milliseconds for all times (`timestamp`, `UpdatedAt`) | Small | Correct latency figures and ordering |
| 7 | Let NATS accept the SSO token, or issue short-lived per-user credentials | Medium | No shared password in the app |
| 8 | Send `Model`, and document Mode3a, units and altitude reference | Small | Correct icons and labels |

## Frontend state

- **Code:** the u1 decoder, resolve with refusal handling, region clusters, the measured update interval (kept within 0.5–2× of the configured value), the dev-server SSO login, and a local mock that behaves like the dev server.
- **Checks:** typecheck is clean, 23 of 23 unit tests pass, and the main flows were checked in Chrome against the dev server.
- **Git:** modified source files, docs and `vite.config.ts`, plus the new `frontend/dev/`. Not committed. The last commit is `770f9e1 change API specs`.
- **Limit:** `VITE_MAX_CACHED_TRACKS` is 4,000. A safe value is roughly the connection speed divided by 377 B, so about 5,000 on this connection.

## How to run

`frontend/.env.u1.local` (git-ignored) holds:

| Variable | Purpose |
|---|---|
| `VITE_NATS_WS_URL` | `wss://dev.utm.io.vn/nats-websocket/` |
| `VITE_NATS_USER` / `VITE_NATS_PASS` | NATS login (ends up in the bundle) |
| `TRACK_API_URL` | `https://dev.utm.io.vn` (the dev proxy target) |
| `U1_AUTH_URL` | `https://dev.utm.io.vn/utm-qg` |
| `U1_USERNAME` / `U1_PASSWORD` | SSO account, read only by the dev server |

```bash
cd frontend
npm run dev:u1   # http://localhost:5173/?lon=105.7541&lat=21.06&zoom=15  (a quiet region)
```

Restart `npm run dev:u1` and reload the page after changing any `VITE_*` value.

Without the real server, or when it sends too little to load the app, run the local simulator and `npm run dev:u1sim` instead (see [U1-SIM.md](U1-SIM.md)). It also publishes a batched and a binary format, and offers a compressed WebSocket, for comparison.

`npm run probe:u1` measures what arrives, second by second (`frontend/bench/u1-probe.ts`; `--local` for the simulator).

## Next steps and open questions

**For the backend team:**

1. Can WebSocket compression be turned on? It is the quickest gain.
2. Is a compact or batched message format planned?
3. Will dense areas get smaller partitions, sampling or a per-region cap?
4. When will `tracks/regions/stats` be deployed?
5. Can NATS accept the SSO token?
6. What are the units of Velocity, Heading and Altitude, and what does Mode3a contain?

**For us:**

1. Commit the current changes, on a new branch if preferred.
2. Measure on the office network. A faster connection may allow a higher limit.
3. Then apply the approach to fe-monorepo `apps/utm` (see [UTM-TRACK-FEATURES.md](UTM-TRACK-FEATURES.md)).
