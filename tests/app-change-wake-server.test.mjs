import test from 'node:test';
import assert from 'node:assert/strict';
import { TestServer } from './test-server.mjs';

class SseReader {
  constructor(response) {
    this.reader = response.body.getReader();
    this.decoder = new TextDecoder();
    this.buffer = '';
  }

  async nextEvent(timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let boundary = this.buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 2);
        const event = frame.match(/^event: ([^\n]+)$/m)?.[1];
        const id = frame.match(/^id: ([^\n]+)$/m)?.[1];
        const data = frame.match(/^data: (.+)$/m)?.[1];
        if (event && data) return { event, id, data: JSON.parse(data), frame };
        boundary = this.buffer.indexOf('\n\n');
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const result = await Promise.race([
        this.reader.read(),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('SSE event timed out')),
          remaining,
        )),
      ]);
      if (result.done) throw new Error('SSE stream ended before the expected event');
      this.buffer += this.decoder.decode(result.value, { stream: true }).replaceAll('\r\n', '\n');
    }
    throw new Error('SSE event timed out');
  }

  async expectClosed(timeoutMs = 10_000) {
    const result = await Promise.race([
      this.reader.read(),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('SSE stream did not close')),
        timeoutMs,
      )),
    ]);
    assert.equal(result.done, true, 'a revoked stream must close instead of receiving another frame');
  }
}

test('real server requires the app cookie and wakes another browser tab after a Web commit', { timeout: 120_000 }, async (t) => {
  const server = new TestServer();
  t.after(() => server.cleanup());
  const previousBuiltinSqlite = process.env.ZEPHYR_ONE_USE_BUILTIN_SQLITE;
  process.env.ZEPHYR_ONE_USE_BUILTIN_SQLITE = '1';
  try {
    await server.start();
  } finally {
    if (previousBuiltinSqlite === undefined) delete process.env.ZEPHYR_ONE_USE_BUILTIN_SQLITE;
    else process.env.ZEPHYR_ONE_USE_BUILTIN_SQLITE = previousBuiltinSqlite;
  }
  const unauthenticated = await fetch(server.url('/api/me/change-wake'));
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json()).code, 'app_session_expired');

  const { cookie } = await server.bootstrapAdmin('app-change-wake-test-pass');
  const abort = new AbortController();
  t.after(() => abort.abort());
  const stream = await fetch(server.url('/api/me/change-wake'), {
    headers: { cookie },
    signal: abort.signal,
  });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type') || '', /^text\/event-stream/);
  assert.equal(stream.headers.get('cache-control'), 'no-store, no-transform');
  const reader = new SseReader(stream);
  const connected = await reader.nextEvent();
  assert.equal(connected.data.reason, 'connected');
  assert.deepEqual(connected.data.entityTypes, []);
  const initialSequence = connected.data.sequence;
  assert.ok(Number.isSafeInteger(initialSequence) && initialSequence >= 0);

  const created = await server.api(cookie, 'POST', '/api/notes', {
    id: 'server-sse-note',
    title: 'Server SSE note',
    content: 'SERVER_SSE_SECRET_CANARY',
  });
  assert.equal(created.status, 200);

  const change = await reader.nextEvent();
  assert.equal(change.event, 'change');
  assert.deepEqual(Object.keys(change.data).sort(), ['entityTypes', 'reason', 'sequence']);
  assert.equal(change.data.reason, 'change');
  assert.ok(change.data.entityTypes.includes('note'));
  assert.ok(change.data.sequence > initialSequence);
  assert.equal(Number(change.id), change.data.sequence);
  assert.doesNotMatch(change.frame, /server-sse-note|Server SSE note|SERVER_SSE_SECRET_CANARY|entityId|payload|fieldMask/);

  const logout = await server.api(cookie, 'POST', '/api/auth/logout');
  assert.equal(logout.status, 200);
  await reader.expectClosed();

  const { cookie: controlCookie } = await server.login('admin', 'app-change-wake-test-pass');
  const revokedSession = await server.login('admin', 'app-change-wake-test-pass');
  const revokedAbort = new AbortController();
  t.after(() => revokedAbort.abort());
  const revokedStream = await fetch(server.url('/api/me/change-wake'), {
    headers: { cookie: revokedSession.cookie },
    signal: revokedAbort.signal,
  });
  const revokedReader = new SseReader(revokedStream);
  await revokedReader.nextEvent();
  const sessions = await server.api(controlCookie, 'GET', '/api/me/sessions');
  const targetSession = sessions.body.sessions.find((session) => !session.current);
  assert.ok(targetSession, 'control session can identify another session for revocation');
  const revoked = await server.api(controlCookie, 'DELETE', `/api/me/sessions/${targetSession.id}`);
  assert.equal(revoked.status, 200);
  await revokedReader.expectClosed();

  const createdUser = await server.api(controlCookie, 'POST', '/api/admin/users', {
    username: 'wake-victim', password: 'wake-victim-pass', mustChangePassword: false,
  });
  assert.equal(createdUser.status, 200);
  const victim = await server.login('wake-victim', 'wake-victim-pass');
  const victimAbort = new AbortController();
  t.after(() => victimAbort.abort());
  const victimStream = await fetch(server.url('/api/me/change-wake'), {
    headers: { cookie: victim.cookie },
    signal: victimAbort.signal,
  });
  const victimReader = new SseReader(victimStream);
  await victimReader.nextEvent();
  const deleted = await server.api(controlCookie, 'DELETE', `/api/admin/users/${createdUser.body.user.userId}`, {
    resourcePolicy: 'delete-resources',
  });
  assert.equal(deleted.status, 200);
  await victimReader.expectClosed();
});
