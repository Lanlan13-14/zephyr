'use strict';

const { FileSyncConfigService } = require('./file-sync-config-service');
const { MobileStoreError } = require('./mobile-v1-store');

/**
 * Adapter kept separate from mobile-v1-entities.js so the central registry
 * wiring can compose it without teaching generic projections about device
 * credentials or device-local filesystem policy.
 */
function createFileSyncConfigAdapter({ db, store, changeBridge, service } = {}) {
    const configs = service || new FileSyncConfigService({ db, store, changeBridge });
    return {
        idOf: (row) => row.clientId,
        residency: (user, id) => configs.residency(user.userId, id),
        list: (user) => configs.list(user.userId),
        read: (user, id) => configs.read(user.userId, id),
        revisionOf: (row) => Math.max(1, Number(row?.syncRevision || 1)),
        create: () => {
            /* A sync operation cannot manufacture a bound device. Bind is the
             * only path that establishes credentials and device public keys. */
            throw new MobileStoreError(
                'unsupported_scope',
                'File sync configuration is created only by device binding',
                400,
            );
        },
        update: (user, id, patch, mutationContext) => {
            const current = configs.read(user.userId, id);
            if (!current) throw new MobileStoreError('client_not_found', 'Device sync configuration not found', 404);
            return configs.update(user.userId, id, patch, {
                expectedRevision: current.syncRevision,
                ...mutationContext,
            });
        },
        remove: () => {
            /* Device revoke is deliberately not reachable from the generic
             * push plane: the account route requires a one-use sensitive grant. */
            throw new MobileStoreError(
                'sensitive_verification_required',
                'Device revoke requires sensitive verification',
                403,
            );
        },
        service: configs,
    };
}

module.exports = { createFileSyncConfigAdapter };
