// Transpile the vendored @wterm TypeScript sources to browser-ready ESM JS.
// Uses esbuild-wasm (works under PRoot/aarch64 when native esbuild is broken).
//
// Usage: node scripts/transpile-wterm.mjs core|dom
import {
  readdirSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from "fs";
import { join, dirname, basename, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild-wasm");

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const WTERM = join(ROOT, "wterm");
const VENDOR = join(ROOT, "public", "vendor", "wterm-fork");

const which = process.argv[2];
if (which !== "core" && which !== "dom") {
  console.error("Usage: node transpile-wterm.mjs core|dom");
  process.exit(1);
}

const TMP = mkdtempSync(join(tmpdir(), "wterm-transpile-"));

let esbuildReady;
async function ensureEsbuild() {
  if (!esbuildReady) {
    esbuildReady = esbuild.initialize({
      wasmURL: undefined,
      worker: false,
    }).catch(async () => {
      // Some versions need wasmModule path
      const wasmPath = require.resolve("esbuild-wasm/esbuild.wasm");
      const wasm = readFileSync(wasmPath);
      return esbuild.initialize({
        wasmModule: await WebAssembly.compile(wasm),
        worker: false,
      });
    });
  }
  return esbuildReady;
}

async function runEsbuild(infile, outfile) {
  await ensureEsbuild();
  const result = await esbuild.build({
    entryPoints: [infile],
    outfile,
    format: "esm",
    target: "es2020",
    write: true,
    logLevel: "silent",
  });
  return result;
}

function preprocess(infile, isDom) {
  let src = readFileSync(infile, "utf8");
  if (isDom) {
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

async function buildCore() {
  const srcDir = join(WTERM, "packages", "@wterm", "core", "src");
  const outDir = join(VENDOR, "core");
  mkdirSync(outDir, { recursive: true });
  for (const file of srcFiles(srcDir)) {
    const name = basename(file).replace(/\.ts$/, ".js");
    if (name === "wasm-inline.js") continue;
    if (name === "xterm-headless.js") continue;
    if (name === "xterm-headless-register.js") continue;
    let infile = file;
    if (name === "xterm-bridge.js") {
      let src = readFileSync(file, "utf8");
      src = src.replace(
        /await import\(["']@xterm\/headless["']\)/g,
        "await Promise.resolve({ Terminal: null })",
      );
      infile = join(TMP, "xterm-bridge.ts");
      writeFileSync(infile, src);
    }
    const outfile = join(outDir, name);
    await runEsbuild(infile, outfile);
    console.log("  core/" + name);
  }
}

async function buildDom() {
  const srcDir = join(WTERM, "packages", "@wterm", "dom", "src");
  for (const file of srcFiles(srcDir)) {
    const name = basename(file).replace(/\.ts$/, ".js");
    const tmp = preprocess(file, true);
    const outfile = join(VENDOR, name);
    await runEsbuild(tmp, outfile);
    console.log("  " + name);
  }
  const css = join(srcDir, "terminal.css");
  if (existsSync(css)) {
    copyFileSync(css, join(VENDOR, "terminal.css"));
    console.log("  terminal.css");
  }
}

try {
  if (which === "core") await buildCore();
  else await buildDom();
  console.log("transpile-wterm: done (" + which + ")");
} catch (err) {
  console.error(err);
  process.exit(1);
} finally {
  rmSync(TMP, { recursive: true, force: true });
}
