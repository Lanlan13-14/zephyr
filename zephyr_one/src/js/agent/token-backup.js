/**
 * Local File-Agent token store shared between Zephyr Agent semantics and Zephyr One.
 * Format mirrors server data/agent-tokens.json (version 2) subset for mutual backup.
 */

const KEY = 'zephyr_one.tokens.v1';

function uid() {
  if (globalThis.crypto?.randomUUID) return `tok_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  return `tok_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
}

function readAll() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.tokens)) return data.tokens;
    return [];
  } catch {
    return [];
  }
}

function writeAll(tokens) {
  localStorage.setItem(KEY, JSON.stringify({ version: 2, tokens }));
}

export function listLocalTokens() {
  return readAll().sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}

export function addLocalToken({ token, name = 'Zephyr One', id, ownerId = 'local' }) {
  const t = String(token || '').trim();
  if (!t) throw new Error('empty token');
  const all = readAll();
  const existing = all.find((x) => x.token === t);
  if (existing) {
    existing.name = name || existing.name;
    existing.updatedAt = Date.now();
    writeAll(all);
    return existing;
  }
  const now = Date.now();
  const record = {
    id: id || uid(),
    ownerId,
    name: String(name || 'Zephyr One').slice(0, 80),
    token: t,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
  };
  all.unshift(record);
  writeAll(all);
  return record;
}

export function removeLocalToken(id) {
  writeAll(readAll().filter((t) => t.id !== id));
}

export function exportLocalTokens() {
  return JSON.stringify(
    {
      version: 2,
      source: 'zephyr-one',
      exportedAt: Date.now(),
      tokens: listLocalTokens(),
    },
    null,
    2,
  );
}

/**
 * Accepts:
 * - Zephyr One export JSON
 * - Zephyr server agent-tokens.json { version:2, tokens: [...] }
 * - bare array of token records
 * - single { token, name? }
 */
export function importLocalTokensJson(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  let items = [];
  if (Array.isArray(data)) items = data;
  else if (data && Array.isArray(data.tokens)) items = data.tokens;
  else if (data && typeof data.token === 'string') items = [data];
  else throw new Error('invalid token backup JSON');

  let count = 0;
  for (const item of items) {
    if (!item || !item.token) continue;
    addLocalToken({
      token: item.token,
      name: item.name || 'Imported',
      id: item.id,
      ownerId: item.ownerId || 'local',
    });
    count += 1;
  }
  return count;
}
