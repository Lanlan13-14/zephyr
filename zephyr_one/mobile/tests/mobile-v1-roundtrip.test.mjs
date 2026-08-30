// End-to-end round trip against a real server: bind -> bootstrap -> push -> changes -> ack.
//
// The other mobile-v1 tests prove the routes are mounted and that the auth
// planes refuse strangers. Neither proves what the client actually needs: that
// a device can bind, receive a mirror, write back, and see its own write return
// through the change feed with a cursor it can acknowledge. That is the point of
// the 22 frozen operations, so it is driven here over HTTP with real ML-KEM and
// ES256 device keys.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createProofClient } from "./mobile-v1-proof-client.mjs";
import {
  createSecureTestDataDir,
  removeSecureTestDataDir,
} from "../../../tests/helpers/secure-data-dir.mjs";
import {
  startChildOnLoopback,
  stopChild,
} from "./mobile-v1-live-server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const ADMIN_PASSWORD = "mv1-roundtrip-pass";
const AI_PROVIDER_SECRET = "mv1-provider-secret-canary";

const state = {
  child: null, base: "", dataFixture: null, dataDir: "", cookie: "", sid: "",
  tokenId: "", tokenSecret: "", deviceId: "", access: "", refresh: "", registryHash: "",
  bindGrant: "", bindAttempt: null, bindPayload: null, bindingRevision: 0, bindingToken: "",
  entityId: "", providerId: "", firstChangeSeq: 0, cursor: 0, log: "", signingPrivateKey: null,
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

function device(pathname, init) {
  const opts = init || {};
  const headers = Object.assign({
    "content-type": "application/json",
    authorization: "Bearer " + state.access,
    "x-zephyr-one-client": "1",
    "x-zephyr-one-platform": "android",
    "x-zephyr-protocol-version": "1",
  }, opts.headers || {});
  return proofDevice(pathname, Object.assign({}, opts, { headers }));
}

function connectionRows(body) {
  if (Array.isArray(body)) return body;
  return body.connections || body.items || [];
}

async function listCanonical() {
  const res = await fetch(state.base + "/api/connections", { headers: { cookie: state.cookie } });
  assert.equal(res.status, 200, "canonical list failed with " + res.status);
  return connectionRows(await res.json());
}

function pushBody(batchId, operations, overrides) {
  return JSON.stringify(Object.assign({
    protocolVersion: 1,
    deviceId: state.deviceId,
    batchId,
    baseCursor: 0,
    registryHash: state.registryHash,
    operations,
  }, overrides || {}));
}

/**
 * Device binding is an account-management action.  Keep the fixture on the
 * production path: verify the password for the exact Client Token/device pair
 * first, then send the short-lived authority only as a request header.
 */
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
  assert.match(body.grant, /^[A-Za-z0-9_-]{43}$/, "the grant has the frozen opaque form");
  assert.equal(body.secret, undefined, "the verification response must not echo the password");
  assert.equal(body.targetIds, undefined, "the verification response exposes only a target hash");
  assert.match(body.targetHash, /^[0-9a-f]{64}$/);
  assert.equal(body.bindingProtocolVersion, 2);
  assert.match(body.bindAttempt.receipt, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(typeof body.bindAttempt.expectedBindingRevision, "number");
  assert.equal(typeof body.bindAttempt.expectedRefreshGeneration, "number");
  return body;
}

test("boot a server and rotate the default admin password", async () => {
  state.dataFixture = createSecureTestDataDir("mv1-rt-");
  state.dataDir = state.dataFixture.dataDir;
  const started = await startChildOnLoopback({
    healthPath: "/healthz",
    log: () => state.log,
    accept: (response) => response.ok,
    spawnChild: ({ httpPort, aiPort, attempt }) => {
      state.base = "http://127.0.0.1:" + httpPort;
      state.log += `[startup attempt ${attempt}: http=${httpPort} ai=${aiPort}]\n`;
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
          ENCRYPTION_KEY: "mv1-roundtrip-key",
          ZEPHYR_ONE_USE_BUILTIN_SQLITE: "1",
          NODE_ENV: "production",
        }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      state.child.stdout.on("data", (b) => { state.log += b.toString(); });
      state.child.stderr.on("data", (b) => { state.log += b.toString(); });
      return state.child;
    },
  });
  state.child = started.child;

  const login = await fetch(state.base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin" }),
  });
  assert.equal(login.status, 200, "default admin login should work on a fresh data dir");
  state.cookie = (login.headers.get("set-cookie") || "").split(";")[0];

  const rotate = await fetch(state.base + "/api/auth/change-password", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: state.cookie },
    body: JSON.stringify({ currentPassword: "admin", newPassword: ADMIN_PASSWORD }),
  });
  assert.equal(rotate.status, 200, "first-login rotation should succeed");
});

test("a native client receives the sid in JSON, not only as a cookie", async () => {
  // ZEPHYR_PARITY.md 68: a native client cannot read HttpOnly cookies across
  // origins, so the sid must come back in the body when the caller declares
  // itself native. Without this the whole SID plane is unreachable from One.
  const res = await fetch(state.base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-zephyr-one-client": "1" },
    body: JSON.stringify({ username: "admin", password: ADMIN_PASSWORD }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.sid, "a native client must get the sid in JSON");
  state.sid = body.sid;
  state.cookie = (res.headers.get("set-cookie") || "").split(";")[0] || state.cookie;
});

test("binding requires an existing Client Token", async () => {
  // A device is never more authorised than the Client Token behind it, so a
  // bind naming no token must fail rather than inventing one.
  const res = await fetch(state.base + "/api/mobile/v1/devices/bind", {
    method: "POST",
    headers: { "content-type": "application/json", "x-zephyr-sid": state.sid },
    body: JSON.stringify({
      deviceId: "dev-no-token-0000000001", deviceName: "T", platform: "android",
      appVersion: "0.1.0", tokenId: "", keys: {}, syncIntervalSec: 300,
    }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "token_required");
});

test("create a Client Token through the normal main-end API", async () => {
  const res = await fetch(state.base + "/api/rdp/file-agent-tokens", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: state.cookie },
    body: JSON.stringify({ name: "mobile-roundtrip" }),
  });
  assert.ok(res.status === 200 || res.status === 201, "token creation returned " + res.status);
  const body = await res.json();
  const id = body.id || (body.token && body.token.id) || (body.record && body.record.id);
  assert.ok(id, "no token id in " + JSON.stringify(body).slice(0, 300));
  state.tokenId = id;
  state.tokenSecret = String(body.token?.token || body.record?.token || "");
  assert.ok(state.tokenSecret, "the one-time create response must contain the Client Token secret");
});

test("create a secret-bearing AI provider through the canonical main-end API", async () => {
  const res = await fetch(state.base + "/api/ai/providers", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: state.cookie },
    body: JSON.stringify({
      name: "Mobile-safe provider",
      type: "openai-compatible",
      baseUrl: "https://api.example.invalid/v1",
      apiKey: AI_PROVIDER_SECRET,
      apiMode: "responses",
      extraHeaders: JSON.stringify({ Authorization: "Bearer " + AI_PROVIDER_SECRET }),
      models: [{
        id: "model-safe",
        label: "Model Safe",
        userAgent: "Zephyr-Server-Only/1",
        extra: { accessToken: AI_PROVIDER_SECRET },
      }],
      defaultModel: "model-safe",
      options: {
        vision: true,
        max_tokens: 4096,
        extraJson: JSON.stringify({ access_token: AI_PROVIDER_SECRET }),
      },
    }),
  });
  const raw = await res.text();
  assert.equal(res.status, 200, "provider creation failed: " + raw.slice(0, 400));
  const body = JSON.parse(raw);
  state.providerId = body.provider?.id || "";
  assert.ok(state.providerId, "canonical provider creation returned no id");
});

test("a bind with a malformed device key is refused", async () => {
  // ML-KEM-768 public keys are exactly 1184 bytes. A short key would mean the
  // server could never seal an openable envelope, and the failure would only
  // surface later as an undecryptable secret.
  const deviceId = "dev-badkey-000000000001";
  const verification = await createBindGrant(state.tokenId, deviceId);
  const res = await fetch(state.base + "/api/mobile/v1/devices/bind", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-zephyr-sid": state.sid,
      "x-zephyr-sensitive-grant": verification.grant,
    },
    body: JSON.stringify({
      deviceId, deviceName: "Bad Key", platform: "android",
      appVersion: "0.1.0", tokenId: state.tokenId, syncIntervalSec: 300,
      keys: {
        encryption: { alg: "ML-KEM-768", publicKey: Buffer.from("short").toString("base64") },
        signing: { alg: "ES256", jwk: { kty: "EC", crv: "P-256", x: "a", y: "b" } },
      },
    }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "invalid_request");
});

test("bind issues access and refresh credentials and demands bootstrap", async () => {
  const { ml_kem768 } = await import("@noble/post-quantum/ml-kem.js");
  const kem = ml_kem768.keygen();
  const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  state.signingPrivateKey = ec.privateKey;
  const jwk = ec.publicKey.export({ format: "jwk" });

  state.deviceId = "dev-" + crypto.randomUUID();
  state.bindPayload = {
    deviceId: state.deviceId, deviceName: "Pixel Roundtrip", platform: "android",
    appVersion: "0.1.0", tokenId: state.tokenId, syncIntervalSec: 300,
    keys: {
      encryption: { alg: "ML-KEM-768", publicKey: Buffer.from(kem.publicKey).toString("base64") },
      signing: { alg: "ES256", jwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } },
    },
  };
  const verification = await createBindGrant(state.tokenId, state.deviceId);
  state.bindGrant = verification.grant;
  state.bindAttempt = verification.bindAttempt;

  const wrongTarget = await fetch(state.base + "/api/mobile/v1/devices/bind", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-zephyr-sid": state.sid,
      "x-zephyr-sensitive-grant": state.bindGrant,
    },
    body: JSON.stringify({ ...state.bindPayload, deviceId: "dev-" + crypto.randomUUID() }),
  });
  assert.equal(wrongTarget.status, 403, "a grant cannot bind a different device");
  assert.equal((await wrongTarget.json()).error.code, "sensitive_verification_required");

  const res = await fetch(state.base + "/api/mobile/v1/devices/bind", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-zephyr-sid": state.sid,
      "x-zephyr-sensitive-grant": state.bindGrant,
    },
    body: JSON.stringify(state.bindPayload),
  });
  const raw = await res.text();
  assert.equal(res.status, 200, "bind failed: " + raw.slice(0, 400));
  const body = JSON.parse(raw);

  assert.equal(body.ok, true);
  assert.ok(body.accessCredential, "an access credential is required");
  assert.ok(body.refreshCredential, "a refresh credential is required");
  assert.notEqual(body.accessCredential, body.refreshCredential,
    "the refresh credential must never double as bearer access");
  assert.equal(body.bootstrapRequired, true, "a fresh device has no mirror yet");
  assert.equal(body.device.deviceId, state.deviceId);
  assert.equal(body.device.platform, "android");
  assert.equal(body.device.tokenId, state.tokenId);
  assert.equal(body.device.enabled, true);
  assert.match(body.registryHash, /^[0-9a-f]{64}$/);

  state.access = body.accessCredential;
  state.refresh = body.refreshCredential;
  state.registryHash = body.registryHash;
  state.bindingRevision = body.bindingRevision;
  state.bindingToken = body.bindingToken;
  assert.equal(body.grant, undefined, "a consumed sensitive grant must never be returned by bind");
  assert.ok(!raw.includes(ADMIN_PASSWORD), "bind must not echo the verification secret");
});

test("a successful bind is idempotent for the same receipt and request", async () => {
  const replay = await fetch(state.base + "/api/mobile/v1/devices/bind", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-zephyr-sid": state.sid,
      "x-zephyr-sensitive-grant": state.bindGrant,
    },
    body: JSON.stringify({
      ...state.bindPayload,
      bindingProtocolVersion: 2,
      bindReceipt: state.bindAttempt.receipt,
    }),
  });
  const raw = await replay.text();
  assert.equal(replay.status, 200, "the same bind receipt must be an idempotent replay");
  const body = JSON.parse(raw);
  assert.equal(body.bindingRevision, state.bindingRevision);
  assert.equal(body.bindingToken, state.bindingToken);
  assert.equal(body.refreshCredential, state.refresh);
  assert.equal(body.grant, undefined, "a replay must not return the sensitive grant");
  assert.ok(!raw.includes(state.bindGrant), "the grant must stay header-only");
});

test("a bind receipt cannot authorize a modified request", async () => {
  const replay = await fetch(state.base + "/api/mobile/v1/devices/bind", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-zephyr-sid": state.sid,
      "x-zephyr-sensitive-grant": state.bindGrant,
    },
    body: JSON.stringify({
      ...state.bindPayload,
      deviceName: "Modified replay",
      bindingProtocolVersion: 2,
      bindReceipt: state.bindAttempt.receipt,
    }),
  });
  const body = await replay.json();
  assert.equal(replay.status, 409);
  assert.equal(body.error.code, "revision_conflict");
  assert.equal(body.error.details.reason, "bind_receipt_mismatch");
  assert.ok(!JSON.stringify(body).includes(state.bindGrant), "a conflict must not leak the grant");
  assert.ok(!JSON.stringify(body).includes(state.bindAttempt.receipt),
    "a conflict must not leak the bind receipt");
});

test("an older bind attempt cannot overwrite a newer winner", async () => {
  const attemptA = await createBindGrant(state.tokenId, state.deviceId);
  const attemptB = await createBindGrant(state.tokenId, state.deviceId);
  assert.equal(attemptA.bindAttempt.expectedBindingRevision, state.bindingRevision);
  assert.equal(attemptB.bindAttempt.expectedBindingRevision, state.bindingRevision);

  const winnerPayload = {
    ...state.bindPayload,
    deviceName: "Pixel Roundtrip Winner",
    bindingProtocolVersion: 2,
    bindReceipt: attemptB.bindAttempt.receipt,
  };
  const winner = await fetch(state.base + "/api/mobile/v1/devices/bind", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-zephyr-sid": state.sid,
      "x-zephyr-sensitive-grant": attemptB.grant,
    },
    body: JSON.stringify(winnerPayload),
  });
  const winnerRaw = await winner.text();
  assert.equal(winner.status, 200, "newer bind attempt failed: " + winnerRaw.slice(0, 400));
  const winnerBody = JSON.parse(winnerRaw);
  assert.equal(winnerBody.bindingRevision, state.bindingRevision + 1);

  const stale = await fetch(state.base + "/api/mobile/v1/devices/bind", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-zephyr-sid": state.sid,
      "x-zephyr-sensitive-grant": attemptA.grant,
    },
    body: JSON.stringify({
      ...state.bindPayload,
      deviceName: "Pixel Roundtrip Stale",
      bindingProtocolVersion: 2,
      bindReceipt: attemptA.bindAttempt.receipt,
    }),
  });
  const staleBody = await stale.json();
  assert.equal(stale.status, 409);
  assert.equal(staleBody.error.code, "revision_conflict");
  assert.equal(staleBody.error.details.reason, "bind_attempt_stale");
  assert.equal(staleBody.error.details.expectedBindingRevision, state.bindingRevision);
  assert.equal(staleBody.error.details.currentBindingRevision, winnerBody.bindingRevision);
  assert.equal(staleBody.error.details.expectedRefreshGeneration,
    attemptA.bindAttempt.expectedRefreshGeneration);
  assert.equal(staleBody.error.details.currentRefreshGeneration,
    attemptA.bindAttempt.expectedRefreshGeneration + 1);

  state.bindPayload = winnerPayload;
  state.access = winnerBody.accessCredential;
  state.refresh = winnerBody.refreshCredential;
  state.registryHash = winnerBody.registryHash;
  state.bindingRevision = winnerBody.bindingRevision;
  state.bindingToken = winnerBody.bindingToken;
});

test("the bound device can now use the DeviceAccess plane", async () => {
  const res = await device("/api/mobile/v1/sync/status");
  const raw = await res.text();
  assert.equal(res.status, 200, "status failed: " + raw.slice(0, 300));
  const body = JSON.parse(raw);
  assert.equal(body.ok, true);
  assert.equal(typeof body.cursor, "number");
  assert.equal(typeof body.state, "string");
});

test("bootstrap streams the owned mirror and terminates", async () => {
  let token = null;
  let pages = 0;
  let total = 0;
  let snapshotCursor = null;
  let providerEntity = null;
  let clientTokenEntity = null;

  for (;;) {
    const q = token
      ? "?pageSize=50&pageToken=" + encodeURIComponent(token)
      : "?pageSize=50";
    const res = await device("/api/mobile/v1/sync/bootstrap" + q);
    const raw = await res.text();
    assert.equal(res.status, 200, "bootstrap failed: " + raw.slice(0, 300));
    const body = JSON.parse(raw);
    assert.equal(body.ok, true);
    assert.ok(body.bootstrapId, "every page must name its bootstrap run");
    if (snapshotCursor === null) snapshotCursor = body.snapshotCursor;
    assert.equal(body.snapshotCursor, snapshotCursor,
      "the snapshot cursor must be stable across pages or the mirror would tear");

    for (const change of body.entities) {
      assert.equal(change.action, "upsert", "a bootstrap page carries no deletes");
      assert.ok(Array.isArray(change.fieldMask), "an upsert must carry a fieldMask");
      assert.ok(change.payload && typeof change.payload === "object");
      assert.equal(change.payload.password, undefined, "a secret leaked into a bootstrap payload");
      assert.equal(change.payload.privateKey, undefined, "a secret leaked into a bootstrap payload");
      if (change.entityType === "aiProvider" && change.entityId === state.providerId) {
        providerEntity = change;
      }
      if (change.entityType === "clientToken" && change.entityId === state.tokenId) {
        clientTokenEntity = change;
      }
    }
    total += body.entities.length;
    pages += 1;

    if (body.complete) {
      assert.equal(body.nextPageToken, null, "a complete page must not offer another token");
      break;
    }
    assert.ok(body.nextPageToken, "an incomplete page must offer a token");
    token = body.nextPageToken;
    assert.ok(pages < 50, "bootstrap did not terminate");
  }

  assert.ok(pages >= 1);
  assert.equal(typeof total, "number");
  assert.ok(providerEntity, "the canonical AI provider was absent from bootstrap");
  assert.equal(providerEntity.payload.baseUrl, "https://api.example.invalid/v1");
  assert.equal(providerEntity.payload.config.apiMode, "responses");
  assert.equal(providerEntity.payload.config.options.vision, true);
  assert.equal(providerEntity.payload.config.options.max_tokens, 4096);
  assert.equal(providerEntity.payload.models[0].id, "model-safe");
  assert.equal(providerEntity.payload.models[0].userAgent, undefined);
  assert.equal(providerEntity.payload.models[0].extra, undefined);
  assert.equal(providerEntity.payload.apiKey, undefined);
  assert.equal(providerEntity.payload.hasApiKey, undefined);
  assert.equal(providerEntity.payload.config.extraHeaders, undefined);
  assert.equal(providerEntity.payload.config.options.extraJson, undefined);
  assert.ok(!JSON.stringify(providerEntity).includes(AI_PROVIDER_SECRET),
    "the AI provider secret canary leaked into bootstrap");
  assert.ok(clientTokenEntity, "the canonical Client Token metadata was absent from bootstrap");
  assert.deepEqual(Object.keys(clientTokenEntity.payload).sort(), [
    "createdAt", "id", "lastUsedAt", "name", "ownerUserId", "revision", "updatedAt",
  ]);
  assert.deepEqual(clientTokenEntity.fieldMask, ["name"]);
  assert.equal(clientTokenEntity.payload.name, "mobile-roundtrip");
  assert.ok(!JSON.stringify(clientTokenEntity).includes(state.tokenSecret),
    "the Client Token secret leaked into bootstrap");
});

test("Client Token metadata writes use one canonical actor-bound change and reject secret masks", async () => {
  const res = await device("/api/mobile/v1/sync/push", {
    method: "POST",
    body: pushBody("batch-token-metadata", [{
      opId: "op-token-rename",
      entityType: "clientToken",
      entityId: state.tokenId,
      action: "upsert",
      baseRevision: 1,
      clientModifiedAt: Date.now(),
      fieldMask: ["name"],
      payload: { name: "mobile-roundtrip-renamed" },
    }]),
  });
  const raw = await res.text();
  assert.equal(res.status, 200, "Client Token rename failed: " + raw.slice(0, 400));
  assert.ok(!raw.includes(state.tokenSecret), "push response leaked the Client Token secret");
  const result = JSON.parse(raw).results[0];
  assert.equal(result.status, "accepted");
  assert.equal(result.revision, 2);
  assert.ok(Number.isSafeInteger(result.changeSeq) && result.changeSeq > 0);

  const feed = await device("/api/mobile/v1/sync/changes?sinceCursor=0&limit=100");
  const feedRaw = await feed.text();
  assert.equal(feed.status, 200, feedRaw.slice(0, 400));
  assert.ok(!feedRaw.includes(state.tokenSecret), "change feed leaked the Client Token secret");
  const changes = JSON.parse(feedRaw).changes.filter((change) => (
    change.entityType === "clientToken" && change.entityId === state.tokenId
  ));
  assert.equal(changes.length, 2, "Web create and mobile rename must each emit one metadata change");
  assert.equal(changes[0].revision, 1);
  assert.equal(changes[0].actorDeviceId, null, "the main-end create has no mobile actor");
  const renameChanges = changes.filter((change) => change.revision === 2);
  assert.equal(renameChanges.length, 1, "mobile rename must not double-write the change feed");
  assert.equal(renameChanges[0].changeSeq, result.changeSeq);
  assert.equal(renameChanges[0].actorDeviceId, state.deviceId);
  assert.deepEqual(renameChanges[0].fieldMask, ["name"]);
  assert.equal(renameChanges[0].payload.name, "mobile-roundtrip-renamed");
  assert.equal(renameChanges[0].payload.token, undefined);

  const forbidden = await device("/api/mobile/v1/sync/push", {
    method: "POST",
    body: pushBody("batch-token-secret-mask", [{
      opId: "op-token-secret-mask",
      entityType: "clientToken",
      entityId: state.tokenId,
      action: "upsert",
      baseRevision: 2,
      fieldMask: ["token"],
      payload: { token: "MUST_NOT_BE_ACCEPTED" },
    }]),
  });
  assert.equal(forbidden.status, 400);
  const forbiddenBody = await forbidden.json();
  assert.equal(forbiddenBody.error.code, "invalid_request");
  assert.equal(JSON.stringify(forbiddenBody).includes("MUST_NOT_BE_ACCEPTED"), false);
});

test("a forged bootstrap page token is refused", async () => {
  // The page token is server-signed, so a token that was not minted here must
  // not page through anybody data.
  const res = await device("/api/mobile/v1/sync/bootstrap?pageToken=" + encodeURIComponent("bm90LWEtdG9rZW4.YmFk"));
  assert.equal(res.status, 410);
  assert.equal((await res.json()).error.code, "bootstrap_expired");
});

test("push creates a real connection through the canonical service", async () => {
  const entityId = "conn-" + crypto.randomUUID();
  const res = await device("/api/mobile/v1/sync/push", {
    method: "POST",
    body: pushBody("batch-1", [{
      opId: "op-create-1",
      entityType: "connection",
      entityId,
      action: "upsert",
      baseRevision: 0,
      clientModifiedAt: Date.now(),
      fieldMask: ["name", "host", "port", "protocol", "username"],
      payload: { name: "Roundtrip Host", host: "10.0.0.9", port: 22, protocol: "SSH", username: "root" },
    }]),
  });
  const raw = await res.text();
  assert.equal(res.status, 200, "push failed: " + raw.slice(0, 500));
  const body = JSON.parse(raw);
  assert.equal(body.ok, true);
  assert.equal(body.batchId, "batch-1");
  assert.equal(body.results.length, 1);

  const result = body.results[0];
  assert.equal(result.opId, "op-create-1");
  assert.equal(result.status, "accepted", "push rejected: " + JSON.stringify(result).slice(0, 400));
  assert.ok(result.revision >= 1);
  assert.ok(result.changeSeq >= 1, "an accepted write must allocate a change");

  state.entityId = entityId;
  state.firstChangeSeq = result.changeSeq;

  // The canonical library must show it, which is what proves the write went
  // through ResourceService rather than straight into the table.
  const rows = await listCanonical();
  assert.ok(rows.some((c) => c.id === entityId),
    "the pushed connection is missing from the canonical library");
});

test("the pushed write returns through the change feed", async () => {
  const res = await device("/api/mobile/v1/sync/changes?sinceCursor=0&limit=100");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.fromCursor, 0);

  const mine = body.changes.find((c) => c.entityId === state.entityId);
  assert.ok(mine, "a device own write must still appear in its feed");
  assert.equal(mine.entityType, "connection");
  assert.equal(mine.action, "upsert");
  assert.equal(mine.changeSeq, state.firstChangeSeq,
    "the push result must reference the exact canonical change row");
  assert.equal(mine.actorDeviceId, state.deviceId,
    "the feed must name the actor so a client can dedupe its own writes");
  assert.equal(mine.payload.name, "Roundtrip Host");
  assert.equal(mine.payload.password, undefined, "a secret leaked into a change payload");
  assert.ok(body.nextCursor >= state.firstChangeSeq);
  state.cursor = body.nextCursor;
});

test("a replayed opId returns the same result without writing twice", async () => {
  const before = await listCanonical();

  const res = await device("/api/mobile/v1/sync/push", {
    method: "POST",
    body: pushBody("batch-1-replay", [{
      opId: "op-create-1",
      entityType: "connection",
      entityId: state.entityId,
      action: "upsert",
      baseRevision: 0,
      fieldMask: ["name"],
      payload: { name: "Should Not Apply" },
    }]),
  });
  assert.equal(res.status, 200);
  const result = (await res.json()).results[0];
  assert.equal(result.status, "duplicate", "a replayed opId must be reported as a duplicate");

  const after = await listCanonical();
  assert.equal(after.length, before.length, "a replay must not create a second row");
  const row = after.find((c) => c.id === state.entityId);
  assert.equal(row.name, "Roundtrip Host", "a replay must not apply its payload");
});

test("a stale baseRevision on the same field is a conflict, not a silent overwrite", async () => {
  const res = await device("/api/mobile/v1/sync/push", {
    method: "POST",
    body: pushBody("batch-conflict", [{
      opId: "op-conflict-1",
      entityType: "connection",
      entityId: state.entityId,
      action: "upsert",
      baseRevision: 0,
      fieldMask: ["name"],
      payload: { name: "Stale Edit" },
    }]),
  });
  assert.equal(res.status, 200);
  const result = (await res.json()).results[0];
  assert.equal(result.status, "conflict",
    "editing a field that moved since baseRevision must conflict: " + JSON.stringify(result).slice(0, 300));

  const rows = await listCanonical();
  const row = rows.find((c) => c.id === state.entityId);
  assert.equal(row.name, "Roundtrip Host", "a conflict must leave the server value untouched");
});

test("a fieldMask naming a secret or a server-authority field is refused", async () => {
  for (const field of ["password", "revision", "ownerUserId", "rdpPipeline"]) {
    const payload = {};
    payload[field] = "x";
    const res = await device("/api/mobile/v1/sync/push", {
      method: "POST",
      body: pushBody("batch-mask-" + field, [{
        opId: "op-mask-" + field,
        entityType: "connection",
        entityId: state.entityId,
        action: "upsert",
        baseRevision: 1,
        fieldMask: [field],
        payload,
      }]),
    });
    assert.equal(res.status, 400, "push preflight must reject " + field);
    const result = await res.json();
    assert.equal(result.error.code, "invalid_request",
      field + " must be rejected: " + JSON.stringify(result).slice(0, 250));
  }
});

test("an unknown entity type is refused rather than silently skipped", async () => {
  const res = await device("/api/mobile/v1/sync/push", {
    method: "POST",
    body: pushBody("batch-unknown", [{
      opId: "op-unknown-1",
      entityType: "notARegistryType",
      entityId: "x1",
      action: "upsert",
      baseRevision: 0,
      fieldMask: ["name"],
      payload: { name: "x" },
    }]),
  });
  assert.equal(res.status, 200);
  const result = (await res.json()).results[0];
  assert.equal(result.status, "rejected");
  assert.equal(result.error.error.code, "unknown_entity_type");
});

test("a registry hash mismatch stops the client instead of guessing", async () => {
  const res = await device("/api/mobile/v1/sync/push", {
    method: "POST",
    body: pushBody("batch-registry", [], { registryHash: "0".repeat(64) }),
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, "registry_mismatch");
});

test("an unsupported protocol version is refused", async () => {
  const res = await device("/api/mobile/v1/sync/push", {
    method: "POST",
    body: pushBody("batch-proto", [], { protocolVersion: 99 }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "unsupported_protocol_version");
});

test("ack advances the acknowledged cursor", async () => {
  const res = await device("/api/mobile/v1/sync/ack", {
    method: "POST",
    body: JSON.stringify({
      deviceId: state.deviceId,
      cursor: state.cursor,
      appliedOpIds: ["op-create-1"],
    }),
  });
  const raw = await res.text();
  assert.equal(res.status, 200, "ack failed: " + raw.slice(0, 300));
  assert.equal((JSON.parse(raw)).ok, true);

  const status = await device("/api/mobile/v1/sync/status");
  const body = await status.json();
  assert.equal(body.cursor, state.cursor, "status must report the acknowledged cursor");
});

test("a delete produces a tombstone carrying no secret", async () => {
  const res = await device("/api/mobile/v1/sync/push", {
    method: "POST",
    body: pushBody("batch-delete", [{
      opId: "op-delete-1",
      entityType: "connection",
      entityId: state.entityId,
      action: "delete",
      baseRevision: 1,
      fieldMask: [],
      payload: {},
    }], { baseCursor: state.cursor }),
  });
  assert.equal(res.status, 200);
  const result = (await res.json()).results[0];
  assert.equal(result.status, "accepted", "delete rejected: " + JSON.stringify(result).slice(0, 300));

  const feed = await device("/api/mobile/v1/sync/changes?sinceCursor=" + state.cursor + "&limit=50");
  const body = await feed.json();
  const del = body.changes.find((c) => c.entityId === state.entityId && c.action === "delete");
  assert.ok(del, "a delete must appear in the feed");
  assert.ok(del.tombstone, "a delete must carry a tombstone");
  assert.equal(/password|privateKey|secret/i.test(JSON.stringify(del.tombstone)), false,
    "a tombstone must carry no secret");

  const rows = await listCanonical();
  assert.equal(rows.some((c) => c.id === state.entityId), false,
    "the deleted connection must be gone from the canonical library");
});

test("refresh rotates both credentials and the old refresh cannot be replayed", async () => {
  const first = await fetch(state.base + "/api/mobile/v1/devices/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: state.deviceId, refreshCredential: state.refresh }),
  });
  const refreshRaw = await first.text();
  assert.equal(first.status, 200, "refresh failed: " + refreshRaw.slice(0, 300));
  const body = JSON.parse(refreshRaw);
  assert.ok(body.accessCredential);
  assert.ok(body.refreshCredential);
  assert.notEqual(body.refreshCredential, state.refresh, "the refresh credential must rotate");

  const replay = await fetch(state.base + "/api/mobile/v1/devices/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: state.deviceId, refreshCredential: state.refresh }),
  });
  assert.equal(replay.status, 401, "a single-use refresh credential must not be replayable");
  assert.equal((await replay.json()).error.code, "refresh_replayed");

  state.access = body.accessCredential;
  state.refresh = body.refreshCredential;
});

test("the device list shows the bound device to the SID plane", async () => {
  const res = await fetch(state.base + "/api/mobile/v1/devices", {
    headers: { "x-zephyr-sid": state.sid },
  });
  const raw = await res.text();
  assert.equal(res.status, 200, "device list failed: " + raw.slice(0, 300));
  const body = JSON.parse(raw);
  assert.equal(body.ok, true);
  const mine = body.devices.find((d) => d.deviceId === state.deviceId);
  assert.ok(mine, "the bound device must be listed");
  assert.equal(mine.deviceName, state.bindPayload.deviceName);
  const text = JSON.stringify(body);
  assert.equal(/refresh_token_hash|refreshCredential|accessCredential/.test(text), false,
    "the device list must never expose credential material");
});

test("bound device AI routes use the main-end runtime authority", async () => {
  const aiDevice = (pathname) => fetch(state.base + pathname, {
    headers: {
      authorization: "Bearer " + state.access,
      "x-zephyr-one-client": "1",
      "x-zephyr-one-platform": "android",
      "x-zephyr-protocol-version": "1",
    },
  });
  const statusRes = await aiDevice("/api/ai/runtime/status");
  assert.equal(statusRes.status, 200, "bound AI status rejected device access: " + statusRes.status);
  const status = await statusRes.json();
  assert.equal(typeof status.enabled, "boolean");

  const providersRes = await aiDevice("/api/ai/providers");
  assert.equal(providersRes.status, 200, "bound AI provider list rejected device access: " + providersRes.status);
  const providers = (await providersRes.json()).providers || [];
  const provider = providers.find((item) => item.id === state.providerId);
  assert.ok(provider, "bound AI provider was not visible to its owner device");
  assert.equal(Object.hasOwn(provider, "apiKey"), false);
  assert.equal(Object.hasOwn(provider, "hasApiKey"), false);
  assert.equal(Object.hasOwn(provider, "baseUrl"), false);
  assert.equal(Object.hasOwn(provider, "config"), false);
  assert.equal(JSON.stringify(provider).includes(AI_PROVIDER_SECRET), false);
});

test("stop the server", async () => {
  await cleanup();
});
