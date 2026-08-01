import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const terminalJs = fs.readFileSync(new URL('../public/terminal.js', import.meta.url), 'utf8');
const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('websocket close detaches SSH instead of destroying the PTY', () => {
  assert.match(server, /cleanup\(\{\s*destroySsh:\s*false,\s*reason:\s*'ws-close'\s*\}\)/);
  assert.match(server, /function attachSshSession/);
  assert.match(server, /SSH_DETACHED_SESSION_TTL_MS/);
  assert.match(server, /detached-ttl/);
});

test('attach replays canonical framebuffer before ready', () => {
  const start = server.indexOf('async function attachSshSession');
  assert.ok(start > 0);
  const end = server.indexOf('function execDockerStream', start);
  const body = server.slice(start, end);
  const replayIdx = body.indexOf("type: 'data'");
  const readyIdx = body.indexOf("type: 'ready'");
  assert.ok(replayIdx > 0 && readyIdx > replayIdx, 'replay data must be sent before ready');
  assert.match(body, /terminalSnapshot\?\.serialize/);
  assert.match(body, /replayKind\s*=\s*'snapshot'/);
  assert.match(body, /replay:\s*true/);
  assert.match(body, /attached:\s*true/);
});

test('connect message reuses requested sessionId for resume', () => {
  assert.match(server, /const requestedSessionId = String\(msg\.sessionId \|\| msg\.terminalSessionId \|\| msg\.tabId/);
  assert.match(server, /attachSshSession\(existingSession,\s*\{\s*replay:\s*true\s*\}\)/);
  assert.match(terminalJs, /sessionId:\s*params\.tabId \|\| params\.sessionId \|\| params\.connectionId/);
  assert.match(appJs, /sessionId:\s*tabId/);
});
