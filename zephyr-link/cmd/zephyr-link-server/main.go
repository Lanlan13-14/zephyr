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
	"bufio"
	"encoding/json"
	"io"
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
const envDevices = "ZEPHYR_LINK_DEVICES"        // path to a JSON list of enrolled device IDs
const envSyncBridge = "ZEPHYR_LINK_SYNC_BRIDGE" // loopback Node sync-core bridge URL
const envSyncToken = "ZEPHYR_LINK_SYNC_TOKEN"   // loopback shared secret for the bridge
const envFileBridge = "ZEPHYR_LINK_FILE_BRIDGE" // loopback Node file bridge URL
const envFileToken = "ZEPHYR_LINK_FILE_TOKEN"   // loopback shared secret for file bridge

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

	// The owned-sync lane forwards business frames to the single Node sync core
	// over loopback, so browser/mobile/desktop share one implementation. Absent
	// the env, the lane stays unregistered and a SYNC_OP is correctly rejected.
	if url := os.Getenv(envSyncBridge); url != "" {
		node.RegisterSyncBridge(link.SyncBridgeConfig{URL: url, AdminToken: os.Getenv(envSyncToken)})
		log.Info("owned-sync lane bridged to the Node sync core", "url", url)
	}
	if url := os.Getenv(envFileBridge); url != "" {
		node.RegisterFileBridge(link.FileBridgeConfig{URL: url, AdminToken: os.Getenv(envFileToken)})
		log.Info("file-bridge lane bridged to the Node file core", "url", url)
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
			DeviceID   string          `json:"deviceId"`
			SigningJWK json.RawMessage `json:"signingJwk"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&body); err != nil || body.DeviceID == "" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		adminMu.Lock()
		node.RegisterDeviceKey(body.DeviceID, body.SigningJWK)
		adminMu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})

	// Agent bastion tunnels: the Node front end attaches an Agent's stream
	// session and dials TCP through it. Loopback + admin token only, same as
	// the other internal lanes.
	tunnelHub := link.NewMainEndTunnelHub(node)
	mux.HandleFunc("/internal/tunnel/attach", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if adminToken == "" || !tokenEqual(r.Header.Get("X-Link-Admin"), adminToken) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var body struct {
			SessionID string `json:"sessionId"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&body); err != nil || body.SessionID == "" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if err := tunnelHub.Attach(body.SessionID); err != nil {
			writeJSONError(w, http.StatusConflict, "tunnel_attach_failed", err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"deviceId":` + jsonString(tunnelHub.DeviceID(body.SessionID)) + `}`))
	})
	mux.HandleFunc("/internal/tunnel/dial", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if adminToken == "" || !tokenEqual(r.Header.Get("X-Link-Admin"), adminToken) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var body struct {
			SessionID string `json:"sessionId"`
			Host      string `json:"host"`
			Port      int    `json:"port"`
			Lane      string `json:"lane"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<14)).Decode(&body); err != nil || body.Host == "" && body.Lane == "" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		// The session names which Agent to dial through. Without it the hub
		// would have to guess, which is exactly the process-wide pinning that
		// broke bastion use after an Agent reconnect.
		if body.SessionID == "" {
			writeJSONError(w, http.StatusBadRequest, "tunnel_session_required", "sessionId is required")
			return
		}
		var conn net.Conn
		var err error
		if body.Lane == "zft2" {
			conn, err = tunnelHub.DialZft2Lane(body.SessionID)
		} else {
			conn, err = tunnelHub.DialTunnel(body.SessionID, body.Host, body.Port)
		}
		if err != nil {
			writeJSONError(w, http.StatusBadGateway, "tunnel_dial_failed", err.Error())
			return
		}
		// Hijack and hand the raw tunnel to the Node caller: bytes from here on
		// are tunnel plaintext at the loopback boundary only; the Agent side
		// keeps sealing everything under ZSL/2.
		hj, ok := w.(http.Hijacker)
		if !ok {
			conn.Close()
			writeJSONError(w, http.StatusInternalServerError, "hijack_unsupported", "loopback hijack unsupported")
			return
		}
		netConn, buf, err := hj.Hijack()
		if err != nil {
			conn.Close()
			writeJSONError(w, http.StatusInternalServerError, "hijack_failed", err.Error())
			return
		}
		go pipeTunnel(netConn, buf, conn)
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

func writeJSONError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	payload, _ := json.Marshal(map[string]any{"ok": false, "error": map[string]any{"code": code, "message": message}})
	_, _ = w.Write(payload)
}

func jsonString(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

// pipeTunnel bridges the hijacked loopback TCP conn and the sealed Agent tunnel.
// The Node process speaks plaintext on its side of loopback; the Agent side of
// the tunnel only ever sees ciphertext under ZSL/2.
func pipeTunnel(netConn net.Conn, buf *bufio.ReadWriter, tunnel net.Conn) {
	defer netConn.Close()
	defer tunnel.Close()
	// Forward anything the client pipelined before the hijack landed.
	if buf.Reader.Buffered() > 0 {
		buffered := make([]byte, buf.Reader.Buffered())
		if _, err := io.ReadFull(buf.Reader, buffered); err == nil {
			if _, err := tunnel.Write(buffered); err != nil {
				return
			}
		}
	}
	done := make(chan struct{}, 2)
	go func() {
		io.Copy(tunnel, netConn)
		done <- struct{}{}
	}()
	go func() {
		io.Copy(netConn, tunnel)
		done <- struct{}{}
	}()
	<-done
}
