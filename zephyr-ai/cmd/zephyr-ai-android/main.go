package main

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/config"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/server"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/session"
)

// Android embeds the exact Zephyr AI runtime as a loopback-only process. Android starts/stops
// the process; stdin EOF is the lifetime boundary, so this entrypoint needs no Unix signals.
func main() {
	cfg := config.FromEnv()
	cfg.Listen = "127.0.0.1:0"
	// An empty platform host is intentional: it yields a model-only runtime rather than trying
	// the desktop Node default. Android supplies a loopback host whenever native tools are enabled.
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		panic(err)
	}
	store, err := session.Open(filepath.Join(cfg.DataDir, "ai.sqlite"))
	if err != nil {
		panic(err)
	}
	defer store.Close()
	runtime := server.New(cfg, store, log)
	defer runtime.Close()
	listener, err := net.Listen("tcp4", cfg.Listen)
	if err != nil {
		panic(err)
	}
	httpServer := &http.Server{Handler: runtime.Handler()}
	go func() { _ = httpServer.Serve(listener) }()
	// One machine-readable readiness line. Never print admin/provider secrets.
	_, _ = os.Stdout.WriteString(listener.Addr().String() + "\n")
	_ = os.Stdout.Sync()
	_, _ = os.Stdin.Read(make([]byte, 1))
	_ = httpServer.Shutdown(context.Background())
}
