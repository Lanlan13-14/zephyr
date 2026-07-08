/**
 * rdp-fs-provider.js — File Agent Bridge for RDP Drive Redirection
 *
 * Provides the globalThis.zephyrRdpFs* functions that Go WASM's rdpefs.go
 * calls synchronously. Under the hood these use a SharedArrayBuffer-based
 * blocking pattern to call async HTTP RPCs to the server, which forwards
 * to the correct Flutter Agent via WebSocket.
 *
 * Also manages SSE subscription for live agent status and provides UI hooks.
 */

/* ─── Configuration ─────────────────────────────────────────────── */
const RPC_BASE = '/api/rdp/file-agents';
const RPC_TIMEOUT = 30000;
// Read-ahead is deliberately conservative.  Large single RPCs (multi-MiB
// base64 JSON over HTTP/WebSocket) are what made multi-GB copies brittle: one
// slow chunk times out and Windows drops the whole redirected drive.  Keep each
// Agent read bounded and let Windows issue the next READ if it asked for more.
const READ_AHEAD_BYTES = 512 * 1024;
const READ_RPC_MAX_BYTES = 512 * 1024;
const READ_CACHE_MAX_HANDLES = 8;

/* ─── State ─────────────────────────────────────────────────────── */
let onlineAgents = [];         // [{agentId, deviceName, platform, online, readOnly, ...}]
let attachedAgents = new Map(); // agentId → {driveName, readOnly, deviceId}
let eventSource = null;
let onAgentsChanged = null;    // callback(agents[])
let readCache = new Map();     // `${agentId}:${handle}` → { offset, data: Uint8Array, ts }
let binaryReadUnsupported = new Set(); // agentId values that returned 426 for binary read

/* ─── SSE Subscription ──────────────────────────────────────────── */

export function subscribeAgentEvents(callback) {
    onAgentsChanged = callback;
    if (eventSource) { eventSource.close(); eventSource = null; }

    eventSource = new EventSource(`${RPC_BASE}/events`);

    eventSource.addEventListener('agent_list', (e) => {
        try {
            const data = JSON.parse(e.data);
            onlineAgents = data.agents || [];
            if (onAgentsChanged) onAgentsChanged(onlineAgents);
        } catch {}
    });

    eventSource.addEventListener('file_agent_online', (e) => {
        try {
            const data = JSON.parse(e.data);
            const agent = data.agent;
            if (!agent) return;
            const idx = onlineAgents.findIndex(a => a.agentId === agent.agentId);
            if (idx >= 0) onlineAgents[idx] = agent;
            else onlineAgents.push(agent);
            if (onAgentsChanged) onAgentsChanged([...onlineAgents]);
        } catch {}
    });

    eventSource.addEventListener('file_agent_offline', (e) => {
        try {
            const data = JSON.parse(e.data);
            const agentId = data.agentId;
            onlineAgents = onlineAgents.filter(a => a.agentId !== agentId);
            if (onAgentsChanged) onAgentsChanged([...onlineAgents]);

            // Auto-detach if was attached
            if (attachedAgents.has(agentId)) {
                detachDrive(agentId);
            }
        } catch {}
    });

    eventSource.onerror = () => {
        // Reconnect is automatic with EventSource
    };
}

export function unsubscribeAgentEvents() {
    if (eventSource) { eventSource.close(); eventSource = null; }
    onAgentsChanged = null;
}

export function getOnlineAgents() {
    return [...onlineAgents];
}

export function getAttachedAgents() {
    return new Map(attachedAgents);
}

export function resetAttachedDriveState() {
    attachedAgents.clear();
}

function safeDriveName(name, fallback = 'AGENT') {
    const raw = String(name || fallback).trim() || fallback;
    const ascii = raw.replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
    return ascii || fallback;
}

export function syncAgentDrives({ enabled = true } = {}) {
    if (!enabled || typeof globalThis.rdpFsAttachDrive !== 'function') return;
    for (const agent of onlineAgents) {
        if (!agent?.agentId || agent.online === false) continue;
        const driveName = safeDriveName(agent.deviceName || agent.shareName || agent.tokenName || 'AGENT');
        attachDrive(agent.agentId, driveName, agent.readOnly !== false);
    }
}

export function attachDrive(agentId, driveName, readOnly) {
    if (attachedAgents.has(agentId)) return true;

    // Call Go WASM to register the drive. If the current RDP session has not
    // created its RDPEFS handler yet, do not mark it attached; a later
    // rdpOnReady/SSE sync will retry against the fresh handler.
    if (typeof globalThis.rdpFsAttachDrive !== 'function') return false;
    const deviceId = globalThis.rdpFsAttachDrive(agentId, driveName, readOnly);
    if (deviceId === null || deviceId === undefined || deviceId === false) return false;

    attachedAgents.set(agentId, { driveName, readOnly, deviceId });
    console.info(`[rdp-fs] attached drive: ${driveName} → ${agentId} (${deviceId})`);
    return true;
}

export function detachDrive(agentId) {
    if (!attachedAgents.has(agentId)) return;

    // Call Go WASM to remove the drive
    if (typeof globalThis.rdpFsDetachDrive === 'function') {
        globalThis.rdpFsDetachDrive(agentId);
    }

    attachedAgents.delete(agentId);
    console.info(`[rdp-fs] detached drive: ${agentId}`);
}

export function detachAllDrives() {
    for (const agentId of [...attachedAgents.keys()]) {
        detachDrive(agentId);
    }
}

/* ─── Synchronous RPC helpers (called from Go WASM) ─────────────
 *
 * Go WASM rdpefs.go calls these via js.Global().Call(). Since Go can only
 * do synchronous calls into JS, these must return results synchronously.
 * We use XMLHttpRequest (synchronous mode, which is allowed in workers and
 * WASM contexts) to achieve this. This is intentional and necessary.
 *
 * The server endpoint /api/rdp/file-agents/:agentId/rpc forwards the
 * request to the correct Agent via WebSocket and waits for the response.
 */

function syncRpc(agentId, method, params) {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${RPC_BASE}/${agentId}/rpc`, false); // synchronous
    xhr.setRequestHeader('Content-Type', 'application/json');
    // Synchronous XMLHttpRequest cannot use timeout in a document context;
    // the server-side Agent RPC has its own timeout.
    try {
        xhr.send(JSON.stringify({ method, params }));
    } catch (e) {
        console.warn(`[rdp-fs] RPC error: ${method}`, e);
        return null;
    }
    if (xhr.status !== 200) {
        console.warn(`[rdp-fs] RPC failed: ${method} → ${xhr.status}`);
        return null;
    }
    try {
        const resp = JSON.parse(xhr.responseText);
        if (!resp.ok) {
            console.warn(`[rdp-fs] RPC error: ${method}`, resp.error);
            return null;
        }
        return resp.result;
    } catch {
        return null;
    }
}

function cacheKey(agentId, handle) {
    return `${agentId}:${handle}`;
}

function trimReadCache() {
    if (readCache.size <= READ_CACHE_MAX_HANDLES) return;
    const entries = [...readCache.entries()].sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
    while (readCache.size > READ_CACHE_MAX_HANDLES && entries.length) {
        readCache.delete(entries.shift()[0]);
    }
}

function clearReadCache(agentId, handle) {
    if (handle) readCache.delete(cacheKey(agentId, handle));
}

function decodeBase64Bytes(dataBase64) {
    if (!dataBase64 || dataBase64.length === 0) return new Uint8Array(0);
    const binaryStr = atob(dataBase64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
    }
    return bytes;
}

function rpcReadBytesBinary(agentId, handle, offset, length) {
    if (binaryReadUnsupported.has(agentId)) return null;
    const xhr = new XMLHttpRequest();
    const url = `${RPC_BASE}/${agentId}/rpc/read-binary?handle=${encodeURIComponent(handle)}&offset=${encodeURIComponent(offset)}&length=${encodeURIComponent(length)}`;
    xhr.open('POST', url, false);
    // responseType='arraybuffer' is not allowed for synchronous XHR on some
    // browsers/main-thread contexts.  x-user-defined preserves byte values in
    // responseText so we can reconstruct Uint8Array without base64/JSON.
    if (xhr.overrideMimeType) xhr.overrideMimeType('text/plain; charset=x-user-defined');
    try {
        xhr.send(null);
    } catch (e) {
        console.warn('[rdp-fs] binary read transport error', e);
        return null;
    }
    if (xhr.status === 426) {
        binaryReadUnsupported.add(agentId);
        return null;
    }
    if (xhr.status !== 200) {
        console.warn(`[rdp-fs] binary read failed → ${xhr.status}`);
        return null;
    }
    const text = xhr.responseText || '';
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xFF;
    return bytes;
}

function rpcReadBytes(agentId, handle, offset, length) {
    const binary = rpcReadBytesBinary(agentId, handle, offset, length);
    if (binary !== null) return binary;
    const result = syncRpc(agentId, 'read', { handle, offset, length });
    if (!result) return null;
    return decodeBase64Bytes(result.dataBase64);
}

function cachedRead(agentId, handle, offset, length) {
    const key = cacheKey(agentId, handle);
    const cached = readCache.get(key);
    const wantStart = Number(offset) || 0;
    const wantLen = Math.max(0, Number(length) || 0);
    if (wantLen === 0) return new Uint8Array(0);
    const wantEnd = wantStart + wantLen;
    if (cached && wantStart >= cached.offset && wantEnd <= cached.offset + cached.data.length) {
        cached.ts = Date.now();
        return cached.data.subarray(wantStart - cached.offset, wantEnd - cached.offset);
    }

    const fetchLen = Math.min(Math.max(wantLen, READ_AHEAD_BYTES), READ_RPC_MAX_BYTES);
    let bytes = rpcReadBytes(agentId, handle, wantStart, fetchLen);
    // If an opportunistic read-ahead fails, retry with the exact Windows
    // request size before reporting failure.  This preserves correctness on
    // slow links or memory-constrained phones.
    if (bytes === null && fetchLen > wantLen) {
        bytes = rpcReadBytes(agentId, handle, wantStart, Math.min(wantLen, READ_RPC_MAX_BYTES));
    }
    if (bytes === null) return null;
    readCache.set(key, { offset: wantStart, data: bytes, ts: Date.now() });
    trimReadCache();
    return bytes.subarray(0, Math.min(wantLen, bytes.length));
}

/* ─── Global functions for Go WASM ──────────────────────────────
 * These are set on globalThis so rdpefs.go can call them via
 * js.Global().Call("zephyrRdpFsList", ...) etc.
 */

globalThis.zephyrRdpFsList = function(agentId, path) {
    const result = syncRpc(agentId, 'list', { path: path || '/' });
    if (!result || !result.entries) return null;
    return result.entries;
};

globalThis.zephyrRdpFsStat = function(agentId, path) {
    const result = syncRpc(agentId, 'stat', { path: path || '/' });
    // Return null for not-found so Go can send STATUS_NO_SUCH_FILE.
    return result || null;
};

globalThis.zephyrRdpFsOpen = function(agentId, path, mode) {
    const result = syncRpc(agentId, 'open', { path, mode: mode || 'read' });
    // Return '' (empty string) on failure so Go detects the missing handle.
    if (!result || !result.handle) return '';
    return result.handle;
};

globalThis.zephyrRdpFsRead = function(agentId, handle, offset, length) {
    const bytes = cachedRead(agentId, handle, offset, length);
    if (bytes === null) return null;
    // Empty read (EOF) — return empty array, NOT null.
    // Returning null would cause rdpefs.go to send STATUS_UNSUCCESSFUL,
    // which Windows surfaces as 0x8007048F "device not connected" on copy.
    return bytes;
};

globalThis.zephyrRdpFsWrite = function(agentId, handle, offset, uint8Data) {
    clearReadCache(agentId, handle);
    // Encode to base64
    let binary = '';
    for (let i = 0; i < uint8Data.length; i++) {
        binary += String.fromCharCode(uint8Data[i]);
    }
    const dataBase64 = btoa(binary);
    const result = syncRpc(agentId, 'write', { handle, offset, dataBase64 });
    if (!result) return 0;
    return result.bytesWritten || 0;
};

globalThis.zephyrRdpFsClose = function(agentId, handle) {
    clearReadCache(agentId, handle);
    syncRpc(agentId, 'close', { handle });
};

globalThis.zephyrRdpFsMkdir = function(agentId, path) {
    const result = syncRpc(agentId, 'mkdir', { path });
    return result !== null;
};

globalThis.zephyrRdpFsDelete = function(agentId, path) {
    const result = syncRpc(agentId, 'delete', { path, recursive: false });
    return result !== null;
};

globalThis.zephyrRdpFsRename = function(agentId, oldPath, newPath) {
    const result = syncRpc(agentId, 'rename', { oldPath, newPath });
    return result !== null;
};

globalThis.zephyrRdpFsTruncate = function(agentId, path, size) {
    const result = syncRpc(agentId, 'truncate', { path, size });
    return result !== null;
};

/* ─── Token management ──────────────────────────────────────────── */

export async function getAgentToken() {
    const resp = await fetch('/api/rdp/file-agent-token');
    const data = await resp.json();
    return data.ok ? data.token : null;
}

export async function regenerateAgentToken() {
    const resp = await fetch('/api/rdp/file-agent-token/regenerate', { method: 'POST' });
    const data = await resp.json();
    return data.ok ? data.token : null;
}
