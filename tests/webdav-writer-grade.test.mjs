import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { classifyWebdavWriter, webdavConcurrentCommit } = require('../webdav-writer-grade.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(fs.readFileSync(
  path.join(here, '../docs/zephyr-link/conformance/cases/webdav-writers-v1.json'),
  'utf8',
));

for (const testCase of cases.filter((entry) => entry.id.startsWith('WD-CAP-'))) {
  test(`${testCase.id} classifies as ${testCase.expected}`, () => {
    assert.equal(classifyWebdavWriter(testCase), testCase.expected);
  });
}

function commitsOf(testCase) {
  return testCase.commitResults.map((result, index) => ({
    writer: testCase.writers[index],
    result,
    etag: testCase.baseEtag,
  }));
}

test('WD-CAS-001 one winner, loser must replay', () => {
  const testCase = cases.find((entry) => entry.id === 'WD-CAS-001');
  const outcome = webdavConcurrentCommit({
    baseEtag: testCase.baseEtag,
    commits: commitsOf(testCase),
  });
  assert.equal(outcome.allowed, true);
  assert.deepEqual(outcome.losersMust, ['reread', 'merge', 'retry']);
});

test('WD-CAS-002 two successful commits are not B2', () => {
  const testCase = cases.find((entry) => entry.id === 'WD-CAS-002');
  const outcome = webdavConcurrentCommit({
    baseEtag: testCase.baseEtag,
    commits: commitsOf(testCase),
  });
  assert.equal(outcome.allowed, false);
  assert.equal(outcome.reason, 'reject_server_not_B2');
});

test('WD-CAS-005 weak ETag cannot be a mutex', () => {
  const testCase = cases.find((entry) => entry.id === 'WD-CAS-005');
  const outcome = webdavConcurrentCommit({
    baseEtag: testCase.baseEtag,
    commits: commitsOf(testCase),
    weakEtag: true,
  });
  assert.equal(outcome.allowed, false);
  assert.equal(outcome.reason, 'no_multiwriter_B2_proof');
});

for (const id of ['WD-CAS-003', 'WD-CAS-004']) {
  test(`${id} two successful commits prove the server is not B2`, () => {
    const testCase = cases.find((entry) => entry.id === id);
    const outcome = webdavConcurrentCommit({
      baseEtag: testCase.baseEtag,
      commits: commitsOf(testCase),
    });
    assert.equal(outcome.allowed, false);
    assert.equal(outcome.reason, testCase.expected);
  });
}

for (const id of ['WD-CAS-008', 'WD-CAS-009', 'WD-CAS-010']) {
  test(`${id} snapshot/lockfile/create-only is not multiwriter-safe`, () => {
    const testCase = cases.find((entry) => entry.id === id);
    const outcome = webdavConcurrentCommit({
      baseEtag: testCase.baseEtag || 'etag',
      commits: [],
      conditionalWrite: false,
    });
    assert.equal(outcome.allowed, false);
    assert.equal(outcome.reason, testCase.expected);
  });
}

test('writers=0 is B0 even with strong CAS flags', () => {
  assert.equal(classifyWebdavWriter({
    strongEtag: true,
    conditionalWrite: true,
    atomicPublish: true,
    consistentReadback: true,
    writers: 0,
  }), 'B0');
});

test('single writer with full CAS is still B1', () => {
  assert.equal(classifyWebdavWriter({
    strongEtag: true,
    conditionalWrite: true,
    atomicPublish: true,
    consistentReadback: true,
    writers: 1,
  }), 'B1');
});
