import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { evaluateAgentPolicy } = require('../agent-policy-engine.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(fs.readFileSync(
  path.join(here, '../docs/zephyr-link/conformance/cases/agent-policy-v1.json'),
  'utf8',
));

const REQUIRED = [
  'AP-RULE-001', 'AP-RULE-004', 'AP-RULE-006',
  'AP-DENY-007', 'AP-DENY-011', 'AP-DENY-012', 'AP-DENY-025',
];

for (const id of REQUIRED) {
  const testCase = cases.find((entry) => entry.id === id);
  test(`${id} matches the conformance vector`, () => {
    assert.ok(testCase, `missing case ${id}`);
    assert.equal(evaluateAgentPolicy(testCase), testCase.expected);
  });
}

for (const testCase of cases) {
  test(`${testCase.id} ${testCase.family} → ${testCase.expected}`, () => {
    const actual = testCase.family === 'schema'
      ? evaluateAgentPolicy(testCase.input)
      : evaluateAgentPolicy(testCase);
    assert.equal(actual, testCase.expected);
  });
}
