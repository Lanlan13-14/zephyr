'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WINDOWS_DIRECTORY_FSYNC_UNSUPPORTED = new Set([
    'EACCES',
    'EBADF',
    'EINVAL',
    'EISDIR',
    'ENOTSUP',
    'EPERM',
]);
const DURABLE_TOMBSTONE_PREFIX = '.zephyr-tombstone-v1-';
const MAX_DURABLE_TOMBSTONES_PER_DIRECTORY = 4096;
const MAX_DURABLE_TOMBSTONE_RECORDS = 4096;
const durableTombstoneRecords = new Map();

function lstatBigInt(file) {
    return fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
}

function fstatBigInt(fd) {
    return fs.fstatSync(fd, { bigint: true });
}

function sameIdentity(left, right) {
    return !!left && !!right && left.dev === right.dev && left.ino === right.ino;
}

function assertNoLinkedPathComponents(resolved, label) {
    const parsed = path.parse(resolved);
    const relative = resolved.slice(parsed.root.length);
    let current = parsed.root;
    for (const component of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, component);
        const stat = lstatBigInt(current);
        if (!stat) break;
        if (stat.isSymbolicLink()) {
            throw new Error(`${label} must not contain a symbolic link or junction`);
        }
    }
}

function assertPrivateDirectoryStat(stat, label) {
    if (process.platform === 'win32') return;
    const currentUid = typeof process.geteuid === 'function' ? BigInt(process.geteuid()) : stat.uid;
    if (stat.uid !== currentUid || (stat.mode & 0o22n) !== 0n) {
        throw new Error(`${label} must be owned by the service identity and not group/world writable`);
    }
}

function assertDirectoryIdentity(token) {
    if (!token || token.closed) throw new Error('directory identity token is closed');
    const opened = fstatBigInt(token.fd);
    const named = lstatBigInt(token.path);
    if (!opened.isDirectory() || !named?.isDirectory() || named.isSymbolicLink()
        || !sameIdentity(token.identity, opened) || !sameIdentity(token.identity, named)) {
        throw new Error(`${token.label} changed during secure filesystem access`);
    }
    if (token.requirePrivate) {
        assertPrivateDirectoryStat(opened, token.label);
        assertPrivateDirectoryStat(named, token.label);
    }
    return named;
}

function openDirectoryIdentity(directory, {
    label = 'directory',
    requirePrivate = false,
    rejectLinkedComponents = false,
} = {}) {
    const resolved = path.resolve(directory);
    if (rejectLinkedComponents) assertNoLinkedPathComponents(resolved, label);
    const before = lstatBigInt(resolved);
    if (!before?.isDirectory() || before.isSymbolicLink()) {
        throw new Error(`${label} must be one regular directory`);
    }
    if (requirePrivate) assertPrivateDirectoryStat(before, label);
    const flags = fs.constants.O_RDONLY
        | Number(fs.constants.O_DIRECTORY || 0)
        | Number(fs.constants.O_NOFOLLOW || 0);
    let fd;
    try {
        fd = fs.openSync(resolved, flags);
        const opened = fstatBigInt(fd);
        if (!opened.isDirectory() || !sameIdentity(before, opened)) {
            throw new Error(`${label} changed while it was being opened`);
        }
        const token = {
            path: resolved,
            fd,
            identity: opened,
            label,
            requirePrivate,
            closed: false,
        };
        assertDirectoryIdentity(token);
        return token;
    } catch (error) {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch {}
        }
        throw error;
    }
}

function closeDirectoryIdentity(token) {
    if (!token || token.closed) return;
    token.closed = true;
    fs.closeSync(token.fd);
}

function directoryEntryPath(token, name) {
    if (!token || token.closed || !name || path.basename(name) !== name) {
        throw new Error('directory entry name is invalid');
    }
    assertDirectoryIdentity(token);
    if (process.platform === 'linux') return `/proc/self/fd/${token.fd}/${name}`;
    return path.join(token.path, name);
}

function verifyNamedIdentity(file, expected, label = 'filesystem target') {
    const named = lstatBigInt(path.resolve(file));
    if (!named || !sameIdentity(named, expected)) {
        throw new Error(`${label} changed during secure filesystem access`);
    }
    return named;
}

function comparablePath(file) {
    const resolved = path.resolve(file);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function entryPathForParent(file, parent, label) {
    const resolved = path.resolve(file);
    const name = path.basename(resolved);
    const namedPath = path.join(parent.path, name);
    const descriptorPath = process.platform === 'linux'
        ? `/proc/self/fd/${parent.fd}/${name}`
        : namedPath;
    if (comparablePath(resolved) !== comparablePath(namedPath)
        && comparablePath(resolved) !== comparablePath(descriptorPath)) {
        throw new Error(`${label} is not an entry in the expected parent directory`);
    }
    return { name, file: directoryEntryPath(parent, name) };
}

function isDurableTombstoneName(name) {
    return typeof name === 'string' && name.startsWith(DURABLE_TOMBSTONE_PREFIX);
}

function tombstoneName(kind = 'entry') {
    return `${DURABLE_TOMBSTONE_PREFIX}${kind}-${process.pid}-${crypto.randomUUID()}`;
}

function recordDurableTombstone(parent, name, stat, state = 'retained') {
    const key = path.join(parent.path, name);
    durableTombstoneRecords.delete(key);
    durableTombstoneRecords.set(key, Object.freeze({
        path: key,
        state,
        directory: !!stat?.isDirectory(),
        observedAt: Date.now(),
    }));
    while (durableTombstoneRecords.size > MAX_DURABLE_TOMBSTONE_RECORDS) {
        durableTombstoneRecords.delete(durableTombstoneRecords.keys().next().value);
    }
}

function listDurableTombstoneRecords() {
    return [...durableTombstoneRecords.values()];
}

function directoryReadPath(token) {
    assertDirectoryIdentity(token);
    return process.platform === 'linux' ? `/proc/self/fd/${token.fd}` : token.path;
}

function createTombstoneBudget(parent) {
    const entries = fs.readdirSync(directoryReadPath(parent), { withFileTypes: true });
    assertDirectoryIdentity(parent);
    let existing = 0;
    for (const entry of entries) {
        if (!isDurableTombstoneName(entry.name)) continue;
        existing += 1;
        const stat = lstatBigInt(directoryEntryPath(parent, entry.name));
        recordDurableTombstone(parent, entry.name, stat, 'observed');
    }
    if (existing >= MAX_DURABLE_TOMBSTONES_PER_DIRECTORY) {
        throw new Error('durable tombstone limit has been reached for this directory');
    }
    return { remaining: MAX_DURABLE_TOMBSTONES_PER_DIRECTORY - existing };
}

function reserveTombstone(parent, budget, kind) {
    if (!budget || budget.remaining < 1) {
        throw new Error('durable tombstone limit has been reached for this directory');
    }
    budget.remaining -= 1;
    const name = tombstoneName(kind);
    const file = directoryEntryPath(parent, name);
    if (lstatBigInt(file)) throw new Error('durable tombstone name unexpectedly exists');
    return { name, file };
}

function assertSupportedRemovalType(stat, label) {
    if (process.platform === 'win32' && stat.isSymbolicLink()) {
        throw new Error(`${label} must not be a Windows reparse point`);
    }
    if (!stat.isFile() && !stat.isDirectory() && !stat.isSymbolicLink()) {
        throw new Error(`${label} has an unsupported filesystem type`);
    }
}

function openQuarantinedIdentity(file, expected, label, existingFd) {
    const named = verifyNamedIdentity(file, expected, label);
    assertSupportedRemovalType(named, label);

    let flags = (named.isFile() ? fs.constants.O_RDWR : fs.constants.O_RDONLY)
        | Number(fs.constants.O_NOFOLLOW || 0);
    if (named.isDirectory()) flags |= Number(fs.constants.O_DIRECTORY || 0);
    if (named.isSymbolicLink()) {
        if (process.platform !== 'linux') return { fd: undefined, named, ownsFd: false };
        // O_PATH is the Linux mechanism for opening a link itself with
        // O_NOFOLLOW, which lets fstat verify its identity without following it.
        flags |= 0o10000000;
    }

    let fd = existingFd;
    const ownsFd = fd === undefined;
    try {
        if (ownsFd) fd = fs.openSync(file, flags);
        const opened = fstatBigInt(fd);
        if (!sameIdentity(opened, expected)
            || opened.isFile() !== named.isFile()
            || opened.isDirectory() !== named.isDirectory()
            || opened.isSymbolicLink() !== named.isSymbolicLink()) {
            throw new Error(`${label} changed while its quarantine handle was being opened`);
        }
        verifyNamedIdentity(file, expected, label);
        return { fd, named: opened, ownsFd };
    } catch (error) {
        if (ownsFd && fd !== undefined) fs.closeSync(fd);
        throw error;
    }
}

function sanitizeOpenFile(fd, opened, label) {
    if (!opened.isFile() || opened.nlink !== 1n) {
        throw new Error(`${label} must be one regular file without another hard link`);
    }
    if (opened.size > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`${label} is too large for secure sanitization`);
    }
    if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
    const byteLength = Number(opened.size);
    const zeros = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, byteLength)));
    let offset = 0;
    while (offset < byteLength) {
        const length = Math.min(zeros.length, byteLength - offset);
        fs.writeSync(fd, zeros, 0, length, offset);
        offset += length;
    }
    fs.ftruncateSync(fd, 0);
    fs.fsyncSync(fd);
    const sanitized = fstatBigInt(fd);
    if (!sameIdentity(opened, sanitized) || !sanitized.isFile()
        || sanitized.nlink !== 1n || sanitized.size !== 0n) {
        throw new Error(`${label} changed while it was being sanitized`);
    }
    return sanitized;
}

function removeExpected(file, expected, options = {}, removeDirectory = false) {
    const resolved = path.resolve(file);
    const parent = options.parentToken || openDirectoryIdentity(path.dirname(resolved), {
        label: `${options.label || 'filesystem target'} parent directory`,
    });
    const ownsParent = !options.parentToken;
    const label = options.label || 'filesystem target';
    const prefix = options.stagePrefix || 'durable_remove';
    const tombstoneParent = options.tombstoneParentToken || parent;
    const budget = options.tombstoneBudget || createTombstoneBudget(tombstoneParent);
    let quarantineHandle = null;
    try {
        assertDirectoryIdentity(parent);
        assertDirectoryIdentity(tombstoneParent);
        const source = entryPathForParent(resolved, parent, label).file;
        const named = verifyNamedIdentity(source, expected, label);
        assertSupportedRemovalType(named, label);
        if (removeDirectory !== named.isDirectory()) {
            throw new Error(`${label} has an unexpected filesystem type`);
        }
        if (named.isFile() && named.nlink !== 1n) {
            throw new Error(`${label} must not have another hard link`);
        }

        fault(options, `${prefix}:after_source_verification`);
        const localTombstone = reserveTombstone(parent, budget, removeDirectory ? 'directory' : 'file');
        fs.renameSync(source, localTombstone.file);
        fault(options, `${prefix}:quarantined`);

        quarantineHandle = openQuarantinedIdentity(
            localTombstone.file,
            expected,
            `${label} quarantine`,
            options.verifiedFd,
        );
        if (removeDirectory && process.platform !== 'win32') {
            fs.fchmodSync(quarantineHandle.fd, 0o700);
        }
        let faultError = null;
        try { fault(options, `${prefix}:after_quarantine_verification`); } catch (error) { faultError = error; }
        if (quarantineHandle.named.isFile()) {
            sanitizeOpenFile(quarantineHandle.fd, quarantineHandle.named, `${label} quarantine`);
        } else if (quarantineHandle.named.isDirectory()) {
            const held = fstatBigInt(quarantineHandle.fd);
            if (!sameIdentity(held, expected) || !held.isDirectory()) {
                throw new Error(`${label} quarantine changed after verification`);
            }
        }
        if (faultError) throw faultError;

        const currentTombstone = lstatBigInt(localTombstone.file);
        if (!currentTombstone || !sameIdentity(currentTombstone, expected)) {
            recordDurableTombstone(parent, localTombstone.name, currentTombstone, 'replacement_retained');
            throw new Error(`${label} quarantine changed after verification`);
        }
        if (lstatBigInt(source)) throw new Error(`${label} name was recreated during secure removal`);

        let retainedParent = parent;
        let retained = localTombstone;
        if (!sameIdentity(parent.identity, tombstoneParent.identity)) {
            retained = reserveTombstone(tombstoneParent, budget, removeDirectory ? 'directory' : 'file');
            // This rename cannot delete the source object. If its name is raced,
            // the replacement is merely retained under another random name.
            fs.renameSync(localTombstone.file, retained.file);
            retainedParent = tombstoneParent;
        }
        const retainedStat = lstatBigInt(retained.file);
        recordDurableTombstone(retainedParent, retained.name, retainedStat, 'sanitized');
        fault(options, `${prefix}:before_quarantine_remove`);
        fault(options, `${prefix}:${removeDirectory ? 'directory_removed' : 'unlinked'}`);
        try {
            fs.fsyncSync(parent.fd);
        } catch (error) {
            if (process.platform !== 'win32' || !WINDOWS_DIRECTORY_FSYNC_UNSUPPORTED.has(error?.code)) throw error;
        }
        if (!sameIdentity(parent.identity, tombstoneParent.identity)) {
            try {
                fs.fsyncSync(tombstoneParent.fd);
            } catch (error) {
                if (process.platform !== 'win32' || !WINDOWS_DIRECTORY_FSYNC_UNSUPPORTED.has(error?.code)) throw error;
            }
        }
        assertDirectoryIdentity(parent);
    } finally {
        if (quarantineHandle?.ownsFd) fs.closeSync(quarantineHandle.fd);
        if (ownsParent) closeDirectoryIdentity(parent);
    }
}

function unlinkExpected(file, expected, options = {}) {
    return removeExpected(file, expected, options, false);
}

function rmdirExpected(file, expected, options = {}) {
    return removeExpected(file, expected, options, true);
}

function fault(options, stage) {
    if (typeof options?.faultInjector === 'function') options.faultInjector(stage);
}

function fsyncFile(file) {
    /* Windows refuses FlushFileBuffers on a read-only handle. Every target in
     * this protocol is an owned 0600 regular file, so request a writable
     * handle consistently across platforms. */
    const fd = fs.openSync(file, 'r+');
    try {
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
}

function fsyncDirectory(directory, options = {}) {
    const resolved = path.resolve(directory);
    let fd;
    try {
        fd = fs.openSync(resolved, 'r');
        fs.fsyncSync(fd);
    } catch (error) {
        /* Windows exposes no supported Node API for flushing a directory
         * handle. File data and the renamed target are still flushed on both
         * sides of every replace; only this documented platform limitation is
         * tolerated. All other directory-sync failures remain fatal. */
        if (process.platform !== 'win32' || !WINDOWS_DIRECTORY_FSYNC_UNSUPPORTED.has(error?.code)) {
            throw error;
        }
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
    fault(options, `${options.stagePrefix || 'durable'}:directory_fsynced`);
}

function temporarySibling(target, label = 'atomic') {
    const resolved = path.resolve(target);
    return path.join(
        path.dirname(resolved),
        `.${path.basename(resolved)}.${label}-${process.pid}-${crypto.randomUUID()}.tmp`,
    );
}

function finishAtomicReplace(tempFile, target, options = {}) {
    const resolved = path.resolve(target);
    const prefix = options.stagePrefix || 'atomic_replace';
    fs.renameSync(tempFile, resolved);
    fault(options, `${prefix}:renamed`);
    fsyncFile(resolved);
    fault(options, `${prefix}:target_fsynced`);
    fsyncDirectory(path.dirname(resolved), { ...options, stagePrefix: prefix });
}

function writeFileAtomically(target, data, options = {}) {
    const resolved = path.resolve(target);
    const directory = path.dirname(resolved);
    const prefix = options.stagePrefix || 'atomic_write';
    fs.mkdirSync(directory, { recursive: true, mode: options.directoryMode || 0o700 });
    const tempFile = temporarySibling(resolved, options.tempLabel || 'atomic');
    let fd;
    let operationError = null;
    try {
        fd = fs.openSync(tempFile, 'wx', options.mode || 0o600);
        fs.writeFileSync(fd, data);
        fault(options, `${prefix}:temp_written`);
        fs.fsyncSync(fd);
        fault(options, `${prefix}:temp_fsynced`);
        fs.closeSync(fd);
        fd = undefined;
        fs.chmodSync(tempFile, options.mode || 0o600);
        finishAtomicReplace(tempFile, resolved, { ...options, stagePrefix: prefix });
    } catch (error) {
        operationError = error;
    } finally {
        const cleanupErrors = [];
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch (closeError) { cleanupErrors.push(closeError); }
        }
        try {
            removeFileDurably(tempFile, {
                allowMissing: true,
                ...options,
                stagePrefix: `${prefix}:temp_cleanup`,
            });
        } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
        }
        if (cleanupErrors.length) {
            throw new AggregateError(
                operationError ? [operationError, ...cleanupErrors] : cleanupErrors,
                `${prefix} temporary file cleanup failed`,
            );
        }
    }
    if (operationError) throw operationError;
}

function copyFileAtomically(source, target, options = {}) {
    const resolvedSource = path.resolve(source);
    const resolvedTarget = path.resolve(target);
    const directory = path.dirname(resolvedTarget);
    const prefix = options.stagePrefix || 'atomic_copy';
    fs.mkdirSync(directory, { recursive: true, mode: options.directoryMode || 0o700 });
    const tempFile = temporarySibling(resolvedTarget, options.tempLabel || 'copy');
    let operationError = null;
    try {
        fs.copyFileSync(resolvedSource, tempFile, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(tempFile, options.mode || 0o600);
        fault(options, `${prefix}:temp_written`);
        fsyncFile(tempFile);
        fault(options, `${prefix}:temp_fsynced`);
        finishAtomicReplace(tempFile, resolvedTarget, { ...options, stagePrefix: prefix });
    } catch (error) {
        operationError = error;
    } finally {
        const cleanupErrors = [];
        try {
            removeFileDurably(tempFile, {
                allowMissing: true,
                ...options,
                stagePrefix: `${prefix}:temp_cleanup`,
            });
        } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
        }
        if (cleanupErrors.length) {
            throw new AggregateError(
                operationError ? [operationError, ...cleanupErrors] : cleanupErrors,
                `${prefix} temporary file cleanup failed`,
            );
        }
    }
    if (operationError) throw operationError;
}

function copyFileExclusiveDurably(source, target, options = {}) {
    const resolvedSource = path.resolve(source);
    const resolvedTarget = path.resolve(target);
    const prefix = options.stagePrefix || 'durable_copy';
    fs.copyFileSync(resolvedSource, resolvedTarget, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(resolvedTarget, options.mode || 0o600);
    fault(options, `${prefix}:written`);
    fsyncFile(resolvedTarget);
    fault(options, `${prefix}:fsynced`);
    fsyncDirectory(path.dirname(resolvedTarget), { ...options, stagePrefix: prefix });
}

function writeFileExclusiveDurably(target, data, options = {}) {
    const resolvedTarget = path.resolve(target);
    const prefix = options.stagePrefix || 'durable_write';
    let fd;
    try {
        fd = fs.openSync(resolvedTarget, 'wx', options.mode || 0o600);
        fs.writeFileSync(fd, data);
        fault(options, `${prefix}:written`);
        fs.fsyncSync(fd);
        fault(options, `${prefix}:fsynced`);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
    fsyncDirectory(path.dirname(resolvedTarget), { ...options, stagePrefix: prefix });
}

function removeFileDurably(file, options = {}) {
    const resolved = path.resolve(file);
    const named = lstatBigInt(resolved);
    if (!named) {
        if (options.allowMissing !== false) return false;
        const error = new Error(`filesystem target does not exist: ${resolved}`);
        error.code = 'ENOENT';
        throw error;
    }
    const expected = options.expectedIdentity || named;
    if (!sameIdentity(named, expected)) {
        throw new Error(`${options.label || 'filesystem target'} changed before secure removal`);
    }
    unlinkExpected(resolved, expected, { ...options, label: options.label || 'filesystem target' });
    return true;
}

function scrubFileAndRemoveDurably(file, options = {}) {
    const resolved = path.resolve(file);
    const stat = lstatBigInt(resolved);
    if (!stat) return false;
    const parent = options.parentToken || openDirectoryIdentity(path.dirname(resolved), {
        label: 'sensitive cleanup parent directory',
    });
    const ownsParent = !options.parentToken;
    try {
        assertDirectoryIdentity(parent);
        const tombstoneParent = options.tombstoneParentToken || parent;
        const tombstoneBudget = options.tombstoneBudget || createTombstoneBudget(tombstoneParent);
        return scrubFileWithIdentity(resolved, stat, parent, {
            ...options,
            tombstoneParentToken: tombstoneParent,
            tombstoneBudget,
        });
    } finally {
        if (ownsParent) closeDirectoryIdentity(parent);
    }
}

function scrubFileWithIdentity(resolved, stat, parent, options) {
    if (stat.isSymbolicLink() || !stat.isFile()) {
        unlinkExpected(resolved, stat, {
            ...options,
            parentToken: parent,
            label: 'sensitive cleanup target',
        });
        return true;
    }
    if (stat.nlink !== 1n) {
        throw new Error('sensitive cleanup target must not have another hard link');
    }

    const openFlags = fs.constants.O_RDWR | Number(fs.constants.O_NOFOLLOW || 0);
    const fd = fs.openSync(resolved, openFlags);
    try {
        const opened = fstatBigInt(fd);
        if (!opened.isFile() || opened.nlink !== 1n || !sameIdentity(opened, stat)) {
            throw new Error('sensitive cleanup target changed while it was being opened');
        }
        assertDirectoryIdentity(parent);
        verifyNamedIdentity(resolved, opened, 'sensitive cleanup target');
        const byteLength = Number(stat.size);
        const zeros = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, byteLength)));
        let offset = 0;
        while (offset < byteLength) {
            const length = Math.min(zeros.length, byteLength - offset);
            fs.writeSync(fd, zeros, 0, length, offset);
            offset += length;
        }
        fs.fsyncSync(fd);
        fault(options, `${options.stagePrefix || 'durable_scrub'}:scrubbed`);
        const scrubbed = fstatBigInt(fd);
        if (!sameIdentity(opened, scrubbed) || scrubbed.nlink !== 1n) {
            throw new Error('sensitive cleanup target changed while it was being scrubbed');
        }
    } finally {
        fs.closeSync(fd);
    }
    // The data handle is closed before the quarantine protocol starts, so a
    // replacement can never be mistaken for the scrubbed identity.
    fault(options, `${options.stagePrefix || 'durable_scrub'}:before_unlink`);
    unlinkExpected(resolved, stat, {
        ...options,
        parentToken: parent,
        label: 'sensitive cleanup target',
        stagePrefix: options.stagePrefix || 'durable_scrub',
    });
    return true;
}

function scrubPathDurably(target, options = {}) {
    const resolved = path.resolve(target);
    const stat = lstatBigInt(resolved);
    if (!stat) return false;
    const parent = openDirectoryIdentity(path.dirname(resolved), {
        label: 'sensitive cleanup parent directory',
    });
    try {
        const tombstoneBudget = createTombstoneBudget(parent);
        return scrubPathWithIdentity(resolved, stat, parent, {
            ...options,
            tombstoneParentToken: parent,
            tombstoneBudget,
        });
    } finally {
        closeDirectoryIdentity(parent);
    }
}

function scrubPathWithIdentity(resolved, stat, parent, options) {
    assertDirectoryIdentity(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        return scrubFileWithIdentity(resolved, stat, parent, options);
    }

    const directory = openDirectoryIdentity(resolved, { label: 'sensitive cleanup directory' });
    try {
        assertDirectoryIdentity(directory);
        const names = fs.readdirSync(directoryReadPath(directory));
        assertDirectoryIdentity(directory);
        for (const name of names) {
            if (!name || name === '.' || name === '..' || path.basename(name) !== name) {
                throw new Error('sensitive cleanup directory contained an invalid entry name');
            }
            assertDirectoryIdentity(directory);
            const child = path.join(resolved, name);
            const childStat = lstatBigInt(child);
            if (!childStat) continue;
            if (isDurableTombstoneName(name)) {
                recordDurableTombstone(directory, name, childStat, 'observed');
                const retained = reserveTombstone(
                    options.tombstoneParentToken,
                    options.tombstoneBudget,
                    childStat.isDirectory() ? 'directory' : 'file',
                );
                fs.renameSync(child, retained.file);
                recordDurableTombstone(
                    options.tombstoneParentToken,
                    retained.name,
                    lstatBigInt(retained.file),
                    'relocated',
                );
                continue;
            }
            scrubPathWithIdentity(child, childStat, directory, options);
            assertDirectoryIdentity(directory);
        }
        assertDirectoryIdentity(directory);
        if (fs.readdirSync(directoryReadPath(directory)).length !== 0) {
            throw new Error('sensitive cleanup directory was not empty after sanitization');
        }

        fault(options, `${options.stagePrefix || 'durable_scrub'}:before_directory_remove`);
        assertDirectoryIdentity(parent);
        rmdirExpected(resolved, stat, {
            ...options,
            verifiedFd: directory.fd,
            parentToken: parent,
            label: 'sensitive cleanup directory',
            stagePrefix: options.stagePrefix || 'durable_scrub',
        });
        return true;
    } finally {
        closeDirectoryIdentity(directory);
    }
}

function sha256File(file) {
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const fd = fs.openSync(file, 'r');
    try {
        let offset = 0;
        while (true) {
            const read = fs.readSync(fd, buffer, 0, buffer.length, offset);
            if (!read) break;
            hash.update(buffer.subarray(0, read));
            offset += read;
        }
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

module.exports = {
    DURABLE_TOMBSTONE_PREFIX,
    MAX_DURABLE_TOMBSTONES_PER_DIRECTORY,
    assertDirectoryIdentity,
    closeDirectoryIdentity,
    copyFileAtomically,
    copyFileExclusiveDurably,
    directoryEntryPath,
    fsyncDirectory,
    fsyncFile,
    isDurableTombstoneName,
    listDurableTombstoneRecords,
    openDirectoryIdentity,
    removeFileDurably,
    scrubFileAndRemoveDurably,
    scrubPathDurably,
    sha256File,
    sameIdentity,
    verifyNamedIdentity,
    writeFileAtomically,
    writeFileExclusiveDurably,
};
