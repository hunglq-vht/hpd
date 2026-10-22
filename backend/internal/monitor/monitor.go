// Package monitor watches the tile snapshot stream (tracks.13.>) and keeps per-tile statistics.
// Every tick it builds an immutable count/centroid pyramid (z15 -> z0) that the HTTP API reads
// without locking.
package monitor

import (
	"encoding/binary"
	"math"
	"slices"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"dronetracks/internal/tiles"
	"dronetracks/internal/wire"
)

const subBits = tiles.StatsMaxLevel - tiles.TopicZoom // 2 => 4x4 stats cells per topic tile
const subN = 1 << subBits

type cellSums struct {
	cnt    [subN * subN]uint32
	sx, sy [subN * subN]uint64 // sums of tile-local u16 coordinates
}

type tileCopy struct {
	key  uint32
	sums cellSums
}

type tileState struct {
	seq      uint32
	gotParts uint8
	at       time.Time
	sums     cellSums
}

// Cell is an aggregated stats cell. SumX/SumY are sums of normalised mercator coordinates.
type Cell struct {
	Count      uint32
	SumX, SumY float64
}

// Centroid returns the mean position of the tracks in the cell, in degrees.
func (c Cell) Centroid() (lon, lat float64) {
	return tiles.MercToLonLat(c.SumX/float64(c.Count), c.SumY/float64(c.Count))
}

// TileCount is used for the top-tiles listing.
type TileCount struct {
	X, Y  int
	Count uint32
}

// Snapshot is an immutable view of the statistics at one point in time.
type Snapshot struct {
	Seq        uint64
	UpdatedAt  float64 // unix ms
	Total      uint64
	Tiles      int
	IntervalMs int
	BuildMs    float64
	Levels     [tiles.StatsMaxLevel + 1]map[uint64]Cell
	Top        []TileCount
}

func cellKey(x, y int) uint64 { return uint64(x)<<32 | uint64(uint32(y)) }

// Metrics are monitor counters, refreshed every build.
type Metrics struct {
	MsgsPerSec, BytesPerSec, TracksPerSec float64
	LatencyP50, LatencyP99, LatencyMax    float64 // publish -> monitor, ms
	BadMessages                           uint64
}

// Monitor consumes tile snapshots.
type Monitor struct {
	mu    sync.Mutex
	tiles map[uint32]*tileState

	intervalMs atomic.Int32
	msgs       atomic.Uint64
	bytes      atomic.Uint64
	records    atomic.Uint64
	bad        atomic.Uint64

	latMu  sync.Mutex
	latBuf []float64
	latN   uint64

	scratch []tileCopy // reused by Build (single goroutine)

	snap    atomic.Pointer[Snapshot]
	metrics atomic.Pointer[Metrics]
	seq     uint64
	last    struct {
		at                   time.Time
		msgs, bytes, records uint64
	}
	now func() time.Time
}

func New() *Monitor {
	m := &Monitor{tiles: make(map[uint32]*tileState), now: time.Now, latBuf: make([]float64, 0, 4096)}
	m.intervalMs.Store(1000)
	m.snap.Store(&Snapshot{IntervalMs: 1000})
	m.metrics.Store(&Metrics{})
	return m
}

// Snapshot returns the latest pyramid.
func (m *Monitor) Snapshot() *Snapshot { return m.snap.Load() }

// Metrics returns the latest counters.
func (m *Monitor) Metrics() *Metrics { return m.metrics.Load() }

// Handle ingests one tile snapshot message. It is called from a single NATS subscription goroutine.
func (m *Monitor) Handle(data []byte) {
	h, err := wire.ParseHeader(data)
	if err != nil || h.Zoom != tiles.TopicZoom {
		m.bad.Add(1)
		return
	}
	now := m.now()
	m.msgs.Add(1)
	m.bytes.Add(uint64(len(data)))
	m.records.Add(uint64(h.Count))
	if h.IntervalMs > 0 {
		m.intervalMs.Store(int32(h.IntervalMs))
	}
	m.sampleLatency(float64(now.UnixNano())/1e6 - h.PublishedAt)

	var s cellSums
	for i := 0; i < int(h.Count); i++ {
		o := wire.HeaderSize + i*wire.RecordSize
		lx := binary.LittleEndian.Uint16(data[o+4:])
		ly := binary.LittleEndian.Uint16(data[o+6:])
		c := int(lx>>(16-subBits)) | int(ly>>(16-subBits))<<subBits
		s.cnt[c]++
		s.sx[c] += uint64(lx)
		s.sy[c] += uint64(ly)
	}

	key := tiles.Key(int(h.X), int(h.Y))
	m.mu.Lock()
	t := m.tiles[key]
	if t == nil {
		t = &tileState{}
		m.tiles[key] = t
	}
	if t.seq != h.Seq || t.gotParts == 0 {
		t.seq, t.gotParts, t.sums = h.Seq, 0, cellSums{}
	}
	for c := range s.cnt {
		t.sums.cnt[c] += s.cnt[c]
		t.sums.sx[c] += s.sx[c]
		t.sums.sy[c] += s.sy[c]
	}
	t.gotParts++
	t.at = now
	m.mu.Unlock()
}

func (m *Monitor) sampleLatency(ms float64) {
	m.latMu.Lock()
	m.latN++
	if len(m.latBuf) < cap(m.latBuf) {
		m.latBuf = append(m.latBuf, ms)
	} else {
		m.latBuf[m.latN%uint64(cap(m.latBuf))] = ms
	}
	m.latMu.Unlock()
}

// Build creates a new snapshot. Tiles not refreshed for 3 intervals are dropped.
func (m *Monitor) Build() *Snapshot {
	start := m.now()
	interval := time.Duration(m.intervalMs.Load()) * time.Millisecond
	stale := start.Add(-3 * interval)
	scale := float64(int(1) << tiles.TopicZoom)

	s := &Snapshot{IntervalMs: int(interval.Milliseconds())}

	// Copy the per-tile sums under the lock (a few ms) and aggregate outside it, so Handle --
	// and therefore the NATS subscription feeding it -- is never blocked by the pyramid build.
	m.mu.Lock()
	work := m.scratch[:0]
	for key, t := range m.tiles {
		if t.at.Before(stale) {
			delete(m.tiles, key)
			continue
		}
		work = append(work, tileCopy{key: key, sums: t.sums})
	}
	m.mu.Unlock()
	m.scratch = work

	l15 := make(map[uint64]Cell, len(work)*4)
	tileCounts := make([]TileCount, 0, len(work))
	var emptied []uint32
	for i := range work {
		key, sums := work[i].key, &work[i].sums
		tx, ty := tiles.Unkey(key)
		var total uint32
		for c, n := range sums.cnt {
			if n == 0 {
				continue
			}
			total += n
			fn := float64(n)
			l15[cellKey(tx<<subBits|c&(subN-1), ty<<subBits|c>>subBits)] = Cell{
				Count: n,
				SumX:  (fn*float64(tx) + float64(sums.sx[c])/65536) / scale,
				SumY:  (fn*float64(ty) + float64(sums.sy[c])/65536) / scale,
			}
		}
		if total == 0 {
			emptied = append(emptied, key) // the tile published an empty snapshot
			continue
		}
		s.Total += uint64(total)
		tileCounts = append(tileCounts, TileCount{tx, ty, total})
	}
	s.Tiles = len(tileCounts)
	if len(emptied) > 0 {
		m.mu.Lock()
		for _, key := range emptied {
			if t := m.tiles[key]; t != nil && t.sums.cnt == ([subN * subN]uint32{}) {
				delete(m.tiles, key)
			}
		}
		m.mu.Unlock()
	}

	s.Levels[tiles.StatsMaxLevel] = l15
	for l := tiles.StatsMaxLevel - 1; l >= 0; l-- {
		child := s.Levels[l+1]
		lv := make(map[uint64]Cell, len(child)/3+1)
		for k, c := range child {
			pk := cellKey(int(k>>32)>>1, int(uint32(k))>>1)
			p := lv[pk]
			p.Count += c.Count
			p.SumX += c.SumX
			p.SumY += c.SumY
			lv[pk] = p
		}
		s.Levels[l] = lv
	}

	sort.Slice(tileCounts, func(i, j int) bool { return tileCounts[i].Count > tileCounts[j].Count })
	s.Top = tileCounts[:min(len(tileCounts), 5000)]

	m.seq++
	s.Seq = m.seq
	end := m.now()
	s.UpdatedAt = float64(end.UnixNano()) / 1e6
	s.BuildMs = float64(end.Sub(start).Microseconds()) / 1000
	m.snap.Store(s)
	m.updateMetrics(end)
	return s
}

func (m *Monitor) updateMetrics(now time.Time) {
	msgs, bytes, recs := m.msgs.Load(), m.bytes.Load(), m.records.Load()
	met := &Metrics{BadMessages: m.bad.Load()}
	if !m.last.at.IsZero() {
		dt := now.Sub(m.last.at).Seconds()
		met.MsgsPerSec = float64(msgs-m.last.msgs) / dt
		met.BytesPerSec = float64(bytes-m.last.bytes) / dt
		met.TracksPerSec = float64(recs-m.last.records) / dt
	}
	m.last.at, m.last.msgs, m.last.bytes, m.last.records = now, msgs, bytes, recs

	m.latMu.Lock()
	lat := slices.Clone(m.latBuf)
	m.latBuf = m.latBuf[:0]
	m.latMu.Unlock()
	if len(lat) > 0 {
		slices.Sort(lat)
		met.LatencyP50 = lat[len(lat)/2]
		met.LatencyP99 = lat[min(len(lat)-1, len(lat)*99/100)]
		met.LatencyMax = lat[len(lat)-1]
	}
	m.metrics.Store(met)
}

// CellsIn calls fn for every non-empty cell at level that intersects r (unwrapped mercator rect).
func (s *Snapshot) CellsIn(level int, r tiles.MercRect, fn func(x, y int, c Cell)) {
	lv := s.Levels[level]
	if lv == nil {
		return
	}
	n := 1 << level
	x0, y0, x1, y1 := r.TileRange(level)
	if x1-x0+1 > n {
		x0, x1 = 0, n-1
	}
	area := (x1 - x0 + 1) * (y1 - y0 + 1)
	if area <= 4*len(lv) {
		seen := make(map[int]bool, x1-x0+1)
		for ux := x0; ux <= x1; ux++ {
			x := tiles.WrapTileX(level, ux)
			if seen[x] {
				continue
			}
			seen[x] = true
			for y := y0; y <= y1; y++ {
				if c, ok := lv[cellKey(x, y)]; ok {
					fn(x, y, c)
				}
			}
		}
		return
	}
	for k, c := range lv {
		x, y := int(k>>32), int(uint32(k))
		if y < y0 || y > y1 {
			continue
		}
		if inWrapped(x, x0, x1, n) {
			fn(x, y, c)
		}
	}
}

func inWrapped(x, x0, x1, n int) bool {
	for _, ux := range [3]int{x - n, x, x + n} {
		if ux >= x0 && ux <= x1 {
			return true
		}
	}
	return false
}

// TileCount returns the number of tracks in a topic tile.
func (s *Snapshot) TileCount(x, y int) uint32 {
	if lv := s.Levels[tiles.TopicZoom]; lv != nil {
		return lv[cellKey(x, y)].Count
	}
	return 0
}

// TimeReply encodes the current time for the svc.time responder.
func TimeReply(now time.Time) []byte {
	b := make([]byte, 8)
	binary.LittleEndian.PutUint64(b, math.Float64bits(float64(now.UnixNano())/1e6))
	return b
}
