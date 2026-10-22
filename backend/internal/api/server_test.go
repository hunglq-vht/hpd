package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"dronetracks/internal/monitor"
	"dronetracks/internal/tiles"
	"dronetracks/internal/wire"
)

func feed(m *monitor.Monitor, lon, lat float64, n int) {
	mx, my := tiles.LonLatToMerc(lon, lat)
	x, y := tiles.TileXY(13, mx, my)
	b := make([]byte, wire.HeaderSize+n*wire.RecordSize)
	wire.PutHeader(b, wire.Header{Zoom: 13, X: uint32(x), Y: uint32(y), Seq: 1, Count: uint32(n), IntervalMs: 1000, Parts: 1,
		PublishedAt: float64(time.Now().UnixNano()) / 1e6})
	for i := 0; i < n; i++ {
		wire.PutRecord(b[wire.HeaderSize+i*wire.RecordSize:], wire.Record{ID: uint32(i + 1), Lx: 30000, Ly: 30000})
	}
	m.Handle(b)
}

func get(t *testing.T, h http.Handler, url string, want int, out any) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", url, nil))
	if rec.Code != want {
		t.Fatalf("%s: status %d (%s)", url, rec.Code, rec.Body.String())
	}
	if out != nil {
		if err := json.Unmarshal(rec.Body.Bytes(), out); err != nil {
			t.Fatalf("%s: %v: %s", url, err, rec.Body.String())
		}
	}
}

func TestEndpoints(t *testing.T) {
	m := monitor.New()
	feed(m, 105.8342, 21.0278, 40) // Hanoi
	feed(m, 139.6917, 35.6895, 7)  // Tokyo
	m.Build()
	srv := NewServer(DefaultConfig(), m)

	var cfg Config
	get(t, srv, "/api/config", 200, &cfg)
	if cfg.TopicZoom != 13 || cfg.NATS.WsPath != "/nats" {
		t.Fatalf("config %+v", cfg)
	}

	var stats struct {
		Level  int         `json:"level"`
		Total  int         `json:"total"`
		InView int         `json:"inView"`
		Cells  [][]float64 `json:"cells"`
	}
	get(t, srv, "/api/stats?bbox=-180,-80,180,80&zoom=1.5", 200, &stats)
	if stats.Level != 4 || stats.Total != 47 || stats.InView != 47 || len(stats.Cells) != 2 {
		t.Fatalf("world stats %+v", stats)
	}
	get(t, srv, "/api/stats?bbox=105,20,107,22&zoom=8", 200, &stats)
	if stats.InView != 40 || len(stats.Cells) != 1 || stats.Cells[0][2] != 40 {
		t.Fatalf("hanoi stats %+v", stats)
	}

	var topics struct {
		ViewportTiles  int  `json:"viewportTiles"`
		ExpectedTracks int  `json:"expectedTracks"`
		Truncated      bool `json:"truncated"`
		Topics         []struct {
			Subject string `json:"subject"`
			Count   int    `json:"count"`
			InView  bool   `json:"inView"`
		} `json:"topics"`
	}
	get(t, srv, "/api/topics?bbox=105.80,21.00,105.87,21.05&zoom=13.5&margin=0.5", 200, &topics)
	if topics.ViewportTiles == 0 || topics.ExpectedTracks != 40 || !topics.Topics[0].InView {
		t.Fatalf("topics %+v", topics)
	}
	found := false
	for _, tp := range topics.Topics {
		found = found || (tp.Subject == "tracks.13.6504.3606" && tp.Count == 40)
	}
	if !found {
		t.Fatal("hanoi tile missing from cover")
	}

	get(t, srv, "/api/topics?bbox=-180,-80,180,80&zoom=13", 422, nil)
	get(t, srv, "/api/stats?bbox=1,2,3&zoom=1", 400, nil)
	get(t, srv, "/api/stats?bbox=1,2,3,4&zoom=abc", 400, nil)

	var top struct {
		Tiles []struct {
			Count int `json:"count"`
		} `json:"tiles"`
	}
	get(t, srv, "/api/tiles/top?limit=1", 200, &top)
	if len(top.Tiles) != 1 || top.Tiles[0].Count != 40 {
		t.Fatalf("top %+v", top)
	}
}
