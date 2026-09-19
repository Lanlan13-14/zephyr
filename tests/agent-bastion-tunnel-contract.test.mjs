import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('Agent bastion lane rides the Link tunnel kind exclusively', () => {
    const codec = read('link-v2-codec.js');
    assert.match(codec, /AGENT_TUNNEL: 16/);
    assert.match(codec, /AGENT_TUNNEL\]: CHANNEL\.AGENT_TUNNEL/);
    // Both registries must agree on the channel name.
    const go = read('zephyr-link/internal/codec/codec.go');
    assert.match(go, /KindAgentTunnel\s*=\s*16/);
    assert.match(go, /ChannelAgentTunnel\s+Channel\s*=\s*"agent-tunnel"/);
});

test('server routes agent-type proxies through the encrypted Link lane', () => {
    const server = read('server.js');
    assert.match(server, /openAgentBastionConnection/);
    // The agent lane must demand an attested Link session before dialing.
    assert.match(server, /linkSessionId/);
    assert.match(server, /linkTunnelAttach/);
    assert.match(server, /linkTunnelDial/);
    // Bastion capability gating stays owner-scoped and opt-in.
    assert.match(server, /bastionEnabled !== true/);
});

test('Agent tunnel hub is served by the embedded Go runtime', () => {
    const go = read('zephyr-link/internal/link/tunnel.go');
    assert.match(go, /KindAgentTunnel/);
    assert.match(go, /tunnelMaxDataBytes/);
    const node = read('zephyr-link/internal/link/node.go');
    assert.match(node, /\/link\/tunnel\/start/);
});

test('hello carries linkSessionId for the bastion lane', () => {
    const dart = read('zephyr_agent/lib/agent/agent_controller.dart');
    assert.match(dart, /'linkSessionId': _linkRuntime\.sessionId/);
    const mgr = read('file-agent-manager.js');
    assert.match(mgr, /linkSessionId/);
    assert.match(mgr, /validateBoundedString\(hello\.linkSessionId, 128\)/);
});

test('ZFT2 data plane migrates onto the encrypted Link lane', () => {
    const mgr = read('file-agent-manager.js');
    // Registration moves the Agent's file frames onto the lane automatically.
    assert.match(mgr, /_attachAgentLinkLane/);
    assert.match(mgr, /callBinaryV2|linkTunnelDial/, 'lane transport present');
    // One send path: lane when attached, legacy WS otherwise — never both.
    assert.match(mgr, /_sendZft2\(frame/);
    // The connection exposes the lane state for gating and diagnostics.
    assert.match(mgr, /attachLinkLane\(socket\)/);
    const go = read('zephyr-link/internal/link/tunnel.go');
    assert.match(go, /Lane string `json:"lane,omitempty"`/);
    assert.match(go, /DialZft2Lane/);
    // The Agent host bridges lanes onto a loopback socket for the dispatcher.
    assert.match(go, /ServeZft2Local/);
    const dart = read('zephyr_agent/lib/agent/zft2_link_lane.dart');
    assert.match(dart, /link\/zft2\/stream/);
    // Replies from the dispatcher keep the lane id prefix.
    const controller = read('zephyr_agent/lib/agent/agent_controller.dart');
    assert.match(controller, /_handleZft2Frame\(frame, laneId: laneId\)/);
    assert.match(controller, /'zft2Lane': _linkRuntime\.ready/);
});

test('Agent receives bastion activity notifications for UI feedback without mutating tunnel pipe', () => {
    const mgr = read('file-agent-manager.js');
    assert.match(mgr, /notifyBastionActivity\(agentId, info = \{\}\)/);
    assert.match(mgr, /type: 'bastion_activity'/);
    const server = read('server.js');
    assert.match(server, /notifyBastionActivity/);
    assert.match(server, /event: 'open'/);
    assert.match(server, /event: 'close'/);
    const controller = read('zephyr_agent/lib/agent/agent_controller.dart');
    assert.match(controller, /case 'bastion_activity':/);
    assert.match(controller, /_handleBastionActivity/);
    assert.match(controller, /bastionCount/);
    assert.match(controller, /bastionActiveCount/);
    assert.match(controller, /bastionBytes/);
    const home = read('zephyr_agent/lib/screens/home_screen.dart');
    assert.match(home, /_bastionStatsGroup/);
    assert.match(home, /s\.groupBastion/);
    assert.match(home, /s\.bastionActive/);
});
