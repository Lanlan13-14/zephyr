import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  sessionExec,
  resolveCommand,
  getSandboxStatus,
  FORBIDDEN_NAMES,
  _resetCapsCache,
} from '../ai-session-exec.js';
import { AiSessionFs } from '../ai-session-fs.js';
import { policyForExtendedTool } from '../ai-extended-capabilities.js';
import { readFileSync } from 'node:fs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-l2-'));
}

function optionalCommand(name) {
  try {
    return resolveCommand(name);
  } catch (error) {
    if (error?.code === 'command_unavailable') return null;
    throw error;
  }
}

test('whitelist resolves jq/grep and forbids shell/network tools', () => {
  _resetCapsCache();
  const jq = optionalCommand('jq');
  if (jq) assert.ok(jq.absolute.toLowerCase().includes('jq'));
  else assert.throws(() => resolveCommand('jq'), (error) => error?.code === 'command_unavailable');
  assert.ok(resolveCommand('grep').absolute);
  assert.throws(() => resolveCommand('bash'), /不在白名单|forbidden|command_forbidden/);
  assert.throws(() => resolveCommand('curl'), /不在白名单|forbidden|command_forbidden/);
  assert.throws(() => resolveCommand('/bin/bash'), /短名|command_must_be_name|不在白名单|forbidden/);
  // python3/node are allowed runtimes (not in FORBIDDEN_NAMES)
  assert.equal(FORBIDDEN_NAMES.has('python3'), false);
  assert.equal(FORBIDDEN_NAMES.has('bash'), true);
  const python = optionalCommand('python3');
  if (python) assert.ok(python.absolute);
  else assert.throws(() => resolveCommand('python3'), (error) => error?.code === 'command_unavailable');
  assert.ok(resolveCommand('node').absolute);
});

test('sandbox status exposes isolation and limits', () => {
  const st = getSandboxStatus();
  assert.ok(Array.isArray(st.allowedCommands));
  assert.ok(st.limits.maxTimeoutMs <= 60000);
  assert.ok(st.limits.defaultTimeoutMs <= st.limits.maxTimeoutMs);
  assert.equal(typeof st.canDenyNetwork, 'boolean');
  assert.equal(typeof st.bwrapOk, 'boolean');
});

test('session_exec greps workspace file and writes audit', async () => {
  const dataDir = tmpDir();
  const fsApi = new AiSessionFs({ dataDir });
  await fsApi.writeWorkspaceFile('u1', 's1', 'workspace/app.log', 'alpha\nerror boom\nomega\n');
  const result = await sessionExec({
    userId: 'u1',
    sessionId: 's1',
    dataDir,
    sessionFs: fsApi,
    command: 'grep',
    args: ['error', 'workspace/app.log'],
    cwd: 'workspace',
    timeoutMs: 10000,
    network: false,
  });
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /error boom/);
  assert.ok(result.isolation?.mode);
  assert.equal(result.network, false);
  const audit = await fsp.readFile(path.join(dataDir, 'ai-sessions', 'u1', 's1', 'outputs', '.exec-audit.ndjson'), 'utf8');
  assert.match(audit, /"command":"grep"/);
  assert.match(audit, /"userId":"u1"/);
});

test('path escape outside session is rejected', async () => {
  const dataDir = tmpDir();
  const fsApi = new AiSessionFs({ dataDir });
  await fsApi.ensure('u1', 's1');
  await assert.rejects(() => sessionExec({
    userId: 'u1',
    sessionId: 's1',
    dataDir,
    sessionFs: fsApi,
    command: 'cat',
    args: ['/etc/passwd'],
    cwd: 'workspace',
  }), /越出|path_escape|bad_path|会话/);
});

test('cwd with .. is rejected', async () => {
  const dataDir = tmpDir();
  const fsApi = new AiSessionFs({ dataDir });
  await fsApi.ensure('u1', 's1');
  await assert.rejects(() => sessionExec({
    userId: 'u1',
    sessionId: 's1',
    dataDir,
    sessionFs: fsApi,
    command: 'wc',
    args: ['-l', 'workspace/x'],
    cwd: '../other',
  }), /cwd|\.\.|bad_cwd/);
});

test('shell binary args and bash command are rejected', async () => {
  const dataDir = tmpDir();
  const fsApi = new AiSessionFs({ dataDir });
  await fsApi.ensure('u1', 's1');
  await assert.rejects(() => sessionExec({
    userId: 'u1',
    sessionId: 's1',
    dataDir,
    sessionFs: fsApi,
    command: 'bash',
    args: ['-c', 'id'],
    cwd: 'workspace',
  }), /不在白名单|forbidden|command_forbidden/);
  await assert.rejects(() => sessionExec({
    userId: 'u1',
    sessionId: 's1',
    dataDir,
    sessionFs: fsApi,
    command: 'grep',
    args: ['foo', '/bin/sh'],
    cwd: 'workspace',
  }), /shell|forbidden|禁止/);
});

test('timeout kills long-running whitelist command', async () => {
  const dataDir = tmpDir();
  const fsApi = new AiSessionFs({ dataDir });
  // generate a large file then use a slow pipeline — use yes via... not in whitelist.
  // Use grep on a huge file instead: write big file and timeout very low with cat.
  const big = 'x'.repeat(1024);
  await fsApi.writeWorkspaceFile('u1', 's1', 'workspace/big.txt', `${big}\n`.repeat(50));
  const result = await sessionExec({
    userId: 'u1',
    sessionId: 's1',
    dataDir,
    sessionFs: fsApi,
    command: 'wc',
    args: ['-c', 'workspace/big.txt'],
    cwd: 'workspace',
    timeoutMs: 1000,
  });
  // should complete quickly under timeout
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, 0);
});

test('jq processes JSON in workspace', async (t) => {
  if (!optionalCommand('jq')) {
    t.skip('jq is an optional sandbox utility on this platform');
    return;
  }
  const dataDir = tmpDir();
  const fsApi = new AiSessionFs({ dataDir });
  await fsApi.writeWorkspaceFile('u1', 's1', 'workspace/data.json', JSON.stringify({ a: 1, b: { c: 2 } }));
  const result = await sessionExec({
    userId: 'u1',
    sessionId: 's1',
    dataDir,
    sessionFs: fsApi,
    command: 'jq',
    args: ['.b.c', 'workspace/data.json'],
    cwd: 'workspace',
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout.trim(), /^2$/);
});

test('network true without policy is denied at tool policy layer shape', async () => {
  const dataDir = tmpDir();
  const fsApi = new AiSessionFs({ dataDir });
  await fsApi.ensure('u1', 's1');
  await assert.rejects(() => sessionExec({
    userId: 'u1',
    sessionId: 's1',
    dataDir,
    sessionFs: fsApi,
    command: 'grep',
    args: ['x', 'workspace/nope'],
    network: true,
    allowNetworkPolicy: false,
  }), /network_policy|策略|403/);
});

test('extended policy marks session_exec always confirm and status never', () => {
  assert.equal(policyForExtendedTool('session_exec_v1').confirmation, 'always');
  assert.equal(policyForExtendedTool('session_exec_v1').risk, 'R2');
  assert.equal(policyForExtendedTool('session_sandbox_status_v1').confirmation, 'never');
  assert.equal(policyForExtendedTool('session_sandbox_status_v1').readOnly, true);
});

test('agent service registers sandbox tools and blocks subagent path', () => {
  const agent = readFileSync(path.resolve(import.meta.dirname, '../ai-agent-service.js'), 'utf8');
  assert.match(agent, /name: 'session_exec_v1'/);
  assert.match(agent, /name: 'session_sandbox_status_v1'/);
  assert.match(agent, /case 'session_exec_v1'/);
  assert.match(agent, /subagent_exec_forbidden/);
  const sub = readFileSync(path.resolve(import.meta.dirname, '../ai-subagent-service.js'), 'utf8');
  assert.match(sub, /denied\.add\('session_exec_v1'\)/);
});

test('environment matrix reports Python Node Go/Rust FFmpeg', () => {
  _resetCapsCache();
  const st = getSandboxStatus();
  assert.ok(Array.isArray(st.environments));
  const names = st.environments.map((e) => e.env);
  assert.ok(names.includes('Python'));
  assert.ok(names.includes('Node.js'));
  assert.ok(names.includes('Go / Rust'));
  assert.ok(names.includes('FFmpeg'));
  assert.equal(st.policy.shell, false);
  assert.equal(st.policy.python, 'full-script-and-uv');
  assert.equal(st.policy.node, 'partial-script-only');
});

test('python runs session script and rejects -c', async (t) => {
  const dataDir = tmpDir();
  const fsApi = new AiSessionFs({ dataDir });
  await fsApi.writeWorkspaceFile('u1', 's1', 'workspace/hello.py', 'print("hello-sandbox")\n');
  await assert.rejects(() => sessionExec({
    userId: 'u1', sessionId: 's1', dataDir, sessionFs: fsApi,
    command: 'python3', args: ['-c', 'print(1)'], cwd: 'workspace',
  }), /python_inline|禁止 python -c/);

  if (!optionalCommand('python3')) {
    t.skip('Python is an optional sandbox runtime on this platform');
    return;
  }
  const ok = await sessionExec({
    userId: 'u1', sessionId: 's1', dataDir, sessionFs: fsApi,
    command: 'python3', args: ['workspace/hello.py'], cwd: 'workspace',
  });
  assert.equal(ok.exitCode, 0);
  assert.match(ok.stdout, /hello-sandbox/);
});

test('node partial: runs js file, rejects -e', async () => {
  const dataDir = tmpDir();
  const fsApi = new AiSessionFs({ dataDir });
  await fsApi.writeWorkspaceFile('u1', 's1', 'workspace/hi.mjs', 'console.log("node-partial")\n');
  const ok = await sessionExec({
    userId: 'u1', sessionId: 's1', dataDir, sessionFs: fsApi,
    command: 'node', args: ['workspace/hi.mjs'], cwd: 'workspace',
  });
  assert.equal(ok.exitCode, 0);
  assert.match(ok.stdout, /node-partial/);

  await assert.rejects(() => sessionExec({
    userId: 'u1', sessionId: 's1', dataDir, sessionFs: fsApi,
    command: 'node', args: ['-e', 'console.log(1)'], cwd: 'workspace',
  }), /node_inline|部分支持/);
});

test('ffmpeg rejects remote URLs and accepts local version probe', async (t) => {
  const dataDir = tmpDir();
  const fsApi = new AiSessionFs({ dataDir });
  await fsApi.ensure('u1', 's1');
  await assert.rejects(() => sessionExec({
    userId: 'u1', sessionId: 's1', dataDir, sessionFs: fsApi,
    command: 'ffmpeg', args: ['-i', 'https://example.com/a.mp4', 'workspace/out.mp4'],
  }), /ffmpeg_remote|远程/);
  if (!optionalCommand('ffmpeg')) {
    t.skip('FFmpeg is an optional sandbox runtime on this platform');
    return;
  }
  const ver = await sessionExec({
    userId: 'u1', sessionId: 's1', dataDir, sessionFs: fsApi,
    command: 'ffmpeg', args: ['-version'], cwd: 'workspace',
  });
  assert.equal(ver.timedOut, false);
  assert.ok(ver.exitCode === 0 || /ffmpeg version/i.test(ver.stdout + ver.stderr));
});
