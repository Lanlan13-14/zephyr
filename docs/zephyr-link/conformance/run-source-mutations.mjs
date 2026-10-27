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
    find: 'if (requiresApproval(input) && !approvalValid(input)) return \'approval_required\';',
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
    find: 'if (requiresApproval(input) && !approvalValid(input)) return \'approval_required\';',
    replace: '/* mutation: revealSecret approval bypassed */',
    witness: { file: 'agent-policy-v1.json', id: 'AP-DENY-025' },
  },
  {
    id: 'remote-wipe-approval-bypass',
    find: 'if (requiresApproval(input) && !approvalValid(input)) return \'approval_required\';',
    replace: '/* mutation: remoteWipe approval bypassed */',
    witness: { file: 'agent-policy-v1.json', id: 'AP-DENY-026' },
  },
  {
    id: 'listen-host-resource-ignored',
    find: "if (input.listenHost && !(rule.listenHosts || []).includes(input.listenHost)) return false;",
    replace: '/* mutation: listenHost resource constraint ignored */',
    witness: { file: 'agent-policy-v1.json', id: 'AP-DENY-028' },
  },
  {
    id: 'primary-resource-intersection-ignored',
    find: "if (input.networkTarget && authority.networkTargets && !authority.networkTargets.includes(input.networkTarget)) return false;",
    replace: '/* mutation: primary network target intersection ignored */',
    witness: { file: 'agent-policy-v1.json', id: 'AP-DENY-031' },
  },
  {
    id: 'expired-confirmation-accepted',
    find: 'if (!Number.isSafeInteger(approval.expiresAt) || input.now >= approval.expiresAt) return false;',
    replace: '/* mutation: expired confirmation accepted */',
    witness: { file: 'agent-policy-v1.json', id: 'AP-DENY-032' },
  },
  {
    id: 'cross-generation-confirmation-accepted',
    find: 'if (approval.policyGeneration !== input.generation) return false;',
    replace: '/* mutation: stale generation confirmation accepted */',
    witness: { file: 'agent-policy-v1.json', id: 'AP-DENY-033' },
  },
  {
    id: 'approval-resource-binding-ignored',
    find: "if (approval.channel !== input.channel || approval.operation !== input.operation) return false;",
    replace: '/* mutation: approval operation binding ignored */',
    witness: { file: 'agent-policy-v1.json', id: 'AP-DENY-035' },
  },
  {
    id: 'approval-request-hash-ignored',
    find: 'if (approval.requestHash !== input.requestHash) return false;',
    replace: '/* mutation: approval request hash ignored */',
    witness: { file: 'agent-policy-v1.json', id: 'AP-DENY-036' },
  },
  {
    id: 'idempotency-before-authorization',
    find: "if (input.systemGrantChangedBeforeExecution || !authorityMatches({ effect: 'allow', operations: input.systemOperations, channels: input.systemChannels, shares: input.systemShares, networkTargets: input.systemNetworkTargets, listenHosts: input.systemListenHosts, offloadCapabilities: input.systemOffloadCapabilities }, input)) return 'system_grant_denied';\n  if (requiresApproval(input) && !approvalValid(input)) return 'approval_required';\n  if (input.retrySameRequest) return 'return_original_receipt';",
    replace: "if (input.retrySameRequest) return 'return_original_receipt';\n  if (input.systemGrantChangedBeforeExecution || !(input.systemOperations || []).includes(input.operation)) return 'system_grant_denied';",
    witness: { file: 'agent-policy-v1.json', id: 'AP-EXEC-009' },
  },
];

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-link-source-mutations-'));
const results = [];
const vectorCache = new Map();
function vectorFor(witness) {
  if (!vectorCache.has(witness.file)) {
    vectorCache.set(witness.file, JSON.parse(fs.readFileSync(path.join(here, 'cases', witness.file), 'utf8')));
  }
  return vectorCache.get(witness.file).find((item) => item.id === witness.id);
}
function evaluateCase(adapter, test) {
  if (test.family === 'valid') return adapter.mapSyncOperation(test.legacy);
  if (test.commitResults) return adapter.webdavConcurrentCommit({
    baseEtag: test.baseEtag,
    commits: test.commitResults.map((result, index) => ({ writer: test.writers[index], result, etag: test.baseEtag })),
    weakEtag: test.baseEtag === 'weak',
  });
  if (test.family === 'capability' || test.id.startsWith('WD-CAP-')) return adapter.webdavWriteMode(test);
  if (test.input?.op) return adapter.mapSyncOperation(test.input, {
    authenticatedDeviceId: test.authenticatedDeviceId,
    envelopeVersion: test.input.envelopeVersion ?? 1,
    currentRevision: test.currentRevision,
    serverRegistryHash: test.serverRegistryHash,
  });
  return adapter.evaluateAgentPolicy(test);
}
function contractValue(result) {
  if (result && typeof result === 'object' && Object.hasOwn(result, 'error')) return result.error;
  if (result && typeof result === 'object' && Object.hasOwn(result, 'allowed')) return result.allowed ? { allowed: true } : { allowed: false, reason: result.reason };
  return result;
}
function contractMatches(actual, test) {
  const expected = test.expectedError || test.expected;
  if (actual && typeof actual === 'object' && Object.hasOwn(actual, 'allowed')) {
    if (expected === 'reject_server_not_B2') return actual.allowed === false && actual.reason === 'reject_server_not_B2';
    if (expected === 'no_multiwriter_B2_proof') return actual.allowed === false && actual.reason === 'no_multiwriter_B2_proof';
    if (expected === 'not_multiwriter_safe') return actual.allowed === false && actual.reason === 'not_multiwriter_safe';
    if (expected === 'one_winner_loser_replays') return actual.allowed === true;
    return actual.allowed === expected;
  }
  return actual === expected;
}
for (const mutation of mutations) {
  if (!original.includes(mutation.find)) {
    results.push({ id: mutation.id, status: 'NOT_APPLICABLE_STALE_MUTATION', witness: mutation.witness, killed: false, error: 'stale mutation cannot be applied' });
    continue;
  }
  const mutantPath = path.join(tempDir, `${mutation.id}.mjs`);
  fs.writeFileSync(mutantPath, original.replace(mutation.find, mutation.replace));
  const adapter = await import(`${pathToFileURL(mutantPath).href}?mutation=${mutation.id}`);
  const test = vectorFor(mutation.witness);
  if (!test) {
    results.push({ id: mutation.id, status: 'MISSING_WITNESS', witness: mutation.witness, killed: false, error: 'required witness case is missing' });
    continue;
  }
  const expected = test.expectedError || test.expected;
  let control;
  let actual;
  let error = null;
  try {
    const originalAdapter = await import(`${pathToFileURL(sourcePath).href}?control=${mutation.id}`);
    control = contractValue(evaluateCase(originalAdapter, test));
    actual = contractValue(evaluateCase(adapter, test));
  } catch (caught) { error = caught.message; }
  const controlPass = contractMatches(control, test);
  const killed = controlPass && !contractMatches(actual, test) && !error;
  results.push({
    id: mutation.id,
    witness: mutation.witness.id,
    expected,
    control,
    actual,
    controlPass,
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
