package core

import "github.com/nakagami/grdp/emission"

type Transport interface {
	Read(b []byte) (n int, err error)
	Write(b []byte) (n int, err error)
	Close() error

	On(event, listener any) *emission.Emitter
	Once(event, listener any) *emission.Emitter
	Emit(event any, arguments ...any) *emission.Emitter
}

type FastPathListener interface {
	RecvFastPath(secFlag byte, s []byte)
}

type FastPathSender interface {
	SendFastPath(secFlag byte, s []byte) (int, error)
}

type ChannelSender interface {
	SendToChannel(channel string, s []byte) (int, error)
}
