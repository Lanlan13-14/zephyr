/**
 * Soft-wrapped terminal URLs must produce one full href across rows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const rendererSrc = fs.readFileSync(join(ROOT, 'public/vendor/wterm-fork/renderer.js'), 'utf8');
const rendererTs = fs.readFileSync(join(ROOT, 'wterm/packages/@wterm/dom/src/renderer.ts'), 'utf8');

test('source: cross-row linkifyViewport exists and is used in render', () => {
  assert.match(rendererSrc, /function linkifyViewport/);
  assert.match(rendererSrc, /function resolveWrappedUrl/);
  assert.match(rendererSrc, /function unwrapAutoLinks/);
  assert.match(rendererSrc, /linkifyViewport\(this\.rowEls\)/);
  assert.match(rendererTs, /export function linkifyViewport/);
  assert.match(rendererTs, /export function resolveWrappedUrl/);
  assert.match(rendererTs, /linkifyViewport\(this\.rowEls\)/);
  const terminalJs = fs.readFileSync(join(ROOT, 'public/terminal.js'), 'utf8');
  const telnetJs = fs.readFileSync(join(ROOT, 'public/telnet-terminal.js'), 'utf8');
  const wtermJs = fs.readFileSync(join(ROOT, 'public/vendor/wterm-fork/wterm.js'), 'utf8');
  assert.match(terminalJs, /wterm-fork\/index\.js\?v=20260726-url-wrap1/);
  assert.match(telnetJs, /wterm-fork\/index\.js\?v=20260726-url-wrap1/);
  assert.match(wtermJs, /renderer\.js\?v=20260726-url-wrap1/);
  // Per-row linkify after paint is removed (viewport path owns auto-links).
  assert.equal(
    /rowEl\.innerHTML = html;\s*linkifyRow\(rowEl\)/.test(rendererSrc),
    false,
  );
});

test('resolveWrappedUrl joins soft-wrapped path', async () => {
  // Mirror production continuation rules (keep in sync with renderer.js).
  const URL_CONT_RE = /^[A-Za-z0-9/._~%&=+\-?#]+/;
  const URL_LOOKS_COMPLETE_RE = /(?:\/|[.](?:html?|php|aspx?|jsp|json|xml|pdf|png|jpe?g|gif|webp|svg|css|js|mjs|ts|md|txt|zip|tar|gz|tgz|bz2|xz|7z|rar|mp[34]|wav|avi|mov|webm|ico|woff2?|ttf|eot|csv|tsv|yaml|yml|toml|ini|cfg|log|sh|py|go|rs|java|c|cpp|h|rb|pl|lua))(?:[?#][^\s]*)?$/i;
  function trimUrlTrailingPunct(url) {
    return String(url || '').replace(/[.,;:!?)}\]]+$/g, '');
  }
  function isShellPromptLine(text = '') {
    const s = String(text || '').trimStart();
    if (!s) return false;
    if (/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:/.test(s)) return true;
    if (/^[#$%❯➜]\s?/.test(s)) return true;
    if (/^~?[\/\w.-]*[%#]\s*$/.test(s)) return true;
    return false;
  }
  function isUrlSoftWrapContinuation(urlSoFar, nextLine) {
    const next = String(nextLine || '');
    if (!next) return false;
    if (/^https?:\/\//i.test(next.trimStart())) return false;
    if (isShellPromptLine(next)) return false;
    if (/^\s/.test(next)) return false;
    if (!URL_CONT_RE.test(next)) return false;
    if (URL_LOOKS_COMPLETE_RE.test(urlSoFar)) return /^[/?#&]/.test(next);
    if (/^[A-Za-z0-9_.-]+@/.test(next)) return false;
    return true;
  }
  function resolveWrappedUrl(texts, startRow, startIdx, matchLen) {
    const n = texts.length;
    let url = String(texts[startRow] || '').slice(startIdx, startIdx + matchLen);
    const segments = [{ row: startRow, start: startIdx, end: startIdx + matchLen }];
    let r = startRow;
    let end = startIdx + matchLen;
    while (r < n) {
      const t = String(texts[r] || '');
      const trailing = t.slice(end);
      if (trailing && /\S/.test(trailing)) break;
      if (r + 1 >= n) break;
      const next = String(texts[r + 1] || '');
      if (!isUrlSoftWrapContinuation(url, next)) break;
      const m = next.match(URL_CONT_RE);
      if (!m) break;
      let piece = trimUrlTrailingPunct(m[0]);
      if (!piece) break;
      url += piece;
      r += 1;
      end = piece.length;
      segments.push({ row: r, start: 0, end: piece.length });
      if (next.length > piece.length && /\S/.test(next.slice(piece.length))) break;
    }
    url = trimUrlTrailingPunct(url);
    return { url, segments };
  }

  // Soft wrap of a long GitHub URL across 2 rows (typical 80-col terminal).
  const row0 = 'see https://github.com/Lanlan13-14/zephyr-ssh/blob/main/public/vendor/wterm-fork/re';
  const row1 = 'nderer.js for details';
  // match on row0 from https to end of line
  const start = row0.indexOf('https://');
  const matchLen = row0.length - start;
  const { url, segments } = resolveWrappedUrl([row0, row1], 0, start, matchLen);
  assert.equal(
    url,
    'https://github.com/Lanlan13-14/zephyr-ssh/blob/main/public/vendor/wterm-fork/renderer.js',
  );
  assert.equal(segments.length, 2);
  assert.equal(segments[0].row, 0);
  assert.equal(segments[1].row, 1);
  assert.equal(segments[1].start, 0);

  // Single-line still works
  const one = 'https://example.com/a';
  const r2 = resolveWrappedUrl([one], 0, 0, one.length);
  assert.equal(r2.url, 'https://example.com/a');
  assert.equal(r2.segments.length, 1);

  // Next row starting with new URL is NOT a continuation
  const r3 = resolveWrappedUrl(
    ['https://a.example/longpathpart1', 'https://b.example/other'],
    0,
    0,
    'https://a.example/longpathpart1'.length,
  );
  assert.equal(r3.url, 'https://a.example/longpathpart1');
  assert.equal(r3.segments.length, 1);

  // Next row is shell prompt — must NOT glue onto .html URL (nxtrace case)
  const nx = 'https://assets.nxtrace.org/tracemap/5d798059-2f72-501a-8a96-b3701acc9784.html';
  const r4 = resolveWrappedUrl([nx, 'root@zephyr-ssh:~#'], 0, 0, nx.length);
  assert.equal(r4.url, nx);
  assert.equal(r4.segments.length, 1, 'prompt line must not become a link segment');

  // user@host alone also blocked
  const r5 = resolveWrappedUrl(
    ['https://example.com/path/that/wraps/midwo', 'user@host:~$'],
    0,
    0,
    'https://example.com/path/that/wraps/midwo'.length,
  );
  assert.equal(r5.segments.length, 1);
});

test('nxtrace UUID split after first group resolves to the complete href', async () => {
  const mod = await import(pathToFileURL(join(ROOT, 'public/vendor/wterm-fork/renderer.js')).href);
  assert.equal(typeof mod.resolveWrappedUrl, 'function');
  const first = 'https://assets.nxtrace.org/tracemap/3989ab80';
  const second = '-92d1-5734-a765-1b6121eea9b3.html';
  const resolved = mod.resolveWrappedUrl([first, second], 0, 0, first.length);
  assert.equal(resolved.url, `${first}${second}`);
  assert.deepEqual(resolved.segments, [
    { row: 0, start: 0, end: first.length },
    { row: 1, start: 0, end: second.length },
  ]);
});

test('module exports viewport and wrapped URL helpers', async () => {
  const mod = await import(pathToFileURL(join(ROOT, 'public/vendor/wterm-fork/renderer.js')).href);
  assert.equal(typeof mod.linkifyViewport, 'function');
  assert.equal(typeof mod.linkifyRow, 'function');
  assert.equal(typeof mod.resolveWrappedUrl, 'function');
});
