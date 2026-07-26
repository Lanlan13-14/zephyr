import test from 'node:test';
import assert from 'node:assert/strict';
import aiAgent from '../ai-agent-service.js';
import capabilities from '../ai-capabilities.js';
import { PLAYBOOKS } from '../ai-playbooks.js';

const canonical = ['browser_inspect_v1', 'browser_click_v1', 'browser_type_v1'];

test('browser catalog exposes elementRef tools and removes selector mutation tools', () => {
  const catalog = aiAgent.listToolCatalog({ permissions: { browser: true } });
  const names = new Set(catalog.map((item) => item.name));
  canonical.forEach((name) => assert.equal(names.has(name), true));
  assert.equal(names.has('browser_inspect'), false);
  assert.equal(names.has('browser_click'), false);
  assert.equal(names.has('browser_type'), false);
  assert.equal(catalog.find((item) => item.name === 'browser_inspect_v1').risk, 'R0');
  assert.equal(catalog.find((item) => item.name === 'browser_click_v1').risk, 'R1');
  assert.equal(catalog.find((item) => item.name === 'browser_type_v1').risk, 'R2');
});

test('browser capability and playbook require DOM revision validation', () => {
  for (const id of ['browser.inspect', 'browser.click', 'browser.type']) {
    assert.ok(capabilities.CAPABILITIES.some((item) => item.id === id && item.state === 'implemented'));
  }
  const playbook = PLAYBOOKS.find((item) => item.id === 'browser-automation-v1');
  assert.ok(playbook);
  assert.match(playbook.prompt, /elementRef/);
  assert.match(playbook.prompt, /stale_dom_revision/);
  assert.match(playbook.prompt, /(不再让模型拼|禁止).*CSS selector/);
});
