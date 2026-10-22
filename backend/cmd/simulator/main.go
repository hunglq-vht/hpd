// Command simulator flies N drones around hotspot cities and publishes one binary snapshot per
// z13 tile per tick to NATS (tracks.13.<x>.<y>). In a real deployment this role is split into
// ingest (drone telemetry) and a tiler that batches updates per tile.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"syscall"
	"time"

	"github.com/nats-io/nats.go"

	"dronetracks/internal/sim"
)

func main() {
	log := slog.New(slog.NewTextHandler(os.Stdout, nil))
	natsURL := env("NATS_URL", nats.DefaultURL)
	n := envInt("TRACKS", 1_000_000)
	tick := time.Duration(envInt("TICK_MS", 1000)) * time.Millisecond
	seed := uint64(envInt("SEED", 42))
	workers := envInt("WORKERS", max(1, runtime.GOMAXPROCS(0)/2)) // leave CPU for NATS on small hosts
	conns := envInt("PUBLISHERS", 4)                              // parallel NATS connections; tiles are sharded across them

	var pubs []sim.PublishFunc
	var ncs []*nats.Conn
	for i := 0; i < conns; i++ {
		nc, err := nats.Connect(natsURL,
			nats.Name("simulator-"+strconv.Itoa(i)),
			nats.RetryOnFailedConnect(true),
			nats.MaxReconnects(-1),
			nats.ReconnectBufSize(64<<20),
			nats.FlusherTimeout(5*time.Second),
		)
		if err != nil {
			log.Error("nats connect", "err", err)
			os.Exit(1)
		}
		defer nc.Drain()
		ncs = append(ncs, nc)
		pubs = append(pubs, nc.Publish)
	}
	connected := func() bool {
		for _, nc := range ncs {
			if !nc.IsConnected() {
				return false
			}
		}
		return true
	}

	t0 := time.Now()
	fleet := sim.NewFleet(n, seed, workers)
	log.Info("fleet ready", "tracks", n, "cities", len(sim.Cities), "workers", workers, "connections", conns, "took", time.Since(t0).Round(time.Millisecond))

	pub := sim.NewPublisher(pubs[0], tick, pubs[1:]...)
	pub.Spread = time.Duration(envInt("PUBLISH_SPREAD_MS", int(tick.Milliseconds()*6/10))) * time.Millisecond
	pub.Slices = envInt("PUBLISH_SLICES", 20)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	ticker := time.NewTicker(tick)
	defer ticker.Stop()
	var ticks int
	var worst time.Duration
	for {
		select {
		case <-ctx.Done():
			log.Info("shutting down")
			return
		case <-ticker.C:
		}
		if !connected() {
			log.Warn("nats not connected, skipping tick")
			continue
		}
		start := time.Now()
		fleet.Step(tick.Seconds())
		stepDur := time.Since(start)
		st, err := pub.Publish(fleet)
		if err != nil {
			log.Error("publish", "err", err)
			continue
		}
		total := time.Since(start)
		worst = max(worst, total)
		if total > tick {
			log.Warn("tick overran its interval", "took", total, "interval", tick)
		}
		ticks++
		if ticks%10 == 1 {
			log.Info("tick",
				"seq", ticks, "tiles", st.Tiles, "emptied", st.Empty, "msgs", st.Messages,
				"MB", float64(st.Bytes)/1e6,
				"step_ms", ms(stepDur), "sort_ms", ms(st.SortDur), "gather_ms", ms(st.EncodeDur), "publish_ms", ms(st.PublishDur),
				"total_ms", ms(total), "worst_ms", ms(worst))
			worst = 0
		}
	}
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
