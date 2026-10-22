// Package tiles implements the tiling agreement shared with the frontend
// (see docs/PROTOCOL.md): Web Mercator, XYZ tiles, one NATS subject per z13 tile.
package tiles

import (
	"errors"
	"math"
	"sort"
	"strconv"
)

const (
	TopicZoom        = 13 // one NATS subject per tile at this level
	StatsMaxLevel    = 15 // finest level the monitor aggregates (4x4 cells per topic tile)
	StatsLevelOffset = 3  // stats level = floor(mapZoom) + offset
	RealtimeMinZoom  = 13 // map zoom at which the client switches from clusters to live tracks
	SubjectPrefix    = "tracks"

	MaxLat              = 85.0511287798066
	EarthCircumferenceM = 40075016.68557849
)

// LonLatToMerc converts degrees to normalised mercator coordinates in [0,1).
func LonLatToMerc(lon, lat float64) (mx, my float64) {
	lat = math.Max(-MaxLat, math.Min(MaxLat, lat))
	mx = (lon + 180) / 360
	s := math.Sin(lat * math.Pi / 180)
	my = 0.5 - math.Log((1+s)/(1-s))/(4*math.Pi)
	return mx, my
}

// MercToLonLat is the inverse of LonLatToMerc.
func MercToLonLat(mx, my float64) (lon, lat float64) {
	lon = mx*360 - 180
	lat = math.Atan(math.Sinh(math.Pi*(1-2*my))) * 180 / math.Pi
	return lon, lat
}

// MercPerMeter returns how many normalised mercator units one ground metre spans at mercator y.
func MercPerMeter(my float64) float64 {
	return math.Cosh(math.Pi*(1-2*my)) / EarthCircumferenceM
}

// WrapX wraps an unwrapped mercator x (from viewports crossing the antimeridian) into [0,1).
func WrapX(mx float64) float64 {
	mx = math.Mod(mx, 1)
	if mx < 0 {
		mx++
	}
	return mx
}

// TileXY returns the tile containing a mercator point at level z.
func TileXY(z int, mx, my float64) (x, y int) {
	n := 1 << z
	x = int(math.Floor(mx * float64(n)))
	y = int(math.Floor(my * float64(n)))
	return clampInt(x, 0, n-1), clampInt(y, 0, n-1)
}

// Key packs a z13 tile coordinate into 26 bits.
func Key(x, y int) uint32 { return uint32(x)<<TopicZoom | uint32(y) }

// Unkey is the inverse of Key.
func Unkey(k uint32) (x, y int) { return int(k >> TopicZoom), int(k & (1<<TopicZoom - 1)) }

// Subject returns the NATS subject for a topic tile.
func Subject(x, y int) string {
	return SubjectPrefix + "." + strconv.Itoa(TopicZoom) + "." + strconv.Itoa(x) + "." + strconv.Itoa(y)
}

// StatsLevel maps a (fractional) map zoom to the stats aggregation level.
func StatsLevel(zoom float64) int {
	return clampInt(int(math.Floor(zoom))+StatsLevelOffset, 0, StatsMaxLevel)
}

// BBox is a viewport in degrees. West may be < -180 and East > 180 when the map shows world copies.
type BBox struct{ W, S, E, N float64 }

// MercRect is a bbox in unwrapped mercator space (X0 may be < 0, X1 may be > 1).
type MercRect struct{ X0, Y0, X1, Y1 float64 }

func (b BBox) Merc() MercRect {
	x0 := (b.W + 180) / 360
	x1 := (b.E + 180) / 360
	_, y0 := LonLatToMerc(0, b.N)
	_, y1 := LonLatToMerc(0, b.S)
	return MercRect{x0, y0, x1, y1}
}

// Expand grows the rect by margin*size on every side (margin 0.5 => 2x width and height).
func (r MercRect) Expand(margin float64) MercRect {
	dx := (r.X1 - r.X0) * margin
	dy := (r.Y1 - r.Y0) * margin
	return MercRect{r.X0 - dx, math.Max(0, r.Y0-dy), r.X1 + dx, math.Min(1, r.Y1+dy)}
}

// TileRange returns the inclusive, unwrapped tile x range and the clamped y range of a rect at level z.
// Callers wrap x with WrapTileX.
func (r MercRect) TileRange(z int) (x0, y0, x1, y1 int) {
	n := float64(int(1) << z)
	x0 = int(math.Floor(r.X0 * n))
	x1 = int(math.Floor(math.Nextafter(r.X1*n, math.Inf(-1))))
	y0 = clampInt(int(math.Floor(r.Y0*n)), 0, int(n)-1)
	y1 = clampInt(int(math.Floor(math.Nextafter(r.Y1*n, math.Inf(-1)))), 0, int(n)-1)
	if x1 < x0 {
		x1 = x0
	}
	return
}

// WrapTileX wraps a tile x into [0, 2^z).
func WrapTileX(z, x int) int {
	n := 1 << z
	x %= n
	if x < 0 {
		x += n
	}
	return x
}

// Cover is one topic tile in a viewport cover.
type Cover struct {
	X, Y   int
	InView bool
	dist   float64
}

// MaxCoverScan bounds the number of tiles CoverTopics will enumerate (~ a zoom 9 viewport).
const MaxCoverScan = 1 << 16

var ErrCoverTooLarge = errors.New("viewport too large for realtime topics; use cluster stats at this zoom")

// CoverTopics returns the topic tiles covering the viewport grown by margin (fraction of the viewport
// size per side), always including at least one ring of neighbours around the viewport tiles.
// Viewport tiles come first, sorted centre-out, then prefetch tiles; the result is capped at limit.
func CoverTopics(b BBox, margin float64, limit int) (out []Cover, truncated bool, err error) {
	const z = TopicZoom
	view := b.Merc()
	vx0, vy0, vx1, vy1 := view.TileRange(z)
	px0, py0, px1, py1 := view.Expand(margin).TileRange(z)
	// at least one ring of neighbours
	px0, py0, px1, py1 = min(px0, vx0-1), min(py0, vy0-1), max(px1, vx1+1), max(py1, vy1+1)
	n := 1 << z
	py0, py1 = clampInt(py0, 0, n-1), clampInt(py1, 0, n-1)
	if px1-px0+1 > n { // whole world: no duplicates
		px0, px1 = 0, n-1
	}
	if (px1-px0+1)*(py1-py0+1) > MaxCoverScan {
		return nil, false, ErrCoverTooLarge
	}

	cx := (view.X0 + view.X1) / 2 * float64(n)
	cy := (view.Y0 + view.Y1) / 2 * float64(n)
	seen := make(map[uint32]struct{})
	for y := py0; y <= py1; y++ {
		for ux := px0; ux <= px1; ux++ {
			x := WrapTileX(z, ux)
			k := Key(x, y)
			if _, dup := seen[k]; dup {
				continue
			}
			seen[k] = struct{}{}
			in := ux >= vx0 && ux <= vx1 && y >= vy0 && y <= vy1
			dx, dy := float64(ux)+0.5-cx, float64(y)+0.5-cy
			out = append(out, Cover{X: x, Y: y, InView: in, dist: dx*dx + dy*dy})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].InView != out[j].InView {
			return out[i].InView
		}
		return out[i].dist < out[j].dist
	})
	if limit > 0 && len(out) > limit {
		out, truncated = out[:limit], true
	}
	return out, truncated, nil
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
