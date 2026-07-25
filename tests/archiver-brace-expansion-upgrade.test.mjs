import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

function packageVersion(name) {
    const entry = require.resolve(name);
    let dir = path.dirname(entry);
    while (dir !== path.dirname(dir)) {
        const pkg = path.join(dir, 'package.json');
        if (fs.existsSync(pkg)) {
            const version = JSON.parse(fs.readFileSync(pkg, 'utf8')).version;
            if (version) return version;
        }
        dir = path.dirname(dir);
    }
    throw new Error(`package.json not found for ${name}`);
}

test('brace-expansion v5 is used through a compatible minimatch v10 chain', () => {
    const braceExpansion = require('brace-expansion');
    const { minimatch } = require('minimatch');

    assert.match(packageVersion('brace-expansion'), /^5\./);
    assert.match(packageVersion('minimatch'), /^10\./);
    assert.equal(typeof braceExpansion.expand, 'function');
    assert.equal(braceExpansion.EXPANSION_MAX_LENGTH > 0, true);
    assert.deepEqual(braceExpansion.expand('file{1..3}.txt'), ['file1.txt', 'file2.txt', 'file3.txt']);
    assert.equal(minimatch('file2.txt', 'file{1..3}.txt'), true);

    // CVE-2026-14257: chained pairs must be capped by aggregate output length,
    // rather than allocating an unbounded expansion result.
    const capped = braceExpansion.expand('{a,b}'.repeat(100));
    const totalLength = capped.reduce((sum, item) => sum + item.length, 0);
    assert.ok(totalLength <= braceExpansion.EXPANSION_MAX_LENGTH);
});

test('archiver v8 ESM ZipArchive writes a valid archive', async () => {
    const { ZipArchive } = await import('archiver');
    assert.match(packageVersion('archiver'), /^8\./);

    const outputPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-archiver-test-')), 'test.zip');
    await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outputPath);
        const archive = new ZipArchive({ zlib: { level: 9 } });
        output.on('close', resolve);
        output.on('error', reject);
        archive.on('error', reject);
        archive.pipe(output);
        archive.append('zephyr', { name: 'payload.txt' });
        archive.finalize();
    });
    const zip = fs.readFileSync(outputPath);
    assert.equal(zip.subarray(0, 2).toString(), 'PK');
    fs.rmSync(path.dirname(outputPath), { recursive: true, force: true });
});
