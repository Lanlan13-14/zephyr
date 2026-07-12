import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { X224_CONNECTION_REQUEST, parseX224ConnectionConfirm } = require('../server/rdp-cert-probe');

function confirm(selectedProtocol = 2) {
    const packet = Buffer.alloc(19);
    packet.set([0x03, 0x00, 0x00, 0x13, 0x0e, 0xd0, 0, 0, 0, 0, 0, 0x02, 0, 0x08, 0]);
    packet.writeUInt32LE(selectedProtocol, 15);
    return packet;
}

test('certificate probe sends X.224 negotiation before TLS', () => {
    assert.equal(X224_CONNECTION_REQUEST.subarray(0, 4).toString('hex'), '03000013');
    assert.equal(X224_CONNECTION_REQUEST[5], 0xe0);
    assert.equal(X224_CONNECTION_REQUEST.readUInt32LE(15), 3);
});

test('certificate probe accepts HYBRID and SSL negotiation responses', () => {
    assert.equal(parseX224ConnectionConfirm(confirm(2)).selectedProtocol, 2);
    assert.equal(parseX224ConnectionConfirm(confirm(1)).selectedProtocol, 1);
});

test('certificate probe rejects standard RDP security and malformed confirms', () => {
    assert.throws(() => parseX224ConnectionConfirm(confirm(0)), /without TLS/);
    const malformed = confirm(2);
    malformed[5] = 0xe0;
    assert.throws(() => parseX224ConnectionConfirm(malformed), /Connection Confirm/);
});
