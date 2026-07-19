package main

import (
	"encoding/json"
	"io"
)

// indirection so session.go doesn't import encoding/json directly (keeps the
// WebSocket layer swappable for tests with a fake Conn).

func jsonNewDecoder(r io.Reader) *json.Decoder { return json.NewDecoder(r) }
func jsonNewEncoder(w io.Writer) *json.Encoder { return json.NewEncoder(w) }
func jsonMarshal(v interface{}) ([]byte, error) { return json.Marshal(v) }
func jsonUnmarshal(b []byte, v interface{}) error { return json.Unmarshal(b, v) }
