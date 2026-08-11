'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const {
    copyFileAtomically,
    copyFileExclusiveDurably,
    fsyncDirectory,
    removeFileDurably,
    scrubPathDurably,
    sha256File,
    writeFileAtomically,
    writeFileExclusiveDurably,
} = require('./durable-file');

const JOURNAL_VERSION = 1;
const JOURNAL_NAME = '.zephyr-import-journal.v1.json';
const JOURNAL_AUTH_KEY_NAME = '.zephyr-import-journal-auth.v1.key';
const CLEANUP_NAME = '.zephyr-import-cleanup.v1.json';
const CLEANUP_CLAIM_NAME = '.zephyr-import-cleanup.v1.claim';
const CLEANUP_VERSION = 1;
const JOURNAL_STATES = new Set([
    'PREPARED',
    'INSTALLING',
    'INSTALLED',
    'COMMITTED',
    'ROLLING_BACK',
    'ROLLED_BACK',
]);
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAC_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const OWNER_START_TOKEN_PATTERN = /^[A-Za-z0-9._:-]{1,240}$/;
const JOURNAL_SIGNED_FIELDS = Object.freeze([
    'version',
    'id',
    'nonce',
    'state',
    'previousState',
    'transitionSequence',
    'databaseTarget',
    'databaseOldSha256',
    'databaseNewSha256',
    'keyChanged',
    'keyTarget',
    'keyOldSha256',
    'keyNewSha256',
    'createdAt',
    'updatedAt',
]);
const JOURNAL_FIELDS = Object.freeze([...JOURNAL_SIGNED_FIELDS, 'mac']);
const ALLOWED_TRANSITIONS = Object.freeze({
    PREPARED: new Set(['INSTALLING', 'ROLLING_BACK']),
    INSTALLING: new Set(['INSTALLED', 'ROLLING_BACK']),
    INSTALLED: new Set(['COMMITTED', 'ROLLING_BACK']),
    COMMITTED: new Set(),
    ROLLING_BACK: new Set(['ROLLED_BACK']),
    ROLLED_BACK: new Set(),
});
const activeCleanupLeases = new Map();
const CLEANUP_LEASE_FIELDS = Object.freeze([
    'version',
    'id',
    'nonce',
    'ownerPid',
    'ownerStartToken',
    'createdAt',
]);
const CLEANUP_CLAIM_FIELDS = Object.freeze([
    'version',
    'expectedId',
    'expectedNonce',
    'nonce',
    'ownerPid',
    'ownerStartToken',
    'createdAt',
]);

function invokeFault(options, stage) {
    if (typeof options?.faultInjector === 'function') options.faultInjector(stage);
}

function resolveLayout({ dataDir, databaseFile, keyFile, id }) {
    const root = path.resolve(dataDir);
    const databaseTarget = path.resolve(databaseFile);
    if (path.dirname(databaseTarget) !== root) {
        throw new Error('database import target must be directly inside the data directory');
    }
    return {
        dataDir: root,
        journalFile: path.join(root, JOURNAL_NAME),
        journalAuthKeyFile: path.join(root, JOURNAL_AUTH_KEY_NAME),
        cleanupFile: path.join(root, CLEANUP_NAME),
        cleanupClaimFile: path.join(root, CLEANUP_CLAIM_NAME),
        databaseTarget,
        keyTarget: keyFile ? path.resolve(keyFile) : null,
        databaseOld: id ? path.join(root, `.zephyr-import-${id}.old.db`) : null,
        databaseNew: id ? path.join(root, `.zephyr-import-${id}.new.db`) : null,
        keyOld: id ? path.join(root, `.zephyr-import-${id}.old.key`) : null,
        keyNew: id ? path.join(root, `.zephyr-import-${id}.new.key`) : null,
    };
}

function requireRegularFile(file, label) {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is unavailable`);
    return stat;
}

function fileMatches(file, expectedHash) {
    try {
        const stat = fs.lstatSync(file, { throwIfNoEntry: false });
        return Boolean(stat?.isFile() && !stat.isSymbolicLink() && sha256File(file) === expectedHash);
    } catch {
        return false;
    }
}

function importJournalError(message) {
    const error = new Error(message);
    error.code = 'database_import_recovery_failed';
    return error;
}

function hasExactFields(raw, expected) {
    const actual = Object.keys(raw).sort();
    const wanted = [...expected].sort();
    return actual.length === wanted.length && actual.every((field, index) => field === wanted[index]);
}

function requirePrivateRegularFile(file, label, expectedSize = null) {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink() || (expectedSize !== null && stat.size !== expectedSize)) {
        throw importJournalError(`${label} is invalid`);
    }
    if (process.platform !== 'win32') {
        if ((stat.mode & 0o077) !== 0) throw importJournalError(`${label} permissions are unsafe`);
        if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
            throw importJournalError(`${label} owner is invalid`);
        }
    }
    return stat;
}

function readJournalAuthKey(layout, { create = false } = {}) {
    let stat = fs.lstatSync(layout.journalAuthKeyFile, { throwIfNoEntry: false });
    if (!stat && create) {
        if (fs.existsSync(layout.journalFile)) {
            throw importJournalError('database import journal authentication key is unavailable');
        }
        const generated = crypto.randomBytes(32);
        try {
            writeFileAtomically(layout.journalAuthKeyFile, generated, {
                mode: 0o600,
                directoryMode: 0o700,
                stagePrefix: 'import:journal_auth_key',
                tempLabel: 'journal-auth',
            });
        } finally {
            generated.fill(0);
        }
        stat = fs.lstatSync(layout.journalAuthKeyFile, { throwIfNoEntry: false });
    }
    if (!stat) throw importJournalError('database import journal authentication key is unavailable');
    requirePrivateRegularFile(layout.journalAuthKeyFile, 'database import journal authentication key', 32);
    return fs.readFileSync(layout.journalAuthKeyFile);
}

function canonicalJournalBytes(journal) {
    return Buffer.from(
        `zephyr.database-import-journal.v1\n${JSON.stringify(
            JOURNAL_SIGNED_FIELDS.map((field) => [field, journal[field]]),
        )}\n`,
        'utf8',
    );
}

function journalMac(layout, journal) {
    const key = readJournalAuthKey(layout);
    try {
        return crypto.createHmac('sha256', key).update(canonicalJournalBytes(journal)).digest('base64url');
    } finally {
        key.fill(0);
    }
}

function validateStateLineage(raw) {
    if (!Number.isSafeInteger(raw.transitionSequence) || raw.transitionSequence < 0 || raw.transitionSequence > 4) {
        return false;
    }
    if (raw.state === 'PREPARED') return raw.previousState === null && raw.transitionSequence === 0;
    if (raw.state === 'INSTALLING') return raw.previousState === 'PREPARED' && raw.transitionSequence === 1;
    if (raw.state === 'INSTALLED') return raw.previousState === 'INSTALLING' && raw.transitionSequence === 2;
    if (raw.state === 'COMMITTED') return raw.previousState === 'INSTALLED' && raw.transitionSequence === 3;
    if (raw.state === 'ROLLING_BACK') {
        return ['PREPARED', 'INSTALLING', 'INSTALLED'].includes(raw.previousState)
            && raw.transitionSequence === ['PREPARED', 'INSTALLING', 'INSTALLED'].indexOf(raw.previousState) + 1;
    }
    return raw.state === 'ROLLED_BACK'
        && raw.previousState === 'ROLLING_BACK'
        && raw.transitionSequence >= 2
        && raw.transitionSequence <= 4;
}

function validateJournal(raw, layout) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
        || !hasExactFields(raw, JOURNAL_FIELDS)
        || raw.version !== JOURNAL_VERSION
        || !ID_PATTERN.test(String(raw.id || ''))
        || !NONCE_PATTERN.test(String(raw.nonce || ''))
        || !JOURNAL_STATES.has(raw.state)
        || !validateStateLineage(raw)
        || path.resolve(String(raw.databaseTarget || '')) !== layout.databaseTarget
        || !HASH_PATTERN.test(String(raw.databaseOldSha256 || ''))
        || !HASH_PATTERN.test(String(raw.databaseNewSha256 || ''))
        || typeof raw.keyChanged !== 'boolean'
        || !Number.isSafeInteger(raw.createdAt)
        || !Number.isSafeInteger(raw.updatedAt)
        || raw.createdAt <= 0
        || raw.updatedAt < raw.createdAt
        || !MAC_PATTERN.test(String(raw.mac || ''))) {
        throw importJournalError('database import journal is invalid');
    }
    if (raw.keyChanged) {
        if (!layout.keyTarget
            || path.resolve(String(raw.keyTarget || '')) !== layout.keyTarget
            || !HASH_PATTERN.test(String(raw.keyOldSha256 || ''))
            || !HASH_PATTERN.test(String(raw.keyNewSha256 || ''))) {
            throw importJournalError('database import key journal is invalid');
        }
    } else if (raw.keyTarget !== null || raw.keyOldSha256 !== null || raw.keyNewSha256 !== null) {
        throw importJournalError('database import journal contains unexpected key state');
    }
    const supplied = Buffer.from(raw.mac, 'base64url');
    const expected = Buffer.from(journalMac(layout, raw), 'base64url');
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
        throw importJournalError('database import journal authentication failed');
    }
    return Object.freeze({ ...raw });
}

function readJournal(layout) {
    const stat = fs.lstatSync(layout.journalFile, { throwIfNoEntry: false });
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 16 * 1024) {
        throw importJournalError('database import journal file is invalid');
    }
    requirePrivateRegularFile(layout.journalFile, 'database import journal file');
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(layout.journalFile, 'utf8'));
    } catch {
        throw importJournalError('database import journal cannot be decoded');
    }
    return validateJournal(parsed, layout);
}

function persistJournal(layout, journal, state, options = {}) {
    if (!JOURNAL_STATES.has(state)) throw new Error('database import journal state is invalid');
    const current = fs.existsSync(layout.journalFile) ? readJournal(layout) : null;
    if (current) {
        if (current.id !== journal.id || current.nonce !== journal.nonce || current.mac !== journal.mac) {
            throw importJournalError('database import journal identity changed during transition');
        }
        if (!ALLOWED_TRANSITIONS[current.state]?.has(state)) {
            throw importJournalError(`database import journal transition ${current.state} to ${state} is invalid`);
        }
    } else if (state !== 'PREPARED' || journal.transitionSequence !== 0) {
        throw importJournalError('database import journal initial transition is invalid');
    }
    const next = {
        ...journal,
        state,
        previousState: current ? current.state : null,
        transitionSequence: current ? current.transitionSequence + 1 : 0,
        updatedAt: Date.now(),
    };
    delete next.mac;
    next.mac = journalMac(layout, next);
    writeFileAtomically(layout.journalFile, `${JSON.stringify(next)}\n`, {
        mode: 0o600,
        faultInjector: options.faultInjector,
        stagePrefix: `import:journal:${state.toLowerCase()}`,
        tempLabel: 'journal',
    });
    invokeFault(options, `after_journal_${state.toLowerCase()}`);
    return Object.freeze(next);
}

function removeDatabaseSidecars(databaseFile, options = {}) {
    for (const suffix of ['-wal', '-shm']) {
        removeFileDurably(`${databaseFile}${suffix}`, {
            allowMissing: true,
            faultInjector: options.faultInjector,
            stagePrefix: `import:database_sidecar${suffix}`,
        });
    }
}

function snapshotFor(layout, generation, kind) {
    if (kind === 'database') return generation === 'new' ? layout.databaseNew : layout.databaseOld;
    return generation === 'new' ? layout.keyNew : layout.keyOld;
}

function expectedHash(journal, generation, kind) {
    const suffix = generation === 'new' ? 'NewSha256' : 'OldSha256';
    return journal[`${kind}${suffix}`];
}

function generationAvailable(layout, journal, generation) {
    const databaseHash = expectedHash(journal, generation, 'database');
    const databaseAvailable = fileMatches(layout.databaseTarget, databaseHash)
        || fileMatches(snapshotFor(layout, generation, 'database'), databaseHash);
    if (!databaseAvailable) return false;
    if (!journal.keyChanged) return true;
    const keyHash = expectedHash(journal, generation, 'key');
    return fileMatches(layout.keyTarget, keyHash)
        || fileMatches(snapshotFor(layout, generation, 'key'), keyHash);
}

function generationInstalled(layout, journal, generation) {
    if (!fileMatches(layout.databaseTarget, expectedHash(journal, generation, 'database'))) return false;
    return !journal.keyChanged
        || fileMatches(layout.keyTarget, expectedHash(journal, generation, 'key'));
}

function applyGeneration(layout, journal, generation, options = {}) {
    if (!['old', 'new'].includes(generation)) throw new Error('database import generation is invalid');
    const databaseHash = expectedHash(journal, generation, 'database');
    if (journal.keyChanged) {
        const keyHash = expectedHash(journal, generation, 'key');
        if (!fileMatches(layout.keyTarget, keyHash)) {
            const keySnapshot = snapshotFor(layout, generation, 'key');
            if (!fileMatches(keySnapshot, keyHash)) {
                throw importJournalError(`database import ${generation} key snapshot is unavailable`);
            }
            if (typeof options.installKeyBuffer !== 'function') {
                throw importJournalError('database import key installer is unavailable');
            }
            const keyBuffer = fs.readFileSync(keySnapshot);
            try {
                options.installKeyBuffer(keyBuffer, {
                    faultInjector: options.faultInjector,
                    stagePrefix: `install:${generation}:key`,
                });
            } finally {
                keyBuffer.fill(0);
            }
            if (!fileMatches(layout.keyTarget, keyHash)) {
                throw importJournalError(`database import ${generation} key installation did not persist`);
            }
        }
        invokeFault(options, `after_${generation}_key_install`);
    }

    /* Sidecars are generation-bearing state too. Remove them even when the
     * main file already has the selected hash: a crash can occur after one
     * sidecar was removed but before the main-file replace, and accepting the
     * matching main DB must not leave the other sidecar live. */
    removeDatabaseSidecars(layout.databaseTarget, options);
    if (!fileMatches(layout.databaseTarget, databaseHash)) {
        const databaseSnapshot = snapshotFor(layout, generation, 'database');
        if (!fileMatches(databaseSnapshot, databaseHash)) {
            throw importJournalError(`database import ${generation} database snapshot is unavailable`);
        }
        copyFileAtomically(databaseSnapshot, layout.databaseTarget, {
            mode: 0o600,
            faultInjector: options.faultInjector,
            stagePrefix: `install:${generation}:database`,
            tempLabel: `import-${generation}`,
        });
        if (!fileMatches(layout.databaseTarget, databaseHash)) {
            throw importJournalError(`database import ${generation} database installation did not persist`);
        }
    }
    removeDatabaseSidecars(layout.databaseTarget, options);
    invokeFault(options, `after_${generation}_database_install`);
}

function scrubAndRemove(file, options = {}) {
    return scrubPathDurably(file, {
        allowMissing: true,
        faultInjector: options.faultInjector,
        stagePrefix: 'import:sensitive_cleanup',
    });
}

function processStartToken(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    try {
        if (process.platform === 'linux') {
            const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
            const closingParenthesis = stat.lastIndexOf(')');
            if (closingParenthesis < 0) return null;
            const fields = stat.slice(closingParenthesis + 1).trim().split(/\s+/);
            const startTicks = fields[19];
            const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
            if (!/^[0-9a-f-]{36}$/i.test(bootId) || !/^\d+$/.test(startTicks || '')) return null;
            return `linux.${bootId}.${startTicks}`;
        }
        if (process.platform === 'win32') {
            const command = [
                `$owner = Get-Process -Id ${pid} -ErrorAction Stop`,
                '[Console]::Out.Write($owner.StartTime.ToUniversalTime().Ticks)',
            ].join('; ');
            const result = spawnSync('powershell.exe', [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                command,
            ], {
                encoding: 'utf8',
                windowsHide: true,
                timeout: 3_000,
            });
            const ticks = String(result.stdout || '').trim();
            return /^\d{15,20}$/.test(ticks) ? `windows.${ticks}` : null;
        }
        const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
            encoding: 'utf8',
            timeout: 3_000,
        });
        const startedAt = String(result.stdout || '').trim();
        return startedAt
            ? `posix.${crypto.createHash('sha256').update(startedAt).digest('hex')}`
            : null;
    } catch {
        return null;
    }
}

function ownerIdentityForCurrentProcess() {
    /* Querying Windows process creation time requires a PowerShell process in
     * stock Node. Do not put that synchronous startup on every import/crash
     * path: an unverified token is still persistent, and a live PID is then
     * deliberately retained rather than risk a PID-reuse takeover. */
    const startToken = process.platform === 'win32' ? null : processStartToken(process.pid);
    return Object.freeze({
        ownerPid: process.pid,
        /* An unavailable OS start token is deliberately not treated as
         * evidence that a future PID is a different process. In that case we
         * can still recover after ESRCH, but retain a live lease fail-closed. */
        ownerStartToken: startToken
            || `unverified.${crypto.randomBytes(32).toString('hex')}`,
    });
}

const currentProcessOwner = ownerIdentityForCurrentProcess();

function hasValidCleanupOwner(raw) {
    return Number.isSafeInteger(raw.ownerPid)
        && raw.ownerPid > 0
        && OWNER_START_TOKEN_PATTERN.test(String(raw.ownerStartToken || ''));
}

function sameCleanupLease(left, right) {
    return Boolean(left && right
        && left.id === right.id
        && left.nonce === right.nonce
        && left.ownerPid === right.ownerPid
        && left.ownerStartToken === right.ownerStartToken);
}

function sameCleanupClaim(left, right) {
    return Boolean(left && right
        && left.expectedId === right.expectedId
        && left.expectedNonce === right.expectedNonce
        && left.nonce === right.nonce
        && left.ownerPid === right.ownerPid
        && left.ownerStartToken === right.ownerStartToken);
}

function isHeldByCurrentProcess(lease) {
    return lease?.ownerPid === currentProcessOwner.ownerPid
        && lease?.ownerStartToken === currentProcessOwner.ownerStartToken;
}

function ownerIsProvenDead(owner) {
    if (!hasValidCleanupOwner(owner)) return false;
    const expectedStartToken = owner.ownerStartToken;
    if (owner.ownerPid === currentProcessOwner.ownerPid) {
        /* This process cannot be a recycled incarnation of its own PID. */
        return false;
    }
    try {
        process.kill(owner.ownerPid, 0);
    } catch (error) {
        return error?.code === 'ESRCH';
    }
    if (expectedStartToken.startsWith('unverified.')) return false;
    const observedStartToken = processStartToken(owner.ownerPid);
    if (observedStartToken) {
        /* A live PID with a mismatched creation token is a different process,
         * not a reason to wait on the dead holder's lease. */
        return !expectedStartToken.startsWith('unverified.')
            && observedStartToken !== expectedStartToken;
    }
    return false;
}

function readPrivateJsonFile(file, label, expectedFields, validate) {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return null;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 4096) {
        throw importJournalError(`${label} is invalid`);
    }
    requirePrivateRegularFile(file, label);
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        throw importJournalError(`${label} cannot be decoded`);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
        || !hasExactFields(raw, expectedFields)
        || !validate(raw)) {
        throw importJournalError(`${label} is invalid`);
    }
    return Object.freeze({ ...raw });
}

function readCleanupLease(layout) {
    return readPrivateJsonFile(
        layout.cleanupFile,
        'database import cleanup marker',
        CLEANUP_LEASE_FIELDS,
        (raw) => raw.version === CLEANUP_VERSION
            && ID_PATTERN.test(String(raw.id || ''))
            && NONCE_PATTERN.test(String(raw.nonce || ''))
            && hasValidCleanupOwner(raw)
            && Number.isSafeInteger(raw.createdAt)
            && raw.createdAt > 0,
    );
}

function readCleanupClaim(layout) {
    return readPrivateJsonFile(
        layout.cleanupClaimFile,
        'database import cleanup lease claim',
        CLEANUP_CLAIM_FIELDS,
        (raw) => raw.version === CLEANUP_VERSION
            && ID_PATTERN.test(String(raw.expectedId || ''))
            && NONCE_PATTERN.test(String(raw.expectedNonce || ''))
            && NONCE_PATTERN.test(String(raw.nonce || ''))
            && hasValidCleanupOwner(raw)
            && Number.isSafeInteger(raw.createdAt)
            && raw.createdAt > 0,
    );
}

function privatePublicationTemp(file, label) {
    return path.join(
        path.dirname(file),
        `.${path.basename(file)}.${label}-${process.pid}-${crypto.randomUUID()}.tmp`,
    );
}

function samePrivateFileIdentity(left, right) {
    return Boolean(left && right
        && left.ino === right.ino
        && (process.platform === 'win32' || left.dev === right.dev));
}

function removePrivatePublicationTemp(file, expectedIdentity, stagePrefix) {
    const current = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!current || !current.isFile() || current.isSymbolicLink()
        || !samePrivateFileIdentity(current, expectedIdentity)) return false;
    fs.unlinkSync(file);
    fsyncDirectory(path.dirname(file), { stagePrefix });
    return true;
}

function publishPrivateJsonNoReplace(file, value, {
    stagePrefix,
    tempLabel,
    beforePublish = null,
} = {}) {
    const tempFile = privatePublicationTemp(file, tempLabel);
    const flags = fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0);
    let fd;
    let tempIdentity = null;
    let operationError = null;
    let published = false;
    try {
        fd = fs.openSync(tempFile, flags, 0o600);
        tempIdentity = fs.fstatSync(fd);
        /* Field insertion order is fixed by the lease/claim constructors;
         * materialize exactly those complete bytes before publication. */
        fs.writeFileSync(fd, Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'));
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.chmodSync(tempFile, 0o600);
        fsyncDirectory(path.dirname(tempFile), { stagePrefix: `${stagePrefix}:temp` });
        if (typeof beforePublish === 'function') beforePublish();
        try {
            /* link(2)/CreateHardLink is atomic create-if-absent when both
             * names are in this directory. Never replace a winner with rename:
             * filesystems without hard-link support fail closed instead. */
            fs.linkSync(tempFile, file);
            published = true;
            fsyncDirectory(path.dirname(file), { stagePrefix });
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
        }
    } catch (error) {
        operationError = error;
    } finally {
        const cleanupErrors = [];
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch (error) { cleanupErrors.push(error); }
        }
        if (tempIdentity) {
            try {
                removePrivatePublicationTemp(tempFile, tempIdentity, `${stagePrefix}:temp_cleanup`);
            } catch (error) {
                cleanupErrors.push(error);
            }
        }
        if (cleanupErrors.length) {
            throw new AggregateError(
                operationError ? [operationError, ...cleanupErrors] : cleanupErrors,
                `${stagePrefix} private publication temporary cleanup failed`,
            );
        }
    }
    if (operationError) throw operationError;
    return published;
}

function tryCreateCleanupLease(layout, lease, beforePublish = null) {
    try {
        return publishPrivateJsonNoReplace(layout.cleanupFile, lease, {
            stagePrefix: 'import:cleanup_marker',
            tempLabel: 'cleanup',
            beforePublish,
        });
    } catch (error) {
        if (error?.code === 'EEXIST') return false;
        throw error;
    }
}

function tryCreateCleanupClaim(layout, claim) {
    try {
        return publishPrivateJsonNoReplace(layout.cleanupClaimFile, claim, {
            stagePrefix: 'import:cleanup_claim',
            tempLabel: 'cleanup-claim',
        });
    } catch (error) {
        if (error?.code === 'EEXIST') return false;
        throw error;
    }
}

function removeCleanupLeaseIfExact(layout, lease) {
    const current = readCleanupLease(layout);
    if (!sameCleanupLease(current, lease) || !isHeldByCurrentProcess(lease)) {
        throw importJournalError('database import cleanup lease is unavailable');
    }
    fs.unlinkSync(layout.cleanupFile);
    fsyncDirectory(layout.dataDir, { stagePrefix: 'import:cleanup_marker' });
    return current;
}

function removeStaleCleanupLeaseAfterClaim(layout, staleLease, claim) {
    const currentClaim = readCleanupClaim(layout);
    const currentLease = readCleanupLease(layout);
    if (!sameCleanupClaim(currentClaim, claim)
        || !isHeldByCurrentProcess(claim)
        || !sameCleanupLease(currentLease, staleLease)
        || !ownerIsProvenDead(currentLease)) {
        return false;
    }
    fs.unlinkSync(layout.cleanupFile);
    fsyncDirectory(layout.dataDir, { stagePrefix: 'import:cleanup_marker' });
    return true;
}

function removeCleanupClaimIfExact(layout, claim) {
    const current = readCleanupClaim(layout);
    if (!sameCleanupClaim(current, claim) || !isHeldByCurrentProcess(claim)) return false;
    fs.unlinkSync(layout.cleanupClaimFile);
    fsyncDirectory(layout.dataDir, { stagePrefix: 'import:cleanup_claim' });
    return true;
}

function removeStaleCleanupClaimAfterProof(layout, staleClaim) {
    const current = readCleanupClaim(layout);
    if (!sameCleanupClaim(current, staleClaim) || !ownerIsProvenDead(current)) return false;
    fs.unlinkSync(layout.cleanupClaimFile);
    fsyncDirectory(layout.dataDir, { stagePrefix: 'import:cleanup_claim' });
    return true;
}

function createCleanupLease() {
    return Object.freeze({
        version: CLEANUP_VERSION,
        id: crypto.randomUUID(),
        nonce: crypto.randomBytes(32).toString('base64url'),
        ...currentProcessOwner,
        createdAt: Date.now(),
    });
}

function forgetLocalCleanupLease(layout, lease) {
    const local = activeCleanupLeases.get(layout.dataDir);
    if (sameCleanupLease(local, lease)) activeCleanupLeases.delete(layout.dataDir);
}

function currentLocalCleanupLease(layout) {
    const lease = activeCleanupLeases.get(layout.dataDir);
    if (!lease) return null;
    try {
        const current = readCleanupLease(layout);
        if (sameCleanupLease(current, lease) && isHeldByCurrentProcess(lease)) return lease;
    } catch {
        /* A local cache is never authority. Disk is checked again below. */
    }
    activeCleanupLeases.delete(layout.dataDir);
    return null;
}

function acquireDiskCleanupLease(layout, {
    allowActiveJournal = false,
    reuseCurrentProcessLease = false,
    beforeCleanupLeasePublish = null,
} = {}) {
    const local = currentLocalCleanupLease(layout);
    if (local) {
        if (reuseCurrentProcessLease) return local;
        throw importJournalError('a database import cleanup lease is already active');
    }
    if (!allowActiveJournal && fs.existsSync(layout.journalFile)) {
        throw importJournalError('a database import recovery journal is already active');
    }

    for (let attempts = 0; attempts < 16; attempts += 1) {
        const candidate = createCleanupLease();
        if (tryCreateCleanupLease(layout, candidate, beforeCleanupLeasePublish)) {
            activeCleanupLeases.set(layout.dataDir, candidate);
            return candidate;
        }

        const existing = readCleanupLease(layout);
        if (!existing) continue;
        if (!ownerIsProvenDead(existing)) {
            throw importJournalError('a database import cleanup lease is already active');
        }

        const claim = Object.freeze({
            version: CLEANUP_VERSION,
            expectedId: existing.id,
            expectedNonce: existing.nonce,
            nonce: crypto.randomBytes(32).toString('base64url'),
            ...currentProcessOwner,
            createdAt: Date.now(),
        });
        if (!tryCreateCleanupClaim(layout, claim)) {
            const activeClaim = readCleanupClaim(layout);
            if (!activeClaim || !ownerIsProvenDead(activeClaim)) {
                throw importJournalError('a database import cleanup lease is already active');
            }
            /* A claimant which has demonstrably died never obtained a marker
             * winner. Removing only its claim lets one later contender retry;
             * it never unlinks a cleanup marker. */
            removeStaleCleanupClaimAfterProof(layout, activeClaim);
            continue;
        }

        try {
            const current = readCleanupLease(layout);
            if (!sameCleanupLease(current, existing) || !ownerIsProvenDead(current)) continue;
            if (!removeStaleCleanupLeaseAfterClaim(layout, existing, claim)) continue;
            if (tryCreateCleanupLease(layout, candidate, beforeCleanupLeasePublish)) {
                activeCleanupLeases.set(layout.dataDir, candidate);
                return candidate;
            }
        } finally {
            /* A losing stale-recovery contender may only remove its own claim.
             * In particular, it must not unlink a marker created by a winner. */
            try { removeCleanupClaimIfExact(layout, claim); } catch {}
        }
    }
    throw importJournalError('database import cleanup lease contention did not settle');
}

function assertCleanupLease(layout, lease) {
    const current = readCleanupLease(layout);
    if (!sameCleanupLease(current, lease) || !isHeldByCurrentProcess(lease)) {
        throw importJournalError('database import cleanup lease is unavailable');
    }
    return current;
}

function assertTransactionCleanupLease(layout, transaction) {
    /* Normal beginImportInstall handles carry the exact disk-owner identity.
     * Keep older crash-recovery handles (id/nonce only) readable so a new
     * process can finish an already durable terminal journal after restart. */
    if (!Object.prototype.hasOwnProperty.call(transaction || {}, 'ownerPid')
        && !Object.prototype.hasOwnProperty.call(transaction || {}, 'ownerStartToken')) return;
    assertCleanupLease(resolveLayout({
        dataDir: layout.dataDir,
        databaseFile: layout.databaseTarget,
        keyFile: layout.keyTarget,
    }), transaction);
}

function cleanupTransactionArtifacts(layout, options = {}) {
    const failures = [];
    for (const file of [layout.databaseOld, layout.databaseNew, layout.keyOld, layout.keyNew]) {
        if (!file) continue;
        try { scrubAndRemove(file, options); } catch (error) { failures.push(error); }
    }
    return failures.length ? new AggregateError(failures, 'database import artifact cleanup failed') : null;
}

function finalizeDecision(layout, journal, options = {}) {
    /* Keep the authenticated terminal decision until every credential-bearing
     * snapshot has been scrubbed. A live owner can then retry finalization;
     * after a crash, recovery sees the same immutable COMMITTED/ROLLED_BACK
     * boundary instead of treating it as an unowned orphan cleanup. */
    const cleanupError = cleanupTransactionArtifacts(resolveLayout({
        dataDir: layout.dataDir,
        databaseFile: layout.databaseTarget,
        keyFile: layout.keyTarget,
        id: journal.id,
    }), options);
    if (cleanupError) return { cleanupError };
    try {
        removeFileDurably(layout.journalFile, {
            allowMissing: true,
            faultInjector: options.faultInjector,
            stagePrefix: 'import:journal:finalize',
        });
        invokeFault(options, 'after_journal_removed');
    } catch (error) {
        return { cleanupError: error };
    }
    return { cleanupError: null };
}

function cleanupImportOrphans({
    dataDir,
    databaseFile,
    keyFile,
    cleanupLease = null,
    retainLease = false,
} = {}) {
    const layout = resolveLayout({ dataDir, databaseFile, keyFile });
    if (fs.existsSync(layout.journalFile)) return;
    const heldLease = cleanupLease || currentLocalCleanupLease(layout)
        || acquireDiskCleanupLease(layout);
    assertCleanupLease(layout, heldLease);
    let entries = [];
    try { entries = fs.readdirSync(layout.dataDir, { withFileTypes: true }); } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
    }
    const failures = [];
    for (const entry of entries) {
        const importArtifact = /^\.zephyr-import-[0-9a-f-]{36}\.(?:old|new)\.(?:db|key)$/.test(entry.name);
        const journalTemp = /^\.\.zephyr-import-journal\.v1\.json\.journal-[0-9a-z-]+\.tmp$/i.test(entry.name);
        const authKeyTemp = /^\.\.zephyr-import-journal-auth\.v1\.key\.journal-auth-[0-9a-z-]+\.tmp$/i.test(entry.name);
        const cleanupTemp = /^\.\.zephyr-import-cleanup\.v1\.json\.cleanup-[0-9a-z-]+\.tmp$/i.test(entry.name);
        const cleanupClaimTemp = /^\.\.zephyr-import-cleanup\.v1\.claim\.cleanup-claim-[0-9a-z-]+\.tmp$/i.test(entry.name);
        const legacyArtifact = /^\.zephyr-import-(?:rollback|install)-[0-9a-z-]+\.db$/i.test(entry.name);
        const archiveArtifact = /^\.zephyr-import-archive-[0-9a-z-]+\.zip$/i.test(entry.name);
        const validationDirectory = /^\.zephyr-import-validation-[0-9a-z_-]+$/i.test(entry.name);
        if (!(importArtifact || journalTemp || authKeyTemp || cleanupClaimTemp
            || legacyArtifact || archiveArtifact || validationDirectory)) continue;
        const target = path.join(layout.dataDir, entry.name);
        if (path.dirname(path.resolve(target)) !== layout.dataDir) continue;
        try {
            scrubAndRemove(target);
        } catch (error) { failures.push(error); }
    }

    const cleanupTargetTemps = (targetFile, labels) => {
        if (!targetFile) return;
        const resolvedTarget = path.resolve(targetFile);
        const directory = path.dirname(resolvedTarget);
        const escapedBase = path.basename(resolvedTarget).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedLabels = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        const pattern = new RegExp(`^\\.${escapedBase}\\.(?:${escapedLabels})-\\d+-[0-9a-f-]{36}\\.tmp$`, 'i');
        let siblings = [];
        try { siblings = fs.readdirSync(directory, { withFileTypes: true }); } catch (error) {
            if (error?.code !== 'ENOENT') failures.push(error);
            return;
        }
        for (const sibling of siblings) {
            if (!pattern.test(sibling.name)) continue;
            const candidate = path.join(directory, sibling.name);
            if (path.dirname(path.resolve(candidate)) !== directory) continue;
            try { scrubAndRemove(candidate); } catch (error) { failures.push(error); }
        }
        try { fsyncDirectory(directory); } catch (error) { failures.push(error); }
    };
    cleanupTargetTemps(layout.databaseTarget, ['import-old', 'import-new']);
    cleanupTargetTemps(layout.keyTarget, ['key', 'restore-key']);

    try { fsyncDirectory(layout.dataDir); } catch (error) { failures.push(error); }
    if (failures.length) {
        throw new AggregateError(failures, 'interrupted database import artifacts could not be removed');
    }
    if (!retainLease) {
        removeCleanupLeaseIfExact(layout, heldLease);
        forgetLocalCleanupLease(layout, heldLease);
    }
}

function acquireImportCleanupLease({
    dataDir,
    databaseFile,
    keyFile = null,
    beforeCleanupLeasePublish = null,
} = {}) {
    const layout = resolveLayout({ dataDir, databaseFile, keyFile });
    const lease = acquireDiskCleanupLease(layout, { beforeCleanupLeasePublish });
    cleanupImportOrphans({
        dataDir,
        databaseFile,
        keyFile,
        cleanupLease: lease,
        retainLease: true,
    });
    const authKey = readJournalAuthKey(layout, { create: true });
    authKey.fill(0);
    return lease;
}

function beginImportInstall({
    dataDir,
    databaseFile,
    candidateDatabaseFile,
    keyFile = null,
    incomingKeyBuffer = null,
    keyChanged = false,
    cleanupLease = null,
    faultInjector = null,
} = {}) {
    const baseLayout = resolveLayout({ dataDir, databaseFile, keyFile });
    const activeCleanupLease = cleanupLease
        ? assertCleanupLease(baseLayout, cleanupLease)
        : acquireImportCleanupLease({ dataDir, databaseFile, keyFile });
    const id = activeCleanupLease.id;
    const layout = resolveLayout({ dataDir, databaseFile, keyFile, id });
    if (fs.existsSync(layout.journalFile)) {
        throw importJournalError('a database import recovery journal is already active');
    }
    requireRegularFile(layout.databaseTarget, 'live database');
    requireRegularFile(candidateDatabaseFile, 'candidate database');
    if (keyChanged) {
        if (!layout.keyTarget || !incomingKeyBuffer?.length) throw new Error('database import key generation is incomplete');
        requireRegularFile(layout.keyTarget, 'live data key');
    }

    const created = [];
    try {
        copyFileExclusiveDurably(layout.databaseTarget, layout.databaseOld, {
            mode: 0o600,
            faultInjector,
            stagePrefix: 'import:snapshot:old_database',
        });
        created.push(layout.databaseOld);
        copyFileExclusiveDurably(candidateDatabaseFile, layout.databaseNew, {
            mode: 0o600,
            faultInjector,
            stagePrefix: 'import:snapshot:new_database',
        });
        created.push(layout.databaseNew);

        let keyOldSha256 = null;
        let keyNewSha256 = null;
        if (keyChanged) {
            copyFileExclusiveDurably(layout.keyTarget, layout.keyOld, {
                mode: 0o600,
                faultInjector,
                stagePrefix: 'import:snapshot:old_key',
            });
            created.push(layout.keyOld);
            writeFileExclusiveDurably(layout.keyNew, incomingKeyBuffer, {
                mode: 0o600,
                faultInjector,
                stagePrefix: 'import:snapshot:new_key',
            });
            created.push(layout.keyNew);
            keyOldSha256 = sha256File(layout.keyOld);
            keyNewSha256 = sha256File(layout.keyNew);
        }

        const journal = {
            version: JOURNAL_VERSION,
            id,
            nonce: activeCleanupLease.nonce,
            state: 'PREPARED',
            previousState: null,
            transitionSequence: 0,
            databaseTarget: layout.databaseTarget,
            databaseOldSha256: sha256File(layout.databaseOld),
            databaseNewSha256: sha256File(layout.databaseNew),
            keyChanged: Boolean(keyChanged),
            keyTarget: keyChanged ? layout.keyTarget : null,
            keyOldSha256,
            keyNewSha256,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        persistJournal(layout, journal, 'PREPARED', { faultInjector });
        return Object.freeze({
            id,
            nonce: activeCleanupLease.nonce,
            ownerPid: activeCleanupLease.ownerPid,
            ownerStartToken: activeCleanupLease.ownerStartToken,
            dataDir: layout.dataDir,
            databaseFile: layout.databaseTarget,
            keyFile: layout.keyTarget,
        });
    } catch (error) {
        if (!fs.existsSync(layout.journalFile)) {
            const cleanupFailures = [];
            for (const file of created) {
                try { scrubAndRemove(file); } catch (cleanupError) { cleanupFailures.push(cleanupError); }
            }
            if (cleanupFailures.length) {
                throw new AggregateError([error, ...cleanupFailures], 'database import setup and sensitive cleanup failed');
            }
        }
        throw error;
    }
}

function installPreparedImport(transaction, options = {}) {
    const layout = resolveLayout({
        dataDir: transaction.dataDir,
        databaseFile: transaction.databaseFile,
        keyFile: transaction.keyFile,
        id: transaction.id,
    });
    let journal = readJournal(layout);
    if (!journal || journal.id !== transaction.id || journal.nonce !== transaction.nonce || journal.state !== 'PREPARED') {
        throw importJournalError('database import is not in the prepared state');
    }
    assertTransactionCleanupLease(layout, transaction);
    journal = persistJournal(layout, journal, 'INSTALLING', options);
    applyGeneration(layout, journal, 'new', options);
    persistJournal(layout, journal, 'INSTALLED', options);
}

function commitImportInstall(transaction, options = {}) {
    const layout = resolveLayout({
        dataDir: transaction.dataDir,
        databaseFile: transaction.databaseFile,
        keyFile: transaction.keyFile,
        id: transaction.id,
    });
    let journal = readJournal(layout);
    if (!journal || journal.id !== transaction.id || journal.nonce !== transaction.nonce) {
        throw importJournalError('database import is not ready to commit');
    }
    assertTransactionCleanupLease(layout, transaction);
    if (journal.state === 'COMMITTED') return finalizeDecision(layout, journal, options);
    if (journal.state !== 'INSTALLED') throw importJournalError('database import is not ready to commit');
    if (!generationInstalled(layout, journal, 'new')) {
        throw importJournalError('installed database import generation is incomplete');
    }
    journal = persistJournal(layout, journal, 'COMMITTED', options);
    return finalizeDecision(layout, journal, options);
}

function rollbackImportInstall(transaction, options = {}) {
    const layout = resolveLayout({
        dataDir: transaction.dataDir,
        databaseFile: transaction.databaseFile,
        keyFile: transaction.keyFile,
        id: transaction.id,
    });
    let journal = readJournal(layout);
    if (!journal || journal.id !== transaction.id || journal.nonce !== transaction.nonce) {
        throw importJournalError('database import rollback journal is unavailable');
    }
    assertTransactionCleanupLease(layout, transaction);
    if (journal.state === 'COMMITTED') {
        throw importJournalError('committed database import cannot be rolled back');
    }
    if (journal.state === 'ROLLED_BACK') return finalizeDecision(layout, journal, options);
    if (journal.state !== 'ROLLING_BACK') journal = persistJournal(layout, journal, 'ROLLING_BACK', options);
    applyGeneration(layout, journal, 'old', options);
    journal = persistJournal(layout, journal, 'ROLLED_BACK', options);
    return finalizeDecision(layout, journal, options);
}

function recoverImportInstall({
    dataDir,
    databaseFile,
    keyFile = null,
    installKeyBuffer = null,
    faultInjector = null,
} = {}) {
    const baseLayout = resolveLayout({ dataDir, databaseFile, keyFile });
    let journal = readJournal(baseLayout);
    if (!journal) {
        cleanupImportOrphans({ dataDir, databaseFile, keyFile });
        const authKey = readJournalAuthKey(baseLayout, { create: true });
        authKey.fill(0);
        return { recovered: false, generation: null };
    }
    const cleanupLease = acquireDiskCleanupLease(baseLayout, {
        allowActiveJournal: true,
        reuseCurrentProcessLease: true,
    });
    const layout = resolveLayout({ dataDir, databaseFile, keyFile, id: journal.id });
    const options = { installKeyBuffer, faultInjector };
    let generation = journal.state === 'COMMITTED' ? 'new' : 'old';

    if (!generationAvailable(layout, journal, generation)) {
        /* COMMITTED is the irreversible security boundary, not an availability
         * hint. Falling back to the pre-import generation here could revive
         * sessions or credentials which were intentionally revoked by the
         * committed candidate. Preserve the journal and fail before startup. */
        throw importJournalError(`database import ${generation} generation cannot be recovered`);
    } else if (generation === 'old' && journal.state !== 'ROLLING_BACK' && journal.state !== 'ROLLED_BACK') {
        journal = persistJournal(layout, journal, 'ROLLING_BACK', options);
    }

    applyGeneration(layout, journal, generation, options);
    if (generation === 'old' && journal.state !== 'ROLLED_BACK') {
        journal = persistJournal(layout, journal, 'ROLLED_BACK', options);
    }
    const finalized = finalizeDecision(layout, journal, options);
    if (finalized.cleanupError) throw finalized.cleanupError;
    cleanupImportOrphans({ dataDir, databaseFile, keyFile, cleanupLease });
    return { recovered: true, generation };
}

module.exports = {
    CLEANUP_NAME,
    JOURNAL_NAME,
    JOURNAL_AUTH_KEY_NAME,
    JOURNAL_VERSION,
    acquireImportCleanupLease,
    beginImportInstall,
    cleanupImportOrphans,
    commitImportInstall,
    installPreparedImport,
    recoverImportInstall,
    rollbackImportInstall,
};
