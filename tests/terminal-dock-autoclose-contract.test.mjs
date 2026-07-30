import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appJs = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const appHtml = readFileSync(path.join(root, 'public/app.html'), 'utf8');

function extractFn(src, name) {
    const re = new RegExp(`function ${name}\\s*\\(`);
    const m = re.exec(src);
    assert.ok(m, `${name} missing`);
    const brace = src.indexOf('{', m.index);
    let depth = 0;
    for (let j = brace; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') {
            depth--;
            if (depth === 0) return src.slice(m.index, j + 1);
        }
    }
    throw new Error(`failed to extract ${name}`);
}

test('smartbar auto-close is 10s and pauses while pointer is inside dock', () => {
    assert.match(appJs, /const TERMINAL_SMARTBAR_AUTO_CLOSE_MS = 10000/);
    const schedule = extractFn(appJs, 'scheduleTerminalSmartbarAutoClose');
    assert.match(schedule, /TERMINAL_SMARTBAR_AUTO_CLOSE_MS|delay = TERMINAL_SMARTBAR_AUTO_CLOSE_MS/);
    assert.match(schedule, /terminalSmartbarPointerInside/);
    assert.match(schedule, /if \(terminalSmartbarPointerInside\) return/);
    assert.doesNotMatch(schedule, /delay = 5000/);
});

test('sessionTabs pointerleave starts 10s close; pointer inside clears timer', () => {
    assert.match(appJs, /noteTerminalSmartbarPointerInside\(false\)[\s\S]{0,120}?scheduleTerminalSmartbarAutoClose\(TERMINAL_SMARTBAR_AUTO_CLOSE_MS\)/);
    assert.match(appJs, /noteTerminalSmartbarPointerInside\(true\)[\s\S]{0,80}?clearTimeout\(terminalSmartbarTimer\)/);
    assert.match(appJs, /isTerminalSmartbarInteractionTarget/);
    assert.match(appHtml, /app\.js\?v=\d{8}-[a-z0-9-]+/);
});
