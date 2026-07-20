//go:build js && wasm

package main

import (
	"fmt"
	"sync"
	"syscall/js"
	"time"
)

const (
	fileTransferMaxInflight = 8
	fileTransferTimeout     = 60 * time.Second
	fileTransferSendHigh    = 8 * 1024 * 1024
	fileTransferSendLow     = 2 * 1024 * 1024
)

type pendingFileTransfer struct {
	result chan fileTransferResult
}

type fileTransferResult struct {
	response fileTransferResponse
	err      error
}

type wsFileTransfer struct {
	baseURL      string
	connectionID string
	mu           sync.Mutex
	connections  map[string]*agentTransferConn
	closed       bool
}

type agentTransferConn struct {
	parent    *wsFileTransfer
	agentID   string
	ws        js.Value
	ready     chan error
	pending   map[uint32]*pendingFileTransfer
	nextID    uint32
	mu        sync.Mutex
	closed    bool
	onOpen    js.Func
	onError   js.Func
	onMessage js.Func
	onClose   js.Func
}

func newWSFileTransfer(baseURL, connectionID string) fileTransfer {
	return &wsFileTransfer{baseURL: baseURL, connectionID: connectionID, connections: make(map[string]*agentTransferConn)}
}

func (t *wsFileTransfer) connection(agentID string) (*agentTransferConn, error) {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return nil, fmt.Errorf("file transfer client is closed")
	}
	if conn := t.connections[agentID]; conn != nil {
		t.mu.Unlock()
		return conn, nil
	}
	conn := &agentTransferConn{parent: t, agentID: agentID, ready: make(chan error, 1), pending: make(map[uint32]*pendingFileTransfer), nextID: 1}
	t.connections[agentID] = conn
	t.mu.Unlock()
	if err := conn.open(); err != nil {
		t.mu.Lock()
		delete(t.connections, agentID)
		t.mu.Unlock()
		return nil, err
	}
	return conn, nil
}

func (c *agentTransferConn) open() error {
	url := c.parent.baseURL + "/file-transfer?agentId=" + js.Global().Get("encodeURIComponent").Invoke(c.agentID).String() + "&connectionId=" + js.Global().Get("encodeURIComponent").Invoke(c.parent.connectionID).String()
	ws := js.Global().Get("WebSocket").New(url)
	ws.Set("binaryType", "arraybuffer")
	c.ws = ws
	c.onOpen = js.FuncOf(func(js.Value, []js.Value) any {
		select {
		case c.ready <- nil:
		default:
		}
		return nil
	})
	c.onError = js.FuncOf(func(js.Value, []js.Value) any {
		select {
		case c.ready <- fmt.Errorf("file transfer websocket error"):
		default:
		}
		return nil
	})
	c.onMessage = js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) == 0 {
			return nil
		}
		data := args[0].Get("data")
		arr := js.Global().Get("Uint8Array").New(data)
		raw := make([]byte, arr.Length())
		js.CopyBytesToGo(raw, arr)
		frame, err := decodeZft2Frame(raw)
		if err != nil {
			c.failAll(err)
			return nil
		}
		c.handleResponse(frame)
		return nil
	})
	c.onClose = js.FuncOf(func(js.Value, []js.Value) any { c.failAll(fmt.Errorf("file transfer websocket closed")); return nil })
	ws.Set("onopen", c.onOpen)
	ws.Set("onerror", c.onError)
	ws.Set("onmessage", c.onMessage)
	ws.Set("onclose", c.onClose)
	select {
	case err := <-c.ready:
		return err
	case <-time.After(15 * time.Second):
		c.close()
		return fmt.Errorf("file transfer websocket open timeout")
	}
}

func (t *wsFileTransfer) Request(agentID string, op byte, meta map[string]any, payload []byte) (fileTransferResponse, error) {
	conn, err := t.connection(agentID)
	if err != nil {
		return fileTransferResponse{}, err
	}
	return conn.request(op, meta, payload)
}

func (c *agentTransferConn) request(op byte, meta map[string]any, payload []byte) (fileTransferResponse, error) {
	c.mu.Lock()
	if c.closed || c.ws.Get("readyState").Int() != 1 {
		c.mu.Unlock()
		return fileTransferResponse{}, fmt.Errorf("file transfer websocket is closed")
	}
	if len(c.pending) >= fileTransferMaxInflight {
		c.mu.Unlock()
		return fileTransferResponse{}, &zft2Error{Code: "busy", Message: "file transfer request window is full", Retryable: true}
	}
	id := c.nextID
	c.nextID++
	pending := &pendingFileTransfer{result: make(chan fileTransferResult, 1)}
	c.pending[id] = pending
	c.mu.Unlock()
	frame, err := encodeZft2Frame(zft2Frame{Type: op, RequestID: id, Meta: meta, Payload: payload})
	if err != nil {
		c.removePending(id)
		return fileTransferResponse{}, err
	}
	if err := c.waitSendBudget(len(frame)); err != nil {
		c.removePending(id)
		return fileTransferResponse{}, err
	}
	arr := js.Global().Get("Uint8Array").New(len(frame))
	js.CopyBytesToJS(arr, frame)
	c.ws.Call("send", arr)
	select {
	case result := <-pending.result:
		return result.response, result.err
	case <-time.After(fileTransferTimeout):
		c.removePending(id)
		c.sendCancel(id)
		return fileTransferResponse{}, &zft2Error{Code: "timeout", Message: "file transfer request timed out", Retryable: true}
	}
}

func (c *agentTransferConn) waitSendBudget(frameBytes int) error {
	deadline := time.Now().Add(30 * time.Second)
	for c.ws.Get("bufferedAmount").Int()+frameBytes > fileTransferSendHigh {
		if time.Now().After(deadline) {
			return fmt.Errorf("file transfer websocket backpressure timeout")
		}
		time.Sleep(4 * time.Millisecond)
		if c.ws.Get("bufferedAmount").Int() <= fileTransferSendLow {
			break
		}
	}
	return nil
}

func (c *agentTransferConn) handleResponse(frame zft2Frame) {
	if frame.Flags&zft2FlagResponse == 0 {
		return
	}
	c.mu.Lock()
	pending := c.pending[frame.RequestID]
	delete(c.pending, frame.RequestID)
	c.mu.Unlock()
	if pending == nil {
		return
	}
	if frame.Flags&zft2FlagError != 0 {
		pending.result <- fileTransferResult{err: &zft2Error{Code: stringMeta(frame.Meta, "code"), Message: stringMeta(frame.Meta, "message"), Retryable: boolMeta(frame.Meta, "retryable")}}
		return
	}
	pending.result <- fileTransferResult{response: fileTransferResponse{Meta: frame.Meta, Payload: frame.Payload}}
}

func (c *agentTransferConn) sendCancel(targetID uint32) {
	c.mu.Lock()
	id := c.nextID
	c.nextID++
	c.mu.Unlock()
	frame, _ := encodeZft2Frame(zft2Frame{Type: zft2Cancel, RequestID: id, Meta: map[string]any{"targetRequestId": targetID}})
	if c.ws.Truthy() && c.ws.Get("readyState").Int() == 1 {
		arr := js.Global().Get("Uint8Array").New(len(frame))
		js.CopyBytesToJS(arr, frame)
		c.ws.Call("send", arr)
	}
}

func (c *agentTransferConn) removePending(id uint32) {
	c.mu.Lock()
	delete(c.pending, id)
	c.mu.Unlock()
}

func (c *agentTransferConn) failAll(err error) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	pending := c.pending
	c.pending = make(map[uint32]*pendingFileTransfer)
	c.mu.Unlock()
	select {
	case c.ready <- err:
	default:
	}
	for _, p := range pending {
		p.result <- fileTransferResult{err: err}
	}
}

func (c *agentTransferConn) close() {
	c.failAll(fmt.Errorf("file transfer connection closed"))
	if c.ws.Truthy() {
		c.ws.Call("close", 1000, "RDP session closed")
	}
}

func (t *wsFileTransfer) CloseAgent(agentID string) {
	t.mu.Lock()
	conn := t.connections[agentID]
	delete(t.connections, agentID)
	t.mu.Unlock()
	if conn != nil {
		conn.close()
	}
}

func (t *wsFileTransfer) Close() {
	t.mu.Lock()
	t.closed = true
	list := t.connections
	t.connections = make(map[string]*agentTransferConn)
	t.mu.Unlock()
	for _, conn := range list {
		conn.close()
	}
}

func stringMeta(meta map[string]any, key string) string {
	if v, ok := meta[key].(string); ok {
		return v
	}
	return ""
}
func boolMeta(meta map[string]any, key string) bool { v, _ := meta[key].(bool); return v }
func int64Meta(meta map[string]any, key string) int64 {
	if v, ok := meta[key].(float64); ok {
		return int64(v)
	}
	return 0
}
