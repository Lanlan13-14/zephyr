/*
 * Production Node adapter for Link conformance vectors.
 *
 * DTO conversion only. Algorithms live in the production modules required
 * below; this file must not reimplement envelope, policy or writer-grade rules.
 */

import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const require = createRequire(import.meta.url);

const envelope = require(path.join(repo, 'link-v2-sync-envelope.js'));
const policy = require(path.join(repo, 'agent-policy-engine.js'));
const webdav = require(path.join(repo, 'webdav-writer-grade.js'));

const PRODUCTION_MODULES = Object.freeze([
  'link-v2-sync-envelope.js',
  'agent-policy-engine.js',
  'webdav-writer-grade.js',
  'link-v2-sync-bridge.js',
]);

function gitCommit() {
  try {
    return execSync('git rev-parse HEAD', { cwd: repo, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function gitBuildId() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: repo, encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
}

export function metadata() {
  return {
    language: 'javascript',
    modulePath: PRODUCTION_MODULES.map((rel) => path.join(repo, rel)),
    commit: gitCommit(),
    production: true,
    buildId: gitBuildId(),
    adapter: 'docs/zephyr-link/conformance/production-adapter-node-v1.mjs',
  };
}

export function mapSyncOperation(legacyBody, sessionContext) {
  return envelope.mapSyncOperation(legacyBody, sessionContext);
}

export function evaluateAgentPolicy(requestContext) {
  return policy.evaluateAgentPolicy(requestContext);
}

export function classifyWebdavWriter(capabilities) {
  return webdav.classifyWebdavWriter(capabilities);
}

export function webdavConcurrentCommit(input) {
  return webdav.webdavConcurrentCommit(input);
}

function deepEqual(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function sessionFromCase(test) {
  const source = test.input || test.legacy || {};
  return {
    envelopeVersion: source.envelopeVersion ?? 1,
    authenticatedDeviceId: test.authenticatedDeviceId,
    currentRevision: test.currentRevision,
    serverRegistryHash: test.serverRegistryHash,
    maxOperations: test.maxOperations,
  };
}

function syncNeedsProductionRuntime(test) {
  if (test.tooLarge) return 'payload size limit requires the transport / store';
  if (test.authenticatedDeviceRevoked) return 'requires enrolled-device store';
  if (test.authenticatedAccountDeleted) return 'requires account store';
  if (test.serverCursor !== undefined) return 'requires canonical cursor store';
  if (test.prunedThroughCursor !== undefined) return 'requires change-feed retention';
  if (test.expectedErrorMetadata) return 'requires live error envelope from the store';
  if (test.forbidErrorSubstrings && test.expectedError === 'invalid_request') return null;
  const err = test.expectedError;
  if (err === 'cursor_invalid' || err === 'cursor_expired') return 'requires canonical cursor store';
  if (err === 'client_revoked' || err === 'account_unavailable') return 'requires auth store';
  if (err === 'secret_reconciliation_required') return 'requires secret journal';
  if (err === 'payload_too_large') return 'payload size limit requires the transport / store';
  if (test.family === 'security' && err === 'revision_conflict') return 'requires secret key-version store';
  if (test.family === 'security' && err === 'invalid_request' && !test.forbidErrorSubstrings) {
    return 'requires secret envelope authentication';
  }
  return null;
}

function compareSync(test, mapped) {
  if (test.family === 'valid') {
    if (mapped.error) return { ok: false, actual: mapped, expected: test.operation };
    const checks = [
      mapped.operation === test.operation,
      mapped.kind === 1,
      mapped.responseShape === test.response,
      !Object.hasOwn(mapped.body, 'op'),
    ];
    if (test.expectedBody && !deepEqual(mapped.body, test.expectedBody)) checks.push(false);
    if (test.idempotencyPrefix && mapped.idempotency?.key !== test.idempotencyPrefix) checks.push(false);
    return { ok: checks.every(Boolean), actual: mapped };
  }

  if (test.expectedError) {
    if (mapped.error) {
      return { ok: mapped.error === test.expectedError, actual: mapped.error, expected: test.expectedError };
    }
    return { ok: false, actual: mapped, expected: test.expectedError };
  }

  if (test.response) {
    if (mapped.error) return { ok: false, actual: mapped, expected: test.response };
    return { ok: mapped.responseShape === test.response, actual: mapped.responseShape, expected: test.response };
  }

  return { ok: false, actual: mapped, expected: 'unspecified' };
}

function compareWebdavCas(test, outcome) {
  const expected = test.expected;
  if (expected === 'one_winner_loser_replays') {
    return {
      ok: outcome.allowed === true && deepEqual(outcome.losersMust, ['reread', 'merge', 'retry']),
      actual: outcome,
      expected,
    };
  }
  if (expected === 'reject_server_not_B2' || expected === 'no_multiwriter_B2_proof' || expected === 'not_multiwriter_safe' || expected === 'stale_epoch_rejected') {
    return {
      ok: outcome.allowed === false && outcome.reason === expected,
      actual: outcome,
      expected,
    };
  }
  return { ok: false, actual: outcome, expected };
}

/**
 * Execute one conformance vector against production functions.
 * @returns {{ status: 'pass'|'fail'|'unsupported', actual: any, artifacts: object }}
 */
export function executeProductionCase(testCase, fixtures = {}) {
  const artifacts = {
    productionModules: PRODUCTION_MODULES,
    fixtures: Object.keys(fixtures || {}),
  };

  if (!testCase || typeof testCase.id !== 'string') {
    return { status: 'fail', actual: 'missing case id', artifacts };
  }

  if (testCase.id.startsWith('SE-')) {
    const blocked = syncNeedsProductionRuntime(testCase);
    if (blocked) {
      return { status: 'unsupported', actual: blocked, artifacts: { ...artifacts, reason: blocked } };
    }
    const legacy = testCase.family === 'valid' ? testCase.legacy : testCase.input;
    const mapped = mapSyncOperation(legacy, sessionFromCase(testCase));
    const compared = compareSync(testCase, mapped);
    return {
      status: compared.ok ? 'pass' : 'fail',
      actual: compared.actual,
      artifacts: { ...artifacts, expected: compared.expected ?? testCase.expectedError ?? testCase.response },
    };
  }

  if (testCase.id.startsWith('AP-')) {
    const actual = testCase.family === 'schema'
      ? evaluateAgentPolicy(testCase.input)
      : evaluateAgentPolicy(testCase);
    const expected = testCase.expected;
    return {
      status: actual === expected ? 'pass' : 'fail',
      actual,
      artifacts: { ...artifacts, expected },
    };
  }

  if (testCase.id.startsWith('WD-CAP-') || testCase.family === 'capability') {
    const actual = classifyWebdavWriter(testCase);
    return {
      status: actual === testCase.expected ? 'pass' : 'fail',
      actual,
      artifacts: { ...artifacts, expected: testCase.expected },
    };
  }

  if (testCase.id.startsWith('WD-CAS-') && Array.isArray(testCase.commitResults)) {
    const commits = testCase.commitResults.map((result, index) => ({
      writer: (testCase.writers || [])[index],
      result,
      etag: testCase.baseEtag,
    }));
    const outcome = webdavConcurrentCommit({
      baseEtag: testCase.baseEtag,
      commits,
      conditionalWrite: testCase.conditionalWrite !== false,
      weakEtag: testCase.baseEtag === 'weak',
    });
    const compared = compareWebdavCas(testCase, outcome);
    if (!compared.ok && !['one_winner_loser_replays', 'reject_server_not_B2', 'no_multiwriter_B2_proof', 'not_multiwriter_safe', 'stale_epoch_rejected'].includes(testCase.expected)) {
      return {
        status: 'unsupported',
        actual: 'CAS vector requires a live WebDAV endpoint',
        artifacts: { ...artifacts, expected: testCase.expected, outcome },
      };
    }
    return {
      status: compared.ok ? 'pass' : 'fail',
      actual: outcome,
      artifacts: { ...artifacts, expected: testCase.expected },
    };
  }

  if (testCase.id.startsWith('WD-CAS-') && testCase.conditionalWrite === false) {
    const outcome = webdavConcurrentCommit({
      baseEtag: testCase.baseEtag || 'etag',
      commits: [],
      conditionalWrite: false,
      weakEtag: false,
    });
    const compared = compareWebdavCas(testCase, outcome);
    return {
      status: compared.ok ? 'pass' : 'fail',
      actual: outcome,
      artifacts: { ...artifacts, expected: testCase.expected },
    };
  }

  if (testCase.id.startsWith('WD-FAULT-') || testCase.id.startsWith('WD-STATE-') || testCase.id.startsWith('WD-CAS-')) {
    return {
      status: 'unsupported',
      actual: 'requires a real WebDAV endpoint or production failure-injection adapter',
      artifacts: { ...artifacts, expected: testCase.expected, scenario: testCase.scenario },
    };
  }

  return {
    status: 'unsupported',
    actual: 'unrecognized production vector family',
    artifacts,
  };
}

export const PRODUCTION_MODULE_PATHS = PRODUCTION_MODULES;
