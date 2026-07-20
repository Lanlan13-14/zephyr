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
