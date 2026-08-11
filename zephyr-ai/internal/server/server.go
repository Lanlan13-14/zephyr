// Package server is the zephyr-ai control/data HTTP surface.
//
// Auth model:
//   - All routes require X-AI-Admin (shared with Node bridge) OR a one-time run ticket.
//   - Browser never holds provider API keys; Node injects them when starting a run.
//   - SSE stream is authorized by run ticket bound to userId+runId.
package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"path/filepath"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/agent"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/archive"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/compose"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/config"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/event"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/mcp"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/permission"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
	_ "github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider/anthropic"
	_ "github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider/gemini"
	_ "github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider/openai"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/session"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/tool"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/tool/builtin"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/tool/platform"
)

const maxCaptureUploadBytes = (8 << 20) + 1

type Server struct {
	cfg      config.Config
	store    *session.Store
	log      *slog.Logger
	mcp      *mcp.Manager
	host     *platform.Host
	runner   *agent.Runner
	archive  *archive.Store
	captures *agent.CaptureStore

	mu       sync.Mutex
	tickets  map[string]*runTicket
	cancels  map[string]context.CancelFunc
	runDone  map[string]chan struct{}
	emitters map[string]*sseHub
}

type runTicket struct {
	Token     string
	UserID    string
	RunID     string
	SessionID string
	Expires   time.Time
}

func New(cfg config.Config, store *session.Store, log *slog.Logger) *Server {
	if log == nil {
		log = slog.Default()
	}
	var host *platform.Host
	if cfg.PlatformHostURL != "" {
		host = platform.NewHost(cfg.PlatformHostURL, cfg.PlatformHostToken)
	}
	arch, err := archive.Open(filepath.Join(cfg.DataDir, "archive"))
	if err != nil {
		log.Warn("archive open failed", "err", err)
	}
	return &Server{
		cfg:      cfg,
		store:    store,
		log:      log,
		mcp:      mcp.NewManager(),
		host:     host,
		runner:   agent.NewRunner(),
		archive:  arch,
		captures: agent.NewCaptureStore(filepath.Join(os.TempDir(), "zephyr-ai-captures")),
		tickets:  make(map[string]*runTicket),
		cancels:  make(map[string]context.CancelFunc),
		runDone:  make(map[string]chan struct{}),
		emitters: make(map[string]*sseHub),
	}
}

func (s *Server) Close() {
	if s.captures != nil {
		s.captures.Clear()
	}
	if s.archive != nil {
		_ = s.archive.Close()
		s.archive = nil
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealth)
	mux.HandleFunc("POST /admin/sessions", s.admin(s.handleCreateSession))
	mux.HandleFunc("GET /admin/sessions", s.admin(s.handleListSessions))
	mux.HandleFunc("GET /admin/sessions/{id}", s.admin(s.handleGetSession))
	mux.HandleFunc("GET /admin/sessions/{id}/usage", s.admin(s.handleSessionUsage))
	mux.HandleFunc("GET /admin/sessions/{id}/messages", s.admin(s.handleListMessages))
	mux.HandleFunc("POST /admin/sessions/{id}/archive", s.admin(s.handleArchiveSession))
	mux.HandleFunc("POST /admin/runs", s.admin(s.handleStartRun))
	mux.HandleFunc("POST /admin/runs/{id}/abort", s.admin(s.handleAbortRun))
	mux.HandleFunc("POST /admin/runs/{id}/permission", s.admin(s.handlePermission))
	mux.HandleFunc("POST /admin/runs/{id}/capture-image", s.admin(s.handleCaptureImage))
	mux.HandleFunc("POST /admin/runs/{id}/capture", s.admin(s.handleCapture))
	mux.HandleFunc("GET /admin/runs/{id}", s.admin(s.handleGetRun))
	mux.HandleFunc("POST /admin/mcp/connect", s.admin(s.handleMCPConnect))
	mux.HandleFunc("GET /v1/runs/{id}/events", s.handleSSE) // ticket or admin
	return mux
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"ok": true, "service": "zephyr-ai", "eventProtocol": event.ProtocolVersion})
}

func (s *Server) admin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.checkAdmin(r) {
			writeJSON(w, 401, map[string]any{"ok": false, "code": "unauthorized", "error": "invalid admin token"})
			return
		}
		next(w, r)
	}
}

func (s *Server) checkAdmin(r *http.Request) bool {
	if s.cfg.AdminToken == "" {
		// dev only: allow empty token on loopback
		host := r.RemoteAddr
		return strings.HasPrefix(host, "127.0.0.1") || strings.HasPrefix(host, "[::1]") || strings.HasPrefix(host, "localhost")
	}
	return r.Header.Get("x-ai-admin") == s.cfg.AdminToken || r.Header.Get("X-AI-Admin") == s.cfg.AdminToken
}

type createSessionReq struct {
	UserID             string         `json:"userId"`
	DatabaseGeneration string         `json:"databaseGeneration"`
	Title              string         `json:"title"`
	Meta               map[string]any `json:"metadata"`
}

func (s *Server) handleCreateSession(w http.ResponseWriter, r *http.Request) {
	var req createSessionReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.UserID == "" || req.DatabaseGeneration == "" {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "userId and databaseGeneration required"})
		return
	}
	sess, err := s.store.CreateSession(req.UserID, req.Title, req.Meta, req.DatabaseGeneration)
	if err != nil {
		writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "session": sess})
}

func (s *Server) handleListSessions(w http.ResponseWriter, r *http.Request) {
	userID := r.URL.Query().Get("userId")
	databaseGeneration := r.URL.Query().Get("databaseGeneration")
	if userID == "" || databaseGeneration == "" {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "userId and databaseGeneration required"})
		return
	}
	list, err := s.store.ListSessions(userID, 50, databaseGeneration)
	if err != nil {
		writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "sessions": list})
}

func (s *Server) handleGetSession(w http.ResponseWriter, r *http.Request) {
	userID := r.URL.Query().Get("userId")
	databaseGeneration := r.URL.Query().Get("databaseGeneration")
	id := r.PathValue("id")
	if userID == "" || databaseGeneration == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "userId and databaseGeneration required"})
		return
	}
	sess, err := s.store.GetSession(userID, id, databaseGeneration)
	if err != nil {
		writeJSON(w, 404, map[string]any{"ok": false, "error": "not_found"})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "session": sess})
}

func (s *Server) handleSessionUsage(w http.ResponseWriter, r *http.Request) {
	userID := strings.TrimSpace(r.URL.Query().Get("userId"))
	databaseGeneration := strings.TrimSpace(r.URL.Query().Get("databaseGeneration"))
	if userID == "" || databaseGeneration == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "user_id_and_database_generation_required"})
		return
	}
	usage, err := s.store.SessionUsage(userID, r.PathValue("id"), databaseGeneration)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "not_found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "usage": usage})
}

func (s *Server) handleListMessages(w http.ResponseWriter, r *http.Request) {
	userID := r.URL.Query().Get("userId")
	databaseGeneration := r.URL.Query().Get("databaseGeneration")
	id := r.PathValue("id")
	if userID == "" || databaseGeneration == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "userId and databaseGeneration required"})
		return
	}
	if err := s.store.ValidateUserSession(userID, id, databaseGeneration); err != nil {
		writeJSON(w, 404, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	msgs, err := s.store.ListMessages(id, 0, 500)
	if err != nil {
		writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "messages": msgs})
}

func (s *Server) handleArchiveSession(w http.ResponseWriter, r *http.Request) {
	var body struct {
		UserID string `json:"userId"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if err := s.store.ArchiveSession(body.UserID, r.PathValue("id")); err != nil {
		writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// startRunReq is the full run kickoff payload from Node.
type startRunReq struct {
	UserID             string             `json:"userId"`
	SessionID          string             `json:"sessionId"`
	Provider           provider.Config    `json:"provider"`
	Model              string             `json:"model"`
	Message            string             `json:"message"`
	Messages           []provider.Message `json:"messages,omitempty"` // optional multi-part user content
	BootstrapMessages  []provider.Message `json:"bootstrapMessages,omitempty"`
	Options            map[string]any     `json:"options"`
	MaxSteps           int                `json:"maxSteps"`
	Permission         permission.Policy  `json:"permission"`
	AutoConfirm        bool               `json:"autoConfirm"`
	AutoConfirmDelayMS int                `json:"autoConfirmDelayMs"`
	Mode               string             `json:"mode"` // standard|plan|goal
	SystemCompose      compose.Input      `json:"systemCompose"`
	ContextJSON        json.RawMessage    `json:"context"`
	MCPServers         []mcp.ServerConfig `json:"mcpServers,omitempty"`
	DatabaseGeneration string             `json:"databaseGeneration"`
	RunNonce           string             `json:"runNonce"`
	// Quota limits (0 = unlimited)
	HourlyLimit         int `json:"hourlyLimit"`
	DailyLimit          int `json:"dailyLimit"`
	ContextWindowTokens int `json:"contextWindowTokens"`
	OutputReserveTokens int `json:"outputReserveTokens"`
}

func (s *Server) handleStartRun(w http.ResponseWriter, r *http.Request) {
	var req startRunReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "bad json: " + err.Error()})
		return
	}
	if req.UserID == "" || req.SessionID == "" || req.DatabaseGeneration == "" || req.RunNonce == "" {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "userId, sessionId, databaseGeneration and runNonce required"})
		return
	}
	if err := s.store.ValidateUserSession(req.UserID, req.SessionID, req.DatabaseGeneration); err != nil {
		writeJSON(w, 404, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	// Canonical history is imported through a distinct, insert-if-empty seam.
	// The session store revalidates owner, roles and the absence of parts/tool
	// state so the provider tail below cannot accidentally become a sync path.
	if len(req.BootstrapMessages) > 0 {
		if _, err := s.store.BootstrapMessages(req.UserID, req.SessionID, req.BootstrapMessages); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"ok": false, "code": "invalid_bootstrap_messages", "error": err.Error(),
			})
			return
		}
	}
	if req.Provider.APIKey == "" && req.Provider.Kind != provider.KindOllama {
		// allow empty for local ollama; otherwise require key
		if req.Provider.Kind != "" && req.Provider.Kind != provider.KindOllama {
			// still allow — some gateways use headers only
		}
	}
	// Quota
	if req.HourlyLimit > 0 {
		n, err := s.store.IncrQuota(req.UserID, "hourly", 3600)
		if err == nil && n > req.HourlyLimit {
			writeJSON(w, 429, map[string]any{"ok": false, "code": "quota_hourly", "error": "hourly AI quota exceeded"})
			return
		}
	}
	if req.DailyLimit > 0 {
		n, err := s.store.IncrQuota(req.UserID, "daily", 86400)
		if err == nil && n > req.DailyLimit {
			writeJSON(w, 429, map[string]any{"ok": false, "code": "quota_daily", "error": "daily AI quota exceeded"})
			return
		}
	}

	model := req.Model
	if model == "" {
		model = req.Provider.DefaultModel
	}
	if model == "" {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "model required"})
		return
	}

	p, err := provider.New(req.Provider)
	if err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": err.Error()})
		return
	}

	run, err := s.store.CreateRun(req.SessionID, req.UserID, req.Provider.Name, model)
	if err != nil {
		writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
		return
	}

	// SSE hub + ticket for browser
	hub := newSSEHub()
	s.mu.Lock()
	s.emitters[run.ID] = hub
	s.mu.Unlock()

	ticket := s.issueTicket(req.UserID, run.ID, req.SessionID)

	// Build tools. Platform catalog is mandatory: running without it makes the
	// model falsely claim that Zephyr tools do not exist.
	reg, err := s.buildToolRegistry(r.Context(), req.UserID, req.SessionID, run.ID, req.DatabaseGeneration, req.RunNonce, req.MCPServers, req.ContextJSON)
	if err != nil {
		_ = s.store.UpdateRunStatus(run.ID, "failed", err.Error(), nil)
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "code": "platform_tools_unavailable", "error": err.Error()})
		return
	}
	reg = agent.FilterToolsForMode(reg, req.Mode)

	// Permission engine + session grants as allow
	eng := permission.NewEngine(req.Permission)
	if grants, err := s.store.ListGrants(req.UserID, req.SessionID); err == nil && len(grants) > 0 {
		pol := eng.Get()
		for _, g := range grants {
			pol.Allow = append(pol.Allow, permission.Rule(g))
		}
		eng.Set(pol)
	}

	assembled := compose.Build(req.SystemCompose)
	system := assembled.Stable + agent.ModeSystemSuffix(req.Mode)
	volatile := assembled.Volatile

	extra := req.Messages
	if req.Message != "" {
		extra = append(extra, provider.Message{Role: provider.RoleUser, Content: req.Message})
	}
	if len(extra) == 0 {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "message required"})
		return
	}

	maxSteps := req.MaxSteps
	if maxSteps <= 0 {
		maxSteps = s.cfg.DefaultMaxSteps
	}

	mcpJSON, _ := json.Marshal(req.MCPServers)
	runCfg := agent.Config{
		RunID:               run.ID,
		SessionID:           req.SessionID,
		UserID:              req.UserID,
		Provider:            p,
		Model:               model,
		Tools:               reg,
		Permission:          eng,
		Store:               s.store,
		Emitter:             hub,
		SystemPrompt:        system,
		VolatilePrompt:      volatile,
		ExtraMessages:       extra,
		Options:             req.Options,
		MaxSteps:            maxSteps,
		ProviderConfig:      req.Provider,
		PermissionPolicy:    req.Permission,
		AutoConfirm:         req.AutoConfirm,
		AutoConfirmDelayMS:  req.AutoConfirmDelayMS,
		MCPServersJSON:      mcpJSON,
		ContextJSON:         req.ContextJSON,
		DatabaseGeneration:  req.DatabaseGeneration,
		RunNonce:            req.RunNonce,
		ContextWindowTokens: req.ContextWindowTokens,
		OutputReserveTokens: req.OutputReserveTokens,
		Archive:             s.archive,
		Captures:            s.captures,
		Mode:                req.Mode,
	}

	s.launchRun(run.ID, hub, runCfg)

	sseURL := "/v1/runs/" + run.ID + "/events?ticket=" + ticket
	if s.cfg.PublicBaseURL != "" {
		sseURL = strings.TrimRight(s.cfg.PublicBaseURL, "/") + sseURL
	}
	writeJSON(w, 200, map[string]any{
		"ok":        true,
		"runId":     run.ID,
		"ticket":    ticket,
		"ssePath":   sseURL,
		"sessionId": req.SessionID,
	})
}

// launchRun starts the agent loop in a goroutine. On pause the hub stays open.
func (s *Server) launchRun(runID string, hub *sseHub, cfg agent.Config) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	s.mu.Lock()
	if old, ok := s.cancels[runID]; ok {
		old()
	}
	s.cancels[runID] = cancel
	s.runDone[runID] = done
	s.emitters[runID] = hub
	s.mu.Unlock()

	go func() {
		defer func() {
			s.mu.Lock()
			if s.runDone[runID] == done {
				delete(s.cancels, runID)
				delete(s.runDone, runID)
			}
			s.mu.Unlock()
			close(done)
		}()
		_, err := s.runner.Run(ctx, cfg)
		if err != nil {
			if _, ok := err.(*agent.PauseError); ok {
				// Hub stays open for resume SSE; do not close.
				return
			}
			if ctx.Err() != nil {
				return
			}
			s.log.Error("run failed", "runId", runID, "err", err)
		}
		// Terminal: keep emitter briefly for late subscribers then close.
		time.AfterFunc(2*time.Minute, func() {
			s.mu.Lock()
			if s.emitters[runID] == hub {
				delete(s.emitters, runID)
				hub.Close()
			}
			s.mu.Unlock()
		})
	}()
}

// buildToolRegistry reconstructs registry (MCP + platform host + history).
func (s *Server) buildToolRegistry(ctx context.Context, userID, sessionID, runID, databaseGeneration, runNonce string, servers []mcp.ServerConfig, contextJSON json.RawMessage) (*tool.Registry, error) {
	reg := tool.NewRegistry()
	for _, mc := range servers {
		if _, err := s.mcp.Connect(ctx, mc); err != nil {
			s.log.Warn("mcp connect failed", "name", mc.Name, "err", err)
			continue
		}
	}
	_ = s.mcp.RegisterAll(ctx, reg)
	if s.host != nil {
		if err := platform.RegisterFromHost(ctx, reg, s.host, userID, sessionID, runID, databaseGeneration, runNonce, contextJSON); err != nil {
			return nil, fmt.Errorf("platform_tools_unavailable: %w", err)
		}
	}
	_ = builtin.RegisterHistoryTools(reg, &builtin.HistoryDeps{
		Archive: s.archive, UserID: userID, SessionID: sessionID,
	})
	return reg, nil
}

// rebuildTools reconstructs registry for resume from raw MCP JSON.
func (s *Server) rebuildTools(ctx context.Context, userID, sessionID, runID, databaseGeneration, runNonce string, mcpRaw, contextJSON json.RawMessage) (*tool.Registry, error) {
	var servers []mcp.ServerConfig
	if len(mcpRaw) > 0 {
		_ = json.Unmarshal(mcpRaw, &servers)
	}
	return s.buildToolRegistry(ctx, userID, sessionID, runID, databaseGeneration, runNonce, servers, contextJSON)
}

func (s *Server) handleAbortRun(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	s.mu.Lock()
	cancel, ok := s.cancels[id]
	done := s.runDone[id]
	s.mu.Unlock()
	if ok {
		cancel()
	}
	if done != nil {
		select {
		case <-done:
		case <-r.Context().Done():
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "code": "run_abort_interrupted", "error": "run abort was interrupted"})
			return
		case <-time.After(30 * time.Second):
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "code": "run_abort_timeout", "error": "timed out waiting for run abort"})
			return
		}
	}
	_ = s.store.UpdateRunStatus(id, "aborted", "user_abort", nil)
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) handleGetRun(w http.ResponseWriter, r *http.Request) {
	run, err := s.store.GetRun(r.PathValue("id"))
	if err != nil {
		writeJSON(w, 404, map[string]any{"ok": false, "error": "not_found"})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "run": run})
}

func (s *Server) handlePermission(w http.ResponseWriter, r *http.Request) {
	var body struct {
		UserID    string          `json:"userId"`
		SessionID string          `json:"sessionId"`
		CallID    string          `json:"callId"`
		Tool      string          `json:"tool"`
		Approve   bool            `json:"approve"`
		Scope     string          `json:"scope"`    // once|session|user
		Provider  provider.Config `json:"provider"` // Node re-injects API key
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "bad json"})
		return
	}
	runID := r.PathValue("id")
	var st agent.ResumeState
	if err := s.store.LoadRunResume(runID, &st); err != nil {
		writeJSON(w, 409, map[string]any{"ok": false, "error": "no_resume_state", "detail": err.Error()})
		return
	}
	run, err := s.store.GetRun(runID)
	if err != nil {
		writeJSON(w, 404, map[string]any{"ok": false, "error": "run_not_found"})
		return
	}
	userID := body.UserID
	if userID == "" {
		userID = run.UserID
	}
	sessionID := body.SessionID
	if sessionID == "" {
		sessionID = run.SessionID
	}

	if !body.Approve {
		_ = s.store.UpdateRunStatus(runID, "aborted", "permission_denied", nil)
		_ = s.store.ClearRunResume(runID)
		// emit abort on hub if present
		s.mu.Lock()
		hub := s.emitters[runID]
		s.mu.Unlock()
		if hub != nil {
			_ = hub.Emit(event.New(runID, time.Now().UnixNano(), event.TypeRunAborted, event.RunTerminal{Reason: "permission_denied"}))
		}
		writeJSON(w, 200, map[string]any{"ok": true, "approved": false, "resumed": false})
		return
	}

	scope := body.Scope
	if scope == "" {
		scope = "once"
	}
	rule := body.Tool
	if rule == "" && st.Ask != nil {
		rule = st.Ask.Name
	}
	if rule == "" {
		rule = "*"
	}
	onceGrant := scope == "once"
	if !onceGrant {
		_ = s.store.AddGrant(userID, sessionID, rule+"(*)", scope, 0)
	}

	// Rebuild provider (Node must pass API key again)
	pcfg := st.Provider
	if body.Provider.APIKey != "" {
		pcfg.APIKey = body.Provider.APIKey
	}
	if body.Provider.BaseURL != "" {
		pcfg.BaseURL = body.Provider.BaseURL
	}
	if body.Provider.Kind != "" {
		pcfg.Kind = body.Provider.Kind
	}
	p, err := provider.New(pcfg)
	if err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": err.Error()})
		return
	}

	pol := permission.Policy{Mode: permission.Mode(st.PermissionMode)}
	if pol.Mode == "" {
		pol.Mode = permission.ModeAsk
	}
	for _, d := range st.Deny {
		pol.Deny = append(pol.Deny, permission.Rule(d))
	}
	for _, a := range st.Allow {
		pol.Allow = append(pol.Allow, permission.Rule(a))
	}
	for _, a := range st.AskRules {
		pol.Ask = append(pol.Ask, permission.Rule(a))
	}
	// standing grants
	if grants, err := s.store.ListGrants(userID, sessionID); err == nil {
		for _, g := range grants {
			pol.Allow = append(pol.Allow, permission.Rule(g))
		}
	}
	// one-shot: allow this exact tool for the resume decision via Resume path (not rule)
	eng := permission.NewEngine(pol)

	reg, err := s.rebuildTools(r.Context(), userID, sessionID, runID, st.DatabaseGeneration, st.RunNonce, st.MCPServers, st.Context)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "code": "platform_tools_unavailable", "error": err.Error()})
		return
	}

	s.mu.Lock()
	hub := s.emitters[runID]
	s.mu.Unlock()
	if hub == nil {
		hub = newSSEHub()
	}

	callID := body.CallID
	if callID == "" && st.Ask != nil {
		callID = st.Ask.CallID
		if callID == "" {
			callID = st.Ask.AskID
		}
	}

	cfg := agent.Config{
		RunID:               runID,
		SessionID:           sessionID,
		UserID:              userID,
		Provider:            p,
		Model:               st.Model,
		Tools:               reg,
		Permission:          eng,
		Store:               s.store,
		Emitter:             hub,
		SystemPrompt:        st.SystemPrompt,
		VolatilePrompt:      st.VolatilePrompt,
		Options:             st.Options,
		MaxSteps:            st.MaxSteps,
		ProviderConfig:      pcfg,
		PermissionPolicy:    pol,
		AutoConfirm:         st.AutoConfirm,
		AutoConfirmDelayMS:  st.AutoConfirmDelayMS,
		MCPServersJSON:      st.MCPServers,
		ContextJSON:         st.Context,
		DatabaseGeneration:  st.DatabaseGeneration,
		RunNonce:            st.RunNonce,
		ContextWindowTokens: st.ContextWindowTokens,
		OutputReserveTokens: st.OutputReserveTokens,
		Captures:            s.captures,
		Resume:              &st,
		Decision: &agent.ResumeDecision{
			Approve:   true,
			CallID:    callID,
			OnceGrant: onceGrant,
		},
	}
	s.launchRun(runID, hub, cfg)
	ticket := s.issueTicket(userID, runID, sessionID)
	writeJSON(w, 200, map[string]any{
		"ok": true, "approved": true, "resumed": true,
		"runId": runID, "callId": callID, "sessionId": sessionID, "ticket": ticket,
	})
}

func (s *Server) handleCaptureImage(w http.ResponseWriter, r *http.Request) {
	runID := r.PathValue("id")
	callID := strings.TrimSpace(r.URL.Query().Get("callId"))
	userID := strings.TrimSpace(r.URL.Query().Get("userId"))
	if callID == "" || userID == "" {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "callId and userId required"})
		return
	}
	run, err := s.store.GetRun(runID)
	if err != nil || run.UserID != userID {
		writeJSON(w, 404, map[string]any{"ok": false, "error": "run_not_found"})
		return
	}
	var state agent.ResumeState
	if err := s.store.LoadRunResume(runID, &state); err != nil || state.Kind != agent.PauseCapture {
		writeJSON(w, 409, map[string]any{"ok": false, "error": "capture_not_expected"})
		return
	}
	waiting, ok := state.WaitingCall()
	if !ok || waiting.ID != callID {
		writeJSON(w, 409, map[string]any{"ok": false, "error": "capture_call_mismatch"})
		return
	}
	mimeType := strings.ToLower(strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0]))
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxCaptureUploadBytes))
	if err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "capture image too large or unreadable"})
		return
	}
	asset, err := s.captures.Put(userID, runID, callID, mimeType, data)
	if err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "captureAssetId": asset.ID, "mimeType": asset.MIMEType, "size": asset.Size})
}

func (s *Server) handleCapture(w http.ResponseWriter, r *http.Request) {
	var body struct {
		UserID         string          `json:"userId"`
		CallID         string          `json:"callId"`
		Result         json.RawMessage `json:"result"`
		CaptureAssetID string          `json:"captureAssetId"`
		Provider       provider.Config `json:"provider"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.CallID == "" {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "callId and result required"})
		return
	}
	runID := r.PathValue("id")
	var st agent.ResumeState
	if err := s.store.LoadRunResume(runID, &st); err != nil {
		writeJSON(w, 409, map[string]any{"ok": false, "error": "no_resume_state", "detail": err.Error()})
		return
	}
	run, err := s.store.GetRun(runID)
	if err != nil {
		writeJSON(w, 404, map[string]any{"ok": false, "error": "run_not_found"})
		return
	}
	userID := body.UserID
	if userID == "" {
		userID = run.UserID
	}
	if userID != run.UserID || st.Kind != agent.PauseCapture || st.Capture == nil || st.Capture.CallID != body.CallID {
		writeJSON(w, 409, map[string]any{"ok": false, "error": "capture_mismatch"})
		return
	}
	toolName := ""
	if st.Capture != nil {
		toolName = st.Capture.Name
	}
	if toolName == "" && st.WaitingIndex >= 0 && st.WaitingIndex < len(st.PendingCalls) {
		toolName = st.PendingCalls[st.WaitingIndex].Name
	}
	needsVisionAsset := strings.HasPrefix(toolName, "remote_desktop_") && !strings.Contains(toolName, "_cert_")
	if needsVisionAsset {
		if body.CaptureAssetID == "" || !s.captures.Owns(body.CaptureAssetID, userID, runID, body.CallID) {
			writeJSON(w, 409, map[string]any{"ok": false, "error": "capture_asset_mismatch"})
			return
		}
	} else if body.CaptureAssetID != "" && !s.captures.Owns(body.CaptureAssetID, userID, runID, body.CallID) {
		writeJSON(w, 409, map[string]any{"ok": false, "error": "capture_asset_mismatch"})
		return
	}
	sessionID := run.SessionID

	pcfg := st.Provider
	if body.Provider.APIKey != "" {
		pcfg.APIKey = body.Provider.APIKey
	}
	if body.Provider.BaseURL != "" {
		pcfg.BaseURL = body.Provider.BaseURL
	}
	p, err := provider.New(pcfg)
	if err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	pol := permission.Policy{Mode: permission.Mode(st.PermissionMode)}
	if pol.Mode == "" {
		pol.Mode = permission.ModeAsk
	}
	for _, d := range st.Deny {
		pol.Deny = append(pol.Deny, permission.Rule(d))
	}
	for _, a := range st.Allow {
		pol.Allow = append(pol.Allow, permission.Rule(a))
	}
	eng := permission.NewEngine(pol)
	reg, err := s.rebuildTools(r.Context(), userID, sessionID, runID, st.DatabaseGeneration, st.RunNonce, st.MCPServers, st.Context)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "code": "platform_tools_unavailable", "error": err.Error()})
		return
	}

	s.mu.Lock()
	hub := s.emitters[runID]
	s.mu.Unlock()
	if hub == nil {
		hub = newSSEHub()
	}

	cfg := agent.Config{
		RunID:               runID,
		SessionID:           sessionID,
		UserID:              userID,
		Provider:            p,
		Model:               st.Model,
		Tools:               reg,
		Permission:          eng,
		Store:               s.store,
		Emitter:             hub,
		SystemPrompt:        st.SystemPrompt,
		VolatilePrompt:      st.VolatilePrompt,
		Options:             st.Options,
		MaxSteps:            st.MaxSteps,
		ProviderConfig:      pcfg,
		PermissionPolicy:    pol,
		AutoConfirm:         st.AutoConfirm,
		AutoConfirmDelayMS:  st.AutoConfirmDelayMS,
		MCPServersJSON:      st.MCPServers,
		ContextJSON:         st.Context,
		DatabaseGeneration:  st.DatabaseGeneration,
		RunNonce:            st.RunNonce,
		ContextWindowTokens: st.ContextWindowTokens,
		OutputReserveTokens: st.OutputReserveTokens,
		Captures:            s.captures,
		Resume:              &st,
		Decision: &agent.ResumeDecision{
			Approve:        true,
			CallID:         body.CallID,
			CaptureResult:  body.Result,
			CaptureAssetID: body.CaptureAssetID,
		},
	}
	s.launchRun(runID, hub, cfg)
	writeJSON(w, 200, map[string]any{"ok": true, "resumed": true, "callId": body.CallID, "runId": runID})
}

func (s *Server) handleMCPConnect(w http.ResponseWriter, r *http.Request) {
	var cfg mcp.ServerConfig
	if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	c, err := s.mcp.Connect(r.Context(), cfg)
	if err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	tools, err := c.ListTools(r.Context())
	if err != nil {
		writeJSON(w, 500, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "name": cfg.Name, "tools": len(tools)})
}

func (s *Server) handleSSE(w http.ResponseWriter, r *http.Request) {
	runID := r.PathValue("id")
	ticket := r.URL.Query().Get("ticket")
	if !s.checkAdmin(r) {
		if !s.consumeOrValidateTicket(ticket, runID) {
			writeJSON(w, 401, map[string]any{"ok": false, "error": "invalid ticket"})
			return
		}
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "stream unsupported", 500)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	// Replay only events the client has not acknowledged. Replaying the whole
	// run after a capture/permission pause duplicates old tool calls and capture
	// requests in the browser.
	afterSeq := int64(0)
	if raw := strings.TrimSpace(r.Header.Get("Last-Event-ID")); raw != "" {
		_, _ = fmt.Sscanf(raw, "%d", &afterSeq)
	}
	if evs, err := s.store.ListEvents(runID, afterSeq); err == nil {
		for _, e := range evs {
			fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", e.Seq, e.Type, string(e.Payload))
		}
		flusher.Flush()
	}

	s.mu.Lock()
	hub := s.emitters[runID]
	s.mu.Unlock()
	if hub == nil {
		// run already finished — replay only
		return
	}
	ch := hub.Subscribe()
	defer hub.Unsubscribe(ch)

	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case <-heartbeat.C:
			fmt.Fprintf(w, "event: heartbeat\ndata: {\"ts\":%d}\n\n", time.Now().UnixMilli())
			flusher.Flush()
		case ev, ok := <-ch:
			if !ok {
				return
			}
			b, _ := json.Marshal(ev)
			fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", ev.Seq, ev.Type, string(b))
			flusher.Flush()
			if ev.Type == event.TypeRunCompleted || ev.Type == event.TypeRunFailed || ev.Type == event.TypeRunAborted {
				return
			}
		}
	}
}

func (s *Server) issueTicket(userID, runID, sessionID string) string {
	tok := fmt.Sprintf("tkt_%d_%s", time.Now().UnixNano(), runID[len(runID)-6:])
	s.mu.Lock()
	s.tickets[tok] = &runTicket{
		Token: tok, UserID: userID, RunID: runID, SessionID: sessionID,
		Expires: time.Now().Add(2 * time.Hour),
	}
	s.mu.Unlock()
	return tok
}

func (s *Server) consumeOrValidateTicket(tok, runID string) bool {
	if tok == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.tickets[tok]
	if !ok || t.RunID != runID {
		return false
	}
	if time.Now().After(t.Expires) {
		delete(s.tickets, tok)
		return false
	}
	// multi-reconnect allowed until expiry (SSE drops are common on mobile)
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// --- SSE hub ---

type sseHub struct {
	mu   sync.Mutex
	subs map[chan event.Event]struct{}
	done bool
}

func newSSEHub() *sseHub {
	return &sseHub{subs: make(map[chan event.Event]struct{})}
}

func (h *sseHub) Emit(ev event.Event) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.done {
		return nil
	}
	for ch := range h.subs {
		select {
		case ch <- ev:
		default:
			// drop slow subscriber frame; replay buffer covers via store
		}
	}
	return nil
}

func (h *sseHub) Subscribe() chan event.Event {
	ch := make(chan event.Event, 64)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	h.mu.Unlock()
	return ch
}

func (h *sseHub) Unsubscribe(ch chan event.Event) {
	h.mu.Lock()
	delete(h.subs, ch)
	h.mu.Unlock()
	close(ch)
}

func (h *sseHub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.done = true
	for ch := range h.subs {
		close(ch)
		delete(h.subs, ch)
	}
}
