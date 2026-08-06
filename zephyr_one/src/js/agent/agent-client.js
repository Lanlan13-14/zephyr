/**
 * Zephyr Agent client (protocol v2 + ZFT2).
 * Port of zephyr_agent AgentController — runs in Tauri webview;
 * file IO is delegated to Rust commands for native FS access.
 */

import { agentWebSocketUriForServerUrl, normalizeServerUrl } from './url.js';
import {
  Zft2Op,
  decodeZft2Frame,
  encodeZft2Error,
  encodeZft2Response,
  isZft2Bytes,
} from './zft2.js';
import { t } from '../i18n/i18n.js';

const STATUS_LABEL = {
  idle: () => t('未连接'),
  connecting: () => t('连接中'),
  authenticating: () => t('认证中'),
  online: () => t('已连接'),
  reconnecting: () => t('重连中'),
  stopped: () => t('已停止'),
  error: () => t('连接错误'),
};

function deviceIdFor(serverUrl, deviceName) {
  // Deterministic-ish id without full uuid v5 dependency.
  const raw = `${serverUrl}:${deviceName}`;
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `dev_${(h >>> 0).toString(16)}${raw.length.toString(16)}`;
}

export class AgentClient {
  constructor({ invoke, onChange } = {}) {
    this.invoke = invoke;
    this.onChange = onChange || (() => {});
    this.config = null;
    this.status = 'idle';
    this.agentId = null;
    this.errorMessage = '';
    this.transferCount = 0;
    this.transferBytes = 0;

    this._ws = null;
    this._heartbeatTimer = null;
    this._heartbeatIntervalMs = 15000;
    this._missedHeartbeats = 0;
    this._reconnectAttempts = 0;
    this._maxReconnect = 10;
    this._reconnectTimer = null;
    this._shutdownTimer = null;
    this._shutdownAt = null;
    this._zft2Tasks = new Map();
    this._handlePaths = new Map();
    this._zft2Cancelled = new Set();
    this._pathQueues = new Map();
  }

  get statusLabel() {
    return (STATUS_LABEL[this.status] || STATUS_LABEL.idle)();
  }

  get isActive() {
    return ['online', 'connecting', 'authenticating', 'reconnecting'].includes(this.status);
  }

  _emit() {
    this.onChange(this);
  }

  _setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this._emit();
  }

  async start(config) {
    if (this.isActive) return;
    this.config = {
      ...config,
      serverUrl: normalizeServerUrl(config.serverUrl),
    };
    this._reconnectAttempts = 0;
    await this._connect();
  }

  async stop() {
    this._setStatus('stopped');
    this._cancelShutdown();
    this._cancelHeartbeat();
    this._cancelReconnect();
    await this._disconnect();
  }

  async _connect() {
    this._setStatus('connecting');
    this.errorMessage = '';
    this._emit();
    try {
      const uri = agentWebSocketUriForServerUrl(this.config.serverUrl);
      if (!uri) throw new Error('empty server url');
      const ws = new WebSocket(uri);
      ws.binaryType = 'arraybuffer';
      this._ws = ws;

      await new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('connection timeout')), 20000);
        ws.onopen = () => {
          clearTimeout(to);
          resolve();
        };
        ws.onerror = () => {
          clearTimeout(to);
          reject(new Error('websocket error'));
        };
      });

      ws.onmessage = (ev) => this._onMessage(ev.data);
      ws.onerror = (ev) => this._onError(ev);
      ws.onclose = () => this._onDone();

      this._setStatus('authenticating');
      this._sendHello();
    } catch (e) {
      this.errorMessage = this._friendly(e);
      this._setStatus('error');
      this._maybeReconnect();
    }
  }

  async _disconnect() {
    try {
      this._ws?.close();
    } catch {
      /* ignore */
    }
    this._ws = null;
  }

  _sendHello() {
    const platform = this.config.platformHint || 'tauri';
    this._sendJson({
      type: 'hello',
      protocolVersion: 2,
      token: this.config.token,
      deviceId: deviceIdFor(this.config.serverUrl, this.config.deviceName),
      deviceName: this.config.deviceName || 'Zephyr One',
      platform,
      appVersion: this.config.appVersion || '0.1.0',
      capabilities: {
        read: true,
        write: !this.config.readOnly,
        delete: !this.config.readOnly,
        rename: !this.config.readOnly,
        mkdir: !this.config.readOnly,
        truncate: !this.config.readOnly,
        binary: true,
        binaryRead: true,
        binaryWrite: true,
        cancel: true,
        creditFlow: true,
        maxInflight: 8,
        maxChunkSize: 1024 * 1024,
      },
      share: {
        name: this.config.sharedDirectoryName || this.config.deviceName || 'Zephyr One',
        readOnly: this.config.readOnly !== false,
      },
    });
  }

  _sendJson(obj) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._ws.send(JSON.stringify(obj));
  }

  _sendBytes(bytes) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._ws.send(bytes);
  }

  _onMessage(data) {
    if (typeof data !== 'string') {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
      if (isZft2Bytes(bytes)) {
        try {
          this._handleZft2(decodeZft2Frame(bytes));
        } catch {
          /* ignore bad frames */
        }
        return;
      }
      try {
        data = new TextDecoder().decode(bytes);
      } catch {
        return;
      }
    }
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'hello_ack':
        this._handleHelloAck(msg);
        break;
      case 'request':
        this._handleJsonRequest(msg);
        break;
      case 'pong':
        this._missedHeartbeats = 0;
        break;
      default:
        break;
    }
  }

  _handleHelloAck(msg) {
    if (msg.ok === true) {
      this.agentId = msg.agentId || null;
      this._heartbeatIntervalMs = Number(msg.heartbeatIntervalMs || 15000);
      this._setStatus('online');
      this._reconnectAttempts = 0;
      this._startHeartbeat();
      this._startShutdown();
    } else {
      this.errorMessage = msg.error?.message || 'Authentication failed';
      this._setStatus('error');
      // no reconnect on auth failure
    }
  }

  async _handleJsonRequest(msg) {
    const id = msg.id;
    const method = msg.method;
    const params = msg.params || {};
    if (!id || !method) return;
    if (this.config.readOnly && ['write', 'mkdir', 'delete', 'rename', 'truncate'].includes(method)) {
      this._sendJson({
        id,
        type: 'response',
        ok: false,
        error: { code: 'read_only', message: 'Share is read-only' },
      });
      return;
    }
    try {
      if (method === 'read' || method === 'write') {
        throw Object.assign(new Error('Base64 reads/writes disabled in protocol v2'), {
          code: 'unsupported',
        });
      }
      const result = await this._dispatchFs(method, params);
      this.transferCount += 1;
      this._emit();
      this._sendJson({ id, type: 'response', ok: true, result });
    } catch (e) {
      this._sendJson({
        id,
        type: 'response',
        ok: false,
        error: { code: e.code || 'internal_error', message: e.message || String(e) },
      });
    }
  }

  _handleZft2(frame) {
    if (frame.isResponse) return;
    if (frame.type === Zft2Op.cancel) {
      const target = Number(frame.meta?.targetRequestId ?? -1);
      if (this._zft2Tasks.has(target)) this._zft2Cancelled.add(target);
      return;
    }
    if (this._zft2Tasks.size >= 8) {
      this._sendBytes(encodeZft2Error(frame, 'busy', 'Agent request window is full', { retryable: true }));
      return;
    }

    const run = async () => {
      try {
        const response = await this._dispatchZft2(frame);
        if (!this._zft2Cancelled.has(frame.requestId)) this._sendBytes(response);
      } catch (e) {
        if (!this._zft2Cancelled.has(frame.requestId)) {
          this._sendBytes(
            encodeZft2Error(frame, e.code || 'internal_error', e.message || String(e)),
          );
        }
      } finally {
        this._zft2Tasks.delete(frame.requestId);
        this._zft2Cancelled.delete(frame.requestId);
      }
    };

    const queueKey = this._queueKey(frame);
    let task;
    if (queueKey) {
      const prev = this._pathQueues.get(queueKey) || Promise.resolve();
      task = prev.catch(() => {}).then(run);
      this._pathQueues.set(
        queueKey,
        task.finally(() => {
          if (this._pathQueues.get(queueKey) === task) this._pathQueues.delete(queueKey);
        }),
      );
    } else {
      task = run();
    }
    this._zft2Tasks.set(frame.requestId, task);
  }

  _queueKey(frame) {
    const meta = frame.meta || {};
    switch (frame.type) {
      case Zft2Op.write:
      case Zft2Op.close: {
        const handle = String(meta.handle || '');
        if (!handle) return null;
        return this._handlePaths.get(handle) || `handle:${handle}`;
      }
      case Zft2Op.open:
      case Zft2Op.truncate:
      case Zft2Op.mkdir:
      case Zft2Op.delete: {
        const path = String(meta.path || '');
        return path || null;
      }
      case Zft2Op.rename: {
        const oldPath = String(meta.oldPath || '');
        return oldPath || null;
      }
      default:
        return null;
    }
  }

  async _dispatchZft2(frame) {
    const meta = frame.meta || {};
    const mutating = [Zft2Op.write, Zft2Op.mkdir, Zft2Op.delete, Zft2Op.rename, Zft2Op.truncate];
    if (this.config.readOnly && mutating.includes(frame.type)) {
      throw Object.assign(new Error('Share is read-only'), { code: 'read_only' });
    }
    let result = {};
    let payload = new Uint8Array(0);
    switch (frame.type) {
      case Zft2Op.open: {
        const openPath = meta.path;
        const handle = await this.invoke('agent_fs_open', {
          root: this.config.sharedDirectoryPath,
          path: openPath,
          mode: meta.mode || 'read',
        });
        this._handlePaths.set(handle, openPath);
        result = { handle };
        break;
      }
      case Zft2Op.read: {
        let length = Number(meta.length ?? 262144);
        if (length < 0) length = 0;
        if (length > 1024 * 1024) length = 1024 * 1024;
        const data = await this.invoke('agent_fs_read', {
          handle: meta.handle,
          offset: Number(meta.offset ?? 0),
          length,
        });
        payload = data instanceof Uint8Array ? data : new Uint8Array(data || []);
        result = { bytesRead: payload.length, eof: payload.length === 0 };
        this.transferBytes += payload.length;
        break;
      }
      case Zft2Op.write: {
        const written = await this.invoke('agent_fs_write', {
          handle: meta.handle,
          offset: Number(meta.offset ?? 0),
          data: Array.from(frame.payload),
        });
        result = { bytesWritten: written };
        this.transferBytes += Number(written || 0);
        break;
      }
      case Zft2Op.close: {
        const closeHandle = meta.handle;
        try {
          await this.invoke('agent_fs_close', { handle: closeHandle });
        } finally {
          this._handlePaths.delete(closeHandle);
        }
        break;
      }
      case Zft2Op.stat:
        result = await this.invoke('agent_fs_stat', {
          root: this.config.sharedDirectoryPath,
          path: meta.path || '/',
        });
        break;
      case Zft2Op.list: {
        const entries = await this.invoke('agent_fs_list', {
          root: this.config.sharedDirectoryPath,
          path: meta.path || '/',
        });
        result = { entries: entries || [] };
        break;
      }
      case Zft2Op.mkdir:
        await this.invoke('agent_fs_mkdir', {
          root: this.config.sharedDirectoryPath,
          path: meta.path,
        });
        break;
      case Zft2Op.delete:
        await this.invoke('agent_fs_delete', {
          root: this.config.sharedDirectoryPath,
          path: meta.path,
          recursive: meta.recursive === true,
        });
        break;
      case Zft2Op.rename:
        await this.invoke('agent_fs_rename', {
          root: this.config.sharedDirectoryPath,
          oldPath: meta.oldPath,
          newPath: meta.newPath,
        });
        break;
      case Zft2Op.truncate:
        await this.invoke('agent_fs_truncate', {
          root: this.config.sharedDirectoryPath,
          path: meta.path,
          size: Number(meta.size ?? 0),
        });
        break;
      case Zft2Op.ping:
        result = { agentTime: Date.now() };
        break;
      default:
        throw Object.assign(new Error(`Unsupported ZFT2 operation: ${frame.type}`), {
          code: 'unsupported',
        });
    }
    this.transferCount += 1;
    this._emit();
    return encodeZft2Response(frame, { meta: result, payload });
  }

  async _dispatchFs(method, params) {
    const root = this.config.sharedDirectoryPath;
    switch (method) {
      case 'list': {
        const entries = await this.invoke('agent_fs_list', { root, path: params.path || '/' });
        return { entries: entries || [] };
      }
      case 'stat':
        return this.invoke('agent_fs_stat', { root, path: params.path || '/' });
      case 'open': {
        const handle = await this.invoke('agent_fs_open', {
          root,
          path: params.path,
          mode: params.mode || 'read',
        });
        return { handle };
      }
      case 'close':
        await this.invoke('agent_fs_close', { handle: params.handle });
        return {};
      case 'mkdir':
        await this.invoke('agent_fs_mkdir', { root, path: params.path });
        return {};
      case 'delete':
        await this.invoke('agent_fs_delete', {
          root,
          path: params.path,
          recursive: !!params.recursive,
        });
        return {};
      case 'rename':
        await this.invoke('agent_fs_rename', {
          root,
          oldPath: params.oldPath,
          newPath: params.newPath,
        });
        return {};
      case 'truncate':
        await this.invoke('agent_fs_truncate', {
          root,
          path: params.path,
          size: params.size || 0,
        });
        return {};
      default:
        throw Object.assign(new Error(`Unsupported method: ${method}`), { code: 'unsupported' });
    }
  }

  _startHeartbeat() {
    this._cancelHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (this.status !== 'online') return;
      this._missedHeartbeats += 1;
      if (this._missedHeartbeats >= 3) {
        this.errorMessage = 'Heartbeat timeout';
        this._setStatus('error');
        this._disconnect();
        this._maybeReconnect();
        return;
      }
      this._sendJson({ type: 'ping', time: Date.now() });
    }, this._heartbeatIntervalMs);
  }

  _cancelHeartbeat() {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = null;
    this._missedHeartbeats = 0;
  }

  _startShutdown() {
    if (!this.config.autoShutdown) return;
    this._cancelShutdown();
    const mins = Number(this.config.autoShutdownMinutes || 10);
    this._shutdownAt = Date.now() + mins * 60_000;
    this._shutdownTimer = setTimeout(() => {
      this._sendJson({
        type: 'agent_auto_shutdown',
        agentId: this.agentId || '',
        reason: `timeout_${mins}min`,
      });
      this.stop();
      this.errorMessage = `已因 ${mins} 分钟超时自动关闭`;
      this._setStatus('stopped');
    }, mins * 60_000);
    this._emit();
  }

  _cancelShutdown() {
    if (this._shutdownTimer) clearTimeout(this._shutdownTimer);
    this._shutdownTimer = null;
    this._shutdownAt = null;
  }

  _maybeReconnect() {
    if (this.status === 'stopped') return;
    if (this._reconnectAttempts >= this._maxReconnect) {
      this.errorMessage = 'Max reconnect attempts reached';
      this._setStatus('error');
      return;
    }
    this._setStatus('reconnecting');
    this._reconnectAttempts += 1;
    const delay = Math.min(this._reconnectAttempts, 30) * 1000;
    this._reconnectTimer = setTimeout(() => this._connect(), delay);
  }

  _cancelReconnect() {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
  }

  _onError() {
    if (['online', 'authenticating', 'connecting'].includes(this.status)) {
      this.errorMessage = 'websocket error';
      this._setStatus('error');
      this._cancelHeartbeat();
      this._maybeReconnect();
    }
  }

  _onDone() {
    this._cancelHeartbeat();
    if (['online', 'authenticating'].includes(this.status)) {
      this.errorMessage = 'Connection closed';
      this._setStatus('error');
      this._maybeReconnect();
    }
  }

  _friendly(error) {
    const raw = error?.message || String(error || '');
    if (/CERTIFICATE|TLS|SSL/i.test(raw)) return 'TLS/证书验证失败：请使用受信任 HTTPS 证书。';
    if (/refused/i.test(raw)) return '主端拒绝连接：请确认地址、端口和服务状态。';
    if (/lookup|DNS|resolve/i.test(raw)) return '域名解析失败：请检查主端地址或 DNS。';
    if (/timeout/i.test(raw)) return '连接超时：请检查网络、防火墙与 WebSocket 转发。';
    return raw;
  }
}
