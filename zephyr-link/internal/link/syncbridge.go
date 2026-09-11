package link

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
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
		Code      string          `json:"code"`
		Message   string          `json:"message"`
		Retryable bool            `json:"retryable"`
		Details   json.RawMessage `json:"details"`
	} `json:"error"`
}

// SyncBusinessError is safe structured business rejection returned by the
// canonical Node sync core. Transport code seals this object back to the
// device; it must never collapse cursor/revocation semantics into a generic
// Link outage or expose an untyped internal error string.
type SyncBusinessError struct {
	Code      string
	Message   string
	Retryable bool
	Details   json.RawMessage
}

func (e *SyncBusinessError) Error() string { return "link: sync rejected (" + e.Code + ")" }

// registerSyncBridge installs the owned-sync lane handler. A SYNC_OP frame is
// forwarded to the Node bridge with the session's attested device id; the bridge
// resolves the device, runs the single sync core, and returns the result, which
// is sealed back as a SYNC_ACK. Any bridge failure surfaces as a dispatch error,
// never a silent ack.
func normalizeCBORForJSON(value any) (any, error) {
	switch typed := value.(type) {
	case map[string]any:
		for key, item := range typed {
			normalized, err := normalizeCBORForJSON(item)
			if err != nil {
				return nil, err
			}
			typed[key] = normalized
		}
		return typed, nil
	case map[any]any:
		out := make(map[string]any, len(typed))
		for rawKey, item := range typed {
			key, ok := rawKey.(string)
			if !ok {
				return nil, fmt.Errorf("link: sync frame contains a non-string object key")
			}
			normalized, err := normalizeCBORForJSON(item)
			if err != nil {
				return nil, err
			}
			out[key] = normalized
		}
		return out, nil
	case []any:
		for i, item := range typed {
			normalized, err := normalizeCBORForJSON(item)
			if err != nil {
				return nil, err
			}
			typed[i] = normalized
		}
		return typed, nil
	default:
		return value, nil
	}
}

func normalizeJSONIntegers(value any) (any, error) {
	switch typed := value.(type) {
	case json.Number:
		/* Cursor, revision and timestamps must stay integers on the CBOR
		 * wire. Connection payloads also carry real floats
		 * (rdpTouchSensitivity defaults to 1.5). Treating every JSON number
		 * as Int64 aborted the whole owned-sync page as soon as the account
		 * had a host: empty accounts and notes/snippets have no floats, so
		 * they looked fine. Keep exact integers as int64; keep finite
		 * floats as float64. */
		if integer, err := typed.Int64(); err == nil {
			return integer, nil
		}
		float, err := typed.Float64()
		if err != nil || math.IsNaN(float) || math.IsInf(float, 0) {
			return nil, fmt.Errorf("link: sync bridge returned a non-finite number")
		}
		return float, nil
	case []any:
		for i, item := range typed {
			normalized, err := normalizeJSONIntegers(item)
			if err != nil {
				return nil, err
			}
			typed[i] = normalized
		}
		return typed, nil
	case map[string]any:
		for key, item := range typed {
			normalized, err := normalizeJSONIntegers(item)
			if err != nil {
				return nil, err
			}
			typed[key] = normalized
		}
		return typed, nil
	default:
		return value, nil
	}
}

func (n *Node) registerSyncBridge(cfg SyncBridgeConfig) {
	client := &http.Client{Timeout: 30 * time.Second}
	n.dispatch.Register(codec.KindSyncOp, func(ctx *FrameContext, fr *codec.Frame) (int, any, bool, error) {
		deviceID := n.sessionDeviceGet(ctx.SessionID)
		if deviceID == "" {
			return 0, nil, false, fmt.Errorf("link: session %s has no attested device", ctx.SessionID)
		}
		// Frame.Body is the decoded frame's raw CBOR payload, not a Go object. Passing
		// []byte to encoding/json base64-encodes it, so Node receives a string and loses
		// the op discriminator. Decode CBOR before crossing the JSON loopback seam.
		var decodedBody any
		if err := codec.Decode(fr.Body, &decodedBody); err != nil {
			return 0, nil, false, fmt.Errorf("link: sync frame body unparsable: %w", err)
		}
		requestBody, err := normalizeCBORForJSON(decodedBody)
		if err != nil {
			return 0, nil, false, err
		}
		payload, err := json.Marshal(syncBridgeRequest{DeviceID: deviceID, Kind: fr.Kind, Body: requestBody})
		if err != nil {
			return 0, nil, false, fmt.Errorf("link: sync bridge request unparsable: %w", err)
		}
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
			if br.Error != nil && br.Error.Code != "" {
				errorBody := map[string]any{
					"code": br.Error.Code, "message": br.Error.Message,
					"retryable": br.Error.Retryable,
				}
				if len(br.Error.Details) > 0 && string(br.Error.Details) != "null" {
					var details any
					decoder := json.NewDecoder(bytes.NewReader(br.Error.Details))
					decoder.UseNumber()
					if err := decoder.Decode(&details); err != nil {
						return 0, nil, false, fmt.Errorf("link: sync bridge error details unparsable")
					}
					details, err = normalizeJSONIntegers(details)
					if err != nil {
						return 0, nil, false, err
					}
					errorBody["details"] = details
				}
				return codec.KindSyncAck, map[string]any{
					"ok": false, "error": errorBody,
				}, false, nil
			}
			return 0, nil, false, fmt.Errorf("link: sync bridge rejected request with status %d", resp.StatusCode)
		}
		var body any
		if len(br.Body) > 0 {
			decoder := json.NewDecoder(bytes.NewReader(br.Body))
			decoder.UseNumber()
			if err := decoder.Decode(&body); err != nil {
				return 0, nil, false, fmt.Errorf("link: sync bridge body unparsable")
			}
			body, err = normalizeJSONIntegers(body)
			if err != nil {
				return 0, nil, false, err
			}
		}
		replyKind := br.Kind
		if replyKind == 0 {
			replyKind = codec.KindSyncAck
		}
		return replyKind, body, false, nil
	})
}
