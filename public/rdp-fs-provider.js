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

/* ─── State ─────────────────────────────────────────────────────── */
let onlineAgents = [];         // [{agentId, deviceName, platform, online, readOnly, ...}]
let attachedAgents = new Map(); // agentId → {driveName, readOnly, deviceId}
let eventSource = null;
let onAgentsChanged = null;    // callback(agents[])

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
    return result || null;
};

globalThis.zephyrRdpFsOpen = function(agentId, path, mode) {
    const result = syncRpc(agentId, 'open', { path, mode: mode || 'read' });
    if (!result || !result.handle) return null;
    return result.handle;
};

globalThis.zephyrRdpFsRead = function(agentId, handle, offset, length) {
    const result = syncRpc(agentId, 'read', { handle, offset, length });
    if (!result || !result.dataBase64) return null;
    // Decode base64 to Uint8Array
    const binaryStr = atob(result.dataBase64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
    }
    return bytes;
};

globalThis.zephyrRdpFsWrite = function(agentId, handle, offset, uint8Data) {
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
