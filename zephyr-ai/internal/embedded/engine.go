package embedded

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/config"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/server"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/session"
)

// Response represents an in-memory dispatch result.
type Response struct {
	StatusCode int               `json:"statusCode"`
	Headers    map[string]string `json:"headers"`
	Body       []byte            `json:"body"`
}

// Runtime is the embedded Zephyr AI core running in-process.
// It bypasses loopback sockets completely and dispatches HTTP requests
// directly against the Go server.Handler() in memory.
type Runtime struct {
	mu         sync.Mutex
	cfg        config.Config
	store      *session.Store
	srv        *server.Server
	adminToken string
	closed     bool
}

// Config specifies the runtime startup parameters.
type Config struct {
	DataDir           string `json:"dataDir"`
	AdminToken        string `json:"adminToken"`
	PlatformHostURL   string `json:"platformHostUrl"`
	PlatformHostToken string `json:"platformHostToken"`
}

// Start boots an embedded Zephyr AI runtime.
func Start(cfg Config) (*Runtime, error) {
	if cfg.DataDir == "" {
		return nil, fmt.Errorf("dataDir required")
	}
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		return nil, fmt.Errorf("mkdir dataDir: %w", err)
	}
	dbPath := filepath.Join(cfg.DataDir, "ai.sqlite")
	store, err := session.Open(dbPath)
	if err != nil {
		return nil, fmt.Errorf("open session store: %w", err)
	}

	appCfg := config.Config{
		DataDir:           cfg.DataDir,
		AdminToken:        cfg.AdminToken,
		PlatformHostURL:   cfg.PlatformHostURL,
		PlatformHostToken: cfg.PlatformHostToken,
		Listen:            "in-memory",
	}

	log := slog.New(slog.NewJSONHandler(io.Discard, nil))
	srv := server.New(appCfg, store, log)

	return &Runtime{
		cfg:        appCfg,
		store:      store,
		srv:        srv,
		adminToken: cfg.AdminToken,
	}, nil
}

// Dispatch executes an HTTP-like request directly against the embedded router in-memory.
func (r *Runtime) Dispatch(method, path string, headers map[string]string, body []byte) (Response, error) {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return Response{StatusCode: http.StatusServiceUnavailable}, fmt.Errorf("runtime closed")
	}
	handler := r.srv.Handler()
	adminToken := r.adminToken
	r.mu.Unlock()

	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	if req.Header.Get("Content-Type") == "" && len(body) > 0 {
		req.Header.Set("Content-Type", "application/json")
	}
	if adminToken != "" && req.Header.Get("x-ai-admin") == "" {
		req.Header.Set("x-ai-admin", adminToken)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	respHeaders := make(map[string]string)
	for k, v := range rec.Header() {
		if len(v) > 0 {
			respHeaders[k] = v[0]
		}
	}

	return Response{
		StatusCode: rec.Code,
		Headers:    respHeaders,
		Body:       rec.Body.Bytes(),
	}, nil
}

// Close shuts down the embedded runtime cleanly.
func (r *Runtime) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil
	}
	r.closed = true
	if r.srv != nil {
		r.srv.Close()
	}
	if r.store != nil {
		return r.store.Close()
	}
	return nil
}

// Global singleton for JNI invocation
var (
	globalMu      sync.Mutex
	globalRuntime *Runtime
)

// InitGlobal initializes or re-initializes the global singleton runtime.
func InitGlobal(jsonConfig string) (string, error) {
	var c Config
	if err := json.Unmarshal([]byte(jsonConfig), &c); err != nil {
		return "", fmt.Errorf("parse config json: %w", err)
	}
	globalMu.Lock()
	defer globalMu.Unlock()
	if globalRuntime != nil {
		_ = globalRuntime.Close()
		globalRuntime = nil
	}
	rt, err := Start(c)
	if err != nil {
		return "", err
	}
	globalRuntime = rt
	return `{"ok":true}`, nil
}

// DispatchGlobal dispatches a request via the global singleton.
func DispatchGlobal(method, path, jsonHeaders, bodyStr string) (string, error) {
	globalMu.Lock()
	rt := globalRuntime
	globalMu.Unlock()
	if rt == nil {
		return "", fmt.Errorf("runtime not initialized")
	}

	headers := make(map[string]string)
	if jsonHeaders != "" {
		_ = json.Unmarshal([]byte(jsonHeaders), &headers)
	}

	resp, err := rt.Dispatch(method, path, headers, []byte(bodyStr))
	if err != nil {
		return "", err
	}

	out, err := json.Marshal(resp)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// CloseGlobal shuts down the global singleton.
func CloseGlobal() {
	globalMu.Lock()
	defer globalMu.Unlock()
	if globalRuntime != nil {
		_ = globalRuntime.Close()
		globalRuntime = nil
	}
}
