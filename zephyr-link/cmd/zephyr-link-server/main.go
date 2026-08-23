// zephyr-link-server is the server-side Link v2 transport. It runs the shared Go
// protocol core (ZSL/2 + codec) so the desktop, mobile and server ends all speak
// one implementation. The Node front-end (server.js) reverse-proxies
// /api/link/v2/* to this process.
//
// The handshake is gated on enrollment: a session only ever anchors to a device
// that completed enrollment. Devices are loaded from a registry file and can be
// registered at runtime through an admin endpoint that requires a bearer token.
package main

import (
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/link"
)

const envListen = "ZEPHYR_LINK_LISTEN"
const envAddr = "ZEPHYR_LINK_ADDR" // set by the Node supervisor to an ephemeral port
const envAdminToken = "ZEPHYR_LINK_ADMIN_TOKEN"
const envDevices = "ZEPHYR_LINK_DEVICES" // path to a JSON list of enrolled device IDs

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	node := link.NewNode()
	node.RequireEnrollment()

	// The Node supervisor passes an ephemeral loopback address; a standalone deploy
	// uses ZEPHYR_LINK_LISTEN or the default.
	listen := os.Getenv(envAddr)
	if listen == "" {
		listen = os.Getenv(envListen)
	}
	if listen == "" {
		listen = "127.0.0.1:3082"
	}
	adminToken := os.Getenv(envAdminToken)

	// Load the enrolled-device registry at boot.
	var loaded int
	if path := os.Getenv(envDevices); path != "" {
		loaded = loadDevices(node, path, log)
	}

	mux := http.NewServeMux()
	// The Link transport surface, reverse-proxied under /api/link/v2.
	mux.Handle("/link/", node.Handler())
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	// Runtime device registration for freshly consumed enrollments. The token is
	// compared in constant time and never logged.
	var adminMu sync.Mutex
	mux.HandleFunc("/admin/register-device", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if adminToken == "" || !tokenEqual(r.Header.Get("X-Link-Admin"), adminToken) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var body struct {
			DeviceID string `json:"deviceId"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&body); err != nil || body.DeviceID == "" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		adminMu.Lock()
		node.RegisterDevice(body.DeviceID)
		adminMu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})

	listener, err := net.Listen("tcp4", listen)
	if err != nil {
		log.Error("listen failed", "err", err)
		os.Exit(1)
	}
	log.Info("zephyr-link-server listening", "addr", listener.Addr().String(), "enrolledDevices", loaded)
	// Readiness line for any supervisor, matching the embedded contract.
	_, _ = os.Stdout.WriteString(listener.Addr().String() + "\n")
	_ = os.Stdout.Sync()
	if err := http.Serve(listener, mux); err != nil {
		log.Error("serve failed", "err", err)
		os.Exit(1)
	}
}

func loadDevices(node *link.Node, path string, log *slog.Logger) int {
	data, err := os.ReadFile(path)
	if err != nil {
		log.Warn("device registry unreadable; starting empty", "path", path, "err", err)
		return 0
	}
	var ids []string
	if err := json.Unmarshal(data, &ids); err != nil {
		log.Warn("device registry malformed; starting empty", "path", path, "err", err)
		return 0
	}
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id != "" {
			node.RegisterDevice(id)
		}
	}
	return len(ids)
}

func tokenEqual(got, want string) bool {
	if len(got) != len(want) {
		return false
	}
	var v byte
	for i := 0; i < len(got); i++ {
		v |= got[i] ^ want[i]
	}
	return v == 0
}
