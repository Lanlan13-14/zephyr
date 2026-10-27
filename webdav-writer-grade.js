'use strict';

/**
 * Production WebDAV writer-grade classifier and CAS concurrent-commit check.
 *
 * Spec: ZEPHYR-LINK-INTERCONNECTION-SPEC.md §6.2.
 * Independent of the documentation reference adapter.
 */

function object(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Classify a storage endpoint into B0 / B1 / B2.
 *
 * B0: no writers (offline export only).
 * B1: single-writer backup; missing strong ETag or conditional write cannot be B2.
 * B2: multi-writer only when strongEtag && conditionalWrite && atomicPublish &&
 *     consistentReadback && writers > 1.
 *
 * Weak ETags are never treated as a mutex; callers must not pass strongEtag=true
 * for a weak validator.
 */
function classifyWebdavWriter(capabilities) {
    if (!object(capabilities)) return 'B0';
    const writers = Number(capabilities.writers) || 0;
    if (writers === 0) return 'B0';
    const strongEtag = capabilities.strongEtag === true;
    const conditionalWrite = capabilities.conditionalWrite === true;
    const atomicPublish = capabilities.atomicPublish === true;
    const consistentReadback = capabilities.consistentReadback === true;
    if (strongEtag && conditionalWrite && atomicPublish && consistentReadback && writers > 1) {
        return 'B2';
    }
    return 'B1';
}

/**
 * Evaluate a concurrent CAS commit vector. Two successful commits against the
 * same epoch, a weak ETag used as a mutex, or an unconditional overwrite are
 * all rejected.
 */
function webdavConcurrentCommit(input) {
    const args = object(input) ? input : {};
    const commits = Array.isArray(args.commits) ? args.commits : [];
    const conditionalWrite = args.conditionalWrite !== false;
    const weakEtag = args.weakEtag === true;

    if (weakEtag) return { allowed: false, reason: 'no_multiwriter_B2_proof' };
    if (!conditionalWrite) return { allowed: false, reason: 'not_multiwriter_safe' };

    const baseEtag = args.baseEtag;
    if (commits.some((commit) => commit && commit.etag !== baseEtag)) {
        return { allowed: false, reason: 'stale_epoch_rejected' };
    }
    if (commits.some((commit) => !commit || !['success', 'precondition_failed'].includes(commit.result))) {
        return { allowed: false, reason: 'invalid_commit_result' };
    }
    const successful = commits.filter((commit) => commit.result === 'success');
    if (successful.length !== 1) {
        return { allowed: false, reason: 'reject_server_not_B2' };
    }
    return {
        allowed: true,
        winner: successful[0].writer,
        losersMust: ['reread', 'merge', 'retry'],
    };
}

module.exports = {
    classifyWebdavWriter,
    webdavConcurrentCommit,
};
