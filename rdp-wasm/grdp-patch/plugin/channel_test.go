package plugin

import (
	"encoding/binary"
	"testing"

	"github.com/nakagami/grdp/core"
	"github.com/nakagami/grdp/emission"
)

type channelTestTransport struct{ emission.Emitter }

func (t *channelTestTransport) Read([]byte) (int, error)                  { return 0, nil }
func (t *channelTestTransport) Write([]byte) (int, error)                 { return 0, nil }
func (t *channelTestTransport) Close() error                              { return nil }
func (t *channelTestTransport) SendToChannel(string, []byte) (int, error) { return 0, nil }

type channelTestHandler struct {
	name string
	got  [][]byte
}

func (h *channelTestHandler) GetType() (string, uint32) { return h.name, 0 }
func (h *channelTestHandler) Sender(core.ChannelSender) {}
func (h *channelTestHandler) Process(p []byte)          { h.got = append(h.got, append([]byte(nil), p...)) }

func channelFragment(total uint32, flags uint32, payload string) []byte {
	b := make([]byte, 8+len(payload))
	binary.LittleEndian.PutUint32(b[0:4], total)
	binary.LittleEndian.PutUint32(b[4:8], flags)
	copy(b[8:], payload)
	return b
}

func TestChannelsReassembleInterleavedPerChannel(t *testing.T) {
	transport := &channelTestTransport{Emitter: *emission.NewEmitter()}
	channels := NewChannels(transport)
	a := &channelTestHandler{name: "drdynvc"}
	b := &channelTestHandler{name: "cliprdr"}
	channels.Register(a)
	channels.Register(b)

	channels.process("drdynvc", channelFragment(6, CHANNEL_FLAG_FIRST, "abc"))
	channels.process("cliprdr", channelFragment(4, CHANNEL_FLAG_FIRST, "12"))
	channels.process("drdynvc", channelFragment(6, CHANNEL_FLAG_LAST, "def"))
	channels.process("cliprdr", channelFragment(4, CHANNEL_FLAG_LAST, "34"))

	if len(a.got) != 1 || string(a.got[0]) != "abcdef" {
		t.Fatalf("drdynvc got %q", a.got)
	}
	if len(b.got) != 1 || string(b.got[0]) != "1234" {
		t.Fatalf("cliprdr got %q", b.got)
	}
}

func TestChannelsRejectLengthMismatch(t *testing.T) {
	transport := &channelTestTransport{Emitter: *emission.NewEmitter()}
	channels := NewChannels(transport)
	h := &channelTestHandler{name: "drdynvc"}
	channels.Register(h)
	channels.process("drdynvc", channelFragment(5, CHANNEL_FLAG_FIRST|CHANNEL_FLAG_LAST, "four"))
	if len(h.got) != 0 {
		t.Fatalf("processed invalid payload %q", h.got)
	}
}
