import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const roots = ['server.js', 'storage.js', 'secret-crypto.js', 'ai-agent-service.js', 'ai-browser-service.js', 'file-agent-manager.js', 'stats.js', 'version.js', 'public'];
const excludedDirs = new Set(['vendor', 'editor', 'novnc']);
const excludedFiles = new Set(['public/editor/zephyr-editor.bundle.js']);
const files = [];

function collect(entry) {
    const normalized = entry.split(path.sep).join('/');
    if (excludedFiles.has(normalized)) return;
    const stat = statSync(entry);
    if (stat.isDirectory()) {
        if (excludedDirs.has(path.basename(entry))) return;
        for (const child of readdirSync(entry).sort()) collect(path.join(entry, child));
    } else if (entry.endsWith('.js') || entry.endsWith('.mjs')) {
        files.push(entry);
    }
}

for (const root of roots) collect(root);
for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) {
        process.stderr.write(result.stdout || '');
        process.stderr.write(result.stderr || '');
        process.exit(result.status || 1);
    }
}
console.log(`JavaScript syntax OK: ${files.length} files`);
