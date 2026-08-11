'use strict';

const childProcess = require('child_process');
const methods = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
let safe = Object.isFrozen(childProcess);

for (const method of methods) {
    try {
        childProcess[method]();
        safe = false;
    } catch (error) {
        if (error?.code !== 'ERR_CHILD_PROCESS_DISABLED') safe = false;
    }
}
try { childProcess.spawn = () => {}; } catch {}
try {
    childProcess.spawn();
    safe = false;
} catch (error) {
    if (error?.code !== 'ERR_CHILD_PROCESS_DISABLED') safe = false;
}

process.exitCode = safe ? 0 : 4;
