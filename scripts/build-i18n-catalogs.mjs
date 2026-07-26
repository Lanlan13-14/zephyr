#!/usr/bin/env node
/**
 * Build public/i18n/locales/{zh-CN,en}.json from extracted UI strings + en map.
 * Run: node scripts/build-i18n-catalogs.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'public/i18n/locales');
const enMapPath = path.join(root, 'public/i18n/en-map.json');
const keysPath = path.join(root, 'public/i18n/keys.json');

function loadJson(p, fallback) {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const keys = loadJson(keysPath, []);
const enMap = loadJson(enMapPath, {});

const zh = {};
const en = {};
for (const key of keys) {
    zh[key] = key;
    en[key] = Object.prototype.hasOwnProperty.call(enMap, key) ? enMap[key] : key;
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'zh-CN.json'), JSON.stringify(zh, null, 2) + '\n');
fs.writeFileSync(path.join(outDir, 'en.json'), JSON.stringify(en, null, 2) + '\n');
const missing = keys.filter((k) => en[k] === k && /[\u4e00-\u9fff]/.test(k));
console.log(`catalogs: ${keys.length} keys, en missing translations: ${missing.length}`);
if (missing.length && missing.length <= 30) missing.forEach((k) => console.log('  -', k));
else if (missing.length) missing.slice(0, 20).forEach((k) => console.log('  -', k));
