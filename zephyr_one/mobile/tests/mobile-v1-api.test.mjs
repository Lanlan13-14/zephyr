// Live HTTP contract test for /api/mobile/v1.
//
// The 22 frozen operations had zero server implementation, so the client had no
// peer to talk to. This boots a real server against a throwaway data directory
// and drives the endpoints over HTTP, because a unit test on the route module
// cannot prove express actually mounts the paths or that the auth planes are
// wired to the right middleware.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startChildOnLoopback, stopChild } from "./mobile-v1-live-server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

let child = null;
let base = "";
let dataDir = "";

async function cleanup() {
  await stopChild(child);
  child = null;
  if (dataDir) {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (err) { /* windows lock */ }
    dataDir = "";
  }
}

after(cleanup);

test("boot the server with mobile v1 mounted", async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mv1-api-"));
  let log = "";
  const started = await startChildOnLoopback({
    healthPath: "/api/mobile/v1/capabilities",
    log: () => log,
    spawnChild: ({ httpPort, aiPort, attempt }) => {
      base = "http://127.0.0.1:" + httpPort;
      log += `[startup attempt ${attempt}: http=${httpPort} ai=${aiPort}]\n`;
      child = spawn(process.execPath, ["server.js"], {
        cwd: repoRoot,
        env: Object.assign({}, process.env, {
          HTTP_ENABLED: "true",
          HTTPS_ENABLED: "false",
          PORT: String(httpPort),
          ZEPHYR_BIND_HOST: "127.0.0.1",
          ZEPHYR_AI_HOST_LISTEN: "127.0.0.1:" + aiPort,
          ZEPHYR_AI_PLATFORM_HOST_URL: "http://127.0.0.1:" + aiPort,
          ZEPHYR_DATA_DIR: dataDir,
          ZEPHYR_DATA_MLKEM768_KEY_FILE: path.join(dataDir, "crypto", "key.json"),
          ENCRYPTION_KEY: "mobile-v1-api-test-key",
          ZEPHYR_ONE_USE_BUILTIN_SQLITE: "1",
          NODE_ENV: "production",
        }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (b) => { log += b.toString(); });
      child.stderr.on("data", (b) => { log += b.toString(); });
      return child;
    },
  });
  child = started.child;
  const res = started.response;
  assert.equal(res.status, 200, "capabilities is unauthenticated by contract");
});

test("capabilities negotiates protocol, registry and limits", async () => {
  const res = await fetch(base + "/api/mobile/v1/capabilities");
  const body = await res.json();

  assert.equal(body.ok, true);
  assert.deepEqual(body.protocolVersions, [1], "the client pins protocol version 1");
  assert.match(body.registryHash, /^[0-9a-f]{64}$/, "registryHash must be a sha256 digest");

  // The client reads these to size its own batches and pages.
  assert.equal(body.limits.maxOpsPerBatch, 200, "frozen by SyncContract.MAX_OPS_PER_BATCH");
  assert.equal(body.limits.minIntervalSec, 30);
  assert.equal(body.limits.maxIntervalSec, 86400);
  assert.equal(body.limits.blobChunkBytes, 4 * 1024 * 1024);

  // Retention drives the client decision about whether a held cursor is stale.
  assert.equal(body.limits.tombstoneRetentionDays, 180);
  assert.equal(body.limits.appliedOpRetentionDays, 180);

  assert.equal(body.auth.signingAlg, "ES256");
  assert.equal(body.auth.encryptionAlg, "ML-KEM-768");
  assert.equal(body.auth.sidHeader, "X-Zephyr-Sid");

  // Unimplemented surfaces are declared false rather than omitted: an absent
  // key reads as unknown and makes the client probe a dead endpoint.
  assert.equal(body.features.bidirectionalSync, true);
  // Shared residency is implemented, so it must read true: the client branches
  // on this flag and a false here makes One skip the shared surface entirely.
  assert.equal(body.features.sharedResources, true);
  /* File bridge must stay false.
   *
   * POST /file-bridge/lease exists and validates its request, but there is no
   * ZFT2 transport behind it for a mobile device: the /file-transfer upgrade
   * authenticates a cookie session bound to a file-agent, and the gateway has
   * no concept of a device lease. Declaring true would make the client mint a
   * lease and then attach to a socket that refuses it, which is worse than
   * knowing up front that the capability is absent. */
  assert.equal(body.features.fileBridge, false);

  // Blob upload/download is mounted at /api/mobile/v1/blobs/* and has its
  // own authenticated HTTP coverage, so the capability must advertise it.
  assert.equal(body.features.blobTransfer, true);
});

test("the registry hash the server serves is the one the client generated against", async () => {
  const res = await fetch(base + "/api/mobile/v1/capabilities");
  const body = await res.json();

  // Recompute from the frozen registry exactly as the store does, so a change
  // to either side is caught rather than silently tolerated.
  const registryPath = path.join(repoRoot, "zephyr_one", "mobile", "contracts", "registries", "entity-registry.json");
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  const { createHash } = await import("node:crypto");

  const canonical = (value) => {
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    if (value && typeof value === "object") {
      return "{" + Object.keys(value).sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
    }
    return JSON.stringify(value === undefined ? null : value);
  };
  const expected = createHash("sha256").update(canonical(registry), "utf8").digest("hex");
  assert.equal(body.registryHash, expected, "server registryHash must be derived from the frozen registry");
});

test("every authenticated plane refuses an anonymous caller", async () => {
  const guarded = [
    ["GET", "/api/mobile/v1/devices"],
    ["GET", "/api/mobile/v1/sync/bootstrap"],
    ["GET", "/api/mobile/v1/sync/changes?sinceCursor=0"],
    ["GET", "/api/mobile/v1/sync/status"],
    ["POST", "/api/mobile/v1/sync/push"],
    ["POST", "/api/mobile/v1/sync/ack"],
    ["POST", "/api/mobile/v1/sync/now"],
    ["POST", "/api/mobile/v1/devices/bind"],
    ["POST", "/api/mobile/v1/devices/proof-challenge"],
    ["POST", "/api/mobile/v1/sensitive/verify"],
    ["PATCH", "/api/mobile/v1/devices/dev-1"],
    ["DELETE", "/api/mobile/v1/devices/dev-1"],
  ];

  for (const [method, route] of guarded) {
    const res = await fetch(base + route, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "GET" || method === "DELETE" ? undefined : "{}",
    });
    assert.ok(
      res.status === 401 || res.status === 403,
      method + " " + route + " answered " + res.status + " to an anonymous caller",
    );
  }
});

/*
 * Refresh is deliberately NOT in the guarded list above.
 *
 * It is the one endpoint whose credential travels in the body rather than a
 * header: the refresh credential is single-use, so sending it as a bearer
 * header would let a leaked header be replayed to mint fresh access. That makes
 * an empty body a malformed request (400) rather than an unauthenticated one,
 * so the property worth asserting is the next one down: a well-formed request
 * carrying a credential the server never issued must be refused.
 */
test("refresh rejects a credential the server never issued", async () => {
  const malformed = await fetch(base + "/api/mobile/v1/devices/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(malformed.status, 400, "an empty body is malformed, not unauthenticated");
  const malformedBody = await malformed.json();
  assert.equal(malformedBody.ok, false);
  assert.equal(malformedBody.error.code, "invalid_request");

  const forged = await fetch(base + "/api/mobile/v1/devices/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "dev-does-not-exist", refreshCredential: "forged" }),
  });
  assert.ok(
    forged.status === 401 || forged.status === 404,
    "a forged refresh credential must never mint access; got " + forged.status,
  );
  const forgedBody = await forged.json();
  assert.equal(forgedBody.ok, false);
  assert.equal(
    forgedBody.accessCredential,
    undefined,
    "a refused refresh must not return an access credential",
  );
});

test("errors use the frozen nested envelope with a registry code", async () => {
  const res = await fetch(base + "/api/mobile/v1/devices");
  const body = await res.json();

  // Shape is frozen by contracts/schemas/error.schema.json: the client branches
  // on code alone and never parses message.
  assert.equal(body.ok, false);
  assert.equal(typeof body.error, "object");
  assert.equal(typeof body.error.code, "string");
  assert.ok(body.error.code.length > 0);
  assert.equal(typeof body.error.message, "string");
  assert.equal(typeof body.error.retryable, "boolean");
  assert.ok(body.error.requestId, "every error must carry a requestId for support correlation");

  // The code must exist in the frozen registry, not be invented per call site.
  const registryPath = path.join(repoRoot, "zephyr_one", "mobile", "contracts", "registries", "error-registry.json");
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  const known = new Set(registry.errors.map((e) => e.code));
  assert.ok(known.has(body.error.code), body.error.code + " is not in the frozen error registry");
});

test("a bad access credential is rejected without leaking whether the device exists", async () => {
  const res = await fetch(base + "/api/mobile/v1/sync/status", {
    headers: { authorization: "Bearer not-a-real-credential" },
  });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.ok, false);
  // Same code as a missing credential: an attacker must not learn device ids by
  // comparing responses.
  assert.equal(body.error.code, "app_session_expired");
});

test("surfaces with no implementation say so instead of pretending to work", async () => {
  const declared = [
    ["GET", "/api/mobile/v1/shared"],
    ["POST", "/api/mobile/v1/file-bridge/lease"],
    ["GET", "/api/mobile/v1/shared/connection/c1"],
  ];
  for (const [method, route] of declared) {
    const res = await fetch(base + route, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "POST" ? "{}" : undefined,
    });
    // Either the auth gate fires first or the route reports unsupported; what
    // must never happen is a 200 with a fabricated empty result, which the
    // client would cache as a complete answer.
    assert.notEqual(res.status, 200, route + " must not fake a successful response");
    const body = await res.json();
    assert.equal(body.ok, false);
  }
});

test("the mounted push parser rejects oversized JSON before the auth plane", async () => {
  const res = await fetch(base + "/api/mobile/v1/sync/push", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(4 * 1024 * 1024 + 1024) }),
  });
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "payload_too_large");
  assert.ok(body.error.requestId);
});

test("stop the server", async () => {
  await cleanup();
});
