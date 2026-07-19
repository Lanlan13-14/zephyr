import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const js = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('app automatically restores workspace after connections load', () => {
  assert.match(js, /await loadConnections\(\);[\s\S]*await restoreLastWorkspace\(\);/);
  assert.match(js, /\/api\/me\/workspaces\/\$\{encodeURIComponent\(automaticWorkspaceId\(\)\)\}\/restore/);
});

test('workspace state contains tabs, order, minimized and active view', () => {
  assert.match(js, /function collectWorkspaceState\(\)/);
  assert.match(js, /minimized:\s*!!t\.minimized/);
  assert.match(js, /order:\s*index/);
  assert.match(js, /active:\s*t\.id === activeTerminalTab/);
  assert.match(js, /activeView:\s*currentAppView/);
});

test('workspace autosaves and excludes transient tabs', () => {
  assert.match(js, /filter\(\(t\) => t\.connectionId && !t\.transient\)/);
  assert.match(js, /scheduleWorkspaceSave\('terminal-tabs'\)/);
  assert.match(js, /addEventListener\('pagehide'/);
  assert.match(js, /keepalive:\s*true/);
});

test('automatic workspace is isolated per client id', () => {
  assert.match(js, /function automaticWorkspaceId\(\)/);
  assert.match(js, /auto-\$\{String\(workspaceClientId/);
});
