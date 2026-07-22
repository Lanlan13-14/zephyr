import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const terminalJs = readFileSync(join(root, 'public/terminal.js'), 'utf8');
const wtermJs = readFileSync(join(root, 'public/vendor/wterm-fork/wterm.js'), 'utf8');
const rendererJs = readFileSync(join(root, 'public/vendor/wterm-fork/renderer.js'), 'utf8');

describe('mobile direct input (no local draft)', () => {
  it('no draft state variables or functions remain in terminal.js', () => {
    assert.equal(terminalJs.includes('mobileLocalDraft'), false, 'mobileLocalDraft var removed');
    assert.equal(terminalJs.includes('mobileLocalDraftComposing'), false, 'composing var removed');
    assert.equal(terminalJs.includes('paintMobileLocalDraft'), false, 'paint fn removed');
    assert.equal(terminalJs.includes('appendMobileLocalDraft'), false, 'append fn removed');
    assert.equal(terminalJs.includes('backspaceMobileLocalDraft'), false, 'backspace fn removed');
    assert.equal(terminalJs.includes('flushMobileLocalDraft'), false, 'flush fn removed');
    assert.equal(terminalJs.includes('setLocalDraft'), false, 'setLocalDraft call removed');
  });

  it('wterm renderer has no draft overlay code', () => {
    assert.equal(rendererJs.includes('_localDraft'), false, '_localDraft field removed');
    assert.equal(rendererJs.includes('_buildDraftOverlay'), false, '_buildDraftOverlay removed');
    assert.equal(rendererJs.includes('setLocalDraft'), false, 'setLocalDraft method removed');
    assert.equal(wtermJs.includes('setLocalDraft'), false, 'wterm.js setLocalDraft removed');
  });

  it('sendMobileStableImeText passes printable directly to sendData (no draft interception)', () => {
    // The draft interception branch ("Mobile default: ALL printable") must be gone.
    assert.equal(terminalJs.includes('paste-draft'), false, 'paste-draft branch removed');
    assert.equal(terminalJs.includes('appendMobileLocalDraft'), false, 'no append call');
    // sendData call for printable text must exist in sendMobileStableImeText.
    assert.match(terminalJs, /sendData\(paste \? prepareTerminalPastePayload/);
  });

  it('sendMobileStableControl sends controls directly (no draft pre-flush)', () => {
    // Draft-era pre-control flush is gone; compose stuck-clear is fine.
    assert.equal(terminalJs.includes('flushMobileLocalDraft'), false, 'draft flush removed');
    assert.equal(terminalJs.includes('mobileLocalDraft'), false, 'draft state removed');
    // Enter still triggers scroll-to-bottom.
    assert.match(terminalJs, /bridge\.scrollToBottom/);
  });

  it('compositionend commits directly to PTY (not draft)', () => {
    // compositionend uses single-commit helper → sendMobileStableImeText.
    assert.match(terminalJs, /commitComposedImeText\(text, 'mobile-ime-composition'\)/);
    assert.equal(terminalJs.includes('appendMobileLocalDraft'), false);
  });

  it('sendData wterm-onData no longer routes through draft', () => {
    // The wterm-onData draft routing block should be gone.
    assert.equal(terminalJs.includes('wterm-onData:draft'), false);
    assert.equal(terminalJs.includes('wterm-onData:enter'), false);
    assert.equal(terminalJs.includes('wterm-onData:bs'), false);
  });

  it('xterm viewport scroll model still intact', () => {
    assert.match(wtermJs, /_wheelAccum/);
    assert.match(terminalJs, /virtualViewport/);
    assert.match(terminalJs, /bridge\.scrollLines/);
  });
});
