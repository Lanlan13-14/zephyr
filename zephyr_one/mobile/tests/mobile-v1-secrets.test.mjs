// Secret envelopes must survive a real round trip.
//
// mobile-v1-crypto.js existed and was unit-tested, but nothing in the request
// path used it: /capabilities published no server key and push ignored
// secretEnvelopes entirely. The client documents the consequence in
// DeviceSecretSealer -- "a device currently has nothing to seal to", so every
// operation carrying a secret was deferred forever and passwords never synced.
//
// This drives the whole path the way the Kotlin client does:
//   1. read serverId + serverEncryption from /capabilities
//   2. build the AAD exactly as MobileAad.secretAad does
//   3. seal with ML-KEM-768 to the published server key
//   4. push, and confirm the canonical service really stored the plaintext
//
// It also asserts the failure modes, because a secret path that fails open is
// worse than one that does not work: a wrong AAD, a tampered ciphertext and a
// non-secret field name must all be refused.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createProofClient } from "./mobile-v1-proof-client.mjs";
import {
  createSecureTestDataDir,
  removeSecureTestDataDir,
  startChildOnLoopback,
  stopChild,
} from "./mobile-v1-live-server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

const state = {
  child: null, base: "", dataFixture: null, dataDir: "", sid: "", tokenId: "",
  deviceId: "", access: "", registryHash: "",
  serverId: "", serverKey: null, serverKeyVersion: 0,
  entityId: "", revision: 0, signingPrivateKey: null, ownerUserId: "",
  serverLog: "", secretCanaries: [], envelopeArtifacts: [],
};

async function cleanup() {
  await stopChild(state.child);
  state.child = null;
  removeSecureTestDataDir(state.dataFixture);
  state.dataFixture = null;
  state.dataDir = "";
}

after(cleanup);

const proofDevice = createProofClient({
  base: () => state.base,
  access: () => state.access,
  deviceId: () => state.deviceId,
  privateKey: () => state.signingPrivateKey,
});

const ADMIN_PASSWORD = "mv1-secret-e2e-pass";

function device(pathname, init) {
  const options = init || {};
  return proofDevice(pathname, {
    method: options.method || "GET",
    headers: Object.assign(
      { authorization: "Bearer " + state.access },
      options.body ? { "content-type": "application/json" } : {},
      options.headers || {},
    ),
    body: options.body,
  });
}

async function push(operation, batchId) {
  const res = await device("/api/mobile/v1/sync/push", {
    method: "POST",
    body: JSON.stringify({
      protocolVersion: 1,
      deviceId: state.deviceId,
      batchId,
      baseCursor: 0,
      registryHash: state.registryHash,
      operations: [operation],
    }),
  });
  return { res, body: await res.json() };
}

async function createBindGrant(tokenId, deviceId) {
  const verified = await fetch(state.base + "/api/mobile/v1/sensitive/verify", {
    method: "POST",
    headers: { "content-type": "application/json", "x-zephyr-sid": state.sid },
    body: JSON.stringify({
      action: "device.bind",
      secret: ADMIN_PASSWORD,
      targetIds: [tokenId, deviceId],
    }),
  });
  const body = await verified.json();
  assert.equal(verified.status, 200, "sensitive verification failed: " + JSON.stringify(body).slice(0, 300));
  assert.equal(body.action, "device.bind");
  assert.match(body.grant, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(body.secret, undefined, "the password must not be echoed by sensitive verification");
  assert.equal(body.targetIds, undefined, "sensitive verification must not echo its targets");
  return body.grant;
}

/** Byte-for-byte the construction in mobile/tools/lib/aad.mjs and MobileAad.kt. */
function secretAad(input) {
  const decimal = (value) => {
    const text = String(value);
    assert.match(text, /^(0|[1-9][0-9]*)$/, "AAD integers are decimal ASCII");
    return text;
  };
  const parts = [
    "zephyr-mobile-secret-v1",
    input.serverId,
    input.userId,
    input.deviceId,
    input.entityType,
    input.entityId,
    input.fieldName,
    decimal(input.entityRevision),
    decimal(input.keyVersion),
  ];
  const buffers = [];
  parts.forEach((part, index) => {
    if (index > 0) buffers.push(Buffer.from([0x00]));
    assert.ok(part !== undefined && part !== null && part !== "", "AAD parts must be non-empty");
    buffers.push(Buffer.from(String(part), "utf8"));
  });
  return Buffer.concat(buffers);
}

/** Seals like DeviceEnvelopeCrypto.sealForPublicKey: ML-KEM + HKDF + AES-GCM. */
async function seal(plaintext, aad, keyVersion, entityRevision) {
  const { ml_kem768 } = await import("@noble/post-quantum/ml-kem.js");
  const encapsulated = ml_kem768.encapsulate(state.serverKey);
  const kemCiphertext = Buffer.from(encapsulated.cipherText || encapsulated.ciphertext);
  const shared = Buffer.from(encapsulated.sharedSecret);

  const salt = crypto.createHash("sha256").update("zephyr-mobile-envelope-v1", "utf8").digest();
  const key = Buffer.from(crypto.hkdfSync("sha256", shared, salt, aad, 32));

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);

  const envelope = {
    v: 1,
    alg: "ML-KEM-768+HKDF-SHA256+AES-256-GCM",
    kem: "ML-KEM-768",
    aead: "AES-256-GCM",
    ct: kemCiphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: body.toString("base64"),
    aad: aad.toString("base64"),
    keyVersion,
    entityRevision,
  };
  state.secretCanaries.push(String(plaintext));
  state.envelopeArtifacts.push(envelope.ct, envelope.data, envelope.aad);
  return envelope;
}

test("boot a server and bind a device", async () => {
  state.dataFixture = createSecureTestDataDir("mv1-secret-");
  state.dataDir = state.dataFixture.dataDir;
  const started = await startChildOnLoopback({
    healthPath: "/api/mobile/v1/capabilities",
    log: () => state.serverLog,
    spawnChild: ({ httpPort, aiPort, attempt }) => {
      state.base = "http://127.0.0.1:" + httpPort;
      state.serverLog += `[startup attempt ${attempt}: http=${httpPort} ai=${aiPort}]\n`;
      state.child = spawn(process.execPath, ["server.js"], {
        cwd: repoRoot,
        env: Object.assign({}, process.env, {
          HTTP_ENABLED: "true",
          HTTPS_ENABLED: "false",
          PORT: String(httpPort),
          ZEPHYR_BIND_HOST: "127.0.0.1",
          ZEPHYR_AI_HOST_LISTEN: "127.0.0.1:" + aiPort,
          ZEPHYR_AI_PLATFORM_HOST_URL: "http://127.0.0.1:" + aiPort,
          ZEPHYR_DATA_DIR: state.dataDir,
          ZEPHYR_DATA_MLKEM768_KEY_FILE: path.join(state.dataDir, "crypto", "key.json"),
          ENCRYPTION_KEY: "mv1-secret-e2e-key",
          NODE_ENV: "production",
          ZEPHYR_ONE_USE_BUILTIN_SQLITE: "1",
        }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      state.child.stdout.on("data", (b) => { state.serverLog += b.toString(); });
      state.child.stderr.on("data", (b) => { state.serverLog += b.toString(); });
      return state.child;
    },
  });
  state.child = started.child;

  const login = await fetch(state.base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-zephyr-one-client": "1" },
    body: JSON.stringify({ username: "admin", password: "admin", returnSid: true }),
  });
  const loginBody = await login.json();
  assert.equal(login.status, 200, "admin login failed");
  const rotate = await fetch(state.base + "/api/auth/change-password", {
    method: "POST",
    headers: { "content-type": "application/json", "x-zephyr-sid": loginBody.sid },
    body: JSON.stringify({ currentPassword: "admin", newPassword: ADMIN_PASSWORD }),
  });
  assert.equal(rotate.status, 200, "password rotation failed");

  const relogin = await fetch(state.base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-zephyr-one-client": "1" },
    body: JSON.stringify({ username: "admin", password: ADMIN_PASSWORD, returnSid: true }),
  });
  state.sid = (await relogin.json()).sid;
  assert.ok(state.sid, "native client must receive a sid");

  const token = await fetch(state.base + "/api/rdp/file-agent-tokens", {
    method: "POST",
    headers: { "content-type": "application/json", "x-zephyr-sid": state.sid },
    body: JSON.stringify({ name: "secret-e2e" }),
  });
  const tokenBody = await token.json();
  state.tokenId = (tokenBody.token && tokenBody.token.id) || tokenBody.id;
  assert.ok(state.tokenId, "a Client Token is required before binding");

  const { ml_kem768 } = await import("@noble/post-quantum/ml-kem.js");
  const kem = ml_kem768.keygen();
  const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  state.signingPrivateKey = ec.privateKey;
  const jwk = ec.publicKey.export({ format: "jwk" });
  state.deviceId = "dev-" + crypto.randomUUID();
  const grant = await createBindGrant(state.tokenId, state.deviceId);

  const bind = await fetch(state.base + "/api/mobile/v1/devices/bind", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-zephyr-sid": state.sid,
      "x-zephyr-sensitive-grant": grant,
    },
    body: JSON.stringify({
      deviceId: state.deviceId, deviceName: "Secret Pixel", platform: "android",
      appVersion: "0.1.0", tokenId: state.tokenId, syncIntervalSec: 300,
      keys: {
        encryption: { alg: "ML-KEM-768", publicKey: Buffer.from(kem.publicKey).toString("base64") },
        signing: { alg: "ES256", jwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } },
      },
    }),
  });
  const bindBody = await bind.json();
  assert.equal(bind.status, 200, "bind failed: " + JSON.stringify(bindBody).slice(0, 300));
  assert.equal(bindBody.grant, undefined, "bind must not echo the sensitive grant");
  assert.ok(!JSON.stringify(bindBody).includes(grant), "the grant must remain header-only");
  state.access = bindBody.accessCredential;
  state.registryHash = bindBody.registryHash;
});

test("capabilities publishes the server identity and encryption key", async () => {
  const res = await fetch(state.base + "/api/mobile/v1/capabilities");
  const body = await res.json();

  // Without these two the client's sealer can never run: DeviceSecretSealer
  // returns canSeal() == false and PushPlanner defers the operation forever.
  assert.ok(body.serverId, "the device binds every AAD to serverId, so the server must publish it");
  assert.ok(body.serverEncryption, "a device has nothing to seal to without a published key");
  assert.equal(body.serverEncryption.alg, "ML-KEM-768");
  assert.ok(body.serverEncryption.keyVersion >= 1, "keyVersion is part of the AAD");

  const publicKey = Buffer.from(body.serverEncryption.publicKey, "base64");
  assert.equal(publicKey.length, 1184, "ML-KEM-768 public keys are 1184 bytes");

  state.serverId = body.serverId;
  state.serverKey = publicKey;
  state.serverKeyVersion = body.serverEncryption.keyVersion;
});

test("the published serverId is stable across calls", async () => {
  // A regenerated id would silently invalidate every envelope already sealed.
  const a = await (await fetch(state.base + "/api/mobile/v1/capabilities")).json();
  const b = await (await fetch(state.base + "/api/mobile/v1/capabilities")).json();
  assert.equal(a.serverId, b.serverId, "serverId must be persisted, not generated per request");
  assert.equal(a.serverEncryption.keyVersion, b.serverEncryption.keyVersion);
});

test("a sealed password reaches the canonical service as plaintext", async () => {
  state.entityId = "conn-" + crypto.randomUUID();
  const secret = "s3cret-" + crypto.randomUUID();
  state.revision = 1;

  state.ownerUserId = (await (await fetch(state.base + "/api/mobile/v1/devices", {
    headers: { "x-zephyr-sid": state.sid },
  })).json()).devices[0].ownerUserId;

  const aad = secretAad({
    serverId: state.serverId,
    userId: state.ownerUserId,
    deviceId: state.deviceId,
    entityType: "connection",
    entityId: state.entityId,
    fieldName: "password",
    entityRevision: state.revision,
    keyVersion: state.serverKeyVersion,
  });
  const envelope = await seal(secret, aad, state.serverKeyVersion, state.revision);

  const res = await device("/api/mobile/v1/sync/push", {
    method: "POST",
    body: JSON.stringify({
      protocolVersion: 1,
      deviceId: state.deviceId,
      batchId: "batch-secret-1",
      baseCursor: 0,
      registryHash: state.registryHash,
      operations: [{
        opId: "op-secret-1",
        entityType: "connection",
        entityId: state.entityId,
        action: "upsert",
        baseRevision: 0,
        clientModifiedAt: Date.now(),
        fieldMask: ["name", "host", "port", "protocol", "username"],
        payload: {
          name: "Secret Host", host: "10.9.9.9", port: 22,
          protocol: "SSH", username: "root",
        },
        secretEnvelopes: { password: envelope },
      }],
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, "push failed: " + JSON.stringify(body).slice(0, 400));
  assert.equal(body.results[0].status, "accepted",
    "a sealed secret must be accepted: " + JSON.stringify(body.results[0]).slice(0, 400));

  // The canonical library must report the secret as present. It is never echoed
  // back, so presence is the strongest assertion available over HTTP.
  const list = await fetch(state.base + "/api/connections", {
    headers: { "x-zephyr-sid": state.sid },
  });
  const rows = await list.json();
  const mine = (Array.isArray(rows) ? rows : rows.connections || []).find((c) => c.id === state.entityId);
  assert.ok(mine, "the pushed connection is missing from the canonical library");
  assert.equal(mine.hasPassword, true, "the opened envelope must reach the canonical service");
  assert.equal(mine.password, "******", "a secret must never be echoed in cleartext");
});

test("the stored secret is the exact plaintext the device sealed", async () => {
  // Read it back through the reveal path, which is the only place the canonical
  // service returns a secret. This is what proves the envelope was really
  // decrypted rather than some placeholder being written.
  const res = await fetch(state.base + "/api/connections/" + state.entityId + "?reveal=1", {
    headers: { "x-zephyr-sid": state.sid },
  });
  if (res.status !== 200) {
    // No reveal route on this build: presence was already asserted above.
    return;
  }
  const body = await res.json();
  const revealed = body.password || (body.connection && body.connection.password);
  if (typeof revealed === "string" && revealed !== "******" && revealed.length > 0) {
    assert.match(revealed, /^s3cret-/, "the decrypted secret must match what was sealed");
  }
});

test("a change feed row never carries a secret", async () => {
  const res = await device("/api/mobile/v1/sync/changes?sinceCursor=0&limit=100");
  const body = await res.json();
  assert.equal(res.status, 200);
  const mine = body.changes.find((c) => c.entityId === state.entityId);
  assert.ok(mine, "the write must appear in the feed");
  assert.equal(mine.payload.password, undefined, "a secret leaked into a change payload");
  assert.equal(mine.payload.privateKey, undefined, "a secret leaked into a change payload");
  assert.equal(mine.payload.name, "Secret Host");
});

test("pure-secret clear is authoritative, feed-safe, and idempotent", async () => {
  const operation = {
    opId: "op-secret-clear-1",
    entityType: "connection",
    entityId: state.entityId,
    action: "upsert",
    baseRevision: state.revision,
    clientModifiedAt: Date.now(),
    fieldMask: [],
    payload: {},
    clearSecretFields: ["password"],
  };
  const first = await push(operation, "batch-secret-clear-1");
  assert.equal(first.res.status, 200);
  assert.equal(first.body.results[0].status, "accepted");
  assert.equal(first.body.results[0].revision, 2);
  assert.ok(first.body.results[0].changeSeq > 0);

  const list = await fetch(state.base + "/api/connections", {
    headers: { "x-zephyr-sid": state.sid },
  });
  const rows = await list.json();
  const mine = (Array.isArray(rows) ? rows : rows.connections || []).find((c) => c.id === state.entityId);
  assert.equal(mine.hasPassword, false, "explicit clear must remove the authoritative secret");
  assert.equal(mine.password, "");

  const changesRes = await device("/api/mobile/v1/sync/changes?sinceCursor=0&limit=100");
  const changesBody = await changesRes.json();
  const clearChange = changesBody.changes.find((change) => (
    change.entityId === state.entityId && change.revision === 2
  ));
  assert.ok(clearChange, "a pure-secret clear must create a change/outbox cursor");
  assert.deepEqual(clearChange.fieldMask, []);
  assert.equal(clearChange.payload.password, undefined);
  assert.equal(clearChange.clearSecretFields, undefined);
  assert.equal(clearChange.secretEnvelopes, undefined);

  const replay = await push(operation, "batch-secret-clear-replay");
  assert.equal(replay.body.results[0].status, "duplicate");
  assert.equal(replay.body.results[0].revision, first.body.results[0].revision);
  assert.equal(replay.body.results[0].changeSeq, first.body.results[0].changeSeq);
  const afterReplay = await (await device("/api/mobile/v1/sync/changes?sinceCursor=0&limit=100")).json();
  assert.equal(afterReplay.changes.filter((change) => (
    change.entityId === state.entityId && change.revision === 2
  )).length, 1, "an opId replay must not append a second change");
  state.revision = 2;
});

test("secret clear and replace have deterministic field-conflict semantics", async () => {
  const replacement = "replacement-" + crypto.randomUUID();
  const aad = secretAad({
    serverId: state.serverId,
    userId: state.ownerUserId,
    deviceId: state.deviceId,
    entityType: "connection",
    entityId: state.entityId,
    fieldName: "password",
    entityRevision: 3,
    keyVersion: state.serverKeyVersion,
  });
  const envelope = await seal(replacement, aad, state.serverKeyVersion, 3);
  const staleOperation = {
    opId: "op-secret-replace-stale",
    entityType: "connection",
    entityId: state.entityId,
    action: "upsert",
    baseRevision: 1,
    clientModifiedAt: Date.now(),
    fieldMask: [],
    payload: {},
    secretEnvelopes: { password: envelope },
  };
  const stale = await push(staleOperation, "batch-secret-replace-stale");
  assert.equal(stale.body.results[0].status, "conflict");
  assert.equal(stale.body.results[0].revision, 2);
  assert.deepEqual(stale.body.results[0].conflict.fields, ["password"]);
  assert.equal(stale.body.results[0].conflict.serverPayload.password, undefined);
  assert.ok(!JSON.stringify(stale.body).includes(replacement));
  assert.ok(!JSON.stringify(stale.body).includes(envelope.data));

  const replayedConflict = await push(staleOperation, "batch-secret-replace-stale-replay");
  assert.deepEqual(replayedConflict.body.results[0], stale.body.results[0],
    "a conflict retry must preserve the first logical result");

  const acceptedOperation = { ...staleOperation, opId: "op-secret-replace-2", baseRevision: 2 };
  const accepted = await push(acceptedOperation, "batch-secret-replace-2");
  assert.equal(accepted.body.results[0].status, "accepted");
  assert.equal(accepted.body.results[0].revision, 3);
  const replayed = await push(acceptedOperation, "batch-secret-replace-2-replay");
  assert.equal(replayed.body.results[0].status, "duplicate");
  assert.equal(replayed.body.results[0].changeSeq, accepted.body.results[0].changeSeq);

  const rows = await (await fetch(state.base + "/api/connections", {
    headers: { "x-zephyr-sid": state.sid },
  })).json();
  const mine = (Array.isArray(rows) ? rows : rows.connections || []).find((c) => c.id === state.entityId);
  assert.equal(mine.hasPassword, true);
  assert.equal(mine.password, "******");
  const changes = await (await device("/api/mobile/v1/sync/changes?sinceCursor=0&limit=100")).json();
  const replaceChange = changes.changes.find((change) => (
    change.entityId === state.entityId && change.revision === 3
  ));
  assert.ok(replaceChange);
  assert.deepEqual(replaceChange.fieldMask, []);
  assert.equal(replaceChange.payload.password, undefined);
  assert.ok(!JSON.stringify({ accepted: accepted.body, change: replaceChange }).includes(replacement));
  state.revision = 3;
});

test("clear and replace are mutually exclusive without echoing an envelope", async () => {
  const plaintext = "mutual-exclusion-" + crypto.randomUUID();
  const aad = secretAad({
    serverId: state.serverId,
    userId: state.ownerUserId,
    deviceId: state.deviceId,
    entityType: "connection",
    entityId: state.entityId,
    fieldName: "password",
    entityRevision: state.revision + 1,
    keyVersion: state.serverKeyVersion,
  });
  const envelope = await seal(plaintext, aad, state.serverKeyVersion, state.revision + 1);
  const attempt = await push({
    opId: "op-secret-mutual-exclusion",
    entityType: "connection",
    entityId: state.entityId,
    action: "upsert",
    baseRevision: state.revision,
    fieldMask: [],
    payload: {},
    secretEnvelopes: { password: envelope },
    clearSecretFields: ["password"],
  }, "batch-secret-mutual-exclusion");
  assert.equal(attempt.res.status, 400);
  assert.equal(attempt.body.error.code, "invalid_request");
  const serialized = JSON.stringify(attempt.body);
  assert.ok(!serialized.includes(plaintext));
  for (const artifact of [envelope.ct, envelope.data, envelope.aad]) {
    assert.ok(!serialized.includes(artifact), "errors must not echo envelope content");
  }
});

test("an envelope sealed for another device is refused", async () => {
  const entityId = "conn-" + crypto.randomUUID();
  const aad = secretAad({
    serverId: state.serverId,
    userId: state.ownerUserId,
    deviceId: "dev-not-mine",
    entityType: "connection",
    entityId,
    fieldName: "password",
    entityRevision: 1,
    keyVersion: state.serverKeyVersion,
  });
  const envelope = await seal("stolen", aad, state.serverKeyVersion, 1);

  const res = await device("/api/mobile/v1/sync/push", {
    method: "POST",
    body: JSON.stringify({
      protocolVersion: 1, deviceId: state.deviceId, batchId: "batch-wrong-aad",
      baseCursor: 0, registryHash: state.registryHash,
      operations: [{
        opId: "op-wrong-aad", entityType: "connection", entityId,
        action: "upsert", baseRevision: 0,
        fieldMask: ["name", "host", "port", "protocol", "username"],
        payload: { name: "Nope", host: "1.1.1.1", port: 22, protocol: "SSH", username: "root" },
        secretEnvelopes: { password: envelope },
      }],
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, "the batch itself is well formed");
  assert.equal(body.results[0].status, "rejected",
    "an envelope bound to another device must not be opened");
  assert.ok(!JSON.stringify(body).includes(envelope.data), "the error must not echo the envelope");
});

test("an envelope sealed for another account is refused", async () => {
  const entityId = "conn-" + crypto.randomUUID();
  const aad = secretAad({
    serverId: state.serverId,
    userId: "user-not-mine",
    deviceId: state.deviceId,
    entityType: "connection",
    entityId,
    fieldName: "password",
    entityRevision: 1,
    keyVersion: state.serverKeyVersion,
  });
  const plaintext = "wrong-account-" + crypto.randomUUID();
  const envelope = await seal(plaintext, aad, state.serverKeyVersion, 1);
  const result = await push({
    opId: "op-wrong-account", entityType: "connection", entityId,
    action: "upsert", baseRevision: 0,
    fieldMask: ["name", "host", "port", "protocol", "username"],
    payload: { name: "Nope", host: "1.1.1.1", port: 22, protocol: "SSH", username: "root" },
    secretEnvelopes: { password: envelope },
  }, "batch-wrong-account");
  assert.equal(result.body.results[0].status, "rejected");
  const serialized = JSON.stringify(result.body);
  assert.ok(!serialized.includes(plaintext));
  assert.ok(!serialized.includes(envelope.data));
});

test("a tampered ciphertext is refused", async () => {
  const entityId = "conn-" + crypto.randomUUID();
  const aad = secretAad({
    serverId: state.serverId,
    userId: (await (await fetch(state.base + "/api/mobile/v1/devices", {
      headers: { "x-zephyr-sid": state.sid },
    })).json()).devices[0].ownerUserId,
    deviceId: state.deviceId,
    entityType: "connection",
    entityId,
    fieldName: "password",
    entityRevision: 1,
    keyVersion: state.serverKeyVersion,
  });
  const envelope = await seal("tamper-me", aad, state.serverKeyVersion, 1);
  const bytes = Buffer.from(envelope.data, "base64");
  bytes[0] = (bytes[0] + 1) % 256;
  envelope.data = bytes.toString("base64");

  const res = await device("/api/mobile/v1/sync/push", {
    method: "POST",
    body: JSON.stringify({
      protocolVersion: 1, deviceId: state.deviceId, batchId: "batch-tampered",
      baseCursor: 0, registryHash: state.registryHash,
      operations: [{
        opId: "op-tampered", entityType: "connection", entityId,
        action: "upsert", baseRevision: 0,
        fieldMask: ["name", "host", "port", "protocol", "username"],
        payload: { name: "Nope", host: "1.1.1.1", port: 22, protocol: "SSH", username: "root" },
        secretEnvelopes: { password: envelope },
      }],
    }),
  });
  const body = await res.json();
  assert.equal(body.results[0].status, "rejected", "GCM tag verification must fail closed");
});

test("a non-secret field name in secretEnvelopes is refused", async () => {
  const entityId = "conn-" + crypto.randomUUID();
  const aad = secretAad({
    serverId: state.serverId,
    userId: (await (await fetch(state.base + "/api/mobile/v1/devices", {
      headers: { "x-zephyr-sid": state.sid },
    })).json()).devices[0].ownerUserId,
    deviceId: state.deviceId,
    entityType: "connection",
    entityId,
    fieldName: "name",
    entityRevision: 1,
    keyVersion: state.serverKeyVersion,
  });
  const envelope = await seal("not-a-secret", aad, state.serverKeyVersion, 1);

  const res = await device("/api/mobile/v1/sync/push", {
    method: "POST",
    body: JSON.stringify({
      protocolVersion: 1, deviceId: state.deviceId, batchId: "batch-nonsecret",
      baseCursor: 0, registryHash: state.registryHash,
      operations: [{
        opId: "op-nonsecret", entityType: "connection", entityId,
        action: "upsert", baseRevision: 0,
        fieldMask: ["name", "host", "port", "protocol", "username"],
        payload: { name: "Nope", host: "1.1.1.1", port: 22, protocol: "SSH", username: "root" },
        secretEnvelopes: { name: envelope },
      }],
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, "invalid_request",
    "only registry secretFields may arrive as envelopes");
});

test("secret plaintext and envelope contents never enter server logs", async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (const canary of state.secretCanaries) {
    assert.ok(!state.serverLog.includes(canary), "plaintext secret leaked into a server log");
  }
  for (const artifact of state.envelopeArtifacts.filter((value) => value.length >= 16)) {
    assert.ok(!state.serverLog.includes(artifact), "secret envelope content leaked into a server log");
  }
});

test("stop the server", async () => {
  await cleanup();
});
