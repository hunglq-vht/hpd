// Package sim simulates a fleet of drones flying between waypoints around hotspot cities.
// State is stored as struct-of-arrays so one tick over 1M drones stays cache friendly and
// can be split across goroutines.
package sim

import (
	"math"
	"math/rand/v2"
	"sync"

	"dronetracks/internal/tiles"
	"dronetracks/internal/wire"
)

type cityGeo struct {
	mx, my float64
	mpm    float64 // mercator units per metre at the city centre
	sigmaM float64
}

// Fleet holds the state of every drone. Drone i has track id i+1.
type Fleet struct {
	N       int
	MX, MY  []float64 // normalised mercator position
	TX, TY  []float64 // current waypoint
	Heading []float32 // radians, clockwise from north
	Speed   []float32 // m/s
	Cruise  []float32
	Alt     []float32 // m
	AltTgt  []float32
	Battery []float32 // %
	Hover   []float32 // seconds left hovering
	Kind    []uint8
	Class   []uint8
	City    []uint16
	Keys    []uint64 // tileKey<<32 | index, rebuilt every tick for grouping
	Rec     []byte   // wire record of drone i at Rec[i*16:], encoded during Step (in parallel)

	geo     []cityGeo
	rngs    []*rand.Rand
	workers int
}

// NewFleet places n drones around the hotspot cities, deterministically for a given seed.
func NewFleet(n int, seed uint64, workers int) *Fleet {
	return NewFleetAround(Cities, n, seed, workers)
}

// NewFleetAround is NewFleet with other hotspots; each one's Weight sets its share of the drones.
func NewFleetAround(cities []City, n int, seed uint64, workers int) *Fleet {
	if workers < 1 {
		workers = 1
	}
	f := &Fleet{
		N: n, workers: workers,
		MX: make([]float64, n), MY: make([]float64, n), TX: make([]float64, n), TY: make([]float64, n),
		Heading: make([]float32, n), Speed: make([]float32, n), Cruise: make([]float32, n),
		Alt: make([]float32, n), AltTgt: make([]float32, n), Battery: make([]float32, n), Hover: make([]float32, n),
		Kind: make([]uint8, n), Class: make([]uint8, n), City: make([]uint16, n), Keys: make([]uint64, n),
		Rec: make([]byte, n*wire.RecordSize),
	}
	for _, c := range cities {
		mx, my := tiles.LonLatToMerc(c.Lon, c.Lat)
		f.geo = append(f.geo, cityGeo{mx: mx, my: my, mpm: tiles.MercPerMeter(my), sigmaM: c.SigmaKm * 1000})
	}
	for w := 0; w < workers; w++ {
		f.rngs = append(f.rngs, rand.New(rand.NewPCG(seed, uint64(w)+1)))
	}

	var wsum float64
	for _, c := range cities {
		wsum += c.Weight
	}
	rng := rand.New(rand.NewPCG(seed, 0))
	for i := 0; i < n; i++ {
		f.City[i] = uint16(pickWeighted(rng, cities, wsum))
		f.Class[i] = uint8(pickShare(rng, classShare[:]))
		k := uint8(pickShare(rng, kindShares()))
		f.Kind[i] = k
		spec := &Kinds[k]
		f.MX[i], f.MY[i] = f.sample(rng, i)
		f.TX[i], f.TY[i] = f.sample(rng, i)
		f.Heading[i] = float32(rng.Float64() * 2 * math.Pi)
		f.Cruise[i] = spec.CruiseMin + rng.Float32()*(spec.CruiseMax-spec.CruiseMin)
		f.Speed[i] = f.Cruise[i] * rng.Float32()
		f.AltTgt[i] = spec.AltMin + rng.Float32()*(spec.AltMax-spec.AltMin)
		f.Alt[i] = f.AltTgt[i]
		f.Battery[i] = 20 + rng.Float32()*80
	}
	return f
}

func kindShares() []float64 {
	s := make([]float64, len(Kinds))
	for i, k := range Kinds {
		s[i] = k.Share
	}
	return s
}

func pickWeighted(rng *rand.Rand, cities []City, wsum float64) int {
	r := rng.Float64() * wsum
	for i, c := range cities {
		if r < c.Weight {
			return i
		}
		r -= c.Weight
	}
	return len(cities) - 1
}

func pickShare(rng *rand.Rand, shares []float64) int {
	r := rng.Float64()
	for i, s := range shares {
		if r < s {
			return i
		}
		r -= s
	}
	return len(shares) - 1
}

// sample draws a waypoint for drone i from its city's distribution (Gaussian, clipped at 3 sigma).
func (f *Fleet) sample(rng *rand.Rand, i int) (mx, my float64) {
	g := &f.geo[f.City[i]]
	sigma := g.sigmaM * classSpread[f.Class[i]]
	e := clamp(rng.NormFloat64(), -3, 3) * sigma
	n := clamp(rng.NormFloat64(), -3, 3) * sigma
	return g.mx + e*g.mpm, clamp(g.my-n*g.mpm, 1e-6, 1-1e-6)
}

// Step advances every drone by dt seconds and refreshes Keys. Work is split across goroutines.
func (f *Fleet) Step(dt float64) {
	var wg sync.WaitGroup
	chunk := (f.N + f.workers - 1) / f.workers
	for w := 0; w < f.workers; w++ {
		lo, hi := w*chunk, min((w+1)*chunk, f.N)
		if lo >= hi {
			break
		}
		wg.Add(1)
		go func(rng *rand.Rand, lo, hi int) {
			defer wg.Done()
			for i := lo; i < hi; i++ {
				f.stepOne(rng, i, dt)
			}
		}(f.rngs[w], lo, hi)
	}
	wg.Wait()
}

func (f *Fleet) stepOne(rng *rand.Rand, i int, dt float64) {
	spec := &Kinds[f.Kind[i]]
	mpm := tiles.MercPerMeter(f.MY[i])
	east := (f.TX[i] - f.MX[i]) / mpm
	north := -(f.TY[i] - f.MY[i]) / mpm
	dist := math.Hypot(east, north)

	hovering := f.Hover[i] > 0
	if hovering {
		f.Hover[i] -= float32(dt)
		if f.Hover[i] <= 0 {
			f.Hover[i] = 0
			f.TX[i], f.TY[i] = f.sample(rng, i)
		}
	} else if dist < spec.ArriveM {
		if spec.CanHover && rng.Float32() < 0.35 {
			f.Hover[i] = 5 + rng.Float32()*25
			hovering = true
		} else {
			f.TX[i], f.TY[i] = f.sample(rng, i)
		}
		east = (f.TX[i] - f.MX[i]) / mpm
		north = -(f.TY[i] - f.MY[i]) / mpm
		dist = math.Hypot(east, north)
	}

	h := float64(f.Heading[i])
	var vt float64
	if !hovering {
		diff := wrapPi(math.Atan2(east, north) - h)
		maxTurn := float64(spec.TurnRate) * dt
		h += clamp(diff, -maxTurn, maxTurn)
		// slow down near the waypoint and in tight turns (fixed-wing keeps its stall speed)
		vt = math.Min(float64(f.Cruise[i]), dist/2.5) * math.Max(0.35, math.Cos(clamp(diff, -math.Pi/2, math.Pi/2)))
		vt = math.Max(vt, float64(spec.MinSpeed))
	}
	v := float64(f.Speed[i])
	acc := float64(spec.Accel) * dt
	v += clamp(vt-v, -acc, acc)
	d := v * dt
	f.MX[i] = tiles.WrapX(f.MX[i] + math.Sin(h)*d*mpm)
	f.MY[i] = clamp(f.MY[i]-math.Cos(h)*d*mpm, 1e-6, 1-1e-6)
	f.Heading[i] = float32(math.Mod(h+2*math.Pi, 2*math.Pi))
	f.Speed[i] = float32(v)

	if rng.Float32() < 0.01 {
		f.AltTgt[i] = spec.AltMin + rng.Float32()*(spec.AltMax-spec.AltMin)
	}
	climb := float32(3 * dt)
	f.Alt[i] += clamp32(f.AltTgt[i]-f.Alt[i], -climb, climb)

	f.Battery[i] -= spec.Drain * float32(dt)
	if f.Battery[i] < 8 {
		f.Battery[i] = 100 // battery swap
	}

	x, y := tiles.TileXY(tiles.TopicZoom, f.MX[i], f.MY[i])
	f.Keys[i] = uint64(tiles.Key(x, y))<<32 | uint64(i)
	const scale = float64(int(1) << tiles.TopicZoom)
	wire.PutRecord(f.Rec[i*wire.RecordSize:], wire.Record{
		ID:       uint32(i + 1),
		Lx:       wire.LocalUint16(f.MX[i]*scale - float64(x)),
		Ly:       wire.LocalUint16(f.MY[i]*scale - float64(y)),
		AltDm:    wire.Sat16(float64(f.Alt[i]) * 10),
		Heading:  wire.EncodeHeading(float64(f.Heading[i])),
		SpeedCms: wire.Sat16(v * 100),
		Type:     f.Kind[i],
		Battery:  uint8(f.Battery[i] + 0.5),
	})
}

func wrapPi(a float64) float64 {
	for a > math.Pi {
		a -= 2 * math.Pi
	}
	for a < -math.Pi {
		a += 2 * math.Pi
	}
	return a
}

func clamp(v, lo, hi float64) float64 { return math.Max(lo, math.Min(hi, v)) }

func clamp32(v, lo, hi float32) float32 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
