import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const client = readFileSync(new URL('../public/rdp-wasm-client.js', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../public/rdp-worker-bridge.js', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../public/rdp-worker.js', import.meta.url), 'utf8');
const wasmMain = readFileSync(new URL('../rdp-wasm/main.go', import.meta.url), 'utf8');
const resolutionPolicy = readFileSync(new URL('../public/rdp-resolution-policy.js', import.meta.url), 'utf8');

test('live resolution request is exported across page, Worker, and Go WASM', () => {
    assert.match(wasmMain, /Set\("rdpSetResolution", js\.FuncOf\(jsSetResolution\)\)/);
    assert.match(worker, /requiredExports[^\n]+rdpSetResolution/);
    assert.match(bridge, /target\.rdpSetResolution = \(\.\.\.args\) => this\.call\('rdpSetResolution', args\)/);
    assert.match(client, /window\.rdpSetResolution\(size\.width, size\.height\)/);
});

test('RDP stage and mobile fullscreen geometry changes schedule a live resize', () => {
    assert.match(client, /new ResizeObserver\(\(\) => scheduleLiveRdpResize\(\)\)/);
    assert.match(client, /addEventListener\('fullscreenchange', scheduleSettledResize\)/);
    assert.match(client, /visualViewport\?\.addEventListener\?\.\('resize', scheduleSettledResize/);
    assert.match(client, /addEventListener\('orientationchange', scheduleSettledResize/);
});

test('live resize does not mutate a transferred canvas backing store', () => {
    const liveResize = client.slice(client.indexOf('async function applyLiveRdpResize'), client.indexOf('function scheduleLiveRdpResize'));
    assert.doesNotMatch(liveResize, /ensureCanvas\s*\(/);
    assert.doesNotMatch(liveResize, /rdpCanvas\.(?:width|height)\s*=/);
});

test('resize remains locked until ordered ResetGraphics acknowledgement', () => {
    assert.match(worker, /reset-graphics[\s\S]*?rdpOnGraphicsReset|rdpOnGraphicsReset[\s\S]*?reset-graphics/);
    assert.match(client, /window\.rdpOnGraphicsReset = function \(width, height\)/);
    const liveResize = client.slice(client.indexOf('async function applyLiveRdpResize'), client.indexOf('function scheduleLiveRdpResize'));
    assert.match(liveResize, /if \(rdpResizeAwaitingReset\)/);
    assert.match(liveResize, /rdpResizeAwaitingReset = true/);
    assert.doesNotMatch(liveResize, /rdpWidth = size\.width/);
    assert.doesNotMatch(liveResize, /rdpHeight = size\.height/);
});

test('protocol reactivation preserves the in-flight ResetGraphics barrier', () => {
    const ready = client.slice(client.indexOf('window.rdpOnReady = function'), client.indexOf('window.rdpOnGraphicsReset = function'));
    assert.match(ready, /const isReactivation = connected/);
    assert.match(ready, /if \(isReactivation\) \{[\s\S]*?reactivation-ready[\s\S]*?return;[\s\S]*?\}\s*resetLiveRdpResizeState\(\)/);
    assert.match(ready, /resetLiveRdpResizeState\(\);\s*scheduleLiveRdpResize\(\{ delay: 80, resetRetry: true \}\)/);
});

test('resolution tiers use bounded envelopes and resize requests are rate limited', () => {
    assert.match(client, /computeSafeRdpSize\(/);
    assert.match(resolutionPolicy, /'2K'.*longEdge: 2560, shortEdge: 1440/);
    assert.match(resolutionPolicy, /'4K'.*longEdge: 3840, shortEdge: 2160/);
    assert.match(client, /RDP_MIN_RESIZE_INTERVAL_MS = 600/);
    assert.match(client, /sinceLastRequest < RDP_MIN_RESIZE_INTERVAL_MS/);
    assert.doesNotMatch(client, /const resolutions = \[[^\]]*'8K'/);
});

test('resize and preference transitions emit immediate diagnostics', () => {
    assert.match(client, /reportWorkerTelemetry\(0, \{ reason: 'resize-request' \}\)/);
    assert.match(client, /reportWorkerTelemetry\(0, \{ reason: 'graphics-reset' \}\)/);
    assert.match(client, /reportWorkerTelemetry\(0, \{ reason: 'transport-close' \}\)/);
});

test('an acknowledged live resize performs one clean embedded RDP reconnect', () => {
    assert.match(client, /else if \(requested\)[\s\S]*?resize-clean-reconnect/);
    assert.match(client, /resize-clean-reconnect[\s\S]*?scheduleResizeCleanReconnect\(actualWidth, actualHeight\)/);
    assert.match(client, /scheduleResizeCleanReconnect[\s\S]*?rdpTransitionReadyForResize = false[\s\S]*?reconnectWithSettings\(\{/);
    assert.match(client, /generation !== rdpResizeCleanReconnectGeneration \|\| !connected \|\| rdpResizeAwaitingReset \|\| rdpResizeQueued/);
});

test('clean reconnect waits for settled geometry and preserves a pre-resize complete frame', () => {
    assert.match(client, /RDP_RESIZE_RECONNECT_SETTLE_MS = 650/);
    assert.match(client, /rdpResizeCleanReconnectGeneration/);
    assert.match(client, /getRemoteDesktopSnapshotForAi\(\{ maxWidth: 1280, quality: 0\.76 \}\)/);
    const liveResize = client.slice(client.indexOf('async function applyLiveRdpResize'), client.indexOf('function scheduleLiveRdpResize'));
    assert.ok(liveResize.indexOf('showRdpResizeTransitionFrame()') < liveResize.indexOf('window.rdpSetResolution(size.width, size.height)'));
    assert.match(client, /meaningfulUpdates >= 100/);
    assert.match(client, /rdpTransitionFrame && !rdpTransitionReadyForResize/);
});

test('resize reconnect rebuilds Worker and transferred canvas without navigating the iframe', () => {
    assert.doesNotMatch(client, /location\.reload\s*\(/);
    assert.match(client, /async function restartRdpWorkerInPlace\(width, height/);
    assert.match(client, /if \(rdpWorkerRestartPromise\) return rdpWorkerRestartPromise/);
    assert.match(client, /oldBridge\?\.notify\('rdpDisconnect'/);
    assert.match(client, /destroyRdpCanvas\(\);\s*ensureCanvas\(targetWidth, targetHeight\);\s*await initializeRdpWorker\(\)/);
    assert.match(client, /rdpTouchController\?\.destroy/);
    assert.match(client, /rdpInputAbortController\?\.abort/);
    assert.match(client, /new Worker\(RDP_WORKER_URL/);
});
