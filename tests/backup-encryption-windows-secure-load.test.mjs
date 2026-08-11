import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import backupModule from '../backup-encryption.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function removeTree(directory) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

test('Windows reads exact env bytes from service-owned private paths', {
    skip: process.platform !== 'win32',
}, () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-backup-secure-read-'));
    const envFile = path.join(dataDir, '.env');
    const expected = 'ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\r\n'
        + 'PUBLIC_ORIGIN=http://localhost:3000\r\n';
    try {
        fs.writeFileSync(envFile, expected);
        const loaded = backupModule.provisionDataEnv({ dataDir, env: {}, readContents: true });
        assert.equal(loaded.envFile, envFile);
        assert.equal(loaded.contents, expected);

        const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
        const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const script = String.raw`
$sidType = [Security.Principal.SecurityIdentifier]
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$directoryAcl = [IO.Directory]::GetAccessControl($env:ZEPHYR_TEST_DATA_DIR)
$fileAcl = [IO.File]::GetAccessControl($env:ZEPHYR_TEST_ENV_FILE)
[ordered]@{
    current = $current
    directoryOwner = $directoryAcl.GetOwner($sidType).Value
    fileOwner = $fileAcl.GetOwner($sidType).Value
    directoryProtected = $directoryAcl.AreAccessRulesProtected
    fileProtected = $fileAcl.AreAccessRulesProtected
} | ConvertTo-Json -Compress
`;
        const acl = JSON.parse(execFileSync(
            powershell,
            ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
            {
                encoding: 'utf8',
                env: {
                    SystemRoot: systemRoot,
                    WINDIR: systemRoot,
                    TEMP: process.env.TEMP,
                    TMP: process.env.TMP,
                    ZEPHYR_TEST_DATA_DIR: dataDir,
                    ZEPHYR_TEST_ENV_FILE: envFile,
                },
                windowsHide: true,
            },
        ));
        assert.equal(acl.directoryOwner, acl.current);
        assert.equal(acl.fileOwner, acl.current);
        assert.equal(acl.directoryProtected, true);
        assert.equal(acl.fileProtected, true);
    } finally {
        removeTree(dataDir);
    }
});

test('server consumes provisioned env contents without reopening the pathname', () => {
    const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const start = source.indexOf('function loadDataEnv() {');
    const end = source.indexOf('loadDataEnv();', start);
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);
    const loadDataEnv = source.slice(start, end + 'loadDataEnv();'.length);
    assert.match(loadDataEnv, /provisionDataEnv\(\{[\s\S]*?readContents:\s*true/);
    assert.doesNotMatch(loadDataEnv, /fs\.readFileSync/);
    assert.match(loadDataEnv, /contents:\s*raw/);
});
