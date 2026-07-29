import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('guidance v16 removes legacy built-ins and preserves user Skills', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zephyr-ai-skill-migrate-'));
  process.env.ZEPHYR_DATA_DIR = dir;
  const storagePath = require.resolve('../storage.js');
  delete require.cache[storagePath];
  const storage = require('../storage.js');
  try {
    storage.init({ hashPassword: (value) => `hash:${value}` });
    storage.updateSettings({ ai: {
      guidanceVersion: 10,
      skills: [
        { id: 'zephyr-local-operator', name: 'old', prompt: 'old' },
        { id: 'playbook:asset-management-v1', name: 'old playbook', prompt: 'old' },
        { id: 'custom-user-skill', name: 'custom', prompt: 'keep me', enabled: true },
      ],
    } });
    const migrated = storage.ensureAiGuidanceDefaults();
    assert.equal(migrated.guidanceVersion, 19);
    assert.deepEqual(migrated.skills.map((item) => item.id), ['custom-user-skill']);
  } finally {
    storage.close();
    delete process.env.ZEPHYR_DATA_DIR;
    delete require.cache[storagePath];
    rmSync(dir, { recursive: true, force: true });
  }
});
