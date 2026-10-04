import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

function valueOf(expr) {
    assert.match(expr, /^[0-9 *+\-]+$/);
    return Function(`"use strict"; return (${expr});`)();
}

test('main-end sftp upload splits writes under the OpenSSH message cap', () => {
    const match = src.match(/const SFTP_MAX_WRITE_BYTES = ([0-9 *+\-]+);/);
    assert.ok(match, 'SFTP_MAX_WRITE_BYTES missing');
    const cap = valueOf(match[1].trim());
    // ssh2 caps an OpenSSH write at 256 KiB minus the 2 KiB it reserves for
    // the header. Anything larger is sent whole and the server drops it.
    assert.ok(cap <= 256 * 1024 - 2 * 1024, `cap ${cap} too high`);
    assert.ok(cap >= 64 * 1024, `cap ${cap} too low`);

    const fn = src.slice(src.indexOf('function sftpWriteBounded'), src.indexOf('function sftpWriteBounded') + 800);
    assert.match(fn, /Math\.min\(SFTP_MAX_WRITE_BYTES, buffer\.length - sent\)/);

    assert.match(src, /sftpWriteBounded\(session\.sftp, session\.fileHandle, buffer, offset\)/);
    assert.doesNotMatch(src, /session\.sftp\.write\(session\.fileHandle, buffer, 0, buffer\.length, offset/);

    // An 8 MiB browser chunk must come out as several writes, none over the cap.
    const pieces = [];
    for (let sent = 0, total = 8 * 1024 * 1024; sent < total;) {
        const n = Math.min(cap, total - sent);
        pieces.push(n);
        sent += n;
    }
    assert.ok(pieces.length > 1);
    assert.ok(pieces.every((n) => n <= cap));
    assert.equal(pieces.reduce((a, b) => a + b, 0), 8 * 1024 * 1024);
});
