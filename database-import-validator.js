'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { prepareAndValidateImportedAuthenticationState } = require('./database-import-auth-state');
const {
    assertDirectoryIdentity,
    closeDirectoryIdentity,
    directoryEntryPath,
    openDirectoryIdentity,
    removeFileDurably,
    sameIdentity,
    verifyNamedIdentity,
} = require('./durable-file');

const VALIDATION_TIMEOUT_MS = 60_000;
const MAX_DIAGNOSTIC_BYTES = 8 * 1024;

function validationError(message, detail = '') {
    const error = new Error(message);
    error.code = 'import_validation_failed';
    if (detail) error.detail = detail;
    return error;
}

function appendBounded(current, chunk) {
    const next = current + String(chunk || '');
    return next.length > MAX_DIAGNOSTIC_BYTES ? next.slice(-MAX_DIAGNOSTIC_BYTES) : next;
}

function safeChildDiagnostic(error) {
    const name = String(error?.name || 'Error').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
    const code = String(error?.code || 'import_validation_failed').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
    const message = String(error?.message || '')
        .replace(/[\r\n\0]/g, ' ')
        .replace(/[^\x20-\x7e]/g, '?')
        .slice(0, 512);
    return `${name}:${code}:${message}`;
}

function openRegularFileIdentity(file, label) {
    const before = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (!before?.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
        throw validationError(`${label} is missing or invalid`);
    }
    const fd = fs.openSync(file, fs.constants.O_RDONLY | Number(fs.constants.O_NOFOLLOW || 0));
    try {
        const opened = fs.fstatSync(fd, { bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n || !sameIdentity(before, opened)) {
            throw validationError(`${label} changed while it was being opened`);
        }
        verifyNamedIdentity(file, opened, label);
        return opened;
    } finally {
        fs.closeSync(fd);
    }
}

function writeCandidateKey(directoryToken, keyBuffer) {
    const name = `.zephyr-import-validation-key-${process.pid}-${crypto.randomUUID()}.json`;
    const file = directoryEntryPath(directoryToken, name);
    let fd;
    let identity = null;
    try {
        assertDirectoryIdentity(directoryToken);
        fd = fs.openSync(
            file,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
                | Number(fs.constants.O_NOFOLLOW || 0),
            0o600,
        );
        identity = fs.fstatSync(fd, { bigint: true });
        if (!identity.isFile() || identity.nlink !== 1n) {
            throw validationError('backup validation key target is invalid');
        }
        fs.writeFileSync(fd, keyBuffer);
        fs.fsyncSync(fd);
        const completed = fs.fstatSync(fd, { bigint: true });
        if (!sameIdentity(identity, completed) || completed.nlink !== 1n) {
            throw validationError('backup validation key changed while it was being written');
        }
        fs.closeSync(fd);
        fd = undefined;
        assertDirectoryIdentity(directoryToken);
        verifyNamedIdentity(file, identity, 'backup validation key');
        return { file, name, identity };
    } catch (error) {
        if (fd !== undefined) fs.closeSync(fd);
        if (identity) {
            try {
                removeFileDurably(file, {
                    allowMissing: true,
                    expectedIdentity: identity,
                    parentToken: directoryToken,
                    label: 'backup validation key',
                });
            } catch {}
        }
        throw error;
    }
}

/**
 * Run the real storage initializer against an isolated candidate directory.
 * The child is allowed to migrate the candidate in place; no module in the
 * live process ever receives a handle to the candidate database.
 */
function validateDatabaseCandidate({
    candidateDir,
    keyBuffer = null,
    timeoutMs = VALIDATION_TIMEOUT_MS,
    nodePath = process.execPath,
    env = process.env,
    afterSpawn = null,
} = {}) {
    const directory = path.resolve(String(candidateDir || ''));
    const databaseFile = path.join(directory, 'zephyr.db');
    let directoryToken;
    try {
        directoryToken = openDirectoryIdentity(directory, {
            label: 'backup validation directory',
            requirePrivate: process.platform !== 'win32',
        });
    } catch {
        return Promise.reject(validationError('backup validation directory is invalid'));
    }
    const operationalDatabaseFile = directoryEntryPath(directoryToken, 'zephyr.db');
    let databaseIdentity;
    try {
        databaseIdentity = openRegularFileIdentity(operationalDatabaseFile, 'backup database');
    } catch (error) {
        closeDirectoryIdentity(directoryToken);
        return Promise.reject(validationError('backup database is missing'));
    }

    let key = null;
    try {
        if (keyBuffer) key = writeCandidateKey(directoryToken, keyBuffer);
    } catch (error) {
        closeDirectoryIdentity(directoryToken);
        return Promise.reject(error?.code === 'import_validation_failed'
            ? error
            : validationError('backup validation key could not be staged', error?.code || 'write_failed'));
    }
    const keyFile = key ? path.join(directory, key.name) : path.join(directory, 'crypto', 'ml-kem-768-keypair.json');
    const useInheritedDirectory = process.platform === 'linux';
    const childDirectory = useInheritedDirectory ? '/proc/self/fd/3' : directory;
    const childKeyFile = key
        ? path.join(childDirectory, key.name)
        : path.join(childDirectory, 'crypto', 'ml-kem-768-keypair.json');

    const childEnv = {
        ...env,
        ZEPHYR_DATA_DIR: childDirectory,
        ZEPHYR_DATA_MLKEM768_KEY_FILE: childKeyFile,
        ZEPHYR_IMPORT_VALIDATION_CHILD: '1',
        ZEPHYR_IMPORT_VALIDATION_GATE_FD: useInheritedDirectory ? '4' : '3',
    };
    if (keyBuffer) {
        delete childEnv.ZEPHYR_DATA_MLKEM768_PUBLIC_KEY_B64;
        delete childEnv.ZEPHYR_DATA_MLKEM768_SECRET_KEY_B64;
        delete childEnv.DATA_MLKEM768_PUBLIC_KEY_B64;
        delete childEnv.DATA_MLKEM768_SECRET_KEY_B64;
    }

    return new Promise((resolve, reject) => {
        let child;
        let stderr = '';
        let settled = false;
        let timeoutError = null;
        let timer = null;
        const finish = (error) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            closeDirectoryIdentity(directoryToken);
            if (error) reject(error);
            else resolve({ databaseFile, keyFile });
        };
        try {
            assertDirectoryIdentity(directoryToken);
            verifyNamedIdentity(operationalDatabaseFile, databaseIdentity, 'backup database');
            child = spawn(nodePath, [__filename], {
                cwd: __dirname,
                env: childEnv,
                stdio: useInheritedDirectory
                    ? ['ignore', 'ignore', 'pipe', directoryToken.fd, 'pipe']
                    : ['ignore', 'ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
        } catch (error) {
            finish(validationError('backup validation process failed', error?.code || 'spawn_failed'));
            return;
        }
        child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
        child.once('error', (error) => finish(validationError('backup validation process failed', error.code || 'spawn_failed')));
        child.once('exit', (code, signal) => {
            if (timeoutError) return finish(timeoutError);
            try {
                assertDirectoryIdentity(directoryToken);
                verifyNamedIdentity(databaseFile, databaseIdentity, 'backup database');
                if (key) verifyNamedIdentity(keyFile, key.identity, 'backup validation key');
            } catch (error) {
                return finish(validationError('backup validation directory changed during isolated validation'));
            }
            if (code === 0) return finish();
            const detail = stderr.trim() || signal || `exit_${code}`;
            return finish(validationError('backup database failed isolated validation', detail));
        });
        timer = setTimeout(() => {
            timeoutError = validationError('backup database validation timed out');
            try { child.kill('SIGKILL'); } catch {}
        }, Math.max(1_000, Math.min(120_000, Number(timeoutMs) || VALIDATION_TIMEOUT_MS)));
        timer.unref?.();
        try {
            if (typeof afterSpawn === 'function') afterSpawn(child);
            assertDirectoryIdentity(directoryToken);
            verifyNamedIdentity(databaseFile, databaseIdentity, 'backup database');
            child.stdio[useInheritedDirectory ? 4 : 3].end(Buffer.from([1]));
        } catch (error) {
            try { child.kill('SIGKILL'); } catch {}
            finish(validationError('backup validation directory changed before isolated validation'));
        }
    });
}

function assertIntegrity(db) {
    const quick = db.pragma('quick_check(1)');
    const quickRow = Array.isArray(quick) ? quick[0] : null;
    if (String(quickRow && Object.values(quickRow)[0] || '').toLowerCase() !== 'ok') {
        throw validationError('backup database integrity check failed');
    }
    const users = db.prepare('SELECT COUNT(*) AS count FROM users').get();
    if (!Number.isSafeInteger(Number(users?.count)) || Number(users.count) < 1) {
        throw validationError('backup database contains no account');
    }
}

function validateDecryption(storage) {
    storage.getUsersStore();
    storage.getConnectionsStore();
    storage.listProxies();
    storage.listSshKeys();
    storage.getSettings();
}

function assertCompleteWalCheckpoint(result) {
    if (!Array.isArray(result) || result.length !== 1) {
        throw validationError('backup database WAL checkpoint returned an invalid result');
    }
    const row = result[0];
    if (!row || typeof row !== 'object') {
        throw validationError('backup database WAL checkpoint returned an invalid result');
    }
    const values = {};
    for (const field of ['busy', 'log', 'checkpointed']) {
        if (!Object.prototype.hasOwnProperty.call(row, field)) {
            throw validationError('backup database WAL checkpoint returned an invalid result');
        }
        const value = row[field];
        if (typeof value !== 'number' || !Number.isFinite(value)
            || !Number.isSafeInteger(value) || value < 0) {
            throw validationError('backup database WAL checkpoint returned an invalid result');
        }
        values[field] = value;
    }
    if (values.busy !== 0) {
        throw validationError('backup database WAL checkpoint was busy');
    }
    if (values.checkpointed !== values.log) {
        throw validationError('backup database WAL checkpoint was incomplete');
    }
    return values;
}

function runValidationChild() {
    if (process.env.ZEPHYR_IMPORT_VALIDATION_CHILD !== '1') {
        throw validationError('validation child marker is missing');
    }
    const gateFd = Number(process.env.ZEPHYR_IMPORT_VALIDATION_GATE_FD);
    const gate = Buffer.alloc(1);
    if (!Number.isInteger(gateFd) || gateFd < 3 || fs.readSync(gateFd, gate, 0, 1, null) !== 1 || gate[0] !== 1) {
        throw validationError('validation child release gate is invalid');
    }
    const storage = require('./storage');
    let phase = 'storage_init';
    try {
        storage.init({
            hashPassword() {
                throw validationError('backup database contains no account');
            },
        });
        phase = 'integrity';
        assertIntegrity(storage.rawDb());
        phase = 'decryption';
        validateDecryption(storage);
        phase = 'authentication_state';
        // This is deliberately performed while ZEPHYR_DATA_DIR still points
        // at the private candidate directory. A rejected candidate can never
        // mutate the running database or retain imported credentials.
        prepareAndValidateImportedAuthenticationState(storage);
        phase = 'checkpoint';
        assertCompleteWalCheckpoint(storage.rawDb().pragma('wal_checkpoint(TRUNCATE)'));
        phase = 'complete';
    } catch (error) {
        error.validationPhase = phase;
        throw error;
    } finally {
        storage.close();
    }
}

if (require.main === module) {
    try {
        runValidationChild();
        process.exitCode = 0;
    } catch (error) {
        const phase = String(error?.validationPhase || 'unknown').replace(/[^a-z0-9_-]/gi, '_');
        process.stderr.write(`${phase}:${safeChildDiagnostic(error)}\n`);
        process.exitCode = 1;
    }
}

module.exports = {
    VALIDATION_TIMEOUT_MS,
    assertCompleteWalCheckpoint,
    validateDatabaseCandidate,
};
