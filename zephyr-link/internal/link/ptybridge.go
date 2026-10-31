package link

import "github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/codec"

type PtyBridgeConfig = AIBridgeConfig

// RegisterPtyBridge routes the shared-terminal lane to the live primary PTY service.
// This is a separate kind from AI/control; no credentials or raw upstream handles are exported.
func (n *Node) RegisterPtyBridge(cfg PtyBridgeConfig) error {
	return n.registerBusinessBridge(cfg, codec.KindSharedTerminal)
}
