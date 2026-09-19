package cell

import "io"

// PTYSession represents an interactive terminal session (§6.1).
// All engines with CapPTY support this; Cell-Server tunnels PTY frames
// over WebSocket (§6.3).
type PTYSession struct {
	// ID is the session-unique PTY identifier.
	ID string

	// Reader streams PTY output from the guest.
	Reader io.Reader

	// Writer accepts PTY input to the guest.
	Writer io.Writer

	// closer is called on Close to release resources.
	closer func() error
}

// Resize changes the PTY dimensions.
// rows and cols must be positive; zero values are ignored.
func (p *PTYSession) Resize(rows, cols int) error {
	// Implementation provided by the engine; this is the SDK interface stub.
	return ErrEngineUnsupported
}

// Close terminates the PTY session and releases resources.
func (p *PTYSession) Close() error {
	if p.closer != nil {
		return p.closer()
	}
	return nil
}
