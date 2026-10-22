# Tiling agreement & wire protocol (v1)

This is the contract that the Go backend (`backend/internal/tiles`, `backend/internal/wire`) and the
React client (`frontend/src/shared/tiles.ts`, `frontend/src/shared/wire.ts`) both implement. The API
serves it at `GET /api/config`, so the client never hard-codes it.

## 1. Tiling scheme

| Item | Value |
|---|---|
| Projection | Web Mercator (EPSG:3857), latitude clamped to ±85.05112878° |
| Tile scheme | XYZ ("slippy map"): `x` grows east, `y` grows **south**, tile (0,0) is the north-west corner |
| Normalised mercator | `mx = (lon + 180) / 360`, `my = (1 - ln(tan φ + sec φ) / π) / 2`, both in `[0, 1)` |
| Tile of a point at level `z` | `x = floor(mx · 2^z)`, `y = floor(my · 2^z)` |
| **Topic level** `T` | **13**. One NATS subject per z13 tile (≈ 4.9 km at the equator, ≈ 3.4 km at 45°) |
| **Stats base level** `S` | **15**. Every z13 tile is split into 4×4 stats cells |
| **Realtime threshold** | map zoom `≥ 13` → realtime tracks over NATS; zoom `< 13` → clusters from `/api/stats` |
| Stats level for a map zoom `z` | `L = clamp(floor(z) + 3, 0, 15)`. With MapLibre's 512 px tiles that gives cells of 64–128 px on screen |

Zoom levels are MapLibre zoom levels (512 px world at z0), so a z13 tile is 512 CSS px wide when the
map sits exactly at zoom 13.

## 2. NATS subjects

| Subject | Direction | Payload |
|---|---|---|
| `tracks.13.<x>.<y>` | backend → clients | Binary tile snapshot (section 3), published once per tick for every non-empty tile, plus one empty snapshot when a tile becomes empty |
| `svc.time` | request/reply | Request: empty. Reply: 8-byte little-endian `float64` Unix time in ms. Clients use it to estimate their clock offset (NTP style), so latency figures are correct |

Clients only subscribe. The `viewer` NATS user can subscribe to `tracks.>` and `_INBOX.>` and can
publish only to `svc.time`. The `backend` user has full access.

## 3. Binary tile snapshot (`tracks.13.<x>.<y>`)

All values are little-endian. A 32-byte header is followed by `count` records of 16 bytes each.

### Header (32 bytes)

| Offset | Type | Field | Notes |
|---:|---|---|---|
| 0 | u8 | `version` | `1` |
| 1 | u8 | `msgType` | `1` = tile snapshot |
| 2 | u8 | `zoom` | `13` |
| 3 | u8 | `flags` | reserved, 0 |
| 4 | u32 | `x` | tile x |
| 8 | u32 | `y` | tile y |
| 12 | u32 | `seq` | tick number of the publisher |
| 16 | f64 | `publishedAt` | Unix epoch, milliseconds (used for latency measurement) |
| 24 | u32 | `count` | number of records in this message |
| 28 | u16 | `intervalMs` | publish interval (tick length) |
| 30 | u8 | `part` | 0-based part index (a tile with more than 65 000 tracks is split) |
| 31 | u8 | `parts` | total parts for this tile and tick |

### Record (16 bytes)

| Offset | Type | Field | Encoding |
|---:|---|---|---|
| 0 | u32 | `id` | track id (unique, non-zero) |
| 4 | u16 | `lx` | tile-local x: `mx = (x + lx/65536) / 2^13` (≈ 7.5 cm resolution at z13) |
| 6 | u16 | `ly` | tile-local y: `my = (y + ly/65536) / 2^13` |
| 8 | u16 | `alt` | altitude in decimetres (0 – 6553.5 m) |
| 10 | u16 | `heading` | `heading° = value · 360 / 65536`, clockwise from true north |
| 12 | u16 | `speed` | centimetres per second |
| 14 | u8 | `type` | 0 quadcopter, 1 hexacopter, 2 fixed-wing, 3 emergency |
| 15 | u8 | `battery` | percent |

### Semantics

* A message holds **every** track that is inside the tile at tick `seq`. It is a batch for one tile,
  not a delta. The client keys its state by track `id`, so a track that crosses a tile edge simply shows
  up in the neighbouring tile's next snapshot.
* A client drops a track it has not seen for `1.5 × intervalMs`. It also drops tracks right away when it
  unsubscribes from their tile.
* When a tile becomes empty, one snapshot with `count = 0` is published so that monitors can clear it.
* There is no last-value cache. A new subscriber waits up to one interval for its first snapshot, which
  is why the client prefetches a ring of tiles around the viewport.

Size: 1 000 000 tracks × 16 B ≈ **16 MB per tick** for the full firehose, plus 32 B per message. A
typical z13 viewport over a dense city with a half-viewport prefetch margin (~50 tiles, ~20–40 k
tracks) is 0.3 – 0.7 MB/s per client.

## 4. HTTP API (`api` service, port 8090, proxied at `/api` by the web container)

### `GET /api/config`
```json
{
  "tileScheme": "xyz-webmercator",
  "topicZoom": 13, "realtimeMinZoom": 13,
  "statsMaxLevel": 15, "statsLevelOffset": 3,
  "subjectPrefix": "tracks", "subjectPattern": "tracks.{z}.{x}.{y}",
  "publishIntervalMs": 1000, "staleFactor": 1.5,
  "defaultMargin": 0.5, "maxTopics": 256, "wireVersion": 1,
  "nats": { "wsUrl": "", "wsPath": "/nats", "user": "viewer", "pass": "viewer" }
}
```
If `wsUrl` is empty, the client connects to `ws(s)://<page host><wsPath>`.

### `GET /api/stats?bbox=w,s,e,n&zoom=z`
Used for cluster mode. It returns the aggregated cells at level `L = clamp(floor(z)+3, 0, 15)` that
intersect the bbox. `lon`/`lat` is the **centroid** of the tracks in the cell, not the cell centre, so
clusters sit where the traffic is.
```json
{ "level": 9, "seq": 812, "updatedAt": 1761123456789.1, "total": 1000000, "inView": 48211,
  "cells": [[x, y, count, lon, lat], ...] }
```

### `GET /api/topics?bbox=w,s,e,n&zoom=z&margin=m`
Used for realtime mode. It returns the z13 tiles that cover the viewport, grown by `margin × viewport
size` on each side (default 0.5, max 2), and always at least one ring of neighbouring tiles. Viewport
tiles come first, sorted from the centre outward, then prefetch tiles. The list is capped at
`maxTopics`.
```json
{ "level": 13, "viewportTiles": 15, "expectedTracks": 23456, "truncated": false,
  "topics": [{ "subject": "tracks.13.7276.3225", "x": 7276, "y": 3225, "count": 812, "inView": true }] }
```

### `GET /api/tiles/top?limit=n`
Returns the z13 tiles with the most tracks. The benchmark uses it to build load tiers.

### `GET /api/metrics`
Monitor counters: messages and bytes received per second, tiles tracked, total tracks, and pyramid build time.
