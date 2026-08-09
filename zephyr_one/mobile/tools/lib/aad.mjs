// AAD construction for device secret envelopes and shared single-use envelopes.
// Frozen by DATA_AND_MIGRATION.md section 5.2 and SHARED_RESOURCE_RESIDENCY.md.
// Fields are UTF-8, joined by a single NUL (0x00); integers are decimal ASCII without leading zeros.

export const SECRET_AAD_PREFIX = 'zephyr-mobile-secret-v1';
export const SHARED_AAD_PREFIX = 'shared-use-v1';
export const HKDF_SALT_INPUT = 'zephyr-mobile-envelope-v1';

export const SECRET_AAD_FIELDS = Object.freeze([
  'prefix', 'serverId', 'userId', 'deviceId',
  'entityType', 'entityId', 'fieldName', 'entityRevision', 'keyVersion',
]);

export const SHARED_AAD_FIELDS = Object.freeze([
  'prefix', 'serverId', 'userId', 'deviceId', 'sessionId',
  'resourceId', 'resourceRevision', 'purpose', 'expiresAt', 'clientNonce',
]);

function decimal(value, field) {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
    return String(value);
  }
  const text = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new Error(`${field} must be decimal ASCII without leading zeros`);
  return text;
}

function joinNul(parts) {
  const buffers = [];
  parts.forEach((part, index) => {
    if (index > 0) buffers.push(Buffer.from([0x00]));
    if (part === undefined || part === null || part === '') throw new Error('AAD parts must be non-empty');
    buffers.push(Buffer.from(String(part), 'utf8'));
  });
  return Buffer.concat(buffers);
}

export function secretAadBytes(input) {
  return joinNul([
    SECRET_AAD_PREFIX,
    input.serverId,
    input.userId,
    input.deviceId,
    input.entityType,
    input.entityId,
    input.fieldName,
    decimal(input.entityRevision, 'entityRevision'),
    decimal(input.keyVersion, 'keyVersion'),
  ]);
}

export function sharedUseAadBytes(input) {
  return joinNul([
    SHARED_AAD_PREFIX,
    input.serverId,
    input.userId,
    input.deviceId,
    input.sessionId,
    input.resourceId,
    decimal(input.resourceRevision, 'resourceRevision'),
    input.purpose,
    decimal(input.expiresAt, 'expiresAt'),
    input.clientNonce,
  ]);
}

export const secretAadBase64 = (input) => secretAadBytes(input).toString('base64');
export const secretAadHex = (input) => secretAadBytes(input).toString('hex');
export const sharedUseAadBase64 = (input) => sharedUseAadBytes(input).toString('base64');
export const sharedUseAadHex = (input) => sharedUseAadBytes(input).toString('hex');

/** Constant-time comparison used before decrypting any envelope. */
export function aadEquals(a, b) {
  const left = Buffer.isBuffer(a) ? a : Buffer.from(String(a), 'base64');
  const right = Buffer.isBuffer(b) ? b : Buffer.from(String(b), 'base64');
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}
