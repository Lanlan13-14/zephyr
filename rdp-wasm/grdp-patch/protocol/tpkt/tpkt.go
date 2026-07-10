package tpkt

import (
	"encoding/binary"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"time"

	"github.com/nakagami/grdp/core"
	"github.com/nakagami/grdp/emission"
	"github.com/nakagami/grdp/protocol/nla"
)

var writePool = sync.Pool{
	New: func() any { return make([]byte, 0, 4096) },
}

// readBufPool reuses packet body buffers in readLoop.
// Typical RDP packets are well under 4 KiB; the pool avoids a heap
// allocation for every incoming packet (~60/s during active sessions).
// Buffers larger than maxPooledReadBuf are not pooled to avoid keeping
// large slices alive in the pool between bursts.
const maxPooledReadBuf = 32 * 1024

var readBufPool = sync.Pool{
	New: func() any { return make([]byte, 0, 4096) },
}

func acquireReadBuf(n int) []byte {
	b := readBufPool.Get().([]byte)
	if cap(b) >= n {
		return b[:n]
	}
	readBufPool.Put(b[:0])
	return make([]byte, n)
}

func releaseReadBuf(b []byte) {
	if cap(b) <= maxPooledReadBuf {
		readBufPool.Put(b[:0])
	}
}

// take idea from https://github.com/Madnikulin50/gordp

/**
 * Type of tpkt packet
 * Fastpath is use to shortcut RDP stack
 * @see http://msdn.microsoft.com/en-us/library/cc240621.aspx
 * @see http://msdn.microsoft.com/en-us/library/cc240589.aspx
 */
const (
	FASTPATH_ACTION_FASTPATH = 0x0
	FASTPATH_ACTION_X224     = 0x3
)

/**
 * TPKT layer of rdp stack
 */
type TPKT struct {
	emission.Emitter
	Conn             *core.SocketLayer
	ntlm             *nla.NTLMv2
	fastPathListener core.FastPathListener
	ntlmSec          *nla.NTLMv2Security
}

func New(s *core.SocketLayer, ntlm *nla.NTLMv2) *TPKT {
	t := &TPKT{
		Emitter: *emission.NewEmitter(),
		Conn:    s,
		ntlm:    ntlm,
	}
	go t.readLoop()
	return t
}

// readLoop is the single goroutine that reads all incoming TPKT/FastPath packets.
// It replaces the previous callback-chain pattern (StartReadBytes → recvHeader →
// StartReadBytes → recvExtendedHeader → …) which spawned a new goroutine for each
// individual read.  By using a single blocking loop with io.ReadFull, we eliminate
// goroutine creation/destruction overhead on the hot receive path.
func (t *TPKT) readLoop() {
	var hdr [2]byte
	for {
		if _, err := io.ReadFull(t.Conn, hdr[:]); err != nil {
			t.Emit("error", err)
			return
		}

		version := hdr[0]
		if version == FASTPATH_ACTION_X224 {
			// TPKT packet: 4-byte header total (version, reserved, length-hi, length-lo)
			var extHdr [2]byte
			if _, err := io.ReadFull(t.Conn, extHdr[:]); err != nil {
				t.Emit("error", err)
				return
			}
			size := binary.BigEndian.Uint16(extHdr[:])
			if size < 4 {
				t.Emit("error", fmt.Errorf("TPKT: invalid packet size %d", size))
				return
			}
			body := acquireReadBuf(int(size) - 4)
			if _, err := io.ReadFull(t.Conn, body); err != nil {
				t.Emit("error", err)
				return
			}
			t.Emit("data", body)
			releaseReadBuf(body)
		} else {
			// FastPath packet: 2- or 3-byte header
			secFlag := (version >> 6) & 0x3
			length := int(hdr[1])
			slog.Debug("TPKT FastPath", "secFlag", secFlag, "length", length)

			var packetSize int
			if length&0x80 != 0 {
				// Extended 3-byte header: high 7 bits from hdr[1], low 8 from next byte
				var extByte [1]byte
				if _, err := io.ReadFull(t.Conn, extByte[:]); err != nil {
					slog.Error("TPKT recvExtendedFastPathHeader", "err", err)
					return
				}
				leftPart := length & ^0x80
				packetSize = (leftPart<<8) + int(extByte[0]) - 3
			} else {
				packetSize = length - 2
			}

			if packetSize < 0 {
				t.Emit("error", fmt.Errorf("TPKT FastPath: invalid packet size %d", packetSize))
				return
			}
			body := acquireReadBuf(packetSize)
			if _, err := io.ReadFull(t.Conn, body); err != nil {
				slog.Debug("TPKT recvFastPath error", "err", err)
				return
			}
			t.fastPathListener.RecvFastPath(secFlag, body)
			releaseReadBuf(body)
		}
	}
}

func (t *TPKT) StartTLS() error {
	return t.Conn.StartTLS()
}

func (t *TPKT) StartNLA() error {
	// Set a deadline for the entire NLA handshake (TLS + NTLM auth)
	// to prevent hanging indefinitely when the server is slow to respond.
	t.Conn.SetDeadline(time.Now().Add(30 * time.Second))
	defer t.Conn.SetDeadline(time.Time{}) // clear deadline after NLA completes

	slog.Debug("StartNLA: TLS handshake begin")
	err := t.StartTLS()
	if err != nil {
		slog.Error("StartNLA", "start tls failed", err)
		return err
	}
	slog.Debug("StartNLA: TLS handshake complete")
	req := nla.EncodeDERTRequest([]nla.Message{t.ntlm.GetNegotiateMessage()}, nil, nil)
	slog.Debug("StartNLA send", "req", core.Hex(req), "len", len(req))
	_, err = t.Conn.Write(req)
	if err != nil {
		slog.Error("send NegotiateMessage", "err", err)
		return err
	}

	resp := make([]byte, 1024)
	n, err := t.Conn.Read(resp)
	slog.Debug("StartNLA recv", "n", n, "err", err)
	if err != nil {
		return fmt.Errorf("read %s", err)
	} else {
		slog.Debug("StartNLA Read success")
	}
	return t.recvChallenge(resp[:n])
}

func (t *TPKT) recvChallenge(data []byte) error {
	slog.Debug("recvChallenge", "data", core.Hex(data))
	tsreq, err := nla.DecodeDERTRequest(data)
	if err != nil {
		slog.Debug("DecodeDERTRequest", "err", err)
		return err
	}
	slog.Debug("recvChallenge", "tsreq", tsreq)
	// get pubkey
	pubkey, err := t.Conn.TlsPubKey()
	slog.Debug("recvChallenge", "pubkey", core.Hex(pubkey))

	authMsg, ntlmSec := t.ntlm.GetAuthenticateMessage(tsreq.NegoTokens[0].Data)
	t.ntlmSec = ntlmSec

	encryptPubkey := ntlmSec.GssEncrypt(pubkey)
	req := nla.EncodeDERTRequest([]nla.Message{authMsg}, nil, encryptPubkey)
	slog.Debug("recvChallenge", "send", core.Hex(req), "len", len(req))
	_, err = t.Conn.Write(req)
	if err != nil {
		slog.Error("send AuthenticateMessage", "err", err)
		return err
	}

	slog.Debug("recvChallenge read challenge start")
	resp := make([]byte, 1024)
	n, err := t.Conn.Read(resp)
	if err != nil {
		slog.Error("recvChallenge", "err", err)
		return fmt.Errorf("read %s", err)
	}

	return t.recvPubKeyInc(resp[:n])
}

func (t *TPKT) recvPubKeyInc(data []byte) error {
	slog.Debug("recvPubKeyInc", "data", core.Hex(data), "len", len(data))
	tsreq, err := nla.DecodeDERTRequest(data)
	if err != nil {
		slog.Debug("DecodeDERTRequest", "err", err)
		return err
	}
	slog.Debug("PubKeyAuth", "key", core.Hex(tsreq.PubKeyAuth))
	//ignore
	pubkey := t.ntlmSec.GssDecrypt([]byte(tsreq.PubKeyAuth))
	slog.Debug("GssDecrypy", "pubkey", core.Hex(pubkey))
	domain, username, password := t.ntlm.GetEncodedCredentials()
	credentials := nla.EncodeDERTCredentials(domain, username, password)
	authInfo := t.ntlmSec.GssEncrypt(credentials)
	req := nla.EncodeDERTRequest(nil, authInfo, nil)
	_, err = t.Conn.Write(req)
	if err != nil {
		slog.Debug("send AuthenticateMessage", "err", err)
		return err
	}

	return nil
}

func (t *TPKT) Read(b []byte) (n int, err error) {
	return t.Conn.Read(b)
}

func (t *TPKT) Write(data []byte) (n int, err error) {
	buf := writePool.Get().([]byte)
	size := uint16(len(data) + 4)
	buf = append(buf[:0], FASTPATH_ACTION_X224, 0, byte(size>>8), byte(size))
	buf = append(buf, data...)
	n, err = t.Conn.Write(buf)
	writePool.Put(buf[:0])
	return
}

func (t *TPKT) Close() error {
	return t.Conn.Close()
}

func (t *TPKT) SetFastPathListener(f core.FastPathListener) {
	t.fastPathListener = f
}

func (t *TPKT) SendFastPath(secFlag byte, data []byte) (n int, err error) {
	buf := writePool.Get().([]byte)
	hdr := uint16(len(data)+3) | 0x8000
	buf = append(buf[:0], FASTPATH_ACTION_FASTPATH|((secFlag&0x3)<<6), byte(hdr>>8), byte(hdr))
	buf = append(buf, data...)
	n, err = t.Conn.Write(buf)
	writePool.Put(buf[:0])
	return
}

