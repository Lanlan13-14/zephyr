const crypto = require('crypto');
const { KIND } = require('./link-v2-codec');
const { verifyP1363 } = require('./mobile-v1-proof');
const { LinkAIDispatchStore } = require('./link-ai-dispatch-store');
const rpcError = (code, status = 400) => Object.assign(new Error('AI request rejected'), {code,status,retryable:false});

const object = value => value && typeof value === 'object' && !Array.isArray(value);
function text(value, max = 200) { return typeof value === 'string' && value.trim() && value.length <= max && !value.includes('\0'); }
function checkKeys(body, keys) {
    if (!object(body) || Object.keys(body).some(key => !keys.includes(key))) throw rpcError('invalid_request');
}
function tokenEqual(expected, given) {
    const a = Buffer.from(String(expected || '')), b = Buffer.from(String(given || ''));
    return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a,b);
}
function approvalProofPayload({ deviceId, requestId, runId, approvalId, inputHash, approve, expiresAt, challenge }) {
    return Buffer.from(['zephyr-link-ai-approval-v1', deviceId, requestId, runId, approvalId, inputHash,
        approve ? 'approve' : 'deny', String(expiresAt), challenge].join('\0'));
}

function createLinkAiBridge({ resolveAuth, storage, runtime, startCanonical, adminToken, clock = Date.now,
    operational = () => true, authorize = () => {} }) {
    const stores = new WeakMap();
    function dispatchStore() {
        const database = storage.rawDb();
        let store = stores.get(database);
        if (!store) { store = new LinkAIDispatchStore(database); stores.set(database,store); }
        return store;
    }
    const approvals = new Map(); // bounded short-lived challenges; never prompt/provider credentials
    function authFor(deviceId, expected) {
        if (!operational()) throw rpcError('database_maintenance',503);
        const auth = resolveAuth(deviceId);
        authorize(auth);
        if (!text(String(auth.user.userId)) || !Number.isSafeInteger(auth.device.binding_revision) ||
            auth.device.binding_revision < 1 || !text(auth.device.signing_public_jwk,4096)) throw rpcError('ai_binding_expired',403);
        const stableScope = JSON.stringify([String(auth.user.userId), deviceId,
            String(auth.device.binding_revision), auth.device.signing_public_jwk]);
        const scope = JSON.stringify([runtime.databaseGeneration,stableScope]);
        if (expected && expected !== scope) throw rpcError('ai_binding_expired',403);
        return { ...auth, scope, stableScope };
    }
    function current(deviceId, scope) { return authFor(deviceId,scope); }
    async function dispatch(deviceId, body) {
        if (!text(deviceId) || !object(body)) throw rpcError('invalid_request');
        const auth = authFor(deviceId);
        const op = body.op;
        if (op === 'status') {
            checkKeys(body,['op']);
            return { ok: true, enabled: runtime.enabled, executionTargets: ['remote_host'], protocol: 'ZSL-AI-RPC/1' };
        }
        if (op === 'ai.command.dispatch') {
            checkKeys(body,['op','requestId','conversationId','prompt','providerId','model','context','executionTarget']);
            if (!text(body.requestId) || !text(body.prompt,64000) || !text(body.conversationId) || body.executionTarget !== 'remote_host') throw rpcError('invalid_request');
            if (body.context !== undefined) checkKeys(body.context,['transport','connectionId']);
            if (body.context !== undefined && (!object(body.context) || body.context.transport !== 'SSH' || !text(body.context.connectionId))) throw rpcError('unsupported_execution_target');
            const allowed = body.context == null ? null : { transport: 'SSH', connectionId: body.context.connectionId };
            const payload = { conversationId: body.conversationId, message: body.prompt, providerId: body.providerId,
                model: body.model, context: allowed, autoConfirm: false, mcpServers: [], maxSteps: 16 };
            if ((body.providerId !== undefined && !text(body.providerId)) || (body.model !== undefined && !text(body.model,300))) throw rpcError('invalid_request');
            return dispatchStore().dispatch({scope:auth.stableScope,requestId:body.requestId,input:body,
                generation:runtime.databaseGeneration,
                assertLive:() => current(deviceId,auth.scope),
                execute:() => startCanonical(auth.user,payload,() => current(deviceId,auth.scope)),
            });
        }
        if (!['ai.command.result','ai.stream.event','ai.command.cancel','ai.approval.decision'].includes(op) || !text(body.requestId)) throw rpcError('unsupported_operation');
        checkKeys(body, op === 'ai.approval.decision'
            ? ['op','requestId','approvalId','inputHash','approve','expiresAt','challenge','proof','providerId','model']
            : op === 'ai.command.cancel' ? ['op','requestId'] : ['op','requestId','afterSeq']);
        if (op === 'ai.approval.decision' && (!text(body.approvalId) || !/^[a-f0-9]{64}$/.test(body.inputHash || '') ||
            typeof body.approve !== 'boolean' || !Number.isSafeInteger(body.expiresAt) || body.expiresAt < 1 ||
            !/^[A-Za-z0-9_-]{32}$/.test(body.challenge || '') || !/^[A-Za-z0-9+/]{86}==$/.test(body.proof || '') ||
            (body.providerId !== undefined && !text(body.providerId)) || (body.model !== undefined && !text(body.model,300)))) throw rpcError('invalid_request');
        const receipt = dispatchStore().query(auth.stableScope,body.requestId,runtime.databaseGeneration);
        if (!receipt.runId) return receipt;
        const runId = receipt.runId;
        if (op === 'ai.command.cancel') {
            await runtime.abortRun(auth.user,runId);
            current(deviceId,auth.scope);
            return { ok:true,requestId:body.requestId,runId,state:'aborted' };
        }
        if (op === 'ai.approval.decision') {
            const key = auth.scope+'\0'+runId;
            const entry = approvals.get(key);
            if (!entry || entry.expiresAt <= clock() || body.expiresAt !== entry.expiresAt ||
                body.challenge !== entry.challenge || body.approvalId !== entry.approvalId ||
                body.inputHash !== entry.inputHash || typeof body.approve !== 'boolean') throw rpcError('approval_required',403);
            let jwk;
            try { jwk = JSON.parse(auth.device.signing_public_jwk); } catch { throw rpcError('approval_required',403); }
            if (!verifyP1363({ jwk, payload:approvalProofPayload({ ...body,deviceId,runId }), proof:body.proof })) throw rpcError('approval_required',403);
            // One challenge, one attempt. Even a timeout cannot repeat a privileged side effect.
            approvals.delete(key);
            const snapshot = await runtime.getRunSnapshot(auth.user,runId,-1);
            current(deviceId,auth.scope);
            if (snapshot.run?.sessionId !== receipt.sessionId || snapshot.run?.userId !== auth.user.userId) throw rpcError('ai_run_scope_mismatch',403);
            const pending = snapshot.approval;
            if (!pending || pending.inputHash !== entry.inputHash || pending.approvalId !== entry.approvalId) throw rpcError('approval_required',403);
            const provider = await resolveProvider(auth.user,body.providerId,body.model);
            current(deviceId,auth.scope);
            const result = await runtime.decidePermission(auth.user,runId,{
                userId:auth.user.userId, sessionId:receipt.sessionId, callId:pending.callId, tool:pending.tool,
                inputHash:pending.inputHash, approve:body.approve, scope:'once',
                // Provider credentials are reinjected by the same canonical resolver, never clients.
                provider,
            });
            current(deviceId,auth.scope);
            return { ok:true,requestId:body.requestId,runId,approved:result.approved === true,resumed:result.resumed === true };
        }
        const after = body.afterSeq === undefined ? -1 : body.afterSeq;
        if (!Number.isSafeInteger(after) || after < -1) throw rpcError('invalid_cursor');
        const result = await runtime.getRunSnapshot(auth.user,runId,after);
        current(deviceId,auth.scope);
        if (result.run?.sessionId !== receipt.sessionId || result.run?.userId !== auth.user.userId) throw rpcError('ai_run_scope_mismatch',403);
        let approval;
        if (result.approval) {
            for (const [key,value] of approvals) if (value.expiresAt <= clock()) approvals.delete(key);
            const key = auth.scope+'\0'+runId;
            let entry = approvals.get(key);
            if (!entry || entry.inputHash !== result.approval.inputHash || entry.approvalId !== result.approval.approvalId) {
                if (approvals.size >= 1000) throw rpcError('approval_capacity',429);
                entry = {...result.approval, challenge:crypto.randomBytes(24).toString('base64url'), expiresAt:clock()+120000};
                approvals.set(key,entry);
            }
            approval = entry;
        }
        return { ok:true,requestId:body.requestId,runId,conversationId:receipt.conversationId,
            executionTarget:'remote_host',state:result.run?.status || 'unknown',
            events:result.events || [],nextSeq:result.nextSeq,hasMore:result.hasMore === true,approval };
    }
    let resolveProvider = async () => undefined;
    function setProviderResolver(resolver) { resolveProvider = resolver; }
    async function handle(req,res) {
        if (!tokenEqual(adminToken,req.get('X-Link-Admin'))) return res.status(401).json({ok:false,error:{code:'unauthorized',message:'Link authentication failed'}});
        try {
            const {deviceId,kind,body} = req.body || {};
            if (kind !== KIND.AI) throw rpcError('unsupported_kind');
            const result = await dispatch(deviceId,body);
            res.json({ok:true,kind:KIND.AI,body:result});
        } catch (error) {
            res.status(Number(error.status)||500).json({ok:false,error:{code:typeof error.code === 'string' ? error.code : 'internal_error',message:'AI request rejected',retryable:false}});
        }
    }
    return {dispatch,handle,setProviderResolver};
}
module.exports = {createLinkAiBridge,approvalProofPayload};
