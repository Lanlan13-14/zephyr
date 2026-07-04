package core

import (
	"bufio"
	"crypto/rsa"
	"crypto/tls"
	"encoding/asn1"
	"errors"
	"math/big"
	"net"
	"time"
)

// readBufSize is the size of the buffered reader used for socket reads.
// RDP packets can be large (bitmap updates, channel data); a 64 KiB buffer
// keeps the number of read(2) syscalls low without wasting memory.
const readBufSize = 65536

// tcpRecvBufSize is the OS-level TCP receive socket buffer size.
// The default on most systems (~87 KiB on Linux, ~128 KiB on macOS) is too
// small for high-resolution RDP sessions where the server can burst several
// MiB of bitmap/H.264 data per frame.  512 KiB allows the kernel to buffer
// more in-flight data, reducing stalls when the application goroutine is
// briefly busy decoding a previous frame.
const tcpRecvBufSize = 512 * 1024

type SocketLayer struct {
	conn       net.Conn
	tlsConn    *tls.Conn
	reader     *bufio.Reader // buffers reads regardless of TLS state
	serverName string
}

func NewSocketLayer(conn net.Conn, serverName string) *SocketLayer {
	// Disable Nagle's algorithm so small DVC responses are sent immediately.
	if tc, ok := conn.(*net.TCPConn); ok {
		tc.SetNoDelay(true)
		// Increase the OS receive buffer so the kernel can absorb large bitmap
		// or H.264 bursts without dropping bytes while the decoder is busy.
		// SetReadBuffer is a best-effort hint; ignore errors (e.g. restricted
		// by the OS cap in /proc/sys/net/core/rmem_max on Linux).
		_ = tc.SetReadBuffer(tcpRecvBufSize)
	}
	l := &SocketLayer{
		conn:       conn,
		tlsConn:    nil,
		serverName: serverName,
	}
	l.reader = bufio.NewReaderSize(conn, readBufSize)
	return l
}

func (s *SocketLayer) SetDeadline(t time.Time) error {
	return s.conn.SetDeadline(t)
}

func (s *SocketLayer) Read(b []byte) (n int, err error) {
	return s.reader.Read(b)
}

func (s *SocketLayer) Write(b []byte) (n int, err error) {
	if s.tlsConn != nil {
		return s.tlsConn.Write(b)
	}
	return s.conn.Write(b)
}

func (s *SocketLayer) Close() error {
	if s.tlsConn != nil {
		s.tlsConn.Close() // best-effort; always close the underlying TCP socket
	}
	return s.conn.Close()
}

func (s *SocketLayer) StartTLS() error {
	config := &tls.Config{
		InsecureSkipVerify: true,
		ServerName:         s.serverName,
		MinVersion:         tls.VersionTLS12,
		MaxVersion:         tls.VersionTLS12,
		//		MaxVersion:               tls.VersionTLS13,
	}
	tlsConn := tls.Client(s.conn, config)
	if err := tlsConn.Handshake(); err != nil {
		return err
	}
	s.tlsConn = tlsConn
	// Reset the buffered reader to read from the TLS connection.
	// Reset discards any unconsumed buffered bytes from the plain-text phase,
	// which is correct because the TLS handshake has already consumed them.
	s.reader.Reset(tlsConn)
	return nil
}

type PublicKey struct {
	N *big.Int `asn1:"explicit,tag:0"` // modulus
	E int      `asn1:"explicit,tag:1"` // public exponent
}

func (s *SocketLayer) TlsPubKey() ([]byte, error) {
	if s.tlsConn == nil {
		return nil, errors.New("TLS conn does not exist")
	}
	pub := s.tlsConn.ConnectionState().PeerCertificates[0].PublicKey.(*rsa.PublicKey)
	return asn1.Marshal(*pub)
}
