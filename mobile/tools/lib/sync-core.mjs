// Reference implementation of the client-side sync rules frozen by SYNC_STATE_MACHINE.md.
// Kotlin and Swift ports must reproduce these outputs byte-for-byte via generated fixtures.
import { entityRegistry, forbiddenMaskFields } from './contracts.mjs';

export const BINDING_STATES = Object.freeze([
  'UNBOUND', 'BOUND_NEEDS_BOOTSTRAP', 'BOOTSTRAPPING', 'CATCHING_UP', 'IDLE',
  'RUNNING', 'CONFLICTED', 'REAUTH_REQUIRED', 'REVOKED', 'FATAL_INCOMPATIBLE',
]);

export const RUN_PHASES = Object.freeze([
  'VALIDATE_BINDING', 'RECOVER_BOOTSTRAP', 'BOOTSTRAP_PAGE', 'CATCH_UP_PULL',
  'PUSH_PENDING', 'PULL_CHANGES', 'APPLY_BLOBS', 'ACK_CURSOR', 'COMMIT_SUCCESS',
]);

export const FIRST_BIND_PHASES = Object.freeze([
  'VALIDATE_BINDING', 'BOOTSTRAP_PAGE', 'CATCH_UP_PULL', 'PUSH_PENDING',
  'PULL_CHANGES', 'APPLY_BLOBS', 'ACK_CURSOR', 'COMMIT_SUCCESS',
]);

export const NORMAL_PHASES = Object.freeze([
  'VALIDATE_BINDING', 'PUSH_PENDING', 'PULL_CHANGES', 'APPLY_BLOBS', 'ACK_CURSOR', 'COMMIT_SUCCESS',
]);

export const MAX_OPS_PER_BATCH = 200;
export const APPLIED_OPS_RETENTION_DAYS = 180;
export const TOMBSTONE_RETENTION_DAYS = 180;
export const BLOB_CHUNK_BYTES = 4 * 1024 * 1024;
export const INTERVAL_SEC_MIN = 30;
export const INTERVAL_SEC_MAX = 86400;
export const BACKOFF_STEPS_MS = Object.freeze([1000, 2000, 4000, 8000, 16000, 30000, 60000, 900000]);

const TRANSITIONS = Object.freeze({
  UNBOUND: { bind_success: 'BOUND_NEEDS_BOOTSTRAP' },
  BOUND_NEEDS_BOOTSTRAP: { run: 'BOOTSTRAPPING' },
  BOOTSTRAPPING: { snapshot_complete: 'CATCHING_UP', bootstrap_expired: 'BOUND_NEEDS_BOOTSTRAP' },
  CATCHING_UP: { success: 'IDLE' },
  IDLE: { trigger: 'RUNNING' },
  RUNNING: { success: 'IDLE', conflict_only: 'CONFLICTED' },
  CONFLICTED: { conflicts_resolved: 'IDLE', trigger: 'RUNNING' },
  REAUTH_REQUIRED: { rebind_success: 'BOUND_NEEDS_BOOTSTRAP' },
  REVOKED: { rebind_success: 'BOUND_NEEDS_BOOTSTRAP' },
});

/** Events that apply to any bound state regardless of the current phase. */
const BOUND_OVERRIDES = Object.freeze({
  refresh_invalid: 'REAUTH_REQUIRED',
  token_missing: 'REAUTH_REQUIRED',
  token_rotated: 'REAUTH_REQUIRED',
  device_revoked: 'REVOKED',
  account_unavailable: 'REVOKED',
  registry_incompatible: 'FATAL_INCOMPATIBLE',
  protocol_incompatible: 'FATAL_INCOMPATIBLE',
  cursor_expired: 'BOUND_NEEDS_BOOTSTRAP',
});

/** SID expiry only affects the management plane; the data plane keeps its state. */
export function nextBindingState(current, event) {
  if (!BINDING_STATES.includes(current)) throw new Error(`unknown binding state ${current}`);
  if (event === 'sid_expired') return current;
  if (current !== 'UNBOUND' && BOUND_OVERRIDES[event]) return BOUND_OVERRIDES[event];
  const next = TRANSITIONS[current]?.[event];
  return next ?? current;
}

export function phasesFor(state) {
  return state === 'BOUND_NEEDS_BOOTSTRAP' || state === 'BOOTSTRAPPING'
    ? FIRST_BIND_PHASES.slice()
    : NORMAL_PHASES.slice();
}

/** Manual sync ignores automaticEnabled; only an unbound device disables it. */
export function canRunManualSync(state) {
  return state !== 'UNBOUND' && state !== 'REVOKED' && state !== 'FATAL_INCOMPATIBLE';
}

/**
 * Automatic rounds additionally require a binding that can authenticate right now.
 * REAUTH_REQUIRED keeps manual sync tappable (it surfaces the re-auth prompt) but must never
 * burn unattended retries.
 */
export function canRunAutomaticSync(state, automaticEnabled) {
  return Boolean(automaticEnabled) && canRunManualSync(state) && state !== 'REAUTH_REQUIRED';
}

export function clampIntervalSec(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return 300;
  return Math.min(INTERVAL_SEC_MAX, Math.max(INTERVAL_SEC_MIN, n));
}

export function backoffMs(attempt, jitter = 1) {
  const index = Math.min(BACKOFF_STEPS_MS.length - 1, Math.max(0, Math.trunc(attempt)));
  const clampedJitter = Math.min(1.5, Math.max(0.5, Number(jitter) || 1));
  return Math.round(BACKOFF_STEPS_MS[index] * clampedJitter);
}

let registryCache = null;
function registry() {
  if (!registryCache) {
    registryCache = new Map(entityRegistry().entities.map((e) => [e.type, e]));
  }
  return registryCache;
}

export function entityMeta(entityType) {
  const meta = registry().get(entityType);
  if (!meta) throw new Error(`unknown_entity_type: ${entityType}`);
  return meta;
}

export function dependencyOrder(entityType) {
  return entityMeta(entityType).dependencyOrder ?? 0;
}

/** Push topology: SSH key/proxy -> jump host -> connection -> note links. */
export function sortOperationsForPush(operations) {
  return operations
    .map((op, index) => ({ op, index }))
    .sort((a, b) => {
      const byDependency = dependencyOrder(a.op.entityType) - dependencyOrder(b.op.entityType);
      if (byDependency !== 0) return byDependency;
      return a.index - b.index;
    })
    .map((entry) => entry.op);
}

export function batchOperations(operations, maxPerBatch = MAX_OPS_PER_BATCH) {
  const ordered = sortOperationsForPush(operations);
  const batches = [];
  for (let i = 0; i < ordered.length; i += maxPerBatch) {
    batches.push(ordered.slice(i, i + maxPerBatch));
  }
  return batches;
}

/**
 * Field masks may only name editable fields the user actually changed.
 * Secret, serverAuthority, opaque, deviceLocal and unknown fields are always rejected.
 */
export function sanitizeFieldMask(entityType, requested) {
  const meta = entityMeta(entityType);
  const editable = new Set(meta.editableFields ?? []);
  const forbidden = new Set(forbiddenMaskFields(meta));
  const accepted = [];
  const rejected = [];
  for (const field of requested ?? []) {
    const root = String(field).split(/[.[]/)[0];
    if (forbidden.has(root) || forbidden.has(field)) rejected.push({ field, reason: 'forbidden' });
    else if (!editable.has(root) && !editable.has(field)) rejected.push({ field, reason: 'unknown' });
    else if (accepted.includes(field)) rejected.push({ field, reason: 'duplicate' });
    else accepted.push(field);
  }
  return { accepted, rejected };
}

/**
 * Collapse unsent operations for one entity.
 * create+updates -> single upsert; create+delete -> nothing; updates -> merged mask keeping the
 * oldest baseRevision; delete dominates later stale edits.
 */
export function foldPendingOperations(operations) {
  const groups = new Map();
  const order = [];
  for (const op of operations) {
    const key = `${op.entityType}::${op.entityId}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key).push(op);
  }

  const folded = [];
  for (const key of order) {
    const group = groups.get(key);
    const createdLocally = group.some((op) => op.action === 'upsert' && op.createdLocally === true);
    const lastDelete = [...group].reverse().find((op) => op.action === 'delete');
    const lastRestore = [...group].reverse().find((op) => op.action === 'restore');

    if (lastDelete && createdLocally && !lastRestore) continue;

    if (lastDelete && (!lastRestore || group.indexOf(lastRestore) < group.indexOf(lastDelete))) {
      folded.push({ ...lastDelete, fieldMask: [], payload: {} });
      continue;
    }

    const upserts = group.filter((op) => op.action === 'upsert');
    if (upserts.length === 0) {
      folded.push(group[group.length - 1]);
      continue;
    }

    const base = upserts[0];
    const mask = [];
    const payload = {};
    for (const op of upserts) {
      for (const field of op.fieldMask ?? []) if (!mask.includes(field)) mask.push(field);
      Object.assign(payload, op.payload ?? {});
    }
    folded.push({
      ...upserts[upserts.length - 1],
      opId: base.opId,
      action: 'upsert',
      createdLocally: createdLocally || undefined,
      baseRevision: Math.min(...upserts.map((op) => op.baseRevision ?? 0)),
      fieldMask: mask,
      payload,
    });
  }
  return folded;
}

/** Non-overlapping field sets merge automatically; overlap is a stable conflict. */
export function classifyPush({ localMask, serverChangedFields, baseRevision, currentRevision }) {
  if (baseRevision === currentRevision) return { status: 'accepted', reason: 'base_matches' };
  const overlap = (localMask ?? []).filter((field) => (serverChangedFields ?? []).includes(field));
  if (overlap.length === 0) return { status: 'accepted', reason: 'non_overlapping_merge' };
  return { status: 'conflict', reason: 'field_overlap', fields: overlap };
}

/** Only apply a change page when it is contiguous with the persisted cursor. */
export function assertContiguousPage(appliedCursor, changes) {
  let cursor = appliedCursor;
  for (const change of changes) {
    if (change.changeSeq <= cursor) continue; // already applied; local revision dedupe handles echoes
    cursor = change.changeSeq;
  }
  return cursor;
}

/** Server revision wins for echoes of our own push. */
export function shouldApplyChange(localRevision, change) {
  if (change.action === 'delete') return true;
  return change.revision > (localRevision ?? 0);
}

export const CONFLICT_RESOLUTIONS = Object.freeze(['use_server', 'keep_local', 'copy_as_new', 'manual_merge']);

/** Each resolution mints a fresh opId against the newest baseRevision. */
export function resolveConflict({ resolution, entityType, entityId, serverRevision, newOpId, mask, payload }) {
  if (!CONFLICT_RESOLUTIONS.includes(resolution)) throw new Error(`unknown resolution ${resolution}`);
  if (resolution === 'use_server') return { operation: null, clearsConflict: true };
  if (resolution === 'copy_as_new') {
    return {
      operation: {
        opId: newOpId,
        entityType,
        entityId: `${entityId}-copy`,
        action: 'upsert',
        baseRevision: 0,
        fieldMask: sanitizeFieldMask(entityType, mask).accepted,
        payload: payload ?? {},
        createdLocally: true,
      },
      clearsConflict: true,
    };
  }
  return {
    operation: {
      opId: newOpId,
      entityType,
      entityId,
      action: 'upsert',
      baseRevision: serverRevision,
      fieldMask: sanitizeFieldMask(entityType, mask).accepted,
      payload: payload ?? {},
    },
    clearsConflict: true,
  };
}
