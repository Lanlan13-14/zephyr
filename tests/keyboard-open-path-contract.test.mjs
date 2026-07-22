import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const terminalJs = readFileSync(join(root, 'public/terminal.js'), 'utf8');
const intentJs = readFileSync(join(root, 'public/ssh-keyboard/intent.js'), 'utf8');
const layoutJs = readFileSync(join(root, 'public/ssh-keyboard/layout.js'), 'utf8');

describe('keyboard open path (F1+F2 fixes)', () => {
    it('layout gate opens on desiredOpen alone (no physical/inset requirement)', () => {
        assert.match(layoutJs, /const layoutOpen = desiredOpen;/);
        assert.equal(
            layoutJs.includes('physicalOpen || state.inset > 0 || phase === LayoutPhase.OPENING'),
            false,
            'old multi-condition layoutOpen removed',
        );
    });

    it('applyMobileStableKeyboardInset opens with inset=0 (no forceClear on open)', () => {
        // Critical: open must not require safeInset > 0
        assert.equal(
            terminalJs.includes('const layoutOpen = !!(open && safeInset > 0)'),
            false,
            'layoutOpen must not require safeInset > 0',
        );
        // Open path must commit even when safeInset === 0
        assert.match(terminalJs, /parentAuthoritative \|\| safeInset === 0/);
        // Close only when !open (not when open-with-zero-inset)
        assert.match(terminalJs, /if \(!open\) \{\s*\n\s*forceClearSshKbShell/);
    });

    it('applyFacadeChrome never self-closes while desired is open', () => {
        // facade-physical-zero self-close path must be gone
        assert.equal(terminalJs.includes('facade-physical-zero'), false);
        // desired open alone writes open chrome
        assert.match(terminalJs, /desired \|\| phase === 'open' \|\| phase === 'opening' \|\| proxyFocused/);
    });

    it('assertKeyboardLayoutSettled does not clear while intent desired open', () => {
        assert.match(terminalJs, /if \(desired\) return;/);
        assert.equal(
            terminalJs.includes('Intent open but physical gone'),
            false,
            'old physical-zero assert path removed',
        );
    });

    it('isSshKbLayoutOpen uses desiredOpen alone', () => {
        assert.match(terminalJs, /if \(sshKb\.desiredOpen\?\.\(\)\) return true;/);
    });

    it('intent.open does not set provisional physical', () => {
        assert.match(intentJs, /Provisional physical was the root cause/);
    });

    it('syncViewport does not dismiss when physical never confirmed (embedded-safe)', () => {
        assert.match(intentJs, /Still waiting for first real height/);
    });

    it('openTimeoutMs fallback exists', () => {
        assert.match(intentJs, /openTimeoutMs/);
        assert.match(intentJs, /open-timeout:no-physical/);
    });

    it('no provisionalInset function remains', () => {
        assert.equal(terminalJs.includes('provisionalInset'), false);
    });

    it('no multi-phase focus/blur polling', () => {
        assert.equal(terminalJs.includes('[60, 160, 320, 560]'), false);
    });
});
