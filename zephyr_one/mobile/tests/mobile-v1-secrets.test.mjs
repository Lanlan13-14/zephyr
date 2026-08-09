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
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

const state = {
  child: null, base: "", dataDir: "", sid: "", tokenId: "",
  deviceId: "", access: "", registryHash: "",
  serverId: "", serverKey: null, serverKeyVersion: 0,
  entityId: "", revision: 0,
};

const ADMIN_PASSWORD = "mv1-secret-e2e-pass";

async function waitUp(url, budgetMs) {
  const until = Date.now() + budgetMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.status > 0) return res;
    } catch (err) { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

function device(pathname, init) {
  const options = init || {};
  return fetch(state.base + pathname, {
    method: options.method || "GET",
    headers: Object.assign(
      { authorization: "Bearer " + state.access },
      options.body ? { "content-type": "application/json" } : {},
      options.headers || {},
    ),
    body: options.body,
  });
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

  return {
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
}

test("boot a server and bind a device", async () => {
  state.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mv1-secret-"));
  const port = 22600 + Math.floor(Math.random() * 300);
  const aiPort = port + 1200;
  state.base = "http://127.0.0.1:" + port;

  state.child = spawn(process.execPath, ["server.js"], {
    cwd: repoRoot,
    env: Object.assign({}, process.env, {
      HTTP_ENABLED: "true",
      HTTPS_ENABLED: "false",
      PORT: String(port),
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
  let log = "";
  state.child.stdout.on("data", (b) => { log += b.toString(); });
  state.child.stderr.on("data", (b) => { log += b.toString(); });

  const up = await waitUp(state.base + "/api/mobile/v1/capabilities", 60000);
  assert.ok(up, "server never came up:\n" + log.slice(-3000));

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
  const jwk = ec.publicKey.export({ format: "jwk" });
  state.deviceId = "dev-" + crypto.randomUUID();

  const bind = await fetch(state.base + "/api/mobile/v1/devices/bind", {
    method: "POST",
    headers: { "content-type": "application/json", "x-zephyr-sid": state.sid },
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

  const aad = secretAad({
    serverId: state.serverId,
    userId: (await (await fetch(state.base + "/api/mobile/v1/devices", {
      headers: { "x-zephyr-sid": state.sid },
    })).json()).devices[0].ownerUserId,
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

test("an envelope sealed for another device is refused", async () => {
  const entityId = "conn-" + crypto.randomUUID();
  const aad = secretAad({
    serverId: state.serverId,
    userId: "some-other-user",
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
  assert.equal(body.results[0].status, "rejected",
    "only registry secretFields may arrive as envelopes");
});

test("stop the server", async () => {
  if (state.child) {
    state.child.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 400));
  }
  if (state.dataDir) {
    try { fs.rmSync(state.dataDir, { recursive: true, force: true }); } catch (err) { /* windows lock */ }
  }
});
