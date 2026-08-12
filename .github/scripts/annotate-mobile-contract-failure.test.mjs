import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  extractPublicDiagnostics,
  sanitizePublicText,
} from './annotate-mobile-contract-failure.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(scriptDirectory, 'annotate-mobile-contract-failure.mjs');
const repositoryRoot = resolve(scriptDirectory, '..', '..');

test('publishes the first multiline TAP root cause before a bounded cascade', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mobile-annotation-'));
  const logPath = join(directory, 'contracts.log');
  const summaryPath = join(directory, 'summary.md');
  const rawLog = [
    'TAP version 13',
    'not ok 1 - boot the server with mobile v1 mounted',
    '  ---',
    "  failureType: 'testCodeFailure'",
    '  error: |-',
    '    server exited before health check (code=1, signal=null)',
    '    platform=linux node=v22.18.0 pid=1234',
    '    --- server output ---',
    "    Error: Cannot find module '/home/runner/work/Zephyr/node_modules/native.node' password=hunter2 token=token-value canary=CI_CANARY_DO_NOT_LEAK",
    '        at /home/runner/work/Zephyr/server.js:1:1',
    "  code: 'ERR_ASSERTION'",
    "  name: 'Error'",
    "  location: 'C:\\Users\\alice\\Zephyr\\mobile.test.mjs:42:1'",
    '  stack: |',
    '    Set-Cookie: session=private-cookie',
    ...Array.from({ length: 12 }, (_, index) => `not ok ${index + 2} - cascade ${index + 1}`),
    '  error: should not replace the first root cause',
    '  code: ERR_CASCADE',
    'RAW_TAIL_MARKER authorization=Basic dXNlcjpwYXNz',
    '1..13',
  ].join('\n');
  await writeFile(logPath, rawLog);
  await writeFile(summaryPath, 'existing summary\n');

  const result = spawnSync(
    process.execPath,
    [scriptPath, '--log', logPath, '--exit', '7', '--platform', 'Linux/X64'],
    {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath },
    },
  );

  assert.equal(result.status, 0);
  const annotations = result.stdout.trim().split('\n');
  assert.ok(annotations.length <= 9, 'GitHub must receive fewer than its ten visible annotations');
  assert.match(annotations[0], /error: server exited before health check/);
  assert.match(annotations[1], /code: ERR_ASSERTION/);
  assert.match(annotations[2], /name: Error/);
  assert.match(annotations[3], /failureType: testCodeFailure/);
  assert.match(annotations[4], /server startup reason/);
  assert.match(annotations[5], /boot the server with mobile v1 mounted/);
  assert.match(result.stdout, /cascade 1/);
  assert.doesNotMatch(result.stdout, /cascade 4|cascade 12|ERR_CASCADE/);
  assert.match(result.stdout, /ERR_ASSERTION/);
  assert.doesNotMatch(result.stdout, /supersecretvalue|hunter2|token-value|CI_CANARY|private-cookie|dXNlcjpwYXNz|alice/i);
  assert.doesNotMatch(result.stdout, /home%2Frunner|RAW_TAIL_MARKER|location|stack|Set-Cookie|Contract suite failed/i);
  assert.match(result.stdout, /\[PATH\]/);
  assert.equal(await readFile(summaryPath, 'utf8'), 'existing summary\n');
});

test('uses a fixed diagnostic when no allowlisted TAP field exists', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mobile-annotation-'));
  const logPath = join(directory, 'contracts.log');
  await writeFile(logPath, 'opaque failure with secret=do-not-publish\n');

  const result = spawnSync(
    process.execPath,
    [scriptPath, '--log', logPath, '--exit', '1', '--platform', 'Linux'],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /no allowlisted diagnostic was available/i);
  assert.doesNotMatch(result.stdout, /do-not-publish|opaque failure/);
});

test('sanitizer redacts common credentials and Unix and Windows paths', () => {
  const sanitized = sanitizePublicText(
    'Authorization: Bearer abc.def password=swordfish key=private canary=sentinel ' +
      'from C:\\Users\\andy\\repo\\test.mjs and /Users/andy/repo/test.mjs',
  );

  assert.doesNotMatch(sanitized, /abc\.def|swordfish|private|sentinel|andy/i);
  assert.match(sanitized, /\[REDACTED\]/);
  assert.match(sanitized, /\[PATH\]/);
});

test('extractor ignores arbitrary tail, stack, location, expected and actual fields', () => {
  const diagnostics = extractPublicDiagnostics([
    'not ok 1 - equality contract',
    "  error: 'values differ'",
    "  expected: 'secret expected value'",
    "  actual: 'secret actual value'",
    "  location: '/private/work/test.mjs:2:1'",
    '  stack: secret stack value',
    'arbitrary tail secret value',
  ].join('\n'));

  assert.deepEqual(diagnostics.tests, ['equality contract']);
  assert.deepEqual(diagnostics.reasons, ['error: values differ']);
});

test('extractor publishes no arbitrary multiline server output without an allowlisted cause', () => {
  const diagnostics = extractPublicDiagnostics([
    'not ok 1 - server contract',
    '  error: |-',
    '    server exited before health check (code=1, signal=null)',
    '    --- server output ---',
    '    arbitrary user-controlled output password=do-not-publish',
    '    request body: super-private-payload',
    "  code: 'ERR_TEST_FAILURE'",
  ].join('\n'));

  assert.deepEqual(diagnostics.reasons, [
    'error: server exited before health check (code=1, signal=null)',
    'code: ERR_TEST_FAILURE',
  ]);
  assert.doesNotMatch(diagnostics.reasons.join(' '), /do-not-publish|super-private-payload/);
});

test('mobile workflow runs the sanitizer contract and preserves npm test status', async () => {
  const workflow = await readFile(
    join(repositoryRoot, '.github', 'workflows', 'zephyr-one-mobile.yml'),
    'utf8',
  );
  const contractsJob = workflow.split(/^  android:/m, 1)[0];

  assert.match(contractsJob, /node "\$GITHUB_WORKSPACE\/\.github\/scripts\/annotate-mobile-contract-failure\.test\.mjs"/);
  assert.match(contractsJob, /annotate-mobile-contract-failure\.mjs/);
  assert.match(contractsJob, /npm test 2>&1 \| tee \/tmp\/mobile-contracts\.log \|\| status=\$\?/);
  assert.match(contractsJob, /exit "\$status"/);
  assert.doesNotMatch(contractsJob, /annotate-build-failure\.sh/);
});
