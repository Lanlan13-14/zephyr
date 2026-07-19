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

test('connection modal exposes TELNET in protocol select and filter', () => {
    assert.match(appHtml, /id="connProtocol"[\s\S]*?<option>TELNET<\/option>/);
    assert.match(appHtml, /id="protocolFilter"[\s\S]*?<option value="TELNET">TELNET<\/option>/);
    assert.match(appHtml, /id="telnetPlaintextBanner"/);
    assert.match(appHtml, /Telnet 未加密/);
});

test('frontend no longer hard-blocks Telnet connect', () => {
    assert.doesNotMatch(appJs, /当前版本尚未启用 Telnet transport/);
    assert.doesNotMatch(appJs, /telnetBlocked\s*=\s*String\(\$\('#connProtocol'\)/);
    assert.match(appJs, /protocol === 'TELNET'/);
    assert.match(appJs, /telnetPlaintextBanner/);
});

test('style defines plaintext Telnet banner', () => {
    assert.match(styleCss, /\.telnet-plaintext-banner\s*\{/);
});

test('server wires TELNET on create/test/ws and no longer rejects transient Telnet', () => {
    assert.match(serverJs, /require\('\.\/telnet-transport'\)/);
    assert.match(serverJs, /protocol === 'TELNET'/);
    assert.match(serverJs, /dialTelnet\(/);
    assert.match(serverJs, /filterIac\(/);
    assert.match(serverJs, /sendNaws\(/);
    assert.doesNotMatch(serverJs, /Telnet 临时连接请使用 worker ticket 路径/);
    assert.doesNotMatch(serverJs, /telnet_unsupported/);
    // default port for TELNET on create
    assert.match(serverJs, /protocolDefaultPort/);
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
