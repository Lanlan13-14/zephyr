package link

import (
	"net"
	"time"
)

// tuneTCP applies the standard kernel tuning that is safe for an already
// authenticated Link stream. It does not weaken TLS, ZSL/2, enrollment, or
// frame limits; it only removes avoidable per-packet latency and enables
// kernel keepalive detection on long-lived mobile/NAT paths.
func tuneTCP(conn net.Conn) {
	tcp, ok := conn.(*net.TCPConn)
	if !ok {
		return
	}
	_ = tcp.SetNoDelay(true)
	_ = tcp.SetKeepAlive(true)
	_ = tcp.SetKeepAlivePeriod(30 * time.Second)
	_ = tcp.SetReadBuffer(256 * 1024)
	_ = tcp.SetWriteBuffer(256 * 1024)
}
