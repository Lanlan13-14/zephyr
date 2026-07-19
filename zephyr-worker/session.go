package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"time"

	"golang.org/x/crypto/ssh"
)

type netDialerImpl struct{}

func (d *netDialerImpl) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	n := &net.Dialer{Timeout: 15 * time.Second}
	return n.DialContext(ctx, network, addr)
}

// serveWS runs the WebSocket session loop: open SSH, attach subscriber,
// pump browser input -> SSH stdin and SSH output -> browser, handle resize.
// The SSH session stays alive after the browser disconnects; only the
// subscriber is removed (FREEZE plan §14 - persistent terminal).
func (h *WSHandler) serveWS(ctx context.Context, conn Conn, t *Ticket) {
	defer conn.Close()

	sessionID := t.ConnID
	if sessionID == "" {
		sessionID = "transient-" + t.Token[:8]
	}

	existing := h.sessions.Get(sessionID)
	if existing != nil && !existing.closed {
		// Resume an existing persistent session.
		h.attachToSession(conn, existing)
		return
	}

	if t.HostSpec.Protocol == "TELNET" {
		_ = conn.WriteJSON(Envelope{Type: "error", Code: "telnet_unsupported", Message: "Telnet transport not yet implemented"})
		return
	}

	client, err := dialSSH(ctx, t.HostSpec, t.Secrets)
	if err != nil {
		_ = conn.WriteJSON(Envelope{Type: "error", Code: "ssh_dial_failed", Message: err.Error()})
		return
	}

	stream, stdin, stdout, stderr, err := openShell(client, 120, 30)
	if err != nil {
		client.Close()
		_ = conn.WriteJSON(Envelope{Type: "error", Code: "shell_open_failed", Message: err.Error()})
		return
	}

	sess := NewSession(sessionID, t.UserID, t.ConnID, t.HostSpec.Host, t.HostSpec.Username)
	sess.client = client
	sess.stream = stream
	sess.stdin = stdin
	sess.stdout = stdout
	sess.stderr = stderr
	h.sessions.Put(sess)
	sess.readLoops()

	_ = conn.WriteJSON(Envelope{Type: "ready", SessionID: sess.ID, Cols: 120, Rows: 30})
	h.attachToSession(conn, sess)
}

func openShell(client *ssh.Client, cols, rows int) (*sshSession, io.WriteCloser, io.Reader, io.Reader, error) {
	s, err := client.NewSession()
	if err != nil {
		return nil, nil, nil, nil, err
	}
	modes := ssh.TerminalModes{ssh.ECHO: 1, ssh.TTY_OP_ISPEED: 14400, ssh.TTY_OP_OSPEED: 14400}
	if err := s.RequestPty("xterm-256color", rows, cols, modes); err != nil {
		s.Close()
		return nil, nil, nil, nil, fmt.Errorf("pty: %w", err)
	}
	stdin, err := s.StdinPipe()
	if err != nil {
		s.Close()
		return nil, nil, nil, nil, err
	}
	stdout, err := s.StdoutPipe()
	if err != nil {
		s.Close()
		return nil, nil, nil, nil, err
	}
	stderr, err := s.StderrPipe()
	if err != nil {
		s.Close()
		return nil, nil, nil, nil, err
	}
	if err := s.Shell(); err != nil {
		s.Close()
		return nil, nil, nil, nil, fmt.Errorf("shell: %w", err)
	}
	return &sshSession{s}, stdin, stdout, stderr, nil
}

// attachToSession pipes a single browser connection into an existing session.
// On browser close only the subscriber is removed; the SSH session persists.
func (h *WSHandler) attachToSession(conn Conn, s *Session) {
	sub := s.subscribe()
	defer s.unsubscribe(sub)

	// Replay buffered output so reconnects see recent context.
	if snap := s.outputBuf.Snapshot(); snap != "" {
		_ = conn.WriteJSON(Envelope{Type: "data", SessionID: s.ID, Data: snap, Extra: json.RawMessage(`{"replay":true}`)})
	}
	_ = conn.WriteJSON(Envelope{Type: "ready", SessionID: s.ID})

	// Reader: browser -> SSH stdin
	go func() {
		for {
			var msg Envelope
			if err := conn.ReadJSON(&msg); err != nil {
				return
			}
			switch msg.Type {
			case "input":
				if err := s.writeInput(msg.Data); err != nil {
					_ = conn.WriteJSON(Envelope{Type: "error", Code: "input_failed", Message: err.Error()})
					return
				}
			case "resize":
				cols, rows := msg.Cols, msg.Rows
				if cols < 1 {
					cols = 80
				}
				if rows < 1 {
					rows = 24
				}
				if err := s.resize(cols, rows); err != nil {
					_ = conn.WriteJSON(Envelope{Type: "error", Code: "resize_failed", Message: err.Error()})
				}
			case "close":
				return
			}
		}
	}()

	// Writer: session -> browser
	for env := range sub {
		if err := conn.WriteJSON(env); err != nil {
			return
		}
	}
}

// errors sentinel for tests
var errClosed = errors.New("connection_closed")
