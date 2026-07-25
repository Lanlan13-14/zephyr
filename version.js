const fs = require('fs');
const path = require('path');
const { readAgentReleaseMeta } = require('./agent-release');

function normalizeVersion(value) {
    const version = String(value || '').trim().replace(/^refs\/tags\//, '');
    return version || '';
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
    return normalizeVersion(
        process.env.ZEPHYR_VERSION ||
        process.env.APP_VERSION ||
        process.env.VERSION_TAG ||
        process.env.GITHUB_REF_NAME ||
        readPackageVersion()
    ) || '3.0.0';
}

function getAgentRelease() {
    return readAgentReleaseMeta();
}

module.exports = { getAppVersion, getAgentRelease };
