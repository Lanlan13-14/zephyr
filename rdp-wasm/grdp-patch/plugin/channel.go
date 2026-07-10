package plugin

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"log/slog"
	"slices"
	"sync"
	"unsafe"

	"github.com/nakagami/grdp/core"
	"github.com/nakagami/grdp/emission"
)

// chunkBufPool reuses the header+payload buffers for outbound channel chunks.
// Each buffer is pre-sized to the largest possible chunk (8-byte header + 1600 bytes data).
var chunkBufPool = sync.Pool{
	New: func() any { return make([]byte, 0, 8+CHANNEL_CHUNK_LENGTH) },
}

const (
	CHANNEL_RC_OK                         = 0
	CHANNEL_RC_ALREADY_INITIALIZED        = 1
	CHANNEL_RC_NOT_INITIALIZED            = 2
	CHANNEL_RC_ALREADY_CONNECTED          = 3
	CHANNEL_RC_NOT_CONNECTED              = 4
	CHANNEL_RC_TOO_MANY_CHANNELS          = 5
	CHANNEL_RC_BAD_CHANNEL                = 6
	CHANNEL_RC_BAD_CHANNEL_HANDLE         = 7
	CHANNEL_RC_NO_BUFFER                  = 8
	CHANNEL_RC_BAD_INIT_HANDLE            = 9
	CHANNEL_RC_NOT_OPEN                   = 10
	CHANNEL_RC_BAD_PROC                   = 11
	CHANNEL_RC_NO_MEMORY                  = 12
	CHANNEL_RC_UNKNOWN_CHANNEL_NAME       = 13
	CHANNEL_RC_ALREADY_OPEN               = 14
	CHANNEL_RC_NOT_IN_VIRTUALCHANNELENTRY = 15
	CHANNEL_RC_NULL_DATA                  = 16
	CHANNEL_RC_ZERO_LENGTH                = 17
	CHANNEL_RC_INVALID_INSTANCE           = 18
	CHANNEL_RC_UNSUPPORTED_VERSION        = 19
	CHANNEL_RC_INITIALIZATION_ERROR       = 20
)
const (
	VIRTUAL_CHANNEL_VERSION_WIN2000 = 1
)

const (
	CHANNEL_EVENT_INITIALIZED          = 0
	CHANNEL_EVENT_CONNECTED            = 1
	CHANNEL_EVENT_V1_CONNECTED         = 2
	CHANNEL_EVENT_DISCONNECTED         = 3
	CHANNEL_EVENT_TERMINATED           = 4
	CHANNEL_EVENT_REMOTE_CONTROL_START = 5
	CHANNEL_EVENT_REMOTE_CONTROL_STOP  = 6
	CHANNEL_EVENT_ATTACHED             = 7
	CHANNEL_EVENT_DETACHED             = 8
	CHANNEL_EVENT_DATA_RECEIVED        = 10
	CHANNEL_EVENT_WRITE_COMPLETE       = 11
	CHANNEL_EVENT_WRITE_CANCELLED      = 12
)

const (
	CHANNEL_OPTION_INITIALIZED               = 0x80000000
	CHANNEL_OPTION_ENCRYPT_RDP               = 0x40000000
	CHANNEL_OPTION_ENCRYPT_SC                = 0x20000000
	CHANNEL_OPTION_ENCRYPT_CS                = 0x10000000
	CHANNEL_OPTION_PRI_HIGH                  = 0x08000000
	CHANNEL_OPTION_PRI_MED                   = 0x04000000
	CHANNEL_OPTION_PRI_LOW                   = 0x02000000
	CHANNEL_OPTION_COMPRESS_RDP              = 0x00800000
	CHANNEL_OPTION_COMPRESS                  = 0x00400000
	CHANNEL_OPTION_SHOW_PROTOCOL             = 0x00200000
	CHANNEL_OPTION_REMOTE_CONTROL_PERSISTENT = 0x00100000
)

type ChannelDef struct {
	Name    string
	Options uint32
}
type CHANNEL_INIT_EVENT_EX_FN func(lpUserParam any,
	pInitHandle any, event uint, pData uintptr, dataLength uint)
type VIRTUALCHANNELINITEX func(lpUserParam any, clientContext any,
	pInitHandle any, pChannel []ChannelDef,
	channelCount int, versionRequested uint32,
	pChannelInitEventProcEx CHANNEL_INIT_EVENT_EX_FN) uint

type CHANNEL_OPEN_EVENT_EX_FN func(lpUserParam uintptr,
	openHandle uint32, event uint,
	pData uintptr, dataLength uint32, totalLength uint32, dataFlags uint32)
type VIRTUALCHANNELOPENEX func(pInitHandle any, pOpenHandle *uint32,
	pChannelName string,
	pChannelOpenEventProcEx *CHANNEL_OPEN_EVENT_EX_FN) uint

type VIRTUALCHANNELCLOSEEX func(pInitHandle any, openHandle uint32) uint

type VIRTUALCHANNELWRITEEX func(pInitHandle any, openHandle uint32, pData any,
	dataLength uint32, pUserData any) uint

type ChannelEntryPointsEx struct {
	CbSize                 uint32
	ProtocolVersion        uint32
	PVirtualChannelInitEx  VIRTUALCHANNELINITEX
	PVirtualChannelOpenEx  VIRTUALCHANNELOPENEX
	PVirtualChannelCloseEx VIRTUALCHANNELCLOSEEX
	PVirtualChannelWriteEx VIRTUALCHANNELWRITEEX
}

func NewChannelEntryPointsEx() *ChannelEntryPointsEx {
	e := &ChannelEntryPointsEx{}
	e.CbSize = uint32(unsafe.Sizeof(e))
	e.ProtocolVersion = VIRTUAL_CHANNEL_VERSION_WIN2000
	return e
}

type VIRTUALCHANNELENTRYEX func(pEntryPointsEx *ChannelEntryPointsEx,
	pInitHandle any) error

/*
type ChannelEntryPoints struct {
	CbSize               uint32
	ProtocolVersion      uint32
	PVirtualChannelInit  PVIRTUALCHANNELINIT
	PVirtualChannelOpen  PVIRTUALCHANNELOPEN
	PVirtualChannelClose PVIRTUALCHANNELCLOSE
	PVirtualChannelWrite PVIRTUALCHANNELWRITE
}
typedef VOID VCAPITYPE CHANNEL_INIT_EVENT_FN(LPVOID pInitHandle,
        UINT event, LPVOID pData, UINT dataLength);

typedef CHANNEL_INIT_EVENT_FN* PCHANNEL_INIT_EVENT_FN;
typedef VOID VCAPITYPE CHANNEL_OPEN_EVENT_FN(DWORD openHandle, UINT event,
        LPVOID pData, UINT32 dataLength, UINT32 totalLength, UINT32 dataFlags);

typedef CHANNEL_OPEN_EVENT_FN* PCHANNEL_OPEN_EVENT_FN;
typedef UINT VCAPITYPE VIRTUALCHANNELINIT(LPVOID* ppInitHandle, PCHANNEL_DEF pChannel,
                                          INT channelCount, ULONG versionRequested,
                                          PCHANNEL_INIT_EVENT_FN pChannelInitEventProc);
typedef VIRTUALCHANNELINIT* PVIRTUALCHANNELINIT;

typedef UINT VCAPITYPE VIRTUALCHANNELOPEN(LPVOID pInitHandle, LPDWORD pOpenHandle,
                                          PCHAR pChannelName,
                                          PCHANNEL_OPEN_EVENT_FN pChannelOpenEventProc);

typedef VIRTUALCHANNELOPEN* PVIRTUALCHANNELOPEN;

typedef UINT VCAPITYPE VIRTUALCHANNELCLOSE(DWORD openHandle);
typedef VIRTUALCHANNELCLOSE* PVIRTUALCHANNELCLOSE;

typedef UINT VCAPITYPE VIRTUALCHANNELWRITE(DWORD openHandle, LPVOID pData, ULONG dataLength,
                                           LPVOID pUserData);
typedef VIRTUALCHANNELWRITE* PVIRTUALCHANNELWRITE;

typedef UINT VCAPITYPE VIRTUALCHANNELINITEX(LPVOID lpUserParam, LPVOID clientContext,
                                            LPVOID pInitHandle, PCHANNEL_DEF pChannel,
                                            INT channelCount, ULONG versionRequested,
                                            PCHANNEL_INIT_EVENT_EX_FN pChannelInitEventProcEx);
typedef VIRTUALCHANNELINITEX* PVIRTUALCHANNELINITEX;

typedef UINT VCAPITYPE VIRTUALCHANNELOPENEX(LPVOID pInitHandle, LPDWORD pOpenHandle,
                                            PCHAR pChannelName,
                                            PCHANNEL_OPEN_EVENT_EX_FN pChannelOpenEventProcEx);
typedef VIRTUALCHANNELOPENEX* PVIRTUALCHANNELOPENEX;


typedef UINT VCAPITYPE VIRTUALCHANNELCLOSEEX(LPVOID pInitHandle, DWORD openHandle);
typedef VIRTUALCHANNELCLOSEEX* PVIRTUALCHANNELCLOSEEX;

typedef UINT VCAPITYPE VIRTUALCHANNELWRITEEX(LPVOID pInitHandle, DWORD openHandle, LPVOID pData,
                                             ULONG dataLength, LPVOID pUserData);
typedef VIRTUALCHANNELWRITEEX* PVIRTUALCHANNELWRITEEX;
*/

// static channel name
const (
	CLIPRDR_SVC_CHANNEL_NAME = "cliprdr" // clipboard
	RDPDR_SVC_CHANNEL_NAME   = "rdpdr"   // device redirection
	RDPSND_SVC_CHANNEL_NAME  = "rdpsnd"  // sound
	RAIL_SVC_CHANNEL_NAME    = "rail"    // remote appication
	DRDYNVC_SVC_CHANNEL_NAME = "drdynvc" // dynamic virtual channel
	REMDESK_SVC_CHANNEL_NAME = "remdesk" // remote assistance
)

const (
	RDPGFX_DVC_CHANNEL_NAME = "Microsoft::Windows::RDS::Graphics" // Graphics Extension
)

var StaticVirtualChannels = map[string]int{
	CLIPRDR_SVC_CHANNEL_NAME: CHANNEL_OPTION_INITIALIZED | CHANNEL_OPTION_ENCRYPT_RDP |
		CHANNEL_OPTION_COMPRESS_RDP | CHANNEL_OPTION_SHOW_PROTOCOL,
	RDPDR_SVC_CHANNEL_NAME: CHANNEL_OPTION_INITIALIZED | CHANNEL_OPTION_ENCRYPT_RDP | CHANNEL_OPTION_COMPRESS_RDP,
	RDPSND_SVC_CHANNEL_NAME: CHANNEL_OPTION_INITIALIZED | CHANNEL_OPTION_ENCRYPT_RDP |
		CHANNEL_OPTION_COMPRESS_RDP | CHANNEL_OPTION_SHOW_PROTOCOL,
	RAIL_SVC_CHANNEL_NAME: CHANNEL_OPTION_INITIALIZED | CHANNEL_OPTION_ENCRYPT_RDP |
		CHANNEL_OPTION_COMPRESS_RDP | CHANNEL_OPTION_SHOW_PROTOCOL,
}

const (
	CHANNEL_CHUNK_LENGTH       = 1600
	CHANNEL_FLAG_FIRST         = 0x01
	CHANNEL_FLAG_LAST          = 0x02
	CHANNEL_FLAG_SHOW_PROTOCOL = 0x10
)

type ChannelTransport interface {
	GetType() (string, uint32)
	Sender(core.ChannelSender)
	Process(s []byte)
}
type ChannelClient struct {
	ChannelDef
	t ChannelTransport
}

type Channels struct {
	emission.Emitter
	channels      map[string]ChannelClient
	transport     core.Transport
	buff          *bytes.Buffer
	channelSender core.ChannelSender
}

func NewChannels(t core.Transport) *Channels {
	c := &Channels{
		Emitter:   *emission.NewEmitter(),
		channels:  make(map[string]ChannelClient, 20),
		transport: t,
		buff:      &bytes.Buffer{},
	}
	t.On("channel", c.process)
	return c
}

func (c *Channels) SetChannelSender(f core.ChannelSender) {
	c.channelSender = f
}
func (c *Channels) Register(t ChannelTransport) {
	name, option := t.GetType()
	_, ok := c.channels[name]
	if ok {
		slog.Warn("Already register", "channel", name)
		return
	}
	t.Sender(c)
	c.channels[name] = ChannelClient{ChannelDef{name, option}, t}
}

func (c *Channels) SendToChannel(channel string, s []byte) (int, error) {
	cli, ok := c.channels[channel]
	if !ok {
		slog.Warn("No register", "channel", channel)
		return 0, fmt.Errorf("No register channel: %s", channel)
	}
	totalLen := len(s)
	baseFlag := uint32(0)
	if cli.Options&CHANNEL_OPTION_SHOW_PROTOCOL != 0 {
		baseFlag |= CHANNEL_FLAG_SHOW_PROTOCOL
	}
	buf := chunkBufPool.Get().([]byte)
	first := true
	remaining := totalLen
	for chunk := range slices.Chunk(s, CHANNEL_CHUNK_LENGTH) {
		flag := baseFlag
		if first {
			flag |= CHANNEL_FLAG_FIRST
			first = false
		}
		remaining -= len(chunk)
		if remaining == 0 {
			flag |= CHANNEL_FLAG_LAST
		}
		slog.Debug("SendToChannel", "len", len(chunk), "flag", flag)
		buf = buf[:8+len(chunk)]
		binary.LittleEndian.PutUint32(buf[0:], uint32(totalLen))
		binary.LittleEndian.PutUint32(buf[4:], flag)
		copy(buf[8:], chunk)
		c.channelSender.SendToChannel(channel, buf)
	}
	chunkBufPool.Put(buf[:0])
	return 0, nil
}

func (c *Channels) process(channel string, s []byte) {
	cli, ok := c.channels[channel]
	if !ok {
		slog.Warn("process No found channel", "channel", channel)
		return
	}
	if len(s) < 8 {
		return
	}
	// Parse 8-byte header directly: totalLen(4) + flags(4)
	flags := uint32(s[4]) | uint32(s[5])<<8 | uint32(s[6])<<16 | uint32(s[7])<<24
	payload := s[8:]
	if flags&CHANNEL_FLAG_FIRST == 0 || flags&CHANNEL_FLAG_LAST == 0 {
		if flags&CHANNEL_FLAG_FIRST != 0 {
			c.buff.Reset()
		}
		c.buff.Write(payload)
		if flags&CHANNEL_FLAG_LAST == 0 {
			return
		}
		cli.t.Process(c.buff.Bytes())
	} else {
		cli.t.Process(payload)
	}
}
