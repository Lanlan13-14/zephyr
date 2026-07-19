package main

import (
	"bytes"
	"context"
	"net/http"
	"sync"

	"nhooyr.io/websocket"
)

func bytesReader(b []byte) *bytes.Reader { return bytes.NewReader(b) }

// realUpgrader adapts nhooyr.io/websocket to our minimal Conn interface.
type realUpgrader struct{}

func (realUpgrader) Upgrade(w http.ResponseWriter, r *http.Request, responseHeader http.Header) (Conn, error) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{"*"},
	})
	if err != nil {
		return nil, err
	}
	return &nhooyrConn{c: c}, nil
}

type nhooyrConn struct {
	c  *websocket.Conn
	mu sync.Mutex
}

func (n *nhooyrConn) ReadJSON(v interface{}) error {
	_, r, err := n.c.Read(context.Background())
	if err != nil {
		return err
	}
	return jsonNewDecoder(bytesReader(r)).Decode(v)
}

func (n *nhooyrConn) WriteJSON(v interface{}) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	w, err := n.c.Writer(context.Background(), websocket.MessageText)
	if err != nil {
		return err
	}
	if err := jsonNewEncoder(w).Encode(v); err != nil {
		return err
	}
	return w.Close()
}

func (n *nhooyrConn) Close() error {
	return n.c.CloseNow()
}

func init() {
	defaultUpgrader = realUpgrader{}
}
