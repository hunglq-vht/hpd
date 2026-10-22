package sim

import "dronetracks/internal/tiles"

// City is a traffic hotspot in Southeast Asia. Drones are spread around it in three classes:
// a dense core (sigma/3.5), the metro area (sigma) and regional traffic (sigma*6).
type City struct {
	Name     string
	Lat, Lon float64
	Weight   float64
	SigmaKm  float64
}

// Region bounds every drone: Southeast Asia, from Myanmar to Timor-Leste. TestCitiesStayInRegion
// checks that no city's widest sampling box (3 regional sigmas) leaves it.
var Region = tiles.BBox{W: 92, S: -11, E: 141, N: 28.5}

var Cities = []City{
	{"Jakarta", -6.2088, 106.8456, 9, 18},
	{"Bangkok", 13.7563, 100.5018, 8, 16},
	{"Manila", 14.5995, 120.9842, 8, 14},
	{"Ho Chi Minh City", 10.8231, 106.6297, 7, 13},
	{"Hanoi", 21.0278, 105.8342, 6, 12},
	{"Kuala Lumpur", 3.1390, 101.6869, 6, 14},
	{"Singapore", 1.3521, 103.8198, 6, 9},
	{"Surabaya", -7.2575, 112.7521, 4, 11},
	{"Yangon", 16.8409, 96.1735, 4, 12},
	{"Bandung", -6.9175, 107.6191, 3, 9},
	{"Medan", 3.5952, 98.6722, 3, 10},
	{"Cebu", 10.3157, 123.8854, 3, 9},
	{"Phnom Penh", 11.5564, 104.9282, 3, 10},
	{"Da Nang", 16.0544, 108.2022, 2, 8},
	{"Hai Phong", 20.8449, 106.6881, 2, 8},
	{"Chiang Mai", 18.7883, 98.9853, 2, 8},
	{"George Town", 5.4141, 100.3288, 2, 8},
	{"Johor Bahru", 1.4927, 103.7414, 2, 9},
	{"Semarang", -6.9667, 110.4167, 2, 9},
	{"Makassar", -5.1477, 119.4327, 2, 8},
	{"Denpasar", -8.6705, 115.2126, 2, 8},
	{"Davao", 7.1907, 125.4553, 2, 9},
	{"Mandalay", 21.9588, 96.0891, 2, 9},
	{"Vientiane", 17.9757, 102.6331, 2, 8},
	{"Can Tho", 10.0452, 105.7469, 1, 7},
	{"Nha Trang", 12.2388, 109.1967, 1, 6},
	{"Hue", 16.4637, 107.5909, 1, 6},
	{"Phuket", 7.8804, 98.3923, 1, 7},
	{"Pattaya", 12.9236, 100.8825, 1, 6},
	{"Kota Kinabalu", 5.9804, 116.0735, 1, 7},
	{"Kuching", 1.5535, 110.3593, 1, 7},
	{"Yogyakarta", -7.7956, 110.3695, 1, 7},
	{"Palembang", -2.9761, 104.7754, 1, 8},
	{"Naypyidaw", 19.7633, 96.0785, 1, 8},
	{"Siem Reap", 13.3671, 103.8448, 1, 6},
	{"Luang Prabang", 19.8856, 102.1347, 1, 5},
	{"Bandar Seri Begawan", 4.9031, 114.9398, 1, 7},
	{"Dili", -8.5569, 125.5603, 1, 6},
}

// Class shares and spread factors: core, metro, regional.
var (
	classShare  = [3]float64{0.35, 0.61, 0.04}
	classSpread = [3]float64{1 / 3.5, 1, 6}
)

// KindSpec describes the flight envelope of a drone type (see the wire "type" field).
type KindSpec struct {
	Share                float64
	CruiseMin, CruiseMax float32 // m/s
	MinSpeed             float32 // fixed-wing cannot hover
	TurnRate             float32 // rad/s
	Accel                float32 // m/s^2
	AltMin, AltMax       float32 // m
	ArriveM              float64
	CanHover             bool
	Drain                float32 // battery %/s
}

const deg = 3.141592653589793 / 180

var Kinds = [4]KindSpec{
	{Share: 0.70, CruiseMin: 8, CruiseMax: 16, TurnRate: 120 * deg, Accel: 4, AltMin: 30, AltMax: 120, ArriveM: 25, CanHover: true, Drain: 0.025},
	{Share: 0.15, CruiseMin: 6, CruiseMax: 12, TurnRate: 70 * deg, Accel: 3, AltMin: 50, AltMax: 150, ArriveM: 25, CanHover: true, Drain: 0.02},
	{Share: 0.12, CruiseMin: 18, CruiseMax: 30, MinSpeed: 15, TurnRate: 18 * deg, Accel: 2, AltMin: 100, AltMax: 400, ArriveM: 250, Drain: 0.012},
	{Share: 0.03, CruiseMin: 22, CruiseMax: 35, TurnRate: 60 * deg, Accel: 5, AltMin: 50, AltMax: 200, ArriveM: 40, CanHover: true, Drain: 0.03},
}
