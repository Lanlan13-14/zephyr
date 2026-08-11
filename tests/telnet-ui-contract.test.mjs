import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appHtml = readFileSync(path.join(root, 'public/app.html'), 'utf8');
const appJs = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const styleCss = readFileSync(path.join(root, 'public/style.css'), 'utf8');
const serverJs = readFileSync(path.join(root, 'server.js'), 'utf8');
const bridgeJs = readFileSync(path.join(root, 'worker-bridge.js'), 'utf8');
const terminalJs = readFileSync(path.join(root, 'public/terminal.js'), 'utf8');

function sourceBetween(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
    return source.slice(start, end);
}

test('connection modal exposes TELNET in protocol select and filter', () => {
    assert.match(appHtml, /id="connProtocol"[\s\S]*?<option>TELNET<\/option>/);
    assert.match(appHtml, /id="protocolFilter"[\s\S]*?<option value="TELNET">TELNET<\/option>/);
    assert.match(appHtml, /id="telnetPlaintextBanner"/);
    assert.match(appHtml, /Telnet 未加密/);
    assert.match(appHtml, /id="connEncoding"/);
    assert.match(appHtml, /id="connEncodingGroup"/);
});

test('frontend keeps password field for TELNET auto-login and submits encoding', () => {
    // Password must NOT be force-hidden for TELNET any more.
    assert.doesNotMatch(appJs, /connPassword.*force-hidden.*TELNET|protocol === 'TELNET' \? '' : \$\{?#connPassword/);
    assert.match(appJs, /connEncodingGroup/);
    assert.match(appJs, /payload\.encoding/);
    assert.match(appJs, /encoding: c\.encoding/);
    assert.match(terminalJs, /encoding: params\.encoding/);
});

test('frontend no longer hard-blocks Telnet connect and keeps route UI available', () => {
    assert.doesNotMatch(appJs, /当前版本尚未启用 Telnet transport/);
    assert.doesNotMatch(appJs, /telnetBlocked\s*=\s*String\(\$\('#connProtocol'\)/);
    assert.match(appJs, /protocol === 'TELNET'/);
    assert.match(appJs, /telnetPlaintextBanner/);
    assert.match(appHtml, /data-route-mode="proxy"[\s\S]*?data-route-mode="jump"/);
    assert.doesNotMatch(appJs, /protocol === 'TELNET' \? 'direct' : \(\$\('#connMode'\)/);
    assert.doesNotMatch(appJs, /advanced-route-panel[^\n]*force-hidden[^\n]*protocol === 'TELNET'/);
});

test('style defines plaintext Telnet banner', () => {
    assert.match(styleCss, /\.telnet-plaintext-banner\s*\{/);
});

test('server wires TELNET on create/test/ws and no longer rejects transient Telnet', () => {
    const createRoute = sourceBetween(
        serverJs,
        "app.post('/api/connections'",
        "app.put('/api/connections/:id'",
    );
    const testRoute = sourceBetween(
        serverJs,
        "app.post('/api/connections/test'",
        "app.post('/api/remote-execute'",
    );
    const testDial = sourceBetween(
        serverJs,
        'async function testTelnetConnection',
        'function testSSHConnection',
    );
    const liveDial = sourceBetween(
        serverJs,
        'async function dialLiveTelnet',
        'function connectSSHClient',
    );
    const wsConnection = serverJs.slice(serverJs.indexOf("wss.on('connection'"));
    const liveTelnetBranch = sourceBetween(
        wsConnection,
        "if (protocol === 'TELNET') {",
        'const routed = await createRoutedSSHConnection(conn, 10000);',
    );

    assert.match(serverJs, /require\('\.\/telnet-transport'\)/);
    assert.match(createRoute, /port:\s*Number\(body\.port\) \|\| protocolDefaultPort\(protocol\)/);
    assert.match(createRoute, /if \(protocol === 'TELNET'\)[\s\S]*?conn\.sshKeyId = '';[\s\S]*?conn\.privateKey = '';/);
    assert.doesNotMatch(createRoute, /\b(?:dialLiveTelnet|dialTelnet|testTelnetConnection)\(/);

    assert.match(testRoute, /protocol === 'TELNET'\s*\? await testTelnetConnection\(conn, timeoutMs\)/);
    assert.doesNotMatch(testRoute, /\b(?:dialLiveTelnet|dialTelnet)\(/);
    assert.match(testDial, /openRoutedTcpConnection\(conn, Number\(conn\.port\) \|\| 23, timeout\)/);
    assert.match(testDial, /negotiateTelnet\(socket\)/);
    assert.match(testDial, /finally[\s\S]*?socket\?\.destroy\?\.\(\)/);

    assert.match(liveDial, /\{ timeout = 10000, cols = 80, rows = 24, signal = null \}/);
    assert.match(liveDial, /waitForSocket\(socket, timeout, '[^']+', signal\)/);
    assert.match(liveTelnetBranch, /createRoutedTcpForward\([\s\S]*?\{ signal: connectController\.signal \}/);
    assert.match(liveTelnetBranch, /socket = await dialLiveTelnet\([\s\S]*?signal: connectController\.signal/);
    assert.match(liveTelnetBranch, /await routedForward\?\.waitForReady\?\.\(\)/);
    assert.match(liveTelnetBranch, /routedTcpForward: routedForward/);
    assert.doesNotMatch(liveTelnetBranch, /\bdialTelnet\(|\bwasm\b|WebAssembly|telnet_unsupported/i);
    assert.match(serverJs, /filterIac\(/);
    assert.match(serverJs, /sendNaws\(/);
    assert.doesNotMatch(serverJs, /Telnet 临时连接请使用 worker ticket 路径/);
    assert.doesNotMatch(serverJs, /telnet_unsupported/);
});

test('worker-bridge issues TELNET tickets instead of blocking', () => {
    assert.doesNotMatch(bridgeJs, /telnet_unsupported/);
    assert.match(bridgeJs, /protocol: proto/);
    assert.match(bridgeJs, /proto !== 'TELNET'/);
});

test('terminal connect envelope carries protocol and recognizes telnet://', () => {
    assert.match(terminalJs, /protocol: params\.protocol/);
    // Source stores the scheme inside a regex literal: telnet:\/\/
    assert.match(terminalJs, /telnet:\\\/\\\//);
});
