'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { MobileStoreError } = require('./mobile-v1-store');

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const DEFERRED_LEGACY_MIGRATION_CODES = new Set([
    'EACCES', 'EBUSY', 'EINTR', 'EINVAL', 'EMFILE', 'ENFILE', 'ENOSPC',
    'ENOSYS', 'ENOTSUP', 'EPERM', 'EROFS',
]);

function positiveInteger(value, fallback) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function configured(value, envName, fallback) {
    return positiveInteger(value, positiveInteger(process.env[envName], fallback));
}

function defaultLimits(overrides = {}) {
    return {
        maxAccountBytes: configured(overrides.maxAccountBytes, 'ZEPHYR_MOBILE_BLOB_ACCOUNT_BYTES', 10 * GIB),
        maxAccountBlobs: configured(overrides.maxAccountBlobs, 'ZEPHYR_MOBILE_BLOB_ACCOUNT_COUNT', 10000),
        maxDeviceBytes: configured(overrides.maxDeviceBytes, 'ZEPHYR_MOBILE_BLOB_DEVICE_BYTES', 5 * GIB),
        maxDeviceBlobs: configured(overrides.maxDeviceBlobs, 'ZEPHYR_MOBILE_BLOB_DEVICE_COUNT', 5000),
        maxInflightAccountUploads: configured(overrides.maxInflightAccountUploads, 'ZEPHYR_MOBILE_BLOB_ACCOUNT_INFLIGHT', 16),
        maxInflightDeviceUploads: configured(overrides.maxInflightDeviceUploads, 'ZEPHYR_MOBILE_BLOB_DEVICE_INFLIGHT', 4),
        maxConcurrentAccountRequests: configured(overrides.maxConcurrentAccountRequests, 'ZEPHYR_MOBILE_BLOB_ACCOUNT_CONCURRENCY', 16),
        maxConcurrentDeviceRequests: configured(overrides.maxConcurrentDeviceRequests, 'ZEPHYR_MOBILE_BLOB_DEVICE_CONCURRENCY', 4),
        maxConcurrentFinalizations: configured(overrides.maxConcurrentFinalizations, 'ZEPHYR_MOBILE_BLOB_FINALIZE_CONCURRENCY', 2),
        maxConcurrentAccountFinalizations: positiveInteger(overrides.maxConcurrentAccountFinalizations, 2),
        maxConcurrentDeviceFinalizations: positiveInteger(overrides.maxConcurrentDeviceFinalizations, 1),
        createRatePerMinute: configured(overrides.createRatePerMinute, 'ZEPHYR_MOBILE_BLOB_CREATE_RATE', 30),
        chunkRatePerMinute: configured(overrides.chunkRatePerMinute, 'ZEPHYR_MOBILE_BLOB_CHUNK_RATE', 300),
        minFreeDiskBytes: configured(overrides.minFreeDiskBytes, 'ZEPHYR_MOBILE_BLOB_MIN_FREE_BYTES', 128 * MIB),
        staleUploadMs: configured(overrides.staleUploadMs, 'ZEPHYR_MOBILE_BLOB_STALE_MS', 24 * 60 * 60 * 1000),
        failedUploadMs: configured(overrides.failedUploadMs, 'ZEPHYR_MOBILE_BLOB_FAILED_MS', 60 * 60 * 1000),
        gcIntervalMs: configured(overrides.gcIntervalMs, 'ZEPHYR_MOBILE_BLOB_GC_INTERVAL_MS', 15 * 60 * 1000),
    };
}

function safeCode(error) {
    if (error instanceof MobileStoreError) return error.code;
    return 'server_unavailable';
}

class MobileV1BlobManager {
    constructor(opts) {
        if (!opts || !opts.store) throw new TypeError('MobileV1BlobManager requires a store');
        this.store = opts.store;
        this.log = opts.log || (() => {});
        this.now = opts.now || (() => Date.now());
        this.limits = defaultLimits(opts.limits);
        this.availableDiskBytes = opts.availableDiskBytes || (() => this._availableDiskBytes());
        this.syncDirectory = opts.syncDirectory || ((directory) => this._syncDirectory(directory));
        this.syncFile = opts.syncFile || ((handle) => handle.sync());
        this.store.blobLimits = this.limits;

        this._rates = new Map();
        this._activeAccountRequests = new Map();
        this._activeDeviceRequests = new Map();
        this._uploadTails = new Map();
        this._createTail = Promise.resolve();
        this._queuedFinalizations = new Map();
        this._activeFinalizations = new Map();
        this._activeAccountFinalizations = new Map();
        this._activeDeviceFinalizations = new Map();
        this._blockedOwners = new Set(
            this.store.listUserCleanupJobs?.().map((job) => String(job.ownerUserId)) || [],
        );
        this._cleanupTail = Promise.resolve();
        this._cleanupAwaitingRestart = new Set();
        this._closed = false;
        this._gcTimer = null;
        this._lastGcAt = 0;
        this._opportunisticGc = null;
        this.ready = this._start();
    }

    async _start() {
        await this._ensurePrivateDir(this.store.blobRoot);
        await this._migrateLegacyBlobFiles();
        await this.gc({ recover: true });
        if (this._closed) return;
        this._gcTimer = setInterval(() => {
            this.gc({ recover: true }).catch((error) => {
                this.log('blob gc failed', { code: safeCode(error) });
            });
        }, this.limits.gcIntervalMs);
        this._gcTimer.unref?.();
    }

    close() {
        this._closed = true;
        if (this._gcTimer) clearInterval(this._gcTimer);
        this._gcTimer = null;
    }

    async _availableDiskBytes() {
        const stat = await fsp.statfs(this.store.blobRoot, { bigint: true });
        const available = stat.bavail * stat.bsize;
        return available > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(available);
    }

    async _syncDirectory(directory) {
        const handle = await fsp.open(directory, 'r');
        try { await handle.sync(); } finally { await handle.close(); }
    }

    async _ensurePrivateDir(directory) {
        await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
        const stat = await fsp.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new MobileStoreError('server_unavailable', 'blob storage directory is unavailable', 503, {
                retryable: true,
            });
        }
        await fsp.chmod(directory, 0o700).catch(() => {});
    }

    _rateLimit(kind, key, limit) {
        const now = this.now();
        const windowMs = 60 * 1000;
        const mapKey = kind + ':' + String(key);
        const prior = this._rates.get(mapKey) || [];
        const recent = prior.filter((timestamp) => timestamp > now - windowMs);
        if (recent.length >= limit) {
            const retryAfterSec = Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000));
            throw new MobileStoreError('rate_limited', 'blob request rate limit exceeded', 429, {
                retryable: true,
                retryAfterSec,
            });
        }
        recent.push(now);
        this._rates.set(mapKey, recent);
        if (this._rates.size > 10000) {
            for (const [candidate, values] of this._rates) {
                if (!values.some((timestamp) => timestamp > now - windowMs)) this._rates.delete(candidate);
            }
        }
    }

    _acquireRequest(ownerUserId, deviceId) {
        const owner = String(ownerUserId);
        const device = String(deviceId);
        if (this._blockedOwners.has(owner)) {
            throw new MobileStoreError('client_revoked', 'account mobile state is unavailable', 403);
        }
        const ownerCount = this._activeAccountRequests.get(owner) || 0;
        const deviceCount = this._activeDeviceRequests.get(device) || 0;
        if (ownerCount >= this.limits.maxConcurrentAccountRequests
            || deviceCount >= this.limits.maxConcurrentDeviceRequests) {
            throw new MobileStoreError('rate_limited', 'too many concurrent blob requests', 429, {
                retryable: true,
                retryAfterSec: 1,
            });
        }
        this._activeAccountRequests.set(owner, ownerCount + 1);
        this._activeDeviceRequests.set(device, deviceCount + 1);
        return () => {
            const nextOwner = (this._activeAccountRequests.get(owner) || 1) - 1;
            const nextDevice = (this._activeDeviceRequests.get(device) || 1) - 1;
            if (nextOwner <= 0) this._activeAccountRequests.delete(owner);
            else this._activeAccountRequests.set(owner, nextOwner);
            if (nextDevice <= 0) this._activeDeviceRequests.delete(device);
            else this._activeDeviceRequests.set(device, nextDevice);
        };
    }

    async _withCreateLock(work) {
        const prior = this._createTail;
        let release;
        this._createTail = new Promise((resolve) => { release = resolve; });
        await prior;
        try {
            return await work();
        } finally {
            release();
        }
    }

    async _withUploadLock(uploadId, work) {
        const key = String(uploadId);
        const prior = this._uploadTails.get(key) || Promise.resolve();
        let release;
        const tail = new Promise((resolve) => { release = resolve; });
        this._uploadTails.set(key, tail);
        await prior;
        try {
            return await work();
        } finally {
            release();
            if (this._uploadTails.get(key) === tail) this._uploadTails.delete(key);
        }
    }

    async _assertDiskReservation(additionalBytes = 0) {
        let available;
        try {
            available = Number(await this.availableDiskBytes());
        } catch {
            throw new MobileStoreError('server_unavailable', 'blob storage capacity is unavailable', 503, {
                retryable: true,
            });
        }
        const reserved = this.store.blobPendingDiskBytes();
        const required = this.limits.minFreeDiskBytes + reserved + Math.max(0, Number(additionalBytes) || 0);
        if (!Number.isFinite(available) || available < required) {
            throw new MobileStoreError('server_unavailable', 'blob storage has insufficient free space', 503, {
                retryable: true,
                details: { requiredFreeBytes: this.limits.minFreeDiskBytes },
            });
        }
    }

    async _maybeGc() {
        const interval = Math.min(this.limits.gcIntervalMs, 60 * 1000);
        if (this.now() - this._lastGcAt < interval) return;
        if (!this._opportunisticGc) {
            this._opportunisticGc = this.gc({ recover: false })
                .catch((error) => this.log('blob opportunistic gc failed', { code: safeCode(error) }))
                .finally(() => { this._opportunisticGc = null; });
        }
        await this._opportunisticGc;
    }

    async createUpload(input) {
        await this.ready;
        await this._maybeGc();
        const release = this._acquireRequest(input.ownerUserId, input.deviceId);
        try {
            this._rateLimit('create', input.deviceId, this.limits.createRatePerMinute);
            return await this._withCreateLock(async () => {
                const existing = this.store.findResumableBlobUpload(
                    input.ownerUserId,
                    input.deviceId,
                    input.sha256,
                );
                if (!this.store.getBlob(input.ownerUserId, input.sha256) && !existing) {
                    // Parts and the assembled temporary file coexist while finalizing.
                    await this._assertDiskReservation(Number(input.size) * 2);
                }
                const status = this.store.createBlobUpload(input, this.limits);
                if (status.uploadId) {
                    await this._ensurePrivateDir(path.join(this.store.blobRoot, '_uploads'));
                    await this._ensurePrivateDir(this.store.uploadChunkDir(status.uploadId));
                    if (status.missing.length === 0 && status.state !== 'complete') {
                        const row = this.store.markBlobFinalizing(status.uploadId);
                        this._scheduleFinalization(row);
                        return this.store.blobUploadStatus(row);
                    }
                }
                return status;
            });
        } finally {
            release();
        }
    }

    async getUploadStatus({ ownerUserId, deviceId, uploadId }) {
        await this.ready;
        if (this._blockedOwners.has(String(ownerUserId))) {
            throw new MobileStoreError('client_revoked', 'account mobile state is unavailable', 403);
        }
        const row = this.store.getBlobUpload(uploadId);
        if (!row
            || String(row.owner_user_id) !== String(ownerUserId)
            || String(row.device_id) !== String(deviceId)) {
            throw new MobileStoreError('resource_not_found_or_inaccessible', 'upload session not found', 404);
        }
        return this.store.blobUploadStatus(row);
    }

    async uploadChunk(input) {
        await this.ready;
        await this._maybeGc();
        const release = this._acquireRequest(input.ownerUserId, input.deviceId);
        try {
            this._rateLimit('chunk', input.deviceId, this.limits.chunkRatePerMinute);
            return await this._withUploadLock(input.uploadId, async () => {
                const prepared = this.store.prepareBlobChunk(input);
                await this._assertDiskReservation(0);
                const dir = this.store.uploadChunkDir(prepared.row.upload_id);
                await this._ensurePrivateDir(dir);
                const temporary = path.join(dir, prepared.index + '.tmp-' + crypto.randomBytes(8).toString('hex'));
                const destination = path.join(dir, prepared.index + '.part');
                try {
                    await fsp.writeFile(temporary, input.bytes, { flag: 'wx', mode: 0o600 });
                    try {
                        await fsp.rename(temporary, destination);
                    } catch (error) {
                        if (!error || !['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
                        let existing = null;
                        try { existing = await this._hashFile(destination); } catch { /* replace a damaged part */ }
                        if (existing
                            && existing.size === input.bytes.length
                            && existing.digest === prepared.digest) {
                            await fsp.rm(temporary, { force: true });
                        } else {
                            await fsp.rm(destination, { force: true });
                            await fsp.rename(temporary, destination);
                        }
                    }
                } catch (error) {
                    await fsp.rm(temporary, { force: true }).catch(() => {});
                    throw new MobileStoreError('server_unavailable', 'blob chunk could not be stored', 503, {
                        retryable: true,
                    });
                }
                const row = this.store.commitBlobChunk({
                    ownerUserId: input.ownerUserId,
                    deviceId: input.deviceId,
                    uploadId: input.uploadId,
                    index: prepared.index,
                    byteLength: input.bytes.length,
                });
                if (row.finalizing_at != null) this._scheduleFinalization(row);
                return this.store.blobUploadStatus(row);
            });
        } finally {
            release();
        }
    }

    _scheduleFinalization(row) {
        if (!row || this._closed || row.state === 'complete' || row.failed_at != null) return;
        if (this._blockedOwners.has(String(row.owner_user_id))) return;
        const uploadId = String(row.upload_id);
        if (this._activeFinalizations.has(uploadId) || this._queuedFinalizations.has(uploadId)) return;
        this._queuedFinalizations.set(uploadId, row);
        queueMicrotask(() => this._drainFinalizations());
    }

    _drainFinalizations() {
        if (this._closed) return;
        while (this._activeFinalizations.size < this.limits.maxConcurrentFinalizations) {
            let selected = null;
            for (const [uploadId, candidate] of this._queuedFinalizations) {
                if (this._blockedOwners.has(String(candidate.owner_user_id))) {
                    this._queuedFinalizations.delete(uploadId);
                    continue;
                }
                const ownerCount = this._activeAccountFinalizations.get(String(candidate.owner_user_id)) || 0;
                const deviceCount = this._activeDeviceFinalizations.get(String(candidate.device_id)) || 0;
                if (ownerCount < this.limits.maxConcurrentAccountFinalizations
                    && deviceCount < this.limits.maxConcurrentDeviceFinalizations) {
                    selected = [uploadId, candidate];
                    break;
                }
            }
            if (!selected) return;
            const [uploadId, row] = selected;
            this._queuedFinalizations.delete(uploadId);
            const owner = String(row.owner_user_id);
            const device = String(row.device_id);
            this._activeAccountFinalizations.set(owner, (this._activeAccountFinalizations.get(owner) || 0) + 1);
            this._activeDeviceFinalizations.set(device, (this._activeDeviceFinalizations.get(device) || 0) + 1);
            const job = this._finalize(row)
                .catch(async (error) => {
                    const code = safeCode(error);
                    if (code === 'blob_hash_mismatch') {
                        this.store.markBlobFailed(uploadId, code);
                        await this._removeUploadFiles(uploadId);
                    } else {
                        this.store.deferBlobFinalization(uploadId, code);
                    }
                    this.log('blob finalization failed', { uploadId, code });
                })
                .finally(() => {
                    this._activeFinalizations.delete(uploadId);
                    const ownerNext = (this._activeAccountFinalizations.get(owner) || 1) - 1;
                    const deviceNext = (this._activeDeviceFinalizations.get(device) || 1) - 1;
                    if (ownerNext <= 0) this._activeAccountFinalizations.delete(owner);
                    else this._activeAccountFinalizations.set(owner, ownerNext);
                    if (deviceNext <= 0) this._activeDeviceFinalizations.delete(device);
                    else this._activeDeviceFinalizations.set(device, deviceNext);
                    this._drainFinalizations();
                });
            job.ownerUserId = owner;
            job.promise = job;
            this._activeFinalizations.set(uploadId, job);
        }
    }

    async _hashFile(file) {
        const stat = await fsp.lstat(file);
        if (!stat.isFile()) throw new Error('blob path is not a regular file');
        const hash = crypto.createHash('sha256');
        let size = 0;
        for await (const chunk of fs.createReadStream(file, { highWaterMark: 64 * 1024 })) {
            hash.update(chunk);
            size += chunk.length;
            if (size > Number.MAX_SAFE_INTEGER) throw new Error('blob file is too large');
        }
        return { digest: hash.digest('hex'), size };
    }

    async _migrateLegacyBlobFiles() {
        for (const row of this.store.listBlobsForLegacyMigration?.() || []) {
            const legacyDirectory = this.store.legacyBlobOwnerDirectory?.(row.owner_user_id);
            if (!legacyDirectory) {
                throw new MobileStoreError('server_unavailable', 'legacy blob owner is unsafe', 503, {
                    retryable: false,
                });
            }
            let directoryStat;
            try { directoryStat = await fsp.lstat(legacyDirectory); } catch (error) {
                if (error?.code === 'ENOENT') continue;
                throw error;
            }
            if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
                throw new MobileStoreError('server_unavailable', 'legacy blob directory is unsafe', 503, {
                    retryable: false,
                });
            }
            const source = this._directChild(
                legacyDirectory,
                path.join(legacyDirectory, String(row.sha256).toLowerCase() + '.blob'),
            );
            let sourceStat;
            try { sourceStat = await fsp.lstat(source); } catch (error) {
                if (error?.code === 'ENOENT') continue;
                throw error;
            }
            if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
                throw new MobileStoreError('server_unavailable', 'legacy blob file is unsafe', 503, {
                    retryable: false,
                });
            }
            const sourceHash = await this._hashFile(source);
            if (sourceHash.digest !== String(row.sha256).toLowerCase()
                || sourceHash.size !== Number(row.size)) {
                throw new MobileStoreError('blob_hash_mismatch', 'legacy blob verification failed', 422, {
                    retryable: false,
                });
            }
            const destination = this.store.blobFilePath(row);
            await this._ensurePrivateDir(path.dirname(destination));
            try {
                const existing = await this._hashFile(destination);
                if (existing.digest !== sourceHash.digest || existing.size !== sourceHash.size) {
                    throw new MobileStoreError('blob_hash_mismatch', 'migrated blob verification failed', 422);
                }
                continue;
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
            }
            const temporary = destination + '.migrate-' + crypto.randomBytes(8).toString('hex');
            try {
                await fsp.copyFile(source, temporary, fs.constants.COPYFILE_EXCL);
                const handle = await fsp.open(temporary, 'r+');
                try { await this.syncFile(handle); } finally { await handle.close(); }
                await fsp.rename(temporary, destination);
            } catch (error) {
                await fsp.rm(temporary, { force: true }).catch(() => {});
                if (DEFERRED_LEGACY_MIGRATION_CODES.has(String(error?.code || ''))) {
                    this.log('mobile legacy blob migration deferred', { code: 'server_unavailable' });
                    continue;
                }
                throw error;
            }
        }
    }

    async _writeAll(handle, bytes) {
        let offset = 0;
        while (offset < bytes.length) {
            const result = await handle.write(bytes, offset, bytes.length - offset, null);
            if (!result.bytesWritten) throw new Error('short blob write');
            offset += result.bytesWritten;
        }
    }

    async _finalize(initialRow) {
        const row = this.store.getBlobUpload(initialRow.upload_id);
        if (!row || row.state === 'complete' || row.failed_at != null) return;
        await this._assertDiskReservation(0);
        const destination = this.store.blobFilePath(row);
        const temporary = destination + '.tmp-' + row.upload_id;
        await this._ensurePrivateDir(path.dirname(destination));

        try {
            const existing = await this._hashFile(destination);
            if (existing.size === Number(row.size) && existing.digest === row.sha256) {
                this.store.completeBlobUpload(row);
                await this._removeUploadFiles(row.upload_id);
                await fsp.rm(temporary, { force: true }).catch(() => {});
                return;
            }
            await fsp.rm(destination, { force: true });
        } catch (error) {
            if (error && error.code !== 'ENOENT') throw error;
        }

        await fsp.rm(temporary, { force: true }).catch(() => {});
        const handle = await fsp.open(temporary, 'wx', 0o600);
        const hash = crypto.createHash('sha256');
        let total = 0;
        try {
            const chunkHashes = JSON.parse(row.chunk_hashes_json);
            for (let index = 0; index < chunkHashes.length; index += 1) {
                const part = path.join(this.store.uploadChunkDir(row.upload_id), index + '.part');
                const stat = await fsp.lstat(part);
                const expected = index === chunkHashes.length - 1
                    ? Number(row.size) - Number(row.chunk_bytes) * (chunkHashes.length - 1)
                    : Number(row.chunk_bytes);
                if (!stat.isFile() || stat.size !== expected) {
                    throw new MobileStoreError('blob_missing_chunk', 'blob chunk is missing', 409, { retryable: true });
                }
                const partHash = crypto.createHash('sha256');
                for await (const bytes of fs.createReadStream(part, { highWaterMark: 64 * 1024 })) {
                    partHash.update(bytes);
                    hash.update(bytes);
                    total += bytes.length;
                    await this._writeAll(handle, bytes);
                }
                if (partHash.digest('hex') !== chunkHashes[index]) {
                    throw new MobileStoreError('blob_hash_mismatch', 'blob chunk verification failed', 422, { retryable: true });
                }
            }
            await handle.sync();
        } catch (error) {
            await handle.close().catch(() => {});
            await fsp.rm(temporary, { force: true }).catch(() => {});
            throw error;
        }
        await handle.close();

        if (total !== Number(row.size) || hash.digest('hex') !== row.sha256) {
            await fsp.rm(temporary, { force: true }).catch(() => {});
            throw new MobileStoreError('blob_hash_mismatch', 'blob verification failed', 422, { retryable: true });
        }

        try {
            await fsp.rename(temporary, destination);
        } catch (error) {
            // Windows does not replace an existing destination. A concurrent
            // uploader may have published the same content-addressed blob.
            if (!error || !['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
            const existing = await this._hashFile(destination);
            if (existing.size !== Number(row.size) || existing.digest !== row.sha256) throw error;
            await fsp.rm(temporary, { force: true });
        }

        try {
            const directory = await fsp.open(path.dirname(destination), 'r');
            try { await directory.sync(); } finally { await directory.close(); }
        } catch { /* directory fsync is not supported on every Windows filesystem */ }

        this.store.completeBlobUpload(row);
        await this._removeUploadFiles(row.upload_id);
    }

    async _removeUploadFiles(uploadId) {
        await fsp.rm(this.store.uploadChunkDir(uploadId), { recursive: true, force: true }).catch(() => {});
    }

    async prepareDeleteUserState(ownerUserId, timeoutMs = 30000) {
        const owner = String(ownerUserId || '');
        if (!owner) throw new TypeError('mobile cleanup owner is required');
        this._blockedOwners.add(owner);
        await this.ready;
        for (const [uploadId, row] of [...this._queuedFinalizations]) {
            if (String(row.owner_user_id) === owner) this._queuedFinalizations.delete(uploadId);
        }

        const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 1);
        while (Date.now() < deadline) {
            const activeRequests = Number(this._activeAccountRequests.get(owner) || 0);
            const activeFinalizations = [...this._activeFinalizations.entries()]
                .filter(([, job]) => job && String(job.ownerUserId || '') === owner)
                .map(([, job]) => job.promise || job);
            if (!activeRequests && !activeFinalizations.length) return true;
            if (activeFinalizations.length) {
                const remaining = deadline - Date.now();
                if (remaining <= 0) break;
                let timer;
                try {
                    await Promise.race([
                        Promise.allSettled(activeFinalizations),
                        new Promise((_, reject) => {
                            timer = setTimeout(() => reject(new MobileStoreError(
                                'server_unavailable',
                                'account mobile operations did not drain',
                                503,
                                { retryable: true },
                            )), remaining);
                        }),
                    ]);
                } finally {
                    if (timer) clearTimeout(timer);
                }
            }
            else await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new MobileStoreError('server_unavailable', 'account mobile operations did not drain', 503, {
            retryable: true,
        });
    }

    async deleteUserState(ownerUserId) {
        const owner = String(ownerUserId || '');
        if (!owner) throw new TypeError('mobile cleanup owner is required');
        this._blockedOwners.add(owner);
        await this.ready;
        return this._queueCleanup(async () => {
            const jobs = this.store.listUserCleanupJobs?.(owner) || [];
            let complete = true;
            for (const job of jobs) {
                if (!await this._runUserCleanupJob(job)) complete = false;
            }
            return complete;
        });
    }

    restoreUserState(ownerUserId) {
        const owner = String(ownerUserId || '');
        if (!owner) throw new TypeError('mobile cleanup owner is required');
        this._blockedOwners.delete(owner);
        for (const row of this.store.listBlobUploadsForRecovery()) {
            if (String(row.owner_user_id) === owner && row.finalizing_at != null) {
                this._scheduleFinalization(row);
            }
        }
    }

    _queueCleanup(work) {
        const run = this._cleanupTail.then(work, work);
        this._cleanupTail = run.catch(() => {});
        return run;
    }

    _directChild(parent, target) {
        const resolvedParent = path.resolve(parent);
        const resolvedTarget = path.resolve(target);
        if (path.dirname(resolvedTarget) !== resolvedParent) {
            throw new MobileStoreError('server_unavailable', 'invalid cleanup descriptor', 503, {
                retryable: false,
            });
        }
        return resolvedTarget;
    }

    async _removeTreeWithoutFollowingRoot(target) {
        let stat;
        try { stat = await fsp.lstat(target); } catch (error) {
            if (error?.code === 'ENOENT') return;
            throw error;
        }
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            await fsp.unlink(target);
            return;
        }
        await fsp.rm(target, { recursive: true, force: false, maxRetries: 2, retryDelay: 25 });
    }

    async _quarantineCleanupPath(source, jobDirectory, name) {
        let stat;
        try { stat = await fsp.lstat(source); } catch (error) {
            if (error?.code === 'ENOENT') return false;
            throw error;
        }
        if (stat.isSymbolicLink()) {
            await fsp.unlink(source);
            return true;
        }
        const destination = this._directChild(jobDirectory, path.join(jobDirectory, name));
        await this._removeTreeWithoutFollowingRoot(destination);
        await fsp.rename(source, destination);
        return true;
    }

    async _runUserCleanupJob(job) {
        const cleanupId = String(job?.cleanupId || '');
        if (!/^del_[0-9a-f]{32}$/.test(cleanupId)) return false;
        if (job.lastErrorCode === 'awaiting_cleanup_confirmation') {
            if (this._cleanupAwaitingRestart.has(cleanupId)) return false;
            if (await this._cleanupJobPathsAbsent(job)) {
                this.store.completeUserCleanupJob(cleanupId);
                return true;
            }
        }
        if (job.invalidDescriptor) {
            this.store.deferUserCleanupJob(cleanupId, 'invalid_cleanup_descriptor');
            this.log('mobile user blob cleanup deferred', { code: 'invalid_cleanup_descriptor' });
            return false;
        }
        if (!this.store.beginUserCleanupJob?.(cleanupId)) return true;
        try {
            const cleanupRoot = this._directChild(this.store.blobRoot, path.join(this.store.blobRoot, '_cleanup'));
            await this._ensurePrivateDir(cleanupRoot);
            const jobDirectory = this._directChild(cleanupRoot, path.join(cleanupRoot, cleanupId));
            await this._ensurePrivateDir(jobDirectory);
            const durableDirectories = new Set([cleanupRoot]);

            const ownerDirectory = this.store.blobOwnerDirectory(job.ownerUserId);
            this._directChild(this.store.blobRoot, ownerDirectory);
            if (await this._quarantineCleanupPath(ownerDirectory, jobDirectory, 'owner')) {
                durableDirectories.add(path.dirname(ownerDirectory));
            }
            const legacyDirectory = this.store.legacyBlobOwnerDirectory?.(job.ownerUserId);
            if ((job.legacyFiles || []).length && !legacyDirectory) {
                throw new MobileStoreError('server_unavailable', 'invalid cleanup descriptor', 503);
            }
            if (legacyDirectory) {
                let legacyStat = null;
                try { legacyStat = await fsp.lstat(legacyDirectory); } catch (error) {
                    if (error?.code !== 'ENOENT') throw error;
                }
                if (legacyStat && (!legacyStat.isDirectory() || legacyStat.isSymbolicLink())) {
                    throw new MobileStoreError('server_unavailable', 'invalid cleanup descriptor', 503);
                }
                let legacyIndex = 0;
                for (const file of job.legacyFiles || []) {
                    if (!/^[0-9a-f]{64}\.blob(?:\.tmp-upl_[0-9a-f]{32})?$/.test(String(file))) {
                        throw new MobileStoreError('server_unavailable', 'invalid cleanup descriptor', 503);
                    }
                    const legacyFile = this._directChild(legacyDirectory, path.join(legacyDirectory, file));
                    if (await this._quarantineCleanupPath(legacyFile, jobDirectory, 'legacy-' + legacyIndex)) {
                        durableDirectories.add(legacyDirectory);
                    }
                    legacyIndex += 1;
                }
                try {
                    await fsp.rmdir(legacyDirectory);
                    durableDirectories.delete(legacyDirectory);
                    durableDirectories.add(path.dirname(legacyDirectory));
                } catch (error) {
                    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error;
                }
            }
            const uploadRoot = this._directChild(this.store.blobRoot, path.join(this.store.blobRoot, '_uploads'));
            await this._ensurePrivateDir(uploadRoot);
            let index = 0;
            for (const uploadId of job.uploadIds || []) {
                if (!/^upl_[0-9a-f]{32}$/.test(String(uploadId))) {
                    throw new MobileStoreError('server_unavailable', 'invalid cleanup descriptor', 503);
                }
                const uploadDirectory = this.store.uploadChunkDir(uploadId);
                this._directChild(uploadRoot, uploadDirectory);
                if (await this._quarantineCleanupPath(uploadDirectory, jobDirectory, 'upload-' + index)) {
                    durableDirectories.add(path.dirname(uploadDirectory));
                }
                index += 1;
            }
            await this._removeTreeWithoutFollowingRoot(jobDirectory);
            try {
                for (const directory of durableDirectories) await this.syncDirectory(directory);
            } catch {
                this.store.deferUserCleanupJob(cleanupId, 'awaiting_cleanup_confirmation');
                this._cleanupAwaitingRestart.add(cleanupId);
                return false;
            }
            this.store.completeUserCleanupJob(cleanupId);
            return true;
        } catch (error) {
            const descriptorError = error instanceof MobileStoreError && /descriptor/.test(String(error.message));
            this.store.deferUserCleanupJob(cleanupId, descriptorError ? 'invalid_cleanup_descriptor' : 'server_unavailable');
            this.log('mobile user blob cleanup deferred', {
                code: descriptorError ? 'invalid_cleanup_descriptor' : 'server_unavailable',
            });
            return false;
        }
    }

    async _cleanupJobPathsAbsent(job) {
        const legacyDirectory = this.store.legacyBlobOwnerDirectory?.(job.ownerUserId);
        const paths = [
            this.store.blobOwnerDirectory(job.ownerUserId),
            path.join(this.store.blobRoot, '_cleanup', String(job.cleanupId)),
            ...(job.uploadIds || []).map((uploadId) => this.store.uploadChunkDir(uploadId)),
            ...((legacyDirectory && job.legacyFiles) || []).map((file) => path.join(legacyDirectory, file)),
        ];
        if ((job.legacyFiles || []).length && !legacyDirectory) return false;
        for (const candidate of paths) {
            try {
                await fsp.lstat(candidate);
                return false;
            } catch (error) {
                if (error?.code !== 'ENOENT') return false;
            }
        }
        return true;
    }

    async _recoverUserCleanupJobs() {
        return this._queueCleanup(async () => {
            const jobs = this.store.listUserCleanupJobs?.() || [];
            for (const job of jobs) {
                this._blockedOwners.add(String(job.ownerUserId));
                await this._runUserCleanupJob(job);
            }
        });
    }

    async _reconcileUpload(row) {
        if (row.state === 'complete') {
            try {
                const stat = await fsp.lstat(this.store.blobFilePath(row));
                if (stat.isFile() && stat.size === Number(row.size)) {
                    await this._removeUploadFiles(row.upload_id);
                    return;
                }
            } catch { /* reopen below so the client can resume missing bytes */ }
            row = this.store.reopenCompletedBlobUpload(row.upload_id);
        }
        if (row.failed_at != null) return;
        const hashes = JSON.parse(row.chunk_hashes_json);
        const recorded = new Set(JSON.parse(row.received_json).map(Number));
        const valid = [];
        for (const index of recorded) {
            if (!Number.isInteger(index) || index < 0 || index >= hashes.length) continue;
            const part = path.join(this.store.uploadChunkDir(row.upload_id), index + '.part');
            try {
                const stat = await fsp.lstat(part);
                const expected = index === hashes.length - 1
                    ? Number(row.size) - Number(row.chunk_bytes) * (hashes.length - 1)
                    : Number(row.chunk_bytes);
                if (stat.isFile() && stat.size === expected) valid.push(index);
            } catch { /* a missing part is made resumable below */ }
        }
        const reconciled = this.store.reconcileBlobUpload(row.upload_id, valid);
        if (valid.length === hashes.length) {
            const finalizing = this.store.markBlobFinalizing(row.upload_id);
            this._scheduleFinalization(finalizing);
        } else if (reconciled.finalizing_at != null) {
            this.store.clearBlobFinalizing(row.upload_id);
        }
    }

    async gc({ recover = false } = {}) {
        const referenceTime = this.now();
        this._lastGcAt = referenceTime;
        await this._recoverUserCleanupJobs();
        const stale = this.store.claimStaleBlobUploads({
            referenceTime,
            staleUploadMs: this.limits.staleUploadMs,
            failedUploadMs: this.limits.failedUploadMs,
        });
        for (const row of stale) await this._removeUploadFiles(row.upload_id);

        const live = this.store.listBlobUploadsForRecovery();
        if (recover) {
            for (const row of live) {
                if (!this._blockedOwners.has(String(row.owner_user_id))) await this._reconcileUpload(row);
            }
        }

        const known = new Set(this.store.listBlobUploadIds());
        const root = path.join(this.store.blobRoot, '_uploads');
        await this._ensurePrivateDir(root);
        let entries = [];
        try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { /* no upload root yet */ }
        for (const entry of entries) {
            if (entry.isDirectory() && !known.has(entry.name)) {
                await fsp.rm(path.join(root, entry.name), { recursive: true, force: true }).catch(() => {});
            }
        }

        let ownerEntries = [];
        try { ownerEntries = await fsp.readdir(this.store.blobRoot, { withFileTypes: true }); } catch {}
        for (const ownerEntry of ownerEntries) {
            if (!ownerEntry.isDirectory() || ownerEntry.name === '_uploads' || ownerEntry.name === '_cleanup') continue;
            const ownerDir = path.join(this.store.blobRoot, ownerEntry.name);
            let files = [];
            try { files = await fsp.readdir(ownerDir, { withFileTypes: true }); } catch { continue; }
            for (const file of files) {
                const match = file.isFile()
                    ? file.name.match(/^[0-9a-f]{64}\.blob\.tmp-(upl_[0-9a-f]{32})$/)
                    : null;
                if (match && !known.has(match[1])) {
                    await fsp.rm(path.join(ownerDir, file.name), { force: true }).catch(() => {});
                }
            }
        }
        return stale.length;
    }

    async waitForIdle(uploadId, timeoutMs = 5000) {
        const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 1);
        const key = uploadId == null ? null : String(uploadId);
        while (Date.now() < deadline) {
            const finalizationPending = key
                ? this._queuedFinalizations.has(key) || this._activeFinalizations.has(key)
                : this._queuedFinalizations.size > 0 || this._activeFinalizations.size > 0;
            const cleanup = this._cleanupTail;
            if (!finalizationPending) {
                const remaining = deadline - Date.now();
                if (remaining <= 0) break;
                let timer;
                try {
                    await Promise.race([
                        cleanup,
                        new Promise((_, reject) => {
                            timer = setTimeout(() => reject(new Error(
                                'blob cleanup did not become idle before timeout',
                            )), remaining);
                        }),
                    ]);
                } finally {
                    if (timer) clearTimeout(timer);
                }
                if (cleanup === this._cleanupTail) return;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error('blob finalization did not become idle before timeout');
    }
}

module.exports = {
    MobileV1BlobManager,
    defaultLimits,
};
