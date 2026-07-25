//go:build js && wasm

package main

import "sync"

type fakeFileTransfer struct {
	mu       sync.Mutex
	requests []byte
	blocked  chan struct{}
}

type recordingFileTransfer struct {
	mu       sync.Mutex
	reads    int
	readData []byte
}

// flakyFileTransfer fails the first failCount requests with a retryable
// error, then succeeds. Used to verify requestAgent chunk-level retries.
type flakyFileTransfer struct {
	mu        sync.Mutex
	failCount int
	attempts  int
	payload   []byte
	code      string
}

// stickyErrorTransfer always returns the same error — for permanent failures.
type stickyErrorTransfer struct {
	err error
}

func (f *recordingFileTransfer) Request(_ string, op byte, _ map[string]any, _ []byte) (fileTransferResponse, error) {
	if op == zft2Read {
		f.mu.Lock()
		f.reads++
		f.mu.Unlock()
		return fileTransferResponse{Payload: append([]byte(nil), f.readData...)}, nil
	}
	return fileTransferResponse{}, nil
}
func (f *recordingFileTransfer) CloseAgent(string) {}
func (f *recordingFileTransfer) Close()            {}

func (f *fakeFileTransfer) Request(_ string, op byte, _ map[string]any, _ []byte) (fileTransferResponse, error) {
	f.mu.Lock()
	f.requests = append(f.requests, op)
	f.mu.Unlock()
	if f.blocked != nil {
		<-f.blocked
	}
	return fileTransferResponse{}, nil
}
func (f *fakeFileTransfer) CloseAgent(string) {}
func (f *fakeFileTransfer) Close()            {}

func (f *flakyFileTransfer) Request(_ string, _ byte, _ map[string]any, _ []byte) (fileTransferResponse, error) {
	f.mu.Lock()
	f.attempts++
	attempt := f.attempts
	left := f.failCount
	code := f.code
	if code == "" {
		code = "busy"
	}
	payload := append([]byte(nil), f.payload...)
	f.mu.Unlock()
	if attempt <= left {
		return fileTransferResponse{}, &zft2Error{Code: code, Message: code + " (simulated)", Retryable: true}
	}
	return fileTransferResponse{Payload: payload, Meta: map[string]any{"ok": true}}, nil
}
func (f *flakyFileTransfer) CloseAgent(string) {}
func (f *flakyFileTransfer) Close()            {}

func (f *stickyErrorTransfer) Request(string, byte, map[string]any, []byte) (fileTransferResponse, error) {
	return fileTransferResponse{}, f.err
}
func (f *stickyErrorTransfer) CloseAgent(string) {}
func (f *stickyErrorTransfer) Close()            {}
