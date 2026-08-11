import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSecureTestDataDir, removeSecureTestDataDir } from './helpers/secure-data-dir.mjs';

const SERVER_FIXTURE_FILES = [
    'backup-encryption-server.test.mjs',
    'database-import-lifecycle.test.mjs',
    'mobile-v1-blob-http.test.mjs',
    'session-restart.test.mjs',
    'test-server.mjs',
    'webdav-production-server.test.mjs',
    'zephyr-one-backup-restore.test.mjs',
    'zephyr-one-desktop-boot-browser.test.mjs',
    'zephyr-one-desktop-surface-live.test.mjs',
    'zephyr-one-embedded-bootstrap-auth.test.mjs',
];

test('server test data directories have a private wrapper and private data child', () => {
    const fixture = createSecureTestDataDir('zephyr-secure-fixture-contract-');
    try {
        assert.equal(path.dirname(fixture.dataDir), fixture.root);
        assert.equal(fs.lstatSync(fixture.root).isSymbolicLink(), false);
        assert.equal(fs.lstatSync(fixture.dataDir).isSymbolicLink(), false);
        if (process.platform !== 'win32') {
            const uid = process.geteuid();
            for (const directory of [fixture.root, fixture.dataDir]) {
                const stat = fs.statSync(directory);
                assert.equal(stat.uid, uid);
                assert.equal(stat.mode & 0o777, 0o700);
            }
        }
    } finally {
        removeSecureTestDataDir(fixture);
    }
});

test('every direct server-launch fixture uses the secure data-directory helper', () => {
    for (const file of SERVER_FIXTURE_FILES) {
        const source = fs.readFileSync(path.join(import.meta.dirname, file), 'utf8');
        assert.match(source, /createSecureTestDataDir\(/, file);
        assert.doesNotMatch(
            source,
            /ZEPHYR_DATA_DIR:[\s\S]{0,120}?mkdtempSync\(path\.join\(os\.tmpdir\(\)/,
            file,
        );
    }
});
