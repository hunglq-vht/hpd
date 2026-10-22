package sim

import (
	"testing"
	"time"
)

func BenchmarkTickBreakdown(b *testing.B) {
	f := NewFleet(1_000_000, 1, 8)
	p := NewPublisher(func(string, []byte) error { return nil }, time.Second)
	var step, sortD, enc, pub time.Duration
	var st TickStats
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		t0 := time.Now()
		f.Step(1)
		step += time.Since(t0)
		st, _ = p.Publish(f)
		sortD += st.SortDur
		enc += st.EncodeDur
		pub += st.PublishDur
	}
	b.ReportMetric(float64(step.Milliseconds())/float64(b.N), "step_ms")
	b.ReportMetric(float64(sortD.Milliseconds())/float64(b.N), "sort_ms")
	b.ReportMetric(float64(enc.Milliseconds())/float64(b.N), "gather_ms")
	b.ReportMetric(float64(pub.Milliseconds())/float64(b.N), "publish_ms")
	b.ReportMetric(float64(st.Tiles), "tiles")
	b.ReportMetric(float64(st.Bytes)/1e6, "MB")
}
