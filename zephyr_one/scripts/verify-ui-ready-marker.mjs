#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const MAX_MARKER_BYTES = 16 * 1024;
const MAX_MARKER_AGE_MS = 5 * 60 * 1000;
const FUTURE_CLOCK_SKEW_MS = 30 * 1000;

function fail(message) {
  throw new Error(`UI-ready marker rejected: ${message}`);
}

function readJsonFile(filePath, label, maxBytes = MAX_MARKER_BYTES) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    fail(`${label} is unavailable (${error.code || error.message})`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular file`);
  if (stat.size <= 0 || stat.size > maxBytes) fail(`${label} has an invalid size`);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    fail(`${label} permissions must not grant group or other access`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    fail(`${label} is not valid JSON (${error.message})`);
  }
}

function requireExact(value, expected, field) {
  if (value !== expected) fail(`${field} does not match this launch`);
}

export function verifyUiReadyMarker({ markerPath, nonce, port, healthPath, corePid, now = Date.now() }) {
  if (!path.isAbsolute(markerPath)) fail('marker path must be absolute');
  if (!/^[a-f0-9]{64}$/.test(nonce)) fail('launch nonce must be 256-bit lowercase hex');
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('expected port is invalid');

  const health = readJsonFile(healthPath, 'health response');
  if (health?.ok !== true || typeof health.instanceId !== 'string' || health.instanceId.length < 16) {
    fail('health response does not identify a ready core instance');
  }

  const marker = readJsonFile(markerPath, 'marker');
  requireExact(marker.schemaVersion, 1, 'schemaVersion');
  requireExact(marker.nonce, nonce, 'nonce');
  requireExact(marker.product, 'zephyr-one', 'product');
  requireExact(marker.windowLabel, 'local-app', 'windowLabel');
  requireExact(marker.topLevel, true, 'topLevel');
  requireExact(marker.authenticated, true, 'authenticated');
  requireExact(marker.appReady, true, 'appReady');
  requireExact(marker.readyState, 'complete', 'readyState');
  requireExact(marker.port, port, 'port');
  requireExact(marker.instanceId, health.instanceId, 'instanceId');
  if (!Number.isInteger(marker.corePid) || marker.corePid < 1) fail('corePid is invalid');
  if (corePid !== undefined) requireExact(marker.corePid, corePid, 'corePid');

  let productUrl;
  try {
    productUrl = new URL(marker.url);
  } catch {
    fail('url is invalid');
  }
  requireExact(productUrl.protocol, 'http:', 'url protocol');
  requireExact(productUrl.hostname, '127.0.0.1', 'url hostname');
  requireExact(productUrl.port, String(port), 'url port');
  requireExact(productUrl.pathname, '/app.html', 'url pathname');
  requireExact(productUrl.search, '?zephyrOne=1', 'url query');
  requireExact(productUrl.hash, '', 'url fragment');
  if (productUrl.username || productUrl.password) fail('url must not contain credentials');

  const createdAt = marker.createdAtMs;
  if (!Number.isInteger(createdAt) || createdAt < 1) fail('createdAtMs is invalid');
  if (createdAt > now + FUTURE_CLOCK_SKEW_MS) fail('createdAt is in the future');
  if (now - createdAt > MAX_MARKER_AGE_MS) fail('marker is stale');

  return {
    corePid: marker.corePid,
    instanceId: marker.instanceId,
    port,
    url: productUrl.href,
    windowLabel: marker.windowLabel,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) fail('arguments must be --name value pairs');
    options[name.slice(2)] = value;
  }
  for (const required of ['marker', 'nonce', 'port', 'health']) {
    if (!options[required]) fail(`missing --${required}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = verifyUiReadyMarker({
    markerPath: path.resolve(options.marker),
    nonce: options.nonce,
    port: Number(options.port),
    healthPath: path.resolve(options.health),
    corePid: options['core-pid'] === undefined ? undefined : Number(options['core-pid']),
  });
  process.stdout.write(
    `UI READY verified window=${result.windowLabel} port=${result.port} corePid=${result.corePid} instanceId=${result.instanceId}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exitCode = 1;
  }
}
