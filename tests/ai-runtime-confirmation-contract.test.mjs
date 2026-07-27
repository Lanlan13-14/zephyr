import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridge = readFileSync(path.join(root, 'ai-runtime-bridge.js'), 'utf8');
const app = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const server = readFileSync(path.join(root, 'server.js'), 'utf8');
const host = readFileSync(path.join(root, 'zephyr-ai/internal/tool/platform/host.go'), 'utf8');
const loop = readFileSync(path.join(root, 'zephyr-ai/internal/agent/loop.go'), 'utf8');

test('runtime auto-confirm settings cross browser, Node bridge and Go', () => {
  assert.match(app, /autoConfirm:\s*!!aiCfg\.sensitive\?\.autoConfirm/);
  assert.match(server, /autoConfirm:\s*!!ai\.sensitive\?\.autoConfirm/);
  assert.match(bridge, /autoConfirm:\s*!!payload\.autoConfirm/);
  assert.match(loop, /cfg\.AutoConfirm/);
});

test('runtime approval is bound to the exact platform tool', () => {
  assert.match(host, /Confirmed:\s*confirmedCallFromContext\(ctx, d\.Name\)/);
  assert.match(loop, /w\.permissionApproved = !w\.t\.ReadOnly\(\) && \(autoApproved \|\| dec == permission\.Allow\)/);
  assert.match(loop, /execCtx = platform\.WithConfirmedCall\(ctx, w\.call\.Name\)/);
  assert.match(loop, /works\[wi\]\.permissionApproved = true/);
  assert.match(bridge, /confirmedToolId:\s*confirmed \? String\(toolName\) : ''/);
});
