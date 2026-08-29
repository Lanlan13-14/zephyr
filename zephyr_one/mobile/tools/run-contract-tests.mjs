import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = path.join(mobileRoot, "tests");
const liveServerSuites = new Set([
  "mobile-v1-api.test.mjs",
  "mobile-v1-roundtrip.test.mjs",
  "mobile-v1-secrets.test.mjs",
  "mobile-v1-shared.test.mjs",
  "link-v2-enrollment.test.mjs",
]);

const allSuites = readdirSync(testsDir)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort();
const staticSuites = allSuites.filter((name) => !liveServerSuites.has(name));

function run(suites, label) {
  process.stdout.write(`\n[mobile-contracts] ${label}: ${suites.length} suite(s)\n`);
  const result = spawnSync(
    process.execPath,
    ["--test", ...suites.map((name) => path.join("tests", name))],
    { cwd: mobileRoot, env: process.env, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(staticSuites, "parallel contract suites");

// Each of these boots the full root server. GitHub's two-core runner can starve
// four simultaneous boot/migration paths long enough to exhaust their health
// budgets, and their independently selected ports still have a TOCTOU window.
// Keep the cheap suites parallel, but give each live server exclusive resources.
for (const suite of liveServerSuites) run([suite], `live server ${suite}`);
