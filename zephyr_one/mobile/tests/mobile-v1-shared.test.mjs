// Live contract test for the shared-resource residency plane.
//
// SHARED_RESOURCE_RESIDENCY.md is the strictest document in the freeze: a
// resource shared *to* the bound account must never enter the mobile mirror,
// and every view or use must be re-authorised online. The seven endpoints that
// serve it were stubbed with 501 until now, so nothing proved any of it.
//
// This boots a real server with two accounts, shares a connection and a note
// from one to the other, and then asserts the properties that actually matter:
// the shared rows are absent from bootstrap and the change feed, the session
// broker never hands a secret to a relay-strict caller, a direct envelope is
// bound to one device and one nonce and cannot be replayed, and revoking the
// grant takes effect on the very next request rather than at cache expiry.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createProofClient } from "./mobile-v1-proof-client.mjs";
import {
  createSecureTestDataDir,
  removeSecureTestDataDir,
  startChildOnLoopback,
  stopChild,
} from "./mobile-v1-live-server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const ACCOUNT_PASSWORDS = Object.freeze({
  owner: "shared-owner-pass",
  borrower: "shared-borrower-pass",
});

const state = {};

async function cleanup() {
  await stopChild(state.child);
  state.child = null;
  removeSecureTestDataDir(state.dataFixture);
  state.dataFixture = null;
  state.dataDir = "";
}

after(cleanup);
const borrowerProof = createProofClient({
  base: () => state.base,
  access: () => state.access,
  deviceId: () => state.deviceId,
  privateKey: () => state.signingPrivateKey,
});
const ownerProof = createProofClient({
  base: () => state.base,
  access: () => state.ownerDevice.access,
  deviceId: () => state.ownerDevice.deviceId,
  privateKey: () => state.ownerDevice.signingPrivateKey,
});

/** Owner-plane request: the SID of whichever account is named. */
function sid(who, url, init = {}) {
  const headers = Object.assign({ "content-type": "application/json" }, init.headers || {});
  headers["x-zephyr-sid"] = state[who].sid;
  return fetch(state.base + url, Object.assign({}, init, { headers }));
}

async function createBindGrant(who, tokenId, deviceId) {
  const verified = await sid(who, "/api/mobile/v1/sensitive/verify", {
    method: "POST",
    body: JSON.stringify({
      action: "device.bind",
      secret: ACCOUNT_PASSWORDS[who],
      targetIds: [tokenId, deviceId],
    }),
  });
  const body = await verified.json();
  assert.equal(verified.status, 200,
    "sensitive verification failed for " + who + ": " + JSON.stringify(body).slice(0, 300));
  assert.equal(body.action, "device.bind");
  assert.match(body.grant, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(body.secret, undefined, "sensitive verification must not echo the account password");
  assert.equal(body.targetIds, undefined, "sensitive verification must not echo its targets");
  return body.grant;
}

/** Device plane: the bearer credential of the *borrower* device. */
function device(url, init = {}) {
  const headers = Object.assign({ "content-type": "application/json" }, init.headers || {});
  headers.authorization = "Bearer " + state.access;
  return borrowerProof(url, Object.assign({}, init, { headers }));
}

async function login(username, password) {
  const res = await fetch(state.base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-zephyr-one-client": "1" },
    body: JSON.stringify({ username, password, returnSid: true }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, "login failed for " + username + ": " + JSON.stringify(body).slice(0, 300));
  return body;
}

test("boot a server with an owner and a borrower account", async () => {
  state.dataFixture = createSecureTestDataDir("mv1-shared-");
  state.dataDir = state.dataFixture.dataDir;
  let log = "";
  const started = await startChildOnLoopback({
    healthPath: "/api/mobile/v1/capabilities",
    log: () => log,
    spawnChild: ({ httpPort, aiPort, attempt }) => {
      state.base = "http://127.0.0.1:" + httpPort;
      log += `[startup attempt ${attempt}: http=${httpPort} ai=${aiPort}]\n`;
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
          ENCRYPTION_KEY: "mobile-v1-shared-test-key",
          NODE_ENV: "production",
          ZEPHYR_ONE_USE_BUILTIN_SQLITE: "1",
        }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      state.child.stdout.on("data", (b) => { log += b.toString(); });
      state.child.stderr.on("data", (b) => { log += b.toString(); });
      return state.child;
    },
  });
  state.child = started.child;

  // Default admin becomes the resource owner.
  const first = await login("admin", "admin");
  state.owner = { sid: first.sid, username: "admin" };
  const rotate = await sid("owner", "/api/auth/change-password", {
    method: "POST",
    body: JSON.stringify({ currentPassword: "admin", newPassword: "shared-owner-pass" }),
  });
  assert.equal(rotate.status, 200, "first-login rotation must succeed");
  const reowner = await login("admin", "shared-owner-pass");
  state.owner.sid = reowner.sid;
  state.owner.userId = reowner.user.userId;
});

test("create a second account to share to", async () => {
  const res = await sid("owner", "/api/admin/users", {
    method: "POST",
    body: JSON.stringify({
      username: "borrower",
      password: "shared-borrower-pass",
      role: "user",
      /* Without this the account is created with defaultPassword set, and
       * every request from it is answered with must_change_password before
       * the handler runs -- which has nothing to do with what this suite
       * is testing. */
      mustChangePassword: false,
    }),
  });
  const body = await res.json().catch(() => ({}));
  assert.ok(res.status === 200 || res.status === 201,
    "creating the borrower account failed: " + res.status + " " + JSON.stringify(body).slice(0, 300));

  const borrower = await login("borrower", "shared-borrower-pass");
  state.borrower = { sid: borrower.sid, username: "borrower", userId: borrower.user.userId };
  assert.notEqual(state.borrower.userId, state.owner.userId, "the two accounts must be distinct");
});

test("the owner creates a connection and a note, then shares both", async () => {
  const conn = await sid("owner", "/api/connections", {
    method: "POST",
    body: JSON.stringify({
      name: "Owner SSH", host: "10.7.7.7", port: 22, protocol: "SSH",
      username: "ops", password: "owner-only-secret",
    }),
  });
  const connBody = await conn.json();
  assert.ok(conn.status === 200 || conn.status === 201,
    "connection create failed: " + JSON.stringify(connBody).slice(0, 300));
  state.connectionId = connBody.id || (connBody.connection && connBody.connection.id);
  assert.ok(state.connectionId, "no connection id returned");

  const note = await sid("owner", "/api/notes", {
    method: "POST",
    body: JSON.stringify({ title: "Owner Note", content: "shared body text" }),
  });
  const noteBody = await note.json();
  assert.ok(note.status === 200 || note.status === 201,
    "note create failed: " + JSON.stringify(noteBody).slice(0, 300));
  state.noteId = noteBody.noteId || noteBody.id || (noteBody.note && (noteBody.note.noteId || noteBody.note.id));
  assert.ok(state.noteId, "no note id returned");

  // Share the connection with use+view but deliberately NOT revealSecret.
  const share = await sid("owner", "/api/resources/connection/" + state.connectionId + "/shares", {
    method: "PUT",
    body: JSON.stringify({
      shares: [{ subjectId: state.borrower.userId, capabilities: ["discover", "view", "use", "control"] }],
    }),
  });
  assert.equal(share.status, 200, "sharing the connection failed: " + (await share.text()).slice(0, 300));

  const noteShare = await sid("owner", "/api/resources/note/" + state.noteId + "/shares", {
    method: "PUT",
    body: JSON.stringify({
      shares: [{ subjectId: state.borrower.userId, capabilities: ["discover", "view"] }],
    }),
  });
  assert.equal(noteShare.status, 200, "sharing the note failed: " + (await noteShare.text()).slice(0, 300));
});

test("bind a device for the borrower account", async () => {
  const tok = await sid("borrower", "/api/rdp/file-agent-tokens", {
    method: "POST",
    body: JSON.stringify({ name: "borrower device" }),
  });
  const tokBody = await tok.json();
  assert.ok(tok.status === 200 || tok.status === 201,
    "token create failed: " + JSON.stringify(tokBody).slice(0, 300));
  const tokenId = tokBody.id || (tokBody.token && tokBody.token.id);
  assert.ok(tokenId, "no tokenId returned");

  const { ml_kem768 } = await import("@noble/post-quantum/ml-kem.js");
  state.kem = ml_kem768.keygen();
  const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  state.signingPrivateKey = ec.privateKey;
  const jwk = ec.publicKey.export({ format: "jwk" });
  state.deviceId = "dev-" + crypto.randomUUID();
  const grant = await createBindGrant("borrower", tokenId, state.deviceId);

  const res = await sid("borrower", "/api/mobile/v1/devices/bind", {
    method: "POST",
    headers: { "x-zephyr-sensitive-grant": grant },
    body: JSON.stringify({
      deviceId: state.deviceId, deviceName: "Borrower Pixel", platform: "android",
      appVersion: "0.1.0", tokenId, syncIntervalSec: 300,
      keys: {
        encryption: { alg: "ML-KEM-768", publicKey: Buffer.from(state.kem.publicKey).toString("base64") },
        signing: { alg: "ES256", jwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } },
      },
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, "bind failed: " + JSON.stringify(body).slice(0, 400));
  assert.equal(body.grant, undefined, "bind must not echo its sensitive grant");
  assert.ok(!JSON.stringify(body).includes(grant), "the grant must remain header-only");
  state.access = body.accessCredential;
  state.registryHash = body.registryHash;
});

/**
 * Binds a device for an arbitrary account and returns its bearer credential.
 *
 * The owner needs one too: without it there is no way to ask the shared plane
 * for a row the caller *owns*, which is the exact confusion that would turn the
 * shared endpoints into a second read path for mirrored data.
 */
async function bindDeviceFor(who) {
  const tok = await sid(who, "/api/rdp/file-agent-tokens", {
    method: "POST",
    body: JSON.stringify({ name: who + " device" }),
  });
  const tokBody = await tok.json();
  assert.ok(tok.status === 200 || tok.status === 201,
    "token create failed for " + who + ": " + JSON.stringify(tokBody).slice(0, 300));
  const tokenId = tokBody.id || (tokBody.token && tokBody.token.id);
  assert.ok(tokenId, "no tokenId returned for " + who);

  const { ml_kem768 } = await import("@noble/post-quantum/ml-kem.js");
  const kem = ml_kem768.keygen();
  const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = ec.publicKey.export({ format: "jwk" });
  const deviceId = "dev-" + crypto.randomUUID();
  const grant = await createBindGrant(who, tokenId, deviceId);

  const res = await sid(who, "/api/mobile/v1/devices/bind", {
    method: "POST",
    headers: { "x-zephyr-sensitive-grant": grant },
    body: JSON.stringify({
      deviceId, deviceName: who + " Pixel", platform: "android",
      appVersion: "0.1.0", tokenId, syncIntervalSec: 300,
      keys: {
        encryption: { alg: "ML-KEM-768", publicKey: Buffer.from(kem.publicKey).toString("base64") },
        signing: { alg: "ES256", jwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } },
      },
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, "bind failed for " + who + ": " + JSON.stringify(body).slice(0, 400));
  assert.equal(body.grant, undefined, "bind must not echo its sensitive grant");
  assert.ok(!JSON.stringify(body).includes(grant), "the grant must remain header-only");
  return { deviceId, kem, access: body.accessCredential, signingPrivateKey: ec.privateKey };
}

test("bind a second device, owned by the owner account", async () => {
  const bound = await bindDeviceFor("owner");
  state.ownerDevice = bound;
});

test("capabilities now declares the shared plane live", async () => {
  const body = await (await fetch(state.base + "/api/mobile/v1/capabilities")).json();
  assert.equal(body.features.sharedResources, true,
    "the shared endpoints are implemented, so the flag must say so");
  /* fileBridge stays false: POST /file-bridge/lease refuses with a
   * registered unsupported_scope because no ZFT2 transport accepts a
   * device lease yet. Declaring true would make the client probe an
   * endpoint that cannot work. */
  assert.equal(body.features.fileBridge, false,
    "no device-authenticated ZFT2 transport is mounted, so the flag must stay false");
  state.serverId = body.serverId;
  state.serverKeyVersion = body.serverEncryption.keyVersion;
});

// ---------------------------------------------------------------- residency --

test("a shared resource never enters the mobile mirror", async () => {
  // Bootstrap is the owned mirror. The borrower owns neither row.
  let token = null;
  const seen = [];
  for (let page = 0; page < 20; page += 1) {
    const q = token ? "?pageToken=" + encodeURIComponent(token) : "?pageSize=100";
    const res = await device("/api/mobile/v1/sync/bootstrap" + q);
    const body = await res.json();
    assert.equal(res.status, 200, "bootstrap failed: " + JSON.stringify(body).slice(0, 300));
    for (const entity of body.entities) seen.push(entity.entityId);
    if (body.complete) break;
    token = body.nextPageToken;
  }

  assert.ok(!seen.includes(state.connectionId),
    "a shared connection leaked into the owned mirror");
  assert.ok(!seen.includes(state.noteId),
    "a shared note leaked into the owned mirror");

  const changes = await device("/api/mobile/v1/sync/changes?sinceCursor=0&limit=200");
  const changeBody = await changes.json();
  assert.equal(changes.status, 200);
  const ids = changeBody.changes.map((c) => c.entityId);
  assert.ok(!ids.includes(state.connectionId), "a shared connection leaked into the change feed");
  assert.ok(!ids.includes(state.noteId), "a shared note leaked into the change feed");
});

test("the online shared directory lists what the mirror must not hold", async () => {
  const res = await device("/api/mobile/v1/shared");
  const body = await res.json();
  assert.equal(res.status, 200, "shared list failed: " + JSON.stringify(body).slice(0, 300));

  // The frozen response shape is { items, nextPageToken }, not { ok, resources }.
  assert.ok(Array.isArray(body.items), "the frozen schema requires an items array");
  assert.ok("nextPageToken" in body, "the frozen schema requires nextPageToken");

  const conn = body.items.find((i) => i.resourceId === state.connectionId);
  assert.ok(conn, "the shared connection must appear in the online directory");
  assert.equal(conn.resourceType, "connection");
  assert.equal(conn.ownerDisplayName, "admin", "the borrower needs to know whose resource this is");
  assert.ok(conn.capabilities.includes("use"));
  assert.ok(!conn.capabilities.includes("revealSecret"),
    "use must never imply revealSecret");
  assert.ok(conn.revision >= 1);
});

test("the shared directory is never cacheable", async () => {
  const res = await device("/api/mobile/v1/shared");
  const cc = String(res.headers.get("cache-control") || "");
  assert.match(cc, /no-store/, "a cached shared listing would outlive a revoke");
  assert.match(cc, /private/);
});

test("shared detail carries no secret material", async () => {
  const res = await device("/api/mobile/v1/shared/connection/" + state.connectionId);
  const body = await res.json();
  assert.equal(res.status, 200, "shared detail failed: " + JSON.stringify(body).slice(0, 300));

  const text = JSON.stringify(body);
  assert.ok(!text.includes("owner-only-secret"), "the shared detail leaked the password");
  assert.equal(body.password, undefined);
  assert.equal(body.privateKey, undefined);
  // Presence flags are fine: they tell the UI a password exists without giving it.
  assert.equal(body.resourceId, state.connectionId);
});

test("enumeration is impossible: unknown and unauthorised both 404", async () => {
  const unknown = await device("/api/mobile/v1/shared/connection/conn-does-not-exist");
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, "resource_not_found_or_inaccessible");

  // A real resource that was never shared to this account must look identical.
  const priv = await sid("owner", "/api/connections", {
    method: "POST",
    body: JSON.stringify({
      name: "Never Shared", host: "10.8.8.8", port: 22, protocol: "SSH", username: "root",
    }),
  });
  const privBody = await priv.json();
  const privateId = privBody.id || (privBody.connection && privBody.connection.id);

  const hidden = await device("/api/mobile/v1/shared/connection/" + privateId);
  assert.equal(hidden.status, 404, "an unshared resource must not be distinguishable from a missing one");
  assert.equal((await hidden.json()).error.code, "resource_not_found_or_inaccessible");
});

// ------------------------------------------------------------------ sessions --

test("relay-strict mints a session with a credential and no secret", async () => {
  const res = await device("/api/mobile/v1/shared/connections/" + state.connectionId + "/sessions", {
    method: "POST",
    body: JSON.stringify({
      mode: "relay-strict",
      clientSessionNonce: crypto.randomBytes(24).toString("base64url"),
      requestedChannels: ["terminal"],
      deviceKeyVersion: 1,
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, "relay session failed: " + JSON.stringify(body).slice(0, 400));
  assert.equal(body.mode, "relay-strict");
  assert.ok(body.sessionId);

  /* The whole point of relay-strict: the device is told where to attach and is
   * given a token scoped to this one session, but no connect material at all.
   * SHARED_RESOURCE_RESIDENCY.md 3.3 forbids the secret leaving the main end. */
  assert.ok(body.relay, "relay-strict must carry a relay descriptor");
  assert.equal(body.relay.protocol, "ssh");
  assert.match(body.relay.websocketUrl, /^\/api\/mobile\/v1\/shared\/relay\?sessionId=/);
  assert.ok(body.relay.credential, "the device needs a session-scoped attach credential");
  assert.equal(body.useEnvelope, undefined, "relay-strict must never carry a use envelope");

  const text = JSON.stringify(body);
  assert.ok(!text.includes("owner-only-secret"), "relay-strict leaked the host password");
  for (const key of ["clientToken", "refreshCredential", "ownerSid", "serverDataKey"]) {
    assert.ok(!text.includes(key), key + " must never ride in a relay descriptor");
  }

  state.relaySessionId = body.sessionId;
  state.relayUrl = body.relay.websocketUrl;
  state.relayCredential = body.relay.credential;
});

test("the relay credential is not a bearer token for anything else", async () => {
  // It must not work as a device access credential on the sync plane.
  const res = await fetch(state.base + "/api/mobile/v1/sync/status", {
    headers: { authorization: "Bearer " + state.relayCredential },
  });
  assert.ok(res.status === 401 || res.status === 403,
    "a relay credential must not authenticate the sync plane (got " + res.status + ")");
});

test("relay attach rejects credentials carried in the query string", async () => {
  const { WebSocket } = await import("ws");
  const result = await new Promise((resolve) => {
    const wsUrl = state.base.replace("http://", "ws://")
      + state.relayUrl + "&credential=" + encodeURIComponent(state.relayCredential);
    const sock = new WebSocket(wsUrl);
    const frames = [];
    sock.on("message", (raw) => frames.push(raw));
    sock.on("close", (code, reason) => resolve({ code, reason: reason.toString(), frames }));
    sock.on("error", () => { /* close follows */ });
  });
  assert.match(result.reason, /query-credential-forbidden/);
  assert.equal(result.frames.length, 0);
});

test("relay attach rejects a forged credential and honours the real one", async () => {
  const { WebSocket } = await import("ws");

  const attach = (credential) => new Promise((resolve) => {
    const wsUrl = state.base.replace("http://", "ws://")
      + state.relayUrl;
    const sock = new WebSocket(wsUrl, credential);
    const frames = [];
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; resolve(result); } };
    sock.on("message", (raw, isBinary) => {
      if (isBinary) { frames.push({ binary: true }); return; }
      try { frames.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
    });
    sock.on("close", (code, reason) => done({ code, reason: reason.toString(), frames }));
    sock.on("error", () => { /* close follows */ });
    setTimeout(() => { try { sock.close(); } catch {} }, 2500);
  });

  // A tampered credential must be refused at the upgrade, not after attach.
  const forged = await attach(state.relayCredential.slice(0, -4) + "AAAA");
  assert.match(forged.reason, /shared_session_expired|forbidden/,
    "a forged relay credential must be refused by code, got: " + forged.reason);
  assert.equal(forged.frames.length, 0, "a refused attach must not stream anything");

  /* The real credential authorises. The shared host in this suite is
   * unroutable on purpose (10.7.7.7), so the honest outcome is an upstream
   * failure *reported as such* - which still proves authorisation passed, the
   * server resolved the credential itself, and no secret was sent to the
   * device. A `ready` frame would mean a reachable host, which is also fine. */
  const real = await attach(state.relayCredential);
  const kinds = real.frames.map((f) => f.type || (f.binary ? "binary" : "?"));

  /* `accepted` is emitted the moment authorisation passes, before the upstream
   * dial. That separation is deliberate and is what this asserts: it proves the
   * credential was honoured without making the assertion depend on whether the
   * shared host answers. `ready` (reachable) and `error` (unreachable) are both
   * legal follow-ups. */
  assert.ok(
    kinds.includes("accepted"),
    "an authorised attach must be acknowledged, got: " + JSON.stringify(kinds),
  );
  const accepted = real.frames.find((f) => f.type === "accepted");
  assert.equal(accepted.mode, "relay-strict");
  assert.equal(accepted.sessionId, state.relaySessionId, "the ack must name the session it attached to");
  assert.deepEqual(accepted.channels, ["terminal"], "the ack must state which channels the ACL backed");
  const wire = JSON.stringify(real.frames);
  assert.ok(!wire.includes("owner-only-secret"), "the relay leaked the host password to the device");
  assert.ok(!wire.includes("privateKey"), "the relay leaked key material to the device");
});
test("a relay credential is scoped to the one session that minted it", async () => {
  const { WebSocket } = await import("ws");

  /* Mint a second relay session for the same device and resource. The two
   * differ only by session id, which is exactly the confusion a scoped
   * credential has to survive: SHARED_RESOURCE_RESIDENCY.md 3.3 requires the
   * relay credential to be bound to one session and unable to reach anything
   * else, so replaying credential A against session B must be refused. */
  const second = await device("/api/mobile/v1/shared/connections/" + state.connectionId + "/sessions", {
    method: "POST",
    body: JSON.stringify({
      mode: "relay-strict",
      clientSessionNonce: crypto.randomBytes(24).toString("base64url"),
      requestedChannels: ["terminal"],
      deviceKeyVersion: 1,
    }),
  });
  const secondBody = await second.json();
  assert.equal(second.status, 200, "second relay session failed: " + JSON.stringify(secondBody).slice(0, 300));
  assert.notEqual(secondBody.sessionId, state.relaySessionId, "the two sessions must be distinct");

  const attachTo = (sessionId, credential) => new Promise((resolve) => {
    const wsUrl = state.base.replace("http://", "ws://")
      + "/api/mobile/v1/shared/relay?sessionId=" + encodeURIComponent(sessionId);
    const sock = new WebSocket(wsUrl, credential);
    const frames = [];
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    sock.on("message", (raw, isBinary) => {
      if (isBinary) { frames.push({ binary: true }); return; }
      try { frames.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
    });
    sock.on("close", (code, reason) => done({ code, reason: reason.toString(), frames }));
    sock.on("error", () => { /* close follows */ });
    setTimeout(() => { try { sock.close(); } catch {} }, 2500);
  });

  // Session A credential pointed at session B.
  const crossed = await attachTo(secondBody.sessionId, state.relayCredential);
  assert.match(crossed.reason, /shared_session_expired|forbidden/,
    "a credential from another session must be refused, got: " + crossed.reason);
  assert.equal(crossed.frames.length, 0, "a refused cross-session attach must not stream anything");

  // Session B own credential still works, so the refusal is scoping rather
  // than a blanket failure.
  const proper = await attachTo(secondBody.sessionId, secondBody.relay.credential);
  const kinds = proper.frames.map((f) => f.type || (f.binary ? "binary" : "?"));
  assert.ok(kinds.includes("accepted"),
    "the session own credential must still authorise, got: " + JSON.stringify(kinds));

  await device("/api/mobile/v1/shared/sessions/" + secondBody.sessionId, { method: "DELETE" });
});

test("a session can be refreshed and then closed", async () => {
  /* Uses direct-ephemeral deliberately: the lifecycle
   * being proved -- refresh extends the same grant, close destroys it, and a
   * closed id cannot be revived -- is mode independent. */
  const opened = await device("/api/mobile/v1/shared/connections/" + state.connectionId + "/sessions", {
    method: "POST",
    body: JSON.stringify({
      mode: "direct-ephemeral",
      clientSessionNonce: crypto.randomBytes(24).toString("base64url"),
      requestedChannels: ["terminal"],
      deviceKeyVersion: 1,
    }),
  });
  const openedBody = await opened.json();
  assert.equal(opened.status, 200, "direct session failed: " + JSON.stringify(openedBody).slice(0, 400));
  const sessionId = openedBody.sessionId;
  assert.ok(sessionId);

  const refreshed = await device("/api/mobile/v1/shared/sessions/" + sessionId + "/refresh", {
    method: "POST",
    body: JSON.stringify({ clientSessionNonce: crypto.randomBytes(24).toString("base64url") }),
  });
  const body = await refreshed.json();
  assert.equal(refreshed.status, 200, "refresh failed: " + JSON.stringify(body).slice(0, 300));
  assert.equal(body.sessionId, sessionId, "refresh must extend, not re-mint");

  const closed = await device("/api/mobile/v1/shared/sessions/" + sessionId, { method: "DELETE" });
  assert.equal(closed.status, 200);
  assert.equal((await closed.json()).ok, true);

  // A closed session is gone, not merely expired.
  const again = await device("/api/mobile/v1/shared/sessions/" + sessionId + "/refresh", {
    method: "POST",
    body: JSON.stringify({ clientSessionNonce: crypto.randomBytes(24).toString("base64url") }),
  });
  assert.equal(again.status, 410, "refreshing a closed session must not succeed");
});

test("a direct-ephemeral envelope opens once, for this device only", async () => {
  const nonce = crypto.randomBytes(24).toString("base64url");
  const res = await device("/api/mobile/v1/shared/connections/" + state.connectionId + "/sessions", {
    method: "POST",
    body: JSON.stringify({
      mode: "direct-ephemeral",
      clientSessionNonce: nonce,
      requestedChannels: ["terminal"],
      deviceKeyVersion: 1,
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, "direct session failed: " + JSON.stringify(body).slice(0, 400));

  // Owner policy may force relay. Both outcomes are contract-legal, so branch
  // rather than assuming: what must never happen is a secret without direct mode.
  if (body.mode === "relay-strict") {
    assert.equal(body.useEnvelope, undefined, "downgraded to relay, so no envelope may appear");
    return;
  }

  assert.equal(body.mode, "direct-ephemeral");
  const env = body.useEnvelope;
  assert.ok(env, "direct-ephemeral must carry a use envelope");
  assert.equal(env.v, 1);
  assert.equal(env.alg, "ML-KEM-768+HKDF-SHA256+AES-256-GCM");
  assert.equal(env.purpose, "ssh", "an SSH connection maps to the ssh purpose");
  assert.equal(env.clientNonce, nonce, "the envelope must bind the nonce the device sent");
  assert.equal(env.sessionId, body.sessionId);
  assert.equal(env.resourceId, state.connectionId);

  // Open it with the device private key and prove it is the real credential.
  const mod = await import(pathToFileURL(path.join(repoRoot, "mobile-v1-crypto.js")).href);
  const mv1 = mod.default || mod;
  const aad = mv1.sharedUseAadBytes({
    serverId: state.serverId,
    userId: state.borrower.userId,
    deviceId: state.deviceId,
    sessionId: env.sessionId,
    resourceId: env.resourceId,
    resourceRevision: env.resourceRevision,
    purpose: env.purpose,
    expiresAt: env.expiresAt,
    clientNonce: env.clientNonce,
  });
  assert.equal(Buffer.from(env.aad, "base64").toString("hex"), aad.toString("hex"),
    "the server AAD must be reproducible by the device");

  const opened = mv1.openEnvelope({
    envelope: env,
    privateKey: state.kem.secretKey,
    expectedAad: aad,
  });
  const material = JSON.parse(opened.toString("utf8"));
  assert.equal(material.password, "owner-only-secret",
    "direct mode exists precisely so the native core gets the real credential");
  /* endpoint is a nested object, matching the field list in
   * SHARED_RESOURCE_RESIDENCY.md 3.2 ("endpoint, username, password/private
   * key/passphrase, domain, proxy/jump chain, host/cert policy"): host, port
   * and protocol only mean anything together, and grouping them keeps a bare
   * `host` from being read as a complete target. */
  assert.equal(material.endpoint.host, "10.7.7.7");
  assert.equal(material.endpoint.port, 22);
  assert.equal(material.endpoint.protocol, "SSH");
  assert.equal(material.username, "ops");

  // No control-plane secret may ride along.
  for (const forbidden of ["clientToken", "aiProviderApiKey", "aiEnvValue", "serverDataKey", "ownerSid", "refreshCredential"]) {
    assert.equal(material[forbidden], undefined, forbidden + " must never appear in a use envelope");
  }

  state.directSessionId = body.sessionId;
  state.directNonce = nonce;
});

test("a consumed direct envelope is not re-downloadable", async () => {
  if (!state.directSessionId) return; // owner policy forced relay; nothing to replay

  // Re-issuing requires a *new* nonce: replaying the old one must not return the
  // same ciphertext, or a captured response would be reusable.
  const replay = await device("/api/mobile/v1/shared/sessions/" + state.directSessionId + "/refresh", {
    method: "POST",
    body: JSON.stringify({ clientSessionNonce: state.directNonce }),
  });
  assert.equal(replay.status, 409, "reusing a spent nonce must be refused");
  assert.equal((await replay.json()).error.code, "shared_session_consumed");

  const fresh = await device("/api/mobile/v1/shared/sessions/" + state.directSessionId + "/refresh", {
    method: "POST",
    body: JSON.stringify({ clientSessionNonce: crypto.randomBytes(24).toString("base64url") }),
  });
  assert.equal(fresh.status, 200, "a fresh nonce must be able to re-seal within the grant");
  const body = await fresh.json();
  if (body.useEnvelope) {
    assert.notEqual(body.useEnvelope.clientNonce, state.directNonce);
  }
});

test("an unsupported channel is refused rather than silently dropped", async () => {
  const res = await device("/api/mobile/v1/shared/connections/" + state.connectionId + "/sessions", {
    method: "POST",
    body: JSON.stringify({
      mode: "relay-strict",
      clientSessionNonce: crypto.randomBytes(24).toString("base64url"),
      requestedChannels: ["not-a-channel"],
      deviceKeyVersion: 1,
    }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "invalid_request");
});

// -------------------------------------------------------------------- invoke --

test("a shared note is read online and never mirrored", async () => {
  const res = await device("/api/mobile/v1/shared/note/" + state.noteId + "/invoke", {
    method: "POST",
    body: JSON.stringify({ operation: "read", arguments: {} }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, "note read failed: " + JSON.stringify(body).slice(0, 300));
  assert.equal(body.ok, true);
  assert.ok(body.revision >= 1, "the client needs a revision to send back on edit");
  assert.equal(body.result.content, "shared body text");
});

test("editing a shared note without edit capability is refused", async () => {
  const res = await device("/api/mobile/v1/shared/note/" + state.noteId + "/invoke", {
    method: "POST",
    body: JSON.stringify({
      operation: "update",
      arguments: { content: "borrower tried to write" },
      expectedRevision: 1,
    }),
  });
  assert.equal(res.status, 403, "the note was shared view-only");
  const code = (await res.json()).error.code;
  assert.equal(code, "forbidden_resource_edit");
});

test("an unknown invoke operation is refused", async () => {
  const res = await device("/api/mobile/v1/shared/note/" + state.noteId + "/invoke", {
    method: "POST",
    body: JSON.stringify({ operation: "exfiltrate", arguments: {} }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "unsupported_scope");
});

// -------------------------------------------------------------------- revoke --

test("revoking the grant takes effect on the very next request", async () => {
  const res = await sid("owner", "/api/resources/connection/" + state.connectionId + "/shares", {
    method: "PUT",
    body: JSON.stringify({ shares: [] }),
  });
  assert.equal(res.status, 200, "revoke failed: " + (await res.text()).slice(0, 300));

  // No cache may keep it alive.
  const listed = await device("/api/mobile/v1/shared");
  const body = await listed.json();
  assert.ok(!body.items.some((i) => i.resourceId === state.connectionId),
    "a revoked resource must disappear immediately, not at cache expiry");

  const detail = await device("/api/mobile/v1/shared/connection/" + state.connectionId);
  assert.equal(detail.status, 404, "a revoked resource must 404 like a missing one");

  const session = await device("/api/mobile/v1/shared/connections/" + state.connectionId + "/sessions", {
    method: "POST",
    body: JSON.stringify({
      mode: "relay-strict",
      clientSessionNonce: crypto.randomBytes(24).toString("base64url"),
      requestedChannels: ["terminal"],
      deviceKeyVersion: 1,
    }),
  });
  assert.equal(session.status, 404, "no new session may be opened against a revoked grant");
});

test("a session opened before the revoke cannot be refreshed after it", async () => {
  if (!state.directSessionId) return;
  const res = await device("/api/mobile/v1/shared/sessions/" + state.directSessionId + "/refresh", {
    method: "POST",
    body: JSON.stringify({ clientSessionNonce: crypto.randomBytes(24).toString("base64url") }),
  });
  assert.ok(res.status === 404 || res.status === 410,
    "revoke must terminate live sessions, not just block new ones (got " + res.status + ")");
});

/* ---------------------------------------------------------------------------
 * The four properties below were added because mutation testing proved the
 * suite could not see them: disabling each guard in mobile-v1-shared.js left
 * every test green. A guard no test can fail is a guard that can be deleted by
 * accident, so each one now has an assertion that fails without it.
 * ------------------------------------------------------------------------- */

/** Owner-device plane: the bearer credential of the *owner* device. */
function ownerDevice(url, init = {}) {
  const headers = Object.assign({ "content-type": "application/json" }, init.headers || {});
  headers.authorization = "Bearer " + state.ownerDevice.access;
  return ownerProof(url, Object.assign({}, init, { headers }));
}

test("the shared plane refuses a row the caller owns", async () => {
  /* SHARED_RESOURCE_RESIDENCY.md 2.1: owned rows travel through sync, shared
   * rows travel online. Serving an owned row here would make the shared
   * endpoints a second, ACL-shaped read path for data the mirror already holds,
   * and would let an owner read their own secrets back through a surface whose
   * whole purpose is to *avoid* holding them. */
  const detail = await ownerDevice("/api/mobile/v1/shared/connection/" + state.connectionId);
  assert.equal(detail.status, 404,
    "an owned connection must not be readable through the shared plane");

  const listed = await ownerDevice("/api/mobile/v1/shared");
  const body = await listed.json();
  assert.equal(listed.status, 200);
  assert.ok(!body.items.some((i) => i.resourceId === state.connectionId),
    "the owner own connection must not appear in their shared directory");

  const session = await ownerDevice("/api/mobile/v1/shared/connections/" + state.connectionId + "/sessions", {
    method: "POST",
    body: JSON.stringify({
      mode: "direct-ephemeral",
      clientSessionNonce: crypto.randomBytes(24).toString("base64url"),
      requestedChannels: ["terminal"],
      deviceKeyVersion: 1,
    }),
  });
  assert.equal(session.status, 404,
    "an owner must not mint a shared session against their own row");
});

test("direct-ephemeral needs owner policy, not merely use", async () => {
  /* Owner policy, not client preference, decides whether real connect
   * material reaches the device. A grant of discover/view/use only must come
   * back as relay-strict with no envelope.
   *
   * This is the load-bearing half of SHARED_RESOURCE_RESIDENCY.md 3.2: `use`
   * authorises the *main end* to connect on the sharee behalf, which is what
   * relay does. It does not authorise handing the sharee the password. */
  const shares = await sid("owner", "/api/resources/connection/" + state.connectionId + "/shares", {
    method: "PUT",
    body: JSON.stringify({
      shares: [{ subjectId: state.borrower.userId, capabilities: ["discover", "view", "use"] }],
    }),
  });
  assert.equal(shares.status, 200, "re-share failed: " + (await shares.text()).slice(0, 200));

  const res = await device("/api/mobile/v1/shared/connections/" + state.connectionId + "/sessions", {
    method: "POST",
    body: JSON.stringify({
      mode: "direct-ephemeral",
      clientSessionNonce: crypto.randomBytes(24).toString("base64url"),
      requestedChannels: ["terminal"],
      deviceKeyVersion: 1,
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, "session open failed: " + JSON.stringify(body).slice(0, 300));

  assert.equal(body.mode, "relay-strict",
    "use without control must be downgraded to relay, never honoured as direct");
  assert.equal(body.useEnvelope, undefined,
    "use-only must not yield direct connect material");

  const text = JSON.stringify(body);
  assert.ok(!text.includes("owner-only-secret"),
    "the host password must never appear in a relay response");

  // Restore control so later tests keep the policy they expect.
  const restore = await sid("owner", "/api/resources/connection/" + state.connectionId + "/shares", {
    method: "PUT",
    body: JSON.stringify({
      shares: [{ subjectId: state.borrower.userId, capabilities: ["discover", "view", "use", "control"] }],
    }),
  });
  assert.equal(restore.status, 200);
});

test("a session is bound to the device that opened it", async () => {
  /* A session id is a bearer-ish string. If it were only bound to the account,
   * a second device on the same account could refresh someone else session and
   * obtain its use envelope. */
  const opened = await device("/api/mobile/v1/shared/connections/" + state.connectionId + "/sessions", {
    method: "POST",
    body: JSON.stringify({
      mode: "direct-ephemeral",
      clientSessionNonce: crypto.randomBytes(24).toString("base64url"),
      requestedChannels: ["terminal"],
      deviceKeyVersion: 1,
    }),
  });
  const openedBody = await opened.json();
  assert.equal(opened.status, 200, "session open failed: " + JSON.stringify(openedBody).slice(0, 300));
  const sessionId = openedBody.sessionId;

  /* The borrower binds a *second* device. Same account, different device: the
   * session must not be usable from it. */
  const second = await bindDeviceFor("borrower");
  const secondDevice = createProofClient({
    base: () => state.base,
    access: () => second.access,
    deviceId: () => second.deviceId,
    privateKey: () => second.signingPrivateKey,
  });
  const stolen = await secondDevice("/api/mobile/v1/shared/sessions/" + sessionId + "/refresh", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + second.access },
    body: JSON.stringify({ clientSessionNonce: crypto.randomBytes(24).toString("base64url") }),
  });
  const stolenBody = await stolen.json();
  assert.ok(stolen.status === 404 || stolen.status === 410,
    "another device on the same account must not refresh this session (got " + stolen.status + ")");
  assert.equal(stolenBody.useEnvelope, undefined,
    "a cross-device refresh must never return connect material");

  const closed = await secondDevice("/api/mobile/v1/shared/sessions/" + sessionId, {
    method: "DELETE",
    headers: { "content-type": "application/json", authorization: "Bearer " + second.access },
  });
  assert.ok(closed.status === 404 || closed.status === 410,
    "another device must not be able to close this session either");

  // The rightful device still owns it.
  await device("/api/mobile/v1/shared/sessions/" + sessionId, { method: "DELETE" });
});

test("a forbidden control-plane key can never ride in a shared payload", async () => {
  /* shared-use-v1.json freezes forbiddenPayloadKeys, and the module walks every
   * projected payload against it. The walk is unreachable from HTTP with the
   * current allow-lists, so it is exercised directly -- otherwise the guard that
   * exists to stop a future field from leaking is itself untested. */
  const mod = await import(pathToFileURL(path.join(repoRoot, "mobile-v1-shared.js")).href);
  const { SharedResourceApi, FORBIDDEN_PAYLOAD_KEYS } = mod.default || mod;

  const vectors = JSON.parse(fs.readFileSync(
    path.join(repoRoot, "zephyr_one", "mobile", "contracts", "test-vectors", "shared-use-v1.json"),
    "utf8",
  ));
  assert.deepEqual([...FORBIDDEN_PAYLOAD_KEYS].sort(), [...vectors.forbiddenPayloadKeys].sort(),
    "the module list must stay identical to the frozen vector");

  const api = Object.create(SharedResourceApi.prototype);
  for (const key of FORBIDDEN_PAYLOAD_KEYS) {
    assert.throws(
      () => api.assertNoForbiddenKeys({ endpoint: { host: "h" }, [key]: "value" }),
      (err) => err.code === "shared_content_export_forbidden",
      key + " must be refused at the top level",
    );
    // Nested too: a forbidden key one level down is the realistic accident.
    assert.throws(
      () => api.assertNoForbiddenKeys({ endpoint: { host: "h", [key]: "value" } }),
      (err) => err.code === "shared_content_export_forbidden",
      key + " must be refused when nested",
    );
  }

  // A clean payload must pass, or the guard would just reject everything.
  const clean = { endpoint: { host: "h", port: 22 }, username: "ops" };
  assert.equal(api.assertNoForbiddenKeys(clean), clean);
});

test("the anonymous caller cannot reach any shared endpoint", async () => {
  const routes = [
    ["GET", "/api/mobile/v1/shared"],
    ["GET", "/api/mobile/v1/shared/connection/x"],
    ["POST", "/api/mobile/v1/shared/connection/x/invoke"],
    ["POST", "/api/mobile/v1/shared/connections/x/sessions"],
    ["POST", "/api/mobile/v1/shared/sessions/x/refresh"],
    ["DELETE", "/api/mobile/v1/shared/sessions/x"],
    ["POST", "/api/mobile/v1/file-bridge/lease"],
  ];
  for (const [method, route] of routes) {
    const res = await fetch(state.base + route, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "GET" || method === "DELETE" ? undefined : "{}",
    });
    assert.ok(res.status === 401 || res.status === 403,
      method + " " + route + " answered " + res.status + " to an anonymous caller");
  }
});

test("stop the server", async () => {
  await cleanup();
});
