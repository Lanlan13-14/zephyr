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
