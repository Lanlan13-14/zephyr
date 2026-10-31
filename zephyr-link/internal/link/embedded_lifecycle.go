package link

// CloseEmbeddedSessions is for an initiator-only in-process host after its request queue has
// quiesced. It must not be used as a general server shutdown API while tunnels are running.
func (n *Node) CloseEmbeddedSessions() {
	n.mu.Lock()
	defer n.mu.Unlock()
	for _, endpoint := range n.sessions {
		endpoint.Close()
	}
	for _, pending := range n.pending {
		pending.session.Close()
	}
	for _, pending := range n.pendingDial {
		pending.session.Close()
	}
	clear(n.sessions)
	clear(n.pending)
	clear(n.pendingDial)
	clear(n.sessionTLS)
	clear(n.sessionDevice)
	if n.dialClient != nil {
		n.dialClient.CloseIdleConnections()
	}
}
