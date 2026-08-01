import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless');
const { createTerminalSnapshot } = require('../terminal-snapshot');

const write = (terminal, data) => new Promise((resolve) => terminal.write(data, resolve));

test('snapshot revision forms an exact boundary for output arriving during resume', async () => {
    const snapshot = createTerminalSnapshot({ cols: 24, rows: 5, scrollback: 100 });
    await snapshot.write('base', 17);
    const serializeJob = snapshot.serialize({ scrollback: 50 });
    const newerJob = snapshot.write('-newer', 18);
    const frame = await serializeJob;
    await newerJob;

    assert.equal(frame.revision, 1);
    assert.equal(frame.outputSequence, 17);
    assert.match(frame.data, /base/);
    assert.doesNotMatch(frame.data, /newer/);

    const client = new Terminal({ cols: 24, rows: 5, scrollback: 100, allowProposedApi: true });
    await write(client, `\x1bc${frame.data}`);
    await write(client, '-newer');
    assert.equal(client.buffer.active.getLine(0).translateToString(true), 'base-newer');
    snapshot.dispose();
    client.dispose();
});

test('snapshot collapses repeated CR redraws to the latest visual frame', async () => {
    const snapshot = createTerminalSnapshot({ cols: 30, rows: 4, scrollback: 50 });
    await snapshot.write('progress 10%');
    await snapshot.write('\rprogress 55%');
    await snapshot.write('\rprogress 100%');
    const frame = await snapshot.serialize();
    assert.match(frame.data, /progress 100%/);
    assert.doesNotMatch(frame.data, /progress 10%/);
    assert.doesNotMatch(frame.data, /progress 55%/);
    snapshot.dispose();
});
