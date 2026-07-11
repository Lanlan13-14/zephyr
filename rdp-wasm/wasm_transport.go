//go:build js && wasm

package main

import (
	"fmt"
	"net"
	"sync"
	"syscall/js"
	"time"
)

const (
	wsReadHighWater = 8 * 1024 * 1024
	wsReadLowWater  = 2 * 1024 * 1024
	wsReadHardLimit = 32 * 1024 * 1024
)

// wsConn implements net.Conn over a browser WebSocket.
// It is created by dialWebSocket and injected into grdp via RdpClient.Dialer.
type wsConn struct {
	ws          js.Value
	readQueue   *byteQueue
	closed      bool
	mu          sync.Mutex
	flowPaused  bool
	flowControl bool
}

func dialWebSocket(proxyURL string) (net.Conn, error) {
	c := &wsConn{
		readQueue:   newByteQueue(wsReadHardLimit),
		flowControl: true,
	}

	ws := js.Global().Get("WebSocket").New(proxyURL)
	ws.Set("binaryType", "arraybuffer")
	c.ws = ws

	openCh := make(chan error, 1)

	var onOpen, onError, onMessage, onClose js.Func

	onOpen = js.FuncOf(func(this js.Value, args []js.Value) any {
		openCh <- nil
		return nil
	})
	onError = js.FuncOf(func(this js.Value, args []js.Value) any {
		select {
		case openCh <- fmt.Errorf("websocket error"):
		default:
		}
		return nil
	})
	onMessage = js.FuncOf(func(this js.Value, args []js.Value) any {
		data := args[0].Get("data")
		arr := js.Global().Get("Uint8Array").New(data)
		buf := make([]byte, arr.Length())
		js.CopyBytesToGo(buf, arr)
		c.mu.Lock()
		closed := c.closed
		c.mu.Unlock()
		if closed {
			return nil
		}
		state, ok := c.readQueue.Push(buf)
		if !ok {
			c.fail("RDP receive queue hard limit exceeded")
			return nil
		}
		if state.QueuedBytes >= wsReadHighWater {
			c.setRemoteFlowPaused(true)
		}
		return nil
	})
	onClose = js.FuncOf(func(this js.Value, args []js.Value) any {
		c.markClosed()
		return nil
	})

	ws.Set("onopen", onOpen)
	ws.Set("onerror", onError)
	ws.Set("onmessage", onMessage)
	ws.Set("onclose", onClose)

	err := <-openCh
	// Release open/error handlers; keep message/close handlers alive via c.ws
	onOpen.Release()
	onError.Release()
	// Store message and close handlers so they are not GC'd
	c.ws.Set("_onmessage", onMessage)
	c.ws.Set("_onclose", onClose)

	if err != nil {
		return nil, err
	}
	return c, nil
}

func (c *wsConn) markClosed() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	c.mu.Unlock()
	c.readQueue.Close()
}

func (c *wsConn) fail(reason string) {
	c.markClosed()
	if c.ws.Truthy() {
		c.ws.Call("close", 1011, reason)
	}
}

func (c *wsConn) setRemoteFlowPaused(paused bool) {
	c.mu.Lock()
	if c.closed || !c.flowControl || c.flowPaused == paused {
		c.mu.Unlock()
		return
	}
	c.flowPaused = paused
	c.mu.Unlock()
	if c.ws.Get("readyState").Int() != 1 {
		return
	}
	message := js.Global().Get("JSON").Call("stringify", map[string]any{
		"type":  "zephyr-rdp-flow",
		"state": map[bool]string{true: "pause", false: "resume"}[paused],
	})
	c.ws.Call("send", message)
}

func (c *wsConn) Read(b []byte) (int, error) {
	for {
		n, closed := c.readQueue.Read(b)
		if n > 0 {
			state := c.readQueue.State()
			if state.QueuedBytes <= wsReadLowWater {
				c.setRemoteFlowPaused(false)
			}
			return n, nil
		}
		if closed {
			return 0, fmt.Errorf("websocket closed")
		}
		<-c.readQueue.notify
	}
}

func (c *wsConn) Write(b []byte) (int, error) {
	c.mu.Lock()
	closed := c.closed
	c.mu.Unlock()
	if closed {
		return 0, fmt.Errorf("websocket closed")
	}
	arr := js.Global().Get("Uint8Array").New(len(b))
	js.CopyBytesToJS(arr, b)
	c.ws.Call("send", arr.Get("buffer"))
	return len(b), nil
}

func (c *wsConn) Close() error {
	c.mu.Lock()
	alreadyClosed := c.closed
	c.closed = true
	c.mu.Unlock()
	c.readQueue.Close()
	if !alreadyClosed && c.ws.Truthy() {
		c.ws.Call("close")
	}
	return nil
}

func (c *wsConn) LocalAddr() net.Addr                { return wsAddr("local") }
func (c *wsConn) RemoteAddr() net.Addr               { return wsAddr("remote") }
func (c *wsConn) SetDeadline(t time.Time) error      { return nil }
func (c *wsConn) SetReadDeadline(t time.Time) error  { return nil }
func (c *wsConn) SetWriteDeadline(t time.Time) error { return nil }

type wsAddr string

func (a wsAddr) Network() string { return "websocket" }
func (a wsAddr) String() string  { return string(a) }
