import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'manifest-v1.json'), 'utf8'));
const cases = {};
const repo = path.resolve(here, '../../..');
for (const script of ['run-conformance.mjs', 'run-source-mutations.mjs', 'verify-conformance.mjs', 'reference-adapter-v1.mjs']) {
  assert.ok(fs.existsSync(path.join(here, script)), `required conformance executable missing: ${script}`);
}
for (const [name, script] of Object.entries(manifest.commands)) {
  const match = script.match(/node\s+(.+)$/);
  assert.ok(match && fs.existsSync(path.join(repo, match[1])), `${name}: missing declared command ${script}`);
}
const gates = fs.readFileSync(path.join(here, '..', 'TESTING-AND-RELEASE-GATES.md'), 'utf8');
for (const command of Object.values(manifest.commands)) assert.ok(gates.includes(command), `release gates omit mandatory command: ${command}`);
const productionContract = fs.readFileSync(path.join(here, 'PRODUCTION-ADAPTER-CONTRACT.md'), 'utf8');
const workflow = fs.readFileSync(path.join(repo, '.github/workflows/zephyr-link.yml'), 'utf8');
for (const branch of ['zephyr-newui', 'zephyr-link-foundation-v1']) assert.ok(workflow.includes(branch), `CI must cover actual branch ${branch}`);
for (const command of Object.values(manifest.commands)) assert.ok(workflow.includes(command), `CI must execute ${command}`);
assert.ok(productionContract.includes('调用栈进入生产业务路径'), 'production adapter contract must require real production call chain review');
const expectedTotal = manifest.minimumVectorIds.syncEnvelope + manifest.minimumVectorIds.agentPolicy + manifest.minimumVectorIds.webdavWriters;
for (const docPath of ['../README.md', '../TESTING-AND-RELEASE-GATES.md']) {
  const doc = fs.readFileSync(path.join(here, docPath), 'utf8');
  assert.ok(doc.includes(`${expectedTotal} 个规范向量`) || doc.includes(`**${expectedTotal}**`), `${docPath}: stale vector total ${expectedTotal}`);
  assert.ok(!doc.includes('221 个规范向量'), `${docPath}: stale vector total from previous baseline`);
}
for (const [name, file] of [['syncEnvelope', 'sync-envelope-v1.json'], ['agentPolicy', 'agent-policy-v1.json'], ['webdavWriters', 'webdav-writers-v1.json']]) {
  cases[name] = JSON.parse(fs.readFileSync(path.join(here, 'cases', file), 'utf8'));
}
for (const [name, minimum] of Object.entries(manifest.minimumVectorIds)) {
  const entries = cases[name];
  assert.ok(entries.length >= minimum, `${name}: regression vector count below minimum ${minimum}`);
  assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length, `${name}: duplicate id`);
  for (const entry of entries) {
    assert.match(entry.id, /^[A-Z]+-[A-Z]+-[0-9]{3}$/, `${name}: malformed id`);
    assert.ok(entry.expected || entry.expectedError || entry.response || entry.operation || entry.responseShape || entry.note, `${entry.id}: no expected outcome`);
  }
}
assert.ok(cases.syncEnvelope.some((entry) => entry.id === 'SE-REJECT-002' && entry.expectedError === 'device_proof_invalid'));
assert.ok(cases.syncEnvelope.some((entry) => entry.id === 'SE-REJECT-003' && entry.expectedError === 'invalid_request'));
assert.ok(cases.syncEnvelope.some((entry) => entry.id === 'SE-BOUNDARY-010' && entry.expectedError === 'unsupported_protocol_version'));
assert.ok(cases.agentPolicy.some((entry) => entry.id === 'AP-DENY-014' && entry.subject !== entry.localSubjects[0]));
assert.ok(cases.agentPolicy.some((entry) => entry.id === 'AP-DENY-015' && entry.channel !== entry.localChannels[0]));
assert.ok(cases.agentPolicy.some((entry) => entry.id === 'AP-EXEC-009' && entry.retrySameRequest && entry.expected === 'system_grant_denied'));
assert.ok(cases.webdavWriters.some((entry) => entry.id === 'WD-CAS-002' && entry.expected === 'reject_server_not_B2'));
const allCaseIds = new Set(Object.values(cases).flat().map((entry) => entry.id));
for (const requiredId of manifest.requiredCaseIds) assert.ok(allCaseIds.has(requiredId), `mandatory anti-bypass case deleted: ${requiredId}`);

const commands = [
  ['reference', 'run-conformance.mjs', (report) => {
    assert.equal(report.evidenceType, 'documentation-reference-adapter');
    assert.equal(report.ok, true);
    assert.equal(report.productEvidence, false);
    assert.equal(report.failures.length, 0);
    assert.equal(report.totalVectors, Object.values(cases).flat().length);
    assert.equal(report.productionRequiredCount > 0, true, 'production obligations must not be silently counted as reference passes');
    assert.equal(report.antiBypassGuardsPassed >= 11, true);
  }],
  ['sourceMutations', 'run-source-mutations.mjs', (report) => {
    assert.equal(report.ok, true);
    assert.equal(report.survived, 0);
    assert.equal(report.total, manifest.requiredSourceMutations);
    assert.equal(report.killed, manifest.requiredSourceMutations);
    assert.ok(report.results.every((entry) => entry.killed === true && !entry.status), 'stale or missing mutation witness must fail the gate');
  }],
];
const reports = {};
for (const [name, script, verify] of commands) {
  const run = spawnSync(process.execPath, [path.join(here, script)], { encoding: 'utf8' });
  assert.equal(run.status, 0, `${name} failed: ${run.stderr || run.stdout}`);
  const report = JSON.parse(run.stdout);
  verify(report);
  reports[name] = report;
}
console.log(JSON.stringify({
  ok: true,
  evidenceType: 'documentation-conformance',
  vectorCounts: Object.fromEntries(Object.entries(cases).map(([name, entries]) => [name, entries.length])),
  totalVectors: Object.values(cases).flat().length,
  referenceValidated: reports.reference.referenceValidated,
  productionRequired: reports.reference.productionRequiredCount,
  antiBypassGuardsPassed: reports.reference.antiBypassGuardsPassed,
  mutationsKilled: reports.sourceMutations.killed,
  productEvidence: false,
}, null, 2));
