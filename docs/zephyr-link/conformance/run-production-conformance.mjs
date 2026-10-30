import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeProductionCase, metadata } from './production-adapter-node-v1.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const casesDir = path.join(here, 'cases');
const read = (name) => JSON.parse(fs.readFileSync(path.join(casesDir, name), 'utf8'));

const syncCases = read('sync-envelope-v1.json');
const agentCases = read('agent-policy-v1.json');
const webdavCases = read('webdav-writers-v1.json');
const allCases = [...syncCases, ...agentCases, ...webdavCases];
const requiredCaseIds = allCases.map((test) => test.id);

const adapterMeta = metadata();
const results = [];

for (const test of allCases) {
  const outcome = executeProductionCase(test, {});
  results.push({
    id: test.id,
    family: test.family || null,
    status: outcome.status,
    actual: outcome.actual,
    expected: test.expectedError || test.expected || test.response || null,
  });
}

const passed = results.filter((row) => row.status === 'pass');
const failed = results.filter((row) => row.status === 'fail');
const unsupported = results.filter((row) => row.status === 'unsupported');
const executed = results.filter((row) => row.status === 'pass' || row.status === 'fail');

const report = {
  ok: requiredCaseIds.length > 0
    && executed.length === requiredCaseIds.length
    && passed.length === executed.length
    && failed.length === 0
    && unsupported.length === 0,
  evidenceType: 'production-conformance',
  commit: adapterMeta.commit,
  adapter: adapterMeta.adapter,
  language: adapterMeta.language,
  modulePath: adapterMeta.modulePath,
  production: true,
  buildId: adapterMeta.buildId,
  vectors: {
    total: requiredCaseIds.length,
    executed: executed.length,
    passed: passed.length,
    failed: failed.length,
    unsupported: unsupported.length,
    requiredCaseIds,
    executedCaseIds: executed.map((row) => row.id),
    passedCaseIds: passed.map((row) => row.id),
    failedCaseIds: failed.map((row) => row.id),
    unsupportedCaseIds: unsupported.map((row) => row.id),
  },
  mutations: { total: 0, killed: 0, survived: 0 },
  artifacts: [],
  coverageGaps: unsupported.map((row) => `${row.id}: ${typeof row.actual === 'string' ? row.actual : 'unsupported'}`),
  failures: failed,
};

console.log(JSON.stringify(report, null, 2));

// A report with unsupported required vectors is not production conformance.
// Development unit tests are a separate job; never turn incompleteness green.
process.exitCode = report.ok ? 0 : 1;
