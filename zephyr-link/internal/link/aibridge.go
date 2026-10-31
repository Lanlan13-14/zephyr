package link

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/codec"
)

type AIBridgeConfig struct{ URL, AdminToken string }

// RegisterAIBridge installs the actual AI account service, replacing the builtin status-only
// handler. Identity is from the proven session, never a frame body user/device field.
func (n *Node) RegisterAIBridge(cfg AIBridgeConfig) error {
	address, err := url.Parse(cfg.URL)
	if err != nil || address.Scheme != "http" || net.ParseIP(address.Hostname()) == nil || !net.ParseIP(address.Hostname()).IsLoopback() || address.User != nil || len(cfg.AdminToken) < 16 {
		return errors.New("link: AI bridge must be authenticated loopback")
	}
	client := &http.Client{Timeout: 2 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	n.dispatch.Register(codec.KindAI, func(ctx *FrameContext, frame *codec.Frame) (int, any, bool, error) {
		deviceID := n.sessionDeviceGet(ctx.SessionID)
		if deviceID == "" {
			return 0, nil, false, errors.New("link: AI requires an attested device")
		}
		var input any
		if err := codec.Decode(frame.Body, &input); err != nil {
			return 0, nil, false, err
		}
		input, err := normalizeCBORForJSON(input)
		if err != nil {
			return 0, nil, false, err
		}
		payload, err := json.Marshal(syncBridgeRequest{DeviceID: deviceID, Kind: codec.KindAI, Body: input})
		if err != nil {
			return 0, nil, false, err
		}
		request, err := http.NewRequest(http.MethodPost, cfg.URL, bytes.NewReader(payload))
		if err != nil {
			return 0, nil, false, err
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Link-Admin", cfg.AdminToken)
		response, err := client.Do(request)
		if err != nil {
			return 0, nil, false, errors.New("link: AI bridge unavailable; query original requestId")
		}
		defer response.Body.Close()
		raw, err := io.ReadAll(io.LimitReader(response.Body, (3<<20)+1))
		if err != nil || len(raw) > 3<<20 {
			return 0, nil, false, errors.New("link: AI response exceeds limit")
		}
		var envelope syncBridgeResponse
		if json.Unmarshal(raw, &envelope) != nil {
			return 0, nil, false, errors.New("link: malformed AI response")
		}
		if !envelope.OK {
			if envelope.Error == nil || envelope.Error.Code == "" {
				return 0, nil, false, errors.New("link: AI rejected request")
			}
			return codec.KindAI, map[string]any{"ok": false, "error": map[string]any{
				"code": envelope.Error.Code, "message": envelope.Error.Message, "retryable": envelope.Error.Retryable,
			}}, false, nil
		}
		if response.StatusCode != http.StatusOK || envelope.Kind != codec.KindAI {
			return 0, nil, false, errors.New("link: unexpected AI reply lane")
		}
		var output any
		decoder := json.NewDecoder(bytes.NewReader(envelope.Body))
		decoder.UseNumber()
		if err := decoder.Decode(&output); err != nil {
			return 0, nil, false, err
		}
		output, err = normalizeJSONIntegers(output)
		return codec.KindAI, output, false, err
	})
	return nil
}
