package wire

import (
	"math"
	"testing"
)

func TestRoundTrip(t *testing.T) {
	h := Header{Zoom: 13, X: 7276, Y: 3225, Seq: 42, PublishedAt: 1761123456789.25, Count: 2, IntervalMs: 1000, Part: 0, Parts: 1}
	recs := []Record{
		{ID: 1, Lx: 0, Ly: 65535, AltDm: 1205, Heading: EncodeHeading(math.Pi / 2), SpeedCms: 1530, Type: 2, Battery: 77},
		{ID: 1_000_000, Lx: 32768, Ly: 1, AltDm: 0, Heading: 0, SpeedCms: 0, Type: 3, Battery: 100},
	}
	b := make([]byte, HeaderSize+len(recs)*RecordSize)
	PutHeader(b, h)
	for i, r := range recs {
		PutRecord(b[HeaderSize+i*RecordSize:], r)
	}
	got, err := ParseHeader(b)
	if err != nil {
		t.Fatal(err)
	}
	if got != h {
		t.Fatalf("header mismatch: %+v != %+v", got, h)
	}
	for i, r := range recs {
		if RecordAt(b, i) != r {
			t.Fatalf("record %d mismatch: %+v != %+v", i, RecordAt(b, i), r)
		}
	}
	if recs[0].Heading != 16384 {
		t.Fatalf("east heading should encode to 16384, got %d", recs[0].Heading)
	}
}

func TestShort(t *testing.T) {
	b := make([]byte, HeaderSize)
	PutHeader(b, Header{Count: 3})
	if _, err := ParseHeader(b); err != ErrShort {
		t.Fatalf("expected ErrShort, got %v", err)
	}
}

func TestQuantise(t *testing.T) {
	if LocalUint16(-0.1) != 0 || LocalUint16(0.99999999) != 65535 || LocalUint16(0.5) != 32768 {
		t.Fatal("LocalUint16 bounds")
	}
	if EncodeHeading(-math.Pi/2) != 49152 {
		t.Fatalf("west heading: %d", EncodeHeading(-math.Pi/2))
	}
	if EncodeHeading(2*math.Pi-1e-12) != 0 {
		t.Fatalf("360 wraps to 0: %d", EncodeHeading(2*math.Pi-1e-12))
	}
}
