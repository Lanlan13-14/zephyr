'use strict';

function parseLoopbackListen(value, fallbackPort = 3080) {
    const raw = String(value || '').trim();
    const match = raw.match(/^([^:]+):(\d{1,5})$/);
    const host = match ? match[1] : '127.0.0.1';
    const port = match ? Number(match[2]) : fallbackPort;
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
        throw new Error(`ZEPHYR_AI_HOST_LISTEN must be loopback-only, got ${host}`);
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid ZEPHYR_AI_HOST_LISTEN port: ${port}`);
    }
    return { host: host === 'localhost' ? '127.0.0.1' : host, port };
}

module.exports = { parseLoopbackListen };
