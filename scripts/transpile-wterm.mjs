// Transpile the vendored @wterm TypeScript sources to browser-ready ESM JS,
// using esbuild for reliable type-stripping. The bare `@wterm/core` specifier
// is rewritten to a relative path via a temp preprocessed file so the output
// loads without a bundler/import-map (esbuild --alias requires --bundle, which
// we don't want: we need one JS file per TS source to preserve the structure).
//
// Usage: node scripts/transpile-wterm.mjs core   (transpile @wterm/core)
//        node scripts/transpile-wterm.mjs dom    (transpile @wterm/dom)
//
// Requires: npx esbuild (falls back to the project's node_modules/.bin/esbuild)
import { readdirSync, mkdirSync, existsSync, copyFileSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "fs";
import { join, dirname, basename, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { tmpdir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const WTERM = join(ROOT, "wterm");
const VENDOR = join(ROOT, "public", "vendor", "wterm-fork");

const which = process.argv[2];
if (which !== "core" && which !== "dom") {
  console.error("Usage: node transpile-wterm.mjs core|dom");
  process.exit(1);
}

// Locate an esbuild binary.
function findEsbuild() {
  const local = join(ROOT, "node_modules", ".bin", "esbuild");
  if (existsSync(local)) return local;
  return null; // use npx
}
const ESBUILD = findEsbuild();
const TMP = mkdtempSync(join(tmpdir(), "wterm-transpile-"));

function runEsbuild(infile, outfile) {
  const args = [
    infile,
    "--outfile=" + outfile,
    "--format=esm",
    "--target=es2020",
  ];
  const cmd = ESBUILD || "npx";
  const fullArgs = ESBUILD ? args : ["--yes", "esbuild", ...args];
  execFileSync(cmd, fullArgs, { stdio: "pipe", cwd: ROOT });
}

// Rewrite `@wterm/core` -> relative path to the built core, write to a temp
// .ts file, then transpile that. For dom files, core is at ../core/index.js
// relative to the output dir; since esbuild resolves imports relative to the
// source file, we point at the real built core path.
function preprocess(infile, isDom) {
  let src = readFileSync(infile, "utf8");
  if (isDom) {
    // dom files live in VENDOR root; core is at ./core/index.js
    src = src.replace(/from\s*["']@wterm\/core["']/g, 'from "./core/index.js"');
  }
  const name = basename(infile);
  const tmpFile = join(TMP, name);
  writeFileSync(tmpFile, src);
  return tmpFile;
}

function srcFiles(pkgDir) {
  return readdirSync(pkgDir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .map((f) => join(pkgDir, f));
}

function buildCore() {
  const srcDir = join(WTERM, "packages", "@wterm", "core", "src");
  const outDir = join(VENDOR, "core");
  mkdirSync(outDir, { recursive: true });
  for (const file of srcFiles(srcDir)) {
    const name = basename(file).replace(/\.ts$/, ".js");
    if (name === "wasm-inline.js") continue; // already generated as JS by build-wterm.sh
    const outfile = join(outDir, name);
    runEsbuild(file, outfile);
    console.log("  core/" + name);
  }
}

function buildDom() {
  const srcDir = join(WTERM, "packages", "@wterm/dom", "src");
  for (const file of srcFiles(srcDir)) {
    const name = basename(file).replace(/\.ts$/, ".js");
    const tmp = preprocess(file, true);
    const outfile = join(VENDOR, name);
    runEsbuild(tmp, outfile);
    console.log("  " + name);
  }
  // Copy CSS verbatim
  const css = join(srcDir, "terminal.css");
  if (existsSync(css)) {
    copyFileSync(css, join(VENDOR, "terminal.css"));
    console.log("  terminal.css");
  }
}

try {
  if (which === "core") buildCore();
  else buildDom();
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

console.log("transpile-wterm: done (" + which + ")");
