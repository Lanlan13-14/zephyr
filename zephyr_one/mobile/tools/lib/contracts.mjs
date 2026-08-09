// Loads the machine contracts that are the single source of truth for both platforms.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
export const MOBILE_ROOT = path.resolve(here, '..', '..');
export const CONTRACTS_ROOT = path.join(MOBILE_ROOT, 'contracts');

/**
 * The Zephyr checkout root. Exported so callers never hand-roll '..' hops: this tree lives at
 * zephyr_one/mobile/, and the FREEZE archive plus the legacy JS/Dart implementations it is checked
 * against sit at the repo root, two levels up.
 */
export const REPO_ROOT = path.resolve(MOBILE_ROOT, '..', '..');

export function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(CONTRACTS_ROOT, relPath), 'utf8'));
}

export const openapi = () => readJson('openapi-mobile-v1.json');
export const entityRegistry = () => readJson('registries/entity-registry.json');
export const errorRegistry = () => readJson('registries/error-registry.json');
export const aiCapabilityBaseline = () => readJson('registries/ai-capability-baseline.json');
export const syncVectors = () => readJson('test-vectors/sync-v1.json');
export const sharedUseVectors = () => readJson('test-vectors/shared-use-v1.json');

export function schema(name) {
  return readJson(path.join('schemas', name));
}

/** Entity types One may author, ordered by push dependency topology. */
export function pushOrderedEntityTypes() {
  const entities = entityRegistry().entities.slice();
  entities.sort((a, b) => (a.dependencyOrder - b.dependencyOrder) || a.type.localeCompare(b.type));
  return entities.map((e) => e.type);
}

/** Fields One is never allowed to name in a fieldMask. */
export function forbiddenMaskFields(entity) {
  return [
    ...(entity.secretFields ?? []),
    ...(entity.serverAuthorityFields ?? []),
    ...(entity.opaquePreserveFields ?? []),
    ...(entity.deviceLocalFields ?? []),
  ];
}
