/*
 * Static resolution gate for the Android tree.
 *
 * There is no Gradle wrapper and no Android SDK in CI yet, so 46k lines of Kotlin are never
 * compiled. That let three referenced-but-undeclared symbols sit in the tree
 * (`ZephyrOneRoot`, `ZephyrApplication`, `AccountContainer`), each of which is a hard compile
 * error the moment a build is attempted.
 *
 * This is not a substitute for compiling. It only answers the question a compiler answers first
 * and cheaply: does every `one.zephyr.mobile.*` name that a file imports, and every same-package
 * type it names, exist somewhere in the tree? That is exactly the class of breakage that shipped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MOBILE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID_ROOT = path.join(MOBILE_ROOT, 'android');

const PACKAGE_PREFIX = 'one.zephyr.mobile.';

/**
 * Names the Android toolchain generates rather than the tree declaring.
 *
 * `R` and `BuildConfig` are emitted per module from res/ and the Gradle config, so they are
 * legitimately absent from source. Everything else must be declared.
 */
const GENERATED = new Set(['R', 'BuildConfig']);

function kotlinFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'build' || entry.name === '.gradle') continue;
      out.push(...kotlinFiles(full));
    } else if (entry.name.endsWith('.kt')) {
      out.push(full);
    }
  }
  return out;
}

/** Strips comments and string literals so a name inside prose is never counted as a reference. */
function stripNoise(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

const files = kotlinFiles(ANDROID_ROOT);

/** Every top-level declaration in the tree, as a fully-qualified name. */
const declared = new Set();
/** Simple names, for the same-package check. */
const declaredSimple = new Set();

const DECL = /^\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public\s+|internal\s+|private\s+|abstract\s+|open\s+|sealed\s+|data\s+|value\s+|enum\s+|annotation\s+|inline\s+|fun\s+(?=interface)|companion\s+)*(class|interface|object|enum class|fun interface|typealias)\s+([A-Za-z_][A-Za-z0-9_]*)/;
const TOP_FUN = /^(?:public\s+|internal\s+|private\s+|inline\s+|suspend\s+|operator\s+)*fun\s+(?:<[^>]*>\s*)?(?:[A-Za-z_][A-Za-z0-9_.<>?, ]*\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
const TOP_VAL = /^(?:public\s+|internal\s+|private\s+|const\s+)*(?:val|var)\s+([A-Za-z_][A-Za-z0-9_]*)/;

const parsed = [];

for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8');
  const clean = stripNoise(raw);
  const pkg = clean.match(/^\s*package\s+([\w.]+)/m)?.[1] ?? '';
  const lines = clean.split(/\r?\n/);

  for (const line of lines) {
    // Top-level only: an indented declaration is a member and is not importable on its own.
    const indented = /^\s/.test(line);
    const decl = line.match(DECL);
    if (decl && !indented) {
      declared.add(pkg + '.' + decl[2]);
      declaredSimple.add(decl[2]);
      continue;
    }
    if (indented) continue;
    const fn = line.match(TOP_FUN);
    if (fn) {
      declared.add(pkg + '.' + fn[1]);
      declaredSimple.add(fn[1]);
      continue;
    }
    const value = line.match(TOP_VAL);
    if (value) {
      declared.add(pkg + '.' + value[1]);
      declaredSimple.add(value[1]);
    }
  }

  parsed.push({ file, pkg, clean });
}

test('the Android tree has Kotlin sources to check', () => {
  // A refactor that moves the tree must not turn this file into a silent no-op.
  assert.ok(files.length > 200, 'expected the full Android tree, found ' + files.length + ' files');
  assert.ok(declared.size > 500, 'declaration scan found only ' + declared.size + ' symbols');
});

test('every imported one.zephyr.mobile.* symbol is declared somewhere in the tree', () => {
  const missing = new Map();

  for (const { file, clean } of parsed) {
    for (const line of clean.split(/\r?\n/)) {
      const match = line.match(/^\s*import\s+([\w.]+)(?:\s+as\s+\w+)?\s*$/);
      if (!match) continue;
      const fqn = match[1];
      if (!fqn.startsWith(PACKAGE_PREFIX)) continue;

      const simple = fqn.slice(fqn.lastIndexOf('.') + 1);
      if (GENERATED.has(simple)) continue;

      /* Accept three shapes:
       *   - the exact fully-qualified name (a top-level declaration),
       *   - a nested member (`Foo.Bar`), whose owner is what must exist,
       *   - an extension function or property, which the simple-name set covers.
       * The point is to catch a name that exists nowhere, not to reimplement resolution. */
      if (declared.has(fqn)) continue;
      const owner = fqn.slice(0, fqn.lastIndexOf('.'));
      if (declared.has(owner)) continue;
      if (declaredSimple.has(simple)) continue;

      const rel = path.relative(MOBILE_ROOT, file);
      if (!missing.has(fqn)) missing.set(fqn, new Set());
      missing.get(fqn).add(rel);
    }
  }

  const report = [...missing.entries()]
    .map(([fqn, where]) => '  ' + fqn + '\n      ' + [...where].join('\n      '))
    .join('\n');
  assert.equal(missing.size, 0, 'imported but never declared:\n' + report);
});

test('the three symbols that blocked the first Android build are declared', () => {
  /* Regression lock, named explicitly. These were referenced by the app module while nothing in
   * the tree declared them, so the very first `assembleDebug` could not have succeeded. */
  assert.ok(
    declared.has('one.zephyr.mobile.app.ZephyrOneRoot'),
    'MainActivity calls ZephyrOneRoot; the root navigation composable must exist',
  );
  assert.ok(
    declared.has('one.zephyr.mobile.app.di.AccountContainer'),
    'AppContainer.bindAccount takes an AccountContainer; the type must exist',
  );
  assert.ok(
    declared.has('one.zephyr.mobile.app.ZephyrOneApplication'),
    'the Application subclass must exist',
  );
});

test('nothing references the misspelled ZephyrApplication', () => {
  /* The class is ZephyrOneApplication. Two files imported and cast to `ZephyrApplication`, which
   * would fail to compile and, being in a Service and a Worker, would not be caught by opening
   * the app. */
  const offenders = [];
  for (const { file, clean } of parsed) {
    if (/\bZephyrApplication\b/.test(clean)) offenders.push(path.relative(MOBILE_ROOT, file));
  }
  assert.deepEqual(offenders, [], 'the class is ZephyrOneApplication');
});

test('MainActivity only calls root symbols that exist', () => {
  /* MainActivity is the entry point, so an unresolved name here is a launch failure rather than a
   * dead code path. Checked by name against the declaration set. */
  const main = parsed.find((entry) => entry.file.endsWith('MainActivity.kt'));
  assert.ok(main, 'MainActivity.kt must exist');

  for (const symbol of ['ZephyrOneRoot', 'ZephyrTheme', 'LockState', 'ZephyrOneApplication']) {
    assert.ok(
      new RegExp('\\b' + symbol + '\\b').test(main.clean),
      'MainActivity is expected to reference ' + symbol,
    );
    assert.ok(declaredSimple.has(symbol), symbol + ' is referenced by MainActivity but not declared');
  }
});
