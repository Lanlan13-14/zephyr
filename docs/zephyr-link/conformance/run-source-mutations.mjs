import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, 'reference-adapter-v1.mjs');
const original = fs.readFileSync(sourcePath, 'utf8');
const mutations = [
  {
    id: 'device-proof-removed',
    find: "if (authenticatedDeviceId && legacy.deviceId && legacy.deviceId !== authenticatedDeviceId) return { error: 'device_proof_invalid' };",
    replace: '/* mutation: device proof intentionally removed */',
    witness: { file: 'sync-envelope-v1.json', id: 'SE-REJECT-002' },
  },
  {
    id: 'kind-check-removed',
    find: "if (legacy.kind !== undefined && legacy.kind !== 1) return { error: 'unsupported_kind' };",
    replace: '/* mutation: kind intentionally ignored */',
    witness: { file: 'sync-envelope-v1.json', id: 'SE-REJECT-005' },
  },
  {
    id: 'double-envelope-accepted',
    find: "if (legacy.body !== undefined) return { error: 'invalid_request' };",
    replace: '/* mutation: mixed envelopes accepted */',
    witness: { file: 'sync-envelope-v1.json', id: 'SE-REJECT-003' },
  },
  {
    id: 'deny-overridden-by-allow',
    find: "if (matchesHere.some((rule) => rule.effect === 'deny')) return 'agent_local_policy_denied';",
    replace: '/* mutation: deny ignored */',
    witness: { file: 'agent-policy-v1.json', id: 'AP-RULE-001' },
  },
  {
    id: 'empty-network-as-wildcard',
    find: "if (input.networkTarget && !(rule.networkTargets || []).includes(input.networkTarget)) return false;",
    replace: '/* mutation: empty network list treated as wildcard */',
    witness: { file: 'agent-policy-v1.json', id: 'AP-DENY-007' },
  },
  {
    id: 'quota-zero-ignored',
    find: 'if (ceiling === 0) return \'agent_quota_exceeded\';',
    replace: '/* mutation: explicit zero quota ignored */',
    witness: { file: 'agent-policy-v1.json', id: 'AP-RULE-006' },
  },
  {
    id: 'approval-bypass',
    find: 'if (highRisk && (!input.confirmed || input.confirmationHashMismatch)) return \'approval_required\';',
    replace: '/* mutation: high-risk approval bypassed */',
    witness: { file: 'agent-policy-v1.json', id: 'AP-DENY-011' },
  },
  {
    id: 'etag-as-plain-overwrite',
    find: 'if (successful.length !== 1) return { allowed: false, reason: \'reject_server_not_B2\' };',
    replace: '/* mutation: multiple CAS winners accepted */',
    witness: { file: 'webdav-writers-v1.json', id: 'WD-CAS-002' },
  },
  {
    id: 'webdav-without-conditions-allowed',
    find: "if (!strongEtag || !conditionalWrite) return 'B1';",
    replace: "if (!strongEtag || !conditionalWrite) return writers > 1 ? 'B2' : 'B1';",
    witness: { file: 'webdav-writers-v1.json', id: 'WD-CAP-003' },
  },
  {
    id: 'protocol-version-guess',
    find: 'if (![1, 2].includes(envelopeVersion)) return { error: \'unsupported_protocol_version\' };',
    replace: '/* mutation: any envelope version accepted */',
    witness: { file: 'sync-envelope-v1.json', id: 'SE-BOUNDARY-010' },
  },
  {
    id: 'default-allow-without-explicit-effect',
    find: "effect: input.localEffect || 'deny',",
    replace: "effect: input.localEffect || 'allow',",
    witness: { file: 'agent-policy-v1.json', id: 'AP-DENY-027' },
  },
  {
    id: 'reveal-secret-approval-bypass',
    find: 'if (highRisk && (!input.confirmed || input.confirmationHashMismatch)) return \'approval_required\';',
    replace: '/* mutation: revealSecret approval bypassed */',
    witness: { file: 'agent-policy-v1.json', id: 'AP-DENY-025' },
  },
  {
    id: 'remote-wipe-approval-bypass',
    find: 'if (highRisk && (!input.confirmed || input.confirmationHashMismatch)) return \'approval_required\';',
    replace: '/* mutation: remoteWipe approval bypassed */',
    witness: { file: 'agent-policy-v1.json', id: 'AP-DENY-026' },
  },
  {
    id: 'idempotency-before-authorization',
    find: "if (input.systemGrantChangedBeforeExecution || !(input.systemOperations || []).includes(input.operation)) return 'system_grant_denied';\n  if (input.retrySameRequest) return 'return_original_receipt';",
    replace: "if (input.retrySameRequest) return 'return_original_receipt';\n  if (input.systemGrantChangedBeforeExecution || !(input.systemOperations || []).includes(input.operation)) return 'system_grant_denied';",
    witness: { file: 'agent-policy-v1.json', id: 'AP-EXEC-009' },
  },
];

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-link-source-mutations-'));
const results = [];
for (const mutation of mutations) {
  if (!original.includes(mutation.find)) {
    results.push({ id: mutation.id, status: 'NOT_APPLICABLE_STALE_MUTATION', witness: mutation.witness, killed: false, error: 'stale mutation cannot be applied' });
    continue;
  }
  const mutantPath = path.join(tempDir, `${mutation.id}.mjs`);
  fs.writeFileSync(mutantPath, original.replace(mutation.find, mutation.replace));
  const adapter = await import(`${pathToFileURL(mutantPath).href}?mutation=${mutation.id}`);
  const cases = JSON.parse(fs.readFileSync(path.join(here, 'cases', mutation.witness.file), 'utf8'));
  const test = cases.find((item) => item.id === mutation.witness.id);
  if (!test) {
    results.push({ id: mutation.id, status: 'MISSING_WITNESS', witness: mutation.witness, killed: false, error: 'required witness case is missing' });
    continue;
  }
  let actual;
  let error = null;
  try {
    if (mutation.witness.file === 'sync-envelope-v1.json') {
      actual = adapter.mapSyncOperation(test.input, { authenticatedDeviceId: test.authenticatedDeviceId, envelopeVersion: test.input.envelopeVersion ?? 1 });
    } else if (mutation.witness.file === 'agent-policy-v1.json') {
      actual = adapter.evaluateAgentPolicy(test);
    } else if (mutation.witness.id === 'WD-CAS-002') {
      actual = adapter.webdavConcurrentCommit({
        baseEtag: test.baseEtag,
        commits: test.commitResults.map((result, index) => ({ writer: test.writers[index], result, etag: test.baseEtag })),
      });
    } else {
      actual = adapter.webdavWriteMode(test);
    }
  } catch (caught) { error = caught.message; }
  const expected = test.expectedError || test.expected;
  const actualValue = actual?.error ?? actual?.allowed ?? actual;
  // Killed means the mutant produces a different result from the contractual expected result.
  // A successful object is not a rejection and can never satisfy a negative vector.
  const killed = actualValue !== expected;
  results.push({
    id: mutation.id,
    witness: mutation.witness.id,
    expected,
    actual: actualValue,
    error,
    killed,
  });
}
const failed = results.filter((result) => !result.killed);
const report = {
  ok: failed.length === 0,
  evidenceType: 'documentation-source-mutation',
  total: results.length,
  killed: results.filter((result) => result.killed).length,
  survived: results.filter((result) => !result.killed).length,
  results,
};
console.log(JSON.stringify(report, null, 2));
if (failed.length) process.exitCode = 1;
assert.ok(results.every((result) => result.killed), 'all intentional source mutations must be killed');
