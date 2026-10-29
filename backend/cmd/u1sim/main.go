// Command u1sim stands in for u1-track-manager when the real one sends too little to load the app.
// It flies TRACKS drones around Vietnamese hotspots (by default as dense as the dev server's central
// Hanoi on 2026-10-26), serves the resolve and regions/stats API on HTTP_ADDR, and publishes every
// drone once per tick in each of FORMATS, on separate subject prefixes:
//
//	json    u1.track.region.xyz.13.<x>.<y>  one track.update per track, like the dev server
//	batch   u1.track.batch.xyz.13.<x>.<y>   one track.batch per region (same track objects)
//	binary  u1.track.bin.xyz.13.<x>.<y>     the demo's 16-byte records, one snapshot per region
//
// WebSocket compression is a NATS setting, not a format: see nats/nats-compressed.conf.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/nats-io/nats.go"

	"dronetracks/internal/sim"
	"dronetracks/internal/u1"
)

func main() {
	log := slog.New(slog.NewTextHandler(os.Stdout, nil))
	natsURL := env("NATS_URL", "nats://backend:backend-secret@127.0.0.1:4222")
	addr := env("HTTP_ADDR", ":8091")
	n := envInt("TRACKS", u1.HotspotTracks())
	tick := time.Duration(envInt("TICK_MS", 1000)) * time.Millisecond
	seed := uint64(envInt("SEED", 42))
	workers := envInt("WORKERS", max(1, runtime.GOMAXPROCS(0)/2)) // leave CPU for NATS on small hosts
	conns := envInt("PUBLISHERS", 2)                              // NATS connections per format
	spread := time.Duration(envInt("PUBLISH_SPREAD_MS", 0)) * time.Millisecond
	slices := envInt("PUBLISH_SLICES", 20)
	prefix := map[u1.Format]string{
		u1.FormatJSON:   env("JSON_PREFIX", "u1.track.region"),
		u1.FormatBatch:  env("BATCH_PREFIX", "u1.track.batch"),
		u1.FormatBinary: env("BINARY_PREFIX", "u1.track.bin"),
	}

	var ncs []*nats.Conn
	connect := func(name string) []sim.PublishFunc {
		var pubs []sim.PublishFunc
		for i := range conns {
			nc, err := nats.Connect(natsURL,
				nats.Name("u1sim-"+name+"-"+strconv.Itoa(i)),
				nats.RetryOnFailedConnect(true),
				nats.MaxReconnects(-1),
				nats.ReconnectBufSize(64<<20),
				nats.FlusherTimeout(5*time.Second),
			)
			if err != nil {
				log.Error("nats connect", "err", err)
				os.Exit(1)
			}
			ncs = append(ncs, nc)
			pubs = append(pubs, nc.Publish)
		}
		return pubs
	}
	defer func() {
		for _, nc := range ncs {
			nc.Drain()
		}
	}()

	t0 := time.Now()
	fleet := sim.NewFleetAround(u1.Hotspots, n, seed, workers)
	tracker := u1.NewTracker(n)
	type publisher struct {
		format u1.Format
		u1     *u1.Publisher
		bin    *sim.Publisher
	}
	var pubs []publisher
	for _, f := range strings.Split(env("FORMATS", "json,batch,binary"), ",") {
		format := u1.Format(strings.TrimSpace(f))
		switch format {
		case u1.FormatJSON, u1.FormatBatch:
			ps := connect(string(format))
			p := u1.NewPublisher(format, prefix[format], tracker, ps[0], ps[1:]...)
			p.Spread, p.Slices = spread, slices
			pubs = append(pubs, publisher{format: format, u1: p})
		case u1.FormatBinary:
			ps := connect(string(format))
			p := sim.NewPublisher(ps[0], tick, ps[1:]...)
			p.Spread, p.Slices = spread, slices
			p.SubjectOf = func(x, y int) string { return u1.Subject(prefix[format], x, y) }
			pubs = append(pubs, publisher{format: format, bin: p})
		default:
			log.Error("unknown format in FORMATS (json, batch, binary)", "format", format)
			os.Exit(1)
		}
	}
	log.Info("fleet ready", "tracks", n, "hotspots", len(u1.Hotspots), "workers", workers, "formats", len(pubs),
		"connections_per_format", conns, "took", time.Since(t0).Round(time.Millisecond))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	srv := &http.Server{Addr: addr, Handler: u1.NewServer(prefix[u1.FormatJSON], tracker.Counts), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(shutdown)
	}()
	go func() {
		log.Info("api listening", "addr", addr, "base", u1.BasePath)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("http", "err", err)
			os.Exit(1)
		}
	}()

	ticker := time.NewTicker(tick)
	defer ticker.Stop()
	h := u1.CentralHanoi
	for ticks := 1; ; ticks++ {
		select {
		case <-ctx.Done():
			log.Info("shutting down")
			return
		case <-ticker.C:
		}
		if !connected(ncs) {
			log.Warn("nats not connected, skipping tick")
			continue
		}
		start := time.Now()
		fleet.Step(tick.Seconds())
		t := tracker.Update(fleet, time.Now())
		stepDur := time.Since(start)

		// every format at once, each on its own connections, so none waits behind another
		attrs := make([][]any, len(pubs))
		var wg sync.WaitGroup
		for i, p := range pubs {
			wg.Add(1)
			go func() {
				defer wg.Done()
				var msgs int
				var bytes int64
				var dur time.Duration
				var err error
				if p.u1 != nil {
					var st u1.Stats
					st, err = p.u1.Publish(fleet, t)
					msgs, bytes, dur = st.Messages, st.Bytes, st.Dur
				} else {
					var st sim.TickStats
					st, err = p.bin.Publish(fleet)
					msgs, bytes, dur = st.Messages, st.Bytes, st.SortDur+st.EncodeDur+st.PublishDur
				}
				if err != nil {
					log.Error("publish", "format", p.format, "err", err)
				}
				attrs[i] = []any{string(p.format), slog.GroupValue(slog.Int("msgs", msgs), slog.Float64("MB", float64(bytes)/1e6), slog.Float64("ms", ms(dur)))}
			}()
		}
		wg.Wait()
		total := time.Since(start)
		if total > tick {
			log.Warn("tick overran its interval", "took", total, "interval", tick)
		}
		if ticks%10 == 1 {
			args := []any{"seq", ticks, "tracks", n, "regions", len(t.Counts), "moved", len(t.Moved),
				"central_hanoi", t.Counts.InRange(h.X0, h.Y0, h.X1, h.Y1),
				"densest_" + strconv.Itoa(h.DenseX) + "." + strconv.Itoa(h.DenseY), t.Counts.InRange(h.DenseX, h.DenseY, h.DenseX, h.DenseY),
				"step_ms", ms(stepDur), "total_ms", ms(total)}
			for _, a := range attrs {
				args = append(args, a...)
			}
			log.Info("tick", args...)
		}
	}
}

func connected(ncs []*nats.Conn) bool {
	for _, nc := range ncs {
		if !nc.IsConnected() {
			return false
		}
	}
	return true
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(k)); err == nil && v > 0 {
		return v
	}
	return def
}
