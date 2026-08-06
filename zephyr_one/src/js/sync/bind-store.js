const KEY = 'zephyr_one.bind.v1';

export function defaultBindState() {
  return {
    serverUrl: '',
    username: '',
    userId: '',
    sid: '',
    clientId: '',
    deviceToken: '',
    tokenId: '',
    deviceName: '',
    platform: '',
    appVersion: '0.1.0',
    boundAt: null,
  };
}

export function loadBindState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultBindState();
    return { ...defaultBindState(), ...JSON.parse(raw) };
  } catch {
    return defaultBindState();
  }
}

export function saveBindState(state) {
  localStorage.setItem(KEY, JSON.stringify(state));
  return state;
}

export function clearBindState() {
  const empty = defaultBindState();
  localStorage.setItem(KEY, JSON.stringify(empty));
  return empty;
}

export function ensureClientId(state) {
  if (state.clientId) return state;
  const id =
    globalThis.crypto?.randomUUID?.() ||
    `one_${Date.now().toString(16)}_${Math.random().toString(16).slice(2, 10)}`;
  state.clientId = id;
  return saveBindState(state);
}
