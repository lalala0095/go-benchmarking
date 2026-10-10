// Command server is the Go ADK benchmark server. "server healthcheck" probes
// /healthz on 127.0.0.1:$PORT (distroless has no curl).
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/lalala0095/go-benchmarking/go-server/internal/agent"
	"github.com/lalala0095/go-benchmarking/go-server/internal/api"
	"github.com/lalala0095/go-benchmarking/go-server/internal/config"
	"github.com/lalala0095/go-benchmarking/go-server/internal/db"
	"github.com/lalala0095/go-benchmarking/go-server/internal/instrument"
	"github.com/lalala0095/go-benchmarking/go-server/internal/metrics"
	"github.com/lalala0095/go-benchmarking/go-server/internal/rag"
)

const shutdownGrace = 20 * time.Second

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))
	if err := run(); err != nil {
		slog.Error("server failed", "err", err)
		os.Exit(1)
	}
}

func healthcheck() int {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	c := &http.Client{Timeout: 2 * time.Second}
	resp, err := c.Get("http://127.0.0.1:" + port + "/healthz")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

func run() error {
	cfg := config.Load()
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	stmts, err := rag.LoadStatements(cfg.SQLDir)
	if err != nil {
		return err
	}
	pool, err := db.OpenPool(ctx, cfg.DatabaseURL, cfg.DBPoolMax, 60*time.Second, stmts.Prepare)
	if err != nil {
		return err
	}
	defer pool.Close()

	rawSessions, err := db.OpenSessionService(cfg.DatabaseURL, cfg.SessionDBPoolMax)
	if err != nil {
		return fmt.Errorf("session service: %w", err)
	}
	sessions := instrument.WrapSessions(rawSessions)

	presets, err := rag.LoadPresets(cfg.RAGQueriesPath())
	if err != nil {
		slog.Warn("rag presets not loaded", "err", err)
	}
	rs := &rag.Service{
		Store:     &rag.Store{Pool: pool},
		Mock:      &rag.MockEmbedder{Delay: cfg.MockEmbedDelay, BatchSize: cfg.EmbedBatchSize},
		GeminiTag: cfg.GeminiEmbedModel,
		CorpusDir: cfg.CorpusDir,
		Presets:   presets,
	}
	if cfg.GeminiConfigured() {
		g, err := rag.NewGeminiEmbedder(ctx, cfg.GoogleAPIKey, cfg.GeminiEmbedModel, cfg.EmbedBatchSize, nil)
		if err != nil {
			return fmt.Errorf("gemini embedder: %w", err)
		}
		g.TaskType = cfg.GeminiEmbedTaskType
		rs.Gemini = g
	}

	runners, err := agent.Build(ctx, cfg, pool, rs, sessions)
	if err != nil {
		return err
	}

	srv := &api.Server{
		Cfg: cfg, Pool: pool, Sessions: sessions, Runners: runners, RAG: rs,
		Metrics:    metrics.New(pool, metrics.DefaultCgroupRoot),
		StartedAt:  time.Now(),
		CgroupRoot: metrics.DefaultCgroupRoot,
	}

	// baseCtx is cancelled only if the graceful drain times out.
	baseCtx, cancelBase := context.WithCancel(context.Background())
	defer cancelBase()
	httpSrv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           srv.Handler(),
		ReadTimeout:       30 * time.Second,
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      0, // SSE
		IdleTimeout:       120 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return baseCtx },
	}

	errCh := make(chan error, 1)
	go func() { errCh <- httpSrv.ListenAndServe() }()
	slog.Info("go-server listening", "addr", httpSrv.Addr, "gomaxprocs", runtime.GOMAXPROCS(0),
		"adk_version", api.ADKVersion(), "gemini_configured", cfg.GeminiConfigured(), "model", cfg.GeminiModel)

	select {
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case <-ctx.Done():
	}

	slog.Info("shutting down, draining in-flight requests", "grace", shutdownGrace.String())
	sctx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()
	if err := httpSrv.Shutdown(sctx); err != nil {
		slog.Warn("graceful shutdown timed out; cancelling in-flight requests", "err", err)
		cancelBase()
		_ = httpSrv.Close()
	}
	slog.Info("shutdown complete")
	return nil
}
