const KEY = 'zephyr_one.settings.v1';

export function defaultSettings() {
  return {
    serverUrl: '',
    themeMode: 'dark',
    palette: 'frost',
    locale: 'zh-CN',
    requireUnlock: true,
    lockOnBackground: true,
    agent: {
      serverUrl: '',
      token: '',
      deviceName: 'My Device',
      sharedDirectoryPath: null,
      sharedDirectoryName: null,
      readOnly: true,
      autoShutdown: true,
      autoShutdownMinutes: 10,
      allowBadCertificates: true,
    },
    // Reserved for future automatic file sync policies.
    fileSync: {
      enabled: false,
      defaultDir: null,
    },
  };
}

export async function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultSettings();
    const parsed = JSON.parse(raw);
    return {
      ...defaultSettings(),
      ...parsed,
      agent: { ...defaultSettings().agent, ...(parsed.agent || {}) },
      fileSync: { ...defaultSettings().fileSync, ...(parsed.fileSync || {}) },
    };
  } catch {
    return defaultSettings();
  }
}

export async function saveSettings(settings) {
  localStorage.setItem(KEY, JSON.stringify(settings));
  return settings;
}
