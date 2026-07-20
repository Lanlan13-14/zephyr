// Package main implements zephyr-worker: a long-lived SSH session and
// background-task executor that survives Node process restarts (FREEZE plan
// §7, §14, §18.4).
//
// Architecture (FREEZE plan §7 - Go for the data plane):
//   - The browser terminal WebSocket connects directly to this worker for
//     persistent SSH sessions; Node is NOT in the data path for terminal
//     bytes. Node only issues one-time tickets and manages task metadata.
//   - Worker holds the SSH client + tmux/screen attach so closing the browser
//     does not kill the session; reconnect resumes the same PTY.
//   - Task executor runs shell commands, scripts and long jobs detached from
//     the browser; events stream back via a ring buffer the Node poller (or
//     a sidecar WS) reads.
//
// Wire protocol: JSON envelopes over WebSocket, same envelope shape as the
// Node /ssh endpoint so the browser terminal client is transport-agnostic.
package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/crypto/ssh"
)

// ─── ticket registry ────────────────────────────────────────────────────────

// A ticket authorizes one WebSocket upgrade. Node mints it after ACL checks;
// the worker never sees secrets in URLs. Tickets are single-use and expire.
type Ticket struct {
	Token     string
	UserID    string
	ConnID    string   // saved-connection id (may be empty for transient)
	HostSpec  HostSpec // resolved connect target (no secrets reach the worker via URL)
	Secrets   Secrets  // server-side resolved credentials (set by Node out-of-band)
	Source    string   // "saved" | "transient"
	ExpiresAt time.Time
	Consumed  bool
}

type HostSpec struct {
	Host           string `json:"host"`
	Port           int    `json:"port"`
	Username       string `json:"username"`
	Protocol       string `json:"protocol"` // SSH | TELNET
	ConnectionMode string `json:"connectionMode"`
	// Proxy / jump chain resolved by Node; worker dials the first hop only.
	ProxyHost string   `json:"proxyHost,omitempty"`
	ProxyPort int      `json:"proxyPort,omitempty"`
	JumpHosts []string `json:"jumpHosts,omitempty"`
}

type Secrets struct {
	Password   string `json:"password,omitempty"`
	PrivateKey []byte `json:"privateKey,omitempty"`
	Passphrase string `json:"passphrase,omitempty"`
}

type TicketStore struct {
	mu      sync.Mutex
	tickets map[string]*Ticket
}

func NewTicketStore() *TicketStore {
	t := &TicketStore{tickets: make(map[string]*Ticket)}
	go t.gc()
	return t
}

func (s *TicketStore) Issue(t *Ticket) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tickets[t.Token] = t
}

func (s *TicketStore) Consume(token string) (*Ticket, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.tickets[token]
	if !ok {
		return nil, errors.New("ticket_not_found")
	}
	if t.Consumed {
		return nil, errors.New("ticket_consumed")
	}
	if time.Now().After(t.ExpiresAt) {
		delete(s.tickets, token)
		return nil, errors.New("ticket_expired")
	}
	t.Consumed = true
	delete(s.tickets, token) // single-use
	return t, nil
}

func (s *TicketStore) gc() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		now := time.Now()
		s.mu.Lock()
		for k, t := range s.tickets {
			if now.After(t.ExpiresAt) {
				delete(s.tickets, k)
			}
		}
		s.mu.Unlock()
	}
}

func randomToken() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func hashToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

// ─── SSH session manager ────────────────────────────────────────────────────

type Session struct {
	ID         string
	UserID     string
	ConnID     string
	Host       string
	Username   string
	CreatedAt  time.Time
	LastActive time.Time

	mu        sync.Mutex
	client    *ssh.Client
	stream    *sshSession
	stdin     io.WriteCloser
	stdout    io.Reader
	stderr    io.Reader
	closed    bool
	attached  []chan Envelope // subscribers (browser tabs / pollers)
	outputBuf *RingBuffer
	history   *WorkerHistory
}

// sshSession wraps *ssh.Session so we can store nil cleanly (ssh.Session is
// an interface and cannot be compared to nil).
type sshSession struct {
	*ssh.Session
}

type Envelope struct {
	Type      string          `json:"type"`
	SessionID string          `json:"sessionId,omitempty"`
	Data      string          `json:"data,omitempty"`
	Message   string          `json:"message,omitempty"`
	Rows      int             `json:"rows,omitempty"`
	Cols      int             `json:"cols,omitempty"`
	Code      string          `json:"code,omitempty"`
	Seq       int64           `json:"seq,omitempty"`
	Extra     json.RawMessage `json:"extra,omitempty"`
}

func NewSession(id, userID, connID, host, username string, history *WorkerHistory) *Session {
	return &Session{
		ID:         id,
		UserID:     userID,
		ConnID:     connID,
		Host:       host,
		Username:   username,
		CreatedAt:  time.Now(),
		LastActive: time.Now(),
		outputBuf:  NewRingBuffer(64 * 1024),
		history:    history,
	}
}

func (s *Session) subscribe() chan Envelope {
	ch := make(chan Envelope, 64)
	s.mu.Lock()
	s.attached = append(s.attached, ch)
	s.mu.Unlock()
	return ch
}

func (s *Session) unsubscribe(ch chan Envelope) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, c := range s.attached {
		if c == ch {
			s.attached = append(s.attached[:i], s.attached[i+1:]...)
			close(ch)
			return
		}
	}
}

func (s *Session) broadcast(env Envelope) {
	s.mu.Lock()
	subs := append([]chan Envelope(nil), s.attached...)
	s.mu.Unlock()
	for _, ch := range subs {
		select {
		case ch <- env:
		default:
			// subscriber too slow; drop to avoid blocking the SSH read loop.
			// Replay buffer covers gaps on reconnect.
		}
	}
}

func (s *Session) writeInput(data string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.LastActive = time.Now()
	if s.stdin == nil {
		return errors.New("session_not_ready")
	}
	_, err := s.stdin.Write([]byte(data))
	return err
}

func (s *Session) resize(cols, rows int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.LastActive = time.Now()
	if s.history != nil {
		s.history.AppendResize(s.UserID, s.ID, cols, rows)
	}
	if s.stream == nil {
		return errors.New("session_not_ready")
	}
	_, err := s.stream.SendRequest("window-change", false, ssh.Marshal(struct {
		Cols, Rows, X, Y uint32
	}{uint32(cols), uint32(rows), 0, 0}))
	return err
}

func (s *Session) close(reason string) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	if s.history != nil {
		s.history.AppendClose(s.UserID, s.ID, reason)
	}
	if s.stream != nil {
		s.stream.Close()
	}
	if s.client != nil {
		s.client.Close()
	}
	subs := s.attached
	s.attached = nil
	s.mu.Unlock()
	s.broadcast(Envelope{Type: "close", SessionID: s.ID, Message: reason})
	for _, ch := range subs {
		close(ch)
	}
}

// readLoops pump SSH output into the ring buffer and all subscribers.
// One goroutine per stream; exits when the stream closes.
func (s *Session) readLoops() {
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := s.stdout.Read(buf)
			if n > 0 {
				chunk := string(buf[:n])
				if s.history != nil {
					s.history.AppendOutput(s.UserID, s.ID, buf[:n])
				}
				s.outputBuf.Write(chunk)
				s.broadcast(Envelope{Type: "data", SessionID: s.ID, Data: chunk})
			}
			if err != nil {
				s.close("shell-close")
				return
			}
		}
	}()
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := s.stderr.Read(buf)
			if n > 0 {
				chunk := string(buf[:n])
				if s.history != nil {
					s.history.AppendOutput(s.UserID, s.ID, buf[:n])
				}
				s.outputBuf.Write(chunk)
				s.broadcast(Envelope{Type: "data", SessionID: s.ID, Data: chunk})
			}
			if err != nil {
				return
			}
		}
	}()
}

// ─── ring buffer for session replay ─────────────────────────────────────────

type RingBuffer struct {
	mu    sync.Mutex
	buf   []byte
	start int // index of oldest byte when full
	total int64
}

func NewRingBuffer(size int) *RingBuffer {
	if size < 1 {
		size = 1
	}
	return &RingBuffer{buf: make([]byte, size)}
}

// Write appends s, overwriting the oldest bytes when full.
func (r *RingBuffer) Write(s string) {
	if len(s) == 0 {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	// If the write is larger than the buffer, keep only the tail.
	if len(s) >= len(r.buf) {
		copy(r.buf, s[len(s)-len(r.buf):])
		r.start = 0
		r.total += int64(len(s))
		return
	}
	for len(s) > 0 {
		end := (r.start + len(s)) % len(r.buf)
		if r.start < end || r.start+len(s) == len(r.buf) {
			copy(r.buf[r.start:], s)
		} else {
			first := len(r.buf) - r.start
			copy(r.buf[r.start:], s[:first])
			copy(r.buf[:end], s[first:])
		}
		r.start = end
		r.total += int64(len(s))
		s = ""
	}
}

// Snapshot returns the buffered bytes in chronological order.
func (r *RingBuffer) Snapshot() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.total < int64(len(r.buf)) {
		return string(r.buf[:r.total])
	}
	out := make([]byte, len(r.buf))
	copy(out, r.buf[r.start:])
	copy(out[len(r.buf)-r.start:], r.buf[:r.start])
	return string(out)
}

// ─── session manager ────────────────────────────────────────────────────────

type SessionManager struct {
	mu       sync.RWMutex
	sessions map[string]*Session
}

func NewSessionManager() *SessionManager {
	return &SessionManager{sessions: make(map[string]*Session)}
}

func (m *SessionManager) Get(id string) *Session {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.sessions[id]
}

func (m *SessionManager) Put(s *Session) {
	m.mu.Lock()
	m.sessions[s.ID] = s
	m.mu.Unlock()
}

func (m *SessionManager) Delete(id string) {
	m.mu.Lock()
	delete(m.sessions, id)
	m.mu.Unlock()
}

func (m *SessionManager) ListForUser(userID string) []*Session {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var out []*Session
	for _, s := range m.sessions {
		if s.UserID == userID {
			out = append(out, s)
		}
	}
	return out
}

// ─── SSH dialer ─────────────────────────────────────────────────────────────

func dialSSH(ctx context.Context, spec HostSpec, secrets Secrets) (*ssh.Client, error) {
	authMethods := []ssh.AuthMethod{}
	if len(secrets.PrivateKey) > 0 {
		var signer ssh.Signer
		var err error
		if secrets.Passphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase(secrets.PrivateKey, []byte(secrets.Passphrase))
		} else {
			signer, err = ssh.ParsePrivateKey(secrets.PrivateKey)
		}
		if err != nil {
			return nil, fmt.Errorf("private_key_parse: %w", err)
		}
		authMethods = append(authMethods, ssh.PublicKeys(signer))
	}
	if secrets.Password != "" {
		authMethods = append(authMethods, ssh.Password(secrets.Password))
	}
	if len(authMethods) == 0 {
		return nil, errors.New("no_auth_method")
	}
	port := spec.Port
	if port == 0 {
		port = 22
	}
	cfg := &ssh.ClientConfig{
		User:            spec.Username,
		Auth:            authMethods,
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), // FREEZE plan §4.4: host-key policy is set by Node policy, not the worker
		Timeout:         10 * time.Second,
	}
	addr := fmt.Sprintf("%s:%d", spec.Host, port)
	d := netDialer()
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("dial: %w", err)
	}
	c, chans, reqs, err := ssh.NewClientConn(conn, addr, cfg)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("ssh_handshake: %w", err)
	}
	return ssh.NewClient(c, chans, reqs), nil
}

// ─── WebSocket upgrade (minimal, no external deps) ──────────────────────────

type WSHandler struct {
	tickets  *TicketStore
	sessions *SessionManager
	history  *WorkerHistory
	log      *slog.Logger
}

func (h *WSHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	token := r.Header.Get("X-Zephyr-Ticket")
	if token == "" {
		token = r.URL.Query().Get("ticket")
	}
	t, err := h.tickets.Consume(token)
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnauthorized)
		return
	}
	conn, err := upgrader().Upgrade(w, r, nil)
	if err != nil {
		h.log.Error("ws_upgrade", "err", err)
		return
	}
	defer conn.Close()
	h.serveWS(r.Context(), conn, t)
}

// Minimal upgrader interface so tests can stub it.
type Conn interface {
	ReadJSON(v interface{}) error
	WriteJSON(v interface{}) error
	Close() error
}

type Upgrader interface {
	Upgrade(w http.ResponseWriter, r *http.Request, responseHeader http.Header) (Conn, error)
}

// ─── server bootstrap ───────────────────────────────────────────────────────

func main() {
	addr := flag.String("addr", "127.0.0.1:8765", "worker listen address")
	flag.Parse()
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))

	tickets := NewTicketStore()
	sessions := NewSessionManager()
	historyRoot := os.Getenv("TERMINAL_HISTORY_DIR")
	if historyRoot == "" {
		historyRoot = filepath.Join("data", "terminal-history")
	}
	handler := &WSHandler{tickets: tickets, sessions: sessions, history: NewWorkerHistory(historyRoot), log: log}

	mux := http.NewServeMux()
	mux.Handle("/ssh", handler)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true, "worker": "zephyr-worker"})
	})
	// Node-side ticket issuer (called after Node resolves ACL + secrets)
	mux.HandleFunc("/internal/tickets", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Zephyr-Internal") != os.Getenv("WORKER_INTERNAL_TOKEN") {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		var t Ticket
		if err := json.NewDecoder(r.Body).Decode(&t); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if t.Token == "" {
			t.Token = randomToken()
		}
		if t.ExpiresAt.IsZero() {
			t.ExpiresAt = time.Now().Add(60 * time.Second)
		}
		tickets.Issue(&t)
		w.Header().Set("content-type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"token": t.Token, "hash": hashToken(t.Token)})
	})

	srv := &http.Server{Addr: *addr, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		log.Info("worker_listen", "addr", *addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("listen", "err", err)
			os.Exit(1)
		}
	}()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv.Shutdown(ctx)
}

// stubs replaced by real implementations in net.go / upgrader.go (see below)
var _ = strings.TrimSpace

// upgrader and netDialer are package-level vars set in upgrader.go / net.go.
var (
	defaultUpgrader Upgrader
	defaultDialer   = &netDialerImpl{}
)

func upgrader() Upgrader        { return defaultUpgrader }
func netDialer() *netDialerImpl { return defaultDialer }

// Ensure unused imports referenced via interface compile.
var _ = http.Header{}
