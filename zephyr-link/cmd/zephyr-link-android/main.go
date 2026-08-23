// zephyr-link-android embeds the Go Link core as a loopback-only process, the
// same shape as zephyr-ai-android. Android starts/stops it; stdin EOF is the
// lifetime boundary. Kotlin talks to it over 127.0.0.1 HTTP, never re
// implementing ZSL/2, so the mobile end shares the exact protocol core the
// server and desktop use.
package main

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"os"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/link"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	node := link.NewNode()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		log.Error("listen failed", "err", err)
		os.Exit(1)
	}
	httpServer := &http.Server{Handler: node.Handler()}
	go func() { _ = httpServer.Serve(listener) }()
	// One machine-readable readiness line, matching the AI runtime contract.
	_, _ = os.Stdout.WriteString(listener.Addr().String() + "\n")
	_ = os.Stdout.Sync()
	_, _ = os.Stdin.Read(make([]byte, 1))
	_ = httpServer.Shutdown(context.Background())
}
