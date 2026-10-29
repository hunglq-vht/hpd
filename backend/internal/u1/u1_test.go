package u1

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"dronetracks/internal/sim"
	"dronetracks/internal/tiles"
)

var sampleTrack = Track{
	ID: 381203, TrackNumber: 381203, Altitude: 347.45505, Latitude: 13.163352, Longitude: 108.78882,
	Velocity: 12.5, Heading: 271.25, Model: Model, Mode3a: "03-N-3164-OU", Serial: "03-N-3164-OU", UpdatedAt: 1793198912,
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestAppendMatchesEncodingJSON(t *testing.T) {
	r := Region{Scheme: Scheme, Zoom: 13, X: 6571, Y: 3793}
	u := Update{Type: "track.update", Timestamp: 1793198912021, StateUpdatedAt: 1793198911825, Region: r, Track: sampleTrack}
	if got, want := AppendUpdate(nil, &u), mustJSON(t, u); !bytes.Equal(got, want) {
		t.Fatalf("update\n got %s\nwant %s", got, want)
	}
	d := Departure{TrackID: 7, ToRegion: Region{Scheme: Scheme, Zoom: 13, X: 6572, Y: 3793}, UpdatedAt: 1793198912}
	l := Leave{Type: "track.leave", Timestamp: 1793198912021, Region: r, Leave: d}
	if got, want := AppendLeave(nil, &l), mustJSON(t, l); !bytes.Equal(got, want) {
		t.Fatalf("leave\n got %s\nwant %s", got, want)
	}
	for _, leaves := range [][]Departure{nil, {d, d}} {
		m := Batch{Type: "track.batch", Timestamp: 1, StateUpdatedAt: 2, Region: r, Tracks: []Track{sampleTrack, sampleTrack}, Leaves: leaves}
		if got, want := AppendBatch(nil, &m), mustJSON(t, m); !bytes.Equal(got, want) {
			t.Fatalf("batch\n got %s\nwant %s", got, want)
		}
	}
}

func TestUpdateLooksLikeTheDevServer(t *testing.T) {
	// a message from dev.utm.io.vn, 2026-10-28
	real := `{"type":"track.update","timestamp":1793198912021,"state_updated_at":1793198911825,"region":{"scheme":"web_mercator_xyz","zoom":13,"x":6571,"y":3793},"track":{"ID":381203,"TrackNumber":381203,"Altitude":347.45505,"Latitude":13.163352,"Longitude":108.78882,"Velocity":0,"Heading":0,"Quantity":0,"Model":"Simulation Drone","Mode3a":"03-N-3164-OU","Serial":"03-N-3164-OU","UpdatedAt":1793198912,"CreatedAt":0}}`
	var u Update
	if err := json.Unmarshal([]byte(real), &u); err != nil {
		t.Fatal(err)
	}
	if got := string(AppendUpdate(nil, &u)); got != real {
		t.Fatalf("re-encoded differently\n got %s\nwant %s", got, real)
	}
	if r := Registration(381203); len(r) != len("03-N-3164-OU") || r[2] != '-' || r[4] != '-' || r[9] != '-' {
		t.Fatalf("registration %q", r)
	}
}

type sent struct {
	subject string
	data    string
}

type capture struct {
	mu   sync.Mutex
	msgs []sent
}

func (c *capture) pub(subject string, data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.msgs = append(c.msgs, sent{subject, string(data)})
	return nil
}

// teleport moves drone i to a point and refreshes its region key, as Step would.
func teleport(f *sim.Fleet, i int, lon, lat float64) {
	f.MX[i], f.MY[i] = tiles.LonLatToMerc(lon, lat)
	x, y := tiles.TileXY(tiles.TopicZoom, f.MX[i], f.MY[i])
	f.Keys[i] = uint64(tiles.Key(x, y))<<32 | uint64(i)
}

func TestJSONLeaveComesBeforeUpdate(t *testing.T) {
	f := sim.NewFleetAround(Hotspots, 3, 1, 1)
	tr := NewTracker(f.N)
	c := &capture{}
	p := NewPublisher(FormatJSON, "u1.track.region", tr, c.pub)
	for i := range 3 {
		teleport(f, i, 105.80, 21.03)
	}
	if st, _ := p.Publish(f, tr.Update(f, time.Now())); st.Updates != 3 || st.Leaves != 0 {
		t.Fatalf("first tick %+v", st)
	}
	old := c.msgs[0].subject
	c.msgs = nil
	teleport(f, 1, 106.63, 10.82)
	st, err := p.Publish(f, tr.Update(f, time.Now()))
	if err != nil || st.Updates != 3 || st.Leaves != 1 || len(c.msgs) != 4 {
		t.Fatalf("second tick %+v err=%v msgs=%d", st, err, len(c.msgs))
	}
	var l Leave
	json.Unmarshal([]byte(c.msgs[1].data), &l)
	var u Update
	json.Unmarshal([]byte(c.msgs[2].data), &u)
	if c.msgs[1].subject != old || l.Type != "track.leave" || l.Leave.TrackID != 2 || u.Track.ID != 2 ||
		l.Leave.ToRegion != u.Region || c.msgs[2].subject != Subject("u1.track.region", u.Region.X, u.Region.Y) {
		t.Fatalf("leave %s on %s, then %s on %s", c.msgs[1].data, c.msgs[1].subject, c.msgs[2].data, c.msgs[2].subject)
	}
	if got := tr.Counts(); len(got) != 2 {
		t.Fatalf("counts %v", got)
	}
}

func TestBatchGroupsRegionsAndSplitsDenseOnes(t *testing.T) {
	n := BatchMax + 10
	f := sim.NewFleetAround(Hotspots, n, 1, 2)
	tr := NewTracker(f.N)
	c := &capture{}
	p := NewPublisher(FormatBatch, "u1.track.batch", tr, c.pub, c.pub)
	for i := range n - 1 {
		teleport(f, i, 105.80, 21.03)
	}
	teleport(f, n-1, 106.63, 10.82)
	p.Publish(f, tr.Update(f, time.Now()))
	if len(c.msgs) != 3 {
		t.Fatalf("%d batches, want 2 for the dense region + 1", len(c.msgs))
	}
	// the lone drone flies into the dense region; its old region empties and gets a batch of leaves only
	teleport(f, n-1, 105.80, 21.03)
	c.msgs = nil
	st, _ := p.Publish(f, tr.Update(f, time.Now()))
	seen := map[uint32]bool{}
	var leaves int
	for _, m := range c.msgs {
		var b Batch
		if err := json.Unmarshal([]byte(m.data), &b); err != nil || b.Type != "track.batch" || len(b.Tracks) > BatchMax {
			t.Fatalf("bad batch on %s: %v", m.subject, err)
		}
		if !strings.HasPrefix(m.subject, "u1.track.batch.xyz.13.") || m.subject != Subject("u1.track.batch", b.Region.X, b.Region.Y) {
			t.Fatalf("batch for %+v on %s", b.Region, m.subject)
		}
		for _, tk := range b.Tracks {
			if seen[tk.ID] {
				t.Fatalf("track %d sent twice", tk.ID)
			}
			seen[tk.ID] = true
		}
		leaves += len(b.Leaves)
	}
	if len(seen) != n || leaves != 1 || st.Updates != n || st.Leaves != 1 {
		t.Fatalf("tracks %d of %d, leaves %d, stats %+v", len(seen), n, leaves, st)
	}
}

func resolveReq(t *testing.T, s *Server, body string) (int, map[string]any) {
	t.Helper()
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest(http.MethodPost, BasePath+"/tracks/subscriptions/resolve", strings.NewReader(body)))
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	return w.Code, out
}

func TestResolveLikeTheDevServer(t *testing.T) {
	h := CentralHanoi
	counts := Counts{tiles.Key(h.DenseX, h.DenseY): 21106, tiles.Key(h.X0, h.Y0): 2500, tiles.Key(100, 100): 9}
	s := NewServer("u1.track.region", func() Counts { return counts })
	// a viewport inside regions 6502..6503 x 3605..3606
	lon0, lat1 := tiles.MercToLonLat((6502+0.5)/8192., (3605+0.5)/8192.)
	lon1, lat0 := tiles.MercToLonLat((6503+0.5)/8192., (3606+0.5)/8192.)
	view := func(limits string) string {
		return `{"viewport":{"west":` + ftoa(lon0) + `,"south":` + ftoa(lat0) + `,"east":` + ftoa(lon1) + `,"north":` + ftoa(lat1) +
			`},"map_zoom":13,"preferred_partition":{"scheme":"web_mercator_xyz","zoom":13},"limits":` + limits + `}`
	}

	code, out := resolveReq(t, s, view(`{"max_partitions":36,"max_cached_tracks":200000}`))
	if code != 200 || out["partition_count"].(float64) != 4 || out["estimated_cached_tracks"].(float64) != 23606 || len(out["topics"].([]any)) != 4 {
		t.Fatalf("200: %v", out)
	}
	code, out = resolveReq(t, s, view(`{"max_partitions":36,"max_cached_tracks":4000}`))
	req := out["required"].(map[string]any)
	if code != 422 || out["code"] != "SUBSCRIPTION_LIMIT_EXCEEDED" || out["limit"] != "max_cached_tracks" ||
		req["estimated_cached_tracks"].(float64) != 23606 || req["partition_count"].(float64) != 0 {
		t.Fatalf("422 tracks: %v", out)
	}
	code, out = resolveReq(t, s, view(`{"max_partitions":1,"max_cached_tracks":200000}`))
	if code != 422 || out["limit"] != "max_partitions" || out["required"].(map[string]any)["partition_count"].(float64) != 4 {
		t.Fatalf("422 partitions: %v", out)
	}
	code, out = resolveReq(t, s, strings.Replace(view(`{}`), `"zoom":13}`, `"zoom":14}`, 1))
	if code != 400 || !strings.Contains(out["message"].(string), "partition zoom 14 not supported (only 13)") {
		t.Fatalf("400: %v", out)
	}

	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest(http.MethodGet, BasePath+"/tracks/regions/stats", nil))
	var st struct {
		Regions []struct {
			Topic string `json:"topic"`
			Count int    `json:"active_track_count"`
		} `json:"regions"`
	}
	if json.Unmarshal(w.Body.Bytes(), &st); len(st.Regions) != 3 || !strings.HasPrefix(st.Regions[0].Topic, "u1.track.region.xyz.13.") {
		t.Fatalf("stats: %s", w.Body)
	}
}

func ftoa(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }

// The default load reproduces the dev server on 2026-10-26 once the drones have spread along their
// routes: about 100k tracks in central Hanoi, about 20k in its densest region. Simulated at 1/10
// scale to stay fast.
func TestDefaultLoadMatchesDevServer(t *testing.T) {
	const scale = 10
	f := sim.NewFleetAround(Hotspots, HotspotTracks()/scale, 42, 4)
	for range 900 {
		f.Step(1)
	}
	tr := NewTracker(f.N)
	c := tr.Update(f, time.Now()).Counts
	h := CentralHanoi
	block := c.InRange(h.X0, h.Y0, h.X1, h.Y1) * scale
	dense := c.InRange(h.DenseX, h.DenseY, h.DenseX, h.DenseY) * scale
	if block < 85_000 || block > 115_000 || dense < 16_000 || dense > 25_000 {
		t.Fatalf("central Hanoi %d tracks, region %d.%d %d", block, h.DenseX, h.DenseY, dense)
	}
	t.Logf("central Hanoi %d tracks, densest region %d", block, dense)
}
