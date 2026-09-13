package link

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/codec"
)

type FileBridgeConfig struct {
	URL        string
	AdminToken string
}

type fileBridgeResponse struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code      string `json:"code"`
		Message   string `json:"message"`
		Retryable bool   `json:"retryable"`
	} `json:"error"`
}

func (n *Node) RegisterFileBridge(cfg FileBridgeConfig) {
	client := &http.Client{Timeout: 65 * time.Second}
	n.dispatch.Register(codec.KindFileBridge, func(ctx *FrameContext, fr *codec.Frame) (int, any, bool, error) {
		deviceID := n.sessionDeviceGet(ctx.SessionID)
		if deviceID == "" {
			return 0, nil, false, fmt.Errorf("link: file session has no attested device")
		}
		var body map[string]any
		if err := codec.Decode(fr.Body, &body); err != nil {
			return 0, nil, false, fmt.Errorf("link: file frame body invalid: %w", err)
		}
		op, ok := body["op"].(string)
		if !ok || op == "" {
			return 0, nil, false, fmt.Errorf("link: file operation missing")
		}
		params := body["params"]
		payload, err := json.Marshal(map[string]any{"deviceId": deviceID, "op": op, "params": params})
		if err != nil {
			return 0, nil, false, err
		}
		req, err := http.NewRequest(http.MethodPost, cfg.URL, bytes.NewReader(payload))
		if err != nil {
			return 0, nil, false, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Link-Admin", cfg.AdminToken)
		resp, err := client.Do(req)
		if err != nil {
			return 0, nil, false, fmt.Errorf("link: file bridge unreachable: %w", err)
		}
		defer resp.Body.Close()
		raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		if err != nil {
			return 0, nil, false, err
		}
		var br fileBridgeResponse
		if err := json.Unmarshal(raw, &br); err != nil {
			return 0, nil, false, fmt.Errorf("link: file bridge reply invalid")
		}
		if !br.OK {
			if br.Error != nil {
				return codec.KindFileBridge, map[string]any{"ok": false, "error": map[string]any{"code": br.Error.Code, "message": br.Error.Message, "retryable": br.Error.Retryable}}, false, nil
			}
			return 0, nil, false, fmt.Errorf("link: file bridge rejected request")
		}
		var result any
		if len(br.Result) > 0 {
			dec := json.NewDecoder(bytes.NewReader(br.Result))
			dec.UseNumber()
			if err := dec.Decode(&result); err != nil {
				return 0, nil, false, err
			}
		}
		if obj, ok := result.(map[string]any); ok && obj["encoding"] == "base64" {
			if encoded, ok := obj["data"].(string); ok {
				data, err := base64.StdEncoding.DecodeString(encoded)
				if err != nil {
					return 0, nil, false, err
				}
				obj["data"] = data
			}
		}
		return codec.KindFileBridge, result, false, nil
	})
}
