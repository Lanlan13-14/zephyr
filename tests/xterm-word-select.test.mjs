/**
 * Mirrors public/terminal.js getSmartTerminalSelectionBounds /
 * XTERM_WORD_SEPARATORS (xterm OptionsService default).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const terminalJs = readFileSync(join(__dirname, '../public/terminal.js'), 'utf8');

// Exact xterm default: ' ()[]{}\',"`'
const XTERM_WORD_SEPARATORS = " ()[]{}',\"" + '`';

function isXtermWordSeparatorChar(ch = '') {
  if (!ch) return true;
  return XTERM_WORD_SEPARATORS.indexOf(ch) >= 0;
}

function getSmartTerminalSelectionBounds(text = '', offset = 0) {
  const value = String(text || '');
  if (!value) return null;
  const clamp = (n) => Math.max(0, Math.min(value.length, n));
  let pos = clamp(offset);
  if (pos >= value.length && value.length) pos = value.length - 1;
  if (isXtermWordSeparatorChar(value[pos]) && pos > 0 && !isXtermWordSeparatorChar(value[pos - 1])) {
    pos -= 1;
  }
  let start = pos;
  let end = pos;
  if (value[pos] === ' ') {
    while (start > 0 && value[start - 1] === ' ') start -= 1;
    while (end + 1 < value.length && value[end + 1] === ' ') end += 1;
    end += 1;
  } else {
    while (start > 0 && !isXtermWordSeparatorChar(value[start - 1])) start -= 1;
    while (end + 1 < value.length && !isXtermWordSeparatorChar(value[end + 1])) end += 1;
    end += 1;
  }
  if (end <= start) return null;
  return { start, end };
}

describe('xterm word select (DOM)', () => {
  it('terminal.js embeds xterm word select + kb viewport-only policy', () => {
    assert.match(terminalJs, /XTERM_WORD_SEPARATORS/);
    assert.match(terminalJs, /handleTerminalDesktopDblClick/);
    assert.match(terminalJs, /ssh-kb-viewport-only/);
    assert.match(terminalJs, /blocked-kb-row-shrink/);
    assert.equal(terminalJs.includes('const hardFit = (label)'), false);
    assert.equal(terminalJs.includes('Ops.file_edit'), false);
  });

  it('selects path token as one unit (slash is not a separator)', () => {
    const line = 'cd /usr/local/bin && ls';
    const idx = line.indexOf('local');
    const b = getSmartTerminalSelectionBounds(line, idx);
    assert.equal(line.slice(b.start, b.end), '/usr/local/bin');
  });

  it('stops at parentheses and commas like xterm', () => {
    const line = 'fn(arg1,arg2)';
    const b = getSmartTerminalSelectionBounds(line, line.indexOf('arg1'));
    // comma is a wordSeparator → only arg1
    assert.equal(line.slice(b.start, b.end), 'arg1');
    const b2 = getSmartTerminalSelectionBounds(line, line.indexOf('arg2'));
    assert.equal(line.slice(b2.start, b2.end), 'arg2');
  });

  it('selects space run', () => {
    const line = 'a   b';
    const b = getSmartTerminalSelectionBounds(line, 2);
    assert.equal(line.slice(b.start, b.end), '   ');
  });

  it('selects simple word', () => {
    const line = 'hello world';
    const b = getSmartTerminalSelectionBounds(line, 1);
    assert.equal(line.slice(b.start, b.end), 'hello');
  });
});
