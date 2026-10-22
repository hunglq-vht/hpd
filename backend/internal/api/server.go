// Package api serves the tiling agreement, cluster statistics and topic covers over HTTP.
package api

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"

	"dronetracks/internal/monitor"
	"dronetracks/internal/tiles"
	"dronetracks/internal/wire"
)

// Config is the public part of the agreement, served at /api/config.
type Config struct {
	TileScheme        string     `json:"tileScheme"`
	TopicZoom         int        `json:"topicZoom"`
	RealtimeMinZoom   int        `json:"realtimeMinZoom"`
	StatsMaxLevel     int        `json:"statsMaxLevel"`
	StatsLevelOffset  int        `json:"statsLevelOffset"`
	SubjectPrefix     string     `json:"subjectPrefix"`
	SubjectPattern    string     `json:"subjectPattern"`
	PublishIntervalMs int        `json:"publishIntervalMs"`
	StaleFactor       float64    `json:"staleFactor"`
	DefaultMargin     float64    `json:"defaultMargin"`
	MaxTopics         int        `json:"maxTopics"`
	WireVersion       int        `json:"wireVersion"`
	NATS              NATSConfig `json:"nats"`
}

type NATSConfig struct {
	WsURL  string `json:"wsUrl"`
	WsPath string `json:"wsPath"`
	User   string `json:"user"`
	Pass   string `json:"pass"`
}

func DefaultConfig() Config {
	return Config{
		TileScheme: "xyz-webmercator", TopicZoom: tiles.TopicZoom, RealtimeMinZoom: tiles.RealtimeMinZoom,
		StatsMaxLevel: tiles.StatsMaxLevel, StatsLevelOffset: tiles.StatsLevelOffset,
		SubjectPrefix: tiles.SubjectPrefix, SubjectPattern: tiles.SubjectPrefix + ".{z}.{x}.{y}",
		PublishIntervalMs: 1000, StaleFactor: 1.5, DefaultMargin: 0.5, MaxTopics: 256, WireVersion: wire.Version,
		NATS: NATSConfig{WsPath: "/nats", User: "viewer", Pass: "viewer"},
	}
}

type Server struct {
	cfg Config
	mon *monitor.Monitor
	mux *http.ServeMux
}

func NewServer(cfg Config, mon *monitor.Monitor) *Server {
	s := &Server{cfg: cfg, mon: mon, mux: http.NewServeMux()}
	s.mux.HandleFunc("GET /api/config", s.config)
	s.mux.HandleFunc("GET /api/stats", s.stats)
	s.mux.HandleFunc("GET /api/topics", s.topics)
	s.mux.HandleFunc("GET /api/tiles/top", s.top)
	s.mux.HandleFunc("GET /api/metrics", s.metrics)
	s.mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"ok": true, "total": s.mon.Snapshot().Total})
	})
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Cache-Control", "no-store")
	s.mux.ServeHTTP(w, r)
}

func (s *Server) config(w http.ResponseWriter, r *http.Request) {
	c := s.cfg
	c.PublishIntervalMs = s.mon.Snapshot().IntervalMs
	writeJSON(w, c)
}

func (s *Server) stats(w http.ResponseWriter, r *http.Request) {
	b, err := parseBBox(r.URL.Query().Get("bbox"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	zoom, err := strconv.ParseFloat(r.URL.Query().Get("zoom"), 64)
	if err != nil || math.IsNaN(zoom) {
		http.Error(w, "zoom: number required", http.StatusBadRequest)
		return
	}
	level := tiles.StatsLevel(zoom)
	snap := s.mon.Snapshot()

	// hand-rolled JSON: this is the hot endpoint in cluster mode
	buf := make([]byte, 0, 32*1024)
	buf = fmt.Appendf(buf, `{"level":%d,"seq":%d,"updatedAt":%.1f,"total":%d,"cells":[`, level, snap.Seq, snap.UpdatedAt, snap.Total)
	var inView uint64
	first := true
	snap.CellsIn(level, b.Merc(), func(x, y int, c monitor.Cell) {
		inView += uint64(c.Count)
		lon, lat := c.Centroid()
		if !first {
			buf = append(buf, ',')
		}
		first = false
		buf = append(buf, '[')
		buf = strconv.AppendInt(buf, int64(x), 10)
		buf = append(buf, ',')
		buf = strconv.AppendInt(buf, int64(y), 10)
		buf = append(buf, ',')
		buf = strconv.AppendUint(buf, uint64(c.Count), 10)
		buf = append(buf, ',')
		buf = strconv.AppendFloat(buf, lon, 'f', 5, 64)
		buf = append(buf, ',')
		buf = strconv.AppendFloat(buf, lat, 'f', 5, 64)
		buf = append(buf, ']')
	})
	buf = fmt.Appendf(buf, `],"inView":%d}`, inView)
	w.Header().Set("Content-Type", "application/json")
	w.Write(buf)
}

type topic struct {
	Subject string `json:"subject"`
	X       int    `json:"x"`
	Y       int    `json:"y"`
	Count   uint32 `json:"count"`
	InView  bool   `json:"inView"`
}

func (s *Server) topics(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	b, err := parseBBox(q.Get("bbox"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	margin := s.cfg.DefaultMargin
	if v := q.Get("margin"); v != "" {
		if margin, err = strconv.ParseFloat(v, 64); err != nil || math.IsNaN(margin) {
			http.Error(w, "margin: number required", http.StatusBadRequest)
			return
		}
	}
	margin = math.Max(0, math.Min(2, margin))
	limit := s.cfg.MaxTopics
	if v, err := strconv.Atoi(q.Get("max")); err == nil && v > 0 && v < limit {
		limit = v
	}

	cover, truncated, err := tiles.CoverTopics(b, margin, limit)
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	snap := s.mon.Snapshot()
	out := struct {
		Level          int     `json:"level"`
		ViewportTiles  int     `json:"viewportTiles"`
		ExpectedTracks uint64  `json:"expectedTracks"`
		ViewportTracks uint64  `json:"viewportTracks"`
		Truncated      bool    `json:"truncated"`
		Topics         []topic `json:"topics"`
	}{Level: tiles.TopicZoom, Truncated: truncated, Topics: make([]topic, 0, len(cover))}
	for _, c := range cover {
		n := snap.TileCount(c.X, c.Y)
		out.ExpectedTracks += uint64(n)
		if c.InView {
			out.ViewportTiles++
			out.ViewportTracks += uint64(n)
		}
		out.Topics = append(out.Topics, topic{tiles.Subject(c.X, c.Y), c.X, c.Y, n, c.InView})
	}
	writeJSON(w, out)
}

func (s *Server) top(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	snap := s.mon.Snapshot()
	limit = max(1, min(limit, len(snap.Top)))
	if len(snap.Top) == 0 {
		limit = 0
	}
	type row struct {
		Subject string  `json:"subject"`
		X       int     `json:"x"`
		Y       int     `json:"y"`
		Count   uint32  `json:"count"`
		Lon     float64 `json:"lon"`
		Lat     float64 `json:"lat"`
	}
	rows := make([]row, 0, limit)
	scale := float64(int(1) << tiles.TopicZoom)
	for _, t := range snap.Top[:limit] {
		lon, lat := tiles.MercToLonLat((float64(t.X)+0.5)/scale, (float64(t.Y)+0.5)/scale)
		rows = append(rows, row{tiles.Subject(t.X, t.Y), t.X, t.Y, t.Count, lon, lat})
	}
	writeJSON(w, map[string]any{"total": snap.Total, "tiles": rows})
}

func (s *Server) metrics(w http.ResponseWriter, r *http.Request) {
	snap := s.mon.Snapshot()
	m := s.mon.Metrics()
	writeJSON(w, map[string]any{
		"snapshotSeq": snap.Seq, "updatedAt": snap.UpdatedAt, "totalTracks": snap.Total, "tiles": snap.Tiles,
		"buildMs": snap.BuildMs, "intervalMs": snap.IntervalMs,
		"msgsPerSec": math.Round(m.MsgsPerSec), "bytesPerSec": math.Round(m.BytesPerSec), "tracksPerSec": math.Round(m.TracksPerSec),
		"latencyMs":   map[string]float64{"p50": m.LatencyP50, "p99": m.LatencyP99, "max": m.LatencyMax},
		"badMessages": m.BadMessages,
	})
}

func parseBBox(s string) (tiles.BBox, error) {
	p := strings.Split(s, ",")
	if len(p) != 4 {
		return tiles.BBox{}, fmt.Errorf("bbox: expected w,s,e,n")
	}
	var v [4]float64
	for i := range p {
		f, err := strconv.ParseFloat(strings.TrimSpace(p[i]), 64)
		if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
			return tiles.BBox{}, fmt.Errorf("bbox: invalid number %q", p[i])
		}
		v[i] = f
	}
	b := tiles.BBox{W: v[0], S: v[1], E: v[2], N: v[3]}
	if b.E < b.W || b.N < b.S || b.E-b.W > 720 {
		return tiles.BBox{}, fmt.Errorf("bbox: expected w<=e and s<=n")
	}
	return b, nil
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
