import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/* OpenSSH sftp-server rejects any message whose length exceeds this and then
 * exits, which the client sees as "EOF while reading packet". */
const OPENSSH_MAX_MESSAGE = 256 * 1024;
/* Bytes sshj prepends to the payload in one WRITE: type, request id, handle
 * length, offset, data length. The handle itself is extra, so the margin below
 * must also cover it. */
const WRITE_FRAMING = 1 + 4 + 4 + 8 + 4;

function chunkValue(source, pattern) {
    const match = source.match(pattern);
    assert.ok(match, `${pattern} not found`);
    const expr = match[1].trim();
    assert.match(expr, /^[0-9 *+\-]+$/, `${expr} is not plain arithmetic`);
    return Function(`"use strict"; return (${expr});`)();
}

test('SFTP write chunks stay under the OpenSSH message cap once framed', () => {
    const values = [
        chunkValue(read('zephyr_one/mobile/android/feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/SftpTransferOps.kt'), /STREAM_CHUNK\s*=\s*([0-9 *+\-]+)/),
        chunkValue(read('zephyr_one/mobile/android/protocol-ssh/src/main/kotlin/one/zephyr/mobile/protocol/ssh/SshjEngine.kt'), /STREAM_CHUNK_BYTES\s*=\s*([0-9 *+\-]+)/),
    ];
    for (const value of values) {
        assert.ok(value >= 64 * 1024, `chunk ${value} is too small to be useful`);
        assert.ok(value + WRITE_FRAMING <= OPENSSH_MAX_MESSAGE, `chunk ${value} exceeds the OpenSSH cap once framed`);
    }
});
