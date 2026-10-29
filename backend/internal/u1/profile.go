package u1

import (
	"dronetracks/internal/sim"
	"dronetracks/internal/tiles"
)

// CentralHanoi is the block of 15 z13 regions over central Hanoi (x 6502..6506, y 3605..3607) that
// the dev server refused on 2026-10-26: about 100k tracks, about 21k of them in region 6503.3606.
var CentralHanoi = struct{ X0, Y0, X1, Y1, DenseX, DenseY int }{6502, 3605, 6506, 3607, 6503, 3606}

// Hotspots is the default load, by track count (sim.City.Weight). Hanoi is centred on region
// 6503.3606, sized so that once the drones have spread along their routes (about 10 minutes) about
// 100k tracks are in CentralHanoi and about 20k in that region (TestDefaultLoadMatchesDevServer).
// The other cities give the cluster view something to show.
var Hotspots = []sim.City{
	{Name: "Hanoi", Lat: denseLat, Lon: denseLon, Weight: 190_000, SigmaKm: 14},
	{Name: "Ho Chi Minh City", Lat: 10.8231, Lon: 106.6297, Weight: 30_000, SigmaKm: 13},
	{Name: "Hai Phong", Lat: 20.8449, Lon: 106.6881, Weight: 6_000, SigmaKm: 8},
	{Name: "Da Nang", Lat: 16.0544, Lon: 108.2022, Weight: 6_000, SigmaKm: 8},
	{Name: "Can Tho", Lat: 10.0452, Lon: 105.7469, Weight: 4_000, SigmaKm: 7},
}

var denseLon, denseLat = tiles.MercToLonLat(
	(float64(CentralHanoi.DenseX)+0.5)/(1<<tiles.TopicZoom),
	(float64(CentralHanoi.DenseY)+0.5)/(1<<tiles.TopicZoom),
)

// HotspotTracks is the total of Hotspots, the default number of tracks.
func HotspotTracks() int {
	n := 0.0
	for _, c := range Hotspots {
		n += c.Weight
	}
	return int(n)
}
