import crypto from 'node:crypto';

async function bodyBytes(body) {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (typeof body.arrayBuffer === 'function') return Buffer.from(await body.arrayBuffer());
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8');
  throw new TypeError('mobile proof test client cannot hash this request body type');
}

/**
 * Test-only HTTP client for the two-request proof protocol. Values are getters
 * because bind/refresh rotates credentials after the helper is constructed.
 */
export function createProofClient({ base, access, deviceId, privateKey, request = fetch } = {}) {
  return async function proofFetch(pathname, init = {}) {
    const origin = typeof base === 'function' ? base() : base;
    const credential = typeof access === 'function' ? access() : access;
    const id = typeof deviceId === 'function' ? deviceId() : deviceId;
    const key = typeof privateKey === 'function' ? privateKey() : privateKey;
    const method = String(init.method || 'GET').toUpperCase();
    const bytes = await bodyBytes(init.body);
    const digest = crypto.createHash('sha256').update(bytes).digest('base64');
    const challengeResponse = await request(origin + '/api/mobile/v1/devices/proof-challenge', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json' },
      body: JSON.stringify({ method, path: pathname, bodySha256: digest }),
    });
    if (!challengeResponse.ok) {
      const detail = await challengeResponse.text();
      throw new Error('proof challenge failed: ' + challengeResponse.status + ' ' + detail.slice(0, 300));
    }
    const { challenge } = await challengeResponse.json();
    const payload = Buffer.from([
      challenge.proofVersion,
      id,
      challenge.method,
      challenge.canonicalPath,
      challenge.bodySha256,
      challenge.usage,
      String(challenge.timestamp),
      challenge.nonce,
    ].join('\u0000'), 'utf8');
    const signature = crypto.sign('sha256', payload, {
      key,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64');
    const headers = new Headers(init.headers || {});
    headers.set('authorization', 'Bearer ' + credential);
    headers.set('x-zephyr-device-proof', signature);
    headers.set('x-zephyr-proof-timestamp', String(challenge.timestamp));
    headers.set('x-zephyr-server-nonce', challenge.nonce);
    return request(origin + pathname, { ...init, headers });
  };
}
