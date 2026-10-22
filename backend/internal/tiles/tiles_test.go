package tiles

import (
	"math"
	"testing"
)

func TestMercRoundTrip(t *testing.T) {
	for _, p := range [][2]float64{{0, 0}, {105.8342, 21.0278}, {-74.006, 40.7128}, {139.6917, 35.6895}, {-179.9, -84.9}} {
		mx, my := LonLatToMerc(p[0], p[1])
		lon, lat := MercToLonLat(mx, my)
		if math.Abs(lon-p[0]) > 1e-9 || math.Abs(lat-p[1]) > 1e-9 {
			t.Fatalf("round trip %v -> %v,%v", p, lon, lat)
		}
	}
}

func TestTileXY(t *testing.T) {
	// Hanoi at z13, cross-checked with the standard slippy-map formula.
	mx, my := LonLatToMerc(105.8342, 21.0278)
	x, y := TileXY(13, mx, my)
	if x != 6504 || y != 3606 {
		t.Fatalf("got %d,%d", x, y)
	}
	if Subject(x, y) != "tracks.13.6504.3606" {
		t.Fatal(Subject(x, y))
	}
	if kx, ky := Unkey(Key(x, y)); kx != x || ky != y {
		t.Fatal("key round trip")
	}
}

func TestMercPerMeter(t *testing.T) {
	_, my := LonLatToMerc(0, 60)
	// at 60 degrees one metre spans twice as much mercator as at the equator
	if r := MercPerMeter(my) * EarthCircumferenceM; math.Abs(r-2) > 1e-9 {
		t.Fatalf("scale %v", r)
	}
}

func TestStatsLevel(t *testing.T) {
	cases := map[float64]int{0: 3, 2.7: 5, 9.99: 12, 12: 15, 12.9: 15, 20: 15, -1: 2}
	for z, want := range cases {
		if got := StatsLevel(z); got != want {
			t.Fatalf("StatsLevel(%v)=%d want %d", z, got, want)
		}
	}
}

func TestCoverTopics(t *testing.T) {
	// A ~1920x1080 px viewport at zoom 13.5 around Tokyo.
	lon, lat := 139.6917, 35.6895
	mx, my := LonLatToMerc(lon, lat)
	world := 512 * math.Pow(2, 13.5)
	hw, hh := 960/world, 540/world
	w, n := MercToLonLat(mx-hw, my-hh)
	e, s := MercToLonLat(mx+hw, my+hh)
	b := BBox{W: w, S: s, E: e, N: n}

	got, trunc, _ := CoverTopics(b, 0, 0)
	if trunc {
		t.Fatal("unexpected truncation")
	}
	inView, sawRing := 0, false
	for _, c := range got {
		if c.InView {
			inView++
			if sawRing {
				t.Fatal("viewport tiles must come first")
			}
		} else {
			sawRing = true
		}
	}
	// viewport spans ~2.65 x 1.5 tiles => 3-4 x 2-3 tiles, plus one ring
	if inView < 6 || inView > 12 {
		t.Fatalf("in-view tiles %d", inView)
	}
	if len(got) <= inView {
		t.Fatal("ring missing")
	}
	cx, cy := TileXY(13, mx, my)
	if !got[0].InView || abs(got[0].X-cx) > 1 || abs(got[0].Y-cy) > 1 {
		t.Fatalf("first tile should be near centre: %+v vs %d,%d", got[0], cx, cy)
	}

	wider, _, _ := CoverTopics(b, 1, 0)
	if len(wider) <= len(got) {
		t.Fatal("margin should add tiles")
	}
	capped, trunc, _ := CoverTopics(b, 2, 10)
	if !trunc || len(capped) != 10 || !capped[0].InView {
		t.Fatal("cap")
	}
}

func TestCoverAntimeridian(t *testing.T) {
	b := BBox{W: 179.98, S: -16.01, E: 180.02, N: -15.99}
	got, _, _ := CoverTopics(b, 0, 0)
	seen := map[uint32]bool{}
	for _, c := range got {
		if c.X < 0 || c.X >= 1<<13 {
			t.Fatalf("x not wrapped: %d", c.X)
		}
		k := Key(c.X, c.Y)
		if seen[k] {
			t.Fatal("duplicate tile")
		}
		seen[k] = true
	}
	hasWest, hasEast := false, false
	for _, c := range got {
		hasWest = hasWest || c.X < 10
		hasEast = hasEast || c.X > 8180
	}
	if !hasWest || !hasEast {
		t.Fatal("cover should span both sides of the antimeridian")
	}
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

func TestCoverTooLarge(t *testing.T) {
	if _, _, err := CoverTopics(BBox{W: -180, S: -80, E: 180, N: 80}, 0.5, 256); err != ErrCoverTooLarge {
		t.Fatalf("world-wide bbox must be rejected, got %v", err)
	}
}
