import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

test('remote hashing pipelines reads instead of waiting on each one', () => {
    const start = src.indexOf('async function sftpHashFile');
    assert.ok(start > 0, 'sftpHashFile missing');
    const fn = src.slice(start, src.indexOf('\nasync function ', start + 1));

    // One read in flight at a time is what made verification through an Agent
    // bastion stall at 100%: every chunk paid a full tunnel round trip.
    assert.match(fn, /SFTP_HASH_PIPELINE/);
    assert.match(fn, /issued - nextFold < SFTP_HASH_PIPELINE/);

    const cap = src.match(/const SFTP_HASH_PIPELINE = (\d+);/);
    assert.ok(cap, 'pipeline depth missing');
    assert.ok(Number(cap[1]) >= 8, 'pipeline too shallow to hide tunnel latency');

    // Out-of-order replies must be buffered and folded in file order, or the
    // digest changes with the network instead of the file.
    assert.match(fn, /pending\.set\(index/);
    assert.match(fn, /await pending\.get\(nextFold\)/);
    assert.match(fn, /index !== nextFold/);
});
