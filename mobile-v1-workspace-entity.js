'use strict';

const { HttpError } = require('./authz');

const EDITABLE_FIELDS = Object.freeze(['name', 'state']);

function safePatch(patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new HttpError(400, 'invalid_request', 'Workspace patch must be an object.');
    }
    const output = {};
    for (const key of Object.keys(patch)) {
        if (!EDITABLE_FIELDS.includes(key)) {
            throw new HttpError(400, 'invalid_request', `Workspace field ${key} is not portable.`);
        }
        output[key] = patch[key];
    }
    return output;
}

function createWorkspacePortableAdapter({ service } = {}) {
    if (!service) return null;
    const required = ['list', 'read', 'residency', 'create', 'update', 'remove', 'restore'];
    if (required.some((name) => typeof service[name] !== 'function')) return null;
    return {
        idOf(row) {
            const id = String(row?.workspaceId || '').trim();
            if (!id) throw new TypeError('Portable workspace rows require a stable workspaceId');
            return id;
        },
        revisionOf(row) {
            const revision = Number(row?.revision);
            if (!Number.isInteger(revision) || revision < 1) {
                throw new TypeError('Portable workspace rows require a positive integer revision');
            }
            return revision;
        },
        fieldMaskOf: () => EDITABLE_FIELDS.slice(),
        residency: (user, id) => service.residency(user, id),
        list: (user) => service.list(user),
        read: (user, id) => service.read(user, id),
        create: (user, id, patch, mutationContext) => (
            service.create(user, id, safePatch(patch), mutationContext)
        ),
        update: (user, id, patch, mutationContext) => (
            service.update(user, id, safePatch(patch), mutationContext)
        ),
        remove: (user, id, mutationContext) => service.remove(user, id, mutationContext),
        restore: (user, id, mutationContext) => service.restore(user, id, mutationContext),
    };
}

function createWorkspacePortableEntityAdapters(options = {}) {
    const adapter = createWorkspacePortableAdapter(options);
    return adapter ? new Map([['workspaceState', adapter]]) : new Map();
}

module.exports = {
    EDITABLE_FIELDS,
    createWorkspacePortableAdapter,
    createWorkspacePortableEntityAdapters,
    safePatch,
};
