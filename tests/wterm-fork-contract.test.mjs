import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/* v0.3.0 vendored fork contract: the fork must expose a public viewport API
 * so the terminal controller stops monkey-patching private methods. Verified
 * by static analysis of the built fork source + the integration in terminal.js.
 *
 * The fork is now built from upstream vercel-labs/wterm v0.3.0 sources
 * (wterm/packages/@wterm/dom/src/*.ts) with Zephyr viewport extensions added
 * in wterm.ts. Built by scripts/build-wterm.sh -> public/vendor/wterm-fork/.
 */

const forkDir = path.resolve(import.meta.dirname, '..', 'public', 'vendor', 'wterm-fork');
const wtermSrc = fs.readFileSync(path.join(forkDir, 'wterm.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(forkDir, 'index.js'), 'utf8');
const terminalSrc = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'public', 'terminal.js'), 'utf8');

test('fork exposes a public viewport facade (plain writable property, not getter-only)', () => {
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

test('fork exposes extended viewport API (§3.8.2)', () => {
    for (const m of ['getViewportState', 'onRenderComplete', 'onViewportChange', 'scrollToLine', 'fitToContainer', 'getBufferSnapshot']) {
        assert.ok(new RegExp(`\\b${m}\\(`).test(wtermSrc), `fork must expose ${m}()`);
    }
    assert.ok(/_fireRenderComplete/.test(wtermSrc), 'fork must fire render-complete callbacks');
    assert.ok(/onRenderComplete/.test(wtermSrc), 'fork must expose onRenderComplete registration');
});

test('fork _doRender fires render-complete callbacks', () => {
    // The render-complete callback is the key fix for P0-3 (IME scroll): it
    // lets downstream scroll-follow read the POST-render DOM instead of
    // racing the next animation frame.
    const doRenderIdx = wtermSrc.indexOf('_doRender()');
    assert.ok(doRenderIdx > 0, 'must have _doRender');
    const fireIdx = wtermSrc.indexOf('_fireRenderComplete', doRenderIdx);
    assert.ok(fireIdx > doRenderIdx, '_doRender must call _fireRenderComplete after rendering');
});

test('fork index.js exports WTerm and local core (no bare @wterm/core specifier)', () => {
    // esbuild may rewrite `export { WTerm } from "./wterm.js"` into
    // `import { WTerm } from "./wterm.js"; ... export { WTerm };` - accept both.
    assert.ok(/export\s*\{[^}]*\bWTerm\b/.test(indexSrc), 'must re-export WTerm');
    assert.ok(/from\s*["']\.\/wterm\.js["']/.test(indexSrc), 'must reference ./wterm.js');
    assert.ok(!/from\s*["']@wterm\/core["']/.test(indexSrc), 'must not use bare @wterm/core specifier');
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
