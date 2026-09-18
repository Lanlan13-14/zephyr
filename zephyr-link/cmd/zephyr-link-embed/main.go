// zephyr-link-embed is the loopback Link runtime used by Agent hosts that
// can exec a child process: Linux, Windows, macOS, and iOS (via a bundled
// binary). Android keeps using cmd/zephyr-link-android, which is the same
// process shape minus persistent identity — Android signs in Keystore.
//
// Contract with the host:
//   - bind 127.0.0.1:0
//   - print "127.0.0.1:<port>\n" on stdout and flush
//   - exit when stdin reaches EOF
//   - ZEPHYR_LINK_IDENTITY_DIR, when set, persists ES256 keys so Dial can
//     finish a proof-required handshake without the host signing
package main

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/link"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	node := link.NewNode()
	if dir := strings.TrimSpace(os.Getenv("ZEPHYR_LINK_IDENTITY_DIR")); dir != "" {
		if err := node.EnablePersistentIdentity(dir); err != nil {
			log.Error("identity dir", "err", err)
			os.Exit(1)
		}
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		log.Error("listen failed", "err", err)
		os.Exit(1)
	}
	httpServer := &http.Server{Handler: node.Handler()}
	go func() { _ = httpServer.Serve(listener) }()
	_, _ = os.Stdout.WriteString(listener.Addr().String() + "\n")
	_ = os.Stdout.Sync()
	_, _ = os.Stdin.Read(make([]byte, 1))
	_ = httpServer.Shutdown(context.Background())
}
