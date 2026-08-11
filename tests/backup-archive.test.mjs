import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    BACKUP_FORMAT,
    BACKUP_MANIFEST_VERSION,
    createBackupArchiveBuffer,
    extractBackupArchive,
    parseCentralDirectory,
} = require('../backup-archive');

const temporaryDirectories = new Set();

afterEach(() => {
    for (const directory of temporaryDirectories) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
    temporaryDirectories.clear();
});

function temporaryArchive(buffer) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-backup-archive-'));
    temporaryDirectories.add(directory);
    const archiveFile = path.join(directory, 'backup.zip');
    const outputDirectory = path.join(directory, 'output');
    fs.writeFileSync(archiveFile, buffer);
    fs.mkdirSync(outputDirectory);
    return { archiveFile, outputDirectory };
}

function digest(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function manifestFor(entries, version = BACKUP_MANIFEST_VERSION) {
    return Buffer.from(JSON.stringify({
        format: BACKUP_FORMAT,
        version,
        entries: entries.map(([entryPath, content]) => ({
            path: entryPath,
            bytes: content.length,
            sha256: digest(content),
        })),
    }));
}

async function rawZip(entries, { symlink = null } = {}) {
    const { ZipArchive } = await import('archiver');
    return new Promise((resolve, reject) => {
        const chunks = [];
        const archive = new ZipArchive({ zlib: { level: 9 } });
        archive.on('data', (chunk) => chunks.push(chunk));
        archive.on('error', reject);
        archive.on('end', () => resolve(Buffer.concat(chunks)));
        for (const entry of entries) {
            archive.append(entry.content, {
                name: entry.path,
                store: !!entry.store,
                mode: entry.mode ?? 0o600,
            });
        }
        if (symlink) archive.symlink(symlink.path, symlink.target, 0o777);
        archive.finalize();
    });
}

function replaceEverySameLength(buffer, before, after) {
    const source = Buffer.from(before);
    const replacement = Buffer.from(after);
    assert.equal(source.length, replacement.length, 'fixture paths must have the same byte length');
    const output = Buffer.from(buffer);
    let offset = 0;
    let replacements = 0;
    while ((offset = output.indexOf(source, offset)) !== -1) {
        replacement.copy(output, offset);
        offset += replacement.length;
        replacements += 1;
    }
    assert.ok(replacements >= 2, 'both local and central names must be patched');
    return output;
}

function overwriteCentralUncompressedSize(buffer, entryPath, bytes) {
    const output = Buffer.from(buffer);
    for (let offset = 0; offset + 46 <= output.length; offset += 1) {
        if (output.readUInt32LE(offset) !== 0x02014b50) continue;
        const nameLength = output.readUInt16LE(offset + 28);
        const name = output.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
        if (name !== entryPath) continue;
        output.writeUInt32LE(bytes, offset + 24);
        return output;
    }
    assert.fail(`central entry not found: ${entryPath}`);
}

function swapDirectoryFromChild(directory, replacementTarget) {
    const moved = `${directory}.moved-${crypto.randomUUID()}`;
    const script = `
        const fs = require('fs');
        const [directory, moved, target, type] = process.argv.slice(1);
        fs.renameSync(directory, moved);
        fs.symlinkSync(target, directory, type);
    `;
    const result = spawnSync(process.execPath, [
        '-e', script, directory, moved, replacementTarget,
        process.platform === 'win32' ? 'junction' : 'dir',
    ], { encoding: 'utf8', windowsHide: true });
    return { moved, result };
}

test('versioned manifest export and bounded streaming import round-trip every allowed payload', async () => {
    const database = Buffer.concat([Buffer.from('SQLite format 3\0', 'binary'), crypto.randomBytes(8192)]);
    const key = Buffer.from('{"publicKey":"test","secretKey":"test"}\n');
    const metadata = { app: 'Zephyr', appVersion: 'test', exportedAt: 1, dataEncryption: 'test' };
    const archive = await createBackupArchiveBuffer({ database, key, metadata });
    const fixture = temporaryArchive(archive);

    const central = await parseCentralDirectory(fixture.archiveFile);
    assert.deepEqual(central.entries.map((entry) => entry.path), [
        'manifest.json',
        'zephyr.db',
        'crypto/ml-kem-768-keypair.json',
        'metadata.json',
    ]);
    const restored = await extractBackupArchive(fixture);
    assert.equal(fs.readFileSync(restored.databaseFile).equals(database), true);
    assert.equal(restored.keyBuffer.equals(key), true);
    assert.deepEqual(JSON.parse(restored.metadataBuffer), metadata);
    assert.equal(restored.manifest.format, BACKUP_FORMAT);
    assert.equal(restored.manifest.version, BACKUP_MANIFEST_VERSION);
    assert.deepEqual(restored.manifest.entries.map((entry) => entry.path), [
        'zephyr.db',
        'crypto/ml-kem-768-keypair.json',
        'metadata.json',
    ]);
});

test('import rejects a missing manifest before extracting the database', async () => {
    const archive = await rawZip([{ path: 'zephyr.db', content: Buffer.from('db'), store: true }]);
    const fixture = temporaryArchive(archive);
    await assert.rejects(extractBackupArchive(fixture), /manifest is missing/i);
    assert.equal(fs.existsSync(path.join(fixture.outputDirectory, 'zephyr.db')), false);
});

test('import rejects duplicate manifest entries', async () => {
    const database = Buffer.from('db');
    const manifest = manifestFor([['zephyr.db', database]]);
    const archive = await rawZip([
        { path: 'manifest.json', content: manifest },
        { path: 'manifest.json', content: manifest },
        { path: 'zephyr.db', content: database, store: true },
    ]);
    await assert.rejects(extractBackupArchive(temporaryArchive(archive)), /duplicate entry: manifest\.json/i);
});

test('import rejects payload hash mismatch', async () => {
    const database = Buffer.from('database-content');
    const manifest = JSON.parse(manifestFor([['zephyr.db', database]]));
    manifest.entries[0].sha256 = '0'.repeat(64);
    const archive = await rawZip([
        { path: 'manifest.json', content: Buffer.from(JSON.stringify(manifest)) },
        { path: 'zephyr.db', content: database, store: true },
    ]);
    const fixture = temporaryArchive(archive);
    await assert.rejects(extractBackupArchive(fixture), /does not match the manifest: zephyr\.db/i);
    assert.equal(fs.existsSync(path.join(fixture.outputDirectory, 'zephyr.db')), false);
});

test('import rejects extra entries even when the manifest omits them', async () => {
    const database = Buffer.from('db');
    const archive = await rawZip([
        { path: 'manifest.json', content: manifestFor([['zephyr.db', database]]) },
        { path: 'zephyr.db', content: database, store: true },
        { path: 'extra.txt', content: Buffer.from('unexpected') },
    ]);
    await assert.rejects(extractBackupArchive(temporaryArchive(archive)), /unexpected entry: extra\.txt/i);
});

test('import rejects path traversal in local and central entry names', async () => {
    const database = Buffer.from('db');
    const metadata = Buffer.from('{}');
    const archive = await rawZip([
        { path: 'manifest.json', content: manifestFor([['zephyr.db', database], ['metadata.json', metadata]]) },
        { path: 'zephyr.db', content: database, store: true },
        { path: 'metadata.json', content: metadata },
    ]);
    const traversing = replaceEverySameLength(archive, 'metadata.json', '../escape.txt');
    await assert.rejects(extractBackupArchive(temporaryArchive(traversing)), /path is unsafe/i);
});

test('central directory entry limit rejects entry floods before walking attacker names', async () => {
    const entries = Array.from({ length: 20 }, (_unused, index) => ({
        path: `entry-${index}.txt`,
        content: Buffer.from('x'),
    }));
    const archive = await rawZip(entries);
    await assert.rejects(parseCentralDirectory(temporaryArchive(archive).archiveFile), /entry count exceeds the limit/i);
});

test('compression ratio limit rejects a zip bomb before decompression', async () => {
    const database = Buffer.alloc(2 * 1024 * 1024, 0);
    const archive = await rawZip([
        { path: 'manifest.json', content: manifestFor([['zephyr.db', database]]) },
        { path: 'zephyr.db', content: database },
    ]);
    await assert.rejects(extractBackupArchive(temporaryArchive(archive)), /compression ratio exceeds the limit: zephyr\.db/i);
});

test('streaming extraction stops when actual output exceeds the central-directory declaration', async () => {
    const database = crypto.randomBytes(32 * 1024);
    const manifest = Buffer.from(JSON.stringify({
        format: BACKUP_FORMAT,
        version: BACKUP_MANIFEST_VERSION,
        entries: [{ path: 'zephyr.db', bytes: 1024, sha256: digest(database) }],
    }));
    const archive = await rawZip([
        { path: 'manifest.json', content: manifest },
        { path: 'zephyr.db', content: database },
    ]);
    const understated = overwriteCentralUncompressedSize(archive, 'zephyr.db', 1024);
    const fixture = temporaryArchive(understated);
    await assert.rejects(extractBackupArchive(fixture), /expands beyond its declared size: zephyr\.db/i);
    assert.equal(fs.existsSync(path.join(fixture.outputDirectory, 'zephyr.db')), false);
});

test('truncated archives fail closed', async () => {
    const database = Buffer.from('db');
    const archive = await rawZip([
        { path: 'manifest.json', content: manifestFor([['zephyr.db', database]]) },
        { path: 'zephyr.db', content: database, store: true },
    ]);
    const truncated = archive.subarray(0, archive.length - 7);
    await assert.rejects(extractBackupArchive(temporaryArchive(truncated)), /end record is missing|truncated/i);
});

test('unknown manifest versions are rejected', async () => {
    const database = Buffer.from('db');
    const archive = await rawZip([
        { path: 'manifest.json', content: manifestFor([['zephyr.db', database]], 999) },
        { path: 'zephyr.db', content: database, store: true },
    ]);
    await assert.rejects(extractBackupArchive(temporaryArchive(archive)), /manifest version is unsupported: 999/i);
});

test('legacy unversioned metadata manifests cannot bypass archive v1 policy', async () => {
    const database = Buffer.from('db');
    const archive = await rawZip([
        { path: 'manifest.json', content: Buffer.from(JSON.stringify({ app: 'Zephyr', version: '3.0.0' })) },
        { path: 'zephyr.db', content: database, store: true },
    ]);
    await assert.rejects(extractBackupArchive(temporaryArchive(archive)), /manifest schema is invalid/i);
});

test('duplicate payload descriptors inside the manifest are rejected', async () => {
    const database = Buffer.from('db');
    const descriptor = { path: 'zephyr.db', bytes: database.length, sha256: digest(database) };
    const manifest = Buffer.from(JSON.stringify({
        format: BACKUP_FORMAT,
        version: BACKUP_MANIFEST_VERSION,
        entries: [descriptor, descriptor],
    }));
    const archive = await rawZip([
        { path: 'manifest.json', content: manifest },
        { path: 'zephyr.db', content: database, store: true },
    ]);
    await assert.rejects(extractBackupArchive(temporaryArchive(archive)), /manifest contains a duplicate entry: zephyr\.db/i);
});

test('symbolic-link entries are rejected even when their path is allowlisted', async () => {
    const database = Buffer.from('db');
    const linkContent = Buffer.from('target');
    const archive = await rawZip([
        { path: 'manifest.json', content: manifestFor([['zephyr.db', database], ['metadata.json', linkContent]]) },
        { path: 'zephyr.db', content: database, store: true },
    ], { symlink: { path: 'metadata.json', target: 'target' } });
    await assert.rejects(extractBackupArchive(temporaryArchive(archive)), /must not be a symbolic link: metadata\.json/i);
});

test('extraction rejects a symlink or junction output directory', async (t) => {
    const archive = await createBackupArchiveBuffer({ database: Buffer.from('db') });
    const fixture = temporaryArchive(archive);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-backup-outside-'));
    temporaryDirectories.add(outside);
    fs.rmSync(fixture.outputDirectory, { recursive: true });
    try {
        fs.symlinkSync(outside, fixture.outputDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
        if (process.platform === 'win32' && error?.code === 'EPERM') {
            t.skip('junction creation is unavailable');
            return;
        }
        throw error;
    }
    await assert.rejects(extractBackupArchive(fixture), /extraction directory is invalid/i);
    assert.deepEqual(fs.readdirSync(outside), []);
});

test('a child-process output-directory swap is detected before extraction can touch its target', async (t) => {
    const archive = await createBackupArchiveBuffer({ database: crypto.randomBytes(1024 * 1024) });
    const fixture = temporaryArchive(archive);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-backup-race-outside-'));
    temporaryDirectories.add(outside);
    const sentinel = path.join(outside, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'outside-data', { mode: 0o600 });
    let attack = null;
    let failure = null;
    try {
        await extractBackupArchive({
            ...fixture,
            faultInjector(stage) {
                if (stage === 'archive:extraction_directory_opened') {
                    attack = swapDirectoryFromChild(fixture.outputDirectory, outside);
                }
            },
        });
    } catch (error) {
        failure = error;
    }
    if (!attack || attack.result.status !== 0) {
        t.skip(`the platform denied the competing rename: ${attack?.result.stderr || 'not attempted'}`);
        return;
    }
    assert.match(String(failure?.message || ''), /changed during secure filesystem access/i);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside-data');
    assert.deepEqual(fs.readdirSync(outside), ['sentinel.txt']);
});

test('a child-process final-name race cannot be overwritten by archive commit', async () => {
    const archive = await createBackupArchiveBuffer({ database: crypto.randomBytes(256 * 1024) });
    const fixture = temporaryArchive(archive);
    let childResult = null;
    await assert.rejects(
        extractBackupArchive({
            ...fixture,
            faultInjector(stage) {
                if (stage !== 'archive:before_database_commit') return;
                childResult = spawnSync(process.execPath, [
                    '-e',
                    "require('fs').writeFileSync(process.argv[1], 'raced-target', { flag: 'wx' })",
                    path.join(fixture.outputDirectory, 'zephyr.db'),
                ], { encoding: 'utf8', windowsHide: true });
            },
        }),
        /database target already exists/i,
    );
    assert.equal(childResult?.status, 0, childResult?.stderr);
    assert.equal(fs.readFileSync(path.join(fixture.outputDirectory, 'zephyr.db'), 'utf8'), 'raced-target');
        assert.deepEqual(
            fs.readdirSync(fixture.outputDirectory)
                .filter((name) => !name.startsWith('.zephyr-tombstone-v1-')),
            ['zephyr.db'],
        );
});
