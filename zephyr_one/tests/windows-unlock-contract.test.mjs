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
    /* Three-parameter overload with non-empty caption+message (Chromium
     * CREDUI_INFO parity): caption is always set, message never empty. */
    assert.match(helloPs1, /PickAsync\(\s*\$targetName,\s*\$reason,\s*\$caption\s*\)/);
    assert.match(helloPs1, /\$caption = 'Zephyr One'/);
    assert.doesNotMatch(helloPs1, /UserConsentVerifier/);
    assert.doesNotMatch(helloPs1, /RequestVerificationAsync/);
});

test('the prompt carries Chromium modal-parent and retry-relay parameters', () => {
    /* Chromium cui.hwndParent + dwAuthError: the shell passes its window
     * handle and the previous attempt's error code into the dialog. */
    assert.match(helloPs1, /\[Parameter\(Mandatory = \$false\)\]\s*\[int\]\$ParentHwnd/);
    assert.match(helloPs1, /\[Parameter\(Mandatory = \$false\)\]\s*\[int\]\$PriorAuthError/);
    const mainJs = read('zephyr_one/electron/main.mjs');
    assert.match(mainJs, /getNativeWindowHandle/);
    assert.match(mainJs, /unlockWindows\(unlockReason\(payload\), \{ parentHwnd \}\)/);
    assert.match(authJs, /WINDOWS_UNLOCK_MAX_ATTEMPTS = 3/);
    assert.match(authJs, /priorAuthErrorFor/);
});

test('blank-password machines report NotAvailable instead of 0x80070490', () => {
    /* Chromium DeviceAuthenticationPresent parity: no gate configured means
     * honest exit 2, so the settings switch refuses to arm instead of
     * raising a provider-less dialog (the shipped screenshot failure). */
    assert.match(helloPs1, /DeviceAuthenticationPresent/);
    assert.match(helloPs1, /Write-Output 'NotAvailable'/);
    assert.match(helloPs1, /0x80070490/);
    assert.match(authJs, /NotAvailable/);
    assert.match(authJs, /尚未设置系统解锁/);
});

test('the credential buffer is verified and wiped, never printed', () => {
    /* Chromium CredentialBufferValidator + SecureZeroMemory parity: the
     * current-user SID is pinned before prompting, the packed secret is
     * checked non-empty and zeroed in a finally block before success. */
    assert.match(helloPs1, /GetCurrent\(\)\.User\.Value/);
    assert.match(helloPs1, /SecureZeroMemory/);
    assert.match(helloPs1, /ZeroBuffer\(\$buffer\)/);
    assert.match(helloPs1, /ZeroFreeGlobalAllocUnicode/);
    assert.doesNotMatch(helloPs1, /Write-Output \$password/);
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
