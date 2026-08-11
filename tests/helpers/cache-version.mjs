import assert from 'node:assert/strict';

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function assetVersions(source, assetName) {
    const asset = escapeRegExp(assetName);
    const pattern = new RegExp(`(?:^|[/"'\`])${asset}\\?[^"'\\s\`>]*?\\bv=([^&"'\\s\`>]+)`, 'g');
    return [...source.matchAll(pattern)].map((match) => match[1]);
}

export function singleAssetVersion(source, assetName, label = assetName) {
    const versions = new Set(assetVersions(source, assetName));
    assert.equal(versions.size, 1, `${label} must use one cache version`);
    return [...versions][0];
}

export function assertAssetVersion(source, assetName, expected, label = assetName) {
    assert.equal(singleAssetVersion(source, assetName, label), expected, `${label} cache version`);
}

export function cacheNameVersion(serviceWorkerSource) {
    const match = serviceWorkerSource.match(/CACHE_NAME = 'zephyr-static-([^']+)'/);
    assert.ok(match, 'service worker cache name must be versioned');
    return match[1];
}
