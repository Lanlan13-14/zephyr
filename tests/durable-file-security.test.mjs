import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    isDurableTombstoneName,
    listDurableTombstoneRecords,
    removeFileDurably,
    scrubFileAndRemoveDurably,
    scrubPathDurably,
} = require('../durable-file');

function childSwapFile(file) {
    const moved = `${file}.moved-${crypto.randomUUID()}`;
    const script = `
      const fs = require('fs');
      const [file, moved] = process.argv.slice(1);
      fs.renameSync(file, moved);
      fs.writeFileSync(file, 'replacement-name', { flag: 'wx', mode: 0o600 });
    `;
    const result = spawnSync(process.execPath, ['-e', script, file, moved], {
        encoding: 'utf8',
        windowsHide: true,
    });
    return { moved, result };
}

function childSwapDirectory(directory, outside) {
    const moved = `${directory}.moved-${crypto.randomUUID()}`;
    const script = `
      const fs = require('fs');
      const [directory, moved, outside, type] = process.argv.slice(1);
      fs.renameSync(directory, moved);
      fs.symlinkSync(outside, directory, type);
    `;
    const result = spawnSync(process.execPath, [
        '-e', script, directory, moved, outside,
        process.platform === 'win32' ? 'junction' : 'dir',
    ], { encoding: 'utf8', windowsHide: true });
    return { moved, result };
}

function removeDirectoryLink(link) {
    const stat = fs.lstatSync(link, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isSymbolicLink()) {
        if (process.platform === 'win32') fs.rmdirSync(link);
        else fs.unlinkSync(link);
        return;
    }
    fs.rmSync(link, { recursive: true, force: true });
}

test('sensitive cleanup rechecks identity after closing the scrubbed file and before unlink', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-durable-file-race-'));
    const file = path.join(root, 'secret.bin');
    fs.writeFileSync(file, crypto.randomBytes(1024), { mode: 0o600 });
    let attack = null;
    let failure = null;
    try {
        try {
            scrubFileAndRemoveDurably(file, {
                stagePrefix: 'test:scrub',
                faultInjector(stage) {
                    if (stage === 'test:scrub:before_unlink') attack = childSwapFile(file);
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
        assert.equal(fs.readFileSync(file, 'utf8'), 'replacement-name');
        assert.equal(fs.statSync(attack.moved).size, 1024);
        assert.equal(fs.readFileSync(attack.moved).every((byte) => byte === 0), true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('quarantine cleanup never deletes a replacement installed after final source verification', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-durable-quarantine-race-'));
    const file = path.join(root, 'secret.bin');
    fs.writeFileSync(file, crypto.randomBytes(1024), { mode: 0o600 });
    let attack = null;
    let failure = null;
    try {
        try {
            scrubFileAndRemoveDurably(file, {
                stagePrefix: 'test:quarantine',
                faultInjector(stage) {
                    if (stage === 'test:quarantine:after_source_verification') {
                        attack = childSwapFile(file);
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
        assert.match(String(failure?.message || ''), /quarantine changed during secure filesystem access/i);
        assert.equal(fs.statSync(attack.moved).size, 1024);
        assert.equal(fs.readFileSync(attack.moved).every((byte) => byte === 0), true);
        const quarantines = fs.readdirSync(root)
            .filter(isDurableTombstoneName);
        assert.equal(quarantines.length, 1);
        assert.equal(fs.readFileSync(path.join(root, quarantines[0]), 'utf8'), 'replacement-name');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a post-verification quarantine swap preserves the replacement and sanitizes only the opened identity', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-durable-verified-race-'));
    const file = path.join(root, 'secret.bin');
    const secret = crypto.randomBytes(4096);
    fs.writeFileSync(file, secret, { mode: 0o600 });
    let attack = null;
    let failure = null;
    try {
        try {
            removeFileDurably(file, {
                allowMissing: false,
                stagePrefix: 'test:verified',
                faultInjector(stage) {
                    if (stage !== 'test:verified:after_quarantine_verification') return;
                    const quarantine = fs.readdirSync(root)
                        .map((name) => path.join(root, name))
                        .find((candidate) => isDurableTombstoneName(path.basename(candidate)));
                    attack = childSwapFile(quarantine);
                },
            });
        } catch (error) {
            failure = error;
        }
        if (!attack || attack.result.status !== 0) {
            t.skip(`the platform denied the competing rename: ${attack?.result.stderr || 'not attempted'}`);
            return;
        }
        assert.match(String(failure?.message || ''), /quarantine changed after verification/i);
        assert.equal(fs.readFileSync(attack.moved).length, 0, 'the verified open identity must be sanitized');
        const replacement = attack.moved.replace(/\.moved-[0-9a-f-]+$/i, '');
        assert.equal(fs.readFileSync(replacement, 'utf8'), 'replacement-name');
        assert.equal(listDurableTombstoneRecords().some((record) => (
            record.path === replacement && record.state === 'replacement_retained'
        )), true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('normal durable removal retains only a zero-length hidden tombstone', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-durable-tombstone-'));
    const file = path.join(root, 'secret.bin');
    fs.writeFileSync(file, crypto.randomBytes(512), { mode: 0o600 });
    try {
        assert.equal(removeFileDurably(file, { allowMissing: false }), true);
        assert.equal(fs.existsSync(file), false);
        const entries = fs.readdirSync(root);
        assert.equal(entries.length, 1);
        assert.equal(isDurableTombstoneName(entries[0]), true);
        assert.equal(fs.statSync(path.join(root, entries[0])).size, 0);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('recursive cleanup retains empty directory tombstones and zero-length file tombstones', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-durable-tree-tombstones-'));
    const tree = path.join(root, 'tree');
    fs.mkdirSync(path.join(tree, 'nested'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(tree, 'nested', 'secret.bin'), crypto.randomBytes(1024), { mode: 0o600 });
    try {
        assert.equal(scrubPathDurably(tree), true);
        assert.equal(fs.existsSync(tree), false);
        const tombstones = fs.readdirSync(root)
            .filter(isDurableTombstoneName)
            .map((name) => path.join(root, name));
        assert.equal(tombstones.length, 3);
        for (const tombstone of tombstones) {
            const stat = fs.lstatSync(tombstone);
            if (stat.isDirectory()) assert.deepEqual(fs.readdirSync(tombstone), []);
            else assert.equal(stat.size, 0);
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('recursive cleanup never follows a symlink or junction outside its tree', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-durable-link-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-durable-outside-'));
    const tree = path.join(root, 'tree');
    fs.mkdirSync(tree);
    fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'outside-data', { mode: 0o600 });
    try {
        try {
            fs.symlinkSync(outside, path.join(tree, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
        } catch (error) {
            if (process.platform === 'win32' && error?.code === 'EPERM') {
                t.skip('junction creation is unavailable');
                return;
            }
            throw error;
        }
        if (process.platform === 'win32') {
            assert.throws(() => scrubPathDurably(tree), /Windows reparse point/i);
            assert.equal(fs.existsSync(tree), true);
        } else {
            scrubPathDurably(tree);
            assert.equal(fs.existsSync(tree), false);
        }
        assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'outside-data');
    } finally {
        try { removeDirectoryLink(path.join(tree, 'outside-link')); } catch {}
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test('recursive cleanup stops when a child process replaces the directory with a link', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-durable-dir-race-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-durable-dir-outside-'));
    const tree = path.join(root, 'tree');
    fs.mkdirSync(tree);
    fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'outside-data', { mode: 0o600 });
    let attack = null;
    let failure = null;
    try {
        try {
            scrubPathDurably(tree, {
                stagePrefix: 'test:tree',
                faultInjector(stage) {
                    if (stage === 'test:tree:before_directory_remove') {
                        attack = childSwapDirectory(tree, outside);
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
        assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'outside-data');
        assert.deepEqual(fs.readdirSync(outside), ['sentinel.txt']);
    } finally {
        try { removeDirectoryLink(tree); } catch {}
        if (attack?.moved) fs.rmSync(attack.moved, { recursive: true, force: true });
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});
