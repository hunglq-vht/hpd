// Command api is the tile monitor: it subscribes to every tile snapshot, keeps per-tile counts,
// rebuilds the cluster pyramid every tick and serves the HTTP API plus the svc.time responder.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/nats-io/nats.go"

	"dronetracks/internal/api"
	"dronetracks/internal/monitor"
	"dronetracks/internal/tiles"
)

func main() {
	log := slog.New(slog.NewTextHandler(os.Stdout, nil))
	natsURL := env("NATS_URL", nats.DefaultURL)
	addr := env("HTTP_ADDR", ":8090")

	cfg := api.DefaultConfig()
	cfg.NATS.WsURL = os.Getenv("PUBLIC_NATS_WS_URL")
	cfg.NATS.WsPath = env("PUBLIC_NATS_WS_PATH", cfg.NATS.WsPath)
	cfg.NATS.User = env("VIEWER_USER", cfg.NATS.User)
	cfg.NATS.Pass = env("VIEWER_PASS", cfg.NATS.Pass)
	if v, err := strconv.Atoi(os.Getenv("MAX_TOPICS")); err == nil && v > 0 {
		cfg.MaxTopics = v
	}
	if v, err := strconv.ParseFloat(os.Getenv("DEFAULT_MARGIN"), 64); err == nil && v >= 0 {
		cfg.DefaultMargin = v
	}

	mon := monitor.New()
	nc, err := nats.Connect(natsURL,
		nats.Name("tile-monitor"),
		nats.RetryOnFailedConnect(true),
		nats.MaxReconnects(-1),
	)
	if err != nil {
		log.Error("nats connect", "err", err)
		os.Exit(1)
	}
	defer nc.Drain()

	sub, err := nc.Subscribe(tiles.SubjectPrefix+"."+strconv.Itoa(tiles.TopicZoom)+".>", func(m *nats.Msg) { mon.Handle(m.Data) })
	if err != nil {
		log.Error("subscribe", "err", err)
		os.Exit(1)
	}
	// the monitor must never become a slow consumer of the firehose
	sub.SetPendingLimits(-1, 512<<20)

	if _, err := nc.Subscribe("svc.time", func(m *nats.Msg) { m.Respond(monitor.TimeReply(time.Now())) }); err != nil {
		log.Error("subscribe svc.time", "err", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		t := time.NewTicker(time.Second)
		defer t.Stop()
		var n int
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
			s := mon.Build()
			if n++; n%10 == 1 {
				m := mon.Metrics()
				dropped, _ := sub.Dropped()
				log.Info("pyramid", "seq", s.Seq, "tracks", s.Total, "tiles", s.Tiles, "build_ms", s.BuildMs,
					"msgs_s", int(m.MsgsPerSec), "MB_s", m.BytesPerSec/1e6, "lat_p50_ms", m.LatencyP50, "lat_p99_ms", m.LatencyP99,
					"dropped", dropped)
			}
		}
	}()

	srv := &http.Server{Addr: addr, Handler: api.NewServer(cfg, mon), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(shutdown)
	}()
	log.Info("api listening", "addr", addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("http", "err", err)
		os.Exit(1)
	}
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
