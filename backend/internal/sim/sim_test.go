package sim

import (
	"math"
	"strings"
	"sync"
	"testing"
	"time"

	"dronetracks/internal/tiles"
	"dronetracks/internal/wire"
)

type capture struct {
	mu   sync.Mutex
	msgs map[string][]byte
}

func (c *capture) pub(subject string, data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, dup := c.msgs[subject]; dup {
		panic("tile published twice in one tick: " + subject)
	}
	c.msgs[subject] = append([]byte(nil), data...)
	return nil
}

func TestPublishRoundTrip(t *testing.T) {
	const n = 20000
	f := NewFleet(n, 7, 4)
	c := &capture{msgs: map[string][]byte{}}
	p := NewPublisher(c.pub, time.Second, c.pub, c.pub) // three parallel "connections"
	for tick := 0; tick < 3; tick++ {
		f.Step(1)
		clear(c.msgs)
		st, err := p.Publish(f)
		if err != nil {
			t.Fatal(err)
		}
		if st.Messages != len(c.msgs) {
			t.Fatalf("messages %d, distinct subjects %d", st.Messages, len(c.msgs))
		}
		seen := 0
		for subj, b := range c.msgs {
			h, err := wire.ParseHeader(b)
			if err != nil {
				t.Fatal(err)
			}
			if subj != tiles.Subject(int(h.X), int(h.Y)) || !strings.HasPrefix(subj, "tracks.13.") {
				t.Fatalf("subject %s does not match header %d/%d", subj, h.X, h.Y)
			}
			for j := 0; j < int(h.Count); j++ {
				r := wire.RecordAt(b, j)
				i := int(r.ID) - 1
				mx := (float64(h.X) + float64(r.Lx)/65536) / 8192
				my := (float64(h.Y) + float64(r.Ly)/65536) / 8192
				if math.Abs(mx-f.MX[i]) > 2e-9 || math.Abs(my-f.MY[i]) > 2e-9 {
					t.Fatalf("drone %d decoded off by %g,%g", i, mx-f.MX[i], my-f.MY[i])
				}
				if math.Abs(float64(r.AltDm)/10-float64(f.Alt[i])) > 0.06 {
					t.Fatalf("alt %v vs %v", r.AltDm, f.Alt[i])
				}
				seen++
			}
		}
		if seen != n {
			t.Fatalf("tick %d: decoded %d of %d drones", tick, seen, n)
		}
	}
}

func TestEmptyTileSnapshot(t *testing.T) {
	f := NewFleet(1, 1, 1)
	c := &capture{msgs: map[string][]byte{}}
	p := NewPublisher(c.pub, time.Second)
	f.Step(1)
	p.Publish(f)
	var first string
	for s := range c.msgs {
		first = s
	}
	// teleport the drone far away; the old tile must receive one empty snapshot
	f.MX[0], f.MY[0] = tiles.LonLatToMerc(-74.006, 40.7128)
	f.TX[0], f.TY[0] = f.MX[0], f.MY[0]
	f.Step(1)
	clear(c.msgs)
	st, _ := p.Publish(f)
	h, err := wire.ParseHeader(c.msgs[first])
	if err != nil || h.Count != 0 || st.Empty != 1 || len(c.msgs) != 2 {
		t.Fatalf("expected empty snapshot on %s: %+v err=%v stats=%+v", first, h, err, st)
	}
	clear(c.msgs)
	f.Step(1)
	p.Publish(f)
	if _, again := c.msgs[first]; again {
		t.Fatal("empty snapshot must be sent only once")
	}
}

func TestMotionIsPlausible(t *testing.T) {
	f := NewFleet(2000, 3, 2)
	f.Step(1)
	px := append([]float64(nil), f.MX...)
	py := append([]float64(nil), f.MY...)
	f.Step(1)
	for i := 0; i < f.N; i++ {
		mpm := tiles.MercPerMeter(f.MY[i])
		d := math.Hypot(f.MX[i]-px[i], f.MY[i]-py[i]) / mpm
		if d > 40 {
			t.Fatalf("drone %d moved %.1f m in one second", i, d)
		}
	}
}

func TestCitiesStayInRegion(t *testing.T) {
	in := func(lon, lat float64) bool {
		return lon >= Region.W && lon <= Region.E && lat >= Region.S && lat <= Region.N
	}
	// sample clips at 3 sigma, so the regional class (widest spread) bounds every waypoint
	for _, c := range Cities {
		mx, my := tiles.LonLatToMerc(c.Lon, c.Lat)
		r := 3 * c.SigmaKm * 1000 * classSpread[2] * tiles.MercPerMeter(my)
		for _, d := range [][2]float64{{-r, -r}, {-r, r}, {r, -r}, {r, r}} {
			if lon, lat := tiles.MercToLonLat(mx+d[0], my+d[1]); !in(lon, lat) {
				t.Fatalf("%s can place drones at %.2f,%.2f, outside the region", c.Name, lon, lat)
			}
		}
	}
	f := NewFleet(20000, 5, 4)
	for tick := 0; tick < 5; tick++ {
		f.Step(1)
	}
	for i := 0; i < f.N; i++ {
		if lon, lat := tiles.MercToLonLat(f.MX[i], f.MY[i]); !in(lon, lat) {
			t.Fatalf("drone %d at %.2f,%.2f is outside the region", i, lon, lat)
		}
	}
}

func BenchmarkTick1M(b *testing.B) {
	f := NewFleet(1_000_000, 1, 8)
	p := NewPublisher(func(string, []byte) error { return nil }, time.Second)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		f.Step(1)
		if _, err := p.Publish(f); err != nil {
			b.Fatal(err)
		}
	}
}
