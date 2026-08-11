'use strict';

const { isDeepStrictEqual } = require('util');

const PORTABLE_WORKSPACE_VERSION = 1;
const MAX_PORTABLE_ITEMS = 100;
const ALLOWED_PROTOCOLS = new Set(['SSH', 'TELNET', 'RDP', 'VNC']);

class WorkspacePortableProjectionError extends Error {
    constructor(message) {
        super(message);
        this.name = 'WorkspacePortableProjectionError';
        this.code = 'invalid_request';
        this.status = 400;
        this.retryable = false;
    }
}

function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function invalid(message) {
    throw new WorkspacePortableProjectionError(message);
}

function normalizeProtocol(value) {
    const protocol = String(value || 'SSH').trim().toUpperCase();
    return ALLOWED_PROTOCOLS.has(protocol) ? protocol : 'SSH';
}

function rawItems(state) {
    if (!isObject(state)) return [];
    if (Array.isArray(state.tabs)) return state.tabs;
    if (Array.isArray(state.layout?.items)) return state.layout.items;
    return [];
}

/**
 * Produces the only workspace state allowed in the account sync mirror.
 *
 * A saved Web workspace contains live terminal/session state. This projection
 * intentionally retains only ordered references to connections owned by the
 * same immutable account. Session ids, tab ids, active/minimized flags,
 * terminal frames, clipboard, AI runs, scroll positions and split coordinates
 * are not inspected, which makes adding one of them to the Web snapshot unable
 * to widen the mobile contract accidentally.
 */
function projectPortableWorkspaceState(state, {
    ownerUserId,
    resolveOwnedResource,
    strict = false,
} = {}) {
    if (state != null && !isObject(state)) {
        if (strict) invalid('Workspace state must be an object.');
        state = {};
    }
    const items = rawItems(state);
    if (strict && items.length > MAX_PORTABLE_ITEMS) {
        invalid(`Workspace contains more than ${MAX_PORTABLE_ITEMS} portable resources.`);
    }

    const tabs = [];
    for (const item of items.slice(0, MAX_PORTABLE_ITEMS)) {
        if (!isObject(item)) {
            if (strict) invalid('Workspace layout items must be objects.');
            continue;
        }
        const connectionId = String(item.connectionId || (
            item.resourceType === 'connection' ? item.resourceId : ''
        ) || '').trim();
        if (!connectionId) {
            if (strict) invalid('Workspace layout items require an owned connection reference.');
            continue;
        }
        const owned = typeof resolveOwnedResource === 'function'
            && resolveOwnedResource('connection', connectionId, String(ownerUserId || '')) === true;
        if (!owned) {
            if (strict) invalid('Workspace references a connection that is not owned by this account.');
            continue;
        }
        tabs.push({
            connectionId,
            protocol: normalizeProtocol(item.protocol),
            order: tabs.length,
        });
    }

    return {
        version: PORTABLE_WORKSPACE_VERSION,
        tabs,
    };
}

/**
 * Applies a portable layout without importing another device's runtime state.
 * Existing per-tab runtime fields are retained only for the matching owned
 * connection occurrence; newly introduced items start without runtime data.
 */
function mergePortableWorkspaceState(canonicalState, portableState) {
    const current = isObject(canonicalState) ? canonicalState : {};
    const existing = Array.isArray(current.tabs) ? current.tabs : [];
    const buckets = new Map();
    for (const tab of existing) {
        if (!isObject(tab)) continue;
        const id = String(tab.connectionId || '').trim();
        if (!id) continue;
        if (!buckets.has(id)) buckets.set(id, []);
        buckets.get(id).push(tab);
    }

    const tabs = (portableState?.tabs || []).map((item, index) => {
        const prior = buckets.get(item.connectionId)?.shift() || {};
        return {
            ...prior,
            connectionId: item.connectionId,
            protocol: item.protocol,
            order: index,
        };
    });
    return {
        ...current,
        version: Math.max(2, Number(current.version) || 0),
        tabs,
    };
}

function samePortableWorkspace(left, right) {
    return isDeepStrictEqual(left || null, right || null);
}

module.exports = {
    PORTABLE_WORKSPACE_VERSION,
    MAX_PORTABLE_ITEMS,
    WorkspacePortableProjectionError,
    projectPortableWorkspaceState,
    mergePortableWorkspaceState,
    samePortableWorkspace,
};
