import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  COMMAND_DIGEST_DOMAIN,
  summarizeRemoteCommand,
} = require(path.join(root, 'remote-command-audit.js'));
const { projectActivityEvent } = require(path.join(root, 'mobile-v1-server-metadata-entities.js'));

const command = [
  'curl https://example.invalid --password=inline-password-canary',
  'Authorization: Bearer unlabelled-token-canary',
  'export SHELL_SECRET_CANARY=shell-secret-canary; deploy',
].join(' && ');
const canaries = [
  'inline-password-canary',
  'unlabelled-token-canary',
  'SHELL_SECRET_CANARY',
  'shell-secret-canary',
];

test('remote command audit persists only a domain-separated digest, length, target count, and stable result', () => {
  const audit = summarizeRemoteCommand(command, [
    { success: true, status: 'success' },
    { success: false, status: 'timeout', error: command },
  ], 2);
  const expectedDigest = crypto.createHash('sha256')
    .update(COMMAND_DIGEST_DOMAIN, 'utf8')
    .update(command, 'utf8')
    .digest('hex');

  assert.deepEqual(Object.keys(audit).sort(), [
    'commandDigest', 'commandLength', 'errorCode', 'result', 'targetCount',
  ]);
  assert.equal(audit.commandDigest, expectedDigest);
  assert.match(audit.commandDigest, /^[a-f0-9]{64}$/);
  assert.equal(audit.commandLength, Buffer.byteLength(command, 'utf8'));
  assert.equal(audit.targetCount, 2);
  assert.equal(audit.result, 'partial_failure');
  assert.equal(audit.errorCode, 'remote_command_timeout');

  const persistedAuditJson = JSON.stringify({ audit, log: audit });
  for (const canary of canaries) assert.ok(!persistedAuditJson.includes(canary), `audit/log leaked ${canary}`);
});

test('mobile activity projection never reads legacy command/message bodies or heuristic redaction', () => {
  const projected = projectActivityEvent({
    id: 'remote-1',
    userId: 'alice',
    time: 100,
    type: 'remote_command',
    message: command,
    command,
    commandPreview: command.slice(0, 20),
    metadata: { command },
    category: '操作',
    outcome: 'partial_failure',
  }, { userId: 'alice' });

  assert.deepEqual(projected, {
    id: 'remote-1',
    userId: 'alice',
    time: 100,
    message: '远程命令已执行',
    type: 'remote_command',
    category: '操作',
    outcome: 'partial_failure',
    protocol: '',
    connectionId: '',
  });
  const feedAndOutboxJson = JSON.stringify({
    bootstrap: [projected],
    feed: [{ after: projected }],
    outbox: [{ entity: projected }],
  });
  for (const canary of canaries) assert.ok(!feedAndOutboxJson.includes(canary), `mobile feed/outbox leaked ${canary}`);

  const projectionSource = fs.readFileSync(path.join(root, 'mobile-v1-server-metadata-entities.js'), 'utf8');
  assert.doesNotMatch(projectionSource, /redactActivityMessage|MESSAGE_SECRET|MESSAGE_BEARER/);
});

test('remote execution route never persists a command prefix in audit or activity source', () => {
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const start = source.indexOf("app.post('/api/remote-execute'");
  const end = source.indexOf("app.get('/api/proxies'", start);
  const route = source.slice(start, end);
  assert.ok(start >= 0 && end > start, 'remote execution route must be present');
  assert.match(route, /const auditSummary = summarizeRemoteCommand\(commandText, results, targets\.length\)/);
  assert.match(route, /metadata: auditSummary/);
  assert.doesNotMatch(route, /commandText\.slice|String\(command\)\.slice|命令 \$\{command/);
  assert.doesNotMatch(route, /console\.(?:log|info|warn|error)\([^\n]*command/);
});
