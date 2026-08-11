'use strict';

function createAclTokenMetadataAdapters({ resourceAclService, clientTokenService } = {}) {
    const adapters = new Map();

    if (resourceAclService) {
        adapters.set('resourceAcl', {
            idOf: (row) => row.grantKey,
            residency: (user, id) => resourceAclService.residency(user, id),
            list: (user) => resourceAclService.list(user),
            read: (user, id) => resourceAclService.read(user, id),
            revisionOf: (row) => Math.max(1, Number(row?.revision) || 1),
            create: (user, id, patch, mutationContext = {}) => (
                resourceAclService.create(user, id, patch, { mutationContext })
            ),
            update: (user, id, patch, mutationContext = {}) => {
                const current = resourceAclService.read(user, id);
                return resourceAclService.update(user, id, patch, {
                    expectedRevision: current?.revision,
                    mutationContext,
                });
            },
            remove: (user, id, mutationContext = {}) => {
                const current = resourceAclService.read(user, id);
                return resourceAclService.remove(user, id, {
                    expectedRevision: current?.revision,
                    mutationContext,
                });
            },
        });
    }

    /* A plaintext or non-transactional token source must not even appear as a
     * usable adapter. This keeps central composition fail-closed. */
    if (clientTokenService?.available) {
        adapters.set('clientToken', {
            idOf: (row) => row.id,
            residency: (user, id) => clientTokenService.residency(user, id),
            list: (user) => clientTokenService.list(user),
            read: (user, id) => clientTokenService.read(user, id),
            revisionOf: (row) => Math.max(1, Number(row?.revision) || 1),
            create: (user, id, patch, mutationContext = {}) => (
                clientTokenService.create(user, id, patch, { mutationContext })
            ),
            update: (user, id, patch, mutationContext = {}) => {
                const current = clientTokenService.read(user, id);
                return clientTokenService.update(user, id, patch, {
                    expectedRevision: current?.revision,
                    mutationContext,
                });
            },
            remove: (user, id, mutationContext = {}) => {
                const current = clientTokenService.read(user, id);
                return clientTokenService.remove(user, id, {
                    expectedRevision: current?.revision,
                    mutationContext,
                });
            },
        });
    }

    return adapters;
}

module.exports = { createAclTokenMetadataAdapters };
