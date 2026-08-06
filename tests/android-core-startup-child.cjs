'use strict';

const path = require('path');

const core = process.argv[2];
const dataDir = process.argv[3];
const aiPort = process.argv[4];
if (!core || !dataDir || !aiPort) process.exit(64);

Object.defineProperty(process, 'platform', { value: 'android', configurable: true });
require('node:sqlite');
process.chdir(core);
process.env.ZEPHYR_DATA_DIR = dataDir;
process.env.HTTP_ENABLED = 'false';
process.env.HTTPS_ENABLED = 'false';
process.env.PORT = '0';
process.env.ZEPHYR_AI_HOST_LISTEN = `127.0.0.1:${aiPort}`;
process.env.ZEPHYR_ONE_USE_BUILTIN_SQLITE = '1';

require(path.join(core, 'server.js'));
// server.js prints the AI-host ready marker after all startup promises resolve.
// A process boundary makes cleanup deterministic even though the server owns
// timers and sockets intended for normal long-running operation.
setTimeout(() => process.exit(0), 3000);
