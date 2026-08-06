/** Mirrors zephyr_agent AgentController.normalizeServerUrl / agentWebSocketUri. */

export function normalizeServerUrl(input) {
  let value = String(input || '').trim();
  if (!value) return '';
  if (value.startsWith('wss://')) value = `https://${value.slice(6)}`;
  if (value.startsWith('ws://')) value = `http://${value.slice(5)}`;
  if (!value.includes('://')) value = `https://${value}`;
  let uri;
  try {
    uri = new URL(value);
  } catch {
    return value.replace(/\/+$/, '');
  }
  if (!uri.protocol || !uri.hostname) return value.replace(/\/+$/, '');
  const port = uri.port ? `:${uri.port}` : '';
  const auth = uri.username
    ? `${encodeURIComponent(uri.username)}${uri.password ? `:${encodeURIComponent(uri.password)}` : ''}@`
    : '';
  return `${uri.protocol}//${auth}${uri.hostname}${port}`.replace(/\/+$/, '');
}

export function agentWebSocketUriForServerUrl(serverUrl) {
  const normalized = normalizeServerUrl(serverUrl);
  const uri = new URL(normalized);
  const wsScheme = uri.protocol === 'http:' ? 'ws:' : 'wss:';
  const port = uri.port ? `:${uri.port}` : '';
  const auth = uri.username
    ? `${encodeURIComponent(uri.username)}${uri.password ? `:${encodeURIComponent(uri.password)}` : ''}@`
    : '';
  return `${wsScheme}//${auth}${uri.hostname}${port}/agent/files`;
}
