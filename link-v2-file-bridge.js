'use strict';

const METHODS = new Set([
    'open', 'readBinary', 'writeBinary', 'close', 'stat', 'list',
    'mkdir', 'delete', 'rename', 'truncate', 'ping',
]);

function createLinkFileBridge({ fileAgentManager, storage, adminToken, log = console.log } = {}) {
    if (!fileAgentManager) throw new Error('file link bridge requires fileAgentManager');
    if (!storage) throw new Error('file link bridge requires storage');
    if (typeof adminToken !== 'string' || adminToken.length < 16) throw new Error('file link bridge requires admin token');

    function equalToken(got) {
        if (typeof got !== 'string' || got.length !== adminToken.length) return false;
        let diff = 0;
        for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ adminToken.charCodeAt(i);
        return diff === 0;
    }

    function findAgent(deviceId) {
        const id = String(deviceId || '');
        const candidates = fileAgentManager.listAllAgents().filter((agent) =>
            agent.deviceId === id
            && agent.capabilities?.linkFileBridge === true
            && agent.capabilities?.binary === true
            && agent.online === true);
        if (candidates.length !== 1) {
            const error = new Error(candidates.length ? 'multiple agents for device' : 'Agent is not Link-enabled');
            error.code = candidates.length ? 'agent_ambiguous' : 'agent_link_required';
            error.status = 404;
            throw error;
        }
        return candidates[0];
    }

    async function handle(req, res) {
        if (!equalToken(req.get('X-Link-Admin') || '')) {
            res.status(401).json({ ok: false, error: { code: 'unauthorized', message: '内部通道未授权' } });
            return;
        }
        const body = req.body || {};
        const deviceId = String(body.deviceId || '');
        const op = String(body.op || '');
        if (!deviceId || !METHODS.has(op)) {
            res.status(400).json({ ok: false, error: { code: 'invalid_file_bridge_request', message: '文件桥接请求无效' } });
            return;
        }
        try {
            const agent = findAgent(deviceId);
            const params = { ...(body.params || {}) };
            if (op === 'writeBinary' && typeof params.data === 'string') params.data = Buffer.from(params.data, 'base64');
            const result = await fileAgentManager.callAgentV2(agent.agentId, op, params, 60000).promise;
            const payload = result instanceof Uint8Array || Buffer.isBuffer(result)
                ? Buffer.from(result).toString('base64') : null;
            res.json({ ok: true, result: payload == null ? (result || {}) : { encoding: 'base64', data: payload } });
        } catch (error) {
            log('[link-file] bridge request failed:', error.code || error.message);
            res.status(Number(error.status) || 502).json({
                ok: false,
                error: { code: String(error.code || 'file_bridge_failed'), message: String(error.message || '文件桥接失败'), retryable: error.code === 'timeout' || error.code === 'agent_offline' },
            });
        }
    }
    return { handle };
}

module.exports = { createLinkFileBridge };
