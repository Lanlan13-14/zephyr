const CHANNEL = 'zephyr-one-native-rdp-v1';
const REQUEST_DIRECTION = 'embedded-to-shell';
const RESPONSE_DIRECTION = 'shell-to-embedded';
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CONNECTION_ID = /^[A-Za-z0-9_.:-]{1,256}$/;
const ACTIONS = new Set(['capabilities', 'open', 'show', 'focus', 'status', 'resize', 'capture', 'input', 'close']);
const OPEN_FIELDS = new Set(['sessionId', 'connectionId', 'width', 'height', 'dpi', 'title']);
const MESSAGE_REPLAY_TTL_MS = 2 * 60_000;

export const NATIVE_RDP_CHANNEL = CHANNEL;

function integer(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function optionalString(value, maxLength) {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

function sessionIdOf(payload) {
  const sessionId = optionalString(payload?.sessionId, 128);
  if (!SESSION_ID.test(sessionId)) throw new Error('rdp_ui_invalid_session: invalid session id');
  return sessionId;
}

function connectionIdOf(payload) {
  const connectionId = optionalString(payload?.connectionId, 256);
  if (!CONNECTION_ID.test(connectionId)) {
    throw new Error('rdp_ui_invalid_connection: invalid connection id');
  }
  return connectionId;
}

function openIntentOf(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('rdp_ui_invalid_intent: invalid open intent');
  }
  for (const field of Object.keys(payload)) {
    if (!OPEN_FIELDS.has(field)) {
      throw new Error('rdp_ui_unexpected_intent_field: open intent contains an unsupported field');
    }
  }
  return {
    sessionId: sessionIdOf(payload),
    connectionId: connectionIdOf(payload),
    width: integer(payload.width, 1280, 320, 8192),
    height: integer(payload.height, 720, 240, 8192),
    dpi: integer(payload.dpi, 96, 72, 480),
    title: optionalString(payload.title, 160).trim() || 'Zephyr One Remote Desktop',
  };
}

function publicError(error) {
  const raw = error instanceof Error ? error.message : String(error || '');
  const code = (/^([a-z0-9_]{3,80})(?::|$)/i.exec(raw) || [])[1] || 'rdp_native_failed';
  const knownMessages = {
    rdp_native_unavailable: 'Native RDP is unavailable in this build.',
    rdp_ui_authorization_denied: 'Native RDP open was not approved.',
    rdp_ui_disposed: 'The native RDP shell is closed.',
    rdp_ui_invalid_action: 'Unsupported native RDP action.',
    rdp_ui_invalid_connection: 'The connection identifier is invalid.',
    rdp_ui_invalid_intent: 'The native RDP intent is invalid.',
    rdp_ui_invalid_session: 'The session identifier is invalid.',
    rdp_ui_stale_capture: 'The native RDP capture is stale or was already used.',
    rdp_ui_invalid_input: 'The native RDP input is invalid.',
    rdp_ui_open_in_flight: 'This native RDP session is already opening.',
    rdp_ui_replayed_message: 'This native RDP request was already used.',
    rdp_ui_session_collision: 'The native RDP session is owned by another surface.',
    rdp_ui_session_not_owned: 'This app surface does not own the native RDP session.',
    rdp_ui_unexpected_intent_field: 'The native RDP intent contains an unsupported field.',
  };
  return { code, message: knownMessages[code] || 'Native RDP request failed.' };
}

function publicSurface(raw, sessionId) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    sessionId,
    platformSupported: raw.platformSupported !== false,
    created: raw.created === true,
    attached: raw.attached === true,
    visible: raw.visible === true,
    focused: raw.focused === true,
    width: integer(raw.width, 0, 0, 8192),
    height: integer(raw.height, 0, 0, 8192),
  };
}

function publicSession(raw, sessionId) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    sessionId,
    live: raw.live === true,
    stopping: raw.stopping === true,
    frames: integer(raw.frames, 0, 0, Number.MAX_SAFE_INTEGER),
    bytes: integer(raw.bytes, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

function phaseOf(surface, session) {
  if (!surface?.created) return 'closed';
  if (!surface.attached) return 'surface-detached';
  if (session?.live) return 'connected';
  return session?.stopping ? 'closing' : 'disconnected';
}

/**
 * Owns the native RDP commands for the local app iframe. The iframe can submit
 * only an opaque connection id plus presentation metadata. Native code resolves
 * connection settings and secrets atomically inside the trusted broker.
 */
export function createNativeRdpShellController({
  frame,
  expectedOrigin,
  invoke,
  isTauri,
  eventTarget = window,
  onStatus = () => {},
  now = () => Date.now(),
}) {
  if (!frame || typeof invoke !== 'function') {
    throw new TypeError('native RDP shell requires a frame and invoke');
  }
  const origin = new URL(expectedOrigin).origin;
  const ownedSessions = new Set();
  const sessionTransitions = new Set();
  const provisionalSessions = new Set();
  const seenRequestIds = new Map();
  const lastCaptures = new Map();
  let lifecycleEpoch = 0;
  let disposed = false;

  function assertActive(epoch) {
    if (disposed || epoch !== lifecycleEpoch) {
      throw new Error('rdp_ui_disposed: native RDP shell is closed');
    }
  }

  function sweepRequestIds() {
    const timestamp = now();
    for (const [requestId, expiresAt] of seenRequestIds) {
      if (timestamp >= expiresAt) seenRequestIds.delete(requestId);
    }
  }

  async function capabilities() {
    if (!isTauri) {
      return {
        available: false,
        platformSupported: false,
        freerdpMajor: null,
        clipboardAvailable: false,
        folderMappingAvailable: false,
        reason: 'Native RDP is available only in the Zephyr One desktop app.',
      };
    }
    const [engine, surface] = await Promise.all([
      invoke('rdp_native_capabilities'),
      invoke('rdp_native_surface_status', { sessionId: 'zephyr_one_capability_probe' }),
    ]);
    const available = engine?.available === true && surface?.platformSupported !== false;
    return {
      available,
      platformSupported: surface?.platformSupported !== false,
      freerdpMajor: engine?.freerdpMajor ?? null,
      clipboardAvailable: engine?.clipboardAvailable === true,
      folderMappingAvailable: false,
      reason: available ? '' : 'Native RDP is unavailable in this build.',
    };
  }

  async function snapshot(sessionId) {
    const rawSurface = await invoke('rdp_native_surface_status', { sessionId });
    const surface = publicSurface(rawSurface, sessionId);
    let session = null;
    if (surface?.created && surface.attached) {
      const rawSession = await invoke('rdp_native_session_state', { sessionId }).catch(() => null);
      session = publicSession(rawSession, sessionId);
    }
    return { surface, session, phase: phaseOf(surface, session) };
  }

  async function capture(payload) {
    const sessionId = requireOwned(payload);
    const raw = await invoke('rdp_native_surface_capture', {
      sessionId,
      maxWidth: integer(payload?.maxWidth, 960, 320, 1920),
    });
    if (!raw || typeof raw.captureId !== 'string' || !raw.captureId
      || typeof raw.dataUrl !== 'string' || !raw.dataUrl.startsWith('data:image/png;base64,')) {
      throw new Error('rdp_native_failed: native surface returned an invalid capture');
    }
    const result = {
      sessionId,
      captureId: raw.captureId.slice(0, 256),
      frameAt: integer(raw.frameAt, now(), 1, Number.MAX_SAFE_INTEGER),
      width: integer(raw.width, 0, 1, 1920),
      height: integer(raw.height, 0, 1, 8192),
      originalWidth: integer(raw.originalWidth, 0, 1, 8192),
      originalHeight: integer(raw.originalHeight, 0, 1, 8192),
      dataUrl: raw.dataUrl,
      connected: true,
      connectionPhase: 'connected',
      certPhase: 'accepted',
    };
    lastCaptures.set(sessionId, result);
    return result;
  }

  async function input(payload) {
    const sessionId = requireOwned(payload);
    const captureId = optionalString(payload?.captureId, 256);
    const capture = lastCaptures.get(sessionId);
    if (!captureId || !capture || capture.captureId !== captureId) {
      throw new Error('rdp_ui_stale_capture: native capture is stale or was already used');
    }
    lastCaptures.delete(sessionId);
    const control = optionalString(payload?.control, 40).toLowerCase().replace(/-/g, '_');
    if (control === 'text' || control === 'clipboard_send') {
      const text = optionalString(payload?.text, 32768);
      if (!text) throw new Error('rdp_ui_invalid_input: text is empty');
      const sent = await invoke('rdp_native_send_text', { sessionId, text });
      return { ok: true, control, length: Number(sent) || text.length, captureId };
    }
    if (control === 'mouse_click') {
      const x = integer(payload?.x, -1, -1, 65535);
      const y = integer(payload?.y, -1, -1, 65535);
      if (x < 0 || y < 0 || x >= capture.originalWidth || y >= capture.originalHeight) {
        throw new Error('rdp_ui_invalid_input: mouse coordinates are outside the captured surface');
      }
      const button = integer(payload?.button, 1, 1, 3);
      const buttonFlag = button === 1 ? 0x1000 : button === 2 ? 0x4000 : 0x2000;
      await invoke('rdp_native_send_mouse', { sessionId, flags: 0x0800, x, y, extended: false });
      await invoke('rdp_native_send_mouse', { sessionId, flags: buttonFlag | 0x8000, x, y, extended: false });
      await new Promise((resolve) => setTimeout(resolve, 45));
      await invoke('rdp_native_send_mouse', { sessionId, flags: buttonFlag, x, y, extended: false });
      return { ok: true, control, x, y, button, captureId };
    }
    throw new Error('rdp_ui_invalid_input: unsupported native RDP input');
  }

  function requireOwned(payload) {
    const sessionId = sessionIdOf(payload);
    if (!ownedSessions.has(sessionId)) {
      throw new Error('rdp_ui_session_not_owned: session is not owned by this app surface');
    }
    return sessionId;
  }

  async function open(payload) {
    const intent = openIntentOf(payload);
    const { sessionId, connectionId, width, height, dpi, title } = intent;
    if (!isTauri) throw new Error('rdp_native_unavailable: Zephyr One desktop runtime required');
    if (sessionTransitions.has(sessionId)) {
      throw new Error('rdp_ui_open_in_flight: this native RDP session is already opening');
    }

    const epoch = lifecycleEpoch;
    sessionTransitions.add(sessionId);
    let created = false;
    try {
      const caps = await capabilities();
      assertActive(epoch);
      if (!caps.available) throw new Error('rdp_native_unavailable: native FreeRDP is unavailable');

      const existing = await invoke('rdp_native_surface_status', { sessionId });
      assertActive(epoch);
      if (existing?.created && existing?.attached) {
        if (!ownedSessions.has(sessionId)) {
          throw new Error('rdp_ui_session_collision: refusing to adopt an unowned native session');
        }
        await invoke('rdp_native_surface_show', { sessionId });
        await invoke('rdp_native_surface_focus', { sessionId }).catch(() => null);
        assertActive(epoch);
        return snapshot(sessionId);
      }

      provisionalSessions.add(sessionId);
      await invoke('rdp_native_surface_create', {
        sessionId,
        width,
        height,
        dpi,
        title,
        visible: true,
      });
      created = true;
      assertActive(epoch);
      const started = await invoke('rdp_native_connect', {
        request: { connectionId, sessionId, width, height },
      });
      assertActive(epoch);
      if (started?.started !== true) {
        throw new Error('rdp_native_failed: native RDP broker did not start the session');
      }
      provisionalSessions.delete(sessionId);
      ownedSessions.add(sessionId);
      await invoke('rdp_native_surface_focus', { sessionId }).catch(() => null);
      assertActive(epoch);
      return snapshot(sessionId);
    } catch (error) {
      if (created) await invoke('rdp_native_surface_close', { sessionId }).catch(() => null);
      provisionalSessions.delete(sessionId);
      ownedSessions.delete(sessionId);
      throw error;
    } finally {
      sessionTransitions.delete(sessionId);
    }
  }

  async function dispatch(action, payload) {
    if (disposed) throw new Error('rdp_ui_disposed: native RDP shell is closed');
    if (!ACTIONS.has(action)) throw new Error('rdp_ui_invalid_action: unsupported native RDP action');
    if (action === 'capabilities') return capabilities();
    if (!isTauri) throw new Error('rdp_native_unavailable: Zephyr One desktop runtime required');
    if (action === 'open') return open(payload);

    const sessionId = requireOwned(payload);
    if (sessionTransitions.has(sessionId)) {
      throw new Error('rdp_ui_open_in_flight: this native RDP session is already opening');
    }
    if (action === 'show') {
      await invoke('rdp_native_surface_show', { sessionId });
      return snapshot(sessionId);
    }
    if (action === 'focus') {
      await invoke('rdp_native_surface_focus', { sessionId });
      return snapshot(sessionId);
    }
    if (action === 'resize') {
      const width = integer(payload?.width, 1280, 320, 8192);
      const height = integer(payload?.height, 720, 240, 8192);
      await invoke('rdp_native_surface_resize', { sessionId, width, height });
      return snapshot(sessionId);
    }
    if (action === 'capture') return capture(payload);
    if (action === 'input') return input(payload);
    if (action === 'close') {
      sessionTransitions.add(sessionId);
      try {
        const closed = await invoke('rdp_native_surface_close', { sessionId });
        ownedSessions.delete(sessionId);
        lastCaptures.delete(sessionId);
        return { closed: closed === true, phase: 'closed' };
      } finally {
        sessionTransitions.delete(sessionId);
      }
    }
    return snapshot(sessionId);
  }

  async function onMessage(event) {
    if (disposed || event.source !== frame.contentWindow || event.origin !== origin) return;
    const message = event.data;
    if (
      !message
      || message.channel !== CHANNEL
      || message.direction !== REQUEST_DIRECTION
      || typeof message.requestId !== 'string'
      || message.requestId.length < 1
      || message.requestId.length > 128
    ) return;

    const response = {
      channel: CHANNEL,
      direction: RESPONSE_DIRECTION,
      requestId: message.requestId,
      action: message.action,
    };
    try {
      sweepRequestIds();
      if (seenRequestIds.has(message.requestId)) {
        throw new Error('rdp_ui_replayed_message: request id was already used');
      }
      seenRequestIds.set(message.requestId, now() + MESSAGE_REPLAY_TTL_MS);
      response.ok = true;
      response.result = await dispatch(message.action, message.payload || {});
      onStatus(message.action, response.result);
    } catch (error) {
      response.ok = false;
      response.error = publicError(error);
      onStatus('error', response.error);
    }
    if (!disposed && frame.contentWindow === event.source) {
      event.source.postMessage(response, origin);
    }
  }

  eventTarget.addEventListener('message', onMessage);

  return {
    dispatch,
    ownedSessions,
    dispose({ closeSessions = true } = {}) {
      if (disposed) return;
      disposed = true;
      lifecycleEpoch += 1;
      eventTarget.removeEventListener('message', onMessage);
      if (closeSessions && isTauri) {
        for (const sessionId of new Set([...ownedSessions, ...provisionalSessions])) {
          invoke('rdp_native_surface_close', { sessionId }).catch(() => null);
        }
      }
      ownedSessions.clear();
      sessionTransitions.clear();
      provisionalSessions.clear();
      lastCaptures.clear();
      seenRequestIds.clear();
    },
  };
}
