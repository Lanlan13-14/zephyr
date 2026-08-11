'use strict';

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
    assertDirectoryIdentity,
    closeDirectoryIdentity,
    directoryEntryPath,
    openDirectoryIdentity,
    removeFileDurably,
    sameIdentity,
} = require('./durable-file');

const CURRENT_MAGIC = Buffer.from('ZEPHYR4', 'ascii');
const LEGACY_MAGIC = Buffer.from('ZEPHYR3', 'ascii');
const HEADER_LENGTH_BYTES = 4;
const AUTH_TAG_BYTES = 16;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const MAX_HEADER_BYTES = 4096;
const MAX_ENV_FILE_BYTES = 64 * 1024;
const MIN_SECRET_BYTES = 32;
const SCRYPT_PARAMS = Object.freeze({ N: 32768, r: 8, p: 1, keyLength: 32 });
const SCRYPT_MAXMEM = 128 * 1024 * 1024;
const PUBLIC_DEFAULT_SECRET = 'please-change-this-key';
const GENERATED_KEY_PROVENANCE = 'zephyr-generated-csprng-v1';
const OPERATOR_ATTESTED_KEY_PROVENANCE = 'operator-attested-csprng-v1';
const ENV_COMMIT_RETRY = new Int32Array(new SharedArrayBuffer(4));
const INSECURE_SECRETS = new Set([
    '',
    PUBLIC_DEFAULT_SECRET,
    'change-me',
    'changeme',
    'replace-me',
    'replace-with-a-long-random-key',
    'your-encryption-key',
    'your-long-random-encryption-key',
    '请替换为足够长的随机密钥',
]);
const KNOWN_WEAK_KEY_SOURCES = new Set([
    ...INSECURE_SECRETS,
    'password',
    'password123',
    'admin',
    'secret',
    'backup',
    'zephyr',
]);
const KNOWN_WEAK_KEY_DIGESTS = new Set(
    [...KNOWN_WEAK_KEY_SOURCES].map((value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex')),
);
const ACCEPTED_KEY_PROVENANCE = new Set([
    GENERATED_KEY_PROVENANCE,
    OPERATOR_ATTESTED_KEY_PROVENANCE,
]);

const PUBLIC_MESSAGES = Object.freeze({
    backup_key_configuration_required: 'Backup encryption is not configured securely. Rotate ENCRYPTION_KEY before exporting or importing backups.',
    backup_format_invalid: 'The backup format is invalid or unsupported.',
    backup_authentication_failed: 'The backup password is incorrect or the archive is corrupted.',
});

class BackupEncryptionError extends Error {
    constructor(code) {
        super(PUBLIC_MESSAGES[code] || PUBLIC_MESSAGES.backup_format_invalid);
        this.name = 'BackupEncryptionError';
        this.code = PUBLIC_MESSAGES[code] ? code : 'backup_format_invalid';
    }
}

function backupError(code) {
    return new BackupEncryptionError(code);
}

function hasRepeatingPeriod(buffer) {
    for (let period = 1; period <= Math.floor(buffer.length / 2); period += 1) {
        if (buffer.length % period !== 0) continue;
        let repeated = true;
        for (let index = period; index < buffer.length; index += 1) {
            if (buffer[index] !== buffer[index % period]) {
                repeated = false;
                break;
            }
        }
        if (repeated) return true;
    }
    return false;
}

function matchesKnownWeakKeyDigest(buffer) {
    return KNOWN_WEAK_KEY_DIGESTS.has(buffer.toString('hex'));
}

function estimatedByteEntropy(buffer) {
    const counts = new Map();
    for (const byte of buffer) counts.set(byte, (counts.get(byte) || 0) + 1);
    let entropy = 0;
    for (const count of counts.values()) {
        const probability = count / buffer.length;
        entropy -= probability * Math.log2(probability);
    }
    return { distinctBytes: counts.size, bitsPerByte: entropy };
}

function requireStrongBackupSecret(input) {
    if (typeof input !== 'string' || input !== input.trim()) {
        throw backupError('backup_key_configuration_required');
    }
    const normalized = input.toLowerCase();
    let bytes = null;
    if (/^[0-9a-f]{64}$/i.test(input)) {
        bytes = Buffer.from(input, 'hex');
    } else if (/^[A-Za-z0-9_-]{43}$/.test(input)) {
        bytes = Buffer.from(input, 'base64url');
        if (bytes.toString('base64url') !== input) {
            bytes.fill(0);
            throw backupError('backup_key_configuration_required');
        }
    } else {
        throw backupError('backup_key_configuration_required');
    }
    const entropy = estimatedByteEntropy(bytes);
    const invalid = bytes.length !== MIN_SECRET_BYTES
        || INSECURE_SECRETS.has(normalized)
        || normalized.includes(PUBLIC_DEFAULT_SECRET)
        || entropy.distinctBytes < 16
        || entropy.bitsPerByte < 3.75
        || hasRepeatingPeriod(bytes)
        || matchesKnownWeakKeyDigest(bytes);
    bytes.fill(0);
    if (invalid) throw backupError('backup_key_configuration_required');
    return input;
}

function requireConfiguredBackupSecret(input, provenance) {
    if (!ACCEPTED_KEY_PROVENANCE.has(provenance)) {
        throw backupError('backup_key_configuration_required');
    }
    return requireStrongBackupSecret(input);
}

function requireLegacyBackupPassword(input) {
    if (typeof input !== 'string' || input !== input.trim()) {
        throw backupError('backup_key_configuration_required');
    }
    const normalized = input.toLowerCase();
    const bytes = Buffer.from(input, 'utf8');
    const entropy = estimatedByteEntropy(bytes);
    const invalid = bytes.length < MIN_SECRET_BYTES
        || INSECURE_SECRETS.has(normalized)
        || normalized.includes(PUBLIC_DEFAULT_SECRET)
        || entropy.distinctBytes < 12
        || entropy.bitsPerByte < 3.25
        || hasRepeatingPeriod(bytes);
    bytes.fill(0);
    if (invalid) throw backupError('backup_key_configuration_required');
    return input;
}

function generateBackupSecret(randomBytes = crypto.randomBytes) {
    const generated = Buffer.from(randomBytes(32));
    if (generated.length < 32) {
        generated.fill(0);
        throw new Error('backup key generator returned fewer than 32 bytes');
    }
    const secret = generated.toString('base64url');
    generated.fill(0);
    return requireStrongBackupSecret(secret);
}

function readCommittedEnvIdentity(dataToken, operationalEnvFile) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        assertDirectoryIdentity(dataToken);
        const named = fs.lstatSync(operationalEnvFile, { bigint: true });
        if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n) return named;

        // The final name is created exclusively and written through its own
        // handle. Another first-start process waits only while a recognized
        // staging file shows that this short commit is still in progress.
        const directory = process.platform === 'linux'
            ? `/proc/self/fd/${dataToken.fd}`
            : dataToken.path;
        const transient = fs.readdirSync(directory).some((name) => {
            return /^\.env\.tmp-/.test(name);
        });
        assertDirectoryIdentity(dataToken);
        if (!transient) return named;
        Atomics.wait(ENV_COMMIT_RETRY, 0, 0, 5);
    }
    return fs.lstatSync(operationalEnvFile, { bigint: true });
}

function windowsToolEnv() {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    return {
        SystemRoot: systemRoot,
        WINDIR: systemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
    };
}

const WINDOWS_SECURE_ENV_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class ZephyrSecureFile {
    private const uint READ_CONTROL = 0x00020000;
    private const uint WRITE_DAC = 0x00040000;
    private const uint GENERIC_READ = 0x80000000;
    private const uint FILE_READ_ATTRIBUTES = 0x00000080;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
    private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;

    [StructLayout(LayoutKind.Sequential)]
    public struct FileIdentity {
        public uint FileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;

        public bool IsDirectory { get { return (FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0; } }
        public bool IsReparsePoint { get { return (FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0; } }
        public string Key { get { return VolumeSerialNumber + ":" + FileIndexHigh + ":" + FileIndexLow; } }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileIdentity information);

    private static SafeFileHandle Open(string fileName, uint desiredAccess, uint flags) {
        SafeFileHandle handle = CreateFileW(
            fileName,
            desiredAccess,
            FILE_SHARE_READ,
            IntPtr.Zero,
            OPEN_EXISTING,
            flags | FILE_FLAG_OPEN_REPARSE_POINT,
            IntPtr.Zero);
        if (handle.IsInvalid) {
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(error, "Secure backup environment handle could not be opened");
        }
        return handle;
    }

    public static SafeFileHandle OpenDirectory(string directory) {
        return Open(directory, READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES, FILE_FLAG_BACKUP_SEMANTICS);
    }

    public static SafeFileHandle OpenFile(string fileName) {
        return Open(fileName, GENERIC_READ | WRITE_DAC, 0);
    }

    public static FileIdentity GetIdentity(SafeFileHandle handle) {
        FileIdentity information;
        if (!GetFileInformationByHandle(handle, out information)) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Secure backup environment identity could not be read");
        }
        return information;
    }
}
'@

function Assert-SameIdentity($expected, $actual, [string] $description) {
    if ($expected.Key -ne $actual.Key) {
        throw "$description was replaced during secure access"
    }
}

function Set-And-VerifyPrivateAcl(
    [IO.FileStream] $stream,
    [bool] $directory,
    [string] $sidValue,
    [string] $lockedPath) {
    $sidType = [Security.Principal.SecurityIdentifier]
    $sid = [Security.Principal.SecurityIdentifier]::new($sidValue)
    $beforeAcl = $stream.GetAccessControl()
    $beforeOwner = $beforeAcl.GetOwner($sidType).Value
    if ($beforeOwner -ne $sidValue) {
        throw 'backup environment path is not owned by the service identity'
    }

    if ($directory) {
        $privateAcl = [Security.AccessControl.DirectorySecurity]::new()
    } else {
        $privateAcl = [Security.AccessControl.FileSecurity]::new()
    }
    $privateAcl.SetAccessRuleProtection($true, $false)
    $inheritance = [Security.AccessControl.InheritanceFlags]::None
    if ($directory) {
        $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [Security.AccessControl.InheritanceFlags]::ObjectInherit
    }
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        $sid,
        [Security.AccessControl.FileSystemRights]::FullControl,
        $inheritance,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow)
    [void] $privateAcl.AddAccessRule($rule)
    if ($directory) {
        # The held directory handle denies deletion/rename, so this pathname cannot be redirected.
        [IO.Directory]::SetAccessControl($lockedPath, $privateAcl)
    } else {
        $stream.SetAccessControl($privateAcl)
    }

    if ($directory) {
        $verified = [IO.Directory]::GetAccessControl($lockedPath)
    } else {
        $verified = $stream.GetAccessControl()
    }
    if ($verified.GetOwner($sidType).Value -ne $sidValue -or -not $verified.AreAccessRulesProtected) {
        throw 'backup environment ACL owner or inheritance validation failed'
    }
    $rules = @($verified.GetAccessRules($true, $true, $sidType))
    if ($rules.Count -ne 1) {
        throw 'backup environment DACL is not private'
    }
    $verifiedRule = $rules[0]
    if ($verifiedRule.IdentityReference.Value -ne $sidValue -or
        $verifiedRule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        $verifiedRule.IsInherited -or
        [int] $verifiedRule.FileSystemRights -ne [int] [Security.AccessControl.FileSystemRights]::FullControl -or
        [int] $verifiedRule.InheritanceFlags -ne [int] $inheritance -or
        $verifiedRule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
        throw "backup environment DACL validation failed (rights=$($verifiedRule.FileSystemRights); inheritance=$($verifiedRule.InheritanceFlags); propagation=$($verifiedRule.PropagationFlags); type=$($verifiedRule.AccessControlType); inherited=$($verifiedRule.IsInherited))"
    }
}

$dataDirectory = [IO.Path]::GetFullPath($env:ZEPHYR_BACKUP_DATA_DIR)
$envFile = $env:ZEPHYR_BACKUP_ENV_FILE
$readContents = $env:ZEPHYR_BACKUP_READ_CONTENTS -eq '1'
$maxEnvBytes = [uint64] $env:ZEPHYR_BACKUP_MAX_ENV_BYTES
$encodedContents = ''
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$directoryHandle = [ZephyrSecureFile]::OpenDirectory($dataDirectory)
$directoryStream = $null
try {
    $directoryBefore = [ZephyrSecureFile]::GetIdentity($directoryHandle)
    if (-not $directoryBefore.IsDirectory -or $directoryBefore.IsReparsePoint) {
        throw 'backup data directory must be one regular directory'
    }
    $directoryStream = [IO.FileStream]::new($directoryHandle, [IO.FileAccess]::Read)
    Set-And-VerifyPrivateAcl $directoryStream $true $currentSid $dataDirectory

    if ($envFile) {
        $resolvedEnvFile = [IO.Path]::GetFullPath($envFile)
        if ([IO.Path]::GetDirectoryName($resolvedEnvFile) -ne $dataDirectory) {
            throw 'backup environment file must be inside the data directory'
        }
        $fileHandle = [ZephyrSecureFile]::OpenFile($resolvedEnvFile)
        $fileStream = $null
        try {
            $fileBefore = [ZephyrSecureFile]::GetIdentity($fileHandle)
            if ($fileBefore.IsDirectory -or $fileBefore.IsReparsePoint -or $fileBefore.NumberOfLinks -ne 1) {
                throw 'backup key environment file must be one regular, unlinked file'
            }
            $fileSize = (([uint64] $fileBefore.FileSizeHigh -shl 32) -bor [uint64] $fileBefore.FileSizeLow)
            if ($fileSize -gt $maxEnvBytes) {
                throw 'backup key environment file is too large'
            }
            $fileStream = [IO.FileStream]::new($fileHandle, [IO.FileAccess]::Read)
            Set-And-VerifyPrivateAcl $fileStream $false $currentSid $resolvedEnvFile

            if ($readContents) {
                $content = [IO.MemoryStream]::new()
                try {
                    $fileStream.CopyTo($content)
                    $encodedContents = [Convert]::ToBase64String($content.ToArray())
                } finally {
                    $content.Dispose()
                }
            }

            $fileAfter = [ZephyrSecureFile]::GetIdentity($fileHandle)
            Assert-SameIdentity $fileBefore $fileAfter 'backup key environment file'
            if ($fileAfter.NumberOfLinks -ne 1) {
                throw 'backup key environment file acquired another hard link during secure access'
            }
            $namedFileHandle = [ZephyrSecureFile]::OpenFile($resolvedEnvFile)
            try {
                Assert-SameIdentity $fileAfter ([ZephyrSecureFile]::GetIdentity($namedFileHandle)) 'backup key environment pathname'
            } finally {
                $namedFileHandle.Dispose()
            }
        } finally {
            if ($fileStream) { $fileStream.Dispose() } else { $fileHandle.Dispose() }
        }
    }

    $directoryAfter = [ZephyrSecureFile]::GetIdentity($directoryHandle)
    Assert-SameIdentity $directoryBefore $directoryAfter 'backup data directory'
    $namedDirectoryHandle = [ZephyrSecureFile]::OpenDirectory($dataDirectory)
    try {
        Assert-SameIdentity $directoryAfter ([ZephyrSecureFile]::GetIdentity($namedDirectoryHandle)) 'backup data directory pathname'
    } finally {
        $namedDirectoryHandle.Dispose()
    }
} finally {
    if ($directoryStream) { $directoryStream.Dispose() } else { $directoryHandle.Dispose() }
}
if ($readContents) {
    [Console]::Out.Write($encodedContents)
}
`;

function secureWindowsDataEnv(dataDir, envFile, { readContents = false } = {}) {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const output = execFileSync(
        powershell,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SECURE_ENV_SCRIPT],
        {
            encoding: 'utf8',
            env: {
                ...windowsToolEnv(),
                ZEPHYR_BACKUP_DATA_DIR: dataDir,
                ZEPHYR_BACKUP_ENV_FILE: envFile || '',
                ZEPHYR_BACKUP_READ_CONTENTS: readContents ? '1' : '0',
                ZEPHYR_BACKUP_MAX_ENV_BYTES: String(MAX_ENV_FILE_BYTES),
            },
            maxBuffer: 2 * 1024 * 1024,
            windowsHide: true,
            stdio: 'pipe',
            timeout: 30_000,
        },
    );
    if (!readContents) return undefined;
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(output)) {
        throw new Error('Windows backup environment reader returned invalid output');
    }
    return Buffer.from(output, 'base64').toString('utf8');
}

function secureEnvFilePermissions(envFile, { readContents = false } = {}) {
    const before = fs.lstatSync(envFile);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
        throw new Error('backup key environment file must be one regular, unlinked file');
    }
    if (process.platform === 'win32') {
        throw new Error('Windows backup environment files require data-directory verification');
    }
    const noFollow = Number(fs.constants.O_NOFOLLOW || 0);
    const fd = fs.openSync(envFile, fs.constants.O_RDONLY | noFollow);
    try {
        const opened = fs.fstatSync(fd);
        const currentUid = typeof process.geteuid === 'function' ? process.geteuid() : opened.uid;
        if (!opened.isFile() || opened.nlink !== 1 || opened.uid !== currentUid
            || opened.size > MAX_ENV_FILE_BYTES) {
            throw new Error('backup key environment file must be owned by the service identity');
        }
        fs.fchmodSync(fd, 0o600);
        const verified = fs.fstatSync(fd);
        const named = fs.lstatSync(envFile);
        if (!verified.isFile() || verified.nlink !== 1 || verified.uid !== currentUid
            || (verified.mode & 0o777) !== 0o600 || !named.isFile() || named.isSymbolicLink()
            || named.dev !== verified.dev || named.ino !== verified.ino) {
            throw new Error('backup key environment file permissions could not be secured');
        }
        const contents = readContents ? fs.readFileSync(fd, 'utf8') : undefined;
        const afterRead = fs.fstatSync(fd);
        const namedAfterRead = fs.lstatSync(envFile);
        if (!afterRead.isFile() || afterRead.nlink !== 1 || afterRead.uid !== currentUid
            || namedAfterRead.dev !== afterRead.dev || namedAfterRead.ino !== afterRead.ino) {
            throw new Error('backup key environment file changed during secure access');
        }
        return contents;
    } finally {
        fs.closeSync(fd);
    }
}

function provisionDataEnv({
    dataDir,
    env = process.env,
    randomBytes = crypto.randomBytes,
    readContents = false,
} = {}) {
    if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('dataDir is required');
    const resolvedDataDir = path.resolve(dataDir);
    const envFile = path.join(resolvedDataDir, '.env');
    const parentDirectory = path.dirname(resolvedDataDir);
    const parentToken = openDirectoryIdentity(parentDirectory, {
        label: 'backup data parent directory',
        requirePrivate: process.platform !== 'win32',
        rejectLinkedComponents: true,
    });
    let dataToken = null;
    try {
        assertDirectoryIdentity(parentToken);
        const existingDataDirectory = fs.lstatSync(resolvedDataDir, {
            bigint: true,
            throwIfNoEntry: false,
        });
        if (!existingDataDirectory) {
            try {
                fs.mkdirSync(resolvedDataDir, { recursive: false, mode: 0o700 });
            } catch (error) {
                if (error?.code !== 'EEXIST') throw error;
            }
        }
        assertDirectoryIdentity(parentToken);
        dataToken = openDirectoryIdentity(resolvedDataDir, {
            label: 'backup data directory',
            requirePrivate: process.platform !== 'win32',
            rejectLinkedComponents: true,
        });
        assertDirectoryIdentity(parentToken);
        if (process.platform === 'win32') {
            try {
                secureWindowsDataEnv(resolvedDataDir, null);
            } catch (error) {
                throw new Error('backup data directory permissions could not be secured', { cause: error });
            }
            assertDirectoryIdentity(dataToken);
        }

        const operationalEnvFile = process.platform === 'linux'
            ? directoryEntryPath(dataToken, '.env')
            : envFile;
        assertDirectoryIdentity(dataToken);
        const namedEnv = fs.lstatSync(operationalEnvFile, { bigint: true, throwIfNoEntry: false });
        assertDirectoryIdentity(dataToken);
        if (!namedEnv) {
            const externallyManaged = typeof env.ENCRYPTION_KEY === 'string' && env.ENCRYPTION_KEY.length > 0;
            const generatedSecret = externallyManaged ? null : generateBackupSecret(randomBytes);
            const generatedConfiguration = generatedSecret
                ? `ENCRYPTION_KEY=${generatedSecret}\nZEPHYR_BACKUP_KEY_PROVENANCE=${GENERATED_KEY_PROVENANCE}\n`
                : '';
            const payload = `${generatedConfiguration}PUBLIC_ORIGIN=http://localhost:3000\n`;
            const temporaryName = `.env.tmp-${process.pid}-${crypto.randomUUID()}`;
            const temporaryFile = directoryEntryPath(dataToken, temporaryName);
            let fd = null;
            let temporaryIdentity = null;
            try {
                assertDirectoryIdentity(dataToken);
                fd = fs.openSync(
                    temporaryFile,
                    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
                        | Number(fs.constants.O_NOFOLLOW || 0),
                    0o600,
                );
                temporaryIdentity = fs.fstatSync(fd, { bigint: true });
                if (!temporaryIdentity.isFile() || temporaryIdentity.nlink !== 1n) {
                    throw new Error('backup environment temporary file is invalid');
                }
                fs.writeFileSync(fd, payload, { encoding: 'utf8' });
                fs.fsyncSync(fd);
                const completedIdentity = fs.fstatSync(fd, { bigint: true });
                if (!sameIdentity(temporaryIdentity, completedIdentity)) {
                    throw new Error('backup environment temporary file changed while being written');
                }
                fs.closeSync(fd);
                fd = null;
                assertDirectoryIdentity(dataToken);
                const namedTemporary = fs.lstatSync(temporaryFile, { bigint: true, throwIfNoEntry: false });
                if (!sameIdentity(temporaryIdentity, namedTemporary)) {
                    throw new Error('backup environment temporary file changed before commit');
                }
                try {
                    const committedFd = fs.openSync(
                        operationalEnvFile,
                        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
                            | Number(fs.constants.O_NOFOLLOW || 0),
                        0o600,
                    );
                    try {
                        fs.writeFileSync(committedFd, payload, { encoding: 'utf8' });
                        fs.fsyncSync(committedFd);
                    } finally {
                        fs.closeSync(committedFd);
                    }
                    assertDirectoryIdentity(dataToken);
                    try {
                        fs.fsyncSync(dataToken.fd);
                    } catch (error) {
                        // Windows has no supported directory flush through Node.
                        if (process.platform !== 'win32') throw error;
                    }
                } catch (error) {
                    if (error?.code !== 'EEXIST') throw error;
                }
            } finally {
                if (fd !== null) fs.closeSync(fd);
                if (temporaryIdentity) {
                    removeFileDurably(temporaryFile, {
                        allowMissing: true,
                        expectedIdentity: temporaryIdentity,
                        parentToken: dataToken,
                        label: 'backup environment temporary file',
                    });
                }
            }
        }

        assertDirectoryIdentity(dataToken);
        const namedEnvFile = readCommittedEnvIdentity(dataToken, operationalEnvFile);
        if (!namedEnvFile.isFile() || namedEnvFile.isSymbolicLink() || namedEnvFile.nlink !== 1n) {
            throw new Error('backup key environment file must be one regular, unlinked file');
        }

        let contents;
        try {
            contents = process.platform === 'win32'
                ? secureWindowsDataEnv(resolvedDataDir, envFile, { readContents })
                : secureEnvFilePermissions(operationalEnvFile, { readContents });
        } catch (error) {
            throw new Error('backup key environment file permissions could not be secured', { cause: error });
        }
        assertDirectoryIdentity(dataToken);
        assertDirectoryIdentity(parentToken);
        return readContents ? { envFile, contents } : envFile;
    } finally {
        closeDirectoryIdentity(dataToken);
        closeDirectoryIdentity(parentToken);
    }
}

function deriveScryptKey(secret, salt, params = SCRYPT_PARAMS) {
    return crypto.scryptSync(secret, salt, params.keyLength, {
        N: params.N,
        r: params.r,
        p: params.p,
        maxmem: SCRYPT_MAXMEM,
    });
}

function encodeHeader(salt, iv) {
    return Buffer.from(JSON.stringify({
        version: 4,
        kdf: {
            name: 'scrypt',
            N: SCRYPT_PARAMS.N,
            r: SCRYPT_PARAMS.r,
            p: SCRYPT_PARAMS.p,
            keyLength: SCRYPT_PARAMS.keyLength,
            salt: salt.toString('base64url'),
        },
        cipher: {
            name: 'AES-256-GCM',
            iv: iv.toString('base64url'),
            tagLength: AUTH_TAG_BYTES,
        },
    }), 'utf8');
}

function canonicalBase64Url(value, expectedBytes) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.length !== expectedBytes || decoded.toString('base64url') !== value) return null;
    return decoded;
}

function parseCurrentEnvelope(input) {
    const body = Buffer.from(input || []);
    const prefixBytes = CURRENT_MAGIC.length + HEADER_LENGTH_BYTES;
    if (body.length < prefixBytes + AUTH_TAG_BYTES + 1 || !body.subarray(0, CURRENT_MAGIC.length).equals(CURRENT_MAGIC)) {
        throw backupError('backup_format_invalid');
    }
    const headerLength = body.readUInt32BE(CURRENT_MAGIC.length);
    if (headerLength < 2 || headerLength > MAX_HEADER_BYTES || body.length < prefixBytes + headerLength + AUTH_TAG_BYTES + 1) {
        throw backupError('backup_format_invalid');
    }
    const headerBytes = body.subarray(prefixBytes, prefixBytes + headerLength);
    let header;
    try { header = JSON.parse(headerBytes.toString('utf8')); } catch { throw backupError('backup_format_invalid'); }
    const keys = header && typeof header === 'object' && !Array.isArray(header) ? Object.keys(header).sort() : [];
    const kdfKeys = header?.kdf && typeof header.kdf === 'object' && !Array.isArray(header.kdf) ? Object.keys(header.kdf).sort() : [];
    const cipherKeys = header?.cipher && typeof header.cipher === 'object' && !Array.isArray(header.cipher) ? Object.keys(header.cipher).sort() : [];
    if (keys.join(',') !== 'cipher,kdf,version'
        || kdfKeys.join(',') !== 'N,keyLength,name,p,r,salt'
        || cipherKeys.join(',') !== 'iv,name,tagLength'
        || header.version !== 4
        || header.kdf.name !== 'scrypt'
        || header.kdf.N !== SCRYPT_PARAMS.N
        || header.kdf.r !== SCRYPT_PARAMS.r
        || header.kdf.p !== SCRYPT_PARAMS.p
        || header.kdf.keyLength !== SCRYPT_PARAMS.keyLength
        || header.cipher.name !== 'AES-256-GCM'
        || header.cipher.tagLength !== AUTH_TAG_BYTES) {
        throw backupError('backup_format_invalid');
    }
    const salt = canonicalBase64Url(header.kdf.salt, SALT_BYTES);
    const iv = canonicalBase64Url(header.cipher.iv, IV_BYTES);
    if (!salt || !iv) throw backupError('backup_format_invalid');
    const tagOffset = prefixBytes + headerLength;
    return {
        headerBytes,
        salt,
        iv,
        tag: body.subarray(tagOffset, tagOffset + AUTH_TAG_BYTES),
        ciphertext: body.subarray(tagOffset + AUTH_TAG_BYTES),
    };
}

function encryptBackup(input, secretInput, randomBytes = crypto.randomBytes) {
    const secret = requireStrongBackupSecret(secretInput);
    const plaintext = Buffer.from(input || []);
    const salt = Buffer.from(randomBytes(SALT_BYTES));
    const iv = Buffer.from(randomBytes(IV_BYTES));
    if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES) throw new Error('backup random generator returned an invalid length');
    const headerBytes = encodeHeader(salt, iv);
    const headerLength = Buffer.alloc(HEADER_LENGTH_BYTES);
    headerLength.writeUInt32BE(headerBytes.length, 0);
    const aad = Buffer.concat([CURRENT_MAGIC, headerLength, headerBytes]);
    const key = deriveScryptKey(secret, salt);
    try {
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(aad);
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        return Buffer.concat([aad, cipher.getAuthTag(), ciphertext]);
    } finally {
        key.fill(0);
        salt.fill(0);
    }
}

function decryptCurrentBackup(body, secret) {
    const envelope = parseCurrentEnvelope(body);
    const key = deriveScryptKey(secret, envelope.salt);
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, envelope.iv);
        const headerLength = Buffer.alloc(HEADER_LENGTH_BYTES);
        headerLength.writeUInt32BE(envelope.headerBytes.length, 0);
        decipher.setAAD(Buffer.concat([CURRENT_MAGIC, headerLength, envelope.headerBytes]));
        decipher.setAuthTag(envelope.tag);
        return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
    } catch {
        throw backupError('backup_authentication_failed');
    } finally {
        key.fill(0);
        envelope.salt.fill(0);
    }
}

function decryptLegacyBackup(body, secret) {
    if (body.length < LEGACY_MAGIC.length + IV_BYTES + AUTH_TAG_BYTES + 1) throw backupError('backup_format_invalid');
    const key = crypto.createHash('sha256').update(secret, 'utf8').digest();
    try {
        const ivStart = LEGACY_MAGIC.length;
        const tagStart = ivStart + IV_BYTES;
        const ciphertextStart = tagStart + AUTH_TAG_BYTES;
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, body.subarray(ivStart, tagStart));
        decipher.setAuthTag(body.subarray(tagStart, ciphertextStart));
        return Buffer.concat([decipher.update(body.subarray(ciphertextStart)), decipher.final()]);
    } catch {
        throw backupError('backup_authentication_failed');
    } finally {
        key.fill(0);
    }
}

function decryptBackup(input, secretInput, { allowLegacyPassword = false } = {}) {
    const body = Buffer.from(input || []);
    if (body.subarray(0, CURRENT_MAGIC.length).equals(CURRENT_MAGIC)) {
        return decryptCurrentBackup(body, requireStrongBackupSecret(secretInput));
    }
    if (body.subarray(0, LEGACY_MAGIC.length).equals(LEGACY_MAGIC)) {
        if (!allowLegacyPassword) throw backupError('backup_format_invalid');
        return decryptLegacyBackup(body, requireLegacyBackupPassword(secretInput));
    }
    throw backupError('backup_format_invalid');
}

module.exports = {
    AUTH_TAG_BYTES,
    BackupEncryptionError,
    CURRENT_MAGIC,
    GENERATED_KEY_PROVENANCE,
    LEGACY_MAGIC,
    MIN_SECRET_BYTES,
    OPERATOR_ATTESTED_KEY_PROVENANCE,
    PUBLIC_DEFAULT_SECRET,
    SCRYPT_PARAMS,
    decryptBackup,
    encryptBackup,
    generateBackupSecret,
    parseCurrentEnvelope,
    provisionDataEnv,
    requireConfiguredBackupSecret,
    requireLegacyBackupPassword,
    requireStrongBackupSecret,
};
