import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import historyModule from '../terminal-history-service.js';
const { TerminalHistoryService } = historyModule;

function tempService(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-terminal-history-'));
  return { root, service: new TerminalHistoryService({ root, ...options }) };
}

test('journal preserves output bytes and resize events', () => {
  const { root, service } = tempService();
  service.open({ userId: 'u1', sessionId: 's1', connectionId: 'c1', cols: 80, rows: 24 });
  service.appendOutput('u1', 's1', Buffer.from([0x41, 0x00, 0x1b, 0x5b, 0x31, 0x6d]));
  service.appendResize('u1', 's1', 120, 40);
  service.appendOutput('u1', 's1', '你好');
  const records = service.readRecords('u1', 's1');
  assert.deepEqual(records.map(r => r.type), ['output', 'resize', 'output']);
  assert.deepEqual(Buffer.from(records[0].data, 'base64'), Buffer.from([0x41, 0x00, 0x1b, 0x5b, 0x31, 0x6d]));
  assert.equal(records[1].cols, 120);
  assert.equal(records[1].rows, 40);
  assert.equal(Buffer.from(records[2].data, 'base64').toString('utf8'), '你好');
  fs.rmSync(root, { recursive: true, force: true });
});

test('tail replay respects byte limit and survives service restart', () => {
  const { root, service } = tempService({ maxReplayBytes: 1024 });
  service.open({ userId: 'u1', sessionId: 's1' });
  service.appendOutput('u1', 's1', 'AAAA');
  service.appendOutput('u1', 's1', 'BBBB');
  service.appendOutput('u1', 's1', 'CCCC');
  const restarted = new TerminalHistoryService({ root, maxReplayBytes: 1024 });
  assert.equal(restarted.replayTail('u1', 's1', 8).data, 'BBBBCCCC');
  fs.rmSync(root, { recursive: true, force: true });
});

test('journals are isolated by user and session', () => {
  const { root, service } = tempService();
  service.open({ userId: 'u1', sessionId: 'same' });
  service.open({ userId: 'u2', sessionId: 'same' });
  service.appendOutput('u1', 'same', 'one');
  service.appendOutput('u2', 'same', 'two');
  assert.equal(service.replayTail('u1', 'same').data, 'one');
  assert.equal(service.replayTail('u2', 'same').data, 'two');
  fs.rmSync(root, { recursive: true, force: true });
});

test('compaction keeps journal bounded and parseable', () => {
  const { root, service } = tempService({ maxSessionBytes: 1024 * 1024 });
  service.open({ userId: 'u', sessionId: 's' });
  const chunk = 'x'.repeat(32 * 1024);
  for (let i = 0; i < 50; i++) service.appendOutput('u', 's', chunk);
  const file = service._journal('u', 's');
  assert.ok(fs.statSync(file).size <= 1024 * 1024);
  assert.ok(fs.existsSync(`${file}.1`), 'rotation must keep an archived segment');
  assert.ok(service.readRecords('u', 's', { limit: 2000 }).length > 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('TTL cleanup removes journal segments, line index and checkpoints', () => {
  const { root, service } = tempService({ retentionMs: 60_000 });
  service.open({ userId: 'u', sessionId: 'old', createdAt: 1 });
  service.appendOutput('u','old','data');
  const journal=service._journal('u','old');
  fs.writeFileSync(`${journal}.1`,'segment');
  const base=journal.replace(/\.ndjson$/,'');
  fs.writeFileSync(`${base}.lines.ndjson`,'line');
  fs.writeFileSync(`${base}.checkpoint.1.gz`,'cp');
  const meta=JSON.parse(fs.readFileSync(`${base}.meta.json`,'utf8')); meta.updatedAt=1; fs.writeFileSync(`${base}.meta.json`,JSON.stringify(meta));
  assert.equal(service.cleanupExpired(70_000),1);
  assert.equal(fs.existsSync(journal),false);
  assert.equal(fs.existsSync(`${journal}.1`),false);
  assert.equal(fs.existsSync(`${base}.lines.ndjson`),false);
  assert.equal(fs.existsSync(`${base}.checkpoint.1.gz`),false);
  fs.rmSync(root,{recursive:true,force:true});
});

test('Node hash naming is compatible with Go worker journals', () => {
  const { root, service } = tempService();
  const file=service._journal('user/a','session:b');
  const expected=crypto.createHash('sha256').update('user/a:session:b').digest('hex').slice(0,24);
  assert.equal(path.basename(file),`${expected}.ndjson`);
  fs.rmSync(root,{recursive:true,force:true});
});
