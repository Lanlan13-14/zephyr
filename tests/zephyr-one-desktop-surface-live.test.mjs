// Live end-to-end check of the Zephyr One desktop surface.
//
// The existing brand-mark and icon-artifact suites are static: they read the
// SVGs, the .ico frames and the transform source. None of them boots a server
// and asks for the page the desktop shell actually loads, so the two symptoms
// reported against the desktop build -- "loading fails after launch" and "the
// in-app icon is not the ZephyrOne icon" -- were both invisible to CI.
//
// This boots the real server in embedded mode and drives /app.html the way the
// Tauri webview does.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

let child = null;
let base = "";
let dataDir = "";
let sid = "";

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

test("boot the desktop shell server in embedded mode", async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "one-desktop-"));
  const port = 23100 + Math.floor(Math.random() * 300);
  base = "http://127.0.0.1:" + port;

  child = spawn(process.execPath, ["server.js"], {
    cwd: repoRoot,
    env: Object.assign({}, process.env, {
      HTTP_ENABLED: "true",
      HTTPS_ENABLED: "false",
      PORT: String(port),
      ZEPHYR_DATA_DIR: dataDir,
      ZEPHYR_ONE_USE_BUILTIN_SQLITE: "1",
      /* The whole point: this is the embedded desktop surface, not the browser. */
      ZEPHYR_ONE_EMBEDDED: "1",
      ENCRYPTION_KEY: "one-desktop-surface-test-key",
      NODE_ENV: "production",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (b) => { log += b.toString(); });
  child.stderr.on("data", (b) => { log += b.toString(); });

  const res = await waitUp(base + "/healthz", 60000);
  assert.ok(res, "server never became healthy:\n" + log.slice(-3000));
});

test("the embedded shell adopts a session without any cookie", async () => {
  /* The Tauri webview has no cookie on first paint. If adoption regressed, the
   * shell would bounce to the login page and the user would report exactly the
   * "loads but goes nowhere" symptom. */
  const res = await fetch(base + "/api/auth/me");
  assert.equal(res.status, 200, "embedded mode must adopt a local session");
  const body = await res.json();
  assert.ok(body.user, "no user on the adopted session");
  sid = "";
});

test("GET /app.html serves the One product marker, not the Zephyr surface", async () => {
  const res = await fetch(base + "/app.html");
  assert.equal(res.status, 200, "the desktop shell entry point must load");
  const html = await res.text();

  /* This attribute is the single switch theme-runtime.js reads to draw the One
   * wind-mark plus wordmark instead of the Zephyr mark. Without it the header
   * renders the generic Zephyr icon, which is the reported symptom. */
  assert.match(html, /<html[^>]*data-zephyr-product="one"/,
    "the served page must carry the One product marker");

  // Exactly once: a doubled marker means the transform ran twice.
  const markers = html.split("data-zephyr-product=\"one\"").length - 1;
  assert.equal(markers, 1, "the product marker must appear exactly once");

  // The logout button is structurally removed in One.
  assert.ok(!html.includes("id=\"logoutBtn\""),
    "the embedded surface must drop the logout button");
});

test("the served page still boots app.js and theme-runtime", async () => {
  const html = await (await fetch(base + "/app.html")).text();
  assert.match(html, /<script src="app\.js/, "app.js must still be the entry module");
  assert.match(html, /id="brandIcon"/, "the brand icon host element must survive the transform");

  for (const asset of ["/app.js", "/theme-runtime.js"]) {
    const res = await fetch(base + asset);
    assert.equal(res.status, 200, asset + " must be served");
  }
});

test("app.js does not dereference an element the embedded surface removed", async () => {
  /* The concrete crash that broke the desktop build: bindEvents() read
   * #logoutBtn unguarded, and the embedded surface removes that button, so the
   * listener threw and aborted the rest of bindEvents -- including
   * applyAppearance(), which is what installs the brand mark. That is why the
   * page appeared to load and then showed the placeholder emoji.
   *
   * Asserted against the served asset rather than the file on disk, so a stale
   * staged copy cannot pass this. */
  const js = await (await fetch(base + "/app.js")).text();
  const removedIds = ["logoutBtn"];
  for (const id of removedIds) {
    const unguarded = new RegExp("\\$\\(.#" + id + ".\\)\\.addEventListener");
    assert.ok(!unguarded.test(js),
      "#" + id + " is removed by the embedded surface, so it must be dereferenced defensively");
  }
});

test("stop the server", async () => {
  if (child) {
    child.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 400));
  }
  if (dataDir) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (err) { /* windows lock */ } }
});
