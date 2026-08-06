/**
 * Zephyr One data sync engine.
 * Pulls user-scoped snapshot from main server on an interval.
 */

const SNAPSHOT_KEY = 'zephyr_one.sync.snapshot.v1';
const META_KEY = 'zephyr_one.sync.meta.v1';

export function loadSnapshot() {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveSnapshot(snapshot) {
  localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
}

export function loadSyncMeta() {
  try {
    const raw = localStorage.getItem(META_KEY);
    return raw ? JSON.parse(raw) : defaultMeta();
  } catch {
    return defaultMeta();
  }
}

export function saveSyncMeta(meta) {
  localStorage.setItem(META_KEY, JSON.stringify(meta));
}

function defaultMeta() {
  return {
    enabled: false,
    intervalSec: 300,
    lastPullAt: null,
    lastError: '',
    lastRevision: 0,
    bound: false,
  };
}

export class SyncEngine {
  /**
   * @param {object} opts
   * @param {import('./zephyr-api.js').ZephyrApi} opts.api
   * @param {() => object} opts.getBindState  // { clientId, deviceToken, deviceName, platform }
   * @param {(state: object) => void} [opts.onChange]
   */
  constructor({ api, getBindState, onChange } = {}) {
    this.api = api;
    this.getBindState = getBindState;
    this.onChange = onChange || (() => {});
    this.meta = loadSyncMeta();
    this.snapshot = loadSnapshot();
    this._timer = null;
    this._running = false;
  }

  get status() {
    return {
      ...this.meta,
      hasSnapshot: !!this.snapshot,
      connectionCount: this.snapshot?.data?.connections?.length || 0,
      noteCount: this.snapshot?.data?.notes?.length || 0,
    };
  }

  _emit() {
    this.onChange(this.status);
  }

  setIntervalSec(sec) {
    const n = Math.max(30, Math.min(86400, Number(sec) || 300));
    this.meta.intervalSec = n;
    saveSyncMeta(this.meta);
    if (this.meta.enabled) this.start();
    this._emit();
  }

  async enable() {
    this.meta.enabled = true;
    this.meta.lastError = '';
    saveSyncMeta(this.meta);
    await this.pull();
    this.start();
    this._emit();
  }

  disable() {
    this.meta.enabled = false;
    saveSyncMeta(this.meta);
    this.stop();
    this._emit();
  }

  start() {
    this.stop();
    if (!this.meta.enabled) return;
    const ms = Math.max(30, this.meta.intervalSec || 300) * 1000;
    this._timer = setInterval(() => {
      this.pull().catch(() => {});
    }, ms);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  async pull() {
    if (this._running) return this.snapshot;
    const bind = this.getBindState() || {};
    if (!bind.clientId || !bind.deviceToken) {
      const err = new Error('尚未绑定 Zephyr One 设备');
      this.meta.lastError = err.message;
      saveSyncMeta(this.meta);
      this._emit();
      throw err;
    }
    this._running = true;
    try {
      const snapshot = await this.api.pullSync(
        {
          clientId: bind.clientId,
          syncIntervalSec: this.meta.intervalSec,
          deviceName: bind.deviceName,
          platform: bind.platform,
          appVersion: bind.appVersion || '0.1.0',
        },
        bind.deviceToken,
      );
      this.snapshot = snapshot;
      saveSnapshot(snapshot);
      this.meta.lastPullAt = Date.now();
      this.meta.lastRevision = snapshot.revision || 0;
      this.meta.lastError = '';
      this.meta.bound = true;
      saveSyncMeta(this.meta);
      this._emit();
      return snapshot;
    } catch (e) {
      this.meta.lastError = e.message || String(e);
      saveSyncMeta(this.meta);
      this._emit();
      throw e;
    } finally {
      this._running = false;
    }
  }
}
