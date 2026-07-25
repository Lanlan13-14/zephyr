package main

// zft2Error is shared by the WASM file-transfer client and the pure retry
// helpers so native unit tests can exercise retry classification without a
// js/wasm toolchain.
type zft2Error struct {
	Code      string
	Message   string
	Retryable bool
}

func (e *zft2Error) Error() string {
	if e == nil {
		return "file transfer failed"
	}
	return e.Message
}
