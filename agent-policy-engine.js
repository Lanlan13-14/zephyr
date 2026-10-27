'use strict';

/**
 * Production Agent local-policy evaluator.
 *
 * Spec: ZEPHYR-LINK-INTERCONNECTION-SPEC.md §8.2 (deterministic evaluation order).
 * Independent of the documentation reference adapter.
 */

const CHANNELS = Object.freeze([
    'control', 'owned-sync', 'secret', 'blob', 'file-bridge',
    'shared-terminal', 'shared-remote', 'shared-note', 'shared-file',
    'ai', 'agent-tunnel',
]);

const OPERATIONS = Object.freeze([
    'list', 'stat', 'read', 'write', 'mkdir', 'delete', 'rename', 'truncate',
    'revealSecret', 'remoteWipe',
    'clipboard.read', 'clipboard.write', 'clipboard.fileManifest', 'clipboard.fileRead',
    'tunnel.local', 'tunnel.remote', 'tunnel.dynamic', 'drive.map', 'desktop.control',
    'ai.read', 'ai.write', 'ai.execute', 'offload.invoke',
]);

const LIMIT_FIELDS = Object.freeze([
    'maxFileBytes', 'maxInflight', 'maxChunkBytes', 'maxDailyBytes',
    'maxDirectoryDepth', 'maxRequestsPerMinute',
]);

const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', '::1']);

const POLICY_KEYS = Object.freeze(['schemaVersion', 'agentId', 'policyGeneration', 'defaultEffect', 'rules']);
const RULE_KEYS = Object.freeze([
    'ruleId', 'subjects', 'channels', 'operations', 'shares',
    'networkTargets', 'listenHosts', 'offloadCapabilities', 'effect', 'limits', 'expiresAt',
]);
const LIMIT_KEYS = Object.freeze(LIMIT_FIELDS);

const SUBJECT_PATTERN = /^(user|device|group):[A-Za-z0-9_.:-]{1,160}$/;
const RULE_ID_PATTERN = /^rule_[A-Za-z0-9_-]{4,96}$/;
const SHARE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const OFFLOAD_PATTERN = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/;

function object(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyText(value, maxLength) {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function uniqueStrings(arr) {
    return Array.isArray(arr) && new Set(arr).size === arr.length;
}

function isPolicyDocument(input) {
    return object(input)
        && Object.prototype.hasOwnProperty.call(input, 'schemaVersion')
        && Object.prototype.hasOwnProperty.call(input, 'rules')
        && !Object.prototype.hasOwnProperty.call(input, 'operation')
        && !Object.prototype.hasOwnProperty.call(input, 'subject');
}

function extraKeys(value, allowed) {
    return Object.keys(value).filter((key) => !allowed.includes(key));
}

function integerInRange(value, min, max) {
    return Number.isInteger(value) && value >= min && (max === undefined || value <= max);
}

function validateLimits(limits) {
    if (!object(limits)) return false;
    if (extraKeys(limits, LIMIT_KEYS).length) return false;
    if (limits.maxFileBytes !== undefined && !integerInRange(limits.maxFileBytes, 0, 1099511627776)) return false;
    if (limits.maxInflight !== undefined && !integerInRange(limits.maxInflight, 0, 64)) return false;
    if (limits.maxChunkBytes !== undefined) {
        if (limits.maxChunkBytes === 0) {
            // explicit disable is valid
        } else if (!integerInRange(limits.maxChunkBytes, 65536, 262144)) {
            return false;
        }
    }
    if (limits.maxDailyBytes !== undefined && !integerInRange(limits.maxDailyBytes, 0)) return false;
    if (limits.maxDirectoryDepth !== undefined && !integerInRange(limits.maxDirectoryDepth, 0, 256)) return false;
    if (limits.maxRequestsPerMinute !== undefined && !integerInRange(limits.maxRequestsPerMinute, 0, 100000)) return false;
    return true;
}

function validateStringArray(arr, { minItems, maxItems, unique, itemCheck }) {
    if (!Array.isArray(arr)) return false;
    if (minItems !== undefined && arr.length < minItems) return false;
    if (maxItems !== undefined && arr.length > maxItems) return false;
    if (unique && !uniqueStrings(arr)) return false;
    if (!arr.every((item) => typeof item === 'string' && itemCheck(item))) return false;
    return true;
}

function validateRule(rule) {
    if (!object(rule)) return false;
    if (extraKeys(rule, RULE_KEYS).length) return false;
    for (const required of ['ruleId', 'subjects', 'channels', 'operations', 'effect', 'limits']) {
        if (!Object.prototype.hasOwnProperty.call(rule, required)) return false;
    }
    if (typeof rule.ruleId !== 'string' || !RULE_ID_PATTERN.test(rule.ruleId)) return false;
    if (!validateStringArray(rule.subjects, { minItems: 1, maxItems: 64, unique: true, itemCheck: (s) => SUBJECT_PATTERN.test(s) })) return false;
    if (!validateStringArray(rule.channels, { minItems: 1, unique: true, itemCheck: (s) => CHANNELS.includes(s) })) return false;
    if (!validateStringArray(rule.operations, { minItems: 1, unique: true, itemCheck: (s) => OPERATIONS.includes(s) })) return false;
    if (rule.shares !== undefined && !validateStringArray(rule.shares, { maxItems: 128, unique: true, itemCheck: (s) => SHARE_PATTERN.test(s) })) return false;
    if (rule.networkTargets !== undefined && !validateStringArray(rule.networkTargets, { maxItems: 256, unique: true, itemCheck: (s) => s.length <= 256 })) return false;
    if (rule.listenHosts !== undefined && !validateStringArray(rule.listenHosts, { maxItems: 16, unique: true, itemCheck: (s) => s.length > 0 && s.length <= 255 })) return false;
    if (rule.offloadCapabilities !== undefined && !validateStringArray(rule.offloadCapabilities, { maxItems: 64, unique: true, itemCheck: (s) => OFFLOAD_PATTERN.test(s) })) return false;
    if (rule.effect !== 'allow' && rule.effect !== 'deny') return false;
    if (!validateLimits(rule.limits)) return false;
    if (rule.expiresAt !== undefined && rule.expiresAt !== null && !integerInRange(rule.expiresAt, 0)) return false;
    return true;
}

function validateAgentPolicyDocument(input) {
    if (!object(input)) return 'schema_invalid';
    if (extraKeys(input, POLICY_KEYS).length) return 'schema_invalid';
    if (input.schemaVersion !== 1) return 'schema_invalid';
    if (!nonEmptyText(input.agentId, 160)) return 'schema_invalid';
    if (!integerInRange(input.policyGeneration, 1)) return 'schema_invalid';
    if (input.defaultEffect !== 'deny') return 'schema_invalid';
    if (!Array.isArray(input.rules) || input.rules.length > 512) return 'schema_invalid';
    const ruleIds = [];
    for (const rule of input.rules) {
        if (!validateRule(rule)) return 'schema_invalid';
        ruleIds.push(rule.ruleId);
    }
    if (new Set(ruleIds).size !== ruleIds.length) return 'schema_invalid';
    return 'valid';
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

function resourceListAllows(list, requested) {
    if (requested === undefined || requested === null || requested === '') return true;
    if (!Array.isArray(list) || !list.includes(requested)) return false;
    return true;
}

function ruleMatches(rule, input) {
    if (!object(rule)) return false;
    if (rule.expiresAt != null && input.now >= rule.expiresAt) return false;
    if (!Array.isArray(rule.subjects) || !rule.subjects.includes(input.subject)) return false;
    if (!Array.isArray(rule.channels) || !rule.channels.includes(input.channel)) return false;
    if (!Array.isArray(rule.operations) || !rule.operations.includes(input.operation)) return false;
    if (!resourceListAllows(rule.shares || [], input.share)) return false;
    if (!resourceListAllows(rule.networkTargets || [], input.networkTarget)) return false;
    if (!resourceListAllows(rule.listenHosts || [], input.listenHost)) return false;
    if (!resourceListAllows(rule.offloadCapabilities || [], input.offloadCapability)) return false;
    return true;
}

function authorityAllows(authority, input) {
    if (!object(authority) || authority.effect !== 'allow') return false;
    if (!Array.isArray(authority.operations) || !authority.operations.includes(input.operation)) return false;
    if (authority.channels && !authority.channels.includes(input.channel)) return false;
    if (input.share) {
        if (!authority.shares || !authority.shares.includes(input.share)) return false;
    }
    if (input.networkTarget) {
        if (!authority.networkTargets || !authority.networkTargets.includes(input.networkTarget)) return false;
    }
    if (input.listenHost) {
        if (!authority.listenHosts || !authority.listenHosts.includes(input.listenHost)) return false;
    }
    if (input.offloadCapability) {
        if (!authority.offloadCapabilities || !authority.offloadCapabilities.includes(input.offloadCapability)) return false;
    }
    return true;
}

function requiresApproval(input) {
    if (['delete', 'revealSecret', 'remoteWipe'].includes(input.operation)) return true;
    if (input.listenHost && !LOOPBACK_HOSTS.includes(input.listenHost)) return true;
    if (input.riskLevel === 'high') return true;
    if (input.sharedWrite === true) return true;
    return false;
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

function intersectPositiveLimits(allows) {
    const ceiling = {};
    for (const rule of allows) {
        const limits = rule.limits || {};
        for (const name of Object.keys(limits)) {
            const value = limits[name];
            if (value === 0) return { exceeded: true };
            if (typeof value === 'number' && value > 0) {
                if (ceiling[name] === undefined || value < ceiling[name]) ceiling[name] = value;
            }
        }
    }
    return { exceeded: false, ceiling };
}

function usageExceeds(input, ceiling) {
    const usage = input.usage || {};
    for (const [name, max] of Object.entries(ceiling)) {
        if (usage[name] !== undefined && usage[name] > max) return true;
    }
    return false;
}

/**
 * Evaluate one Agent request against local policy ∩ primary ACL ∩ system grant.
 * Returns 'allow' or a stable denial code.
 */
function evaluateAgentPolicy(requestContext) {
    if (!object(requestContext)) return 'schema_invalid';
    if (isPolicyDocument(requestContext)) return validateAgentPolicyDocument(requestContext);

    const input = {
        ...requestContext,
        now: requestContext.now ?? 0,
        localOperations: requestContext.localOperations || [],
        localShares: requestContext.localShares || [],
        primaryOperations: requestContext.primaryOperations || [],
        systemOperations: requestContext.systemOperations || [],
    };

    if (typeof input.operation !== 'string' || input.operation.length === 0) return 'schema_invalid';
    if (typeof input.subject !== 'string' || typeof input.channel !== 'string') return 'schema_invalid';

    // 1. Unknown operations default deny (do not silently ignore).
    const unknownOperation = !OPERATIONS.includes(input.operation);

    // 2. paused / revoked / offline-requires-online.
    if (input.agentRevoked) return 'agent_revoked';
    if (input.paused) return 'agent_paused';
    if (input.primaryOffline && !input.localAuthorizedOffline) return 'primary_unavailable';

    // 3. policy generation must match the session.
    if (input.generation !== input.sessionGeneration) return 'agent_policy_generation_stale';

    // 4–6. Collect matches. Empty resource lists are not wildcards. Deny wins.
    const rules = toRules(input);
    const matched = unknownOperation ? [] : rules.filter((rule) => ruleMatches(rule, input));
    if (matched.some((rule) => rule.effect === 'deny')) return 'agent_local_policy_denied';
    const allows = matched.filter((rule) => rule.effect === 'allow');
    if (!allows.length) return 'agent_local_policy_denied';

    // 7 + 11. Intersect positive limits; explicit 0 forbids the dimension.
    // Refuse when current usage already exceeds the bound (debit-before-execute).
    const limitState = intersectPositiveLimits(allows);
    if (limitState.exceeded) return 'agent_quota_exceeded';
    if (usageExceeds(input, limitState.ceiling)) return 'agent_quota_exceeded';

    // 8. Primary ACL ∩ system authorization. Failures keep distinct codes.
    const primaryAuthority = {
        effect: 'allow',
        operations: input.primaryOperations,
        channels: input.primaryChannels,
        shares: input.primaryShares,
        networkTargets: input.primaryNetworkTargets,
        listenHosts: input.primaryListenHosts,
        offloadCapabilities: input.primaryOffloadCapabilities,
    };
    if (!authorityAllows(primaryAuthority, input)) return 'primary_acl_denied';

    const systemAuthority = {
        effect: 'allow',
        operations: input.systemOperations,
        channels: input.systemChannels,
        shares: input.systemShares,
        networkTargets: input.systemNetworkTargets,
        listenHosts: input.systemListenHosts,
        offloadCapabilities: input.systemOffloadCapabilities,
    };
    if (input.systemGrantChangedBeforeExecution || !authorityAllows(systemAuthority, input)) {
        return 'system_grant_denied';
    }

    // 9. High-risk operations need a confirmation bound to this request.
    if (requiresApproval(input) && !approvalValid(input)) return 'approval_required';

    // 10. Re-authorize before returning a prior receipt. Revocation must win.
    // Different payload on the same idempotency key is a conflict, not a replay.
    if (input.retrySameIdempotencyDifferentPayload) return 'idempotency_conflict';
    if (input.retrySameRequest) return 'return_original_receipt';

    return 'allow';
}

module.exports = {
    evaluateAgentPolicy,
    validateAgentPolicyDocument,
    CHANNELS,
    OPERATIONS,
};
