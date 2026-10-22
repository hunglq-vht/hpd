package monitor

import (
	"math"
	"testing"
	"time"

	"dronetracks/internal/tiles"
	"dronetracks/internal/wire"
)

func msg(x, y int, seq uint32, pts [][2]uint16) []byte {
	b := make([]byte, wire.HeaderSize+len(pts)*wire.RecordSize)
	wire.PutHeader(b, wire.Header{Zoom: 13, X: uint32(x), Y: uint32(y), Seq: seq, Count: uint32(len(pts)), IntervalMs: 1000, Parts: 1,
		PublishedAt: float64(time.Now().UnixNano()) / 1e6})
	for i, p := range pts {
		wire.PutRecord(b[wire.HeaderSize+i*wire.RecordSize:], wire.Record{ID: uint32(i + 1), Lx: p[0], Ly: p[1]})
	}
	return b
}

func TestPyramid(t *testing.T) {
	m := New()
	// two points in the top-left z15 cell, one in the bottom-right, of tile (6504,3606)
	m.Handle(msg(6504, 3606, 1, [][2]uint16{{1000, 1000}, {3000, 3000}, {65000, 65000}}))
	m.Handle(msg(6505, 3606, 1, [][2]uint16{{32768, 32768}}))
	s := m.Build()

	if s.Total != 4 || s.Tiles != 2 {
		t.Fatalf("total %d tiles %d", s.Total, s.Tiles)
	}
	if got := s.Levels[15][cellKey(6504*4, 3606*4)].Count; got != 2 {
		t.Fatalf("z15 top-left count %d", got)
	}
	if got := s.Levels[15][cellKey(6504*4+3, 3606*4+3)].Count; got != 1 {
		t.Fatalf("z15 bottom-right count %d", got)
	}
	if s.TileCount(6504, 3606) != 3 || s.TileCount(6505, 3606) != 1 {
		t.Fatal("tile counts")
	}
	// level 0 holds everything; its centroid is the mean of the four points
	c := s.Levels[0][cellKey(0, 0)]
	if c.Count != 4 {
		t.Fatalf("level 0 count %d", c.Count)
	}
	wantX := ((6504 + 1000.0/65536) + (6504 + 3000.0/65536) + (6504 + 65000.0/65536) + (6505 + 0.5)) / 4 / 8192
	if math.Abs(c.SumX/4-wantX) > 1e-12 {
		t.Fatalf("centroid x %v want %v", c.SumX/4, wantX)
	}
	if len(s.Top) != 2 || s.Top[0].Count != 3 {
		t.Fatalf("top %+v", s.Top)
	}

	// an empty snapshot clears the tile
	m.Handle(msg(6505, 3606, 2, nil))
	s = m.Build()
	if s.Total != 3 || s.Tiles != 1 {
		t.Fatalf("after empty: total %d tiles %d", s.Total, s.Tiles)
	}
}

func TestStaleEviction(t *testing.T) {
	m := New()
	now := time.Now()
	m.now = func() time.Time { return now }
	m.Handle(msg(1, 1, 1, [][2]uint16{{1, 1}}))
	now = now.Add(5 * time.Second)
	if s := m.Build(); s.Total != 0 {
		t.Fatalf("stale tile not evicted: %d", s.Total)
	}
}

func TestCellsIn(t *testing.T) {
	m := New()
	m.Handle(msg(6504, 3606, 1, [][2]uint16{{1000, 1000}}))
	m.Handle(msg(100, 100, 1, [][2]uint16{{1000, 1000}}))
	s := m.Build()
	b := tiles.BBox{W: 105.5, S: 20.8, E: 106.2, N: 21.3} // around Hanoi
	level := 10
	var n int
	s.CellsIn(level, b.Merc(), func(x, y int, c Cell) {
		n++
		lon, lat := c.Centroid()
		if lon < 105.5 || lon > 106.2 || lat < 20.8 || lat > 21.3 {
			t.Fatalf("centroid outside bbox: %v %v", lon, lat)
		}
	})
	if n != 1 {
		t.Fatalf("expected 1 cell, got %d", n)
	}
	// a world-wide bbox at a fine level takes the map-iteration path and must still find both
	n = 0
	s.CellsIn(15, tiles.BBox{W: -180, S: -85, E: 180, N: 85}.Merc(), func(int, int, Cell) { n++ })
	if n != 2 {
		t.Fatalf("expected 2 cells world-wide, got %d", n)
	}
}
