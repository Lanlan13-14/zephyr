// Package mobile is the bounded in-process adapter used by Apple hosts. It exposes only
// initiator operations; it does not listen on any socket or expose server/identity-key routes.
package mobile

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"runtime/debug"
	"sync"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/link"
)

const MaxBody = 8 << 20

type Runtime struct {
	mu     sync.Mutex
	node   *link.Node
	closed bool
}

func New() *Runtime { return &Runtime{node: link.NewNode()} }

type response struct {
	Status int             `json:"status"`
	Body   json.RawMessage `json:"body"`
}

type recorder struct {
	header   http.Header
	code     int
	body     bytes.Buffer
	overflow bool
}

func (w *recorder) Header() http.Header { return w.header }
func (w *recorder) WriteHeader(code int) {
	if w.code == 0 {
		w.code = code
	}
}
func (w *recorder) Write(data []byte) (int, error) {
	if w.code == 0 {
		w.code = http.StatusOK
	}
	if w.body.Len()+len(data) > MaxBody {
		w.overflow = true
		return 0, io.ErrShortBuffer
	}
	return w.body.Write(data)
}
func failure(status int, code string) []byte {
	data, _ := json.Marshal(response{status, json.RawMessage(`{"ok":false,"error":{"code":"` + code + `","message":"Link request failed","retryable":false}}`)})
	return data
}
func (r *Runtime) Call(path string, body []byte) []byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return failure(http.StatusGone, "runtime_closed")
	}
	if path != "/link/dial" && path != "/link/dial/finish" && path != "/link/push" {
		return failure(http.StatusForbidden, "operation_not_allowed")
	}
	if len(body) > MaxBody || !json.Valid(body) {
		return failure(http.StatusBadRequest, "invalid_request")
	}
	// One native binding has one active outbound channel. Redial drops all old/pending keys;
	// network failures must not accumulate abandoned session material until eventual unbind.
	if path == "/link/dial" {
		r.node.CloseEmbeddedSessions()
	}
	request, err := http.NewRequest(http.MethodPost, "http://in-process"+path, bytes.NewReader(body))
	if err != nil {
		return failure(http.StatusBadRequest, "invalid_request")
	}
	request.Header.Set("Content-Type", "application/json")
	result := &recorder{header: make(http.Header)}
	r.node.Handler().ServeHTTP(result, request)
	if result.overflow || !json.Valid(result.body.Bytes()) {
		return failure(http.StatusBadGateway, "invalid_response")
	}
	if path == "/link/push" && result.code >= 400 {
		r.node.CloseEmbeddedSessions()
	}
	data, err := json.Marshal(response{result.code, result.body.Bytes()})
	if err != nil {
		return failure(http.StatusInternalServerError, "invalid_response")
	}
	return data
}

// Close is serialized with every network request. It drops this binding's entire keyed Node;
// handles cannot be reused or resurrected after native teardown. No shared process Node exists.
func (r *Runtime) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closed = true
	if r.node != nil {
		r.node.CloseEmbeddedSessions()
	}
	r.node = nil
}

func BuildInfo() []byte {
	out := map[string]any{"protocol": 1}
	if info, ok := debug.ReadBuildInfo(); ok {
		out["goVersion"] = info.GoVersion
		out["module"] = info.Main.Path
		for _, setting := range info.Settings {
			out[setting.Key] = setting.Value
		}
	}
	data, _ := json.Marshal(out)
	return data
}
