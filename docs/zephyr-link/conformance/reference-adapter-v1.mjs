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

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function nonEmptyText(value, maxLength = 160) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function validateSyncOperation(op, operation) {
  if (!object(op)) return 'invalid_request';
  if (!nonEmptyText(op.opId, 80)) return 'invalid_request';
  if (!nonEmptyText(op.entityType, 80)) return 'invalid_request';
  if (!nonEmptyText(op.entityId, 160)) return 'invalid_request';
  if (!['upsert', 'delete', 'restore'].includes(op.action)) return 'invalid_request';
  if (!Number.isSafeInteger(op.baseRevision) || op.baseRevision < 0) return 'invalid_request';
  if (!Array.isArray(op.fieldMask) || op.fieldMask.length > 256 || !op.fieldMask.every((field) => typeof field === 'string')) return 'invalid_request';
  if (!object(op.payload)) return 'invalid_request';
  if (op.action !== 'upsert' && (op.fieldMask.length || Object.keys(op.payload).length || op.secretEnvelopes || op.clearSecretFields)) return 'invalid_request';
  if (op.action === 'upsert' && !op.fieldMask.length && !op.secretEnvelopes && !op.clearSecretFields) return 'invalid_request';
  if (op.secretEnvelopes && op.clearSecretFields) return 'invalid_request';
  if (op.clearSecretFields && (!Array.isArray(op.clearSecretFields) || !op.clearSecretFields.every((field) => typeof field === 'string'))) return 'invalid_request';
  if (Number.isSafeInteger(operation.currentRevision) && op.baseRevision > operation.currentRevision) return 'revision_conflict';
  return null;
}

export function mapSyncOperation(legacy, { envelopeVersion = 1, authenticatedDeviceId = null, currentRevision = null, serverRegistryHash = null } = {}) {
  if (![1, 2].includes(envelopeVersion)) return { error: 'unsupported_protocol_version' };
  if (!object(legacy)) return { error: 'invalid_request' };
  const operations = { bootstrap: 'sync.bootstrap', changes: 'sync.changes', push: 'sync.push', ack: 'sync.ack', status: 'sync.status' };
  if (legacy.kind !== undefined && legacy.kind !== 1) return { error: 'unsupported_kind' };
  if (typeof legacy.op !== 'string') return { error: 'invalid_request' };
  const operation = operations[legacy.op];
  if (!operation) return { error: 'unsupported_op' };
  if (legacy.operation !== undefined && legacy.operation !== operation) return { error: 'invalid_request' };
  if (legacy.op === 'push' && legacy.protocolVersion !== 1) return { error: 'unsupported_protocol_version' };
  if (legacy.body !== undefined) return { error: 'invalid_request' };
  if (authenticatedDeviceId && legacy.deviceId && legacy.deviceId !== authenticatedDeviceId) return { error: 'device_proof_invalid' };
  const deviceId = legacy.deviceId || authenticatedDeviceId || null;
  if (legacy.op === 'push') {
    if (!nonEmptyText(deviceId)) return { error: 'device_proof_invalid' };
    if (serverRegistryHash && legacy.registryHash && serverRegistryHash !== legacy.registryHash) return { error: 'registry_mismatch' };
    if (!nonEmptyText(legacy.batchId, 160)) return { error: 'invalid_request' };
    if (!Array.isArray(legacy.operations)) return { error: 'invalid_request' };
    if (legacy.operations.some((op) => validateSyncOperation(op, { ...legacy, currentRevision }))) {
      return { error: validateSyncOperation(legacy.operations.find((op) => validateSyncOperation(op, { ...legacy, currentRevision })), { ...legacy, currentRevision }) };
    }
  }
  if (legacy.op === 'ack') {
    if (!nonEmptyText(deviceId)) return { error: 'device_proof_invalid' };
    if (!Number.isSafeInteger(legacy.cursor) || legacy.cursor < 0) return { error: 'invalid_request' };
    if (legacy.appliedOpIds !== undefined && (!Array.isArray(legacy.appliedOpIds) || !legacy.appliedOpIds.every((id) => nonEmptyText(id, 80)))) return { error: 'invalid_request' };
  }
  if (legacy.op === 'changes') {
    if (!Number.isSafeInteger(legacy.sinceCursor) || legacy.sinceCursor < 0) return { error: 'invalid_request' };
    if (legacy.limit !== undefined && (!Number.isSafeInteger(legacy.limit) || legacy.limit < 1 || legacy.limit > 1000)) return { error: 'invalid_request' };
  }
  if (legacy.op === 'bootstrap') {
    if (legacy.pageSize !== undefined && (!Number.isSafeInteger(legacy.pageSize) || legacy.pageSize < 1 || legacy.pageSize > 500)) return { error: 'invalid_request' };
    if (legacy.pageToken !== undefined && !nonEmptyText(legacy.pageToken, 4096)) return { error: 'invalid_request' };
  }
  const { op: _op, operation: _operation, ...body } = legacy;
  if (deviceId && (legacy.op === 'push' || legacy.op === 'ack')) body.deviceId = deviceId;
  return {
    kind: 1,
    envelopeVersion: 2,
    operation,
    body,
    requestIdGenerated: true,
    responseShape: { bootstrap: 'BootstrapPage', changes: 'ChangePage', push: 'PushResponse', ack: 'AckResponse', status: 'SyncStatus' }[legacy.op],
    idempotency: legacy.op === 'push'
      ? { kind: 'batch', key: `push:${deviceId}:${legacy.batchId}`, operationIdsPreserved: true }
      : { kind: legacy.op === 'ack' ? 'monotonic-ack' : 'read-only' },
  };
}

function matches(rule, input) {
  if (!object(rule)) return false;
  if (rule.expiresAt != null && input.now >= rule.expiresAt) return false;
  if (rule.subjects && !rule.subjects.includes(input.subject)) return false;
  if (rule.channels && !rule.channels.includes(input.channel)) return false;
  if (!Array.isArray(rule.operations) || !rule.operations.includes(input.operation)) return false;
  if (input.share && !(rule.shares || []).includes(input.share)) return false;
  if (input.networkTarget && !(rule.networkTargets || []).includes(input.networkTarget)) return false;
  if (input.listenHost && !(rule.listenHosts || []).includes(input.listenHost)) return false;
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
    listenHosts: input.localListenHosts || [],
    offloadCapabilities: input.localOffloadCapabilities || [],
    expiresAt: input.expiresAt,
    limits: input.limits || {},
  }];
}

function authorityMatches(authority, input) {
  if (!object(authority)) return false;
  if (authority.effect !== 'allow') return false;
  if (!(authority.operations || []).includes(input.operation)) return false;
  if (authority.channels && !authority.channels.includes(input.channel)) return false;
  if (input.share && authority.shares && !authority.shares.includes(input.share)) return false;
  if (input.share && !authority.shares) return false;
  if (input.networkTarget && authority.networkTargets && !authority.networkTargets.includes(input.networkTarget)) return false;
  if (input.networkTarget && !authority.networkTargets) return false;
  if (input.listenHost && authority.listenHosts && !authority.listenHosts.includes(input.listenHost)) return false;
  if (input.listenHost && !authority.listenHosts) return false;
  if (input.offloadCapability && authority.offloadCapabilities && !authority.offloadCapabilities.includes(input.offloadCapability)) return false;
  if (input.offloadCapability && !authority.offloadCapabilities) return false;
  return true;
}

function approvalValid(input) {
  const approval = input.approval;
  if (!object(approval) || !nonEmptyText(approval.confirmationId, 160)) return false;
  if (!nonEmptyText(approval.requestHash, 256)) return false;
  if (approval.requestHash !== input.requestHash) return false;
  if (approval.policyGeneration !== input.generation) return false;
  if (approval.channel !== input.channel || approval.operation !== input.operation) return false;
  if ((approval.share || null) !== (input.share || null)) return false;
  if ((approval.networkTarget || null) !== (input.networkTarget || null)) return false;
  if ((approval.listenHost || null) !== (input.listenHost || null)) return false;
  if (!Number.isSafeInteger(approval.expiresAt) || input.now >= approval.expiresAt) return false;
  return true;
}

function requiresApproval(input) {
  if (['delete', 'revealSecret', 'remoteWipe'].includes(input.operation)) return true;
  if (input.listenHost && !['127.0.0.1', '::1'].includes(input.listenHost)) return true;
  return input.riskLevel === 'high' || input.sharedWrite === true;
}

export function evaluateAgentPolicy(input) {
  if (!object(input)) return 'schema_invalid';
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
  const matchesHere = rules.filter((rule) => matches(rule, input));
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

  if (!authorityMatches({ effect: 'allow', operations: input.primaryOperations, channels: input.primaryChannels, shares: input.primaryShares, networkTargets: input.primaryNetworkTargets, listenHosts: input.primaryListenHosts, offloadCapabilities: input.primaryOffloadCapabilities }, input)) return 'primary_acl_denied';
  if (input.systemGrantChangedBeforeExecution || !authorityMatches({ effect: 'allow', operations: input.systemOperations, channels: input.systemChannels, shares: input.systemShares, networkTargets: input.systemNetworkTargets, listenHosts: input.systemListenHosts, offloadCapabilities: input.systemOffloadCapabilities }, input)) return 'system_grant_denied';
  if (requiresApproval(input) && !approvalValid(input)) return 'approval_required';
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
  if (commits.some((commit) => !['success', 'precondition_failed'].includes(commit.result))) return { allowed: false, reason: 'invalid_commit_result' };
  const successful = commits.filter((commit) => commit.result === 'success');
  if (successful.length !== 1) return { allowed: false, reason: 'reject_server_not_B2' };
  return { allowed: true, winner: successful[0].writer, losersMust: ['reread', 'merge', 'retry'] };
}
