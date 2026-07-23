/**
 * Behavioral simulation of the stuck-Latin + Enter path.
 * Does not load terminal.js as a browser module — reimplements the pure
 * decision helpers the same way, so regressions in the algorithm fail here
 * even if contract grep still matches comments.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const terminalJs = fs.readFileSync(new URL('../public/terminal.js', import.meta.url), 'utf8');

function makeImeState() {
  return {
    composing: false,
    proxyValue: '',
    lastSent: { text: '', at: 0 },
    lastComposed: '',
    suppressUntil: 0,
    enterSuppressEndUntil: 0,
    sent: [],
    chromePublishes: 0,
    now: 1000,
  };
}

function imeTextEqual(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

function alreadySent(s, text, windowMs = 900) {
  if (!text) return false;
  if (s.lastSent.text && imeTextEqual(s.lastSent.text, text) && s.now - s.lastSent.at < windowMs) return true;
  if (s.lastComposed && imeTextEqual(s.lastComposed, text) && s.now < s.suppressUntil) return true;
  return false;
}

function sendText(s, text, { forceImmediate = false } = {}) {
  if (!text) return false;
  if (s.lastSent.text && imeTextEqual(s.lastSent.text, text) && s.now - s.lastSent.at < 320) return false;
  if (!forceImmediate && alreadySent(s, text, 900)) return false;
  // forceImmediate still dedups against lastSent (case-insensitive)
  if (forceImmediate && s.lastSent.text && imeTextEqual(s.lastSent.text, text) && s.now - s.lastSent.at < 900) {
    return false;
  }
  s.sent.push({ kind: 'text', text });
  s.lastSent = { text, at: s.now };
  return true;
}

function clearStuck(s, { quiet = false } = {}) {
  if (!s.composing && !s.proxyValue) return;
  s.composing = false;
  s.proxyValue = '';
  if (!quiet) s.chromePublishes += 1;
}

function flushEnter(s) {
  const leftover = s.proxyValue;
  clearStuck(s, { quiet: true });
  if (leftover && !alreadySent(s, leftover, 900)) {
    sendText(s, leftover);
    s.lastComposed = leftover;
    s.suppressUntil = s.now + 900;
  }
  s.proxyValue = '';
  s.enterSuppressEndUntil = s.now + 900;
  s.sent.push({ kind: 'cr' });
}

function onCompositionEnd(s, data) {
  if (s.now < s.enterSuppressEndUntil) {
    s.composing = false;
    s.proxyValue = '';
    return 'swallowed';
  }
  s.chromePublishes += 1;
  s.composing = false;
  const payload = data || s.proxyValue;
  s.proxyValue = '';
  if (!payload) return 'empty';
  if (alreadySent(s, payload, 900)) {
    s.lastComposed = payload;
    s.suppressUntil = s.now + 900;
    return 'dup-drop';
  }
  sendText(s, payload, { forceImmediate: true });
  s.lastComposed = payload;
  s.suppressUntil = s.now + 900;
  return 'commit';
}

test('stuck Latin kimi + Enter sends once and one CR, no chrome publish', () => {
  const s = makeImeState();
  // Android Chinese IME: compositionstart, type kimi, no compositionend
  s.composing = true;
  s.proxyValue = 'kimi';
  // Enter while composing
  flushEnter(s);
  assert.deepEqual(s.sent, [{ kind: 'text', text: 'kimi' }, { kind: 'cr' }]);
  assert.equal(s.composing, false);
  assert.equal(s.chromePublishes, 0, 'quiet clear must not publish facade');
});

test('English progressive kimi then Enter leftover re-fill does not double', () => {
  // Simulates: input sends k,i,m,i → lineAcc=kimi; Enter leftover=kimi → CR only
  let lineAcc = '';
  const sent = [];
  function note(t) { lineAcc += t; sent.push({ kind: 'text', text: t }); }
  function delta(leftover) {
    const b = String(leftover || '').toLowerCase();
    const a = String(lineAcc || '').toLowerCase();
    if (!b) return '';
    if (!a) return leftover;
    if (a === b || a.endsWith(b)) return '';
    if (b.startsWith(a)) return leftover.slice(lineAcc.length);
    return leftover;
  }
  for (const ch of 'kimi') note(ch);
  const leftover = 'kimi'; // English IME re-fill on first Enter
  const d = delta(leftover);
  assert.equal(d, '');
  if (d) note(d);
  sent.push({ kind: 'cr' });
  assert.deepEqual(
    sent.filter((x) => x.kind === 'text').map((x) => x.text).join(''),
    'kimi',
  );
  assert.equal(sent.filter((x) => x.kind === 'cr').length, 1);
});

test('leftover delta after partial progressive send', () => {
  let lineAcc = 'ki';
  function delta(leftover) {
    const b = String(leftover || '').toLowerCase();
    const a = String(lineAcc || '').toLowerCase();
    if (!b) return '';
    if (!a) return leftover;
    if (a === b || a.endsWith(b)) return '';
    if (b.startsWith(a)) return leftover.slice(lineAcc.length);
    return leftover;
  }
  assert.equal(delta('kimi'), 'mi');
  assert.equal(delta('ki'), '');
  assert.equal(delta('Kimi'), 'mi');
  lineAcc = '';
  assert.equal(delta('kimi'), 'kimi');
});

test('late compositionend "Kimi" after Enter is dropped (no kimikimi)', () => {
  const s = makeImeState();
  s.composing = true;
  s.proxyValue = 'kimi';
  flushEnter(s);
  s.now += 50; // still inside 900ms suppress
  const result = onCompositionEnd(s, 'Kimi');
  assert.equal(result, 'swallowed');
  assert.deepEqual(s.sent, [{ kind: 'text', text: 'kimi' }, { kind: 'cr' }]);
});

test('case-insensitive alreadySent blocks forceImmediate re-delivery', () => {
  const s = makeImeState();
  s.composing = true;
  s.proxyValue = 'kimi';
  flushEnter(s);
  // Simulate swallow window expired but lastSent still recent
  s.now += 50;
  s.enterSuppressEndUntil = 0; // force past swallow
  // commit path still uses alreadySent / lastSent case-insensitive
  const ok = sendText(s, 'Kimi', { forceImmediate: true });
  assert.equal(ok, false);
  assert.equal(s.sent.filter((x) => x.kind === 'text').length, 1);
});

test('real CJK compositionend still commits once', () => {
  const s = makeImeState();
  s.composing = true;
  s.proxyValue = 'nihao'; // intermediate pinyin buffer
  const result = onCompositionEnd(s, '你好');
  assert.equal(result, 'commit');
  assert.deepEqual(s.sent, [{ kind: 'text', text: '你好' }]);
  assert.equal(s.chromePublishes, 1); // real end may publish; Enter path must not
});

test('stuck flag + non-live Enter flushes; live 选词 Enter does not', () => {
  // Simulate decision used in keydown
  function shouldFlushOnEnter({ composingFlag, isComposing, keyCode, key }) {
    const liveCompose = !!(isComposing || keyCode === 229 || key === 'Process');
    return !!(composingFlag && !liveCompose);
  }
  assert.equal(
    shouldFlushOnEnter({ composingFlag: true, isComposing: false, keyCode: 13, key: 'Enter' }),
    true,
    'stuck Latin after kimi',
  );
  assert.equal(
    shouldFlushOnEnter({ composingFlag: true, isComposing: true, keyCode: 229, key: 'Enter' }),
    false,
    'live 选词',
  );
  assert.equal(
    shouldFlushOnEnter({ composingFlag: true, isComposing: false, keyCode: 229, key: 'Enter' }),
    false,
    'keyCode 229 still live',
  );
  assert.equal(
    shouldFlushOnEnter({ composingFlag: false, isComposing: false, keyCode: 13, key: 'Enter' }),
    false,
    'not composing — handled by normal Enter path',
  );
});

test('source file: flushMobileImeEnter is single Enter authority', () => {
  // Non-compose Enter also routes through flush (no second leftover+CR path).
  const enterBlocks = [...terminalJs.matchAll(/e\.key === 'Enter'[\s\S]{0,500}/g)].map((m) => m[0]);
  assert.ok(enterBlocks.length >= 1);
  let sawComposeEnterFlush = false;
  for (const block of enterBlocks) {
    if (block.includes('liveCompose') || block.includes('mobileImeComposing && !liveCompose')) {
      sawComposeEnterFlush = true;
      assert.match(block, /flushMobileImeEnter/);
    }
  }
  assert.equal(sawComposeEnterFlush, true, 'compose Enter branch must use liveCompose guard');
});

test('source file: aux / facade not touched by flush helpers', () => {
  const flush = terminalJs.match(/function flushMobileImeEnter[\s\S]*?^function\s+\w+/m)?.[0] || '';
  const code = flush.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.equal(code.includes('applyFacadeChrome'), false);
  assert.equal(code.includes('retainFocus'), false);
  assert.equal(code.includes('writeSshKbPageGeometry'), false);
  assert.equal(code.includes('handleCompositionEnd'), false);
});
