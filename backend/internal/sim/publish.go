package sim

import (
	"errors"
	"runtime"
	"sync"
	"time"

	"dronetracks/internal/tiles"
	"dronetracks/internal/wire"
)

// PublishFunc sends one message. nats.Conn.Publish satisfies it. The buffer is reused after
// the call returns, so the function must copy it (nats.go does).
type PublishFunc func(subject string, data []byte) error

// TickStats describes one publish pass.
type TickStats struct {
	Tiles, Empty, Messages int
	Bytes                  int64
	SortDur, EncodeDur     time.Duration
	PublishDur             time.Duration
}

// msgRun is one message: a slice of the sorted keys belonging to one tile (or one part of it).
type msgRun struct {
	key         uint32
	subject     string
	lo, hi      int // range in the sorted keys; lo == hi for an empty snapshot
	off         int // byte offset of the message in the tick buffer
	part, parts uint8
}

// Publisher groups the fleet by z13 tile and publishes one binary snapshot per tile.
//
// It can publish over several connections in parallel. A NATS server processes each inbound
// connection on one goroutine, so a single connection caps the burst rate; sharding tiles across
// connections (a tile always uses the same one, which keeps per-subject ordering) spreads the
// 17 MB tick over several server cores and keeps publish->receive latency low.
type Publisher struct {
	pubs       []PublishFunc
	intervalMs uint16
	seq        uint32
	tmp        []uint64
	buf        []byte
	runs       []msgRun
	shards     [][]int // run indexes per connection
	subjects   map[uint32]string
	lastSeq    map[uint32]uint32 // tile -> seq of its last non-empty snapshot
	workers    int
	now        func() time.Time

	// Spread paces one tick's messages over this duration in Slices steps (0 = one burst).
	Spread time.Duration
	Slices int
	// SubjectOf names a tile's subject; nil means tiles.Subject ("tracks.13.<x>.<y>").
	SubjectOf func(x, y int) string
}

func NewPublisher(pub PublishFunc, interval time.Duration, more ...PublishFunc) *Publisher {
	pubs := append([]PublishFunc{pub}, more...)
	return &Publisher{
		pubs:       pubs,
		intervalMs: uint16(interval.Milliseconds()),
		shards:     make([][]int, len(pubs)),
		subjects:   make(map[uint32]string),
		lastSeq:    make(map[uint32]uint32),
		workers:    runtime.GOMAXPROCS(0),
		now:        time.Now,
	}
}

// Publish sends the current fleet state. Step must have refreshed Keys and Rec.
// Phases: radix sort by tile -> split into messages -> parallel gather of records into one
// contiguous tick buffer -> parallel publish per connection (headers stamped right before sending).
func (p *Publisher) Publish(f *Fleet) (TickStats, error) {
	var st TickStats
	p.seq++
	t0 := time.Now()
	sorted := p.radixSort(f.Keys)
	st.SortDur = time.Since(t0)

	t1 := time.Now()
	p.runs = p.runs[:0]
	off := 0
	for lo := 0; lo < len(sorted); {
		key := uint32(sorted[lo] >> 32)
		hi := lo + 1
		for hi < len(sorted) && uint32(sorted[hi]>>32) == key {
			hi++
		}
		subj := p.subject(key)
		parts := (hi - lo + wire.MaxRecordsPerMsg - 1) / wire.MaxRecordsPerMsg
		for part := 0; part < parts; part++ {
			a := lo + part*wire.MaxRecordsPerMsg
			b := min(hi, a+wire.MaxRecordsPerMsg)
			p.runs = append(p.runs, msgRun{key: key, subject: subj, lo: a, hi: b, off: off, part: uint8(part), parts: uint8(parts)})
			off += wire.HeaderSize + (b-a)*wire.RecordSize
		}
		p.lastSeq[key] = p.seq
		st.Tiles++
		lo = hi
	}
	// tiles that just became empty get one empty snapshot so subscribers and monitors can clear them
	for key, s := range p.lastSeq {
		if s != p.seq {
			p.runs = append(p.runs, msgRun{key: key, subject: p.subject(key), off: off, parts: 1})
			off += wire.HeaderSize
			delete(p.lastSeq, key)
			st.Empty++
		}
	}
	if cap(p.buf) < off {
		p.buf = make([]byte, off+off/4)
	}
	buf := p.buf[:off]
	p.gather(f, sorted, buf)
	st.EncodeDur = time.Since(t1)

	t2 := time.Now()
	// Pace the tick: publish contiguous slices of the (tile-sorted) messages spread over
	// Spread instead of one 17 MB burst, the way independent producers would emit them.
	slices := max(1, p.Slices)
	per := (len(p.runs) + slices - 1) / slices
	var errs []error
	for k := 0; k*per < len(p.runs); k++ {
		if k > 0 && p.Spread > 0 {
			time.Sleep(time.Until(t2.Add(p.Spread * time.Duration(k) / time.Duration(slices))))
		}
		msgs, bytes, err := p.publishBatch(p.runs[k*per:min(len(p.runs), (k+1)*per)], buf)
		st.Messages += msgs
		st.Bytes += bytes
		if err != nil {
			errs = append(errs, err)
			break
		}
	}
	st.PublishDur = time.Since(t2)
	return st, errors.Join(errs...)
}

// publishBatch sends runs in parallel, one goroutine per connection; a tile always maps to the
// same connection so per-subject ordering is preserved.
func (p *Publisher) publishBatch(runs []msgRun, buf []byte) (int, int64, error) {
	for i := range p.shards {
		p.shards[i] = p.shards[i][:0]
	}
	for i, r := range runs {
		s := int(r.key % uint32(len(p.pubs)))
		p.shards[s] = append(p.shards[s], i)
	}
	type result struct {
		msgs  int
		bytes int64
		err   error
	}
	results := make([]result, len(p.pubs))
	var wg sync.WaitGroup
	for s := range p.pubs {
		if len(p.shards[s]) == 0 {
			continue
		}
		wg.Add(1)
		go func(s int) {
			defer wg.Done()
			res := &results[s]
			for _, i := range p.shards[s] {
				r := &runs[i]
				msg := buf[r.off : r.off+wire.HeaderSize+(r.hi-r.lo)*wire.RecordSize]
				x, y := tiles.Unkey(r.key)
				wire.PutHeader(msg, wire.Header{
					Zoom: tiles.TopicZoom, X: uint32(x), Y: uint32(y), Seq: p.seq,
					PublishedAt: float64(p.now().UnixNano()) / 1e6,
					Count:       uint32(r.hi - r.lo), IntervalMs: p.intervalMs, Part: r.part, Parts: r.parts,
				})
				if err := p.pubs[s](r.subject, msg); err != nil {
					res.err = err
					return
				}
				res.msgs++
				res.bytes += int64(len(msg))
			}
		}(s)
	}
	wg.Wait()
	var msgs int
	var bytes int64
	var errs []error
	for _, r := range results {
		msgs += r.msgs
		bytes += r.bytes
		errs = append(errs, r.err)
	}
	return msgs, bytes, errors.Join(errs...)
}

func (p *Publisher) subject(key uint32) string {
	s, ok := p.subjects[key]
	if !ok {
		name := p.SubjectOf
		if name == nil {
			name = tiles.Subject
		}
		s = name(tiles.Unkey(key))
		p.subjects[key] = s
	}
	return s
}

// gather copies every drone's pre-encoded record into its message slot, split across workers.
func (p *Publisher) gather(f *Fleet, sorted []uint64, buf []byte) {
	var wg sync.WaitGroup
	per := (len(p.runs) + p.workers - 1) / p.workers
	for w := 0; w < p.workers; w++ {
		runs := p.runs[min(len(p.runs), w*per):min(len(p.runs), (w+1)*per)]
		if len(runs) == 0 {
			break
		}
		wg.Add(1)
		go func(runs []msgRun) {
			defer wg.Done()
			for _, r := range runs {
				o := r.off + wire.HeaderSize
				for _, k := range sorted[r.lo:r.hi] {
					i := int(uint32(k)) * wire.RecordSize
					copy(buf[o:o+wire.RecordSize], f.Rec[i:i+wire.RecordSize])
					o += wire.RecordSize
				}
			}
		}(runs)
	}
	wg.Wait()
}

// radixSort sorts tileKey<<32|index values by tile key (26 bits) in two 13-bit LSD passes.
// It is stable, so drones keep index order inside a tile.
func (p *Publisher) radixSort(keys []uint64) []uint64 {
	n := len(keys)
	if cap(p.tmp) < 2*n {
		p.tmp = make([]uint64, 2*n)
	}
	// sort a copy so Fleet.Keys stays indexable by drone; two passes end back in src
	src, dst := p.tmp[:n], p.tmp[n:2*n]
	copy(src, keys)
	const bits = tiles.TopicZoom
	const mask = 1<<bits - 1
	for pass := 0; pass < 2; pass++ {
		shift := 32 + bits*pass
		var counts [1 << bits]int
		for _, k := range src {
			counts[(k>>shift)&mask]++
		}
		sum := 0
		for b, c := range counts {
			counts[b] = sum
			sum += c
		}
		for _, k := range src {
			b := (k >> shift) & mask
			dst[counts[b]] = k
			counts[b]++
		}
		src, dst = dst, src
	}
	return src
}
