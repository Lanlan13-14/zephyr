import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import backupModule from '../backup-encryption.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const {
    CURRENT_MAGIC,
    GENERATED_KEY_PROVENANCE,
    LEGACY_MAGIC,
    OPERATOR_ATTESTED_KEY_PROVENANCE,
    PUBLIC_DEFAULT_SECRET,
    SCRYPT_PARAMS,
    decryptBackup,
    encryptBackup,
    parseCurrentEnvelope,
    provisionDataEnv,
    requireConfiguredBackupSecret,
    requireStrongBackupSecret,
} = backupModule;

const temporaryDataRoots = new Map();

function temporaryDataDirectory(prefix) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { mode: 0o700 });
    temporaryDataRoots.set(dataDir, root);
    return dataDir;
}

function strongSecret() {
    return crypto.randomBytes(32).toString('base64url');
}

function removeTree(directory) {
    let cleanupTarget = temporaryDataRoots.get(directory) || directory;
    temporaryDataRoots.delete(directory);
    if (process.platform === 'win32') {
        const renamed = `${directory}.cleanup-${process.pid}-${crypto.randomUUID()}`;
        try {
            fs.renameSync(directory, renamed);
            cleanupTarget = renamed;
        } catch (error) {
            if (error?.code === 'ENOENT') return;
        }
    }
    fs.rmSync(cleanupTarget, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
}

function canonicalSecretEncodings(bytes) {
    assert.equal(bytes.length, 32);
    const hex = bytes.toString('hex');
    const base64url = bytes.toString('base64url');
    assert.match(hex, /^[0-9a-f]{64}$/);
    assert.match(base64url, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(Buffer.from(hex, 'hex'), bytes);
    assert.deepEqual(Buffer.from(base64url, 'base64url'), bytes);
    return { hex, base64url };
}

function legacyEncrypt(plaintext, secret) {
    const key = crypto.createHash('sha256').update(secret, 'utf8').digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    key.fill(0);
    return Buffer.concat([LEGACY_MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}

function parseEnvFile(file) {
    return Object.fromEntries(fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map((line) => {
        const split = line.indexOf('=');
        return [line.slice(0, split), line.slice(split + 1)];
    }));
}

function assertPrivatePermissions(file) {
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
        return;
    }
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$acl = [IO.File]::GetAccessControl([IO.Path]::GetFullPath($env:ZEPHYR_BACKUP_ACL_FILE))
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$allows = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object {
    $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow
} | ForEach-Object {
    [ordered]@{ sid = $_.IdentityReference.Value; inherited = $_.IsInherited }
})
[ordered]@{ protected = $acl.AreAccessRulesProtected; current = $identity.User.Value; allows = $allows } |
    ConvertTo-Json -Compress -Depth 4
`;
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const output = execFileSync(
        path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        {
            encoding: 'utf8',
            env: {
                SystemRoot: systemRoot,
                WINDIR: systemRoot,
                TEMP: process.env.TEMP,
                TMP: process.env.TMP,
                PSModulePath: process.env.PSModulePath,
                ZEPHYR_BACKUP_ACL_FILE: file,
            },
            windowsHide: true,
        },
    );
    const acl = JSON.parse(output);
    assert.equal(acl.protected, true);
    assert.deepEqual(acl.allows, [{ sid: acl.current, inherited: false }]);
}

function runProvisioner(dataDir) {
    const script = `
        const backup = require('./backup-encryption');
        delete process.env.ENCRYPTION_KEY;
        backup.provisionDataEnv({ dataDir: process.argv[1], env: process.env });
    `;
    const env = { ...process.env };
    delete env.ENCRYPTION_KEY;
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', script, dataDir], {
            cwd: ROOT,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.once('error', reject);
        child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr || `provisioner exited ${code}`)));
    });
}

test('fresh install provisions one persistent CSPRNG backup secret with restrictive mode', () => {
    const dataDir = temporaryDataDirectory('zephyr-backup-key-');
    try {
        const env = {};
        const envFile = provisionDataEnv({ dataDir, env });
        const parsed = parseEnvFile(envFile);
        const decoded = Buffer.from(parsed.ENCRYPTION_KEY, 'base64url');
        assert.equal(decoded.length, 32);
        assert.equal(decoded.toString('base64url'), parsed.ENCRYPTION_KEY);
        assert.doesNotThrow(() => requireStrongBackupSecret(parsed.ENCRYPTION_KEY));
        assert.equal(parsed.ZEPHYR_BACKUP_KEY_PROVENANCE, GENERATED_KEY_PROVENANCE);
        assert.equal(
            requireConfiguredBackupSecret(parsed.ENCRYPTION_KEY, parsed.ZEPHYR_BACKUP_KEY_PROVENANCE),
            parsed.ENCRYPTION_KEY,
        );
        assert.equal(parsed.PUBLIC_ORIGIN, 'http://localhost:3000');
        assertPrivatePermissions(envFile);

        provisionDataEnv({ dataDir, env });
        const restarted = parseEnvFile(envFile);
        assert.equal(restarted.ENCRYPTION_KEY, parsed.ENCRYPTION_KEY, 'restart must not rotate the key');
        assert.equal(restarted.ZEPHYR_BACKUP_KEY_PROVENANCE, GENERATED_KEY_PROVENANCE);
    } finally {
        removeTree(dataDir);
    }
});

test('concurrent first-start provisioners converge on one complete key file', async () => {
    const dataDir = temporaryDataDirectory('zephyr-backup-key-race-');
    try {
        await Promise.all(Array.from({ length: 12 }, () => runProvisioner(dataDir)));
        const raw = fs.readFileSync(path.join(dataDir, '.env'), 'utf8');
        assert.equal((raw.match(/^ENCRYPTION_KEY=/gm) || []).length, 1);
        assert.equal((raw.match(/^ZEPHYR_BACKUP_KEY_PROVENANCE=/gm) || []).length, 1);
        assert.equal((raw.match(/^PUBLIC_ORIGIN=/gm) || []).length, 1);
        const parsed = parseEnvFile(path.join(dataDir, '.env'));
        assert.equal(parsed.ZEPHYR_BACKUP_KEY_PROVENANCE, GENERATED_KEY_PROVENANCE);
        assert.doesNotThrow(() => requireConfiguredBackupSecret(
            parsed.ENCRYPTION_KEY,
            parsed.ZEPHYR_BACKUP_KEY_PROVENANCE,
        ));
        assert.deepEqual(
            fs.readdirSync(dataDir).filter((name) => !name.startsWith('.zephyr-tombstone-v1-')).sort(),
            ['.env'],
        );
    } finally {
        removeTree(dataDir);
    }
});

test('existing missing or public-default configuration is never silently rotated', () => {
    for (const content of [
        'PUBLIC_ORIGIN=http://localhost:3000\n',
        `ENCRYPTION_KEY=${PUBLIC_DEFAULT_SECRET}\nPUBLIC_ORIGIN=http://localhost:3000\n`,
    ]) {
        const dataDir = temporaryDataDirectory('zephyr-backup-key-migrate-');
        try {
            const envFile = path.join(dataDir, '.env');
            fs.writeFileSync(envFile, content, { mode: 0o600 });
            provisionDataEnv({ dataDir, env: {} });
            assert.equal(fs.readFileSync(envFile, 'utf8'), content, 'legacy installs require an explicit operator rotation');
            assertPrivatePermissions(envFile);
            const configured = parseEnvFile(envFile).ENCRYPTION_KEY;
            assert.throws(() => requireStrongBackupSecret(configured), { code: 'backup_key_configuration_required' });
        } finally {
            removeTree(dataDir);
        }
    }
});

test('an externally managed key is not copied into the data directory', () => {
    const dataDir = temporaryDataDirectory('zephyr-backup-key-external-');
    try {
        const secret = strongSecret();
        const envFile = provisionDataEnv({
            dataDir,
            env: {
                ENCRYPTION_KEY: secret,
                ZEPHYR_BACKUP_KEY_PROVENANCE: OPERATOR_ATTESTED_KEY_PROVENANCE,
            },
        });
        assert.equal(fs.readFileSync(envFile, 'utf8').includes(secret), false);
        const parsed = parseEnvFile(envFile);
        assert.equal(Object.hasOwn(parsed, 'ENCRYPTION_KEY'), false);
        assert.equal(Object.hasOwn(parsed, 'ZEPHYR_BACKUP_KEY_PROVENANCE'), false);
    } finally {
        removeTree(dataDir);
    }
});

test('missing, public-default, placeholder, short, padded and low-entropy secrets are rejected', () => {
    for (const secret of [undefined, '', PUBLIC_DEFAULT_SECRET, `x-${PUBLIC_DEFAULT_SECRET}-x`, '请替换为足够长的随机密钥', 'short-key', 'a'.repeat(64), 'abcd'.repeat(16), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab', 'password-password-password-1234567890', 'this-is-a-very-predictable-backup-password', ` ${strongSecret()}`]) {
        assert.throws(() => requireStrongBackupSecret(secret), { code: 'backup_key_configuration_required' });
    }
    assert.doesNotThrow(() => requireStrongBackupSecret(strongSecret()));
});

test('every complete repeating byte period is rejected in each canonical encoding', () => {
    const patterns = [];
    for (const period of [1, 2, 4, 8, 16]) {
        const unit = Buffer.from(Array.from({ length: period }, (_, index) => (index * 17 + 31) & 0xff));
        patterns.push([`${period}-byte period`, Buffer.concat(Array(32 / period).fill(unit))]);
    }
    patterns.push(
        ['16-byte ASCII period', Buffer.from('0123456789abcdef0123456789abcdef', 'ascii')],
        ['16-byte binary period', Buffer.from(Array.from({ length: 32 }, (_, index) => index % 16))],
    );

    for (const [label, bytes] of patterns) {
        for (const [encoding, secret] of Object.entries(canonicalSecretEncodings(bytes))) {
            assert.throws(
                () => requireStrongBackupSecret(secret),
                { code: 'backup_key_configuration_required' },
                `${label} must be rejected when encoded as ${encoding}`,
            );
        }
    }
});

test('hashes of public default passwords are rejected in each canonical encoding', () => {
    for (const publicDefault of ['password', 'please-change-this-key']) {
        const digest = crypto.createHash('sha256').update(publicDefault, 'utf8').digest();
        for (const [encoding, secret] of Object.entries(canonicalSecretEncodings(digest))) {
            assert.throws(
                () => requireStrongBackupSecret(secret),
                { code: 'backup_key_configuration_required' },
                `SHA-256 of ${JSON.stringify(publicDefault)} must be rejected when encoded as ${encoding}`,
            );
        }
    }
});

test('configured backup secrets require trusted provenance without bypassing key policy', () => {
    const secret = strongSecret();
    for (const provenance of [undefined, '', 'unknown-key-provenance-v1']) {
        assert.throws(
            () => requireConfiguredBackupSecret(secret, provenance),
            { code: 'backup_key_configuration_required' },
        );
    }

    for (const provenance of [GENERATED_KEY_PROVENANCE, OPERATOR_ATTESTED_KEY_PROVENANCE]) {
        assert.equal(requireConfiguredBackupSecret(secret, provenance), secret);
    }

    const weakSecret = Buffer.from('0123456789abcdef0123456789abcdef', 'ascii').toString('base64url');
    for (const provenance of [GENERATED_KEY_PROVENANCE, OPERATOR_ATTESTED_KEY_PROVENANCE]) {
        assert.throws(
            () => requireConfiguredBackupSecret(weakSecret, provenance),
            { code: 'backup_key_configuration_required' },
        );
    }
});

test('current backups use random salt, versioned scrypt parameters and authenticated metadata', () => {
    const secret = strongSecret();
    const plaintext = crypto.randomBytes(4096);
    const first = encryptBackup(plaintext, secret);
    const second = encryptBackup(plaintext, secret);
    assert.equal(first.subarray(0, CURRENT_MAGIC.length).equals(CURRENT_MAGIC), true);
    assert.equal(first.equals(second), false);
    assert.deepEqual(decryptBackup(first, secret), plaintext);

    const firstEnvelope = parseCurrentEnvelope(first);
    const secondEnvelope = parseCurrentEnvelope(second);
    const header = JSON.parse(firstEnvelope.headerBytes.toString('utf8'));
    assert.deepEqual(
        { N: header.kdf.N, r: header.kdf.r, p: header.kdf.p, keyLength: header.kdf.keyLength },
        SCRYPT_PARAMS,
    );
    assert.notEqual(header.kdf.salt, JSON.parse(secondEnvelope.headerBytes.toString('utf8')).kdf.salt);

    const tampered = Buffer.from(first);
    tampered[CURRENT_MAGIC.length + 4 + firstEnvelope.headerBytes.length + 16] ^= 1;
    assert.throws(() => decryptBackup(tampered, secret), { code: 'backup_authentication_failed' });
});

test('wrong current backup password fails without exposing crypto internals', () => {
    const archive = encryptBackup(Buffer.from('secret database'), strongSecret());
    assert.throws(
        () => decryptBackup(archive, strongSecret()),
        (error) => error?.code === 'backup_authentication_failed'
            && !/authenticate|openssl|decipher|bad decrypt/i.test(error.message),
    );
});

test('legacy ZEPHYR3 envelope is disabled unless an explicit compatibility password is allowed', () => {
    const plaintext = Buffer.from('legacy secure archive');
    const legacyPassword = 'legacy-archive-password-with-32-bytes-Q9!m';
    const archive = legacyEncrypt(plaintext, legacyPassword);
    assert.throws(() => decryptBackup(archive, legacyPassword), { code: 'backup_format_invalid' });
    assert.deepEqual(decryptBackup(archive, legacyPassword, { allowLegacyPassword: true }), plaintext);
    assert.throws(
        () => decryptBackup(
            legacyEncrypt(plaintext, PUBLIC_DEFAULT_SECRET),
            PUBLIC_DEFAULT_SECRET,
            { allowLegacyPassword: true },
        ),
        { code: 'backup_key_configuration_required' },
    );
});

test('environment file rejects hard links, directories, and symbolic links', (t) => {
    const dataDir = temporaryDataDirectory('zephyr-backup-key-file-type-');
    const envFile = path.join(dataDir, '.env');
    try {
        fs.writeFileSync(envFile, `ENCRYPTION_KEY=${strongSecret()}\n`, { mode: 0o600 });
        fs.linkSync(envFile, path.join(dataDir, 'env-alias'));
        assert.throws(() => provisionDataEnv({ dataDir, env: {} }), /regular, unlinked file/);
    } finally {
        removeTree(dataDir);
    }

    const directoryCase = temporaryDataDirectory('zephyr-backup-key-directory-');
    try {
        fs.mkdirSync(path.join(directoryCase, '.env'));
        assert.throws(() => provisionDataEnv({ dataDir: directoryCase, env: {} }), /regular, unlinked file/);
    } finally {
        removeTree(directoryCase);
    }

    const symlinkCase = temporaryDataDirectory('zephyr-backup-key-symlink-');
    try {
        const target = path.join(symlinkCase, 'target');
        fs.writeFileSync(target, `ENCRYPTION_KEY=${strongSecret()}\n`, { mode: 0o600 });
        try {
            fs.symlinkSync(target, path.join(symlinkCase, '.env'), 'file');
        } catch (error) {
            if (process.platform === 'win32' && error?.code === 'EPERM') {
                t.diagnostic('Windows symlink creation requires Developer Mode; hard-link rejection remains covered');
                return;
            }
            throw error;
        }
        assert.throws(() => provisionDataEnv({ dataDir: symlinkCase, env: {} }), /regular, unlinked file/);
    } finally {
        removeTree(symlinkCase);
    }
});

test('POSIX data directory and its parent must be service-owned and not writable by group/world', {
    skip: process.platform === 'win32',
}, (t) => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'zephyr-backup-key-posix-mode-'));
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { mode: 0o700 });
    try {
        fs.chmodSync(dataDir, 0o720);
        assert.throws(
            () => provisionDataEnv({ dataDir, env: {} }),
            /backup data directory.*not group\/world writable/i,
        );

        fs.chmodSync(dataDir, 0o700);
        fs.chmodSync(root, 0o702);
        assert.throws(
            () => provisionDataEnv({ dataDir, env: {} }),
            /backup data parent directory.*not group\/world writable/i,
        );

        fs.chmodSync(root, 0o700);
        const envFile = provisionDataEnv({ dataDir, env: {} });
        assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);

        if (typeof process.geteuid === 'function' && process.geteuid() === 0) {
            fs.rmSync(envFile);
            fs.chownSync(dataDir, 1, 1);
            assert.throws(
                () => provisionDataEnv({ dataDir, env: {} }),
                /backup data directory.*owned by the service identity/i,
            );
            fs.chownSync(dataDir, 0, 0);
        } else {
            t.diagnostic('ownership mismatch requires a privileged test runner; mode checks remain active');
        }
    } finally {
        try { fs.chmodSync(root, 0o700); } catch {}
        try { fs.chmodSync(dataDir, 0o700); } catch {}
        removeTree(root);
    }
});
