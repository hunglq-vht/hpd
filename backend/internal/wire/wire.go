// Package wire implements the binary tile snapshot format (docs/PROTOCOL.md section 3).
package wire

import (
	"encoding/binary"
	"errors"
	"math"
)

const (
	Version         = 1
	MsgTileSnapshot = 1
	HeaderSize      = 32
	RecordSize      = 16
	// MaxRecordsPerMsg keeps a message under NATS' default 1 MiB max_payload.
	MaxRecordsPerMsg = 65000
)

// Header of a tile snapshot.
type Header struct {
	Zoom        uint8
	X, Y        uint32
	Seq         uint32
	PublishedAt float64 // unix ms
	Count       uint32
	IntervalMs  uint16
	Part, Parts uint8
}

// Record is one decoded track. Lx/Ly are tile-local positions in 1/65536 of the tile.
type Record struct {
	ID       uint32
	Lx, Ly   uint16
	AltDm    uint16
	Heading  uint16
	SpeedCms uint16
	Type     uint8
	Battery  uint8
}

var le = binary.LittleEndian

// PutHeader writes h into b[0:32].
func PutHeader(b []byte, h Header) {
	b[0] = Version
	b[1] = MsgTileSnapshot
	b[2] = h.Zoom
	b[3] = 0
	le.PutUint32(b[4:], h.X)
	le.PutUint32(b[8:], h.Y)
	le.PutUint32(b[12:], h.Seq)
	le.PutUint64(b[16:], math.Float64bits(h.PublishedAt))
	le.PutUint32(b[24:], h.Count)
	le.PutUint16(b[28:], h.IntervalMs)
	b[30] = h.Part
	b[31] = h.Parts
}

// PutRecord writes r into b[0:16].
func PutRecord(b []byte, r Record) {
	le.PutUint32(b[0:], r.ID)
	le.PutUint16(b[4:], r.Lx)
	le.PutUint16(b[6:], r.Ly)
	le.PutUint16(b[8:], r.AltDm)
	le.PutUint16(b[10:], r.Heading)
	le.PutUint16(b[12:], r.SpeedCms)
	b[14] = r.Type
	b[15] = r.Battery
}

var ErrShort = errors.New("wire: message too short")
var ErrVersion = errors.New("wire: unsupported version or type")

// ParseHeader validates and decodes the header of a tile snapshot.
func ParseHeader(b []byte) (Header, error) {
	if len(b) < HeaderSize {
		return Header{}, ErrShort
	}
	if b[0] != Version || b[1] != MsgTileSnapshot {
		return Header{}, ErrVersion
	}
	h := Header{
		Zoom:        b[2],
		X:           le.Uint32(b[4:]),
		Y:           le.Uint32(b[8:]),
		Seq:         le.Uint32(b[12:]),
		PublishedAt: math.Float64frombits(le.Uint64(b[16:])),
		Count:       le.Uint32(b[24:]),
		IntervalMs:  le.Uint16(b[28:]),
		Part:        b[30],
		Parts:       b[31],
	}
	if len(b) < HeaderSize+int(h.Count)*RecordSize {
		return h, ErrShort
	}
	return h, nil
}

// RecordAt decodes record i of a message whose header was validated by ParseHeader.
func RecordAt(b []byte, i int) Record {
	o := HeaderSize + i*RecordSize
	return Record{
		ID:       le.Uint32(b[o:]),
		Lx:       le.Uint16(b[o+4:]),
		Ly:       le.Uint16(b[o+6:]),
		AltDm:    le.Uint16(b[o+8:]),
		Heading:  le.Uint16(b[o+10:]),
		SpeedCms: le.Uint16(b[o+12:]),
		Type:     b[o+14],
		Battery:  b[o+15],
	}
}

// LocalUint16 quantises a fraction in [0,1) to the tile-local u16 encoding.
func LocalUint16(frac float64) uint16 {
	v := frac * 65536
	if v <= 0 {
		return 0
	}
	if v >= 65535 {
		return 65535
	}
	return uint16(v)
}

// Sat16 saturates a non-negative float to u16.
func Sat16(v float64) uint16 {
	if v <= 0 {
		return 0
	}
	if v >= 65535 {
		return 65535
	}
	return uint16(v + 0.5)
}

// EncodeHeading converts radians (clockwise from north) to the u16 encoding.
func EncodeHeading(rad float64) uint16 {
	deg := math.Mod(rad*180/math.Pi, 360)
	if deg < 0 {
		deg += 360
	}
	return uint16(uint32(deg/360*65536+0.5) & 0xffff)
}
