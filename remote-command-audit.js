'use strict';

const crypto = require('crypto');

const COMMAND_DIGEST_DOMAIN = 'zephyr.remote-command-audit.v1\0';

function commandDigest(command) {
    return crypto.createHash('sha256')
        .update(COMMAND_DIGEST_DOMAIN, 'utf8')
        .update(String(command ?? ''), 'utf8')
        .digest('hex');
}

function summarizeRemoteCommand(command, results, targetCount) {
    const rows = Array.isArray(results) ? results : [];
    const failed = rows.filter((row) => row?.success !== true);
    let result = 'success';
    let errorCode = null;
    if (!rows.length) {
        result = 'failed';
        errorCode = 'remote_command_no_eligible_targets';
    } else if (failed.length) {
        result = failed.length === rows.length ? 'failed' : 'partial_failure';
        if (failed.every((row) => row?.denied === true)) errorCode = 'remote_command_target_denied';
        else if (failed.some((row) => row?.status === 'timeout')) errorCode = 'remote_command_timeout';
        else if (failed.some((row) => row?.status === 'aborted')) errorCode = 'remote_command_aborted';
        else errorCode = 'remote_command_failed';
    }
    return {
        commandLength: Buffer.byteLength(String(command ?? ''), 'utf8'),
        commandDigest: commandDigest(command),
        targetCount: Math.max(0, Number(targetCount) || 0),
        result,
        errorCode,
    };
}

module.exports = { COMMAND_DIGEST_DOMAIN, commandDigest, summarizeRemoteCommand };
