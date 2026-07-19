import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/* Stage 5/6 contract (FREEZE plan §3.8, §5): the vendored @wterm/dom fork
 * must expose a public viewport API so the terminal controller stops
 * monkey-patching private methods. Verified by static analysis of the fork
 * source + the bridge in terminal.js. */

const forkDir = path.resolve(import.meta.dirname, '..', 'public', 'vendor', 'wterm-fork');
const wtermSrc = fs.readFileSync(path.join(forkDir, 'wterm.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(forkDir, 'index.js'), 'utf8');
const terminalSrc = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'public', 'terminal.js'), 'utf8');

test('fork exposes a public viewport API (writable property, not getter-only)', () => {
    // viewport must be mounted as a plain writable property in the constructor
    // (NOT a getter) so patchWTermScrollBehavior can replace it without
    // tripping "has only a getter".
    assert.ok(/this\.viewport\s*=/.test(wtermSrc), 'fork must set this.viewport in constructor');
    assert.ok(/_buildViewportFacade/.test(wtermSrc), 'fork must build the viewport facade');
    assert.ok(!/get viewport\(\)/.test(wtermSrc), 'fork must NOT use get viewport() (causes getter-only crash)');
    assert.ok(/atBottom/.test(wtermSrc), 'viewport must expose atBottom');
    assert.ok(/follow\(\)/.test(wtermSrc), 'viewport must expose follow()');
    assert.ok(/lock\(\)/.test(wtermSrc), 'viewport must expose lock()');
});

test('fork exposes public isAtBottom/scrollToBottom/followBottom/lockBottom aliases', () => {
    for (const m of ['isAtBottom', 'scrollToBottom', 'followBottom', 'lockBottom']) {
        assert.ok(new RegExp(`\\b${m}\\(`).test(wtermSrc), `fork must expose ${m}()`);
    }
});

test('fork index.js exports WTerm and local core (no bare @wterm/core specifier)', () => {
    assert.ok(/export \{ WTerm \} from "\.\/wterm\.js"/.test(indexSrc), 'must re-export WTerm');
    assert.ok(!/from "@wterm\/core"/.test(indexSrc), 'must not use bare @wterm/core specifier');
    assert.ok(/\.\/core\/index\.js/.test(indexSrc), 'must re-export local core');
});

test('terminal.js prefers the fork, falls back to stock package', () => {
    const idx = terminalSrc.indexOf('/vendor/wterm-fork/index.js');
    assert.ok(idx > 0, 'terminal.js must try the fork first');
    // Fork must appear before the stock package in the loader
    const stockIdx = terminalSrc.indexOf('/vendor/@wterm/dom/dist/index.js');
    assert.ok(stockIdx > 0, 'terminal.js must still reference the stock package as fallback');
    assert.ok(idx < stockIdx, 'fork must be attempted before the stock package');
});

test('terminal.js fork path does not monkey-patch private methods', () => {
    // The fork path in patchWTermScrollBehavior must not overwrite
    // _scrollToBottom / _isScrolledToBottom / _doRender on the fork instance.
    const forkPathStart = terminalSrc.indexOf("term.viewport && typeof term.viewport.follow === 'function'");
    assert.ok(forkPathStart > 0, 'fork path must exist in patchWTermScrollBehavior');
    const forkPathEnd = terminalSrc.indexOf('// Legacy path:', forkPathStart);
    assert.ok(forkPathEnd > forkPathStart, 'fork path must precede the legacy path');
    const forkPathBody = terminalSrc.slice(forkPathStart, forkPathEnd);
    assert.ok(!/term\._scrollToBottom\s*=/.test(forkPathBody), 'fork path must not overwrite _scrollToBottom');
    assert.ok(!/term\._isScrolledToBottom\s*=/.test(forkPathBody), 'fork path must not overwrite _isScrolledToBottom');
    assert.ok(!/term\._doRender\s*=/.test(forkPathBody), 'fork path must not overwrite _doRender');
});
