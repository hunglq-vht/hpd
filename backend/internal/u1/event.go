// Package u1 stands in for u1-track-manager, the track service of the UTM platform: track events on
// one NATS subject per z13 region, and the HTTP API that resolves a viewport into those subjects.
// The JSON format copies the dev server (dev.utm.io.vn) field for field as sampled on 2026-10-28;
// the batch and binary formats exist only here, to compare formats under the same load.
package u1

import (
	"math"
	"strconv"

	"dronetracks/internal/tiles"
)

const (
	Scheme = "web_mercator_xyz"
	Model  = "Simulation Drone" // what the dev server sends for every track
	// BatchMax caps the tracks in one track.batch (about 330 B each), below NATS max_payload (1 MB).
	BatchMax = 2000
)

// Region is the region object of every event.
type Region struct {
	Scheme string `json:"scheme"`
	Zoom   int    `json:"zoom"`
	X      int    `json:"x"`
	Y      int    `json:"y"`
}

// Track is the track object of a track.update, in the dev server's field order. Times: UpdatedAt in
// seconds, CreatedAt 0 (as the dev server sends them).
type Track struct {
	ID          uint32  `json:"ID"`
	TrackNumber uint32  `json:"TrackNumber"`
	Altitude    float32 `json:"Altitude"`
	Latitude    float32 `json:"Latitude"`
	Longitude   float32 `json:"Longitude"`
	Velocity    float32 `json:"Velocity"`
	Heading     float32 `json:"Heading"`
	Quantity    int     `json:"Quantity"`
	Model       string  `json:"Model"`
	Mode3a      string  `json:"Mode3a"`
	Serial      string  `json:"Serial"`
	UpdatedAt   int64   `json:"UpdatedAt"`
	CreatedAt   int64   `json:"CreatedAt"`
}

// Update is a track.update event. Timestamp is the publish time and StateUpdatedAt the time of the
// position, both unix ms.
type Update struct {
	Type           string `json:"type"`
	Timestamp      int64  `json:"timestamp"`
	StateUpdatedAt int64  `json:"state_updated_at"`
	Region         Region `json:"region"`
	Track          Track  `json:"track"`
}

// Departure is a track that moved from a region into another one.
type Departure struct {
	TrackID   uint32 `json:"track_id"`
	ToRegion  Region `json:"to_region"`
	UpdatedAt int64  `json:"updated_at"` // seconds, like Track.UpdatedAt
}

// Leave is a track.leave event, sent on the old region before the track's update on the new one.
type Leave struct {
	Type      string    `json:"type"`
	Timestamp int64     `json:"timestamp"`
	Region    Region    `json:"region"`
	Leave     Departure `json:"leave"`
}

// Batch is a track.batch event: the tracks of one region in one message, plus the tracks that left
// the region this tick. A region with more than BatchMax tracks is split over several batches.
type Batch struct {
	Type           string      `json:"type"`
	Timestamp      int64       `json:"timestamp"`
	StateUpdatedAt int64       `json:"state_updated_at"`
	Region         Region      `json:"region"`
	Tracks         []Track     `json:"tracks"`
	Leaves         []Departure `json:"leaves,omitempty"`
}

// RegionOf returns the region object of a tile key (tiles.Key).
func RegionOf(key uint32) Region {
	x, y := tiles.Unkey(key)
	return Region{Scheme: Scheme, Zoom: tiles.TopicZoom, X: x, Y: y}
}

// Subject returns the NATS subject of a region: "<prefix>.xyz.13.<x>.<y>".
func Subject(prefix string, x, y int) string {
	return prefix + ".xyz." + strconv.Itoa(tiles.TopicZoom) + "." + strconv.Itoa(x) + "." + strconv.Itoa(y)
}

// Registration returns a plate-like Mode3a/Serial text such as "03-N-3164-OU", fixed per track id.
func Registration(id uint32) string {
	h := uint64(id) * 0x9E3779B97F4A7C15
	h ^= h >> 29
	b := make([]byte, 0, 12)
	b = append(b, '0'+byte(h%10), '0'+byte(h/10%10), '-', 'A'+byte(h/100%26), '-')
	b = strconv.AppendUint(b, 1000+h/2600%9000, 10)
	return string(append(b, '-', 'A'+byte(h>>40%26), 'A'+byte(h>>48%26)))
}

// The Append functions encode exactly as encoding/json does (see the tests), without allocating.
// Strings are written unescaped: they hold letters, digits, '-', '.' and ' ' only.

func AppendUpdate(b []byte, u *Update) []byte {
	b = appendHead(b, u.Type, u.Timestamp, u.StateUpdatedAt, u.Region)
	b = appendTrack(append(b, `,"track":`...), &u.Track)
	return append(b, '}')
}

func AppendBatch(b []byte, m *Batch) []byte {
	b = appendHead(b, m.Type, m.Timestamp, m.StateUpdatedAt, m.Region)
	b = append(b, `,"tracks":[`...)
	for i := range m.Tracks {
		if i > 0 {
			b = append(b, ',')
		}
		b = appendTrack(b, &m.Tracks[i])
	}
	b = append(b, ']')
	if len(m.Leaves) > 0 {
		b = append(b, `,"leaves":[`...)
		for i, d := range m.Leaves {
			if i > 0 {
				b = append(b, ',')
			}
			b = appendDeparture(b, d)
		}
		b = append(b, ']')
	}
	return append(b, '}')
}

func AppendLeave(b []byte, l *Leave) []byte {
	b = append(b, `{"type":"`...)
	b = append(b, l.Type...)
	b = append(b, `","timestamp":`...)
	b = strconv.AppendInt(b, l.Timestamp, 10)
	b = appendRegion(append(b, `,"region":`...), l.Region)
	b = appendDeparture(append(b, `,"leave":`...), l.Leave)
	return append(b, '}')
}

func appendHead(b []byte, typ string, ts, state int64, r Region) []byte {
	b = append(b, `{"type":"`...)
	b = append(b, typ...)
	b = append(b, `","timestamp":`...)
	b = strconv.AppendInt(b, ts, 10)
	b = append(b, `,"state_updated_at":`...)
	b = strconv.AppendInt(b, state, 10)
	return appendRegion(append(b, `,"region":`...), r)
}

func appendTrack(b []byte, t *Track) []byte {
	b = append(b, `{"ID":`...)
	b = strconv.AppendUint(b, uint64(t.ID), 10)
	b = append(b, `,"TrackNumber":`...)
	b = strconv.AppendUint(b, uint64(t.TrackNumber), 10)
	b = appendFloat(append(b, `,"Altitude":`...), t.Altitude)
	b = appendFloat(append(b, `,"Latitude":`...), t.Latitude)
	b = appendFloat(append(b, `,"Longitude":`...), t.Longitude)
	b = appendFloat(append(b, `,"Velocity":`...), t.Velocity)
	b = appendFloat(append(b, `,"Heading":`...), t.Heading)
	b = append(b, `,"Quantity":`...)
	b = strconv.AppendInt(b, int64(t.Quantity), 10)
	b = append(append(b, `,"Model":"`...), t.Model...)
	b = append(append(b, `","Mode3a":"`...), t.Mode3a...)
	b = append(append(b, `","Serial":"`...), t.Serial...)
	b = append(b, `","UpdatedAt":`...)
	b = strconv.AppendInt(b, t.UpdatedAt, 10)
	b = append(b, `,"CreatedAt":`...)
	b = strconv.AppendInt(b, t.CreatedAt, 10)
	return append(b, '}')
}

func appendDeparture(b []byte, d Departure) []byte {
	b = append(b, `{"track_id":`...)
	b = strconv.AppendUint(b, uint64(d.TrackID), 10)
	b = appendRegion(append(b, `,"to_region":`...), d.ToRegion)
	b = append(b, `,"updated_at":`...)
	b = strconv.AppendInt(b, d.UpdatedAt, 10)
	return append(b, '}')
}

func appendRegion(b []byte, r Region) []byte {
	b = append(b, `{"scheme":"`...)
	b = append(b, r.Scheme...)
	b = append(b, `","zoom":`...)
	b = strconv.AppendInt(b, int64(r.Zoom), 10)
	b = append(b, `,"x":`...)
	b = strconv.AppendInt(b, int64(r.X), 10)
	b = append(b, `,"y":`...)
	b = strconv.AppendInt(b, int64(r.Y), 10)
	return append(b, '}')
}

// appendFloat writes a float32 the way encoding/json does for |v| in [1e-6, 1e21), the range of every
// coordinate, altitude, speed and heading; smaller values are written as 0 (they never matter here).
func appendFloat(b []byte, v float32) []byte {
	if math.Abs(float64(v)) < 1e-6 {
		return append(b, '0')
	}
	return strconv.AppendFloat(b, float64(v), 'f', -1, 32)
}
