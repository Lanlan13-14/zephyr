package editorcore

import "errors"

var errNotOpen = errors.New("document is not open")

// ErrNotOpen is returned when a host names a document the session does not hold.
func ErrNotOpen() error { return errNotOpen }
