// Package agent implements the multi-step tool-using run loop with mid-run
// permission/capture pause and resume (no fake user turns).
package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/sync/errgroup"
	"golang.org/x/sync/semaphore"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/archive"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/compact"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/event"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/permission"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/session"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/tool"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/tool/platform"
)

const (
	DefaultMaxSteps      = 32
	DefaultParallelTools = 6
	MaxParallelTools     = 16
)

// Emitter receives ordered run events.
type Emitter interface {
	Emit(ev event.Event) error
}

// PauseError signals the loop must stop and wait for external input.
// ResumeState is always populated for durable resume.
type PauseError struct {
	Kind  PauseKind
	Data  any
	State ResumeState
}

func (e *PauseError) Error() string { return "run_paused:" + string(e.Kind) }

// ResumeDecision is supplied when continuing a paused run.
type ResumeDecision struct {
	// Approve permission ask (PausePermission).
	Approve bool
	// CallID must match the waiting call.
	CallID string
	// CaptureResult contains metadata only; image bytes live in CaptureStore.
	CaptureResult  json.RawMessage
	CaptureAssetID string
	// OnceGrant: if true, only this callId is allowed (not a standing rule).
	OnceGrant bool
}

// Config for one run or resume.
type Config struct {
	RunID      string
	SessionID  string
	UserID     string
	Provider   provider.Provider
	Model      string
	Tools      *tool.Registry
	Permission *permission.Engine
	Store      *session.Store
	Emitter    Emitter
	// SystemPrompt is the fully composed standing system message.
	SystemPrompt string
	// ExtraMessages appended after loaded history (fresh user turn only).
	ExtraMessages []provider.Message
	Options       map[string]any
	MaxSteps      int
	Parallelism   int
	// CompactCfg optional; zero → dynamic budget from model window.
	CompactCfg          compact.Config
	ContextWindowTokens int
	OutputReserveTokens int
	// SkipCompact disables history compaction for this run.
	SkipCompact bool
	// Archive stores compacted fragments for history_search (optional).
	Archive *archive.Store
	// Captures stores short-lived client-rendered RDP/VNC frames outside SQLite.
	Captures *CaptureStore
	// Mode: standard | plan | goal
	Mode string

	// Resume continues a paused run without a new user message.
	Resume   *ResumeState
	Decision *ResumeDecision

	// ProviderConfig is stored into ResumeState (api key stripped by server).
	ProviderConfig provider.Config
	// Permission policy snapshot for resume state.
	PermissionPolicy   permission.Policy
	AutoConfirm        bool
	AutoConfirmDelayMS int
	MCPServersJSON     json.RawMessage
	ContextJSON        json.RawMessage
}

type Metrics struct {
	ProviderCalls int   `json:"providerCalls"`
	ProviderMs    int64 `json:"providerMs"`
	ToolMs        int64 `json:"toolMs"`
	ToolResults   int   `json:"toolResults"`
	Steps         int   `json:"steps"`
	InputTokens   int   `json:"inputTokens,omitempty"`
	OutputTokens  int   `json:"outputTokens,omitempty"`
}

// Runner executes agent loops.
type Runner struct {
	seq atomic.Int64
}

type callWork struct {
	call               provider.ToolCall
	t                  tool.Tool
	args               json.RawMessage
	result             any
	err                error
	ms                 int64
	skip               bool // already resolved (capture inject)
	permissionApproved bool // runtime gate approved; platform host must not ask again
	observation        *provider.Message
}

func NewRunner() *Runner { return &Runner{} }

func (r *Runner) nextSeq() int64 { return r.seq.Add(1) }

func (r *Runner) emit(cfg Config, t event.Type, data any) error {
	ev := event.New(cfg.RunID, r.nextSeq(), t, data)
	if cfg.Store != nil {
		_ = cfg.Store.AppendEvent(cfg.RunID, ev.Seq, string(t), ev)
	}
	if cfg.Emitter != nil {
		return cfg.Emitter.Emit(ev)
	}
	return nil
}

// Run executes until completion, pause, abort, or error.
func (r *Runner) Run(ctx context.Context, cfg Config) (Metrics, error) {
	r.seq.Store(0)
	metrics := Metrics{}
	if cfg.Resume != nil {
		metrics = cfg.Resume.Metrics
	}
	maxSteps := cfg.MaxSteps
	if maxSteps <= 0 {
		maxSteps = DefaultMaxSteps
	}
	parallel := cfg.Parallelism
	if parallel <= 0 {
		parallel = DefaultParallelTools
	}
	if parallel > MaxParallelTools {
		parallel = MaxParallelTools
	}
	compCfg := cfg.CompactCfg
	if compCfg.MaxChars <= 0 {
		budget := compact.ComputeBudget(compact.BudgetInput{
			Model:               cfg.Model,
			WindowTokens:        cfg.ContextWindowTokens,
			OutputReserveTokens: cfg.OutputReserveTokens,
			SystemPrompt:        cfg.SystemPrompt,
			Tools:               toProviderTools(cfg.Tools),
		})
		compCfg = compact.ConfigForBudget(budget)
	}

	isResume := cfg.Resume != nil && cfg.Decision != nil
	if !isResume {
		if err := r.emit(cfg, event.TypeRunStarted, event.RunStarted{
			SessionID: cfg.SessionID,
			Model:     cfg.Model,
		}); err != nil {
			return metrics, err
		}
	} else {
		if err := r.emit(cfg, event.TypeRunStarted, event.RunStarted{
			SessionID: cfg.SessionID,
			Model:     cfg.Model,
			Mode:      "resume",
		}); err != nil {
			return metrics, err
		}
	}
	if cfg.Store != nil {
		_ = cfg.Store.UpdateRunStatus(cfg.RunID, "running", "", metrics)
		_ = cfg.Store.ClearRunResume(cfg.RunID)
	}

	// Load history
	var messages []provider.Message
	if cfg.Store != nil {
		hist, err := cfg.Store.ProviderMessages(cfg.SessionID)
		if err != nil {
			return metrics, err
		}
		messages = hist
	}
	messages = prependSystem(messages, cfg.SystemPrompt)

	if !isResume {
		messages = append(messages, cfg.ExtraMessages...)
		if cfg.Store != nil {
			for _, m := range cfg.ExtraMessages {
				if m.Role == provider.RoleUser {
					if _, err := cfg.Store.AppendMessage(cfg.SessionID, cfg.RunID, m); err != nil {
						return metrics, err
					}
				}
			}
		}
	}

	toolSchemas := toProviderTools(cfg.Tools)

	// Resume path: finish the interrupted tool batch first, then continue model loop.
	if isResume {
		st := *cfg.Resume
		metrics = st.Metrics
		// Deny path
		if st.Kind == PausePermission && !cfg.Decision.Approve {
			_ = r.emit(cfg, event.TypeRunAborted, event.RunTerminal{Reason: "permission_denied"})
			if cfg.Store != nil {
				_ = cfg.Store.UpdateRunStatus(cfg.RunID, "aborted", "permission_denied", metrics)
			}
			return metrics, nil
		}
		works, err := r.buildWorksFromPending(cfg, st.PendingCalls)
		if err != nil {
			return metrics, err
		}
		// Re-apply already completed tools — do not re-execute.
		done := map[string]CompletedTool{}
		for _, c := range st.Completed {
			done[c.CallID] = c
		}
		for i := range works {
			if c, ok := done[works[i].call.ID]; ok {
				if c.Error != "" {
					works[i].err = fmt.Errorf("%s", c.Error)
				} else if len(c.Result) > 0 {
					var data any
					_ = json.Unmarshal(c.Result, &data)
					works[i].result = data
				}
				works[i].ms = c.MS
				works[i].skip = true
			}
		}
		// Apply decision to waiting index
		wi := st.WaitingIndex
		if wi < 0 || wi >= len(works) {
			// try match by call id
			wi = -1
			for i, w := range works {
				if w.call.ID == cfg.Decision.CallID {
					wi = i
					break
				}
			}
		}
		if wi < 0 || wi >= len(works) {
			return metrics, fmt.Errorf("invalid waiting index")
		}
		if st.Kind == PauseCapture {
			if len(cfg.Decision.CaptureResult) == 0 {
				return metrics, fmt.Errorf("capture result required")
			}
			var data any
			_ = json.Unmarshal(cfg.Decision.CaptureResult, &data)
			data = stripCaptureImageData(data)
			works[wi].result = data
			works[wi].skip = true
			works[wi].err = nil
			if strings.HasPrefix(works[wi].call.Name, "remote_desktop_") && cfg.Decision.CaptureAssetID == "" {
				return metrics, fmt.Errorf("vision capture asset required")
			}
			if cfg.Decision.CaptureAssetID != "" {
				if cfg.Captures == nil {
					return metrics, fmt.Errorf("capture store unavailable")
				}
				asset, imageBytes, err := cfg.Captures.Take(cfg.Decision.CaptureAssetID, cfg.UserID, cfg.RunID, works[wi].call.ID)
				if err != nil {
					return metrics, err
				}
				dataURL := "data:" + asset.MIMEType + ";base64," + base64.StdEncoding.EncodeToString(imageBytes)
				meta := remoteDesktopObservationText(works[wi].call, cfg.Decision.CaptureResult)
				works[wi].observation = &provider.Message{
					Role:    provider.RoleUser,
					Content: meta,
					Parts:   []provider.ContentPart{{Type: "text", Text: meta}, {Type: "image_url", ImageURL: dataURL}},
				}
			}
		}
		// Permission approve: clear skip so waiting tool executes (if not already completed)
		if st.Kind == PausePermission && cfg.Decision.Approve {
			works[wi].skip = false
			works[wi].err = nil
			works[wi].result = nil
			works[wi].permissionApproved = true
		}
		if err := r.executeWorks(ctx, cfg, works, parallel, &metrics); err != nil {
			if pe, ok := err.(*PauseError); ok {
				pe.State.PendingCalls = st.PendingCalls
				pe.State.Completed = snapshotCompleted(works)
				pe.State.StepsDone = st.StepsDone
				if pe.State.WaitingIndex < 0 {
					pe.State.WaitingIndex = indexOfCall(works, pe)
				}
				return r.persistPause(cfg, metrics, pe)
			}
			return metrics, err
		}
		// Append tool messages for this batch
		for _, w := range works {
			tm := toolResultMessage(w)
			messages = append(messages, tm)
			if cfg.Store != nil {
				if _, err := cfg.Store.AppendMessage(cfg.SessionID, cfg.RunID, tm); err != nil {
					return metrics, err
				}
			}
			if w.observation != nil {
				messages = withoutVisualParts(messages)
				messages = append(messages, *w.observation)
			}
		}
		// continue into model loop from stepsDone
		metrics.Steps = st.StepsDone
	}

	startStep := metrics.Steps
	for step := startStep; step < maxSteps; step++ {
		if err := ctx.Err(); err != nil {
			_ = r.emit(cfg, event.TypeRunAborted, event.RunTerminal{Reason: "context_canceled"})
			if cfg.Store != nil {
				_ = cfg.Store.UpdateRunStatus(cfg.RunID, "aborted", "context_canceled", metrics)
			}
			return metrics, err
		}
		metrics.Steps = step + 1

		// Compaction on text/history only. Ephemeral RDP/VNC image observations
		// stay outside SQLite and are appended after compaction for this step.
		visualObservations := make([]provider.Message, 0, 1)
		textMessages := make([]provider.Message, 0, len(messages))
		for _, msg := range messages {
			if len(msg.Parts) > 0 { visualObservations = append(visualObservations, msg); continue }
			textMessages = append(textMessages, msg)
		}
		modelMessages := append([]provider.Message(nil), textMessages...)
		if !cfg.SkipCompact {
			cr := compact.Apply(textMessages, compCfg)
			modelMessages = cr.Messages
			if cr.Snipped > 0 || cr.Pruned > 0 || cr.Compacted {
				_ = r.emit(cfg, event.TypeStepCompacted, event.Compacted{
					OriginalCount:  cr.OriginalChars,
					CompactedCount: cr.FinalChars,
					TotalChars:     cr.FinalChars,
				})
				if cfg.Archive != nil {
					if len(cr.SnipOriginals) > 0 {
						_, _ = cfg.Archive.PutMessages(cfg.UserID, cfg.SessionID, cfg.RunID, "tool_snip", cr.SnipOriginals)
					}
					if len(cr.Archived) > 0 {
						_, _ = cfg.Archive.PutMessages(cfg.UserID, cfg.SessionID, cfg.RunID, "fold", cr.Archived)
					}
				}
			}
		}
		modelMessages = append(modelMessages, visualObservations...)

		req := provider.Request{
			Model:    cfg.Model,
			Messages: modelMessages,
			Tools:    toolSchemas,
			Options:  cfg.Options,
			Stream:   true,
		}

		started := time.Now()
		ch, err := cfg.Provider.Stream(ctx, req)
		if err != nil {
			_ = r.emit(cfg, event.TypeRunFailed, event.RunTerminal{Error: err.Error(), Code: "provider_stream"})
			if cfg.Store != nil {
				_ = cfg.Store.UpdateRunStatus(cfg.RunID, "failed", err.Error(), metrics)
			}
			return metrics, err
		}

		var (
			text      strings.Builder
			toolCalls []provider.ToolCall
			respID    string
		)
		for chunk := range ch {
			if chunk.Err != nil || chunk.ErrorMsg != "" {
				msg := chunk.ErrorMsg
				if msg == "" && chunk.Err != nil {
					msg = chunk.Err.Error()
				}
				metrics.ProviderMs += time.Since(started).Milliseconds()
				metrics.ProviderCalls++
				_ = r.emit(cfg, event.TypeRunFailed, event.RunTerminal{Error: msg, Code: "provider_error"})
				if cfg.Store != nil {
					_ = cfg.Store.UpdateRunStatus(cfg.RunID, "failed", msg, metrics)
				}
				return metrics, fmt.Errorf("%s", msg)
			}
			switch chunk.Type {
			case "text":
				if chunk.Text != "" {
					text.WriteString(chunk.Text)
					_ = r.emit(cfg, event.TypeTextDelta, event.TextDelta{Text: chunk.Text})
				}
			case "reasoning":
				if chunk.Text != "" {
					_ = r.emit(cfg, event.TypeReasoningDelta, event.ReasoningDelta{Text: chunk.Text})
				}
			case "tool_calls":
				toolCalls = append(toolCalls, chunk.ToolCalls...)
			case "usage":
				if chunk.Usage != nil {
					metrics.InputTokens += chunk.Usage.InputTokens
					metrics.OutputTokens += chunk.Usage.OutputTokens
				}
			}
			if chunk.ResponseID != "" {
				respID = chunk.ResponseID
			}
		}
		metrics.ProviderMs += time.Since(started).Milliseconds()
		metrics.ProviderCalls++

		assistant := provider.Message{
			Role:       provider.RoleAssistant,
			Content:    text.String(),
			ToolCalls:  toolCalls,
			ResponseID: respID,
		}
		messages = append(messages, assistant)
		if cfg.Store != nil {
			if _, err := cfg.Store.AppendMessage(cfg.SessionID, cfg.RunID, assistant); err != nil {
				return metrics, err
			}
		}

		if len(toolCalls) == 0 {
			_ = r.emit(cfg, event.TypeMessageCompleted, event.MessageCompleted{
				Role: "assistant", Content: assistant.Content,
			})
			_ = r.emit(cfg, event.TypeRunCompleted, event.RunTerminal{Metrics: metrics})
			if cfg.Store != nil {
				_ = cfg.Store.UpdateRunStatus(cfg.RunID, "completed", "", metrics)
			}
			return metrics, nil
		}

		works, err := r.buildWorksFromPending(cfg, toolCalls)
		if err != nil {
			return metrics, err
		}
		// Permission gate before execute
		for i := range works {
			w := &works[i]
			if w.err != nil || w.t == nil {
				continue
			}
			dec := permission.Allow
			if cfg.Permission != nil {
				dec = cfg.Permission.Decide(permission.Request{
					Tool: w.call.Name, Args: w.args, ReadOnly: w.t.ReadOnly(), Risk: string(w.t.Risk()),
				})
			}
			_ = r.emit(cfg, event.TypeToolPending, event.ToolPending{
				CallID: w.call.ID, Name: w.call.Name, Args: json.RawMessage(w.args),
			})
			if dec == permission.Deny {
				w.err = fmt.Errorf("permission denied for tool %s", w.call.Name)
				continue
			}
			autoApproved := false
			if dec == permission.Ask && cfg.AutoConfirm && !permission.HasExplicitAsk(cfg.PermissionPolicy, permission.Request{
				Tool: w.call.Name, Args: w.args, ReadOnly: w.t.ReadOnly(), Risk: string(w.t.Risk()),
			}) {
				if delay := time.Duration(cfg.AutoConfirmDelayMS) * time.Millisecond; delay > 0 {
					timer := time.NewTimer(delay)
					select {
					case <-ctx.Done():
						if !timer.Stop() {
							<-timer.C
						}
						return metrics, ctx.Err()
					case <-timer.C:
					}
				}
				dec = permission.Allow
				autoApproved = true
			}
			if dec == permission.Ask {
				ask := event.PermissionAsk{
					AskID: w.call.ID, CallID: w.call.ID, Name: w.call.Name,
					Args: json.RawMessage(w.args), Risk: string(w.t.Risk()),
					Summary: fmt.Sprintf("允许执行 %s ?", w.call.Name),
				}
				_ = r.emit(cfg, event.TypePermissionAsk, ask)
				pe := &PauseError{
					Kind:  PausePermission,
					Data:  ask,
					State: r.makeResumeState(cfg, metrics, PausePermission, toolCalls, i, &ask, nil),
				}
				return r.persistPause(cfg, metrics, pe)
			}
			// The runtime permission engine is authoritative. Carry the approval to
			// the Node platform host so its canonical/legacy gate does not ask a
			// second time. Auto-confirm and YOLO both land here; explicit Ask never
			// does because it returned above. Read-only calls need no confirmation.
			w.permissionApproved = !w.t.ReadOnly() && (autoApproved || dec == permission.Allow)
		}

		if err := r.executeWorks(ctx, cfg, works, parallel, &metrics); err != nil {
			if pe, ok := err.(*PauseError); ok {
				pe.State.PendingCalls = toolCalls
				pe.State.Completed = snapshotCompleted(works)
				pe.State.StepsDone = metrics.Steps
				pe.State.Metrics = metrics
				pe.State.WaitingIndex = indexOfCall(works, pe)
				return r.persistPause(cfg, metrics, pe)
			}
			return metrics, err
		}

		for _, w := range works {
			tm := toolResultMessage(w)
			messages = append(messages, tm)
			if cfg.Store != nil {
				if _, err := cfg.Store.AppendMessage(cfg.SessionID, cfg.RunID, tm); err != nil {
					return metrics, err
				}
			}
			if w.observation != nil {
				messages = withoutVisualParts(messages)
				messages = append(messages, *w.observation)
			}
		}
	}

	msg := "已达到工具调用轮次上限，请根据上方工具结果继续。"
	_ = r.emit(cfg, event.TypeMessageCompleted, event.MessageCompleted{Role: "assistant", Content: msg})
	_ = r.emit(cfg, event.TypeRunCompleted, event.RunTerminal{Reason: "max_steps", Metrics: metrics})
	if cfg.Store != nil {
		_ = cfg.Store.UpdateRunStatus(cfg.RunID, "completed", "max_steps", metrics)
	}
	return metrics, nil
}

func (r *Runner) persistPause(cfg Config, metrics Metrics, pe *PauseError) (Metrics, error) {
	pe.State.Metrics = metrics
	status := "waiting_permission"
	if pe.Kind == PauseCapture {
		status = "waiting_capture"
	}
	if cfg.Store != nil {
		_ = cfg.Store.UpdateRunStatus(cfg.RunID, status, "", metrics)
		_ = cfg.Store.SaveRunResume(cfg.RunID, pe.State)
	}
	return metrics, pe
}

func (r *Runner) makeResumeState(cfg Config, metrics Metrics, kind PauseKind, calls []provider.ToolCall, waitIdx int, ask *event.PermissionAsk, cap *event.ClientCapture) ResumeState {
	pc := cfg.ProviderConfig
	pc.APIKey = "" // never persist secrets
	pol := cfg.PermissionPolicy
	st := ResumeState{
		Kind:                kind,
		PendingCalls:        calls,
		WaitingIndex:        waitIdx,
		Ask:                 ask,
		Capture:             cap,
		Model:               cfg.Model,
		SystemPrompt:        cfg.SystemPrompt,
		Options:             cfg.Options,
		MaxSteps:            cfg.MaxSteps,
		StepsDone:           metrics.Steps,
		Provider:            pc,
		PermissionMode:      string(pol.Mode),
		AutoConfirm:         cfg.AutoConfirm,
		AutoConfirmDelayMS:  cfg.AutoConfirmDelayMS,
		MCPServers:          cfg.MCPServersJSON,
		Context:             cfg.ContextJSON,
		ContextWindowTokens: cfg.ContextWindowTokens,
		OutputReserveTokens: cfg.OutputReserveTokens,
		Metrics:             metrics,
	}
	for _, d := range pol.Deny {
		st.Deny = append(st.Deny, string(d))
	}
	for _, a := range pol.Allow {
		st.Allow = append(st.Allow, string(a))
	}
	for _, a := range pol.Ask {
		st.AskRules = append(st.AskRules, string(a))
	}
	return st
}

func (r *Runner) buildWorksFromPending(cfg Config, calls []provider.ToolCall) ([]callWork, error) {
	works := make([]callWork, 0, len(calls))
	for _, tc := range calls {
		args := normalizeArgs(tc.Arguments)
		t, ok := cfg.Tools.Get(tc.Name)
		if !ok {
			works = append(works, callWork{
				call: tc, args: args,
				err: fmt.Errorf("unknown tool %q", tc.Name),
			})
			continue
		}
		works = append(works, callWork{call: tc, t: t, args: args})
	}
	return works, nil
}

func (r *Runner) executeWorks(ctx context.Context, cfg Config, works []callWork, parallel int, metrics *Metrics) error {
	// Emit errors for pre-failed
	for i := range works {
		w := &works[i]
		if w.err != nil {
			_ = r.emit(cfg, event.TypeToolError, event.ToolResult{
				CallID: w.call.ID, Name: w.call.Name,
				Result: map[string]any{"ok": false, "error": w.err.Error()},
				Status: "error",
			})
			metrics.ToolResults++
		} else if w.skip && w.result != nil {
			_ = r.emit(cfg, event.TypeToolResult, event.ToolResult{
				CallID: w.call.ID, Name: w.call.Name,
				Result: w.result, Status: "success",
			})
			metrics.ToolResults++
		}
	}

	var parallelIdx, serialIdx []int
	for i, w := range works {
		if w.err != nil || w.skip {
			continue
		}
		if w.t != nil && w.t.ParallelSafe() {
			parallelIdx = append(parallelIdx, i)
		} else {
			serialIdx = append(serialIdx, i)
		}
	}

	if len(parallelIdx) > 0 {
		sem := semaphore.NewWeighted(int64(parallel))
		var mu sync.Mutex
		g, gctx := errgroup.WithContext(ctx)
		for _, idx := range parallelIdx {
			idx := idx
			g.Go(func() error {
				if err := sem.Acquire(gctx, 1); err != nil {
					return err
				}
				defer sem.Release(1)
				return r.runOneTool(gctx, cfg, &works[idx], metrics, &mu)
			})
		}
		if err := g.Wait(); err != nil {
			return err
		}
	}

	for _, idx := range serialIdx {
		if err := r.runOneTool(ctx, cfg, &works[idx], metrics, nil); err != nil {
			return err
		}
	}
	return nil
}

func (r *Runner) runOneTool(ctx context.Context, cfg Config, w *callWork, metrics *Metrics, mu *sync.Mutex) error {
	if w.err != nil || w.skip {
		return nil
	}
	_ = r.emit(cfg, event.TypeToolStart, event.ToolStart{
		CallID: w.call.ID, Name: w.call.Name, Args: json.RawMessage(w.args),
	})
	execCtx := ctx
	if w.permissionApproved {
		execCtx = platform.WithConfirmedCall(ctx, w.call.Name)
	}
	st := time.Now()
	res, err := w.t.Execute(execCtx, w.args)
	ms := time.Since(st).Milliseconds()
	if mu != nil {
		mu.Lock()
		w.result, w.err, w.ms = res, err, ms
		metrics.ToolMs += ms
		metrics.ToolResults++
		mu.Unlock()
	} else {
		w.result, w.err, w.ms = res, err, ms
		metrics.ToolMs += ms
		metrics.ToolResults++
	}
	if err != nil {
		_ = r.emit(cfg, event.TypeToolError, event.ToolResult{
			CallID: w.call.ID, Name: w.call.Name,
			Result:     map[string]any{"ok": false, "error": err.Error()},
			DurationMs: ms, Status: "error",
		})
		return nil
	}
	if capture, ok := detectClientCapture(res); ok {
		capture.CallID = w.call.ID
		capture.Name = w.call.Name
		_ = r.emit(cfg, event.TypeClientCapture, capture)
		// Find index later via call id
		pe := &PauseError{
			Kind:  PauseCapture,
			Data:  capture,
			State: r.makeResumeState(cfg, *metrics, PauseCapture, nil, 0, nil, &capture),
		}
		// waiting index filled by caller if pending set; set by call id match
		pe.State.WaitingIndex = -1
		pe.State.PendingCalls = nil
		// stash call id in capture
		return pe
	}
	if conf, ok := detectConfirmation(res); ok {
		// Tool returned confirmationRequired (legacy host path)
		conf.CallID = w.call.ID
		if conf.Name == "" {
			conf.Name = w.call.Name
		}
		_ = r.emit(cfg, event.TypePermissionAsk, conf)
		return &PauseError{
			Kind:  PausePermission,
			Data:  conf,
			State: r.makeResumeState(cfg, *metrics, PausePermission, nil, 0, &conf, nil),
		}
	}
	_ = r.emit(cfg, event.TypeToolResult, event.ToolResult{
		CallID: w.call.ID, Name: w.call.Name,
		Result: res, DurationMs: ms, Status: "success",
	})
	return nil
}

func snapshotCompleted(works []callWork) []CompletedTool {
	var out []CompletedTool
	for _, w := range works {
		if w.err == nil && w.result == nil && !w.skip {
			continue // not finished
		}
		// skip the one still waiting (result nil, err nil, not skip) — already continue
		ct := CompletedTool{CallID: w.call.ID, Name: w.call.Name, MS: w.ms}
		if w.err != nil {
			ct.Error = w.err.Error()
		} else if w.result != nil {
			b, _ := json.Marshal(w.result)
			ct.Result = b
		} else {
			continue
		}
		out = append(out, ct)
	}
	return out
}

func indexOfCall(works []callWork, pe *PauseError) int {
	waitID := ""
	if pe.Kind == PauseCapture && pe.State.Capture != nil {
		waitID = pe.State.Capture.CallID
	}
	if pe.Kind == PausePermission && pe.State.Ask != nil {
		waitID = pe.State.Ask.CallID
		if waitID == "" {
			waitID = pe.State.Ask.AskID
		}
	}
	if waitID == "" {
		return 0
	}
	for i, w := range works {
		if w.call.ID == waitID {
			return i
		}
	}
	return 0
}

func prependSystem(msgs []provider.Message, system string) []provider.Message {
	out := make([]provider.Message, 0, len(msgs)+1)
	out = append(out, provider.Message{Role: provider.RoleSystem, Content: system})
	for _, m := range msgs {
		if m.Role == provider.RoleSystem {
			continue
		}
		out = append(out, m)
	}
	return out
}

func toProviderTools(reg *tool.Registry) []provider.ToolSchema {
	if reg == nil {
		return nil
	}
	list := reg.ProviderSchemas()
	out := make([]provider.ToolSchema, 0, len(list))
	for _, t := range list {
		out = append(out, provider.ToolSchema{
			Name: t.Name, Description: t.Description, Parameters: t.Parameters,
		})
	}
	return out
}

func normalizeArgs(raw json.RawMessage) json.RawMessage {
	raw = json.RawMessage(strings.TrimSpace(string(raw)))
	if len(raw) == 0 {
		return json.RawMessage(`{}`)
	}
	if raw[0] == '"' {
		var s string
		if err := json.Unmarshal(raw, &s); err == nil {
			s = strings.TrimSpace(s)
			if s == "" {
				return json.RawMessage(`{}`)
			}
			if json.Valid([]byte(s)) {
				return json.RawMessage(s)
			}
			b, _ := json.Marshal(map[string]string{"value": s})
			return b
		}
	}
	if !json.Valid(raw) {
		b, _ := json.Marshal(map[string]string{"raw": string(raw)})
		return b
	}
	return raw
}

func withoutVisualParts(messages []provider.Message) []provider.Message {
	out := make([]provider.Message, 0, len(messages))
	for _, msg := range messages {
		if len(msg.Parts) == 0 { out = append(out, msg) }
	}
	return out
}

func stripCaptureImageData(value any) any {
	switch item := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(item))
		for key, child := range item {
			if key == "dataUrl" || key == "imageData" || key == "base64" { continue }
			out[key] = stripCaptureImageData(child)
		}
		return out
	case []any:
		out := make([]any, len(item))
		for i, child := range item { out[i] = stripCaptureImageData(child) }
		return out
	default:
		return value
	}
}

func remoteDesktopObservationText(call provider.ToolCall, raw json.RawMessage) string {
	var meta map[string]any
	_ = json.Unmarshal(raw, &meta)
	captureID, _ := meta["captureId"].(string)
	tabID, _ := meta["tabId"].(string)
	protocol, _ := meta["protocol"].(string)
	return fmt.Sprintf("客户端渲染的 %s 远程桌面视觉观察。toolCallId=%s tabId=%s captureId=%s。请直接观察随附图片；不要调用 browser_* 代替远程桌面。", strings.ToUpper(protocol), call.ID, tabID, captureID)
}

func toolResultMessage(w callWork) provider.Message {
	var content string
	if w.err != nil {
		b, _ := json.Marshal(map[string]any{"ok": false, "error": w.err.Error()})
		content = string(b)
	} else {
		b, err := json.Marshal(w.result)
		if err != nil {
			content = fmt.Sprintf("%v", w.result)
		} else {
			content = string(b)
		}
	}
	if len(content) > 120000 {
		content = content[:120000] + "…(truncated)"
	}
	return provider.Message{
		Role:       provider.RoleTool,
		Content:    content,
		ToolCallID: w.call.ID,
		Name:       w.call.Name,
	}
}

func detectClientCapture(res any) (event.ClientCapture, bool) {
	m := asMap(res)
	if m == nil {
		return event.ClientCapture{}, false
	}
	// Canonical tool results are wrapped as {ok,data,meta}; inspect the data
	// payload without discarding the outer result used by non-capture tools.
	payload := m
	if data, ok := m["data"].(map[string]any); ok {
		payload = data
	}
	if v, ok := payload["clientCaptureRequired"].(bool); !ok || !v {
		return event.ClientCapture{}, false
	}
	cap := event.ClientCapture{Name: str(payload["tool"])}
	if c, ok := payload["clientCapture"].(map[string]any); ok {
		cap.CallID = str(c["toolCallId"])
		cap.TabID = str(c["tabId"])
		if n, ok := c["maxWidth"].(float64); ok {
			cap.MaxWidth = int(n)
		}
		cap.Args = c
	} else {
		cap.TabID = str(payload["tabId"])
		if n, ok := payload["maxWidth"].(float64); ok {
			cap.MaxWidth = int(n)
		}
		cap.Args = payload
	}
	return cap, true
}

func detectConfirmation(res any) (event.PermissionAsk, bool) {
	m := asMap(res)
	if m == nil {
		return event.PermissionAsk{}, false
	}
	if v, ok := m["confirmationRequired"].(bool); !ok || !v {
		return event.PermissionAsk{}, false
	}
	ask := event.PermissionAsk{Summary: "需要确认"}
	if c, ok := m["confirmation"].(map[string]any); ok {
		ask.AskID = str(c["id"])
		ask.Name = str(c["tool"])
		ask.Summary = str(c["summary"])
		ask.Args = c["args"]
	}
	return ask, true
}

func asMap(res any) map[string]any {
	if m, ok := res.(map[string]any); ok {
		return m
	}
	b, err := json.Marshal(res)
	if err != nil {
		return nil
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return nil
	}
	return m
}

func str(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprint(v)
}
