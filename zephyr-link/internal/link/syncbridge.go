package link

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/codec"
)

// SyncBridgeConfig points the owned-sync lane at the single Node sync business
// core. The Go node owns ZSL/2 and framing only; it never touches account data,
// so a business frame is forwarded to the Node loopback bridge and the sealed
// reply is the business core's exact result. Browser, mobile and desktop clients
// thereby share one sync implementation.
type SyncBridgeConfig struct {
	// URL is the loopback-only Node bridge endpoint, e.g.
	// http://127.0.0.1:PORT/internal/link/sync.
	URL string
	// AdminToken is the loopback shared secret, sent as X-Link-Admin.
	AdminToken string
}

type syncBridgeRequest struct {
	DeviceID string `json:"deviceId"`
	Kind     int    `json:"kind"`
	Body     any    `json:"body"`
}

type syncBridgeResponse struct {
	OK    bool            `json:"ok"`
	Kind  int             `json:"kind"`
	Body  json.RawMessage `json:"body"`
	Error *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// registerSyncBridge installs the owned-sync lane handler. A SYNC_OP frame is
// forwarded to the Node bridge with the session's attested device id; the bridge
// resolves the device, runs the single sync core, and returns the result, which
// is sealed back as a SYNC_ACK. Any bridge failure surfaces as a dispatch error,
// never a silent ack.
func (n *Node) registerSyncBridge(cfg SyncBridgeConfig) {
	client := &http.Client{Timeout: 30 * time.Second}
	n.dispatch.Register(codec.KindSyncOp, func(ctx *FrameContext, fr *codec.Frame) (int, any, bool, error) {
		deviceID := n.sessionDeviceGet(ctx.SessionID)
		if deviceID == "" {
			return 0, nil, false, fmt.Errorf("link: session %s has no attested device", ctx.SessionID)
		}
		payload, _ := json.Marshal(syncBridgeRequest{DeviceID: deviceID, Kind: fr.Kind, Body: fr.Body})
		req, err := http.NewRequest(http.MethodPost, cfg.URL, bytes.NewReader(payload))
		if err != nil {
			return 0, nil, false, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Link-Admin", cfg.AdminToken)
		resp, err := client.Do(req)
		if err != nil {
			return 0, nil, false, fmt.Errorf("link: sync bridge unreachable: %w", err)
		}
		defer resp.Body.Close()
		raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
		if err != nil {
			return 0, nil, false, err
		}
		var br syncBridgeResponse
		if err := json.Unmarshal(raw, &br); err != nil {
			return 0, nil, false, fmt.Errorf("link: sync bridge returned an unparsable reply")
		}
		if !br.OK {
			if br.Error != nil {
				return 0, nil, false, fmt.Errorf("link: sync rejected (%s): %s", br.Error.Code, br.Error.Message)
			}
			return 0, nil, false, fmt.Errorf("link: sync rejected (status %d)", resp.StatusCode)
		}
		var body any
		if len(br.Body) > 0 {
			if err := json.Unmarshal(br.Body, &body); err != nil {
				return 0, nil, false, fmt.Errorf("link: sync bridge body unparsable")
			}
		}
		replyKind := br.Kind
		if replyKind == 0 {
			replyKind = codec.KindSyncAck
		}
		return replyKind, body, false, nil
	})
}
