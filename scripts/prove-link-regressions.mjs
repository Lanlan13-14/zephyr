import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

// CI-only A/B proof. Overlay the new tests on the reviewed baseline and
// require named behavioral tests to fail, not a missing dependency/syntax error.
const root = process.argv[2];
const cases = [
  ['ai', 'tests/ai-run-idempotency.test.mjs', 'identical call ids cannot replay another account result'],
  ['webdav', 'tests/webdav-vault-restore-production.test.mjs', 'missing business services fail closed rather than returning zero-count success'],
  ['agent', 'tests/agent-file-policy-gate.test.mjs', 'real escaping parent symlink'],
];
fs.mkdirSync('.link-evidence', { recursive: true });
for (const [name, file, title] of cases) {
  const result = spawnSync(process.execPath, ['--test', `--test-name-pattern=${title}`, file], { cwd: root, encoding: 'utf8', timeout: 120_000 });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  fs.writeFileSync(`.link-evidence/baseline-${name}.tap`, output);
  process.stdout.write(output);
  if (result.error || result.status === 0 || !output.includes(title) || !/failureType: 'testCodeFailure'/.test(output) || !/AssertionError/.test(output)) {
    throw new Error(`${name}: old implementation did not fail the behavioral assertion as required`);
  }
}
