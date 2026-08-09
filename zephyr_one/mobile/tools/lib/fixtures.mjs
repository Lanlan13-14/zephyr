// Emits cross-platform test fixtures. Kotlin and Swift unit tests read these files so that both
// ports are checked against one reference implementation instead of two hand-written expectations.
import { secretAadBytes, sharedUseAadBytes } from "./aad.mjs";
import * as zft2 from "./zft2.mjs";
import {
  sanitizeFieldMask, foldPendingOperations, classifyPush, sortOperationsForPush,
  batchOperations, shouldApplyChange, resolveConflict, nextBindingState,
} from "./sync-core.mjs";
import { syncVectors, sharedUseVectors } from "./contracts.mjs";

function aadCase(name, kind, input) {
  const bytes = kind === "secret" ? secretAadBytes(input) : sharedUseAadBytes(input);
  return {
    name,
    kind,
    input,
    expectedHex: bytes.toString("hex"),
    expectedBase64: bytes.toString("base64"),
    expectedLength: bytes.length,
  };
}

export function aadVectors() {
  const frozenSecret = syncVectors().aad;
  const frozenShared = sharedUseVectors().aad;

  const secretCanonical = aadCase("canonical-secret", "secret", {
    serverId: "srv-1",
    userId: "usr-1",
    deviceId: "dev-1",
    entityType: "connection",
    entityId: "conn-1",
    fieldName: "password",
    entityRevision: 8,
    keyVersion: 1,
  });
  const sharedCanonical = aadCase("canonical-shared", "shared", {
    serverId: "srv-1",
    userId: "usr-2",
    deviceId: "dev-1",
    sessionId: "sess-1",
    resourceId: "conn-7",
    resourceRevision: 9,
    purpose: "ssh",
    expiresAt: 1786093230000,
    clientNonce: "nonce-1234567890abcdef",
  });

  if (secretCanonical.expectedHex !== frozenSecret.hex) {
    throw new Error("secret AAD drifted from contracts/test-vectors/sync-v1.json");
  }
  if (sharedCanonical.expectedHex !== frozenShared.hex) {
    throw new Error("shared AAD drifted from contracts/test-vectors/shared-use-v1.json");
  }

  const cases = [secretCanonical, sharedCanonical];

  // Every AAD field must change the bytes, otherwise ciphertext could be transplanted.
  const secretMutations = {
    serverId: "srv-2",
    userId: "usr-9",
    deviceId: "dev-2",
    entityType: "sshKey",
    entityId: "conn-2",
    fieldName: "privateKey",
    entityRevision: 9,
    keyVersion: 2,
  };
  for (const [field, value] of Object.entries(secretMutations)) {
    cases.push(aadCase(`secret-mutated-${field}`, "secret", { ...secretCanonical.input, [field]: value }));
  }
  const sharedMutations = {
    deviceId: "dev-2",
    sessionId: "sess-2",
    resourceId: "conn-8",
    resourceRevision: 10,
    purpose: "rdp",
    expiresAt: 1786093230001,
    clientNonce: "nonce-fedcba0987654321",
  };
  for (const [field, value] of Object.entries(sharedMutations)) {
    cases.push(aadCase(`shared-mutated-${field}`, "shared", { ...sharedCanonical.input, [field]: value }));
  }

  return {
    generatedFrom: "mobile/tools/lib/aad.mjs",
    separator: 0,
    cases,
    rejects: [
      { name: "leading-zero-revision", kind: "secret", input: { ...secretCanonical.input, entityRevision: "08" } },
      { name: "empty-field-name", kind: "secret", input: { ...secretCanonical.input, fieldName: "" } },
      { name: "negative-key-version", kind: "secret", input: { ...secretCanonical.input, keyVersion: -1 } },
    ],
  };
}

export function zft2Frames() {
  const frames = [
    {
      name: "ping-request",
      encode: { type: zft2.OP.PING, requestId: 1, flags: 0, meta: {}, payload: null },
    },
    {
      name: "open-request",
      encode: {
        type: zft2.OP.OPEN,
        requestId: 42,
        flags: 0,
        meta: { path: "/data/report.txt", mode: "read" },
        payload: null,
      },
    },
    {
      name: "read-response",
      encode: {
        type: zft2.OP.READ,
        requestId: 7,
        flags: zft2.FLAG_RESPONSE,
        meta: { handle: 3, offset: 0, length: 5 },
        payloadUtf8: "hello",
      },
    },
    {
      name: "error-response",
      encode: {
        type: zft2.OP.WRITE,
        requestId: 9,
        flags: zft2.FLAG_RESPONSE | zft2.FLAG_ERROR,
        meta: { code: "read_only_share", message: "provider is read only" },
        payload: null,
      },
    },
    {
      name: "unicode-metadata",
      encode: {
        type: zft2.OP.LIST,
        requestId: 4294967295,
        flags: 0,
        meta: { path: "/\u4e2d\u6587/\u30c6\u30b9\u30c8" },
        payload: null,
      },
    },
  ].map((entry) => {
    const payload = entry.encode.payloadUtf8 != null ? Buffer.from(entry.encode.payloadUtf8, "utf8") : entry.encode.payload;
    const bytes = zft2.encodeFrame({ ...entry.encode, payload });
    return {
      name: entry.name,
      type: entry.encode.type,
      requestId: entry.encode.requestId,
      flags: entry.encode.flags,
      meta: entry.encode.meta,
      payloadUtf8: entry.encode.payloadUtf8 ?? null,
      expectedHex: bytes.toString("hex"),
      expectedLength: bytes.length,
    };
  });

  const bad = [
    { name: "bad-magic", hex: Buffer.concat([Buffer.from("XFT2", "ascii"), Buffer.alloc(16)]).toString("hex"), expectedCode: "bad_magic" },
    {
      name: "unsupported-version",
      hex: (() => {
        const buf = Buffer.alloc(zft2.HEADER_BYTES);
        zft2.MAGIC.copy(buf, 0);
        buf[4] = 3;
        return buf.toString("hex");
      })(),
      expectedCode: "unsupported_version",
    },
    { name: "truncated-header", hex: "5a465432", expectedCode: "truncated_header" },
    {
      name: "length-mismatch",
      hex: (() => {
        const buf = Buffer.alloc(zft2.HEADER_BYTES);
        zft2.MAGIC.copy(buf, 0);
        buf[4] = zft2.VERSION;
        buf[5] = zft2.OP.PING;
        buf.writeUInt32BE(1, 8);
        buf.writeUInt32BE(64, 12);
        return buf.toString("hex");
      })(),
      expectedCode: "length_mismatch",
    },
    {
      name: "metadata-length-bomb",
      hex: (() => {
        const buf = Buffer.alloc(zft2.HEADER_BYTES);
        zft2.MAGIC.copy(buf, 0);
        buf[4] = zft2.VERSION;
        buf[5] = zft2.OP.LIST;
        buf.writeUInt32BE(1, 8);
        buf.writeUInt32BE(0xffffffff, 12);
        return buf.toString("hex");
      })(),
      expectedCode: "metadata_too_large",
    },
  ];

  return {
    generatedFrom: "mobile/tools/lib/zft2.mjs",
    headerBytes: zft2.HEADER_BYTES,
    writeOps: zft2.WRITE_OPS,
    inflight: [
      { input: 0, expected: zft2.MAX_INFLIGHT_MIN },
      { input: 8, expected: 8 },
      { input: 99, expected: zft2.MAX_INFLIGHT_MAX },
    ],
    chunkNegotiation: [
      { local: 65536, remote: 32768, expected: 32768 },
      { local: 1048576, remote: 4194304, expected: 1048576 },
    ],
    frames,
    rejects: bad,
  };
}

export function syncCases() {
  const maskCases = [
    {
      name: "connection-accepts-editable",
      entityType: "connection",
      requested: ["name", "host", "rdpQuality"],
    },
    {
      name: "connection-rejects-secret-and-authority",
      entityType: "connection",
      requested: ["name", "password", "revision", "rdpPipeline", "ephemeral", "notAField"],
    },
    {
      name: "connection-rejects-duplicate",
      entityType: "connection",
      requested: ["name", "name"],
    },
    {
      name: "note-nested-path-root-checked",
      entityType: "note",
      requested: ["title", "tags[0]"],
    },
    {
      name: "activity-is-append-only",
      entityType: "activityEvent",
      requested: ["message"],
    },
    {
      name: "clientToken-only-name-editable",
      entityType: "clientToken",
      requested: ["name", "token"],
    },
  ].map((entry) => ({ ...entry, expected: sanitizeFieldMask(entry.entityType, entry.requested) }));

  const foldInputs = {
    "create-then-updates-collapses": [
      { opId: "op-1", entityType: "connection", entityId: "c1", action: "upsert", baseRevision: 0, createdLocally: true, fieldMask: ["name"], payload: { name: "A" } },
      { opId: "op-2", entityType: "connection", entityId: "c1", action: "upsert", baseRevision: 0, fieldMask: ["host"], payload: { host: "h1" } },
      { opId: "op-3", entityType: "connection", entityId: "c1", action: "upsert", baseRevision: 0, fieldMask: ["name"], payload: { name: "B" } },
    ],
    "create-then-delete-disappears": [
      { opId: "op-1", entityType: "note", entityId: "n1", action: "upsert", baseRevision: 0, createdLocally: true, fieldMask: ["title"], payload: { title: "draft" } },
      { opId: "op-2", entityType: "note", entityId: "n1", action: "delete", baseRevision: 0, fieldMask: [], payload: {} },
    ],
    "updates-keep-oldest-base-revision": [
      { opId: "op-1", entityType: "note", entityId: "n2", action: "upsert", baseRevision: 4, fieldMask: ["title"], payload: { title: "t1" } },
      { opId: "op-2", entityType: "note", entityId: "n2", action: "upsert", baseRevision: 6, fieldMask: ["content"], payload: { content: "body" } },
    ],
    "delete-dominates-later-stale-edit": [
      { opId: "op-1", entityType: "snippet", entityId: "s1", action: "upsert", baseRevision: 2, fieldMask: ["name"], payload: { name: "x" } },
      { opId: "op-2", entityType: "snippet", entityId: "s1", action: "delete", baseRevision: 2, fieldMask: [], payload: {} },
    ],
    "restore-after-delete-survives": [
      { opId: "op-1", entityType: "note", entityId: "n3", action: "delete", baseRevision: 3, fieldMask: [], payload: {} },
      { opId: "op-2", entityType: "note", entityId: "n3", action: "restore", baseRevision: 3, fieldMask: [], payload: {} },
    ],
  };

  const pushOrderInput = [
    { opId: "o1", entityType: "note", entityId: "n1", action: "upsert", baseRevision: 1, fieldMask: ["title"], payload: {} },
    { opId: "o2", entityType: "connection", entityId: "c1", action: "upsert", baseRevision: 1, fieldMask: ["name"], payload: {} },
    { opId: "o3", entityType: "jumpHost", entityId: "j1", action: "upsert", baseRevision: 1, fieldMask: ["name"], payload: {} },
    { opId: "o4", entityType: "sshKey", entityId: "k1", action: "upsert", baseRevision: 1, fieldMask: ["name"], payload: {} },
    { opId: "o5", entityType: "proxy", entityId: "p1", action: "upsert", baseRevision: 1, fieldMask: ["name"], payload: {} },
    { opId: "o6", entityType: "clientToken", entityId: "t1", action: "upsert", baseRevision: 1, fieldMask: ["name"], payload: {} },
  ];

  const classifyCases = [
    { name: "base-matches", localMask: ["name"], serverChangedFields: [], baseRevision: 7, currentRevision: 7 },
    { name: "non-overlapping-merge", localMask: ["name"], serverChangedFields: ["remark"], baseRevision: 7, currentRevision: 8 },
    { name: "overlap-conflicts", localMask: ["name"], serverChangedFields: ["name"], baseRevision: 7, currentRevision: 8 },
    { name: "multi-field-overlap", localMask: ["name", "host"], serverChangedFields: ["host", "port"], baseRevision: 7, currentRevision: 9 },
  ].map((entry) => ({ ...entry, expected: classifyPush(entry) }));

  const applyCases = [
    { name: "newer-revision-applies", localRevision: 7, change: { action: "upsert", revision: 8 } },
    { name: "echo-of-own-push-skipped", localRevision: 8, change: { action: "upsert", revision: 8 } },
    { name: "stale-revision-skipped", localRevision: 9, change: { action: "upsert", revision: 8 } },
    { name: "tombstone-always-applies", localRevision: 12, change: { action: "delete", revision: 5 } },
  ].map((entry) => ({ ...entry, expected: shouldApplyChange(entry.localRevision, entry.change) }));

  const conflictCases = [
    { name: "use-server", resolution: "use_server", entityType: "connection", entityId: "c1", serverRevision: 9, newOpId: "op-new", mask: ["name"], payload: { name: "local" } },
    { name: "keep-local", resolution: "keep_local", entityType: "connection", entityId: "c1", serverRevision: 9, newOpId: "op-new", mask: ["name"], payload: { name: "local" } },
    { name: "copy-as-new", resolution: "copy_as_new", entityType: "connection", entityId: "c1", serverRevision: 9, newOpId: "op-new", mask: ["name", "password"], payload: { name: "local" } },
    { name: "manual-merge", resolution: "manual_merge", entityType: "note", entityId: "n1", serverRevision: 4, newOpId: "op-new", mask: ["content"], payload: { content: "merged" } },
  ].map((entry) => ({ ...entry, expected: resolveConflict(entry) }));

  const transitionCases = [
    { from: "UNBOUND", event: "bind_success" },
    { from: "BOUND_NEEDS_BOOTSTRAP", event: "run" },
    { from: "BOOTSTRAPPING", event: "snapshot_complete" },
    { from: "CATCHING_UP", event: "success" },
    { from: "IDLE", event: "trigger" },
    { from: "RUNNING", event: "success" },
    { from: "RUNNING", event: "conflict_only" },
    { from: "IDLE", event: "cursor_expired" },
    { from: "RUNNING", event: "refresh_invalid" },
    { from: "IDLE", event: "device_revoked" },
    { from: "IDLE", event: "registry_incompatible" },
    { from: "CONFLICTED", event: "conflicts_resolved" },
    { from: "REAUTH_REQUIRED", event: "bind_success" },
    { from: "IDLE", event: "sid_expired" },
  ].map((entry) => ({ ...entry, expected: nextBindingState(entry.from, entry.event) }));

  return {
    generatedFrom: "mobile/tools/lib/sync-core.mjs",
    fieldMask: maskCases,
    fold: Object.entries(foldInputs).map(([name, operations]) => ({
      name,
      operations,
      expected: foldPendingOperations(operations),
    })),
    pushOrder: {
      input: pushOrderInput,
      expectedOpIds: sortOperationsForPush(pushOrderInput).map((op) => op.opId),
      expectedBatchCount: batchOperations(pushOrderInput, 2).length,
    },
    classifyPush: classifyCases,
    applyChange: applyCases,
    conflictResolution: conflictCases,
    transitions: transitionCases,
  };
}

export function fixtures() {
  return {
    "aad-vectors.json": aadVectors(),
    "zft2-frames.json": zft2Frames(),
    "sync-cases.json": syncCases(),
  };
}

/** Same fixtures, serialized deterministically for checked-in files. */
export function fixtureFiles() {
  const out = {};
  for (const [name, value] of Object.entries(fixtures())) {
    out[name] = JSON.stringify(value, null, 2) + "\n";
  }
  return out;
}
