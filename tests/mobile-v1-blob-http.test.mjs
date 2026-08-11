// Live HTTP test for /api/mobile/v1/blobs/* (SYNC_STATE_MACHINE.md section 11).
//
// The store semantics are pinned by mobile-v1-blobs.test.mjs; this file proves
// the express layer actually mounts the routes, that the DeviceAccess plane
// guards them, and that a real 4 MiB-chunk upload round-trips over the wire.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createProofClient } from "../zephyr_one/mobile/tests/mobile-v1-proof-client.mjs";
import { createSecureTestDataDir, removeSecureTestDataDir } from "./helpers/secure-data-dir.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const ADMIN_PASSWORD = "mv1-blob-http-pass";
const CHUNK = 4 * 1024 * 1024; // server-pinned, from /capabilities limits

const state = {
  child: null, base: "", dataDir: "", dataFixture: null, cookie: "", sid: "",
  tokenId: "", deviceId: "", access: "", log: "", signingPrivateKey: null,
};

const proofDevice = createProofClient({
  base: () => state.base,
  access: () => state.access,
  deviceId: () => state.deviceId,
  privateKey: () => state.signingPrivateKey,
});

async function waitHealthy(budgetMs) {
  const until = Date.now() + budgetMs;
  while (Date.now() < until) {
    if (state.child && state.child.exitCode !== null) return false;
    try {
      const res = await fetch(state.base + "/healthz");
      if (res.ok) return true;
    } catch (err) { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function device(pathname, init) {
  const opts = init || {};
  const headers = Object.assign({
    authorization: "Bearer " + state.access,
    "x-zephyr-one-client": "1",
    "x-zephyr-one-platform": "android",
    "x-zephyr-protocol-version": "1",
  }, opts.headers || {});
  return proofDevice(pathname, Object.assign({}, opts, { headers }));
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

test("boot a server, rotate the admin password, bind a device", async () => {
  state.dataFixture = createSecureTestDataDir("mv1-blob-http-");
  state.dataDir = state.dataFixture.dataDir;
  const port = 23100 + Math.floor(Math.random() * 300);
  state.base = "http://127.0.0.1:" + port;

  state.child = spawn(process.execPath, ["server.js"], {
    cwd: repoRoot,
    env: Object.assign({}, process.env, {
      HTTP_ENABLED: "true",
      HTTPS_ENABLED: "false",
      PORT: String(port),
      ZEPHYR_AI_HOST_LISTEN: "127.0.0.1:" + (port + 1000),
      ZEPHYR_AI_PLATFORM_HOST_URL: "http://127.0.0.1:" + (port + 1000),
      ZEPHYR_DATA_DIR: state.dataDir,
      ZEPHYR_DATA_MLKEM768_KEY_FILE: path.join(state.dataDir, "crypto", "key.json"),
      ENCRYPTION_KEY: "mv1-blob-http-key",
      ZEPHYR_ONE_USE_BUILTIN_SQLITE: "1",
      NODE_ENV: "production",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  state.child.stdout.on("data", (b) => { state.log += b.toString(); });
  state.child.stderr.on("data", (b) => { state.log += b.toString(); });
  assert.ok(await waitHealthy(60000), "server never became healthy:\n" + state.log.slice(-3000));

  const login = await fetch(state.base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin" }),
  });
  assert.equal(login.status, 200);
  state.cookie = (login.headers.get("set-cookie") || "").split(";")[0];

  const rotate = await fetch(state.base + "/api/auth/change-password", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: state.cookie },
    body: JSON.stringify({ currentPassword: "admin", newPassword: ADMIN_PASSWORD }),
  });
  assert.equal(rotate.status, 200);

  const relogin = await fetch(state.base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-zephyr-one-client": "1" },
    body: JSON.stringify({ username: "admin", password: ADMIN_PASSWORD }),
  });
  assert.equal(relogin.status, 200);
  state.sid = (await relogin.json()).sid;
  assert.ok(state.sid);

  const token = await fetch(state.base + "/api/rdp/file-agent-tokens", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: state.cookie },
    body: JSON.stringify({ name: "blob-http" }),
  });
  assert.ok(token.status === 200 || token.status === 201);
  const tokenBody = await token.json();
  state.tokenId = tokenBody.id || (tokenBody.token && tokenBody.token.id) || (tokenBody.record && tokenBody.record.id);
  assert.ok(state.tokenId);

  const { ml_kem768 } = await import("@noble/post-quantum/ml-kem.js");
  const kem = ml_kem768.keygen();
  const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  state.signingPrivateKey = ec.privateKey;
  const jwk = ec.publicKey.export({ format: "jwk" });
  state.deviceId = "dev-" + crypto.randomUUID();
  const verify = await fetch(state.base + "/api/mobile/v1/sensitive/verify", {
    method: "POST",
    headers: { "content-type": "application/json", "x-zephyr-sid": state.sid },
    body: JSON.stringify({
      action: "device.bind",
      targetIds: [state.tokenId, state.deviceId],
      secret: ADMIN_PASSWORD,
    }),
  });
  const verifyBody = await verify.json();
  assert.equal(verify.status, 200, "sensitive verify failed: " + JSON.stringify(verifyBody).slice(0, 300));
  assert.ok(verifyBody.grant);
  const bind = await fetch(state.base + "/api/mobile/v1/devices/bind", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-zephyr-sid": state.sid,
      "x-zephyr-sensitive-grant": verifyBody.grant,
    },
    body: JSON.stringify({
      deviceId: state.deviceId, deviceName: "Blob HTTP", platform: "android",
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
  assert.ok(state.access);
});

test("capabilities advertise blob transfer with the frozen chunk size", async () => {
  const res = await fetch(state.base + "/api/mobile/v1/capabilities");
  const body = await res.json();
  assert.equal(body.features.blobTransfer, true);
  assert.equal(body.limits.blobChunkBytes, CHUNK);
  assert.equal(typeof body.limits.maxBlobBytes, "number");
});

test("blob endpoints refuse an anonymous caller", async () => {
  const digest = "a".repeat(64);
  const attempts = [
    ["POST", "/api/mobile/v1/blobs/uploads", "{}"],
    ["GET", "/api/mobile/v1/blobs/uploads/upl_nope", null],
    ["PUT", "/api/mobile/v1/blobs/uploads/upl_nope/chunks/0", Buffer.alloc(8)],
    ["GET", "/api/mobile/v1/blobs/" + digest, null],
    ["GET", "/api/mobile/v1/blobs/" + digest + "/chunks/0", null],
  ];
  for (const [method, route, body] of attempts) {
    const res = await fetch(state.base + route, {
      method,
      headers: body ? { "content-type": method === "PUT" ? "application/octet-stream" : "application/json" } : {},
      body: body || undefined,
    });
    assert.equal(res.status, 401, route + " must require the DeviceAccess plane");
    const parsed = await res.json();
    assert.equal(parsed.ok, false);
  }
});

test("manifest validation rejects bad digests and inconsistent chunk counts", async () => {
  const badSha = await device("/api/mobile/v1/blobs/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sha256: "nope", size: 8, mime: "x/y", chunks: [] }),
  });
  assert.equal(badSha.status, 400);
  assert.equal((await badSha.json()).error.code, "invalid_request");

  const badCount = await device("/api/mobile/v1/blobs/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sha256: "b".repeat(64), size: 8, mime: "x/y", chunks: [] }),
  });
  assert.equal(badCount.status, 400);
  const parsed = await badCount.json();
  assert.equal(parsed.error.code, "invalid_request");
  assert.equal(parsed.error.details.expectedChunks, 1);
});

const blobBody = Buffer.concat([crypto.randomBytes(CHUNK), Buffer.from("end")]);
const blobDigest = sha256(blobBody);
let uploadId = "";

test("a two-chunk upload completes out of order and becomes downloadable", async () => {
  const create = await device("/api/mobile/v1/blobs/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sha256: blobDigest,
      size: blobBody.length,
      mime: "application/x-test",
      chunks: [sha256(blobBody.subarray(0, CHUNK)), sha256(blobBody.subarray(CHUNK))],
      encrypted: false,
    }),
  });
  const created = await create.json();
  assert.equal(create.status, 200, JSON.stringify(created).slice(0, 300));
  assert.equal(created.ok, true);
  assert.equal(created.upload.state, "receiving");
  assert.equal(created.upload.chunkBytes, CHUNK);
  assert.deepEqual(created.upload.missing, [0, 1]);
  uploadId = created.upload.uploadId;
  assert.ok(uploadId);

  // Tail chunk first: order must not matter.
  const tail = await device("/api/mobile/v1/blobs/uploads/" + uploadId + "/chunks/1", {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: blobBody.subarray(CHUNK),
  });
  const tailBody = await tail.json();
  assert.equal(tail.status, 200, JSON.stringify(tailBody).slice(0, 300));
  assert.equal(tailBody.upload.state, "receiving");
  assert.deepEqual(tailBody.upload.missing, [0]);

  const status = await device("/api/mobile/v1/blobs/uploads/" + uploadId);
  const statusBody = await status.json();
  assert.equal(status.status, 200);
  assert.deepEqual(statusBody.upload.received, [1]);

  const head = await device("/api/mobile/v1/blobs/uploads/" + uploadId + "/chunks/0", {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: blobBody.subarray(0, CHUNK),
  });
  const headBody = await head.json();
  assert.equal(head.status, 200);
  assert.ok(["finalizing", "complete"].includes(headBody.upload.state));
  assert.deepEqual(headBody.upload.missing, []);

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const finalized = await device("/api/mobile/v1/blobs/uploads/" + uploadId);
    const finalizedBody = await finalized.json();
    assert.equal(finalized.status, 200);
    if (finalizedBody.upload.state === "complete") return;
    assert.equal(finalizedBody.upload.state, "finalizing");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("blob did not leave finalizing state before the deadline");
});

test("the completed blob downloads whole and per chunk", async () => {
  const whole = await device("/api/mobile/v1/blobs/" + blobDigest);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("x-zephyr-blob-sha256"), blobDigest);
  assert.equal(whole.headers.get("content-type"), "application/x-test");
  const bytes = Buffer.from(await whole.arrayBuffer());
  assert.equal(bytes.length, blobBody.length);
  assert.equal(sha256(bytes), blobDigest, "downloaded bytes must hash to the manifest digest");

  const chunk = await device("/api/mobile/v1/blobs/" + blobDigest + "/chunks/1");
  assert.equal(chunk.status, 200);
  assert.equal(chunk.headers.get("x-zephyr-blob-chunk-index"), "1");
  const tail = Buffer.from(await chunk.arrayBuffer());
  assert.deepEqual(tail, blobBody.subarray(CHUNK));
});

test("re-posting the same manifest after completion is an idempotent no-op", async () => {
  const res = await device("/api/mobile/v1/blobs/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sha256: blobDigest,
      size: blobBody.length,
      mime: "application/x-test",
      chunks: [sha256(blobBody.subarray(0, CHUNK)), sha256(blobBody.subarray(CHUNK))],
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.upload.state, "complete");
  assert.equal(body.upload.uploadId, null, "no new upload is opened for a blob the server already holds");
});

test("a chunk with wrong bytes is a registered hash error", async () => {
  const body = Buffer.alloc(CHUNK + 1, 7);
  const digest = sha256(body);
  const create = await device("/api/mobile/v1/blobs/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sha256: digest, size: body.length, mime: "x/y", chunks: [sha256(body.subarray(0, CHUNK)), sha256(body.subarray(CHUNK))] }),
  });
  const created = await create.json();
  assert.equal(create.status, 200);
  const bad = await device("/api/mobile/v1/blobs/uploads/" + created.upload.uploadId + "/chunks/0", {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: Buffer.alloc(CHUNK, 9),
  });
  assert.equal(bad.status, 422);
  const parsed = await bad.json();
  assert.equal(parsed.error.code, "blob_hash_mismatch");
  assert.equal(parsed.error.retryable, true);
});

test("downloading a blob the server never completed is blob_missing_chunk", async () => {
  const res = await device("/api/mobile/v1/blobs/" + "c".repeat(64));
  assert.equal(res.status, 409);
  const parsed = await res.json();
  assert.equal(parsed.error.code, "blob_missing_chunk");
});

test("another user's upload session is a 404, never a 403 that confirms it exists", async () => {
  const res = await device("/api/mobile/v1/blobs/uploads/upl_doesnotexist");
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, "resource_not_found_or_inaccessible");
});

test("in-flight upload limits return 429 with Retry-After", async () => {
  let limited = null;
  for (let index = 0; index < 8; index += 1) {
    const bytes = Buffer.from("limit-" + index);
    const res = await device("/api/mobile/v1/blobs/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sha256: sha256(bytes),
        size: bytes.length,
        mime: "application/octet-stream",
        chunks: [sha256(bytes)],
      }),
    });
    if (res.status === 429) {
      limited = res;
      break;
    }
    assert.equal(res.status, 200);
  }
  assert.ok(limited, "server must bound active uploads per device");
  assert.match(limited.headers.get("retry-after") || "", /^\d+$/);
  const body = await limited.json();
  assert.equal(body.error.code, "rate_limited");
  assert.equal(body.error.retryable, true);
});

test("stop the server", async () => {
  if (state.child) {
    state.child.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 500));
  }
  if (state.dataFixture) {
    try { removeSecureTestDataDir(state.dataFixture); } catch (err) { /* windows lock */ }
  }
});
