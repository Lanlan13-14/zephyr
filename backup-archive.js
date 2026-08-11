'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable, Transform, Writable } = require('stream');
const { pipeline } = require('stream/promises');
const zlib = require('zlib');
const {
    assertDirectoryIdentity,
    closeDirectoryIdentity,
    copyFileExclusiveDurably,
    directoryEntryPath,
    openDirectoryIdentity,
    removeFileDurably,
    sameIdentity,
    scrubPathDurably,
    verifyNamedIdentity,
} = require('./durable-file');

const BACKUP_FORMAT = 'zephyr-backup';
const BACKUP_MANIFEST_VERSION = 1;
const MANIFEST_PATH = 'manifest.json';
const DATABASE_PATH = 'zephyr.db';
const KEY_PATH = 'crypto/ml-kem-768-keypair.json';
const METADATA_PATH = 'metadata.json';

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_DATABASE_BYTES = 40 * 1024 * 1024;
const MAX_KEY_BYTES = 128 * 1024;
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024;
const MAX_ENTRY_HEADER_BYTES = 4 * 1024;
const MAX_COMPRESSION_RATIO = 200;

const PAYLOAD_ORDER = [DATABASE_PATH, KEY_PATH, METADATA_PATH];
const ENTRY_POLICIES = new Map([
    [MANIFEST_PATH, { required: true, maxBytes: MAX_MANIFEST_BYTES }],
    [DATABASE_PATH, { required: true, maxBytes: MAX_DATABASE_BYTES }],
    [KEY_PATH, { required: false, maxBytes: MAX_KEY_BYTES }],
    [METADATA_PATH, { required: false, maxBytes: MAX_METADATA_BYTES }],
]);
const MAX_ARCHIVE_ENTRIES = ENTRY_POLICIES.size;
const MAX_TOTAL_UNCOMPRESSED_BYTES = [...ENTRY_POLICIES.values()]
    .reduce((sum, policy) => sum + policy.maxBytes, 0);

function archiveError(message) {
    const error = new Error(message);
    error.code = 'invalid_backup_archive';
    return error;
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
    if (!isPlainObject(value)) return false;
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function assertPayloadBuffer(name, buffer) {
    const policy = ENTRY_POLICIES.get(name);
    if (!policy || name === MANIFEST_PATH) throw archiveError(`backup entry is not allowed: ${name}`);
    if (!Buffer.isBuffer(buffer) || buffer.length < 1 || buffer.length > policy.maxBytes) {
        throw archiveError(`backup entry size is invalid: ${name}`);
    }
}

function createManifest(payloads) {
    const entries = PAYLOAD_ORDER
        .filter((name) => payloads.has(name))
        .map((name) => {
            const buffer = payloads.get(name);
            return { path: name, bytes: buffer.length, sha256: sha256(buffer) };
        });
    return Buffer.from(`${JSON.stringify({
        format: BACKUP_FORMAT,
        version: BACKUP_MANIFEST_VERSION,
        entries,
    }, null, 2)}\n`, 'utf8');
}

async function createBackupArchiveBuffer({ database, key = null, metadata = null } = {}) {
    assertPayloadBuffer(DATABASE_PATH, database);
    const payloads = new Map([[DATABASE_PATH, database]]);
    if (key !== null && key !== undefined) {
        assertPayloadBuffer(KEY_PATH, key);
        payloads.set(KEY_PATH, key);
    }
    if (metadata !== null && metadata !== undefined) {
        const metadataBuffer = Buffer.isBuffer(metadata)
            ? metadata
            : Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
        assertPayloadBuffer(METADATA_PATH, metadataBuffer);
        payloads.set(METADATA_PATH, metadataBuffer);
    }
    const manifest = createManifest(payloads);
    if (manifest.length > MAX_MANIFEST_BYTES) throw archiveError('backup manifest is too large');

    const { ZipArchive } = await import('archiver');
    return new Promise((resolve, reject) => {
        const chunks = [];
        let outputBytes = 0;
        let settled = false;
        const archive = new ZipArchive({ zlib: { level: 9 } });
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            if (error) reject(error);
            else resolve(value);
        };
        archive.on('warning', (error) => finish(error));
        archive.on('error', (error) => finish(error));
        archive.on('data', (chunk) => {
            outputBytes += chunk.length;
            if (outputBytes > MAX_ARCHIVE_BYTES) {
                archive.abort();
                finish(archiveError('backup archive exceeds the compressed size limit'));
                return;
            }
            chunks.push(chunk);
        });
        archive.on('end', () => finish(null, Buffer.concat(chunks, outputBytes)));
        archive.append(manifest, { name: MANIFEST_PATH, mode: 0o600 });
        for (const name of PAYLOAD_ORDER) {
            const content = payloads.get(name);
            if (!content) continue;
            /* Store SQLite without deflate. A sparse/mostly empty database can
             * otherwise exceed the same compression-ratio limit that protects
             * import from zip bombs. Small metadata files remain compressed. */
            archive.append(content, { name, mode: 0o600, store: name === DATABASE_PATH });
        }
        Promise.resolve(archive.finalize()).catch((error) => finish(error));
    });
}

async function readExact(handle, length, position, label) {
    if (!Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(position) || position < 0) {
        throw archiveError(`${label} range is invalid`);
    }
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
        const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
        if (!bytesRead) throw archiveError(`backup archive is truncated while reading ${label}`);
        offset += bytesRead;
    }
    return buffer;
}

function decodeEntryName(buffer) {
    if (!buffer.length || buffer.includes(0)) throw archiveError('backup entry path is invalid');
    const name = buffer.toString('utf8');
    if (!Buffer.from(name, 'utf8').equals(buffer)) throw archiveError('backup entry path is not valid UTF-8');
    if (name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)
        || name.split('/').some((part) => !part || part === '.' || part === '..')
        || path.posix.normalize(name) !== name) {
        throw archiveError(`backup entry path is unsafe: ${name}`);
    }
    return name;
}

function assertEntryType(versionMadeBy, externalAttributes, name) {
    const platform = versionMadeBy >>> 8;
    const unixMode = externalAttributes >>> 16;
    const unixType = unixMode & 0xf000;
    const dosAttributes = externalAttributes & 0xffff;
    if ((platform === 3 || platform === 19) && unixType === 0xa000) {
        throw archiveError(`backup entry must not be a symbolic link: ${name}`);
    }
    if (((platform === 3 || platform === 19) && unixType === 0x4000)
        || (dosAttributes & 0x10) !== 0 || name.endsWith('/')) {
        throw archiveError(`backup entry must be a regular file: ${name}`);
    }
}

function assertCompression(entry) {
    if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
        throw archiveError(`backup entry uses an unsupported compression method: ${entry.path}`);
    }
    if (entry.compressionMethod === 0 && entry.compressedSize !== entry.uncompressedSize) {
        throw archiveError(`stored backup entry has inconsistent sizes: ${entry.path}`);
    }
    if (entry.uncompressedSize > 0 && entry.compressedSize < 1) {
        throw archiveError(`backup entry compressed size is invalid: ${entry.path}`);
    }
    if (entry.uncompressedSize / Math.max(1, entry.compressedSize) > MAX_COMPRESSION_RATIO) {
        throw archiveError(`backup entry compression ratio exceeds the limit: ${entry.path}`);
    }
}

async function openAndParseCentralDirectory(archiveFile) {
    const resolved = path.resolve(String(archiveFile || ''));
    const pathStat = await fs.promises.lstat(resolved).catch(() => null);
    if (!pathStat?.isFile() || pathStat.isSymbolicLink() || pathStat.size < 22 || pathStat.size > MAX_ARCHIVE_BYTES) {
        throw archiveError('backup archive file size is invalid');
    }
    let handle = null;
    try {
        handle = await fs.promises.open(resolved, 'r');
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== pathStat.size
            || (pathStat.dev && stat.dev && pathStat.dev !== stat.dev)
            || (pathStat.ino && stat.ino && pathStat.ino !== stat.ino)) {
            throw archiveError('backup archive changed while it was being opened');
        }
        /* Zephyr never emits ZIP comments. Requiring EOCD at EOF makes trailing
         * junk and truncated comments unambiguous and avoids scanning attacker-
         * controlled megabytes for a signature. */
        const eocdOffset = stat.size - 22;
        const eocd = await readExact(handle, 22, eocdOffset, 'end of central directory');
        if (eocd.readUInt32LE(0) !== 0x06054b50 || eocd.readUInt16LE(20) !== 0) {
            throw archiveError('backup archive end record is missing or has an unsupported comment');
        }
        const diskNumber = eocd.readUInt16LE(4);
        const centralDisk = eocd.readUInt16LE(6);
        const entriesOnDisk = eocd.readUInt16LE(8);
        const entryCount = eocd.readUInt16LE(10);
        const centralSize = eocd.readUInt32LE(12);
        const centralOffset = eocd.readUInt32LE(16);
        if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
            throw archiveError('multi-disk backup archives are not supported');
        }
        if (entryCount < 1 || entryCount > MAX_ARCHIVE_ENTRIES) {
            throw archiveError('backup archive entry count exceeds the limit');
        }
        if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
            throw archiveError('ZIP64 backup archives are not supported');
        }
        if (centralSize < entryCount * 46 || centralSize > MAX_CENTRAL_DIRECTORY_BYTES
            || centralOffset < 0 || centralOffset + centralSize !== eocdOffset) {
            throw archiveError('backup central directory bounds are invalid');
        }

        const entries = [];
        const names = new Set();
        let cursor = centralOffset;
        let totalDeclared = 0;
        for (let index = 0; index < entryCount; index += 1) {
            const header = await readExact(handle, 46, cursor, 'central directory entry');
            if (header.readUInt32LE(0) !== 0x02014b50) {
                throw archiveError('backup central directory entry is invalid');
            }
            const versionMadeBy = header.readUInt16LE(4);
            const flags = header.readUInt16LE(8);
            const compressionMethod = header.readUInt16LE(10);
            const crc32 = header.readUInt32LE(16);
            const compressedSize = header.readUInt32LE(20);
            const uncompressedSize = header.readUInt32LE(24);
            const nameLength = header.readUInt16LE(28);
            const extraLength = header.readUInt16LE(30);
            const commentLength = header.readUInt16LE(32);
            const diskStart = header.readUInt16LE(34);
            const externalAttributes = header.readUInt32LE(38);
            const localHeaderOffset = header.readUInt32LE(42);
            if (diskStart !== 0 || localHeaderOffset === 0xffffffff
                || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
                throw archiveError('ZIP64 or multi-disk backup entries are not supported');
            }
            if ((flags & ~0x0808) !== 0 || (flags & 0x0001) !== 0) {
                throw archiveError('backup entry uses unsupported ZIP flags');
            }
            if (nameLength < 1 || nameLength > 256 || extraLength > MAX_ENTRY_HEADER_BYTES
                || commentLength > MAX_ENTRY_HEADER_BYTES) {
                throw archiveError('backup entry header exceeds the limit');
            }
            const variableLength = nameLength + extraLength + commentLength;
            if (cursor + 46 + variableLength > centralOffset + centralSize) {
                throw archiveError('backup central directory is truncated');
            }
            const nameBuffer = await readExact(handle, nameLength, cursor + 46, 'backup entry name');
            const name = decodeEntryName(nameBuffer);
            if (!ENTRY_POLICIES.has(name)) throw archiveError(`backup archive contains an unexpected entry: ${name}`);
            if (names.has(name)) throw archiveError(`backup archive contains a duplicate entry: ${name}`);
            names.add(name);
            assertEntryType(versionMadeBy, externalAttributes, name);
            const policy = ENTRY_POLICIES.get(name);
            if (uncompressedSize < 1 || uncompressedSize > policy.maxBytes) {
                throw archiveError(`backup entry size exceeds the limit: ${name}`);
            }
            const entry = {
                path: name,
                flags,
                compressionMethod,
                crc32,
                compressedSize,
                uncompressedSize,
                localHeaderOffset,
                dataOffset: null,
                dataEnd: null,
            };
            assertCompression(entry);
            totalDeclared += uncompressedSize;
            if (totalDeclared > MAX_TOTAL_UNCOMPRESSED_BYTES) {
                throw archiveError('backup archive expanded size exceeds the limit');
            }
            entries.push(entry);
            cursor += 46 + variableLength;
        }
        if (cursor !== centralOffset + centralSize) throw archiveError('backup central directory size is inconsistent');
        if (!names.has(MANIFEST_PATH)) throw archiveError('backup archive manifest is missing');
        if (!names.has(DATABASE_PATH)) throw archiveError('backup archive database is missing');

        for (const entry of entries) {
            if (entry.localHeaderOffset + 30 > centralOffset) throw archiveError('backup local entry bounds are invalid');
            const local = await readExact(handle, 30, entry.localHeaderOffset, 'local entry header');
            if (local.readUInt32LE(0) !== 0x04034b50) throw archiveError('backup local entry header is invalid');
            const localFlags = local.readUInt16LE(6);
            const localMethod = local.readUInt16LE(8);
            const localCrc32 = local.readUInt32LE(14);
            const localCompressedSize = local.readUInt32LE(18);
            const localUncompressedSize = local.readUInt32LE(22);
            const localNameLength = local.readUInt16LE(26);
            const localExtraLength = local.readUInt16LE(28);
            if (localFlags !== entry.flags || localMethod !== entry.compressionMethod
                || localNameLength < 1 || localNameLength > 256 || localExtraLength > MAX_ENTRY_HEADER_BYTES) {
                throw archiveError(`backup local header disagrees with central directory: ${entry.path}`);
            }
            const localName = await readExact(handle, localNameLength, entry.localHeaderOffset + 30, 'local entry name');
            if (decodeEntryName(localName) !== entry.path) {
                throw archiveError(`backup local entry path mismatch: ${entry.path}`);
            }
            if ((entry.flags & 0x0008) === 0
                && (localCrc32 !== entry.crc32 || localCompressedSize !== entry.compressedSize
                    || localUncompressedSize !== entry.uncompressedSize)) {
                throw archiveError(`backup local entry sizes disagree with central directory: ${entry.path}`);
            }
            entry.dataOffset = entry.localHeaderOffset + 30 + localNameLength + localExtraLength;
            entry.dataEnd = entry.dataOffset + entry.compressedSize;
            if (entry.dataEnd > centralOffset) throw archiveError(`backup entry data is out of bounds: ${entry.path}`);
        }
        const ranges = [...entries].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset);
        for (let index = 1; index < ranges.length; index += 1) {
            if (ranges[index].localHeaderOffset < ranges[index - 1].dataEnd) {
                throw archiveError('backup entry data ranges overlap');
            }
        }
        return { archiveFile: resolved, archiveBytes: stat.size, entries, totalDeclared, handle };
    } catch (error) {
        await handle?.close().catch(() => {});
        throw error;
    }
}

async function parseCentralDirectory(archiveFile) {
    const archive = await openAndParseCentralDirectory(archiveFile);
    try {
        const { handle: _handle, ...result } = archive;
        return result;
    } finally {
        await archive.handle.close();
    }
}

async function streamEntry(archive, entry, { expected = null, outputFile = null, collect = false, totalState }) {
    const chunks = [];
    let actualBytes = 0;
    const hash = crypto.createHash('sha256');
    const meter = new Transform({
        transform(chunk, _encoding, callback) {
            actualBytes += chunk.length;
            if (actualBytes > entry.uncompressedSize
                || totalState.actual + chunk.length > MAX_TOTAL_UNCOMPRESSED_BYTES) {
                callback(archiveError(`backup entry expands beyond its declared size: ${entry.path}`));
                return;
            }
            totalState.actual += chunk.length;
            hash.update(chunk);
            if (collect) chunks.push(Buffer.from(chunk));
            callback(null, chunk);
        },
    });
    let outputHandle = null;
    let outputIdentity = null;
    if (outputFile) {
        outputHandle = await fs.promises.open(
            outputFile,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
                | Number(fs.constants.O_NOFOLLOW || 0),
            0o600,
        );
        outputIdentity = await outputHandle.stat({ bigint: true });
        if (!outputIdentity.isFile() || outputIdentity.nlink !== 1n) {
            await outputHandle.close();
            throw archiveError(`backup extraction target is invalid: ${entry.path}`);
        }
    }
    const sink = outputHandle
        ? fs.createWriteStream(outputFile, { fd: outputHandle.fd, autoClose: false })
        : new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const source = Readable.from((async function* readCompressedRange() {
        let position = entry.dataOffset;
        let remaining = entry.compressedSize;
        while (remaining > 0) {
            const chunk = Buffer.alloc(Math.min(64 * 1024, remaining));
            const { bytesRead } = await archive.handle.read(chunk, 0, chunk.length, position);
            if (!bytesRead) throw archiveError(`backup entry is truncated: ${entry.path}`);
            position += bytesRead;
            remaining -= bytesRead;
            yield bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead);
        }
    }()));
    const streams = entry.compressionMethod === 8
        ? [source, zlib.createInflateRaw(), meter, sink]
        : [source, meter, sink];
    let pipelineError = null;
    let outputCloseError = null;
    try {
        await pipeline(...streams);
    } catch (error) {
        pipelineError = error;
    } finally {
        if (outputHandle) {
            try {
                if (!pipelineError) await outputHandle.sync();
            } finally {
                try { await outputHandle.close(); } catch (error) { outputCloseError = error; }
            }
        }
    }
    if (outputCloseError && !pipelineError) {
        throw archiveError(`backup extraction target could not be closed: ${entry.path}`);
    }
    if (pipelineError) {
        if (pipelineError?.code === 'invalid_backup_archive') throw pipelineError;
        throw archiveError(`backup entry is truncated or cannot be decompressed: ${entry.path}`);
    }
    const digest = hash.digest('hex');
    if (actualBytes !== entry.uncompressedSize) {
        throw archiveError(`backup entry size does not match the archive: ${entry.path}`);
    }
    if (expected && (expected.bytes !== actualBytes || expected.sha256 !== digest)) {
        throw archiveError(`backup entry does not match the manifest: ${entry.path}`);
    }
    if (outputIdentity) {
        const completed = fs.lstatSync(outputFile, { bigint: true, throwIfNoEntry: false });
        if (!completed?.isFile() || completed.isSymbolicLink() || completed.nlink !== 1n
            || !sameIdentity(outputIdentity, completed) || completed.size !== BigInt(actualBytes)) {
            throw archiveError(`backup extraction target changed: ${entry.path}`);
        }
    }
    return {
        buffer: collect ? Buffer.concat(chunks, actualBytes) : null,
        bytes: actualBytes,
        sha256: digest,
        outputIdentity,
    };
}

function parseManifest(buffer, archiveEntries) {
    let parsed;
    try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        if (text.charCodeAt(0) === 0xfeff) throw new Error('BOM is not allowed');
        parsed = JSON.parse(text);
    } catch {
        throw archiveError('backup archive manifest is not valid UTF-8 JSON');
    }
    if (!hasExactKeys(parsed, ['format', 'version', 'entries']) || parsed.format !== BACKUP_FORMAT) {
        throw archiveError('backup archive manifest schema is invalid');
    }
    if (parsed.version !== BACKUP_MANIFEST_VERSION) {
        throw archiveError(`backup archive manifest version is unsupported: ${String(parsed.version)}`);
    }
    if (!Array.isArray(parsed.entries) || parsed.entries.length < 1 || parsed.entries.length > PAYLOAD_ORDER.length) {
        throw archiveError('backup archive manifest entries are invalid');
    }
    const manifestEntries = new Map();
    for (const descriptor of parsed.entries) {
        if (!hasExactKeys(descriptor, ['path', 'bytes', 'sha256'])
            || !PAYLOAD_ORDER.includes(descriptor.path)
            || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1
            || descriptor.bytes > ENTRY_POLICIES.get(descriptor.path).maxBytes
            || typeof descriptor.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(descriptor.sha256)) {
            throw archiveError('backup archive manifest entry schema is invalid');
        }
        if (manifestEntries.has(descriptor.path)) {
            throw archiveError(`backup manifest contains a duplicate entry: ${descriptor.path}`);
        }
        manifestEntries.set(descriptor.path, descriptor);
    }
    if (!manifestEntries.has(DATABASE_PATH)) throw archiveError('backup manifest database entry is missing');

    const payloadEntries = archiveEntries.filter((entry) => entry.path !== MANIFEST_PATH);
    if (payloadEntries.length !== manifestEntries.size) {
        throw archiveError('backup archive entries do not match the manifest');
    }
    for (const entry of payloadEntries) {
        const descriptor = manifestEntries.get(entry.path);
        if (!descriptor || descriptor.bytes !== entry.uncompressedSize) {
            throw archiveError(`backup archive entry size does not match the manifest: ${entry.path}`);
        }
    }
    return { manifest: parsed, entries: manifestEntries };
}

async function extractBackupArchive({ archiveFile, outputDirectory, faultInjector = null } = {}) {
    const directory = path.resolve(String(outputDirectory || ''));
    let directoryToken = null;
    try {
        directoryToken = openDirectoryIdentity(directory, {
            label: 'backup extraction directory',
            requirePrivate: process.platform !== 'win32',
        });
    } catch {
        throw archiveError('backup extraction directory is invalid');
    }
    let archive = null;
    const databaseFile = path.join(directory, DATABASE_PATH);
    const stagingName = `.zephyr-backup-extract-${process.pid}-${crypto.randomUUID()}`;
    const stagingDirectory = path.join(directory, stagingName);
    let stagingToken = null;
    let stagedDatabaseIdentity = null;
    let installedDatabaseIdentity = null;
    try {
        if (typeof faultInjector === 'function') faultInjector('archive:extraction_directory_opened');
        assertDirectoryIdentity(directoryToken);
        fs.mkdirSync(directoryEntryPath(directoryToken, stagingName), { recursive: false, mode: 0o700 });
        assertDirectoryIdentity(directoryToken);
        stagingToken = openDirectoryIdentity(stagingDirectory, {
            label: 'backup extraction staging directory',
            requirePrivate: process.platform !== 'win32',
        });
        assertDirectoryIdentity(directoryToken);
        archive = await openAndParseCentralDirectory(archiveFile);
        const byName = new Map(archive.entries.map((entry) => [entry.path, entry]));
        const totalState = { actual: 0 };
        const manifestResult = await streamEntry(archive, byName.get(MANIFEST_PATH), {
            collect: true,
            totalState,
        });
        const parsedManifest = parseManifest(manifestResult.buffer, archive.entries);
        const databaseEntry = byName.get(DATABASE_PATH);
        assertDirectoryIdentity(stagingToken);
        const stagedDatabaseFile = directoryEntryPath(stagingToken, DATABASE_PATH);
        const databaseResult = await streamEntry(archive, databaseEntry, {
            expected: parsedManifest.entries.get(DATABASE_PATH),
            outputFile: stagedDatabaseFile,
            totalState,
        });
        stagedDatabaseIdentity = databaseResult.outputIdentity;
        assertDirectoryIdentity(stagingToken);

        let keyBuffer = null;
        if (byName.has(KEY_PATH)) {
            const result = await streamEntry(archive, byName.get(KEY_PATH), {
                expected: parsedManifest.entries.get(KEY_PATH),
                collect: true,
                totalState,
            });
            keyBuffer = result.buffer;
        }
        let metadataBuffer = null;
        if (byName.has(METADATA_PATH)) {
            const result = await streamEntry(archive, byName.get(METADATA_PATH), {
                expected: parsedManifest.entries.get(METADATA_PATH),
                collect: true,
                totalState,
            });
            metadataBuffer = result.buffer;
        }
        if (totalState.actual !== archive.totalDeclared) {
            throw archiveError('backup archive expanded size is inconsistent');
        }

        assertDirectoryIdentity(stagingToken);
        assertDirectoryIdentity(directoryToken);
        verifyNamedIdentity(stagedDatabaseFile, stagedDatabaseIdentity, 'staged backup database');
        if (typeof faultInjector === 'function') faultInjector('archive:before_database_commit');
        assertDirectoryIdentity(stagingToken);
        assertDirectoryIdentity(directoryToken);
        if (fs.lstatSync(directoryEntryPath(directoryToken, DATABASE_PATH), {
            bigint: true,
            throwIfNoEntry: false,
        })) {
            throw archiveError('backup extraction database target already exists');
        }
        assertDirectoryIdentity(directoryToken);
        try {
            copyFileExclusiveDurably(
                stagedDatabaseFile,
                directoryEntryPath(directoryToken, DATABASE_PATH),
                { mode: 0o600, stagePrefix: 'archive:database_commit' },
            );
        } catch (error) {
            if (error?.code === 'EEXIST') {
                throw archiveError('backup extraction database target already exists');
            }
            throw error;
        }
        installedDatabaseIdentity = fs.lstatSync(databaseFile, { bigint: true });
        assertDirectoryIdentity(stagingToken);
        assertDirectoryIdentity(directoryToken);
        verifyNamedIdentity(databaseFile, installedDatabaseIdentity, 'extracted backup database');
        removeFileDurably(stagedDatabaseFile, {
            allowMissing: false,
            expectedIdentity: stagedDatabaseIdentity,
            parentToken: stagingToken,
            label: 'staged backup database',
        });
        stagedDatabaseIdentity = null;
        const installedDatabase = verifyNamedIdentity(
            databaseFile,
            installedDatabaseIdentity,
            'extracted backup database',
        );
        if (!installedDatabase.isFile() || installedDatabase.isSymbolicLink() || installedDatabase.nlink !== 1n) {
            throw archiveError('extracted backup database link count is invalid');
        }
        return {
            databaseFile,
            keyBuffer,
            metadataBuffer,
            manifest: parsedManifest.manifest,
        };
    } catch (error) {
        if (stagedDatabaseIdentity && stagingToken) {
            try {
                removeFileDurably(directoryEntryPath(stagingToken, DATABASE_PATH), {
                    allowMissing: true,
                    expectedIdentity: stagedDatabaseIdentity,
                    parentToken: stagingToken,
                    label: 'staged backup database',
                });
            } catch {}
        }
        if (installedDatabaseIdentity) {
            try {
                removeFileDurably(directoryEntryPath(directoryToken, DATABASE_PATH), {
                    allowMissing: true,
                    expectedIdentity: installedDatabaseIdentity,
                    parentToken: directoryToken,
                    label: 'extracted backup database',
                });
            } catch {}
        }
        throw error;
    } finally {
        const cleanupErrors = [];
        if (archive) {
            try { await archive.handle.close(); } catch (error) { cleanupErrors.push(error); }
        }
        try { closeDirectoryIdentity(stagingToken); } catch (error) { cleanupErrors.push(error); }
        if (stagingToken) {
            try {
                verifyNamedIdentity(stagingDirectory, stagingToken.identity, 'backup extraction staging directory');
                scrubPathDurably(stagingDirectory, { allowMissing: true });
            } catch (error) { cleanupErrors.push(error); }
        }
        if (installedDatabaseIdentity) {
            try {
                assertDirectoryIdentity(directoryToken);
                verifyNamedIdentity(databaseFile, installedDatabaseIdentity, 'extracted backup database');
            } catch (error) { cleanupErrors.push(error); }
        }
        try { closeDirectoryIdentity(directoryToken); } catch (error) { cleanupErrors.push(error); }
        if (cleanupErrors.length) {
            throw new AggregateError(cleanupErrors, 'backup extraction cleanup or identity verification failed');
        }
    }
}

module.exports = {
    BACKUP_FORMAT,
    BACKUP_MANIFEST_VERSION,
    DATABASE_PATH,
    KEY_PATH,
    MANIFEST_PATH,
    MAX_ARCHIVE_BYTES,
    MAX_COMPRESSION_RATIO,
    MAX_DATABASE_BYTES,
    MAX_KEY_BYTES,
    METADATA_PATH,
    createBackupArchiveBuffer,
    extractBackupArchive,
    parseCentralDirectory,
};
