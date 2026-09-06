import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appJs = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const serviceJs = readFileSync(path.join(root, 'ai-agent-service.js'), 'utf8');

test('manual AI plan deletion completes the server confirmation gate', () => {
    const start = appJs.indexOf('async function deleteAiPlanConfirmed(planId)');
    const end = appJs.indexOf('\nasync function revealAiProviderKey', start);
    assert.ok(start >= 0 && end > start, 'manual plan deletion handler exists');
    const handler = appJs.slice(start, end);
    assert.match(handler, /tool:\s*'plan_delete'/);
    assert.match(handler, /result\.confirmationRequired/);
    assert.match(handler, /api\(`\/api\/ai\/confirm\/\$\{encodeURIComponent\(confirmation\.id\)\}`/);
    assert.match(handler, /approve:\s*true/);
    assert.match(handler, /result\.deleted\s*===\s*true/);
    assert.match(handler, /计划删除未完成/);
});

test('plan deletion remains a destructive confirmed AI capability', () => {
    assert.match(serviceJs, /name:\s*'plan_delete'/);
    assert.match(serviceJs, /case 'plan_delete':/);
    assert.match(serviceJs, /filter\(\(plan\) => plan\.id !== planId\)/);
});
