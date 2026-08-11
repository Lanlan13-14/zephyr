'use strict';

const { PERSONAL_SYNC_FIELDS } = require('./personal-settings-section-service');

/**
 * Adapter factory for the personal-data entities normalized outside the
 * original ResourceService/NotesService registry. The central mobile adapter
 * table can merge this Map without giving the route layer direct table access.
 */
function createPersonalEntityAdapters({
    snippetService,
    personalSettingsService,
    userSettingsService,
} = {}) {
    const adapters = new Map();
    const snippets = snippetService || userSettingsService?.snippetService;
    const sections = personalSettingsService || userSettingsService?.personalSettingsService;

    if (snippets) {
        adapters.set('snippet', {
            idOf: (row) => row.id,
            residency: (user, id) => snippets.residency(user, id),
            list: (user) => snippets.list(user),
            read: (user, id) => snippets.read(user, id),
            revisionOf: (row) => Math.max(1, Number(row?.revision) || 1),
            create: (user, id, patch, mutationContext) => snippets.create(
                user,
                { ...patch, id },
                mutationContext,
            ),
            update: (user, id, patch, mutationContext) => {
                const current = snippets.read(user, id);
                return snippets.update(user, id, patch, {
                    expectedRevision: current?.revision,
                    ...mutationContext,
                });
            },
            remove: (user, id, mutationContext) => {
                const current = snippets.read(user, id);
                return snippets.remove(user, id, {
                    expectedRevision: current?.revision,
                    ...mutationContext,
                });
            },
            restore: (user, id, mutationContext) => {
                const deleted = snippets.read(user, id, { includeDeleted: true });
                return snippets.restore(user, id, {
                    expectedRevision: deleted?.revision,
                    ...mutationContext,
                });
            },
        });
    }

    if (sections) {
        /* mobile-v1-routes currently performs its bootstrap residency check
         * through ownerUserId even though the registry names userId. A
         * non-enumerable alias satisfies that check without adding an
         * out-of-contract field to the projected JSON payload. */
        const bootstrapOwnerAlias = (row) => {
            if (!row) return row;
            if (!Object.prototype.hasOwnProperty.call(row, 'ownerUserId')) {
                Object.defineProperty(row, 'ownerUserId', {
                    value: row.userId,
                    enumerable: false,
                    configurable: true,
                });
            }
            return row;
        };
        adapters.set('oneUserSettings', {
            idOf: (row) => row.sectionKey,
            residency: (user, id) => sections.residency(user, id),
            list: (user) => sections.list(user).map(bootstrapOwnerAlias),
            read: (user, id) => bootstrapOwnerAlias(sections.read(user, id)),
            revisionOf: (row) => Math.max(1, Number(row?.revision) || 1),
            fieldMaskOf: (row) => PERSONAL_SYNC_FIELDS.filter((field) => (
                Object.prototype.hasOwnProperty.call(row || {}, field)
            )),
            create: (user, id, patch, mutationContext) => bootstrapOwnerAlias(sections.patchSection(
                user,
                id,
                patch,
                {
                    expectedRevision: sections.currentRevision(user, id),
                    source: 'mobile',
                    ...mutationContext,
                },
            )),
            update: (user, id, patch, mutationContext) => {
                const current = sections.read(user, id);
                return bootstrapOwnerAlias(sections.patchSection(
                    user,
                    id,
                    patch,
                    { expectedRevision: current?.revision, source: 'mobile', ...mutationContext },
                ));
            },
            remove: (user, id, mutationContext) => {
                const current = sections.read(user, id);
                return sections.resetSection(
                    user,
                    id,
                    { expectedRevision: current?.revision, source: 'mobile', ...mutationContext },
                );
            },
            restore: (user, id, mutationContext) => {
                const reset = sections.read(user, id, { includeReset: true });
                return bootstrapOwnerAlias(sections.restoreSection(
                    user,
                    id,
                    { expectedRevision: reset?.revision, source: 'mobile', ...mutationContext },
                ));
            },
        });
    }

    return adapters;
}

module.exports = { createPersonalEntityAdapters };
