const fs = require('fs');
const path = require('path');
const { readAgentReleaseMeta } = require('./agent-release');

function normalizeVersion(value) {
    const version = String(value || '').trim().replace(/^refs\/tags\//, '');
    return version || '';
}

/* Desktop One About must show the pre suffix (0.1.20pre15). The core's own
 * package.json keeps the marketing version only (3.0.0); the full display
 * build travels on ZEPHYR_ONE_FULL_VERSION, with ZEPHYR_ONE_PRERELEASE joined
 * onto ZEPHYR_VERSION as fallback. Stable builds have no suffix: no-op. */
function withPrerelease(version, prerelease) {
    const base = String(version || '');
    const pre = String(prerelease || '').trim().toLowerCase();
    if (!base || !/^pre\d+$/.test(pre)) return base;
    if (base.toLowerCase().endsWith(pre)) return base;
    return `${base}${pre}`;
}

function readPackageVersion() {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
        return normalizeVersion(pkg.version);
    } catch {
        return '';
    }
}

function getAppVersion() {
    if (process.env.ZEPHYR_ONE_FULL_VERSION) {
        return normalizeVersion(process.env.ZEPHYR_ONE_FULL_VERSION) || '3.0.0';
    }
    const base = normalizeVersion(
        process.env.ZEPHYR_VERSION ||
        process.env.APP_VERSION ||
        process.env.VERSION_TAG ||
        process.env.GITHUB_REF_NAME ||
        readPackageVersion()
    ) || '3.0.0';
    return withPrerelease(base, process.env.ZEPHYR_ONE_PRERELEASE);
}

function getAgentRelease() {
    return readAgentReleaseMeta();
}

module.exports = { getAppVersion, getAgentRelease };
