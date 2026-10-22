# Assessment: tile-partitioned realtime tracking over NATS

## The proposal in one paragraph

The backend and frontend share a fixed Web Mercator tile grid. The backend keeps counting how many
tracks fall in each tile. When the map zoom is below 13, the client draws clusters from per-tile
statistics fetched over HTTP. At zoom 13 and above, the client asks the backend which NATS subjects
(one per z13 tile) cover the viewport plus a prefetch ring, subscribes to them over NATS WebSocket and
draws every individual track. Clicking a track opens an info panel, draws a ring around it and makes
the camera follow it.

**Verdict.** This is a sound design and a well-known pattern: spatially partitioned pub/sub with
server-side aggregation at low zoom. It gives the client a cost that depends on screen area, not on
fleet size, which is the only way 1 M live tracks can reach a browser. A fixed zoom threshold is not
enough on its own, though. The weak points are density skew, the wait for the first snapshot after a
new subscription, and exposing the bus to browsers. Each of them has a known mitigation. The demo
already implements several of them, and the rest are listed at the end.

---

## Advantages

1. **Client load is bounded by the screen, not by the fleet.** Below z13 the client gets a few hundred
   aggregated cells, whether there are 10 k or 10 M tracks. Above z13 it gets only the tracks inside
   about 20–60 tiles. 1 M tracks × 16 B is 16 MB/s for the firehose, but a dense city viewport is only
   0.3–0.7 MB/s.
2. **The broker does the filtering.** NATS routes by subject interest. Producers publish per tile and
   never know who is watching, and nothing on the backend holds per-client state. When nobody listens
   to a subject, the server drops its messages almost for free. A server cluster, superclusters and leaf
   nodes scale the fan-out out horizontally and push it to the edge.
3. **A deterministic, shared contract.** XYZ/Web Mercator is the same grid the map already uses for its
   base tiles. Both sides compute `tile ⇄ subject` the same way. Subjects are readable
   (`tracks.13.7276.3225`), and wildcards come free: a recorder or analytics job can take `tracks.>`,
   and a regional consumer can take `tracks.13.72*` style partitions.
4. **The prefetch ring hides subscription latency.** Data for tiles just outside the viewport is
   already flowing, so a normal pan shows tracks right away.
5. **Natural horizontal partitioning of the backend.** Ingest and tiling can be sharded by tile range.
   The tile monitor and the stats API are separate, stateless-on-request services, and statistics
   responses are cacheable for one tick.
6. **Batching per tile is efficient.** One message per tile per tick, instead of one per track, cuts
   per-message overhead (NATS protocol header, WS frame, JS callback) by 2–3 orders of magnitude in
   dense areas. Snapshot semantics are idempotent and self-healing: a lost message is fixed by the next
   tick.
7. **Simple client mental model.** Below the threshold the client reads cluster stats over HTTP. Above
   it, the client holds a set of subscriptions. Every pan or zoom becomes a subscription diff.

## Drawbacks and risks

| # | Issue | Why it matters | Mitigation (✓ = done in this demo) |
|---|---|---|---|
| 1 | **Density skew.** The zoom threshold says nothing about how many tracks are in view | One dense z13 tile can hold thousands of drones. A viewport plus prefetch over a city centre can reach 50–100 k tracks/s, while the same zoom over the countryside shows 3 | ✓ `/api/topics` returns `expectedTracks`, and the API caps the topic count. Production should **switch on density instead of zoom** (stay clustered while `expectedTracks > budget`), use **adaptive tile levels** (split hot tiles to z14/z15 subjects, i.e. a quadtree), or apply server-side thinning or level-of-detail |
| 2 | **Wait for the first snapshot.** Core NATS keeps no last value | After subscribing, a tile stays blank for up to one interval (1 s). Fast pans beyond the ring show empty space | ✓ prefetch ring and linger on unsubscribe. Better: JetStream stream or KV with `MaxMsgsPerSubject=1` (last-value cache), or a request/reply snapshot service |
| 3 | **Edge effects at tile boundaries** | A track shows up in tile B before or after it leaves tile A. The followed track can drift out of the subscribed set | ✓ client state keyed by track id, with staleness eviction. ✓ the selected track's tile and its neighbours stay subscribed even in cluster mode |
| 4 | **Round trip and subscription churn.** Every move calls `/api/topics`, then SUB/UNSUB | Adds latency and puts load on the API. Zoom and pan storms make many short-lived subscriptions | ✓ debounce with max-wait, plus a 3 s linger before unsubscribing. The client could compute the cover itself, since the contract is deterministic. The server call is still useful for authorisation, caps and versioning |
| 5 | **Hard switch at zoom 13** | Clusters disappear and dots appear, visibly. Stats and live data come from different pipelines, so counts may not match exactly | ✓ clusters stay on screen until the first realtime frame arrives. A crossfade or a density-based switch helps more |
| 6 | **Browsers connect straight to the bus** | Security (who can subscribe to what), resource abuse (thousands of SUBs), slow consumers (NATS drops a client that cannot keep up), and the bus being reachable from the internet | ✓ dedicated `viewer` user that can only subscribe to `tracks.>` and request `svc.time`. Production: WSS/TLS, per-user JWT or auth callout with subject permissions, `max_subscriptions` and `max_pending` limits, an isolated account or leaf node that exports only `tracks.>`, and reconnect-plus-resubscribe on the client |
| 7 | **Snapshots resend stationary tracks** | Hovering drones cost bandwidth on every tick | Delta encoding with periodic keyframes, or adaptive per-track rates (slow or still tracks less often). Snapshots stay simpler and self-healing |
| 8 | **Many tiny messages in sparse areas** | Message count grows with the number of non-empty tiles, not with tracks. 30 k lone drones means 30 k messages per tick | Adaptive tiles in the other direction: merge sparse tiles under a coarser subject |
| 9 | **Fan-out egress** | 1 000 viewers × 0.5 MB/s is 500 MB/s of egress, and hot tiles such as a city centre are watched by everyone | Edge leaf nodes or CDN-style WS gateways near users. Optional WS compression trades CPU for bandwidth |
| 10 | **Render lag versus accuracy** | Smooth motion from 1 Hz data needs interpolation, so the screen runs about one interval behind the truth | ✓ GPU interpolation with a 1.15× buffer. Dead-reckoning on heading and speed could lower the visual latency |
| 11 | **Web Mercator distortion** | A z13 tile covers about 4× less ground at 60° latitude than at the equator, so density budgets per tile vary. Areas above ±85° are excluded | Fine for drones. Use H3 or S2 if equal-area cells matter |
| 12 | **2-D partitioning** | Altitude is ignored. Airspace queries (corridors, flight levels) need more | Add an altitude band to the subject (`tracks.13.x.y.band`) if needed |
| 13 | **Clock and latency observability** | Browser clocks are not synchronised with the backend | ✓ `svc.time` request/reply for NTP-style offset estimation, so latency percentiles are honest |
| 14 | **Burstiness and hot consumers** (found while measuring) | Publishing a whole tick as one 17 MB burst, plus one monitor subscribed to `tracks.13.>`, queued messages for 150–240 ms at every subscriber | ✓ pace publishing over the tick, shard producers over several connections, and keep the monitor's lock out of the hot path. Latency went from p50 149 / p99 240 ms to **14 / 59 ms** (`PERFORMANCE.md` §4). In production, shard the monitor with queue groups or regions |

## Alternatives considered

* **Server-side per-client viewport filtering** (each client sends its bbox, and a gateway filters
  every update). This is flexible (any shape, any density rule), but it puts per-client state and
  CPU (O(clients × updates)) on the backend. The tile and subject approach moves that work into
  the broker's subject routing.
* **Vector tiles (MVT) regenerated every second.** CDN-friendly and works at all zoom levels, but
  re-tiling 1 M points per second across zoom levels is expensive, and the client cannot interpolate
  smoothly between tile generations.
* **Push everything and cluster on the client** (supercluster or deck.gl). Not feasible: 16 MB/s per
  browser.
* **Quadkey subjects** (`tracks.1.3.0.2…`, one token per level). One subscription with `>` covers any
  ancestor tile, which makes adaptive levels trivial. This is a good next step for drawback #1.

## What this demo implements

See `README.md` for how to run it and `docs/PERFORMANCE.md` for measurements.

* Go simulator with 1 M drones (waypoint flight model around 38 hotspot cities in Southeast Asia). It publishes binary
  z13 tile snapshots at 1 Hz, sharded over 4 NATS connections and paced across the tick.
* Go tile monitor and API. It subscribes to `tracks.13.>`, keeps a 4×4 sub-cell summary per tile,
  builds a z15→z0 count and centroid pyramid every tick, and serves `/api/stats`, `/api/topics`,
  `/api/config` and the `svc.time` responder.
* React + MapLibre client. Clusters below z13. Above z13, a Web Worker owns the NATS WebSocket
  connection, decodes snapshots and maintains the track table, and a custom WebGL2 layer draws
  instanced drone icons with interpolation on the GPU. Click picking, info panel, pulsing selection
  ring and camera follow. Live performance HUD.
