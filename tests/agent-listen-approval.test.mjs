import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateAgentPolicy } = require('../agent-policy-engine.js');

function base(overrides = {}) {
  return {
    subject: 'user:alice',
    channel: 'agent-tunnel',
    operation: 'tunnel.local',
    share: null,
    localEffect: 'allow',
    localOperations: ['tunnel.local'],
    localShares: [],
    localChannels: ['agent-tunnel'],
    localSubjects: ['user:alice'],
    localListenHosts: ['127.0.0.1', '0.0.0.0', '::', '::1'],
    primaryOperations: ['tunnel.local'],
    primaryChannels: ['agent-tunnel'],
    primaryListenHosts: ['127.0.0.1', '0.0.0.0', '::', '::1'],
    systemOperations: ['tunnel.local'],
    systemChannels: ['agent-tunnel'],
    systemListenHosts: ['127.0.0.1', '0.0.0.0', '::', '::1'],
    generation: 5,
    sessionGeneration: 5,
    riskLevel: 'low',
    now: 1,
    ...overrides,
  };
}

test('0.0.0.0 listenHost without confirmation is approval_required', () => {
  assert.equal(evaluateAgentPolicy(base({ listenHost: '0.0.0.0' })), 'approval_required');
});

test(':: listenHost without confirmation is approval_required', () => {
  assert.equal(evaluateAgentPolicy(base({ listenHost: '::' })), 'approval_required');
});

test('127.0.0.1 listenHost does not require listen approval', () => {
  assert.equal(evaluateAgentPolicy(base({ listenHost: '127.0.0.1' })), 'allow');
});
