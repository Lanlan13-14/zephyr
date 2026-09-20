import crypto from 'node:crypto';

const SHELL_AUTH_NAMESPACE = 'one-shell-unlock-v1';

export function createShellIdentity() {
  return {
    secret: crypto.randomBytes(32).toString('hex') + crypto.randomBytes(32).toString('hex'),
    instance: crypto.randomUUID().replace(/-/g, ''),
  };
}

export function signedMessage(action, timestamp, nonce, shellInstance, fields = []) {
  return [
    SHELL_AUTH_NAMESPACE,
    String(action || ''),
    String(timestamp || ''),
    String(nonce || ''),
    String(shellInstance || ''),
    ...fields.map((value) => {
      const text = String(value == null ? '' : value);
      return Buffer.byteLength(text, 'utf8') + ':' + text;
    }),
  ].join('\n');
}

export function signHeaders(identity, action, fields = []) {
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  const message = signedMessage(action, timestamp, nonce, identity.instance, fields);
  const mac = crypto.createHmac('sha256', identity.secret).update(message, 'utf8').digest('hex');
  return {
    'X-Zephyr-One-Shell-Instance': identity.instance,
    'X-Zephyr-One-Shell-Timestamp': timestamp,
    'X-Zephyr-One-Shell-Nonce': nonce,
    'X-Zephyr-One-Shell-Mac': mac,
  };
}
