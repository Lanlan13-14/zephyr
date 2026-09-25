'use strict';
/* Regression: sessionExec must append a visible exec-history record and
 * readSessionExecHistory must return it owner-scoped and newest-first. */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { sessionExec, readSessionExecHistory } = require('../ai-session-exec');

(async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-hist-'));
    const userId = 'user-a';
    const sessionId = 'sess-hist';

    // Before any exec: empty history, no throw.
    const empty = await readSessionExecHistory({ userId, sessionId, dataDir, limit: 10 });
    assert.deepStrictEqual(empty, { items: [] }, 'empty history must be {items:[]}');

    // Seed a workspace file, then run a real whitelisted command (grep).
    const wsDir = path.join(dataDir, 'ai-sessions', userId, sessionId, 'workspace');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'input.txt'), 'smoke line\n');
    const res = await sessionExec({
        userId,
        sessionId,
        dataDir,
        command: 'grep',
        args: ['-o', 'smoke', 'workspace/input.txt'],
        cwd: 'workspace',
        timeoutMs: 10000,
    });
    assert.strictEqual(res.exitCode, 0, `grep must succeed: ${JSON.stringify(res)}`);

    // History file exists under outputs/ with one line.
    const histPath = path.join(dataDir, 'ai-sessions', userId, sessionId, 'outputs', 'exec-history.ndjson');
    assert.ok(fs.existsSync(histPath), 'exec-history.ndjson must exist');
    const lines = fs.readFileSync(histPath, 'utf8').split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 1, 'exactly one history line after one exec');
    const rec = JSON.parse(lines[0]);
    assert.strictEqual(rec.command, 'grep');
    assert.ok(rec.args.includes('-o') && rec.args.includes('smoke'), `args recorded: ${JSON.stringify(rec.args)}`);
    assert.strictEqual(rec.ok, true);
    assert.ok(typeof rec.ts === 'string' && rec.ts.length > 0, 'ts must be stamped');
    assert.ok(String(rec.stdoutPreview || '').includes('smoke'), 'stdout preview captured');

    // readSessionExecHistory returns it, owner-scoped.
    const hist = await readSessionExecHistory({ userId, sessionId, dataDir, limit: 5 });
    assert.strictEqual(hist.items.length, 1);
    assert.strictEqual(hist.items[0].command, 'grep');
    assert.strictEqual(hist.items[0].exitCode, 0);
    assert.strictEqual(hist.items[0].ok, true);

    // Another user cannot see it (different session root).
    const other = await readSessionExecHistory({ userId: 'user-b', sessionId, dataDir, limit: 5 });
    assert.deepStrictEqual(other, { items: [] }, 'history must be owner-scoped');

    // Second exec: newest first.
    fs.writeFileSync(path.join(wsDir, 'second.txt'), 'second line\n');
    await sessionExec({
        userId,
        sessionId,
        dataDir,
        command: 'grep',
        args: ['-o', 'second', 'workspace/second.txt'],
        cwd: 'workspace',
        timeoutMs: 10000,
    });
    const hist2 = await readSessionExecHistory({ userId, sessionId, dataDir, limit: 5 });
    assert.strictEqual(hist2.items.length, 2);
    assert.ok(String(hist2.items[0].stdoutPreview || '').includes('second'), 'newest first');

    console.log('PASS exec-history write + read');
})().catch((err) => { console.error('FAIL', err); process.exit(1); });
