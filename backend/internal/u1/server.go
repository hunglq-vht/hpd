package u1

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"slices"
	"time"

	"dronetracks/internal/tiles"
)

// BasePath is where u1-track-manager serves its API.
const BasePath = "/u1-track-manager"

// Defaults when a resolve request sends no limits (what the frontend sends by default).
const (
	DefaultMaxPartitions   = 36
	DefaultMaxCachedTracks = 4000
)

// Server serves the u1-track-manager API that the frontend uses:
//
//	POST /u1-track-manager/tracks/subscriptions/resolve   the region subjects that cover a viewport
//	GET  /u1-track-manager/tracks/regions/stats           tracks per region, for the cluster view
//
// Subjects are those of the JSON format; a client of another format swaps the prefix. No login:
// the SSO token that the dev proxy adds is ignored.
type Server struct {
	prefix string
	counts func() Counts
	mux    *http.ServeMux
	now    func() time.Time
}

func NewServer(prefix string, counts func() Counts) *Server {
	s := &Server{prefix: prefix, counts: counts, mux: http.NewServeMux(), now: time.Now}
	s.mux.HandleFunc("POST "+BasePath+"/tracks/subscriptions/resolve", s.resolve)
	s.mux.HandleFunc("GET "+BasePath+"/tracks/regions/stats", s.stats)
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	s.mux.ServeHTTP(w, r)
}

type viewport struct {
	West  float64 `json:"west"`
	South float64 `json:"south"`
	East  float64 `json:"east"`
	North float64 `json:"north"`
}

type resolveRequest struct {
	Viewport           viewport `json:"viewport"`
	MapZoom            float64  `json:"map_zoom"`
	PreferredPartition *struct {
		Scheme string `json:"scheme"`
		Zoom   *int   `json:"zoom"`
	} `json:"preferred_partition"`
	Limits struct {
		MaxPartitions   int `json:"max_partitions"`
		MaxCachedTracks int `json:"max_cached_tracks"`
	} `json:"limits"`
}

// resolve answers like the dev server (checked 2026-10-26): the z13 regions the viewport touches,
// with no neighbour ring; 422 SUBSCRIPTION_LIMIT_EXCEEDED rather than a shorter list when they are
// more than max_partitions or hold more than max_cached_tracks; 400 for a zoom other than 13.
func (s *Server) resolve(w http.ResponseWriter, r *http.Request) {
	var req resolveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body: "+err.Error())
		return
	}
	if p := req.PreferredPartition; p != nil && p.Zoom != nil && *p.Zoom != tiles.TopicZoom {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("partition zoom %d not supported (only %d)", *p.Zoom, tiles.TopicZoom))
		return
	}
	v := req.Viewport
	for _, c := range []float64{v.West, v.South, v.East, v.North} {
		if math.IsNaN(c) || math.IsInf(c, 0) {
			writeError(w, http.StatusBadRequest, "viewport: numbers required")
			return
		}
	}
	if !(v.West < v.East && v.South < v.North) {
		writeError(w, http.StatusBadRequest, "viewport: west < east and south < north required")
		return
	}
	maxParts := cmpOr(req.Limits.MaxPartitions, DefaultMaxPartitions)
	maxTracks := cmpOr(req.Limits.MaxCachedTracks, DefaultMaxCachedTracks)

	x0, y0, x1, y1 := tiles.BBox{W: v.West, S: v.South, E: v.East, N: v.North}.Merc().TileRange(tiles.TopicZoom)
	n := 1 << tiles.TopicZoom
	if x1-x0+1 > n { // whole world
		x0, x1 = 0, n-1
	}
	partitions := (x1 - x0 + 1) * (y1 - y0 + 1)
	counts := s.counts()
	estimated := 0
	for k, c := range counts {
		x, y := tiles.Unkey(k)
		if y >= y0 && y <= y1 && inWrapped(x, x0, x1, n) {
			estimated += int(c)
		}
	}

	refuse := func(limit, msg string, applied map[string]int, parts int) {
		writeJSONStatus(w, http.StatusUnprocessableEntity, map[string]any{
			"code": "SUBSCRIPTION_LIMIT_EXCEEDED", "limit": limit, "limits_applied": applied,
			"message":  "SUBSCRIPTION_LIMIT_EXCEEDED: " + msg,
			"required": map[string]int{"estimated_cached_tracks": estimated, "partition_count": parts},
		})
	}
	if partitions > maxParts {
		refuse("max_partitions", fmt.Sprintf("partition_count %d exceeds max_partitions %d (estimated tracks %d)", partitions, maxParts, estimated),
			map[string]int{"max_cached_tracks": 0, "max_partitions": maxParts}, partitions)
		return
	}
	if estimated > maxTracks {
		// like the dev server, a refusal on track count reports 0 partitions
		refuse("max_cached_tracks", fmt.Sprintf("estimated_cached_tracks %d exceeds max_cached_tracks %d", estimated, maxTracks),
			map[string]int{"max_cached_tracks": maxTracks, "max_partitions": 0}, 0)
		return
	}
	topics := make([]string, 0, partitions)
	for ux := x0; ux <= x1; ux++ {
		for y := y0; y <= y1; y++ {
			topics = append(topics, Subject(s.prefix, tiles.WrapTileX(tiles.TopicZoom, ux), y))
		}
	}
	writeJSONStatus(w, http.StatusOK, map[string]any{
		"effective_partition":     map[string]any{"scheme": Scheme, "zoom": tiles.TopicZoom, "x": 0, "y": 0},
		"viewport_with_buffer":    v,
		"partition_count":         partitions,
		"estimated_cached_tracks": estimated,
		"topics":                  topics,
		"resolved_at":             s.now().Unix(),
	})
}

// stats lists every non-empty region with its track count, as the u1 spec describes (the dev
// server has not deployed this endpoint).
func (s *Server) stats(w http.ResponseWriter, r *http.Request) {
	type row struct {
		Topic string `json:"topic"`
		Count int32  `json:"active_track_count"`
	}
	counts := s.counts()
	keys := make([]uint32, 0, len(counts))
	for k := range counts {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	rows := make([]row, len(keys))
	for i, k := range keys {
		x, y := tiles.Unkey(k)
		rows[i] = row{Subject(s.prefix, x, y), counts[k]}
	}
	writeJSONStatus(w, http.StatusOK, map[string]any{"regions": rows})
}

// inWrapped tells whether tile x lies in the unwrapped range x0..x1 of a world n tiles wide.
func inWrapped(x, x0, x1, n int) bool {
	for _, d := range []int{-n, 0, n} {
		if x+d >= x0 && x+d <= x1 {
			return true
		}
	}
	return false
}

func cmpOr(v, def int) int {
	if v > 0 {
		return v
	}
	return def
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSONStatus(w, status, map[string]any{"code": status, "message": msg})
}

func writeJSONStatus(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
