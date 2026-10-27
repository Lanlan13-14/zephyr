/*
 * Executable reference adapter for Link conformance vectors.
 * This validates the specification's example algorithm, NOT production code.
 * A production adapter MUST implement this interface and run the same vectors.
 */

export const META = Object.freeze({
  id: 'reference-only-not-product-evidence',
  kind: 'documentation-reference-adapter',
  version: 1,
});

export function mapSyncOperation(legacy, { envelopeVersion = 1, authenticatedDeviceId = null } = {}) {
  if (![1, 2].includes(envelopeVersion)) return { error: 'unsupported_protocol_version' };
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return { error: 'invalid_request' };
  const operations = { bootstrap: 'sync.bootstrap', changes: 'sync.changes', push: 'sync.push', ack: 'sync.ack', status: 'sync.status' };
  if (legacy.kind !== undefined && legacy.kind !== 1) return { error: 'unsupported_kind' };
  if (typeof legacy.op !== 'string') return { error: 'invalid_request' };
  const operation = operations[legacy.op];
  if (!operation) return { error: 'unsupported_op' };
  if (legacy.operation !== undefined && legacy.operation !== operation) return { error: 'invalid_request' };
  if (legacy.op === 'push' && legacy.protocolVersion !== 1) return { error: 'unsupported_protocol_version' };
  if (legacy.body !== undefined) return { error: 'invalid_request' };
  if (authenticatedDeviceId && legacy.deviceId && legacy.deviceId !== authenticatedDeviceId) return { error: 'device_proof_invalid' };
  const { op: _op, operation: _operation, ...body } = legacy;
  return {
    kind: 1,
    envelopeVersion: 2,
    operation,
    body,
    requestIdGenerated: true,
    responseShape: { bootstrap: 'BootstrapPage', changes: 'ChangePage', push: 'PushResponse', ack: 'AckResponse', status: 'SyncStatus' }[legacy.op],
    idempotency: legacy.op === 'push'
      ? { kind: 'batch', key: `push:${legacy.deviceId}:${legacy.batchId}`, operationIdsPreserved: true }
      : { kind: legacy.op === 'ack' ? 'monotonic-ack' : 'read-only' },
  };
}

function matches(rule, input) {
  if (!rule || typeof rule !== 'object') return false;
  if (rule.expiresAt != null && input.now >= rule.expiresAt) return false;
  if (rule.subjects && !rule.subjects.includes(input.subject)) return false;
  if (rule.channels && !rule.channels.includes(input.channel)) return false;
  if (!Array.isArray(rule.operations) || !rule.operations.includes(input.operation)) return false;
  if (input.share && !(rule.shares || []).includes(input.share)) return false;
  if (input.networkTarget && !(rule.networkTargets || []).includes(input.networkTarget)) return false;
  if (input.offloadCapability && !(rule.offloadCapabilities || []).includes(input.offloadCapability)) return false;
  return true;
}

function toRules(input) {
  if (Array.isArray(input.rules)) return input.rules;
  return [{
    effect: input.localEffect || 'deny',
    subjects: input.localSubjects || [],
    channels: input.localChannels || [],
    operations: input.localOperations || [],
    shares: input.localShares || [],
    networkTargets: input.localNetworkTargets || [],
    offloadCapabilities: input.localOffloadCapabilities || [],
    expiresAt: input.expiresAt ?? input.expiresAt,
    limits: input.limits || {},
  }];
}

export function evaluateAgentPolicy(input) {
  if (!input || typeof input !== 'object') return 'schema_invalid';
  const normalized = {
    ...input,
    now: input.now ?? 0,
    localOperations: input.localOperations || [],
    localShares: input.localShares || [],
    primaryOperations: input.primaryOperations || [],
    systemOperations: input.systemOperations || [],
  };
  input = normalized;
  if (input.agentRevoked) return 'agent_revoked';
  if (input.paused) return 'agent_paused';
  if (input.generation !== input.sessionGeneration) return 'agent_policy_generation_stale';
  if (input.primaryOffline && !input.localAuthorizedOffline) return 'primary_unavailable';
  if (input.retrySameIdempotencyDifferentPayload) return 'idempotency_conflict';

  const rules = toRules(input);
  const matchesHere = rules.filter((rule) => matches(rule, {
    ...input,
    subject: rule.subjects ? input.subject : null,
    channel: rule.channels ? input.channel : null,
  }));
  if (matchesHere.some((rule) => rule.effect === 'deny')) return 'agent_local_policy_denied';
  const allows = matchesHere.filter((rule) => rule.effect === 'allow');
  if (!allows.length) return 'agent_local_policy_denied';

  for (const rule of allows) {
    for (const [name, ceiling] of Object.entries(rule.limits || {})) {
      if (ceiling === 0) return 'agent_quota_exceeded';
      const requested = input.usage?.[name];
      if (requested !== undefined && requested > ceiling) return 'agent_quota_exceeded';
    }
  }

  const highRisk = ['delete', 'revealSecret', 'remoteWipe'].includes(input.operation)
    || (input.listenHost && !['127.0.0.1', '::1'].includes(input.listenHost));
  if (highRisk && (!input.confirmed || input.confirmationHashMismatch)) return 'approval_required';
  if (!(input.primaryOperations || []).includes(input.operation)) return 'primary_acl_denied';
  if (input.systemGrantChangedBeforeExecution || !(input.systemOperations || []).includes(input.operation)) return 'system_grant_denied';
  if (input.retrySameRequest) return 'return_original_receipt';
  return 'allow';
}

export function webdavWriteMode({ strongEtag, conditionalWrite, atomicPublish, consistentReadback, writers }) {
  if (writers === 0) return 'B0';
  if (!strongEtag || !conditionalWrite) return 'B1';
  if (!atomicPublish || !consistentReadback) return 'B1';
  if (writers > 1) return 'B2';
  return 'B1';
}

export function webdavConcurrentCommit({ baseEtag, commits, conditionalWrite = true, weakEtag = false }) {
  if (weakEtag) return { allowed: false, reason: 'no_multiwriter_B2_proof' };
  if (!conditionalWrite) return { allowed: false, reason: 'not_multiwriter_safe' };
  if (!commits.every((commit) => commit.etag === baseEtag)) return { allowed: false, reason: 'stale_epoch_rejected' };
  const successful = commits.filter((commit) => commit.result === 'success');
  if (successful.length !== 1) return { allowed: false, reason: 'reject_server_not_B2' };
  return { allowed: true, winner: successful[0].writer, losersMust: ['reread', 'merge', 'retry'] };
}
