//go:build js && wasm

package main

import "sync"

type fakeFileTransfer struct {
	mu       sync.Mutex
	requests []byte
	blocked  chan struct{}
}

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
