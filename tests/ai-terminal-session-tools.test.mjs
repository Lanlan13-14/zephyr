import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import terminalTools from '../ai-terminal-session-tools.js';

function harness(protocol = 'TELNET') {
  const writes = [];
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.write = (data) => { writes.push(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)); };
  const stream = new EventEmitter();
  stream.writable = true;
  stream.write = (data) => { writes.push(String(data)); };
  const session = {
    id: 'session-1', userId: 'u1', username: 'alice', protocol,
    connectionId: 'conn-1', connectionConfig: { id: 'conn-1', name: 'box', host: '10.0.0.1', port: protocol === 'TELNET' ? 23 : 22, username: 'ops' },
    telnetSocket: protocol === 'TELNET' ? socket : null,
    telnetDecoder: protocol === 'TELNET' ? { encode: (text) => Buffer.from(text, 'utf8') } : null,
    sshStream: protocol === 'SSH' ? stream : null,
    outputBuffer: ['boot\nlogin: '], pty: { cols: 80, rows: 24 }, createdAt: 1, lastActive: 2, closed: false,
  };
  let historyText = 'boot\nlogin: ';
  const sessions = new Map([[session.id, session]]);
  const history = { replayTail() { return { data: historyText, bytes: historyText.length, truncated: false }; } };
  return { user: { userId: 'u1', username: 'alice' }, session, sessions, history, writes, setHistory: (text) => { historyText = text; } };
}

test('terminal session tools enforce ownership and support TELNET send/read', () => {
  const h = harness('TELNET');
  const read = terminalTools.readSession(h.sessions, h.history, h.user, { sessionId: 'session-1', maxChars: 4000 });
  assert.equal(read.protocol, 'TELNET');
  assert.match(read.text, /login:/);
  const sent = terminalTools.sendSession(h.sessions, h.history, h.user, { sessionId: 'session-1', text: 'alice' });
  assert.equal(sent.sentChars, 6);
  assert.deepEqual(h.writes, ['alice\n']);
  assert.throws(() => terminalTools.readSession(h.sessions, h.history, { userId: 'u2', username: 'bob' }, { sessionId: 'session-1' }), (error) => error.status === 404);
});

test('terminal wait matches text and returns latest timeout snapshot', async () => {
  const h = harness('SSH');
  setTimeout(() => h.setHistory('boot\nservice ready\n$ '), 60);
  const matched = await terminalTools.waitSession(h.sessions, h.history, h.user, { sessionId: 'session-1', pattern: 'READY', timeoutMs: 1000, pollMs: 20, maxChars: 4000 });
  assert.equal(matched.matched, true);
  assert.match(matched.session.text, /service ready/);
  const timeout = await terminalTools.waitSession(h.sessions, h.history, h.user, { sessionId: 'session-1', pattern: 'never-here', timeoutMs: 100, pollMs: 20, maxChars: 4000 });
  assert.equal(timeout.matched, false);
  assert.match(timeout.session.text, /service ready/);
});

test('invalid wait regex is rejected before polling', async () => {
  const h = harness('SSH');
  await assert.rejects(() => terminalTools.waitSession(h.sessions, h.history, h.user, { sessionId: 'session-1', pattern: '[', regex: true }), (error) => error.code === 'invalid_wait_pattern');
});
