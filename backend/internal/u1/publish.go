package u1

import (
	"errors"
	"math"
	"sync"
	"sync/atomic"
	"time"

	"dronetracks/internal/sim"
	"dronetracks/internal/tiles"
)

// Format is a wire format u1sim publishes, each on its own subject prefix.
type Format string

const (
	FormatJSON   Format = "json"   // one track.update per track per tick, like the dev server
	FormatBatch  Format = "batch"  // one track.batch per region per tick (split at BatchMax tracks)
	FormatBinary Format = "binary" // the demo's 16-byte records, one snapshot per region (sim.Publisher)
)

// Counts maps a region key (tiles.Key) to the number of tracks in it.
type Counts map[uint32]int32

// InRange returns the number of tracks in regions x0..x1, y0..y1 (inclusive, x already wrapped).
func (c Counts) InRange(x0, y0, x1, y1 int) int {
	sum := 0
	for k, n := range c {
		if x, y := tiles.Unkey(k); x >= x0 && x <= x1 && y >= y0 && y <= y1 {
			sum += int(n)
		}
	}
	return sum
}

const noRegion = math.MaxUint32

// Tick is what every format publishes from one fleet state: each drone's region, the region it
// left this tick, and the tracks per region.
type Tick struct {
	State  time.Time
	Key    []uint32 // region of drone i
	From   []uint32 // region drone i left this tick, or noRegion
	Moved  []int32  // drones with From set
	Counts Counts
}

// Tracker turns fleet positions into Ticks. It keeps each drone's region between ticks.
type Tracker struct {
	tick   Tick
	regs   []string // Mode3a / Serial of each drone
	counts atomic.Pointer[Counts]
}

func NewTracker(n int) *Tracker {
	t := &Tracker{tick: Tick{Key: make([]uint32, n), From: make([]uint32, n)}, regs: make([]string, n)}
	for i := range n {
		t.tick.Key[i] = noRegion
		t.regs[i] = Registration(uint32(i + 1))
	}
	return t
}

// Update reads the regions from f.Keys, which Step has refreshed.
func (t *Tracker) Update(f *sim.Fleet, state time.Time) *Tick {
	k := &t.tick
	k.State = state
	k.Moved = k.Moved[:0]
	counts := make(Counts, len(t.Counts()))
	for i, fk := range f.Keys {
		key := uint32(fk >> 32)
		counts[key]++
		k.From[i] = noRegion
		if old := k.Key[i]; old != key {
			if old != noRegion {
				k.From[i] = old
				k.Moved = append(k.Moved, int32(i))
			}
			k.Key[i] = key
		}
	}
	k.Counts = counts
	t.counts.Store(&counts)
	return k
}

// Counts returns the tracks per region at the last Update (nil before the first). Safe from any
// goroutine; the map must not be modified.
func (t *Tracker) Counts() Counts {
	if c := t.counts.Load(); c != nil {
		return *c
	}
	return nil
}

// Stats describes one publish pass.
type Stats struct {
	Messages, Updates, Leaves int
	Bytes                     int64
	Dur                       time.Duration
}

// Publisher sends a Tick in FormatJSON or FormatBatch, over one or more connections in parallel.
//
// FormatJSON: each connection takes a contiguous range of drones, so a drone's leave and update
// always go out on the same connection, in order. FormatBatch: regions are sharded by key, so a
// region's batches always go out on the same connection.
type Publisher struct {
	format   Format
	prefix   string
	tracker  *Tracker
	pubs     []sim.PublishFunc
	subjects map[uint32]string
	order    []int32            // FormatBatch: drone indexes grouped by region
	leaves   map[uint32][]int32 // FormatBatch: drones that left each region this tick
	now      func() time.Time

	// Spread paces one tick's messages over this duration in Slices steps (0 = one burst, like the
	// dev server, whose messages of one tick all carry the same timestamp).
	Spread time.Duration
	Slices int
}

func NewPublisher(format Format, prefix string, tracker *Tracker, pub sim.PublishFunc, more ...sim.PublishFunc) *Publisher {
	return &Publisher{
		format: format, prefix: prefix, tracker: tracker,
		pubs:     append([]sim.PublishFunc{pub}, more...),
		subjects: make(map[uint32]string),
		leaves:   make(map[uint32][]int32),
		now:      time.Now,
		Slices:   20,
	}
}

func (p *Publisher) subject(key uint32) string {
	s, ok := p.subjects[key]
	if !ok {
		x, y := tiles.Unkey(key)
		s = Subject(p.prefix, x, y)
		p.subjects[key] = s
	}
	return s
}

// Publish sends one tick. The fleet must not change until it returns.
func (p *Publisher) Publish(f *sim.Fleet, t *Tick) (Stats, error) {
	start := p.now()
	// name every subject now: the connection goroutines only read the map
	for key := range t.Counts {
		p.subject(key)
	}
	for _, i := range t.Moved {
		p.subject(t.From[i])
	}

	var shards [][]batchPart
	if p.format == FormatBatch {
		shards = p.batchParts(t)
	}
	stats := make([]Stats, len(p.pubs))
	errs := make([]error, len(p.pubs))
	per := (f.N + len(p.pubs) - 1) / len(p.pubs)
	var wg sync.WaitGroup
	for c, pub := range p.pubs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if p.format == FormatBatch {
				stats[c], errs[c] = p.sendBatches(f, t, pub, shards[c], start)
			} else {
				stats[c], errs[c] = p.sendUpdates(f, t, pub, min(f.N, c*per), min(f.N, (c+1)*per), start)
			}
		}()
	}
	wg.Wait()

	var st Stats
	for _, s := range stats {
		st.Messages += s.Messages
		st.Updates += s.Updates
		st.Leaves += s.Leaves
		st.Bytes += s.Bytes
	}
	st.Dur = time.Since(start)
	return st, errors.Join(errs...)
}

// paced calls send(0..n-1), spread over Spread in Slices steps from start.
func (p *Publisher) paced(start time.Time, n int, send func(i int) error) error {
	slices := 1
	if p.Spread > 0 {
		slices = max(1, p.Slices)
	}
	per := (n + slices - 1) / slices
	for s := 0; s*per < n; s++ {
		if s > 0 {
			time.Sleep(time.Until(start.Add(p.Spread * time.Duration(s) / time.Duration(slices))))
		}
		for i := s * per; i < min(n, (s+1)*per); i++ {
			if err := send(i); err != nil {
				return err
			}
		}
	}
	return nil
}

func (p *Publisher) fillTrack(tr *Track, f *sim.Fleet, i int, updatedAt int64) {
	lon, lat := tiles.MercToLonLat(f.MX[i], f.MY[i])
	*tr = Track{
		ID: uint32(i + 1), TrackNumber: uint32(i + 1),
		Altitude: f.Alt[i], Latitude: float32(lat), Longitude: float32(lon),
		Velocity: f.Speed[i], Heading: f.Heading[i] * (180 / math.Pi),
		Model: Model, Mode3a: p.tracker.regs[i], Serial: p.tracker.regs[i], UpdatedAt: updatedAt,
	}
}

// sendUpdates publishes a track.update for drones lo..hi-1, each preceded by a track.leave on its
// old region when it moved.
func (p *Publisher) sendUpdates(f *sim.Fleet, t *Tick, pub sim.PublishFunc, lo, hi int, start time.Time) (Stats, error) {
	var st Stats
	u := Update{Type: "track.update", StateUpdatedAt: t.State.UnixMilli()}
	buf := make([]byte, 0, 512)
	err := p.paced(start, hi-lo, func(j int) error {
		i := lo + j
		u.Timestamp = p.now().UnixMilli()
		if from := t.From[i]; from != noRegion {
			l := Leave{Type: "track.leave", Timestamp: u.Timestamp, Region: RegionOf(from),
				Leave: Departure{TrackID: uint32(i + 1), ToRegion: RegionOf(t.Key[i]), UpdatedAt: t.State.Unix()}}
			buf = AppendLeave(buf[:0], &l)
			if err := pub(p.subjects[from], buf); err != nil {
				return err
			}
			st.Messages++
			st.Leaves++
			st.Bytes += int64(len(buf))
		}
		u.Region = RegionOf(t.Key[i])
		p.fillTrack(&u.Track, f, i, t.State.Unix())
		buf = AppendUpdate(buf[:0], &u)
		if err := pub(p.subjects[t.Key[i]], buf); err != nil {
			return err
		}
		st.Messages++
		st.Updates++
		st.Bytes += int64(len(buf))
		return nil
	})
	return st, err
}

// batchPart is one track.batch: a region's drones p.order[lo:hi]; the first part of a region also
// carries its departures.
type batchPart struct {
	key    uint32
	lo, hi int
	first  bool
}

// batchParts fills p.order with drone indexes grouped by region and p.leaves with the drones that
// left each region, and returns each connection's batches.
func (p *Publisher) batchParts(t *Tick) [][]batchPart {
	end := make(map[uint32]int, len(t.Counts)) // next free slot of each region in p.order, then its end
	off := 0
	for key, n := range t.Counts {
		end[key] = off
		off += int(n)
	}
	if cap(p.order) < off {
		p.order = make([]int32, off)
	}
	p.order = p.order[:off]
	for i, key := range t.Key {
		p.order[end[key]] = int32(i)
		end[key]++
	}
	clear(p.leaves)
	for _, i := range t.Moved {
		p.leaves[t.From[i]] = append(p.leaves[t.From[i]], i)
	}

	shards := make([][]batchPart, len(p.pubs))
	add := func(b batchPart) {
		s := b.key % uint32(len(p.pubs))
		shards[s] = append(shards[s], b)
	}
	for key, hi := range end {
		for lo := hi - int(t.Counts[key]); lo < hi; lo += BatchMax {
			add(batchPart{key: key, lo: lo, hi: min(hi, lo+BatchMax), first: lo == hi-int(t.Counts[key])})
		}
	}
	for key := range p.leaves {
		if _, ok := t.Counts[key]; !ok { // the region emptied: one batch with only its departures
			add(batchPart{key: key, first: true})
		}
	}
	return shards
}

// sendBatches publishes one connection's batches.
func (p *Publisher) sendBatches(f *sim.Fleet, t *Tick, pub sim.PublishFunc, parts []batchPart, start time.Time) (Stats, error) {
	var st Stats
	m := Batch{Type: "track.batch", StateUpdatedAt: t.State.UnixMilli()}
	buf := make([]byte, 0, 64<<10)
	err := p.paced(start, len(parts), func(j int) error {
		pt := parts[j]
		m.Timestamp = p.now().UnixMilli()
		m.Region = RegionOf(pt.key)
		m.Tracks = m.Tracks[:0]
		for _, i := range p.order[pt.lo:pt.hi] {
			m.Tracks = append(m.Tracks, Track{})
			p.fillTrack(&m.Tracks[len(m.Tracks)-1], f, int(i), t.State.Unix())
		}
		m.Leaves = m.Leaves[:0]
		if pt.first {
			for _, i := range p.leaves[pt.key] {
				m.Leaves = append(m.Leaves, Departure{TrackID: uint32(i + 1), ToRegion: RegionOf(t.Key[i]), UpdatedAt: t.State.Unix()})
			}
		}
		buf = AppendBatch(buf[:0], &m)
		if err := pub(p.subjects[pt.key], buf); err != nil {
			return err
		}
		st.Messages++
		st.Updates += len(m.Tracks)
		st.Leaves += len(m.Leaves)
		st.Bytes += int64(len(buf))
		return nil
	})
	return st, err
}
