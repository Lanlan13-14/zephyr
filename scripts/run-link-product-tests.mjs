import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Explicit allowlisted product groups: no reference-adapter execution can
// substitute for these tests. Unknown groups and missing files fail closed.
const groups = {
  sync: [
    'one-link-local-store', 'zephyr-one-link-sync', 'zephyr-one-link-zsl-transport',
    'mobile-v1-bootstrap-snapshot', 'mobile-v1-field-ledger-backfill',
    'mobile-v1-field-overlap', 'mobile-v1-gc-retention', 'mobile-v1-hydrate-projection',
    'mobile-v1-activity-ingest', 'mobile-v1-server-metadata-entities',
    'mobile-v1-shared-security', 'owned-mutation-outbox-atomic',
    'zephyr-one-link-ui-contract', 'zephyr-link-p3-wiring-contract',
    'sqlite-driver-named-params', 'app-change-wake',
  ],
  webdav: [
    'webdav-backup-provider', 'webdav-production', 'webdav-production-server',
    'webdav-production-restore-route', 'webdav-sync-service', 'webdav-sync-routes',
    'webdav-vault-password', 'webdav-vault-restore', 'webdav-vault-restore-production',
    'webdav-vault-no-multiwriter', 'webdav-writer-grade', 'webdav-sensitive-rate-limiter',
  ],
  agent: [
    'agent-path-jail', 'agent-file-policy-gate', 'agent-listen-approval',
    'agent-policy-engine', 'file-agent-v2', 'file-agent-preauth-resource-gate',
    'link-frame-validate', 'link-v2-sync-envelope', 'link-v2-sync-bridge',
    'link-v2-file-bridge', 'link-handoff-session', 'cell-command-allowlist-contract',
  ],
  ai: [
    'ai-run-idempotency', 'ai-tool-executor-idempotency', 'ai-host-call-identity',
    'ai-runtime-bridge-contract', 'ai-runtime-database-generation',
    'ai-runtime-confirmation-contract', 'ai-connection-tools-v1',
    'ai-session-exec', 'ai-host-isolation-contract',
  ],
};
const group = process.env.LINK_TEST_GROUP;
if (!Object.hasOwn(groups, group || '')) throw new Error('Unknown LINK_TEST_GROUP');
const files = groups[group].map((name) => path.join('tests', `${name}.test.mjs`));
for (const file of files) if (!fs.existsSync(file)) throw new Error(`Missing product test: ${file}`);
fs.mkdirSync('.link-evidence', { recursive: true });
const output = path.join('.link-evidence', `node-${group}.tap`);
const fd = fs.openSync(output, 'w');
let result;
try {
  result = spawnSync(process.execPath, ['--test', '--test-concurrency=2', '--test-reporter=tap', ...files], {
    stdio: ['ignore', fd, fd], env: process.env, timeout: 15 * 60_000,
  });
} finally { fs.closeSync(fd); }
process.stdout.write(fs.readFileSync(output, 'utf8'));
if (result.error) console.error(result.error.message);
process.exitCode = result.status === 0 && !result.error && !result.signal ? 0 : 1;
