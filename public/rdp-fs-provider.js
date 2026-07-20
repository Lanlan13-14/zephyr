/*
 * rdp-fs-provider.js — Agent presence and RDP drive lifecycle only.
 *
 * File bytes never cross the page thread. Go WASM in rdp-worker.js talks to
 * /file-transfer over ZFT2 binary WebSocket and completes RDPEFS IRPs
 * asynchronously. This module intentionally contains no sync XHR fallback.
 */

const RPC_BASE = '/api/rdp/file-agents';
let onlineAgents = [];
let attachedAgents = new Map();
let eventSource = null;
let onAgentsChanged = null;

export function subscribeAgentEvents(callback) {
    onAgentsChanged = callback;
    if (eventSource) { eventSource.close(); eventSource = null; }
    eventSource = new EventSource(`${RPC_BASE}/events`);
    eventSource.addEventListener('agent_list', (event) => {
        try {
            onlineAgents = JSON.parse(event.data).agents || [];
            onAgentsChanged?.([...onlineAgents]);
        } catch {}
    });
    eventSource.addEventListener('file_agent_online', (event) => {
        try {
            const agent = JSON.parse(event.data).agent;
            if (!agent) return;
            const index = onlineAgents.findIndex((item) => item.agentId === agent.agentId);
            if (index >= 0) onlineAgents[index] = agent;
            else onlineAgents.push(agent);
            onAgentsChanged?.([...onlineAgents]);
        } catch {}
    });
    eventSource.addEventListener('file_agent_offline', (event) => {
        try {
            const agentId = JSON.parse(event.data).agentId;
            onlineAgents = onlineAgents.filter((agent) => agent.agentId !== agentId);
            if (attachedAgents.has(agentId)) detachDrive(agentId);
            onAgentsChanged?.([...onlineAgents]);
        } catch {}
    });
}

export function unsubscribeAgentEvents() {
    if (eventSource) { eventSource.close(); eventSource = null; }
    onAgentsChanged = null;
}

export function getOnlineAgents() { return [...onlineAgents]; }
export function getAttachedAgents() { return new Map(attachedAgents); }
export function resetAttachedDriveState() { attachedAgents.clear(); }

function safeDriveName(name, fallback = 'AGENT') {
    const raw = String(name || fallback).trim() || fallback;
    return raw.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || fallback;
}

export function syncAgentDrives({ enabled = true } = {}) {
    if (!enabled || typeof globalThis.rdpFsAttachDrive !== 'function') return;
    for (const agent of onlineAgents) {
        if (!agent?.agentId || agent.online === false || Number(agent.protocolVersion || 1) < 2) continue;
        const driveName = safeDriveName(agent.deviceName || agent.shareName || agent.tokenName || 'AGENT');
        attachDrive(agent.agentId, driveName, agent.readOnly !== false);
    }
}

export function attachDrive(agentId, driveName, readOnly) {
    if (attachedAgents.has(agentId)) return true;
    if (typeof globalThis.rdpFsAttachDrive !== 'function') return false;
    const deviceId = globalThis.rdpFsAttachDrive(agentId, driveName, readOnly);
    if (deviceId === null || deviceId === undefined || deviceId === false) return false;
    attachedAgents.set(agentId, { driveName, readOnly, deviceId });
    console.info(`[rdp-fs] attached ZFT2 drive: ${driveName} → ${agentId} (${deviceId})`);
    return true;
}

export function detachDrive(agentId) {
    if (!attachedAgents.has(agentId)) return;
    if (typeof globalThis.rdpFsDetachDrive === 'function') globalThis.rdpFsDetachDrive(agentId);
    attachedAgents.delete(agentId);
}

export function detachAllDrives() {
    for (const agentId of [...attachedAgents.keys()]) detachDrive(agentId);
}
