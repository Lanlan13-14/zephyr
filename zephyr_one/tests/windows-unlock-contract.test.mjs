import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
const authJs = read('zephyr_one/electron/auth.mjs');
const helloPs1 = read('zephyr_one/electron/windows-hello.ps1');

test('Windows unlock calls the official desktop CredentialPicker', () => {
    assert.match(authJs, /powershell\.exe/);
    assert.match(authJs, /windows-hello\.ps1/);
    assert.match(authJs, /'-STA'/);
    /* The consent-only verifier is not the Windows Security dialog. Microsoft
     * documents the options-object overload as UWP-only, so the desktop call
     * is the three-parameter PickAsync. */
    assert.match(helloPs1, /Windows\.Security\.Credentials\.UI\.CredentialPicker/);
    assert.match(helloPs1, /CredentialPicker\]::PickAsync\(\s*'Zephyr One',\s*\$reason,\s*'Zephyr One'\s*\)/);
    assert.doesNotMatch(helloPs1, /UserConsentVerifier/);
    assert.doesNotMatch(helloPs1, /RequestVerificationAsync/);
});

test('success is reachable only through a Verified verdict', () => {
    assert.match(authJs, /method: 'windows_credential_picker'/);
    assert.match(authJs, /code === 0/);
    assert.match(helloPs1, /Write-Output 'Verified'/);
    /* The dialog verifies the credential; the secret must not reach stdout. */
    assert.doesNotMatch(helloPs1, /Write-Output \$result\.Credential/);
});

test('Windows capabilities are reported as available with biometry', () => {
    assert.match(authJs, /Windows 安全性凭据对话框/);
    const winAt = authJs.indexOf("process.platform === 'win32'");
    assert.ok(winAt > 0);
    const block = authJs.slice(winAt, winAt + 500);
    assert.match(block, /available: true/);
    assert.match(block, /biometry: true/);
});
