'use strict';

const X224_CONNECTION_REQUEST = Buffer.from([
    0x03, 0x00, 0x00, 0x13,
    0x0e, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x08, 0x00,
    0x03, 0x00, 0x00, 0x00,
]);

function parseX224ConnectionConfirm(packet) {
    if (!Buffer.isBuffer(packet) || packet.length < 11) throw new Error('short X.224 Connection Confirm');
    if (packet[0] !== 0x03 || packet[1] !== 0x00) throw new Error('invalid TPKT header');
    const packetLength = packet.readUInt16BE(2);
    if (packetLength !== packet.length) throw new Error(`invalid TPKT length ${packetLength}/${packet.length}`);
    if ((packet[5] & 0xf0) !== 0xd0) throw new Error('RDP server did not return X.224 Connection Confirm');
    for (let offset = 11; offset + 8 <= packet.length; offset++) {
        const type = packet[offset];
        const length = packet.readUInt16LE(offset + 2);
        if (length !== 8) continue;
        if (type === 0x03) throw new Error(`RDP negotiation failed with code ${packet.readUInt32LE(offset + 4)}`);
        if (type === 0x02) {
            const selectedProtocol = packet.readUInt32LE(offset + 4);
            if ((selectedProtocol & 0x03) === 0) throw new Error('RDP server selected standard RDP security without TLS');
            return { selectedProtocol };
        }
    }
    throw new Error('RDP server omitted negotiation response');
}

function negotiateRdpTls(socket, { timeoutMs = 8000 } = {}) {
    return new Promise((resolve, reject) => {
        let buffer = Buffer.alloc(0);
        let timer = null;
        let settled = false;
        const cleanup = () => {
            if (timer) clearTimeout(timer);
            socket.off('data', onData);
            socket.off('error', onError);
            socket.off('close', onClose);
        };
        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error); else resolve(result);
        };
        const onError = (error) => finish(error);
        const onClose = () => finish(new Error('RDP socket closed during X.224 negotiation'));
        const onData = (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            if (buffer.length < 4) return;
            const length = buffer.readUInt16BE(2);
            if (length < 11 || length > 65535) return finish(new Error(`invalid RDP TPKT length ${length}`));
            if (buffer.length < length) return;
            if (buffer.length > length) socket.unshift(buffer.subarray(length));
            try { finish(null, parseX224ConnectionConfirm(buffer.subarray(0, length))); }
            catch (error) { finish(error); }
        };
        socket.on('data', onData);
        socket.once('error', onError);
        socket.once('close', onClose);
        timer = setTimeout(() => finish(new Error('RDP X.224 negotiation timeout')), timeoutMs);
        socket.write(X224_CONNECTION_REQUEST, (error) => { if (error) finish(error); });
    });
}

module.exports = { X224_CONNECTION_REQUEST, parseX224ConnectionConfirm, negotiateRdpTls };
