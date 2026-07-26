import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('password email verification row gives input three quarters and button one quarter', () => {
    const html = read('public/app.html');
    const css = read('public/style.css');

    assert.match(
        html,
        /id="settingsEmailCodeRow"[\s\S]*?<div class="form-row-inline verification-code-row">[\s\S]*?id="settingsEmailCode"[\s\S]*?id="settingsSendCodeBtn"/,
    );
    assert.match(
        css,
        /\.verification-code-row\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*minmax\(0,\s*3fr\)\s+minmax\(0,\s*1fr\);[\s\S]*?\}/,
    );
    assert.match(
        css,
        /\.verification-code-row input,\s*\n\.verification-code-row \.btn-sm\s*\{[\s\S]*?width:\s*100%;[\s\S]*?min-width:\s*0;/,
    );
});
