'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_META_PATH = path.join(__dirname, 'public', 'agent-release.json');
const DEFAULT_REPO = 'Lanlan13-14/zephyr-ssh';

function normalizeTag(raw) {
    const tag = String(raw || '').trim().replace(/^refs\/tags\//, '');
    return tag || '';
}

function tagToDisplay(tag) {
    const t = normalizeTag(tag);
    if (!t) return '';
    // agent-v1.0.12 → v1.0.12; already-v tags pass through.
    if (t.startsWith('agent-')) return t.slice('agent-'.length);
    if (t.startsWith('v')) return t;
    return `v${t}`;
}

function releaseUrlFor(repo, tag) {
    const t = normalizeTag(tag);
    if (!t) return '';
    return `https://github.com/${repo}/releases/tag/${encodeURIComponent(t).replace(/%2F/g, '/')}`;
}

function readAgentReleaseMeta(options = {}) {
    const metaPath = options.metaPath || process.env.ZEPHYR_AGENT_RELEASE_FILE || DEFAULT_META_PATH;
    const repo = options.repo || process.env.ZEPHYR_GITHUB_REPO || DEFAULT_REPO;
    let file = null;
    try {
        if (fs.existsSync(metaPath)) {
            file = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        }
    } catch {
        file = null;
    }

    const tag = normalizeTag(
        process.env.ZEPHYR_AGENT_RELEASE_TAG
        || file?.tag
        || file?.agentTag
        || ''
    );
    const url = String(
        process.env.ZEPHYR_AGENT_RELEASE_URL
        || file?.url
        || file?.html_url
        || (tag ? releaseUrlFor(repo, tag) : '')
    ).trim();
    const display = String(file?.display || tagToDisplay(tag) || '').trim();
    const updatedAt = file?.updatedAt || null;

    return {
        tag: tag || null,
        display: display || null,
        url: url || null,
        updatedAt,
        available: Boolean(tag && url),
    };
}

module.exports = {
    DEFAULT_META_PATH,
    DEFAULT_REPO,
    normalizeTag,
    tagToDisplay,
    releaseUrlFor,
    readAgentReleaseMeta,
};
