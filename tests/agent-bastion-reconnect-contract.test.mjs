import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/*
 * "Agent bastion session has no live stream" had three independent causes, one
 * per layer. Each is cheap to reintroduce and expensive to notice (it only
 * shows up after a reconnect on a real device), so each gets a static guard
 * here in addition to the Go behavioural tests in
 * zephyr-link/internal/link/tunnel_reconnect_test.go.
 */

test('the main-end tunnel hub multiplexes Agent sessions instead of pinning one', () => {
    const go = read('zephyr-link/internal/link/tunnel.go');
    // The hub holds a table of sessions, not a single session field.
    assert.match(go, /agents\s+map\[string\]\*mainEndAgent/);
    assert.match(go, /func \(h \*MainEndTunnelHub\) Attach\(sessionID string\) error/);
    assert.match(go, /func \(h \*MainEndTunnelHub\) Detach\(sessionID string\)/);
    assert.match(go, /func \(h \*MainEndTunnelHub\) Attached\(sessionID string\) bool/);
    // Every dial names the Agent it goes through.
    assert.match(go, /func \(h \*MainEndTunnelHub\) DialTunnel\(sessionID, host string, port int\)/);
    assert.match(go, /func \(h \*MainEndTunnelHub\) DialZft2Lane\(sessionID string\)/);
    assert.match(go, /func \(h \*MainEndTunnelHub\) send\(sessionID string, tf tunnelFrame\) error/);
    // The old single-session pinning must not come back.
    assert.doesNotMatch(go, /hub already attached to session/);
    // Inbound frames are routed by the attested session on the frame context,
    // so one Agent can never address another Agent's tunnel ids.
    assert.match(go, /h\.deliver\(ctx\.SessionID, &tf\)/);
    assert.match(go, /func \(h \*MainEndTunnelHub\) deliver\(sessionID string, tf \*tunnelFrame\)/);
});

test('a main-end tunnel remembers which session it rides', () => {
    const go = read('zephyr-link/internal/link/tunnel.go');
    assert.match(go, /type MainEndTunnel struct \{[\s\S]*?session string/);
    assert.match(go, /c\.hub\.send\(c\.session, tunnelFrame\{Tun: c\.id, Op: "close"\}\)/);
});

test('the Go internal dial route requires the session id', () => {
    const main = read('zephyr-link/cmd/zephyr-link-server/main.go');
    assert.match(main, /SessionID string `json:"sessionId"`/);
    assert.match(main, /tunnel_session_required/);
    assert.match(main, /tunnelHub\.DialTunnel\(body\.SessionID, body\.Host, body\.Port\)/);
    assert.match(main, /tunnelHub\.DialZft2Lane\(body\.SessionID\)/);
    assert.match(main, /tunnelHub\.DeviceID\(body\.SessionID\)/);
});

test('the Node front end names the Agent session on every tunnel dial', () => {
    const proxy = read('link-v2-go-proxy.js');
    assert.match(proxy, /async function linkTunnelDial\(sessionId, host_, port_/);
    assert.match(proxy, /tunnel_session_required/);
    assert.match(proxy, /JSON\.stringify\(\{ sessionId: session, host: host_, port: port_, lane \}\)/);

    const server = read('server.js');
    // The bastion lane dials through the session it just attached.
    assert.match(server, /linkTunnelDial\(linkSessionId, String\(targetHost \|\| ''\)/);
    // Swallowing an attach conflict is what let a dial land on a dead session:
    // the attach failed, the error was matched away, and the dial went out on
    // whichever session the hub had pinned. Ban the swallow, not the words.
    assert.doesNotMatch(server, /\/already attached\/\.test\(/);

    const mgr = read('file-agent-manager.js');
    assert.match(mgr, /this\.linkTunnelDial\(sessionId, '', 0, 12000, 'zft2'\)/);
    assert.doesNotMatch(mgr, /\/already attached\/\.test\(/);
});

test('the Agent tunnel hub is restartable across reconnects', () => {
    const go = read('zephyr-link/internal/link/tunnel.go');
    // Each Start run is stamped, so a dying predecessor cannot tear down the
    // stream its successor just installed.
    assert.match(go, /generation uint64/);
    assert.match(go, /func \(h \*AgentTunnelHub\) closeAll\(generation uint64, reason string\) bool/);
    assert.match(go, /func \(h \*AgentTunnelHub\) readLoop\(generation uint64\)/);
    assert.match(go, /func \(h \*AgentTunnelHub\) writeLoop\(generation uint64\)/);
    // The previous stream is retired explicitly on restart.
    assert.match(go, /prevStream, prevCancel := h\.stream, h\.cancel/);
    assert.match(go, /func \(h \*AgentTunnelHub\) SessionID\(\) string/);
});

test('the Agent restarts its bastion tunnel on each new Link session', () => {
    const dart = read('zephyr_agent/lib/agent/agent_controller.dart');
    // The guard is the session id. A boolean latch stayed true for the life of
    // the process, so the Agent never re-dialed its stream after the first
    // reconnect and the main end saw no live stream.
    assert.match(dart, /String\? _bastionTunnelSessionId;/);
    assert.doesNotMatch(dart, /_bastionTunnelStarted/);
    assert.match(dart, /if \(_bastionTunnelSessionId == sessionId\) return;/);
    assert.match(dart, /_bastionTunnelSessionId = sessionId;/);
    // Dropping the connection clears the latch and the tunnel-up flag.
    assert.match(dart, /_bastionTunnelSessionId = null;[\s\S]{0,120}_linkRuntime\.markTunnelDown\(\);/);
});

test('the Agent host starts the tunnel on the recorded Link peer root', () => {
    const kotlin = read('zephyr_agent/android_host/EmbeddedLinkApi.kt');
    // The Go core appends "/stream" to the peer, and the main end only routes
    // that upgrade at /api/link/v2/stream. Handing it the bare server URL
    // dialed an unrouted path, so the Agent never attached its stream.
    assert.match(kotlin, /private fun linkPeerRoot\(serverUrl: String\): String/);
    assert.match(kotlin, /if \(trimmed\.endsWith\("\/api\/link\/v2"\)\) trimmed else "\$trimmed\/api\/link\/v2"/);
    assert.match(kotlin, /val peerRoot = linkPeerRoot\(serverUrl\)/);
    // tunnelStart prefers the peer recorded at dial time (the pre-resolved IP
    // form whose SNI the Go sessionTLS table remembers).
    assert.match(kotlin, /val resolvedPeer = this\.peerUrl \?: linkPeerRoot\(peerUrl\)/);
});

test('the Go tunnel stream dials the peer leaf the main end actually routes', () => {
    const go = read('zephyr-link/internal/link/tunnel.go');
    assert.match(go, /streamURL := strings\.TrimSuffix\(peerURL, "\/"\) \+ "\/stream\?sessionId="/);
    const node = read('zephyr-link/internal/link/node.go');
    assert.match(node, /n\.mux\.HandleFunc\("\/link\/stream", n\.handleStream\)/);
    assert.match(node, /n\.mux\.HandleFunc\("\/stream", n\.handleStream\)/);
    // The main end's WebSocket upgrade table must expose that leaf.
    const server = read('server.js');
    assert.match(server, /pathname === '\/api\/link\/v2\/stream'/);
});

test('the Agent stream handshake is RFC 6455 so Node ws will accept it', () => {
    const stream = read('zephyr-link/internal/link/stream.go');
    const tunnel = read('zephyr-link/internal/link/tunnel.go');
    // Node's `ws` keyRegex is /^[+/0-9A-Za-z]{22}==$/. The old printable
    // "zephyr-link-<ts>" key never matched, so the public upgrade 400'd and
    // the Agent never attached — "session has no live stream".
    assert.match(tunnel, /key, err := newWSClientKey\(\)/);
    assert.doesNotMatch(tunnel, /zephyr-link-%d/);
    // Accept must be standard base64; RawURLEncoding is what Node's ws
    // client (the reverse-proxy hop onto handleStream) rejects.
    assert.match(stream, /base64\.StdEncoding\.EncodeToString\(h\[:\]\)/);
    assert.doesNotMatch(stream, /RawURLEncoding\.EncodeToString\(h\[:\]\)/);
    // Client frames on the public hop must be masked.
    assert.match(tunnel, /writeClientFrame\(t\.conn, 0x1, env\)/);
});

test('loopback tunnel dial is an HTTP 101 upgrade, not a raw hijack', () => {
    const go = read('zephyr-link/cmd/zephyr-link-server/main.go');
    const js = read('link-v2-go-proxy.js');
    // After the Agent stream attached, the next hop was Node's linkTunnelDial.
    // Go hijacked and copied tunnel bytes with no status line; Node's parser
    // then emitted "Parse Error: Expected HTTP/". Both sides now speak 101.
    assert.match(go, /func writeTunnelUpgrade\(/);
    assert.match(go, /HTTP\/1\.1 101 Switching Protocols/);
    assert.match(go, /Upgrade: tcp/);
    assert.match(js, /Connection: 'Upgrade'/);
    assert.match(js, /Upgrade: 'tcp'/);
    assert.match(js, /req\.on\('upgrade'/);
});
