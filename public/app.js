import { reduceParentKeyboardMessage } from './ssh-keyboard/bridge.js?v=20260723-sync2';
import { applyZephyrColorScheme, DEFAULT_CUSTOM_THEME_COLORS, normalizeCustomThemeColors, zephyrBrandIconHtml, zephyrDefaultBrandName, zephyrFaviconHref, zephyrResolveBrandName } from './theme-runtime.js?v=20260810-one-brand2';
import { createNotesController } from './notes.js?v=20260811-webdav1';
import { renderMarkdown as renderMarkdownCore, renderInlineMarkdown as renderInlineMarkdownCore } from './markdown.js?v=20260720-notes-md1';
import { t, initI18n, setLocale, getLocale, applyDomI18n, onLocaleChange, formatDateTime } from './i18n/runtime.js?v=20260811-webdav1';
import { localizeActivityMessage } from './activity-i18n.js?v=20260811-webdav1';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
/* Null-safe DOM writes, for a file served to two different DOM shapes.
 *
 * zephyr-one-embed-surface.js structurally removes the browser-era
 * credential surface from app.html before Zephyr One ever loads it: password
 * change, TOTP, passkeys, CAPTCHA, IP policy, login events and the profile
 * form, 43 element ids in total. Every binding for them was written as
 * `$('#id').addEventListener(...)` or `$('#id').value = ...`, so in One the
 * first one threw `Cannot read properties of null` inside bindEvents(), which
 * aborted init() before applyAppearance() ever ran.
 *
 * That single throw is what the packaged desktop app showed as a failed load:
 * the static shell painted, then nothing else happened. The header kept the
 * emoji placeholder and the window title stayed 'Zephyr' -- not because the
 * branding was wrong but because the code that applies it never executed.
 *
 * Writes need helpers because `?.` cannot be an assignment target; reads and
 * addEventListener calls use `?.` directly. A missing element is a legitimate
 * state here rather than an error to report: One is *supposed* to have no
 * password form, so it must be skipped silently and not logged.
 */
const withEl = (sel, fn) => { const el = $(sel); if (el) fn(el); return el; };
const setVal = (sel, value) => withEl(sel, (el) => { el.value = value; });
const setChecked = (sel, checked) => withEl(sel, (el) => { el.checked = checked; });
function installClosestFallback() {
    const define = (proto, fn) => {
        if (!proto || proto.closest) return;
        try { Object.defineProperty(proto, 'closest', { value: fn, configurable: true }); } catch {}
    };
    define(window.Text?.prototype, function closestFromText(selector) { return this.parentElement?.closest?.(selector) || null; });
    define(window.Document?.prototype, function closestFromDocument() { return null; });
    define(window.Window?.prototype, function closestFromWindow() { return null; });
}

/* Browser change wake runtime start. Kept dependency-injected so the same
 * lifecycle runs in standalone Web, the Zephyr One iframe, and browser tests. */
function createBrowserChangeWakeClient({
    endpoint,
    entityTypes,
    onEntityTypes,
    onResume = () => {},
    EventSourceImpl,
    documentRef,
    windowRef,
    navigatorRef,
    locationRef,
    setTimeoutImpl = window.setTimeout.bind(window),
    clearTimeoutImpl = window.clearTimeout.bind(window),
    baseRetryMs = 1000,
    maxRetryMs = 30000,
} = {}) {
    const allowedEntityTypes = new Set(entityTypes || []);
    let source = null;
    let reconnectTimer = 0;
    let reconnectAttempt = 0;
    let lastSequence = null;
    let started = false;

    const isVisible = () => documentRef?.visibilityState !== 'hidden';
    const isOnline = () => navigatorRef?.onLine !== false;
    const clearReconnect = () => {
        if (!reconnectTimer) return;
        clearTimeoutImpl(reconnectTimer);
        reconnectTimer = 0;
    };
    const disconnect = () => {
        const current = source;
        source = null;
        try { current?.close?.(); } catch {}
    };
    const streamUrl = () => {
        const url = new URL(endpoint, locationRef?.href || 'http://localhost/');
        if (lastSequence !== null) url.searchParams.set('cursor', String(lastSequence));
        return url.origin === locationRef?.origin
            ? `${url.pathname}${url.search}`
            : url.href;
    };
    const scheduleReconnect = () => {
        disconnect();
        clearReconnect();
        if (!started || !isVisible() || !isOnline() || typeof EventSourceImpl !== 'function') return;
        const delay = Math.min(maxRetryMs, baseRetryMs * (2 ** reconnectAttempt));
        reconnectAttempt += 1;
        reconnectTimer = setTimeoutImpl(() => {
            reconnectTimer = 0;
            connect();
        }, delay);
    };
    const handleChange = (candidate, event) => {
        if (source !== candidate) return;
        let payload;
        try { payload = JSON.parse(String(event?.data || '')); } catch { return; }
        const sequence = Number(payload?.sequence);
        const reason = String(payload?.reason || '');
        const rawTypes = Array.isArray(payload?.entityTypes) ? payload.entityTypes : null;
        if (!Number.isSafeInteger(sequence) || sequence < 0
            || !['connected', 'change', 'reconnect', 'database_rebind'].includes(reason)
            || !rawTypes
            || rawTypes.some((type) => typeof type !== 'string' || !allowedEntityTypes.has(type))) return;
        lastSequence = sequence;
        reconnectAttempt = 0;
        const uniqueTypes = [...new Set(rawTypes)];
        if (uniqueTypes.length) onEntityTypes?.(uniqueTypes, payload);
    };
    function connect() {
        if (!started || source || reconnectTimer || !isVisible() || !isOnline()
            || typeof EventSourceImpl !== 'function') return;
        const candidate = new EventSourceImpl(streamUrl(), { withCredentials: true });
        source = candidate;
        candidate.onopen = () => {
            if (source === candidate) reconnectAttempt = 0;
        };
        candidate.addEventListener('change', (event) => handleChange(candidate, event));
        candidate.onerror = () => {
            if (source === candidate) scheduleReconnect();
        };
    }
    const handleVisibility = () => {
        if (!isVisible()) {
            clearReconnect();
            disconnect();
            return;
        }
        onResume();
        connect();
    };
    const handleOnline = () => { onResume(); connect(); };
    const handleOffline = () => { clearReconnect(); disconnect(); };
    const handlePageHide = () => { clearReconnect(); disconnect(); };
    const handlePageShow = () => { onResume(); connect(); };
    const start = () => {
        if (started) return;
        started = true;
        documentRef?.addEventListener?.('visibilitychange', handleVisibility);
        windowRef?.addEventListener?.('online', handleOnline);
        windowRef?.addEventListener?.('offline', handleOffline);
        windowRef?.addEventListener?.('pagehide', handlePageHide);
        windowRef?.addEventListener?.('pageshow', handlePageShow);
        connect();
    };
    const stop = () => {
        if (!started) return;
        started = false;
        clearReconnect();
        disconnect();
        documentRef?.removeEventListener?.('visibilitychange', handleVisibility);
        windowRef?.removeEventListener?.('online', handleOnline);
        windowRef?.removeEventListener?.('offline', handleOffline);
        windowRef?.removeEventListener?.('pagehide', handlePageHide);
        windowRef?.removeEventListener?.('pageshow', handlePageShow);
    };
    return {
        start,
        stop,
        connect,
        state: () => ({ connected: !!source, reconnectAttempt, lastSequence, started }),
    };
}

function createBrowserChangeRefreshScheduler({
    entityGroups,
    loaders,
    documentRef,
    debounceMs = 160,
    setTimeoutImpl = window.setTimeout.bind(window),
    clearTimeoutImpl = window.clearTimeout.bind(window),
} = {}) {
    const typeTimers = new Map();
    const groupStates = new Map();
    const isVisible = () => documentRef?.visibilityState !== 'hidden';
    const stateFor = (group) => {
        if (!groupStates.has(group)) groupStates.set(group, { queued: false, running: null, launchTimer: 0 });
        return groupStates.get(group);
    };
    const requestGroup = (group) => {
        const loader = loaders?.[group];
        if (typeof loader !== 'function') return;
        const state = stateFor(group);
        state.queued = true;
        if (state.running || state.launchTimer || !isVisible()) return;
        state.launchTimer = setTimeoutImpl(() => {
            state.launchTimer = 0;
            if (state.running || !state.queued || !isVisible()) return;
            state.running = (async () => {
                while (state.queued && isVisible()) {
                    state.queued = false;
                    try { await loader(); } catch (error) {
                        console.warn('[change-wake]', group, error?.code || error?.message || error);
                    }
                }
            })().finally(() => {
                state.running = null;
                if (state.queued && isVisible()) requestGroup(group);
            });
        }, 0);
    };
    const flushType = (type) => {
        const timer = typeTimers.get(type);
        if (timer) clearTimeoutImpl(timer);
        typeTimers.delete(type);
        const groups = Array.isArray(entityGroups?.[type]) ? entityGroups[type] : [entityGroups?.[type]];
        groups.filter(Boolean).forEach(requestGroup);
    };
    const schedule = (types) => {
        [...new Set(Array.isArray(types) ? types : [])].forEach((type) => {
            if (!entityGroups?.[type]) return;
            const oldTimer = typeTimers.get(type);
            if (oldTimer) clearTimeoutImpl(oldTimer);
            typeTimers.set(type, setTimeoutImpl(() => flushType(type), debounceMs));
        });
    };
    const resume = () => {
        if (!isVisible()) return;
        groupStates.forEach((state, group) => {
            if (state.queued) requestGroup(group);
        });
    };
    const flushNow = () => {
        [...typeTimers.keys()].forEach(flushType);
        resume();
    };
    const stop = () => {
        typeTimers.forEach((timer) => clearTimeoutImpl(timer));
        typeTimers.clear();
        groupStates.forEach((state) => {
            state.queued = false;
            if (state.launchTimer) clearTimeoutImpl(state.launchTimer);
            state.launchTimer = 0;
        });
    };
    return { schedule, resume, flushNow, stop };
}
/* Browser change wake runtime end. */

installClosestFallback();
document.documentElement.dataset.appModule = 'loaded';

const BROWSER_CHANGE_ENTITY_TYPES = Object.freeze([
    'connection', 'proxy', 'sshKey', 'jumpHost', 'note', 'snippet',
    'aiProvider', 'aiMemory', 'aiSkill', 'aiEnv', 'aiConversation', 'aiMessage',
    'oneUserSettings', 'serverSettings', 'backupMetadata', 'activityEvent',
    'resourceAcl', 'clientToken', 'workspaceState', 'fileSyncConfig',
]);
const BROWSER_CHANGE_ENTITY_GROUPS = Object.freeze({
    connection: 'connections',
    proxy: 'network',
    sshKey: 'network',
    jumpHost: 'network',
    note: 'notes',
    snippet: 'settings',
    aiProvider: 'settings',
    aiMemory: 'settings',
    aiSkill: 'settings',
    aiEnv: 'settings',
    aiConversation: 'aiHistory',
    aiMessage: 'aiHistory',
    oneUserSettings: 'settings',
    serverSettings: 'settings',
    backupMetadata: 'backup',
    activityEvent: 'activities',
    resourceAcl: ['connections', 'network', 'settings', 'notes'],
    clientToken: 'agentTokens',
    workspaceState: 'workspace',
    fileSyncConfig: 'oneClients',
});

let connections = [], activities = [], proxies = [], jumpHosts = [], sshKeys = [], settings = {}, personalSettingsOverrides = {};
let connectionsLoadGeneration = 0;
let activitiesLoadGeneration = 0;
let networkLoadGeneration = 0;
let settingsLoadGeneration = 0;
let activityRange = '7d';
let zephyrSharedClipboard = { type: '', text: '', files: [], sourceTabId: '', sourcePage: '', updatedAt: 0 };
let aiSettingsState = null;
let aiProviderShareTargetsState = [];
let aiProviderSelectedUserIds = new Set();
let aiChatSessions = [];
let aiCurrentSessionId = null;
let aiHistoryLoaded = false;
let aiHistoryLoadPromise = null;
let aiHistoryReloadTimer = 0;
let aiPanelLayoutMenu = null;
let aiPanelLayoutMenuButton = null;
let aiPanelSuppressLayoutClick = false;
let aiBrowserPreviewTimer = 0;
let aiAutoTitleTimer = 0;
let aiSidebarCollapsedBySize = false;
let aiPendingConfirmations = new Map();
const aiBrowserPreviewStates = new Map();
const aiSessionRuns = new Map();
let aiStoppedControllers = new WeakSet();
let aiPanelState = 'closed';
let aiPanelCloseTimer = 0;
let aiPanelWatchdogTimer = 0;
let aiPanelMorphOriginButton = null;
let aiRemoteDesktopActionSeq = 0;
const aiRemoteDesktopActionWaiters = new Map();
let aiCodeBlockSeq = 0;
const aiCodeBlockStore = new Map();
let aiCodePreviewObjectUrl = '';
let aiMessageMenuState = { index: -1, text: '', element: null, touchTimer: 0 };
let aiEditingMessageIndex = -1;
let aiEditingSessionId = '';
let aiPendingInputAttachments = [];
const AI_CHAT_STORAGE_KEY = 'zephyr-ai-chat-sessions';
let editingId = null;
let editingSecretLoaded = false;
let editingConnectionSecretState = { hasPassword: false, hasPrivateKey: false, sshKeyId: '' };
let connectionModalMode = 'create'; // create | edit | transient
let connectionModalSource = 'dashboard';
let transientToken = '';
let transientHasCredential = false;
let connectionModalTrigger = null;
let connectionModalCycle = 0;
const connectionModalMotion = { phase: 'closed', originRect: null, targetRect: null, trigger: null };
const terminalCardFlipMotion = { phase: 'closed', cycle: 0, originRect: null, sourceEl: null, connectionId: null, fromView: 'dashboard', layoutW: 0, layoutH: 0, hostedWindow: null, hostedParent: null, hostedNext: null };
let proxyModalTrigger = null;
let proxyModalCycle = 0;
let sshKeyModalTrigger = null;
let sshKeyModalCycle = 0;
let adminUserModalTrigger = null;
let adminUserModalCycle = 0;
let snippetModalTrigger = null;
let snippetModalCycle = 0;
let aiProviderModalTrigger = null;
let aiProviderModalCycle = 0;
let notesController = null;
let workspaceClientId = '';
let workspaceRevision = null;
let workspaceRestoring = false;
let workspaceReady = false;
let workspaceSaveTimer = null;
let workspaceRemoteUpdatePending = false;
let browserChangeWakeClient = null;
let browserChangeRefreshScheduler = null;
let currentAppView = 'dashboard';
let terminalTabs = [], activeTerminalTab = null;
let openOrderStack = [], visualLayout = [], recentUseStack = [];
let terminalSmartbarOpen = false;
let terminalSmartbarSide = 'center';
let terminalSmartbarPickerOpen = false;
let terminalSmartbarTimer = 0;
let terminalSmartbarClosing = false;
let terminalSmartbarLastInnerPointerAt = 0;
let terminalSmartbarPointerInside = false;
const TERMINAL_SMARTBAR_AUTO_CLOSE_MS = 10000;
let smartbarDragState = null;
let smartbarPressState = null;
let suppressSmartbarClick = false;
let smartbarHoverWindowId = null;
let smartbarTrashHover = false;
let dockSwapAnimatingWindows = new Set();
let dockLaunchAnimatingWindows = new Set();
let terminalDragState = null;
let terminalControlLongPress = false;
let mobileDockTogglePressState = null;
let mobileDockToggleLastToggleAt = 0;
const terminalReconnectFallbackTimers = new Map();
/** Mid-flight interrupt token for mobile stretchExpand fullscreen. */
let terminalFullscreenMotionGen = 0;
/** Collapsed workspace rect captured just before mobile fullscreen expand. */
let terminalFullscreenOriginRect = null;
/** One shared exit promise prevents close/minimize from racing the collapse. */
let terminalFullscreenExitPromise = null;
let sshKbParentBaseline = 0;
let sshKbParentOpen = false;
// True only after parent visualViewport itself observed a real IME inset.
// An overlays-content parent that always reports 0 must never close an iframe-open IME.
let sshKbParentInset = 0;
let sshKbParentSettleTimer = 0;
let sshKbParentLastSignature = '';
let sshKbParentPendingMetrics = null;
let sshKbParentFreezeReleaseTimer = 0;
/** Last physically observed IME height/top from parent VV (not invented 34%). */
let sshKbParentLastGoodInset = 0;
let sshKbParentLastGoodTop = 0;
let sshKbParentSeenPhysical = false;
let sshKbParentLowSince = 0;
/** Child intent open, waiting for real parent VV/VK height before first crop. */
let sshKbParentAwaiting = false;
let sshKbParentAwaitingSince = 0;
let sshKbParentAwaitingMetrics = null;
let closingTerminalTabs = new Set();
 
let minimizingTerminalTabs = new Set();
let securityStatus = { user: {}, passkeys: [] }, ipBans = [], loginEvents = [];

const SMARTBAR_AUTO_HIDE_MS = 30000;
const SMARTBAR_TOUCH_DRAG_HOLD_MS = 2000;
const SMARTBAR_TOUCH_TAP_MAX_MS = 1999;
const TERMINAL_EDGE_SNAP_PX = 56;
/* The product name shown when the operator has not chosen one.
 *
 * A function, not a constant: One serves this same app.js, so a literal
 * 'Zephyr' made the One header and the window title both read "Zephyr".
 * With the wind mark being the same artwork in both products, nothing on
 * screen identified which product the user was actually in.
 */
const defaultBrandName = () => zephyrDefaultBrandName();
const DEFAULT_BRAND_ICON = '🌬️';
let pendingBrandIcon = DEFAULT_BRAND_ICON;
const SMARTBAR_TEXT_IMAGE_CACHE = new Map();

function localizedAiError(error = {}) {
    const code = String(error?.code || error?.errorCode || '').trim();
    const field = String(error?.field || '').trim();
    const byCode = {
        invalid_tool_arguments: field ? t('AI 工具参数无效：{field}', { field }) : t('AI 工具参数无效'),
        revision_conflict: t('资源已被其他操作修改，请重新读取后再试'),
        resource_not_found_or_inaccessible: t('资源不存在或无权访问'),
        notes_disabled: t('当前用户未启用笔记功能'),
        stale_dom_revision: t('页面 DOM 已变化，请重新检查页面元素'),
        stale_element_ref: t('页面元素引用已失效，请重新检查页面元素'),
        stale_capture: t('远程桌面画面已变化，请重新截图后再操作'),
        agent_read_only: t('Agent 共享为只读'),
        agent_offline: t('Agent 当前离线'),
        invalid_secret_ref: t('secretRef 无效'),
        secret_ref_forbidden: t('secretRef 不属于当前用户'),
        secret_ref_expired: t('secretRef 已过期，请重新发现'),
        secret_ref_kind_mismatch: t('secretRef 类型不匹配'),
        invalid_terminal_protocol: t('标准终端操作仅支持 SSH 或 TELNET 会话'),
        terminal_not_writable: t('终端会话已断开或不可写'),
        invalid_wait_pattern: t('等待正则表达式无效'),
    };
    return byCode[code] || error?.message || error?.error || t('操作失败');
}
function apiErrorFromResponse(res, data = {}) {
    const raw = data.error || data.message;
    const message = data.code ? localizedAiError({ code: data.code, field: data.field, error: typeof raw === 'string' ? raw : raw?.message }) : (typeof raw === 'string' ? raw : (raw?.message || raw?.code || `请求失败（HTTP ${res.status}）`));
    const err = new Error(message);
    err.status = res.status;
    err.code = data.code || raw?.code || '';
    err.retryable = !!data.retryable;
    err.transient = !!data.transient || res.status === 502 || res.status === 503 || res.status === 504;
    err.payload = data;
    return err;
}
function api(path, options = {}) {
    return fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options })
        .then(async (res) => { const data = await res.json().catch(() => ({})); if (!res.ok) throw apiErrorFromResponse(res, data); return data; });
}

/* Backup import UI start. The one-time grant stays in function scope so it
 * cannot be persisted or reused after either phase finishes. */
const backupImportUiState = { active: false, statusKey: '' };

function makeBackupImportUiError(code, status = 0) {
    const error = new Error('Backup import failed.');
    error.code = String(code || 'backup_import_failed');
    error.status = Number(status) || 0;
    return error;
}

function backupImportErrorKey(error) {
    const byCode = {
        backup_import_step_up_failed: '当前登录密码验证失败，请重试。',
        backup_import_grant_invalid: '导入授权无效或已过期，请重新验证当前登录密码。',
        invalid_backup_import_multipart: '备份导入请求无效，请重新选择备份文件后重试。',
        backup_import_payload_too_large: '备份文件超过允许的大小限制。',
        backup_import_busy: '已有备份导入正在进行，请稍后重试。',
        webdav_sensitive_rate_limited: '敏感操作过于频繁，请稍后重试。',
    };
    return byCode[String(error?.code || '')] || '导入失败，请稍后重试。';
}

function setBackupImportStatus(statusKey, { tone = 'idle', focus = false } = {}) {
    backupImportUiState.statusKey = statusKey;
    const status = $('#importDataStatus');
    if (!status) return;
    status.textContent = statusKey ? t(statusKey) : '';
    status.dataset.state = tone;
    status.setAttribute('aria-live', tone === 'warning' || tone === 'error' ? 'assertive' : 'polite');
    if (focus) status.focus({ preventScroll: true });
}

function setBackupImportBusy(busy, labelKey = '导入备份') {
    const form = $('#importDataForm');
    const button = $('#importDataBtn');
    form?.setAttribute('aria-busy', busy ? 'true' : 'false');
    form?.querySelectorAll('input, button').forEach((control) => { control.disabled = busy; });
    if (button) {
        button.textContent = t(labelKey);
        button.setAttribute('aria-busy', busy ? 'true' : 'false');
        button.setAttribute('aria-disabled', busy ? 'true' : 'false');
    }
}

async function readBackupImportResponse(response) {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw makeBackupImportUiError(payload?.code, response.status);
    return payload && typeof payload === 'object' ? payload : {};
}

async function submitBackupImport({ fetchImpl = fetch, confirmImpl = confirm } = {}) {
    if (backupImportUiState.active) return { ok: false, busy: true };
    const form = $('#importDataForm');
    const fileInput = $('#backupFile');
    const loginPasswordInput = $('#importLoginPassword');
    const backupPasswordInput = $('#backupPassword');
    const file = fileInput?.files?.[0];
    let loginPassword = String(loginPasswordInput?.value || '');
    let backupPassword = String(backupPasswordInput?.value || '');
    if (!file) {
        setBackupImportStatus('backupImport.fileRequired', { tone: 'error', focus: true });
        fileInput?.focus({ preventScroll: true });
        return { ok: false, validation: true };
    }
    if (!loginPassword) {
        setBackupImportStatus('backupImport.loginPasswordRequired', { tone: 'error', focus: true });
        loginPasswordInput?.focus({ preventScroll: true });
        return { ok: false, validation: true };
    }
    if (!confirmImpl(t('导入会覆盖当前数据库，系统会先生成本地备份。继续？'))) return { ok: false, cancelled: true };

    backupImportUiState.active = true;
    setBackupImportBusy(true, '正在验证导入授权');
    setBackupImportStatus('backupImport.verifyingAuthorization', { tone: 'busy' });
    let uploadStarted = false;
    let grant = '';
    try {
        let grantResponse;
        try {
            grantResponse = await fetchImpl('/api/data/import/grant', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: loginPassword }),
            });
        } finally {
            loginPassword = '';
            if (loginPasswordInput) loginPasswordInput.value = '';
        }
        const grantPayload = await readBackupImportResponse(grantResponse);
        grant = typeof grantPayload.grant === 'string' ? grantPayload.grant : '';
        if (!grant) throw makeBackupImportUiError('backup_import_grant_invalid', grantResponse.status);

        const formData = new FormData();
        formData.append('backup', file);
        if (backupPassword) formData.append('backupPassword', backupPassword);
        setBackupImportBusy(true, '正在上传备份');
        setBackupImportStatus('backupImport.uploadingBackup', { tone: 'busy' });
        uploadStarted = true;
        let importResponse;
        try {
            importResponse = await fetchImpl('/api/data/import', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'X-Zephyr-Backup-Import-Grant': grant },
                body: formData,
            });
        } catch (error) {
            error.backupImportOutcomeUnknown = true;
            throw error;
        }
        const result = await readBackupImportResponse(importResponse);
        setBackupImportStatus(result.message || '导入完成', { tone: 'success', focus: true });
        return { ok: true, value: result };
    } catch (error) {
        const outcomeUnknown = uploadStarted && error?.backupImportOutcomeUnknown === true;
        setBackupImportStatus(
            outcomeUnknown ? '导入请求已提交；结果可能已完成，请刷新页面确认。' : backupImportErrorKey(error),
            { tone: outcomeUnknown ? 'warning' : 'error', focus: true },
        );
        return { ok: false, error, outcomeUnknown };
    } finally {
        loginPassword = '';
        backupPassword = '';
        grant = '';
        if (uploadStarted && backupPasswordInput) backupPasswordInput.value = '';
        backupImportUiState.active = false;
        setBackupImportBusy(false);
    }
}

function setupBackupImportUi() {
    $('#importDataForm')?.addEventListener('submit', (event) => {
        event.preventDefault();
        submitBackupImport();
    });
}
/* Backup import UI end. */
function apiMaybeForm(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (!(options.body instanceof FormData) && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    return fetch(path, { credentials: 'same-origin', headers, ...options })
        .then(async (res) => { const data = await res.json().catch(() => ({})); if (!res.ok) throw apiErrorFromResponse(res, data); return data; });
}
/* Toast → 仅 zephyr-motion toastPush 堆叠（API.md §5.4）。
 * 多条消息各自入场/退场，新消息把旧消息顶开；无 CSS 进出场 fallback。 */
let toastMotionEngine = null;
let toastMotionPromise = null;
function ensureToastMotion() {
    if (toastMotionEngine) return Promise.resolve(toastMotionEngine);
    if (toastMotionPromise) return toastMotionPromise;
    toastMotionPromise = (async () => {
        try {
            if (sshKeyMotion && typeof sshKeyMotion._ensure === 'function') {
                const viaShared = await sshKeyMotion._ensure();
                if (viaShared?.toastPush) {
                    toastMotionEngine = viaShared;
                    return viaShared;
                }
            }
        } catch { /* TDZ */ }
        const mod = await import('./vendor/zephyr-motion/index.js?v=20260731-motion-mobile-fix2');
        const Motion = mod?.Motion || window.Motion;
        if (!Motion?.toastPush) throw new Error('Motion.toastPush unavailable');
        try { await Motion.init({ capacity: 256 }); } catch {}
        toastMotionEngine = Motion;
        return Motion;
    })().catch((err) => {
        toastMotionPromise = null;
        throw err;
    });
    return toastMotionPromise;
}
function ensureAppToastHost() {
    let host = document.getElementById('toastHost') || document.querySelector('.toast-container');
    if (!host) {
        host = document.createElement('div');
        host.id = 'toastHost';
        host.className = 'toast-container';
        host.setAttribute('aria-live', 'polite');
        document.body.appendChild(host);
    }
    return host;
}
function styleAppToastNode(el) {
    if (!el) return;
    // 统一中性样式（与原单例 toast 一致，不做 success/error 变色）
    el.className = 'toast';
    // 清掉 toastPush demo 内联 chrome；保留引擎 transform/opacity
    el.style.background = '';
    el.style.border = '';
    el.style.borderColor = '';
    el.style.borderRadius = '';
    el.style.boxShadow = '';
    el.style.color = '';
    el.style.font = '';
    el.style.padding = '';
    el.style.minWidth = '';
    el.style.maxWidth = '';
    el.style.backdropFilter = '';
    el.style.webkitBackdropFilter = '';
    el.style.pointerEvents = 'none';
    // 绝对定位叠在宿主原点：堆叠间距只由 Motion y 负责，避免 flex 流 + transform 双倍间距
    el.style.position = 'absolute';
    el.style.top = '0';
    el.style.right = '0';
    el.style.left = 'auto';
    el.style.bottom = 'auto';
    el.style.willChange = 'transform, opacity';
}
function toast(message, opts = {}) {
    const text = String(message ?? '');
    if (!text) return;
    const durationMs = Math.max(800, Number(opts.duration ?? opts.timeout ?? 2600) || 2600);
    const host = ensureAppToastHost();
    const edge = window.matchMedia?.('(max-width: 760px) and (hover: none) and (pointer: coarse)')?.matches
        ? 'bottom'
        : 'top';
    ensureToastMotion().then((Motion) => {
        // gap=8 与演示页一致；创建后立刻绝对定位 + 中性样式，避免 flex 双倍间距与 kind 变色闪烁
        const pushed = Motion.toastPush(host, {
            text,
            kind: 'info',
            duration: durationMs / 1000,
            edge,
            gap: 8,
        });
        styleAppToastNode(pushed?.el);
        const reflow = () => {
            try {
                const stack = Motion._toastStacks?.get?.(host);
                if (!stack?.items?.length) return;
                let offset = 0;
                const gap = stack.gap || 8;
                stack.items.forEach((it) => {
                    const h = it.el?.offsetHeight || 44;
                    const y = edge === 'bottom' ? -offset : offset;
                    it.y = y;
                    Motion.to(it.el, { y }, { preset: 'snappy' });
                    offset += h + gap;
                });
            } catch { /* ignore */ }
        };
        requestAnimationFrame(reflow);
        return Promise.resolve(pushed).then((handle) => {
            styleAppToastNode(handle?.el);
            reflow();
            return handle;
        });
    }).catch((err) => {
        console.warn('[toast] motion required, toast skipped:', err?.message || err);
    });
}
window.addEventListener('error', (event) => {
    console.error('[app-runtime]', event.error || event.message);
    if (document.readyState === 'complete') toast(t('前端错误：{error}', { error: event.message || t('未知错误') }));
});
window.addEventListener('unhandledrejection', (event) => {
    console.error('[app-runtime]', event.reason);
    if (document.readyState === 'complete') toast(t('前端异步错误：{error}', { error: event.reason?.message || event.reason || t('未知错误') }));
});
function terminalFrameById(tabId = '') {
    const id = String(tabId || '').trim();
    return id ? document.querySelector(`#terminalWorkspace iframe.terminal-frame[data-frame="${CSS.escape(id)}"]`) : null;
}
function terminalPageForTab(tabId = '') {
    return String(terminalTabs.find((t) => t.id === tabId)?.page || 'terminal').toLowerCase();
}
function isRemoteDesktopPage(page = '') { return page === 'rdp' || page === 'novnc'; }
function postToTerminalTab(tabId = '', message = {}) {
    const frame = terminalFrameById(tabId);
    if (!frame?.contentWindow) return false;
    frame.contentWindow.postMessage({ source: 'zephyr-app', ...message }, '*');
    return true;
}
function normalizeSharedClipboardFiles(files = []) {
    return Array.from(files || []).map((file) => {
        const name = String(file.name || (file.path ? String(file.path).split(/[\\/]/).pop() : '') || 'clipboard-file').slice(0, 255);
        const path = String(file.path || file.remotePath || name || '');
        return {
            id: String(file.id || ''),
            name,
            size: Number(file.size) || 0,
            type: file.type === 'd' ? 'd' : '-',
            path,
            mime: String(file.mime || ''),
            dataUrl: String(file.dataUrl || ''),
            transitUrl: String(file.transitUrl || ''),
            remotePath: String(file.remotePath || ''),
            source: String(file.source || ''),
        };
    }).filter((file) => file.name || file.path || file.dataUrl || file.transitUrl || file.remotePath);
}
function updateZephyrSharedClipboard(next = {}) {
    zephyrSharedClipboard = {
        type: String(next.type || ''),
        text: String(next.text || ''),
        files: normalizeSharedClipboardFiles(next.files || []),
        sourceTabId: String(next.sourceTabId || ''),
        sourcePage: String(next.sourcePage || terminalPageForTab(String(next.sourceTabId || '')) || ''),
        updatedAt: Date.now(),
    };
}
function fileClipboardNames(files = []) {
    return normalizeSharedClipboardFiles(files).map((f) => f.name || f.path.split('/').pop() || 'file').join('、');
}
function offerSharedClipboardToSshTargets(sourceTabId = '', files = []) {
    const names = fileClipboardNames(files);
    const targets = terminalTabs.filter((t) => !closingTerminalTabs.has(t.id) && t.id !== sourceTabId && t.page !== 'rdp' && t.page !== 'novnc' && t.iframe);
    if (!targets.length) {
        toast(names ? `已复制远程文件：${names}；打开 SSH 文件管理器后可粘贴` : t('已复制远程文件'));
        return;
    }
    targets.forEach((target) => postToTerminalTab(target.id, { type: 'shared-file-clipboard-available', files, sourceTabId, sourcePage: terminalPageForTab(sourceTabId) || 'rdp' }));
    toast(names ? `已复制 RDP 文件：${names}，可到 SSH 文件管理器粘贴` : t('已复制 RDP 文件，可到 SSH 文件管理器粘贴'));
}
function offerSharedClipboardToRdpTargets(sourceTabId = '', files = [], sourcePage = '') {
    const names = fileClipboardNames(files);
    const page = sourcePage || terminalPageForTab(sourceTabId) || 'rdp';
    const targets = terminalTabs.filter((t) => !closingTerminalTabs.has(t.id) && t.id !== sourceTabId && (t.page === 'rdp' || t.page === 'novnc') && t.iframe);
    if (!targets.length) {
        toast(names ? `已复制文件：${names}；打开 RDP 后可粘贴` : t('已复制文件'));
        return;
    }
    targets.forEach((target) => postToTerminalTab(target.id, {
        type: 'shared-file-clipboard-available',
        files,
        sourceTabId,
        sourcePage: page,
    }));
    toast(names ? `已复制文件：${names}，可到 RDP 远程桌面粘贴` : t('已复制文件，可到 RDP 粘贴'));
}
function handleSharedClipboardMessage(data = {}) {
    const sourceTabId = String(data.tabId || '');
    // ── Text clipboard ──
    if (data.type === 'shared-clipboard-text') {
        const text = String(data.text || '');
        if (!text) return true;
        updateZephyrSharedClipboard({ type: 'text', text, sourceTabId, sourcePage: terminalPageForTab(sourceTabId) });
        terminalTabs.filter((t) => t.id !== sourceTabId && t.iframe).forEach((target) => {
            const page = terminalPageForTab(target.id);
            if (isRemoteDesktopPage(page)) postToTerminalTab(target.id, { type: 'shared-clipboard-text', text, sourceTabId });
        });
        return true;
    }
    // ── File clipboard from RDP (local paste/drop files → forward to SSH) ──
    if (data.type === 'shared-file-clipboard') {
        const files = normalizeSharedClipboardFiles(data.files || []);
        if (!files.length) return true;
        updateZephyrSharedClipboard({ type: 'files', files, sourceTabId, sourcePage: terminalPageForTab(sourceTabId) });
        const page = terminalPageForTab(sourceTabId);
        if (isRemoteDesktopPage(page)) {
            // RDP source: offer to SSH tabs and other RDP tabs.
            offerSharedClipboardToSshTargets(sourceTabId, files);
            offerSharedClipboardToRdpTargets(sourceTabId, files, page);
        } else {
            // SSH / terminal source: offer to RDP tabs.
            offerSharedClipboardToRdpTargets(sourceTabId, files, page || 'terminal');
        }
        return true;
    }
    // ── Request clipboard from parent (SSH/RDP startup) ──
    if (data.type === 'request-shared-file-clipboard') {
        if (zephyrSharedClipboard.type === 'files' && zephyrSharedClipboard.files.length) {
            postToTerminalTab(sourceTabId, {
                type: 'shared-file-clipboard-available',
                files: zephyrSharedClipboard.files,
                sourceTabId: zephyrSharedClipboard.sourceTabId,
                sourcePage: zephyrSharedClipboard.sourcePage || '',
            });
            return true;
        }
        return true;
    }
    // ── Target consumes clipboard (SSH↔RDP / RDP↔RDP) ──
    if (data.type === 'shared-file-clipboard-consume') {
        const files = normalizeSharedClipboardFiles(data.files || zephyrSharedClipboard.files || []);
        if (!files.length) return true;
        const sourceTabIdForFiles = String(data.sourceTabId || zephyrSharedClipboard.sourceTabId || '');
        // Consumer is the tab that asked to paste (message origin).
        const consumerFrame = terminalFrameById(sourceTabId);
        // Already-hydrated bytes: forward immediately.
        if (files.every((f) => f.transitUrl || f.dataUrl || f.remotePath) && consumerFrame?.contentWindow) {
            consumerFrame.contentWindow.postMessage({
                source: 'zephyr-app',
                type: 'shared-file-clipboard-data',
                requestId: '',
                files,
                sourceTabId: sourceTabIdForFiles,
            }, '*');
            return true;
        }
        // Ask source tab to materialize bytes, then relay to consumer.
        // RDP source → cliprdr download + transit upload.
        // SSH source → sftp clipboard upload.
        const sourceFrame = terminalFrameById(sourceTabIdForFiles);
        if (sourceFrame?.contentWindow && consumerFrame?.contentWindow) {
            const requestId = `shared-file-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
            const relay = (event) => {
                if (event.source !== sourceFrame.contentWindow || event.data?.source !== 'zephyr-terminal' || event.data?.type !== 'shared-file-clipboard-data' || event.data?.requestId !== requestId) return;
                window.removeEventListener('message', relay, true);
                consumerFrame.contentWindow.postMessage({
                    source: 'zephyr-app',
                    type: 'shared-file-clipboard-data',
                    requestId,
                    files: event.data.files || [],
                    error: event.data.error || '',
                    sourceTabId: sourceTabIdForFiles,
                }, '*');
            };
            window.addEventListener('message', relay, true);
            sourceFrame.contentWindow.postMessage({
                source: 'zephyr-app',
                type: 'shared-file-clipboard-read',
                requestId,
                files,
                sourceTabId: sourceTabIdForFiles,
            }, '*');
            window.setTimeout(() => window.removeEventListener('message', relay, true), 60000);
        }
        return true;
    }
    // ── SSH notifies file copy to parent (metadata only, actual data on server) ──
    if (data.type === 'shared-file-clipboard-remote') {
        const files = normalizeSharedClipboardFiles(data.files || []);
        if (!files.length) return true;
        updateZephyrSharedClipboard({ type: 'files', files, sourceTabId, sourcePage: 'terminal' });
        offerSharedClipboardToRdpTargets(sourceTabId, files, 'terminal');
        return true;
    }
    return false;
}
const systemThemeQuery = matchMedia('(prefers-color-scheme: dark)');
function getSystemTheme() { return systemThemeQuery.matches ? 'dark' : 'light'; }
function getAppearance() { return settings?.appearance || {}; }
function isSessionPersistenceEnabled() { return settings?.workspace?.sessionPersistence !== false; }
function isAutoThemeEnabled() { return getAppearance().autoThemeEnabled !== false; }
function getPreferredTheme() {
    const appearance = getAppearance();
    if (isAutoThemeEnabled() || appearance.theme === 'auto') return getSystemTheme();
    if (appearance.theme === 'light' || appearance.theme === 'dark') return appearance.theme;
    const saved = localStorage.getItem('zephyr-theme');
    return saved === 'light' || saved === 'dark' ? saved : getSystemTheme();
}
function postTerminalKeyboardFreeze(frozen, reason = 'keyboard-freeze', { settleMs = 900, tabId = activeTerminalTab } = {}) {
    const frames = tabId
        ? $$(`#terminalWorkspace iframe.terminal-frame[data-frame="${CSS.escape(tabId)}"]`)
        : $$('#terminalWorkspace iframe.terminal-frame');
    frames.forEach((frame) => frame.contentWindow?.postMessage({
        source: 'zephyr-app',
        type: 'keyboard-freeze',
        frozen: !!frozen,
        reason,
        settleMs,
    }, '*'));
}
function postTerminalLayoutStabilize(reason = 'layout-stabilize', { focus = false, tabId = activeTerminalTab } = {}) {
    const workspace = $('#terminalWorkspace');
    const frames = tabId
        ? $$(`#terminalWorkspace iframe.terminal-frame[data-frame="${CSS.escape(tabId)}"]`)
        : $$('#terminalWorkspace iframe.terminal-frame');
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
    const workspaceRect = workspace?.getBoundingClientRect?.();
    console.info('[TerminalLayoutDiagnostics]', {
        event: 'parent:layout-stabilize',
        reason,
        focus,
        tabId,
        frames: frames.length,
        workspace: workspaceRect ? {
            width: Math.round(workspaceRect.width),
            height: Math.round(workspaceRect.height),
            top: Math.round(workspaceRect.top),
            left: Math.round(workspaceRect.left),
        } : null,
        fullscreen: !!fullscreenElement,
        customFullscreen: !!workspace?.classList.contains('custom-fullscreen'),
        keyboardOpen: !!workspace?.classList.contains('ssh-kb-open'),
        sshKbParentOpen,
        sshKbParentBaseline,
        visualViewport: window.visualViewport ? {
            width: Math.round(window.visualViewport.width || 0),
            height: Math.round(window.visualViewport.height || 0),
            offsetTop: Math.round(window.visualViewport.offsetTop || 0),
            offsetLeft: Math.round(window.visualViewport.offsetLeft || 0),
        } : null,
    });
    const keyboardInset = parseInt(document.documentElement.style.getPropertyValue('--app-keyboard-inset') || '0', 10);
    frames.forEach((frame) => frame.contentWindow?.postMessage({
        source: 'zephyr-app',
        type: 'layout-stabilize',
        reason,
        focus,
        keyboardOpen: !!workspace?.classList.contains('ssh-kb-open') || sshKbParentOpen,
        keyboardInset: Math.round(keyboardInset || 0),
        fullscreen: !!fullscreenElement,
        customFullscreen: !!workspace?.classList.contains('custom-fullscreen'),
        workspaceWidth: Math.round(workspaceRect?.width || 0),
        workspaceHeight: Math.round(workspaceRect?.height || 0),
    }, '*'));
}
function maybeApplyCompactKeyboardFromViewport(reason = 'compact-keyboard-viewport') {
    // Parent must NOT invent keyboard open from its own visualViewport.
    // Child facade is sole judge; parent only refreshes geometry if already open via child metrics.
    const workspace = $('#terminalWorkspace');
    if (!workspace || !isCompactTerminalWorkspace() || !document.body.classList.contains('terminal-mode') || !window.visualViewport) return false;
    if (!sshKbParentOpen && !workspace.classList.contains('ssh-kb-open') && !workspace.classList.contains('ssh-kb-open')) return false;
    const baseline = Math.max(sshKbParentBaseline || 0, window.innerHeight || 0, document.documentElement.clientHeight || 0);
    const viewportHeight = Math.round(window.visualViewport.height || 0);
    const offsetTop = Math.round(window.visualViewport.offsetTop || 0);
    const inset = Math.max(0, Math.round(baseline - viewportHeight - offsetTop));
    // Only update inset geometry while child-declared open; never flip open/closed here.
    if (!sshKbParentOpen) return false;
    applyTerminalWorkspaceKeyboard({
        keyboardOpen: true,
        keyboardInset: Math.max(inset, sshKbParentInset || 0),
        viewportHeight,
        layoutHeight: baseline,
        offsetTop,
        stableInput: true,
        liftMode: 'workspace',
        inputSource: 'terminal-ime',
        reason,
        intent: 'open',
        phase: 'open',
    });
    return true;
}
function scheduleCompactKeyboardViewportCheck(reason = 'compact-keyboard-check') {
    [0, 60, 140, 260, 420, 700].forEach((delay) => {
        window.setTimeout(() => maybeApplyCompactKeyboardFromViewport(`${reason}:phase-${delay}`), delay);
    });
}
function rememberCompactTerminalKeyboardBaseline(reason = 'compact-keyboard-baseline') {
    const workspace = $('#terminalWorkspace');
    if (!workspace || !isCompactTerminalWorkspace() || sshKbParentOpen || workspace.classList.contains('ssh-kb-open')) return;
    const viewport = window.visualViewport;
    const candidates = [
        window.innerHeight || 0,
        document.documentElement.clientHeight || 0,
        viewport ? (viewport.height || 0) + (viewport.offsetTop || 0) : 0,
        document.querySelector('.terminal-view.active')?.getBoundingClientRect?.().bottom || 0,
    ].map((value) => Math.round(Number(value) || 0)).filter((value) => value > 0);
    if (!candidates.length) return;
    const nextBaseline = Math.max(...candidates);
    if (nextBaseline > sshKbParentBaseline) sshKbParentBaseline = nextBaseline;
    console.info('[TerminalLayoutDiagnostics]', { event: 'parent:compact-keyboard-baseline', reason, sshKbParentBaseline });
}
function forceCompactTerminalWorkspaceFill(reason = 'compact-terminal-fill') {
    const workspace = $('#terminalWorkspace');
    if (!workspace || !isCompactTerminalWorkspace()) return;
    const view = document.querySelector('.terminal-view.active');
    if (!view) return;
    rememberCompactTerminalKeyboardBaseline(reason);
    const viewRect = view.getBoundingClientRect?.();
    const viewHeight = Math.round(viewRect?.height || 0);
    if (!sshKbParentOpen && viewHeight > 0) {
        workspace.style.flex = '1 1 auto';
        workspace.style.height = 'auto';
        workspace.style.maxHeight = 'none';
        workspace.style.minHeight = '0px';
        workspace.style.marginBottom = '0px';
        document.body.classList.remove('ssh-kb-lift');
        document.documentElement.style.setProperty('--app-keyboard-shift', '0px');
        document.documentElement.style.setProperty('--app-visual-vh', '100vh');
        document.documentElement.style.setProperty('--app-keyboard-top', '100vh');
    }
    workspace.querySelectorAll('.terminal-window:not(.minimized-keepalive)').forEach((win) => {
        win.style.minHeight = '0px';
        win.style.height = '';
        win.style.maxHeight = '100%';
        const body = win.querySelector('.terminal-window-body');
        if (body) {
            body.style.minHeight = '0px';
            body.style.height = '';
            body.style.maxHeight = '100%';
        }
        win.querySelectorAll('.terminal-frame, .terminal-placeholder').forEach((frame) => {
            frame.style.height = '100%';
            frame.style.maxHeight = '100%';
            frame.style.minHeight = '0px';
        });
    });
    console.info('[TerminalLayoutDiagnostics]', { event: 'parent:compact-fill', reason, viewHeight, sshKbParentOpen });
}
function scheduleTerminalLayoutStabilize(reason = 'layout-stabilize', options = {}) {
    window.clearTimeout(scheduleTerminalLayoutStabilize._timer);
    scheduleTerminalLayoutStabilize._timer = window.setTimeout(() => {
        [0, 80, 220, 520].forEach((delay, index) => {
            window.setTimeout(() => {
                forceCompactTerminalWorkspaceFill(`${reason}:phase-${index}`);
                if (sshKbParentOpen || $('#terminalWorkspace')?.classList.contains('ssh-kb-open')) maybeApplyCompactKeyboardFromViewport(`${reason}:phase-${index}`);
                postTerminalLayoutStabilize(`${reason}:phase-${index}`, options);
            }, delay);
        });
    }, 24);
}
function broadcastTerminalSettings(terminal = {}, workspace = settings?.workspace || {}) {
    $$('#terminalWorkspace iframe.terminal-frame').forEach((frame) => {
        try { frame.contentWindow?.postMessage({ source: 'zephyr-app', type: 'terminal-settings', terminal, workspace }, '*'); } catch (_) {}
    });
}
function broadcastThemeToTerminals(theme) {
    const appearance = getAppearance();
    $$('#terminalWorkspace iframe.terminal-frame').forEach((frame) => frame.contentWindow?.postMessage({ source: 'zephyr-app', type: 'theme-change', theme, appearance }, '*'));
    broadcastNotesEnabled();
    scheduleTerminalLayoutStabilize('theme-change', { focus: false, tabId: null });
}
function applyTheme(theme, { persist = false } = {}) {
    const root = document.documentElement;
    const previousTheme = root.getAttribute('data-theme') || getSystemTheme();
    const changed = previousTheme !== theme;
    root.classList.remove('theme-transitioning');
    void root.offsetWidth;
    root.classList.add('theme-transitioning');
    document.body?.classList.toggle('theme-ripple-active', changed);
    window.clearTimeout(applyTheme._timer);
    applyTheme._timer = window.setTimeout(() => {
        root.classList.remove('theme-transitioning');
        document.body?.classList.remove('theme-ripple-active');
    }, 460);
    root.setAttribute('data-theme', theme);
    applyZephyrColorScheme(getAppearance(), { theme, page: 'app' });
    setFavicon(pendingBrandIcon || DEFAULT_BRAND_ICON);
    SMARTBAR_TEXT_IMAGE_CACHE.clear();
    if (terminalTabs.length) renderTerminalSmartbar();
    if (persist || getAppearance().autoThemeEnabled === false) localStorage.setItem('zephyr-theme', theme);
    $('#appThemeToggle').textContent = theme === 'dark' ? '☀️' : '🌙';
    $('#settingsThemeToggle').textContent = theme === 'dark' ? '☀️' : '🌙';
    syncAppearanceSchemeControls();
    console.debug('[appearance-client]', 'theme transition applied', { previousTheme, theme, changed });
    broadcastThemeToTerminals(theme);
}
async function toggleTheme() {
    const nextTheme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    localStorage.setItem('zephyr-theme', nextTheme);
    settings = await savePersonalSettings({ appearance: { colorScheme: 'frost', theme: nextTheme, autoThemeEnabled: false } }).catch((err) => { toast(err.message); return settings; });
    $('#autoThemeEnabled').checked = false;
    applyTheme(nextTheme, { persist: true });
    console.debug('[appearance-client]', 'manual theme selected', { theme: nextTheme, autoThemeEnabled: false });
}
function escapeHtml(str) { return String(str || '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m])); }
/* `compact` drops One's "One" wordmark, for marks rendered small.
 *
 * The header mark is 24px, where the wordmark's own font-size resolves to
 * about 1.8px tall. That cannot render as letters; it renders as a smudge
 * beside crisp strokes, which is what makes the logo look blurry. The
 * settings preview is 52px and keeps the full mark. */
function iconHtml(icon = DEFAULT_BRAND_ICON, opts = {}) { return zephyrBrandIconHtml(icon, opts); }

function faviconHref(icon = DEFAULT_BRAND_ICON) { return zephyrFaviconHref(icon); }
function setFavicon(icon = DEFAULT_BRAND_ICON) {
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
    }
    link.href = faviconHref(icon);
}
function applyAppearance(appearance = getAppearance()) {
    /* Resolved rather than defaulted: the stored value is seeded with
     * 'Zephyr' on every fresh install, so `stored || default` never fired and
     * One showed the other product's name. See zephyrResolveBrandName(). */
    const brandName = zephyrResolveBrandName(appearance.brandName);
    const brandIcon = String(appearance.brandIcon || DEFAULT_BRAND_ICON).trim() || DEFAULT_BRAND_ICON;
    pendingBrandIcon = brandIcon;
    $('#brandName').textContent = brandName;
    $('#brandIcon').innerHTML = iconHtml(brandIcon, { compact: true });
    $('#brandNameInput').value = brandName;
    $('#brandIconPreview').innerHTML = iconHtml(brandIcon);
    $('#autoThemeEnabled').checked = appearance.autoThemeEnabled !== false;
    syncAppearanceSchemeControls(appearance);
    document.title = brandName;
    setFavicon(brandIcon);
    console.debug('[appearance-client]', 'appearance applied', { brandName, customIcon: brandIcon !== DEFAULT_BRAND_ICON, autoThemeEnabled: appearance.autoThemeEnabled !== false, theme: appearance.theme || 'auto' });
}
function readImageAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        if (!file) return resolve('');
        if (!/^image\/(png|jpeg|gif|webp|svg\+xml)$/i.test(file.type)) return reject(new Error(t('仅支持 PNG/JPEG/GIF/WebP/SVG 图标')));
        if (file.size > 512 * 1024) return reject(new Error(t('图标文件不能超过 512KB')));
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error(t('读取图标失败')));
        reader.readAsDataURL(file);
    });
}
function invertHexColorClient(value, fallback = '#1d1d1f') {
    const hex = normalizeHexInputClient(value, '');
    if (!hex) return fallback;
    const rgb = hexToRgbClient(hex);
    return rgbToHexClient({ r: 255 - rgb.r, g: 255 - rgb.g, b: 255 - rgb.b });
}
function normalizeTerminalFontColors(appearance = {}) {
    const colors = appearance.terminalFontColors || {};
    const legacy = appearance.terminalFontColor || '';
    const dark = normalizeHexInputClient(colors.dark || legacy || '', '');
    const lightRaw = normalizeHexInputClient(colors.light || '', '');
    return { dark, light: lightRaw || (dark ? invertHexColorClient(dark) : '') };
}
/** Solid terminal canvas color (independent of frost/lava/custom colorScheme). */
function normalizeTerminalSolidBgColors(appearance = {}) {
    const colors = appearance.terminalSolidBgColors || appearance.terminalBgColors || {};
    const dark = normalizeHexInputClient(colors.dark || '', '');
    const lightRaw = normalizeHexInputClient(colors.light || '', '');
    return { dark, light: lightRaw || (dark ? invertHexColorClient(dark) : '') };
}
/**
 * Selection highlight: background + foreground (DOM ::selection / --wterm-selection).
 * Works on every wterm theme (default/light/custom-*), not only colorScheme=custom.
 */
function normalizeTerminalSelectionColors(appearance = {}) {
    const sel = appearance.terminalSelection || {};
    const bgIn = sel.bg || {};
    const fgIn = sel.fg || {};
    const bgDark = normalizeHexInputClient(bgIn.dark || sel.bgDark || '', '');
    const bgLight = normalizeHexInputClient(bgIn.light || sel.bgLight || '', '') || bgDark;
    const fgDark = normalizeHexInputClient(fgIn.dark || sel.fgDark || '', '');
    const fgLight = normalizeHexInputClient(fgIn.light || sel.fgLight || '', '') || fgDark;
    return {
        bg: { dark: bgDark, light: bgLight },
        fg: { dark: fgDark, light: fgLight },
    };
}
function setColorPickerEnabled(input, enabled) {
    if (!input) return;
    input.disabled = !enabled;
    input.closest('[data-color-picker]')?.classList.toggle('disabled', !enabled);
}
function normalizeRdpDefaultQuality(value) {
    const mode = String(value || '').toLowerCase();
    return ['balanced', 'performance', 'quality'].includes(mode) ? mode : 'balanced';
}
async function saveAppearance(e) {
    e.preventDefault();
    const previous = getAppearance();
    const colorScheme = $('#colorSchemeSelect')?.value || previous.colorScheme || 'frost';
    const autoThemeEnabled = $('#autoThemeEnabled').checked;
    const explicitMode = $('#themeModeSelect')?.value || previous.theme || 'auto';
    const theme = autoThemeEnabled || explicitMode === 'auto' ? 'auto' : (explicitMode === 'light' || explicitMode === 'dark' ? explicitMode : (document.documentElement.getAttribute('data-theme') || getSystemTheme()));
    const terminalBgSource = $('#terminalBgSource')?.value || 'none';
    const terminalFontEnabled = !!$('#terminalFontColorEnabled')?.checked;
    const terminalFontDark = terminalFontEnabled ? normalizeHexInputClient($('#terminalFontColor')?.value || '', '') : '';
    const terminalFontLightRaw = terminalFontEnabled ? normalizeHexInputClient($('#terminalFontColorLight')?.value || '', '') : '';
    const terminalFontColors = terminalFontEnabled && terminalFontDark ? { dark: terminalFontDark, light: terminalFontLightRaw || invertHexColorClient(terminalFontDark) } : { dark: '', light: '' };
    const terminalSolidBgEnabled = !!$('#terminalSolidBgEnabled')?.checked;
    const solidDark = terminalSolidBgEnabled ? normalizeHexInputClient($('#terminalSolidBgDark')?.value || '', '') : '';
    const solidLightRaw = terminalSolidBgEnabled ? normalizeHexInputClient($('#terminalSolidBgLight')?.value || '', '') : '';
    const terminalSolidBgColors = terminalSolidBgEnabled && solidDark
        ? { dark: solidDark, light: solidLightRaw || invertHexColorClient(solidDark) }
        : { dark: '', light: '' };
    const terminalSelectionEnabled = !!$('#terminalSelectionEnabled')?.checked;
    const selBgDark = terminalSelectionEnabled ? normalizeHexInputClient($('#terminalSelectionBgDark')?.value || '', '') : '';
    const selBgLight = terminalSelectionEnabled ? normalizeHexInputClient($('#terminalSelectionBgLight')?.value || '', '') : '';
    const selFgDark = terminalSelectionEnabled ? normalizeHexInputClient($('#terminalSelectionFgDark')?.value || '', '') : '';
    const selFgLight = terminalSelectionEnabled ? normalizeHexInputClient($('#terminalSelectionFgLight')?.value || '', '') : '';
    const terminalSelection = terminalSelectionEnabled && (selBgDark || selFgDark)
        ? {
            bg: { dark: selBgDark, light: selBgLight || selBgDark },
            fg: { dark: selFgDark, light: selFgLight || selFgDark },
        }
        : { bg: { dark: '', light: '' }, fg: { dark: '', light: '' } };
    const appearance = {
        ...previous,
        brandName: $('#brandNameInput').value.trim() || defaultBrandName(),
        brandIcon: pendingBrandIcon || DEFAULT_BRAND_ICON,
        colorScheme,
        autoThemeEnabled,
        theme,
        customThemeMode: $('#customThemeMode')?.value || previous.customThemeMode || 'dark',
        customColors: readCustomThemeColors(),
        customCss: $('#customCssInput')?.value || '',
        customJs: $('#customJsInput')?.value || '',
        terminalBackground: {
            type: terminalBgSource,
            url: terminalBgSource === 'upload' ? ($('#terminalBgDataUrl')?.value || previous.terminalBackground?.url || '') : terminalBgSource === 'url' ? ($('#terminalBgUrl')?.value.trim() || '') : '',
            fit: $('#terminalBgFit')?.value || 'cover',
            opacity: Number($('#terminalBgOpacity')?.value || 0.35),
            blur: Number($('#terminalBgBlur')?.value || 0),
        },
        terminalFontColor: terminalFontColors.dark,
        terminalFontColors,
        terminalSolidBgColors,
        terminalSelection,
        rdp: {
            ...(previous.rdp || {}),
            defaultResolution: $('#rdpDefaultResolution')?.value || previous.rdp?.defaultResolution || '1920x1080',
            defaultQuality: normalizeRdpDefaultQuality($('#rdpDefaultQuality')?.value || previous.rdp?.defaultQuality || 'balanced'),
            defaultFps: Number($('#rdpDefaultFps')?.value || previous.rdp?.defaultFps || 30),
        },
    };
    if (myIdentity.role === 'admin') {
        settings = await savePlatformSettings('appearance', { appearance });
    } else {
        const { brandName, brandIcon, customJs, ...personalAppearance } = appearance;
        settings = await savePersonalSettings({ appearance: personalAppearance });
    }
    localStorage.removeItem('zephyr-theme');
    if (!autoThemeEnabled) localStorage.setItem('zephyr-theme', theme);
    applyAppearance(settings.appearance || appearance);
    applyTheme(getPreferredTheme());
    console.info('[appearance-client]', 'appearance saved', { brandName: appearance.brandName, customIcon: appearance.brandIcon !== DEFAULT_BRAND_ICON, autoThemeEnabled, theme });
    toast(t('个性化设置已保存'));
}
async function resetAppearance() {
    const appearance = { ...getAppearance(), brandName: defaultBrandName(), brandIcon: DEFAULT_BRAND_ICON, colorScheme: 'frost', customCss: '', customJs: '', terminalBackground: { type: 'none', url: '', fit: 'cover', opacity: 0.35, blur: 0 }, terminalFontColor: '', terminalFontColors: { dark: '', light: '' }, terminalSolidBgColors: { dark: '', light: '' }, terminalSelection: { bg: { dark: '', light: '' }, fg: { dark: '', light: '' } }, rdp: { defaultResolution: '1920x1080', defaultQuality: 'balanced', defaultFps: 60 } };
    if (myIdentity.role === 'admin') {
        settings = await savePlatformSettings('appearance', { appearance });
    } else {
        const { brandName, brandIcon, customJs, ...personalAppearance } = appearance;
        settings = await savePersonalSettings({ appearance: personalAppearance });
    }
    $('#brandIconFile').value = '';
    applyAppearance(settings.appearance || appearance);
    applyTheme(getPreferredTheme());
    console.info('[appearance-client]', 'brand reset to defaults');
    toast(t('名称和图标已重置'));
}

function syncAppearanceSchemeControls(appearance = getAppearance()) {
    const scheme = appearance.colorScheme || 'frost';
    const colorSelect = $('#colorSchemeSelect');
    if (colorSelect) colorSelect.value = scheme;
    const customPanel = $('#customThemePanel');
    if (customPanel) customPanel.classList.toggle('force-hidden', scheme !== 'custom');
    // Appearance hint text was removed from the settings form.
    if ($('#themeModeSelect')) $('#themeModeSelect').value = appearance.autoThemeEnabled !== false || appearance.theme === 'auto' ? 'auto' : (appearance.theme === 'light' ? 'light' : 'dark');
    if ($('#customThemeMode')) $('#customThemeMode').value = appearance.customThemeMode || 'dark';
    const colors = normalizeCustomThemeColors(appearance.customColors || {});
    Object.keys(DEFAULT_CUSTOM_THEME_COLORS).forEach((key) => {
        const input = document.querySelector(`[data-custom-color="${key}"]`);
        if (input) setColorPickerValue(input, colors[key]);
    });
    if ($('#customCssInput')) $('#customCssInput').value = appearance.customCss || '';
    if ($('#customJsInput')) $('#customJsInput').value = appearance.customJs || '';
    const bg = appearance.terminalBackground || {};
    const bgType = bg.type || 'none';
    if ($('#terminalBgSource')) $('#terminalBgSource').value = bgType;
    if ($('#terminalBgUrl')) {
        $('#terminalBgUrl').value = bgType === 'url' ? (bg.url || '') : '';
        $('#terminalBgUrl').disabled = bgType !== 'url';
    }
    if ($('#terminalBgFile')) $('#terminalBgFile').disabled = bgType !== 'upload';
    if ($('#terminalBgDataUrl')) $('#terminalBgDataUrl').value = bgType === 'upload' ? (bg.url || '') : '';
    if ($('#terminalBgFit')) $('#terminalBgFit').value = bg.fit || 'cover';
    if ($('#terminalBgOpacity')) $('#terminalBgOpacity').value = String(bg.opacity ?? 0.35);
    if ($('#terminalBgOpacityValue')) $('#terminalBgOpacityValue').textContent = `${Math.round(Number(bg.opacity ?? 0.35) * 100)}%`;
    if ($('#terminalBgBlur')) $('#terminalBgBlur').value = String(bg.blur ?? 0);
    if ($('#terminalBgBlurValue')) $('#terminalBgBlurValue').textContent = `${Math.round(Number(bg.blur ?? 0))}px`;
    const terminalColors = normalizeTerminalFontColors(appearance);
    const terminalFontEnabled = !!terminalColors.dark;
    if ($('#terminalFontColorEnabled')) $('#terminalFontColorEnabled').checked = terminalFontEnabled;
    if ($('#terminalFontColor')) {
        setColorPickerValue($('#terminalFontColor'), terminalColors.dark || '#f4f4f6');
        setColorPickerEnabled($('#terminalFontColor'), terminalFontEnabled);
    }
    if ($('#terminalFontColorLight')) {
        const lightRaw = appearance.terminalFontColors?.light || '';
        setColorPickerValue($('#terminalFontColorLight'), lightRaw || (terminalColors.dark ? invertHexColorClient(terminalColors.dark) : '#1d1d1f'));
        if (!lightRaw) $('#terminalFontColorLight').value = '';
        setColorPickerEnabled($('#terminalFontColorLight'), terminalFontEnabled);
    }
    // Solid terminal background (all color schemes)
    const solidBg = normalizeTerminalSolidBgColors(appearance);
    const solidEnabled = !!(solidBg.dark || solidBg.light);
    if ($('#terminalSolidBgEnabled')) $('#terminalSolidBgEnabled').checked = solidEnabled;
    if ($('#terminalSolidBgDark')) {
        $('#terminalSolidBgDark').value = solidBg.dark || '#0a0a0a';
        setColorPickerValue($('#terminalSolidBgDark'), solidBg.dark || '#0a0a0a');
        setColorPickerEnabled($('#terminalSolidBgDark'), solidEnabled);
    }
    if ($('#terminalSolidBgLight')) {
        $('#terminalSolidBgLight').value = solidBg.light || (solidBg.dark ? invertHexColorClient(solidBg.dark) : '');
        setColorPickerValue($('#terminalSolidBgLight'), $('#terminalSolidBgLight').value || '#f5f5f7');
        setColorPickerEnabled($('#terminalSolidBgLight'), solidEnabled);
    }
    // Selection bg + fg (all color schemes / all wterm themes)
    const sel = normalizeTerminalSelectionColors(appearance);
    const selEnabled = !!(sel.bg.dark || sel.bg.light || sel.fg.dark || sel.fg.light);
    if ($('#terminalSelectionEnabled')) $('#terminalSelectionEnabled').checked = selEnabled;
    const selFields = [
        ['terminalSelectionBgDark', sel.bg.dark || '#0a84ff'],
        ['terminalSelectionBgLight', sel.bg.light || sel.bg.dark || '#007aff'],
        ['terminalSelectionFgDark', sel.fg.dark || '#ffffff'],
        ['terminalSelectionFgLight', sel.fg.light || sel.fg.dark || '#ffffff'],
    ];
    selFields.forEach(([id, val]) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = val;
        setColorPickerValue(el, val);
        setColorPickerEnabled(el, selEnabled);
    });

    const rdp = appearance.rdp || {};
    if ($('#rdpDefaultResolution')) $('#rdpDefaultResolution').value = rdp.defaultResolution || '1920x1080';
    if ($('#rdpDefaultQuality')) $('#rdpDefaultQuality').value = normalizeRdpDefaultQuality(rdp.defaultQuality || 'balanced');
    if ($('#rdpDefaultFps')) $('#rdpDefaultFps').value = String(rdp.defaultFps || 60);
    if ($('#terminalBgPreview')) {
        const url = bg.type === 'url' ? ($('#terminalBgUrl')?.value.trim() || bg.url || '') : (bg.url || '');
        const hasBg = (bg.type === 'upload' || bg.type === 'url') && url;
        $('#terminalBgPreview').style.backgroundImage = hasBg ? `linear-gradient(rgba(0,0,0,.16), rgba(0,0,0,.16)), url("${String(url).replace(/"/g, '%22')}")` : '';
        $('#terminalBgPreview').textContent = hasBg ? t('已选择背景') : t('未设置背景');
    }
}
function readCustomThemeColors() {
    const out = {};
    Object.keys(DEFAULT_CUSTOM_THEME_COLORS).forEach((key) => { out[key] = document.querySelector(`[data-custom-color="${key}"]`)?.value || DEFAULT_CUSTOM_THEME_COLORS[key]; });
    return normalizeCustomThemeColors(out);
}

const COLOR_PICKER_PRESETS = ['#f5f5f7', '#ffffff', '#dedee3', '#1d1d1f', '#6e6e73', '#101114', '#1b1c20', '#303237', '#f7f3ef', '#e1d8cf', '#3f8f82', '#448e96', '#007aff', '#0a84ff', '#bf5a1f', '#ff453a', '#32d74b', '#ffd60a'];
let activeColorPickerInput = null;
let activeColorPickerHsv = { h: 210, s: 1, v: 1 };
function clampColorUnit(value) { return Math.max(0, Math.min(1, Number(value) || 0)); }
function normalizeHexInputClient(value, fallback = '#000000') {
    const text = String(value || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase();
    if (/^[0-9a-f]{6}$/i.test(text)) return `#${text.toLowerCase()}`;
    return fallback;
}
function hexToRgbClient(hex) {
    const safe = normalizeHexInputClient(hex, '#000000').slice(1);
    return { r: parseInt(safe.slice(0, 2), 16), g: parseInt(safe.slice(2, 4), 16), b: parseInt(safe.slice(4, 6), 16) };
}
function rgbToHexClient({ r, g, b }) {
    const part = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return `#${part(r)}${part(g)}${part(b)}`;
}
function rgbToHsvClient(rgb) {
    const r = (Number(rgb.r) || 0) / 255;
    const g = (Number(rgb.g) || 0) / 255;
    const b = (Number(rgb.b) || 0) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let h = 0;
    if (delta) {
        if (max === r) h = 60 * (((g - b) / delta) % 6);
        else if (max === g) h = 60 * (((b - r) / delta) + 2);
        else h = 60 * (((r - g) / delta) + 4);
    }
    if (h < 0) h += 360;
    return { h, s: max ? delta / max : 0, v: max };
}
function hexToHsvClient(hex) { return rgbToHsvClient(hexToRgbClient(hex)); }
function hsvToRgbClient(h, s, v) {
    const hue = (((Number(h) || 0) % 360) + 360) % 360;
    const sat = clampColorUnit(s);
    const val = clampColorUnit(v);
    const c = val * sat;
    const x = c * (1 - Math.abs((hue / 60) % 2 - 1));
    const m = val - c;
    let r = 0, g = 0, b = 0;
    if (hue < 60) [r, g, b] = [c, x, 0];
    else if (hue < 120) [r, g, b] = [x, c, 0];
    else if (hue < 180) [r, g, b] = [0, c, x];
    else if (hue < 240) [r, g, b] = [0, x, c];
    else if (hue < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}
function setColorPickerValue(input, value, { dispatch = false } = {}) {
    if (!input) return;
    const normalized = normalizeHexInputClient(value, input.value || '#000000');
    input.value = normalized;
    const picker = input.closest('[data-color-picker]');
    picker?.style.setProperty('--picker-color', normalized);
    picker?.querySelector('[data-color-swatch]')?.style.setProperty('--picker-color', normalized);
    if (dispatch) input.dispatchEvent(new Event('input', { bubbles: true }));
}
function syncColorPickerPanel(color) {
    const panel = document.getElementById('zephyrColorPickerPanel');
    if (!panel) return;
    const normalized = normalizeHexInputClient(color || activeColorPickerInput?.value, '#0a84ff');
    const next = hexToHsvClient(normalized);
    if (next.s === 0 && activeColorPickerHsv?.s > 0) next.h = activeColorPickerHsv.h;
    activeColorPickerHsv = next;
    panel.style.setProperty('--panel-hue', String(Math.round(next.h)));
    panel.style.setProperty('--panel-color', normalized);
    panel.style.setProperty('--panel-sv-x', `${Math.round(next.s * 1000) / 10}%`);
    panel.style.setProperty('--panel-sv-y', `${Math.round((1 - next.v) * 1000) / 10}%`);
    const hueInput = panel.querySelector('[data-color-hue]');
    if (hueInput && document.activeElement !== hueInput) hueInput.value = String(Math.round(next.h));
    const valueLabel = panel.querySelector('[data-color-value]');
    if (valueLabel) valueLabel.textContent = normalized;
}
function commitActiveColorPickerHsv() {
    if (!activeColorPickerInput) return;
    const hex = rgbToHexClient(hsvToRgbClient(activeColorPickerHsv.h, activeColorPickerHsv.s, activeColorPickerHsv.v));
    setColorPickerValue(activeColorPickerInput, hex, { dispatch: true });
    syncColorPickerPanel(hex);
}
function updateActiveColorFromSvPointer(event, surface) {
    if (!surface) return;
    const rect = surface.getBoundingClientRect();
    const s = clampColorUnit((event.clientX - rect.left) / Math.max(1, rect.width));
    const v = clampColorUnit(1 - ((event.clientY - rect.top) / Math.max(1, rect.height)));
    activeColorPickerHsv = { ...activeColorPickerHsv, s, v };
    commitActiveColorPickerHsv();
}
function ensureColorPickerPanel() {
    let panel = document.getElementById('zephyrColorPickerPanel');
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'zephyrColorPickerPanel';
    panel.className = 'zephyr-color-panel hidden';
    panel.innerHTML = `
        <div class="color-panel-current">
            <span class="color-panel-current-swatch" data-color-current aria-hidden="true"></span>
            <span class="color-panel-current-value" data-color-value>#0a84ff</span>
        </div>
        <div class="color-palette-sv" data-color-sv aria-label="${t('拖动选择饱和度和明度')}" role="slider"><span class="color-palette-cursor" aria-hidden="true"></span></div>
        <label class="color-hue-row"><span>${t('色相')}</span><input type="range" min="0" max="360" step="1" value="210" data-color-hue aria-label="${t('色相')}"></label>
        <div class="color-panel-hint">${t('拖动色盘/色相，或继续直接输入色号。')}</div>
        <div class="color-panel-grid" aria-label="${t('常用颜色')}">${COLOR_PICKER_PRESETS.map((color) => `<button type="button" data-color-preset="${color}" style="--preset-color:${color}" aria-label="${t('选择 {color}', { color })}"></button>`).join('')}</div>
        <div class="color-panel-actions"><button type="button" data-color-close>${t('关闭')}</button></div>`;
    document.body.appendChild(panel);
    panel.addEventListener('click', (event) => {
        const preset = event.target.closest?.('[data-color-preset]')?.dataset.colorPreset;
        if (preset && activeColorPickerInput) {
            setColorPickerValue(activeColorPickerInput, preset, { dispatch: true });
            syncColorPickerPanel(preset);
            return;
        }
        if (event.target.closest?.('[data-color-close]')) closeColorPickerPanel();
    });
    panel.addEventListener('input', (event) => {
        const hue = event.target.closest?.('[data-color-hue]');
        if (!hue || !activeColorPickerInput) return;
        activeColorPickerHsv = { ...activeColorPickerHsv, h: Math.max(0, Math.min(360, Number(hue.value) || 0)) };
        commitActiveColorPickerHsv();
    });
    panel.addEventListener('pointerdown', (event) => {
        const surface = event.target.closest?.('[data-color-sv]');
        if (!surface || !activeColorPickerInput) return;
        event.preventDefault();
        updateActiveColorFromSvPointer(event, surface);
        surface.setPointerCapture?.(event.pointerId);
        const onMove = (ev) => { ev.preventDefault(); updateActiveColorFromSvPointer(ev, surface); };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
        };
        window.addEventListener('pointermove', onMove, { passive: false });
        window.addEventListener('pointerup', onUp, { once: true });
        window.addEventListener('pointercancel', onUp, { once: true });
    });
    return panel;
}
function closeColorPickerPanel() {
    document.getElementById('zephyrColorPickerPanel')?.classList.add('hidden');
    activeColorPickerInput = null;
}
function openColorPickerPanel(input, anchor) {
    if (!input || input.disabled) return;
    activeColorPickerInput = input;
    const panel = ensureColorPickerPanel();
    panel.classList.remove('hidden');
    syncColorPickerPanel(input.value || '#000000');
    const rect = anchor.getBoundingClientRect();
    const margin = 10;
    const width = panel.offsetWidth || 288;
    const height = panel.offsetHeight || 340;
    const left = Math.min(window.innerWidth - width - margin, Math.max(margin, rect.left));
    const top = Math.min(window.innerHeight - height - margin, Math.max(margin, rect.bottom + 8));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
}
function setupColorPickers() {
    if (setupColorPickers._bound) return;
    setupColorPickers._bound = true;
    $$('[data-color-picker] .color-hex-input').forEach((input) => {
        setColorPickerValue(input, input.value || '#000000');
        input.addEventListener('input', () => {
            const text = String(input.value || '').trim();
            if (/^#?[0-9a-f]{6}$/i.test(text)) {
                setColorPickerValue(input, text);
                if (activeColorPickerInput === input) syncColorPickerPanel(input.value);
            }
        });
        input.addEventListener('blur', () => {
            setColorPickerValue(input, input.value || '#000000');
            if (activeColorPickerInput === input) syncColorPickerPanel(input.value);
        });
    });
    document.addEventListener('click', (event) => {
        const swatch = event.target.closest?.('[data-color-swatch]');
        if (swatch) {
            const input = swatch.closest('[data-color-picker]')?.querySelector('.color-hex-input');
            openColorPickerPanel(input, swatch);
            return;
        }
        if (activeColorPickerInput && event.target.closest?.('[data-color-picker]')?.querySelector('.color-hex-input') === activeColorPickerInput) return;
        if (!event.target.closest?.('#zephyrColorPickerPanel')) closeColorPickerPanel();
    });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeColorPickerPanel(); });
}
function readTerminalBackgroundAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        if (!file) return resolve('');
        if (!/^image\/(png|jpeg|jpg|gif|webp|svg\+xml|avif)$/i.test(file.type)) return reject(new Error(t('终端背景仅支持 PNG/JPEG/GIF/WebP/AVIF/SVG')));
        if (file.size > 12 * 1024 * 1024) return reject(new Error(t('终端背景图片不能超过 12MB')));
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error(t('读取终端背景失败')));
        reader.readAsDataURL(file);
    });
}
function setupAppearanceControls() {
    setupColorPickers();
    $('#colorSchemeSelect')?.addEventListener('change', () => {
        const appearance = { ...getAppearance(), colorScheme: $('#colorSchemeSelect').value, customThemeMode: $('#customThemeMode')?.value || 'dark', customColors: readCustomThemeColors(), customCss: $('#customCssInput')?.value || '', customJs: $('#customJsInput')?.value || '' };
        settings.appearance = appearance;
        applyTheme(getPreferredTheme());
        syncAppearanceSchemeControls(appearance);
    });
    $('#themeModeSelect')?.addEventListener('change', () => { const mode = $('#themeModeSelect').value; settings.appearance = { ...getAppearance(), theme: mode, autoThemeEnabled: mode === 'auto' }; if ($('#autoThemeEnabled')) $('#autoThemeEnabled').checked = mode === 'auto'; applyTheme(getPreferredTheme()); });
    $('#autoThemeEnabled')?.addEventListener('change', () => { const auto = $('#autoThemeEnabled').checked; const mode = auto ? 'auto' : ($('#themeModeSelect')?.value === 'light' ? 'light' : 'dark'); settings.appearance = { ...getAppearance(), theme: mode, autoThemeEnabled: auto }; if ($('#themeModeSelect')) $('#themeModeSelect').value = mode; applyTheme(getPreferredTheme()); });
    $('#customThemeMode')?.addEventListener('change', () => { settings.appearance = { ...getAppearance(), customThemeMode: $('#customThemeMode').value }; applyTheme(getPreferredTheme()); });
    $$('.custom-color-grid [data-custom-color]').forEach((input) => input.addEventListener('input', () => {
        settings.appearance = { ...getAppearance(), colorScheme: 'custom', customColors: readCustomThemeColors() };
        applyZephyrColorScheme(settings.appearance, { theme: getPreferredTheme(), page: 'app', executeCustomJs: false });
        setFavicon(pendingBrandIcon || DEFAULT_BRAND_ICON);
    }));
    $('#terminalBgSource')?.addEventListener('change', () => syncAppearanceSchemeControls({ ...getAppearance(), terminalBackground: { ...(getAppearance().terminalBackground || {}), type: $('#terminalBgSource').value } }));
    $('#terminalBgUrl')?.addEventListener('input', () => syncAppearanceSchemeControls({ ...getAppearance(), terminalBackground: { type: 'url', url: $('#terminalBgUrl').value.trim(), fit: $('#terminalBgFit')?.value || 'cover', opacity: Number($('#terminalBgOpacity')?.value || 0.35), blur: Number($('#terminalBgBlur')?.value || 0) } }));
    $('#terminalFontColorEnabled')?.addEventListener('change', () => {
        const enabled = $('#terminalFontColorEnabled').checked;
        setColorPickerEnabled($('#terminalFontColor'), enabled);
        setColorPickerEnabled($('#terminalFontColorLight'), enabled);
    });
    const bindTerminalColorEnable = (checkId, inputIds) => {
        $(`#${checkId}`)?.addEventListener('change', () => {
            const enabled = !!$(`#${checkId}`)?.checked;
            inputIds.forEach((id) => setColorPickerEnabled(document.getElementById(id), enabled));
        });
    };
    bindTerminalColorEnable('terminalSolidBgEnabled', ['terminalSolidBgDark', 'terminalSolidBgLight']);
    bindTerminalColorEnable('terminalSelectionEnabled', [
        'terminalSelectionBgDark', 'terminalSelectionBgLight',
        'terminalSelectionFgDark', 'terminalSelectionFgLight',
    ]);

    $('#terminalBgOpacity')?.addEventListener('input', () => { if ($('#terminalBgOpacityValue')) $('#terminalBgOpacityValue').textContent = `${Math.round(Number($('#terminalBgOpacity').value || 0.35) * 100)}%`; });
    $('#terminalBgBlur')?.addEventListener('input', () => { if ($('#terminalBgBlurValue')) $('#terminalBgBlurValue').textContent = `${Math.round(Number($('#terminalBgBlur').value || 0))}px`; });
    $('#terminalBgFile')?.addEventListener('change', async (e) => { try { const dataUrl = await readTerminalBackgroundAsDataUrl(e.target.files?.[0]); if (!dataUrl) return; $('#terminalBgDataUrl').value = dataUrl; $('#terminalBgSource').value = 'upload'; syncAppearanceSchemeControls({ ...getAppearance(), terminalBackground: { type: 'upload', url: dataUrl, fit: $('#terminalBgFit')?.value || 'cover', opacity: Number($('#terminalBgOpacity')?.value || 0.35), blur: Number($('#terminalBgBlur')?.value || 0) } }); toast(t('终端背景已载入，保存外观后生效')); } catch (err) { e.target.value = ''; toast(err.message); } });
}
function safeJsonParseClient(value, fallback = null) { try { return JSON.parse(String(value || '').trim()); } catch (_) { return fallback; } }
function escapeAttr(str) { return escapeHtml(str).replace(/'/g, '&#39;'); }
function safeHref(url = '') {
    const value = String(url || '').trim();
    if (/^(https?:|\/|#|blob:)/i.test(value) || /^data:image\//i.test(value)) return value;
    return '#';
}
function codeLangExt(lang = '') {
    const key = String(lang || '').toLowerCase().replace(/^language-/, '');
    const map = { js:'js', javascript:'js', ts:'ts', typescript:'ts', json:'json', yaml:'yaml', yml:'yaml', html:'html', htm:'html', xml:'xml', css:'css', sh:'sh', shell:'sh', bash:'sh', python:'py', py:'py', markdown:'md', md:'md', sql:'sql', text:'txt', plaintext:'txt' };
    return map[key] || (key ? key.replace(/[^a-z0-9_.-]/g, '').slice(0, 16) : 'txt');
}
function parseCodeFenceInfo(info = '') {
    const raw = String(info || '').trim();
    const parts = raw.split(/\s+/).filter(Boolean);
    let lang = '', filename = '';
    for (const part of parts) {
        const fm = /^(?:file(?:name)?|path)=['"]?(.+?)['"]?$/i.exec(part);
        if (fm) { filename = fm[1].split(/[\\/]/).pop(); continue; }
        if (!lang && /^[A-Za-z0-9_+.#-]+$/.test(part) && !part.includes('.')) { lang = part; continue; }
        if (!filename && /\.[A-Za-z0-9]{1,8}$/.test(part)) filename = part.split(/[\\/]/).pop();
    }
    if (!lang && filename && filename.includes('.')) lang = filename.split('.').pop();
    lang = String(lang || 'text').toLowerCase().replace(/^language-/, '');
    if (!filename) filename = `snippet.${codeLangExt(lang) || 'txt'}`;
    return { lang, filename };
}
function codeMimeType(filename = '', lang = '') {
    const ext = String(filename || '').split('.').pop().toLowerCase() || codeLangExt(lang);
    if (ext === 'html' || ext === 'htm') return 'text/html;charset=utf-8';
    if (ext === 'json') return 'application/json;charset=utf-8';
    if (ext === 'yaml' || ext === 'yml') return 'application/yaml;charset=utf-8';
    if (ext === 'css') return 'text/css;charset=utf-8';
    if (ext === 'js' || ext === 'mjs') return 'text/javascript;charset=utf-8';
    if (ext === 'md') return 'text/markdown;charset=utf-8';
    return 'text/plain;charset=utf-8';
}
function renderInlineMarkdown(text = '') {
    return renderInlineMarkdownCore(text);
}
function renderCodeBlockHtml(code = '', info = '', enhanced = false) {
    const meta = parseCodeFenceInfo(info);
    const cleanCode = String(code || '').replace(/\n$/, '');
    const escapedCode = escapeHtml(cleanCode);
    if (!enhanced) {
        const langClass = meta.lang ? ` class="language-${escapeAttr(meta.lang)}"` : '';
        return `<pre class="md-code"><code${langClass}>${escapedCode}</code></pre>`;
    }
    const id = `ai-code-${++aiCodeBlockSeq}`;
    aiCodeBlockStore.set(id, { code: cleanCode, lang: meta.lang, filename: meta.filename });
    const isHtml = meta.lang === 'html' || /\.html?$/i.test(meta.filename);
    return `<div class="ai-code-block" data-ai-code-id="${escapeAttr(id)}"><div class="ai-code-toolbar"><span class="ai-code-name"><i>⌘</i>${escapeHtml(meta.filename || meta.lang || 'code')}</span><div class="ai-code-actions">${isHtml ? `<button type="button" data-ai-code-preview="${escapeAttr(id)}">▶ ${t('预览')}</button>` : ''}<button type="button" data-ai-code-copy="${escapeAttr(id)}">⧉ ${t('复制')}</button><button type="button" data-ai-code-download="${escapeAttr(id)}">⇩ ${t('下载')}</button></div></div><pre><code class="language-${escapeAttr(meta.lang)}">${escapedCode}</code></pre></div>`;
}
function renderMarkdown(md, options = {}) {
    const enhanced = !!options.enhancedCode;
    return renderMarkdownCore(md, {
        renderCodeBlock: enhanced
            ? (code, info) => renderCodeBlockHtml(code, info, true)
            : undefined,
    });
}
// Expose for any non-module consumers / notes fallback.
try { window.renderMarkdown = renderMarkdown; } catch (_) {}
function splitCsv(value) { return String(value || '').split(/[\n,，]+/).map((x) => x.trim()).filter(Boolean); }
function fmtTime(ts) { return ts ? new Date(ts).toLocaleString() : t('从未连接'); }
/* Zephyr One's reveal gate lives on the OS authenticator, not on a password.
 *
 * In One the account password is a value the shell generated and the user never
 * chose, and there is no second factor, so prompting for it protects nothing
 * while training the user to type a meaningless secret. The switch in One's
 * Settings > Security decides instead: on -> Windows Hello / Touch ID / PIN,
 * off -> no challenge. See zephyr-one-security.js for the server half.
 *
 * `window.__zephyrOneUnlock` is installed by the One overlay script. Its absence
 * is what keeps browser Zephyr on the password/TOTP path below, unchanged. */
async function requestSensitiveSecret(actionText = t('查看已保存敏感信息')) {
    const oneUnlock = typeof window !== 'undefined' ? window.__zephyrOneUnlock : null;
    if (oneUnlock && typeof oneUnlock.acquire === 'function') {
        /* Returns '' when the switch is off: no challenge was asked for, so the
         * server sees an empty secret and its own One branch accepts it. Throws
         * on cancel/failure, which the existing catch in every caller reports. */
        return oneUnlock.acquire(actionText);
    }

    const usingTotp = !!securityStatus.user?.totpEnabled;
    const message = usingTotp
        ? `${actionText}\n请输入 6 位 TOTP 动态验证码：`
        : `${actionText}\n请输入当前登录密码：`;
    const secret = prompt(message);
    if (secret === null) throw new Error(t('已取消验证'));
    if (!String(secret).trim()) throw new Error(usingTotp ? t('请输入动态验证码') : t('请输入当前登录密码'));
    console.debug('[secret-open]', 'sensitive reveal requested', { actionText, authType: usingTotp ? 'totp' : 'password' });
    return secret;
}

/* WebDAV settings start. Kept as one block so its request contract can be
 * exercised with a mocked fetch without booting the full application shell. */
const WEB_DAV_API_BASE = '/api/webdav-sync';
const webDavUiState = {
    config: null,
    controller: null,
    operation: '',
    retry: null,
    statusKey: '正在读取 WebDAV 设置',
    statusTone: 'busy',
    remoteStatusKey: '尚未验证',
    errorKey: '',
    retryLabelKey: '重试上次操作',
    credentialOriginChanged: false,
    savedCredentialOrigin: '',
    baseUrlOrigin: '',
    credentialInputOrigin: '',
    hasSavedCredentialProjection: false,
};

function makeWebDavRequestError(code, status = 0, retryable = false, { confirmedBeforeSideEffect = false } = {}) {
    const error = new Error('WebDAV request failed.');
    error.code = String(code || 'webdav_backup_failed');
    error.status = Number(status) || 0;
    error.retryable = retryable === true;
    // A browser abort cannot establish whether the remote side effect happened.
    error.confirmedBeforeSideEffect = confirmedBeforeSideEffect === true;
    return error;
}

async function requestWebDav(path, { method = 'GET', body, signal, fetchImpl = fetch } = {}) {
    let response;
    try {
        response = await fetchImpl(`${WEB_DAV_API_BASE}${path}`, {
            method,
            credentials: 'same-origin',
            headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal,
        });
    } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') {
            throw makeWebDavRequestError('webdav_cancelled');
        }
        throw makeWebDavRequestError('webdav_network_error', 0, true);
    }

    const text = await response.text().catch(() => '');
    let payload = {};
    if (text) {
        try { payload = JSON.parse(text); } catch { payload = {}; }
    }
    if (!response.ok) {
        const publicError = payload && typeof payload.error === 'object' ? payload.error : {};
        throw makeWebDavRequestError(publicError.code, response.status, publicError.retryable, {
            confirmedBeforeSideEffect: publicError.confirmedBeforeSideEffect === true,
        });
    }
    return payload && typeof payload === 'object' ? payload : {};
}

function webDavErrorKey(error) {
    const code = String(error?.code || '');
    if (code === 'webdav_cancelled' && error?.confirmedBeforeSideEffect === true) return '已确认 WebDAV 操作在更改数据前取消。';
    const byCode = {
        sensitive_verification_failed: '敏感验证失败，未执行 WebDAV 操作。',
        one_unlock_required: '请先完成系统解锁验证。',
        webdav_cancelled: '已停止等待 WebDAV 操作；操作可能已完成，请刷新状态。',
        webdav_sync_unknown: 'WebDAV 同步结果未知；远端可能已更新，请刷新状态。',
        webdav_network_error: '无法连接到 Zephyr 服务，请检查当前网络后重试。',
        webdav_not_configured: '请先保存 WebDAV 设置。',
        webdav_disabled: '请先启用并保存 WebDAV 备份。',
        webdav_invalid_config: 'WebDAV 设置无效，请检查地址、远程目录和凭据。',
        webdav_insecure_url: 'WebDAV 地址必须使用 HTTPS。',
        webdav_ssrf_blocked: '此 WebDAV 主机不在允许的网络范围内。',
        webdav_dns_failed: '无法解析 WebDAV 主机，请检查地址。',
        webdav_timeout: 'WebDAV 服务器响应超时，请稍后重试。',
        webdav_unavailable: 'WebDAV 服务当前不可用，请检查服务配置后重试。',
        webdav_auth_failed: 'WebDAV 用户名或密码不正确。',
        webdav_forbidden: 'WebDAV 服务器拒绝了此操作。',
        webdav_not_found: 'WebDAV 远程目录不存在或无法访问。',
        webdav_conflict: '远程备份已被修改，为避免覆盖，当前备份已停止。',
        webdav_protocol_error: 'WebDAV 服务器返回了不兼容的响应。',
        webdav_response_too_large: 'WebDAV 响应超过安全大小限制。',
        webdav_backup_too_large: '备份超过允许的大小限制。',
        webdav_sync_in_progress: '已有 WebDAV 操作正在进行，请稍后重试。',
        webdav_rate_limited: 'WebDAV 操作过于频繁，请稍后重试。',
        webdav_config_changed: 'WebDAV 设置已变更，当前操作已安全停止。',
        webdav_backup_failed: 'WebDAV 操作失败，未覆盖远程备份。',
    };
    if (Number(error?.status) === 429) return 'WebDAV 操作过于频繁，请稍后重试。';
    return byCode[code] || 'WebDAV 操作失败，未覆盖远程备份。';
}

function webDavRemoteStatusKey(error) {
    const code = String(error?.code || '');
    if (code === 'webdav_cancelled' && error?.confirmedBeforeSideEffect === true) return '已确认未更改';
    if (code === 'webdav_sync_unknown') return '远端状态待确认';
    if (code === 'webdav_conflict') return '检测到远程冲突';
    if (code === 'webdav_rate_limited' || Number(error?.status) === 429) return '请求过于频繁';
    if (['webdav_network_error', 'webdav_dns_failed', 'webdav_timeout', 'webdav_unavailable'].includes(code)) return '当前不可达';
    if (code === 'webdav_cancelled') return '操作结果待确认';
    return '验证或备份失败';
}

function renderWebDavText() {
    const config = webDavUiState.config;
    const status = $('#webDavStatusText');
    const statusBand = $('#webDavStatusBand');
    const remoteStatus = $('#webDavRemoteStatus');
    const lastSuccess = $('#webDavLastSuccess');
    const badge = $('#webDavConfigBadge');
    const passwordState = $('#webDavPasswordState');
    const errorBox = $('#webDavError');
    const dangerActions = $('#webDavDangerActions');

    if (status) status.textContent = t(webDavUiState.statusKey);
    if (statusBand) statusBand.dataset.state = webDavUiState.statusTone;
    if (remoteStatus) remoteStatus.textContent = t(webDavUiState.remoteStatusKey);
    if (lastSuccess) lastSuccess.textContent = config?.lastSyncedAt ? formatDateTime(config.lastSyncedAt) : t('暂无');

    if (badge) {
        const badgeKey = config?.configured
            ? (config.enabled ? '已配置并启用' : '已配置但未启用')
            : '未配置';
        badge.textContent = t(badgeKey);
        badge.dataset.state = config?.configured ? 'configured' : (webDavUiState.errorKey ? 'error' : 'idle');
    }
    if (passwordState) {
        passwordState.textContent = t(webDavUiState.credentialOriginChanged
            ? 'WebDAV 地址来源已变更；已清除用户名和密码，请显式输入此地址的凭据。'
            : (config?.hasPassword
                ? '已保存 WebDAV 密码。仅在需要更改时输入新密码。'
                : '尚未保存 WebDAV 密码。保存时请显式输入。'));
    }
    if (errorBox) {
        errorBox.textContent = webDavUiState.errorKey ? t(webDavUiState.errorKey) : '';
        errorBox.classList.toggle('force-hidden', !webDavUiState.errorKey);
    }
    const retryButton = $('#webDavRetryBtn');
    if (retryButton) retryButton.textContent = t(webDavUiState.retryLabelKey || '重试上次操作');
    dangerActions?.classList.toggle('force-hidden', !config?.configured);
    renderWebDavActionLabels();
}

function renderWebDavActionLabels() {
    const actions = [
        ['#webDavSaveBtn', 'save', '保存 WebDAV 设置', '正在保存 WebDAV 设置'],
        ['#webDavTestBtn', 'test', '测试连接', '正在验证 WebDAV 连接'],
        ['#webDavSyncNowBtn', 'sync', '立即备份', '正在创建 WebDAV 备份'],
        ['#webDavDeleteBtn', 'delete', '删除 WebDAV 设置', '正在删除 WebDAV 设置'],
    ];
    actions.forEach(([selector, operation, idleKey, busyKey]) => {
        const button = $(selector);
        if (!button) return;
        const pending = webDavUiState.operation === operation;
        button.textContent = t(pending ? busyKey : idleKey);
        button.setAttribute('aria-busy', pending ? 'true' : 'false');
    });
}

function webDavCanonicalOrigin(value) {
    try {
        const url = new URL(String(value || '').trim());
        return url.protocol === 'https:' && url.origin !== 'null' ? url.origin : '';
    } catch { return ''; }
}

function clearWebDavCredentialProjection() {
    setVal('#webDavUsername', '');
    setVal('#webDavPassword', '');
    webDavUiState.credentialInputOrigin = '';
    if (webDavUiState.config) {
        webDavUiState.config.username = '';
        webDavUiState.config.hasPassword = false;
    }
}

function updateWebDavCredentialOriginHint() {
    const currentOrigin = webDavCanonicalOrigin($('#webDavBaseUrl')?.value);
    const previousOrigin = webDavUiState.baseUrlOrigin;
    const originChanged = webDavUiState.hasSavedCredentialProjection && currentOrigin !== previousOrigin;
    const differsFromSaved = webDavUiState.hasSavedCredentialProjection
        && (!currentOrigin || !webDavUiState.savedCredentialOrigin || currentOrigin !== webDavUiState.savedCredentialOrigin);
    if (originChanged) clearWebDavCredentialProjection();
    if (originChanged || differsFromSaved) webDavUiState.credentialOriginChanged = true;
    webDavUiState.baseUrlOrigin = currentOrigin;
    renderWebDavText();
}

function trackWebDavCredentialInputOrigin() {
    webDavUiState.credentialInputOrigin = webDavCanonicalOrigin($('#webDavBaseUrl')?.value);
}

function setWebDavStatus(statusKey, { tone = 'idle', remoteStatusKey } = {}) {
    webDavUiState.statusKey = statusKey;
    webDavUiState.statusTone = tone;
    if (remoteStatusKey) webDavUiState.remoteStatusKey = remoteStatusKey;
    renderWebDavText();
}

function updateWebDavActionAvailability() {
    const busy = !!webDavUiState.controller;
    const baseUrlReady = !!String($('#webDavBaseUrl')?.value || '').trim();
    const draftEnabled = !!$('#webDavEnabled')?.checked;
    const configuredAndEnabled = !!(webDavUiState.config?.configured && webDavUiState.config?.enabled && draftEnabled);
    const save = $('#webDavSaveBtn');
    const test = $('#webDavTestBtn');
    const sync = $('#webDavSyncNowBtn');
    const remove = $('#webDavDeleteBtn');
    const setAvailability = (button, disabled) => {
        if (!button) return;
        button.disabled = disabled;
        button.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    };
    setAvailability(save, busy);
    setAvailability(test, busy || !baseUrlReady);
    setAvailability(sync, busy || !configuredAndEnabled);
    setAvailability(remove, busy || !webDavUiState.config?.configured);
}

function setWebDavBusy(operation, busy) {
    const section = $('#webDavSettingsSection');
    const cancel = $('#webDavCancelBtn');
    section?.setAttribute('aria-busy', busy ? 'true' : 'false');
    document.querySelectorAll('[data-webdav-lock]').forEach((control) => { control.disabled = busy; });
    if (cancel) cancel.classList.toggle('force-hidden', !busy);
    if (cancel) cancel.disabled = !busy;
    if (cancel) cancel.setAttribute('aria-disabled', busy ? 'false' : 'true');
    if (!busy) webDavUiState.operation = '';
    else webDavUiState.operation = operation;
    renderWebDavActionLabels();
    updateWebDavActionAvailability();
}

function populateWebDavForm(config = {}) {
    setChecked('#webDavEnabled', config.enabled === true);
    setVal('#webDavBaseUrl', config.baseUrl || '');
    setVal('#webDavUsername', config.username || '');
    setVal('#webDavRemotePath', config.remotePath || '');
    setVal('#webDavPassword', '');
    const savedOrigin = webDavCanonicalOrigin(config.baseUrl);
    webDavUiState.savedCredentialOrigin = savedOrigin;
    webDavUiState.baseUrlOrigin = savedOrigin;
    webDavUiState.credentialInputOrigin = savedOrigin;
    webDavUiState.hasSavedCredentialProjection = Boolean(config.baseUrl || config.username || config.hasPassword);
    webDavUiState.credentialOriginChanged = false;
}

function collectWebDavDraft({ includeEnabled = true } = {}) {
    const baseUrl = String($('#webDavBaseUrl')?.value || '').trim();
    const currentOrigin = webDavCanonicalOrigin(baseUrl);
    const canSubmitCredentials = Boolean(currentOrigin)
        && (!webDavUiState.credentialOriginChanged || webDavUiState.credentialInputOrigin === currentOrigin);
    const draft = {
        baseUrl,
        remotePath: String($('#webDavRemotePath')?.value || '').trim(),
    };
    if (includeEnabled) draft.enabled = !!$('#webDavEnabled')?.checked;
    if (canSubmitCredentials) draft.username = String($('#webDavUsername')?.value || '');
    const password = String($('#webDavPassword')?.value || '');
    if (canSubmitCredentials && password) draft.password = password;
    return draft;
}

function validateWebDavForm() {
    const form = $('#webDavSettingsForm');
    const input = $('#webDavBaseUrl');
    if (!form || !input) return false;
    input.setCustomValidity('');
    try {
        if (new URL(String(input.value || '').trim()).protocol !== 'https:') {
            input.setCustomValidity(t('WebDAV 地址必须使用 HTTPS。'));
        }
    } catch {
        input.setCustomValidity(t('请输入有效的 WebDAV HTTPS 地址。'));
    }
    return form.reportValidity();
}

async function requestWebDavVerification(actionKey) {
    try {
        return await requestSensitiveSecret(t(actionKey));
    } catch (error) {
        const code = String(error?.code || '');
        throw makeWebDavRequestError(code === 'one_unlock_required' ? code : 'sensitive_verification_failed');
    }
}

function showWebDavError(error, { retry, focus = true } = {}) {
    const code = String(error?.code || '');
    const cancellationOutcomeUnknown = (code === 'webdav_cancelled' && error?.confirmedBeforeSideEffect !== true)
        || code === 'webdav_sync_unknown';
    webDavUiState.errorKey = webDavErrorKey(error);
    webDavUiState.retry = cancellationOutcomeUnknown ? () => loadWebDavSettings() : (typeof retry === 'function' ? retry : null);
    webDavUiState.retryLabelKey = cancellationOutcomeUnknown ? '刷新 WebDAV 状态' : '重试上次操作';
    setWebDavStatus(webDavUiState.errorKey, {
        tone: code === 'webdav_conflict' || cancellationOutcomeUnknown ? 'warning' : 'idle',
        remoteStatusKey: webDavRemoteStatusKey(error),
    });
    const retryButton = $('#webDavRetryBtn');
    retryButton?.classList.toggle('force-hidden', !webDavUiState.retry);
    if (focus) $('#webDavError')?.focus({ preventScroll: true });
}

async function runWebDavOperation(operation, busyStatusKey, work, retry, { focusErrors = true } = {}) {
    if (webDavUiState.controller) return { ok: false, busy: true };
    const controller = new AbortController();
    webDavUiState.controller = controller;
    webDavUiState.retry = null;
    webDavUiState.retryLabelKey = '重试上次操作';
    webDavUiState.errorKey = '';
    $('#webDavRetryBtn')?.classList.add('force-hidden');
    setWebDavBusy(operation, true);
    setWebDavStatus(busyStatusKey, { tone: 'busy' });
    try {
        return { ok: true, value: await work(controller.signal) };
    } catch (error) {
        showWebDavError(error, { retry, focus: focusErrors });
        return { ok: false, error };
    } finally {
        if (webDavUiState.controller === controller) webDavUiState.controller = null;
        setWebDavBusy(operation, false);
    }
}

async function loadWebDavSettings() {
    const retry = () => loadWebDavSettings();
    const outcome = await runWebDavOperation('load', '正在读取 WebDAV 设置', (signal) => (
        requestWebDav('/config', { signal })
    ), retry, { focusErrors: false });
    if (!outcome.ok) return;
    const config = outcome.value?.config || {};
    webDavUiState.config = config;
    webDavUiState.errorKey = '';
    webDavUiState.retry = null;
    populateWebDavForm(config);
    const previousError = config.lastErrorCode ? makeWebDavRequestError(config.lastErrorCode) : null;
    if (previousError) {
        setWebDavStatus('webDav.status.loadedWithBackupFailure', {
            tone: 'warning',
            remoteStatusKey: webDavRemoteStatusKey(previousError),
        });
    } else {
        setWebDavStatus(config.configured ? 'WebDAV 设置已配置。' : '尚未配置 WebDAV 备份。', {
            tone: config.lastSyncedAt ? 'success' : 'idle',
            remoteStatusKey: config.lastSyncedAt ? '最近备份成功' : '尚未验证',
        });
    }
    renderWebDavText();
    updateWebDavActionAvailability();
}

async function saveWebDavSettings() {
    if (!validateWebDavForm()) return;
    const draft = collectWebDavDraft();
    const retry = () => saveWebDavSettings();
    const outcome = await runWebDavOperation('save', '正在保存 WebDAV 设置', async (signal) => {
        const secret = await requestWebDavVerification('保存 WebDAV 设置');
        return requestWebDav('/config', { method: 'PATCH', body: { ...draft, secret }, signal });
    }, retry);
    if (!outcome.ok) return;
    webDavUiState.config = outcome.value?.config || {};
    webDavUiState.errorKey = '';
    webDavUiState.retry = null;
    populateWebDavForm(webDavUiState.config);
    setWebDavStatus('webDav.status.settingsSaved', { tone: 'success' });
    $('#webDavStatusBand')?.focus({ preventScroll: true });
    updateWebDavActionAvailability();
}

async function testWebDavConnection() {
    if (!validateWebDavForm()) return;
    const draft = collectWebDavDraft({ includeEnabled: false });
    const retry = () => testWebDavConnection();
    const outcome = await runWebDavOperation('test', '正在验证 WebDAV 连接', async (signal) => {
        const secret = await requestWebDavVerification('验证 WebDAV 连接');
        return requestWebDav('/test', { method: 'POST', body: { ...draft, secret }, signal });
    }, retry);
    if (!outcome.ok) return;
    const result = outcome.value?.result || {};
    webDavUiState.errorKey = '';
    webDavUiState.retry = null;
    setWebDavStatus('webDav.status.connectionVerified', {
        tone: 'success',
        remoteStatusKey: result.namespaceExists === false ? 'webDav.remote.directoryCreatedOnBackup' : 'webDav.remote.available',
    });
    $('#webDavStatusBand')?.focus({ preventScroll: true });
}

async function syncWebDavNow() {
    const retry = () => syncWebDavNow();
    const outcome = await runWebDavOperation('sync', '正在创建 WebDAV 备份', async (signal) => {
        const secret = await requestWebDavVerification('立即创建 WebDAV 备份');
        return requestWebDav('/sync-now', { method: 'POST', body: { secret }, signal });
    }, retry);
    if (!outcome.ok) return;
    const result = outcome.value?.result || {};
    webDavUiState.config = {
        ...(webDavUiState.config || {}),
        configured: true,
        lastSyncedAt: Number(result.syncedAt) || Date.now(),
        lastErrorCode: null,
    };
    webDavUiState.errorKey = '';
    webDavUiState.retry = null;
    setWebDavStatus('webDav.status.backupComplete', { tone: 'success', remoteStatusKey: 'webDav.remote.latestBackupSucceeded' });
    $('#webDavStatusBand')?.focus({ preventScroll: true });
}

async function deleteWebDavSettings() {
    if (!webDavUiState.config?.configured) return;
    if (!confirm(t('删除 WebDAV 设置会移除 Zephyr 保存的凭据，但不会删除远程备份文件。继续？'))) return;
    const retry = () => deleteWebDavSettings();
    const outcome = await runWebDavOperation('delete', '正在删除 WebDAV 设置', async (signal) => {
        const secret = await requestWebDavVerification('删除 WebDAV 设置');
        return requestWebDav('/config', { method: 'DELETE', body: { secret }, signal });
    }, retry);
    if (!outcome.ok) return;
    webDavUiState.config = { configured: false, enabled: false, hasPassword: false, lastSyncedAt: null, lastErrorCode: null };
    webDavUiState.credentialOriginChanged = false;
    webDavUiState.errorKey = '';
    webDavUiState.retry = null;
    populateWebDavForm(webDavUiState.config);
    setWebDavStatus(outcome.value?.deleted === true ? 'WebDAV 设置已删除。' : '尚未配置 WebDAV 备份。', {
        tone: outcome.value?.deleted === true ? 'success' : 'idle',
        remoteStatusKey: '尚未验证',
    });
    $('#webDavStatusBand')?.focus({ preventScroll: true });
    updateWebDavActionAvailability();
}

function cancelWebDavOperation() {
    const controller = webDavUiState.controller;
    if (!controller || controller.signal.aborted) return;
    setWebDavStatus('webDav.status.cancellationRequested', { tone: 'busy', remoteStatusKey: 'webDav.remote.resultPendingConfirmation' });
    controller.abort();
}

function retryWebDavOperation() {
    if (webDavUiState.controller || typeof webDavUiState.retry !== 'function') return;
    const retry = webDavUiState.retry;
    webDavUiState.retry = null;
    $('#webDavRetryBtn')?.classList.add('force-hidden');
    retry();
}
/* WebDAV settings end. */

function syncTerminalSmartbarTop() {
    const nav = $('.main-nav');
    const smartbar = $('#sessionTabs');
    if (!nav || !smartbar) return;
    const smartbarTop = `${Math.round(nav.getBoundingClientRect().bottom)}px`;
    smartbar.style.setProperty('--smartbar-top', smartbarTop);
    document.documentElement.style.setProperty('--smartbar-top', smartbarTop);
}
function syncTerminalShelfLineState() {
    const nav = $('.main-nav');
    const smartbar = $('#sessionTabs');
    if (!nav || !smartbar) return;
    const dockInteractive = terminalSmartbarOpen || terminalSmartbarClosing;
    const terminalActive = document.body.classList.contains('terminal-mode');
    const shelfSettled = terminalActive;
    nav.classList.toggle('terminal-shelf-settled', shelfSettled);
    nav.classList.toggle('terminal-shelf-dock-open', terminalActive && dockInteractive);
    smartbar.classList.toggle('shelf-line-active', shelfSettled);
    smartbar.classList.toggle('dock-open', dockInteractive);
}
function scheduleTerminalSmartbarTopSync(reason = 'smartbar-top') {
    if (Array.isArray(scheduleTerminalSmartbarTopSync._timers)) scheduleTerminalSmartbarTopSync._timers.forEach((timer) => window.clearTimeout(timer));
    const run = () => requestAnimationFrame(() => { syncTerminalSmartbarTop(); syncTerminalShelfLineState(); });
    scheduleTerminalSmartbarTopSync._timers = [0, 32, 80, 140, 220, 340, 500, 680].map((delay) => window.setTimeout(run, delay));
    console.debug('[terminal-smartbar]', 'scheduled top sync', { reason });
}
function closeTerminalSmartbarForViewLeave() {
    window.clearTimeout(terminalSmartbarTimer);
    window.clearTimeout(setTerminalSmartbarOpen._closeTimer);
    terminalSmartbarOpen = false;
    terminalSmartbarClosing = false;
    terminalSmartbarPickerOpen = false;
    document.querySelectorAll('#terminalWorkspace .terminal-frame').forEach((frame) => frame.style.pointerEvents = '');
    const pickerLayer = document.getElementById('smartbarPickerLayer');
    if (pickerLayer) pickerLayer.innerHTML = '';
    const root = $('#sessionTabs');
    root?.classList.remove('open', 'closing', 'shelf-line-active', 'dock-open');
    $('.main-nav')?.classList.remove('terminal-shelf-settled', 'terminal-shelf-dock-open');
}
function applySwitchViewCore(name, { enteringAnimated = false } = {}) {
    const target = name === 'ai' ? 'dashboard' : name;
    currentAppView = target;
    rememberLastAppView(target);
    if (target !== 'notes') notesController?.leave?.().catch(() => {});
    $$('.nav-tab').forEach((b) => b.classList.toggle('active', b.dataset.view === target));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${target}`));
    const wasTerminal = document.body.classList.contains('terminal-mode');
    const enteringTerminal = target === 'terminal' && !wasTerminal;
    const leavingTerminal = target !== 'terminal' && wasTerminal;
    if (leavingTerminal) closeTerminalSmartbarForViewLeave();
    document.body.classList.toggle('terminal-mode', target === 'terminal');
    document.body.classList.toggle('terminal-mode-entering', enteringTerminal && !enteringAnimated);
    window.clearTimeout(switchView._navTimer);
    if (target === 'terminal') {
        renderTerminalSmartbar();
        // Immediate measure so content row sits under nav+shelf (no underlap).
        try {
            syncTerminalSmartbarTop();
            syncTerminalShelfLineState();
            const nav = document.querySelector('.main-nav');
            if (nav) {
                document.documentElement.style.setProperty('--terminal-nav-height', `${Math.round(nav.getBoundingClientRect().height)}px`);
            }
        } catch {}
        scheduleTerminalSmartbarTopSync(enteringTerminal ? 'switch-enter-terminal' : 'switch-terminal');
        switchView._navTimer = window.setTimeout(() => {
            document.body.classList.remove('terminal-mode-entering');
            syncTerminalSmartbarTop();
            syncTerminalShelfLineState();
            try {
                const nav = document.querySelector('.main-nav');
                if (nav) {
                    document.documentElement.style.setProperty('--terminal-nav-height', `${Math.round(nav.getBoundingClientRect().height)}px`);
                }
            } catch {}
        }, enteringAnimated ? 40 : 680);
        rememberCompactTerminalKeyboardBaseline('switch-view-terminal');
        scheduleTerminalLayoutStabilize('switch-view-terminal', { focus: true });
    } else {
        document.body.classList.remove('terminal-mode-entering');
        if (leavingTerminal) scheduleTerminalSmartbarTopSync('switch-leave-terminal');
    }
    if (target === 'notes') {
        notesController?.activate?.().catch((err) => toast(err.message || t('加载笔记失败')));
    }
    scheduleWorkspaceSave('view-change');
    return { target, wasTerminal, enteringTerminal, leavingTerminal };
}
function stableTerminalCardSourceRect(el) {
    if (!el?.isConnected) return null;
    const oldTransition = el.style.getPropertyValue('transition');
    const oldPriority = el.style.getPropertyPriority('transition');
    el.style.setProperty('transition', 'none', 'important');
    void el.offsetWidth;
    const r = el.getBoundingClientRect();
    if (oldTransition) el.style.setProperty('transition', oldTransition, oldPriority);
    else el.style.removeProperty('transition');
    return r.width > 2 && r.height > 2
        ? { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom }
        : null;
}
function terminalCardFlipNavBottom() {
    const nav = document.querySelector('.main-nav');
    if (!nav) return 0;
    const r = nav.getBoundingClientRect();
    return Math.max(0, Math.round(r.bottom));
}
function settleTerminalShelfForCardFlip() {
    const nav = document.querySelector('.main-nav');
    if (!nav) return 0;
    const oldTransition = nav.style.getPropertyValue('transition');
    const oldTransitionPriority = nav.style.getPropertyPriority('transition');
    const oldPaddingBottom = nav.style.getPropertyValue('padding-bottom');
    const oldPaddingPriority = nav.style.getPropertyPriority('padding-bottom');
    const rootStyle = getComputedStyle(document.documentElement);
    const openPadding = rootStyle.getPropertyValue('--terminal-shelf-open-padding').trim() || '27px';
    // The card owns the visible transition. Snap the shelf to its terminal
    // layout in the same task so the flip stage and live terminal share one box.
    nav.style.setProperty('transition', 'none', 'important');
    nav.style.setProperty('padding-bottom', openPadding, 'important');
    void nav.offsetWidth;
    const bottom = Math.max(0, Math.round(nav.getBoundingClientRect().bottom));
    document.documentElement.style.setProperty('--terminal-nav-height', `${Math.round(nav.getBoundingClientRect().height)}px`);
    if (oldPaddingBottom) nav.style.setProperty('padding-bottom', oldPaddingBottom, oldPaddingPriority);
    else nav.style.removeProperty('padding-bottom');
    if (oldTransition) nav.style.setProperty('transition', oldTransition, oldTransitionPriority);
    else nav.style.removeProperty('transition');
    return bottom;
}
function terminalCardSourceRadius(sourceEl) {
    const card = sourceEl?.classList?.contains?.('connection-card')
        ? sourceEl
        : (sourceEl?.closest?.('.connection-card') || sourceEl);
    if (!card?.isConnected) {
        const lg = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--radius-lg'));
        return Number.isFinite(lg) && lg > 0 ? lg : 16;
    }
    const raw = getComputedStyle(card).borderRadius || '';
    const m = String(raw).match(/([\d.]+)px/);
    if (m) return Math.max(4, parseFloat(m[1]));
    const lg = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--radius-lg'));
    return Number.isFinite(lg) && lg > 0 ? lg : 16;
}
function terminalCardFlipTargetRect(_origin) {
    const vw = window.innerWidth || document.documentElement.clientWidth || 360;
    const vh = window.innerHeight || document.documentElement.clientHeight || 640;
    // Measure the terminal shelf's final bottom while the dashboard is still
    // the visible view. This lets preparation happen without selecting an
    // empty terminal page before the actual card starts moving.
    const nav = document.querySelector('.main-nav');
    let navBottom = terminalCardFlipNavBottom();
    if (nav && !document.body.classList.contains('terminal-mode')) {
        const currentPadding = parseFloat(getComputedStyle(nav).paddingBottom) || 0;
        const openPadding = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--terminal-shelf-open-padding')) || 27;
        navBottom += Math.max(0, openPadding - currentPadding);
    }
    navBottom = Math.max(0, Math.round(navBottom));
    return {
        left: 0,
        top: navBottom,
        width: Math.max(200, vw),
        height: Math.max(200, vh - navBottom),
        topBound: navBottom,
        fillStage: true,
    };
}
function placeTerminalCardFlipSurface(surface, rect) {
    if (!surface || !rect) return;
    surface.style.left = `${rect.left}px`;
    surface.style.top = `${rect.top}px`;
    surface.style.width = `${rect.width}px`;
    surface.style.height = `${rect.height}px`;
    surface.style.right = 'auto';
    surface.style.bottom = 'auto';
    surface.style.inset = 'auto';
}
function placeTerminalCardFlipStage(stage, topBound) {
    if (!stage) return;
    // Stage starts at nav bottom: shelf line is drawn in nav::after above this.
    stage.style.top = `${Math.max(0, topBound)}px`;
    stage.style.left = '0';
    stage.style.right = '0';
    stage.style.bottom = '0';
    stage.style.width = 'auto';
    stage.style.height = 'auto';
}
function setCompensatedRadius(el, visualPx, sx, sy) {
    if (!el) return;
    const v = Math.max(0, Number(visualPx) || 0);
    const sxn = Math.max(0.001, Math.abs(sx || 1));
    const syn = Math.max(0.001, Math.abs(sy || 1));
    el.style.borderRadius = `${v / sxn}px / ${v / syn}px`;
}
function paintTerminalCardFlipFront(sourceEl) {
    const front = document.querySelector('[data-terminal-card-front]');
    if (!front) return;
    front.innerHTML = '';
    front.style.cssText = [
        'position:absolute',
        'inset:0',
        'border-radius:inherit',
        'overflow:hidden',
        'opacity:1',
        'backface-visibility:hidden',
        '-webkit-backface-visibility:hidden',
        'transform:rotateY(0deg)',
        'background:var(--surface)',
        'pointer-events:none',
    ].join(';');
    if (!sourceEl?.isConnected) {
        front.innerHTML = `<div class="terminal-card-flip-front-fallback connection-card"><h2>${t('连接')}</h2></div>`;
        return;
    }
    try {
        const card = sourceEl.classList?.contains('connection-card')
            ? sourceEl
            : (sourceEl.closest?.('.connection-card') || sourceEl);
        const clone = card.cloneNode(true);
        clone.removeAttribute('id');
        clone.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
        clone.classList.add('terminal-card-flip-card-clone');
        clone.style.cssText = [
            'margin:0',
            'width:100%',
            'height:100%',
            'max-width:none',
            'box-sizing:border-box',
            'pointer-events:none',
            'transform:none',
            'animation:none',
            'transition:none',
            'box-shadow:none',
        ].join(';');
        clone.querySelectorAll('button').forEach((btn) => {
            btn.disabled = true;
            btn.tabIndex = -1;
        });
        front.appendChild(clone);
    } catch {
        front.innerHTML = `<div class="terminal-card-flip-front-fallback connection-card"><h2>${t('连接')}</h2></div>`;
    }
}
function paintTerminalCardFlipBack(options = {}) {
    const back = document.querySelector('[data-terminal-card-back]');
    const liveWin = options.liveWindow || null;
    if (!back || !liveWin?.isConnected) return false;
    restoreCardFlipHostedWindow();
    back.innerHTML = '';
    terminalCardFlipMotion.hostedWindow = liveWin;
    terminalCardFlipMotion.hostedParent = liveWin.parentElement;
    terminalCardFlipMotion.hostedNext = liveWin.nextSibling;
    liveWin.dataset.cardFlipHosted = '1';
    Object.assign(liveWin.style, {
        width:'100%', height:'100%', margin:'0', maxWidth:'none', borderRadius:'inherit',
        overflow:'hidden', boxShadow:'none', opacity:'1', visibility:'visible', pointerEvents:'none',
        animation:'none', transition:'none', transform:'none', filter:'none',
    });
    back.appendChild(liveWin);
    return true;
}
function restoreCardFlipHostedWindow() {
    const win = terminalCardFlipMotion.hostedWindow;
    if (!win) return;
    const parent = terminalCardFlipMotion.hostedParent;
    const next = terminalCardFlipMotion.hostedNext;
    try {
        // Clear flip-only inline layout so workspace CSS takes over.
        ['width', 'height', 'margin', 'maxWidth', 'boxShadow', 'opacity', 'visibility',
            'pointerEvents', 'animation', 'transform', 'filter'].forEach((k) => {
            try { win.style[k] = ''; } catch {}
        });
        // Keep matched radius if set.
        if (win.dataset.cardFlipRadius) {
            win.style.borderRadius = `${win.dataset.cardFlipRadius}px`;
            win.style.overflow = 'hidden';
            win.style.animation = 'none';
            win.style.transition = 'none';
            win.style.transform = 'none';
            win.style.filter = 'none';
        } else {
            win.style.borderRadius = '';
            win.style.overflow = '';
        }
        delete win.dataset.cardFlipHosted;
        const targetParent = parent && parent.isConnected ? parent : $('#terminalWorkspace');
        const targetNext = targetParent === parent && next?.parentElement === parent ? next : null;
        if (targetParent) {
            // State-preserving DOM move keeps the live iframe browsing/rendering
            // context attached, avoiding a white compositor frame at handoff.
            if (typeof targetParent.moveBefore === 'function') targetParent.moveBefore(win, targetNext);
            else if (targetNext) targetParent.insertBefore(win, targetNext);
            else targetParent.appendChild(win);
        }
    } catch (err) {
        console.warn('[terminal-card-flip] restore hosted window failed', err);
    }
    terminalCardFlipMotion.hostedWindow = null;
    terminalCardFlipMotion.hostedParent = null;
    terminalCardFlipMotion.hostedNext = null;
}

function resetTerminalCardFlipSurface(Motion) {
    restoreCardFlipHostedWindow();

    const stage = $('#terminalCardFlipStage');
    const surface = $('#terminalCardFlipSurface');
    const rotor = document.querySelector('[data-terminal-card-rotor]');
    const scrim = $('#terminalCardFlipScrim');
    const front = document.querySelector('[data-terminal-card-front]');
    const back = document.querySelector('[data-terminal-card-back]');
    if (Motion) {
        try {
            if (surface) Motion.release(surface);
            if (rotor) Motion.release(rotor);
            if (scrim) Motion.release(scrim);
        } catch {}
    }
    if (terminalCardFlipMotion.sourceEl?.style) {
        const src = terminalCardFlipMotion.sourceEl;
        src.style.opacity = '';
        src.style.pointerEvents = '';
        src.style.visibility = '';
        delete src.dataset.motionHidden;
    }
    if (front) front.innerHTML = '';
    if (back) back.innerHTML = '';
    if (surface) {
        surface.classList.remove('is-live', 'flip-fill-stage');
        surface.style.visibility = 'hidden';
        surface.style.pointerEvents = 'none';
        surface.style.transform = '';
        surface.style.opacity = '';
        surface.style.borderRadius = '';
        surface.style.transition = '';
        surface.style.left = '';
        surface.style.top = '';
        surface.style.width = '';
        surface.style.height = '';
        surface.setAttribute('aria-hidden', 'true');
    }
    if (rotor) {
        rotor.style.transform = '';
        rotor.style.transition = '';
    }
    if (scrim) {
        scrim.style.visibility = 'hidden';
        scrim.style.opacity = '0';
        scrim.style.transition = '';
        scrim.classList.remove('is-open');
        scrim.setAttribute('aria-hidden', 'true');
    }
    if (stage) {
        stage.classList.remove('is-active');
        stage.setAttribute('aria-hidden', 'true');
    }
    document.body.classList.remove('terminal-card-flip-animating', 'terminal-card-flip-open');
    document.documentElement.classList.remove('terminal-card-flip-3d');
}
function cardFlipStandards(Motion) {
    return Motion.STANDARDS || Motion.MOTION_STANDARDS || {
        iosCardGeometryOpen: 1,
        iosCardGeometryClose: 2,
        iosCardFlipOpen: 3,
        iosCardFlipClose: 4,
        iosCardContent: 5,
        iosCardScrim: 6,
    };
}
/**
 * Reference-grade OPEN — one Go spring for geometry + rotateY (same standard).
 * Center origin. Interruptible via terminalCardFlipMotion.cycle.
 */
/**
 * Reference-grade OPEN — one Go spring for geometry + rotateY (same standard).
 * Center origin. Interruptible via terminalCardFlipMotion.cycle.
 */
async function playTerminalCardFlipOpen(sourceEl, options = {}) {
    const stage = $('#terminalCardFlipStage');
    const surface = $('#terminalCardFlipSurface');
    const rotor = document.querySelector('[data-terminal-card-rotor]');
    const scrim = $('#terminalCardFlipScrim');
    const front = document.querySelector('[data-terminal-card-front]');
    const back = document.querySelector('[data-terminal-card-back]');
    const liveWindow = options.liveWindow || null;
    const origin = options.originRect || stableTerminalCardSourceRect(sourceEl);
    if (!stage || !surface || !rotor || !front || !back || !liveWindow || !origin) return false;

    const cycle = ++terminalCardFlipMotion.cycle;
    terminalCardFlipMotion.phase = 'opening';
    terminalCardFlipMotion.originRect = origin;
    terminalCardFlipMotion.sourceEl = sourceEl || null;
    terminalCardFlipMotion.connectionId = options.connectionId || null;
    document.body.classList.add('terminal-card-flip-animating', 'terminal-card-flip-open');
    paintTerminalCardFlipFront(sourceEl);
    if (!paintTerminalCardFlipBack({ liveWindow })) return false;

    const target = terminalCardFlipTargetRect(origin);
    const topBound = target.topBound != null ? target.topBound : terminalCardFlipNavBottom();
    placeTerminalCardFlipStage(stage, topBound);
    const localTarget = target.fillStage
        ? { left: 0, top: 0, width: target.width, height: target.height }
        : { left: Math.max(0, target.left), top: Math.max(0, target.top - topBound), width: target.width, height: target.height };
    placeTerminalCardFlipSurface(surface, localTarget);
    surface.classList.toggle('flip-fill-stage', !!target.fillStage);

    const targetWidth = Math.max(1, localTarget.width);
    const targetHeight = Math.max(1, localTarget.height);
    const sx0 = Math.max(0.001, origin.width / targetWidth);
    const sy0 = Math.max(0.001, origin.height / targetHeight);
    const x0 = (origin.left + origin.width / 2) - (localTarget.left + targetWidth / 2);
    const y0 = (origin.top - topBound + origin.height / 2) - (localTarget.top + targetHeight / 2);
    const radius = Number.isFinite(Number(options.radiusFrom)) ? Number(options.radiusFrom) : terminalCardSourceRadius(sourceEl);
    const radiusCss = `${radius}px`;

    stage.classList.add('is-active');
    stage.setAttribute('aria-hidden', 'false');
    surface.classList.add('is-live');
    Object.assign(surface.style, {
        visibility: 'visible', pointerEvents: 'none', transformOrigin: '50% 50%', overflow: 'visible',
        isolation: 'auto', background: 'transparent', border: 'none', boxShadow: 'none',
        transition: 'none', borderRadius: radiusCss,
    });
    surface.setAttribute('aria-hidden', 'false');
    rotor.style.cssText = 'position:absolute;inset:0;border-radius:inherit;transform-style:preserve-3d;-webkit-transform-style:preserve-3d;transform-origin:50% 50%;overflow:visible;transition:none;pointer-events:none';
    front.style.cssText = `position:absolute;inset:0;border-radius:${radiusCss};overflow:hidden;opacity:1;backface-visibility:hidden;-webkit-backface-visibility:hidden;transform:rotateY(0deg);background:var(--surface);pointer-events:none;border:1px solid var(--border);box-shadow:var(--shadow-lift,0 18px 50px rgba(0,0,0,.16));transition:none`;
    back.style.cssText = `position:absolute;inset:0;border-radius:${radiusCss};overflow:hidden;opacity:1;backface-visibility:hidden;-webkit-backface-visibility:hidden;transform:rotateY(180deg);background:var(--surface);pointer-events:none;border:1px solid var(--border);box-shadow:var(--shadow-lift,0 18px 50px rgba(0,0,0,.16));transition:none`;
    if (scrim) {
        scrim.style.visibility = 'visible';
        scrim.style.transition = 'none';
        scrim.classList.add('is-open');
        scrim.setAttribute('aria-hidden', 'false');
    }

    const Motion = await sshKeyMotion._ensure();
    if (cycle !== terminalCardFlipMotion.cycle || !Motion) return false;
    Motion.stop(surface);
    Motion.stop(rotor);
    if (scrim) Motion.stop(scrim);
    Motion.set(surface, { x: x0, y: y0, scaleX: sx0, scaleY: sy0, opacity: 1, radius });
    Motion.set(rotor, { rotateY: 0 });
    if (scrim) Motion.set(scrim, { opacity: 0 });

    // The seeded layer now exactly replaces the source card. Hide the source
    // atomically; the dashboard remains behind the single flipping card.
    await new Promise(requestAnimationFrame);
    if (cycle !== terminalCardFlipMotion.cycle) return false;
    if (sourceEl?.style) {
        sourceEl.style.opacity = '0';
        sourceEl.style.pointerEvents = 'none';
        sourceEl.dataset.motionHidden = '1';
    }

    // Lay out the terminal shelf before the back face becomes readable. The
    // full card remains above it; the nav padding is snapped to final geometry
    // so there can be no post-handoff downward frame.
    document.body.classList.add('terminal-card-flip-handoff');
    const nav = document.querySelector('.main-nav');
    const navStyle = nav ? getComputedStyle(nav) : null;
    const shelfFrom = navStyle ? (parseFloat(navStyle.paddingBottom) || 10) : 10;
    const shelfTo = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--terminal-shelf-open-padding')) || 27;
    applySwitchViewCore('terminal', { enteringAnimated: true });
    if (nav) {
        Motion.cssVars(nav, { '--terminal-card-shelf-line-opacity': 0 }, { immediate: true });
        Motion.set(nav, { y: shelfFrom - shelfTo });
        void nav.offsetHeight;
    }
    syncTerminalSmartbarTop();
    syncTerminalShelfLineState();

    // Top shelf catches up first; the card keeps the slower reference cadence.
    const shelfJobs = nav ? [
        Motion.to(nav, { y: 0 }, { preset: { response: 0.22, damping: 1 } }),
        Motion.cssVars(nav, { '--terminal-card-shelf-line-opacity': 1 }, { preset: { response: 0.40, damping: 0.96 }, delay: 0.10 }),
    ] : [];

    // One cadence for the whole gesture. Geometry and rotation are separate
    // DOM responsibilities but use the same Go flip standard and start frame.
    const S = cardFlipStandards(Motion);
    const jobs = [
        Motion.to(surface, { x: 0, y: 0, scaleX: 1, scaleY: 1, opacity: 1, radius }, { standard: S.iosCardFlipOpen }),
        Motion.to(rotor, { rotateY: -180 }, { standard: S.iosCardFlipOpen }),
        scrim ? Motion.to(scrim, { opacity: 0.55 }, { standard: S.iosCardFlipOpen }) : Promise.resolve(),
    ];
    // Reference motion visually finishes around 0.7s. Do not keep the flip
    // layer alive for the spring's sub-pixel/sub-degree numerical tail; that
    // makes the real page feel faster than the animation. At the visual end,
    // snap the same Go channels to their exact target and hand off this node.
    await new Promise((resolve) => window.setTimeout(resolve, 700));
    if (cycle !== terminalCardFlipMotion.cycle) return false;
    Motion.stop(surface);
    Motion.stop(rotor);
    if (scrim) Motion.stop(scrim);
    Motion.set(surface, { x: 0, y: 0, scaleX: 1, scaleY: 1, opacity: 1, radius });
    Motion.set(rotor, { rotateY: -180 });
    if (scrim) Motion.set(scrim, { opacity: 0.55 });
    Promise.allSettled([...jobs, ...shelfJobs]).catch(() => {});
    if (nav) {
        Motion.stop(nav, ['y', '--terminal-card-shelf-line-opacity']);
        Motion.set(nav, { y: 0, '--terminal-card-shelf-line-opacity': 1 });
    }
    terminalCardFlipMotion.phase = 'open';
    return true;
}
/** Instant handoff — no fade. Real terminal is already under the card. */
/** Instant handoff — no fade. Real terminal is already under the card. */
/** Instant handoff — no fade, no leave-fly residue. */
/** Instant handoff onto the real page — restore reparented window, no fade flash. */
async function finishTerminalCardFlipOpenHandoff() {
    const surface = $('#terminalCardFlipSurface');
    const scrim = $('#terminalCardFlipScrim');
    const Motion = sshKeyMotion.engine;
    const win = terminalCardFlipMotion.hostedWindow;
    if (!win) return false;
    // The final back face still covers the whole target while terminal mode is
    // laid out underneath. All operations remain in this one JS task, so the
    // browser never paints an empty intermediate page.
    settleTerminalShelfForCardFlip();
    syncTerminalSmartbarTop();
    syncTerminalShelfLineState();
    // The back face is still full-stage, so this is the flip's visual end box.
    // It becomes the FLIP "before" rect for the settle morph below.
    const stageRect = win.getBoundingClientRect();
    // The live window is still hosted by the full-screen back face, so the
    // workspace can be assigned its final layout without painting a duplicate.
    // NEVER hardcode layout-1 here: when "multiple terminals per page" is on
    // and a session is already open, the real layout is 2 or 3 columns. Forcing
    // layout-1 left every window auto-placed into implicit rows, which is what
    // produced the vertical stack instead of a left/right split.
    // Keep the final back face visually intact until the live node is already
    // in its final workspace box. The back surface is cleared only afterwards.
    restoreCardFlipHostedWindow();
    Object.assign(win.style, {
        visibility: 'visible', opacity: '1', pointerEvents: '', animation: 'none',
        transition: 'none', transform: 'none', filter: 'none',
    });
    // The restored node is back under #terminalWorkspace, so the normal
    // renderer reuses this exact iframe and assigns the real layout class,
    // slot-N placement and splitter tracks in the same JS task.
    syncVisualLayout({ preserve: true });
    renderTerminalWorkspace();
    // Same-frame handoff: the exact back-face node is now in the exact final
    // box; only then remove the flip surface and reveal the terminal view.
    document.body.classList.remove('terminal-card-flip-preparing', 'terminal-card-flip-animating', 'terminal-card-flip-handoff');
    // Release the flip-only pins. `[data-card-flip-radius]` carries
    // `transform/transition/filter/animation: none !important`, which outranks
    // element.animate() in the cascade — leaving it on froze this window for
    // every later layout morph while its siblings moved, so windows ended up
    // overlapping and corners were covered. Keep only the inline
    // `animation: none` so the entrance keyframes cannot replay.
    releaseCardFlipWindowPins(win);
    if (Motion && surface) {
        Motion.stop(surface);
        if (scrim) Motion.stop(scrim);
        Motion.set(surface, { opacity: 0 });
        if (scrim) Motion.set(scrim, { opacity: 0 });
    }
    if (Motion) {
        const nav = document.querySelector('.main-nav');
        if (nav) Motion.release(nav);
    }
    resetTerminalCardFlipSurface(Motion);
    // The flip always ends full-stage. With a multi-window layout the final box
    // is one slot, so morph from the flip's end box into that slot instead of
    // snapping.
    //
    // This must be gated on a MATERIAL difference, not on the morph's own 1px
    // threshold. In a single-window layout the window is inset by the
    // workspace's 1px border, so |dx|+|dy| is 2 and the morph would fire for a
    // 1px nudge — and `.layout-morphing .terminal-frame` is `pointer-events:
    // none`, which would leave a freshly opened terminal dead to input for the
    // whole 560ms. Compare against the settled box and only morph on a real
    // slot change.
    if (shouldSettleCardFlipIntoSlot(win, stageRect)) {
        animateTerminalWindowLayoutFrom(new Map([[win.dataset.window, stageRect]]), { reason: 'card-flip-settle' });
    }
    terminalCardFlipMotion.phase = 'settled';
    terminalCardFlipMotion.originRect = null;
    terminalCardFlipMotion.sourceEl = null;
    return true;
}
/**
 * Should the handed-off window morph from the flip's full-stage box into its
 * final slot, or is it already effectively there?
 *
 * The flip always ends full-stage. With one visible window the final box is the
 * whole workspace, differing only by the workspace's 1px border — i.e. |dx|+|dy|
 * = 2, which is already past animateTerminalWindowLayoutFrom's 1px threshold. A
 * morph there would be invisible yet still add `.layout-morphing`, whose rule
 * sets `pointer-events: none` on `.terminal-frame`: the terminal would ignore
 * clicks and keys for the whole 560ms right after opening. Only morph when the
 * slot is materially different, which is exactly the multi-window case.
 *
 * The threshold is read from --workspace-gutter so it cannot drift from the CSS:
 * anything smaller than one gutter is not a slot change.
 */
function shouldSettleCardFlipIntoSlot(win, stageRect) {
    if (!win?.isConnected || !stageRect || stageRect.width <= 1 || stageRect.height <= 1) return false;
    const now = win.getBoundingClientRect();
    if (now.width <= 1 || now.height <= 1) return false;
    const gutter = (() => {
        const raw = parseFloat(getComputedStyle(win).getPropertyValue('--workspace-gutter'));
        return Number.isFinite(raw) && raw > 0 ? raw : 12;
    })();
    return Math.abs(now.left - stageRect.left) >= gutter
        || Math.abs(now.top - stageRect.top) >= gutter
        || Math.abs(now.width - stageRect.width) >= gutter
        || Math.abs(now.height - stageRect.height) >= gutter;
}
/**
 * Drop every flip-only pin from a handed-off window.
 *
 * `[data-card-flip-radius]` is matched by a rule carrying
 * `transform/transition/filter/animation: none !important`. Author-important
 * beats the Animation origin in the cascade, so while that attribute stays the
 * window can never be moved by element.animate() nor by any class-driven
 * transition. Removing it restores normal layout-morph behaviour.
 *
 * Inline `animation: 'none'` is deliberately kept: clearing it would restart
 * `terminalWindowIn` on an already-visible window and flash it. Class-driven
 * keyframes (`.motion-closing`, `.dock-swapping`) use !important so they still win.
 */
function releaseCardFlipWindowPins(win) {
    if (!win) return;
    delete win.dataset.cardFlipRadius;
    win.style.removeProperty('border-radius');
    win.style.removeProperty('overflow');
    win.style.removeProperty('transform');
    win.style.removeProperty('transition');
    win.style.removeProperty('filter');
}
/**
 * Reference-grade CLOSE — hold rotateY(-180), centre scale→0.01 + opacity 0.
 * Can interrupt an in-flight OPEN (no busy lock).
 */
/**
 * Reference-grade CLOSE — hold rotateY(-180), centre scale→0.01 + opacity 0.
 * Can interrupt an in-flight OPEN (no busy lock).
 */
async function playTerminalCardFlipClose(options = {}) {
    const stage = $('#terminalCardFlipStage');
    const surface = $('#terminalCardFlipSurface');
    const rotor = document.querySelector('[data-terminal-card-rotor]');
    const scrim = $('#terminalCardFlipScrim');
    const front = document.querySelector('[data-terminal-card-front]');
    const back = document.querySelector('[data-terminal-card-back]');
    if (!surface || !rotor) return false;
    // Allow interrupting opening. Only reject if already closed or already closing this cycle path.
    if (terminalCardFlipMotion.phase === 'closed') return false;

    let sourceEl = options.sourceEl || terminalCardFlipMotion.sourceEl;
    if (sourceEl && !sourceEl.isConnected && terminalCardFlipMotion.connectionId) {
        const id = String(terminalCardFlipMotion.connectionId);
        sourceEl = document.querySelector(`.connection-card [data-connect="${CSS.escape(id)}"]`)?.closest?.('.connection-card')
            || document.querySelector(`[data-connect="${CSS.escape(id)}"]`)?.closest?.('.connection-card')
            || null;
    }
    const origin = options.originRect || terminalCardFlipMotion.originRect || stableTerminalCardSourceRect(sourceEl);

    const cycle = ++terminalCardFlipMotion.cycle;
    const wasOpening = terminalCardFlipMotion.phase === 'opening';
    terminalCardFlipMotion.phase = 'closing';
    document.body.classList.add('terminal-card-flip-animating', 'terminal-card-flip-open');

    if (!front.childNodes.length) paintTerminalCardFlipFront(sourceEl);
    if (!back.childNodes.length) {
        paintTerminalCardFlipBack({
            name: options.name || sourceEl?.querySelector?.('h2')?.textContent || t('终端'),
            host: options.host || sourceEl?.querySelector?.('.host-line')?.textContent || '',
            protocol: options.protocol,
            tabId: options.tabId,
        });
    }

    const Motion = await sshKeyMotion._ensure();
    if (cycle !== terminalCardFlipMotion.cycle) return false;

    const target = terminalCardFlipTargetRect(origin);
    const topBound = target.topBound != null ? target.topBound : terminalCardFlipNavBottom();
    placeTerminalCardFlipStage(stage, topBound);
    const localTarget = target.fillStage
        ? { left: 0, top: 0, width: target.width, height: target.height }
        : {
            left: Math.max(0, target.left),
            top: Math.max(0, target.top - topBound),
            width: target.width,
            height: target.height,
        };
    // If already live at final box, keep placement; else place.
    if (!surface.classList.contains('is-live') || !surface.style.width) {
        placeTerminalCardFlipSurface(surface, localTarget);
    }
    if (stage) {
        stage.classList.add('is-active');
        stage.setAttribute('aria-hidden', 'false');
    }
    surface.classList.add('is-live');
    surface.classList.toggle('flip-fill-stage', !!target.fillStage);
    surface.style.visibility = 'visible';
    surface.style.pointerEvents = 'none';
    surface.style.transformOrigin = '50% 50%';
    surface.style.transformStyle = 'preserve-3d';
    surface.style.overflow = 'visible';
    surface.style.transition = 'none';
    surface.style.background = 'transparent';
    surface.style.border = 'none';
    surface.style.boxShadow = 'none';
    rotor.style.cssText = [
        'position:absolute', 'inset:0', 'border-radius:inherit',
        'transform-style:preserve-3d', '-webkit-transform-style:preserve-3d',
        'transform:none', 'overflow:visible', 'transition:none',
    ].join(';');
    if (front) {
        front.style.backfaceVisibility = 'hidden';
        front.style.webkitBackfaceVisibility = 'hidden';
        front.style.transform = 'rotateY(0deg)';
        front.style.opacity = '1';
    }
    if (back) {
        back.style.backfaceVisibility = 'hidden';
        back.style.webkitBackfaceVisibility = 'hidden';
        back.style.transform = 'rotateY(180deg)';
        back.style.opacity = '1';
    }
    if (scrim) {
        scrim.style.visibility = 'visible';
        scrim.style.transition = 'none';
        scrim.classList.add('is-open');
    }
    document.querySelectorAll('#terminalWorkspace .terminal-window').forEach((w) => {
        w.style.opacity = '0';
        w.style.pointerEvents = 'none';
    });

    if (!Motion) {
        resetTerminalCardFlipSurface(null);
        terminalCardFlipMotion.phase = 'closed';
        terminalCardFlipMotion.originRect = null;
        terminalCardFlipMotion.sourceEl = null;
        return false;
    }

    // Interrupt-safe: stop at live pose, then spring to shrink-out.
    try { Motion.stop(surface); if (scrim) Motion.stop(scrim); } catch {}

    const liveX = Motion.value?.(surface, 'x');
    const liveY = Motion.value?.(surface, 'y');
    const liveSX = Motion.value?.(surface, 'scaleX');
    const liveSY = Motion.value?.(surface, 'scaleY');
    const liveRot = Motion.value?.(rotor, 'rotateY');
    const liveOp = Motion.value?.(surface, 'opacity');
    const hasLive = wasOpening && Number.isFinite(liveSX);

    // Centre-origin shrink: stay at x=0,y=0 (or current centre), scale→0.01, hold -180.
    Motion.set(surface, {
        x: hasLive && Number.isFinite(liveX) ? liveX : 0,
        y: hasLive && Number.isFinite(liveY) ? liveY : 0,
        scaleX: hasLive ? liveSX : 1,
        scaleY: hasLive && Number.isFinite(liveSY) ? liveSY : (hasLive ? liveSX : 1),
        opacity: Number.isFinite(liveOp) ? liveOp : 1,
    });
    Motion.set(rotor, { rotateY: Number.isFinite(liveRot) ? liveRot : -180 });
    if (scrim) {
        const so = Motion.value?.(scrim, 'opacity');
        Motion.set(scrim, { opacity: Number.isFinite(so) ? so : 0.55 });
    }

    const S = cardFlipStandards(Motion);
    const sEnd = 0.01;
    try {
        // Close is faster than open (reference 0.5s vs 0.7s) — geometryClose 0.34/1.0.
        // Hold rotateY at -180 (no reverse flip). Centre origin → x/y → 0 while scaling down.
        await Promise.all([
            Motion.to(surface, {
                x: 0,
                y: 0,
                scaleX: sEnd,
                scaleY: sEnd,
                opacity: 0,
            }, { standard: S.iosCardGeometryClose }),
            Motion.to(rotor, { rotateY: -180 }, { standard: S.iosCardFlipClose }),
            scrim
                ? Motion.to(scrim, { opacity: 0 }, { standard: S.iosCardScrim })
                : Promise.resolve(),
        ]);
    } catch (err) {
        console.warn('[terminal-card-flip] engine close failed', err);
    }
    if (cycle !== terminalCardFlipMotion.cycle) return false;

    if (sourceEl?.style) {
        sourceEl.style.opacity = '';
        sourceEl.style.pointerEvents = '';
        sourceEl.style.visibility = '';
        delete sourceEl.dataset.motionHidden;
    }
    document.querySelectorAll('#terminalWorkspace .terminal-window').forEach((w) => {
        w.style.opacity = '';
        w.style.pointerEvents = '';
    });
    resetTerminalCardFlipSurface(Motion);
    terminalCardFlipMotion.phase = 'closed';
    terminalCardFlipMotion.originRect = null;
    terminalCardFlipMotion.sourceEl = null;
    return true;
}


/**
 * Connect + flip: engine-owned, interruptible, parallel network.
 * Flip starts as soon as engine is ready; no busy lock.
 */
/**
 * Connect + flip: engine-owned, interruptible, parallel network.
 * Flip starts as soon as engine is ready; no busy lock.
 */
/**
 * Connect with card flip — REAL page on the back face.
 * Order:
 *  1) Measure source card + radius
 *  2) Switch terminal + open session + mount real window (hidden under stage)
 *  3) Paint back = live terminal chrome (图二), front = connection card
 *  4) Go spring: scale + rotateY on one surface (same radius end-to-end)
 *  5) Instant handoff onto the real window (same box/radius) — no flash
 */
/**
 * Connect + flip: animation FIRST (same as demo), real page on the back.
 * Never wait for API before the first flip frame.
 */
async function openConnectionWithCardFlip(id, sourceEl, extra = {}) {
    const cardEl = sourceEl?.classList?.contains?.('connection-card')
        ? sourceEl : (sourceEl?.closest?.('.connection-card') || sourceEl);
    const originRect = stableTerminalCardSourceRect(cardEl);
    const connection = connections.find((item) => String(item.id) === String(id));
    if (!originRect || !connection) return openConnection(id, { ...extra, skipCardFlip: true });
    const cardRadius = terminalCardSourceRadius(cardEl);
    document.documentElement.style.setProperty('--terminal-card-radius', `${cardRadius}px`);
    document.body.classList.add('terminal-card-flip-preparing');

    // Mount the actual terminal immediately from the already-authorized public
    // connection metadata. Server-side USE authorization/markConnected runs in
    // parallel, so network latency cannot delay the card's first frame.
    const tabId = `tab_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const mountedId = mountConnectionLocallyForCardFlip(connection, { tabId });
    const liveWin = mountedId
        ? document.querySelector(`#terminalWorkspace .terminal-window[data-window="${CSS.escape(String(mountedId))}"]`)
        : null;
    if (!liveWin) {
        document.body.classList.remove('terminal-card-flip-preparing');
        return openConnection(id, { ...extra, skipCardFlip: true });
    }
    liveWin.dataset.cardFlipRadius = String(cardRadius);
    Object.assign(liveWin.style, {borderRadius:`${cardRadius}px`,overflow:'hidden',animation:'none',transition:'none',transform:'none',filter:'none'});

    const authorize = api(`/api/connections/${id}/open`, { method: 'POST' });
    const flight = playTerminalCardFlipOpen(cardEl, {
        originRect, connectionId:id, tabId:mountedId, liveWindow:liveWin,
        radiusFrom:cardRadius, radiusTo:cardRadius, fromView:'dashboard',
    });
    let authorized = true;
    authorize.catch((err) => { authorized = false; console.warn('[terminal-card-flip] connect authorization failed', err); });
    const flipped = await flight.catch(() => false);
    if (!authorized) {
        resetTerminalCardFlipSurface(sshKeyMotion.engine);
        document.body.classList.remove('terminal-card-flip-preparing');
        rollbackLocallyMountedCardFlipTab(mountedId);
        throw new Error(t('连接授权失败'));
    }
    if (flipped || terminalCardFlipMotion.hostedWindow) await finishTerminalCardFlipOpenHandoff();
    else {
        resetTerminalCardFlipSurface(sshKeyMotion.engine);
        document.body.classList.remove('terminal-card-flip-preparing');
    }
    scheduleTerminalLayoutStabilize?.('card-flip-handoff', {focus:true});
    authorize.then(() => { loadConnections().catch(() => {}); }).catch(() => {});
    return mountedId;
}

function shouldExitTerminalFullscreenBeforeView(target) {
    if (target === 'terminal') return false;
    const workspace = $('#terminalWorkspace');
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
    return !!workspace?.classList.contains('custom-fullscreen')
        || fullscreenElement === workspace
        || !!fullscreenElement?.classList?.contains?.('terminal-window');
}

async function exitTerminalFullscreenThenSwitchView(name, options = {}) {
    const target = name === 'ai' ? 'dashboard' : name;
    if (document.body.classList.contains('terminal-mode') && shouldExitTerminalFullscreenBeforeView(target)) {
        // Keep terminal-mode and fullscreen classes alive until the Go spring
        // finishes. This preserves the existing workspace shrink + nav return
        // animation instead of snapping directly to the destination view.
        await exitTerminalFullscreen({ renderAfter: false });
    }
    switchView(target, { ...options, fullscreenExitHandled: true });
}

function switchView(name, options = {}) {
    const target = name === 'ai' ? 'dashboard' : name;
    if (!options.fullscreenExitHandled
        && document.body.classList.contains('terminal-mode')
        && shouldExitTerminalFullscreenBeforeView(target)) {
        return exitTerminalFullscreenThenSwitchView(target, options);
    }
    const wasTerminal = document.body.classList.contains('terminal-mode');
    const enteringTerminal = target === 'terminal' && !wasTerminal;
    const leavingTerminal = target !== 'terminal' && wasTerminal;
    const sourceEl = options.cardFlipSource
        || (options.cardFlipSourceSelector ? document.querySelector(options.cardFlipSourceSelector) : null);
    const wantsOpenFlip = enteringTerminal && !options.skipCardFlip && !!options.forceCardFlipOpen && !!sourceEl;
    // ONLY interrupt an in-flight open with reverse shrink. After handoff
    // (phase settled/closed) just clean up — no ghost card flying home.
    const wantsCloseFlip = leavingTerminal
        && !options.skipCardFlip
        && terminalCardFlipMotion.phase === 'opening';

    if (wantsOpenFlip) {
        playTerminalCardFlipOpen(sourceEl, {
            connectionId: options.connectionId || null,
            originRect: options.originRect || null,
            fromView: options.fromView || 'dashboard',
        }).then(async (ok) => {
            applySwitchViewCore(target, { enteringAnimated: true });
            if (ok || terminalCardFlipMotion.phase === 'open') await finishTerminalCardFlipOpenHandoff();
            else if (terminalCardFlipMotion.phase !== 'closing') {
                resetTerminalCardFlipSurface(sshKeyMotion.engine);
                terminalCardFlipMotion.phase = 'settled';
            }
        }).catch((err) => {
            console.warn('[terminal-card-flip] open path', err);
            applySwitchViewCore(target, { enteringAnimated: true });
        });
        return;
    }
    if (wantsCloseFlip) {
        playTerminalCardFlipClose({
            sourceEl: terminalCardFlipMotion.sourceEl || sourceEl,
            originRect: options.originRect || terminalCardFlipMotion.originRect || null,
        }).then(() => {
            applySwitchViewCore(target, { enteringAnimated: false });
        }).catch((err) => {
            console.warn('[terminal-card-flip] close path', err);
            applySwitchViewCore(target, { enteringAnimated: false });
        });
        return;
    }
    if (leavingTerminal) {
        try {
            const surface = $('#terminalCardFlipSurface');
            if (surface && sshKeyMotion.engine) sshKeyMotion.engine.stop(surface);
        } catch {}
        resetTerminalCardFlipSurface(sshKeyMotion.engine);
        terminalCardFlipMotion.phase = 'closed';
        terminalCardFlipMotion.originRect = null;
        terminalCardFlipMotion.sourceEl = null;
        applySwitchViewCore(target, { enteringAnimated: false });
        return;
    }
    applySwitchViewCore(target, { enteringAnimated: false });
}



function parseTags(v) { return String(v || '').split(',').map((x) => x.trim()).filter(Boolean); }
function base64urlToBuffer(value) { const s = String(value).replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(s + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0)); }
function bufferToBase64url(buffer) { return btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }

function allTags() { return [...new Set(connections.flatMap((c) => c.tags || []))].sort(); }
const CONNECTION_FILTER_KEY = 'zephyr.connection.filters.v1';

/**
 * Custom single-select that toggles closed when the trigger is clicked again.
 * Native <select> on mobile cannot be dismissed by re-tapping the control.
 * Keeps the original <select> as the value source of truth (forms/filters unchanged).
 */
const TOGGLE_SELECT_IDS = [
    // Dashboard filters
    'protocolFilter', 'tagFilter', 'sortSelect',
    // Settings / appearance / terminal prefs (same UI pattern)
    'captchaProvider', 'colorSchemeSelect', 'themeModeSelect',
    'terminalBgSource', 'terminalBgFit', 'terminalMaxWindows',
    'terminalSmartbarOrder', 'terminalShortcutPlatform',
    // Settings → 语言（与其它设置同源 toggle-select）
    'languageSelect',
    // 设置 → 语言（与其它设置同源 toggle-select）
    'languageSelect',
    // AI 助理设置 / 供应商弹窗（与 CAPTCHA 同源 toggle-select）
    'aiDefaultProvider', 'aiProviderType', 'aiProviderApiMode', 'aiProviderReasoningEffort',
    // Proxy modal
    'proxyType',
    // Connection modal / RDP (when opened)
    'connProtocol', 'connSshKey', 'connEncoding', 'connRoute',
    'rdpSoundMode', 'rdpResolution', 'rdpQuality', 'rdpFps', 'rdpTouchMode',
    // 多用户 → 添加用户 → 角色（与首页「全部协议」同源 toggle-select）
    'adminUserRole',
];
let _toggleSelectDocBound = false;

/* 首页三个筛选（全部协议 / 全部标签 / 按创建时间）接 zephyr-motion：
   与演示页 motion-feel.html §3 同一套“从按钮向下 FLIP 展开菜单”；
   打开 Motion.morph（preset 'mac'），关闭 setOriginFromAnchor + macClose
   缩回淡出。引擎不可用时退回原 instant class 路径。 */
const MOTION_FILTER_SELECT_IDS = [
    // 首页筛选
    'protocolFilter', 'tagFilter', 'sortSelect',
    // 设置 → 安全 → CAPTCHA
    'captchaProvider',
    // 设置 → 个性化
    'colorSchemeSelect', 'themeModeSelect', 'terminalBgSource', 'terminalBgFit',
    // 设置 → 终端工作台
    'terminalMaxWindows', 'terminalSmartbarOrder', 'terminalShortcutPlatform',
    // 连接弹窗：协议 / SSH 密钥 / Telnet 编码 / 代理选择与首页筛选同款菜单动画
    'connProtocol', 'connSshKey', 'connEncoding', 'connRoute',
    'rdpSoundMode', 'rdpResolution', 'rdpQuality', 'rdpFps', 'rdpTouchMode',
    // AI 助理 / 供应商弹窗（与 CAPTCHA 完全同一套 open/close 动画）
    'aiDefaultProvider', 'aiProviderType', 'aiProviderApiMode', 'aiProviderReasoningEffort',
    // 设置 → 语言 与 代理弹窗 → 类型（与首页筛选同一套 FLIP 展开/收起）
    'languageSelect', 'proxyType',
    // 多用户 → 添加用户 → 角色：与「全部协议」同一套 Motion.morph(mac) / macClose
    'adminUserRole',
];
function isMotionFilterShell(shell) {
    return !!shell && MOTION_FILTER_SELECT_IDS.includes(shell.dataset?.selectId || '');
}

async function openToggleSelectMenu(shell) {
    const trigger = shell.querySelector('.ui-toggle-select-trigger');
    const menu = shell.querySelector('.ui-toggle-select-menu');
    if (!trigger || !menu) return;
    shell.classList.remove('menu-closing');
    shell.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    if (!isMotionFilterShell(shell)) {
        try { menu.scrollTop = 0; } catch (_) {}
        return;
    }
    const Motion = await sshKeyMotion._ensure();
    if (!Motion) { try { menu.scrollTop = 0; } catch (_) {} return; }
    const token = (shell._menuToken = (shell._menuToken || 0) + 1);
    const midFlight = Motion.isAnimating(menu); // 必须先查；morph 自身处理飞行中重定向
    // display:grid 已由 .open 生效；飞行中重开不藏（防闪），冷启动先藏再 reflow 防终态闪一帧。
    if (!midFlight) {
        menu.style.visibility = 'hidden';
        void menu.offsetWidth;
    }
    const from = trigger.getBoundingClientRect();
    menu.style.visibility = 'visible';
    try { menu.scrollTop = 0; } catch (_) {}
    const radiusFrom = parseFloat(getComputedStyle(trigger)?.borderRadius) || 12;
    try {
        await Motion.morph(menu, from, {
            preset: 'mac',
            radiusFrom,
            radiusTo: 14,
            radiusCompensate: true,
            opacityFrom: 0.92,
            opacityTo: 1,
            forceFrom: !midFlight,
        });
    } catch (err) {
        console.debug('[filter-menu]', 'open morph failed', err?.message || err);
    }
    if (token !== shell._menuToken) return;
}

function closeToggleSelectMenu(shell) {
    const trigger = shell.querySelector('.ui-toggle-select-trigger');
    const menu = shell.querySelector('.ui-toggle-select-menu');
    if (!trigger || !menu) return;
    const wasOpen = shell.classList.contains('open');
    shell.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
    if (!wasOpen || !isMotionFilterShell(shell)) return;
    const Motion = sshKeyMotion.engine; // close 不懒加载引擎；没加载过就 instant
    if (!Motion || sshKeyMotion.failed) return;
    const token = (shell._menuToken = (shell._menuToken || 0) + 1);
    shell.classList.add('menu-closing'); // 动画期间保持 display:grid
    Motion.setOriginFromAnchor?.(menu, trigger);
    Promise.resolve()
        .then(() => Motion.to(menu, { opacity: 0, scale: 0.94, y: -8, x: 0, blur: 0 }, { preset: 'macClose' }))
        .catch(() => {})
        .then(() => {
            if (token !== shell._menuToken) return;
            shell.classList.remove('menu-closing');
            Motion.stop(menu);
            Motion.set(menu, { x: 0, y: 0, scaleX: 1, scaleY: 1, scale: 1, opacity: 1, blur: 0, radius: 0 });
            menu.style.transform = '';
            menu.style.opacity = '';
        });
}

function closeAllToggleSelects(exceptShell = null) {
    document.querySelectorAll('.ui-toggle-select.open').forEach((shell) => {
        if (exceptShell && shell === exceptShell) return;
        closeToggleSelectMenu(shell);
    });
}

function syncToggleSelectFace(select) {
    if (!select?.closest) return;
    const shell = select.closest('.ui-toggle-select');
    if (!shell) return;
    const trigger = shell.querySelector('.ui-toggle-select-trigger');
    const menu = shell.querySelector('.ui-toggle-select-menu');
    if (!trigger || !menu) return;
    const opts = Array.from(select.options || []);
    const current = opts.find((o) => o.value === select.value) || opts[0];
    trigger.textContent = current ? (current.textContent || current.value || '') : '';
    menu.innerHTML = opts.map((o) => {
        const selected = o.value === select.value;
        return `<button type="button" class="ui-toggle-select-option${selected ? ' is-selected' : ''}" role="option" data-value="${escapeAttr(o.value)}" aria-selected="${selected ? 'true' : 'false'}">${escapeHtml(o.textContent || o.value || '')}</button>`;
    }).join('');
}

function enhanceToggleSelect(select) {
    if (!select || select.tagName !== 'SELECT' || select.multiple || select.dataset.toggleSelect === '1') return null;
    if (select.disabled) return null;
    // Already wrapped
    if (select.parentElement?.classList?.contains('ui-toggle-select')) {
        select.dataset.toggleSelect = '1';
        syncToggleSelectFace(select);
        return select.parentElement;
    }
    const shell = document.createElement('div');
    shell.className = 'ui-toggle-select';
    shell.dataset.selectId = select.id || '';
    select.parentNode.insertBefore(shell, select);
    shell.appendChild(select);
    select.classList.add('ui-toggle-select-native');
    select.dataset.toggleSelect = '1';
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'ui-toggle-select-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    if (select.id) trigger.id = `${select.id}ToggleTrigger`;

    const menu = document.createElement('div');
    menu.className = 'ui-toggle-select-menu';
    menu.setAttribute('role', 'listbox');
    menu.hidden = false;

    shell.appendChild(trigger);
    shell.appendChild(menu);
    syncToggleSelectFace(select);

    trigger.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const willOpen = !shell.classList.contains('open');
        closeAllToggleSelects(willOpen ? shell : null);
        if (willOpen) openToggleSelectMenu(shell);
        else closeToggleSelectMenu(shell);
    });

    menu.addEventListener('click', (e) => {
        const opt = e.target.closest?.('.ui-toggle-select-option');
        if (!opt) return;
        e.preventDefault();
        e.stopPropagation();
        const value = opt.getAttribute('data-value') ?? '';
        if (select.value !== value) {
            select.value = value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            select.dispatchEvent(new Event('input', { bubbles: true }));
        }
        syncToggleSelectFace(select);
        closeToggleSelectMenu(shell);
    });

    select.addEventListener('change', () => syncToggleSelectFace(select));
    return shell;
}

function enhanceAllToggleSelects() {
    TOGGLE_SELECT_IDS.forEach((id) => {
        const el = document.getElementById(id);
        if (el) enhanceToggleSelect(el);
    });
    // Settings / dashboard / modals: wrap remaining single selects with toggle UX
    document.querySelectorAll(
        '.action-bar select:not([multiple]), .settings-form select:not([multiple]), .appearance-form select:not([multiple]), .connection-modal select:not([multiple]), .proxy-modal select:not([multiple]), #proxyForm select:not([multiple]), #connectionForm select:not([multiple])',
    ).forEach((el) => {
        enhanceToggleSelect(el);
    });
    if (!_toggleSelectDocBound) {
        _toggleSelectDocBound = true;
        document.addEventListener('click', (e) => {
            if (e.target.closest?.('.ui-toggle-select')) return;
            closeAllToggleSelects();
        }, true);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeAllToggleSelects();
        });
        // Re-sync when options mutate (tag filter rebuild).
        const mo = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.type === 'childList' && m.target?.tagName === 'SELECT' && m.target.dataset.toggleSelect === '1') {
                    syncToggleSelectFace(m.target);
                }
            }
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
    }
}

function readConnectionFilters() {
    try { return JSON.parse(localStorage.getItem(CONNECTION_FILTER_KEY) || '{}') || {}; } catch { return {}; }
}
function saveConnectionFilters() {
    const data = {
        q: $('#searchInput')?.value || '',
        protocol: $('#protocolFilter')?.value || 'all',
        tag: $('#tagFilter')?.value || 'all',
        sort: $('#sortSelect')?.value || 'createdAt',
    };
    try { localStorage.setItem(CONNECTION_FILTER_KEY, JSON.stringify(data)); } catch {}
}
function restoreConnectionFilters() {
    const data = readConnectionFilters();
    if ($('#searchInput')) $('#searchInput').value = data.q || '';
    if ($('#protocolFilter')) $('#protocolFilter').value = data.protocol || 'all';
    if ($('#sortSelect')) $('#sortSelect').value = data.sort || 'createdAt';
    if ($('#tagFilter')) $('#tagFilter').dataset.savedValue = data.tag || 'all';
    // Faces after restore (native value already set).
    ['protocolFilter', 'tagFilter', 'sortSelect'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) syncToggleSelectFace(el);
    });
}
function refreshTagFilter() {
    const select = $('#tagFilter');
    if (!select) return;
    const old = select.dataset.savedValue || select.value || 'all';
    select.innerHTML = `<option value="all">${t('全部标签')}</option>` + allTags().map((tag) => `<option value="${escapeAttr(tag)}" ${old === tag ? 'selected' : ''}>${escapeHtml(tag)}</option>`).join('');
    if (old === 'all' || allTags().includes(old)) select.value = old;
    else select.value = 'all';
    delete select.dataset.savedValue;
    syncToggleSelectFace(select);
}
// 首页搜索空结果：命中危机/自伤意图词时展示援助信息，而不是“暂无连接”。
// 故意收窄关键词，避免「抑郁」「压力」等日常词误触发；只有明确危机意图才替换空状态。
const CRISIS_HELP_HOTLINE = '010-82951332';
const CRISIS_HELP_HOTLINE_TEL = '01082951332';
const CRISIS_SEARCH_PATTERNS = [
    /自杀/, /轻生/, /自尽/, /寻死/, /想死/, /不想活/, /结束生命/, /结束自己/,
    /自残/, /割腕/, /跳楼/, /跳河/, /上吊/, /服毒/, /烧炭/,
    /suicide/i, /suicidal/i, /\bkill myself\b/i, /\bwant to die\b/i,
    /self[-\s]?harm/i, /\bend my life\b/i, /\bend it all\b/i,
];
function isCrisisSearchQuery(q) {
    const raw = String(q || '').trim();
    if (!raw) return false;
    return CRISIS_SEARCH_PATTERNS.some((re) => re.test(raw));
}
function renderCrisisHelpEmptyCard() {
    const phone = escapeHtml(CRISIS_HELP_HOTLINE);
    const tel = escapeAttr(CRISIS_HELP_HOTLINE_TEL);
    return `<div class="empty-card crisis-help-card" role="region" aria-label="${t('心理援助信息')}">
        <div class="crisis-help-inner">
            <h2 class="crisis-help-title">${t('你不孤单，我们都在')}</h2>
            <p class="crisis-help-lead">${t('如果需要帮助，请拨打全国24小时免费心理咨询热线')}</p>
            <a class="crisis-help-phone" href="tel:${tel}">${phone}</a>
            <p class="crisis-help-en">24/7 Free Psychological Counseling</p>
            <button type="button" class="btn crisis-help-copy" data-copy-hotline="${phone}">${t('复制热线')}</button>
        </div>
    </div>`;
}
function connectionListEmptyHtml() {
    const q = $('#searchInput')?.value || '';
    if (isCrisisSearchQuery(q)) return renderCrisisHelpEmptyCard();
    return `<div class="empty-card">${t('暂无连接，点击右上角添加新连接。')}</div>`;
}
function filteredConnections() {
    const q = $('#searchInput').value.trim().toLowerCase(), proto = $('#protocolFilter').value, tag = $('#tagFilter').value, sort = $('#sortSelect').value;
    const list = connections.filter((c) => [c.name, c.host, c.remark, c.username, (c.tags || []).join(' ')].join(' ').toLowerCase().includes(q) && (proto === 'all' || c.protocol === proto) && (tag === 'all' || (c.tags || []).includes(tag)));
    return list.sort((a, b) => sort === 'name' ? String(a.name).localeCompare(String(b.name), 'zh-CN') : sort === 'protocol' ? String(a.protocol).localeCompare(String(b.protocol)) : (b[sort] || 0) - (a[sort] || 0));
}
function renderConnections() {
    refreshTagFilter();
    $('#connectionTitle').textContent = t('连接列表 ({count})', { count: connections.length });
    const list = filteredConnections();
    $('#connectionGrid').innerHTML = list.length ? list.map((c) => {
        const caps = Array.isArray(c.capabilities) ? c.capabilities : [];
        const canEdit = !caps.length || caps.includes('edit');
        const canDelete = !caps.length || caps.includes('delete');
        const canUse = !caps.length || caps.includes('use') || caps.includes('control');
        const sourceBadge = c.owner === 'shared'
            ? `<span class="connection-source-badge shared">${t('共享')}</span>`
            : (c.owner === 'own' ? `<span class="connection-source-badge">${t('我的')}</span>` : '');
        return `<article class="connection-card"><div class="card-top"><span class="protocol-badge">${escapeHtml(c.protocol)}</span><div class="card-top-meta">${sourceBadge}<span class="last-time">${fmtTime(c.lastConnectedAt)}</span></div></div>
        <h2>${escapeHtml(c.name)}</h2><p class="host-line">${escapeHtml(c.host)}:${escapeHtml(c.port)} · ${c.connectionMode === 'proxy' ? t('代理') : c.connectionMode === 'jump' ? t('跳板机') : t('直连')}</p>
        <div class="tag-row">${(c.tags || []).map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div><div class="remark-md">${renderMarkdown(c.remark || t('暂无备注'))}</div>
        <div class="card-actions">${canEdit ? `<button class="tool-btn" data-edit="${c.id}">${t('编辑')}</button>` : ''}${canDelete ? `<button class="tool-btn danger" data-delete="${c.id}">${t('删除')}</button>` : ''}${canUse ? `<button class="btn btn-primary" data-connect="${c.id}">${t('连接')}</button>` : `<button class="btn btn-primary" disabled title="${t('仅观察')}">${t('只读')}</button>`}</div></article>`;
    }).join('') : connectionListEmptyHtml();
    renderRemoteServers(); renderJumpOptions();
}
function activityRangeBounds(range = activityRange) {
    const end = new Date();
    if (range === 'all') return { from: 0, to: 0, label: t('全部时间') };
    if (range === 'custom') {
        const startValue = $('#activityStartDate')?.value || '';
        const endValue = $('#activityEndDate')?.value || '';
        const from = startValue ? new Date(`${startValue}T00:00:00`).getTime() : 0;
        const to = endValue ? new Date(`${endValue}T23:59:59.999`).getTime() : 0;
        return { from, to, label: startValue || endValue ? `${startValue || t('最早')} 至 ${endValue || t('现在')}` : t('自定义范围') };
    }
    const fromDate = new Date(end);
    if (range === 'today') fromDate.setHours(0, 0, 0, 0);
    else fromDate.setDate(fromDate.getDate() - (range === '30d' ? 30 : 7));
    return { from: fromDate.getTime(), to: 0, label: range === 'today' ? t('今天') : (range === '30d' ? t('近 30 天') : t('近 7 天')) };
}
function activityDetails(activity) {
    const message = String(activity.message || t('未知活动'));
    const connection = connections.find((item) => message.includes(item.name) || activity.connectionId === item.id);
    const category = activity.category || (/登录|密码|TOTP|Passkey|用户/.test(message) ? t('账户') : (/连接|服务器|跳板机|代理|SSH 密钥/.test(message) ? t('连接') : (/设置|邮件|导入|日志/.test(message) ? t('系统') : t('操作'))));
    const outcome = activity.outcome || (/失败|拒绝|错误|超时/.test(message) ? t('失败') : t('成功'));
    const sourceIp = String(activity.sourceIp || '').trim();
    const protocol = activity.protocol || connection?.protocol || '';
    const target = activity.target || (connection ? `${connection.host}:${connection.port}` : '');
    return {
        category,
        outcome,
        actor: activity.actor || (activity.userId === myIdentity.userId ? t('当前用户') : (activity.userId || t('系统'))),
        protocol,
        target,
        sourceIp,
    };
}
function syncActivityRangeThumb({ instant = false } = {}) {
    const tabs = document.querySelector('.activity-range-tabs');
    if (!tabs) return;
    const thumb = tabs.querySelector('.activity-range-thumb');
    const active = tabs.querySelector('.activity-range-btn.active')
        || tabs.querySelector(`[data-activity-range="${activityRange}"]`)
        || tabs.querySelector('[data-activity-range]');
    if (!thumb || !active) return;
    if (instant) tabs.classList.add('no-thumb-transition');
    const x = active.offsetLeft;
    const w = active.offsetWidth;
    tabs.style.setProperty('--activity-thumb-x', `${Math.max(0, x)}px`);
    tabs.style.setProperty('--activity-thumb-w', `${Math.max(0, w)}px`);
    if (instant) {
        void thumb.offsetWidth;
        tabs.classList.remove('no-thumb-transition');
    }
}
function bindActivityRangeMotion() {
    if (!sshKeyMotion?._ensure) return;
    sshKeyMotion._ensure().then((Motion) => {
        if (!Motion?.press) return;
        document.querySelectorAll('.activity-range-tabs .activity-range-btn').forEach((btn) => {
            if (btn.dataset.motionPressBound === '1') return;
            Motion.press(btn, { scale: 0.965, preset: { response: 0.18, damping: 0.86 } });
            btn.dataset.motionPressBound = '1';
            btn.classList.add('motion-press-bound');
        });
    }).catch(() => {});
}

function previewActivityRangeSelection(btn) {
    if (!btn || btn.classList.contains('active')) return;
    const tabs = document.querySelector('.activity-range-tabs');
    if (!tabs || tabs.classList.contains('no-transition') || tabs.classList.contains('no-thumb-transition')) return;
    tabs.style.setProperty('--activity-thumb-x', `${Math.max(0, btn.offsetLeft)}px`);
    tabs.style.setProperty('--activity-thumb-w', `${Math.max(0, btn.offsetWidth)}px`);
}


let activityCustomRangeAnimGen = 0;
async function setActivityCustomRangeVisible(show, { animate = true } = {}) {
    const el = $('#activityCustomRange');
    if (!el) return;
    const wantOpen = !!show;
    const isHidden = el.classList.contains('force-hidden');
    if (wantOpen === !isHidden && !el.style.height) return;
    if (!animate || !sshKeyMotion?._ensure) {
        el.classList.toggle('force-hidden', !wantOpen);
        el.style.height = '';
        el.style.opacity = '';
        el.style.overflow = '';
        el.style.willChange = '';
        return;
    }
    const gen = ++activityCustomRangeAnimGen;
    try {
        const Motion = await sshKeyMotion._ensure();
        if (gen !== activityCustomRangeAnimGen) return;
        if (!Motion?.expand) {
            el.classList.toggle('force-hidden', !wantOpen);
            return;
        }
        await Motion.expand(el, {
            open: wantOpen,
            hiddenClass: 'force-hidden',
            duration: wantOpen ? 340 : 280,
            bezier: [0.32, 0.72, 0, 1],
        });
    } catch (err) {
        if (gen !== activityCustomRangeAnimGen) return;
        console.warn('[activity-custom-range] expand failed', err);
        el.classList.toggle('force-hidden', !wantOpen);
        el.style.height = '';
        el.style.opacity = '';
        el.style.overflow = '';
        el.style.willChange = '';
    }
}

function setActivityRangeSelection(range, { animate = true } = {}) {
    activityRange = range || '7d';
    $$('[data-activity-range]').forEach((item) => {
        item.classList.toggle('active', item.dataset.activityRange === activityRange);
    });
    const customRangeMotion = setActivityCustomRangeVisible(activityRange === 'custom', { animate });
    syncActivityRangeThumb({ instant: !animate });
    bindActivityRangeMotion();
    return customRangeMotion;
}
function renderActivities() {
    const list = $('#activityList');
    if (!list) return;
    const bounds = activityRangeBounds();
    $('#activityResultCount').textContent = t('{count} 条记录', { count: activities.length });
    $('#activityRangeLabel').textContent = bounds.label;
    const empty = `<div class="activity-empty"><strong>${t('此时间范围内没有活动')}</strong><span>${t('尝试扩大时间范围查看更早的记录。')}</span></div>`;
    if (!activities.length) {
        list.innerHTML = empty;
        requestAnimationFrame(() => syncActivityRangeThumb({ instant: true }));
        return;
    }
    const html = activities.map((activity, index) => {
        const detail = activityDetails(activity);
        const outcomeClass = detail.outcome === t('失败') ? 'failed' : 'success';
        const stagger = Math.min(index, 12) * 28;
        return `<article class="activity-detail-item" style="--activity-stagger:${stagger}ms">
            <div class="activity-detail-head">
                <div class="activity-event-mark" data-category="${escapeHtml(detail.category)}" aria-hidden="true"></div>
                <div class="activity-event-title"><h2>${escapeHtml(localizeActivityMessage(activity.message || t('未知活动')))}</h2><span class="activity-status ${outcomeClass}">${escapeHtml(detail.outcome)}</span></div>
                <time datetime="${new Date(Number(activity.time || 0)).toISOString()}">${escapeHtml(fmtTime(activity.time))}</time>
            </div>
            <dl class="activity-meta-grid">
                <div><dt>${t('事件类型')}</dt><dd>${escapeHtml(detail.category)}</dd></div>
                <div><dt>${t('操作者')}</dt><dd>${escapeHtml(detail.actor)}</dd></div>
                ${detail.protocol ? `<div><dt>${t('协议')}</dt><dd>${escapeHtml(detail.protocol)}</dd></div>` : ''}
                ${detail.target ? `<div><dt>${t('目标地址')}</dt><dd>${escapeHtml(detail.target)}</dd></div>` : ''}
                ${detail.sourceIp ? `<div><dt>${t('来源 IP')}</dt><dd>${escapeHtml(detail.sourceIp)}</dd></div>` : ''}
            </dl>
            <div class="activity-event-id"><span>${t('事件 ID')}</span><code>${escapeHtml(activity.id || '—')}</code></div>
        </article>`;
    }).join('');
    list.innerHTML = html;
    /* i18n / font load can change label widths — keep thumb under active chip. */
    requestAnimationFrame(() => syncActivityRangeThumb({ instant: true }));
}
async function loadActivities() {
    const generation = ++activitiesLoadGeneration;
    const { from, to } = activityRangeBounds();
    const params = new URLSearchParams();
    if (from) params.set('from', String(from));
    if (to) params.set('to', String(to));
    const data = await api(`/api/activities${params.size ? `?${params}` : ''}`);
    if (generation !== activitiesLoadGeneration) return activities;
    activities = data.activities || [];
    renderActivities();
    return activities;
}
async function loadConnections() {
    const generation = ++connectionsLoadGeneration;
    const data = await api('/api/connections');
    if (generation !== connectionsLoadGeneration) return connections;
    connections = data.connections || [];
    renderConnections();
    return connections;
}
function waitForConnectionCardExit(card, connectionId) {
    if (!card) return Promise.resolve();
    card.querySelectorAll('button').forEach((btn) => { btn.disabled = true; });
    card.classList.add('deleting');
    console.debug('[connection-card]', 'delete exit animation start', { connectionId });
    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            card.removeEventListener('animationend', finish);
            console.debug('[connection-card]', 'delete exit animation end', { connectionId });
            resolve();
        };
        card.addEventListener('animationend', finish, { once: true });
        window.setTimeout(finish, 380);
    });
}
function waitForMiniItemExit(item, itemId) {
    if (!item) return Promise.resolve();
    item.querySelectorAll('button').forEach((btn) => { btn.disabled = true; });
    item.classList.add('deleting');
    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            item.removeEventListener('animationend', finish);
            resolve();
        };
        item.addEventListener('animationend', finish, { once: true });
        window.setTimeout(finish, 380);
    });
}

function normalizeSelectedRouteIds(selected = '') {
    return Array.isArray(selected) ? selected.map(String).filter(Boolean) : String(selected || '').split(',').map((v) => v.trim()).filter(Boolean);
}
function normalizeRouteRowIds(selected = '') {
    const list = Array.isArray(selected) ? selected.map((v) => String(v || '')) : normalizeSelectedRouteIds(selected);
    return list.length ? list : [''];
}
function jumpConnectionOptions(selected = '') {
    const selectedId = String(selected || '');
    const currentEditingId = String(editingId || '');
    const list = connections.filter((c) => String(c.protocol || 'SSH').toUpperCase() === 'SSH' && String(c.id) !== currentEditingId);
    return `<option value="">${t('请选择跳板机')}</option>` + list.map((c) => `<option value="${c.id}" ${selectedId === String(c.id) ? 'selected' : ''}>${escapeHtml(c.name)} (${escapeHtml(c.host)}:${escapeHtml(c.port)})</option>`).join('');
}
function renderJumpRouteRows(selectedIds = []) {
    const list = normalizeRouteRowIds(selectedIds);
    $('#jumpRouteList').innerHTML = list.map((id, index) => `
        <div class="jump-route-row" data-jump-route-row>
            <label>${t('跳板机 {index}:', { index: index + 1 })}</label>
            <select data-jump-route-select>${jumpConnectionOptions(id)}</select>
            <button type="button" class="jump-route-remove" data-remove-jump-route title="${t('移除跳板机')}">×</button>
        </div>`).join('');
    console.debug('[route-ui]', 'render jump rows', { selectedIds: list, availableSshConnections: connections.filter((c) => String(c.protocol || 'SSH').toUpperCase() === 'SSH' && String(c.id) !== String(editingId || '')).length });
}
function setRouteMode(mode = 'direct', selected = '') {
    const nextMode = ['direct', 'proxy', 'jump'].includes(mode) ? mode : 'direct';
    $('#connMode').value = nextMode;
    $$('.route-type-tab').forEach((btn) => {
        const active = btn.dataset.routeMode === nextMode;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    $('#proxyRouteConfig')?.classList.toggle('force-hidden', nextMode !== 'proxy');
    $('#jumpRouteConfig')?.classList.toggle('force-hidden', nextMode !== 'jump');
    updateRouteOptions(nextMode, selected);
}
function renderSshKeyOptions(selected = '') {
    const select = $('#connSshKey');
    if (!select) return;
    const selectedId = String(selected || '');
    select.innerHTML = `<option value="">${t('不使用密钥库')}</option>` + sshKeys.map((k) => `<option value="${k.id}" ${selectedId === String(k.id) ? 'selected' : ''}>${escapeHtml(k.name)}${k.hasPassphrase ? t('（有口令）') : ''}</option>`).join('');
    select.value = selectedId;
    console.debug('[ssh-key-ui]', 'render connection key options', { selectedId, keyCount: sshKeys.length });
}

function updateRouteOptions(mode = $('#connMode').value, selected = '') {
    const selectedIds = normalizeSelectedRouteIds(selected);
    const route = $('#connRoute');
    if (route) {
        route.innerHTML = `<option value="">${t('请选择代理服务器')}</option>` + proxies.map((p) => `<option value="${p.id}" ${selectedIds.includes(String(p.id)) ? 'selected' : ''}>${escapeHtml(p.name)} (${escapeHtml(p.host)}:${escapeHtml(p.port)})</option>`).join('');
        route.value = mode === 'proxy' ? (selectedIds[0] || '') : '';
    }
    if (mode === 'jump') renderJumpRouteRows(selectedIds);
    console.debug('[route-ui]', 'update route options', { mode, selectedIds, proxyCount: proxies.length, connectionCount: connections.length });
}
function addJumpRouteRow() {
    const ids = $$('#jumpRouteList [data-jump-route-select]').map((el) => el.value);
    ids.push('');
    console.debug('[route-ui]', 'add jump row', { before: ids.slice(0, -1), after: ids });
    renderJumpRouteRows(ids);
}
function updateConnectionSecretRevealChrome(protocol = $('#connProtocol')?.value || 'SSH') {
    const revealGroup = $('#connSecretRevealGroup');
    const revealBtn = $('#revealConnSecrets');
    const hint = $('#connSecretRevealHint');
    const isSsh = String(protocol || 'SSH').toUpperCase() === 'SSH';
    const hasSavedSecret = !!editingId && (
        !!editingConnectionSecretState.hasPassword
        || (isSsh && (!!editingConnectionSecretState.hasPrivateKey || !!editingConnectionSecretState.sshKeyId))
    );
    revealGroup?.classList.toggle('force-hidden', !hasSavedSecret);
    if (revealBtn) revealBtn.textContent = isSsh ? t('查看已保存密码/私钥') : t('查看已保存密码');
    if (hint) hint.textContent = isSsh
        ? t('编辑时默认隐藏敏感信息；留空或保持星号不会覆盖已保存凭据。')
        : t('编辑时默认隐藏已保存密码；留空或保持星号不会覆盖已保存密码。');
}
function updateProtocolFields({ preservePort = true } = {}) {
    const protocol = String($('#connProtocol')?.value || 'SSH').toUpperCase();
    const portInput = $('#connPort');
    const usernameInput = $('#connUsername');
    const defaultPort = protocol === 'RDP' ? 3389 : protocol === 'VNC' ? 5900 : protocol === 'TELNET' ? 23 : 22;
    if (portInput && (!preservePort || !Number(portInput.value))) portInput.value = defaultPort;
    if (usernameInput) {
        usernameInput.required = protocol === 'SSH';
        usernameInput.placeholder = protocol === 'TELNET'
            ? t('用户名（可选，终端内认证）')
            : protocol === 'VNC'
                ? t('用户名（可选，取决于 VNC 服务）')
                : t('用户名');
    }
    $('#connSshKey')?.closest('.form-group')?.classList.toggle('force-hidden', protocol !== 'SSH');
    $('#connPrivateKey')?.closest('.form-group')?.classList.toggle('force-hidden', protocol !== 'SSH');
    // Telnet remains cleartext end-to-end, but its TCP transport can use the
    // same proxy or SSH jump route selector as SSH/RDP/VNC.
    // Password is kept visible for in-band auto-login (still plaintext on wire).
    $('#connPassword')?.closest('.form-group')?.classList.toggle('force-hidden', false);
    $('#connEncodingGroup')?.classList.toggle('force-hidden', protocol !== 'TELNET');
    $('#telnetPlaintextBanner')?.classList.toggle('force-hidden', protocol !== 'TELNET');
    $('#telnetUsernameHint')?.classList.toggle('force-hidden', protocol !== 'TELNET');
    $('#rdpSettingsPanel')?.classList.toggle('force-hidden', protocol !== 'RDP');
    $('#rdpDomainGroup')?.classList.toggle('force-hidden', protocol !== 'RDP');
    $('.advanced-route-panel')?.classList.remove('force-hidden');
    updateConnectionSecretRevealChrome(protocol);
    console.debug('[conn-protocol]', 'protocol fields updated', { protocol, defaultPort, usernameRequired: protocol === 'SSH' });
}
function setConnectionTestLatency(text = '', state = '') {
    const el = $('#connectionTestLatency');
    if (!el) return;
    el.textContent = text;
    el.dataset.state = state;
}
function isTransientConnectionMode(mode = connectionModalMode) {
    return mode === 'transient' || mode === 'ephemeral';
}

function setConnectionModalMode(mode = 'create', { source = 'dashboard', draft = null, token = '', ephemeral = false } = {}) {
    if (mode === 'transient') connectionModalMode = 'transient';
    else if (mode === 'ephemeral' || (mode === 'create' && ephemeral)) connectionModalMode = 'ephemeral';
    else if (mode === 'edit' || draft?.id) connectionModalMode = 'edit';
    else connectionModalMode = 'create';
    connectionModalSource = source || 'dashboard';
    transientToken = connectionModalMode === 'transient' ? String(token || '') : '';
    transientHasCredential = connectionModalMode === 'transient' && !!(draft?.hasTransientCredential);
    const form = $('#connectionForm');
    const isOneShot = isTransientConnectionMode(connectionModalMode);
    form?.classList.toggle('transient-mode', isOneShot);
    form?.setAttribute('data-mode', connectionModalMode);
    $('#transientToken') && ($('#transientToken').value = transientToken);
    const banner = $('#transientConnectionBanner');
    if (banner) {
        const showBanner = isOneShot;
        banner.classList.toggle('force-hidden', !showBanner);
        if (connectionModalMode === 'ephemeral') {
            banner.innerHTML = `<strong>${t('临时连接')}</strong><span>· ${t('本次参数不会保存到主机库，直接连接')}</span>`;
        } else if (connectionModalMode === 'transient') {
            banner.innerHTML = `<strong>${t('临时连接')}</strong><span>· ${t('本次参数不会保存到主机库')}</span>`;
        }
    }
    const ephemeralGroup = $('#connectionEphemeralGroup');
    if (ephemeralGroup) {
        const showToggle = connectionModalMode === 'create' || connectionModalMode === 'ephemeral';
        ephemeralGroup.classList.toggle('force-hidden', !showToggle);
    }
    const ephemeralToggle = $('#connEphemeral');
    if (ephemeralToggle) {
        ephemeralToggle.checked = connectionModalMode === 'ephemeral';
        ephemeralToggle.disabled = connectionModalMode === 'edit' || connectionModalMode === 'transient';
    }
    // Real share settings only — the top ephemeral toggle also uses
    // connection-share-group for identical card chrome and must stay visible.
    const shareGroup = document.querySelector('#connectionForm .connection-share-group:not(.connection-ephemeral-group)');
    if (shareGroup) shareGroup.classList.toggle('force-hidden', isOneShot);
    const cred = $('#transientCredentialState');
    if (cred) {
        cred.classList.toggle('force-hidden', !(connectionModalMode === 'transient' && transientHasCredential));
        cred.textContent = transientHasCredential ? t('已载入一次性凭据') : '';
    }
    const connectBtn = $('#connectTransientBtn');
    if (connectBtn) {
        connectBtn.disabled = false;
        connectBtn.title = connectionModalMode === 'ephemeral' ? t('使用当前表单参数直接连接，不会写入主机库') : '';
        connectBtn.textContent = t('连接');
    }
    // Name is only mandatory when persisting to the host library.
    if ($('#connName')) $('#connName').required = !isOneShot;
}

function applyEphemeralToggleFromUi() {
    if (connectionModalMode === 'edit' || connectionModalMode === 'transient') return;
    const on = !!$('#connEphemeral')?.checked;
    setConnectionModalMode(on ? 'ephemeral' : 'create', {
        source: connectionModalSource || 'dashboard',
        draft: null,
        token: '',
        ephemeral: on,
    });
    $('#modalTitle').textContent = on ? t('临时连接') : t('添加服务器');
    editingId = null;
    $('#connectionId') && ($('#connectionId').value = '');
}

function prepareConnectionModalForm(conn = null, options = {}) {
    const mode = options.mode || (conn?.id ? 'edit' : 'create');
    setConnectionModalMode(mode, {
        source: options.source || 'dashboard',
        draft: conn,
        token: options.transientToken || '',
        ephemeral: mode === 'ephemeral' || !!options.ephemeral,
    });
    editingId = isTransientConnectionMode(connectionModalMode) ? null : (conn?.id || null);
    editingSecretLoaded = false;
    editingConnectionSecretState = {
        hasPassword: !!conn?.hasPassword || !!(connectionModalMode === 'transient' && conn?.hasTransientCredential),
        hasPrivateKey: !!conn?.hasPrivateKey,
        sshKeyId: conn?.sshKeyId || '',
    };
    $('#modalTitle').textContent = isTransientConnectionMode(connectionModalMode)
        ? t('临时连接')
        : (editingId ? t('编辑服务器') : t('添加服务器'));
    $('#connectionId').value = editingId || '';
    setConnectionTestLatency();
    $('#connName').value = conn?.name || ''; $('#connProtocol').value = conn?.protocol || 'SSH'; $('#connHost').value = conn?.host || ''; $('#connPort').value = conn?.port || ($('#connProtocol').value === 'RDP' ? 3389 : $('#connProtocol').value === 'VNC' ? 5900 : $('#connProtocol').value === 'TELNET' ? 23 : 22); $('#connUsername').value = conn?.username || '';
    if ($('#connEncoding')) $('#connEncoding').value = conn?.encoding || 'utf-8';
    renderSshKeyOptions(conn?.sshKeyId || '');
    $('#connTags').value = (conn?.tags || []).join(', '); setRouteMode(conn?.connectionMode || 'direct', conn?.connectionMode === 'jump' ? (conn?.jumpHostIds || (conn?.jumpHostId ? [conn.jumpHostId] : [])) : (conn?.proxyId || ''));
    $('#connPassword').type = 'password'; $('#toggleConnPassword').textContent = '👁️';
    // Transient credentials must never be written as a readable DOM value.
    if (connectionModalMode === 'transient' && conn?.hasTransientCredential) {
        $('#connPassword').value = '';
        $('#connPassword').placeholder = t('已载入一次性凭据（可覆盖）');
    } else {
        $('#connPassword').placeholder = '';
        $('#connPassword').value = conn?.hasPassword ? '******' : '';
    }
    $('#connPrivateKey').value = conn?.hasPrivateKey ? '******' : '';
    $('#connRemark').value = conn?.remark || '';
    // Sharing flags (saved connections only)
    if ($('#connShareUsers')) $('#connShareUsers').checked = isTransientConnectionMode(connectionModalMode) ? false : !!conn?.shareWithUsers;
    if ($('#connShareAdmins')) $('#connShareAdmins').checked = isTransientConnectionMode(connectionModalMode) ? false : !!conn?.shareWithAdmins;
    /* RDP settings */
    if ($('#rdpSoundMode')) $('#rdpSoundMode').value = conn?.rdpSoundMode || 'local';
    if ($('#rdpClipboard')) $('#rdpClipboard').checked = conn?.rdpClipboard !== false;
    if ($('#rdpMicrophone')) $('#rdpMicrophone').checked = !!conn?.rdpMicrophone;
    if ($('#rdpLocation')) $('#rdpLocation').checked = !!conn?.rdpLocation;
    if ($('#rdpStorage')) $('#rdpStorage').checked = !!conn?.rdpStorage;
    if ($('#rdpCamera')) $('#rdpCamera').checked = !!conn?.rdpCamera;
    if ($('#rdpResolution')) $('#rdpResolution').value = conn?.rdpResolution || '1080p';
    if ($('#rdpQuality')) $('#rdpQuality').value = conn?.rdpQuality || 'balanced';
    if ($('#rdpFps')) $('#rdpFps').value = String(conn?.rdpFps || 30);
    if ($('#rdpTouchMode')) $('#rdpTouchMode').value = conn?.rdpTouchMode === 'relative' ? 'relative' : 'direct';
    if ($('#rdpTouchSensitivity')) $('#rdpTouchSensitivity').value = String(Math.max(0.5, Math.min(3, Number(conn?.rdpTouchSensitivity) || 1.5)));
    updateRdpTouchSettingsUi();
    if ($('#rdpDomain')) $('#rdpDomain').value = conn?.rdpDomain || '';
    updateProtocolFields({ preservePort: !!conn });
    // Connection/RDP selects: toggle-select so re-tap closes the menu.
    enhanceAllToggleSelects();
    ['connProtocol', 'connSshKey', 'connEncoding', 'connRoute', 'rdpSoundMode', 'rdpResolution', 'rdpQuality', 'rdpFps', 'rdpTouchMode'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) syncToggleSelectFace(el);
    });
}
function connectionScrimSet(open) {
    motionScrimSet('connectionModalScrim', 'connection1-blurring', open);
}
function stableConnectionSourceRect(trigger) {
    if (!trigger?.isConnected) return null;
    trigger.classList.remove('connection-pressing');
    const oldTransition = trigger.style.getPropertyValue('transition');
    const oldPriority = trigger.style.getPropertyPriority('transition');
    trigger.style.setProperty('transition', 'none', 'important');
    void trigger.offsetWidth;
    const r = trigger.getBoundingClientRect();
    if (oldTransition) trigger.style.setProperty('transition', oldTransition, oldPriority);
    else trigger.style.removeProperty('transition');
    return r.width > 2 && r.height > 2
        ? { left: r.left, top: r.top, width: r.width, height: r.height }
        : null;
}
function placeConnectionMotionSurface(surface, rect) {
    if (!surface || !rect) return;
    surface.style.left = `${rect.left}px`;
    surface.style.top = `${rect.top}px`;
    surface.style.width = `${rect.width}px`;
    surface.style.height = `${rect.height}px`;
}
function resetConnectionMotionProxy(Motion, modal, card, surface, trigger) {
    if (Motion) {
        try {
            if (trigger) Motion.restoreSource(trigger);
            Motion.restoreSources(surface);
            surface.querySelector?.(':scope > [data-motion-source-visual]')?.remove();
            Motion.release(surface);
            Motion.release(card);
        } catch {}
    } else if (trigger?.style) {
        trigger.style.opacity = '';
        trigger.style.pointerEvents = '';
        delete trigger.dataset.motionHidden;
    }
    surface.style.visibility = 'hidden';
    surface.style.pointerEvents = 'none';
    surface.style.transform = '';
    surface.style.opacity = '';
    surface.style.borderRadius = '';
    surface.style.left = '';
    surface.style.top = '';
    surface.style.width = '';
    surface.style.height = '';
    card.style.visibility = '';
    card.style.opacity = '';
    card.style.pointerEvents = '';
    card.style.position = '';
    card.style.zIndex = '';
    card.style.overflow = '';
    card.style.maxHeight = '';
    card.style.height = '';
    modal.classList.remove('show', 'closing', 'opening', 'app-visible', 'connection1');
    connectionModalMotion.phase = 'closed';
    connectionModalMotion.originRect = null;
    connectionModalMotion.targetRect = null;
    connectionModalMotion.trigger = null;
}
function openModal(conn = null, trigger = null, options = {}) {
    const modal = $('#connectionModal');
    const card = $('#connectionForm');
    const surface = $('#connectionMotionSurface');
    if (!modal || !card || !surface || connectionModalMotion.phase === 'open' || connectionModalMotion.phase === 'opening') return;
    const cycle = ++connectionModalCycle;
    const source = trigger || $('#addConnectionBtn');
    prepareConnectionModalForm(conn, options);
    connectionModalTrigger = source;
    connectionModalMotion.trigger = source;
    connectionModalMotion.originRect = stableConnectionSourceRect(source);
    connectionModalMotion.phase = 'opening';

    modal.classList.remove('closing');
    modal.classList.add('show', 'opening', 'connection1', 'app-visible');
    modal.setAttribute('aria-hidden', 'false');
    card.style.visibility = 'hidden';
    card.style.opacity = '0';
    card.style.pointerEvents = 'none';
    void card.offsetWidth;
    const target = card.getBoundingClientRect();
    connectionModalMotion.targetRect = { left: target.left, top: target.top, width: target.width, height: target.height };
    placeConnectionMotionSurface(surface, connectionModalMotion.targetRect);
    connectionScrimSet(true);

    sshKeyMotion._ensure().then((Motion) => {
        if (cycle !== connectionModalCycle || connectionModalMotion.phase !== 'opening') return;
        const origin = connectionModalMotion.originRect;
        if (!Motion || !origin) {
            card.style.visibility = 'visible';
            card.style.opacity = '1';
            card.style.pointerEvents = 'auto';
            surface.style.visibility = 'hidden';
            modal.classList.remove('opening');
            connectionModalMotion.phase = 'open';
            return;
        }
        try {
            Motion.stop(surface); Motion.release(surface);
            Motion.stop(card); Motion.release(card);
            surface.querySelector?.(':scope > [data-motion-source-visual]')?.remove();
        } catch {}
        surface.style.visibility = 'hidden';
        surface.style.pointerEvents = 'none';
        card.style.visibility = 'visible';
        // 内容只做独立 opacity 合成；尽早开放关闭按钮，使 opening 可被 close 反向打断。
        card.style.pointerEvents = 'auto';
        Motion.iosAppOpen(surface, source, {
            contentEl: card,
            scrim: null,
            home: null,
            cloneSource: true,
            hideSource: true,
            radiusFrom: sshKeyBtnRadius(source, origin),
            radiusTo: 22,
            contentDelay: 0.16,
            faceDelay: 0.05,
            faceInDelay: 0.04,
            shapePreset: 'shape',
            contentPreset: 'content',
        }).then((won) => {
            if (!won || cycle !== connectionModalCycle || connectionModalMotion.phase !== 'opening') return;
            modal.classList.remove('opening');
            // 与新建代理完全同源：卡片完整外展，唯一滚动面交给 backdrop。
            card.style.overflow = 'visible';
            card.style.maxHeight = 'none';
            card.style.height = 'auto';
            card.style.pointerEvents = 'auto';
            connectionModalMotion.phase = 'open';
            $('#connName')?.focus({ preventScroll: true });
        }).catch((err) => console.warn('[connection-motion-proxy] open failed', err));
    });
}
function closeModal() {
    const modal = $('#connectionModal');
    const card = $('#connectionForm');
    const surface = $('#connectionMotionSurface');
    if (!modal?.classList.contains('show') || connectionModalMotion.phase === 'closed' || connectionModalMotion.phase === 'closing') return;
    const trigger = connectionModalMotion.trigger || connectionModalTrigger;
    const origin = connectionModalMotion.originRect;
    const cycle = ++connectionModalCycle;
    connectionModalMotion.phase = 'closing';
    modal.classList.remove('opening', 'app-visible');
    modal.classList.add('closing');
    modal.setAttribute('aria-hidden', 'true');
    card.style.pointerEvents = 'none';

    transientToken = '';
    transientHasCredential = false;
    connectionModalMode = 'create';
    $('#transientToken') && ($('#transientToken').value = '');
    card.classList.remove('transient-mode');
    card.setAttribute('data-mode', 'create');
    if ($('#connEphemeral')) { $('#connEphemeral').checked = false; $('#connEphemeral').disabled = false; }
    if ($('#connName')) $('#connName').required = true;
    $('#connectionEphemeralGroup')?.classList.add('force-hidden');
    document.querySelector('#connectionForm .connection-share-group:not(.connection-ephemeral-group)')?.classList.remove('force-hidden');
    $('#connPassword') && ($('#connPassword').placeholder = '');
    const banner = $('#transientConnectionBanner');
    if (banner) {
        banner.classList.add('force-hidden');
        banner.innerHTML = `<strong>${t('临时连接')}</strong><span>· ${t('本次参数不会保存到主机库')}</span>`;
    }
    setConnectionTestLatency();
    closeAllToggleSelects();
    connectionScrimSet(false);

    const Motion = sshKeyMotion.engine;
    const finish = () => {
        if (cycle !== connectionModalCycle) return;
        if (Motion) {
            try { if (trigger) Motion.restoreSource(trigger); Motion.restoreSources(surface); } catch {}
        }
        void trigger?.offsetHeight;
        resetConnectionMotionProxy(Motion, modal, card, surface, trigger);
        connectionModalTrigger = null;
        requestAnimationFrame(() => trigger?.focus?.({ preventScroll: true }));
    };
    if (!Motion || !origin) { finish(); return; }
    const closed = Motion.iosAppClose(surface, origin, {
        contentEl: card,
        scrim: null,
        home: null,
        cloneSource: true,
        hideSource: false,
        restoreSource: false,
        hideSurface: false,
        clearSourceVisual: false,
        radiusTo: sshKeyBtnRadius(trigger, origin),
        faceInDelay: 0.04,
        shapePreset: 'shapeClose',
        contentPreset: 'contentClose',
    });
    const cap = new Promise((resolve) => window.setTimeout(resolve, 900));
    Promise.race([closed, cap]).then((won) => {
        if (won === false || cycle !== connectionModalCycle) return;
        requestAnimationFrame(finish);
    }).catch((err) => {
        console.warn('[connection-motion-proxy] close failed', err);
        finish();
    });
}
function updateRdpTouchSettingsUi() {
    const mode = $('#rdpTouchMode')?.value === 'relative' ? 'relative' : 'direct';
    const sensitivity = Math.max(0.5, Math.min(3, Number($('#rdpTouchSensitivity')?.value) || 1.5));
    const group = $('#rdpTouchSensitivityGroup');
    const input = $('#rdpTouchSensitivity');
    const output = $('#rdpTouchSensitivityValue');
    if (group) group.classList.toggle('rdp-range-disabled', mode !== 'relative');
    if (input) input.disabled = mode !== 'relative';
    if (output) output.textContent = `${sensitivity.toFixed(1)}×`;
}

function connectionPayload({ forTest = false } = {}) {
    const protocol = String($('#connProtocol').value || 'SSH').toUpperCase();
    const mode = $('#connMode').value || 'direct';
    const proxyId = mode === 'proxy' ? ($('#connRoute')?.value || '') : '';
    const jumpHostIds = mode === 'jump' ? [...new Set($$('#jumpRouteList [data-jump-route-select]').map((el) => el.value).filter(Boolean))] : [];
    const defaultPort = protocol === 'RDP' ? 3389 : protocol === 'VNC' ? 5900 : protocol === 'TELNET' ? 23 : 22;
    const payload = { name: $('#connName').value.trim(), protocol, host: $('#connHost').value.trim(), port: Number($('#connPort').value) || defaultPort, username: $('#connUsername').value.trim(), sshKeyId: protocol === 'SSH' ? ($('#connSshKey')?.value || '') : '', password: $('#connPassword').value, privateKey: protocol === 'SSH' ? $('#connPrivateKey').value : '', remark: $('#connRemark').value, tags: parseTags($('#connTags').value), connectionMode: mode, proxyId: mode === 'proxy' ? proxyId : '', jumpHostId: mode === 'jump' ? (jumpHostIds[0] || '') : '', jumpHostIds, shareWithUsers: !!$('#connShareUsers')?.checked, shareWithAdmins: !!$('#connShareAdmins')?.checked };
    if (protocol === 'TELNET') {
        payload.encoding = String($('#connEncoding')?.value || 'utf-8');
        payload.sshKeyId = '';
        payload.privateKey = '';
    }
    if (protocol === 'RDP') {
        payload.rdpSoundMode = $('#rdpSoundMode')?.value || 'local';
        payload.rdpClipboard = $('#rdpClipboard')?.checked !== false;
        payload.rdpMicrophone = !!$('#rdpMicrophone')?.checked;
        payload.rdpLocation = !!$('#rdpLocation')?.checked;
        payload.rdpStorage = !!$('#rdpStorage')?.checked;
        payload.rdpCamera = !!$('#rdpCamera')?.checked;
        payload.rdpResolution = $('#rdpResolution')?.value || '1080p';
        payload.rdpQuality = $('#rdpQuality')?.value || 'balanced';
        payload.rdpFps = Number($('#rdpFps')?.value) || 30;
        payload.rdpPipeline = 'worker-gpu-v2';
        payload.rdpTouchMode = $('#rdpTouchMode')?.value === 'relative' ? 'relative' : 'direct';
        payload.rdpTouchSensitivity = Math.max(0.5, Math.min(3, Number($('#rdpTouchSensitivity')?.value) || 1.5));
        payload.rdpDomain = ($('#rdpDomain')?.value || '').trim();
    }
    console.debug('[route-ui]', 'connection payload route', { mode, proxyId: payload.proxyId, jumpHostIds, sshKeyId: payload.sshKeyId });
    if (!forTest && editingId) { if (payload.password === '******') delete payload.password; if (payload.privateKey === '******') delete payload.privateKey; }
    return payload;
}
async function saveConnection(e) {
    e.preventDefault();
    // Hard guard: one-shot modes must never hit POST /api/connections.
    if (isTransientConnectionMode()) {
        if (connectionModalMode === 'ephemeral') {
            await connectEphemeral().catch((err) => toast(err.message || t('连接失败')));
            return;
        }
        toast(t('临时连接不会保存到主机库'));
        return;
    }
    const payload = connectionPayload();
    if (editingId) await api(`/api/connections/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/api/connections', { method: 'POST', body: JSON.stringify(payload) });
    closeModal();
    toast(t('连接已保存'));
    await loadConnections();
}
async function testConnection() {
    const btn = $('#testConnectionBtn');
    const connectBtn = $('#connectTransientBtn');
    const oldText = btn.textContent;
    btn.disabled = true;
    if (connectBtn) connectBtn.disabled = true;
    btn.textContent = t('测试中...');
    setConnectionTestLatency(t('测试中...'), 'pending');
    try {
        const payload = connectionPayload({ forTest: true });
        let result;
        if (connectionModalMode === 'transient') {
            if (!transientToken) throw new Error(t('临时凭据已失效，请重新打开链接'));
            const overrides = {
                name: payload.name, host: payload.host, port: payload.port,
                username: payload.username, protocol: payload.protocol,
            };
            const credentialOverride = {};
            if (payload.password && payload.password !== '******') credentialOverride.password = payload.password;
            if (payload.privateKey && payload.privateKey !== '******') credentialOverride.privateKey = payload.privateKey;
            result = await api(`/api/deeplinks/${encodeURIComponent(transientToken)}/test`, {
                method: 'POST',
                body: JSON.stringify({ overrides, credentialOverride, timeoutSeconds: 10 }),
            });
        } else {
            // create / edit / ephemeral all exercise the ad-hoc test path with form payload
            result = await api('/api/connections/test', {
                method: 'POST',
                body: JSON.stringify({
                    ...payload,
                    connectionId: connectionModalMode === 'ephemeral' ? '' : (editingId || ''),
                    timeoutSeconds: 10,
                }),
            });
        }
        setConnectionTestLatency(`连接延迟：${result.durationMs}ms`, 'success');
        toast(result.message || t('连接测试成功'));
    } catch (err) {
        setConnectionTestLatency(t('测试失败'), 'error');
        toast(err.message);
    } finally {
        btn.disabled = false;
        btn.textContent = oldText;
        if (connectBtn && isTransientConnectionMode()) {
            connectBtn.disabled = false;
        }
    }
}

function sanitizeCredentialValue(value) {
    const text = String(value || '');
    if (!text || text === '******') return '';
    return text;
}

/**
 * Temporary connect strategy (all protocols, including VNC):
 *  1) POST /api/connections with ephemeral:true  — row hidden from host library
 *  2) openConnection(id) — normal saved-connection path (VNC/RDP/SSH all work)
 *  3) tab.ephemeralConnectionId set so closeTerminalTab DELETEs the row
 * If open fails after create, the row is deleted immediately.
 */
async function openEphemeralSession(payload) {
    const protocol = String(payload.protocol || 'SSH').toUpperCase();
    if (!payload.host) throw new Error(t('主机不能为空'));
    if (protocol === 'SSH' && !payload.username) throw new Error(t('主机和用户名不能为空'));

    const createBody = {
        ...payload,
        name: String(payload.name || '').trim() || `${protocol} ${payload.host}`,
        // Never share a one-shot row into the library visibility graph.
        shareWithUsers: false,
        shareWithAdmins: false,
        ephemeral: true,
    };
    // Strip placeholder secrets so we don't store "******".
    if (createBody.password === '******') createBody.password = '';
    if (createBody.privateKey === '******') createBody.privateKey = '';

    const created = await api('/api/connections', {
        method: 'POST',
        body: JSON.stringify(createBody),
    });
    const connId = created?.connection?.id;
    if (!connId) throw new Error(t('临时连接创建失败'));

    try {
        // skipConnectionsReload: ephemeral rows are filtered server-side and
        // must not flash into the host grid even briefly.
        const tabId = await openConnection(connId, {
            skipConnectionsReload: true,
            forceNew: true,
        });
        const tab = terminalTabs.find((t) => t.id === tabId);
        if (tab) {
            tab.transient = true;
            tab.ephemeral = true;
            tab.ephemeralConnectionId = connId;
            if (!String(tab.name || '').includes(t('临时'))) {
                tab.name = `${tab.name || created.connection?.name || payload.host} · 临时`;
            }
        }
        // Open path already switched view / rendered tabs.
        scheduleWorkspaceSave?.('open-ephemeral-connection', { immediate: true });
        return tabId;
    } catch (err) {
        // Open failed — don't leave an orphan ephemeral row in the DB.
        try {
            await api(`/api/connections/${encodeURIComponent(connId)}`, { method: 'DELETE' });
        } catch (delErr) {
            console.warn('[ephemeral]', 'rollback delete failed', delErr);
        }
        throw err;
    }
}

async function disposeEphemeralConnection(connectionId, { reason = 'tab-close' } = {}) {
    const id = String(connectionId || '').trim();
    if (!id) return;
    try {
        await api(`/api/connections/${encodeURIComponent(id)}`, { method: 'DELETE' });
        console.info('[ephemeral]', 'deleted one-shot connection', { connectionId: id, reason });
    } catch (err) {
        // 404 is fine (already gone / GC'd). Anything else is logged only —
        // never block tab close on cleanup failure.
        if (!/404|不存在|not found/i.test(String(err?.message || ''))) {
            console.warn('[ephemeral]', 'delete failed', { connectionId: id, reason, error: err.message });
        }
    }
}

async function connectEphemeral() {
    if (connectionModalMode !== 'ephemeral') return;
    const btn = $('#connectTransientBtn');
    const testBtn = $('#testConnectionBtn');
    if (btn) { btn.disabled = true; btn.textContent = t('正在连接…'); }
    if (testBtn) testBtn.disabled = true;
    try {
        const payload = connectionPayload({ forTest: true });
        await openEphemeralSession(payload);
        closeModal();
        toast(t('正在建立临时连接…'));
    } catch (err) {
        toast(err.message || t('连接失败'));
        if (btn) { btn.disabled = false; btn.textContent = t('连接'); }
        if (testBtn) testBtn.disabled = false;
    }
}

async function connectTransient() {
    if (connectionModalMode === 'ephemeral') {
        await connectEphemeral();
        return;
    }
    if (connectionModalMode !== 'transient') return;
    if (!transientToken) {
        toast(t('临时凭据已失效，请重新打开链接'));
        return;
    }
    const btn = $('#connectTransientBtn');
    const testBtn = $('#testConnectionBtn');
    if (btn) { btn.disabled = true; btn.textContent = t('正在连接…'); }
    if (testBtn) testBtn.disabled = true;
    try {
        const payload = connectionPayload({ forTest: true });
        const token = transientToken;
        const overrides = {
            name: payload.name, host: payload.host, port: payload.port,
            username: payload.username, protocol: payload.protocol,
        };
        // Open a terminal tab that consumes the one-time token server-side.
        const tabId = `tab_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        const title = payload.name || `${payload.username || 'user'}@${payload.host}`;
        const sshParams = {
            transientToken: token,
            transientOverrides: overrides,
            host: payload.host,
            port: payload.port,
            username: payload.username,
            protocol: payload.protocol || 'SSH',
            // password/privateKey only if the user overrode the one-time credential
            password: (payload.password && payload.password !== '******') ? payload.password : '',
            privateKey: (payload.privateKey && payload.privateKey !== '******') ? payload.privateKey : '',
            init: '',
            tabId,
            embedded: !isCompactTerminalWorkspace(),
            timestamp: Date.now(),
            snippets: settings?.snippets || [],
            transient: true,
        };
        sessionStorage.setItem(`zephyr_ssh_params_${tabId}`, JSON.stringify(sshParams));
        const transientProto = String(payload.protocol || 'SSH').toUpperCase();
        terminalTabs.push({
            id: tabId,
            name: `${title} · 临时`,
            protocol: payload.protocol || 'SSH',
            status: 'connecting',
            iframe: true,
            page: transientProto === 'TELNET' ? 'telnet-terminal' : 'terminal',
            connectionId: '',
            transient: true,
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
            minimized: false,
        });
        openOrderStack.push(tabId);
        activeTerminalTab = tabId;
        touchTerminalSession?.(tabId);
        enforceTerminalWorkspaceLimit?.(tabId);
        // Consume path: clear local token handle before navigation so a double
        // click cannot reuse it even if the server race loses.
        transientToken = '';
        $('#transientToken') && ($('#transientToken').value = '');
        closeModal();
        renderTerminalTabs();
        switchView('terminal');
        renderTerminalTabs({ rebuildWorkspace: true });
        toast(t('正在建立临时连接…'));
    } catch (err) {
        toast(err.message || t('连接失败'));
        if (btn) { btn.disabled = false; btn.textContent = t('连接'); }
        if (testBtn) testBtn.disabled = false;
    }
}

async function openTransientFromUri(uri) {
    try {
        const prepared = await api('/api/deeplinks/prepare', { method: 'POST', body: JSON.stringify({ uri }) });
        openConnectionModal({
            mode: 'transient',
            source: 'note',
            draft: prepared.draft,
            transientToken: prepared.token,
        });
    } catch (err) {
        toast(err.message || t('无法打开临时连接'));
    }
}

function openConnectionModal({ mode = 'create', source = 'dashboard', draft = null, transientToken: token = '', trigger = null } = {}) {
    openModal(draft, trigger, { mode, source, transientToken: token });
}

async function openTransientFromToken(token) {
    try {
        const peeked = await api(`/api/deeplinks/${encodeURIComponent(token)}`);
        openConnectionModal({
            mode: 'transient',
            source: 'deeplink',
            draft: peeked.draft,
            transientToken: token,
        });
    } catch (err) {
        toast(err.message || t('临时凭据无效或已过期'));
    }
}

async function revealConnectionSecrets() {
    if (!editingId || editingSecretLoaded) return;
    const protocol = String($('#connProtocol')?.value || 'SSH').toUpperCase();
    const isSsh = protocol === 'SSH';
    const actionText = isSsh ? t('查看已保存连接密码/私钥') : t('查看已保存连接密码');
    const secret = await requestSensitiveSecret(actionText);
    const data = await api(`/api/connections/${editingId}/open`, { method: 'POST', body: JSON.stringify({ purpose: 'reveal', secret }) });
    $('#connPassword').value = data.connection?.password || '';
    if (isSsh) $('#connPrivateKey').value = data.connection?.privateKey || '';
    editingSecretLoaded = true;
    console.debug('[secret-open]', 'connection secrets loaded', { connectionId: editingId, protocol, hasPassword: !!data.connection?.password, hasPrivateKey: !!data.connection?.privateKey });
    toast(isSsh ? t('已载入保存的密码/私钥') : t('已载入保存的密码'));
}

function stableTerminalSessionId(connectionId, protocol = 'SSH') {
    const client = String(workspaceClientId || ensureWorkspaceClientId() || 'default').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'default';
    const conn = String(connectionId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'unknown';
    const proto = String(protocol || 'SSH').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'SSH';
    // Stable across refresh so the server can re-attach the live PTY + output buffer.
    return `sess_${proto}_${client}_${conn}`;
}

function rememberLastAppView(view = currentAppView) {
    if (!isSessionPersistenceEnabled()) return;
    try { localStorage.setItem('zephyr.lastView', String(view || 'dashboard')); } catch {}
}

function mountConnectionLocallyForCardFlip(connection, options = {}) {
    const c = connection;
    if (!c?.id) return null;
    const protocol = String(c.protocol || 'SSH').toUpperCase();
    const tabId = String(options.tabId || `tab_${Date.now()}_${Math.random().toString(16).slice(2)}`);
    if (terminalTabs.some((item) => item.id === tabId)) return tabId;
    if (protocol === 'RDP' || protocol === 'VNC') {
        sessionStorage.setItem(`zephyr_remote_desktop_params_${tabId}`, JSON.stringify({
            connectionId:c.id,name:c.name,host:c.host,port:c.port,username:c.username,protocol,tabId,sessionId:tabId,
            embedded:true,timestamp:Date.now(),rdpResolution:c.rdpResolution||'1080p',quality:c.rdpQuality||'balanced',
            rdpFps:Number(c.rdpFps||30),rdpPipeline:'worker-gpu-v2',rdpTouchMode:c.rdpTouchMode==='relative'?'relative':'direct',
            rdpTouchSensitivity:Math.max(.5,Math.min(3,Number(c.rdpTouchSensitivity)||1.5)),rdpSoundMode:c.rdpSoundMode||'local',
            rdpClipboard:c.rdpClipboard!==false,rdpDomain:c.rdpDomain||'',rdpMicrophone:!!c.rdpMicrophone,
            rdpLocation:!!c.rdpLocation,rdpStorage:!!c.rdpStorage,rdpCamera:!!c.rdpCamera,
        }));
        terminalTabs.push({id:tabId,name:c.name,protocol,status:'connecting',iframe:true,page:protocol==='VNC'?'novnc':'rdp',connectionId:c.id,sessionId:tabId,createdAt:Date.now(),lastUsedAt:Date.now(),minimized:false});
    } else {
        const page = protocol === 'TELNET' ? 'telnet-terminal' : 'terminal';
        sessionStorage.setItem(`zephyr_ssh_params_${tabId}`, JSON.stringify({connectionId:c.id,host:c.host,port:c.port,username:c.username,protocol,encoding:c.encoding||'utf-8',init:'',tabId,sessionId:tabId,embedded:!isCompactTerminalWorkspace(),timestamp:Date.now(),snippets:settings?.snippets||[]}));
        terminalTabs.push({id:tabId,name:c.name,protocol,status:'connecting',iframe:true,page,connectionId:c.id,sessionId:tabId,createdAt:Date.now(),lastUsedAt:Date.now(),minimized:false});
    }
    if (!openOrderStack.includes(tabId)) openOrderStack.push(tabId);
    activeTerminalTab = tabId;
    touchTerminalSession(tabId);
    enforceTerminalWorkspaceLimit(tabId);
    const workspace = $('#terminalWorkspace');
    if (workspace) {
        // Never hardcode a layout class here. Any already-visible window stays
        // in the workspace, so a fixed single-cell template auto-placed the
        // second window into an implicit ROW — that is the "stacked instead of
        // side-by-side" bug. renderTerminalWorkspace() is the single source of
        // truth for the layout-N class, slot-N placement and splitter tracks,
        // and it reuses existing window elements (live iframes are not
        // reloaded), so the already-open session keeps its PTY.
        renderTerminalWorkspace();
    }
    return tabId;
}

function rollbackLocallyMountedCardFlipTab(tabId) {
    terminalTabs = terminalTabs.filter((item) => item.id !== tabId);
    openOrderStack = openOrderStack.filter((item) => item !== tabId);
    visualLayout = visualLayout.filter((item) => item !== tabId);
    if (activeTerminalTab === tabId) activeTerminalTab = terminalTabs.at(-1)?.id || null;
    sessionStorage.removeItem(`zephyr_remote_desktop_params_${tabId}`);
    sessionStorage.removeItem(`zephyr_ssh_params_${tabId}`);
    renderTerminalTabs({rebuildWorkspace:true});
}

async function openConnection(id, options = {}) {
    const data = await api(`/api/connections/${id}/open`, { method: 'POST' }); const c = data.connection;
    const protocol = String(c.protocol || 'SSH').toUpperCase();
    // Restore path supplies a stable sessionId so refresh reattaches the live PTY.
    // Normal "连接" still opens a fresh tab unless the same session is already open.
    const preferredId = String(options.sessionId || options.tabId || '').trim();
    const tabId = preferredId || `tab_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const existing = terminalTabs.find((t) => t.id === tabId)
        || (preferredId ? terminalTabs.find((t) => t.sessionId === preferredId) : null)
        || (options.reuseOpenTab
            ? terminalTabs.find((t) => t.connectionId === c.id && !t.transient && String(t.protocol || '').toUpperCase() === protocol)
            : null);
    if (existing && !options.forceNew) {
        existing.minimized = false;
        if (preferredId) existing.sessionId = preferredId;
        activeTerminalTab = existing.id;
        touchTerminalSession(existing.id);
        renderTerminalTabs({ rebuildWorkspace: true });
        if (!options.skipViewSwitch) switchView('terminal');
        scheduleWorkspaceSave('reopen-existing-tab', { immediate: true });
        return existing.id;
    }
    if (protocol === 'RDP' || protocol === 'VNC') {
        sessionStorage.setItem(`zephyr_remote_desktop_params_${tabId}`, JSON.stringify({ connectionId: c.id, name: c.name, host: c.host, port: c.port, username: c.username, protocol, tabId, sessionId: tabId, embedded: true, timestamp: Date.now(), rdpResolution: c.rdpResolution || '1080p', quality: c.rdpQuality || 'balanced', rdpFps: Number(c.rdpFps || 30), rdpPipeline: 'worker-gpu-v2', rdpTouchMode: c.rdpTouchMode === 'relative' ? 'relative' : 'direct', rdpTouchSensitivity: Math.max(0.5, Math.min(3, Number(c.rdpTouchSensitivity) || 1.5)), rdpSoundMode: c.rdpSoundMode || 'local', rdpClipboard: c.rdpClipboard !== false, rdpDomain: c.rdpDomain || '', rdpMicrophone: !!c.rdpMicrophone, rdpLocation: !!c.rdpLocation, rdpStorage: !!c.rdpStorage, rdpCamera: !!c.rdpCamera }));
        terminalTabs.push({ id: tabId, name: c.name, protocol, status: 'connecting', iframe: true, page: protocol === 'VNC' ? 'novnc' : 'rdp', connectionId: c.id, sessionId: tabId, createdAt: Date.now(), lastUsedAt: Date.now(), minimized: false, snapshotText: options.snapshotText || '', workspaceState: options.workspaceState || null });
        console.debug(protocol === 'VNC' ? '[novnc-client]' : '[rdp-client]', 'open remote desktop tab', { protocol, tabId, connectionId: c.id, host: c.host, port: c.port });
    } else {
        // SSH → terminal.html; TELNET → telnet-terminal.html (no SFTP/Docker/stats UI).
        const page = protocol === 'TELNET' ? 'telnet-terminal' : 'terminal';
        const sshParams = {
            connectionId: c.id,
            host: c.host,
            port: c.port,
            username: c.username,
            protocol,
            encoding: c.encoding || 'utf-8',
            init: '',
            tabId,
            sessionId: tabId,
            embedded: !isCompactTerminalWorkspace(),
            timestamp: Date.now(),
            snippets: settings?.snippets || [],
        };
        sessionStorage.setItem(`zephyr_ssh_params_${tabId}`, JSON.stringify(sshParams));
        terminalTabs.push({ id: tabId, name: c.name, protocol, status: 'connecting', iframe: true, page, connectionId: c.id, sessionId: tabId, createdAt: Date.now(), lastUsedAt: Date.now(), minimized: false, snapshotText: options.snapshotText || '', workspaceState: options.workspaceState || null });
    }
    if (!openOrderStack.includes(tabId)) openOrderStack.push(tabId);
    activeTerminalTab = tabId;
    touchTerminalSession(tabId);
    enforceTerminalWorkspaceLimit(tabId);
    renderTerminalTabs();
    if (!options.skipViewSwitch) switchView('terminal');
    renderTerminalTabs({ rebuildWorkspace: true });
    if (isCompactTerminalWorkspace() && document.body.classList.contains('terminal-custom-fullscreen-open')) {
        window.setTimeout(() => renderTerminalTabs({ rebuildWorkspace: true }), 80);
    }
    if (!options.skipConnectionsReload) await loadConnections();
    scheduleWorkspaceSave('open-connection', { immediate: true });
    return tabId;
}
function openPlaceholderTab(c) {
    const tabId = `tab_${Date.now()}`;
    terminalTabs.push({ id: tabId, name: c.name, protocol: c.protocol, status: t('占位'), iframe: false, createdAt: Date.now(), lastUsedAt: Date.now(), minimized: false });
    openOrderStack.push(tabId);
    activeTerminalTab = tabId;
    touchTerminalSession(tabId);
    enforceTerminalWorkspaceLimit(tabId);
    renderTerminalTabs();
    switchView('terminal');
}

function detectInteractionEnvironment() {
    const ua = String(navigator.userAgent || '').toLowerCase();
    const mobileUA = /android|iphone|ipod|blackberry|iemobile|opera mini/i.test(ua);
    const iPadOS = navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;
    const width = window.innerWidth || document.documentElement.clientWidth || 0;
    const height = window.innerHeight || document.documentElement.clientHeight || 0;
    const smallScreen = Math.min(width, height) <= 820;
    const touch = 'ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0;
    const coarse = window.matchMedia?.('(pointer: coarse)')?.matches || false;
    const hover = window.matchMedia?.('(hover: hover)')?.matches || false;
    const platform = String(navigator.platform || '').toLowerCase();
    const desktopPlatform = /win|mac|linux/.test(platform);
    let mobileScore = 0;
    if (mobileUA) mobileScore += 3;
    if (iPadOS) mobileScore += 3;
    if (smallScreen) mobileScore += 2;
    if (touch) mobileScore += 1;
    if (coarse) mobileScore += 2;
    if (!hover) mobileScore += 1;
    let desktopScore = 0;
    if (desktopPlatform) desktopScore += 2;
    if (hover) desktopScore += 2;
    if (!coarse) desktopScore += 1;
    if (!smallScreen) desktopScore += 2;
    let type = mobileScore >= desktopScore ? 'mobile' : 'desktop';
    let category = type === 'mobile' ? (width >= 768 ? 'tablet' : 'phone') : 'desktop';
    if (category === 'tablet') type = 'desktop';
    return { type, category, width, height, touch, coarse, hover, platform, ua, mobileScore, desktopScore };
}
function isPhoneLikeEnvironment() {
    const env = detectInteractionEnvironment();
    const explicitPhoneUA = /android.*mobile|iphone|ipod|blackberry|iemobile|opera mini/i.test(env.ua);
    const desktopClassInput = env.hover && !env.coarse;
    if (desktopClassInput) return false;
    return explicitPhoneUA && env.coarse && Math.min(env.width, env.height) <= 700;
}

function isCompactTerminalWorkspace() { return isPhoneLikeEnvironment(); }
function getConfiguredTerminalMaxWindows() {
    const value = Number(settings?.terminal?.maxWindows || localStorage.getItem('zephyr-terminal-max-windows') || 3);
    return Math.min(3, Math.max(1, Number.isFinite(value) ? value : 3));
}
function getConfiguredMinimizedKeepAlive() {
    const raw = settings?.terminal?.minimizedKeepAlive ?? localStorage.getItem('zephyr-terminal-minimized-keepalive') ?? 0;
    const value = Number(raw);
    if (!Number.isFinite(value)) return 0;
    if (value === -1) return -1;
    return Math.max(0, Math.floor(value));
}
function getTerminalSmartbarOrder() {
    const value = settings?.terminal?.smartbarOrder || localStorage.getItem('zephyr-terminal-smartbar-order') || 'old-first';
    if (value === 'new-left' || value === 'new-first') return 'new-first';
    return 'old-first';
}

function getTerminalShortcutPlatform() {
    const value = settings?.terminal?.shortcutPlatform || localStorage.getItem('zephyr-shortcut-platform') || 'auto';
    return ['auto', 'windows', 'mac'].includes(value) ? value : 'auto';
}
function getEffectiveTerminalMaxWindows() { return isCompactTerminalWorkspace() ? 1 : getConfiguredTerminalMaxWindows(); }
function getTerminalSession(id) { return terminalTabs.find((t) => t.id === id); }
function visibleTerminalTabs() { return terminalTabs.filter((t) => !t.minimized && !closingTerminalTabs.has(t.id)); }
function terminalShortName(name = '') { const s = String(name || 'Terminal'); return s.length > 6 ? `${s.slice(0, 6)}…` : s; }
function terminalInitials(name = '') {
    const parts = String(name || 'T').trim().split(/[\s._-]+/).filter(Boolean);
    const raw = parts.length > 1 ? parts.slice(0, 2).map((x) => x[0]).join('') : (parts[0] || 'T').slice(0, 2);
    return raw.toUpperCase();
}
function escapeSvgText(str) { return String(str || '').replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m])); }
// SMARTBAR_TEXT_IMAGE_CACHE is initialized near the top of the module because applyTheme() runs during init.
function smartbarTextThemeColor(kind = 'label') {
    if (kind === 'plus') return '#0969da';
    const theme = document.documentElement.getAttribute('data-theme') || getPreferredTheme();
    if (kind === 'initials') return theme === 'dark' ? '#f0f6fc' : '#1f2328';
    return theme === 'dark' ? '#f0f6fc' : '#24292f';
}
function smartbarTextMeasureContext(font) {
    const canvas = smartbarTextMeasureContext.canvas || (smartbarTextMeasureContext.canvas = document.createElement('canvas'));
    const ctx = canvas.getContext('2d');
    ctx.font = font;
    return ctx;
}
function measureSmartbarText(text, font) {
    return smartbarTextMeasureContext(font).measureText(String(text || '')).width;
}
function fitSmartbarTextToWidth(text, maxWidth, font) {
    const raw = String(text || '').replace(/\s+/g, ' ').trim() || 'Terminal';
    if (measureSmartbarText(raw, font) <= maxWidth) return raw;
    const chars = Array.from(raw);
    let lo = 0, hi = chars.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (measureSmartbarText(`${chars.slice(0, mid).join('')}…`, font) <= maxWidth) lo = mid;
        else hi = mid - 1;
    }
    return `${chars.slice(0, Math.max(1, lo)).join('')}…`;
}
function smartbarSvgDataUrl(svg) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
function smartbarTextImage(text, { kind = 'label', maxWidth = 82, width = null, height = null, fontSize = 11, fontWeight = 700, letterSpacing = 0 } = {}) {
    const fontFamily = '-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
    const canvasFont = `${fontWeight} ${fontSize}px ${fontFamily}`;
    const rawText = String(text || (kind === 'initials' ? 'T' : 'Terminal')).trim() || (kind === 'initials' ? 'T' : 'Terminal');
    const fittedText = kind === 'label' ? fitSmartbarTextToWidth(rawText, maxWidth, canvasFont) : rawText;
    const measuredWidth = Math.ceil(measureSmartbarText(fittedText, canvasFont));
    const cssWidth = width || Math.min(maxWidth, Math.max(kind === 'initials' ? 42 : 8, measuredWidth + (kind === 'label' ? 2 : 0)));
    const cssHeight = height || (kind === 'initials' ? 30 : 14);
    const color = smartbarTextThemeColor(kind);
    const cacheKey = [kind, fittedText, cssWidth, cssHeight, fontSize, fontWeight, letterSpacing, color].join('|');
    const cached = SMARTBAR_TEXT_IMAGE_CACHE.get(cacheKey);
    if (cached) return cached;
    const scale = Math.min(3, Math.max(2, Math.ceil(window.devicePixelRatio || 1)));
    const viewWidth = Math.ceil(cssWidth * scale);
    const viewHeight = Math.ceil(cssHeight * scale);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${viewWidth}" height="${viewHeight}" viewBox="0 0 ${viewWidth} ${viewHeight}"><text x="50%" y="52%" text-anchor="middle" dominant-baseline="central" font-family="${fontFamily}" font-size="${fontSize * scale}" font-weight="${fontWeight}" letter-spacing="${letterSpacing * scale}" fill="${color}">${escapeSvgText(fittedText)}</text></svg>`;
    const image = { src: smartbarSvgDataUrl(svg), width: cssWidth, height: cssHeight, text: fittedText };
    SMARTBAR_TEXT_IMAGE_CACHE.set(cacheKey, image);
    return image;
}
function smartbarPlusImage() {
    const color = smartbarTextThemeColor('plus');
    const cacheKey = `plus|${color}`;
    const cached = SMARTBAR_TEXT_IMAGE_CACHE.get(cacheKey);
    if (cached) return cached;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60" viewBox="0 0 60 60"><path d="M30 12v36M12 30h36" stroke="${color}" stroke-width="7" stroke-linecap="round"/></svg>`;
    const image = { src: smartbarSvgDataUrl(svg), width: 30, height: 30, text: '+' };
    SMARTBAR_TEXT_IMAGE_CACHE.set(cacheKey, image);
    return image;
}
function smartbarImageHtml(image, className) {
    return `<span class="${className} smartbar-rendered-image" style="width:${image.width}px;height:${image.height}px;background-image:url(&quot;${escapeHtml(image.src)}&quot;)" aria-hidden="true"></span>`;
}
function smartbarSessionInitialsHtml(name) { return smartbarImageHtml(smartbarTextImage(terminalInitials(name), { kind: 'initials', maxWidth: 46, width: 46, height: 30, fontSize: 20, fontWeight: 900, letterSpacing: .2 }), 'smartbar-session-initials-img'); }
function smartbarSessionLabelHtml(name) { return smartbarImageHtml(smartbarTextImage(name || 'Terminal', { kind: 'label', maxWidth: 82, height: 14, fontSize: 11, fontWeight: 700 }), 'smartbar-session-label-img'); }
function smartbarPlusHtml() { return `<span class="smartbar-add-icon">${smartbarImageHtml(smartbarPlusImage(), 'smartbar-plus-img')}</span>`; }
function touchTerminalSession(id) { const t = getTerminalSession(id); if (t) t.lastUsedAt = Date.now(); recentUseStack = [id, ...recentUseStack.filter((x) => x !== id)].filter((x) => getTerminalSession(x)); }
function orderedVisibleIds() { return openOrderStack.filter((id) => visibleTerminalTabs().some((t) => t.id === id)); }
function computeDefaultVisualLayout() {
    const ids = orderedVisibleIds();
    if (ids.length <= 2) return ids;
    return [ids[ids.length - 1], ids[1], ids[0]].filter(Boolean);
}
function syncVisualLayout({ preserve = true } = {}) {
    const visibleIds = orderedVisibleIds();
    if (!preserve || !visualLayout.length) visualLayout = computeDefaultVisualLayout();
    else visualLayout = [...visualLayout.filter((id) => visibleIds.includes(id)), ...visibleIds.filter((id) => !visualLayout.includes(id))];
    if (visibleIds.length === 3 && (!preserve || visualLayout.length !== 3)) visualLayout = computeDefaultVisualLayout();
    if (!activeTerminalTab || !getTerminalSession(activeTerminalTab) || getTerminalSession(activeTerminalTab)?.minimized) activeTerminalTab = visualLayout[0] || visibleIds[0] || terminalTabs[0]?.id || null;
}
function minimizeTerminalSession(id, { activateNext = true, animated = true } = {}) {
    const t = getTerminalSession(id); if (!t) return;
    resetTerminalWorkspaceKeyboard({ force: true });
    if (animated && !t.minimized && !minimizingTerminalTabs.has(id)) {
        minimizingTerminalTabs.add(id);
        renderTerminalTabs({ rebuildWorkspace: false });
        window.setTimeout(() => {
            minimizingTerminalTabs.delete(id);
            minimizeTerminalSession(id, { activateNext, animated: false });
            renderTerminalTabs();
        }, 260);
        return;
    }
    t.minimized = true;
    visualLayout = visualLayout.filter((x) => x !== id);
    if (activeTerminalTab === id && activateNext) activeTerminalTab = visualLayout[0] || orderedVisibleIds()[0] || terminalTabs.find((x) => !x.minimized)?.id || terminalTabs[0]?.id || null;
    syncVisualLayout({ preserve: false });
}
function restoreTerminalSession(id) {
    const t = getTerminalSession(id); if (!t) return;
    t.minimized = false;
    activeTerminalTab = id;
    touchTerminalSession(id);
    enforceTerminalWorkspaceLimit(id);
}
function showTerminalSessionInWorkspace(id) {
    const t = getTerminalSession(id); if (!t) return;
    resetTerminalWorkspaceKeyboard({ force: true });
    t.minimized = false;
    activeTerminalTab = id;
    touchTerminalSession(id);
    const maxWindows = getEffectiveTerminalMaxWindows();
    if (maxWindows <= 1) {
        terminalTabs.forEach((item) => { if (item.id !== id) item.minimized = true; });
        visualLayout = [id];
    } else {
        const visibleIds = orderedVisibleIds();
        if (!visualLayout.includes(id)) visualLayout.push(id);
        while (visibleTerminalTabs().length > maxWindows) {
            const victimId = visualLayout.find((itemId) => itemId !== id);
            if (!victimId) break;
            const victim = getTerminalSession(victimId);
            if (victim) victim.minimized = true;
            visualLayout = visualLayout.filter((itemId) => itemId !== victimId);
        }
        const stillVisibleIds = orderedVisibleIds();
        visualLayout = [...visualLayout.filter((itemId) => stillVisibleIds.includes(itemId)), ...visibleIds.filter((itemId) => !visualLayout.includes(itemId) && stillVisibleIds.includes(itemId))];
        if (!visualLayout.includes(id)) visualLayout.push(id);
        visualLayout = visualLayout.slice(-maxWindows);
    }
    if (!visualLayout.includes(id)) visualLayout = [id, ...visualLayout].slice(0, maxWindows);
    syncVisualLayout({ preserve: true });
}
function enforceTerminalWorkspaceLimit(newId) {
    const maxWindows = getEffectiveTerminalMaxWindows();
    if (maxWindows <= 1) {
        terminalTabs.forEach((t) => { if (t.id !== newId) t.minimized = true; });
    } else {
        while (visibleTerminalTabs().length > maxWindows) {
            const oldestVisible = openOrderStack.find((id) => id !== newId && getTerminalSession(id) && !getTerminalSession(id).minimized);
            if (!oldestVisible) break;
            minimizeTerminalSession(oldestVisible, { activateNext: false, animated: false });
        }
    }
    syncVisualLayout({ preserve: false });
}
function terminalProtocolClass(protocol) { return String(protocol || 'SSH').toLowerCase(); }
function positionSmartbarPicker() {
    const smartbar = $('#sessionTabs');
    const picker = document.querySelector('#smartbarPickerLayer .smartbar-picker');
    const addButton = smartbar?.querySelector('[data-smartbar-add]');
    if (!smartbar || !picker || !addButton) return;
    const viewport = window.visualViewport;
    const vvLeft = viewport?.offsetLeft || 0;
    const vvTop = viewport?.offsetTop || 0;
    const vvWidth = viewport?.width || window.innerWidth;
    const vvHeight = viewport?.height || window.innerHeight;
    const margin = 14;
    const addRect = addButton.getBoundingClientRect();
    const mobileFullscreen = isCompactTerminalWorkspace() && document.body.classList.contains('terminal-custom-fullscreen-open');
    const targetWidth = mobileFullscreen
        ? Math.min(340, Math.max(240, vvWidth - margin * 2))
        : Math.min(360, Math.max(300, vvWidth - margin * 2));
    const anchorX = addRect.left + addRect.width / 2;
    const desiredLeft = mobileFullscreen ? addRect.right + 12 : anchorX - targetWidth / 2;
    const left = Math.min(Math.max(desiredLeft, vvLeft + margin), vvLeft + vvWidth - targetWidth - margin);
    const preferredTop = mobileFullscreen ? Math.round(addRect.top) : Math.round(addRect.bottom + 14);
    const maxTop = vvTop + Math.max(margin, vvHeight - 280 - margin);
    const top = Math.min(Math.max(preferredTop, vvTop + margin), maxTop);
    const arrowLeft = Math.min(targetWidth - 20, Math.max(20, anchorX - left));
    picker.style.width = `${targetWidth}px`;
    picker.style.setProperty('--smartbar-picker-left', `${left}px`);
    picker.style.setProperty('--smartbar-picker-top', `${top}px`);
    picker.style.setProperty('--smartbar-picker-arrow-left', `${arrowLeft}px`);
    picker.style.setProperty('--smartbar-picker-origin-x', `${arrowLeft}px`);
}
function renderTerminalSmartbar() {
    const order = getTerminalSmartbarOrder();
    const orderedIds = order === 'new-first' ? [...openOrderStack].reverse() : [...openOrderStack];
    const seen = new Set();
    const sessions = orderedIds.map(getTerminalSession).filter(Boolean).filter((t) => {
        if (seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
    });
    const icon = (t, index) => `<button class="smartbar-session ${t.id === activeTerminalTab ? 'active' : ''} ${t.minimized ? 'minimized' : ''}" style="--dock-index:${index}" data-smartbar-tab="${t.id}" title="${escapeHtml(t.protocol)} · ${escapeHtml(t.name)} · ${escapeHtml(t.status)}" aria-label="${escapeHtml(t.name || 'Terminal')}"><span class="smartbar-session-icon"><span class="proto-dot ${terminalProtocolClass(t.protocol)}"></span>${smartbarSessionInitialsHtml(t.name)}</span><span class="smartbar-session-label" aria-hidden="true">${smartbarSessionLabelHtml(t.name || 'Terminal')}</span></button>`;
    const launchableConnections = connections.filter((c) => ['SSH', 'RDP', 'VNC'].includes(String(c.protocol || 'SSH').toUpperCase()));
    const picker = terminalSmartbarPickerOpen ? `
        <div class="smartbar-picker" role="dialog" aria-label="${t('选择服务器连接')}">
            <div class="smartbar-picker-head"><strong>${t('选择服务器')}</strong><button data-smartbar-picker-close title="${t('关闭')}">×</button></div>
            <div class="smartbar-picker-list">
                ${launchableConnections.length ? launchableConnections.map((c) => `<button data-smartbar-connect="${c.id}"><span class="proto-dot ${terminalProtocolClass(c.protocol)}"></span><strong>${escapeHtml(c.name)}</strong><em>${escapeHtml(c.protocol)} · ${escapeHtml(c.host)}:${escapeHtml(c.port)}</em></button>`).join('') : `<div class="smartbar-empty">${t('暂无 SSH/RDP/VNC 服务器')}</div>`}
            </div>
        </div>` : '';
    const pickerMount = document.getElementById('smartbarPickerLayer') || (() => {
        const el = document.createElement('div');
        el.id = 'smartbarPickerLayer';
        document.body.appendChild(el);
        return el;
    })();
    pickerMount.innerHTML = picker;
    const smartbarRoot = $('#sessionTabs');
    if (!smartbarRoot) return;
    syncTerminalSmartbarTop();
    smartbarRoot.className = `terminal-smartbar ${terminalSmartbarOpen ? 'open' : ''} ${terminalSmartbarClosing ? 'closing' : ''}`;
    syncTerminalShelfLineState();
    smartbarRoot.innerHTML = `
        <button class="smartbar-handle" data-smartbar-toggle title="${t('展开/收回 Dock')}"><span></span></button>
        <div class="smartbar-panel">
            <div class="smartbar-dock" aria-label="${t('终端 Dock')}">
                ${sessions.map(icon).join('') || `<span class="smartbar-empty">${t('暂无会话')}</span>`}
                <button class="smartbar-add" style="--dock-index:${sessions.length}" data-smartbar-add title="${t('选择服务器连接')}" aria-label="${t('选择服务器连接')}">${smartbarPlusHtml()}</button>
            </div>
        </div>`;
    requestAnimationFrame(() => {
        const nav = $('.main-nav');
        const smartbar = $('#sessionTabs');
        const panel = smartbar?.querySelector('.smartbar-panel');
        if (!nav || !smartbar || !panel) return;
        syncTerminalSmartbarTop();
        syncTerminalShelfLineState();
        positionSmartbarPicker();
    });
}
function terminalWindowMenu(session) {
    const maxWindows = getEffectiveTerminalMaxWindows();
    const visibleCount = visibleTerminalTabs().length;
    const compact = isCompactTerminalWorkspace();
    const workspace = $('#terminalWorkspace');
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
    const winFullscreen = fullscreenElement?.classList?.contains('terminal-window') || fullscreenElement === workspace;
    const customFullscreen = workspace?.classList.contains('custom-fullscreen');
    const fullscreenItem = (customFullscreen || winFullscreen) ? ['exit-fullscreen', t('退出全屏')] : ['fullscreen', t('全屏')];
    let items;
    if (maxWindows <= 1 || visibleCount <= 1) {
        items = compact ? [fullscreenItem, ['reconnect-mobile', t('重连')], ['minimize', t('最小化')], ['close', t('关闭')]] : [['minimize', t('最小化')], ['close', t('关闭')]];
    } else if (maxWindows === 2 || visibleCount === 2) {
        items = [fullscreenItem, ['left-half', t('左半屏')], ['right-half', t('右半屏')], ['minimize', t('最小化')], ['close', t('关闭')]];
    } else {
        items = [fullscreenItem, ['left-half', t('左半屏')], ['right-half', t('右半屏')], ['right-top', t('右侧 1/3 上半部')], ['right-bottom', t('右侧 1/3 下半部')], ['left-two-thirds', t('左侧 2/3')], ['right-two-thirds', t('右侧 2/3')], ['minimize', t('最小化')], ['close', t('关闭')]];
    }
    return `<div class="terminal-window-menu" role="menu" style="--island-action-count:${items.length}">${items.map(([action, label]) => `<button data-window-action="${action}" data-window="${session.id}" title="${label}" aria-label="${label}">${label}</button>`).join('')}</div>`;
}
function terminalWindowTitlebarHtml(session) {
    return `<button class="terminal-grip terminal-window-center-dots" data-window-control="${session.id}" title="${t('短按打开窗口操作，长按拖动交换位置')}" aria-label="${t('窗口操作与拖动')}"><span></span></button><button class="mobile-fullscreen-dock-toggle" data-mobile-dock-toggle data-smartbar-toggle title="${t('展开/收回移动端 Dock')}" aria-label="${t('展开/收回移动端 Dock')}"><span></span></button><span class="proto-dot ${terminalProtocolClass(session.protocol)}"></span><strong>${escapeHtml(terminalShortName(session.name))}</strong>${terminalWindowMenu(session)}`;
}
function positionTerminalWindowMenu(titlebar, { collapsed = false, force = false } = {}) {
    if (!force && !titlebar?.classList.contains('menu-open')) return;
    const button = titlebar.querySelector('[data-window-control]');
    const menu = titlebar.querySelector('.terminal-window-menu');
    if (!button || !menu) return;
    const titleRect = titlebar.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();

    // 竖向“岛内列表”：保持原来的上下排列，但仍从三个点的几何中心连续膨胀出来，避免横向超出窗口。
    const islandCenterX = buttonRect.left + buttonRect.width / 2;
    const islandCenterY = buttonRect.top + buttonRect.height / 2;
    const itemCount = Number.parseInt(menu.style.getPropertyValue('--island-action-count'), 10) || menu.children.length || 3;
    const windowRect = titlebar.closest('.terminal-window')?.getBoundingClientRect() || titleRect;
    const menuWidth = Math.min(260, Math.max(220, titleRect.width - 16));
    const naturalHeight = 26 + itemCount * 45;
    const targetHeight = Math.min(naturalHeight, Math.max(120, windowRect.height - 12));
    const finalLeft = Math.min(Math.max(islandCenterX - titleRect.left - menuWidth / 2, 8), Math.max(8, titleRect.width - menuWidth - 8));
    const finalTop = Math.round(islandCenterY - titleRect.top - buttonRect.height / 2);
    const startWidth = Math.round(buttonRect.width);
    const startHeight = Math.round(buttonRect.height);
    const startLeft = Math.round(islandCenterX - titleRect.left - startWidth / 2);
    const startTop = Math.round(buttonRect.top - titleRect.top);
    const openDown = true;
    const clampedLeft = collapsed ? startLeft : finalLeft;
    const top = collapsed ? startTop : finalTop;
    const currentWidth = collapsed ? startWidth : menuWidth;
    const currentHeight = collapsed ? startHeight : targetHeight;
    menu.style.top = `${top}px`;
    menu.style.setProperty('--terminal-window-menu-left', `${clampedLeft}px`);
    menu.style.setProperty('--terminal-island-menu-width', `${currentWidth}px`);
    menu.style.setProperty('--terminal-island-menu-height', `${currentHeight}px`);

    const originX = collapsed ? currentWidth / 2 : Math.min(menuWidth - 18, Math.max(18, islandCenterX - titleRect.left - finalLeft));
    const originY = collapsed ? currentHeight / 2 : Math.max(0, Math.min(currentHeight, islandCenterY - titleRect.top - finalTop));
    const finalOriginX = Math.min(menuWidth - 18, Math.max(18, islandCenterX - titleRect.left - finalLeft));
    const finalOriginY = Math.max(0, Math.min(targetHeight, islandCenterY - titleRect.top - finalTop));
    menu.style.setProperty('--island-origin-x', `${originX}px`);
    menu.style.setProperty('--island-origin-y', `${originY}px`);
    menu.style.setProperty('--island-dots-x', `${collapsed ? currentWidth / 2 : finalOriginX}px`);
    menu.style.setProperty('--island-dots-y', `${collapsed ? currentHeight / 2 : finalOriginY}px`);
    const collapsedRadius = Math.round(startHeight / 2);
    const finalRadius = 22;
    menu.style.setProperty('--terminal-island-radius', `${collapsed ? collapsedRadius : finalRadius}px`);
    menu.style.setProperty('--terminal-island-collapsed-radius', `${collapsedRadius}px`);
    menu.style.setProperty('--terminal-island-final-radius', `${finalRadius}px`);
    menu.style.setProperty('--terminal-island-final-left', `${finalLeft}px`);
    menu.style.setProperty('--terminal-island-final-top', `${finalTop}px`);
    menu.style.setProperty('--terminal-island-final-width', `${menuWidth}px`);
    menu.style.setProperty('--terminal-island-final-height', `${targetHeight}px`);
    console.info('[DynamicIslandDiagnostics]', {
        event: 'terminal-window-menu-align',
        tabId: button?.dataset.windowControl || '',
        mode: 'vertical-island',
        titlebarOpen: titlebar.classList.contains('menu-open'),
        buttonRect: {
            left: Number(buttonRect.left.toFixed(2)),
            top: Number(buttonRect.top.toFixed(2)),
            width: Number(buttonRect.width.toFixed(2)),
            height: Number(buttonRect.height.toFixed(2)),
            centerX: Number(islandCenterX.toFixed(2)),
            centerY: Number(islandCenterY.toFixed(2)),
        },
        islandRect: {
            left: Number((titleRect.left + clampedLeft).toFixed(2)),
            top: Number((titleRect.top + top).toFixed(2)),
            width: Number(menuWidth.toFixed(2)),
            height: Number(targetHeight.toFixed(2)),
            originX: Number(originX.toFixed(2)),
            originY: Number(originY.toFixed(2)),
            openDown,
        },
        startTransform: {
            left: Number(clampedLeft.toFixed(2)),
            top: Number(top.toFixed(2)),
            width: Number(currentWidth.toFixed(2)),
            height: Number(currentHeight.toFixed(2)),
            collapsed,
        },
        menuAnimation: getComputedStyle(menu).animationName,
    });
}
function openTerminalWindowMenu(titlebar) {
    if (!titlebar) return;
    titlebar.classList.remove('menu-closing', 'menu-animating');
    positionTerminalWindowMenu(titlebar, { collapsed: true, force: true });
    const menu = titlebar.querySelector('.terminal-window-menu');
    const button = titlebar.querySelector('[data-window-control]');
    menu?.style.setProperty('opacity', '1');
    button?.style.setProperty('opacity', '0');
    titlebar.classList.add('menu-open', 'menu-animating');
    requestAnimationFrame(() => {
        positionTerminalWindowMenu(titlebar, { collapsed: false, force: true });
        window.setTimeout(() => {
            titlebar.classList.remove('menu-animating');
            menu?.style.removeProperty('opacity');
        }, 540);
    });
}
function closeTerminalWindowMenu(titlebar) {
    if (!titlebar) return;
    window.clearTimeout(titlebar._terminalMenuCloseTimer);
    const menu = titlebar.querySelector('.terminal-window-menu');
    const button = titlebar.querySelector('[data-window-control]');
    positionTerminalWindowMenu(titlebar, { collapsed: false, force: true });
    menu?.style.setProperty('opacity', '1');
    button?.style.setProperty('opacity', '0');
    titlebar.classList.add('menu-closing', 'menu-animating');
    titlebar.classList.remove('menu-open');
    requestAnimationFrame(() => positionTerminalWindowMenu(titlebar, { collapsed: true, force: true }));
    titlebar._terminalMenuCloseTimer = window.setTimeout(() => {
        titlebar.classList.remove('menu-closing', 'menu-animating');
        menu?.style.removeProperty('opacity');
        button?.style.removeProperty('opacity');
    }, 460);
}
function closeOtherTerminalWindowMenus(currentButton = null) {
    $$('.terminal-window-titlebar.menu-open').forEach((el) => {
        if (!currentButton || !el.contains(currentButton)) closeTerminalWindowMenu(el);
    });
}
function runTerminalWindowActionButton(action) {
    if (!action) return;
    const tabId = action.dataset.window;
    const windowAction = action.dataset.windowAction;
    applyTerminalWindowPreset(tabId, windowAction);
    closeTerminalWindowMenu(action.closest('.terminal-window-titlebar'));
}
function reconnectTerminalSession(tabId) {
    const t = getTerminalSession(tabId);
    if (!t) return false;
    restoreTerminalSession(tabId);
    t.status = t('重连中');
    renderTerminalTabs({ rebuildWorkspace: false });
    let frame = document.querySelector(`#terminalWorkspace .terminal-frame[data-frame="${CSS.escape(tabId)}"]`);
    if (!frame?.contentWindow) {
        renderTerminalTabs({ rebuildWorkspace: true });
        frame = document.querySelector(`#terminalWorkspace .terminal-frame[data-frame="${CSS.escape(tabId)}"]`);
    }
    if (frame?.contentWindow) {
        frame.contentWindow.postMessage({ source: 'zephyr-app', type: 'reconnect-terminal', tabId }, '*');
    } else {
        t.status = 'connecting';
        renderTerminalTabs({ rebuildWorkspace: true });
    }
    const oldTimer = terminalReconnectFallbackTimers.get(tabId);
    if (oldTimer) window.clearTimeout(oldTimer);
    const timer = window.setTimeout(() => {
        terminalReconnectFallbackTimers.delete(tabId);
        const session = getTerminalSession(tabId);
        if (!session || !session.iframe || session.status !== t('重连中')) return;
        session.status = 'connecting';
        const liveFrame = document.querySelector(`#terminalWorkspace .terminal-frame[data-frame="${CSS.escape(tabId)}"]`);
        if (liveFrame?.src) {
            const src = liveFrame.src;
            liveFrame.src = 'about:blank';
            window.setTimeout(() => { liveFrame.src = src; }, 30);
            renderTerminalTabs({ rebuildWorkspace: false });
            return;
        }
        renderTerminalTabs({ rebuildWorkspace: true });
    }, 2400);
    terminalReconnectFallbackTimers.set(tabId, timer);
    toast(t('{protocol} 正在重连...', { protocol: t.protocol || t('终端') }));
    return true;
}
function getMinimizedKeepAliveSessions() {
    const limit = getConfiguredMinimizedKeepAlive();
    const minimized = terminalTabs
        .filter((t) => t.minimized && !closingTerminalTabs.has(t.id) && t.iframe)
        .sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
    if (limit === -1) return minimized;
    if (limit <= 0) return minimized;
    return minimized.slice(0, limit);
}
function createTerminalWindowElement(session) {
    const article = document.createElement('article');
    article.className = 'terminal-window';
    article.dataset.window = session.id;
    article.draggable = false;
    const titlebar = document.createElement('div');
    titlebar.className = 'terminal-window-titlebar';
    titlebar.innerHTML = terminalWindowTitlebarHtml(session);
    const body = document.createElement('div');
    body.className = 'terminal-window-body';
    if (session.iframe) {
        const frame = document.createElement('iframe');
        frame.className = 'terminal-frame';
        frame.dataset.frame = session.id;
        const frameTheme = getPreferredTheme();
        frame.src = session.page === 'rdp'
            ? `/rdp.html?embed=1&v=20260804-rdp-ssh-scroll4&theme=${encodeURIComponent(frameTheme)}&tabId=${encodeURIComponent(session.id)}&connectionId=${encodeURIComponent(session.connectionId || '')}`
            : session.page === 'novnc'
                ? `/novnc.html?embed=1&v=20260804-terminal-shell3&tabId=${encodeURIComponent(session.id)}&connectionId=${encodeURIComponent(session.connectionId || '')}`
                : session.page === 'telnet-terminal'
                    ? `/telnet-terminal.html?embed=1&tabId=${encodeURIComponent(session.id)}&v=20260801-terminal-grid-converge1-mobile-ime2`
                    : `/terminal.html?embed=1&tabId=${encodeURIComponent(session.id)}&v=20260801-terminal-grid-converge1-mobile-ime2`;
        frame.allow = 'fullscreen; virtual-keyboard; clipboard-read; clipboard-write';
        frame.addEventListener('load', () => {
            try {
                frame.contentWindow?.postMessage({
                    source: 'zephyr-app',
                    type: 'notes-enabled',
                    enabled: isNotesEnabled(),
                }, '*');
                frame.contentWindow?.postMessage({
                    source: 'zephyr-app',
                    type: 'terminal-settings',
                    terminal: settings.terminal || {},
                    workspace: settings.workspace || { sessionPersistence: true },
                }, '*');
                if (session.workspaceState) {
                    frame.contentWindow?.postMessage({ source: 'zephyr-app', type: 'restore-workspace-state', state: session.workspaceState }, '*');
                }
            } catch (_) {}
        }, { once: true });
        body.appendChild(frame);
        if (session.snapshotText && (session.page === 'terminal' || session.page === 'telnet-terminal')) {
            const snapshot = document.createElement('pre');
            snapshot.className = 'terminal-snapshot';
            snapshot.dataset.snapshotFor = session.id;
            snapshot.textContent = session.snapshotText;
            body.appendChild(snapshot);
        }
    } else {
        const placeholder = document.createElement('div');
        placeholder.className = 'terminal-placeholder active';
        placeholder.dataset.frame = session.id;
        placeholder.textContent = t('{protocol} 协议将在后续版本接入。', { protocol: session.protocol });
        body.appendChild(placeholder);
    }
    article.append(titlebar, body);
    return article;
}
function mountMobileDockToggle(workspace) {
    // 小圆点现在直接由 terminalWindowTitlebarHtml 渲染进每个标题栏，避免 titlebar.innerHTML 重绘后丢失。
    workspace?.querySelectorAll('.terminal-window-titlebar > .mobile-fullscreen-dock-toggle').forEach((toggle) => {
        toggle.style.display = isCompactTerminalWorkspace() && workspace?.classList.contains('custom-fullscreen') ? 'grid' : '';
    });
}
function renderTerminalWorkspace() {
    const visibleSessions = terminalTabs.filter((t) => !t.minimized && !closingTerminalTabs.has(t.id));
    const visible = [
        ...visualLayout.map(getTerminalSession).filter(Boolean).filter((t) => visibleSessions.some((item) => item.id === t.id)),
        ...visibleSessions.filter((t) => !visualLayout.includes(t.id)),
    ];
    const keepAliveMinimized = getMinimizedKeepAliveSessions();
    const count = visible.length;
    const workspace = $('#terminalWorkspace');
    const preservedWorkspaceClasses = ['custom-fullscreen', 'ssh-kb-open']
        .filter((className) => workspace.classList.contains(className));
    workspace.className = `terminal-workspace terminal-workspace-grid layout-${Math.min(count, 3)} ${isCompactTerminalWorkspace() ? 'compact' : ''} ${preservedWorkspaceClasses.join(' ')}`;
    const visibleIds = new Set(visible.map((t) => t.id));
    const keepAliveIds = new Set([...visible.map((t) => t.id), ...keepAliveMinimized.map((t) => t.id)]);
    console.info('[terminal-keepalive]', 'workspace render decision', {
        visibleIds: [...visibleIds],
        minimizedKeepAliveLimit: getConfiguredMinimizedKeepAlive(),
        keptMinimizedIds: keepAliveMinimized.map((t) => t.id),
        existingWindowIds: Array.from(workspace.querySelectorAll(':scope > .terminal-window')).map((el) => el.dataset.window),
    });
    if (!count) {
        workspace.querySelectorAll(':scope > .workspace-splitter').forEach((el) => el.remove());
        workspace.querySelectorAll(':scope > .terminal-window').forEach((el) => {
            if (!keepAliveIds.has(el.dataset.window)) {
                console.info('[terminal-keepalive]', 'unload terminal iframe', { tabId: el.dataset.window, reason: 'no-visible-and-not-kept' });
                el.remove();
            }
        });
        if (!workspace.querySelector(':scope > .terminal-placeholder')) {
            workspace.insertAdjacentHTML('afterbegin', `<div class="terminal-placeholder active">${t('暂无可见会话。最小化会话可从终端栏恢复。')}</div>`);
        }
        keepAliveMinimized.forEach((t) => {
            let win = workspace.querySelector(`:scope > .terminal-window[data-window="${CSS.escape(t.id)}"]`);
            if (!win) {
                win = createTerminalWindowElement(t);
                workspace.appendChild(win);
                console.info('[terminal-keepalive]', 'create minimized keepalive iframe', { tabId: t.id, reason: 'no-visible' });
            }
            win.className = `terminal-window minimized-keepalive ${closingTerminalTabs.has(t.id) ? 'closing' : ''}`;
            win.querySelectorAll('.terminal-frame, .terminal-placeholder').forEach((frame) => frame.classList.remove('active'));
        });
        mountMobileDockToggle(workspace);
        return;
    }
    mountMobileDockToggle(workspace);
    workspace.querySelectorAll(':scope > .terminal-placeholder, :scope > .workspace-splitter').forEach((el) => el.remove());
    workspace.querySelectorAll(':scope > .terminal-window').forEach((el) => {
        if (!keepAliveIds.has(el.dataset.window)) {
            console.info('[terminal-keepalive]', 'unload terminal iframe', { tabId: el.dataset.window, reason: 'outside-visible-and-minimized-keepalive' });
            el.remove();
        }
    });
    visible.forEach((t, index) => {
        let win = workspace.querySelector(`:scope > .terminal-window[data-window="${CSS.escape(t.id)}"]`);
        if (!win) {
            win = createTerminalWindowElement(t);
            workspace.appendChild(win);
            console.info('[terminal-keepalive]', 'create visible iframe', { tabId: t.id, slot: index + 1 });
        }
        const titlebar = win.querySelector('.terminal-window-titlebar');
        if (titlebar) {
            titlebar.innerHTML = terminalWindowTitlebarHtml(t);
        }
        const isActiveWindow = t.id === activeTerminalTab;
        win.className = `terminal-window slot-${index + 1} ${isActiveWindow ? 'active' : 'background'} ${closingTerminalTabs.has(t.id) ? 'closing' : ''} ${minimizingTerminalTabs.has(t.id) ? 'minimizing' : ''} ${dockSwapAnimatingWindows.has(t.id) ? 'dock-swapping' : ''} ${dockLaunchAnimatingWindows.has(t.id) ? 'dock-launching' : ''}`;
        win.querySelectorAll('.terminal-frame, .terminal-placeholder').forEach((frame) => frame.classList.toggle('active', isActiveWindow));
    });
    mountMobileDockToggle(workspace);
    keepAliveMinimized.forEach((t) => {
        let win = workspace.querySelector(`:scope > .terminal-window[data-window="${CSS.escape(t.id)}"]`);
        if (!win) {
            win = createTerminalWindowElement(t);
            workspace.appendChild(win);
            console.info('[terminal-keepalive]', 'create minimized keepalive iframe', { tabId: t.id, reason: 'hidden-minimized' });
        }
        win.className = `terminal-window minimized-keepalive ${closingTerminalTabs.has(t.id) ? 'closing' : ''}`;
        win.querySelectorAll('.terminal-frame, .terminal-placeholder').forEach((frame) => frame.classList.remove('active'));
    });
    if (count === 2 || count === 3) {
        const splitterX = document.createElement('div');
        splitterX.className = 'workspace-splitter vertical';
        splitterX.dataset.splitter = 'x';
        workspace.appendChild(splitterX);
    }
    if (count === 3) {
        const splitterY = document.createElement('div');
        splitterY.className = 'workspace-splitter horizontal';
        splitterY.dataset.splitter = 'y';
        workspace.appendChild(splitterY);
    }
    rememberCompactTerminalKeyboardBaseline('render-terminal-workspace');
    scheduleTerminalLayoutStabilize('render-terminal-workspace', { focus: true });
}
function renderTerminalTabs({ rebuildWorkspace = true } = {}) {
    syncVisualLayout({ preserve: true });
    renderTerminalSmartbar();
    if (rebuildWorkspace) renderTerminalWorkspace();
    else {
        $$('#terminalWorkspace [data-window]').forEach((el) => {
            const active = el.dataset.window === activeTerminalTab;
            el.classList.toggle('active', active);
            el.classList.toggle('background', !active);
            el.classList.toggle('closing', closingTerminalTabs.has(el.dataset.window));
            el.classList.toggle('minimizing', minimizingTerminalTabs.has(el.dataset.window));
        });
        $$('#terminalWorkspace .terminal-window').forEach((win) => {
            const active = win.dataset.window === activeTerminalTab && !win.classList.contains('minimized-keepalive');
            win.querySelectorAll('.terminal-frame, .terminal-placeholder').forEach((frame) => frame.classList.toggle('active', active));
        });
        terminalTabs.forEach((t) => { $$(`[data-window-status="${t.id}"]`).forEach((el) => { el.textContent = t.status || ''; }); });
    }
    requestAnimationFrame(() => {
        broadcastThemeToTerminals(document.documentElement.getAttribute('data-theme') || getPreferredTheme());
        broadcastTerminalSettings(settings.terminal || {}, settings.workspace || { sessionPersistence: true });
    });
    scheduleWorkspaceSave('terminal-tabs');
}

function exitTerminalFullscreen({ renderAfter = true } = {}) {
    const workspace = $('#terminalWorkspace');
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
    if (workspace?.classList.contains('custom-fullscreen')) {
        if (terminalFullscreenExitPromise) return terminalFullscreenExitPromise;
        resetTerminalWorkspaceKeyboard({ force: true });
        terminalFullscreenExitPromise = animateMobileTerminalFullscreen(workspace, { open: false })
            .catch(() => {
                workspace.classList.remove('custom-fullscreen');
                document.body.classList.remove('terminal-custom-fullscreen-open', 'terminal-fullscreen-exiting');
                const nav = document.querySelector('.main-nav');
                if (nav) {
                    try { sshKeyMotion.engine?.release?.(nav); } catch {}
                    nav.style.display = '';
                    nav.style.visibility = '';
                    nav.style.pointerEvents = '';
                    nav.style.willChange = '';
                }
                try { sshKeyMotion.engine?.release?.(workspace); } catch {}
                clearTerminalFullscreenInline(workspace);
                return false;
            })
            .finally(() => {
                terminalFullscreenExitPromise = null;
                if (renderAfter) renderTerminalTabs();
                scheduleTerminalKeyboardReflow('mobile-fullscreen-exit');
            });
        return terminalFullscreenExitPromise;
    }
    if (fullscreenElement) {
        if (document.exitFullscreen) return document.exitFullscreen().catch?.(() => false) || Promise.resolve(true);
        if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
            return Promise.resolve(true);
        }
    }
    return Promise.resolve(false);
}

async function playTerminalWindowCloseMotion(win) {
    if (!win) return false;
    win.classList.add('motion-closing');
    win.style.transformOrigin = '50% 50%';
    try {
        await Motion.tween(win, { scaleX: 0.01, scaleY: 0.01, opacity: 0 }, {
            duration: 360,
            bezier: [0.32, 0.72, 0, 1]
        });
        return true;
    } catch (e) {
        console.warn('[terminal] close motion failed', e);
        return false;
    }
}

async function closeTerminalTab(tabId, { reason = 'manual' } = {}) {
    if (!terminalTabs.some((t) => t.id === tabId) || closingTerminalTabs.has(tabId)) return;
    const willBeLastTab = terminalTabs.length <= 1;
    const closingTab = terminalTabs.find((t) => t.id === tabId);
    const ephemeralConnectionId = closingTab?.ephemeralConnectionId
        || (closingTab?.ephemeral || closingTab?.transient ? closingTab?.connectionId : '')
        || '';
    console.info('[terminal-layout]', 'close terminal tab requested', {
        tabId,
        reason,
        willBeLastTab,
        activeTerminalTab,
        ephemeralConnectionId: ephemeralConnectionId || '',
        customFullscreen: $('#terminalWorkspace')?.classList.contains('custom-fullscreen'),
    });
    const customFullscreen = !!$('#terminalWorkspace')?.classList.contains('custom-fullscreen');
    const shouldExitFullscreen = activeTerminalTab === tabId || willBeLastTab;
    closingTerminalTabs.add(tabId);
    const win = terminalWorkspace?.querySelector(`.terminal-window[data-window="${CSS.escape(String(tabId))}"]`);
    const closeMotion = playTerminalWindowCloseMotion(win);
    if (shouldExitFullscreen && customFullscreen) {
        // Window shrink and nav/workspace return are one coordinated gesture.
        await Promise.all([
            exitTerminalFullscreen({ renderAfter: false }),
            closeMotion,
        ]);
    } else {
        if (shouldExitFullscreen) await exitTerminalFullscreen({ renderAfter: false });
        await closeMotion;
    }
    // Fire-and-forget: delete the one-shot host row so it never lingers in the library.
    if (ephemeralConnectionId) {
        disposeEphemeralConnection(ephemeralConnectionId, { reason: `tab-close:${reason}` });
    }
    terminalTabs = terminalTabs.filter((t) => t.id !== tabId);
    openOrderStack = openOrderStack.filter((id) => id !== tabId);
    visualLayout = visualLayout.filter((id) => id !== tabId);
    recentUseStack = recentUseStack.filter((id) => id !== tabId);
    closingTerminalTabs.delete(tabId);
    const reconnectTimer = terminalReconnectFallbackTimers.get(tabId);
    if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
        terminalReconnectFallbackTimers.delete(tabId);
    }
    sessionStorage.removeItem(`zephyr_ssh_params_${tabId}`);
    sessionStorage.removeItem(`zephyr_remote_desktop_params_${tabId}`);
    removeTerminalSnapshot(tabId);
    if (activeTerminalTab === tabId) activeTerminalTab = visualLayout[0] || terminalTabs.find((t) => !t.minimized)?.id || terminalTabs[0]?.id || null;
    if (!terminalTabs.length) {
        activeTerminalTab = null;
        visualLayout = [];
        openOrderStack = [];
        recentUseStack = [];
        setTerminalSmartbarOpen(false);
        exitTerminalFullscreen();
        resetTerminalWorkspaceKeyboard();
        // 最后一个终端关闭后保留在终端页，显示空会话占位，不再自动回到首页。
        switchView('terminal');
    }
    renderTerminalTabs();
    scheduleWorkspaceSave('close-terminal-tab', { immediate: true });
}

function applyTerminalWindowPreset(tabId, action) {
    const t = getTerminalSession(tabId); if (!t) return;
    console.debug('[terminal-layout]', 'window action', {
        tabId,
        action,
        compact: isCompactTerminalWorkspace(),
        visibleCount: visibleTerminalTabs().length,
        maxWindows: getEffectiveTerminalMaxWindows()
    });
    if (action === 'minimize') {
        const workspace = $('#terminalWorkspace');
        const customFullscreen = !!workspace?.classList.contains('custom-fullscreen');
        if (customFullscreen) {
            // Nav/workspace collapse and window minimize begin on the same frame.
            const exitJob = exitTerminalFullscreen({ renderAfter: false });
            minimizeTerminalSession(tabId);
            exitJob.finally(() => renderTerminalTabs());
        } else {
            minimizeTerminalSession(tabId);
            renderTerminalTabs();
        }
        return;
    }
    if (action === 'close') { closeTerminalTab(tabId); return; }
    if (action === 'exit-fullscreen') { exitTerminalFullscreen(); return; }
    if (action === 'reconnect-mobile') {
        reconnectTerminalSession(tabId);
        return;
    }
    if (action === 'fullscreen') { fullscreenTerminalTab(tabId).catch((err) => toast(err.message)); return; }
    restoreTerminalSession(tabId);
    const beforeRects = captureTerminalWindowRects();
    const workspace = $('#terminalWorkspace');
    const others = visualLayout.filter((id) => id !== tabId);
    if (action === 'left-half' || action === 'left-two-thirds') visualLayout = [tabId, ...others].slice(0, 3);
    else if (action === 'right-half' || action === 'right-two-thirds') visualLayout = [...others, tabId].slice(-3);
    else if (action === 'right-top') visualLayout = [others[0] || tabId, tabId, ...others.filter((_, i) => i > 0)].slice(0, 3);
    else if (action === 'right-bottom') visualLayout = [others[0] || tabId, ...others.filter((_, i) => i > 0), tabId].slice(0, 3);
    if (workspace) {
        if (action === 'left-half' || action === 'right-half') workspace.style.setProperty('--workspace-split-x', '50%');
        if (action === 'left-two-thirds' || action === 'right-top' || action === 'right-bottom') workspace.style.setProperty('--workspace-split-x', '66.666%');
        if (action === 'right-two-thirds') workspace.style.setProperty('--workspace-split-x', '33.333%');
        if (action === 'right-top') workspace.style.setProperty('--workspace-split-y', '50%');
        if (action === 'right-bottom') workspace.style.setProperty('--workspace-split-y', '50%');
    }
    activeTerminalTab = tabId; touchTerminalSession(tabId); renderTerminalTabs();
    animateTerminalWindowLayoutFrom(beforeRects, { reason: action });
}

function captureTerminalWindowRects() {
    const workspace = $('#terminalWorkspace');
    if (!workspace) return new Map();
    return new Map(Array.from(workspace.querySelectorAll(':scope > .terminal-window:not(.minimized-keepalive)')).map((el) => [el.dataset.window, el.getBoundingClientRect()]));
}
/**
 * The window's resting corner radius in px, read while no morph class is on.
 * The shell invariant publishes it with !important, so the computed longhand is
 * the single source of truth (never assume --radius-lg).
 */
function terminalWindowRestRadius(el) {
    if (!el) return 0;
    const raw = getComputedStyle(el).borderTopLeftRadius || '';
    const px = parseFloat(String(raw).split(/[\s/]+/)[0]);
    return Number.isFinite(px) && px > 0 ? px : 0;
}
const TERMINAL_MORPH_DURATION = 560;
const TERMINAL_MORPH_EASING = 'cubic-bezier(.16, 1, .3, 1)';
/**
 * Keyframe count for the morph's geometry track.
 *
 * The radius compensation is R/scale — a hyperbola — while WAAPI interpolates
 * between keyframes linearly. Two keyframes therefore overshoot the PAINTED
 * corner (measured: 2.25px / 12.5% at sx=2). Densifying the track turns the
 * chord error into a piecewise-linear approximation (measured: 0.011px at
 * sx=2). Option-level easing is applied BEFORE keyframe-offset lookup, so
 * adding keyframes does not alter the motion curve at all.
 *
 * Scale it with the zoom ratio: the hyperbola's curvature grows as scale→0.
 */
function terminalMorphFrameCount(sx, sy) {
    const ratio = Math.max(
        Math.abs(sx) || 1, Math.abs(sy) || 1,
        1 / Math.max(0.0001, Math.abs(sx) || 1),
        1 / Math.max(0.0001, Math.abs(sy) || 1),
    );
    return Math.min(64, Math.max(20, Math.ceil(ratio * 10)));
}
/**
 * Geometry track for one window: FLIP transform plus the inverse-compensated
 * corner radius, sampled so that radius x scale stays on the resting radius for
 * every frame instead of only at the two endpoints.
 */
function buildTerminalMorphFrames({ dx, dy, sx, sy, radius, compensate }) {
    const steps = compensate ? terminalMorphFrameCount(sx, sy) : 1;
    const frames = [];
    for (let i = 0; i <= steps; i++) {
        const p = i / steps;
        // Linear in keyframe offset: the option-level easing already shaped the
        // time→offset mapping, so this reproduces the original transform curve.
        const cx = sx + (1 - sx) * p;
        const cy = sy + (1 - sy) * p;
        const frame = {
            offset: p,
            transform: `translate3d(${(dx * (1 - p)).toFixed(4)}px, ${(dy * (1 - p)).toFixed(4)}px, 0) scale3d(${cx.toFixed(6)}, ${cy.toFixed(6)}, 1)`,
        };
        if (compensate) {
            frame['--morph-rx'] = `${(radius / Math.max(0.0001, Math.abs(cx))).toFixed(4)}px`;
            frame['--morph-ry'] = `${(radius / Math.max(0.0001, Math.abs(cy))).toFixed(4)}px`;
        }
        frames.push(frame);
    }
    return frames;
}
function animateTerminalWindowLayoutFrom(beforeRects, { reason = 'layout-change' } = {}) {
    const workspace = $('#terminalWorkspace');
    if (!workspace || !beforeRects?.size) return;
    window.cancelAnimationFrame(animateTerminalWindowLayoutFrom._raf);
    animateTerminalWindowLayoutFrom._raf = window.requestAnimationFrame(() => {
        const animations = [];
        // Live handles, so the watchdog below can cancel a fill that never
        // resolved (interrupted render, tab hidden mid-morph, …).
        const running = [];
        workspace.classList.add('terminal-layout-morphing');
        workspace.querySelectorAll(':scope > .terminal-window:not(.minimized-keepalive)').forEach((el) => {
            const before = beforeRects.get(el.dataset.window);
            const after = el.getBoundingClientRect();
            if (!before || after.width <= 1 || after.height <= 1) return;
            const dx = before.left - after.left;
            const dy = before.top - after.top;
            const sx = before.width / after.width;
            const sy = before.height / after.height;
            const moved = Math.abs(dx) + Math.abs(dy) > 1;
            const resized = Math.abs(1 - sx) + Math.abs(1 - sy) > 0.01;
            if (!moved && !resized) return;
            // A FLIP morph paints the corner through scale3d, so a uniform
            // border-radius is stretched into an ellipse (radius*sx by
            // radius*sy) for the whole morph — that is the "corners look wrong
            // / go missing" while a ratio changes. Pre-divide the authored
            // radius by the scale so the PAINTED radius stays constant.
            const restRadius = terminalWindowRestRadius(el);
            // Only a RESIZE stretches the corner; a pure move paints it 1:1.
            // The compensation class must therefore be added only when those
            // custom properties are actually animated, otherwise the rule that
            // consumes them would take over with nothing driving it.
            const compensate = restRadius > 0 && resized;
            el.classList.add('layout-morphing');
            if (compensate) el.classList.add('layout-morphing-radius');
            const timing = {
                duration: TERMINAL_MORPH_DURATION,
                easing: TERMINAL_MORPH_EASING,
                fill: 'both',
            };
            // Geometry: densified so radius x scale stays constant every frame.
            const anim = el.animate(
                buildTerminalMorphFrames({ dx, dy, sx, sy, radius: restRadius, compensate }),
                timing,
            );
            // Cosmetics stay on their own 2-keyframe track: densifying these
            // would change how blur/shadow read, and they need no compensation.
            const cosmetic = el.animate([
                {
                    filter: 'blur(.6px) saturate(.98)',
                    boxShadow: '0 18px 52px rgba(0,0,0,.30), inset 0 0 0 1px rgba(255,255,255,.03)',
                },
                {
                    filter: 'blur(0) saturate(1)',
                    boxShadow: el.classList.contains('active')
                        ? '0 24px 70px rgba(0,0,0,.38), 0 0 0 3px rgba(10,132,255,.08)'
                        : '0 18px 52px rgba(0,0,0,.32), inset 0 0 0 1px rgba(255,255,255,.03)',
                },
            ], timing);
            running.push(anim, cosmetic);
            animations.push(Promise.allSettled([anim.finished, cosmetic.finished]).finally(() => {
                el.classList.remove('layout-morphing', 'layout-morphing-radius');
                // `fill: 'both'` keeps the end keyframe in the Animation origin
                // forever, which outranks author-normal declarations. A leaked
                // fill therefore froze `.minimizing`'s scale(.72) and
                // `.dragging`'s translate at identity. The end keyframe already
                // equals the resting style (base transform is
                // translate3d(0,0,0) scale(1); the background box-shadow is
                // byte-identical; the active one is author-!important anyway),
                // so cancelling is visually a no-op and releases the property.
                try { anim.cancel(); } catch {}
                try { cosmetic.cancel(); } catch {}
            }));
        });
        window.clearTimeout(animateTerminalWindowLayoutFrom._timer);
        Promise.all(animations).finally(() => {
            workspace.classList.remove('terminal-layout-morphing');
            scheduleTerminalLayoutStabilize(`terminal-window-morph:${reason}`, { focus: true });
        });
        animateTerminalWindowLayoutFrom._timer = window.setTimeout(() => {
            workspace.classList.remove('terminal-layout-morphing');
            // Cancel too, not just declassify: a filling animation keeps owning
            // transform/--morph-* in the cascade even after its class is gone,
            // which would freeze the next .minimizing / .dragging transform.
            running.forEach((anim) => { try { anim.cancel(); } catch {} });
            running.length = 0;
            workspace.querySelectorAll('.terminal-window.layout-morphing, .terminal-window.layout-morphing-radius')
                .forEach((el) => el.classList.remove('layout-morphing', 'layout-morphing-radius'));
        }, 720);
    });
}

function resetTerminalWorkspaceKeyboard({ force = false, notifyIframe = false } = {}) {
    const workspace = $('#terminalWorkspace');
    if (!workspace || (!force && !sshKbParentOpen && !workspace.classList.contains('ssh-kb-open') && !workspace.classList.contains('ssh-kb-settling') && !sshKbParentAwaiting)) return;
    const wasOpen = sshKbParentOpen;
    stopSshKbAlignLoop();
    sshKbParentOpen = false;
    sshKbParentInset = 0;
    sshKbParentBaseline = 0;
    sshKbParentPendingMetrics = null;
    sshKbParentLastSignature = '';
    sshKbParentLastGoodInset = 0;
    sshKbParentLastGoodTop = 0;
    sshKbParentSeenPhysical = false;
    sshKbParentLowSince = 0;
    // Stale awaiting after close left second open without align loop / crop.
    sshKbParentAwaiting = false;
    sshKbParentAwaitingSince = 0;
    sshKbParentAwaitingMetrics = null;
    window.clearTimeout(sshKbParentSettleTimer);

    workspace.classList.remove('ssh-kb-open', 'keyboard-settling', 'ssh-kb-open');
    document.documentElement.classList.remove('ssh-kb-open');
    document.documentElement.style.setProperty('--app-keyboard-inset', '0px');
    document.documentElement.style.setProperty('--ssh-kb-inset', '0px');
    sshKbParentInset = 0;
    document.body.classList.remove('ssh-kb-lift');
    document.documentElement.style.setProperty('--app-keyboard-shift', '0px');
    document.documentElement.style.setProperty('--app-visual-vh', '100vh');
    document.documentElement.style.setProperty('--app-visual-offset-top', '0px');
    document.documentElement.style.setProperty('--app-keyboard-top', '100vh');
    workspace.style.flex = '';
    workspace.style.height = '';
    workspace.style.maxHeight = '';
    workspace.style.minHeight = '';
    workspace.style.marginBottom = '';
    // Geometry-only by default. postMessage reset-mobile-keyboard blurs the IME proxy
    // and is the #1 cause of "keyboard opens then dies in ~1s". Only notify iframe when
    // explicitly leaving the terminal / force-closing the session keyboard.
    const clearFrameGeometry = () => {
        workspace.querySelectorAll('.terminal-frame').forEach((frame) => {
            const body = frame.closest?.('.terminal-window')?.querySelector?.('.terminal-window-body') || frame.parentElement;
            [frame, body].forEach((el) => {
                if (!el?.style) return;
                el.style.removeProperty('height');
                el.style.removeProperty('max-height');
                el.style.removeProperty('min-height');
                el.style.removeProperty('flex');
                el.style.removeProperty('overflow');
                el.style.removeProperty('box-sizing');
                try {
                    delete el.dataset.sshKbCropped;
                    // Keep resting top across ordinary keyboard close; only wipe on force below.
                    if (force) delete el.dataset.sshKbRestingTop;
                } catch (_) {}
            });
        });
    };
    const notifyFrameKeyboardReset = (reason = 'parent-workspace-reset') => {
        if (!notifyIframe && !force) return;
        workspace.querySelectorAll('.terminal-frame').forEach((frame) => {
            try { frame.contentWindow?.postMessage({ source: 'zephyr-app', type: 'reset-mobile-keyboard', reason }, '*'); } catch (_) {}
        });
    };
    clearFrameGeometry();
    if (notifyIframe || force) notifyFrameKeyboardReset('parent-workspace-reset');
    if (force) {
        [80, 220, 520, 900].forEach((delay) => window.setTimeout(() => {
            sshKbParentOpen = false;
            sshKbParentBaseline = 0;
            sshKbParentPendingMetrics = null;
            sshKbParentLastSignature = '';
            sshKbParentAwaiting = false;
            sshKbParentAwaitingMetrics = null;
            workspace.classList.remove('ssh-kb-open', 'keyboard-settling');
            document.documentElement.style.setProperty('--app-keyboard-inset', '0px');
            document.body.classList.remove('ssh-kb-lift');
            document.documentElement.style.setProperty('--app-keyboard-shift', '0px');
            document.documentElement.style.setProperty('--app-visual-vh', '100vh');
            document.documentElement.style.setProperty('--app-visual-offset-top', '0px');
            document.documentElement.style.setProperty('--app-keyboard-top', '100vh');
            workspace.style.flex = '';
            workspace.style.height = '';
            workspace.style.maxHeight = '';
            workspace.style.minHeight = '';
            workspace.style.marginBottom = '';
            clearFrameGeometry();
            if (notifyIframe) notifyFrameKeyboardReset(`parent-workspace-reset:${delay}`);
        }, delay));
    }
    // Ordinary close: do NOT freeze child publish for 900ms.
    // That freeze swallowed the next open intent → second open no parent crop → bar stuck.
    window.clearTimeout(sshKbParentFreezeReleaseTimer);
    if (force) {
        postTerminalKeyboardFreeze(true, 'parent-keyboard-reset-start', { settleMs: 220 });
        sshKbParentFreezeReleaseTimer = window.setTimeout(
            () => postTerminalKeyboardFreeze(false, 'parent-keyboard-reset-settled'),
            220,
        );
    } else {
        postTerminalKeyboardFreeze(false, 'parent-keyboard-reset-soft-unfreeze');
    }
    void wasOpen;
    console.info('[TerminalLayoutDiagnostics]', { event: 'parent:keyboard-reset', wasOpen });
    scheduleTerminalLayoutStabilize('parent-keyboard-reset', { focus: false });
}

function commitTerminalWorkspaceKeyboard(metrics = {}) {
    const workspace = $('#terminalWorkspace');
    if (!workspace) return;
    const inset = Math.round(Number(metrics.keyboardInset) || 0);
    const viewportHeight = Math.round(Number(metrics.viewportHeight) || window.visualViewport?.height || window.innerHeight || 0);
    const offsetTop = Math.round(Number(metrics.offsetTop) || window.visualViewport?.offsetTop || 0);
    const height = Math.max(240, viewportHeight);
    sshKbParentOpen = true;
    workspace.classList.add('ssh-kb-open');
    workspace.classList.remove('ssh-kb-settling');
    postTerminalKeyboardFreeze(true, 'parent-keyboard-commit-lock', { settleMs: 900 });
    document.documentElement.style.setProperty('--app-keyboard-inset', `${inset}px`);
    document.documentElement.style.setProperty('--app-visual-vh', `${height}px`);
    document.documentElement.style.setProperty('--app-visual-offset-top', `${offsetTop}px`);
    workspace.style.height = `${height}px`;
    workspace.style.maxHeight = `${height}px`;
    const frame = workspace.querySelector(`.terminal-frame[data-frame="${CSS.escape(activeTerminalTab || '')}"]`) || workspace.querySelector('.terminal-frame.active');
    if (frame) {
        frame.style.height = '100%';
        frame.style.maxHeight = '100%';
    }
    console.info('[TerminalLayoutDiagnostics]', {
        event: 'parent:keyboard-commit',
        inset,
        viewportHeight,
        offsetTop,
        activeTerminalTab,
    });
    scheduleTerminalLayoutStabilize('parent-keyboard-commit', { focus: false });
}

/**
 * Physical keyboard TOP in layout-viewport CSS px (same as getBoundingClientRect).
 * Prefer VirtualKeyboard.boundingRect.y; else visualViewport.offsetTop+height (MDN).
 */
function measureParentKeyboardTop() {
    const layoutH = Math.max(
        Math.round(window.innerHeight || 0),
        Math.round(document.documentElement.clientHeight || 0),
        1,
    );
    try {
        const vk = navigator.virtualKeyboard?.boundingRect;
        const top = Math.round(Number(vk?.y) || 0);
        const h = Math.round(Number(vk?.height) || 0);
        if (h >= 64 && top >= 0 && top < layoutH) {
            return {
                top,
                screenInset: Math.max(0, layoutH - top),
                source: 'virtualKeyboard',
                layoutH,
                vvHeight: Math.round(window.visualViewport?.height || layoutH - h),
            };
        }
    } catch (_) {}
    const vv = window.visualViewport;
    if (vv) {
        const vvH = Math.round(vv.height || 0);
        const vvTop = Math.round(vv.offsetTop || 0);
        const top = Math.max(0, vvTop + vvH);
        const screenInset = Math.max(0, layoutH - top);
        // Same open threshold as intent (80). 64 was too eager for status-bar noise
        // and too strict vs the 80-gate in applyTerminalWorkspaceKeyboard.
        return {
            top: screenInset >= 80 ? top : layoutH,
            screenInset: screenInset >= 80 ? screenInset : 0,
            source: screenInset >= 80 ? 'visualViewport' : 'visualViewport-full',
            layoutH,
            vvHeight: vvH,
        };
    }
    return { top: layoutH, screenInset: 0, source: 'none', layoutH, vvHeight: layoutH };
}

/**
 * PARENT crops the terminal shell so its bottom edge == physical keyboard top.
 * Child iframe is height:100% of that shell. Child must NOT apply a second inset.
 */

function applyParentIframeShellToKeyboard(activeFrame, keyboardTop, open) {
    const win = activeFrame?.closest?.('.terminal-window');
    const body = win?.querySelector?.('.terminal-window-body') || activeFrame?.parentElement;
    const target = body || activeFrame;

    const clearImportant = (el, { keepResting = false } = {}) => {
        if (!el?.style) return;
        el.style.removeProperty('height');
        el.style.removeProperty('max-height');
        el.style.removeProperty('min-height');
        el.style.removeProperty('flex');
        el.style.removeProperty('overflow');
        el.style.removeProperty('box-sizing');
        el.style.removeProperty('width');
        el.style.removeProperty('display');
        try {
            delete el.dataset.sshKbCropped;
            if (!keepResting) delete el.dataset.sshKbRestingTop;
        } catch (_) {}
    };

    if (!open) {
        clearImportant(activeFrame, { keepResting: true });
        clearImportant(body, { keepResting: true });
        if (win?.style) {
            win.style.removeProperty('height');
            win.style.removeProperty('max-height');
        }
        return { shellH: 0, top: 0, kTop: 0 };
    }

    const kTop = Math.round(Number(keyboardTop) || 0);
    if (!target || kTop <= 0) return { shellH: 0, top: 0, kTop: 0 };

    // Prefer resting origin when already cropped — avoid uncrop thrash every frame.
    const alreadyCropped = target.dataset.sshKbCropped === '1';
    let originTop = Math.round(Number(target.dataset.sshKbRestingTop) || 0);
    if (!alreadyCropped || originTop <= 0) {
        clearImportant(target, { keepResting: true });
        if (activeFrame && activeFrame !== target) clearImportant(activeFrame, { keepResting: true });
        void target.offsetHeight;
        originTop = Math.round(target.getBoundingClientRect().top || 0);
        if (originTop > 0) target.dataset.sshKbRestingTop = String(originTop);
    }

    const shellH = Math.max(120, kTop - originTop);
    target.style.setProperty('box-sizing', 'border-box', 'important');
    target.style.setProperty('height', `${shellH}px`, 'important');
    target.style.setProperty('max-height', `${shellH}px`, 'important');
    target.style.setProperty('min-height', '0px', 'important');
    target.style.setProperty('flex', '0 0 auto', 'important');
    target.style.setProperty('overflow', 'hidden', 'important');
    target.dataset.sshKbCropped = '1';

    if (activeFrame && activeFrame !== target) {
        activeFrame.style.setProperty('box-sizing', 'border-box', 'important');
        activeFrame.style.setProperty('height', '100%', 'important');
        activeFrame.style.setProperty('max-height', '100%', 'important');
        activeFrame.style.setProperty('min-height', '0px', 'important');
        activeFrame.style.setProperty('width', '100%', 'important');
        activeFrame.style.setProperty('display', 'block', 'important');
        activeFrame.style.border = '0';
        activeFrame.dataset.sshKbCropped = '1';
    }

    return { shellH, top: originTop, kTop };
}

function postParentShellManaged(activeFrame, {
    open,
    keyboardTop = 0,
    screenInset = 0,
    shellH = 0,
    frameKeyboardOverlap = 0,
    heightSource = '',
    reason = 'parent-shell',
} = {}) {
    if (!activeFrame?.contentWindow) return;
    try {
        activeFrame.contentWindow.postMessage({
            source: 'zephyr-app',
            type: 'keyboard-overlap',
            keyboardOpen: !!open,
            // Parent already cropped iframe: child layout overlap stays zero;
            // frameKeyboardOverlap records the exact pre-crop physical overlap.
            keyboardOverlap: 0,
            frameKeyboardOverlap: Math.round(frameKeyboardOverlap || 0),
            parentShellManaged: true,
            keyboardTop: Math.round(keyboardTop || 0),
            parentInset: Math.round(screenInset || 0),
            shellH: Math.round(shellH || 0),
            heightSource,
            reason,
        }, '*');
    } catch (_) {}
}

/** While IME open, keep posting exact overlap every animation frame (throttled). */
let _sshKbAlignRaf = 0;
let _sshKbAlignLastPost = 0;
function stopSshKbAlignLoop() {
    if (_sshKbAlignRaf) {
        cancelAnimationFrame(_sshKbAlignRaf);
        _sshKbAlignRaf = 0;
    }
}
function startSshKbAlignLoop() {
    if (_sshKbAlignRaf) return;
    const tick = () => {
        _sshKbAlignRaf = 0;
        // Keep looping while open OR while waiting for first physical height.
        if (!sshKbParentOpen && !sshKbParentAwaiting) return;
        const workspace = $('#terminalWorkspace');
        if (!workspace) return;
        const activeFrame = workspace.querySelector(`.terminal-frame[data-frame="${CSS.escape(activeTerminalTab || '')}"]`)
            || workspace.querySelector('.terminal-frame.active');
        if (!activeFrame) {
            _sshKbAlignRaf = requestAnimationFrame(tick);
            return;
        }
        const m = measureParentKeyboardTop();
        if (m.screenInset >= 80) {
            // First real height / track. Quantize lightly via 12px delta to cut thrash.
            const firstPhysical = !sshKbParentSeenPhysical || sshKbParentAwaiting;
            const top = Math.round(m.top);
            const prevTop = Math.round(sshKbParentLastGoodTop || 0);
            const delta = Math.abs(top - prevTop);
            sshKbParentSeenPhysical = true;
            sshKbParentAwaiting = false;
            sshKbParentAwaitingMetrics = null;
            sshKbParentLastGoodInset = m.screenInset;
            sshKbParentLastGoodTop = top;
            sshKbParentInset = m.screenInset;
            sshKbParentLowSince = 0;
            const now = performance.now();
            // First crop immediate; later only if moved >=12px and >=100ms since last post.
            if (firstPhysical || ((delta >= 12) && (now - _sshKbAlignLastPost >= 100))) {
                _sshKbAlignLastPost = now;
                const crop = applyParentIframeShellToKeyboard(activeFrame, top, true);
                sshKbParentOpen = true;
                workspace.classList.add('ssh-kb-open');
                document.documentElement.classList.add('ssh-kb-open');
                postParentShellManaged(activeFrame, {
                    open: true,
                    keyboardTop: top,
                    screenInset: m.screenInset,
                    shellH: crop.shellH,
                    heightSource: `align-loop:${m.source}`,
                    reason: firstPhysical ? 'parent-align-first-physical' : 'parent-align-loop',
                });
                document.documentElement.style.setProperty('--app-keyboard-inset', `${m.screenInset}px`);
                document.documentElement.style.setProperty('--app-keyboard-top', `${top}px`);
                document.documentElement.style.setProperty('--ssh-kb-inset', '0px');
                sshKbParentLastSignature = `parent-shell:1:${crop.shellH}:${top}`;
            }
        } else if (sshKbParentSeenPhysical) {
            const now = Date.now();
            if (!sshKbParentLowSince) sshKbParentLowSince = now;
            // 280ms continuous low before close (was 100 — too eager).
            if (now - sshKbParentLowSince >= 280) {
                sshKbParentOpen = false;
                sshKbParentAwaiting = false;
                sshKbParentAwaitingMetrics = null;
                sshKbParentInset = 0;
                sshKbParentLastGoodInset = 0;
                sshKbParentLastGoodTop = 0;
                sshKbParentSeenPhysical = false;
                sshKbParentLastSignature = '';
                document.documentElement.classList.remove('ssh-kb-open');
                workspace.classList.remove('ssh-kb-open');
                document.documentElement.style.setProperty('--ssh-kb-inset', '0px');
                document.documentElement.style.setProperty('--app-keyboard-inset', '0px');
                document.documentElement.style.setProperty('--app-keyboard-top', '100vh');
                applyParentIframeShellToKeyboard(activeFrame, m.layoutH, false);
                postParentShellManaged(activeFrame, {
                    open: false,
                    keyboardTop: m.layoutH,
                    reason: 'parent-align-loop-close',
                });
                return;
            }
        } else if (sshKbParentAwaiting) {
            if (Date.now() - sshKbParentAwaitingSince > 4000) {
                sshKbParentAwaiting = false;
                sshKbParentAwaitingMetrics = null;
                return;
            }
        }
        _sshKbAlignRaf = requestAnimationFrame(tick);
    };
    _sshKbAlignRaf = requestAnimationFrame(tick);
}

function applyTerminalWorkspaceKeyboard(metrics = {}) {
    const workspace = $('#terminalWorkspace');
    if (!workspace) return;
    const activeSession = getTerminalSession(activeTerminalTab);
    const isCompact = isCompactTerminalWorkspace();
    const isTouchDevice = window.matchMedia?.('(hover: none) and (pointer: coarse)')?.matches;
    const isStableInput = !!(metrics.stableInput || (activeSession?.protocol === 'SSH' && isCompact && isTouchDevice));
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
    const fullscreenWindow = activeTerminalTab ? workspace.querySelector(`.terminal-window[data-window="${CSS.escape(activeTerminalTab)}"]`) : null;
    const isFullscreenTerminalSurface = fullscreenElement === workspace || fullscreenElement === fullscreenWindow || workspace.classList.contains('custom-fullscreen');
    const childInset = Math.round(Number(metrics.keyboardInset) || 0);

    // Physical keyboard edge in PARENT coordinates (single source of truth).
    const measured = measureParentKeyboardTop();
    const parentKeyboardTop = measured.top;
    const parentInset = measured.screenInset;
    const parentLayoutHeight = measured.layoutH;
    const parentVvHeight = measured.vvHeight || Math.round(window.visualViewport?.height || parentLayoutHeight);
    const layoutHeight = parentLayoutHeight;

    // OPEN intent: child facade only. Parent never invents open from VV alone.
    const childOpen = !!(
        metrics.keyboardOpen
        || metrics.intent === 'open'
        || metrics.phase === 'open'
        || metrics.phase === 'opening'
    );

    // Screen keyboard height. Child geometry uses frame overlap.
    // F2 parent: NEVER invent provisional 32%/260–360 crop. That was the
    // "tools fly up ~1s then drop" bug (normal + custom fullscreen share this).
    // Crop only with live vv / real child height / brief last-good while already open.
    let effectiveInset = 0;
    let heightSource = 'none';
    let physicalKeyboardTop = layoutHeight;
    if (childOpen) {
        if (parentInset >= 80) {
            effectiveInset = parentInset;
            physicalKeyboardTop = parentKeyboardTop;
            heightSource = measured.source || 'parent';
            sshKbParentSeenPhysical = true;
            sshKbParentLastGoodInset = parentInset;
            sshKbParentLastGoodTop = parentKeyboardTop;
            sshKbParentLowSince = 0;
        } else if (childInset >= 80) {
            // Child has a real height but parent VV is 0 (some overlays builds).
            effectiveInset = childInset;
            physicalKeyboardTop = (sshKbParentLastGoodTop > 0)
                ? sshKbParentLastGoodTop
                : Math.max(0, layoutHeight - childInset);
            heightSource = 'child-metrics';
            sshKbParentSeenPhysical = true;
            sshKbParentLastGoodInset = childInset;
            sshKbParentLastGoodTop = physicalKeyboardTop;
        } else if (sshKbParentOpen && sshKbParentSeenPhysical && (sshKbParentLastGoodInset || 0) >= 80) {
            // Continuous open mid-animation dip only — not first open, not re-open.
            effectiveInset = sshKbParentLastGoodInset;
            physicalKeyboardTop = sshKbParentLastGoodTop || Math.max(0, layoutHeight - effectiveInset);
            heightSource = 'last-good';
        } else {
            // No physical reading yet: DO NOT crop. Wait for live vv via align loop.
            // One settle to real height beats fly-then-correct.
            effectiveInset = 0;
            physicalKeyboardTop = layoutHeight;
            heightSource = 'await-physical';
        }
    } else {
        effectiveInset = 0;
        physicalKeyboardTop = layoutHeight;
        sshKbParentLastGoodInset = 0;
        sshKbParentLastGoodTop = 0;
        sshKbParentSeenPhysical = false;
        sshKbParentLowSince = 0;
        stopSshKbAlignLoop();
    }

    // Integer px only — no 4/16 quantize lag that leaves tools floating.
    effectiveInset = Math.max(0, Math.round(effectiveInset));
    physicalKeyboardTop = Math.max(0, Math.round(physicalKeyboardTop));

    // Real height only. Provisional path removed — no fake open crop.
    const keyboardOpen = childOpen && effectiveInset >= 80;

    // Stable SSH mobile (stable-overlay): parent owns the shell crop and keeps
    // workspace geometry unclipped; child receives the exact iframe overlap.
    if (isStableInput && isCompact) {
        const liftMode = metrics.liftMode === 'none' || metrics.inputSource === 'cmd' || metrics.source === 'cmd'
            ? 'none'
            : 'workspace';
        let finalOpen = keyboardOpen && liftMode === 'workspace';
        const activeFrame = workspace.querySelector(`.terminal-frame[data-frame="${CSS.escape(activeTerminalTab || '')}"]`)
            || workspace.querySelector('.terminal-frame.active');

        if (!childOpen) {
            finalOpen = false;
            sshKbParentAwaiting = false;
            sshKbParentAwaitingMetrics = null;
            stopSshKbAlignLoop();
        } else if (heightSource === 'await-physical') {
            // Intent open, no real height yet: do not crop, do not post close.
            // Align loop waits for first physical height then crops once.
            finalOpen = false;
            sshKbParentAwaiting = true;
            sshKbParentAwaitingSince = Date.now();
            sshKbParentAwaitingMetrics = {
                ...metrics,
                stableInput: true,
                keyboardOpen: true,
                liftMode,
                heightSource: 'await-physical',
            };
            // Uncrop if a previous provisional/stale crop is still applied.
            if (activeFrame && sshKbParentOpen) {
                applyParentIframeShellToKeyboard(activeFrame, layoutHeight, false);
                sshKbParentOpen = false;
                sshKbParentLastSignature = '';
            }
            workspace.classList.remove('ssh-kb-open');
            document.documentElement.classList.remove('ssh-kb-open');
            document.documentElement.style.setProperty('--app-keyboard-inset', '0px');
            document.documentElement.style.setProperty('--app-keyboard-top', '100vh');
            document.documentElement.style.setProperty('--ssh-kb-inset', '0px');
            // Tell child intent is still open but no shell crop yet (inset 0).
            // Do NOT send keyboardOpen:false — that re-closes child intent.
            postParentShellManaged(activeFrame, {
                open: true,
                keyboardTop: layoutHeight,
                screenInset: 0,
                shellH: 0,
                heightSource: 'await-physical',
                reason: `${metrics.reason || 'parent-shell'}:await-physical`,
            });
            startSshKbAlignLoop();
            console.info('[TerminalLayoutDiagnostics]', {
                event: 'parent:await-physical',
                childOpen,
                parentInset,
                childInset,
                layoutHeight,
            });
            return;
        } else if (sshKbParentSeenPhysical && parentInset < 40 && parentVvHeight >= (sshKbParentBaseline || layoutHeight) - 16) {
            const now = Date.now();
            if (!sshKbParentLowSince) sshKbParentLowSince = now;
            if (now - sshKbParentLowSince >= 280) {
                // Physical height authority: parent-physical-close owns the
                // final close after visualViewport remains at baseline.
                finalOpen = false;
                sshKbParentLastGoodInset = 0;
                sshKbParentLastGoodTop = 0;
                sshKbParentAwaiting = false;
                stopSshKbAlignLoop();
            }
        } else {
            sshKbParentLowSince = 0;
        }

        // Crop shell first, then notify child (child does not shrink again).
        // Fresh open after close: bust signature so we never skip re-crop.
        if (finalOpen && !sshKbParentOpen) {
            sshKbParentLastSignature = '';
            sshKbParentAwaiting = false;
            sshKbParentAwaitingMetrics = null;
        }
        if (!finalOpen && sshKbParentOpen) {
            // Closing edge: drop last-good so next open cannot reuse old keyboard top.
            sshKbParentLastGoodInset = 0;
            sshKbParentLastGoodTop = 0;
            sshKbParentLastSignature = '';
            sshKbParentAwaiting = false;
            sshKbParentAwaitingMetrics = null;
        }

        let cropTop = Math.round(physicalKeyboardTop || 0);
        let cropInset = effectiveInset;

        let crop = { shellH: 0, top: 0, kTop: cropTop };
        const frameRect = activeFrame?.getBoundingClientRect?.();
        const frameKeyboardOverlap = finalOpen && frameRect
            ? Math.max(0, Math.round(frameRect.bottom - physicalKeyboardTop))
            : 0;
        if (activeFrame) {
            crop = applyParentIframeShellToKeyboard(activeFrame, cropTop, finalOpen);
        }

        const signature = `stable-overlay:${finalOpen ? 1 : 0}:${crop.shellH || 0}:${cropTop}:${frameKeyboardOverlap}`;
        if (signature === sshKbParentLastSignature) {
            sshKbParentOpen = finalOpen;
            if (finalOpen || sshKbParentAwaiting) startSshKbAlignLoop();
            return;
        }
        sshKbParentLastSignature = signature;
        sshKbParentOpen = finalOpen;
        sshKbParentPendingMetrics = finalOpen
            ? { ...metrics, stableInput: true, keyboardOpen: true, keyboardInset: cropInset, liftMode, heightSource }
            : null;

        workspace.classList.toggle('ssh-kb-open', finalOpen);
        document.documentElement.classList.toggle('ssh-kb-open', finalOpen);
        document.documentElement.style.setProperty('--app-keyboard-inset', finalOpen ? `${cropInset}px` : '0px');
        document.documentElement.style.setProperty('--app-keyboard-top', finalOpen ? `${cropTop}px` : '100vh');
        document.documentElement.style.setProperty('--app-keyboard-shift', '0px');
        document.documentElement.style.setProperty('--app-visual-vh', '100vh');
        document.documentElement.style.setProperty('--app-visual-offset-top', '0px');
        // Parent shell managed: child inset channel stays 0 (no double shrink).
        document.documentElement.style.setProperty('--ssh-kb-inset', '0px');
        if (finalOpen) sshKbParentInset = cropInset;
        else sshKbParentInset = 0;

        document.body.classList.remove('ssh-kb-lift');
        // Do NOT force iframe height:100% of uncropped window — shell crop owns height.
        workspace.style.flex = '';
        workspace.style.marginBottom = '0px';

        postParentShellManaged(activeFrame, {
            open: finalOpen,
            keyboardTop: cropTop,
            screenInset: cropInset,
            shellH: crop.shellH,
            frameKeyboardOverlap,
            heightSource,
            reason: metrics.reason || 'parent-shell',
        });

        console.info('[TerminalLayoutDiagnostics]', {
            event: 'parent:shell-crop',
            finalOpen,
            shellH: crop.shellH,
            shellTop: crop.top,
            physicalKeyboardTop: cropTop,
            effectiveInset: cropInset,
            parentInset,
            childInset,
            heightSource,
            measureSource: measured.source,
        });

        if (finalOpen || sshKbParentAwaiting) startSshKbAlignLoop();
        else stopSshKbAlignLoop();
        return;
    }

// Non-stable / fullscreen path: still use measured keyboard top.
    if (!keyboardOpen || !isFullscreenTerminalSurface) {
        if (!keyboardOpen) {
            stopSshKbAlignLoop();
            resetTerminalWorkspaceKeyboard();
        }
        return;
    }

    const parentOffsetTop = Math.round(window.visualViewport?.offsetTop || 0);
    const signature = `${effectiveInset}:${physicalKeyboardTop}:${parentOffsetTop}`;
    sshKbParentPendingMetrics = {
        ...metrics,
        keyboardInset: effectiveInset,
        viewportHeight: parentVvHeight || Math.max(0, layoutHeight - effectiveInset),
        offsetTop: parentOffsetTop,
        keyboardOpen: true,
    };
    workspace.classList.add('ssh-kb-settling');
    postTerminalKeyboardFreeze(true, 'parent-ssh-kb-opening', { settleMs: 1200 });
    window.clearTimeout(sshKbParentFreezeReleaseTimer);
    if (signature === sshKbParentLastSignature && sshKbParentOpen) return;
    sshKbParentLastSignature = signature;
    window.clearTimeout(sshKbParentSettleTimer);
    sshKbParentSettleTimer = window.setTimeout(() => {
        commitTerminalWorkspaceKeyboard(sshKbParentPendingMetrics || metrics);
        sshKbParentFreezeReleaseTimer = window.setTimeout(() => postTerminalKeyboardFreeze(false, 'parent-ssh-kb-open-settled'), 1100);
    }, sshKbParentOpen ? 70 : 110);
}
 
function updateFullscreenKeyboardFromViewport() {
    const workspace = $('#terminalWorkspace');
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
    const isCompact = isCompactTerminalWorkspace();
    const isKeyboardRelevant = workspace?.classList.contains('custom-fullscreen')
        || fullscreenElement === workspace
        || fullscreenElement?.classList?.contains('terminal-window')
        || (isCompact && document.body.classList.contains('terminal-mode'));
    if (!workspace || !isKeyboardRelevant) return;
    const m = measureParentKeyboardTop();
    const alreadyOpen = !!(sshKbParentOpen || workspace.classList.contains('ssh-kb-open'));
    // Closed: only refresh baseline. Never invent open from parent visualViewport inset.
    if (!alreadyOpen) {
        sshKbParentBaseline = Math.max(sshKbParentBaseline || 0, m.layoutH, m.vvHeight || 0);
        return;
    }
    // Already child-open: refresh with live keyboard top (align loop also runs).
    applyTerminalWorkspaceKeyboard({
        keyboardOpen: true,
        intent: 'open',
        phase: 'open',
        keyboardInset: Math.max(m.screenInset, sshKbParentInset || 0),
        viewportHeight: m.vvHeight || Math.max(0, m.layoutH - m.screenInset),
        layoutHeight: m.layoutH,
        offsetTop: Math.round(window.visualViewport?.offsetTop || 0),
        stableInput: true,
        liftMode: 'workspace',
        reason: 'parent-fullscreen-geometry-refresh',
    });
}
 
function scheduleTerminalKeyboardReflow(reason = 'terminal-keyboard-reflow') {
    sshKbParentLastSignature = '';
    [0, 80, 180, 360, 720].forEach((delay, index) => {
        window.setTimeout(() => {
            sshKbParentLastSignature = '';
            updateFullscreenKeyboardFromViewport();
            scheduleTerminalLayoutStabilize(`${reason}:phase-${index}`, { focus: false });
        }, delay);
    });
}

function clearTerminalFullscreenInline(workspace) {
    if (!workspace) return;
    for (const prop of ['position', 'left', 'width', 'right', 'top', 'bottom', 'zIndex', 'willChange', 'maxHeight', 'minHeight', 'overflow', 'boxSizing', 'borderRadius', 'transform', 'opacity', 'filter', 'transition']) {
        workspace.style[prop] = '';
    }
    workspace.style.removeProperty('height');
}

function terminalWorkspaceRadiusPx(el) {
    const r = parseFloat(getComputedStyle(el)?.borderRadius);
    return Number.isFinite(r) && r > 0 ? r : 12;
}

/**
 * Mobile terminal fullscreen: bottom-anchored height stretch via Motion.stretchExpand.
 * Open and close share the same spring so mid-flight reverse is continuous.
 * No spinner / loading overlay.
 */
async function animateMobileTerminalFullscreen(workspace, { open }) {
    if (!workspace) return false;
    const gen = ++terminalFullscreenMotionGen;
    const Motion = await sshKeyMotion._ensure();
    const vh = Math.max(window.innerHeight || 0, document.documentElement?.clientHeight || 0, 1);
    if (!Motion?.stretchExpand || sshKeyMotion.failed) {
        // Instant fallback — still no spinner.
        if (open) {
            terminalFullscreenOriginRect = workspace.getBoundingClientRect();
            workspace.classList.add('custom-fullscreen');
            document.body.classList.add('terminal-custom-fullscreen-open');
        } else {
            workspace.classList.remove('custom-fullscreen');
            document.body.classList.remove('terminal-custom-fullscreen-open');
            terminalFullscreenOriginRect = null;
        }
        clearTerminalFullscreenInline(workspace);
        return gen === terminalFullscreenMotionGen;
    }

    if (open) {
        const fromRect = workspace.getBoundingClientRect();
        terminalFullscreenOriginRect = {
            left: fromRect.left,
            top: fromRect.top,
            width: fromRect.width,
            height: fromRect.height,
            bottom: fromRect.bottom,
            right: fromRect.right,
        };
        const radiusFrom = terminalWorkspaceRadiusPx(workspace);
        // Freeze the measured collapsed presentation before fixed positioning.
        // Late `height:100%!important` shell rules otherwise win the first paint.
        workspace.style.setProperty('height', `${fromRect.height}px`, 'important');
        // Full-bleed X from frame 0; only height/radius spring (no horizontal flash).
        const ok = await Motion.stretchExpand(workspace, {
            open: true,
            fromRect,
            fromHeight: fromRect.height,
            toHeight: vh,
            pinBottom: 0,
            fullBleedX: true,
            radiusFrom,
            radiusTo: 0,
            release: false,
            clearInline: false,
        });
        if (gen !== terminalFullscreenMotionGen) return false;
        workspace.classList.add('custom-fullscreen');
        document.body.classList.add('terminal-custom-fullscreen-open');
        try { Motion.release(workspace); } catch {}
        clearTerminalFullscreenInline(workspace);
        return ok && gen === terminalFullscreenMotionGen;
    }

    // Close: keep the body in fullscreen state while the workspace shrinks.
    // Removing that class first made the entire mobile nav appear in one paint.
    const fullRect = workspace.getBoundingClientRect();
    const origin = terminalFullscreenOriginRect;
    const targetTop = Math.max(0, Number(origin?.top) || 0);
    const collapsedH = Math.max(1, Number(origin?.height) || Math.round(vh * 0.6));
    const targetBottom = Math.max(0, vh - targetTop - collapsedH);
    const radiusTo = (() => {
        const raw = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--terminal-card-radius'));
        return Number.isFinite(raw) && raw > 0 ? raw : 12;
    })();
    workspace.style.position = 'fixed';
    workspace.style.left = '0';
    workspace.style.right = '0';
    workspace.style.width = '100vw';
    workspace.style.top = 'auto';
    workspace.style.bottom = '0';
    workspace.style.setProperty('height', `${fullRect.height}px`, 'important');
    workspace.style.borderRadius = '0px';
    workspace.style.zIndex = '1000';
    workspace.style.transition = 'none';
    document.body.classList.add('terminal-fullscreen-exiting');
    const nav = document.querySelector('.main-nav');
    if (nav) {
        nav.style.display = 'flex';
        nav.style.visibility = 'visible';
        nav.style.pointerEvents = 'none';
        nav.style.willChange = 'transform, opacity';
    }
    let navMotion = Promise.resolve();
    if (nav) {
        Motion.set(nav, { y: -Math.max(1, nav.getBoundingClientRect().height), opacity: 0 });
        navMotion = Motion.to(nav, { y: 0, opacity: 1 }, { preset: { response: 0.30, damping: 1 } });
    }
    const workspaceMotion = Motion.stretchExpand(workspace, {
        open: false,
        fromRect: fullRect,
        fromHeight: fullRect.height,
        toHeight: collapsedH,
        pinBottom: targetBottom,
        fullBleedX: true,
        radiusFrom: 0,
        radiusTo,
        release: false,
        clearInline: false,
    });
    const [ok] = await Promise.all([workspaceMotion, navMotion]);
    if (gen !== terminalFullscreenMotionGen) return false;
    workspace.classList.remove('custom-fullscreen');
    document.body.classList.remove('terminal-custom-fullscreen-open', 'terminal-fullscreen-exiting');
    try { Motion.release(workspace); } catch {}
    if (nav) {
        try { Motion.release(nav); } catch {}
        nav.style.display = '';
        nav.style.visibility = '';
        nav.style.pointerEvents = '';
        nav.style.willChange = '';
    }
    clearTerminalFullscreenInline(workspace);
    terminalFullscreenOriginRect = null;
    return ok && gen === terminalFullscreenMotionGen;
}

async function fullscreenTerminalTab(tabId) {
    const compact = isCompactTerminalWorkspace();
    const visibleBefore = visibleTerminalTabs().map((t) => t.id);
    console.debug('[terminal-layout]', 'fullscreen requested', {
        tabId,
        compact,
        visibleCount: visibleBefore.length,
        maxWindows: getEffectiveTerminalMaxWindows()
    });

    restoreTerminalSession(tabId);
    activeTerminalTab = tabId;
    touchTerminalSession(tabId);
    renderTerminalTabs();
    const workspace = $('#terminalWorkspace');
    const win = workspace?.querySelector(`.terminal-window[data-window="${CSS.escape(tabId)}"]`);
    if (!workspace || !win) return;
    try {
        if (compact) {
            const entering = !workspace.classList.contains('custom-fullscreen');
            resetTerminalWorkspaceKeyboard({ force: true });
            await animateMobileTerminalFullscreen(workspace, { open: entering });
            sshKbParentLastSignature = '';
            scheduleTerminalKeyboardReflow(entering ? 'mobile-fullscreen-enter' : 'mobile-fullscreen-exit');
            renderTerminalTabs();
            window.setTimeout(() => {
                scheduleTerminalKeyboardReflow('mobile-fullscreen-after-focus');
                win.querySelector('.terminal-frame')?.contentWindow?.postMessage({ source: 'zephyr-app', type: 'focus-terminal' }, '*');
            }, 120);
        } else {
            const minimizedIds = visibleBefore.filter((id) => id !== tabId);
            minimizedIds.forEach((id) => {
                const session = getTerminalSession(id);
                if (session) session.minimized = true;
            });
            visualLayout = [tabId];
            activeTerminalTab = tabId;
            syncVisualLayout({ preserve: false });
            console.debug('[terminal-layout]', 'desktop fullscreen uses single-window layout', {
                tabId,
                minimizedIds,
                visualLayout: [...visualLayout]
            });
            renderTerminalTabs();
            window.setTimeout(() => {
                workspace.querySelector(`.terminal-frame[data-frame="${CSS.escape(tabId)}"]`)?.contentWindow?.postMessage({ source: 'zephyr-app', type: 'focus-terminal' }, '*');
            }, 120);
        }
    } catch (err) {
        clearTerminalFullscreenInline(workspace);
        document.body.classList.remove('terminal-fullscreen-exiting');
        const nav = document.querySelector('.main-nav');
        if (nav) {
            nav.style.display = '';
            nav.style.visibility = '';
            nav.style.pointerEvents = '';
            nav.style.willChange = '';
        }
        throw err;
    }
}

function isTerminalSmartbarInteractionTarget(target) {
    return !!target?.closest?.(
        '.terminal-smartbar, .smartbar-panel, .smartbar-dock, .smartbar-session, .smartbar-add, .smartbar-handle, .smartbar-picker, .mobile-fullscreen-dock-toggle, [data-smartbar-toggle], [data-smartbar-tab], [data-smartbar-add], [data-smartbar-connect], [data-smartbar-picker-close]'
    );
}

function noteTerminalSmartbarPointerInside(inside = true) {
    terminalSmartbarPointerInside = !!inside;
    if (inside) terminalSmartbarLastInnerPointerAt = Date.now();
}

/** 指针在 dock 区域：不计时；离开后 10s 无交互再关。 */
function scheduleTerminalSmartbarAutoClose(delay = TERMINAL_SMARTBAR_AUTO_CLOSE_MS) {
    window.clearTimeout(terminalSmartbarTimer);
    if (!terminalSmartbarOpen) return;
    // 鼠标/手指仍在 dock 上时：暂停自动关闭
    if (terminalSmartbarPointerInside) return;
    const wait = Math.max(0, Number(delay) || TERMINAL_SMARTBAR_AUTO_CLOSE_MS);
    terminalSmartbarTimer = window.setTimeout(() => {
        if (!terminalSmartbarOpen) return;
        if (terminalSmartbarPointerInside) return;
        // 离开后若又点过 dock 内，从最后一次内交互重新计 10s
        const idle = Date.now() - terminalSmartbarLastInnerPointerAt;
        if (idle < wait) {
            scheduleTerminalSmartbarAutoClose(wait - idle);
            return;
        }
        setTerminalSmartbarOpen(false);
    }, wait);
}

function setTerminalSmartbarOpen(open) {
    window.clearTimeout(terminalSmartbarTimer);
    window.clearTimeout(setTerminalSmartbarOpen._closeTimer);
    if (!open) {
        document.querySelectorAll('#terminalWorkspace .terminal-frame').forEach((frame) => frame.style.pointerEvents = '');
        terminalSmartbarPointerInside = false;
        if (!terminalSmartbarOpen) return;
        terminalSmartbarOpen = false;
        terminalSmartbarPickerOpen = false;
        terminalSmartbarClosing = true;
        renderTerminalSmartbar();
        syncTerminalShelfLineState();
        scheduleTerminalKeyboardReflow('smartbar-close');
        setTerminalSmartbarOpen._closeTimer = window.setTimeout(() => {
            terminalSmartbarClosing = false;
            renderTerminalSmartbar();
            syncTerminalShelfLineState();
            scheduleTerminalKeyboardReflow('smartbar-close-settled');
        }, 760);
        return;
    }
    terminalSmartbarLastInnerPointerAt = Date.now();
    // 不强制 inside：只有真实 pointer 在 dock 上才暂停；否则从打开起 10s 无交互关闭
    $('.main-nav')?.classList.remove('terminal-shelf-settled', 'terminal-shelf-dock-open');
    terminalSmartbarClosing = false;
    terminalSmartbarOpen = true;
    renderTerminalSmartbar();
    syncTerminalShelfLineState();
    scheduleTerminalKeyboardReflow('smartbar-open');
    scheduleTerminalSmartbarAutoClose(TERMINAL_SMARTBAR_AUTO_CLOSE_MS);
}
function noteTerminalWorkspaceActivity() {}
function swapTerminalWindows(a, b) {
    if (!a || !b || a === b) return;
    const ia = visualLayout.indexOf(a), ib = visualLayout.indexOf(b);
    if (ia < 0 || ib < 0) return;
    [visualLayout[ia], visualLayout[ib]] = [visualLayout[ib], visualLayout[ia]];
    renderTerminalTabs();
}
function snapTerminalWindowToEdge(tabId, clientX, clientY) {
    const workspace = $('#terminalWorkspace');
    if (!workspace || isCompactTerminalWorkspace()) return false;
    const rect = workspace.getBoundingClientRect();
    const nearLeft = clientX - rect.left <= TERMINAL_EDGE_SNAP_PX;
    const nearRight = rect.right - clientX <= TERMINAL_EDGE_SNAP_PX;
    const nearTop = clientY - rect.top <= TERMINAL_EDGE_SNAP_PX;
    const nearBottom = rect.bottom - clientY <= TERMINAL_EDGE_SNAP_PX;
    if (!nearLeft && !nearRight && !nearTop && !nearBottom) return false;
    if (nearLeft) applyTerminalWindowPreset(tabId, 'left-half');
    else if (nearRight && nearTop) applyTerminalWindowPreset(tabId, 'right-top');
    else if (nearRight && nearBottom) applyTerminalWindowPreset(tabId, 'right-bottom');
    else if (nearRight) applyTerminalWindowPreset(tabId, 'right-half');
    else if (nearTop) applyTerminalWindowPreset(tabId, 'left-two-thirds');
    else applyTerminalWindowPreset(tabId, 'right-two-thirds');
    return true;
}
function reorderTerminalOrder(dragId, targetId) {
    if (!dragId || !targetId || dragId === targetId) return;
    const order = getTerminalSmartbarOrder();
    const stack = order === 'new-first' ? [...openOrderStack].reverse() : [...openOrderStack];
    const from = stack.indexOf(dragId);
    const to = stack.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const [id] = stack.splice(from, 1);
    stack.splice(to, 0, id);
    openOrderStack = order === 'new-first' ? stack.reverse() : stack;
}
const DOCK_MAGNIFY_SELECTOR = '.smartbar-session, .smartbar-add';
function isVerticalSmartbarDock() {
    return isCompactTerminalWorkspace() && document.body.classList.contains('terminal-custom-fullscreen-open');
}
function resetDockMagnification(dock = document.querySelector('.smartbar-dock')) {
    if (!dock) return;
    // 演示页 §9 同源：Motion.dockMagnifyReset 用 spring 收回，不是瞬间清 CSS 变量。
    const Motion = sshKeyMotion.engine;
    if (Motion?.dockMagnifyReset) {
        Motion.dockMagnifyReset(dock, {
            itemSelector: DOCK_MAGNIFY_SELECTOR,
            preset: 'snappy',
        });
        return;
    }
    dock.querySelectorAll(DOCK_MAGNIFY_SELECTOR).forEach((item) => {
        item.style.removeProperty('--dock-scale');
        item.style.removeProperty('--dock-lift');
        item.style.removeProperty('--dock-shift');
        item.style.removeProperty('--dock-blur');
        item.style.removeProperty('--dock-rotate');
    });
}
function updateDockMagnification(clientX, dock = document.querySelector('.smartbar-dock'), clientY = null) {
    if (!dock) return;
    const verticalDock = isVerticalSmartbarDock();
    const Motion = sshKeyMotion.engine;
    const y = clientY ?? smartbarDragState?.currentY ?? 0;
    if (verticalDock) {
        // 全屏竖栏：横栏「左右推邻」→ 上下推邻；「上浮」仍为 −Y；无侧向弹出
        if (Motion?.dockMagnifyVerticalPointer) {
            Motion.dockMagnifyVerticalPointer(dock, clientX, y, {
                itemSelector: DOCK_MAGNIFY_SELECTOR,
                influence: 110,
                maxScale: 1.22,
                maxLift: 12,
                maxSpread: 8,
                maxRotate: 0.7,
                maxBlur: 0.12,
                preset: 'dock',
            });
            return;
        }
    } else if (Motion?.dockMagnifyPointer) {
        // 横栏：演示页 §9 同源
        Motion.dockMagnifyPointer(dock, clientX, y, {
            itemSelector: DOCK_MAGNIFY_SELECTOR,
            influence: 142,
            maxScale: 1.26,
            maxLift: 15,
            maxShift: 8,
            maxRotate: 0.7,
            maxBlur: 0.14,
            preset: 'dock',
        });
        return;
    }
    // 引擎未就绪瞬时回退
    if (verticalDock) {
        const influence = 110;
        const pointerCoord = y;
        dock.querySelectorAll(DOCK_MAGNIFY_SELECTOR).forEach((item) => {
            const rect = item.getBoundingClientRect();
            const center = rect.top + rect.height / 2;
            const d = Math.abs(pointerCoord - center);
            const t = Math.max(0, 1 - d / influence);
            const eased = 1 - Math.pow(1 - t, 3);
            const direction = Math.sign(center - pointerCoord);
            item.style.setProperty('--dock-scale', (1 + eased * 0.22).toFixed(3));
            // 上浮 + 上下推邻；shift 恒 0
            item.style.setProperty('--dock-lift', `${(-eased * 12 + direction * eased * 8).toFixed(2)}px`);
            item.style.setProperty('--dock-shift', '0px');
            item.style.setProperty('--dock-blur', `${((1 - eased) * 0.12).toFixed(2)}px`);
            item.style.setProperty('--dock-rotate', `${(direction * eased * -0.7).toFixed(2)}deg`);
        });
        return;
    }
    const influence = 142;
    const pointerCoord = clientX;
    dock.querySelectorAll(DOCK_MAGNIFY_SELECTOR).forEach((item) => {
        const rect = item.getBoundingClientRect();
        const center = rect.left + rect.width / 2;
        const d = Math.abs(pointerCoord - center);
        const t = Math.max(0, 1 - d / influence);
        const eased = 1 - Math.pow(1 - t, 3);
        const direction = Math.sign(center - pointerCoord);
        item.style.setProperty('--dock-scale', (1 + eased * 0.26).toFixed(3));
        item.style.setProperty('--dock-lift', `${(-eased * 15).toFixed(2)}px`);
        item.style.setProperty('--dock-shift', `${(direction * eased * 8).toFixed(2)}px`);
        item.style.setProperty('--dock-blur', `${((1 - eased) * 0.14).toFixed(2)}px`);
        item.style.setProperty('--dock-rotate', `${(direction * eased * -0.7).toFixed(2)}deg`);
    });
}
function animateWindowFromDock(tabId, sourceRect, { swap = false } = {}) {
    if (!tabId || !sourceRect) return;
    requestAnimationFrame(() => {
        const win = document.querySelector(`#terminalWorkspace .terminal-window[data-window="${CSS.escape(tabId)}"]`);
        if (!win) return;
        const rect = win.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const sx = Math.max(0.08, sourceRect.width / rect.width);
        const sy = Math.max(0.06, sourceRect.height / rect.height);
        const dx = (sourceRect.left + sourceRect.width / 2) - (rect.left + rect.width / 2);
        const dy = (sourceRect.top + sourceRect.height / 2) - (rect.top + rect.height / 2);
        const shellRadius = `${parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--radius-lg')) || 18}px`;
        win.animate([
            { transform: `translate3d(${dx}px, ${dy}px, 0) scale3d(${sx}, ${sy}, 1)`, opacity: 0.28, filter: 'blur(18px) saturate(.82)', borderRadius: '30px' },
            { transform: `translate3d(${dx * 0.16}px, ${dy * 0.16 - 8}px, 0) scale3d(1.025, 1.018, 1)`, opacity: 1, filter: 'blur(0) saturate(1.08)', borderRadius: shellRadius, offset: 0.72 },
            { transform: 'translate3d(0, 0, 0) scale3d(1, 1, 1)', opacity: 1, filter: 'blur(0) saturate(1)', borderRadius: shellRadius }
        ], { duration: swap ? 620 : 560, easing: 'cubic-bezier(.16,1,.3,1)' });
    });
}
function activateTerminalFromDock(tabId, sourceEl = null) {
    const sourceRect = sourceEl?.getBoundingClientRect?.();
    const t = getTerminalSession(tabId);
    if (!t) return;
    const mobileSwitch = isCompactTerminalWorkspace();
    if (mobileSwitch) resetTerminalWorkspaceKeyboard({ force: true });
    dockLaunchAnimatingWindows.add(tabId);
    const mobileFullscreen = mobileSwitch && document.body.classList.contains('terminal-custom-fullscreen-open');
    if (!mobileFullscreen && t && !t.minimized && activeTerminalTab === tabId) minimizeTerminalSession(tabId);
    else showTerminalSessionInWorkspace(tabId);
    if (!mobileFullscreen) scheduleTerminalSmartbarAutoClose();
    renderTerminalTabs();
    if (mobileSwitch) {
        forceCompactTerminalWorkspaceFill('dock-activate');
        scheduleTerminalLayoutStabilize('dock-activate-mobile', { focus: true, tabId });
        window.setTimeout(() => scheduleTerminalLayoutStabilize('dock-activate-mobile-settled', { focus: true, tabId }), 180);
    }
    animateWindowFromDock(tabId, sourceRect, { swap: false });
    window.setTimeout(() => {
        dockLaunchAnimatingWindows.delete(tabId);
        renderTerminalTabs({ rebuildWorkspace: false });
        if (mobileSwitch) scheduleTerminalLayoutStabilize('dock-activate-animation-settled', { focus: true, tabId });
    }, 620);
}
function replaceWindowWithDockTab(targetWindowId, draggedTabId) {
    if (!targetWindowId || !draggedTabId || targetWindowId === draggedTabId) return false;
    const target = getTerminalSession(targetWindowId);
    const dragged = getTerminalSession(draggedTabId);
    if (!target || !dragged) return false;
    dockSwapAnimatingWindows.add(targetWindowId);
    dockSwapAnimatingWindows.add(draggedTabId);
    target.minimized = true;
    dragged.minimized = false;
    const idx = visualLayout.indexOf(targetWindowId);
    if (idx >= 0) visualLayout[idx] = draggedTabId;
    else visualLayout.unshift(draggedTabId);
    activeTerminalTab = draggedTabId;
    touchTerminalSession(draggedTabId);
    syncVisualLayout({ preserve: true });
    renderTerminalTabs();
    window.setTimeout(() => {
        dockSwapAnimatingWindows.delete(targetWindowId);
        dockSwapAnimatingWindows.delete(draggedTabId);
        renderTerminalTabs({ rebuildWorkspace: false });
    }, 560);
    return true;
}
function ensureSmartbarTrashTarget() {
    let trash = document.querySelector('.smartbar-trash-target');
    if (!trash) {
        trash = document.createElement('div');
        trash.className = 'smartbar-trash-target';
        trash.innerHTML = '<span>×</span>';
        document.body.appendChild(trash);
    }
    return trash;
}
function removeSmartbarTrashTarget() {
    document.querySelector('.smartbar-trash-target')?.remove();
    document.body.classList.remove('smartbar-trash-hover');
    smartbarTrashHover = false;
}
function isPointInRect(x, y, rect, pad = 0) {
    return x >= rect.left - pad && x <= rect.right + pad && y >= rect.top - pad && y <= rect.bottom + pad;
}
function startSmartbarIconDrag(e, tabId) {
    const btn = e.target.closest?.('[data-smartbar-tab]');
    if (!btn || e.button === 2) return;
    e.preventDefault();
    suppressSmartbarClick = false;
    const ghost = btn.cloneNode(true);
    ghost.classList.add('smartbar-drag-ghost');
    document.body.appendChild(ghost);
    const trash = ensureSmartbarTrashTarget();
    document.body.classList.add('smartbar-dragging-dock');
    document.querySelectorAll('#terminalWorkspace .terminal-frame').forEach((frame) => frame.style.pointerEvents = 'none');
    const sourceRect = btn.getBoundingClientRect();
    const dock = btn.closest('.smartbar-dock');
    const fullscreenDock = isCompactTerminalWorkspace() && document.body.classList.contains('terminal-custom-fullscreen-open');
    smartbarDragState = {
        tabId,
        startX: e.clientX,
        startY: e.clientY,
        currentX: e.clientX,
        currentY: e.clientY,
        moved: false,
        ghost,
        sourceRect,
        dock,
        originCenterX: sourceRect.left + sourceRect.width / 2,
        originCenterY: sourceRect.top + sourceRect.height / 2,
        raf: 0,
    };
    btn.classList.add('dragging');
    const paintGhost = () => {
        const state = smartbarDragState;
        if (!state) return;
        state.raf = 0;
        const dx = state.currentX - state.startX;
        const dy = state.currentY - state.startY;
        ghost.style.left = `${state.currentX}px`;
        ghost.style.top = `${state.currentY}px`;
        ghost.style.transform = `translate(-50%, -50%) scale(${state.moved ? 1.11 : 1.035}) rotate(${Math.max(-6, Math.min(6, dx * 0.018))}deg)`;
        ghost.style.setProperty('--ghost-dx', `${dx}px`);
        ghost.style.setProperty('--ghost-dy', `${dy}px`);
        if (state.dock) updateDockMagnification(state.currentX, state.dock, state.currentY);
    };
    const schedulePaint = () => {
        if (smartbarDragState?.raf) return;
        smartbarDragState.raf = requestAnimationFrame(paintGhost);
    };
    paintGhost();
    const onMove = (ev) => {
        if (!smartbarDragState) return;
        smartbarDragState.currentX = ev.clientX;
        smartbarDragState.currentY = ev.clientY;
        const dx = ev.clientX - smartbarDragState.startX;
        const dy = ev.clientY - smartbarDragState.startY;
        if (Math.hypot(dx, dy) > 5) smartbarDragState.moved = true;
        ev.preventDefault?.();
        window.getSelection?.()?.removeAllRanges?.();
        schedulePaint();
        ghost.style.pointerEvents = 'none';
        const trashRect = trash.getBoundingClientRect();
        smartbarTrashHover = isPointInRect(ev.clientX, ev.clientY, trashRect, 18);
        document.body.classList.toggle('smartbar-trash-hover', smartbarTrashHover);
        trash.classList.toggle('hover', smartbarTrashHover);
        const hoverWin = smartbarTrashHover ? null : document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.terminal-window[data-window]')?.dataset.window || null;
        if (hoverWin !== smartbarHoverWindowId) {
            smartbarHoverWindowId = hoverWin;
            document.querySelectorAll('.terminal-window').forEach((el) => el.classList.toggle('dock-drop-target', !!hoverWin && el.dataset.window === hoverWin && hoverWin !== tabId));
        }
        const targetDock = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('[data-smartbar-tab]')?.dataset.smartbarTab;
        document.querySelectorAll('[data-smartbar-tab]').forEach((el) => {
            el.classList.toggle('dock-reorder-target', !!targetDock && el.dataset.smartbarTab === targetDock && targetDock !== tabId);
        });
    };
    const cleanup = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        if (smartbarDragState?.raf) cancelAnimationFrame(smartbarDragState.raf);
        resetDockMagnification(dock);
        btn.classList.remove('dragging', 'dock-press-armed');
        document.body.classList.remove('smartbar-dragging-dock');
        document.querySelectorAll('#terminalWorkspace .terminal-frame').forEach((frame) => frame.style.pointerEvents = '');
        document.querySelectorAll('.terminal-window.dock-drop-target').forEach((el) => el.classList.remove('dock-drop-target'));
        document.querySelectorAll('[data-smartbar-tab].dock-reorder-target').forEach((el) => el.classList.remove('dock-reorder-target'));
        smartbarHoverWindowId = null;
        window.setTimeout(removeSmartbarTrashTarget, 180);
        smartbarDragState = null;
    };
    const onCancel = () => {
        cleanup();
        ghost.remove();
    };
    const onUp = (ev) => {
        const moved = smartbarDragState?.moved;
        const source = smartbarDragState?.sourceRect || ghost.getBoundingClientRect();
        const targetWin = smartbarHoverWindowId || document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.terminal-window[data-window]')?.dataset.window;
        const targetDock = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('[data-smartbar-tab]')?.dataset.smartbarTab;
        const dropToTrash = smartbarTrashHover;
        cleanup();
        if (moved || fullscreenDock) {
            suppressSmartbarClick = true;
            if (dropToTrash) {
                ghost.classList.add('smartbar-drag-ghost-closing');
                window.setTimeout(() => ghost.remove(), 220);
                closeTerminalTab(tabId, { reason: 'dock-trash' });
                return;
            }
            if (targetWin && targetWin !== tabId) {
                replaceWindowWithDockTab(targetWin, tabId);
                animateWindowFromDock(tabId, source, { swap: true });
                ghost.remove();
                return;
            }
            if (targetDock && targetDock !== tabId) {
                reorderTerminalOrder(tabId, targetDock);
                renderTerminalSmartbar();
                ghost.remove();
                return;
            }
            if (!fullscreenDock && !targetWin && !targetDock) {
                showTerminalSessionInWorkspace(tabId);
                renderTerminalTabs();
                animateWindowFromDock(tabId, source, { swap: true });
                ghost.remove();
                return;
            }
        }
        ghost.animate([
            { transform: ghost.style.transform || 'translate(-50%, -50%) scale(1.1)', opacity: 1 },
            { transform: 'translate(-50%, -50%) scale(.78)', opacity: 0 }
        ], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' }).onfinish = () => ghost.remove();
    };
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp, { once: true });
    window.addEventListener('pointercancel', onCancel, { once: true });
}

function startSmartbarPress(e, tabBtn) {
    if (!tabBtn || e.button === 2) return;
    e.preventDefault?.();
    window.getSelection?.()?.removeAllRanges?.();
    const tabId = tabBtn.dataset.smartbarTab;
    if (!tabId) return;
    const isDesktopLike = window.matchMedia?.('(hover: hover) and (pointer: fine)')?.matches;
    const holdMs = isDesktopLike && e.pointerType !== 'touch' ? 260 : 420;
    window.clearTimeout(smartbarPressState?.timer);
    smartbarPressState = {
        tabId,
        tabBtn,
        startX: e.clientX,
        startY: e.clientY,
        pointerId: e.pointerId,
        startedAt: performance.now(),
        dragStarted: false,
        cancelled: false,
        originalEvent: e,
        timer: 0,
    };
    tabBtn.classList.add('dock-press-armed');
    const cleanup = ({ keepClick = false } = {}) => {
        if (!smartbarPressState) return;
        window.clearTimeout(smartbarPressState.timer);
        smartbarPressState.tabBtn?.classList.remove('dock-press-armed');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        if (!keepClick) smartbarPressState = null;
    };
    const beginDrag = (ev = e) => {
        if (!smartbarPressState || smartbarPressState.dragStarted || smartbarPressState.cancelled) return;
        smartbarPressState.dragStarted = true;
        if (navigator.vibrate) navigator.vibrate(12);
        smartbarPressState.tabBtn?.setPointerCapture?.(smartbarPressState.pointerId);
        const dragEvent = {
            ...smartbarPressState.originalEvent,
            target: smartbarPressState.tabBtn,
            currentTarget: smartbarPressState.tabBtn,
            clientX: ev.clientX,
            clientY: ev.clientY,
            button: smartbarPressState.originalEvent.button,
            pointerType: smartbarPressState.originalEvent.pointerType,
            preventDefault: () => {},
        };
        startSmartbarIconDrag(dragEvent, smartbarPressState.tabId);
    };
    smartbarPressState.timer = window.setTimeout(() => beginDrag(), holdMs);
    const onMove = (ev) => {
        if (!smartbarPressState || ev.pointerId !== smartbarPressState.pointerId) return;
        const dx = ev.clientX - smartbarPressState.startX;
        const dy = ev.clientY - smartbarPressState.startY;
        ev.preventDefault?.();
        window.getSelection?.()?.removeAllRanges?.();
        if (!smartbarPressState.dragStarted && Math.hypot(dx, dy) > 24) {
            beginDrag(ev);
            return;
        }
    };
    const onUp = () => {
        if (!smartbarPressState) return;
        const state = smartbarPressState;
        const elapsed = performance.now() - state.startedAt;
        const wasDragging = state.dragStarted;
        state.cancelled = true;
        cleanup();
        if (wasDragging) return;
        if (elapsed <= SMARTBAR_TOUCH_TAP_MAX_MS || holdMs < SMARTBAR_TOUCH_DRAG_HOLD_MS) {
            suppressSmartbarClick = true;
            if (navigator.vibrate) navigator.vibrate(6);
            activateTerminalFromDock(state.tabId, state.tabBtn);
        }
    };
    const onCancel = () => {
        if (smartbarPressState) smartbarPressState.cancelled = true;
        smartbarPressState?.tabBtn?.classList.remove('dock-press-armed');
        cleanup();
    };
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp, { once: true });
    window.addEventListener('pointercancel', onCancel, { once: true });
}

function startTerminalWindowDrag(e, tabId) {
    if (isCompactTerminalWorkspace() || (e.target.closest?.('button') && !e.target.closest?.('.terminal-grip'))) return;
    const win = e.target.closest?.('.terminal-window');
    if (!win) return;
    e.preventDefault();
    activeTerminalTab = tabId;
    touchTerminalSession(tabId);
    terminalDragState = { id: tabId, startX: e.clientX, startY: e.clientY, moved: false };
    win.classList.add('dragging');
    document.body.classList.add('terminal-window-dragging');
    const onMove = (ev) => {
        const dx = ev.clientX - terminalDragState.startX, dy = ev.clientY - terminalDragState.startY;
        if (Math.abs(dx) + Math.abs(dy) > 6) terminalDragState.moved = true;
        win.style.setProperty('--drag-x', `${dx}px`);
        win.style.setProperty('--drag-y', `${dy}px`);
    };
    const onUp = (ev) => {
        win.style.pointerEvents = 'none';
        const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.terminal-window')?.dataset.window;
        win.style.pointerEvents = '';
        win.classList.remove('dragging');
        win.style.removeProperty('--drag-x');
        win.style.removeProperty('--drag-y');
        document.body.classList.remove('terminal-window-dragging');
        window.removeEventListener('pointermove', onMove);
        if (target && target !== tabId) swapTerminalWindows(tabId, target);
        else if (!snapTerminalWindowToEdge(tabId, ev.clientX, ev.clientY)) renderTerminalTabs({ rebuildWorkspace: false });
        terminalDragState = null;
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerup', onUp, { once: true });
}
/**
 * Grid track percentages (--workspace-split-x/y) resolve against the grid
 * container's CONTENT box, while getBoundingClientRect() is the BORDER box.
 * Mixing the two drifts the gutter away from the pointer, so measure the
 * content box explicitly and read the real gutter track width.
 */
function workspaceGridMetrics(workspace) {
    const rect = workspace.getBoundingClientRect();
    const cs = getComputedStyle(workspace);
    const num = (value, fallback = 0) => {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    };
    const bl = num(cs.borderLeftWidth), brr = num(cs.borderRightWidth);
    const bt = num(cs.borderTopWidth), bb = num(cs.borderBottomWidth);
    const pl = num(cs.paddingLeft), pr = num(cs.paddingRight);
    const pt = num(cs.paddingTop), pb = num(cs.paddingBottom);
    return {
        left: rect.left + bl + pl,
        top: rect.top + bt + pt,
        width: Math.max(1, rect.width - bl - brr - pl - pr),
        height: Math.max(1, rect.height - bt - bb - pt - pb),
        gutter: num(cs.getPropertyValue('--workspace-gutter'), 12),
    };
}
/**
 * The leading track gets `px`; the gutter track follows it. Keep both inside
 * the content box so the trailing window can never be squeezed to zero.
 */
function clampWorkspaceSplitPercent(px, total, gutter, minPct, maxPct, minTrailing = 88) {
    if (!(total > 0)) return minPct;
    const maxByTrailing = ((total - gutter - minTrailing) / total) * 100;
    const hi = Math.min(maxPct, Number.isFinite(maxByTrailing) ? maxByTrailing : maxPct);
    const lo = Math.min(minPct, hi);
    return Math.min(hi, Math.max(lo, (px / total) * 100));
}
function startWorkspaceSplitterDrag(e, axis) {
    const workspace = $('#terminalWorkspace');
    if (!workspace) return;
    e.preventDefault();
    const splitter = e.target.closest?.('[data-splitter]');
    const metrics = workspaceGridMetrics(workspace);

    // The gutter track is centred under the pointer, so the leading track ends
    // half a gutter before the cursor. This keeps grab point == bar position.
    const applyPosition = (clientX, clientY) => {
        if (axis === 'x') {
            const px = (clientX - metrics.left) - metrics.gutter / 2;
            const pct = clampWorkspaceSplitPercent(px, metrics.width, metrics.gutter, 24, 82);
            workspace.style.setProperty('--workspace-split-x', `${pct.toFixed(2)}%`);
        } else {
            const px = (clientY - metrics.top) - metrics.gutter / 2;
            const pct = clampWorkspaceSplitPercent(px, metrics.height, metrics.gutter, 22, 78);
            workspace.style.setProperty('--workspace-split-y', `${pct.toFixed(2)}%`);
        }
    };

    const onMove = (ev) => {
        ev.preventDefault?.();
        applyPosition(ev.clientX, ev.clientY);
    };

    const cleanup = () => {
        splitter?.releasePointerCapture?.(e.pointerId);
        splitter?.classList.remove('arming', 'dragging');
        workspace.classList.remove('splitting');
        document.body.classList.remove('terminal-workspace-splitting');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', cleanup);
        window.removeEventListener('pointercancel', cleanup);
        scheduleWorkspaceSave('workspace-split');
    };

    splitter?.setPointerCapture?.(e.pointerId);
    splitter?.classList.add('dragging');
    workspace.classList.add('splitting');
    document.body.classList.add('terminal-workspace-splitting');
    applyPosition(e.clientX, e.clientY);
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', cleanup, { once: true });
    window.addEventListener('pointercancel', cleanup, { once: true });
}


const DEFAULT_AI_GUIDANCE_TEXT = `Zephyr 默认内置提示词已启用：优先使用当前连接上下文、连接标签/备注、Memory、计划器、浏览器截图预览和远程文件/命令工具；先查事实再操作，危险操作走确认。`;
function defaultAiSettings() {
    return {
        enabled: false,
        assistantName: 'Zephyr AI',
        defaultProviderId: '',
        defaultModel: '',
        systemPrompt: '',
        defaultSystemPrompt: DEFAULT_AI_GUIDANCE_TEXT,
        guidanceVersion: 1,
        codeCompletionEnabled: true,
        context: { windowTokens: 64000, maxInputChars: 90000, toolResultChars: 30000, memoryItems: 16, maxToolRounds: 0 },
        sensitive: { requireConfirmation: true, autoConfirm: false, autoConfirmDelayMs: 2500 },
        permissions: { webSearch: true, webFetch: true, browser: true, remoteExecute: true, fileRead: true, fileWrite: true, codeEdit: true, memory: true, env: true },
        planner: { enabled: true, requirePlanBeforeTools: false },
        memory: { enabled: true, maxItems: 500 },
        providers: [],
        skills: [],
        envVars: [],
        memories: [],
        plans: [],
    };
}
function normalizeVisibleAiProvider(provider = {}) {
    const config = provider?.config && typeof provider.config === 'object' ? provider.config : {};
    const options = provider.options && typeof provider.options === 'object' ? provider.options : (config.options || {});
    return {
        ...provider,
        apiMode: provider.apiMode ?? config.apiMode ?? 'auto',
        options: options && typeof options === 'object' ? options : (config.options || {}),
        organization: provider.organization ?? config.organization ?? '',
        extraHeaders: provider.extraHeaders ?? config.extraHeaders ?? '',
        modelUserAgents: provider.modelUserAgents ?? config.modelUserAgents ?? '',
        models: normalizeAiModelEntries(provider.models, { providerVisionDefault: options?.vision !== false }),
    };
}
function defaultAiModelModalities(providerVisionDefault = true) {
    return {
        input: { image: !!providerVisionDefault, pdf: false, audio: false, video: false },
        output: { image: false, audio: false },
    };
}
function normalizeAiModelEntry(raw, { providerVisionDefault = true } = {}) {
    if (raw == null) return null;
    if (typeof raw === 'string') {
        const id = String(raw).trim();
        if (!id) return null;
        const mods = defaultAiModelModalities(providerVisionDefault);
        return {
            id, label: id, hidden: false,
            contextWindowTokens: null, maxOutputTokens: null,
            temperature: null, topP: null,
            reasoning: !!globalThis.ZephyrThinkingPolicy?.inferredReasoningModel?.(id),
            reasoningConfigured: false, reasoningEffort: null,
            input: mods.input, output: mods.output,
            tools: true, parallelToolCalls: true, promptCache: 'auto',
            maxImagesPerRequest: null, maxImageBytes: null, apiMode: null, userAgent: null, extra: {},
        };
    }
    if (typeof raw !== 'object') return null;
    const id = String(raw.id || raw.model || raw.name || '').trim();
    if (!id) return null;
    const mods = defaultAiModelModalities(providerVisionDefault);
    const input = raw.input && typeof raw.input === 'object' ? raw.input : {};
    const output = raw.output && typeof raw.output === 'object' ? raw.output : {};
    return {
        id,
        label: String(raw.label || raw.displayName || id).trim() || id,
        hidden: !!raw.hidden,
        contextWindowTokens: raw.contextWindowTokens == null || raw.contextWindowTokens === '' ? null : Number(raw.contextWindowTokens) || null,
        maxOutputTokens: raw.maxOutputTokens == null || raw.maxOutputTokens === '' ? null : Number(raw.maxOutputTokens) || null,
        temperature: raw.temperature == null || raw.temperature === '' ? null : Number(raw.temperature),
        topP: raw.topP == null && raw.top_p == null ? null : Number(raw.topP ?? raw.top_p),
        reasoning: raw.reasoningConfigured
            ? !!raw.reasoning
            : (!!raw.reasoning || !!globalThis.ZephyrThinkingPolicy?.inferredReasoningModel?.(id)),
        reasoningConfigured: !!raw.reasoningConfigured,
        reasoningEffort: raw.reasoningEffort || null,
        input: {
            image: input.image === undefined ? mods.input.image : !!input.image,
            pdf: !!input.pdf, audio: !!input.audio, video: !!input.video,
        },
        output: { image: !!output.image, audio: !!output.audio },
        tools: raw.tools === undefined ? true : !!raw.tools,
        parallelToolCalls: raw.parallelToolCalls === undefined ? true : !!raw.parallelToolCalls,
        promptCache: raw.promptCache || 'auto',
        maxImagesPerRequest: raw.maxImagesPerRequest == null ? null : Number(raw.maxImagesPerRequest) || null,
        maxImageBytes: raw.maxImageBytes == null ? null : Number(raw.maxImageBytes) || null,
        apiMode: raw.apiMode || null,
        userAgent: raw.userAgent || null,
        extra: raw.extra && typeof raw.extra === 'object' ? raw.extra : {},
    };
}
function normalizeAiModelEntries(models, opts = {}) {
    const list = Array.isArray(models) ? models : String(models || '').split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
    const byId = new Map();
    for (const item of list) {
        const entry = normalizeAiModelEntry(item, opts);
        if (entry) byId.set(entry.id, entry);
    }
    return [...byId.values()];
}
function mergeAiModelEntries(existing, nextModels, opts = {}) {
    const current = normalizeAiModelEntries(existing, opts);
    const byId = new Map(current.map((m) => [m.id, m]));
    const next = normalizeAiModelEntries(nextModels, opts);
    const out = [];
    const seen = new Set();
    for (const remote of next) {
        const id = remote.id;
        if (seen.has(id)) continue;
        const existingEntry = byId.get(id);
        out.push(existingEntry ? { ...remote, ...existingEntry, label: existingEntry.label || remote.label || id } : remote);
        seen.add(id);
    }
    return out;
}
/** In-memory draft of model entries while the provider modal is open. */
let aiProviderModelEntriesDraft = [];
let aiModelDetailSource = 'provider'; // provider | draft
let aiModelDetailProviderId = '';
let aiModelsPageProviderId = '';
let aiSettingsSubpageDepth = 0; // 0 root · 1 models list · 2 model detail

function aiModelGlyphIcons(entry = {}) {
    // Screenshot-style monochrome glyphs (image / document)
    const icons = [];
    if (entry?.input?.image) icons.push({ key: 'image', title: t('图片输入'), html: '<span class="ai-cap-glyph ai-cap-image" aria-hidden="true"></span>' });
    if (entry?.input?.pdf) icons.push({ key: 'pdf', title: t('PDF 输入'), html: '<span class="ai-cap-glyph ai-cap-doc" aria-hidden="true"></span>' });
    return icons;
}

function renderAiProviderModelCatalog() {
    // Provider modal no longer hosts the full catalog UI (moved to L2 page).
    const root = $('#aiProviderModelCatalog');
    if (!root) return;
    aiProviderModelEntriesDraft = mergeAiModelEntries(aiProviderModelEntriesDraft, $('#aiProviderModels')?.value || '', {
        providerVisionDefault: !!$('#aiProviderVision')?.checked,
    });
    root.innerHTML = '';
}

function settingsSubpageEls() {
    return {
        layout: document.querySelector('#view-settings .settings-layout'),
        content: document.querySelector('#view-settings .settings-content'),
        menu: document.querySelector('#view-settings .settings-menu'),
        models: $('#settingsAiModelsPage'),
        detail: $('#settingsAiModelDetailPage'),
    };
}

/**
 * Freeze the page under fixed L2/L3: body position:fixed + top:-scrollY.
 * Unfreeze restores that same scrollY once. No multi-rAF gymnastics.
 */
let settingsAiFrozenScrollY = null;

function syncSettingsSubpageBodyLock() {
    const open = !!($('#settingsAiModelsPage')?.classList.contains('is-open')
        || $('#settingsAiModelDetailPage')?.classList.contains('is-open')
        || $('#settingsAiQuickTestPage')?.classList.contains('is-open'));
    const frozen = settingsAiFrozenScrollY != null;

    if (open && !frozen) {
        const y = window.scrollY
            || document.scrollingElement?.scrollTop
            || document.documentElement.scrollTop
            || 0;
        settingsAiFrozenScrollY = y;
        document.body.classList.add('settings-subpage-open');
        document.body.style.position = 'fixed';
        document.body.style.top = `-${y}px`;
        document.body.style.left = '0';
        document.body.style.right = '0';
        document.body.style.width = '100%';
        return;
    }

    if (!open && frozen) {
        const y = settingsAiFrozenScrollY || 0;
        settingsAiFrozenScrollY = null;
        document.body.classList.remove('settings-subpage-open');
        document.body.style.position = '';
        document.body.style.top = '';
        document.body.style.left = '';
        document.body.style.right = '';
        document.body.style.width = '';
        // Body was visually parked at y via top:-y; unlock then put window back there.
        window.scrollTo(0, y);
    }
}

async function animateSettingsSubpage(el, open, { edge = 'right' } = {}) {
    if (!el) return;
    const Motion = await sshKeyMotion._ensure().catch(() => null);
    if (!Motion || sshKeyMotion.failed) {
        el.classList.toggle('is-open', open);
        el.setAttribute('aria-hidden', open ? 'false' : 'true');
        if (open) {
            el.style.transform = 'none';
            el.style.opacity = '1';
            el.style.visibility = 'visible';
            el.style.pointerEvents = 'auto';
            el.style.overflow = 'hidden';
            el.style.display = 'flex';
            const scroller = el.querySelector('.settings-subpage-scroll');
            if (scroller) {
                scroller.scrollTop = 0;
                scroller.style.overflowY = 'auto';
                scroller.style.touchAction = 'pan-y';
            }
            el.scrollTop = 0;
        } else {
            el.style.visibility = 'hidden';
            el.style.pointerEvents = 'none';
            el.style.transform = '';
            el.style.opacity = '';
            el.style.overflow = '';
        }
        syncSettingsSubpageBodyLock();
        return;
    }
    if (open) {
        el.classList.add('is-open');
        el.setAttribute('aria-hidden', 'false');
        el.style.visibility = 'visible';
        el.style.pointerEvents = 'auto';
        el.style.display = 'flex';
        el.style.opacity = '1';
        el.style.overflow = 'hidden'; // outer shell never scrolls
        // Force layout so Motion.sheet gets non-zero width/height (else travel=0).
        void el.offsetWidth;
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) {
            el.style.width = `${window.innerWidth || 360}px`;
            el.style.height = `${window.innerHeight || 640}px`;
            void el.offsetWidth;
        }
        const scroller = el.querySelector('.settings-subpage-scroll');
        if (scroller) scroller.scrollTop = 0;
        el.scrollTop = 0;
        syncSettingsSubpageBodyLock();
        await Motion.sheet(el, { edge, open: true, preset: 'sheet' });
        // Critical for iOS: a leftover transform on the fixed shell breaks
        // touch scrolling of the inner scroller. Release channels + clear.
        try { Motion.stop(el); Motion.set(el, { x: 0, y: 0, opacity: 1 }); Motion.release(el); } catch { /* ignore */ }
        el.style.transform = 'none';
        el.style.opacity = '1';
        el.style.willChange = 'auto';
        el.style.overflow = 'hidden';
        if (scroller) {
            scroller.style.overflowY = 'auto';
            scroller.style.webkitOverflowScrolling = 'touch';
            scroller.style.touchAction = 'pan-y';
        }
    } else {
        await Motion.sheet(el, { edge, open: false, preset: 'sheet' });
        el.classList.remove('is-open');
        el.setAttribute('aria-hidden', 'true');
        el.style.visibility = 'hidden';
        el.style.pointerEvents = 'none';
        try { Motion.release(el); } catch { /* ignore */ }
        el.style.transform = '';
        el.style.opacity = '';
        el.style.width = '';
        el.style.height = '';
        el.style.willChange = '';
        el.style.overflow = '';
        syncSettingsSubpageBodyLock();
    }
}

function getAiModelsSearchQuery() {
    return String($('#aiModelsSearchInput')?.value || '').trim().toLowerCase();
}

function renderAiModelsListPage() {
    const card = $('#aiModelsListCard');
    if (!card) return;
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    const provider = (ai.providers || []).find((p) => p.id === aiModelsPageProviderId);
    if (!provider) {
        card.innerHTML = `<p class="empty-state">${t('供应商不存在')}</p>`;
        return;
    }
    const entries = normalizeAiModelEntries(provider.models, {
        providerVisionDefault: provider?.options?.vision !== false,
    });
    const q = getAiModelsSearchQuery();
    const filtered = !q ? entries : entries.filter((m) => {
        const id = String(m.id || '').toLowerCase();
        const label = String(m.label || '').toLowerCase();
        return id.includes(q) || label.includes(q);
    });
    // Title shows filtered/total when searching
    $('#aiModelsPageTitle').textContent = q
        ? t('模型（{shown}/{total}）', { shown: filtered.length, total: entries.length })
        : t('模型（{count}）', { count: entries.length });
    $('#aiModelsPageSubtitle').textContent = provider.name || provider.type || '';
    if (!entries.length) {
        card.innerHTML = `<p class="empty-state">${t('暂无模型。点击上方刷新模型列表，或在编辑供应商时手动填写。')}</p>`;
        return;
    }
    if (!filtered.length) {
        card.innerHTML = `<p class="empty-state">${t('没有匹配「{query}」的模型', { query: getAiModelsSearchQuery() })}</p>`;
        return;
    }
    card.innerHTML = filtered.map((m) => {
        const glyphs = aiModelGlyphIcons(m).map((g) => g.html).join('');
        const hidden = m.hidden ? `<span class="muted">${t('已隐藏')}</span>` : '';
        return `<button type="button" class="ai-models-list-row" data-ai-model-open="${escapeAttr(m.id)}">
            <span class="ai-models-list-text"><strong>${escapeHtml(m.label || m.id)}</strong><small>${escapeHtml(m.id)}</small>${hidden}</span>
            <span class="ai-models-list-trailing">${glyphs}<span class="ai-models-chevron" aria-hidden="true">›</span></span>
        </button>`;
    }).join('');
}

function ensureAiSettingsTabActive() {
    // Prefer direct class toggles — re-clicking the AI tab can race with subpage open.
    if (!document.getElementById('view-settings')?.classList.contains('active')) {
        try { switchView('settings'); } catch { /* ignore */ }
    }
    const tab = document.querySelector('.settings-tab[data-settings="ai"]');
    const panel = document.getElementById('settings-ai');
    if (tab && !tab.classList.contains('active')) {
        document.querySelectorAll('.settings-tab').forEach((b) => b.classList.remove('active'));
        tab.classList.add('active');
    }
    if (panel && !panel.classList.contains('active')) {
        document.querySelectorAll('.settings-panel').forEach((p) => p.classList.remove('active'));
        panel.classList.add('active');
    }
}

async function openAiModelsPage(providerId = '', trigger = null) {
    const { layout, models } = settingsSubpageEls();
    if (!models) {
        toast(t('模型列表页未加载，请硬刷新后重试'));
        return;
    }
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    const provider = (ai.providers || []).find((p) => p.id === providerId);
    if (!provider) return toast(t('供应商不存在'));
    ensureAiSettingsTabActive();
    aiModelsPageProviderId = providerId;
    const search = $('#aiModelsSearchInput');
    if (search) search.value = '';
    renderAiModelsListPage();
    layout?.classList.add('has-subpage');
    aiSettingsSubpageDepth = Math.max(aiSettingsSubpageDepth, 1);
    // Freeze background at current scroll; only the overlay moves.
    await animateSettingsSubpage(models, true, { edge: 'right' });
}

async function closeAiModelsPage() {
    const { layout, models, detail } = settingsSubpageEls();
    if (detail?.classList.contains('is-open')) await closeAiModelDetailPage({ skipParent: true });
    await animateSettingsSubpage(models, false, { edge: 'right' });
    aiModelsPageProviderId = '';
    aiSettingsSubpageDepth = 0;
    layout?.classList.remove('has-subpage');
}

async function openAiModelDetailPage({ providerId = '', modelId = '', source = 'provider' } = {}) {
    const { layout, detail } = settingsSubpageEls();
    if (!detail) return;
    let entry = null;
    let provider = null;
    aiModelDetailSource = source;
    aiModelDetailProviderId = providerId || aiModelsPageProviderId || '';
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    provider = (ai.providers || []).find((p) => p.id === aiModelDetailProviderId) || null;
    if (source === 'provider' && provider) {
        entry = normalizeAiModelEntries(provider.models, {
            providerVisionDefault: provider?.options?.vision !== false,
        }).find((m) => m.id === modelId) || null;
    } else {
        entry = aiProviderModelEntriesDraft.find((m) => m.id === modelId) || null;
    }
    if (!entry) return toast(t('模型不存在'));
    // Ensure L2 is open first when coming from provider list
    if (provider && (!$('#settingsAiModelsPage')?.classList.contains('is-open'))) {
        await openAiModelsPage(provider.id);
    }
    $('#aiModelDetailProviderId').value = aiModelDetailProviderId || '';
    $('#aiModelDetailId').value = entry.id;
    $('#aiModelDetailIdDisplay').value = entry.id;
    $('#aiModelDetailLabel').value = entry.label && entry.label !== entry.id ? entry.label : '';
    $('#aiModelDetailContextWindow').value = entry.contextWindowTokens || '';
    $('#aiModelDetailMaxOutput').value = entry.maxOutputTokens || '';
    $('#aiModelDetailReasoning').checked = !!entry.reasoning;
    $('#aiModelDetailHidden').checked = !!entry.hidden;
    $('#aiModelDetailInputImage').checked = !!entry.input?.image;
    $('#aiModelDetailInputPdf').checked = !!entry.input?.pdf;
    $('#aiModelDetailInputAudio').checked = !!entry.input?.audio;
    $('#aiModelDetailInputVideo').checked = !!entry.input?.video;
    $('#aiModelDetailOutputImage').checked = !!entry.output?.image;
    $('#aiModelDetailOutputAudio').checked = !!entry.output?.audio;
    $('#aiModelDetailProviderName').textContent = provider?.name || provider?.type || '—';
    $('#aiModelDetailTitle').textContent = t('模型详情');
    layout?.classList.add('has-subpage', 'has-subpage-l3');
    aiSettingsSubpageDepth = 2;
    await animateSettingsSubpage(detail, true, { edge: 'right' });
}

// Back-compat alias used by older listeners
function openAiModelDetailModal(opts) { return openAiModelDetailPage(opts); }

async function closeAiModelDetailPage({ skipParent = false } = {}) {
    const { layout, detail } = settingsSubpageEls();
    await animateSettingsSubpage(detail, false, { edge: 'right' });
    aiSettingsSubpageDepth = $('#settingsAiModelsPage')?.classList.contains('is-open') ? 1 : 0;
    layout?.classList.remove('has-subpage-l3');
    if (!skipParent && aiSettingsSubpageDepth === 0) layout?.classList.remove('has-subpage');
}

function closeAiModelDetailModal() { return closeAiModelDetailPage(); }

async function saveAiModelDetail(e) {
    e?.preventDefault?.();
    const modelId = $('#aiModelDetailId')?.value || '';
    if (!modelId) return;
    const patch = {
        id: modelId,
        label: ($('#aiModelDetailLabel')?.value || '').trim() || modelId,
        contextWindowTokens: Number($('#aiModelDetailContextWindow')?.value) || null,
        maxOutputTokens: Number($('#aiModelDetailMaxOutput')?.value) || null,
        reasoning: !!$('#aiModelDetailReasoning')?.checked,
        reasoningConfigured: true,
        hidden: !!$('#aiModelDetailHidden')?.checked,
        input: {
            image: !!$('#aiModelDetailInputImage')?.checked,
            pdf: !!$('#aiModelDetailInputPdf')?.checked,
            audio: !!$('#aiModelDetailInputAudio')?.checked,
            video: !!$('#aiModelDetailInputVideo')?.checked,
        },
        output: {
            image: !!$('#aiModelDetailOutputImage')?.checked,
            audio: !!$('#aiModelDetailOutputAudio')?.checked,
        },
    };
    if (aiModelDetailSource === 'provider' && aiModelDetailProviderId) {
        const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
        const provider = (ai.providers || []).find((p) => p.id === aiModelDetailProviderId);
        if (!provider || provider.owned === false) {
            toast(t('共享 Provider 只能调用，不能编辑'));
            return;
        }
        const models = normalizeAiModelEntries(provider.models, {
            providerVisionDefault: provider?.options?.vision !== false,
        }).map((m) => (m.id === modelId ? { ...m, ...patch, input: { ...m.input, ...patch.input }, output: { ...m.output, ...patch.output } } : m));
        await api(`/api/ai/providers/${encodeURIComponent(aiModelDetailProviderId)}`, {
            method: 'PATCH',
            body: JSON.stringify({ models }),
        });
        const visible = await api('/api/ai/providers');
        settings.ai = { ...(settings.ai || {}), providers: visible.providers || [] };
        aiSettingsState = normalizeAiSettings(settings.ai);
        renderAiProviderList();
        renderAiHeaderSelectors();
        renderAiModelsListPage();
        toast(t('模型能力已保存'));
    } else {
        aiProviderModelEntriesDraft = aiProviderModelEntriesDraft.map((m) => (
            m.id === modelId ? { ...m, ...patch, input: { ...m.input, ...patch.input }, output: { ...m.output, ...patch.output } } : m
        ));
        if (!aiProviderModelEntriesDraft.some((m) => m.id === modelId)) {
            aiProviderModelEntriesDraft.push(normalizeAiModelEntry(patch, {
                providerVisionDefault: !!$('#aiProviderVision')?.checked,
            }));
        }
        if ($('#aiProviderModels')) $('#aiProviderModels').value = aiProviderModelEntriesDraft.map((m) => m.id).join('\n');
        toast(t('模型能力已写入草稿，保存供应商后生效'));
    }
    await closeAiModelDetailPage();
}

function formatQuickTestDuration(ms) {
    const n = Number(ms) || 0;
    if (n < 1000) return `${Math.max(1, Math.round(n))}ms`;
    return `${(n / 1000).toFixed(1)}s`;
}

function renderQuickTestResults(payload = {}, { loading = false } = {}) {
    const root = $('#aiQuickTestResults');
    if (!root) return;
    if (loading) {
        root.innerHTML = `<div class="ai-quick-test-item is-loading">
            <div class="ai-quick-test-item-head">
                <span class="ai-quick-test-mod"><span class="ai-quick-test-tt">Tt</span> ${escapeHtml(t('文本'))}</span>
                <span class="ai-quick-test-status muted">${escapeHtml(t('测试中…'))}</span>
            </div>
            <p class="ai-quick-test-content muted">${escapeHtml(t('正在向模型发送真实请求…'))}</p>
        </div>`;
        return;
    }
    const results = Array.isArray(payload.results) ? payload.results : [];
    if (!results.length) {
        root.innerHTML = `<p class="empty-state">${escapeHtml(payload.error || t('快速测试失败'))}</p>`;
        return;
    }
    const modLabel = { text: t('文本'), image: t('图片'), pdf: t('PDF'), audio: t('音频'), video: t('视频') };
    root.innerHTML = results.map((r) => {
        const ok = r.ok !== false && !r.error;
        const label = modLabel[r.modality] || r.modality || t('文本');
        const status = ok
            ? `<span class="ai-quick-test-status is-ok">✓ ${escapeHtml(formatQuickTestDuration(r.durationMs))}</span>`
            : `<span class="ai-quick-test-status is-err">✕ ${escapeHtml(formatQuickTestDuration(r.durationMs))}</span>`;
        const body = ok
            ? (r.content || t('（无文本回复）'))
            : (r.error || t('请求失败'));
        return `<div class="ai-quick-test-item ${ok ? 'is-ok' : 'is-err'}">
            <div class="ai-quick-test-item-head">
                <span class="ai-quick-test-mod"><span class="ai-quick-test-tt">Tt</span> ${escapeHtml(label)}</span>
                ${status}
            </div>
            <p class="ai-quick-test-content">${escapeHtml(String(body))}</p>
        </div>`;
    }).join('');
}

async function openAiQuickTestPage() {
    const page = $('#settingsAiQuickTestPage');
    if (!page) return;
    const layout = document.querySelector('#view-settings .settings-layout');
    layout?.classList.add('has-subpage', 'has-subpage-l3');
    await animateSettingsSubpage(page, true, { edge: 'right' });
}

async function closeAiQuickTestPage() {
    const page = $('#settingsAiQuickTestPage');
    await animateSettingsSubpage(page, false, { edge: 'right' });
}

async function quickTestAiModel() {
    const providerId = $('#aiModelDetailProviderId')?.value || aiModelDetailProviderId;
    const modelId = $('#aiModelDetailId')?.value || '';
    const label = ($('#aiModelDetailLabel')?.value || '').trim() || modelId;
    if (!providerId || !modelId) return toast(t('模型不存在'));
    const btn = $('#aiModelDetailQuickTestBtn');
    if (btn) btn.disabled = true;
    const imageOn = !!$('#aiModelDetailInputImage')?.checked;
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    const provider = (ai.providers || []).find((p) => p.id === providerId);
    const displayId = provider?.name ? `${provider.name}/${modelId}` : modelId;
    $('#aiQuickTestModelLabel').textContent = label || modelId;
    $('#aiQuickTestModelId').textContent = displayId;
    renderQuickTestResults({}, { loading: true });
    await openAiQuickTestPage();
    try {
        const data = await api('/api/ai/models/quick-test', {
            method: 'POST',
            body: JSON.stringify({
                providerId,
                model: modelId,
                testImage: imageOn,
            }),
        });
        $('#aiQuickTestModelLabel').textContent = data.label || label || modelId;
        $('#aiQuickTestModelId').textContent = data.provider?.name
            ? `${data.provider.name}/${data.model || modelId}`
            : displayId;
        renderQuickTestResults(data);
        if (!data.ok) toast(t('部分能力测试失败'));
    } catch (err) {
        renderQuickTestResults({ results: [{ modality: 'text', ok: false, durationMs: 0, error: err.message || t('快速测试失败') }] });
        toast(err.message || t('快速测试失败'));
    } finally {
        if (btn) btn.disabled = false;
    }
}
function normalizeAiSettings(ai = {}) {
    const base = defaultAiSettings();
    return {
        ...base,
        ...ai,
        sensitive: { ...base.sensitive, ...(ai.sensitive || {}) },
        permissions: { ...base.permissions, ...(ai.permissions || {}) },
        planner: { ...base.planner, ...(ai.planner || {}) },
        memory: { ...base.memory, ...(ai.memory || {}) },
        context: { ...base.context, ...(ai.context || {}) },
        providers: Array.isArray(ai.providers) ? ai.providers.map(normalizeVisibleAiProvider) : [],
        skills: Array.isArray(ai.skills) ? ai.skills : [],
        envVars: Array.isArray(ai.envVars) ? ai.envVars : [],
        memories: Array.isArray(ai.memories) ? ai.memories : [],
        plans: Array.isArray(ai.plans) ? ai.plans : [],
    };
}
function aiModelEntries(provider = {}, { includeHidden = false } = {}) {
    return normalizeAiModelEntries(provider.models, {
        providerVisionDefault: provider?.options?.vision !== false,
    }).filter((m) => includeHidden || !m.hidden);
}
function aiModelNames(provider = {}, opts = {}) {
    return aiModelEntries(provider, opts).map((m) => m.id).filter(Boolean);
}
function aiModelDisplayName(provider = {}, modelId = '') {
    const id = String(modelId || '').trim();
    const entry = aiModelEntries(provider, { includeHidden: true }).find((m) => m.id === id);
    return String(entry?.label || entry?.id || id).trim();
}
function aiModelCapabilityIcons(entry = {}) {
    const icons = [];
    if (entry?.input?.image) icons.push({ key: 'image', label: '🖼️', title: t('图片输入') });
    if (entry?.input?.pdf) icons.push({ key: 'pdf', label: '📄', title: t('PDF 输入') });
    if (entry?.input?.audio) icons.push({ key: 'audio', label: '🔊', title: t('音频输入') });
    if (entry?.input?.video) icons.push({ key: 'video', label: '🎬', title: t('视频输入') });
    if (entry?.reasoning) icons.push({ key: 'think', label: '💭', title: t('思考') });
    if (entry?.hidden) icons.push({ key: 'hidden', label: '🙈', title: t('已隐藏') });
    return icons;
}
function aiProviderKind(provider = {}) {
    const type = String(provider?.type || '').toLowerCase();
    const base = String(provider?.baseUrl || '').toLowerCase();
    if (type === 'anthropic' || type === 'claude' || base.includes('anthropic.com')) return 'anthropic';
    if (type === 'gemini' || type === 'google' || base.includes('generativelanguage.googleapis.com')) return 'gemini';
    return 'openai';
}
function aiThinkingOptionsForProvider(provider = {}, model = '') {
    const policy = globalThis.ZephyrThinkingPolicy;
    if (policy?.optionsForProvider) {
        return policy.optionsForProvider(provider, model).map(([value, label]) => [value, label === '默认' ? t('默认') : label]);
    }
    return [['', t('默认')]];
}
function aiCurrentSession() {
    if (!aiChatSessions.length) createAiChat({ silent: true });
    return aiChatSessions.find((s) => s.id === aiCurrentSessionId) || aiChatSessions[0];
}
function applyAiVisibility() {
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    const enabled = !!ai.enabled;
    $('#aiNavTab')?.classList.add('force-hidden');
    $('#aiFloatingBtn')?.classList.toggle('force-hidden', !enabled);
    if (enabled) $('#aiFloatingBtn')?.classList.toggle('active', $('#aiAgentPanel')?.getAttribute('aria-hidden') === 'false');
    if (document.querySelector('#view-ai')?.classList.contains('active')) switchView('dashboard');
    renderAiHeaderSelectors();
}
function renderAiProviderOptions() {
    // 与 CAPTCHA 同源：真实 <select> + enhanceToggleSelect；动态填供应商列表。
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    const providers = ai.providers || [];
    const select = $('#aiDefaultProvider');
    if (!select) return;
    const current = ai.defaultProviderId || select.value || '';
    select.innerHTML = `<option value="">${t('自动选择第一个可用供应商')}</option>`
        + providers.map((p) => `<option value="${escapeAttr(p.id)}">${escapeHtml(p.name || p.type || t('供应商'))}</option>`).join('');
    if (current && providers.some((p) => p.id === current)) select.value = current;
    else select.value = '';
    enhanceToggleSelect(select);
    syncToggleSelectFace(select);
}

/** 设置 AI 供应商弹窗里的 <select> 值（已 enhance 的会同步 trigger 文案） */
function setAiFieldSelectValue(selectId, value) {
    const select = document.getElementById(selectId);
    if (!select) return;
    const next = value ?? '';
    if ([...select.options].some((o) => o.value === next)) select.value = next;
    else if (select.options.length) select.selectedIndex = 0;
    enhanceToggleSelect(select);
    syncToggleSelectFace(select);
}
function renderAiHeaderSelectors() {
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    const providerSelect = $('#aiProviderSelect');
    const modelSelect = $('#aiModelSelect');
    if (!providerSelect || !modelSelect) return;
    const providers = (ai.providers || []).filter((p) => p.enabled !== false);
    const previousProviderId = providerSelect.value;
    providerSelect.value = providers.some((p) => p.id === previousProviderId) ? previousProviderId : (ai.defaultProviderId || providers[0]?.id || '');
    const p = providers.find((x) => x.id === providerSelect.value) || providers[0];
    const models = aiModelNames(p);
    const chosen = ((p?.id === ai.defaultProviderId ? ai.defaultModel : '') || p?.defaultModel || models[0] || ai.defaultModel || '').trim();
    modelSelect.value = chosen;
    $('#aiProviderPickerBtn') && ($('#aiProviderPickerBtn').textContent = p ? (p.name || p.type || t('供应商')) : t('未配置模型'));
    $('#aiModelPickerBtn') && ($('#aiModelPickerBtn').textContent = aiModelDisplayName(p, chosen) || t('自动选择模型'));
    renderAiThinkingSelector(p, modelSelect.value || chosen);
    renderAiCapabilityStrip();
}
function renderAiThinkingSelector(provider = null, model = '') {
    const select = $('#aiThinkIntensity');
    if (!select) return;
    const previous = select.value;
    const options = aiThinkingOptionsForProvider(provider || {}, model);
    select.value = options.some(([value]) => value === previous) ? previous : '';
    const supported = options.some(([value]) => value !== '');
    const label = supported ? (options.find(([value]) => value === select.value)?.[1] || t('默认')) : t('不支持');
    const button = $('#aiThinkPickerBtn');
    if (button) {
        button.textContent = t('推理：{label}', { label });
        button.disabled = !supported;
        button.title = supported ? '' : t('当前模型未启用思考能力');
    }
}
function aiHeaderChoices(kind = '') {
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    const providers = (ai.providers || []).filter((p) => p.enabled !== false);
    const provider = providers.find((p) => p.id === $('#aiProviderSelect')?.value) || providers[0] || {};
    if (kind === 'provider') return providers.map((p) => ({ value: p.id, label: p.name || p.type || t('供应商') }));
    if (kind === 'model') {
        const entries = aiModelEntries(provider);
        if (entries.length) return entries.map((m) => ({ value: m.id, label: m.label || m.id }));
        return [$('#aiModelSelect')?.value || provider.defaultModel || ai.defaultModel || ''].filter(Boolean).map((m) => ({ value: m, label: m }));
    }
    if (kind === 'thinking') return aiThinkingOptionsForProvider(provider, $('#aiModelSelect')?.value || provider.defaultModel || '').map(([value, label]) => ({ value, label }));
    return [];
}
/** Custom segmented control (no native <select>). Value lives on data-value. */
function getAiSegmentValue(id, fallback = '') {
    const el = typeof id === 'string' ? document.getElementById(id) : id;
    if (!el) return fallback;
    return String(el.dataset.value || fallback);
}
function setAiSegmentValue(id, value, { silent = false } = {}) {
    const el = typeof id === 'string' ? document.getElementById(id) : id;
    if (!el) return;
    const next = String(value ?? '');
    const buttons = [...el.querySelectorAll('.ai-segment-btn')];
    const match = buttons.find((b) => b.dataset.value === next) || buttons[0];
    const resolved = match?.dataset.value || next;
    const idx = Math.max(0, buttons.findIndex((b) => b.dataset.value === resolved));
    el.dataset.value = resolved;
    el.dataset.index = String(idx);
    if (buttons.length) el.dataset.cols = String(buttons.length);
    buttons.forEach((btn) => {
        const on = btn.dataset.value === resolved;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (!silent) {
        if (el.id === 'aiMcpType') toggleAiMcpTypeFields();
        if (el.id === 'aiPermRuleMode') updateAiPermModeHint();
        if (el.id === 'aiCollabMode') {
            const s = aiCurrentSession();
            if (s) { s.collabMode = resolved; saveAiChats(); }
        }
        if (el.id === 'aiRunProfile') {
            const s = aiCurrentSession();
            if (s) { s.runProfile = resolved; saveAiChats(); }
        }
        if (el.id === 'aiChatPermissionMode') {
            const s = aiCurrentSession();
            if (s) { s.permissionMode = resolved; saveAiChats(); }
        }
    }
}
function updateAiPermModeHint() {
    const hint = $('#aiPermModeHint');
    if (!hint) return;
    const mode = getAiSegmentValue('aiPermRuleMode', 'ask');
    hint.textContent = mode === 'auto'
        ? t('Auto：只读工具自动通过，写操作仍询问')
        : mode === 'yolo'
            ? t('Yolo：除 Deny 规则外全部自动执行（高风险）')
            : t('Ask：写操作默认询问');
}
function bindAiSegmentControls(root = document) {
    root.querySelectorAll?.('.ai-segment').forEach((seg) => {
        if (!seg.dataset.cols) {
            const n = seg.querySelectorAll('.ai-segment-btn').length || 3;
            seg.dataset.cols = String(n);
        }
        setAiSegmentValue(seg, seg.dataset.value || seg.querySelector('.ai-segment-btn.active')?.dataset.value || '', { silent: true });
    });
}
function closeAiPickerPopover({ instant = false } = {}) {
    const pop = document.querySelector('.ai-picker-popover');
    if (!pop || pop.dataset.closing === '1') return;
    pop.dataset.closing = '1';
    const remove = () => {
        const Motion = sshKeyMotion.engine;
        if (Motion) { try { Motion.release(pop); } catch {} }
        pop.remove();
    };
    const Motion = sshKeyMotion.engine;
    if (instant || !Motion || sshKeyMotion.failed) { remove(); return; }
    Motion.dismiss(pop, {
        to: { opacity: 0, scale: 0.96, y: -4, x: 0 },
        preset: 'macClose',
    }).then(remove).catch(remove);
}
/** In-app confirm sheet — never window.confirm. */
function openAiInlineConfirm({ title = t('确认'), body = '', confirmLabel = t('确认'), cancelLabel = t('取消'), danger = false, onConfirm } = {}) {
    document.querySelector('.ai-inline-confirm')?.remove();
    const mask = document.createElement('div');
    mask.className = 'ai-inline-confirm';
    mask.innerHTML = `
      <div class="ai-inline-confirm-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        <div class="ai-inline-confirm-title">${escapeHtml(title)}</div>
        <div class="ai-inline-confirm-body">${escapeHtml(body)}</div>
        <div class="ai-inline-confirm-actions">
          <button type="button" class="ui-btn" data-ai-inline-cancel>${escapeHtml(cancelLabel)}</button>
          <button type="button" class="ui-btn ${danger ? 'danger' : 'btn-primary'}" data-ai-inline-ok>${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    const close = () => {
        if (mask.dataset.closing === '1') return;
        mask.dataset.closing = '1';
        const card = mask.querySelector('.ai-inline-confirm-card');
        const Motion = sshKeyMotion.engine;
        const done = () => {
            if (Motion) {
                try { Motion.release(card); Motion.release(mask); } catch {}
            }
            mask.remove();
        };
        if (!Motion || sshKeyMotion.failed) { done(); return; }
        Promise.all([
            Motion.dismiss(card, { to: { opacity: 0, scale: 0.97, y: 4 }, preset: 'macClose' }),
            Motion.to(mask, { opacity: 0 }, { preset: 'macClose' }),
        ]).then(done).catch(done);
    };
    mask.addEventListener('click', (e) => {
        if (e.target === mask || e.target.closest?.('[data-ai-inline-cancel]')) close();
        if (e.target.closest?.('[data-ai-inline-ok]')) {
            close();
            try { onConfirm?.(); } catch (err) { toast(err.message || String(err)); }
        }
    });
    document.body.appendChild(mask);
    const card = mask.querySelector('.ai-inline-confirm-card');
    sshKeyMotion._ensure().then((Motion) => {
        if (!mask.isConnected || !Motion) return;
        Motion.set(mask, { opacity: 0 });
        Motion.set(card, { opacity: 0, scale: 0.96, y: 6 });
        Promise.all([
            Motion.to(mask, { opacity: 1 }, { preset: 'mac' }),
            Motion.present(card, { from: { opacity: 0, scale: 0.96, y: 6 }, preset: 'mac' }),
        ]).catch(() => {});
    });
    mask.querySelector('[data-ai-inline-ok]')?.focus?.();
}
function openAiPicker(kind = '', anchor = null) {
    const existing = document.querySelector('.ai-picker-popover');
    if (existing && existing.dataset.pickerKind === kind
        && (existing._anchorEl === anchor || (anchor?.id && existing.dataset.pickerAnchorId === anchor.id))) {
        closeAiPickerPopover();
        return;
    }
    closeAiPickerPopover();
    const choices = aiHeaderChoices(kind);
    if (!choices.length || !anchor) return;
    const current = kind === 'provider' ? $('#aiProviderSelect')?.value : kind === 'model' ? $('#aiModelSelect')?.value : $('#aiThinkIntensity')?.value;
    const pop = document.createElement('div');
    pop.className = 'ai-picker-popover';
    pop.dataset.pickerKind = String(kind || '');
    pop.dataset.pickerAnchorId = anchor.id || '';
    pop._anchorEl = anchor;
    pop.innerHTML = choices.map((item) => `<button type="button" class="ai-picker-option${item.value === current ? ' active' : ''}" data-kind="${escapeHtml(kind)}" data-value="${escapeHtml(item.value)}"><span>${escapeHtml(item.label)}</span>${item.value === current ? '<b>✓</b>' : ''}</button>`).join('');
    document.body.appendChild(pop);
    const rect = anchor.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    // origin near trigger (popover, not modal)
    pop.style.transformOrigin = 'top left';
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - pr.width - 8, rect.left))}px`;
    pop.style.top = `${Math.max(8, Math.min(window.innerHeight - pr.height - 8, rect.bottom + 8))}px`;
    sshKeyMotion._ensure().then((Motion) => {
        if (!pop.isConnected || !Motion) return;
        Motion.popover(pop, anchor, { fromScale: 0.96, preset: 'mac' }).catch(() => {});
    });
}
function applyAiPickerChoice(kind = '', value = '') {
    if (kind === 'provider') { $('#aiProviderSelect').value = value; renderAiHeaderSelectors(); }
    if (kind === 'model') { $('#aiModelSelect').value = value; const ai = normalizeAiSettings(settings.ai || aiSettingsState || {}); const p = (ai.providers || []).find((x) => x.id === $('#aiProviderSelect')?.value) || {}; $('#aiModelPickerBtn').textContent = aiModelDisplayName(p, value) || t('自动选择模型'); renderAiThinkingSelector(p, value); }
    if (kind === 'thinking') { $('#aiThinkIntensity').value = value; const ai = normalizeAiSettings(settings.ai || aiSettingsState || {}); const p = (ai.providers || []).find((x) => x.id === $('#aiProviderSelect')?.value) || {}; renderAiThinkingSelector(p, $('#aiModelSelect')?.value || ''); }
    closeAiPickerPopover();
}
function formatTokenValue(n) {
    const v = Number(n) || 0;
    if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
    if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
    return String(Math.round(v));
}
async function openAiUsageSheet(messageMetrics = null, anchor = null) {
    document.querySelector('.ai-usage-popover')?.remove();
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    const provider = (ai.providers || []).find((p) => p.id === $('#aiProviderSelect')?.value) || {};
    const modelId = $('#aiModelSelect')?.value || provider.defaultModel || '';
    const modelEntry = aiModelEntries(provider, { includeHidden: true }).find((m) => m.id === modelId) || {};
    const context = ai.context || {};
    const opts = provider.options || {};
    const thinking = $('#aiThinkIntensity')?.value || '';
    const currentSession = aiChatSessions.find((s) => s.id === aiCurrentSessionId);
    let usage = {};
    if (currentSession?.runtimeSessionId) {
        try { usage = (await api(`/api/ai/runtime/sessions/${encodeURIComponent(currentSession.runtimeSessionId)}/usage`)).usage || {}; } catch (_) {}
    }
    const msg = messageMetrics && typeof messageMetrics === 'object' ? messageMetrics : {};
    const lastMetrics = usage.lastRun?.metrics && typeof usage.lastRun.metrics === 'object' ? usage.lastRun.metrics : {};
    const metric = (key, fallback = 0) => Number(msg[key] ?? lastMetrics[key] ?? fallback ?? 0) || 0;
    const contextWindow = Number(modelEntry.contextWindowTokens || opts.context?.windowTokens || context.windowTokens || 0);
    const maxOutput = Number(modelEntry.maxOutputTokens || opts.max_output_tokens || opts.max_tokens || 0);
    const pop = document.createElement('div');
    pop.className = 'ai-usage-popover';
    pop.innerHTML = `<div class="ai-usage-head"><h2>${t('会话 Token 用量')}</h2><button class="ai-usage-close" type="button" aria-label="${t('关闭')}">×</button></div>
        <div class="ai-usage-body">
            <div class="ai-usage-section">${t('本轮真实用量')}</div>
            <div class="ai-usage-row"><span>${t('输入')}</span><b>${formatTokenValue(metric('inputTokens'))}</b></div>
            <div class="ai-usage-row"><span>${t('输出')}</span><b>${formatTokenValue(metric('outputTokens'))}</b></div>
            <div class="ai-usage-row"><span>${t('缓存写入')}</span><b>${formatTokenValue(metric('cacheCreationTokens', msg.cacheWriteTokens))}</b></div>
            <div class="ai-usage-row"><span>${t('缓存读取')}</span><b>${formatTokenValue(metric('cacheReadTokens'))}</b></div>
            <div class="ai-usage-row"><span>${t('本轮耗时')}</span><b>${msg.durationMs ? (Number(msg.durationMs) / 1000).toFixed(1) + 's' : '—'}</b></div>
            <div class="ai-usage-section">${t('当前会话')}</div>
            <div class="ai-usage-row"><span>${t('输入')}</span><b>${formatTokenValue(usage.inputTokens || 0)}</b></div>
            <div class="ai-usage-row"><span>${t('输出')}</span><b>${formatTokenValue(usage.outputTokens || 0)}</b></div>
            <div class="ai-usage-row"><span>${t('总计')}</span><b>${formatTokenValue(Number(usage.inputTokens || 0) + Number(usage.outputTokens || 0))}</b></div>
            <div class="ai-usage-row"><span>${t('缓存写入')}</span><b>${formatTokenValue(usage.cacheCreationTokens || 0)}</b></div>
            <div class="ai-usage-row"><span>${t('缓存读取')}</span><b>${formatTokenValue(usage.cacheReadTokens || 0)}</b></div>
            <div class="ai-usage-section">${t('上下文')}</div>
            <div class="ai-usage-row"><span>${t('已用上下文')}</span><b>${formatTokenValue(usage.latestContextTokens || metric('latestContextTokens'))}</b></div>
            <div class="ai-usage-row"><span>${t('上下文窗口')}</span><b>${formatTokenValue(contextWindow)}</b></div>
            <div class="ai-usage-row"><span>${t('最大输出')}</span><b>${formatTokenValue(maxOutput)}</b></div>
            <div class="ai-usage-section">AGENT ${t('循环')}</div>
            <div class="ai-usage-row"><span>${t('本轮循环次数')}</span><b>${formatTokenValue(metric('providerCalls'))}</b></div>
            <div class="ai-usage-row"><span>${t('总循环次数')}</span><b>${formatTokenValue(usage.providerCalls || 0)}</b></div>
            <div class="ai-usage-row"><span>${t('运行次数')}</span><b>${formatTokenValue(usage.runCount || 0)}</b></div>
            <div class="ai-usage-row"><span>${t('思考级别')}</span><b>${escapeHtml(thinking || t('默认'))}</b></div>
        </div>`;
    document.body.appendChild(pop);
    const rect = anchor?.getBoundingClientRect?.() || document.querySelector('#aiUsageBtn')?.getBoundingClientRect?.() || null;
    const pr = pop.getBoundingClientRect();
    if (rect) {
        pop.style.left = `${Math.max(8, Math.min(window.innerWidth - pr.width - 8, rect.right - pr.width))}px`;
        pop.style.top = `${Math.max(8, Math.min(window.innerHeight - pr.height - 8, rect.bottom + 8))}px`;
    }
    const closeUsage = () => {
        if (!pop.isConnected || pop.dataset.closing === '1') return;
        pop.dataset.closing = '1';
        const Motion = sshKeyMotion.engine;
        const remove = () => {
            if (Motion) { try { Motion.release(pop); } catch {} }
            pop.remove();
        };
        if (!Motion || sshKeyMotion.failed) { remove(); return; }
        Motion.dismiss(pop, { to: { opacity: 0, scale: 0.97, y: -4 }, preset: 'macClose' }).then(remove).catch(remove);
    };
    pop._closeAiUsage = closeUsage;
    pop.querySelector('.ai-usage-close')?.addEventListener('click', closeUsage);
    const usageAnchor = anchor || document.querySelector('#aiUsageBtn');
    sshKeyMotion._ensure().then((Motion) => {
        if (!pop.isConnected || !Motion) return;
        Motion.popover(pop, usageAnchor, { fromScale: 0.97, preset: 'mac' }).catch(() => {});
    });
}
function renderAiCapabilityStrip() {
    const strip = $('#aiCapabilityStrip');
    if (strip) strip.innerHTML = '';
}
function renderAiSettingsForm() {
    const ai = normalizeAiSettings(settings.ai || {});
    aiSettingsState = ai;
    $('#aiEnabled').checked = !!ai.enabled;
    $('#aiAssistantName').value = ai.assistantName || 'Zephyr AI';
    $('#aiDefaultModel').value = ai.defaultModel || '';
    $('#aiSystemPrompt').value = ai.systemPrompt || '';
    $('#aiCodeCompletionEnabled').checked = ai.codeCompletionEnabled !== false;
    if ($('#aiContextWindowTokens')) $('#aiContextWindowTokens').value = ai.context?.windowTokens ?? 64000;
    if ($('#aiContextMaxInputChars')) $('#aiContextMaxInputChars').value = ai.context?.maxInputChars ?? 90000;
    // Message-count truncation was removed; budgets are model-window based.
    if ($('#aiContextToolResultChars')) $('#aiContextToolResultChars').value = ai.context?.toolResultChars ?? 30000;
    if ($('#aiContextMaxToolRounds')) $('#aiContextMaxToolRounds').value = ai.context?.maxToolRounds ?? 0;
    $('#aiRequireConfirmation').checked = ai.sensitive?.requireConfirmation !== false;
    $('#aiAutoConfirm').checked = !!ai.sensitive?.autoConfirm;
    $('#aiAutoConfirmDelayMs').value = ai.sensitive?.autoConfirmDelayMs ?? 2500;
    const p = ai.permissions || {};
    $('#aiPermWebSearch').checked = p.webSearch !== false;
    $('#aiPermWebFetch').checked = p.webFetch !== false;
    $('#aiPermBrowser').checked = p.browser !== false;
    $('#aiPermRemoteExecute').checked = p.remoteExecute !== false;
    $('#aiPermFileRead').checked = p.fileRead !== false;
    $('#aiPermFileWrite').checked = p.fileWrite !== false;
    $('#aiPermCodeEdit').checked = p.codeEdit !== false;
    $('#aiPermMemory').checked = p.memory !== false;
    $('#aiPermNotesRead').checked = p.notesRead !== false;
    $('#aiPermNotesWrite').checked = p.notesWrite !== false;
    $('#aiPermEnv').checked = p.env !== false;
    $('#aiMemoryEnabled').checked = ai.memory?.enabled !== false;
    $('#aiMemoryMaxItems').value = ai.memory?.maxItems ?? 500;
    $('#aiPlannerEnabled').checked = ai.planner?.enabled !== false;
    $('#aiRequirePlanBeforeTools').checked = !!ai.planner?.requirePlanBeforeTools;
    setAiSegmentValue('aiPermRuleMode', ai.permissions?.mode || 'ask', { silent: true });
    updateAiPermModeHint();
    if ($('#aiPermDeny')) $('#aiPermDeny').value = (ai.permissions?.deny || []).join('\n');
    if ($('#aiPermAllow')) $('#aiPermAllow').value = (ai.permissions?.allow || []).join('\n');
    if ($('#aiPermAsk')) $('#aiPermAsk').value = (ai.permissions?.ask || []).join('\n');
    renderAiProviderOptions();
    renderAiProviderList();
    renderAiEnvList();
    renderAiMemoryList();
    renderAiPlanList();
    renderAiSkillList();
    renderAiMcpList();
    applyAiVisibility();
}
function parseEnvLines(text = '') {
    const env = {};
    String(text || '').split('\n').forEach((line) => {
        const s = line.trim();
        if (!s || s.startsWith('#')) return;
        const i = s.indexOf('=');
        if (i <= 0) return;
        env[s.slice(0, i).trim()] = s.slice(i + 1).trim();
    });
    return env;
}
function parseHeaderLines(text = '') {
    const headers = {};
    String(text || '').split('\n').forEach((line) => {
        const s = line.trim();
        if (!s) return;
        const i = s.indexOf(':');
        if (i <= 0) return;
        headers[s.slice(0, i).trim()] = s.slice(i + 1).trim();
    });
    return headers;
}
function renderAiMcpList() {
    const list = $('#aiMcpList');
    if (!list) return;
    const servers = Array.isArray(aiSettingsState?.mcpServers) ? aiSettingsState.mcpServers : (settings.ai?.mcpServers || []);
    if (!servers.length) {
        list.innerHTML = `<p class="empty-state">${t('暂无 MCP 服务器。配置后由 Go AI Runtime 在每次 run 时连接。')}</p>`;
        return;
    }
    list.innerHTML = servers.map((s) => {
        const detail = s.type === 'http' ? escapeHtml(s.url || '') : escapeHtml([s.command, ...(s.args || [])].filter(Boolean).join(' '));
        return `<div class="ai-list-row" data-ai-mcp-id="${escapeHtml(s.id)}">
            <div class="ai-list-main"><strong>${escapeHtml(s.name)}</strong>
            <span class="muted">${escapeHtml(s.type)} · ${s.enabled === false ? t('停用') : t('启用')}</span>
            <div class="muted mono">${detail}</div></div>
            <div class="ai-list-actions">
                <button type="button" class="tool-btn" data-ai-mcp-edit="${escapeHtml(s.id)}">${t('编辑')}</button>
                <button type="button" class="tool-btn danger" data-ai-mcp-del="${escapeHtml(s.id)}">${t('删除')}</button>
            </div></div>`;
    }).join('');
}
function resetAiMcpForm() {
    $('#aiMcpId').value = '';
    $('#aiMcpName').value = '';
    setAiSegmentValue('aiMcpType', 'stdio', { silent: true });
    $('#aiMcpCommand').value = '';
    $('#aiMcpArgs').value = '';
    $('#aiMcpEnv').value = '';
    $('#aiMcpUrl').value = '';
    $('#aiMcpHeaders').value = '';
    $('#aiMcpTrustedReadOnly').value = '';
    $('#aiMcpTimeout').value = '300';
    $('#aiMcpEnabled').checked = true;
    toggleAiMcpTypeFields();
}
function toggleAiMcpTypeFields() {
    const http = getAiSegmentValue('aiMcpType', 'stdio') === 'http';
    $('#aiMcpStdioFields')?.classList.toggle('force-hidden', http);
    $('#aiMcpHttpFields')?.classList.toggle('force-hidden', !http);
}
function fillAiMcpForm(s) {
    if (!s) return resetAiMcpForm();
    $('#aiMcpId').value = s.id || '';
    $('#aiMcpName').value = s.name || '';
    setAiSegmentValue('aiMcpType', s.type === 'http' ? 'http' : 'stdio', { silent: true });
    $('#aiMcpCommand').value = s.command || '';
    $('#aiMcpArgs').value = Array.isArray(s.args) ? s.args.join(' ') : '';
    $('#aiMcpEnv').value = s.env ? Object.entries(s.env).map(([k, v]) => `${k}=${v}`).join('\n') : '';
    $('#aiMcpUrl').value = s.url || '';
    $('#aiMcpHeaders').value = s.headers ? Object.entries(s.headers).map(([k, v]) => `${k}: ${v}`).join('\n') : '';
    $('#aiMcpTrustedReadOnly').value = Array.isArray(s.trustedReadOnlyTools) ? s.trustedReadOnlyTools.join(', ') : '';
    $('#aiMcpTimeout').value = s.callTimeoutSeconds || 300;
    $('#aiMcpEnabled').checked = s.enabled !== false;
    toggleAiMcpTypeFields();
}
async function saveAiMcpFromForm(e) {
    e?.preventDefault?.();
    const ai = normalizeAiSettings(settings.ai || {});
    const id = $('#aiMcpId').value || (crypto.randomUUID?.() || `mcp_${Date.now()}`);
    const type = getAiSegmentValue('aiMcpType', 'stdio') === 'http' ? 'http' : 'stdio';
    const next = {
        id,
        name: $('#aiMcpName').value.trim(),
        type,
        command: $('#aiMcpCommand').value.trim(),
        args: $('#aiMcpArgs').value.trim().split(/\s+/).filter(Boolean),
        env: parseEnvLines($('#aiMcpEnv').value),
        url: $('#aiMcpUrl').value.trim(),
        headers: parseHeaderLines($('#aiMcpHeaders').value),
        trustedReadOnlyTools: $('#aiMcpTrustedReadOnly').value.split(/[\n,]/).map((x) => x.trim()).filter(Boolean),
        callTimeoutSeconds: Number($('#aiMcpTimeout').value) || 300,
        enabled: $('#aiMcpEnabled').checked,
        updatedAt: Date.now(),
    };
    if (!next.name) return toast(t('MCP 名称不能为空'));
    if (type === 'http' && !next.url) return toast(t('HTTP MCP 需要 URL'));
    if (type === 'stdio' && !next.command) return toast(t('stdio MCP 需要命令'));
    const list = Array.isArray(ai.mcpServers) ? ai.mcpServers.slice() : [];
    const idx = list.findIndex((x) => x.id === id);
    if (idx >= 0) list[idx] = next; else list.push(next);
    settings = await savePlatformSettings('ai', { ai: { ...ai, mcpServers: list } });
    aiSettingsState = normalizeAiSettings(settings.ai || {});
    renderAiMcpList();
    resetAiMcpForm();
    toast(t('MCP 已保存'));
}
async function deleteAiMcp(id) {
    const ai = normalizeAiSettings(settings.ai || {});
    const list = (ai.mcpServers || []).filter((s) => s.id !== id);
    settings = await savePlatformSettings('ai', { ai: { ...ai, mcpServers: list } });
    aiSettingsState = normalizeAiSettings(settings.ai || {});
    renderAiMcpList();
    toast(t('已删除'));
}
function collectAiSettingsForm() {
    const old = normalizeAiSettings(settings.ai || aiSettingsState || {});
    return {
        ...old,
        enabled: $('#aiEnabled').checked,
        assistantName: $('#aiAssistantName').value.trim() || 'Zephyr AI',
        defaultProviderId: $('#aiDefaultProvider').value,
        defaultModel: $('#aiDefaultModel').value.trim(),
        systemPrompt: $('#aiSystemPrompt').value,
        codeCompletionEnabled: $('#aiCodeCompletionEnabled').checked,
        context: {
            windowTokens: Number($('#aiContextWindowTokens')?.value) || 64000,
            maxInputChars: Number($('#aiContextMaxInputChars')?.value) || 90000,
            // No fixed message count: server derives budget from model window.
            toolResultChars: Number($('#aiContextToolResultChars')?.value) || 30000,
            memoryItems: old.context?.memoryItems ?? 16,
            maxToolRounds: Math.max(0, Number($('#aiContextMaxToolRounds')?.value) || 0),
        },
        sensitive: { requireConfirmation: $('#aiRequireConfirmation').checked, autoConfirm: $('#aiAutoConfirm').checked, autoConfirmDelayMs: Number($('#aiAutoConfirmDelayMs').value) || 0 },
        permissions: {
            webSearch: $('#aiPermWebSearch').checked,
            webFetch: $('#aiPermWebFetch').checked,
            browser: $('#aiPermBrowser').checked,
            remoteExecute: $('#aiPermRemoteExecute').checked,
            fileRead: $('#aiPermFileRead').checked,
            fileWrite: $('#aiPermFileWrite').checked,
            codeEdit: $('#aiPermCodeEdit').checked,
            memory: $('#aiPermMemory').checked,
            notesRead: $('#aiPermNotesRead').checked,
            notesWrite: $('#aiPermNotesWrite').checked,
            env: $('#aiPermEnv').checked,
            mode: getAiSegmentValue('aiPermRuleMode', 'ask'),
            deny: String($('#aiPermDeny')?.value || '').split('\n').map((x) => x.trim()).filter(Boolean),
            allow: String($('#aiPermAllow')?.value || '').split('\n').map((x) => x.trim()).filter(Boolean),
            ask: String($('#aiPermAsk')?.value || '').split('\n').map((x) => x.trim()).filter(Boolean),
        },
        planner: { enabled: $('#aiPlannerEnabled').checked, requirePlanBeforeTools: $('#aiRequirePlanBeforeTools').checked },
        memory: { enabled: $('#aiMemoryEnabled').checked, maxItems: Number($('#aiMemoryMaxItems').value) || 500 },
    };
}
async function saveAiSettings(e) {
    e?.preventDefault?.();
    const ai = collectAiSettingsForm();
    settings = await savePlatformSettings('ai', { ai });
    settings.ai = normalizeAiSettings(settings.ai || ai);
    renderAiSettingsForm();
    toast(t('AI 助理设置已保存'));
}
function aiProviderScrimSet(open, _Motion) {
    motionScrimSet('aiProviderModalScrim', 'aiprovider1-blurring', open);
}

function aiProviderBtnRadius(el, rect) {
    const r = parseFloat(getComputedStyle(el)?.borderRadius);
    if (Number.isFinite(r) && r > 0) return r;
    return Math.min(rect.width, rect.height) / 2;
}

async function openAiProviderModal(provider = null, trigger = null) {
    if (provider && provider.owned === false) { toast(t('共享 Provider 只能调用，不能编辑')); return; }
    window.clearTimeout(closeAiProviderModal._timer);
    const cycle = ++aiProviderModalCycle;
    const modal = $('#aiProviderModal');
    if (!modal || (modal.classList.contains('show') && !modal.classList.contains('closing'))) return;
    const card = $('#aiProviderForm');
    const inner = $('#aiProviderModalInner');
    $('#aiProviderModalTitle').textContent = provider ? t('编辑模型供应商') : t('添加模型供应商');
    $('#aiProviderId').value = provider?.id || '';
    $('#aiProviderName').value = provider?.name || '';
    setAiFieldSelectValue('aiProviderType', provider?.type || 'openai-compatible');
    $('#aiProviderBaseUrl').value = provider?.baseUrl || '';
    $('#aiProviderApiKey').value = provider?.hasApiKey ? '******' : '';
    setAiFieldSelectValue('aiProviderApiMode', provider?.apiMode || provider?.options?.apiMode || 'auto');
    aiProviderModelEntriesDraft = normalizeAiModelEntries(provider?.models || [], {
        providerVisionDefault: provider ? provider?.options?.vision !== false : true,
    });
    $('#aiProviderModels').value = aiProviderModelEntriesDraft.map((m) => m.id).join('\n');
    $('#aiProviderDefaultModel').value = provider?.defaultModel || '';
    renderAiProviderModelCatalog();
    if ($('#aiProviderModelUserAgents')) $('#aiProviderModelUserAgents').value = provider?.modelUserAgents || '';
    $('#aiProviderOrganization').value = provider?.organization || provider?.options?.organization || '';
    $('#aiProviderExtraHeaders').value = provider?.extraHeaders || '';
    $('#aiProviderTemperature').value = provider?.options?.temperature ?? -1;
    $('#aiProviderTopP').value = provider?.options?.top_p ?? -1;
    $('#aiProviderMaxTokens').value = provider?.options?.max_tokens ?? provider?.options?.max_output_tokens ?? 4096;
    if ($('#aiProviderContextWindow')) $('#aiProviderContextWindow').value = provider?.options?.context?.windowTokens ?? '';
    if ($('#aiProviderVision')) $('#aiProviderVision').checked = provider ? provider?.options?.vision !== false : true;
    if ($('#aiProviderUsePreviousResponse')) $('#aiProviderUsePreviousResponse').checked = !!provider?.options?.use_previous_response_id;
    setAiFieldSelectValue('aiProviderReasoningEffort', provider?.options?.reasoning_effort || '');
    $('#aiProviderPresencePenalty').value = provider?.options?.presence_penalty ?? 0;
    $('#aiProviderFrequencyPenalty').value = provider?.options?.frequency_penalty ?? 0;
    $('#aiProviderExtraJson').value = provider?.options?.extraJson || '';
    updateAiProviderModalHints();
    $('#aiProviderEnabled').checked = provider?.enabled !== false;
    $('#aiProviderShareUsers').checked = !!provider?.shareWithUsers;
    $('#aiProviderShareAdmins').checked = !!provider?.shareWithAdmins;
    aiProviderSelectedUserIds = new Set(provider?.sharedUserIds || []);
    // Only the exact control that launched this modal may own its matched geometry.
    // Add uses the header button; edit/reveal use the clicked provider-row action.
    aiProviderModalTrigger = trigger?.isConnected ? trigger : null;

    const fillShareTargets = async () => {
        aiProviderShareTargetsState = (await api('/api/ai/share-targets').catch(() => ({ users: [] }))).users || [];
        if (cycle !== aiProviderModalCycle) return;
        renderAiProviderShareTargets();
        const search = $('#aiProviderShareSearch');
        if (search) search.oninput = renderAiProviderShareTargets;
    };

    sshKeyMotion._ensure().then((Motion) => {
        if (cycle !== aiProviderModalCycle) return;
        armMotionModalOpen(Motion, modal, card, inner, aiProviderModalTrigger, 'aiprovider1');
        const btnRect = aiProviderModalTrigger?.getBoundingClientRect?.() || null;
        aiProviderScrimSet(true, Motion || null);
        const useMotion = !!Motion && !!btnRect && btnRect.width > 2 && btnRect.height > 2;
        if (!useMotion) {
            if (card?.style) {
                card.style.visibility = '';
                card.style.opacity = '';
                card.style.pointerEvents = '';
                card.style.overflow = 'visible';
                card.style.maxHeight = 'none';
                card.style.height = 'auto';
            }
            if (inner?.style) {
                inner.style.opacity = '';
                inner.style.overflow = 'visible';
                inner.style.maxHeight = 'none';
            }
            $('#aiProviderName')?.focus({ preventScroll: true });
            fillShareTargets();
            return;
        }
        Motion.iosAppOpen(card, aiProviderModalTrigger, {
            contentEl: inner,
            scrim: null,
            home: null,
            cloneSource: true,
            hideSource: true,
            radiusFrom: aiProviderBtnRadius(aiProviderModalTrigger, btnRect),
            radiusTo: 22,
            contentDelay: 0.16,
            faceDelay: 0.05,
            faceInDelay: 0.04,
            shapePreset: 'shape',
            contentPreset: 'content',
        }).then(() => {
            if (cycle !== aiProviderModalCycle) return;
            card.style.overflow = 'visible';
            card.style.maxHeight = 'none';
            card.style.height = 'auto';
            if (inner?.style) {
                inner.style.overflow = 'visible';
                inner.style.maxHeight = 'none';
            }
            // Fill after the shape settles: no DOM reflow while FLIP is running.
            fillShareTargets();
        }).catch((err) => {
            console.warn('[aiprovider1] iosAppOpen failed', err);
            fillShareTargets();
        });
        window.setTimeout(() => {
            if (cycle === aiProviderModalCycle && modal.classList.contains('show')) {
                $('#aiProviderName')?.focus({ preventScroll: true });
            }
        }, 220);
    });
}
function renderAiProviderShareTargets() {
    const root = $('#aiProviderShareTargets');
    if (!root) return;
    const q = String($('#aiProviderShareSearch')?.value || '').trim().toLowerCase();
    const users = aiProviderShareTargetsState.filter((u) => !q || String(u.username || '').toLowerCase().includes(q));
    root.innerHTML = users.length ? users.map((u) => `<label class="check-line ai-provider-share-user"><input type="checkbox" data-ai-share-user="${escapeHtml(u.userId)}" ${aiProviderSelectedUserIds.has(u.userId) ? 'checked' : ''}><span>${escapeHtml(u.username)}</span><small>${u.role === 'admin' ? t('管理员') : t('普通用户')}</small></label>`).join('') : `<span class="muted">${t('没有匹配用户')}</span>`;
    root.querySelectorAll('[data-ai-share-user]').forEach((input) => input.addEventListener('change', () => {
        if (input.checked) aiProviderSelectedUserIds.add(input.dataset.aiShareUser);
        else aiProviderSelectedUserIds.delete(input.dataset.aiShareUser);
    }));
}
function closeAiProviderModal() {
    const modal = $('#aiProviderModal');
    if (!modal?.classList.contains('show') || modal.classList.contains('closing')) return;
    const card = $('#aiProviderForm');
    const inner = $('#aiProviderModalInner');
    const cycle = ++aiProviderModalCycle;
    window.clearTimeout(closeAiProviderModal._timer);

    modal.classList.add('closing');
    modal.classList.remove('app-visible');
    modal.setAttribute('aria-hidden', 'true');

    const Motion = sshKeyMotion.engine;
    const trigger = aiProviderModalTrigger;
    const btnRect = trigger?.getBoundingClientRect?.() || null;
    const useMotion = !!Motion && !sshKeyMotion.failed
        && modal.classList.contains('aiprovider1')
        && !!btnRect && btnRect.width > 2 && btnRect.height > 2;

    const finish = () => {
        if (cycle !== aiProviderModalCycle) return;
        if (Motion) {
            try {
                if (trigger) Motion.restoreSource(trigger);
                Motion.restoreSources(card);
            } catch {}
        } else if (trigger?.style) {
            trigger.style.opacity = '';
            trigger.style.pointerEvents = '';
            delete trigger.dataset.motionHidden;
        }
        void (trigger?.offsetHeight);
        void card.offsetHeight;

        modal.classList.remove('show', 'closing', 'aiprovider1');

        if (Motion) {
            try {
                card.querySelector?.(':scope > [data-motion-source-visual]')?.remove();
                Motion.release(card);
                if (inner) Motion.release(inner);
            } catch {}
        }
        card.style.overflow = '';
        card.style.maxHeight = '';
        card.style.height = '';
        if (inner?.style) {
            inner.style.overflow = '';
            inner.style.maxHeight = '';
        }
        card.style.visibility = '';
        card.style.opacity = '';
        card.style.filter = '';
        card.style.transform = '';
        card.style.borderRadius = '';
        const focusEl = trigger;
        aiProviderModalTrigger = null;
        if (focusEl) {
            requestAnimationFrame(() => {
                try { focusEl.focus?.({ preventScroll: true }); } catch {}
            });
        }
    };

    aiProviderScrimSet(false, Motion || null);
    if (!useMotion) {
        closeAiProviderModal._timer = window.setTimeout(finish, 0);
        return;
    }
    try {
        const twinLayer = card.querySelector(':scope > [data-motion-source-visual]');
        if (twinLayer) Motion.set(twinLayer, { opacity: Number(twinLayer.style.opacity) || 0 });
    } catch {}
    const closed = Motion.iosAppClose(card, trigger, {
        contentEl: inner,
        scrim: null,
        home: null,
        restoreSource: false,
        hideSurface: false,
        clearSourceVisual: false,
        release: false,
        radiusTo: aiProviderBtnRadius(trigger, btnRect),
        shapePreset: 'shapeClose',
        contentPreset: 'contentClose',
        faceInDelay: 0.04,
    });
    const cap = new Promise(r => window.setTimeout(r, 900));
    Promise.race([closed, cap]).then(() => {
        requestAnimationFrame(() => finish());
    }).catch((err) => {
        console.warn('[aiprovider1] iosAppClose failed', err);
        finish();
    });
}
async function saveAiProvider(e) {
    e.preventDefault();
    const existingId = $('#aiProviderId').value || '';
    const providerTypeValue = $('#aiProviderType').value;
    const apiKeyValue = $('#aiProviderApiKey').value;
    const payload = {
        name: $('#aiProviderName').value.trim() || t('未命名供应商'),
        type: providerTypeValue,
        enabled: $('#aiProviderEnabled').checked,
        baseUrl: $('#aiProviderBaseUrl').value.trim(),
        apiMode: ['openai-compatible', 'openai'].includes(providerTypeValue) ? ($('#aiProviderApiMode').value || 'auto') : 'native',
        models: mergeAiModelEntries(aiProviderModelEntriesDraft, $('#aiProviderModels').value, {
            providerVisionDefault: !!$('#aiProviderVision')?.checked,
        }),
        defaultModel: $('#aiProviderDefaultModel').value.trim(),
        modelUserAgents: $('#aiProviderModelUserAgents')?.value.trim() || '',
        organization: $('#aiProviderOrganization').value.trim(),
        extraHeaders: $('#aiProviderExtraHeaders').value.trim(),
        options: {
            temperature: Number($('#aiProviderTemperature').value),
            top_p: Number($('#aiProviderTopP').value),
            max_tokens: Number($('#aiProviderMaxTokens').value) || 4096,
            max_output_tokens: Number($('#aiProviderMaxTokens').value) || 4096,
            reasoning_effort: $('#aiProviderReasoningEffort').value,
            vision: !!$('#aiProviderVision')?.checked,
            use_previous_response_id: !!$('#aiProviderUsePreviousResponse')?.checked,
            context: { windowTokens: Number($('#aiProviderContextWindow')?.value) || undefined },
            presence_penalty: Number($('#aiProviderPresencePenalty').value) || 0,
            frequency_penalty: Number($('#aiProviderFrequencyPenalty').value) || 0,
            extraJson: $('#aiProviderExtraJson').value.trim(),
        },
        shareWithUsers: !!$('#aiProviderShareUsers').checked,
        shareWithAdmins: !!$('#aiProviderShareAdmins').checked,
        sharedUserIds: Array.from(aiProviderSelectedUserIds),
    };
    if (apiKeyValue && apiKeyValue !== '******') payload.apiKey = apiKeyValue;
    const result = existingId
        ? await api(`/api/ai/providers/${encodeURIComponent(existingId)}`, { method: 'PATCH', body: JSON.stringify(payload) })
        : await api('/api/ai/providers', { method: 'POST', body: JSON.stringify(payload) });
    const savedProvider = normalizeVisibleAiProvider(result.provider || {});
    const savedId = savedProvider.id;
    const visible = await api('/api/ai/providers');
    settings.ai = { ...(settings.ai || {}), providers: visible.providers || [] };
    aiSettingsState = normalizeAiSettings(settings.ai);
    closeAiProviderModal();
    const refreshProviderSurfaces = () => {
        renderAiProviderOptions();
        renderAiHeaderSelectors();
        renderAiProviderList();
    };
    if ($('#aiProviderModal')?.classList.contains('closing')) {
        window.setTimeout(refreshProviderSurfaces, 920);
    } else {
        refreshProviderSurfaces();
    }
    const shouldAutoFetchModels = !aiModelNames(savedProvider).length && savedProvider.enabled !== false && (savedProvider.hasApiKey || !!payload.apiKey);
    if (shouldAutoFetchModels) {
        toast(t('模型供应商已保存，正在获取模型...'));
        await fetchAiModelsForProvider(savedId);
    } else toast(t('模型供应商已保存'));
    // Provider persistence is handled by the per-user API above.
}
function renderAiProviderList() {
    const list = $('#aiProviderList');
    if (!list) return;
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    list.innerHTML = ai.providers.length ? ai.providers.map((p) => {
        const models = aiModelNames(p, { includeHidden: true });
        const visibleCount = aiModelNames(p).length;
        const modelText = p.defaultModel || models[0] || (p.modelsPending ? t('可点击获取模型') : t('未获取模型'));
        const owned = p.owned !== false;
        const sharedLabels = [];
        if (p.shareWithUsers) sharedLabels.push(t('所有用户'));
        if (p.shareWithAdmins) sharedLabels.push(t('所有管理员'));
        if (Array.isArray(p.sharedUserIds) && p.sharedUserIds.length) sharedLabels.push(t('指定用户 {count}', { count: p.sharedUserIds.length }));
        const source = owned ? t('我的 Provider') : t('由 {user} 共享', { user: p.ownerUsername || t('其他用户') });
        const sharedText = sharedLabels.length ? ` · ${t('共享：{targets}', { targets: sharedLabels.join('、') })}` : '';
        const capHints = normalizeAiModelEntries(p.models, { providerVisionDefault: p?.options?.vision !== false })
            .filter((m) => !m.hidden)
            .slice(0, 6)
            .map((m) => aiModelGlyphIcons(m).map((g) => g.html).join(''))
            .filter(Boolean)
            .join('');
        const meta = [
            p.type || 'openai-compatible',
            p.enabled === false ? t('已停用') : t('已启用'),
            source + sharedText,
            models.length ? t('默认：{model}', { model: modelText }) : '',
        ].filter(Boolean).join(' · ');
        return `<div class="ai-provider-item" data-provider-id="${escapeHtml(p.id)}">
            <div class="ai-provider-item-main">
                <strong class="ai-provider-item-name">${escapeHtml(p.name || t('未命名供应商'))}</strong>
                <p class="ai-provider-item-meta">${escapeHtml(meta)}</p>
                <p class="ai-provider-item-url" title="${escapeAttr(p.baseUrl || '')}">${escapeHtml(p.baseUrl || t('默认 API 地址'))}</p>
                <button type="button" class="ai-provider-models-link" data-ai-open-models="${escapeAttr(p.id)}">
                    <span class="ai-provider-models-link-label">${escapeHtml(t('模型（{count}）', { count: visibleCount || models.length }))}</span>
                    <span class="ai-models-list-trailing">${capHints}<span class="ai-models-chevron" aria-hidden="true">›</span></span>
                </button>
            </div>
            <div class="ai-provider-item-actions">
                <button type="button" class="tool-btn" data-ai-fetch-provider-models="${escapeHtml(p.id)}">${t('获取模型')}</button>
                ${owned ? `<button type="button" class="tool-btn" data-ai-reveal-provider-key="${escapeHtml(p.id)}">${t('查看 Key')}</button><button type="button" class="tool-btn" data-ai-edit-provider="${escapeHtml(p.id)}">${t('编辑')}</button><button type="button" class="tool-btn danger" data-ai-delete-provider="${escapeHtml(p.id)}">${t('删除')}</button>` : `<span class="muted ai-provider-readonly">${t('仅可调用')}</span>`}
            </div>
        </div>`;
    }).join('') : `<p class="empty-state">${t('暂无可用模型供应商。创建自己的 Provider，或让其他用户共享给你。')}</p>`;
}
function readAiProviderFormDraft() {
    const apiKey = $('#aiProviderApiKey')?.value || '';
    return {
        id: ($('#aiProviderId')?.value || '').trim(),
        name: ($('#aiProviderName')?.value || '').trim() || t('临时供应商'),
        type: $('#aiProviderType')?.value || 'openai-compatible',
        baseUrl: ($('#aiProviderBaseUrl')?.value || '').trim(),
        apiMode: $('#aiProviderApiMode')?.value || 'auto',
        apiKey,
        organization: ($('#aiProviderOrganization')?.value || '').trim(),
        extraHeaders: ($('#aiProviderExtraHeaders')?.value || '').trim(),
        modelUserAgents: ($('#aiProviderModelUserAgents')?.value || '').trim(),
    };
}

/**
 * @param {string} [id] saved provider id (list/card/L2). Empty = use edit modal form as-is.
 */
async function fetchAiModelsForProvider(id = '') {
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    const modalOpen = !!$('#aiProviderModal')?.classList.contains('show');
    const formDraft = modalOpen ? readAiProviderFormDraft() : null;
    const formId = formDraft?.id || '';
    // List/card path uses saved provider; modal path uses current form (saved key if ******).
    const fromList = !!id;
    const saved = fromList ? ai.providers.find((p) => p.id === id) : (formId ? ai.providers.find((p) => p.id === formId) : null);
    if (fromList && !saved) return toast(t('供应商不存在'));

    let body;
    if (fromList) {
        body = { providerId: id };
    } else if (formDraft) {
        const key = formDraft.apiKey;
        const hasLiveKey = key && key !== '******';
        if (!formId && !hasLiveKey) {
            return toast(t('请先填写 API Key'));
        }
        // Always send form draft so baseUrl/type edits apply without saving.
        // Server merges draft onto saved secret when providerId is set and key is ******.
        body = {
            providerId: formId || undefined,
            provider: {
                ...formDraft,
                apiKey: hasLiveKey ? key : undefined,
            },
        };
    } else {
        return toast(t('供应商不存在'));
    }

    const btn = modalOpen ? $('#aiFetchModelsBtn') : null;
    if (btn) btn.disabled = true;
    try {
        const data = await api('/api/ai/models', { method: 'POST', body: JSON.stringify(body) });
        const remoteEntries = (data.models || []).map((model) => ({
            id: model.id || model.name,
            label: model.name || model.display_name || model.id || '',
        })).filter((model) => model.id);
        const uniqueNames = Array.from(new Set(remoteEntries.map((model) => model.id)));
        if (!uniqueNames.length && data.preserveExisting) return toast(t('自定义端点未返回模型列表，已保留现有模型配置'));
        if (!uniqueNames.length) return toast(t('没有获取到模型'));

        if (fromList) {
            if (saved.owned === false) return toast(t('已获取 {count} 个模型（共享 Provider 不能修改）', { count: uniqueNames.length }));
            const merged = mergeAiModelEntries(saved.models, remoteEntries, {
                providerVisionDefault: saved?.options?.vision !== false,
            });
            await api(`/api/ai/providers/${encodeURIComponent(id)}`, {
                method: 'PATCH',
                body: JSON.stringify({ models: merged, defaultModel: saved.defaultModel || uniqueNames[0] }),
            });
            const visible = await api('/api/ai/providers');
            settings.ai = { ...(settings.ai || {}), providers: visible.providers || [] };
            aiSettingsState = normalizeAiSettings(settings.ai);
            renderAiProviderOptions();
            renderAiHeaderSelectors();
            renderAiProviderList();
            if (aiModelsPageProviderId === id) renderAiModelsListPage();
        } else {
            // Modal: write into form only — user still clicks 保存供应商 to persist.
            aiProviderModelEntriesDraft = mergeAiModelEntries(aiProviderModelEntriesDraft, remoteEntries, {
                providerVisionDefault: !!$('#aiProviderVision')?.checked,
            });
            if ($('#aiProviderModels')) {
                $('#aiProviderModels').value = aiProviderModelEntriesDraft.map((m) => m.id).join('\n');
            }
            if ($('#aiProviderDefaultModel') && !$('#aiProviderDefaultModel').value) {
                $('#aiProviderDefaultModel').value = uniqueNames[0] || '';
            }
            renderAiProviderModelCatalog();
        }
        toast(t('已获取 {count} 个模型', { count: uniqueNames.length }));
    } catch (err) {
        toast(err.message || t('获取模型失败'));
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function deleteAiProvider(id) {
    openAiInlineConfirm({
        title: t('删除模型供应商'),
        body: t('删除后需重新配置 API Key 与模型列表。'),
        confirmLabel: t('删除'),
        danger: true,
        onConfirm: async () => {
            await api(`/api/ai/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
            const visible = await api('/api/ai/providers');
            settings.ai = { ...(settings.ai || {}), providers: visible.providers || [] };
            aiSettingsState = normalizeAiSettings(settings.ai);
            renderAiProviderOptions();
            renderAiHeaderSelectors();
            renderAiProviderList();
            toast(t('模型供应商已删除'));
        },
    });
}

function resetAiEnvForm() {
    $('#aiEnvId').value = '';
    $('#aiEnvName').value = '';
    $('#aiEnvDescription').value = '';
    $('#aiEnvValue').value = '';
    $('#aiEnvValue').type = 'password';
    $('#toggleAiEnvValue').textContent = '👁️';
    $('#aiEnvEnabled').checked = true;
    $('#aiEnvVisibleToAi').checked = false;
    $('#aiEnvValueVisibleToAi').checked = false;
}
function renderAiEnvList() {
    const list = $('#aiEnvList');
    if (!list) return;
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    list.innerHTML = ai.envVars.length ? ai.envVars.map((item) => `<div class="ai-env-item" data-env-id="${escapeHtml(item.id)}"><div><strong>${escapeHtml(item.name || 'UNNAMED')}</strong><span>${item.enabled === false ? t('已停用') : t('已启用')} · ${item.hasValue || item.value ? t('已保存值') : t('无值')} · ${item.visibleToAi ? t('AI可见') : t('AI屏蔽')}${item.valueVisibleToAi ? `/${t('值可见')}` : ''} · ${escapeHtml(item.description || '')}</span></div><button class="tool-btn" data-ai-edit-env="${escapeHtml(item.id)}">${t('编辑')}</button><button class="tool-btn danger" data-ai-delete-env="${escapeHtml(item.id)}">${t('删除')}</button></div>`).join('') : `<p class="empty-state">${t('暂无 AI 环境变量。变量值会加密保存，AI 读取时需要敏感确认。')}</p>`;
}
async function saveAiEnv(e) {
    e.preventDefault();
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    const id = $('#aiEnvId').value || `env-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const idx = ai.envVars.findIndex((x) => x.id === id);
    const oldItem = idx >= 0 ? ai.envVars[idx] : {};
    const rawValue = $('#aiEnvValue').value;
    const item = {
        id,
        name: $('#aiEnvName').value.trim(),
        description: $('#aiEnvDescription').value.trim(),
        // The settings response intentionally has no plaintext env value.
        // Preserve the sentinel so the account-scoped canonical service keeps
        // the existing ciphertext instead of treating an edit as a clear.
        value: rawValue === '******' ? '******' : rawValue,
        enabled: $('#aiEnvEnabled').checked,
        visibleToAi: $('#aiEnvVisibleToAi').checked,
        valueVisibleToAi: $('#aiEnvValueVisibleToAi').checked,
        updatedAt: Date.now(),
    };
    if (!item.name) return toast(t('请填写变量名'));
    if (idx >= 0) ai.envVars[idx] = item; else ai.envVars.unshift(item);
    settings = await savePlatformSettings('ai', { ai });
    resetAiEnvForm(); renderAiSettingsForm(); toast(t('AI 环境变量已保存'));
}
async function deleteAiEnv(id) {
    openAiInlineConfirm({
        title: t('删除环境变量'),
        body: t('删除后 AI 将无法再通过此变量名读取对应密钥。'),
        confirmLabel: t('删除'),
        danger: true,
        onConfirm: async () => {
            const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
            ai.envVars = ai.envVars.filter((x) => x.id !== id);
            settings = await savePlatformSettings('ai', { ai });
            renderAiSettingsForm(); toast(t('AI 环境变量已删除'));
        },
    });
}
function resetAiMemoryForm() {
    $('#aiMemoryId').value = '';
    $('#aiMemoryTitle').value = '';
    $('#aiMemoryScope').value = '';
    $('#aiMemoryConnectionIds').value = '';
    $('#aiMemoryTags').value = '';
    $('#aiMemoryContent').value = '';
    $('#aiMemoryItemEnabled').checked = true;
}
function renderAiMemoryList() {
    const list = $('#aiMemoryList');
    if (!list) return;
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    list.innerHTML = ai.memories.length ? ai.memories.slice(0, 80).map((m) => {
        const tags = Array.isArray(m.tags) ? m.tags : splitCsv(m.tags);
        const connIds = Array.isArray(m.connectionIds) ? m.connectionIds : splitCsv(m.connectionIds);
        const meta = [m.enabled === false ? t('已停用') : t('已启用'), m.scope || 'global', m.project || '', tags.length ? `标签:${tags.join(',')}` : '', connIds.length ? `连接:${connIds.length}` : ''].filter(Boolean).join(' · ');
        return `<div class="ai-memory-item" data-memory-id="${escapeHtml(m.id)}"><div><strong>${escapeHtml(m.title || 'Memory')}</strong><span>${escapeHtml(meta)}</span><code>${escapeHtml((m.content || '').slice(0, 300))}</code></div><button class="tool-btn" data-ai-edit-memory="${escapeHtml(m.id)}">${t('编辑')}</button><button class="tool-btn danger" data-ai-delete-memory="${escapeHtml(m.id)}">${t('删除')}</button></div>`;
    }).join('') : `<p class="empty-state">${t('暂无长期 Memory。AI 也可通过 memory_save 工具主动记录项目记忆，并按连接、项目、标签自动关联。')}</p>`;
}
async function saveAiMemory(e) {
    e.preventDefault();
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    const id = $('#aiMemoryId').value || `memory-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const scope = $('#aiMemoryScope').value.trim() || 'global';
    const item = {
        id,
        title: $('#aiMemoryTitle').value.trim() || 'Memory',
        scope,
        project: scope,
        projects: scope && scope !== 'global' ? [scope] : [],
        tags: splitCsv($('#aiMemoryTags').value),
        connectionIds: splitCsv($('#aiMemoryConnectionIds').value),
        content: $('#aiMemoryContent').value,
        enabled: $('#aiMemoryItemEnabled').checked,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    if (!item.content.trim()) return toast(t('请填写 Memory 内容'));
    const old = ai.memories.find((x) => x.id === id);
    if (old) item.createdAt = old.createdAt || item.createdAt;
    const idx = ai.memories.findIndex((x) => x.id === id);
    if (idx >= 0) ai.memories[idx] = item; else ai.memories.unshift(item);
    settings = await savePlatformSettings('ai', { ai });
    resetAiMemoryForm(); renderAiSettingsForm(); toast(t('Memory 已保存'));
}
async function deleteAiMemory(id) {
    openAiInlineConfirm({
        title: t('删除 Memory'),
        body: t('删除后无法恢复该条长期记忆。'),
        confirmLabel: t('删除'),
        danger: true,
        onConfirm: async () => {
            await deleteAiMemoryConfirmed(id);
        },
    });
}
async function deleteAiMemoryConfirmed(id) {
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    ai.memories = ai.memories.filter((x) => x.id !== id);
    settings = await savePlatformSettings('ai', { ai });
    renderAiSettingsForm(); toast(t('Memory 已删除'));
}
function renderAiPlanList() {
    const list = $('#aiPlanList');
    if (!list) return;
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    list.innerHTML = ai.plans.length ? ai.plans.slice(0, 30).map((plan) => {
        const steps = Array.isArray(plan.steps) ? plan.steps : [];
        const actions = `<div class="ai-plan-actions"><button class="tool-btn" data-ai-plan-pause="${escapeHtml(plan.id)}">${t('暂停')}</button><button class="tool-btn" data-ai-plan-resume="${escapeHtml(plan.id)}">${t('继续')}</button><button class="tool-btn" data-ai-plan-retry="${escapeHtml(plan.id)}">${t('重试失败')}</button><button class="tool-btn danger" data-ai-plan-delete="${escapeHtml(plan.id)}">${t('删除')}</button></div>`;
        return `<div class="ai-plan-item" data-plan-id="${escapeHtml(plan.id)}"><div><strong>${escapeHtml(plan.title || t('任务计划'))}</strong><span><b class="ai-status ai-status-${escapeHtml(plan.status || 'planned')}">${escapeHtml(plan.status || 'planned')}</b> · ${fmtTime(plan.updatedAt || plan.createdAt)}</span>${plan.risk ? `<p>${escapeHtml(plan.risk)}</p>` : ''}<ol>${steps.map((s, index) => `<li><em class="ai-status ai-status-${escapeHtml(s.status || 'pending')}">${escapeHtml(s.status || 'pending')}</em> ${escapeHtml(s.text || '')}${s.note ? `<small>${escapeHtml(s.note)}</small>` : ''}${s.error ? `<small class="error-text">${escapeHtml(s.error)}</small>` : ''}<div class="ai-step-actions"><button data-ai-plan-step="${escapeHtml(plan.id)}" data-step-index="${index + 1}" data-step-status="running">${t('执行中')}</button><button data-ai-plan-step="${escapeHtml(plan.id)}" data-step-index="${index + 1}" data-step-status="completed">${t('完成')}</button><button data-ai-plan-step="${escapeHtml(plan.id)}" data-step-index="${index + 1}" data-step-status="failed">${t('失败')}</button></div></li>`).join('')}</ol>${actions}</div></div>`;
    }).join('') : `<p class="empty-state">${t('暂无任务计划。AI 可通过 plan_task 工具为复杂任务创建计划，并持续更新步骤状态。')}</p>`;
}

function resetAiSkillForm() {
    $('#aiSkillId').value = '';
    $('#aiSkillName').value = '';
    $('#aiSkillDescription').value = '';
    $('#aiSkillPrompt').value = '';
    $('#aiSkillEnabled').checked = true;
}
function renderAiSkillList() {
    const list = $('#aiSkillList');
    if (!list) return;
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    const displaySkill = (skill) => skill.id === 'zephyr-unified-operator'
        ? { ...skill, name: t('Zephyr AI 全能力总控'), description: t('统一连接资产、终端命令、文件、远程桌面、浏览器、Memory 与 UI 操作的内置 Skill。'), prompt: t('内置完整操作规程；模型回复语言仍跟随当前界面语言。') }
        : skill;
    list.innerHTML = ai.skills.length ? ai.skills.map((raw) => {
        const s = displaySkill(raw);
        const actions = s.builtin
            ? `<span class="muted">${t('内置只读')}</span>`
            : `<button class="tool-btn" data-ai-edit-skill="${escapeHtml(s.id)}">${t('编辑')}</button><button class="tool-btn danger" data-ai-delete-skill="${escapeHtml(s.id)}">${t('删除')}</button>`;
        return `<div class="ai-skill-item" data-skill-id="${escapeHtml(s.id)}"><div><strong>${escapeHtml(s.name || t('未命名 Skill'))}</strong><span>${s.enabled === false ? t('已停用') : t('已启用')} · ${escapeHtml(s.description || '')}</span><code>${escapeHtml((s.prompt || '').slice(0, 260))}</code></div>${actions}</div>`;
    }).join('') : `<p class="empty-state">${t('暂无 Skill。可以把工作流、工具使用规则、专用提示词保存成能力包。')}</p>`;
}
async function saveAiSkill(e) {
    e.preventDefault();
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    const id = $('#aiSkillId').value || `skill-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    if (id === 'zephyr-unified-operator') return toast(t('内置 Skill 不可修改'));
    const skill = { id, name: $('#aiSkillName').value.trim(), description: $('#aiSkillDescription').value.trim(), prompt: $('#aiSkillPrompt').value, enabled: $('#aiSkillEnabled').checked, updatedAt: Date.now() };
    if (!skill.name && !skill.prompt.trim()) return toast(t('请填写 Skill 名称或指令内容'));
    const idx = ai.skills.findIndex((s) => s.id === id);
    if (idx >= 0) ai.skills[idx] = skill; else ai.skills.unshift(skill);
    settings = await savePlatformSettings('ai', { ai });
    resetAiSkillForm();
    renderAiSettingsForm();
    toast(t('Skill 已保存'));
}
async function deleteAiSkill(id) {
    if (id === 'zephyr-unified-operator') return toast(t('内置 Skill 不可删除'));
    openAiInlineConfirm({
        title: t('删除 Skill'),
        body: t('删除后该能力包不会再注入 AI 系统提示。'),
        confirmLabel: t('删除'),
        danger: true,
        onConfirm: async () => {
            const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
            ai.skills = ai.skills.filter((s) => s.id !== id);
            settings = await savePlatformSettings('ai', { ai });
            renderAiSettingsForm();
            toast(t('Skill 已删除'));
        },
    });
}
function aiHistoryCacheMetadata(sessions = []) {
    return (Array.isArray(sessions) ? sessions : []).slice(0, 40).map((session) => ({
        id: String(session?.id || ''),
        runtimeSessionId: String(session?.runtimeSessionId || ''),
        collabMode: String(session?.collabMode || ''),
        runProfile: String(session?.runProfile || ''),
        permissionMode: String(session?.permissionMode || ''),
    })).filter((session) => session.id);
}
function saveAiChats() {
    try {
        localStorage.setItem(AI_CHAT_STORAGE_KEY, JSON.stringify({
            version: 2,
            ownerUserId: myIdentity.userId || '',
            current: aiCurrentSessionId,
            // Canonical message bodies and attachment refs never enter browser
            // persistence. This cache contains only UI/runtime routing state.
            sessions: aiHistoryCacheMetadata(aiChatSessions),
        }));
    } catch (_) {}
}
function readAiHistoryMetadataCache() {
    try {
        const data = JSON.parse(localStorage.getItem(AI_CHAT_STORAGE_KEY) || '{}');
        if (Number(data.version) !== 2 || String(data.ownerUserId || '') !== String(myIdentity.userId || '')) {
            // Version 1 contained ownerless message bodies. It cannot be
            // assigned to whichever account happens to log in next.
            localStorage.removeItem(AI_CHAT_STORAGE_KEY);
            return { current: '', sessions: [] };
        }
        return {
            current: String(data.current || ''),
            sessions: aiHistoryCacheMetadata(data.sessions),
        };
    } catch (_) { return { current: '', sessions: [] }; }
}
async function loadAiChats({ force = false } = {}) {
    if (aiHistoryLoadPromise) return aiHistoryLoadPromise;
    aiHistoryLoadPromise = (async () => {
        const cache = readAiHistoryMetadataCache();
        const metadata = new Map(cache.sessions.map((session) => [session.id, session]));
        const data = await api('/api/ai/history/conversations?withMessages=1');
        aiChatSessions = (Array.isArray(data.conversations) ? data.conversations : []).map((conversation) => ({
            ...metadata.get(String(conversation.id)) || {},
            ...conversation,
            messages: Array.isArray(conversation.messages) ? conversation.messages : [],
        }));
        aiCurrentSessionId = aiChatSessions.some((session) => session.id === aiCurrentSessionId)
            ? aiCurrentSessionId
            : (aiChatSessions.some((session) => session.id === cache.current) ? cache.current : aiChatSessions[0]?.id || null);
        aiHistoryLoaded = true;
        saveAiChats();
        return aiChatSessions;
    })().finally(() => { aiHistoryLoadPromise = null; });
    return aiHistoryLoadPromise;
}
function ensureCanonicalAiConversation(session) {
    if (!session) return Promise.reject(new Error(t('AI 对话不存在')));
    if (session.revision > 0) return Promise.resolve(session);
    if (session.canonicalPromise) return session.canonicalPromise;
    session.canonicalPromise = api('/api/ai/history/conversations', {
        method: 'POST',
        body: JSON.stringify({ id: session.id, title: session.title || t('新对话') }),
    }).then((data) => {
        Object.assign(session, data.conversation || {}, { messages: session.messages || [] });
        saveAiChats();
        return session;
    }).finally(() => { delete session.canonicalPromise; });
    return session.canonicalPromise;
}
async function reloadCanonicalAiHistory() {
    if ([...aiSessionRuns.keys()].some((id) => aiIsSessionRunning(id))) {
        scheduleAiHistoryReload(800);
        return;
    }
    const current = aiCurrentSessionId;
    await loadAiChats({ force: true });
    if (current && aiChatSessions.some((session) => session.id === current)) aiCurrentSessionId = current;
    if (aiPanelState !== 'closed') renderAiChat();
}
function scheduleAiHistoryReload(delay = 180) {
    window.clearTimeout(aiHistoryReloadTimer);
    aiHistoryReloadTimer = window.setTimeout(() => {
        reloadCanonicalAiHistory().catch((error) => console.warn('[ai-history]', error?.code || error?.message || error));
    }, delay);
}
function createAiChat({ silent = false } = {}) {
    const id = `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const session = { id, title: t('新对话'), messages: [], revision: 0, ownerUserId: myIdentity.userId || '' };
    aiChatSessions.unshift(session);
    aiCurrentSessionId = id;
    aiEditingMessageIndex = -1;
    aiEditingSessionId = '';
    syncAiEditingState();
    saveAiChats();
    ensureCanonicalAiConversation(session).catch((error) => toast(error.message || t('创建 AI 对话失败')));
    if (!silent) renderAiChat();
    return session;
}
function renderAiChatList() {
    const list = $('#aiChatList');
    if (!list) return;
    list.innerHTML = aiChatSessions.map((s) => {
        const running = aiIsSessionRunning(s.id);
        return `<div class="ai-chat-row ${s.id === aiCurrentSessionId ? 'active' : ''} ${running ? 'running' : ''}" data-ai-chat-row="${escapeHtml(s.id)}"><button class="ai-chat-item" data-ai-chat="${escapeHtml(s.id)}"><span class="ai-chat-title-text">${escapeHtml(s.title || t('新对话'))}</span>${running ? `<span class="ai-chat-running-dot" title="${t('AI 正在回复')}"></span>` : ''}</button><button class="ai-chat-delete" type="button" data-ai-delete-chat="${escapeHtml(s.id)}" title="${t('删除对话')}" aria-label="${t('删除对话')}">×</button></div>`;
    }).join('');
}
function renderAiChat() {
    if (!aiChatSessions.length) createAiChat({ silent: true });
    const session = aiCurrentSession();
    $('#aiCurrentChatTitle').textContent = session.title || t('新对话');
    setAiSegmentValue('aiCollabMode', session.collabMode || 'standard', { silent: true });
    setAiSegmentValue('aiRunProfile', session.runProfile || 'balanced', { silent: true });
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    setAiSegmentValue('aiChatPermissionMode', session.permissionMode || ai.permissions?.mode || (ai.sensitive?.autoConfirm ? 'yolo' : 'ask'), { silent: true });
    renderAiBrowserPreview();
    const area = $('#aiChatArea');
    const typing = $('#aiTypingIndicator');
    area.querySelectorAll('.ai-message').forEach((el) => el.remove());
    session.messages.forEach((m, index) => {
        if (m.role === 'confirmation') {
            const pending = aiPendingConfirmations.get(m.confirmationId);
            if (pending?.confirmation) insertAiConfirmationCard(pending.confirmation, index);
            else appendAiMessage(m.content, 'assistant', { store: false, messageIndex: index, sessionId: session.id });
            return;
        }
        appendAiMessage(m.content, m.role, { store: false, rawHtml: m.role === 'trace', messageIndex: index, sessionId: session.id, metrics: m.metrics || null });
    });
    area.appendChild(typing);
    updateAiRunUiForCurrentSession();
    renderAiChatList();
    syncAiEditingState();
    scrollAiChat();
}
function summarizeAiUserMessageForDisplay(text = '') {
    return String(text || '')
        .replace(/附件图片：([^\n]+)\n\s*data:image\/[^;\s]+(?:;[^,\s]+)*;base64,[A-Za-z0-9+/=\r\n]+/g, '附件图片：$1\n[图片已发送]')
        .replace(/data:image\/[A-Za-z0-9.+-]+(?:;[^,\s]+)*;base64,[A-Za-z0-9+/=\r\n]+/g, '[图片已发送]');
}
function renderAiMessageContent(text = '', role = 'assistant', rawHtml = false) {
    if (rawHtml) return String(text || '');
    const source = role === 'user' ? summarizeAiUserMessageForDisplay(text) : String(text || '');
    return renderMarkdown(source, { enhancedCode: role !== 'trace' });
}
function appendAiMessage(text, role = 'assistant', { store = true, meta = '', rawHtml = false, messageIndex = -1, sessionId = '', metrics = null, id = '', attachments = [] } = {}) {
    const targetSessionId = String(sessionId || aiCurrentSessionId || '');
    const session = targetSessionId
        ? aiChatSessions.find((s) => s.id === targetSessionId)
        : aiCurrentSession();
    if (!session) return null;
    const normalizedRole = rawHtml ? 'trace' : (role === 'ai' ? 'assistant' : role);
    let storedIndex = messageIndex;
    if (store) {
        const record = {
            id: String(id || `message-${Date.now()}-${Math.random().toString(16).slice(2)}`),
            role: normalizedRole,
            content: String(text || ''),
        };
        if (Array.isArray(attachments) && attachments.length) {
            record.attachments = attachments.map((item) => ({
                id: String(item?.id || ''), name: String(item?.name || ''),
                kind: String(item?.kind || ''), mime: String(item?.mime || ''),
                size: Math.max(0, Number(item?.size) || 0),
            })).filter((item) => item.id);
        }
        if (metrics && typeof metrics === 'object') record.metrics = metrics;
        session.messages.push(record);
        storedIndex = session.messages.length - 1;
        if (role === 'user' && (!session.title || session.title === '新对话' || session.title === t('新对话') || session.title === '新沙箱')) {
            session.title = String(text || '').slice(0, 14) + (String(text || '').length > 14 ? '...' : '');
            if (session.id === aiCurrentSessionId) $('#aiCurrentChatTitle').textContent = session.title;
        }
        saveAiChats();
        renderAiChatList();
    }
    const storedRecord = storedIndex >= 0 ? session.messages[storedIndex] : null;
    if (session.id !== aiCurrentSessionId) return storedRecord;
    const area = $('#aiChatArea');
    const typing = $('#aiTypingIndicator');
    if (!area || !typing) return;
    const div = document.createElement('div');
    div.className = `ai-message ${role === 'user' ? 'user' : (role === 'system' || role === 'trace') ? 'system' : 'ai'}`;
    div.dataset.aiMessageRole = normalizedRole;
    if (storedIndex >= 0) div.dataset.aiMessageIndex = String(storedIndex);
    div.dataset.aiMessageText = String(text || '');
    if (metrics && typeof metrics === 'object') div.dataset.aiMetrics = JSON.stringify(metrics).slice(0, 6000);
    div.innerHTML = `${meta ? `<small>${escapeHtml(meta)}</small>` : ''}${renderAiMessageContent(text, role, rawHtml)}`;
    area.insertBefore(div, typing);
    if ((role === 'system' || role === 'trace') && div.querySelector('.ai-tool-trace')) {
        div.classList.add('ai-trace-message');
    }
    scrollAiChat();
    return storedRecord;
}
function scrollAiChat() { requestAnimationFrame(() => { const a = $('#aiChatArea'); if (a) a.scrollTo({ top: a.scrollHeight, behavior: 'smooth' }); }); }
function aiIsSessionRunning(sessionId = '') { return aiSessionRuns.has(String(sessionId || '')); }
function aiRunForSession(sessionId = '') { return aiSessionRuns.get(String(sessionId || '')) || null; }
function registerAiSessionRun(sessionId, controller) {
    const id = String(sessionId || '');
    if (!id || !controller) return;
    aiSessionRuns.set(id, controller);
    updateAiRunUiForCurrentSession();
    renderAiChatList();
}
function clearAiSessionRun(sessionId, controller = null) {
    const id = String(sessionId || '');
    if (!id) return;
    if (!controller || aiSessionRuns.get(id) === controller) aiSessionRuns.delete(id);
    updateAiRunUiForCurrentSession();
    renderAiChatList();
}
function updateAiRunUiForCurrentSession() { setAiTyping(aiIsSessionRunning(aiCurrentSessionId)); }
function aiCodeItem(id = '') { return aiCodeBlockStore.get(String(id || '')) || null; }
async function copyTextToClipboard(text = '', successMessage = t('已复制')) {
    const value = String(text || '');
    let copied = false;
    if (navigator.clipboard?.writeText && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(value);
            copied = true;
        } catch (_) {}
    }
    if (!copied) {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        try { copied = document.execCommand('copy'); } catch (_) { copied = false; }
        ta.remove();
    }
    if (!copied) throw new Error(t('浏览器拒绝剪贴板写入，请手动长按复制'));
    toast(successMessage);
}

async function aiCopyText(text = '') {
    await copyTextToClipboard(text, t('已复制'));
}
function aiDownloadTextFile(item) {
    if (!item) return;
    const blob = new Blob([item.code || ''], { type: codeMimeType(item.filename, item.lang) });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = item.filename || `snippet.${codeLangExt(item.lang)}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1200);
    toast(t('已下载 {name}', { name: a.download }));
}
function aiPreviewCode(item) {
    if (!item) return;
    if (aiCodePreviewObjectUrl) URL.revokeObjectURL(aiCodePreviewObjectUrl);
    aiCodePreviewObjectUrl = URL.createObjectURL(new Blob([item.code || ''], { type: codeMimeType(item.filename, item.lang) }));
    const state = aiBrowserPreviewStateForSession(aiCurrentSessionId);
    state.visible = true;
    $('#aiBrowserPreview')?.classList.remove('force-hidden');
    const title = $('#aiBrowserPreviewTitle'), body = $('#aiBrowserPreviewBody'), toggle = $('#aiBrowserPreviewToggleBtn');
    if (toggle) toggle.textContent = t('隐藏预览');
    if (title) title.textContent = t('代码调试沙箱 · {name}', { name: item.filename || 'snippet' });
    if (body) body.innerHTML = `<iframe class="ai-code-preview-frame" sandbox="allow-scripts allow-forms allow-modals allow-pointer-lock" src="${escapeAttr(aiCodePreviewObjectUrl)}"></iframe><small>${escapeHtml(item.filename || '')} · ${t('本地 Blob 沙箱预览')}</small>`;
    toast(t('已打开代码预览'));
}
function renderAiAttachmentChips() {
    if (!aiPendingInputAttachments.length) return '';
    return `<div class="ai-attachment-strip">${aiPendingInputAttachments.map((a, idx) => {
        const status = a.status === 'uploading' ? t('上传中') : (a.status === 'error' ? t('失败') : (a.kind === 'image' ? '🖼️' : ''));
        const title = a.error || a.name || '';
        return `<span class="ai-attachment-chip" title="${escapeAttr(title)}"><span class="ai-attachment-icon fm-button-icon" data-glyph="file" aria-hidden="true"></span><span class="ai-attachment-name">${escapeHtml(a.name || t('附件'))}</span>${status ? `<small class="ai-attachment-status">${escapeHtml(status)}</small>` : ''}<button type="button" data-ai-remove-attachment="${idx}" aria-label="${t('移除附件')}">×</button></span>`;
    }).join('')}</div>`;
}
function updateAiInputPreview() {
    const preview = $('#aiInputPreview');
    if (!preview) return;
    if (!aiPendingInputAttachments.length) { preview.hidden = true; preview.innerHTML = ''; return; }
    preview.hidden = false;
    preview.innerHTML = renderAiAttachmentChips();
}
function updateAiAttachmentDraftUi() {
    updateAiInputPreview();
}
function toggleAiMarkdownPreview() {
    const preview = $('#aiInputPreview'), btn = $('#aiMarkdownPreviewBtn');
    if (!preview) return;
    preview.hidden = !preview.hidden;
    btn?.classList.toggle('active', !preview.hidden);
    if (!preview.hidden) updateAiInputPreview();
}
function ensureAiMessageMenu() {
    let menu = $('#aiMessageContextMenu');
    if (menu) return menu;
    menu = document.createElement('div');
    menu.id = 'aiMessageContextMenu';
    menu.className = 'ai-message-menu hidden';
    menu.innerHTML = `<button type="button" data-ai-msg-action="copy"><span>⧉</span>${t('复制文本')}</button><button type="button" data-ai-msg-action="edit"><span>✎</span>${t('编辑消息')}</button><button type="button" data-ai-msg-action="regen"><span>↻</span>${t('重新回答')}</button><button type="button" data-ai-msg-action="select"><span>T</span>${t('选择文本')}</button><button type="button" data-ai-msg-action="usage"><span>◷</span>${t('查看用量')}</button>`;
    document.body.appendChild(menu);
    return menu;
}
function hideAiMessageMenu() {
    const menu = $('#aiMessageContextMenu');
    if (!menu) return;
    menu.classList.add('closing');
    window.setTimeout(() => { menu.classList.add('hidden'); menu.classList.remove('open', 'closing'); }, 120);
}
function showAiMessageMenu(messageEl, x, y) {
    if (!messageEl) return;
    const menu = ensureAiMessageMenu();
    const role = messageEl.dataset.aiMessageRole || '';
    const selection = window.getSelection?.();
    const selectedText = selection && !selection.isCollapsed && messageEl.contains(selection.anchorNode) && messageEl.contains(selection.focusNode)
        ? selection.toString()
        : '';
    aiMessageMenuState.index = Number(messageEl.dataset.aiMessageIndex || -1);
    aiMessageMenuState.sessionId = aiCurrentSessionId;
    aiMessageMenuState.text = messageEl.dataset.aiMessageText || '';
    aiMessageMenuState.selectedText = selectedText;
    aiMessageMenuState.element = messageEl;
    aiMessageMenuState.metrics = safeJsonParseClient(messageEl.dataset.aiMetrics || '{}', {});
    menu.querySelectorAll('[data-ai-msg-action="edit"],[data-ai-msg-action="regen"]').forEach((btn) => { btn.hidden = role !== 'user'; });
    menu.classList.remove('hidden', 'closing');
    const vw = window.innerWidth || document.documentElement.clientWidth || 360;
    const vh = window.innerHeight || document.documentElement.clientHeight || 640;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(vw - (rect.width || 180) - 8, x))}px`;
    menu.style.top = `${Math.max(8, Math.min(vh - (rect.height || 180) - 8, y))}px`;
    requestAnimationFrame(() => menu.classList.add('open'));
}
function selectAiMessageText(el) {
    if (!el) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
}
function syncAiEditingState() {
    const editing = aiEditingMessageIndex >= 0 && (!aiEditingSessionId || aiEditingSessionId === aiCurrentSessionId);
    const button = $('#aiCancelEditBtn');
    const area = button?.closest?.('.ai-input-area') || $('.ai-input-area');
    const input = $('#aiUserInput');
    if (button) button.hidden = !editing;
    area?.classList.toggle('is-editing', editing);
    if (input) {
        if (editing) input.setAttribute('aria-label', t('正在编辑已发送消息'));
        else input.removeAttribute('aria-label');
    }
}
function cancelAiMessageEdit({ focus = true } = {}) {
    aiEditingMessageIndex = -1;
    aiEditingSessionId = '';
    const input = $('#aiUserInput');
    if (input) {
        input.value = '';
        autoResizeAiInput(input);
    }
    updateAiInputPreview();
    syncAiEditingState();
    if (focus) input?.focus?.();
}
function editAiMessageFromMenu() {
    const input = $('#aiUserInput');
    if (!input) return;
    aiEditingMessageIndex = aiMessageMenuState.index;
    aiEditingSessionId = aiMessageMenuState.sessionId || aiCurrentSessionId;
    input.value = aiMessageMenuState.text || '';
    autoResizeAiInput(input);
    updateAiInputPreview();
    syncAiEditingState();
    input.focus?.();
    toast(t('已载入原消息，修改后发送会从此处重新回答'));
}
function regenerateAiMessageFromMenu() {
    if (aiIsSessionRunning(aiCurrentSessionId)) return toast(t('请先停止当前对话的 AI 回复'));
    const input = $('#aiUserInput');
    if (!input) return;
    aiEditingMessageIndex = aiMessageMenuState.index;
    aiEditingSessionId = aiMessageMenuState.sessionId || aiCurrentSessionId;
    input.value = aiMessageMenuState.text || '';
    autoResizeAiInput(input);
    syncAiEditingState();
    sendAiMessage();
}
function handleAiMessageMenuAction(action = '') {
    const a = String(action || '');
    if (a === 'copy') {
        const selection = window.getSelection?.();
        const selectedText = selection && !selection.isCollapsed && aiMessageMenuState.element?.contains(selection.anchorNode) && aiMessageMenuState.element?.contains(selection.focusNode)
            ? selection.toString()
            : (aiMessageMenuState.selectedText || '');
        aiCopyText(selectedText || aiMessageMenuState.text || '');
    }
    if (a === 'edit') editAiMessageFromMenu();
    if (a === 'regen') regenerateAiMessageFromMenu();
    if (a === 'select') selectAiMessageText(aiMessageMenuState.element);
    if (a === 'usage') openAiUsageSheet(aiMessageMenuState.metrics || {});
    hideAiMessageMenu();
}
function aiMessageFromEvent(event) { return event.target?.closest?.('.ai-message'); }
function handleAiMessageContextMenu(event) {
    const msg = aiMessageFromEvent(event);
    if (!msg || msg.classList.contains('ai-trace-message')) return;
    event.preventDefault();
    showAiMessageMenu(msg, event.clientX || 24, event.clientY || 24);
}
function handleAiMessageTouchStart(event) {
    const msg = aiMessageFromEvent(event);
    if (!msg || msg.classList.contains('ai-trace-message')) return;
    window.clearTimeout(aiMessageMenuState.touchTimer);
    aiMessageMenuState.touchTimer = window.setTimeout(() => {
        const t = event.touches?.[0];
        showAiMessageMenu(msg, t?.clientX || 24, t?.clientY || 24);
    }, 560);
}
function clearAiMessageTouchTimer() { window.clearTimeout(aiMessageMenuState.touchTimer); aiMessageMenuState.touchTimer = 0; }
function handleAiCodeActionClick(event) {
    const copy = event.target.closest?.('[data-ai-code-copy]');
    const download = event.target.closest?.('[data-ai-code-download]');
    const preview = event.target.closest?.('[data-ai-code-preview]');
    const id = copy?.dataset.aiCodeCopy || download?.dataset.aiCodeDownload || preview?.dataset.aiCodePreview || '';
    if (!id) return false;
    event.preventDefault(); event.stopPropagation();
    const item = aiCodeItem(id);
    if (copy) aiCopyText(item?.code || '');
    if (download) aiDownloadTextFile(item);
    if (preview) aiPreviewCode(item);
    return true;
}
function handleAiChatAreaClick(event) {
    if (handleAiCodeActionClick(event)) return;
    const button = event.target.closest?.('[data-ai-confirm-approve],[data-ai-confirm-deny]');
    if (!button || button.disabled) return;
    const approveId = button.dataset.aiConfirmApprove;
    const denyId = button.dataset.aiConfirmDeny;
    const id = approveId || denyId || '';
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    const card = button.closest('.ai-confirm-card');
    card?.querySelectorAll?.('[data-ai-confirm-approve],[data-ai-confirm-deny]').forEach((item) => { item.disabled = true; });
    resolveAiConfirmation(id, !!approveId).catch(() => {
        card?.querySelectorAll?.('[data-ai-confirm-approve],[data-ai-confirm-deny]').forEach((item) => { item.disabled = false; });
    });
}
function closeAiBrowserForSession(id) {
    const sessionId = String(id || '').trim();
    if (!sessionId) return;
    const state = aiBrowserPreviewStates.get(sessionId) || aiBrowserPreviewStateForSession(sessionId);
    const session = state?.session || `chat-${sessionId.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80)}`;
    api('/api/ai/tools/run', { method: 'POST', body: JSON.stringify({ tool: 'browser_close', args: { session }, context: collectAiContext({ sessionId }) }) }).catch(() => {});
    aiBrowserPreviewStates.delete(sessionId);
    if (sessionId === aiCurrentSessionId) renderAiBrowserPreview();
}
function deleteAiChat(id) {
    if (!id) return;
    openAiInlineConfirm({
        title: t('删除对话'),
        body: t('将从同账号的所有设备删除此对话及其消息。'),
        confirmLabel: t('删除'),
        danger: true,
        onConfirm: () => deleteAiChatConfirmed(id).catch((error) => toast(error.message || t('删除对话失败'))),
    });
}
async function deleteAiChatConfirmed(id) {
    /* Two real failure modes lived here: a session whose local revision was 0 skipped the server
     * delete entirely (so it came back on reload), and a stale local revision produced a 409. Make
     * the session canonical first (which persists a revision-0 local session and returns its real
     * revision), refresh from the server so the revision is current, then delete with that. A 404
     * means the server never had it — that is a successful delete, not an error. */
    let target = aiChatSessions.find((session) => session.id === id);
    if (target) {
        /* Refresh from the server so the revision is current. A local session that was never
         * persisted has revision 0; after loadAiChats it either has the server revision or is
         * gone (404 below is a successful delete). */
        await loadAiChats({ force: true }).catch(() => {});
        target = aiChatSessions.find((session) => session.id === id);
        const revision = Number(target?.revision) || 0;
        if (revision > 0) {
            try {
                await api(`/api/ai/history/conversations/${encodeURIComponent(id)}?expectedRevision=${encodeURIComponent(String(revision))}`, {
                    method: 'DELETE',
                });
            } catch (error) {
                /* A 409 means our revision was stale — refetch the current one and delete once more
                 * instead of failing the user. A 404 means it was already gone server-side. */
                if (error?.status === 409 || error?.code === 'revision_conflict') {
                    await loadAiChats({ force: true }).catch(() => {});
                    const fresh = aiChatSessions.find((session) => session.id === id);
                    const freshRevision = Number(fresh?.revision) || 0;
                    if (freshRevision > 0) {
                        await api(`/api/ai/history/conversations/${encodeURIComponent(id)}?expectedRevision=${encodeURIComponent(String(freshRevision))}`, {
                            method: 'DELETE',
                        });
                    }
                } else if (error?.status !== 404) {
                    throw error;
                }
            }
        }
    }
    if (aiEditingSessionId === id) cancelAiMessageEdit({ focus: false });
    const controller = aiRunForSession(id);
    if (controller) {
        aiStoppedControllers.add(controller);
        controller.abort();
        clearAiSessionRun(id, controller);
    }
    aiPendingConfirmations.forEach((pending, confirmationId) => { if (pending?.sessionId === id) aiPendingConfirmations.delete(confirmationId); });
    closeAiBrowserForSession(id);
    aiChatSessions = aiChatSessions.filter((s) => s.id !== id);
    aiCurrentSessionId = aiChatSessions[0]?.id || null;
    if (!aiChatSessions.length) createAiChat({ silent: true });
    saveAiChats();
    renderAiChat();
}
async function clearCurrentAiChat() {
    const session = aiCurrentSession();
    if (!session) return;
    if (aiIsSessionRunning(session.id)) return toast(t('请先停止当前对话的 AI 回复'));
    if (session.revision > 0) {
        await api(`/api/ai/history/conversations/${encodeURIComponent(session.id)}?expectedRevision=${encodeURIComponent(String(session.revision))}`, {
            method: 'DELETE',
        });
    }
    closeAiBrowserForSession(session.id);
    aiChatSessions = aiChatSessions.filter((item) => item.id !== session.id);
    createAiChat({ silent: true });
    renderAiChat();
}
function updateAiPanelResponsiveState() {
    const panel = $('#aiAgentPanel');
    if (!panel) return;
    const rect = panel.getBoundingClientRect?.();
    const width = Math.max(220, rect?.width || panel.offsetWidth || 0);
    const isMobile = window.innerWidth <= 760;
    const compact = isMobile || width < 680;
    const narrow = !isMobile && width < 560;
    panel.classList.toggle('ai-compact', compact);
    panel.classList.toggle('ai-narrow', narrow);
    if (isMobile) { aiSidebarCollapsedBySize = false; panel.classList.remove('sidebar-collapsed'); return; }
    if (narrow && !aiSidebarCollapsedBySize) { aiSidebarCollapsedBySize = true; panel.classList.add('sidebar-collapsed'); }
    if (!narrow && aiSidebarCollapsedBySize) { aiSidebarCollapsedBySize = false; panel.classList.remove('sidebar-collapsed'); }
}
function setAiTyping(show) {
    $('#aiTypingIndicator')?.classList.toggle('show', !!show);
    const send = $('#aiSendBtn');
    if (send) {
        send.classList.toggle('ai-stop-mode', !!show);
        send.innerHTML = show
            ? '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"></rect></svg>'
            : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>';
        send.title = show ? t('停止 AI 回复') : t('发送');
        send.setAttribute('aria-label', show ? t('停止 AI 回复') : t('发送'));
    }
    scrollAiChat();
}
function stopAiResponse(sessionId = aiCurrentSessionId) {
    const id = String(sessionId || aiCurrentSessionId || '');
    const controller = aiRunForSession(id);
    if (!controller) return false;
    aiStoppedControllers.add(controller);
    controller.abort();
    clearAiSessionRun(id, controller);
    const sess = aiChatSessions.find((s) => s.id === id);
    if (sess?.runtimeRunId) {
        api(`/api/ai/runtime/runs/${encodeURIComponent(sess.runtimeRunId)}/abort`, { method: 'POST', body: '{}' }).catch(() => {});
    }
    appendAiMessage(t('已停止 AI 回复/操作。'), 'system', { sessionId: id });
    return true;
}

function aiIntensityOptions() {
    const value = $('#aiThinkIntensity')?.value || '';
    if (!value) return {};
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    const provider = (ai.providers || []).find((p) => p.id === $('#aiProviderSelect')?.value) || {};
    const model = $('#aiModelSelect')?.value || provider.defaultModel || '';
    const kind = aiProviderKind(provider);
    if (kind === 'gemini') {
        if (/^-?\d+$/.test(value)) return { thinkingConfig: { thinkingBudget: Number(value) } };
        return { thinkingConfig: { thinkingLevel: value } };
    }
    const raw = kind === 'anthropic' ? { effort: value } : { reasoning_effort: value };
    return globalThis.ZephyrThinkingPolicy?.sanitizeThinkingOptions?.(provider, model, raw) || raw;
}
function uniq(list = []) { return Array.from(new Set(list.map((x) => String(x || '').trim()).filter(Boolean))); }
function collectAiContext(options = {}) {
    const contextSession = options.sessionId ? aiChatSessions.find((s) => s.id === options.sessionId) : aiCurrentSession();
    const active = terminalTabs.find((t) => t.id === activeTerminalTab);
    const ordered = [active, ...terminalTabs.filter((t) => t && t.id !== activeTerminalTab)].filter(Boolean);
    const activeConnectionIds = uniq(ordered.map((t) => t.connectionId));
    const contextConnections = activeConnectionIds.map((id) => connections.find((c) => String(c.id) === String(id))).filter(Boolean).map((c) => ({ id: c.id, name: c.name, protocol: c.protocol, host: c.host, port: c.port, username: c.username, tags: Array.isArray(c.tags) ? c.tags : splitCsv(c.tags), remark: c.remark || '' }));
    const tags = uniq(contextConnections.flatMap((c) => c.tags || []));
    const view = document.querySelector('.nav-tab.active')?.dataset.view || '';
    const terminalOutputs = collectAiTerminalOutputs();
    const remoteDesktopSnapshots = collectAiRemoteDesktopSnapshots({ includeImage: !!options.includeRemoteDesktopImages });
    const activeTerminal = terminalOutputs.find((item) => item.tabId === activeTerminalTab) || terminalOutputs[0] || null;
    const activeTabProtocol = String(active?.protocol || '').toUpperCase();
    const activeTabIsRemoteDesktop = ['RDP', 'VNC'].includes(activeTabProtocol);
    const activeRemoteDesktop = remoteDesktopSnapshots.find((item) => item.tabId === activeTerminalTab)
        || remoteDesktopSnapshots.find((item) => ['RDP', 'VNC'].includes(String(item.protocol || '').toUpperCase()))
        || (activeTabIsRemoteDesktop ? {
            tabId: active?.id || activeTerminalTab || '',
            protocol: activeTabProtocol,
            connectionId: active?.connectionId || '',
            status: active?.status || '',
            connected: active?.status === 'connected',
            pending: true,
        } : null);
    const activeSurface = activeRemoteDesktop
        ? { kind: 'remote-desktop', protocol: activeRemoteDesktop.protocol || active?.protocol || '', tabId: activeRemoteDesktop.tabId || activeTerminalTab || '', connectionId: activeRemoteDesktop.connectionId || active?.connectionId || '' }
        : activeTerminal
            ? { kind: 'terminal', protocol: activeTerminal.protocol || active?.protocol || '', tabId: activeTerminal.tabId || activeTerminalTab || '', sessionId: activeTerminal.sessionId || activeTerminalTab || '', connectionId: activeTerminal.connectionId || active?.connectionId || '' }
            : { kind: String(view || 'workspace'), protocol: '', tabId: '', connectionId: '' };
    return {
        locale: getLocale(),
        view,
        aiChatSessionId: contextSession?.id || '',
        runtimeSessionId: contextSession?.runtimeSessionId || '',
        activeChatTitle: contextSession?.title || '',
        activeSurface,
        activeRemoteDesktopTabId: activeRemoteDesktop?.tabId || '',
        activeRemoteDesktopProtocol: activeRemoteDesktop?.protocol || '',
        activeTerminalTab,
        activeTerminalSessionId: activeTerminal?.sessionId || activeTerminalTab || '',
        activeTerminalConnectionId: activeTerminal?.connectionId || active?.connectionId || '',
        activeTerminalProtocol: activeTerminal?.protocol || active?.protocol || '',
        terminalSessions: terminalOutputs.map((item) => ({
            sessionId: item.sessionId || item.tabId || '',
            tabId: item.tabId || '',
            connectionId: item.connectionId || '',
            name: item.name || '',
            protocol: item.protocol || '',
            status: item.status || '',
            available: item.available !== false,
        })),
        activeConnectionIds,
        connections: contextConnections,
        tags,
        terminalOutputs,
        remoteDesktopSnapshots,
    };
}
function aiBrowserPreviewStateForSession(sessionId = aiCurrentSessionId) {
    const key = String(sessionId || 'default');
    const safe = key.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80);
    if (!aiBrowserPreviewStates.has(key)) aiBrowserPreviewStates.set(key, { session: safe && safe !== 'default' ? `chat-${safe}` : 'default', preview: null, visible: false });
    return aiBrowserPreviewStates.get(key);
}
function browserShotFromResult(result = {}) {
    if (!result || typeof result !== 'object') return null;
    const data = result?.ok === true && result?.data && typeof result.data === 'object' ? result.data : result;
    if (data.preview?.url) return data.preview;
    if (data.url && /\/api\/ai\/browser\/screenshots\//.test(data.url)) return data;
    return null;
}
function updateAiBrowserPreviewFromToolResult(item = {}, { sessionId = aiCurrentSessionId } = {}) {
    if (!String(item.tool || '').startsWith('browser_')) return;
    const resultData = item.result?.ok === true && item.result?.data && typeof item.result.data === 'object' ? item.result.data : (item.result || {});
    const shot = browserShotFromResult(resultData);
    if (shot) {
        const state = aiBrowserPreviewStateForSession(sessionId);
        state.preview = { ...shot, tool: item.tool, updatedAt: Date.now(), pageUrl: resultData.url || resultData.pageUrl || '' };
        state.session = resultData.session || item.args?.session || state.session || (sessionId ? `chat-${sessionId}` : 'default');
        state.visible = true;
        if (sessionId === aiCurrentSessionId) renderAiBrowserPreview();
    }
}
function renderAiBrowserPreview() {
    const box = $('#aiBrowserPreview'), body = $('#aiBrowserPreviewBody'), title = $('#aiBrowserPreviewTitle'), toggle = $('#aiBrowserPreviewToggleBtn');
    if (!box || !body) return;
    const state = aiBrowserPreviewStateForSession(aiCurrentSessionId);
    box.classList.toggle('force-hidden', !state.visible);
    if (toggle) toggle.textContent = state.visible ? t('隐藏预览') : t('浏览器预览');
    const shot = state.preview;
    if (!shot?.url) {
        title && (title.textContent = t('AI 代操作页面'));
        body.innerHTML = `<span>${t('AI 打开网页后，会在这里持续显示它正在代操作的页面。')}</span>`;
        return;
    }
    title && (title.textContent = t('AI 代操作页面 · {tool} · {session} · {time}', { tool: shot.tool || 'browser', session: state.session || 'default', time: new Date(shot.updatedAt || Date.now()).toLocaleTimeString() }));
    body.innerHTML = `<a href="${escapeHtml(shot.url)}" target="_blank" rel="noopener"><img src="${escapeHtml(shot.url)}" alt="${escapeHtml(t('浏览器截图'))}"></a>${shot.pageUrl ? `<small>${escapeHtml(shot.pageUrl)}</small>` : ''}`;
}
async function refreshAiBrowserPreview() {
    if (aiBrowserPreviewTimer) return;
    aiBrowserPreviewTimer = window.setTimeout(() => { aiBrowserPreviewTimer = 0; }, 800);
    try {
        const state = aiBrowserPreviewStateForSession(aiCurrentSessionId);
        const data = await api('/api/ai/tools/run', { method: 'POST', body: JSON.stringify({ tool: 'browser_screenshot', args: { session: state.session || 'default' }, context: collectAiContext({ sessionId: aiCurrentSessionId }) }) });
        state.preview = { ...(data.result || {}), tool: 'browser_screenshot', updatedAt: Date.now() };
        state.visible = true;
        renderAiBrowserPreview();
    } catch (err) { toast(err.message || t('刷新浏览器截图失败')); }
}
function mergeAiPlan(plan) {
    if (!plan?.id) return;
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    const idx = ai.plans.findIndex((p) => p.id === plan.id);
    if (idx >= 0) ai.plans[idx] = plan; else ai.plans.unshift(plan);
    settings.ai = ai; aiSettingsState = ai; renderAiPlanList();
}
function mergeAiMemory(memory) {
    if (!memory?.id) return;
    const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
    const idx = ai.memories.findIndex((m) => m.id === memory.id);
    if (idx >= 0) ai.memories[idx] = memory; else ai.memories.unshift(memory);
    settings.ai = ai; aiSettingsState = ai; renderAiMemoryList();
}
function currentOrRequestedTerminalTab(tabId = '') {
    const requested = String(tabId || '').trim();
    if (requested && terminalTabs.some((t) => t.id === requested)) return requested;
    if (activeTerminalTab && terminalTabs.some((t) => t.id === activeTerminalTab)) return activeTerminalTab;
    return terminalTabs.find((t) => !t.minimized)?.id || terminalTabs[0]?.id || '';
}
function terminalFrameByIdForAi(tabId = '') {
    const id = String(tabId || '').trim();
    return id ? document.querySelector(`#terminalWorkspace .terminal-frame[data-frame="${CSS.escape(id)}"]`) : null;
}
function nativeRemoteDesktopBridge(frame) {
    const bridge = frame?.__zephyrNativeRdpBridge;
    return bridge && typeof bridge.snapshot === 'function' && typeof bridge.action === 'function'
        ? bridge : null;
}
function terminalFrameForAi(tabId = '') {
    const id = currentOrRequestedTerminalTab(tabId);
    return terminalFrameByIdForAi(id);
}
function clipAiTerminalText(text = '', maxChars = 24000) {
    const max = Math.max(1000, Math.min(60000, Number(maxChars) || 24000));
    const value = String(text || '').replace(/[\s\n]+$/g, '');
    return value.length > max ? `[前面已截断 ${value.length - max} 字符]\n${value.slice(-max)}` : value;
}
function readTerminalOutputForAi(tabId = '', maxChars = 24000) {
    const id = currentOrRequestedTerminalTab(tabId);
    const tab = terminalTabs.find((t) => t.id === id) || null;
    const conn = tab?.connectionId ? connections.find((c) => String(c.id) === String(tab.connectionId)) : null;
    const frame = terminalFrameByIdForAi(id);
    let snapshot = null;
    try { snapshot = frame?.contentWindow?.__zephyrGetTerminalOutput?.({ maxChars }); } catch (err) { snapshot = { error: err.message || String(err) }; }
    const protocol = String(tab?.protocol || conn?.protocol || '').toUpperCase();
    return {
        tabId: id,
        sessionId: snapshot?.sessionId || tab?.sessionId || id,
        name: tab?.name || conn?.name || '',
        protocol,
        connectionId: tab?.connectionId || conn?.id || '',
        host: snapshot?.host || conn?.host || '',
        port: snapshot?.port || conn?.port || '',
        username: snapshot?.username || conn?.username || '',
        status: snapshot?.status || tab?.status || '',
        available: Boolean(snapshot && !snapshot.error && (snapshot.text || snapshot.currentInput || ['SSH', 'TELNET'].includes(protocol))),
        error: snapshot?.error || (!frame ? '终端 iframe 未加载或已被最小化释放' : ''),
        text: clipAiTerminalText(snapshot?.text || '', maxChars),
        currentInput: snapshot?.currentInput || '',
        lineCount: snapshot?.lineCount || 0,
        originalLength: snapshot?.originalLength || 0,
        truncated: !!snapshot?.truncated,
        cols: snapshot?.cols || 0,
        rows: snapshot?.rows || 0,
        scrollbackCount: snapshot?.scrollbackCount || 0,
        at: snapshot?.at || Date.now(),
    };
}
function collectAiTerminalOutputs() {
    const ids = uniq([activeTerminalTab, ...visualLayout, ...terminalTabs.filter((t) => !t.minimized).map((t) => t.id), ...terminalTabs.map((t) => t.id)]).slice(0, 4);
    return ids.map((id, index) => readTerminalOutputForAi(id, index === 0 ? 60000 : 16000))
        .filter((item) => ['SSH', 'TELNET'].includes(item.protocol) && (item.available || item.text || item.currentInput))
        .slice(0, 3);
}
function readRemoteDesktopSnapshotForAi(tabId = '', maxWidth = 960) {
    const id = currentOrRequestedTerminalTab(tabId);
    const tab = terminalTabs.find((t) => t.id === id) || null;
    const protocol = String(tab?.protocol || '').toUpperCase();
    if (!['RDP', 'VNC'].includes(protocol)) return null;
    const conn = tab?.connectionId ? connections.find((c) => String(c.id) === String(tab.connectionId)) : null;
    const frame = terminalFrameByIdForAi(id);
    let shot = null;
    try {
        const nativeBridge = nativeRemoteDesktopBridge(frame);
        shot = nativeBridge
            ? nativeBridge.snapshot({ maxWidth })
            : frame?.contentWindow?.__zephyrGetRemoteDesktopSnapshot?.({ maxWidth });
        if (shot && typeof shot.then === 'function') return {
            pending: true,
            promise: shot,
            tabId: id,
            name: tab?.name || conn?.name || '',
            protocol,
            connectionId: tab?.connectionId || conn?.id || '',
            host: conn?.host || '',
            port: conn?.port || '',
            status: tab?.status || '',
            connected: tab?.status === 'connected',
            error: '',
        };
    } catch (err) { shot = { error: err.message || String(err) }; }
    if (shot?.dataUrl && shot.dataUrl.length > 6000000 && Number(maxWidth) > 520) {
        try {
            const smallerWidth = Math.max(420, Math.round(Number(maxWidth) * 0.62));
            const smaller = frame?.contentWindow?.__zephyrGetRemoteDesktopSnapshot?.({ maxWidth: smallerWidth, quality: 0.58 });
            if (smaller?.dataUrl && smaller.dataUrl.length < shot.dataUrl.length) shot = smaller;
        } catch (_) {}
    }
    const frameAt = Number(shot?.frameAt || shot?.at || Date.now());
    const captureId = shot?.captureId || [id || 'remote', frameAt, shot?.width || 0, shot?.height || 0].map((part) => String(part || 0).replace(/[^A-Za-z0-9_.-]/g, '_')).join(':');
    let certDialog = shot?.certDialog || null;
    if (!certDialog) {
        try { certDialog = frame?.contentWindow?.__zephyrGetRemoteDesktopCertState?.() || null; } catch (_) { certDialog = null; }
    }
    return {
        tabId: id,
        name: tab?.name || conn?.name || '',
        protocol,
        connectionId: tab?.connectionId || conn?.id || '',
        host: shot?.host || conn?.host || '',
        port: shot?.port || conn?.port || '',
        status: shot?.status || tab?.status || '',
        title: shot?.title || tab?.name || conn?.name || '',
        connected: !!shot?.connected,
        connectionPhase: shot?.connectionPhase || certDialog?.connectionPhase || (shot?.connected ? 'connected' : ''),
        certPhase: shot?.certPhase || certDialog?.certPhase || 'none',
        certDialog,
        dataUrl: shot?.dataUrl || '',
        width: shot?.width || 0,
        height: shot?.height || 0,
        originalWidth: shot?.originalWidth || 0,
        originalHeight: shot?.originalHeight || 0,
        error: shot?.error || (!frame ? t('远程桌面 iframe 未加载或已被最小化释放') : ''),
        frameAt,
        captureId,
        at: shot?.at || Date.now(),
    };
}
function collectAiRemoteDesktopSnapshots({ includeImage = false } = {}) {
    const ids = uniq([activeTerminalTab, ...visualLayout, ...terminalTabs.filter((t) => !t.minimized).map((t) => t.id), ...terminalTabs.map((t) => t.id)]).slice(0, includeImage ? 3 : 5);
    const list = ids.map((id, index) => includeImage ? readRemoteDesktopSnapshotForAi(id, index === 0 ? 960 : 720) : readRemoteDesktopSnapshotForAi(id, 360))
        .filter((item) => item && ['RDP', 'VNC'].includes(item.protocol) && (item.dataUrl || item.error || item.connected || item.pending))
        .slice(0, includeImage ? 1 : 2);
    if (includeImage) return list;
    return list.map(({ dataUrl, ...item }) => ({ ...item, hasScreenshot: !!dataUrl, dataUrlLength: dataUrl ? dataUrl.length : 0 }));
}
function currentOrRequestedRemoteDesktopTab(tabId = '') {
    const requested = String(tabId || '').trim();
    const isRemote = (t) => ['RDP', 'VNC'].includes(String(t?.protocol || '').toUpperCase());
    if (requested && terminalTabs.some((t) => t.id === requested && isRemote(t))) return requested;
    const active = terminalTabs.find((t) => t.id === activeTerminalTab && isRemote(t));
    if (active) return active.id;
    return terminalTabs.find((t) => !t.minimized && isRemote(t))?.id || terminalTabs.find(isRemote)?.id || '';
}
function publicAiRemoteDesktopAction(action = {}) {
    return {
        source: 'zephyr-app',
        type: 'ai-remote-desktop-action',
        actionId: action.actionId || '',
        captureId: action.captureId || '',
        frameAt: Number(action.frameAt || 0),
        control: action.desktopControl || action.control || '',
        qualityMode: action.qualityMode || '',
        fitMode: action.fitMode || '',
        zoomPercent: action.zoomPercent,
        sequence: action.sequence || '',
        text: action.text || '',
        paste: action.paste !== false,
        x: action.x,
        y: action.y,
        button: action.button || 1,
        coordinateSpace: action.coordinateSpace || '',
        screenshotX: action.screenshotX,
        screenshotY: action.screenshotY,
        screenshotWidth: action.screenshotWidth,
        screenshotHeight: action.screenshotHeight,
        originalWidth: action.originalWidth,
        originalHeight: action.originalHeight,
    };
}
function normalizeAiRemoteDesktopMouseAction(action = {}, tabId = '') {
    if (String(action.action || '') !== 'remote_desktop_mouse') return action;
    const x = Number(action.x);
    const y = Number(action.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return action;
    // The server already attached the dimensions of the validated capture.
    // Do not take a new live snapshot just to scale coordinates: animated
    // desktops advance frameAt continuously and this used to create stale loops.
    const screenshotWidth = Number(action.screenshotWidth || 0);
    const screenshotHeight = Number(action.screenshotHeight || 0);
    const remoteWidth = Number(action.originalWidth || screenshotWidth || 0);
    const remoteHeight = Number(action.originalHeight || screenshotHeight || 0);
    const coordinateSpace = String(action.coordinateSpace || action.coords || 'screenshot').toLowerCase();
    const shouldScale = coordinateSpace !== 'remote'
        && screenshotWidth > 0 && screenshotHeight > 0 && remoteWidth > 0 && remoteHeight > 0
        && (Math.abs(remoteWidth - screenshotWidth) > 1 || Math.abs(remoteHeight - screenshotHeight) > 1)
        && x >= 0 && y >= 0 && x <= screenshotWidth + 2 && y <= screenshotHeight + 2;
    if (!shouldScale) return { ...action, coordinateSpace: coordinateSpace || 'remote' };
    return {
        ...action,
        x: Math.round(x * remoteWidth / screenshotWidth),
        y: Math.round(y * remoteHeight / screenshotHeight),
        screenshotX: x,
        screenshotY: y,
        screenshotWidth,
        screenshotHeight,
        coordinateSpace: 'screenshot_scaled_to_remote',
    };
}
function delayMs(ms = 0) { return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, Number(ms) || 0))); }
async function waitForFreshRemoteDesktopSnapshot(tabId = '', { maxWidth = 640, afterFrameAt = 0, timeoutMs = 1800 } = {}) {
    const deadline = Date.now() + Math.max(300, Number(timeoutMs) || 1800);
    let shot = null;
    while (Date.now() < deadline) {
        shot = readRemoteDesktopSnapshotForAi(tabId, maxWidth);
        if (shot?.pending && shot.promise) {
            const raw = await shot.promise.catch((err) => ({ error: err.message || String(err) }));
            const frameAtValue = Number(raw?.frameAt || raw?.at || Date.now());
            const captureIdValue = raw?.captureId || [shot.tabId || 'remote', frameAtValue, raw?.width || 0, raw?.height || 0].map((part) => String(part || 0).replace(/[^A-Za-z0-9_.-]/g, '_')).join(':');
            shot = { ...raw, tabId: raw?.tabId || shot.tabId || '', protocol: raw?.protocol || shot.protocol || '', connectionId: raw?.connectionId || shot.connectionId || '', frameAt: frameAtValue, captureId: captureIdValue };
        }
        const frameAt = Number(shot?.frameAt || shot?.at || 0);
        if (shot?.dataUrl && (!afterFrameAt || frameAt > afterFrameAt)) return shot;
        await delayMs(180);
    }
    if (shot) return shot;
    const fallback = readRemoteDesktopSnapshotForAi(tabId, maxWidth);
    if (fallback?.pending && fallback.promise) return fallback.promise.catch((err) => ({ error: err.message || String(err) }));
    return fallback;
}
function waitForAiRemoteDesktopActionAck(actionId, timeoutMs = 3200) {
    if (!actionId) return Promise.resolve(null);
    return new Promise((resolve) => {
        const timer = window.setTimeout(() => {
            aiRemoteDesktopActionWaiters.delete(actionId);
            resolve({ ok: false, timeout: true, error: '远程桌面没有返回操作结果，可能 iframe 未收到操作或脚本未更新' });
        }, Math.max(800, Number(timeoutMs) || 3200));
        aiRemoteDesktopActionWaiters.set(actionId, (payload = {}) => {
            window.clearTimeout(timer);
            aiRemoteDesktopActionWaiters.delete(actionId);
            resolve(payload);
        });
    });
}
async function readTerminalOutputAfterAiAction(action = {}) {
    const waitMs = action.run === false ? 120 : 1200;
    await delayMs(waitMs);
    return readTerminalOutputForAi(action.tabId || '', 30000);
}
function clickSettingsSection(section = '') {
    const key = String(section || '').toLowerCase();
    if (!key) return;
    if (['security', 'data'].includes(key)) throw new Error(t('AI 不允许代操作安全/数据管理设置页'));
    const btn = document.querySelector(`.settings-tab[data-settings="${CSS.escape(key)}"]`);
    if (btn) btn.click();
}
function waitForTerminalFrameReady(frame, timeoutMs = 1800) {
    if (nativeRemoteDesktopBridge(frame)) return Promise.resolve(frame);
    if (!frame) return Promise.reject(new Error(t('当前终端页面还没准备好')));
    try {
        const doc = frame.contentDocument;
        if (doc && doc.readyState !== 'loading') return Promise.resolve(frame);
    } catch (_) {}
    return new Promise((resolve) => {
        let done = false;
        const finish = () => { if (done) return; done = true; frame.removeEventListener('load', finish); resolve(frame); };
        frame.addEventListener('load', finish, { once: true });
        window.setTimeout(finish, timeoutMs);
    });
}
async function performAiUiAction(action = {}) {
    const a = String(action.action || '');
    if (!a) return;
    if (a === 'switch_view') {
        const view = ['dashboard', 'terminal', 'remote', 'settings'].includes(action.view) ? action.view : 'dashboard';
        switchView(view);
        if (view === 'settings') clickSettingsSection(action.settingsSection || 'ai');
        toast(t('AI 已切换到{view}', { view }));
        return;
    }
    if (a === 'open_add_connection') { switchView('dashboard'); openModal(null, $('#addConnectionBtn')); return; }
    if (a === 'open_edit_connection') {
        switchView('dashboard');
        const conn = connections.find((c) => c.id === String(action.connectionId || ''));
        if (!conn) throw new Error(t('连接不存在或尚未刷新'));
        openModal(conn, document.querySelector(`[data-edit="${CSS.escape(conn.id)}"]`) || $('#addConnectionBtn'));
        return;
    }
    if (a === 'terminal_fullscreen') { const id = currentOrRequestedTerminalTab(action.tabId); if (!id) throw new Error(t('暂无终端会话')); fullscreenTerminalTab(id).catch((err) => toast(err.message)); return; }
    if (a === 'terminal_exit_fullscreen') { exitTerminalFullscreen(); return; }
    if (a === 'terminal_window_action') { const id = currentOrRequestedTerminalTab(action.tabId); if (!id) throw new Error(t('暂无终端会话')); applyTerminalWindowPreset(id, action.windowAction || 'fullscreen'); return; }
    if (a === 'terminal_toolbar') {
        switchView('terminal');
        const frame = await waitForTerminalFrameReady(terminalFrameForAi(action.tabId));
        if (!frame?.contentWindow) throw new Error(t('当前终端页面还没准备好'));
        frame.contentWindow.postMessage({ source: 'zephyr-app', type: 'ai-terminal-toolbar', control: action.control || '' }, '*');
        return;
    }
    if (a === 'terminal_send_input') {
        switchView('terminal');
        const id = currentOrRequestedTerminalTab(action.tabId);
        const frame = await waitForTerminalFrameReady(terminalFrameByIdForAi(id));
        if (!frame?.contentWindow) throw new Error(t('当前终端页面还没准备好'));
        frame.contentWindow.postMessage({ source: 'zephyr-app', type: 'ai-terminal-send-input', text: action.text || '', run: action.run !== false }, '*');
        return { terminalOutput: await readTerminalOutputAfterAiAction({ ...action, tabId: id }) };
    }
    if (a === 'terminal_read_output') {
        switchView('terminal');
        const id = currentOrRequestedTerminalTab(action.tabId);
        await waitForTerminalFrameReady(terminalFrameByIdForAi(id));
        return { terminalOutput: readTerminalOutputForAi(id, action.maxChars || 30000) };
    }
    if (a === 'remote_desktop_toolbar' || a === 'remote_desktop_send_text' || a === 'remote_desktop_mouse') {
        switchView('terminal');
        const id = currentOrRequestedRemoteDesktopTab(action.tabId);
        if (!id) throw new Error(t('暂无 RDP/VNC 远程桌面会话'));
        const frame = await waitForTerminalFrameReady(terminalFrameByIdForAi(id));
        const nativeBridge = nativeRemoteDesktopBridge(frame);
        if (!nativeBridge && !frame?.contentWindow) throw new Error(t('当前远程桌面页面还没准备好'));
        const actionId = `rdp-${Date.now().toString(36)}-${++aiRemoteDesktopActionSeq}`;
        const actionForMessage = normalizeAiRemoteDesktopMouseAction(action, id);
        const msg = publicAiRemoteDesktopAction({
            ...actionForMessage,
            actionId,
            desktopControl: actionForMessage.desktopControl || actionForMessage.control || (a === 'remote_desktop_send_text' ? 'text' : a === 'remote_desktop_mouse' ? 'mouse_click' : ''),
        });
        const beforeFrameAt = Number(action.frameAt || 0);
        let ack;
        if (nativeBridge) {
            // The shell validates and consumes captureId before dispatching
            // input into the owner-bound FreeRDP session.
            ack = await nativeBridge.action(msg);
        } else {
            const ackPromise = waitForAiRemoteDesktopActionAck(actionId, action.ackTimeoutMs || 5200);
            frame.contentWindow.postMessage(msg, '*');
            ack = await ackPromise;
        }
        await delayMs(action.waitMs ?? 2000);
        const remoteDesktopScreenshot = await waitForFreshRemoteDesktopSnapshot(id, { maxWidth: action.maxWidth || 640, afterFrameAt: beforeFrameAt, timeoutMs: action.freshTimeoutMs || 2600 });
        const result = { remoteDesktopAction: ack || { ok: false, timeout: true }, remoteDesktopScreenshot, actionId, beforeCaptureId: action.captureId || '', afterCaptureId: remoteDesktopScreenshot?.captureId || '' };
        result.captureChanged = !!result.beforeCaptureId && !!result.afterCaptureId && result.beforeCaptureId !== result.afterCaptureId;
        if (ack && ack.ok === false) result.clientError = ack.error || t('AI 远程桌面操作失败');
        return result;
    }
    if (a === 'remote_desktop_cert_status') {
        switchView('terminal');
        const id = currentOrRequestedRemoteDesktopTab(action.tabId);
        if (!id) throw new Error(t('暂无 RDP/VNC 远程桌面会话'));
        const frame = await waitForTerminalFrameReady(terminalFrameByIdForAi(id));
        if (!frame?.contentWindow) throw new Error(t('当前远程桌面页面还没准备好'));
        const actionId = `rdp-cert-${Date.now().toString(36)}-${++aiRemoteDesktopActionSeq}`;
        const ackPromise = waitForAiRemoteDesktopActionAck(actionId, action.ackTimeoutMs || 3200);
        frame.contentWindow.postMessage({
            source: 'zephyr-app',
            type: 'ai-remote-desktop-cert-status',
            actionId,
            tabId: id,
            connectionId: action.connectionId || '',
        }, '*');
        const ack = await ackPromise;
        let cert = ack?.cert || ack?.result?.cert || null;
        if (!cert) {
            try { cert = frame.contentWindow.__zephyrGetRemoteDesktopCertState?.() || null; } catch (_) {}
        }
        if (!cert) {
            const shot = readRemoteDesktopSnapshotForAi(id, 360);
            cert = shot?.certDialog || null;
        }
        const result = { cert, remoteDesktopAction: ack || { ok: false, timeout: true }, actionId, clientCaptured: true, vision: false };
        if (ack && ack.ok === false) result.clientError = ack.error || t('读取 RDP 证书状态失败');
        return result;
    }
    if (a === 'remote_desktop_cert_decide') {
        switchView('terminal');
        const id = currentOrRequestedRemoteDesktopTab(action.tabId);
        if (!id) throw new Error(t('暂无 RDP/VNC 远程桌面会话'));
        const frame = await waitForTerminalFrameReady(terminalFrameByIdForAi(id));
        if (!frame?.contentWindow) throw new Error(t('当前远程桌面页面还没准备好'));
        const actionId = `rdp-cert-${Date.now().toString(36)}-${++aiRemoteDesktopActionSeq}`;
        const decision = String(action.decision || '') === 'reject' ? 'reject' : 'accept';
        const ackPromise = waitForAiRemoteDesktopActionAck(actionId, action.ackTimeoutMs || 5200);
        frame.contentWindow.postMessage({
            source: 'zephyr-app',
            type: 'ai-remote-desktop-cert-decide',
            actionId,
            tabId: id,
            decision,
            remember: action.remember === true,
            connectionId: action.connectionId || '',
            expectedFingerprint: action.expectedFingerprint || '',
        }, '*');
        const ack = await ackPromise;
        if (decision === 'accept') await delayMs(action.waitMs ?? 1200);
        let cert = ack?.cert || ack?.result?.cert || null;
        if (!cert) {
            try { cert = frame.contentWindow.__zephyrGetRemoteDesktopCertState?.() || null; } catch (_) {}
        }
        const shot = readRemoteDesktopSnapshotForAi(id, 360);
        const result = {
            decided: !(ack && ack.ok === false),
            decision,
            remember: action.remember === true,
            cert: cert || shot?.certDialog || null,
            remoteDesktopAction: ack || { ok: false, timeout: true },
            remoteDesktopScreenshot: shot,
            actionId,
            clientCaptured: true,
            vision: false,
        };
        if (ack && ack.ok === false) result.clientError = ack.error || t('AI 证书决策失败');
        return result;
    }
    if (a === 'toast') { toast(action.text || t('AI 已执行操作')); return; }
    throw new Error(t('未知 UI 动作：{action}', { action: a }));
}
async function handleAiClientCapture(data = {}, { providerId = '', model = '', options = {}, signal = null, original = '', depth = 0, sessionId = '' } = {}) {
    // Legacy Chat must never embed data:image into message content. Remote-desktop
    // vision is Runtime-only (capture-image → Go Parts). Certificate dialog tools are
    // HTML-layer and return structured cert state without framebuffer images.
    const targetSessionId = sessionId || aiCurrentSessionId;
    if (!data?.clientCaptureRequired || !data.clientCapture) return false;
    const capture = data.clientCapture || {};
    const captureType = String(capture.type || data.tool || '');
    if (captureType.includes('remote_desktop_cert_') || capture.vision === false || String(capture.action?.action || '').startsWith('remote_desktop_cert_')) {
        const action = capture.action || {
            action: captureType.includes('cert_decide') ? 'remote_desktop_cert_decide' : 'remote_desktop_cert_status',
            tabId: capture.tabId || '',
            decision: capture.decision || 'accept',
            remember: capture.remember === true,
            connectionId: capture.connectionId || '',
            expectedFingerprint: capture.expectedFingerprint || '',
        };
        const actionResult = await performAiUiAction(action);
        const toolResults = [{
            tool: captureType || 'remote_desktop_cert_status_v1',
            args: capture,
            result: { ok: true, data: { ...(actionResult || {}), clientCaptured: true, vision: false } },
        }];
        await syncAiToolSideEffects(toolResults, { sessionId: targetSessionId });
        appendAiMessage(toolResults.map(formatAiToolResult).join(''), 'trace', { rawHtml: true, sessionId: targetSessionId });
        return true;
    }
    const context = collectAiContext({ includeRemoteDesktopImages: false, sessionId: targetSessionId });
    if (context?.activeSurface?.kind === 'remote-desktop') {
        appendAiMessage(t('RDP/VNC AI 视觉操作需要 Go Runtime'), 'system', { sessionId: targetSessionId });
        throw new Error(t('RDP/VNC AI 视觉操作需要 Go Runtime'));
    }
    appendAiMessage(t('远程桌面截图 followup 已禁用 Legacy 路径，请启用 Go Runtime'), 'system', { sessionId: targetSessionId });
    throw new Error(t('远程桌面截图 followup 已禁用 Legacy 路径，请启用 Go Runtime'));
}
async function syncAiToolSideEffects(toolResults = [], { sessionId = '' } = {}) {
    for (const r of toolResults) {
        updateAiBrowserPreviewFromToolResult(r, { sessionId });
        const toolData = r.result?.ok === true && r.result?.data && typeof r.result.data === 'object' ? r.result.data : r.result;
        if ((toolData?.uiAction === 'open_connection' || r.tool === 'connection_open_v1') && toolData?.connectionId) {
            try {
                const openedTabId = await openConnection(toolData.connectionId);
                if (openedTabId) toolData.openedTabId = openedTabId;
                const protocol = String(toolData?.connection?.protocol || '').toUpperCase();
                if (['RDP', 'VNC'].includes(protocol)) toolData.remoteDesktopScreenshot = await waitForFreshRemoteDesktopSnapshot(openedTabId, { maxWidth: 640, timeoutMs: 5200 });
            } catch (err) { toast(err.message || t('AI 打开连接失败')); }
        }
        if (toolData?.clientActionRequired && toolData?.clientAction && !toolData?.clientCaptureRequired) {
            try {
                const clientResult = await performAiUiAction(toolData.clientAction);
                if (clientResult && typeof clientResult === 'object') Object.assign(toolData, clientResult);
            } catch (err) { toast(err.message || t('AI 远程桌面操作失败')); toolData.clientError = err.message || t('AI 远程桌面操作失败'); }
        }
        if (toolData?.uiAction === 'ui_action' && toolData?.action) {
            try {
                const clientResult = await performAiUiAction(toolData.action);
                if (clientResult && typeof clientResult === 'object') Object.assign(toolData, clientResult);
            } catch (err) { toast(err.message || t('AI UI 操作失败')); toolData.clientError = err.message || t('AI UI 操作失败'); }
        }
        if (r.tool === 'plan_task' || r.tool === 'plan_update') mergeAiPlan(r.result?.plan);
        if (r.tool === 'memory_save') mergeAiMemory(r.result?.memory);
        if (/^(connection_|proxy_|ssh_key_|jump_host_)/.test(String(r.tool || ''))) {
            await Promise.all([loadConnections().catch(() => {}), loadNetwork().catch(() => {})]);
        }
        if (/^snippet_/.test(String(r.tool || ''))) {
            const snippets = toolData?.snippets || toolData?.resources?.snippets;
            if (Array.isArray(snippets)) { settings.snippets = normalizeSnippets(snippets); renderSnippetSettings(); }
            else await loadSettings().then(() => renderSnippetSettings()).catch(() => {});
        }
    }
}
async function waitForRemoteDesktopSnapshotForAi(tabId = '', maxWidth = 960, timeoutMs = 3600) {
    const deadline = Date.now() + Math.max(800, Number(timeoutMs) || 3600);
    let last = null;
    while (Date.now() < deadline) {
        last = readRemoteDesktopSnapshotForAi(tabId, maxWidth);
        if (last?.dataUrl || (last?.connected && (last.width || last.originalWidth))) return last;
        await delayMs(650);
    }
    return last || readRemoteDesktopSnapshotForAi(tabId, maxWidth);
}
function needsRemoteDesktopClientFollowup(toolResults = []) {
    return (Array.isArray(toolResults) ? toolResults : []).some((r) => {
        const protocol = String(r.result?.connection?.protocol || r.result?.remoteDesktopScreenshot?.protocol || '').toUpperCase();
        const toolData = r.result?.ok === true && r.result?.data && typeof r.result.data === 'object' ? r.result.data : (r.result || {});
        const action = String(toolData?.action?.action || toolData?.clientAction?.action || '');
        return r.tool === 'remote_desktop_action_v1' || ['RDP', 'VNC'].includes(protocol) || action.startsWith('remote_desktop');
    });
}
async function continueAiAfterRemoteDesktopClientActions({ original = '', providerId = '', model = '', options = {}, signal = null, toolResults = [], sessionId = '', historyCommit = null } = {}) {
    const targetSessionId = sessionId || aiCurrentSessionId;
    // Legacy followup never carries vision Parts. Remote-desktop must stay on Runtime.
    const rdContext = collectAiContext({ includeRemoteDesktopImages: false, sessionId: targetSessionId });
    if (rdContext?.activeSurface?.kind === 'remote-desktop') {
        throw new Error(t('RDP/VNC AI 视觉操作需要 Go Runtime'));
    }
    const sideEffectSummary = JSON.stringify(maskAiSensitive((Array.isArray(toolResults) ? toolResults : []).map((r) => ({ tool: r.tool, args: r.args, result: r.result }))), null, 2).slice(0, 7000);
    const followup = `原问题：${original}\n\n前端已经尝试执行 RDP/VNC 打开或远程桌面操作。工具/前端执行结果摘要如下：\n${sideEffectSummary || '（无工具结果）'}\n\n现在请基于最新 Zephyr 上下文继续回答；如果结果里有 clientError 或 remoteDesktopAction.ok=false，必须直接告诉用户该操作失败和失败原因，不要声称已经完成；如果工具结果已经包含 remoteDesktopScreenshot/截图摘要，可直接依据它回答，不要重复截图；只有缺少截图且原问题确实询问当前画面时，才调用 remote_desktop_screenshot。不要重复打开同一连接或重复点击刚才的按钮。`;
    const nextOptions = { ...(options || {}), max_tokens: Math.min(Number(options?.max_tokens || 900), 900), max_output_tokens: Math.min(Number(options?.max_output_tokens || 900), 900) };
    const next = await api('/api/ai/chat', { method: 'POST', signal, body: JSON.stringify({ messages: [{ role: 'user', content: followup }], providerId, model, options: nextOptions, context: collectAiContext({ includeRemoteDesktopImages: false, sessionId: targetSessionId }), historyCommit: historyCommit || undefined }) });
    if (next.toolResults?.length) {
        await syncAiToolSideEffects(next.toolResults, { sessionId: targetSessionId });
        appendAiMessage(next.toolResults.map(formatAiToolResult).join(''), 'trace', { rawHtml: true, sessionId: targetSessionId });
    }
    if (next.clientCaptureRequired) return handleAiClientCapture(next, { providerId, model, options, signal, original, sessionId: targetSessionId });
    if (next.confirmationRequired) appendAiConfirmation(next.confirmation, { messages: [{ role: 'user', content: followup }], providerId, model, options, context: collectAiContext({ sessionId: targetSessionId }), sessionId: targetSessionId, historyCommit });
    else {
        appendAiMessage(next.message?.content || '执行完成。', 'assistant', { id: historyCommit?.assistantMessageId || '', meta: [next.provider?.name, next.model].filter(Boolean).join(' / '), sessionId: targetSessionId, metrics: { ...(next.metrics || {}), provider: next.provider, model: next.model } });
        if (next.historyPersisted) scheduleAiHistoryReload(300);
    }
    return true;
}
function maskAiSensitive(value, tool = '') {
    const sensitiveKeys = /api[_-]?key|password|passwd|private[_-]?key|passphrase|secret|token|authorization|cookie/i;
    const walk = (item, key = '') => {
        if (item === null || item === undefined) return item;
        if (typeof item !== 'object') {
            if (sensitiveKeys.test(key) || (tool === 'get_env_var' && key === 'value')) return item ? '******' : item;
            return item;
        }
        if (Array.isArray(item)) return item.map((x) => walk(x, key));
        return Object.fromEntries(Object.entries(item).map(([k, v]) => {
            if (/^(dataUrl|imageDataUrl)$/i.test(k) && typeof v === 'string') return [k, v ? `[image data omitted ${v.length} chars]` : ''];
            return [k, sensitiveKeys.test(k) || (tool === 'get_env_var' && k === 'value') ? (v ? '******' : v) : walk(v, k)];
        }));
    };
    return walk(value);
}
function summarizeAiToolResult(tool, result = {}) {
    const data = result?.ok === true && result?.data && typeof result.data === 'object' ? result.data : result;
    if (result?.ok === false || result?.code || result?.errorCode) return localizedAiError(result);
    if (tool === 'connection_list_v1') return `发现 ${(data.connections || []).length} 个连接`;
    if (tool === 'connection_get_v1') return `读取连接 ${data.connection?.name || data.connection?.id || ''}`;
    if (tool === 'connection_create_v1') return `已新增连接 ${data.connection?.name || ''}`;
    if (tool === 'connection_update_v1' || tool === 'connection_rename_v1') return `已修改连接 ${data.connection?.name || ''}`;
    if (tool === 'connection_delete_v1') return `已删除连接 ${data.connectionId || ''}`;
    if (tool === 'connection_test_v1') return data.result?.ok ? t('连接测试成功') : (data.result?.message || '连接测试完成');
    if (tool === 'connection_open_v1') return `准备打开连接 ${data.connection?.name || data.connectionId || ''}`;
    if (tool === 'proxy_list_v1') return `发现 ${(data.proxies || []).length} 个代理`;
    if (tool === 'proxy_get_v1') return `读取代理 ${data.proxy?.name || data.proxy?.id || ''}`;
    if (tool === 'proxy_create_v1') return `已新增代理 ${data.proxy?.name || ''}`;
    if (tool === 'proxy_update_v1') return `已修改代理 ${data.proxy?.name || ''}`;
    if (tool === 'proxy_delete_v1') return `已删除代理 ${data.proxyId || ''}`;
    if (tool === 'ssh_key_list_v1') return `发现 ${(data.sshKeys || []).length} 个 SSH 密钥`;
    if (tool === 'ssh_key_get_v1') return `读取 SSH 密钥 ${data.sshKey?.name || data.sshKey?.id || ''}`;
    if (tool === 'ssh_key_validate_v1') return data.validation?.valid ? `SSH 密钥格式有效，${data.validation.algorithm || ''}` : 'SSH 密钥格式无效';
    if (tool === 'ssh_key_rename_v1' || tool === 'ssh_key_update_metadata_v1') return `已修改 SSH 密钥 ${data.sshKey?.name || ''}`;
    if (tool === 'ssh_key_delete_v1') return `已删除 SSH 密钥 ${data.sshKeyId || ''}`;
    if (tool === 'list_connections') {
        const list = result.connections || [];
        const byProto = list.reduce((acc, c) => { acc[c.protocol || 'SSH'] = (acc[c.protocol || 'SSH'] || 0) + 1; return acc; }, {});
        return `发现 ${list.length} 个连接：${Object.entries(byProto).map(([k, v]) => `${k} ${v}`).join('、') || '无'}`;
    }
    if (tool === 'remote_execute') return `远程命令完成，目标 ${(result.results || []).length} 台`;
    if (tool === 'remote_read_file') return `读取 ${result.path || t('文件')}，${result.size || 0} bytes`;
    if (tool === 'remote_write_file') return `写入 ${result.path || t('文件')}，${result.bytes || 0} bytes`;
    if (tool === 'web_search') return `搜索返回 ${(result.results || []).length} 条结果`;
    if (tool === 'fetch_url') return `读取网页 ${result.url || ''}`;
    if (tool === 'memory_search') return `Memory 命中 ${(result.memories || []).length} 条`;
    if (tool === 'memory_save') return `已保存 Memory：${result.memory?.title || ''}`;
    if (tool === 'plan_task' || tool === 'plan_update') return `计划 ${result.plan?.title || result.plan?.id || ''}：${result.plan?.status || 'planned'}`;
    if (tool === 'plan_delete') return `已删除计划 ${result.planId || ''}`;
    if (tool === 'open_connection') return result.message || `打开连接 ${result.connection?.name || result.connectionId || ''}`;
    if (tool === 'terminal_read_output') return `读取 ${(result.terminalOutputs || []).length || (result.terminalOutput ? 1 : 0)} 个终端输出快照`;
    if (tool === 'remote_desktop_capture_v1') {
        if (data.clientCaptureRequired) return t('请求前端实时截取并签发新 captureId');
        const count = (data.screenshots || []).length || (data.capture ? 1 : 0);
        return count ? t('读取 {count} 个远程桌面画面，captureId={captureId}', { count, captureId: data.capture?.captureId || data.screenshots?.[0]?.captureId || '' }) : (data.message || t('没有可读取的远程桌面画面'));
    }
    if (tool === 'remote_desktop_action_v1') return data.clientError ? t('远程桌面操作失败：{error}', { error: data.clientError }) : (data.captureChanged ? t('远程桌面操作已返回新画面') : t('远程桌面操作等待闭环验证'));
    if (tool === 'remote_desktop_verify_v1') return data.verified ? t('远程桌面动作闭环已验证') : t('远程桌面画面未变化，不能确认操作成功');
    if (tool === 'remote_desktop_cert_status_v1') {
        const cert = data.cert || {};
        if (data.clientError) return t('读取证书状态失败：{error}', { error: data.clientError });
        if (cert.pending) return t('RDP 证书待确认：{host} fingerprint={fingerprint}', { host: cert.host || '', fingerprint: cert.fingerprint || '' });
        return data.message || t('RDP 证书阶段：{phase}', { phase: cert.certPhase || cert.connectionPhase || '' });
    }
    if (tool === 'remote_desktop_cert_decide_v1') {
        if (data.clientError) return t('证书决策失败：{error}', { error: data.clientError });
        const rejected = String(data.decision || '') === 'reject' || data.cert?.certPhase === 'rejected';
        return rejected ? t('RDP 证书已拒绝') : t('RDP 证书已接受');
    }
    if (tool === 'ui_action' && result.clientError) return t('操作失败：{error}', { error: result.clientError });
    if (tool === 'ui_action' && result.remoteDesktopScreenshot) return t('远程桌面操作完成：{protocol} {status}', { protocol: result.remoteDesktopScreenshot.protocol || '', status: result.remoteDesktopScreenshot.status || '' });
    if (tool === 'ui_action' && result.terminalOutput) return result.terminalOutput.truncated ? t('终端输出 {count} 行（已截断）', { count: result.terminalOutput.lineCount || 0 }) : t('终端输出 {count} 行', { count: result.terminalOutput.lineCount || 0 });
    if (tool === 'browser_inspect_v1') return t('发现 {count} 个可操作元素（DOM v{revision}）：{elements}', { count: (data.elements || []).length, revision: data.domRevision || 0, elements: (data.elements || []).slice(0, 5).map((e) => e.text || e.elementRef).filter(Boolean).join(t('、')) });
    if (String(tool || '').startsWith('browser_')) return t('AI 正在页面代操作：{target}', { target: data.title || data.url || t('浏览器操作完成') });
    return t('执行完成');
}
function formatAiToolResult(r = {}) {
    const result = r.result || {};
    const detail = JSON.stringify(maskAiSensitive({ args: r.args || {}, result }, r.tool), null, 2);
    const shot = browserShotFromResult(result);
    const titleMap = {
        list_connections: t('列出连接'), connection_list_v1: t('列出连接'), connection_get_v1: t('读取连接'), connection_rename_v1: t('重命名连接'), connection_create_v1: t('新增连接'), connection_update_v1: t('修改连接'), connection_delete_v1: t('删除连接'), connection_test_v1: t('测试连接'), connection_open_v1: t('打开连接'), proxy_list_v1: t('列出代理'), proxy_get_v1: t('读取代理'), proxy_create_v1: t('新增代理'), proxy_update_v1: t('修改代理'), proxy_delete_v1: t('删除代理'), ssh_key_list_v1: t('列出 SSH 密钥'), ssh_key_get_v1: t('读取 SSH 密钥'), ssh_key_validate_v1: t('校验 SSH 密钥'), ssh_key_rename_v1: t('重命名 SSH 密钥'), ssh_key_update_metadata_v1: t('修改 SSH 密钥备注'), ssh_key_delete_v1: t('删除 SSH 密钥'), web_search: t('网页搜索'), fetch_url: t('网页读取'), browser_navigate: t('浏览器打开'), browser_inspect_v1: t('检查页面元素'), browser_screenshot: t('浏览器截图'), browser_click_v1: t('浏览器点击'), browser_type_v1: t('浏览器输入'), browser_scroll: t('浏览器滚动'), browser_text: t('读取浏览器文本'), browser_key: t('浏览器按键'), browser_wait: t('等待页面'), open_connection: t('打开连接'), terminal_read_output: t('读取终端输出'), remote_desktop_capture_v1: t('读取远程桌面画面'), remote_desktop_action_v1: t('操作远程桌面'), remote_desktop_verify_v1: t('验证远程桌面操作'), remote_desktop_cert_status_v1: t('读取 RDP 证书状态'), remote_desktop_cert_decide_v1: t('决策 RDP 证书'), sftp_list_v1: t('SFTP 列目录'), sftp_stat_v1: t('SFTP 元数据'), sftp_mkdir_v1: t('SFTP 创建目录'), sftp_rename_v1: t('SFTP 重命名'), sftp_delete_v1: t('SFTP 删除'), sftp_chmod_v1: t('SFTP 改权限'), docker_status_v1: t('Docker 状态'), docker_ps_v1: t('Docker 容器'), docker_images_v1: t('Docker 镜像'), docker_container_action_v1: t('Docker 容器操作'), docker_logs_v1: t('Docker 日志'), docker_pull_v1: t('Docker 拉取'), docker_mirrors_get_v1: t('Docker 镜像源'), docker_mirrors_set_v1: t('设置 Docker 镜像源'), agent_file_write_text_v1: t('写入 Agent 文件'), resource_share_list_v1: t('列出资源共享'), resource_share_put_v1: t('更新资源共享'), resource_share_delete_v1: t('删除资源共享'), resource_shared_with_me_v1: t('共享给我的资源'), note_groups_v1: t('笔记分组'), note_group_rename_v1: t('重命名笔记分组'), note_group_delete_v1: t('删除笔记分组'), note_restore_v1: t('恢复笔记'), note_purge_v1: t('彻底删除笔记'), note_bulk_v1: t('批量笔记操作'), env_set_v1: t('设置环境变量'), env_delete_v1: t('删除环境变量'), ui_action: t('页面/终端代操作'), memory_search: t('搜索 Memory'), memory_save: t('保存 Memory'), plan_task: t('创建计划'), plan_update: t('更新计划'), plan_delete: t('删除计划'), remote_execute: t('远程执行'), remote_read_file: t('读取远程文件'), remote_write_file: t('写入远程文件'), confirmed: t('敏感操作结果')
    };
    const title = titleMap[r.tool] || t('工具 {name}', { name: r.tool || 'unknown' });
    const duration = Number.isFinite(Number(r.durationMs)) ? `${(Number(r.durationMs) / 1000).toFixed(1)}s` : '';
    return `<div class="ai-tool-trace" data-tool="${escapeHtml(r.tool || '')}">
        <div class="ai-tool-trace-head"><span class="ai-tool-icon">${String(r.tool || '').startsWith('remote_') ? '▣' : String(r.tool || '').startsWith('browser_') ? '◉' : '◇'}</span><strong>${escapeHtml(title)}</strong>${duration ? `<em>${escapeHtml(duration)}</em>` : ''}</div>
        <div class="ai-tool-summary">${escapeHtml(summarizeAiToolResult(r.tool, result))}</div>
        ${shot?.url ? `<a href="${escapeHtml(shot.url)}" target="_blank" rel="noopener"><img class="ai-inline-shot" src="${escapeHtml(shot.url)}" alt="${escapeHtml(t('浏览器截图'))}"></a>` : ''}
        <details class="ai-tool-details"><summary>${t('查看完整参数和结果')}</summary><pre><code>${escapeHtml(detail)}</code></pre></details>
    </div>`;
}
async function deleteAiPlan(planId) {
    if (!planId) return;
    openAiInlineConfirm({
        title: t('删除任务计划'),
        body: t('删除后计划步骤与日志不可恢复。'),
        confirmLabel: t('删除'),
        danger: true,
        onConfirm: () => deleteAiPlanConfirmed(planId),
    });
}
async function deleteAiPlanConfirmed(planId) {
    try {
        const data = await api('/api/ai/tools/run', { method: 'POST', body: JSON.stringify({ tool: 'plan_delete', args: { planId }, context: collectAiContext() }) });
        const ai = normalizeAiSettings(settings.ai || aiSettingsState || {});
        ai.plans = (ai.plans || []).filter((p) => p.id !== planId);
        settings.ai = ai; aiSettingsState = ai; renderAiPlanList();
        toast(data.result?.deleted ? t('计划已删除') : t('计划删除完成'));
    } catch (err) { toast(err.message || t('计划删除失败')); }
}
async function revealAiProviderKey(id, trigger = null) {
    const secret = await requestSensitiveSecret(t('查看已保存 AI API Key'));
    const data = await api(`/api/ai/providers/${encodeURIComponent(id)}/open`, { method: 'POST', body: JSON.stringify({ secret }) });
    const provider = normalizeAiSettings(settings.ai || aiSettingsState || {}).providers.find((p) => p.id === id);
    if (provider) openAiProviderModal(provider, trigger);
    $('#aiProviderApiKey').value = data.apiKey || '';
    $('#aiProviderApiKey').type = 'text';
    toast(data.hasApiKey ? '已载入保存的 API Key' : '当前未保存 API Key');
}
async function updateAiPlan(planId, action = {}) {
    try {
        const data = await api('/api/ai/tools/run', { method: 'POST', body: JSON.stringify({ tool: 'plan_update', args: { planId, ...action }, context: collectAiContext() }) });
        mergeAiPlan(data.result?.plan);
        toast(t('计划已更新'));
    } catch (err) { toast(err.message || '计划更新失败'); }
}
function formatAiRequestFailure(err) {
    const message = String(err?.message || t('请求失败'));
    const transient = !!err?.transient || /网络请求失败|网络连接中断|请求超时|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|502|503|504/i.test(message);
    if (transient) {
        return `请求失败：${message}\n\n我已在服务端对上游 AI fetch failed / 断连 / 超时做自动重试；如果仍出现，多半是当前供应商线路或模型临时不稳。你可以直接重试，或切换模型/供应商。`;
    }
    const contextTooLarge = /context length|context window|maximum context|max(?:imum)? tokens|token limit|too many tokens|上下文.*(?:过长|超限)|请求内容过长|413/i.test(message);
    if (contextTooLarge) {
        return `请求失败：${message}\n\n建议：点“压缩摘要”后重试，或减少截图和附件。`;
    }
    return `请求失败：${message}`;
}
let aiRuntimeEnabledCache = null;
async function aiRuntimeIsEnabled() {
    if (aiRuntimeEnabledCache != null) return aiRuntimeEnabledCache;
    try {
        const st = await api('/api/ai/runtime/status');
        aiRuntimeEnabledCache = !!st?.enabled;
    } catch {
        aiRuntimeEnabledCache = false;
    }
    return aiRuntimeEnabledCache;
}

/** Consume SSE from Node proxy. Supports fetch streaming (cookie auth). */
async function consumeAiRuntimeSse(path, { signal, onEvent, lastEventId = 0, onLastEventId } = {}) {
    const headers = { Accept: 'text/event-stream' };
    if (Number(lastEventId) > 0) headers['Last-Event-ID'] = String(Math.floor(Number(lastEventId)));
    const res = await fetch(path, {
        method: 'GET',
        credentials: 'same-origin',
        headers,
        signal,
    });
    if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw Object.assign(new Error(errBody.error || res.statusText || 'SSE failed'), { status: res.status, body: errBody });
    }
    const reader = res.body?.getReader?.();
    if (!reader) throw new Error('SSE stream unsupported');
    const dec = new TextDecoder();
    let buf = '';
    let eventName = 'message';
    let eventId = '';
    let dataLines = [];
    const flush = () => {
        if (!dataLines.length) return;
        const raw = dataLines.join('\n');
        dataLines = [];
        let payload = raw;
        try { payload = JSON.parse(raw); } catch {}
        const type = payload?.type || eventName;
        const parsedId = Number(eventId || payload?.seq || 0);
        if (Number.isFinite(parsedId) && parsedId > 0) onLastEventId?.(parsedId);
        onEvent?.({ type, data: payload, raw, eventId: parsedId || 0 });
        eventName = 'message';
        eventId = '';
    };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
            let line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            if (line.endsWith('\r')) line = line.slice(0, -1);
            if (line === '') { flush(); continue; }
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:')) { eventName = line.slice(6).trim(); continue; }
            if (line.startsWith('id:')) { eventId = line.slice(3).trim(); continue; }
            if (line.startsWith('data:')) { dataLines.push(line.slice(5).trimStart()); continue; }
        }
    }
    flush();
}

function aiCaptureDataUrlToBlob(dataUrl) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(String(dataUrl || ''));
    if (!match) throw new Error(t('远程桌面截图格式无效'));
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: match[1].toLowerCase() });
}

async function ensureAiRuntimeSessionId(session, sessionId) {
    if (session.runtimeSessionId) return session.runtimeSessionId;
    await ensureCanonicalAiConversation(session);
    const created = await api('/api/ai/runtime/sessions', {
        method: 'POST',
        body: JSON.stringify({
            title: session.title || t('新对话'),
            metadata: { clientSessionId: sessionId, canonicalConversationId: session.id },
        }),
    });
    session.runtimeSessionId = created.session?.id || created.sessionId;
    saveAiChats();
    return session.runtimeSessionId;
}

function aiHistoryCommitFor(session, userMessage, assistantMessageId, providerId, model) {
    return {
        conversationId: session.id,
        title: session.title || t('新对话'),
        providerId: providerId || null,
        model: model || null,
        userMessage: {
            id: userMessage?.id || `message-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            content: String(userMessage?.content || ''),
        },
        assistantMessageId: assistantMessageId || `message-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    };
}

async function sendAiMessageViaRuntime({ session, sessionId, text, providerId, model, options, context, abortController, attachments = [], userMessage, assistantMessageId }) {
    // Bind browser chat id → server session id (stored on session object).
    const serverSessionId = await ensureAiRuntimeSessionId(session, sessionId);
    const aiCfg = normalizeAiSettings(settings.ai || {});
    const collabMode = getAiSegmentValue('aiCollabMode', session.collabMode || 'standard');
    session.collabMode = collabMode;
    setAiSegmentValue('aiCollabMode', collabMode, { silent: true });
    // S8 run profile (economy/balanced/delivery). Collab plan/goal wins when not standard.
    const runProfile = getAiSegmentValue('aiRunProfile', session.runProfile || 'balanced');
    session.runProfile = runProfile;
    setAiSegmentValue('aiRunProfile', runProfile, { silent: true });
    const effectiveMode = (collabMode && collabMode !== 'standard') ? collabMode : runProfile;
    const perm = aiCfg.permissions || {};
    const chatPermissionMode = getAiSegmentValue('aiChatPermissionMode', session.permissionMode || perm.mode || (aiCfg.sensitive?.autoConfirm ? 'yolo' : 'ask'));
    session.permissionMode = chatPermissionMode;
    setAiSegmentValue('aiChatPermissionMode', chatPermissionMode, { silent: true });
    const permissionMode = chatPermissionMode;
    const attachmentIds = (attachments || []).map((a) => a.id).filter(Boolean);
    const start = await api('/api/ai/runtime/runs', {
        method: 'POST',
        signal: abortController.signal,
        body: JSON.stringify({
            sessionId: serverSessionId,
            conversationId: session.id,
            title: session.title || t('新对话'),
            userMessageId: userMessage?.id || '',
            assistantMessageId,
            historyUserContent: String(userMessage?.content || text || ''),
            message: text,
            attachments: attachmentIds,
            providerId,
            model,
            options,
            context,
            mode: effectiveMode,
            permissionMode,
            permission: {
                mode: permissionMode,
                deny: perm.deny || [],
                allow: perm.allow || [],
                ask: perm.ask || [],
            },
            autoConfirm: !!aiCfg.sensitive?.autoConfirm,
            autoConfirmDelayMs: Number(aiCfg.sensitive?.autoConfirmDelayMs) || 0,
        }),
    });
    session.runtimeRunId = start.runId;
    session.runtimeTicket = start.ticket || session.runtimeTicket || '';
    session.runtimeLastEventId = 0;
    saveAiChats();

    let assistantText = '';
    const toolTrace = [];
    let assistantEl = null;
    let assistantMsgIndex = -1;
    const ensureAssistantBubble = () => {
        if (assistantEl && document.contains(assistantEl)) return assistantEl;
        appendAiMessage(assistantText || '', 'assistant', {
            sessionId,
            meta: [model].filter(Boolean).join(' / '),
            store: true,
            id: assistantMessageId,
        });
        const area = $('#aiChatArea');
        const nodes = area?.querySelectorAll?.('.ai-message.ai, .ai-message.assistant');
        assistantEl = nodes?.[nodes.length - 1] || null;
        if (assistantEl?.dataset?.aiMessageIndex != null) {
            assistantMsgIndex = Number(assistantEl.dataset.aiMessageIndex);
        }
        return assistantEl;
    };
    const patchAssistant = () => {
        ensureAssistantBubble();
        if (!assistantEl) return;
        const metaHtml = assistantEl.querySelector('small')
            ? `<small>${assistantEl.querySelector('small').innerHTML}</small>`
            : (model ? `<small>${escapeHtml(model)}</small>` : '');
        assistantEl.innerHTML = `${metaHtml}${renderAiMessageContent(assistantText, 'assistant', false)}`;
        assistantEl.dataset.aiMessageText = assistantText;
        const s = aiChatSessions.find((x) => x.id === sessionId);
        if (s?.messages?.length) {
            if (assistantMsgIndex >= 0 && s.messages[assistantMsgIndex]?.role === 'assistant') {
                s.messages[assistantMsgIndex].content = assistantText;
            } else {
                const last = s.messages[s.messages.length - 1];
                if (last?.role === 'assistant') last.content = assistantText;
            }
            saveAiChats();
        }
        scrollAiChat();
    };

    const ssePath = start.sseProxyPath || start.ssePath || `/api/ai/runtime/runs/${encodeURIComponent(start.runId)}/events?ticket=${encodeURIComponent(start.ticket || '')}`;
    await consumeAiRuntimeSse(ssePath, {
        signal: abortController.signal,
        lastEventId: session.runtimeLastEventId || 0,
        onLastEventId: (id) => { session.runtimeLastEventId = Math.max(Number(session.runtimeLastEventId) || 0, Number(id) || 0); },
        onEvent: async ({ type, data }) => {
            const evType = data?.type || type;
            const payload = data?.data != null && typeof data.data === 'object' && !Array.isArray(data.data)
                ? data.data
                : (typeof data?.data === 'string' ? (() => { try { return JSON.parse(data.data); } catch { return { text: data.data }; } })() : data);
            // When full event envelope: data is Event, payload in data.data (already parsed object or string)
            let body = payload;
            if (data?.data && data.type) {
                body = typeof data.data === 'string' ? (() => { try { return JSON.parse(data.data); } catch { return {}; } })() : data.data;
            }
            switch (evType) {
                case 'text.delta': {
                    const t = body?.text || payload?.text || '';
                    if (t) { assistantText += t; patchAssistant(); }
                    break;
                }
                case 'tool.start':
                case 'tool.pending':
                    toolTrace.push({ phase: evType, name: body?.name || '', callId: body?.callId || '' });
                    break;
                case 'tool.result':
                case 'tool.error': {
                    const item = {
                        tool: body?.name || 'tool',
                        args: body?.args || {},
                        result: body?.result,
                        status: body?.status || (evType === 'tool.error' ? 'error' : 'success'),
                    };
                    toolTrace.push(item);
                    try { await syncAiToolSideEffects([item], { sessionId }); } catch {}
                    appendAiMessage(formatAiToolResult(item), 'trace', { rawHtml: true, sessionId });
                    break;
                }
                case 'permission.ask': {
                    const conf = {
                        id: body?.askId || body?.callId || `ask_${Date.now()}`,
                        tool: body?.name || '',
                        summary: body?.summary || `允许执行 ${body?.name || t('操作')}？`,
                        args: body?.args || {},
                    };
                    appendAiConfirmation(conf, {
                        runtime: true,
                        runId: start.runId,
                        serverSessionId,
                        providerId,
                        model,
                        options,
                        context,
                        sessionId,
                    });
                    // Go has paused at the permission gate. Close only this SSE
                    // listener (not the server run) so resume does not create a
                    // second subscriber and the first Approve click cannot be
                    // intercepted by stopAiResponse().
                    aiStoppedControllers.add(abortController);
                    abortController.abort();
                    clearAiSessionRun(sessionId, abortController);
                    break;
                }
                case 'client.capture': {
                    const captureArgs = body?.args && typeof body.args === 'object' ? body.args : body;
                    const targetTabId = String(captureArgs?.tabId || body?.tabId || '').trim();
                    const maxWidth = Number(captureArgs?.maxWidth || body?.maxWidth || 640) || 640;
                    const callId = body?.callId || captureArgs?.toolCallId || '';
                    const captureType = String(captureArgs?.type || body?.name || '');
                    const isCertCapture = captureType.includes('remote_desktop_cert_') || captureArgs?.vision === false
                        || (captureArgs?.action && String(captureArgs.action.action || '').startsWith('remote_desktop_cert_'));
                    if (isCertCapture) {
                        let actionResult = null;
                        if (captureType === 'remote_desktop_cert_decide_v1' || captureArgs?.action?.action === 'remote_desktop_cert_decide') {
                            actionResult = await performAiUiAction(captureArgs.action || {
                                action: 'remote_desktop_cert_decide',
                                tabId: targetTabId,
                                decision: captureArgs.decision || captureArgs.action?.decision || 'accept',
                                remember: captureArgs.remember === true || captureArgs.action?.remember === true,
                                connectionId: captureArgs.connectionId || captureArgs.action?.connectionId || '',
                                expectedFingerprint: captureArgs.expectedFingerprint || captureArgs.action?.expectedFingerprint || '',
                                waitMs: captureArgs.waitMs || captureArgs.action?.waitMs,
                            });
                        } else {
                            actionResult = await performAiUiAction(captureArgs.action || {
                                action: 'remote_desktop_cert_status',
                                tabId: targetTabId,
                                connectionId: captureArgs.connectionId || '',
                            });
                        }
                        const cert = actionResult?.cert || null;
                        const captureResult = {
                            ...(actionResult || {}),
                            cert,
                            clientCaptured: true,
                            vision: false,
                            capturedAt: Date.now(),
                            message: cert?.pending
                                ? t('RDP 证书对话框待决策')
                                : t('已读取 RDP 证书/连接阶段'),
                        };
                        await api(`/api/ai/runtime/runs/${encodeURIComponent(start.runId)}/capture`, {
                            method: 'POST',
                            signal: abortController.signal,
                            body: JSON.stringify({ callId, result: captureResult, providerId, model }),
                        });
                        break;
                    }
                    let actionResult = null;
                    let shot = null;
                    if (captureArgs?.type === 'remote_desktop_action_v1' && captureArgs?.action) {
                        actionResult = await performAiUiAction(captureArgs.action);
                        shot = actionResult?.remoteDesktopScreenshot || null;
                    }
                    if (!shot) shot = await waitForFreshRemoteDesktopSnapshot(targetTabId, { maxWidth, timeoutMs: 3200, afterFrameAt: Number(captureArgs?.afterFrameAt || 0) });
                    if (!shot?.dataUrl) throw new Error(shot?.error || t('实时截图不可用'));
                    const imageBlob = aiCaptureDataUrlToBlob(shot.dataUrl);
                    if (!imageBlob) throw new Error(t('截图格式无效，无法上传视觉帧'));
                    let uploaded;
                    try {
                        uploaded = await api(`/api/ai/runtime/runs/${encodeURIComponent(start.runId)}/capture-image?callId=${encodeURIComponent(callId)}`, {
                            method: 'POST',
                            signal: abortController.signal,
                            headers: { 'Content-Type': imageBlob.type },
                            body: imageBlob,
                        });
                    } catch (uploadErr) {
                        toast(uploadErr?.message || t('视觉帧上传失败'));
                        throw Object.assign(uploadErr instanceof Error ? uploadErr : new Error(String(uploadErr?.message || uploadErr || t('视觉帧上传失败'))), { code: uploadErr?.code || 'vision_upload_failed' });
                    }
                    if (!uploaded?.captureAssetId) {
                        const err = new Error(t('视觉帧上传失败：缺少 captureAssetId'));
                        err.code = 'vision_upload_failed';
                        toast(err.message);
                        throw err;
                    }
                    const safeShot = { ...shot };
                    delete safeShot.dataUrl;
                    const captureResult = { ...(actionResult || {}), screenshots: [safeShot], capture: safeShot, captureId: safeShot.captureId || '', beforeCaptureId: captureArgs?.beforeCaptureId || actionResult?.beforeCaptureId || '', afterCaptureId: safeShot.captureId || actionResult?.afterCaptureId || '', clientCaptured: true, capturedAt: Date.now(), mimeType: imageBlob.type, imageBytes: imageBlob.size, message: t('已实时截取最新远程桌面画面并签发 captureId') };
                    await api(`/api/ai/runtime/runs/${encodeURIComponent(start.runId)}/capture`, {
                        method: 'POST',
                        signal: abortController.signal,
                        body: JSON.stringify({ callId, captureAssetId: uploaded.captureAssetId, result: captureResult, providerId, model }),
                    });
                    break;
                }
                case 'message.completed': {
                    if (body?.content && !assistantText) {
                        assistantText = body.content;
                        patchAssistant();
                    }
                    break;
                }
                case 'run.completed': {
                    if (!assistantText) {
                        appendAiMessage('执行完成。', 'assistant', { sessionId, metrics: body?.metrics || null });
                    } else {
                        // finalize metrics on last message
                        const s = aiChatSessions.find((x) => x.id === sessionId);
                        const last = s?.messages?.[s.messages.length - 1];
                        if (last?.role === 'assistant') last.metrics = body?.metrics || null;
                        saveAiChats();
                    }
                    // Canonical persistence is performed by the independent
                    // Node completion monitor. Refresh after local run state is
                    // released; metrics remain device-local and are not synced.
                    scheduleAiHistoryReload(600);
                    break;
                }
                case 'run.failed':
                    appendAiMessage(body?.error || t('AI 运行失败'), 'system', { sessionId });
                    break;
                case 'run.aborted':
                    appendAiMessage(t('AI 回复已中断。'), 'system', { sessionId });
                    break;
                default:
                    break;
            }
        },
    });
}

async function deleteCanonicalAiTail(session, fromIndex) {
    const tail = (Array.isArray(session?.messages) ? session.messages : []).slice(Math.max(0, fromIndex));
    for (const message of tail) {
        if (!message?.id || !['user', 'assistant'].includes(String(message.role || ''))) continue;
        try {
            await api(`/api/ai/history/messages/${encodeURIComponent(message.id)}?expectedRevision=${encodeURIComponent(String(Number(message.revision) || 1))}`, {
                method: 'DELETE',
            });
        } catch (error) {
            // A local-only cancelled/failed turn never entered canonical
            // history. Every other failure (especially CAS conflict) must stop
            // the edit so another device's update is not silently erased.
            if (Number(error?.status) === 404 && !message.revision) continue;
            throw error;
        }
    }
}

async function sendAiMessage() {
    const session = aiCurrentSession();
    const sessionId = session?.id || '';
    if (!sessionId) return;
    if (aiIsSessionRunning(sessionId)) { stopAiResponse(sessionId); return; }
    const input = $('#aiUserInput');
    const typedText = input.value.trim();
    const pending = aiPendingInputAttachments.slice();
    if (pending.some((a) => a.status === 'uploading')) {
        toast(t('附件仍在上传，请稍候'));
        return;
    }
    const readyAttachments = pending.filter((a) => a.id && a.status !== 'error');
    if (!typedText && !readyAttachments.length) return;
    const displayBits = [typedText];
    if (readyAttachments.length) {
        displayBits.push(readyAttachments.map((a) => `[附件] ${a.name || a.id}${a.kind === 'image' ? ' 🖼️' : ''}`).join('\n'));
    }
    const text = displayBits.filter(Boolean).join('\n\n');
    const editingIndex = aiEditingSessionId && aiEditingSessionId !== sessionId ? -1 : aiEditingMessageIndex;
    if (editingIndex >= 0) {
        try {
            await deleteCanonicalAiTail(session, editingIndex);
        } catch (error) {
            toast(error.message || t('对话已在其他设备更新，请刷新后重试'));
            scheduleAiHistoryReload(0);
            return;
        }
    }
    aiEditingMessageIndex = -1;
    aiEditingSessionId = '';
    syncAiEditingState();
    if (editingIndex >= 0) {
        session.messages = session.messages.slice(0, Math.max(0, editingIndex));
        renderAiChat();
    }
    input.value = '';
    aiPendingInputAttachments = [];
    autoResizeAiInput(input);
    updateAiInputPreview();
    input.focus?.();
    // Persist only attachment refs in local history — never base64 payloads.
    const userMessage = appendAiMessage(text, 'user', {
        sessionId,
        attachments: readyAttachments.map((a) => ({ id: a.id, name: a.name, kind: a.kind, mime: a.mime, size: a.size })),
    });
    const assistantMessageId = `message-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const abortController = new AbortController();
    registerAiSessionRun(sessionId, abortController);
    try {
        const context = collectAiContext({ sessionId });
        const providerId = $('#aiProviderSelect').value;
        const model = $('#aiModelSelect').value;
        const options = aiIntensityOptions();
        await ensureCanonicalAiConversation(session);
        const useRuntime = await aiRuntimeIsEnabled();
        if (context?.activeSurface?.kind === 'remote-desktop' && !useRuntime) {
            throw new Error(t('RDP/VNC AI 视觉操作需要 Go Runtime'));
        }
        if (readyAttachments.length && !useRuntime) {
            throw new Error(t('发送附件需要 Go Runtime'));
        }
        if (useRuntime) {
            await sendAiMessageViaRuntime({
                session, sessionId, text: typedText || (readyAttachments.length ? t('（用户发送了附件）') : ''),
                providerId, model, options, context, abortController, attachments: readyAttachments,
                userMessage, assistantMessageId,
            });
            return;
        }
        const requestMessages = aiMessagesForRequest(session, typedText);
        const historyCommit = aiHistoryCommitFor(session, userMessage, assistantMessageId, providerId, model);
        const data = await api('/api/ai/chat', { method: 'POST', signal: abortController.signal, body: JSON.stringify({ messages: requestMessages, providerId, model, options, context, historyCommit }) });
        if (data.toolResults?.length) {
            await syncAiToolSideEffects(data.toolResults, { sessionId });
            appendAiMessage(data.toolResults.map(formatAiToolResult).join(''), 'trace', { rawHtml: true, sessionId });
        }
        if (data.clientCaptureRequired) {
            await handleAiClientCapture(data, { providerId, model, options, signal: abortController.signal, original: typedText, sessionId });
        } else if (data.confirmationRequired) {
            appendAiConfirmation(data.confirmation, { messages: requestMessages.slice(), providerId, model, options, context, sessionId, historyCommit });
        } else if (needsRemoteDesktopClientFollowup(data.toolResults || [])) {
            await continueAiAfterRemoteDesktopClientActions({ original: typedText, providerId, model, options, signal: abortController.signal, toolResults: data.toolResults || [], sessionId, historyCommit });
        } else {
            appendAiMessage(data.message?.content || '执行完成。', 'assistant', { id: assistantMessageId, meta: [data.provider?.name, data.model].filter(Boolean).join(' / '), sessionId, metrics: { ...(data.metrics || {}), provider: data.provider, model: data.model } });
            if (data.historyPersisted) scheduleAiHistoryReload(300);
        }
    } catch (err) {
        if (err.name === 'AbortError' || /aborted|abort|已停止/i.test(String(err.message || ''))) {
            if (!aiStoppedControllers.has(abortController)) appendAiMessage(t('AI 回复已中断。'), 'system', { sessionId });
        } else appendAiMessage(formatAiRequestFailure(err), 'system', { sessionId });
    } finally {
        clearAiSessionRun(sessionId, abortController);
        aiStoppedControllers.delete(abortController);
    }
}
async function appendAiFiles(files = []) {
    const session = aiCurrentSession();
    const sessionId = session?.id || aiCurrentSessionId || '';
    if (!sessionId) {
        toast(t('请先打开一个 AI 对话'));
        return;
    }
    // Attachments require a server runtime session for disk storage.
    let serverSessionId = '';
    try {
        serverSessionId = await ensureAiRuntimeSessionId(session, sessionId);
    } catch (err) {
        toast(err.message || t('无法创建运行时会话以上传附件'));
        return;
    }
    const room = Math.max(0, 6 - aiPendingInputAttachments.length);
    const picked = Array.from(files || []).slice(0, room);
    if (!picked.length) return;
    let added = 0;
    for (const file of picked) {
        if (file.size > 12 * 1024 * 1024) {
            toast(t('附件过大已跳过：{name}', { name: file.name }));
            continue;
        }
        const draft = {
            kind: /^image\//i.test(file.type) ? 'image' : (/^text\//i.test(file.type) ? 'text' : 'file'),
            name: file.name,
            mime: file.type || 'application/octet-stream',
            size: file.size,
            status: 'uploading',
            id: '',
            previewUrl: /^image\//i.test(file.type) ? URL.createObjectURL(file) : '',
        };
        aiPendingInputAttachments = aiPendingInputAttachments.concat([draft]).slice(0, 6);
        updateAiAttachmentDraftUi();
        try {
            const form = new FormData();
            form.append('file', file, file.name);
            form.append('sessionId', serverSessionId);
            // FormData must not force application/json Content-Type.
            const res = await apiMaybeForm('/api/ai/attachments', { method: 'POST', body: form });
            const item = res.attachment || res;
            draft.id = item.id;
            draft.kind = item.kind || draft.kind;
            draft.mime = item.mime || draft.mime;
            draft.size = item.size || draft.size;
            draft.status = 'ready';
            added += 1;
        } catch (err) {
            draft.status = 'error';
            draft.error = err.message || t('上传失败');
            toast(draft.error);
        }
        updateAiAttachmentDraftUi();
    }
    $('#aiUserInput')?.focus?.();
    if (added) toast(t('已添加 {count} 个附件，可继续输入文字后发送', { count: added }));
}
async function continueAiAfterConfirmation(id, approve, data) {
    const pending = aiPendingConfirmations.get(id);
    aiPendingConfirmations.delete(id);
    if (!approve || !pending) return;
    const sessionId = pending.sessionId || aiCurrentSessionId;
    if (aiIsSessionRunning(sessionId)) { stopAiResponse(sessionId); return; }
    const original = (pending.messages || []).slice().reverse().find((m) => m.role === 'user')?.content || '';
    const session = aiChatSessions.find((s) => s.id === sessionId);
    if (session) {
        session.messages = session.messages.filter((m) => m.confirmationId !== id);
        saveAiChats();
        if (sessionId === aiCurrentSessionId) renderAiChat();
    }
    const followup = `原问题：${original}\n\n敏感操作已确认并执行，结果如下：\n${JSON.stringify(data.result || {}, null, 2).slice(0, 30000)}\n请基于这个结果继续回答原问题，直接给出结论，不要只复述 JSON。`;
    const abortController = new AbortController();
    registerAiSessionRun(sessionId, abortController);
    try {
        const context = collectAiContext({ includeRemoteDesktopImages: false, sessionId });
        // Never re-enter Legacy Chat for remote-desktop (no dataUrl content path).
        if (context?.activeSurface?.kind === 'remote-desktop') {
            throw new Error(t('RDP/VNC AI 视觉操作需要 Go Runtime'));
        }
        const next = await api('/api/ai/chat', { method: 'POST', signal: abortController.signal, body: JSON.stringify({ messages: [{ role: 'user', content: followup }], providerId: pending.providerId, model: pending.model, options: pending.options || aiIntensityOptions(), context, historyCommit: pending.historyCommit || undefined }) });
        if (next.toolResults?.length) { await syncAiToolSideEffects(next.toolResults, { sessionId }); appendAiMessage(next.toolResults.map(formatAiToolResult).join(''), 'trace', { rawHtml: true, sessionId }); }
        if (next.clientCaptureRequired) await handleAiClientCapture(next, { providerId: pending.providerId, model: pending.model, options: pending.options || aiIntensityOptions(), signal: abortController.signal, original, sessionId });
        else if (next.confirmationRequired) appendAiConfirmation(next.confirmation, { messages: [{ role: 'user', content: followup }], providerId: pending.providerId, model: pending.model, options: pending.options, context: pending.context || context, sessionId, historyCommit: pending.historyCommit });
        else {
            appendAiMessage(next.message?.content || '执行完成。', 'assistant', { id: pending.historyCommit?.assistantMessageId || '', meta: [next.provider?.name, next.model].filter(Boolean).join(' / '), sessionId, metrics: { ...(next.metrics || {}), provider: next.provider, model: next.model } });
            if (next.historyPersisted) scheduleAiHistoryReload(300);
        }
    } catch (err) {
        if (err.name === 'AbortError' || /aborted|abort|已停止/i.test(String(err.message || ''))) {
            if (!aiStoppedControllers.has(abortController)) appendAiMessage('AI 后续处理已中断。', 'system', { sessionId });
        } else appendAiMessage(formatAiRequestFailure(err).replace(/^请求失败/, '继续处理失败'), 'system', { sessionId });
    } finally {
        clearAiSessionRun(sessionId, abortController);
        aiStoppedControllers.delete(abortController);
    }
}
function localizedAiConfirmationSummary(confirmation = {}) {
    if (confirmation.summaryKey) return t(confirmation.summaryKey, confirmation.summaryParams || {});
    return confirmation.summary || '';
}
function insertAiConfirmationCard(confirmation, messageIndex = -1) {
    const area = $('#aiChatArea');
    const typing = $('#aiTypingIndicator');
    if (!area || !typing) return;
    const div = document.createElement('div');
    div.className = 'ai-message system ai-confirm-card';
    div.dataset.aiMessageRole = 'confirmation';
    if (messageIndex >= 0) div.dataset.aiMessageIndex = String(messageIndex);
    const summary = localizedAiConfirmationSummary(confirmation);
    div.dataset.aiMessageText = t('需要确认敏感操作：{summary}', { summary });
    div.innerHTML = `<strong>${t('需要确认敏感操作')}</strong><p>${escapeHtml(summary)}</p><pre>${escapeHtml(JSON.stringify(confirmation?.args || {}, null, 2))}</pre><div class="form-actions"><button class="btn btn-primary" data-ai-confirm-approve="${escapeHtml(confirmation?.id || '')}">${t('确认执行')}</button><button class="btn danger" data-ai-confirm-deny="${escapeHtml(confirmation?.id || '')}">${t('拒绝')}</button></div>`;
    div.title = '';
    area.insertBefore(div, typing);
}
function appendAiConfirmation(confirmation, pending = {}) {
    const sessionId = pending.sessionId || aiCurrentSessionId;
    const summary = localizedAiConfirmationSummary(confirmation);
    const text = t('需要确认敏感操作：{summary}', { summary });
    if (confirmation?.id) aiPendingConfirmations.set(confirmation.id, { ...pending, sessionId, confirmation });
    const session = aiChatSessions.find((s) => s.id === sessionId) || aiCurrentSession();
    if (!session) return;
    session.messages.push({ role: 'confirmation', content: text, confirmationId: confirmation?.id || '', summary });
    const messageIndex = session.messages.length - 1;
    saveAiChats();
    renderAiChatList();
    if (session.id === aiCurrentSessionId) {
        insertAiConfirmationCard(confirmation, messageIndex);
        scrollAiChat();
    }
}
async function resolveAiConfirmation(id, approve) {
    const pending = aiPendingConfirmations.get(id);
    const sessionId = pending?.sessionId || aiCurrentSessionId;
    // A permission ask is a paused run, not an active response to abort. Stale
    // SSE/controller bookkeeping must never turn the first Approve click into
    // stop/deny; release only the local listener and resume the same run below.
    const activeController = aiRunForSession(sessionId);
    if (pending && activeController) {
        aiStoppedControllers.add(activeController);
        activeController.abort();
        clearAiSessionRun(sessionId, activeController);
    } else if (aiIsSessionRunning(sessionId)) {
        stopAiResponse(sessionId);
        return;
    }
    const abortController = new AbortController();
    registerAiSessionRun(sessionId, abortController);
    try {
        // Go runtime permission path (grant + optional follow-up).
        if (pending?.runtime && pending.runId) {
            const permissionResult = await api(`/api/ai/runtime/runs/${encodeURIComponent(pending.runId)}/permission`, {
                method: 'POST',
                signal: abortController.signal,
                body: JSON.stringify({
                    approve: !!approve,
                    sessionId: pending.serverSessionId || '',
                    callId: id,
                    tool: pending.confirmation?.tool || '',
                    scope: approve ? (pending.scope || 'session') : 'once',
                    providerId: pending.providerId || $('#aiProviderSelect')?.value || '',
                    model: pending.model || $('#aiModelSelect')?.value || '',
                }),
            });
            aiPendingConfirmations.delete(id);
            const session = aiChatSessions.find((s) => s.id === sessionId);
            if (session) session.messages = session.messages.filter((m) => m.confirmationId !== id);
            if (!approve) {
                appendAiMessage('已拒绝执行敏感操作。', 'system', { sessionId });
                if (sessionId === aiCurrentSessionId) renderAiChat();
                return;
            }
            appendAiMessage(approve ? '已授权，正在继续…' : '已拒绝。', 'system', { sessionId });
            clearAiSessionRun(sessionId, abortController);
            // True mid-run resume: Go continues same run; keep listening on same SSE ticket if still open.
            // Permission endpoint launches resume; client re-subscribes SSE for the same runId.
            if (approve && pending.runId) {
                const contController = new AbortController();
                registerAiSessionRun(sessionId, contController);
                try {
                    const ticket = permissionResult?.ticket || session?.runtimeTicket || '';
                    if (session && permissionResult?.ticket) {
                        session.runtimeTicket = permissionResult.ticket;
                        saveAiChats();
                    }
                    const ssePath = `/api/ai/runtime/runs/${encodeURIComponent(pending.runId)}/events?ticket=${encodeURIComponent(ticket)}`;
                    // If ticket missing, status poll only — user still sees tool traces on next message.
                    if (ticket) {
                        await consumeAiRuntimeSse(ssePath, {
                            signal: contController.signal,
                            lastEventId: session?.runtimeLastEventId || 0,
                            onLastEventId: (eventId) => {
                                if (session) session.runtimeLastEventId = Math.max(Number(session.runtimeLastEventId) || 0, Number(eventId) || 0);
                            },
                            onEvent: ({ type, data }) => {
                                const evType = data?.type || type;
                                if (evType === 'text.delta') {
                                    const body = typeof data?.data === 'string' ? (() => { try { return JSON.parse(data.data); } catch { return {}; } })() : (data?.data || data);
                                    if (body?.text) appendAiMessage(body.text, 'assistant', { sessionId, store: true });
                                }
                                if (evType === 'tool.result' || evType === 'tool.error') {
                                    const body = typeof data?.data === 'string' ? (() => { try { return JSON.parse(data.data); } catch { return {}; } })() : (data?.data || data);
                                    const item = { tool: body?.name || 'tool', args: body?.args || {}, result: body?.result, status: body?.status || 'success' };
                                    appendAiMessage(formatAiToolResult(item), 'trace', { rawHtml: true, sessionId });
                                }
                                if (evType === 'run.completed' && data?.data) {
                                    const body = typeof data.data === 'string' ? (() => { try { return JSON.parse(data.data); } catch { return {}; } })() : data.data;
                                    if (body?.metrics) { /* optional */ }
                                }
                            },
                        });
                    }
                } finally {
                    clearAiSessionRun(sessionId, contController);
                }
            }
            return;
        }

        const data = await api(`/api/ai/confirm/${encodeURIComponent(id)}`, { method: 'POST', signal: abortController.signal, body: JSON.stringify({ approve }) });
        if (approve && data.result) {
            await syncAiToolSideEffects([{ tool: data.toolName || (data.result?.plan ? 'plan_update' : ''), args: data.args || {}, result: data.result }], { sessionId });
            appendAiMessage(formatAiToolResult({ tool: data.toolName || 'confirmed', result: data.result, args: data.args || {}, durationMs: data.durationMs }), 'trace', { rawHtml: true, sessionId });
            clearAiSessionRun(sessionId, abortController);
            await continueAiAfterConfirmation(id, true, data);
        } else {
            aiPendingConfirmations.delete(id);
            const session = aiChatSessions.find((s) => s.id === sessionId);
            if (session) session.messages = session.messages.filter((m) => m.confirmationId !== id);
            appendAiMessage('已拒绝执行敏感操作。', 'system', { sessionId });
            if (sessionId === aiCurrentSessionId) renderAiChat();
        }
    } catch (err) {
        if (err.name === 'AbortError' || /aborted|abort|已停止/i.test(String(err.message || ''))) {
            if (!aiStoppedControllers.has(abortController)) appendAiMessage('AI 确认操作已中断。', 'system', { sessionId });
        } else appendAiMessage(`确认处理失败：${err.message}`, 'system', { sessionId });
    } finally {
        clearAiSessionRun(sessionId, abortController);
        aiStoppedControllers.delete(abortController);
    }
}
function autoResizeAiInput(textarea) { textarea.style.height = 'auto'; textarea.style.height = `${Math.min(140, textarea.scrollHeight)}px`; }
function estimateAiMessageChars(message) {
    const text = String(message?.content || '');
    return text.length + (text.includes('data:image/') ? 1200 : 0);
}
function compressAiMessagesForRequest(messages = [], latest = '') {
    const clean = (Array.isArray(messages) ? messages : [])
        .filter((m) => ['user', 'assistant', 'confirmation'].includes(String(m.role || '')) && !/^请求失败[:：]/.test(String(m.content || '')))
        .map((m) => ({ role: m.role === 'confirmation' ? 'assistant' : m.role, content: String(m.content || '') }));
    const last = clean[clean.length - 1];
    if (latest && (!last || last.role !== 'user' || String(last.content || '') !== latest)) clean.push({ role: 'user', content: latest });
    const total = clean.reduce((sum, m) => sum + estimateAiMessageChars(m), 0);
    if (clean.length <= 18 && total <= 72000) return clean;
    const recent = [];
    let recentChars = 0;
    for (let i = clean.length - 1; i >= 0; i -= 1) {
        const len = estimateAiMessageChars(clean[i]);
        if (recent.length >= 12 && recentChars + len > 42000) break;
        recent.unshift(clean[i]);
        recentChars += len;
    }
    const older = clean.slice(0, Math.max(0, clean.length - recent.length));
    if (!older.length) return recent;
    let summary = `高轮次对话压缩摘要（前端自动生成；不是限制轮次，最近 ${recent.length} 条仍保留原文）：\n`;
    for (const m of older) {
        if (summary.length > 18000) break;
        const role = m.role === 'assistant' ? 'AI' : t('用户');
        const text = m.content.replace(/data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+/g, '[图片]').replace(/\s+/g, ' ').trim().slice(0, 700);
        if (text) summary += `- ${role}: ${text}\n`;
    }
    return [{ role: 'user', content: summary.slice(0, 20000) }, ...recent];
}
function aiMessagesForRequest(session, latestText = '') {
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const latest = String(latestText || messages[messages.length - 1]?.content || '');
    return compressAiMessagesForRequest(messages, latest);
}
function startAiPanelWatchdog() {
    window.clearInterval(aiPanelWatchdogTimer);
    aiPanelWatchdogTimer = window.setInterval(() => {
        const panel = $('#aiAgentPanel');
        if (!panel || aiPanelState !== 'open') return;
        const rect = panel.getBoundingClientRect();
        const bad = panel.style.display === 'none' || panel.getAttribute('aria-hidden') === 'true' || rect.width < 120 || rect.height < 160 || getComputedStyle(panel).opacity === '0';
        if (!bad) return;
        const Motion = sshKeyMotion.engine;
        if (Motion) {
            try { Motion.stop(panel); Motion.release(panel); } catch {}
        }
        panel.style.display = 'flex';
        panel.style.visibility = 'visible';
        panel.style.pointerEvents = 'auto';
        panel.style.opacity = '1';
        panel.style.transform = 'none';
        panel.style.filter = 'none';
        panel.style.willChange = '';
        panel.classList.add('open');
        panel.setAttribute('aria-hidden', 'false');
        clampAiPanel(panel);
    }, 1200);
}
function stopAiPanelWatchdog() { window.clearInterval(aiPanelWatchdogTimer); aiPanelWatchdogTimer = 0; }
function prepareAiPanelLayout(panel) {
    if (!panel || panel.dataset.positioned) return;
    const compact = window.innerWidth <= 760;
    const vvWidth = window.visualViewport?.width || window.innerWidth;
    const vvHeight = window.visualViewport?.height || window.innerHeight;
    const width = compact ? Math.max(300, Math.min(vvWidth - 40, Math.round(vvWidth * 0.88))) : Math.min(980, window.innerWidth - 40);
    const height = compact ? Math.max(360, Math.min(vvHeight - 96, Math.round(vvHeight * 0.78))) : Math.min(780, window.innerHeight - 80);
    panel.style.left = compact ? `${Math.max(16, Math.round((vvWidth - width) / 2))}px` : `${Math.max(16, (window.innerWidth - width) / 2)}px`;
    panel.style.top = compact ? `${Math.max(18, Math.round((vvHeight - height) * 0.16))}px` : '52px';
    panel.style.width = `${width}px`;
    panel.style.height = `${height}px`;
    panel.dataset.positioned = '1';
}
function resetAiPanelMotionStyles(panel) {
    if (!panel?.style) return;
    panel.style.opacity = '';
    panel.style.transform = '';
    panel.style.filter = '';
    panel.style.transition = '';
    panel.style.visibility = '';
    panel.style.pointerEvents = '';
    panel.style.willChange = '';
    panel.style.transformOrigin = '';
}
function openAiAssistantPanel(trigger = null) {
    const ai = normalizeAiSettings(settings.ai || {});
    if (!ai.enabled) { toast(t('请先在设置中启用 AI 助理')); return; }
    const panel = $('#aiAgentPanel');
    if (!panel) return;
    const wasHidden = panel.style.display === 'none' || panel.getAttribute('aria-hidden') === 'true' || aiPanelState === 'closed';
    const sourceButton = trigger || aiPanelMorphOriginButton || $('#aiFloatingBtn') || $('#openAiAssistantBtn') || $('#openAiAssistantBtn2') || $('#aiNavTab');
    aiPanelMorphOriginButton = sourceButton || aiPanelMorphOriginButton;
    window.clearTimeout(aiPanelCloseTimer);
    aiPanelState = 'opening';
    panel.style.display = 'flex';
    panel.style.visibility = 'hidden';
    panel.style.pointerEvents = 'none';
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    $('#aiFloatingBtn')?.classList.add('active');
    prepareAiPanelLayout(panel);
    bringAiPanelToFront();
    updateAiPanelResponsiveState();
    if (!aiChatSessions.length) createAiChat({ silent: true });
    renderAiHeaderSelectors(); renderAiBrowserPreview(); renderAiChat();
    if (!wasHidden) {
        panel.style.visibility = 'visible';
        panel.style.pointerEvents = 'auto';
        aiPanelState = 'open';
        startAiPanelWatchdog();
        scheduleWorkspaceSave('ai-panel-open');
        return;
    }
    const cycle = ++openAiAssistantPanel._cycle;
    sshKeyMotion._ensure().then(async (Motion) => {
        if (cycle !== openAiAssistantPanel._cycle || aiPanelState !== 'opening') return;
        if (!Motion) {
            resetAiPanelMotionStyles(panel);
            panel.style.visibility = 'visible';
            panel.style.pointerEvents = 'auto';
            aiPanelState = 'open';
            return;
        }
        try {
            Motion.stop(panel);
            Motion.release(panel);
            const contentEl = panel.querySelector('.ai-agent-window');
            if (contentEl) {
                try { Motion.stop(contentEl); Motion.set(contentEl, { opacity: 1 }); } catch { /* ignore */ }
                contentEl.style.opacity = '';
            }
            await Motion.aiPanelOpen(panel, sourceButton, {
                contentEl,
                mode: sourceButton ? 'flip' : 'origin',
                hideSource: false,
                // Grow as one surface; content stays visible during expand.
                contentWithPanel: true,
                radiusTo: parseFloat(getComputedStyle(panel).borderRadius) || 18,
                preset: 'mac',
            });
        } catch (err) {
            console.warn('[ai-panel-motion] open failed, using instant state:', err?.message || err);
        }
        if (cycle !== openAiAssistantPanel._cycle || aiPanelState !== 'opening') return;
        resetAiPanelMotionStyles(panel);
        panel.style.visibility = 'visible';
        panel.style.pointerEvents = 'auto';
        aiPanelState = 'open';
        startAiPanelWatchdog();
        if (window.innerWidth > 760) $('#aiUserInput')?.focus?.({ preventScroll: true });
    });
    scheduleWorkspaceSave('ai-panel-open');
}
openAiAssistantPanel._cycle = 0;
function toggleAiAssistantPanel(trigger = null) {
    const panel = $('#aiAgentPanel');
    const visible = panel && panel.style.display !== 'none' && aiPanelState !== 'closed';
    if (visible) {
        if (trigger) aiPanelMorphOriginButton = trigger;
        closeAiAssistantPanel();
        return;
    }
    openAiAssistantPanel(trigger);
}
function closeAiAssistantPanel() {
    const panel = $('#aiAgentPanel');
    if (!panel || panel.style.display === 'none' || aiPanelState === 'closed') return;
    closeAiPanelLayoutMenu({ instant: true });
    window.clearTimeout(aiPanelCloseTimer);
    aiPanelState = 'closing';
    const cycle = ++openAiAssistantPanel._cycle;
    panel.setAttribute('aria-hidden', 'true');
    closeAiBrowserForSession(aiCurrentSessionId);
    $('#aiFloatingBtn')?.classList.remove('active');
    const trigger = aiPanelMorphOriginButton?.isConnected ? aiPanelMorphOriginButton : ($('#aiFloatingBtn') || $('#aiNavTab'));
    const finishClose = (Motion = null) => {
        if (cycle !== openAiAssistantPanel._cycle || aiPanelState !== 'closing') return;
        if (Motion) {
            try { Motion.stop(panel); Motion.release(panel); } catch {}
        }
        panel.style.display = 'none';
        resetAiPanelMotionStyles(panel);
        panel.classList.remove('open');
        aiPanelState = 'closed';
        stopAiPanelWatchdog();
        scheduleWorkspaceSave('ai-panel-close');
    };
    const Motion = sshKeyMotion.engine;
    if (!Motion || sshKeyMotion.failed) {
        finishClose(null);
        return;
    }
    const contentEl = panel.querySelector('.ai-agent-window');
    // Hide chrome instantly (also done in engine) so shrink is never a mini chat UI.
    panel.classList.add('ai-panel-motion-closing');
    Motion.aiPanelClose(panel, trigger, {
        contentEl,
        mode: trigger ? 'flip' : 'origin',
        hideSource: false,
        contentWithPanel: false,
        // Engine hides before identity reset; we still display:none in finishClose.
        thenHide: true,
        thenDisplayNone: false,
        preset: 'macClose',
    }).then(() => {
        panel.classList.remove('ai-panel-motion-closing');
        if (contentEl) {
            try { Motion.set(contentEl, { opacity: 1 }); } catch { /* ignore */ }
            contentEl.style.opacity = '';
            contentEl.style.visibility = '';
        }
        finishClose(Motion);
    }).catch((err) => {
        console.warn('[ai-panel-motion] close failed, using instant state:', err?.message || err);
        panel.classList.remove('ai-panel-motion-closing');
        if (contentEl) {
            try { Motion.set(contentEl, { opacity: 1 }); } catch { /* ignore */ }
            contentEl.style.opacity = '';
            contentEl.style.visibility = '';
        }
        finishClose(Motion);
    });
}
function bringAiPanelToFront() { const p = $('#aiAgentPanel'); if (!p) return; p.style.zIndex = String(10080 + Math.floor(Date.now() % 40)); p.style.setProperty('--panel-z', p.style.zIndex); }
let aiPanelLayoutMotionToken = 0;

async function applyAiPanelLayout(layout, { animate = true } = {}) {
    const p = $('#aiAgentPanel');
    if (!p) return false;
    const token = ++aiPanelLayoutMotionToken;
    const Motion = animate ? await sshKeyMotion._ensure().catch(() => null) : null;
    // Measure exactly what is painted now. Rapid clicks can therefore retarget
    // from an in-flight rectangle rather than snapping to the previous target.
    const fromRect = p.getBoundingClientRect();
    const fromRadius = parseFloat(getComputedStyle(p).borderTopLeftRadius) || 0;
    if (Motion && !sshKeyMotion.failed) {
        try { Motion.stop(p); Motion.release(p); } catch { /* ignore */ }
    }

    const parentRect = aiPanelParentRect(p);
    const compact = window.innerWidth <= 760;
    const margin = compact ? 6 : 12;
    const topbar = compact ? 38 : 52;
    let left = margin, top = topbar, width = parentRect.width - margin * 2, height = parentRect.height - topbar - margin;
    if (layout === 'full') { left = margin; top = margin; width = parentRect.width - margin * 2; height = parentRect.height - margin * 2; }
    else if (layout === 'half') { width = parentRect.width; height = Math.max(compact ? 260 : 360, parentRect.height / 2); left = 0; top = parentRect.height - height; }
    else if (layout === 'left-quarter') { width = Math.max(compact ? 260 : 340, parentRect.width / 4); height = parentRect.height - topbar; left = 0; top = topbar; }
    else if (layout === 'right-quarter') { width = Math.max(compact ? 260 : 340, parentRect.width / 4); height = parentRect.height - topbar; left = parentRect.width - width; top = topbar; }

    p.classList.add('layout-animating');
    p.style.pointerEvents = 'none';
    p.style.willChange = 'transform, border-radius';
    Object.assign(p.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto', width: `${width}px`, height: `${height}px`, transform: '' });
    bringAiPanelToFront();
    updateAiPanelResponsiveState();
    void p.offsetWidth;

    if (!Motion || sshKeyMotion.failed || fromRect.width < 2 || fromRect.height < 2) {
        p.classList.remove('layout-animating');
        p.style.pointerEvents = '';
        p.style.willChange = '';
        clampAiPanel(p);
        return true;
    }

    const toRadius = parseFloat(getComputedStyle(p).borderTopLeftRadius) || 0;
    try {
        await Motion.morph(p, fromRect, {
            forceFrom: true,
            preset: 'shape',
            radiusVisualFrom: fromRadius,
            radiusTo: toRadius,
            radiusCompensate: true,
        });
    } finally {
        if (token === aiPanelLayoutMotionToken) {
            try { Motion.stop(p); Motion.release(p); } catch { /* ignore */ }
            p.classList.remove('layout-animating');
            p.style.pointerEvents = '';
            p.style.willChange = '';
            p.style.transform = '';
            clampAiPanel(p);
            updateAiPanelResponsiveState();
        }
    }
    return true;
}
function aiPanelParentRect(panel) {
    const viewport = window.visualViewport;
    const fallback = panel?.parentElement?.getBoundingClientRect?.() || { width: window.innerWidth, height: window.innerHeight };
    return {
        left: viewport?.offsetLeft || 0,
        top: viewport?.offsetTop || 0,
        width: viewport?.width || window.innerWidth || document.documentElement.clientWidth || fallback.width,
        height: viewport?.height || window.innerHeight || document.documentElement.clientHeight || fallback.height,
    };
}
/** Keep only enough chrome on-screen to grab again (traffic light / title). */
function aiPanelMinVisiblePx(panel) {
    const width = panel?.offsetWidth || panel?.getBoundingClientRect?.().width || 320;
    // Thin edge strip is intentional (park mostly off-screen). Do NOT use 160px —
    // that caused a post-release jump from "almost gone" back to a fat dock.
    return Math.min(56, Math.max(44, Math.round(width * 0.12)));
}
function clampAiPanel(panel) {
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const parentRect = aiPanelParentRect(panel);
    const minVisible = aiPanelMinVisiblePx(panel);
    const left = Math.min(Math.max(rect.left - parentRect.left, -rect.width + minVisible), parentRect.width - minVisible);
    const top = Math.min(Math.max(rect.top - parentRect.top, 8), parentRect.height - minVisible);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
}
function positionAiPanelLayoutMenu(menu, button, { collapsed = false } = {}) {
    if (!menu || !button) return;
    const rect = button.getBoundingClientRect();
    const viewport = window.visualViewport;
    const vvWidth = viewport?.width || window.innerWidth;
    const anchorX = rect.left + rect.width / 2;
    const finalWidth = Math.min(284, Math.max(160, vvWidth - 16));
    const finalHeight = 50;
    const finalLeft = anchorX - finalWidth / 2;
    menu.style.left = `${collapsed ? rect.left : finalLeft}px`;
    menu.style.top = `${rect.top}px`;
    menu.style.setProperty('--panel-island-menu-width', `${collapsed ? rect.width : finalWidth}px`);
    menu.style.setProperty('--panel-island-menu-height', `${collapsed ? rect.height : finalHeight}px`);
    menu.style.setProperty('--panel-island-radius', `${Math.round((collapsed ? rect.height : 36) / 2)}px`);
    menu.dataset.placement = 'inline';
}
function closeAiPanelLayoutMenu({ instant = false } = {}) {
    const menu = aiPanelLayoutMenu;
    const button = aiPanelLayoutMenuButton;
    if (!menu) { button?.classList.remove('active-layout'); aiPanelLayoutMenuButton = null; return; }
    window.clearTimeout(menu._closeTimer);
    if (instant || !button?.isConnected) {
        button?.classList.remove('active-layout');
        button?.style.removeProperty('opacity');
        menu.remove(); aiPanelLayoutMenu = null; aiPanelLayoutMenuButton = null; return;
    }
    menu.style.transition = 'none';
    positionAiPanelLayoutMenu(menu, button, { collapsed: false });
    menu.style.opacity = '1';
    void menu.offsetWidth;
    menu.classList.remove('island-open');
    menu.classList.add('island-closing', 'island-animating');
    button.classList.remove('active-layout');
    button.style.opacity = '0';
    requestAnimationFrame(() => { menu.style.removeProperty('transition'); positionAiPanelLayoutMenu(menu, button, { collapsed: true }); });
    menu._closeTimer = window.setTimeout(() => {
        button.classList.remove('active-layout');
        button.style.opacity = '1';
        requestAnimationFrame(() => button.style.removeProperty('opacity'));
        menu.remove(); if (aiPanelLayoutMenu === menu) aiPanelLayoutMenu = null; if (aiPanelLayoutMenuButton === button) aiPanelLayoutMenuButton = null;
    }, 460);
}
function openAiPanelLayoutMenu(button, panel) {
    closeAiPanelLayoutMenu({ instant: true });
    aiPanelLayoutMenuButton = button;
    button?.classList.remove('active-layout');
    const menu = document.createElement('div');
    menu.className = 'panel-layout-menu ai-layout-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', t('AI 浮窗布局'));
    menu.innerHTML = `
        <button data-layout="full" title="${t('全屏')}" aria-label="${t('全屏')}"><span class="panel-layout-icon full"></span></button>
        <button data-layout="half" title="${t('半屏')}" aria-label="${t('半屏')}"><span class="panel-layout-icon half"></span></button>
        <button data-layout="left-quarter" title="${t('左侧四分之一')}" aria-label="${t('左侧四分之一')}"><span class="panel-layout-icon left"></span></button>
        <button data-layout="right-quarter" title="${t('右侧四分之一')}" aria-label="${t('右侧四分之一')}"><span class="panel-layout-icon right"></span></button>
        <button data-layout="close" class="panel-layout-close" title="${t('关闭窗口')}" aria-label="${t('关闭窗口')}"><span class="panel-layout-icon close"></span></button>
    `;
    menu.style.transition = 'none';
    document.body.appendChild(menu);
    const baseZ = Number(panel?.style?.zIndex || getComputedStyle(panel || document.body).zIndex || 10080) || 10080;
    menu.style.zIndex = String(baseZ + 200);
    aiPanelLayoutMenu = menu;
    positionAiPanelLayoutMenu(menu, button, { collapsed: true });
    button.style.opacity = '0';
    menu.style.opacity = '1';
    menu.classList.add('island-animating');
    void menu.offsetWidth;
    requestAnimationFrame(() => {
        menu.style.removeProperty('transition');
        menu.classList.add('island-open');
        positionAiPanelLayoutMenu(menu, button, { collapsed: false });
        window.setTimeout(() => { menu.classList.remove('island-animating'); menu.style.removeProperty('opacity'); }, 540);
    });
    menu.addEventListener('click', (ev) => {
        const item = ev.target.closest?.('[data-layout]');
        if (!item) return;
        const layout = item.dataset.layout;
        if (layout === 'close') { closeAiAssistantPanel(); closeAiPanelLayoutMenu({ instant: true }); return; }
        // Menu collapses independently; the AI surface uses Motion.morph FLIP.
        closeAiPanelLayoutMenu();
        void applyAiPanelLayout(layout, { animate: true });
    });
}
function aiProviderFieldWrap(id, labelText) {
    const el = document.getElementById(id);
    if (!el || el.closest('.form-group')) return;
    const label = Array.from($('#aiProviderForm')?.querySelectorAll(':scope > label') || []).find((x) => x.getAttribute('for') === id || x.nextElementSibling === el || x.textContent.trim() === labelText);
    const group = document.createElement('div');
    group.className = 'form-group';
    if (label) { label.remove(); group.appendChild(label); } else { const l = document.createElement('label'); l.textContent = labelText; group.appendChild(l); }
    el.parentNode.insertBefore(group, el);
    group.appendChild(el);
}
function normalizeAiProviderModalLayout() {
    const labels = {
        aiProviderBaseUrl: 'API Base URL',
        aiProviderApiKey: 'API Key',
        aiProviderApiMode: '接口模式',
        aiProviderModels: t('模型列表'),
        aiProviderDefaultModel: t('默认模型'),
        aiProviderModelUserAgents: t('模型请求 User-Agent（可选，逐模型）'),
        aiProviderOrganization: t('Organization / Project（可选）'),
        aiProviderExtraHeaders: t('额外请求头 JSON（可选）'),
        aiProviderExtraJson: 'response_format / 其他参数 JSON',
    };
    Object.entries(labels).forEach(([id, label]) => aiProviderFieldWrap(id, label));
}
function setupAiPanelChrome() {
    const panel = $('#aiAgentPanel');
    const layoutBtn = panel?.querySelector('[data-ai-agent-layout]');
    const dragHandle = panel?.querySelector('.panel-drag-handle');
    const titleBar = panel?.querySelector('.panel-titlebar, .ai-title-bar');
    let aiPanelDragController = null;
    let aiPanelPhysicsReady = false;

    const bakeAiPanelTransform = () => {
        if (!panel) return;
        const parent = aiPanelParentRect(panel);
        const rect = panel.getBoundingClientRect();
        Object.assign(panel.style, {
            left: `${rect.left - parent.left}px`,
            top: `${rect.top - parent.top}px`,
            right: 'auto',
            bottom: 'auto',
            transform: '',
        });
    };

    const aiPanelDragBounds = () => {
        // Bounds are Motion x/y deltas relative to the baked left/top.
        const parent = aiPanelParentRect(panel);
        const width = panel.offsetWidth || panel.getBoundingClientRect().width;
        const height = panel.offsetHeight || panel.getBoundingClientRect().height;
        const left = parseFloat(panel.style.left) || 0;
        const top = parseFloat(panel.style.top) || 0;
        const minVisible = aiPanelMinVisiblePx(panel);
        return {
            minX: (minVisible - width) - left,
            maxX: (parent.width - minVisible) - left,
            minY: (0) - top,
            maxY: (Math.max(0, parent.height - Math.min(56, height * 0.25))) - top,
        };
    };

    const hardClampDragDelta = (x, y) => {
        const b = aiPanelDragBounds();
        return {
            x: Math.min(b.maxX ?? Infinity, Math.max(b.minX ?? -Infinity, x)),
            y: Math.min(b.maxY ?? Infinity, Math.max(b.minY ?? -Infinity, y)),
        };
    };

    const finishAiPanelPhysicsDrag = (Motion) => {
        // Bake the painted rect first, then clear transform channels. Never
        // re-clamp to a larger minVisible afterward — that was the 图一→图二 jump.
        bakeAiPanelTransform();
        try { Motion?.stop?.(panel, ['x', 'y']); Motion?.set?.(panel, { x: 0, y: 0 }); Motion?.release?.(panel); } catch { /* ignore */ }
        panel.classList.remove('dragging');
        panel.style.willChange = '';
        panel.style.transform = '';
        // Soft safety only (same minVisible as drag bounds — no extra pull-in).
        clampAiPanel(panel);
        updateAiPanelResponsiveState();
        window.setTimeout(() => { aiPanelSuppressLayoutClick = false; }, 320);
    };

    const ensureAiPanelPhysicsDrag = async () => {
        if (!panel || aiPanelPhysicsReady) return true;
        const Motion = await sshKeyMotion._ensure().catch(() => null);
        if (!Motion || sshKeyMotion.failed || typeof Motion.drag !== 'function') return false;
        if (aiPanelDragController?.destroy) {
            try { aiPanelDragController.destroy(); } catch { /* ignore */ }
        }

        // Only the top gray .panel-drag-handle owns physical dragging.
        // The title/content/sidebar/input areas never receive drag listeners.
        aiPanelDragController = Motion.drag(panel, {
            handle: dragHandle,
            activationThreshold: 4,
            // Light rubber only while dragging; release settles to the release
            // point (hard-clamped), not a fatter dock snap.
            rubberband: true,
            decelRate: 0.997,
            preset: 'ui',
            bounds: aiPanelDragBounds,
            // If already past the hard edge (rubber-band), stop there — do not
            // project inertia further on-screen (图一 must not become 图二).
            snap: (tx, ty, ctx) => {
                const b = aiPanelDragBounds();
                const cx = Number(ctx?.x);
                const cy = Number(ctx?.y);
                const pastEdge = Number.isFinite(cx) && (
                    cx < (b.minX ?? -Infinity) - 0.5
                    || cx > (b.maxX ?? Infinity) + 0.5
                    || (Number.isFinite(cy) && (cy < (b.minY ?? -Infinity) - 0.5 || cy > (b.maxY ?? Infinity) + 0.5))
                );
                if (pastEdge) return hardClampDragDelta(cx, cy);
                // Free space: allow inertia projection, still hard-clamped.
                return hardClampDragDelta(tx, ty);
            },
            filter: (e) => {
                if (!e || !dragHandle) return false;
                if (e.button != null && e.button !== 0) return false;
                // Three-dot traffic light is separately wired to precise hard drag.
                if (e.target?.closest?.('[data-ai-agent-layout]')) return false;
                const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
                const fromHandle = path.includes?.(dragHandle)
                    || dragHandle === e.target
                    || dragHandle.contains?.(e.target);
                if (!fromHandle) return false;
                // Nothing interactive inside the gray strip may start physics.
                if (e.target?.closest?.('button, a, input, textarea, select, [role="button"], label')) return false;
                return true;
            },
            onActivate: () => {
                bringAiPanelToFront();
                closeAiPanelLayoutMenu({ instant: true });
                aiPanelSuppressLayoutClick = true;
                panel._suppressHeaderClick = true;
                // Interrupt layout morphs; bake residual transform to left/top.
                try { Motion.stop(panel); } catch { /* ignore */ }
                bakeAiPanelTransform();
                try { Motion.set(panel, { x: 0, y: 0 }); } catch { /* ignore */ }
                panel.classList.add('dragging');
                panel.style.willChange = 'transform';
            },
            onMove: () => {
                // Do not call updateAiPanelResponsiveState while dragging —
                // toggling ai-narrow/sidebar-collapsed mid-gesture resizes
                // content and makes the parked edge strip "pop" wider.
            },
            onEnd: ({ settled }) => {
                if (settled && typeof settled.then === 'function') {
                    settled.then(() => finishAiPanelPhysicsDrag(Motion)).catch(() => finishAiPanelPhysicsDrag(Motion));
                } else {
                    finishAiPanelPhysicsDrag(Motion);
                }
            },
            onCancel: () => {
                // Sub-threshold: leave clicks alone.
                panel.classList.remove('dragging');
            },
        });
        aiPanelPhysicsReady = true;
        return true;
    };

    // Precise 1:1 hard drag from the traffic-light (⋯) only — no rubberband/inertia.
    // Title bar / empty handle strip use Motion.drag physics instead.
    const startAiPanelHardDrag = (e, { suppressLayoutClick = false, threshold = 4 } = {}) => {
        if (!panel) return;
        if (e.button !== undefined && e.button !== 0) return;
        bringAiPanelToFront();
        // Kill any in-flight physics settle so hard drag owns left/top immediately.
        void sshKeyMotion._ensure().then((Motion) => {
            try { Motion?.stop?.(panel); Motion?.set?.(panel, { x: 0, y: 0 }); } catch { /* ignore */ }
        }).catch(() => {});
        bakeAiPanelTransform();
        const sx = e.clientX, sy = e.clientY;
        const sl = panel.offsetLeft, st = panel.offsetTop;
        let dragging = false, raf = 0, lastX = sx, lastY = sy;
        const commit = () => {
            raf = 0;
            panel.style.left = `${sl + lastX - sx}px`;
            panel.style.top = `${st + lastY - sy}px`;
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
            panel.style.transform = '';
            clampAiPanel(panel);
        };
        const move = (ev) => {
            lastX = ev.clientX;
            lastY = ev.clientY;
            const dist = Math.hypot(lastX - sx, lastY - sy);
            if (!dragging && dist > threshold) {
                dragging = true;
                panel.classList.add('dragging');
                panel._suppressHeaderClick = true;
                if (suppressLayoutClick) {
                    aiPanelSuppressLayoutClick = true;
                    closeAiPanelLayoutMenu({ instant: true });
                }
            }
            if (!dragging) return;
            ev.preventDefault();
            if (!raf) raf = requestAnimationFrame(commit);
        };
        const up = () => {
            const wasDragging = dragging;
            if (raf) cancelAnimationFrame(raf);
            if (dragging) commit();
            panel.classList.remove('dragging');
            updateAiPanelResponsiveState();
            if (suppressLayoutClick && wasDragging) {
                window.setTimeout(() => { aiPanelSuppressLayoutClick = false; }, 700);
            }
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
        };
        window.addEventListener('pointermove', move, { passive: false });
        window.addEventListener('pointerup', up, { once: true });
        window.addEventListener('pointercancel', up, { once: true });
    };

    panel?.addEventListener('pointerdown', () => {
        bringAiPanelToFront();
        // Lazy-bind physics on first interaction if engine was still booting.
        void ensureAiPanelPhysicsDrag();
    });
    layoutBtn?.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        layoutBtn.classList.add('pressing');
        // Hold-and-drag on ⋯ = precise hard drag; short click still opens layout menu.
        startAiPanelHardDrag(e, { suppressLayoutClick: true, threshold: 4 });
        const up = () => {
            layoutBtn.classList.remove('pressing');
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
        };
        window.addEventListener('pointerup', up, { once: true });
        window.addEventListener('pointercancel', up, { once: true });
    });
    // Physics drag only for the top gray handle strip. Hard drag remains for ⋯.
    void ensureAiPanelPhysicsDrag().then((ok) => {
        if (ok || !panel) return;
        // Engine unavailable: hard-drag fallback is still limited to gray strip.
        const startFallback = (e) => startAiPanelHardDrag(e, { suppressLayoutClick: false, threshold: 4 });
        panel.querySelector('.panel-drag-handle')?.addEventListener('pointerdown', (e) => {
            if (e.target.closest?.('[data-ai-agent-layout], button, a, input, textarea, select, [role="button"], label')) return;
            startFallback(e);
        });
    });
    panel?.querySelector('.panel-titlebar')?.addEventListener('click', (e) => {
        if (!panel._suppressHeaderClick) return;
        e.preventDefault();
        e.stopPropagation();
        panel._suppressHeaderClick = false;
    }, true);
    panel?.querySelectorAll('[data-ai-agent-resize]').forEach((h) => h.addEventListener('pointerdown', (e) => {
        e.preventDefault(); bringAiPanelToFront(); panel.classList.add('resizing'); h.setPointerCapture?.(e.pointerId);
        const sx = e.clientX, sy = e.clientY, sw = panel.offsetWidth, sh = panel.offsetHeight, sl = panel.offsetLeft, edge = h.dataset.aiAgentResize;
        const parentRect = aiPanelParentRect(panel);
        const compact = window.innerWidth <= 760;
        const minWidth = compact ? 220 : 420, minHeight = compact ? 300 : 420;
        const move = (ev) => { ev.preventDefault(); let nw = sw + ev.clientX - sx, nl = sl; if (edge === 'left') { nw = sw - (ev.clientX - sx); nl = sl + (ev.clientX - sx); if (nw < minWidth) { nl -= minWidth - nw; nw = minWidth; } if (nl < 8) { nw += nl - 8; nl = 8; } panel.style.left = `${nl}px`; } const maxWidth = edge === 'left' ? sl + sw - 8 : parentRect.width - panel.offsetLeft - 12; const maxHeight = parentRect.height - panel.offsetTop - 12; panel.style.width = `${Math.min(Math.max(minWidth, nw), maxWidth)}px`; panel.style.height = `${Math.min(Math.max(minHeight, sh + ev.clientY - sy), maxHeight)}px`; updateAiPanelResponsiveState(); };
        const up = () => { panel.classList.remove('resizing'); updateAiPanelResponsiveState(); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
        window.addEventListener('pointermove', move, { passive: false }); window.addEventListener('pointerup', up, { once: true });
    }));
    if (panel) panel._layoutAnimationTimer = null;
    layoutBtn?.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (aiPanelSuppressLayoutClick) { aiPanelSuppressLayoutClick = false; return; }
        bringAiPanelToFront();
        if (navigator.vibrate) navigator.vibrate(8);
        if (aiPanelLayoutMenu && aiPanelLayoutMenuButton === layoutBtn) closeAiPanelLayoutMenu(); else openAiPanelLayoutMenu(layoutBtn, panel);
    });
    document.addEventListener('pointerdown', (e) => {
        if (aiPanelLayoutMenu && !e.target.closest?.('.panel-layout-menu') && !e.target.closest?.('[data-ai-agent-layout]')) closeAiPanelLayoutMenu();
    });
    window.addEventListener('resize', () => closeAiPanelLayoutMenu({ instant: true }));
}
function updateAiProviderModalHints() {
    const type = $('#aiProviderType')?.value || 'openai-compatible';
    const modeSelect = $('#aiProviderApiMode');
    let mode = modeSelect?.value || 'auto';
    const isOpenAiLike = type === 'openai-compatible' || type === 'openai';
    if (modeSelect) {
        modeSelect.disabled = !isOpenAiLike;
        const shell = modeSelect.closest?.('.ui-toggle-select');
        const trigger = shell?.querySelector?.('.ui-toggle-select-trigger');
        if (trigger) {
            trigger.disabled = !isOpenAiLike;
            trigger.classList.toggle('is-disabled', !isOpenAiLike);
            trigger.setAttribute('aria-disabled', isOpenAiLike ? 'false' : 'true');
        }
    }
    if (!isOpenAiLike && modeSelect) {
        setAiFieldSelectValue('aiProviderApiMode', 'auto');
        mode = 'auto';
    }
    const base = $('#aiProviderBaseUrl');
    const extra = $('#aiProviderExtraJson');
    if (base) {
        base.placeholder = mode === 'responses'
            ? 'https://api.openai.com/v1/responses'
            : type === 'gemini'
                ? 'https://generativelanguage.googleapis.com/v1beta'
                : type === 'anthropic'
                    ? 'https://api.anthropic.com/v1'
                    : 'https://api.openai.com/v1 / https://api.deepseek.com/v1';
    }
    if (extra) {
        extra.placeholder = type === 'anthropic'
            ? '{"thinking":{"type":"adaptive","display":"omitted"},"output_config":{"effort":"medium"}}'
            : type === 'gemini'
                ? '{"thinkingConfig":{"thinkingLevel":"low"}} 或 {"thinkingConfig":{"thinkingBudget":1024}}'
                : mode === 'responses'
                    ? '{"text":{"format":{"type":"json_object"}},"reasoning":{"effort":"medium"}}'
                    : '{"response_format":{"type":"json_object"}}';
    }
}
function setupAiAssistant() {
    normalizeAiProviderModalLayout();
    setupAiPanelChrome();
    $('#aiSettingsForm')?.addEventListener('submit', saveAiSettings);
    $('[data-ai-save-settings]')?.addEventListener('click', saveAiSettings);
    $('#aiAddProviderBtn')?.addEventListener('click', (e) => openAiProviderModal(null, e.currentTarget));
    $('#aiProviderModal')?.addEventListener('click', (e) => { if (e.target.id === 'aiProviderModal') closeAiProviderModal(); });
    $('#aiProviderModalScrim')?.addEventListener('click', () => { if ($('#aiProviderModal')?.classList.contains('show')) closeAiProviderModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#aiProviderModal')?.classList.contains('show')) closeAiProviderModal(); });
    $('#aiProviderForm')?.addEventListener('submit', saveAiProvider);
    $('#aiFetchModelsBtn')?.addEventListener('click', () => fetchAiModelsForProvider());
    // AI 字段选择器已改为真实 <select> + enhanceToggleSelect（与 CAPTCHA 同源）。
    $('#aiProviderType')?.addEventListener('change', () => updateAiProviderModalHints());
    $('#aiProviderApiMode')?.addEventListener('change', () => updateAiProviderModalHints());
    $('#aiProviderModels')?.addEventListener('change', () => renderAiProviderModelCatalog());
    $('#aiProviderModels')?.addEventListener('blur', () => renderAiProviderModelCatalog());
    $('#aiProviderVision')?.addEventListener('change', () => renderAiProviderModelCatalog());
    $('#aiProviderCloseBtn')?.addEventListener('click', closeAiProviderModal);
    $('#aiProviderCancelBtn')?.addEventListener('click', closeAiProviderModal);
    $('#aiModelDetailForm')?.addEventListener('submit', (e) => { saveAiModelDetail(e).catch((err) => toast(err.message || t('保存模型能力失败'))); });
    $('#aiModelDetailCancelBtn')?.addEventListener('click', () => { closeAiModelDetailPage().catch(() => {}); });
    $('#aiModelDetailQuickTestBtn')?.addEventListener('click', () => { quickTestAiModel().catch((err) => toast(err.message || t('快速测试失败'))); });
    $('#aiQuickTestDoneBtn')?.addEventListener('click', () => { closeAiQuickTestPage().catch(() => {}); });
    $('#aiQuickTestRerunBtn')?.addEventListener('click', () => { quickTestAiModel().catch((err) => toast(err.message || t('快速测试失败'))); });
    $('#aiModelsPageBackBtn')?.addEventListener('click', () => { closeAiModelsPage().catch(() => {}); });
    const refreshModels = () => {
        if (!aiModelsPageProviderId) return;
        fetchAiModelsForProvider(aiModelsPageProviderId).then(() => renderAiModelsListPage()).catch((err) => toast(err.message || t('获取模型失败')));
    };
    $('#aiModelsRefreshRow')?.addEventListener('click', refreshModels);
    $('#aiModelsSearchInput')?.addEventListener('input', () => { renderAiModelsListPage(); });
    $('#aiModelsSearchInput')?.addEventListener('search', () => { renderAiModelsListPage(); });
    $('#aiModelsListCard')?.addEventListener('click', (e) => {
        const row = e.target.closest?.('[data-ai-model-open]');
        if (!row) return;
        openAiModelDetailPage({
            providerId: aiModelsPageProviderId,
            modelId: row.dataset.aiModelOpen,
            source: 'provider',
        }).catch((err) => toast(err.message || t('模型不存在')));
    });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if ($('#settingsAiQuickTestPage')?.classList.contains('is-open')) {
            e.preventDefault();
            closeAiQuickTestPage().catch(() => {});
            return;
        }
        if ($('#settingsAiModelDetailPage')?.classList.contains('is-open')) {
            e.preventDefault();
            closeAiModelDetailPage().catch(() => {});
            return;
        }
        if ($('#settingsAiModelsPage')?.classList.contains('is-open')) {
            e.preventDefault();
            closeAiModelsPage().catch(() => {});
        }
    });
    $('#aiProviderList')?.addEventListener('click', (e) => {
        const openModels = e.target.closest?.('[data-ai-open-models]');
        if (openModels) {
            openAiModelsPage(openModels.dataset.aiOpenModels, openModels).catch((err) => toast(err.message || t('供应商不存在')));
            return;
        }
        const action = e.target.closest?.('[data-ai-fetch-provider-models],[data-ai-reveal-provider-key],[data-ai-edit-provider],[data-ai-delete-provider]');
        if (!action) return;
        const edit = action.dataset.aiEditProvider, del = action.dataset.aiDeleteProvider, fetchModels = action.dataset.aiFetchProviderModels, reveal = action.dataset.aiRevealProviderKey;
        const ai = normalizeAiSettings(settings.ai || {});
        if (fetchModels) fetchAiModelsForProvider(fetchModels);
        if (reveal) revealAiProviderKey(reveal, action).catch((err) => toast(err.message || '读取 API Key 失败'));
        if (edit) openAiProviderModal(ai.providers.find((p) => p.id === edit), action);
        if (del) deleteAiProvider(del);
    });
    $('#aiEnvForm')?.addEventListener('submit', saveAiEnv);
    $('#aiEnvResetBtn')?.addEventListener('click', resetAiEnvForm);
    $('#toggleAiEnvValue')?.addEventListener('click', () => { const el = $('#aiEnvValue'); el.type = el.type === 'password' ? 'text' : 'password'; $('#toggleAiEnvValue').textContent = el.type === 'password' ? '👁️' : '🙈'; });
    $('#aiEnvList')?.addEventListener('click', (e) => { const edit = e.target.dataset.aiEditEnv, del = e.target.dataset.aiDeleteEnv; const ai = normalizeAiSettings(settings.ai || {}); if (edit) { const item = ai.envVars.find((x) => x.id === edit); if (!item) return; $('#aiEnvId').value = item.id; $('#aiEnvName').value = item.name || ''; $('#aiEnvDescription').value = item.description || ''; $('#aiEnvValue').value = item.hasValue || item.value ? '******' : ''; $('#aiEnvEnabled').checked = item.enabled !== false; $('#aiEnvVisibleToAi').checked = item.visibleToAi === true; $('#aiEnvValueVisibleToAi').checked = item.valueVisibleToAi === true; } if (del) deleteAiEnv(del); });
    $('#aiMemoryForm')?.addEventListener('submit', saveAiMemory);
    $('#aiMemoryResetBtn')?.addEventListener('click', resetAiMemoryForm);
    $('#aiMemoryList')?.addEventListener('click', (e) => { const edit = e.target.dataset.aiEditMemory, del = e.target.dataset.aiDeleteMemory; const ai = normalizeAiSettings(settings.ai || {}); if (edit) { const item = ai.memories.find((x) => x.id === edit); if (!item) return; $('#aiMemoryId').value = item.id; $('#aiMemoryTitle').value = item.title || ''; $('#aiMemoryScope').value = item.scope || item.project || ''; $('#aiMemoryConnectionIds').value = (Array.isArray(item.connectionIds) ? item.connectionIds : splitCsv(item.connectionIds)).join(', '); $('#aiMemoryTags').value = (Array.isArray(item.tags) ? item.tags : splitCsv(item.tags)).join(', '); $('#aiMemoryContent').value = item.content || ''; $('#aiMemoryItemEnabled').checked = item.enabled !== false; } if (del) deleteAiMemory(del); });
    $('#aiPlanList')?.addEventListener('click', (e) => {
        const pause = e.target.dataset.aiPlanPause, resume = e.target.dataset.aiPlanResume, retry = e.target.dataset.aiPlanRetry, delPlan = e.target.dataset.aiPlanDelete, stepPlan = e.target.dataset.aiPlanStep;
        if (pause) updateAiPlan(pause, { pause: true, note: '用户在设置页暂停计划' });
        if (resume) updateAiPlan(resume, { resume: true, note: '用户在设置页继续计划' });
        if (retry) updateAiPlan(retry, { retryFailed: true, note: '用户在设置页重试失败步骤' });
        if (delPlan) deleteAiPlan(delPlan);
        if (stepPlan) updateAiPlan(stepPlan, { steps: [{ index: Number(e.target.dataset.stepIndex), status: e.target.dataset.stepStatus }] });
    });
    $('#aiSkillForm')?.addEventListener('submit', saveAiSkill);
    $('#aiMcpForm')?.addEventListener('submit', saveAiMcpFromForm);
    $('#aiMcpResetBtn')?.addEventListener('click', resetAiMcpForm);
    bindAiSegmentControls(document);
    document.addEventListener('click', (e) => {
        const segBtn = e.target.closest?.('.ai-segment-btn');
        if (!segBtn) return;
        const root = segBtn.closest?.('.ai-segment');
        if (!root) return;
        e.preventDefault();
        setAiSegmentValue(root, segBtn.dataset.value);
    });
    $('#aiMcpList')?.addEventListener('click', (e) => {
        const edit = e.target.closest?.('[data-ai-mcp-edit]')?.dataset.aiMcpEdit;
        const del = e.target.closest?.('[data-ai-mcp-del]')?.dataset.aiMcpDel;
        const ai = normalizeAiSettings(settings.ai || {});
        if (edit) fillAiMcpForm((ai.mcpServers || []).find((x) => x.id === edit));
        if (del) {
            // craft confirm card instead of window.confirm
            openAiInlineConfirm({
                title: t('删除 MCP 服务器'),
                body: t('删除后需重新配置才能连接该 MCP。'),
                confirmLabel: t('删除'),
                danger: true,
                onConfirm: () => deleteAiMcp(del).catch((err) => toast(err.message)),
            });
        }
    });
    $('#aiSkillResetBtn')?.addEventListener('click', resetAiSkillForm);
    $('#aiSkillList')?.addEventListener('click', (e) => { const edit = e.target.dataset.aiEditSkill, del = e.target.dataset.aiDeleteSkill; const ai = normalizeAiSettings(settings.ai || {}); if (edit) { const s = ai.skills.find((x) => x.id === edit); if (!s || s.builtin) return; $('#aiSkillId').value = s.id; $('#aiSkillName').value = s.name || ''; $('#aiSkillDescription').value = s.description || ''; $('#aiSkillPrompt').value = s.prompt || ''; $('#aiSkillEnabled').checked = s.enabled !== false; } if (del) deleteAiSkill(del); });
    $('#openAiAssistantBtn')?.addEventListener('click', (e) => openAiAssistantPanel(e.currentTarget)); $('#openAiAssistantBtn2')?.addEventListener('click', (e) => openAiAssistantPanel(e.currentTarget));
    $('#aiNavTab')?.addEventListener('click', (e) => { e.preventDefault(); openAiAssistantPanel(e.currentTarget); });
    $('#aiFloatingBtn')?.addEventListener('click', (e) => toggleAiAssistantPanel(e.currentTarget));
    $('#aiJumpSettingsBtn')?.addEventListener('click', () => { switchView('settings'); document.querySelector('.settings-tab[data-settings="ai"]')?.click(); });
    $('#aiClosePanelBtn')?.addEventListener('click', closeAiAssistantPanel); $('#aiNewChatBtn')?.addEventListener('click', () => createAiChat());
    $('#aiChatList')?.addEventListener('click', (e) => { const del = e.target.closest?.('[data-ai-delete-chat]')?.dataset.aiDeleteChat; if (del) { e.preventDefault(); e.stopPropagation(); deleteAiChat(del); return; } const id = e.target.closest?.('[data-ai-chat]')?.dataset.aiChat || e.target.closest?.('[data-ai-chat-row]')?.dataset.aiChatRow; if (id) { cancelAiMessageEdit({ focus: false }); aiCurrentSessionId = id; saveAiChats(); renderAiChat(); } });
    $('#aiSendBtn')?.addEventListener('click', () => { if (aiIsSessionRunning(aiCurrentSessionId)) stopAiResponse(aiCurrentSessionId); else sendAiMessage(); });
    $('#aiCancelEditBtn')?.addEventListener('click', () => cancelAiMessageEdit());
    $('#aiUserInput')?.addEventListener('input', (e) => { autoResizeAiInput(e.target); updateAiInputPreview(); });
    $('#aiUserInput')?.addEventListener('keydown', (e) => { if (e.key === 'Escape' && aiEditingMessageIndex >= 0) { e.preventDefault(); cancelAiMessageEdit(); return; } if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendAiMessage(); } });
    // Markdown preview toggle removed; messages are rendered as Markdown directly.
    $('#aiClearChatBtn')?.addEventListener('click', () => { cancelAiMessageEdit({ focus: false }); clearCurrentAiChat().catch((error) => { toast(error.message || t('清空对话失败')); scheduleAiHistoryReload(0); }); });
    $('#aiCompressChatBtn')?.addEventListener('click', () => { const s = aiCurrentSession(); if (aiIsSessionRunning(s?.id)) return toast(t('请先停止当前对话的 AI 回复')); if (s.messages.length > 2) s.messages = [{ role: 'system', content: `历史已压缩：此前共有 ${s.messages.length} 条消息。` }, s.messages[s.messages.length - 1]]; renderAiChat(); });
    $('#aiProviderPickerBtn')?.addEventListener('click', (e) => openAiPicker('provider', e.currentTarget));
    $('#aiModelPickerBtn')?.addEventListener('click', (e) => openAiPicker('model', e.currentTarget));
    $('#aiThinkPickerBtn')?.addEventListener('click', (e) => openAiPicker('thinking', e.currentTarget));
    $('#aiUsageBtn')?.addEventListener('click', (e) => { e.stopPropagation(); openAiUsageSheet(null, e.currentTarget); });
    document.addEventListener('click', (e) => {
        const option = e.target.closest?.('.ai-picker-option');
        if (option) {
            applyAiPickerChoice(option.dataset.kind, option.dataset.value || '');
            return;
        }
        if (!e.target.closest?.('.ai-picker-popover,.ai-picker-btn')) closeAiPickerPopover();
        if (!e.target.closest?.('.ai-usage-popover,#aiUsageBtn')) {
            const usage = document.querySelector('.ai-usage-popover');
            if (typeof usage?._closeAiUsage === 'function') usage._closeAiUsage();
            else usage?.remove();
        }
    }, true);
    $('#aiBrowserPreviewToggleBtn')?.addEventListener('click', () => { const state = aiBrowserPreviewStateForSession(aiCurrentSessionId); state.visible = !state.visible; renderAiBrowserPreview(); });
    $('#aiBrowserPreviewRefreshBtn')?.addEventListener('click', refreshAiBrowserPreview);
    $('#aiRefreshStatusBtn')?.addEventListener('click', async () => { const r = await api('/api/ai/status'); settings.ai = normalizeAiSettings(r.ai || {}); renderAiSettingsForm(); toast(t('AI 配置已刷新')); });
    $('#aiChatArea')?.addEventListener('click', handleAiChatAreaClick);
    $('#aiChatArea')?.addEventListener('contextmenu', handleAiMessageContextMenu);
    $('#aiChatArea')?.addEventListener('touchstart', handleAiMessageTouchStart, { passive: true });
    $('#aiChatArea')?.addEventListener('touchend', clearAiMessageTouchTimer);
    $('#aiChatArea')?.addEventListener('touchcancel', clearAiMessageTouchTimer);
    const handleAiMessageMenuClick = (e) => {
        const menu = $('#aiMessageContextMenu');
        if (!menu || menu.classList.contains('hidden')) return;
        const action = e.target.closest?.('[data-ai-msg-action]')?.dataset.aiMsgAction;
        if (action) { handleAiMessageMenuAction(action); return; }
        if (!menu.contains(e.target)) hideAiMessageMenu();
    };
    const handleAiMessageMenuPointerDown = (e) => {
        const menu = $('#aiMessageContextMenu');
        if (!menu || menu.classList.contains('hidden')) return;
        if (!menu.contains(e.target)) hideAiMessageMenu();
    };
    document.addEventListener('pointerdown', handleAiMessageMenuPointerDown, { capture: true });
    document.addEventListener('click', handleAiMessageMenuClick, { capture: true });
    document.addEventListener('contextmenu', (e) => {
        const menu = $('#aiMessageContextMenu');
        if (!menu || menu.classList.contains('hidden')) return;
        if (!menu.contains(e.target) && !e.target.closest?.('.ai-message')) hideAiMessageMenu();
    }, { capture: true });
    $('#aiUploadBtn')?.addEventListener('click', () => $('#aiFileUpload').click());
    $('#aiFileUpload')?.addEventListener('change', (e) => { const files = Array.from(e.target.files || []); if (!files.length) return; appendAiFiles(files).catch((err) => toast(err.message || '附件读取失败')).finally(() => { e.target.value = ''; }); });
    $('#aiInputPreview')?.addEventListener('click', (e) => { const btn = e.target.closest?.('[data-ai-remove-attachment]'); if (!btn) return; aiPendingInputAttachments.splice(Number(btn.dataset.aiRemoveAttachment || -1), 1); updateAiAttachmentDraftUi(); });
    window.addEventListener('resize', () => { updateAiPanelResponsiveState(); if (aiPanelState === 'open') startAiPanelWatchdog(); });
    window.visualViewport?.addEventListener('resize', () => { updateAiPanelResponsiveState(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && aiPanelState === 'open') startAiPanelWatchdog(); });
}

function renderRemoteServers() { const ssh = connections.filter((c) => c.protocol === 'SSH'); $('#remoteServerList').innerHTML = ssh.length ? ssh.map((c) => `<label class="server-check"><input type="checkbox" value="${c.id}"> <span>${escapeHtml(c.name)}</span><em>${escapeHtml(c.host)}</em></label>`).join('') : `<div class="empty-card">${t('暂无 SSH 连接')}</div>`; }
async function remoteExecute(e) { e.preventDefault(); const ids = $$('#remoteServerList input:checked').map((i) => i.value); try { $('#remoteResults').innerHTML = `<div class="empty-card">${t('执行中...')}</div>`; const data = await api('/api/remote-execute', { method: 'POST', body: JSON.stringify({ connectionIds: ids, command: $('#remoteCommand').value, timeoutSeconds: Number($('#remoteTimeout').value) || 30 }) }); $('#remoteResults').innerHTML = data.results.map((r) => `<article class="result-card ${r.success ? 'ok' : 'fail'}"><h3>${escapeHtml(r.name)} <span>${escapeHtml(r.status)} · ${r.durationMs}ms</span></h3>${r.error ? `<p class="error-text">${escapeHtml(r.error)}</p>` : ''}<pre>${escapeHtml(r.stdout || '')}</pre>${r.stderr ? `<pre class="stderr">${escapeHtml(r.stderr)}</pre>` : ''}</article>`).join(''); await loadConnections(); } catch (err) { toast(err.message); } }

async function savePersonalSettings(patch) {
    settingsLoadGeneration += 1;
    const result = await api('/api/me/settings', { method: 'PUT', body: JSON.stringify(patch) });
    personalSettingsOverrides = result.overrides || personalSettingsOverrides;
    return result.settings || settings;
}

async function savePlatformSettings(section, patch) {
    settingsLoadGeneration += 1;
    const result = await api(`/api/settings/${encodeURIComponent(section)}`, { method: 'PUT', body: JSON.stringify(patch) });
    return { ...settings, ...result, _admin: result };
}

function applyAgentReleaseLinks(agentRelease) {
    const rel = agentRelease && typeof agentRelease === 'object' ? agentRelease : {};
    const fallbackUrl = 'https://github.com/Lanlan13-14/zephyr-ssh/releases';
    const url = String(rel.url || fallbackUrl).trim() || fallbackUrl;
    const tag = String(rel.tag || '').trim();
    const display = String(rel.display || '').trim() || (tag ? tag.replace(/^agent-/, '') : '');
    const available = rel.available === true || Boolean(tag && rel.url);
    const label = available
        ? t('下载 Zephyr Agent {version}', { version: display || tag })
        : t('查看 Zephyr Agent 发布页');
    const hint = available
        ? t('当前镜像绑定最新 Agent Release：{tag}', { tag: `<code>${escapeHtml(tag || display)}</code>` })
        : t('尚未解析到 agent-v* Release；构建镜像时会自动拉取最新标签。').replace('agent-v*', '<code>agent-v*</code>');

    for (const id of ['aboutAgentReleaseLink', 'agentReleaseLink']) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.href = url;
        el.textContent = label;
        el.target = '_blank';
        el.rel = 'noopener noreferrer';
    }
    const hintEl = document.getElementById('agentReleaseHint');
    if (hintEl) hintEl.innerHTML = hint;
}

async function loadSettings() {
    const generation = ++settingsLoadGeneration;
    const personal = await api('/api/me/settings');
    const nextPersonalSettingsOverrides = personal.overrides || {};
    let nextSettings = personal.settings || {};
    if (myIdentity.isSuperAdmin) {
        const admin = await api('/api/settings/admin');
        nextSettings = {
            ...admin,
            ...nextSettings,
            appearance: { ...(admin.appearance || {}), ...(nextSettings.appearance || {}) },
            terminal: { ...(admin.terminal || {}), ...(nextSettings.terminal || {}) },
            workspace: { ...(admin.workspace || {}), ...(nextSettings.workspace || {}) },
            ai: { ...(admin.ai || {}), ...(nextSettings.ai || {}) },
            mail: { ...(admin.mail || {}), ...(nextSettings.mail || {}) },
            // Personal notes.enabled must win over platform default (same as /api/me/settings).
            notes: { ...(admin.notes || {}), ...(nextSettings.notes || {}) },
            _admin: admin,
        };
    }
    const aiProvidersData = await api('/api/ai/providers').catch(() => null);
    if (aiProvidersData?.providers) {
        nextSettings.ai = { ...(nextSettings.ai || {}), providers: aiProvidersData.providers };
    }
    if (generation !== settingsLoadGeneration) return settings;
    personalSettingsOverrides = nextPersonalSettingsOverrides;
    settings = nextSettings;
    const sec = settings.security || {}, cap = settings.captcha || {}, mail = settings.mail || {}, beian = settings.beian || {};
    $('#versionText').textContent = settings.version || '--';
    applyAgentReleaseLinks(settings.agentRelease);
    $('#icpInput').value = beian.icp ?? settings.icp ?? ''; $('#icpUrlInput').value = beian.icpUrl ?? settings.icpUrl ?? ''; $('#policeInput').value = beian.policeBeian ?? settings.policeBeian ?? ''; $('#policeUrlInput').value = beian.policeBeianUrl ?? settings.policeBeianUrl ?? ''; $('#showBeianInput').checked = (beian.show ?? settings.showBeian) !== false;
    setChecked('#ipWhitelistEnabled', !!sec.ipWhitelistEnabled); setVal('#ipWhitelist', sec.ipWhitelist || ''); setChecked('#bruteForceEnabled', sec.bruteForceEnabled !== false); setVal('#bruteForceMaxFailures', sec.bruteForceMaxFailures || 5); setVal('#bruteForceBanMinutes', sec.bruteForceBanMinutes || 15);
    setChecked('#captchaEnabled', !!cap.enabled); setVal('#captchaProvider', cap.provider || 'turnstile'); setVal('#captchaSiteKey', cap.siteKey || cap.tencentCaptchaAppId || cap.aliyunCaptchaId || cap.aliyunSceneId || ''); setVal('#captchaSecretKey', cap.secretKey || cap.tencentAppSecretKey || cap.aliyunAccessKeySecret || '');
    $('#mailEnabled').checked = !!mail.enabled; $('#mailHost').value = mail.host || ''; $('#mailPort').value = mail.port || 465; $('#mailSecure').checked = mail.secure !== false; $('#mailUser').value = mail.user || ''; $('#mailPass').value = mail.pass || ''; $('#mailFrom').value = mail.from || ''; $('#mailAdminEmail').value = mail.adminEmail || ''; $('#notifyLoginSuccess').checked = mail.notifyLoginSuccess !== false; $('#notifyLoginFailure').checked = mail.notifyLoginFailure !== false; $('#notifyLoginToUser').checked = mail.notifyLoginToUser !== false; $('#geoLookupEnabled').checked = mail.geoLookupEnabled !== false;
    setChecked('#notifyLoginPersonal', personalSettingsOverrides?.mail?.notifyLogin !== false);
    settings.workspace = { sessionPersistence: true, ...(settings.workspace || {}) };
    try {
        if (isSessionPersistenceEnabled()) localStorage.removeItem('zephyr.sessionPersistence.disabled');
        else localStorage.setItem('zephyr.sessionPersistence.disabled', '1');
    } catch {}
    if ($('#sessionPersistenceEnabled')) $('#sessionPersistenceEnabled').checked = isSessionPersistenceEnabled();
    $('#terminalMaxWindows').value = String(getConfiguredTerminalMaxWindows());
    if ($('#terminalAllowLigatures')) $('#terminalAllowLigatures').checked = !!(settings?.terminal?.allowLigatures);
    $('#terminalMinimizedKeepAlive').value = String(getConfiguredMinimizedKeepAlive());
    $('#terminalSmartbarOrder').value = getTerminalSmartbarOrder();
    $('#terminalShortcutPlatform').value = getTerminalShortcutPlatform();
    settings.appearance = { brandName: defaultBrandName(), brandIcon: DEFAULT_BRAND_ICON, theme: 'auto', autoThemeEnabled: true, colorScheme: 'frost', customThemeMode: 'dark', customColors: normalizeCustomThemeColors(), customCss: '', customJs: '', terminalBackground: { type: 'none', url: '', fit: 'cover', opacity: 0.35, blur: 0 }, terminalFontColor: '', terminalFontColors: { dark: '', light: '' }, terminalSolidBgColors: { dark: '', light: '' }, terminalSelection: { bg: { dark: '', light: '' }, fg: { dark: '', light: '' } }, ...(settings.appearance || {}) };
    settings.ai = normalizeAiSettings(settings.ai || {});
    applyAppearance(settings.appearance);
    applyTheme(getPreferredTheme());
    renderAiSettingsForm();
    renderNotesToggle();
    await loadSecurityStatus(); await loadSecurityLists(); loadWebDavSettings();
    // Settings values filled into native selects — refresh toggle faces / wrap new ones.
    enhanceAllToggleSelects();
    TOGGLE_SELECT_IDS.forEach((id) => {
        const el = document.getElementById(id);
        if (el) syncToggleSelectFace(el);
    });
    /* 空闲预热动画引擎：懒加载会让首次展开先静态弹出、引擎就绪后再补一遍
     * FLIP（首次与后续动画不一致）。预热后首次点击即与后续完全一致。 */
    const warmSelectMotion = () => sshKeyMotion._ensure();
    if ('requestIdleCallback' in window) window.requestIdleCallback(warmSelectMotion, { timeout: 4000 });
    else window.setTimeout(warmSelectMotion, 2000);
}

function isNotesEnabled() {
    return !!(settings.notes && settings.notes.enabled);
}

function broadcastNotesEnabled(enabled = isNotesEnabled()) {
    $$('#terminalWorkspace iframe.terminal-frame').forEach((frame) => {
        try {
            frame.contentWindow?.postMessage({
                source: 'zephyr-app',
                type: 'notes-enabled',
                enabled: !!enabled,
            }, '*');
        } catch (_) {}
    });
}

function renderNotesToggle() {
    // Notes is opt-in (FREEZE plan §6.1): the nav tab only appears when an
    // admin (or the user override) enables it. Default off.
    const notesEnabled = isNotesEnabled();
    const navTab = document.getElementById('notesNavTab');
    if (navTab) navTab.classList.toggle('force-hidden', !notesEnabled);
    const settingsCheckbox = document.getElementById('notesEnabledInput');
    if (settingsCheckbox) settingsCheckbox.checked = notesEnabled;
    if (!notesEnabled && document.querySelector('.nav-tab.active')?.dataset.view === 'notes') {
        switchView('dashboard');
    }
    broadcastNotesEnabled(notesEnabled);
}

async function saveNotesSettings(e) {
    e.preventDefault();
    const enabled = !!document.getElementById('notesEnabledInput')?.checked;
    try {
        // Always persist the personal opt-in (toast says "当前用户"; USER_ALLOWED_KEYS has notes.enabled).
        // Admin-only platform write was wrong: it never wrote user_settings, and superadmin
        // loadSettings used to drop personal notes when re-merging /api/settings/admin.
        if (myIdentity.role === 'admin') {
            // Platform default so new accounts inherit the policy; failures must not
            // block the personal override that actually controls this session.
            await api('/api/settings/notes', {
                method: 'PUT',
                body: JSON.stringify({ notes: { enabled } }),
            }).catch((err) => {
                console.warn('[notes-settings] platform default save failed', err);
            });
        }
        settings = await savePersonalSettings({ notes: { enabled } });
        settings.notes = { ...(settings.notes || {}), enabled: !!(settings.notes && settings.notes.enabled) };
        renderNotesToggle();
        toast(enabled ? '已为当前用户开启笔记功能' : '已为当前用户关闭笔记功能');
    } catch (err) {
        toast(err?.message || t('保存失败'));
    }
}
async function savePersonalLoginNotification() {
    const enabled = !!$('#notifyLoginPersonal')?.checked;
    settings = await savePersonalSettings({ mail: { notifyLogin: enabled } });
    toast(enabled ? '已开启个人登录邮件通知' : '已关闭个人登录邮件通知');
}
async function setSessionPersistenceEnabled(enabled) {
    settings = await savePersonalSettings({ workspace: { sessionPersistence: !!enabled } });
    settings.workspace = { ...(settings.workspace || {}), sessionPersistence: !!enabled };
    try {
        if (enabled) localStorage.removeItem('zephyr.sessionPersistence.disabled');
        else localStorage.setItem('zephyr.sessionPersistence.disabled', '1');
    } catch {}
    if ($('#sessionPersistenceEnabled')) $('#sessionPersistenceEnabled').checked = isSessionPersistenceEnabled();
    broadcastTerminalSettings(settings.terminal || {}, settings.workspace || {});
    if (enabled) {
        workspaceReady = true;
        rememberLastAppView(currentAppView);
        await saveWorkspaceNow({ reason: 'session-persistence-enabled' });
        toast(t('会话持久化已开启'));
        return;
    }
    clearTimeout(workspaceSaveTimer);
    workspaceSaveTimer = null;
    workspaceRevision = null;
    try { sessionStorage.removeItem(TERMINAL_SNAPSHOT_STORAGE_KEY); } catch {}
    try { localStorage.removeItem('zephyr.lastView'); } catch {}
    try {
        await api(`/api/me/workspaces/${encodeURIComponent(automaticWorkspaceId())}`, { method: 'DELETE' });
    } catch (err) {
        if (err.status !== 404) console.warn('[workspace-persistence]', 'failed to delete saved automatic workspace', err);
    }
    toast(t('会话持久化已关闭'));
}
async function saveBeian(e) { e.preventDefault(); settings = await savePlatformSettings('beian', { beian: { icp: $('#icpInput').value, icpUrl: $('#icpUrlInput').value, policeBeian: $('#policeInput').value, policeBeianUrl: $('#policeUrlInput').value, show: $('#showBeianInput').checked } }); toast(t('备案信息已保存')); }
async function loadSecurityStatus() { securityStatus = await api('/api/security/status').catch(() => ({ user: {}, passkeys: [] })); setVal('#profileUsername', securityStatus.user.username || ''); setVal('#profileEmail', securityStatus.user.email || ''); renderTotp(); renderPasskeys(); }
async function loadSecurityLists() {
    const loginPath = myIdentity.isSuperAdmin ? '/api/security/login-events' : '/api/security/login-events/mine';
    const [banData, eventData] = await Promise.all([
        myIdentity.isSuperAdmin ? api('/api/security/ip-bans') : Promise.resolve({ bans: [] }),
        api(loginPath).catch(() => ({ events: [] })),
    ]);
    ipBans = banData.bans || [];
    loginEvents = eventData.events || [];
    renderSecurityLists();
}
function renderTotp() { if (!$('#totpBox')) return; $('#totpBox').innerHTML = securityStatus.user.totpEnabled ? `<div class="mini-item"><b>${t('TOTP 状态')}</b><span>${t('已开启')}</span></div>` : `<p class="muted">${t('暂无 TOTP')}</p>`; $('#totpAction').innerHTML = `<button class="security-card-action" id="setupTotpBtn" type="button">${securityStatus.user.totpEnabled ? t('重新绑定') : t('开启 TOTP')}</button>`; $('#totpDisableForm').classList.toggle('force-hidden', !securityStatus.user.totpEnabled); updatePasswordFormFields(); }
function updatePasswordFormFields() {
    const usingTotp = !!securityStatus.user?.totpEnabled;
    const hasEmail = !!(securityStatus.user?.email);
    const totpRow = $('#settingsTotpRow');
    const emailRow = $('#settingsEmailCodeRow');
    if (totpRow) totpRow.classList.toggle('force-hidden', !usingTotp);
    /* Email code shown whenever user has email (both TOTP-on and TOTP-off).
     * Only hidden when no email at all. */
    if (emailRow) emailRow.classList.toggle('force-hidden', !hasEmail);
    /* Policy hint: mirror the server-side factor matrix so users know what a
     * change will require before submitting (and notice the degraded mode). */
    const hint = $('#passwordPolicyHint');
    if (hint) {
        if (usingTotp && hasEmail) hint.textContent = t('当前账号已开启 TOTP 并绑定邮箱：修改密码需要当前密码 + TOTP 动态码 + 邮箱验证码。');
        else if (usingTotp) hint.textContent = t('当前账号已开启 TOTP：修改密码需要当前密码 + TOTP 动态码。');
        else if (hasEmail) hint.textContent = t('当前账号已绑定邮箱：修改密码需要当前密码 + 邮箱验证码。');
        else hint.textContent = t('当前账号未开启 TOTP 且未绑定邮箱：仅验证当前密码。建议开启 TOTP 或绑定邮箱以提升安全性。');
    }
}
/* Post-change notification dialog. Email-bound accounts only get a pointer to
 * the mailbox (the rollback link travels by email); accounts without email get
 * the link in-app — the only remaining notification channel. */
function openPasswordChangedModal({ notifiedByEmail, rollbackUrl, rollbackExpiresAt } = {}) {
    const modal = $('#passwordChangedModal');
    if (!modal) return;
    const emailHint = $('#passwordChangedEmailHint');
    const linkBox = $('#passwordChangedLinkBox');
    const urlInput = $('#passwordChangedRollbackUrl');
    const expiry = $('#passwordChangedExpiry');
    const showEmail = !!notifiedByEmail;
    if (emailHint) emailHint.classList.toggle('force-hidden', !showEmail);
    if (linkBox) linkBox.classList.toggle('force-hidden', showEmail);
    if (!showEmail) {
        if (urlInput) urlInput.value = rollbackUrl || '';
        if (expiry) expiry.textContent = rollbackExpiresAt ? t('有效期至：{time}', { time: formatDateTime(Number(rollbackExpiresAt)) }) : '';
    }
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    $('#passwordChangedOkBtn')?.focus();
}
function closePasswordChangedModal() {
    const modal = $('#passwordChangedModal');
    if (!modal || !modal.classList.contains('show')) return;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    /* Never keep the one-time link in the DOM once dismissed. */
    const urlInput = $('#passwordChangedRollbackUrl');
    if (urlInput) urlInput.value = '';
}
function renderPasskeys() { if (!$('#passkeyList')) return; $('#passkeyList').innerHTML = (securityStatus.passkeys || []).map((p) => `<div class="mini-item"><b>Passkey</b><span>${fmtTime(p.createdAt)}</span><button data-del-passkey="${p.id}">${t('删除')}</button></div>`).join('') || `<p class="muted">${t('暂无 Passkey')}</p>`; }
function renderSecurityLists() { if (!$('#ipBanList')) return; $('#ipBanList').innerHTML = ipBans.map((b) => `<div class="mini-item"><b>${escapeHtml(b.ip)}</b><span>${t('失败')} ${b.failedCount} · ${t('解封')} ${fmtTime(b.bannedUntil)}</span><button data-unban="${escapeHtml(b.ip)}">${t('解除')}</button></div>`).join('') || `<p class="muted">${t('暂无封禁 IP')}</p>`; $('#loginEventList').innerHTML = loginEvents.slice(0, 20).map((e) => `<div class="mini-item"><b>${e.success ? t('成功') : t('失败')} · ${escapeHtml(e.username || '-')}</b><span>${escapeHtml(e.ip || '')} · ${escapeHtml(e.reason ? t(e.reason) : '')} · ${fmtTime(e.time)}</span></div>`).join('') || `<p class="muted">${t('暂无登录事件')}</p>`; }
async function saveSecurityPolicy(e) { e.preventDefault(); if (!$('#securityPolicyForm')) return; settings = await savePlatformSettings('security', { security: { ipWhitelistEnabled: $('#ipWhitelistEnabled').checked, ipWhitelist: $('#ipWhitelist').value, bruteForceEnabled: $('#bruteForceEnabled').checked, bruteForceMaxFailures: Number($('#bruteForceMaxFailures').value) || 5, bruteForceBanMinutes: Number($('#bruteForceBanMinutes').value) || 15 } }); toast(t('安全策略已保存')); }
async function saveCaptcha(e) {
    e.preventDefault();
    if (!$('#captchaForm')) return;
    const provider = $('#captchaProvider').value;
    const siteKey = $('#captchaSiteKey').value.trim();
    const secretKey = $('#captchaSecretKey').value.trim();
    const captcha = {
        enabled: $('#captchaEnabled').checked,
        provider,
        siteKey,
        secretKey,
        tencentCaptchaAppId: provider === 'tencent' ? siteKey : '',
        tencentAppSecretKey: provider === 'tencent' ? secretKey : '',
        aliyunCaptchaId: provider === 'aliyun' ? siteKey : '',
        aliyunSceneId: provider === 'aliyun' ? siteKey : '',
        aliyunAccessKeySecret: provider === 'aliyun' ? secretKey : ''
    };
    console.debug('[captcha-client]', 'save captcha settings', { provider, enabled: captcha.enabled, hasSiteKey: !!siteKey, hasSecretKey: !!secretKey });
    settings = await savePlatformSettings('captcha', { captcha });
    toast(t('CAPTCHA 已保存'));
}
async function revealCaptchaSecret() {
    if (!$('#captchaSecretKey')) return;
    const secret = await requestSensitiveSecret(t('查看已保存 CAPTCHA 密钥'));
    const data = await api('/api/settings/captcha/open', { method: 'POST', body: JSON.stringify({ secret }) });
    $('#captchaSecretKey').value = data.secretKey || '';
    $('#captchaSecretKey').type = 'text';
    $('#toggleCaptchaSecret').textContent = '🙈';
    console.debug('[captcha-client]', 'captcha secret loaded', { provider: data.provider, hasSecretKey: !!data.hasSecretKey });
    toast(data.hasSecretKey ? '已载入保存的 CAPTCHA 密钥' : '当前未保存 CAPTCHA 密钥');
}
async function saveMail(e) {
    e.preventDefault();
    try {
        settings = await savePlatformSettings('mail', { mail: { enabled: $('#mailEnabled').checked, host: $('#mailHost').value.trim(), port: Number($('#mailPort').value) || 465, secure: $('#mailSecure').checked, user: $('#mailUser').value.trim(), pass: $('#mailPass').value, from: $('#mailFrom').value.trim(), adminEmail: $('#mailAdminEmail').value.trim(), notifyLoginSuccess: $('#notifyLoginSuccess').checked, notifyLoginFailure: $('#notifyLoginFailure').checked, notifyLoginToUser: $('#notifyLoginToUser').checked, geoLookupEnabled: $('#geoLookupEnabled').checked } });
        $('#mailPass').type = 'password';
        $('#toggleMailPassword').textContent = '👁️';
        toast(t('邮件设置已保存'));
    } catch (err) {
        toast(err.message || '邮件设置保存失败');
    }
}
async function revealMailPass() {
    const secret = await requestSensitiveSecret(t('查看已保存 SMTP 密码'));
    const data = await api('/api/settings/mail/open', { method: 'POST', body: JSON.stringify({ secret }) });
    $('#mailPass').value = data.pass || '';
    $('#mailPass').type = 'text';
    $('#toggleMailPassword').textContent = '🙈';
    console.debug('[secret-open]', 'mail password loaded', { hasPass: !!data.hasPass });
    toast(data.hasPass ? '已载入保存的 SMTP 密码' : '当前未保存 SMTP 密码');
}
async function testMail() {
    const btn = $('#testMailBtn');
    const oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = t('发送中...');
    try {
        const result = await api('/api/settings/test-mail', { method: 'POST', body: JSON.stringify({ to: $('#mailAdminEmail').value.trim() }) });
        toast(result.message || '测试邮件已发送');
    } catch (err) {
        toast(err.message || '测试邮件发送失败');
    } finally {
        btn.disabled = false;
        btn.textContent = oldText;
    }
}
async function saveTerminalLayout(e) {
    e.preventDefault();
    const maxWindows = Math.min(3, Math.max(1, Number($('#terminalMaxWindows').value) || 3));
    const rawKeepAlive = Number($('#terminalMinimizedKeepAlive').value);
    const minimizedKeepAlive = rawKeepAlive === -1 ? -1 : Math.max(0, Math.floor(Number.isFinite(rawKeepAlive) ? rawKeepAlive : 0));
    const smartbarOrder = $('#terminalSmartbarOrder').value === 'new-first' ? 'new-first' : 'old-first';
    const shortcutPlatformRaw = $('#terminalShortcutPlatform').value;
    const shortcutPlatform = ['auto', 'windows', 'mac'].includes(shortcutPlatformRaw) ? shortcutPlatformRaw : 'auto';
    localStorage.setItem('zephyr-terminal-max-windows', String(maxWindows));
    localStorage.setItem('zephyr-terminal-minimized-keepalive', String(minimizedKeepAlive));
    localStorage.setItem('zephyr-terminal-smartbar-order', smartbarOrder);
    localStorage.setItem('zephyr-shortcut-platform', shortcutPlatform);
    const allowLigatures = !!$('#terminalAllowLigatures')?.checked;
    localStorage.setItem('zephyr-terminal-allow-ligatures', allowLigatures ? '1' : '0');
    settings = await savePersonalSettings({ terminal: { maxWindows, minimizedKeepAlive, smartbarOrder, shortcutPlatform, allowLigatures } });
    enforceTerminalWorkspaceLimit(activeTerminalTab);
    renderTerminalTabs();
    const keepAliveText = minimizedKeepAlive === -1 ? '最小化无限保活' : `最小化保活 ${minimizedKeepAlive} 个`;
    toast(t('终端布局已保存：最多 {count} 窗，{keepAlive}', { count: maxWindows, keepAlive: keepAliveText }));
    broadcastTerminalSettings({ allowLigatures });
}

const SNIPPET_STORAGE_KEY = 'zephyr-ssh-snippets';
function normalizeSnippets(list) {
    return Array.isArray(list) ? list.filter((item) => item && item.command).map((item) => ({
        id: String(item.id || `snippet-${Date.now()}-${Math.random().toString(16).slice(2)}`),
        name: String(item.name || '').slice(0, 60),
        command: String(item.command || ''),
        group: String(item.group || '').slice(0, 40),
        autoRun: !!item.autoRun,
        revision: Math.max(1, Number(item.revision) || 1),
        createdAt: Number(item.createdAt || item.updatedAt || Date.now()),
        updatedAt: Number(item.updatedAt || Date.now()),
    })) : [];
}
function getSnippets() {
    return normalizeSnippets(settings?.snippets || []);
}
async function persistSnippets(list) {
    const snippets = normalizeSnippets(list);
    settings = await savePersonalSettings({ snippets });
    settings.snippets = normalizeSnippets(settings.snippets || snippets);
    return settings.snippets;
}
async function migrateLocalSnippetsToServer() {
    if (getSnippets().length) return;
    try {
        const local = normalizeSnippets(JSON.parse(localStorage.getItem(SNIPPET_STORAGE_KEY) || '[]'));
        if (!local.length) return;
        await persistSnippets(local);
        localStorage.removeItem(SNIPPET_STORAGE_KEY);
        toast(t('已将本地代码片段迁移到服务端'));
    } catch (_) {}
}
function resetSnippetForm() {
    $('#snippetId').value = '';
    $('#snippetName').value = '';
    $('#snippetCommand').value = '';
    $('#snippetGroup').value = '';
    $('#snippetAutoRun').checked = false;
}
function snippetScrimSet(open, _Motion) {
    motionScrimSet('snippetModalScrim', 'snippet1-blurring', open);
}

function snippetBtnRadius(el, rect) {
    const r = parseFloat(getComputedStyle(el)?.borderRadius);
    if (Number.isFinite(r) && r > 0) return r;
    return Math.min(rect.width, rect.height) / 2;
}

function openSnippetModal(item = null, trigger = null) {
    window.clearTimeout(closeSnippetModal._timer);
    const cycle = ++snippetModalCycle;
    const modal = $('#snippetModal');
    if (!modal || (modal.classList.contains('show') && !modal.classList.contains('closing'))) return;
    const card = $('#snippetForm');
    resetSnippetForm();
    $('#snippetModalTitle').textContent = item ? '编辑代码片段' : t('新增代码片段');
    $('#saveSnippetBtn').textContent = item ? '保存修改' : t('保存代码片段');
    $('#snippetId').value = item?.id || '';
    $('#snippetName').value = item?.name || '';
    $('#snippetCommand').value = item?.command || '';
    $('#snippetGroup').value = item?.group || '';
    $('#snippetAutoRun').checked = !!item?.autoRun;
    snippetModalTrigger = trigger || $('#addSnippetBtn');
    const btnRect = snippetModalTrigger?.getBoundingClientRect?.() || null;

    sshKeyMotion._ensure().then((Motion) => {
        if (cycle !== snippetModalCycle) return;
        const inner = $('#snippetModalInner');
        armMotionModalOpen(Motion, modal, card, inner, snippetModalTrigger, 'snippet1');
        const liveRect = snippetModalTrigger?.getBoundingClientRect?.() || btnRect;
        snippetScrimSet(true, Motion || null);
        const useMotion = !!Motion && !!liveRect && liveRect.width > 2 && liveRect.height > 2;
        if (!useMotion) {
            if (card?.style) {
                card.style.visibility = '';
                card.style.opacity = '';
                card.style.pointerEvents = '';
            }
            if (inner?.style) inner.style.opacity = '';
            if (snippetModalTrigger?.style) {
                snippetModalTrigger.style.opacity = '';
                snippetModalTrigger.style.pointerEvents = '';
                delete snippetModalTrigger.dataset.motionHidden;
            }
            $('#snippetName')?.focus({ preventScroll: true });
            return;
        }
        Motion.iosAppOpen(card, snippetModalTrigger, {
            contentEl: inner,
            scrim: null,
            home: null,
            cloneSource: true,
            hideSource: true,
            radiusFrom: snippetBtnRadius(snippetModalTrigger, liveRect),
            radiusTo: 22,
            contentDelay: 0.16,
            faceDelay: 0.05,
            faceInDelay: 0.04,
            shapePreset: 'shape',
            contentPreset: 'content',
        }).then(() => {
            if (cycle !== snippetModalCycle) return;
            card.style.overflow = '';
        }).catch((err) => console.warn('[snippet1] iosAppOpen failed', err));
        window.setTimeout(() => {
            if (cycle === snippetModalCycle && modal.classList.contains('show')) {
                $('#snippetName')?.focus({ preventScroll: true });
            }
        }, 220);
    });
}

function closeSnippetModal() {
    const modal = $('#snippetModal');
    if (!modal?.classList.contains('show') || modal.classList.contains('closing')) return;
    const card = $('#snippetForm');
    const inner = $('#snippetModalInner');
    const cycle = ++snippetModalCycle;
    window.clearTimeout(closeSnippetModal._timer);

    modal.classList.add('closing');
    modal.classList.remove('app-visible');
    modal.setAttribute('aria-hidden', 'true');

    const Motion = sshKeyMotion.engine;
    const trigger = snippetModalTrigger;
    const btnRect = trigger?.getBoundingClientRect?.() || null;
    const useMotion = !!Motion && !sshKeyMotion.failed
        && modal.classList.contains('snippet1')
        && !!btnRect && btnRect.width > 2 && btnRect.height > 2;

    const finish = () => {
        if (cycle !== snippetModalCycle) return;
        if (Motion) {
            try {
                if (trigger) Motion.restoreSource(trigger);
                Motion.restoreSources(card);
            } catch {}
        } else if (trigger?.style) {
            trigger.style.opacity = '';
            trigger.style.pointerEvents = '';
            delete trigger.dataset.motionHidden;
        }
        void (trigger?.offsetHeight);
        void card.offsetHeight;

        modal.classList.remove('show', 'closing', 'snippet1');

        if (Motion) {
            try {
                card.querySelector?.(':scope > [data-motion-source-visual]')?.remove();
                Motion.release(card);
                if (inner) Motion.release(inner);
            } catch {}
        }
        card.style.overflow = '';
        card.style.visibility = '';
        card.style.opacity = '';
        card.style.filter = '';
        card.style.transform = '';
        card.style.borderRadius = '';
        resetSnippetForm();
        const focusEl = trigger;
        snippetModalTrigger = null;
        if (focusEl) {
            requestAnimationFrame(() => {
                try { focusEl.focus?.({ preventScroll: true }); } catch {}
            });
        }
    };

    snippetScrimSet(false, Motion || null);
    if (!useMotion) {
        closeSnippetModal._timer = window.setTimeout(finish, 0);
        return;
    }
    try {
        const twinLayer = card.querySelector(':scope > [data-motion-source-visual]');
        if (twinLayer) Motion.set(twinLayer, { opacity: Number(twinLayer.style.opacity) || 0 });
    } catch {}
    const closed = Motion.iosAppClose(card, trigger, {
        contentEl: inner,
        scrim: null,
        home: null,
        restoreSource: false,
        hideSurface: false,
        clearSourceVisual: false,
        release: false,
        radiusTo: snippetBtnRadius(trigger, btnRect),
        shapePreset: 'shapeClose',
        contentPreset: 'contentClose',
        faceInDelay: 0.04,
    });
    const cap = new Promise(r => window.setTimeout(r, 900));
    Promise.race([closed, cap]).then(() => {
        requestAnimationFrame(() => finish());
    }).catch((err) => {
        console.warn('[snippet1] iosAppClose failed', err);
        finish();
    });
}
function renderSnippetSettings() {
    const list = $('#snippetSettingsList');
    if (!list) return;
    const snippets = getSnippets();
    list.innerHTML = snippets.length ? snippets.map((item) => `<div class="mini-item snippet-settings-item" data-id="${escapeHtml(item.id)}"><span class="resource-tag resource-tag-name" title="${escapeHtml(item.name || t('未命名片段'))}">${escapeHtml(item.name || t('未命名片段'))}</span><div class="resource-meta"><span class="resource-tag resource-tag-protocol">${escapeHtml(item.group || t('未分组'))}</span><span class="resource-tag ${item.autoRun ? 'resource-tag-host' : 'resource-tag-auth'}">${item.autoRun ? t('直接执行') : t('填入输入框')}</span></div><button class="tool-btn" data-edit-snippet="${escapeHtml(item.id)}">${t('编辑')}</button><button class="tool-btn danger" data-delete-snippet="${escapeHtml(item.id)}">${t('删除')}</button></div>`).join('') : `<p class="muted">${t('暂无代码片段')}</p>`;
}
async function saveSnippet(e) {
    e.preventDefault();
    const name = $('#snippetName').value.trim();
    const command = $('#snippetCommand').value;
    if (!name || !command.trim()) return toast(t('请填写片段名称和命令'));
    const id = $('#snippetId').value || `snippet-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const snippets = getSnippets();
    const idx = snippets.findIndex((x) => x.id === id);
    const old = idx >= 0 ? snippets[idx] : null;
    const item = { id, name, command, group: $('#snippetGroup').value.trim(), autoRun: $('#snippetAutoRun').checked, revision: old ? Math.max(1, Number(old.revision) || 1) + 1 : 1, createdAt: old?.createdAt || Date.now(), updatedAt: Date.now() };
    if (idx >= 0) snippets[idx] = item; else snippets.unshift(item);
    await persistSnippets(snippets);
    closeSnippetModal();
    renderSnippetSettings();
    toast(t('代码片段已保存到服务端'));
}
function setupSnippetSettings() {
    $('#snippetForm')?.addEventListener('submit', saveSnippet);
    $('#addSnippetBtn')?.addEventListener('click', (e) => openSnippetModal(null, e.currentTarget));
    $('#snippetCloseBtn')?.addEventListener('click', closeSnippetModal);
    $('#cancelSnippetEditBtn')?.addEventListener('click', closeSnippetModal);
    // 点模糊遮罩关闭（仅 target 为 backdrop 本身，点表单不关）。可打断飞行中动画。
    $('#snippetModal')?.addEventListener('click', (e) => { if (e.target.id === 'snippetModal') closeSnippetModal(); });
    $('#snippetModalScrim')?.addEventListener('click', () => { if ($('#snippetModal')?.classList.contains('show')) closeSnippetModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#snippetModal')?.classList.contains('show')) closeSnippetModal(); });
    $('#snippetSettingsList')?.addEventListener('click', async (e) => {
        const editId = e.target.closest?.('[data-edit-snippet]')?.dataset.editSnippet;
        const deleteId = e.target.closest?.('[data-delete-snippet]')?.dataset.deleteSnippet;
        const snippets = getSnippets();
        if (editId) {
            const item = snippets.find((x) => x.id === editId); if (!item) return;
            openSnippetModal(item, e.target.closest('[data-edit-snippet]'));
        }
        if (deleteId) {
            if (!confirm(t('删除该代码片段？'))) return;
            await waitForMiniItemExit(e.target.closest('.mini-item'), deleteId);
            try {
                await persistSnippets(snippets.filter((x) => x.id !== deleteId));
                renderSnippetSettings();
                toast(t('代码片段已从服务端删除'));
            } catch (err) { toast(err.message || t('删除失败')); }
        }
    });
    renderSnippetSettings();
}
async function setupTotp() { if (!$('#totpEnableForm')) return; const r = await api('/api/security/totp/setup', { method: 'POST', body: '{}' }); $('#totpEnableForm').classList.remove('force-hidden'); $('#totpQrBox').innerHTML = `<img class="qr-img" src="${r.qr}"><p class="muted">${t('密钥：')}${escapeHtml(r.secret)}</p>`; }
async function registerPasskey() { try { if (!window.PublicKeyCredential) return toast(t('当前浏览器不支持 Passkey')); const options = await api('/api/passkeys/register/options', { method: 'POST', body: '{}' }); options.challenge = base64urlToBuffer(options.challenge); options.user.id = base64urlToBuffer(options.user.id); (options.excludeCredentials || []).forEach((c) => { c.id = base64urlToBuffer(c.id); }); const cred = await navigator.credentials.create({ publicKey: options }); if (!cred) return toast(t('Passkey 创建被取消')); const payload = { id: cred.id, rawId: bufferToBase64url(cred.rawId), type: cred.type, response: { clientDataJSON: bufferToBase64url(cred.response.clientDataJSON), attestationObject: bufferToBase64url(cred.response.attestationObject), transports: cred.response.getTransports ? cred.response.getTransports() : [] } }; await api('/api/passkeys/register/verify', { method: 'POST', body: JSON.stringify(payload) }); toast(t('Passkey 已绑定')); await loadSecurityStatus(); } catch (err) { toast(t('Passkey 注册失败：') + err.message); } }
async function loadNetwork() {
    const generation = ++networkLoadGeneration;
    const [proxyData, keyData, jumpData] = await Promise.all([
        api('/api/proxies'),
        api('/api/ssh-keys').catch(() => ({ sshKeys: [] })),
        api('/api/jump-hosts').catch(() => ({ jumpHosts: [] })),
    ]);
    if (generation !== networkLoadGeneration) return { proxies, sshKeys, jumpHosts };
    proxies = proxyData.proxies || [];
    sshKeys = keyData.sshKeys || [];
    jumpHosts = jumpData.jumpHosts || [];
    renderNetwork();
    updateRouteOptions();
    renderSshKeyOptions($('#connSshKey')?.value || '');
    return { proxies, sshKeys, jumpHosts };
}
function renderNetwork() {
    $('#proxyList').innerHTML = proxies.map((p) => `<div class="mini-item proxy-item"><span class="resource-tag resource-tag-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span><div class="resource-meta"><span class="resource-tag resource-tag-protocol">${escapeHtml((p.type || 'socks5').toUpperCase())}</span><span class="resource-tag resource-tag-host" title="${escapeHtml(p.host)}">${escapeHtml(p.host)}</span><span class="resource-tag resource-tag-port">${Number(p.port) || 1080}</span>${p.username ? `<span class="resource-tag resource-tag-auth">${escapeHtml(p.username)}</span>` : ''}${p.hasPassword ? `<span class="resource-tag resource-tag-secret">${t('有密码')}</span>` : ''}</div><button data-edit-proxy="${p.id}">${t('编辑')}</button><button data-open-proxy="${p.id}">${t('查看')}</button><button data-del-proxy="${p.id}">${t('删除')}</button></div>`).join('') || `<p class="muted">${t('暂无代理')}</p>`;
    $('#sshKeyList').innerHTML = sshKeys.map((k) => `<div class="mini-item ssh-key-item"><span class="ssh-key-tag ssh-key-tag-name" title="${escapeHtml(k.name)}">${escapeHtml(k.name)}</span><div class="ssh-key-meta"><span class="ssh-key-tag ssh-key-tag-private">${k.hasPrivateKey ? t('已保存私钥') : t('无私钥')}</span>${k.hasPassphrase ? `<span class="ssh-key-tag ssh-key-tag-passphrase">${t('有口令')}</span>` : ''}${k.remark ? `<span class="ssh-key-tag ssh-key-tag-remark" title="${escapeHtml(k.remark)}">${escapeHtml(k.remark)}</span>` : ''}</div><button data-edit-ssh-key="${k.id}">${t('编辑')}</button><button data-open-ssh-key="${k.id}">${t('查看')}</button><button data-del-ssh-key="${k.id}">${t('删除')}</button></div>`).join('') || `<p class="muted">${t('暂无 SSH 密钥')}</p>`;
}
function renderJumpOptions() { if ($('#jumpRouteConfig') && $('#connMode')?.value === 'jump') updateRouteOptions('jump', $$('#jumpRouteList [data-jump-route-select]').map((el) => el.value).filter(Boolean)); }
function resetProxyForm() { $('#proxyForm')?.reset(); $('#proxyId').value = ''; $('#proxyType').value = 'socks5'; $('#proxyPort').value = '1080'; }
function proxyScrimSet(open, _Motion) {
    motionScrimSet('proxyModalScrim', 'proxy1-blurring', open);
}

function proxyBtnRadius(el, rect) {
    const r = parseFloat(getComputedStyle(el)?.borderRadius);
    if (Number.isFinite(r) && r > 0) return r;
    return Math.min(rect.width, rect.height) / 2;
}

function openProxyModal(proxy = null, trigger = null) {
    window.clearTimeout(closeProxyModal._timer);
    const cycle = ++proxyModalCycle;
    const modal = $('#proxyModal');
    // 允许打断 closing 中的动画；禁止重复打开已完全 show 的窗
    if (!modal || (modal.classList.contains('show') && !modal.classList.contains('closing'))) return;
    const card = $('#proxyForm');
    const inner = $('#proxyModalInner');
    // 字段手写赋值，避免原生 reset 触发布局 + toggle-select 二次同步导致闪
    $('#proxyModalTitle').textContent = proxy ? '编辑代理' : t('新建代理');
    $('#proxyId').value = proxy?.id || '';
    $('#proxyName').value = proxy?.name || '';
    $('#proxyType').value = proxy?.type || 'socks5';
    $('#proxyHost').value = proxy?.host || '';
    $('#proxyPort').value = proxy?.port || 1080;
    $('#proxyUsername').value = proxy?.username || '';
    $('#proxyPassword').value = proxy?.hasPassword ? '******' : (proxy?.password || '');
    proxyModalTrigger = trigger || $('#addProxyBtn');

    sshKeyMotion._ensure().then((Motion) => {
        if (cycle !== proxyModalCycle) return;
        // 先清场再量尺寸：停 press 弹簧 / 中断中的 close morph，避免量到 scale 中的按钮
        armMotionModalOpen(Motion, modal, card, inner, proxyModalTrigger, 'proxy1');
        // 代理类型只写原生 select 值；飞行中不 enhance/sync toggle-select，避免
        // 二次 DOM 同步与菜单动画在 FLIP 首帧抢 paint。
        try { closeAllToggleSelects(); } catch {}
        const btnRect = proxyModalTrigger?.getBoundingClientRect?.() || null;
        proxyScrimSet(true, Motion || null);
        const useMotion = !!Motion && !!btnRect && btnRect.width > 2 && btnRect.height > 2;
        if (!useMotion) {
            if (card?.style) {
                card.style.visibility = '';
                card.style.opacity = '';
                card.style.pointerEvents = '';
            }
            if (inner?.style) inner.style.opacity = '';
            if (proxyModalTrigger?.style) {
                proxyModalTrigger.style.opacity = '';
                proxyModalTrigger.style.pointerEvents = '';
                delete proxyModalTrigger.dataset.motionHidden;
            }
            try {
                enhanceToggleSelect($('#proxyType'));
                syncToggleSelectFace($('#proxyType'));
            } catch {}
            $('#proxyName')?.focus({ preventScroll: true });
            return;
        }
        Motion.iosAppOpen(card, proxyModalTrigger, {
            contentEl: inner,
            scrim: null,
            home: null,
            cloneSource: true,
            hideSource: true,
            radiusFrom: proxyBtnRadius(proxyModalTrigger, btnRect),
            radiusTo: 22,
            contentDelay: 0.16,
            faceDelay: 0.05,
            faceInDelay: 0.04,
            shapePreset: 'shape',
            contentPreset: 'content',
        }).then(() => {
            if (cycle !== proxyModalCycle) return;
            // 完整展开：iosAppOpen 飞行中会写 overflow:hidden；落地后必须清掉，
            // 否则卡片仍表现为内部滚动而不是内容完整外展。
            card.style.overflow = 'visible';
            card.style.maxHeight = 'none';
            card.style.height = 'auto';
            if (inner?.style) {
                inner.style.overflow = 'visible';
                inner.style.maxHeight = 'none';
            }
            try {
                enhanceToggleSelect($('#proxyType'));
                syncToggleSelectFace($('#proxyType'));
            } catch {}
        }).catch((err) => console.warn('[proxy1] iosAppOpen failed', err));
        window.setTimeout(() => {
            if (cycle === proxyModalCycle && modal.classList.contains('show')) {
                $('#proxyName')?.focus({ preventScroll: true });
            }
        }, 220);
    });
}

function closeProxyModal() {
    const modal = $('#proxyModal');
    if (!modal?.classList.contains('show') || modal.classList.contains('closing')) return;
    const card = $('#proxyForm');
    const inner = $('#proxyModalInner');
    const cycle = ++proxyModalCycle;
    window.clearTimeout(closeProxyModal._timer);

    modal.classList.add('closing');
    modal.classList.remove('app-visible');
    modal.setAttribute('aria-hidden', 'true');

    const Motion = sshKeyMotion.engine;
    const trigger = proxyModalTrigger;
    const btnRect = trigger?.getBoundingClientRect?.() || null;
    const useMotion = !!Motion && !sshKeyMotion.failed
        && modal.classList.contains('proxy1')
        && !!btnRect && btnRect.width > 2 && btnRect.height > 2;

    const finish = () => {
        if (cycle !== proxyModalCycle) return;
        if (Motion) {
            try {
                if (trigger) Motion.restoreSource(trigger);
                Motion.restoreSources(card);
            } catch {}
        } else if (trigger?.style) {
            trigger.style.opacity = '';
            trigger.style.pointerEvents = '';
            delete trigger.dataset.motionHidden;
        }
        void (trigger?.offsetHeight);
        void card.offsetHeight;

        modal.classList.remove('show', 'closing', 'proxy1');

        if (Motion) {
            try {
                card.querySelector?.(':scope > [data-motion-source-visual]')?.remove();
                Motion.release(card);
                if (inner) Motion.release(inner);
            } catch {}
        }
        card.style.overflow = '';
        card.style.visibility = '';
        card.style.opacity = '';
        card.style.filter = '';
        card.style.transform = '';
        card.style.borderRadius = '';
        // 不在 finish 里 form.reset：交接同一帧改 DOM 会闪一下
        const focusEl = trigger;
        proxyModalTrigger = null;
        if (focusEl) {
            requestAnimationFrame(() => {
                try { focusEl.focus?.({ preventScroll: true }); } catch {}
            });
        }
    };

    proxyScrimSet(false, Motion || null);
    if (!useMotion) {
        closeProxyModal._timer = window.setTimeout(finish, 0);
        return;
    }
    try {
        const twinLayer = card.querySelector(':scope > [data-motion-source-visual]');
        if (twinLayer) Motion.set(twinLayer, { opacity: Number(twinLayer.style.opacity) || 0 });
    } catch {}
    const closed = Motion.iosAppClose(card, trigger, {
        contentEl: inner,
        scrim: null,
        home: null,
        restoreSource: false,
        hideSurface: false,
        clearSourceVisual: false,
        release: false,
        radiusTo: proxyBtnRadius(trigger, btnRect),
        shapePreset: 'shapeClose',
        contentPreset: 'contentClose',
        faceInDelay: 0.04,
    });
    const cap = new Promise(r => window.setTimeout(r, 900));
    Promise.race([closed, cap]).then(() => {
        requestAnimationFrame(() => finish());
    }).catch((err) => {
        console.warn('[proxy1] iosAppClose failed', err);
        finish();
    });
}
async function saveProxy(e) { e.preventDefault(); const id = $('#proxyId').value, payload = { name: $('#proxyName').value, type: $('#proxyType').value, host: $('#proxyHost').value, port: Number($('#proxyPort').value), username: $('#proxyUsername').value, password: $('#proxyPassword').value }; console.debug('[route-ui]', 'save proxy payload', { id, ...payload, password: payload.password ? '******' : '' }); await api(id ? `/api/proxies/${id}` : '/api/proxies', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) }); closeProxyModal(); await loadNetwork(); toast(t('代理已保存')); }
async function openProxySecret(id, trigger = null) {
    const secret = await requestSensitiveSecret('查看已保存代理密码');
    const data = await api(`/api/proxies/${id}/open`, { method: 'POST', body: JSON.stringify({ secret }) });
    const p = data.proxy || {};
    $('#proxyId').value = p.id || '';
    $('#proxyName').value = p.name || '';
    $('#proxyType').value = p.type || 'socks5';
    $('#proxyHost').value = p.host || '';
    $('#proxyPort').value = p.port || '';
    $('#proxyUsername').value = p.username || '';
    $('#proxyPassword').value = p.password || '';
    openProxyModal(p, trigger);
    $('#proxyPassword').value = p.password || '';
    console.debug('[proxy-ui]', 'proxy secret loaded', { id, hasPassword: !!p.password });
    toast(t('已载入代理密码'));
}
function resetSshKeyForm() { $('#sshKeyForm').reset(); $('#sshKeyId').value = ''; $('#sshKeyPrivateKey').value = ''; $('#sshKeyPassphrase').value = ''; }
/* scrim：只拨 opacity + is-open 类。禁止 Motion.cssVars 每帧改 backdrop-filter
   （会触发全屏 layer 重绘 → 开合每一帧闪）。blur 瞬时切换，opacity 走 CSS 过渡。 */
const _motionScrimGen = new WeakMap();
function motionScrimSet(scrimId, bodyClass, open) {
    const scrim = document.getElementById(scrimId);
    if (!scrim) return;
    const gen = (_motionScrimGen.get(scrim) || 0) + 1;
    _motionScrimGen.set(scrim, gen);
    document.body.classList.toggle(bodyClass, !!open);
    if (open) {
        scrim.style.visibility = 'visible';
        // 先挂 blur 类再淡入 opacity，避免 opacity 动画期间每帧改 filter
        scrim.classList.add('is-open');
        // 下一帧再抬 opacity，确保 is-open 的 blur 已提交
        requestAnimationFrame(() => {
            if (_motionScrimGen.get(scrim) !== gen) return;
            scrim.style.opacity = '1';
        });
    } else {
        scrim.style.opacity = '0';
        // blur 等 opacity 收完再卸，避免关窗时整屏 filter 突变
        window.setTimeout(() => {
            if (_motionScrimGen.get(scrim) !== gen) return;
            scrim.classList.remove('is-open');
            if (scrim.style.opacity === '0') scrim.style.visibility = 'hidden';
            document.body.classList.remove(bodyClass);
        }, 340);
    }
}

/* 开弹窗前：停掉卡片/按钮/inner 上一切残留弹簧与 twin，再藏卡片 display。
   代理窗闪一下的主因：上一次 close 未 finish 的 morph 通道还在写 transform，
   与 arm 清 style / 新一次 iosAppOpen seed 抢帧 → 多闪。三窗统一清场。 */
function armMotionModalOpen(Motion, modal, card, inner, trigger, motionClass) {
    if (Motion) {
        try {
            if (trigger) { Motion.stop(trigger); Motion.release(trigger); }
            if (card) { Motion.stop(card); Motion.release(card); }
            if (inner) { Motion.stop(inner); Motion.release(inner); }
            card?.querySelector?.(':scope > [data-motion-source-visual]')?.remove();
        } catch {}
    }
    // 按压 CSS 类也会 scale，量尺寸前清掉
    trigger?.classList?.remove('connection-pressing');
    if (trigger?.style) {
        // Do not pre-hide here. iosAppOpen.hideSource() owns the single-frame
        // handoff: it disables authored opacity transitions, hides the real
        // control, forces a paint, then exposes the pixel-identical twin.
        // Pre-hiding here made hideSource capture opacity:0 as its “original”
        // state and let AI button transitions cross-fade a second source image.
        trigger.style.opacity = '';
        trigger.style.pointerEvents = '';
        trigger.style.transform = '';
        trigger.style.filter = '';
        trigger.style.visibility = '';
        delete trigger.dataset.motionHidden;
    }
    if (card?.style) {
        card.style.visibility = 'hidden';
        card.style.opacity = '0';
        card.style.pointerEvents = 'none';
        card.style.transform = '';
        card.style.filter = '';
        card.style.borderRadius = '';
        card.style.overflow = '';
        card.style.willChange = '';
        card.style.zIndex = '';
    }
    if (inner?.style) {
        // iosAppOpen 会重新 seed content opacity；清残留避免首帧露出表单
        inner.style.opacity = '0';
        inner.style.position = '';
        inner.style.zIndex = '';
    }
    modal.classList.remove('closing', 'app-visible', 'connection1', 'sshkey1', 'snippet1', 'proxy1', 'aiprovider1', 'adminuser1');
    modal.classList.add('show', motionClass);
    modal.setAttribute('aria-hidden', 'false');
    modal.classList.add('app-visible');
}

/* ── sshkey1 / snippet1 / proxy1：弹窗接入 zephyr-motion ─────────────── */
/* 演示页（/motion-feel.html）里 iOS 打开动画用的就是 Motion.iosAppOpen/Close
   这条 FLIP 弹簧路径；生产里 SSH 密钥 / 代码片段 / 代理池 同源接线。
   引擎走动态 import 且 try/catch 兜底，挂了自动回退老 class 路径。 */
const sshKeyMotion = {
    engine: null,
    failed: false,
    animating: false,
    _pressBound: false,
    _ensure() {
        if (this.engine || this.failed) return Promise.resolve(this.engine);
        return import('./vendor/zephyr-motion/index.js?v=20260731-motion-mobile-fix2')
            .then(async (mod) => {
                const Motion = mod?.Motion || window.Motion;
                if (!Motion) throw new Error('Motion missing from zephyr-motion module');
                // index.js 已 auto-boot；await 让 wasm 就绪（幂等）。
                try { await Motion.init({ capacity: 256 }); } catch {}
                this.engine = Motion;
                // 打开按压反馈（Apple/Emil：scale 0.96 on pointerdown）
                // 代理新建按钮不绑 Motion.press：任何源按钮 scale 都会和 iosAppOpen
                // 的 clone 首帧抢 transform，造成“闪一下/曲线不对”。
                if (!this._pressBound) {
                    for (const id of ['addSshKeyBtn', 'addSnippetBtn']) {
                        const btn = document.getElementById(id);
                        if (btn && Motion.press) Motion.press(btn, { scale: 0.96, preset: 'snappy' });
                    }
                    this._pressBound = true;
                }
                console.debug('[sshkey1]', 'motion ready', { wasm: !!Motion.usingWasm });
                return Motion;
            })
            .catch((err) => {
                console.warn('[sshkey1] motion engine unavailable, CSS fallback:', err?.message || err);
                this.failed = true;
                return null;
            });
    },
    reset() { this.engine = null; this.failed = false; this.animating = false; this._pressBound = false; },
};

function sshKeyScrimSet(open, _Motion) {
    motionScrimSet('sshKeyModalScrim', 'sshkey1-blurring', open);
}

/* 按钮圆角：优先取真值，取不到退回胶囊半径 */
function sshKeyBtnRadius(el, rect) {
    const r = parseFloat(getComputedStyle(el)?.borderRadius);
    if (Number.isFinite(r) && r > 0) return r;
    return Math.min(rect.width, rect.height) / 2;
}

function openSshKeyModal(sshKey = null, trigger = null) {
    window.clearTimeout(closeSshKeyModal._timer);
    const cycle = ++sshKeyModalCycle;
    const modal = $('#sshKeyModal');
    if (!modal || (modal.classList.contains('show') && !modal.classList.contains('closing'))) return;
    const card = $('#sshKeyForm');
    resetSshKeyForm();
    $('#sshKeyModalTitle').textContent = sshKey ? '编辑 SSH 密钥' : t('新增 SSH 密钥');
    $('#saveSshKeyBtn').textContent = sshKey ? '保存修改' : t('保存 SSH 密钥');
    $('#sshKeyId').value = sshKey?.id || '';
    $('#sshKeyName').value = sshKey?.name || '';
    $('#sshKeyPrivateKey').value = sshKey?.hasPrivateKey ? '******' : '';
    $('#sshKeyPassphrase').value = sshKey?.hasPassphrase ? '******' : '';
    $('#sshKeyRemark').value = sshKey?.remark || '';
    sshKeyModalTrigger = trigger || $('#addSshKeyBtn');
    const btnRect = sshKeyModalTrigger?.getBoundingClientRect?.() || null;

    sshKeyMotion._ensure().then((Motion) => {
        if (cycle !== sshKeyModalCycle) return;
        const inner = $('#sshKeyModalInner');
        armMotionModalOpen(Motion, modal, card, inner, sshKeyModalTrigger, 'sshkey1');
        const liveRect = sshKeyModalTrigger?.getBoundingClientRect?.() || btnRect;
        sshKeyScrimSet(true, Motion || null);
        const useMotion = !!Motion && !!liveRect && liveRect.width > 2 && liveRect.height > 2;
        if (!useMotion) {
            if (card?.style) {
                card.style.visibility = '';
                card.style.opacity = '';
                card.style.pointerEvents = '';
            }
            if (inner?.style) inner.style.opacity = '';
            if (sshKeyModalTrigger?.style) {
                sshKeyModalTrigger.style.opacity = '';
                sshKeyModalTrigger.style.pointerEvents = '';
                delete sshKeyModalTrigger.dataset.motionHidden;
            }
            $('#sshKeyName')?.focus({ preventScroll: true });
            return;
        }
        Motion.iosAppOpen(card, sshKeyModalTrigger, {
            contentEl: inner,
            scrim: null,
            home: null,
            cloneSource: true,
            hideSource: true,
            radiusFrom: sshKeyBtnRadius(sshKeyModalTrigger, liveRect),
            radiusTo: 22,
            contentDelay: 0.16,
            faceDelay: 0.05,
            faceInDelay: 0.04,
            shapePreset: 'shape',
            contentPreset: 'content',
        }).then(() => {
            if (cycle !== sshKeyModalCycle) return;
            card.style.overflow = '';
        }).catch((err) => console.warn('[sshkey1] iosAppOpen failed', err));
        window.setTimeout(() => {
            if (cycle === sshKeyModalCycle && modal.classList.contains('show')) {
                $('#sshKeyName')?.focus({ preventScroll: true });
            }
        }, 220);
    });
}

function closeSshKeyModal() {
    const modal = $('#sshKeyModal');
    if (!modal?.classList.contains('show') || modal.classList.contains('closing')) return;
    const card = $('#sshKeyForm');
    const inner = $('#sshKeyModalInner');
    const cycle = ++sshKeyModalCycle;
    window.clearTimeout(closeSshKeyModal._timer);

    // 抢占式：先标记 closing，禁止重复触发；aria 立刻置 true
    modal.classList.add('closing');
    modal.classList.remove('app-visible');
    modal.setAttribute('aria-hidden', 'true');

    const Motion = sshKeyMotion.engine;
    const trigger = sshKeyModalTrigger;
    const btnRect = trigger?.getBoundingClientRect?.() || null;
    const useMotion = !!Motion && !sshKeyMotion.failed
        && modal.classList.contains('sshkey1')
        && !!btnRect && btnRect.width > 2 && btnRect.height > 2;

    const finish = () => {
        if (cycle !== sshKeyModalCycle) return;
        // 原子交接（同一次 paint，参考 iOS True Morph transitionend）：
        // 1) 先把真按钮 opacity 还原（twin 仍盖在上面，用户看不到按钮出现）
        // 2) 强制 reflow，让浏览器提交 opacity:1
        // 3) 再卸 .show（display:none 掉卡片+twin）—— 底下按钮已可见
        // 旧 bug：clearSourceVisual / remove show 先于 restoreSource → 一帧按钮=0 且 twin 没了 → 闪一下
        if (Motion) {
            try {
                if (trigger) Motion.restoreSource(trigger);
                Motion.restoreSources(card);
            } catch {}
        } else if (trigger?.style) {
            trigger.style.opacity = '';
            trigger.style.pointerEvents = '';
            delete trigger.dataset.motionHidden;
        }
        // 强制提交「按钮已可见」样式，再卸 twin
        void (trigger?.offsetHeight);
        void card.offsetHeight;

        modal.classList.remove('show', 'closing', 'sshkey1');

        if (Motion) {
            try {
                // twin 随 modal 隐藏后再清，避免中途露底
                card.querySelector?.(':scope > [data-motion-source-visual]')?.remove();
                Motion.release(card);
                if (inner) Motion.release(inner);
            } catch {}
        }
        card.style.overflow = '';
        card.style.visibility = '';
        card.style.opacity = '';
        card.style.filter = '';
        card.style.transform = '';
        card.style.borderRadius = '';
        resetSshKeyForm();
        // focus 延后一帧，避免 restore 当帧再触发一次 outline/闪动
        const focusEl = trigger;
        sshKeyModalTrigger = null;
        if (focusEl) {
            requestAnimationFrame(() => {
                try { focusEl.focus?.({ preventScroll: true }); } catch {}
            });
        }
    };

    sshKeyScrimSet(false, Motion || null);
    if (!useMotion) {
        closeSshKeyModal._timer = window.setTimeout(finish, 0);
        return;
    }
    // clearSourceVisual 必须 false：否则 finally 先删 twin，finish 才 restore → 闪一下
    try {
        const twinLayer = card.querySelector(':scope > [data-motion-source-visual]');
        if (twinLayer) Motion.set(twinLayer, { opacity: Number(twinLayer.style.opacity) || 0 });
    } catch {}
    const closed = Motion.iosAppClose(card, trigger, {
        contentEl: inner,
        scrim: null,
        home: null,
        restoreSource: false,
        hideSurface: false,
        clearSourceVisual: false,
        release: false,
        radiusTo: sshKeyBtnRadius(trigger, btnRect),
        shapePreset: 'shapeClose',
        contentPreset: 'contentClose',
        faceInDelay: 0.04,
    });
    const cap = new Promise(r => window.setTimeout(r, 900));
    Promise.race([closed, cap]).then(() => {
        requestAnimationFrame(() => finish());
    }).catch((err) => {
        console.warn('[sshkey1] iosAppClose failed', err);
        finish();
    });
}
async function saveSshKey(e) {
    e.preventDefault();
    const id = $('#sshKeyId').value;
    const payload = { name: $('#sshKeyName').value.trim(), privateKey: $('#sshKeyPrivateKey').value, passphrase: $('#sshKeyPassphrase').value, remark: $('#sshKeyRemark').value.trim() };
    console.debug('[ssh-key-ui]', 'save ssh key payload', { id, name: payload.name, hasPrivateKey: !!payload.privateKey && payload.privateKey !== '******', hasPassphrase: !!payload.passphrase && payload.passphrase !== '******' });
    await api(id ? `/api/ssh-keys/${id}` : '/api/ssh-keys', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    closeSshKeyModal();
    await loadNetwork();
    toast(t('SSH 密钥已保存'));
}
async function openSshKeySecret(id, trigger = null) {
    const secret = await requestSensitiveSecret('查看已保存 SSH 密钥');
    const data = await api(`/api/ssh-keys/${id}/open`, { method: 'POST', body: JSON.stringify({ secret }) });
    const k = data.sshKey || {};
    openSshKeyModal(k, trigger);
    $('#sshKeyId').value = k.id || '';
    $('#sshKeyName').value = k.name || '';
    $('#sshKeyPrivateKey').value = k.privateKey || '';
    $('#sshKeyPassphrase').value = k.passphrase || '';
    $('#sshKeyRemark').value = k.remark || '';
    console.debug('[ssh-key-ui]', 'ssh key secret loaded', { id, hasPrivateKey: !!k.privateKey, hasPassphrase: !!k.passphrase });
    toast(t('已载入 SSH 密钥内容'));
}

function bindConnectionPressFeedback(root = document) {
    // 故意不含 #addProxyBtn：代理弹窗只保留 iosAppOpen 路径，不叠加 CSS press。
    const pressableSelector = '#addConnectionBtn, #addSshKeyBtn, #addSnippetBtn, [data-edit]';
    const clearPress = (el) => el?.classList?.remove('connection-pressing');
    root.addEventListener('pointerdown', (e) => {
        const target = e.target.closest?.(pressableSelector);
        if (!target || target.disabled) return;
        target.classList.add('connection-pressing');
    }, { passive: true });
    root.addEventListener('pointerup', (e) => clearPress(e.target.closest?.(pressableSelector)), { passive: true });
    root.addEventListener('pointercancel', (e) => clearPress(e.target.closest?.(pressableSelector)), { passive: true });
    root.addEventListener('pointerleave', (e) => clearPress(e.target.closest?.(pressableSelector)), { passive: true });
    root.addEventListener('click', (e) => {
        const target = e.target.closest?.(pressableSelector);
        if (!target) return;
        window.setTimeout(() => clearPress(target), 120);
    }, true);
    // 预热引擎（绑 Motion.press 按压）——不阻塞
    try { sshKeyMotion._ensure(); } catch {}
}

function bindEvents() {
    document.documentElement.dataset.appBindEvents = 'start';
    bindConnectionPressFeedback();
    $$('.nav-tab').forEach((btn) => btn.addEventListener('click', () => switchView(btn.dataset.view, { cardFlipSource: btn })));
    $$('.settings-tab').forEach((btn) => btn.addEventListener('click', () => {
        $$('.settings-tab').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        $$('.settings-panel').forEach((p) => p.classList.remove('active'));
        $(`#settings-${btn.dataset.settings}`).classList.add('active');
        // Leaving AI settings collapses model subpages without trapping navigation.
        if (btn.dataset.settings !== 'ai') {
            if ($('#settingsAiModelDetailPage')?.classList.contains('is-open')) closeAiModelDetailPage({ skipParent: true }).catch(() => {});
            if ($('#settingsAiModelsPage')?.classList.contains('is-open')) closeAiModelsPage().catch(() => {});
        }
        scheduleWorkspaceSave('settings-tab');
    }));
    ['view-settings', 'view-dashboard', 'view-activity'].forEach((id) => document.getElementById(id)?.addEventListener('scroll', () => scheduleWorkspaceSave(`${id}-scroll`), { passive: true }));
    $('#appThemeToggle').addEventListener('click', () => toggleTheme().catch((err) => toast(err.message))); $('#settingsThemeToggle').addEventListener('click', () => toggleTheme().catch((err) => toast(err.message))); $('#logoutBtn')?.addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/'; });
    bindLocaleSelects();
    $('#notesSettingsForm')?.addEventListener('submit', saveNotesSettings);
    $('#webDavSettingsForm')?.addEventListener('submit', (event) => {
        event.preventDefault();
        saveWebDavSettings();
    });
    $('#webDavTestBtn')?.addEventListener('click', testWebDavConnection);
    $('#webDavSyncNowBtn')?.addEventListener('click', syncWebDavNow);
    $('#webDavDeleteBtn')?.addEventListener('click', deleteWebDavSettings);
    $('#webDavCancelBtn')?.addEventListener('click', cancelWebDavOperation);
    $('#webDavRetryBtn')?.addEventListener('click', retryWebDavOperation);
    $('#webDavEnabled')?.addEventListener('change', updateWebDavActionAvailability);
    $('#webDavBaseUrl')?.addEventListener('input', (event) => {
        event.currentTarget.setCustomValidity('');
        updateWebDavCredentialOriginHint();
        updateWebDavActionAvailability();
    });
    $('#webDavUsername')?.addEventListener('input', trackWebDavCredentialInputOrigin);
    $('#webDavPassword')?.addEventListener('input', trackWebDavCredentialInputOrigin);
    $('#notifyLoginPersonal')?.addEventListener('change', () => savePersonalLoginNotification().catch((err) => toast(err.message || '保存通知设置失败')));
    $('#adminAddUserBtn')?.addEventListener('click', (e) => openAdminAddUserDialog(e.currentTarget));
    $('#adminUserForm')?.addEventListener('submit', (e) => { saveAdminUser(e).catch((err) => toast(err.message || t('创建失败'))); });
    $('#adminUserCloseBtn')?.addEventListener('click', closeAdminUserModal);
    $('#adminUserCancelBtn')?.addEventListener('click', closeAdminUserModal);
    $('#adminUserModal')?.addEventListener('click', (e) => { if (e.target.id === 'adminUserModal') closeAdminUserModal(); });
    $('#adminUserModalScrim')?.addEventListener('click', () => { if ($('#adminUserModal')?.classList.contains('show')) closeAdminUserModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#adminUserModal')?.classList.contains('show')) closeAdminUserModal(); });
    document.getElementById('adminUserList')?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-admin-action]');
        if (!btn) return;
        handleAdminAction(btn.dataset.adminAction, btn.dataset.userId);
    });
    $('#addConnectionBtn').addEventListener('click', (e) => openModal(null, e.currentTarget, { mode: 'create', source: 'dashboard' })); $('#closeModalBtn').addEventListener('click', closeModal); $('#cancelModalBtn').addEventListener('click', closeModal); $('#toggleConnPassword').addEventListener('click', () => { const el = $('#connPassword'); el.type = el.type === 'password' ? 'text' : 'password'; $('#toggleConnPassword').textContent = el.type === 'password' ? '👁️' : '🙈'; }); $('#revealConnSecrets').addEventListener('click', () => revealConnectionSecrets().catch((err) => toast(err.message))); $$('.route-type-tab').forEach((btn) => btn.addEventListener('click', () => setRouteMode($('#connMode').value === btn.dataset.routeMode ? 'direct' : btn.dataset.routeMode))); $('#addJumpRouteBtn').addEventListener('click', addJumpRouteRow); $('#jumpRouteList').addEventListener('click', (e) => { if (!e.target.closest?.('[data-remove-jump-route]')) return; const ids = $$('#jumpRouteList [data-jump-route-select]').filter((el) => !el.closest('[data-jump-route-row]').contains(e.target)).map((el) => el.value).filter(Boolean); renderJumpRouteRows(ids); }); $('#testConnectionBtn').addEventListener('click', testConnection); $('#connectTransientBtn')?.addEventListener('click', () => connectTransient().catch((err) => toast(err.message)));
    $('#connEphemeral')?.addEventListener('change', applyEphemeralToggleFromUi);
    $('#connProtocol').addEventListener('change', () => updateProtocolFields({ preservePort: false }));
    $('#rdpTouchMode')?.addEventListener('change', updateRdpTouchSettingsUi);
    $('#rdpTouchSensitivity')?.addEventListener('input', updateRdpTouchSettingsUi);
    $('#connectionForm').addEventListener('submit', saveConnection);
    // Toggle-select shells before restore so faces pick up saved values.
    enhanceAllToggleSelects();
    restoreConnectionFilters();
    ['searchInput', 'protocolFilter', 'tagFilter', 'sortSelect'].forEach((id) => {
        const el = $(`#${id}`);
        if (!el) return;
        const handler = () => { saveConnectionFilters(); renderConnections(); };
        el.addEventListener('input', handler);
        el.addEventListener('change', handler);
    });
    // Settings/appearance selects may mount later with settings HTML — re-enhance after loadSettings.
    window.__zephyrEnhanceToggleSelects = enhanceAllToggleSelects;
    $$('[data-activity-range]').forEach((button) => {
        button.addEventListener('pointerdown', () => previewActivityRangeSelection(button), { passive: true });
        button.addEventListener('pointercancel', () => syncActivityRangeThumb());
        button.addEventListener('click', async () => {
            const next = button.dataset.activityRange || '7d';
            if (next === activityRange && button.classList.contains('active')) {
                if (next !== 'custom') return;
            }
            const customRangeMotion = setActivityRangeSelection(next, { animate: true });
            // Closing the date controls animates layout. Do not simultaneously
            // replace a potentially long activity list on the main thread.
            if (next !== 'custom') {
                await customRangeMotion;
                await loadActivities();
            }
        });
    });
    const activityRangeTabs = document.querySelector('.activity-range-tabs');
    if (activityRangeTabs) {
        setActivityRangeSelection(activityRange, { animate: false });
        requestAnimationFrame(() => syncActivityRangeThumb({ instant: true }));
        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(() => syncActivityRangeThumb({ instant: true }));
            ro.observe(activityRangeTabs);
            activityRangeTabs.querySelectorAll('.activity-range-btn').forEach((btn) => ro.observe(btn));
        }
        window.addEventListener('resize', () => syncActivityRangeThumb({ instant: true }), { passive: true });
    }
    $('#applyActivityRange')?.addEventListener('click', async () => {
        const bounds = activityRangeBounds('custom');
        if (bounds.from && bounds.to && bounds.from > bounds.to) return toast(t('开始日期不能晚于结束日期'));
        await loadActivities();
    });
    $('#connectionGrid').addEventListener('click', async (e) => {
        const hotline = e.target.closest?.('[data-copy-hotline]')?.dataset.copyHotline;
        if (hotline) {
            e.preventDefault();
            await copyTextToClipboard(hotline, '热线号码已复制');
            return;
        }
        const edit = e.target.closest?.('[data-edit]')?.dataset.edit, del = e.target.closest?.('[data-delete]')?.dataset.delete, connect = e.target.closest?.('[data-connect]')?.dataset.connect;
        if (edit) openModal(connections.find((c) => c.id === edit), e.target.closest?.('[data-edit]'));
        if (del && confirm(t('确定删除该连接？'))) {
            const card = e.target.closest?.('.connection-card');
            try {
                await waitForConnectionCardExit(card, del);
                await api(`/api/connections/${del}`, { method: 'DELETE' });
                await loadConnections();
                toast(t('连接已删除'));
            } catch (err) {
                card?.classList.remove('deleting');
                card?.querySelectorAll('button').forEach((btn) => { btn.disabled = false; });
                console.debug('[connection-card]', 'delete failed, animation reverted', { connectionId: del, message: err.message });
                toast(err.message);
            }
        }
        if (connect) {
            const sourceCard = e.target.closest?.('.connection-card') || e.target.closest?.('[data-connect]')?.closest?.('.connection-card') || e.target.closest?.('[data-connect]');
            openConnectionWithCardFlip(connect, sourceCard).catch((err) => toast(err.message));
        }
    });
    $('#sessionTabs').addEventListener('click', (e) => {
        if (suppressSmartbarClick) { suppressSmartbarClick = false; return; }
        const toggle = e.target.closest?.('[data-smartbar-toggle]');
        if (toggle) { setTerminalSmartbarOpen(!terminalSmartbarOpen); return; }
        if (e.target.closest?.('[data-mobile-exit-fullscreen]')) { exitTerminalFullscreen(); setTerminalSmartbarOpen(false); return; }
        if (e.target.closest?.('[data-smartbar-add]')) {
            terminalSmartbarPickerOpen = !terminalSmartbarPickerOpen;
            setTerminalSmartbarOpen(true);
            requestAnimationFrame(positionSmartbarPicker);
            return;
        }
        const tabButton = e.target.closest?.('[data-smartbar-tab]');
        const tab = tabButton?.dataset.smartbarTab;
        if (tab) activateTerminalFromDock(tab, tabButton);
    });
    document.addEventListener('pointerdown', (e) => {
        const toggle = e.target.closest?.('.mobile-fullscreen-dock-toggle');
        if (!toggle) return;
        e.preventDefault();
        e.stopPropagation();
        mobileDockTogglePressState = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            moved: false,
            toggle,
        };
        toggle.classList.add('is-pressing');
        try { toggle.setPointerCapture?.(e.pointerId); } catch (_) {}
        document.querySelectorAll('#terminalWorkspace .terminal-frame').forEach((frame) => frame.style.pointerEvents = 'none');
    }, true);
    document.addEventListener('pointermove', (e) => {
        const state = mobileDockTogglePressState;
        if (!state || e.pointerId !== state.pointerId) return;
        if (Math.hypot(e.clientX - state.startX, e.clientY - state.startY) > 10) state.moved = true;
        e.preventDefault();
        e.stopPropagation();
    }, true);
    document.addEventListener('pointerup', (e) => {
        const state = mobileDockTogglePressState;
        if (!state || e.pointerId !== state.pointerId) return;
        e.preventDefault();
        e.stopPropagation();
        mobileDockTogglePressState = null;
        state.toggle?.classList.remove('is-pressing');
        try { state.toggle?.releasePointerCapture?.(e.pointerId); } catch (_) {}
        if (!state.moved) {
            mobileDockToggleLastToggleAt = Date.now();
            setTerminalSmartbarOpen(!terminalSmartbarOpen);
        } else if (!terminalSmartbarOpen) {
            document.querySelectorAll('#terminalWorkspace .terminal-frame').forEach((frame) => frame.style.pointerEvents = '');
        }
    }, true);
    document.addEventListener('pointercancel', (e) => {
        const state = mobileDockTogglePressState;
        if (!state || e.pointerId !== state.pointerId) return;
        mobileDockTogglePressState = null;
        state.toggle?.classList.remove('is-pressing');
        if (!terminalSmartbarOpen) document.querySelectorAll('#terminalWorkspace .terminal-frame').forEach((frame) => frame.style.pointerEvents = '');
    }, true);
    document.addEventListener('click', (e) => {
        if (e.target.closest?.('.smartbar-handle')) {
            e.preventDefault();
            e.stopPropagation();
            if (Date.now() - mobileDockToggleLastToggleAt > 180) {
                mobileDockToggleLastToggleAt = Date.now();
                setTerminalSmartbarOpen(!terminalSmartbarOpen);
            }
            return;
        }
        if (e.target.closest?.('.mobile-fullscreen-dock-toggle')) {
            e.preventDefault();
            e.stopPropagation();
            if (Date.now() - mobileDockToggleLastToggleAt > 450) {
                mobileDockToggleLastToggleAt = Date.now();
                setTerminalSmartbarOpen(!terminalSmartbarOpen);
            }
            return;
        }
        if (e.target.closest?.('[data-smartbar-picker-close]')) { terminalSmartbarPickerOpen = false; renderTerminalSmartbar(); return; }
        const connect = e.target.closest?.('[data-smartbar-connect]')?.dataset.smartbarConnect;
        if (connect) {
            terminalSmartbarPickerOpen = false;
            setTerminalSmartbarOpen(false);
            const sourceBtn = e.target.closest?.('[data-smartbar-connect]') || document.querySelector(`[data-smartbar-connect="${CSS.escape(String(connect))}"]`);
            openConnectionWithCardFlip(connect, sourceBtn).catch((err) => toast(err.message));
        }
    }, true);
    $('#sessionTabs').addEventListener('pointerdown', (e) => {
        if (isTerminalSmartbarInteractionTarget(e.target)) {
            noteTerminalSmartbarPointerInside(true);
            window.clearTimeout(terminalSmartbarTimer); // 在区域内：暂停自动关闭
        }
        const tabBtn = e.target.closest?.('[data-smartbar-tab]');
        if (!tabBtn) return;
        startSmartbarPress(e, tabBtn);
    });
    $('#sessionTabs').addEventListener('pointermove', (e) => {
        if (terminalSmartbarOpen && isTerminalSmartbarInteractionTarget(e.target)) {
            noteTerminalSmartbarPointerInside(true);
            window.clearTimeout(terminalSmartbarTimer);
        }
        const dock = e.target.closest?.('.smartbar-dock');
        if (dock) {
            if (e.target.closest?.('[data-smartbar-tab]')) e.preventDefault?.();
            // 懒加载引擎：首次 hover 前确保 ready，后续 pointermove 全走 dock 弹簧。
            if (!sshKeyMotion.engine && !sshKeyMotion.failed) sshKeyMotion._ensure().catch(() => {});
            updateDockMagnification(e.clientX, dock, e.clientY);
        }
    }, { passive: false });
    $('#sessionTabs').addEventListener('pointerleave', (e) => {
        resetDockMagnification(e.currentTarget.querySelector('.smartbar-dock'));
        // 指针离开整个 sessionTabs：开始 10s 自动关闭
        if (terminalSmartbarOpen) {
            noteTerminalSmartbarPointerInside(false);
            scheduleTerminalSmartbarAutoClose(TERMINAL_SMARTBAR_AUTO_CLOSE_MS);
        }
    });
    // picker 层不在 #sessionTabs 内，单独续命
    document.getElementById('smartbarPickerLayer')?.addEventListener('pointerenter', () => {
        if (!terminalSmartbarOpen) return;
        noteTerminalSmartbarPointerInside(true);
        window.clearTimeout(terminalSmartbarTimer);
    });
    document.getElementById('smartbarPickerLayer')?.addEventListener('pointerleave', () => {
        if (!terminalSmartbarOpen) return;
        noteTerminalSmartbarPointerInside(false);
        scheduleTerminalSmartbarAutoClose(TERMINAL_SMARTBAR_AUTO_CLOSE_MS);
    });
    // dock 指针离开整个 sessionTabs 容器时复位；离开单个 item 不复位（跨 item 连续放大）。
    document.addEventListener('pointerdown', (e) => {
        if (!terminalSmartbarOpen) return;
        if (e.target.closest?.('[data-smartbar-toggle], .mobile-fullscreen-dock-toggle')) return;
        if (isTerminalSmartbarInteractionTarget(e.target)) {
            noteTerminalSmartbarPointerInside(true);
            window.clearTimeout(terminalSmartbarTimer);
            return;
        }
        // 点 dock 外：立即收起（保持原行为）
        setTerminalSmartbarOpen(false);
        document.querySelectorAll('#terminalWorkspace .terminal-frame').forEach((frame) => frame.style.pointerEvents = '');
    }, true);
    $('#terminalWorkspace').addEventListener('click', (e) => {
        const action = e.target.closest?.('[data-window-action]');
        if (!action) return;
        noteTerminalWorkspaceActivity();
        e.preventDefault();
        e.stopPropagation();
        action.dataset.windowActionHandled = '1';
        runTerminalWindowActionButton(action);
    }, true);
    $('#terminalWorkspace').addEventListener('click', (e) => {
        noteTerminalWorkspaceActivity();
        const menuBtn = e.target.closest?.('[data-window-control]');
        closeOtherTerminalWindowMenus(menuBtn);
        if (menuBtn) {
            e.stopPropagation();
            if (terminalControlLongPress) {
                terminalControlLongPress = false;
                return;
            }
            const titlebar = menuBtn.closest('.terminal-window-titlebar');
            if (titlebar?.classList.contains('menu-open')) {
                closeTerminalWindowMenu(titlebar);
            } else {
                openTerminalWindowMenu(titlebar);
            }
            console.info('[DynamicIslandDiagnostics]', {
                event: 'terminal-window-menu-toggle',
                tabId: menuBtn.dataset.windowControl || '',
                open: titlebar?.classList.contains('menu-open') || false,
                longPressSuppressed: false,
            });
            return;
        }
        const action = e.target.closest?.('[data-window-action]');
        if (action) {
            e.preventDefault();
            e.stopPropagation();
            if (!action.dataset.windowActionHandled) runTerminalWindowActionButton(action);
            delete action.dataset.windowActionHandled;
            return;
        }
        const win = e.target.closest?.('[data-window]');
        if (win) { activeTerminalTab = win.dataset.window; touchTerminalSession(activeTerminalTab); renderTerminalTabs({ rebuildWorkspace: false }); }
    });
    $('#terminalWorkspace').addEventListener('pointerdown', (e) => {
        if (e.target.closest?.('[data-window-action]')) {
            e.stopPropagation();
            return;
        }
        const splitter = e.target.closest?.('[data-splitter]');
        if (splitter) { startWorkspaceSplitterDrag(e, splitter.dataset.splitter); return; }
        const control = e.target.closest?.('[data-window-control]');
        if (control) {
            const tabId = control.dataset.windowControl;
            terminalControlLongPress = false;
            control.classList.add('island-pressing');
            const releaseIslandPress = () => control.classList.remove('island-pressing');
            const timer = window.setTimeout(() => {
                terminalControlLongPress = true;
                control.closest('.terminal-window-titlebar')?.classList.remove('menu-open');
                releaseIslandPress();
                startTerminalWindowDrag(e, tabId);
            }, 360);
            const cleanup = () => {
                window.clearTimeout(timer);
                releaseIslandPress();
                window.removeEventListener('pointerup', cleanup);
                window.removeEventListener('pointercancel', cleanup);
            };
            window.addEventListener('pointerup', cleanup, { once: true });
            window.addEventListener('pointercancel', cleanup, { once: true });
        }
    });
    document.addEventListener('pointerdown', (e) => {
        if (e.target.closest?.('[data-window-control], .terminal-window-menu')) return;
        closeOtherTerminalWindowMenus();
    }, true);
    ['keydown', 'pointerdown'].forEach((eventName) => document.addEventListener(eventName, (e) => { if (e.target.closest?.('#terminalWorkspace')) noteTerminalWorkspaceActivity(); }, true));
    ['fullscreenchange', 'webkitfullscreenchange'].forEach((eventName) => document.addEventListener(eventName, () => {
        const workspace = $('#terminalWorkspace');
        const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
        const isTerminalFullscreen = fullscreenElement === workspace || fullscreenElement?.classList?.contains('terminal-window');
        if (isTerminalFullscreen) {
            sshKbParentBaseline = Math.max(window.innerHeight || 0, document.documentElement.clientHeight || 0, window.visualViewport?.height || 0);
            scheduleTerminalKeyboardReflow('native-fullscreen-change');
        } else {
            resetTerminalWorkspaceKeyboard();
            // Native browser fullscreen only — custom mobile stretch path owns its class.
            if (!workspace?.classList.contains('custom-fullscreen')) {
                document.body.classList.remove('terminal-custom-fullscreen-open');
            }
        }
    }));
    systemThemeQuery.addEventListener('change', () => {
        if (isAutoThemeEnabled()) {
            const theme = getSystemTheme();
            console.debug('[appearance-client]', 'system theme changed', { theme });
            applyTheme(theme);
        }
    });
    window.addEventListener('message', (e) => {
        if (e.data?.source !== 'zephyr-terminal') return;
        if (handleSharedClipboardMessage(e.data)) return;
        if (e.data.type === 'rdp-file-open-share' || e.data.type === 'rdp-sftp-clipboard-paste-ack') {
            const targetFrame = terminalFrameById(String(e.data.tabId || ''));
            if (targetFrame?.contentWindow) {
                targetFrame.contentWindow.postMessage({ source: 'zephyr-app', type: e.data.type, ...e.data }, '*');
            }
            return;
        }
        if (e.data.type === 'ai-remote-desktop-action-result') {
            const actionId = String(e.data.actionId || '');
            const resolve = aiRemoteDesktopActionWaiters.get(actionId);
            if (resolve) resolve(e.data);
            return;
        }
        if (e.data.type === 'keyboard-metrics' || e.data.type === 'ssh-kb') {
            const tabId = String(e.data.tabId || '');
            if (tabId && tabId !== activeTerminalTab) return;
            if (e.data.fallback && e.data.stableInput) return;
            // Single parent hysteresis via reduceParentKeyboardMessage (open≥80, close<12).
            const reduced = reduceParentKeyboardMessage(e.data, {
                open: !!sshKbParentOpen,
                inset: sshKbParentInset || Number.parseInt(document.documentElement.style.getPropertyValue('--app-keyboard-inset') || '0', 10) || 0,
            });
            if (reduced.changed || reduced.open) sshKbParentInset = reduced.inset;
            if (reduced.cmd) {
                window.clearTimeout(applyTerminalWorkspaceKeyboard._closeDebounce);
                if (sshKbParentOpen) resetTerminalWorkspaceKeyboard({ force: false });
                return;
            }
            if (!reduced.changed && (e.data.type === 'ssh-kb')) {
                // Still apply if legacy path needs continuous metrics while open.
                if (!reduced.open) return;
            }
            window.clearTimeout(applyTerminalWorkspaceKeyboard._closeDebounce);
            if (reduced.open) {
                // Reopen must never wait out a residual close freeze.
                postTerminalKeyboardFreeze(false, 'parent-child-open-intent');
                applyTerminalWorkspaceKeyboard({
                    ...e.data,
                    keyboardOpen: true,
                    keyboardInset: reduced.inset,
                    intent: e.data.intent || 'open',
                    phase: e.data.phase || 'opening',
                    stableInput: e.data.stableInput !== false,
                });
            } else {
                // F3: no debounce - align-loop's 160ms low-inset confirm is the sole close gate.
                resetTerminalWorkspaceKeyboard({ force: false });
            }
            // Mirror unified CSS class/var on parent document for diagnostics.
            try {
                document.documentElement.classList.toggle('ssh-kb-open', !!reduced.open);
                document.documentElement.style.setProperty('--ssh-kb-inset', `${reduced.open ? reduced.inset : 0}px`);
            } catch (_) {}
            return;
        }
        if (e.data.type === 'activity') {
            noteTerminalWorkspaceActivity();
            return;
        }
        if (e.data.type === 'close-request') {
            console.info('[terminal-layout]', 'close request from terminal iframe', {
                tabId: e.data.tabId,
                reason: e.data.reason,
                tabCount: terminalTabs.length,
                compact: isCompactTerminalWorkspace(),
            });
            closeTerminalTab(e.data.tabId, { reason: e.data.reason || 'iframe-close-request' });
            return;
        }
        if (e.data.type === 'download-url') {
            let downloadUrl;
            try {
                downloadUrl = new URL(e.data.url || '', location.href);
                if (downloadUrl.origin !== location.origin) throw new Error('cross-origin download blocked');
            } catch (err) {
                console.warn('[terminal-download]', 'ignored invalid download url', { message: err.message });
                return;
            }
            const a = document.createElement('a');
            a.href = downloadUrl.href;
            a.download = String(e.data.name || 'download');
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            window.setTimeout(() => { try { a.remove(); } catch {} }, 1000);
            return;
        }
        const t = terminalTabs.find((x) => x.id === e.data.tabId);
        if (t) {
            const reconnectTimer = terminalReconnectFallbackTimers.get(t.id);
            if (reconnectTimer && e.data.status) {
                window.clearTimeout(reconnectTimer);
                terminalReconnectFallbackTimers.delete(t.id);
            }
            t.status = e.data.status || t.status;
            if (e.data.status === 'connected') {
                t.snapshotText = '';
                document.querySelector(`.terminal-snapshot[data-snapshot-for="${CSS.escape(t.id)}"]`)?.remove();
            }
            renderTerminalTabs({ rebuildWorkspace: false });
        }
    });
    window.visualViewport?.addEventListener('resize', () => { updateFullscreenKeyboardFromViewport(); scheduleCompactKeyboardViewportCheck('visualViewport-resize'); }, { passive: true });
    window.addEventListener('resize', () => {
        document.querySelectorAll('.terminal-window-titlebar.menu-open').forEach(positionTerminalWindowMenu);
    }, { passive: true });
    window.addEventListener('resize', () => { updateFullscreenKeyboardFromViewport(); scheduleCompactKeyboardViewportCheck('window-resize'); }, { passive: true });
    window.visualViewport?.addEventListener('scroll', () => { updateFullscreenKeyboardFromViewport(); scheduleCompactKeyboardViewportCheck('visualViewport-scroll'); }, { passive: true });
    window.addEventListener('resize', () => {
        if (!terminalTabs.length) return;
        if (isCompactTerminalWorkspace()) {
            renderTerminalSmartbar();
            renderTerminalTabs({ rebuildWorkspace: false });
            return;
        }
        enforceTerminalWorkspaceLimit(activeTerminalTab);
        renderTerminalTabs();
    });
    // 连接窗与新建代理同源：点 backdrop / scrim 空白立即反向打断 opening。
    $('#connectionModal')?.addEventListener('click', (e) => {
        if (e.target.id === 'connectionModal' && $('#connectionModal')?.classList.contains('show')) closeModal();
    });
    $('#connectionModalScrim')?.addEventListener('click', () => {
        if ($('#connectionModal')?.classList.contains('show')) closeModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && $('#connectionModal')?.classList.contains('show')) closeModal();
    });
    $('#remoteExecForm').addEventListener('submit', remoteExecute); $('#beianForm').addEventListener('submit', saveBeian); $('#proxyForm').addEventListener('submit', saveProxy); $('#addProxyBtn')?.addEventListener('click', (e) => openProxyModal(null, e.currentTarget)); $('#proxyCloseBtn')?.addEventListener('click', closeProxyModal); $('#proxyCancelBtn')?.addEventListener('click', closeProxyModal); $('#proxyModal')?.addEventListener('click', (e) => { if (e.target.id === 'proxyModal') closeProxyModal(); }); $('#proxyModalScrim')?.addEventListener('click', () => { if ($('#proxyModal')?.classList.contains('show')) closeProxyModal(); }); document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#proxyModal')?.classList.contains('show')) closeProxyModal(); }); $('#sshKeyForm').addEventListener('submit', saveSshKey); $('#addSshKeyBtn')?.addEventListener('click', (e) => openSshKeyModal(null, e.currentTarget)); $('#sshKeyCloseBtn')?.addEventListener('click', closeSshKeyModal); $('#sshKeyCancelBtn')?.addEventListener('click', closeSshKeyModal); // 点模糊遮罩关闭（仅 target 为 backdrop 本身，点表单不关）。可打断飞行中动画。
$('#sshKeyModal')?.addEventListener('click', (e) => { if (e.target.id === 'sshKeyModal') closeSshKeyModal(); });
$('#sshKeyModalScrim')?.addEventListener('click', () => { if ($('#sshKeyModal')?.classList.contains('show')) closeSshKeyModal(); }); document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#sshKeyModal')?.classList.contains('show')) closeSshKeyModal(); });
    setupAiAssistant();
    $('#brandIconFile').addEventListener('change', async (e) => { try { const dataUrl = await readImageAsDataUrl(e.target.files?.[0]); if (!dataUrl) return; pendingBrandIcon = dataUrl; $('#brandIconPreview').innerHTML = iconHtml(dataUrl); console.debug('[appearance-client]', 'brand icon file loaded', { size: e.target.files?.[0]?.size || 0, type: e.target.files?.[0]?.type || '' }); } catch (err) { e.target.value = ''; toast(err.message); } });
    setupAppearanceControls();
    $('#resetAppearanceBtn').addEventListener('click', () => resetAppearance().catch((err) => toast(err.message)));
    $('#proxyList').addEventListener('click', async (e) => { const id = e.target.dataset.editProxy || e.target.dataset.openProxy || e.target.dataset.delProxy; if (!id) return; const p = proxies.find((x) => x.id === id); if (e.target.dataset.editProxy) openProxyModal(p, e.target); else if (e.target.dataset.openProxy) { await openProxySecret(id, e.target); } else if (confirm(t('删除代理？'))) { await waitForMiniItemExit(e.target.closest('.mini-item'), id); await api(`/api/proxies/${id}`, { method: 'DELETE' }); await loadNetwork(); toast(t('代理已删除')); } });
    $('#sshKeyList').addEventListener('click', async (e) => { const editId = e.target.dataset.editSshKey, openId = e.target.dataset.openSshKey, delId = e.target.dataset.delSshKey; if (editId) { const k = sshKeys.find((x) => x.id === editId); if (k) openSshKeyModal(k, e.target); return; } if (openId) { await openSshKeySecret(openId, e.target); return; } if (delId && confirm(t('删除该 SSH 密钥？已选择它的连接将无法再使用该密钥。'))) { await waitForMiniItemExit(e.target.closest('.mini-item'), delId); await api(`/api/ssh-keys/${delId}`, { method: 'DELETE' }); await loadNetwork(); toast(t('SSH 密钥已删除')); } });
    $('#passwordForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const currentPassword = $('#settingsCurrentPassword').value;
        const newPassword = $('#settingsNewPassword').value;
        const confirmPassword = $('#settingsConfirmPassword').value;
        if (newPassword !== confirmPassword) return toast(t('两次输入的新密码不一致'));
        const totpCode = $('#settingsTotpCode')?.value || '';
        const emailCode = $('#settingsEmailCode')?.value || '';
        try {
            const result = await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword, totpCode, emailCode }) });
            e.target.reset();
            updatePasswordFormFields();
            toast(t('密码已更新'));
            openPasswordChangedModal(result || {});
        } catch (err) {
            toast(err.message);
        }
    });
    $('#passwordChangedCloseBtn')?.addEventListener('click', closePasswordChangedModal);
    $('#passwordChangedOkBtn')?.addEventListener('click', closePasswordChangedModal);
    $('#passwordChangedModal')?.addEventListener('click', (e) => { if (e.target.id === 'passwordChangedModal') closePasswordChangedModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePasswordChangedModal(); });
    $('#passwordChangedCopyBtn')?.addEventListener('click', async () => {
        const value = $('#passwordChangedRollbackUrl')?.value || '';
        if (!value) return;
        try {
            await navigator.clipboard.writeText(value);
            toast(t('链接已复制'));
        } catch {
            $('#passwordChangedRollbackUrl')?.select();
            toast(t('复制失败，请手动复制'));
        }
    });
    $('#settingsSendCodeBtn')?.addEventListener('click', async () => {
        try {
            const btn = $('#settingsSendCodeBtn');
            btn.disabled = true;
            const r = await api('/api/auth/change-password/request-code', { method: 'POST', body: '{}' });
            toast(r.message || t('验证码已发送'));
            let countdown = 60;
            const timer = setInterval(() => {
                btn.textContent = `${countdown}s`;
                countdown--;
                if (countdown < 0) { clearInterval(timer); btn.disabled = false; btn.textContent = t('发送验证码'); }
            }, 1000);
        } catch (err) {
            $('#settingsSendCodeBtn').disabled = false;
            toast(err.message);
        }
    });
    $('#profileForm')?.addEventListener('submit', async (e) => { e.preventDefault(); await api('/api/security/profile', { method: 'PUT', body: JSON.stringify({ username: $('#profileUsername').value.trim(), email: $('#profileEmail').value }) }); toast(t('资料已保存')); await loadSecurityStatus(); });
    $('#securityPolicyForm')?.addEventListener('submit', saveSecurityPolicy); $('#captchaForm')?.addEventListener('submit', saveCaptcha); $('#mailForm').addEventListener('submit', saveMail); $('#appearanceForm').addEventListener('submit', saveAppearance); $('#terminalLayoutForm').addEventListener('submit', saveTerminalLayout); setupSnippetSettings(); setupAgentTokenSettings();
    $('#sessionPersistenceEnabled')?.addEventListener('change', async (e) => {
        const input = e.currentTarget;
        input.disabled = true;
        try {
            await setSessionPersistenceEnabled(input.checked);
        } catch (err) {
            input.checked = isSessionPersistenceEnabled();
            toast(err.message || t('保存会话持久化设置失败'));
        } finally {
            input.disabled = false;
        }
    });
    $('#totpAction')?.addEventListener('click', (e) => { if (e.target.id === 'setupTotpBtn') setupTotp().catch((err) => toast(err.message)); });
    $('#totpEnableForm')?.addEventListener('submit', async (e) => { e.preventDefault(); await api('/api/security/totp/enable', { method: 'POST', body: JSON.stringify({ code: $('#totpEnableCode').value }) }); toast(t('TOTP 已开启')); $('#totpEnableForm').classList.add('force-hidden'); await loadSecurityStatus(); });
    $('#totpDisableForm')?.addEventListener('submit', async (e) => { e.preventDefault(); if (!confirm(t('确定关闭 TOTP？'))) return; await api('/api/security/totp/disable', { method: 'POST', body: JSON.stringify({ currentPassword: $('#totpDisablePassword').value, code: $('#totpDisableCode').value }) }); e.target.reset(); toast(t('TOTP 已关闭')); await loadSecurityStatus(); });
    $('#addPasskeyBtn')?.addEventListener('click', () => registerPasskey().catch((err) => toast(err.message)));
    $('#passkeyList')?.addEventListener('click', async (e) => { const id = e.target.dataset.delPasskey; if (id && confirm(t('删除该 Passkey？'))) { await api(`/api/passkeys/${id}`, { method: 'DELETE' }); await loadSecurityStatus(); } });
    $('#ipBanList')?.addEventListener('click', async (e) => { const ip = e.target.dataset.unban; if (ip) { await api(`/api/security/ip-bans/${encodeURIComponent(ip)}`, { method: 'DELETE' }); await loadSecurityLists(); toast(t('已解除封禁')); } });
    $('#toggleCaptchaSecret')?.addEventListener('click', () => { const el = $('#captchaSecretKey'); el.type = el.type === 'password' ? 'text' : 'password'; $('#toggleCaptchaSecret').textContent = el.type === 'password' ? '👁️' : '🙈'; });
    $('#revealCaptchaSecret')?.addEventListener('click', () => revealCaptchaSecret().catch((err) => toast(err.message || '读取 CAPTCHA 密钥失败')));
    $('#toggleMailPassword').addEventListener('click', () => { const el = $('#mailPass'); el.type = el.type === 'password' ? 'text' : 'password'; $('#toggleMailPassword').textContent = el.type === 'password' ? '👁️' : '🙈'; });
    $('#revealMailPass').addEventListener('click', () => revealMailPass().catch((err) => toast(err.message || '读取 SMTP 密码失败')));
    $('#testMailBtn').addEventListener('click', () => testMail());
    $('#exportDataBtn').addEventListener('click', () => { location.href = '/api/data/export'; });
    $('#clearActivityBtn').addEventListener('click', async () => { if (!confirm(t('确定清理活动日志？'))) return; await api('/api/activities', { method: 'DELETE' }); await loadActivities(); toast(t('活动日志已清理')); });
    $('#clearLoginEventsBtn')?.addEventListener('click', async () => { if (!confirm(t('确定清理登录事件日志？'))) return; await api('/api/security/login-events', { method: 'DELETE' }); await loadSecurityLists(); toast(t('登录事件已清理')); });
    setupBackupImportUi();
}
function automaticWorkspaceId() {
    return `auto-${String(workspaceClientId || 'default').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80)}`;
}

const TERMINAL_SNAPSHOT_STORAGE_KEY = 'zephyr.workspace.terminal-snapshots.v1';

function readTerminalSnapshots() {
    try {
        const saved = JSON.parse(sessionStorage.getItem(TERMINAL_SNAPSHOT_STORAGE_KEY) || '{}');
        if (!saved || Date.now() - Number(saved.capturedAt || 0) > 24 * 60 * 60 * 1000) {
            sessionStorage.removeItem(TERMINAL_SNAPSHOT_STORAGE_KEY);
            return {};
        }
        return saved.snapshots || {};
    } catch {
        return {};
    }
}

function captureTerminalSnapshots() {
    const snapshots = {};
    terminalTabs.forEach((tab) => {
        if (tab.page !== 'terminal' || tab.minimized) return;
        const frame = terminalFrameById(tab.id);
        try {
            const text = frame?.contentWindow?.__zephyrGetScreenText?.();
            if (text) snapshots[tab.id] = String(text).slice(-64 * 1024);
        } catch {}
    });
    try { sessionStorage.setItem(TERMINAL_SNAPSHOT_STORAGE_KEY, JSON.stringify({ capturedAt: Date.now(), snapshots })); } catch {}
    return snapshots;
}

function removeTerminalSnapshot(tabId) {
    const snapshots = readTerminalSnapshots();
    if (!Object.hasOwn(snapshots, tabId)) return;
    delete snapshots[tabId];
    try { sessionStorage.setItem(TERMINAL_SNAPSHOT_STORAGE_KEY, JSON.stringify({ capturedAt: Date.now(), snapshots })); } catch {}
}

function collectTerminalFrameStates() {
    const states = {};
    terminalTabs.forEach((tab) => {
        const frame = terminalFrameById(tab.id);
        try {
            const state = frame?.contentWindow?.__zephyrGetWorkspaceState?.();
            if (state && typeof state === 'object') states[tab.id] = state;
        } catch {}
    });
    return states;
}

function collectWorkspaceState() {
    const workspace = $('#terminalWorkspace');
    const tabs = terminalTabs
        .filter((t) => t.connectionId && !t.transient)
        .map((t, index) => ({
            connectionId: t.connectionId,
            protocol: t.protocol || 'SSH',
            sessionId: t.sessionId || t.id || '',
            tabId: t.id,
            minimized: !!t.minimized,
            order: index,
            active: t.id === activeTerminalTab,
            page: t.page || 'terminal',
        }));
    return {
        version: 2,
        tabs,
        ui: {
            activeView: currentAppView,
            settingsSubTab: document.querySelector('.settings-tab.active')?.dataset.settings || 'security',
            settingsScrollY: $('#view-settings')?.scrollTop || 0,
            dashboardScrollY: $('#view-dashboard')?.scrollTop || 0,
        },
        terminal: {
            openOrderStack: [...openOrderStack],
            visualLayout: [...visualLayout],
            recentUseStack: [...recentUseStack],
            splitX: workspace?.style.getPropertyValue('--workspace-split-x') || '',
            splitY: workspace?.style.getPropertyValue('--workspace-split-y') || '',
            smartbarOpen: !!terminalSmartbarOpen,
            smartbarSide: terminalSmartbarSide,
            activeTerminalTab,
            tabs: collectTerminalFrameStates(),
        },
        panels: {
            ai: aiPanelState !== 'closed' ? { open: true, sessionId: aiCurrentSessionId || '' } : { open: false },
        },
        notes: {
            selectedId: notesController?.state?.selectedId || '',
            mode: notesController?.state?.mode || 'edit',
        },
        clipboard: {
            type: zephyrSharedClipboard.type || '',
            text: zephyrSharedClipboard.text || '',
            sourceTabId: zephyrSharedClipboard.sourceTabId || '',
            sourcePage: zephyrSharedClipboard.sourcePage || '',
        },
        activeConnectionId: terminalTabs.find((t) => t.id === activeTerminalTab)?.connectionId || '',
        activeSessionId: terminalTabs.find((t) => t.id === activeTerminalTab)?.sessionId
            || terminalTabs.find((t) => t.id === activeTerminalTab)?.id
            || '',
    };
}

function scheduleWorkspaceSave(reason = '', { immediate = false } = {}) {
    if (!isSessionPersistenceEnabled() || !workspaceReady || workspaceRestoring || !workspaceClientId) return;
    clearTimeout(workspaceSaveTimer);
    if (immediate) {
        workspaceSaveTimer = null;
        saveWorkspaceNow({ reason }).catch((err) => console.warn('[workspace-save]', err));
        return;
    }
    workspaceSaveTimer = setTimeout(() => saveWorkspaceNow({ reason }).catch((err) => console.warn('[workspace-save]', err)), 700);
}

async function saveWorkspaceNow({ keepalive = false, reason = '' } = {}) {
    if (!isSessionPersistenceEnabled() || !workspaceReady || workspaceRestoring || !workspaceClientId) return;
    clearTimeout(workspaceSaveTimer);
    workspaceSaveTimer = null;
    const body = {
        clientId: workspaceClientId,
        name: '默认工作区',
        state: collectWorkspaceState(),
        expectedRevision: workspaceRevision,
    };
    try {
        const data = await api(`/api/me/workspaces/${encodeURIComponent(automaticWorkspaceId())}`, {
            method: 'PUT',
            body: JSON.stringify(body),
            keepalive,
        });
        workspaceRevision = data.workspace?.revision ?? workspaceRevision;
        if (reason) console.debug('[workspace-save]', reason, { revision: workspaceRevision, tabs: body.state?.tabs?.length || 0, view: body.state?.ui?.activeView });
    } catch (err) {
        if (err.status === 409) {
            const latest = await api(`/api/me/workspaces/${encodeURIComponent(automaticWorkspaceId())}`);
            workspaceRevision = latest.workspace?.revision ?? null;
            body.expectedRevision = workspaceRevision;
            const data = await api(`/api/me/workspaces/${encodeURIComponent(automaticWorkspaceId())}`, {
                method: 'PUT',
                body: JSON.stringify(body),
                keepalive,
            });
            workspaceRevision = data.workspace?.revision ?? workspaceRevision;
            return;
        }
        throw err;
    }
}

async function restoreLastWorkspace() {
    if (!workspaceClientId || !isSessionPersistenceEnabled()) {
        workspaceRevision = null;
        workspaceRestoring = false;
        workspaceReady = true;
        return;
    }
    workspaceRestoring = true;
    try {
        // Backend only exposes POST /restore (GET falls through to Express 404 and was
        // previously swallowed, so refresh always dropped back to the dashboard).
        const restored = await api(`/api/me/workspaces/${encodeURIComponent(automaticWorkspaceId())}/restore`, {
            method: 'POST',
            body: '{}',
        });
        const workspace = restored.workspace;
        workspaceRevision = workspace?.revision ?? null;
        const state = workspace?.state || {};
        const savedTabs = Array.isArray(state.tabs)
            ? [...state.tabs]
                .filter((t) => t && t.connectionId && t.accessible !== false)
                .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
            : [];
        const view = String(state.ui?.activeView || 'dashboard');
        const allowedView = ['dashboard', 'activity', 'terminal', 'remote', 'notes', 'settings'].includes(view) ? view : 'dashboard';
        const preferTerminal = savedTabs.length > 0
            && (allowedView === 'terminal' || savedTabs.some((t) => t.active));
        // Switch view first so the user lands on the terminal shell immediately,
        // then re-attach sessions underneath (with history replay).
        if (preferTerminal) switchView('terminal');
        const snapshots = readTerminalSnapshots();
        const opened = new Map();
        const restoreTab = async (saved) => {
            const conn = connections.find((c) => c.id === saved.connectionId);
            if (!conn) return;
            try {
                const sessionId = String(saved.sessionId || saved.tabId || '').trim()
                    || stableTerminalSessionId(conn.id, saved.protocol || conn.protocol || 'SSH');
                const tabId = await openConnection(conn.id, {
                    sessionId,
                    tabId: sessionId,
                    skipViewSwitch: true,
                    skipConnectionsReload: true,
                    snapshotText: snapshots[sessionId] || snapshots[saved.tabId] || '',
                    workspaceState: state.terminal?.tabs?.[sessionId] || state.terminal?.tabs?.[saved.tabId] || null,
                });
                const tab = terminalTabs.find((t) => t.id === tabId && !opened.has(t.id));
                if (tab) {
                    tab.minimized = !!saved.minimized;
                    tab.sessionId = sessionId;
                    opened.set(tab.id, saved);
                }
            } catch (err) {
                console.warn('[workspace-restore] skip connection', conn.id, err);
            }
        };
        await Promise.allSettled(savedTabs.map(restoreTab));

        const restoredIds = new Set(terminalTabs.map((tab) => tab.id));
        const savedTerminal = state.terminal || {};
        const restoreOrder = (list, fallback) => Array.isArray(list)
            ? [...list.filter((id) => restoredIds.has(id)), ...fallback.filter((id) => !list.includes(id))]
            : fallback;
        openOrderStack = restoreOrder(savedTerminal.openOrderStack, terminalTabs.map((tab) => tab.id));
        visualLayout = restoreOrder(savedTerminal.visualLayout, terminalTabs.filter((tab) => !tab.minimized).map((tab) => tab.id));
        recentUseStack = restoreOrder(savedTerminal.recentUseStack, terminalTabs.map((tab) => tab.id));
        const activeConnectionId = state.activeConnectionId || savedTabs.find((t) => t.active)?.connectionId || '';
        const activeSessionId = state.activeSessionId || savedTabs.find((t) => t.active)?.sessionId || savedTabs.find((t) => t.active)?.tabId || '';
        const active = terminalTabs.find((t) => activeSessionId && (t.sessionId === activeSessionId || t.id === activeSessionId))
            || terminalTabs.find((t) => t.connectionId === activeConnectionId)
            || terminalTabs.find((t) => !t.minimized)
            || terminalTabs[0];
        if (active) {
            active.minimized = false;
            activeTerminalTab = active.id;
        }
        renderTerminalTabs({ rebuildWorkspace: true });
        const terminalWorkspace = $('#terminalWorkspace');
        if (savedTerminal.splitX) terminalWorkspace?.style.setProperty('--workspace-split-x', savedTerminal.splitX);
        if (savedTerminal.splitY) terminalWorkspace?.style.setProperty('--workspace-split-y', savedTerminal.splitY);
        terminalSmartbarSide = savedTerminal.smartbarSide || terminalSmartbarSide;
        const restoredView = preferTerminal && terminalTabs.length ? 'terminal' : allowedView;
        switchView(restoredView);
        if (restoredView === 'terminal') setTerminalSmartbarOpen(!!savedTerminal.smartbarOpen);

        if (allowedView === 'settings') {
            const settingsKey = String(state.ui?.settingsSubTab || 'security');
            const settingsTab = document.querySelector(`.settings-tab[data-settings="${CSS.escape(settingsKey)}"]:not(.force-hidden)`)
                || document.querySelector('.settings-tab[data-settings="security"]');
            settingsTab?.click();
        }
        requestAnimationFrame(() => {
            if ($('#view-settings')) $('#view-settings').scrollTop = Number(state.ui?.settingsScrollY || 0);
            if ($('#view-dashboard')) $('#view-dashboard').scrollTop = Number(state.ui?.dashboardScrollY || 0);
        });

        if (state.clipboard?.text || state.clipboard?.type) updateZephyrSharedClipboard(state.clipboard);
        if (state.notes?.selectedId && allowedView === 'notes') {
            try {
                await notesController?.activate?.();
                await notesController?.selectNote?.(state.notes.selectedId);
            } catch (err) {
                console.warn('[workspace-restore] note unavailable', err);
            }
        }
        if (state.panels?.ai?.open) {
            if (state.panels.ai.sessionId && aiChatSessions.some((session) => session.id === state.panels.ai.sessionId)) {
                aiCurrentSessionId = state.panels.ai.sessionId;
            }
            openAiAssistantPanel();
        }
    } catch (err) {
        if (err.status !== 404) console.warn('[workspace-restore]', err);
    } finally {
        workspaceRestoring = false;
        workspaceReady = true;
        // Persist the filtered restore result so the next load stays consistent.
        scheduleWorkspaceSave('restore-complete', { immediate: true });
    }
}

function ensureWorkspaceClientId() {
    const key = 'zephyr.workspace.clientId';
    try {
        let id = localStorage.getItem(key);
        if (!id) {
            id = (crypto.randomUUID?.() || `c_${Date.now().toString(16)}_${Math.random().toString(16).slice(2)}`);
            localStorage.setItem(key, id);
        }
        workspaceClientId = id;
        return id;
    } catch {
        workspaceClientId = `mem_${Date.now()}`;
        return workspaceClientId;
    }
}

function handleTransientHash() {
    const hash = String(location.hash || '').replace(/^#/, '');
    if (!hash.startsWith('transient=')) return false;
    const token = decodeURIComponent(hash.slice('transient='.length));
    history.replaceState(null, '', location.pathname + location.search);
    if (token) openTransientFromToken(token).catch((err) => toast(err.message || '临时凭据无效'));
    return true;
}

function bindDeepLinkChannel() {
    if (!('BroadcastChannel' in window)) return;
    try {
        const channel = new BroadcastChannel('zephyr-deeplink');
        channel.addEventListener('message', (event) => {
            const data = event.data || {};
            if (data.type !== 'zephyr-transient-connect' || !data.token) return;
            openConnectionModal({
                mode: 'transient',
                source: 'deeplink',
                draft: data.draft || null,
                transientToken: data.token,
            });
        });
    } catch {}
    window.addEventListener('message', (event) => {
        if (event.origin !== location.origin) return;
        const data = event.data || {};
        if (data.type !== 'zephyr-transient-connect' || !data.token) return;
        openConnectionModal({
            mode: 'transient',
            source: 'deeplink',
            draft: data.draft || null,
            transientToken: data.token,
        });
    });
    // Terminal -> app: open notes filtered by current connection
    window.addEventListener('message', (event) => {
        if (event.origin !== location.origin) return;
        const data = event.data || {};
        if (data.source !== 'zephyr-terminal' || data.type !== 'open-notes-for-connection') return;
        if (!isNotesEnabled()) {
            toast(t('笔记功能未开启，请在设置中启用'));
            return;
        }
        Promise.resolve(switchView('notes', { source: 'terminal-notes-button' }))
            .then(() => {
                notesController?.filterByConnection?.(data.connectionId);
                toast(data.connectionId ? '已按当前连接过滤笔记' : '已打开笔记');
            })
            .catch((err) => {
                console.warn('[terminal-notes]', 'fullscreen exit before notes failed', err);
                toast(t('无法打开笔记，请重试'));
            });
    });
}

// ─── Multi-user management UI (FREEZE plan §19.3) ───────────────────────────
// Apple-style line SVG icons (no emoji). 24x24, currentColor, rounded.
function adminIcon(name, size = 16) {
    const icons = {
        user: '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/></svg>',
        plus: '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
        shield: '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l8 3v7c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V5l8-3z"/></svg>',
        crown: '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7l4 5 5-7 5 7 4-5v11H3V7z"/></svg>',
        pause: '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
        play: '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 5l12 7-12 7V5z"/></svg>',
        key: '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="16" r="4"/><path d="M11 13l9-9M16 8l2 2"/></svg>',
        logout: '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M16 17l5-5-5-5M21 12H9"/></svg>',
        trash: '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14"/></svg>',
        transfer: '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3l4 4-4 4M20 7H8M8 21l-4-4 4-4M4 17h12"/></svg>',
        promote: '<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
    };
    return (icons[name] || icons.user).replace(/\{s\}/g, String(size));
}

let myIdentity = { userId: '', role: 'user', isSuperAdmin: false };

function initSettingsVisibility() {
    const isAdmin = myIdentity.role === 'admin';
    const isSuperAdmin = isAdmin && myIdentity.isSuperAdmin;
    ['mail', 'data'].forEach((key) => {
        document.querySelector(`.settings-tab[data-settings="${key}"]`)?.classList.toggle('force-hidden', !isSuperAdmin);
        document.getElementById(`settings-${key}`)?.classList.toggle('force-hidden', !isSuperAdmin);
    });
    document.querySelector('.settings-tab[data-settings="beian"]')?.classList.toggle('force-hidden', !isAdmin);
    document.getElementById('settings-beian')?.classList.toggle('force-hidden', !isAdmin);
    document.getElementById('platformSecuritySettings')?.classList.toggle('force-hidden', !isSuperAdmin);
    document.getElementById('clearLoginEventsBtn')?.classList.toggle('force-hidden', !isSuperAdmin);
    document.getElementById('clearActivityBtn')?.classList.toggle('force-hidden', !isSuperAdmin);
    const isOneMode = typeof window !== 'undefined' && !!window.__zephyrOneUnlock;
    document.getElementById('linkSettingsTab')?.classList.toggle('force-hidden', !isOneMode);
    document.getElementById('settings-link')?.classList.toggle('force-hidden', !isOneMode);
    const title = document.getElementById('loginEventsTitle');
    if (title) title.textContent = isSuperAdmin ? t('全部登录事件') : t('我的登录记录');
    const activeSettingsTab = document.querySelector('.settings-tab.active');
    if (activeSettingsTab?.classList.contains('force-hidden')) {
        document.querySelector('.settings-tab[data-settings="security"]')?.click();
    }
}

async function loadAdminUsers() {
    const panel = document.getElementById('settings-admin');
    if (!panel) return;
    const adminTab = document.getElementById('adminSettingsTab');
    if (myIdentity.role !== 'admin') { panel.classList.add('force-hidden'); adminTab?.classList.add('force-hidden'); return; }
    panel.classList.remove('force-hidden');
    adminTab?.classList.remove('force-hidden');
    // Inject SVG icons into title and add button
    const title = document.getElementById('adminPanelTitle');
    if (title && !title.dataset.iconInjected) { title.innerHTML = adminIcon('shield', 18) + ` ${t('多用户管理')}`; title.dataset.iconInjected = '1'; }
    const addBtn = document.getElementById('adminAddUserBtn');
    if (addBtn && !addBtn.dataset.iconInjected) { const span = addBtn.querySelector('.admin-icon-inline'); if (span) span.innerHTML = adminIcon('plus', 15); addBtn.dataset.iconInjected = '1'; }
    try {
        const data = await api('/api/admin/users');
        renderAdminUsers(data.users || []);
    } catch (err) {
        console.error('loadAdminUsers failed', err);
    }
}

async function initLinkPanel() {
    const panel = document.getElementById('settings-link');
    if (!panel) return;
    const isOneMode = typeof window !== 'undefined' && !!window.__zephyrOneUnlock;
    if (!isOneMode) return;

    const bindStatus = document.getElementById('linkBindStatus');
    const syncSettings = document.getElementById('linkSyncSettings');
    const devices = document.getElementById('linkDevices');
    const shares = document.getElementById('linkShares');
    const conflicts = document.getElementById('linkConflicts');
    const diagnostics = document.getElementById('linkDiagnostics');

    async function refreshLinkState() {
        try {
            const state = await api('/api/link/v2/state');
            if (state.bound) {
                bindStatus.innerHTML = `<p class="field-hint">${t('已绑定 {user}', { user: state.username || state.userId || '' })}</p>`;
                syncSettings.style.display = '';
                devices.style.display = '';
                shares.style.display = '';
                conflicts.style.display = '';
                diagnostics.style.display = '';
            } else {
                bindStatus.innerHTML = `<p class="empty-state">${t('未绑定')}</p><button type="button" class="z-btn z-btn-primary" id="linkBindBtn">${t('绑定主端')}</button>`;
                syncSettings.style.display = 'none';
                devices.style.display = 'none';
                shares.style.display = 'none';
                conflicts.style.display = 'none';
                diagnostics.style.display = 'none';
                document.getElementById('linkBindBtn')?.addEventListener('click', startBind);
            }
        } catch (err) {
            bindStatus.innerHTML = `<p class="gate-error">${t('加载失败：{message}', { message: err?.message || String(err) })}</p>`;
        }
    }

    async function startBind() {
        try {
            const result = await api('/api/link/v2/enrollments', { method: 'POST' });
            if (result.verificationPath) {
                window.open(result.verificationPath, '_blank');
            }
        } catch (err) {
            toast(t('绑定失败：{message}', { message: err?.message || String(err) }));
        }
    }

    document.getElementById('linkSyncNowBtn')?.addEventListener('click', async () => {
        try {
            await api('/api/link/v2/sync', { method: 'POST' });
            toast(t('同步已触发'));
        } catch (err) {
            toast(t('同步失败：{message}', { message: err?.message || String(err) }));
        }
    });

    await refreshLinkState();
    panel.classList.add('force-hidden');
}

function renderAdminUsers(users) {
    const list = document.getElementById('adminUserList');
    if (!list) return;
    // Soft-deleted users must never remain visible after delete (status=deleted).
    const visible = (Array.isArray(users) ? users : []).filter((u) => u && u.status !== 'deleted');
    if (!visible.length) {
        list.innerHTML = `<p class="muted">${t('暂无用户')}</p>`;
        return;
    }
    const activeAdmins = visible.filter((u) => u.role === 'admin' && u.status === 'active');
    list.innerHTML = visible.map((u) => {
        const isSelf = u.userId === myIdentity.userId;
        const isLastActiveAdmin = u.role === 'admin' && u.status === 'active' && activeAdmins.length <= 1;
        const roleBadge = u.isSuperAdmin
            ? `<span class="admin-badge super">${adminIcon('crown', 12)} ${t('超级管理员')}</span>`
            : u.role === 'admin'
                ? `<span class="admin-badge admin">${adminIcon('shield', 12)} ${t('管理员')}</span>`
                : `<span class="admin-badge user">${adminIcon('user', 12)} ${t('普通用户')}</span>`;
        const statusBadge = u.status === 'active' ? `<span class="admin-badge ok">${t('正常')}</span>`
            : u.status === 'suspended' ? `<span class="admin-badge warn">${t('已停用')}</span>`
            : u.status === 'invited' ? `<span class="admin-badge warn">${t('已邀请')}</span>`
            : `<span class="admin-badge">${escapeHtml(u.status || t('未知'))}</span>`;
        let actions = '';
        // Suspend / reactivate
        if (u.status === 'active' && !u.isSuperAdmin && !isLastActiveAdmin) {
            actions += `<button class="admin-action-btn" data-admin-action="suspend" data-user-id="${escapeHtml(u.userId)}" title="${t('停用')}">${adminIcon('pause', 14)} ${t('停用')}</button>`;
        }
        if (u.status === 'suspended') {
            actions += `<button class="admin-action-btn" data-admin-action="reactivate" data-user-id="${escapeHtml(u.userId)}" title="${t('启用')}">${adminIcon('play', 14)} ${t('启用')}</button>`;
        }
        // Reset password (not for super admin unless self)
        if (!u.isSuperAdmin || isSelf) {
            actions += `<button class="admin-action-btn" data-admin-action="reset-pw" data-user-id="${escapeHtml(u.userId)}" title="${t('重置密码')}">${adminIcon('key', 14)} ${t('重置密码')}</button>`;
        }
        // Revoke sessions (not for self)
        if (!isSelf && !u.isSuperAdmin) {
            actions += `<button class="admin-action-btn" data-admin-action="revoke-sessions" data-user-id="${escapeHtml(u.userId)}" title="${t('强制下线')}">${adminIcon('logout', 14)} ${t('踢下线')}</button>`;
        }
        // Promote to admin (only super admin can, target must be non-admin)
        if (myIdentity.isSuperAdmin && u.role !== 'admin' && !isSelf) {
            actions += `<button class="admin-action-btn" data-admin-action="promote" data-user-id="${escapeHtml(u.userId)}" title="${t('授予管理员')}">${adminIcon('promote', 14)} ${t('授权管理员')}</button>`;
        }
        // Demote admin (only super admin, not self, not super admin target)
        if (myIdentity.isSuperAdmin && u.role === 'admin' && !u.isSuperAdmin && !isSelf && !isLastActiveAdmin) {
            actions += `<button class="admin-action-btn" data-admin-action="demote" data-user-id="${escapeHtml(u.userId)}" title="${t('撤销管理员')}">${adminIcon('promote', 14)} ${t('撤销管理员')}</button>`;
        }
        // Transfer super admin (only current super admin, target is admin and not self)
        if (myIdentity.isSuperAdmin && u.role === 'admin' && !isSelf) {
            actions += `<button class="admin-action-btn" data-admin-action="transfer-super" data-user-id="${escapeHtml(u.userId)}" title="${t('转移超级管理员')}">${adminIcon('transfer', 14)} ${t('转移超管')}</button>`;
        }
        // Delete (not for self, not for super admin, not last admin)
        if (!isSelf && !u.isSuperAdmin && !isLastActiveAdmin) {
            actions += `<button class="admin-action-btn danger" data-admin-action="delete" data-user-id="${escapeHtml(u.userId)}" title="${t('删除')}">${adminIcon('trash', 14)} ${t('删除')}</button>`;
        }
        return `<div class="admin-user-row" data-user-id="${escapeHtml(u.userId)}">
            <div class="admin-user-info">
                <span class="admin-user-name">${adminIcon(u.isSuperAdmin ? 'crown' : (u.role === 'admin' ? 'shield' : 'user'), 18)}</span>
                <b>${escapeHtml(u.username)}</b>${isSelf ? ` <span class="muted">${t('(你)')}</span>` : ''}
                <span class="muted">${escapeHtml(u.email || t('无邮箱'))}</span>
                ${roleBadge}${statusBadge}
                <span class="muted">${u.lastLoginAt ? t('最后登录 {time}', { time: fmtTime(u.lastLoginAt) }) : t('从未登录')}</span>
            </div>
            <div class="admin-user-actions">${actions}</div>
        </div>`;
    }).join('');
}

function adminUserScrimSet(open, _Motion) {
    motionScrimSet('adminUserModalScrim', 'adminuser1-blurring', open);
}

function adminUserBtnRadius(el, rect) {
    const r = parseFloat(getComputedStyle(el)?.borderRadius);
    if (Number.isFinite(r) && r > 0) return r;
    return Math.min(rect.width, rect.height) / 2;
}

function openAdminAddUserDialog(trigger = null) {
    window.clearTimeout(closeAdminUserModal._timer);
    const cycle = ++adminUserModalCycle;
    const modal = $('#adminUserModal');
    if (!modal || (modal.classList.contains('show') && !modal.classList.contains('closing'))) return;
    const card = $('#adminUserForm');
    const inner = $('#adminUserModalInner');
    // 字段手写赋值，避免原生 reset 触发布局闪
    $('#adminUserModalTitle').textContent = t('添加用户');
    $('#saveAdminUserBtn').textContent = t('创建用户');
    $('#adminUserName').value = '';
    $('#adminUserPassword').value = '';
    $('#adminUserEmail').value = '';
    $('#adminUserRole').value = 'user';
    $('#adminUserMustChangePassword').checked = true;
    const roleGroup = $('#adminUserRoleGroup');
    if (roleGroup) roleGroup.classList.toggle('force-hidden', !myIdentity.isSuperAdmin);
    adminUserModalTrigger = trigger || $('#adminAddUserBtn');

    sshKeyMotion._ensure().then((Motion) => {
        if (cycle !== adminUserModalCycle) return;
        armMotionModalOpen(Motion, modal, card, inner, adminUserModalTrigger, 'adminuser1');
        try { closeAllToggleSelects(); } catch {}
        const btnRect = adminUserModalTrigger?.getBoundingClientRect?.() || null;
        adminUserScrimSet(true, Motion || null);
        const useMotion = !!Motion && !!btnRect && btnRect.width > 2 && btnRect.height > 2;
        if (!useMotion) {
            if (card?.style) {
                card.style.visibility = '';
                card.style.opacity = '';
                card.style.pointerEvents = '';
            }
            if (inner?.style) inner.style.opacity = '';
            if (adminUserModalTrigger?.style) {
                adminUserModalTrigger.style.opacity = '';
                adminUserModalTrigger.style.pointerEvents = '';
                delete adminUserModalTrigger.dataset.motionHidden;
            }
            try {
                enhanceToggleSelect($('#adminUserRole'));
                syncToggleSelectFace($('#adminUserRole'));
            } catch {}
            $('#adminUserName')?.focus({ preventScroll: true });
            return;
        }
        Motion.iosAppOpen(card, adminUserModalTrigger, {
            contentEl: inner,
            scrim: null,
            home: null,
            cloneSource: true,
            hideSource: true,
            radiusFrom: adminUserBtnRadius(adminUserModalTrigger, btnRect),
            radiusTo: 22,
            contentDelay: 0.16,
            faceDelay: 0.05,
            faceInDelay: 0.04,
            shapePreset: 'shape',
            contentPreset: 'content',
        }).then(() => {
            if (cycle !== adminUserModalCycle) return;
            card.style.overflow = 'visible';
            card.style.maxHeight = 'none';
            card.style.height = 'auto';
            if (inner?.style) {
                inner.style.overflow = 'visible';
                inner.style.maxHeight = 'none';
            }
            try {
                enhanceToggleSelect($('#adminUserRole'));
                syncToggleSelectFace($('#adminUserRole'));
            } catch {}
        }).catch((err) => console.warn('[adminuser1] iosAppOpen failed', err));
        window.setTimeout(() => {
            if (cycle === adminUserModalCycle && modal.classList.contains('show')) {
                $('#adminUserName')?.focus({ preventScroll: true });
            }
        }, 220);
    });
}

function closeAdminUserModal() {
    const modal = $('#adminUserModal');
    if (!modal?.classList.contains('show') || modal.classList.contains('closing')) return;
    const card = $('#adminUserForm');
    const inner = $('#adminUserModalInner');
    const cycle = ++adminUserModalCycle;
    window.clearTimeout(closeAdminUserModal._timer);

    modal.classList.add('closing');
    modal.classList.remove('app-visible');
    modal.setAttribute('aria-hidden', 'true');

    const Motion = sshKeyMotion.engine;
    const trigger = adminUserModalTrigger;
    const btnRect = trigger?.getBoundingClientRect?.() || null;
    const useMotion = !!Motion && !sshKeyMotion.failed
        && modal.classList.contains('adminuser1')
        && !!btnRect && btnRect.width > 2 && btnRect.height > 2;

    const finish = () => {
        if (cycle !== adminUserModalCycle) return;
        if (Motion) {
            try {
                if (trigger) Motion.restoreSource(trigger);
                Motion.restoreSources(card);
            } catch {}
        } else if (trigger?.style) {
            trigger.style.opacity = '';
            trigger.style.pointerEvents = '';
            delete trigger.dataset.motionHidden;
        }
        void (trigger?.offsetHeight);
        void card.offsetHeight;

        modal.classList.remove('show', 'closing', 'adminuser1');

        if (Motion) {
            try {
                card.querySelector?.(':scope > [data-motion-source-visual]')?.remove();
                Motion.release(card);
                if (inner) Motion.release(inner);
            } catch {}
        }
        card.style.overflow = '';
        card.style.visibility = '';
        card.style.opacity = '';
        card.style.filter = '';
        card.style.transform = '';
        card.style.borderRadius = '';
        const focusEl = trigger;
        adminUserModalTrigger = null;
        if (focusEl) {
            requestAnimationFrame(() => {
                try { focusEl.focus?.({ preventScroll: true }); } catch {}
            });
        }
    };

    adminUserScrimSet(false, Motion || null);
    if (!useMotion) {
        closeAdminUserModal._timer = window.setTimeout(finish, 0);
        return;
    }
    try {
        const twinLayer = card.querySelector(':scope > [data-motion-source-visual]');
        if (twinLayer) Motion.set(twinLayer, { opacity: Number(twinLayer.style.opacity) || 0 });
    } catch {}
    const closed = Motion.iosAppClose(card, trigger, {
        contentEl: inner,
        scrim: null,
        home: null,
        restoreSource: false,
        hideSurface: false,
        clearSourceVisual: false,
        release: false,
        radiusTo: adminUserBtnRadius(trigger, btnRect),
        shapePreset: 'shapeClose',
        contentPreset: 'contentClose',
        faceInDelay: 0.04,
    });
    const cap = new Promise(r => window.setTimeout(r, 900));
    Promise.race([closed, cap]).then(() => {
        requestAnimationFrame(() => finish());
    }).catch((err) => {
        console.warn('[adminuser1] iosAppClose failed', err);
        finish();
    });
}

async function saveAdminUser(e) {
    e.preventDefault();
    const username = ($('#adminUserName')?.value || '').trim();
    const password = $('#adminUserPassword')?.value || '';
    const email = ($('#adminUserEmail')?.value || '').trim();
    const role = myIdentity.isSuperAdmin ? (($('#adminUserRole')?.value || 'user') === 'admin' ? 'admin' : 'user') : 'user';
    const mustChangePassword = !!$('#adminUserMustChangePassword')?.checked;
    if (!username) return toast(t('请输入新用户名'));
    if (!password || password.length < 4) return toast(t('密码至少 4 位'));
    try {
        await api('/api/admin/users', {
            method: 'POST',
            body: JSON.stringify({ username, password, email, role, mustChangePassword }),
        });
        closeAdminUserModal();
        await loadAdminUsers();
        toast(t('用户已创建'));
    } catch (err) {
        toast(err.message || t('创建失败'));
    }
}

async function handleAdminAction(action, userId) {
    try {
        if (action === 'suspend') {
            if (!confirm(t('确定停用此用户？停用后该用户无法登录。'))) return;
            await api(`/api/admin/users/${userId}/suspend`, { method: 'POST' });
        } else if (action === 'reactivate') {
            await api(`/api/admin/users/${userId}/reactivate`, { method: 'POST' });
        } else if (action === 'reset-pw') {
            const pw = prompt(t('输入新密码：'));
            if (!pw) return;
            await api(`/api/admin/users/${userId}/force-password-reset`, { method: 'POST', body: JSON.stringify({ newPassword: pw }) });
        } else if (action === 'revoke-sessions') {
            await api(`/api/admin/users/${userId}/revoke-sessions`, { method: 'POST' });
            toast(t('已强制下线'));
        } else if (action === 'promote') {
            if (!confirm(t('确定授予此用户管理员角色？'))) return;
            await api(`/api/admin/users/${userId}`, { method: 'PATCH', body: JSON.stringify({ role: 'admin' }) });
        } else if (action === 'demote') {
            if (!confirm(t('确定撤销此用户的管理员角色？'))) return;
            await api(`/api/admin/users/${userId}`, { method: 'PATCH', body: JSON.stringify({ role: 'user' }) });
        } else if (action === 'transfer-super') {
            if (!confirm(t('确定将超级管理员转移给此用户？\n转移后你将变为普通管理员。此操作不可撤销。'))) return;
            await api(`/api/admin/users/${userId}/transfer-super-admin`, { method: 'POST' });
            toast(t('超级管理员已转移，请重新登录'));
            setTimeout(() => location.href = '/', 1500);
            return;
        } else if (action === 'delete') {
            if (!confirm(t('确定删除此用户？其资源将转移给管理员。此操作不可撤销。'))) return;
            await api(`/api/admin/users/${userId}`, { method: 'DELETE', body: JSON.stringify({ resourcePolicy: 'transfer-to-admin' }) });
        }
        toast(t('操作成功'));
        await loadAdminUsers();
    } catch (err) {
        toast(err.message || t('操作失败'));
    }
}

function registerStaticAssetWorker() {
    if (window.__zephyrPreviewMode) return;
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => {
        console.warn('[service-worker] registration failed', err);
    });
}

function syncLocaleSelectsValue(locale = getLocale()) {
    const value = locale === 'en' ? 'en' : 'zh-CN';
    ['#languageSelect'].forEach((sel) => {
        const el = document.querySelector(sel);
        if (el && el.value !== value) {
            el.value = value;
            const shell = el.closest('.ui-toggle-select');
            if (shell) {
                try { syncToggleSelectFace(el); } catch {}
            }
        }
    });
}

function rerenderLocaleSensitiveContent() {
    /* Static DOM is handled by applyDomI18n(). Repaint state-derived fragments
     * separately: their text was produced before the locale switch and has no
     * data-i18n attributes for the runtime to revisit. */
    for (const render of [
        renderConnections,
        renderActivities,
        renderRemoteServers,
        renderTotp,
        renderPasskeys,
        renderSecurityLists,
        renderAiSettingsForm,
        renderAiMcpList,
        renderAiProviderList,
        renderAiEnvList,
        renderAiMemoryList,
        renderAiPlanList,
        renderAiSkillList,
        renderSnippetSettings,
        renderNetwork,
        renderWebDavText,
    ]) {
        try { render?.(); } catch (err) { console.warn('[i18n] dynamic rerender failed', err); }
    }
    if (myIdentity.role === 'admin') loadAdminUsers().catch((err) => console.warn('[i18n] admin rerender failed', err));
}

async function changeAppLocale(next) {
    const before = getLocale();
    await setLocale(next, { persist: true, applyDom: true });
    /* A real change is repainted by onLocaleChange(). If the user selects the
     * already-active value, there is no event, so refresh state-derived text
     * here exactly once. */
    if (getLocale() === before) rerenderLocaleSensitiveContent();
}

function bindLocaleSelects() {
    ['#languageSelect'].forEach((sel) => {
        document.querySelector(sel)?.addEventListener('change', (e) => {
            changeAppLocale(e.target.value).catch((err) => console.warn('[i18n]', err));
        });
    });
}

function markWorkspaceRemoteUpdate() {
    workspaceRemoteUpdatePending = true;
    document.documentElement.dataset.workspaceRemoteUpdate = 'pending';
}

function startBrowserChangeWake() {
    if (browserChangeWakeClient || typeof window.EventSource !== 'function') return;
    browserChangeRefreshScheduler = createBrowserChangeRefreshScheduler({
        entityGroups: BROWSER_CHANGE_ENTITY_GROUPS,
        documentRef: document,
        loaders: {
            connections: () => loadConnections(),
            network: () => loadNetwork(),
            settings: async () => {
                await loadSettings();
                renderSnippetSettings();
            },
            notes: () => notesController?.notifyRemoteUpdate?.(),
            aiHistory: () => scheduleAiHistoryReload(120),
            workspace: () => markWorkspaceRemoteUpdate(),
            activities: () => loadActivities(),
            backup: () => loadWebDavSettings(),
            agentTokens: () => loadAgentTokens(),
            oneClients: () => loadOneClients(),
        },
    });
    browserChangeWakeClient = createBrowserChangeWakeClient({
        endpoint: '/api/me/change-wake',
        entityTypes: BROWSER_CHANGE_ENTITY_TYPES,
        onEntityTypes: (types) => browserChangeRefreshScheduler?.schedule(types),
        onResume: () => browserChangeRefreshScheduler?.resume(),
        EventSourceImpl: window.EventSource,
        documentRef: document,
        windowRef: window,
        navigatorRef: navigator,
        locationRef: window.location,
    });
    browserChangeWakeClient.start();
}

async function init() {
    document.documentElement.dataset.appInit = 'start';
    try {
        await initI18n({ applyDom: true });
        syncLocaleSelectsValue(getLocale());
        onLocaleChange(() => {
            syncLocaleSelectsValue(getLocale());
            rerenderLocaleSensitiveContent();
            try { applyDomI18n(document); } catch {}
        });
        applyTheme(getPreferredTheme());
        document.documentElement.dataset.appInitTheme = 'ok';
        const me = await api('/api/auth/me');
        document.documentElement.dataset.appInitAuth = 'ok';
        if (me.mustChangePassword) { location.href = '/'; return; }
        myIdentity = { userId: me.user?.userId || '', role: me.user?.role || 'user', isSuperAdmin: !!me.user?.isSuperAdmin };
        window.__zephyrMyUserId = myIdentity.userId;
        window.__zephyrRole = myIdentity.role;
        window.__zephyrIsSuperAdmin = myIdentity.isSuperAdmin;
        ensureWorkspaceClientId();
        // Early shell switch: if last view was terminal, paint that shell before
        // network restore so refresh does not flash the dashboard first.
        try {
            const lastView = isSessionPersistenceEnabled() ? (localStorage.getItem('zephyr.lastView') || '') : '';
            if (['activity', 'terminal', 'remote', 'notes', 'settings', 'dashboard'].includes(lastView) && lastView !== 'dashboard') {
                currentAppView = lastView;
                $$('.nav-tab').forEach((b) => b.classList.toggle('active', b.dataset.view === lastView));
                $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${lastView}`));
                document.body.classList.toggle('terminal-mode', lastView === 'terminal');
            }
        } catch {}
        notesController = createNotesController({
            api,
            toast,
            openTransientFromUri,
            $,
            $$,
        });
        startBrowserChangeWake();
        bindEvents();
        bindDeepLinkChannel();
        initSettingsVisibility();
        initLinkPanel().catch((err) => console.warn('[link] init failed', err));
        document.documentElement.dataset.appBindEvents = 'done';
        const backgroundLoads = Promise.allSettled([
            loadNetwork(),
            loadAdminUsers(),
        ]);
        await loadSettings();
        document.documentElement.dataset.appLoadSettings = 'ok';
        await loadAiChats().catch((error) => {
            console.warn('[ai-history] canonical load failed', error?.code || error?.message || error);
            if (!aiChatSessions.length) createAiChat({ silent: true });
        });
        await migrateLocalSnippetsToServer();
        renderSnippetSettings();
        await loadConnections();
        document.documentElement.dataset.appLoadConnections = 'ok';
        await loadActivities();
        await restoreLastWorkspace();
        await backgroundLoads;
        // Deep Link hand-off from /open (token only — never the raw URI).
        handleTransientHash();
        document.documentElement.dataset.appReady = '1';
        window.__zephyrAppReady = true;
        window.openConnectionModal = openConnectionModal;
        window.openTransientFromUri = openTransientFromUri;
        registerStaticAssetWorker();
        const flushWorkspace = () => {
            if (isSessionPersistenceEnabled()) {
                captureTerminalSnapshots();
                saveWorkspaceNow({ keepalive: true, reason: 'page-exit' }).catch(() => {});
            } else {
                try { sessionStorage.removeItem(TERMINAL_SNAPSHOT_STORAGE_KEY); } catch {}
            }
            // Best-effort: drop any open one-shot rows so a hard refresh does not
            // leave orphan ephemeral hosts until the 6h GC runs.
            terminalTabs.forEach((t) => {
                const id = t.ephemeralConnectionId || ((t.ephemeral || t.transient) ? t.connectionId : '');
                if (id) disposeEphemeralConnection(id, { reason: 'page-exit' });
            });
        };
        window.addEventListener('pagehide', flushWorkspace);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') flushWorkspace();
        });
    } catch (err) {
        console.error('[app-init]', err);
        document.documentElement.dataset.appInitError = err?.message || String(err || 'unknown');
        toast(t('初始化失败：{error}', { error: err?.message || err || t('未知错误') }));
    }
}
init();

// ─── Zephyr Agent Token Settings ─────────────────────────────────
function formatAgentTokenTime(ms) {
    if (!ms) return t('从未');
    try { return new Date(Number(ms)).toLocaleString(); } catch { return t('未知'); }
}

const agentRevealedTokens = new Map();

async function loadAgentTokens() {
    const list = $('#agentTokenList');
    if (!list) return;
    list.innerHTML = `<p class="empty-state">${t('正在加载...')}</p>`;
    try {
        const data = await api('/api/rdp/file-agent-tokens');
        renderAgentTokens(data.tokens || [], agentRevealedTokens);
    } catch (err) {
        list.innerHTML = `<p class="empty-state">${t('加载失败：')}${escapeHtml(err.message || 'unknown')}</p>`;
    }
}

function renderAgentTokens(tokens, revealedTokens = new Map()) {
    const list = $('#agentTokenList');
    if (!list) return;
    if (!tokens.length) {
        list.innerHTML = `<p class="empty-state">${t('暂无 Token。点击“新增 Token”为设备创建连接凭据。')}</p>`;
        return;
    }
    const revealMap = revealedTokens instanceof Map ? revealedTokens : new Map(Object.entries(revealedTokens || {}));
    list.innerHTML = tokens.map((tok) => {
        const revealed = tok.token || revealMap.get(tok.id) || '';
        return `
        <div class="agent-token-item" data-token-id="${escapeHtml(tok.id)}">
            <div class="agent-token-main">
                <div class="agent-token-title"><strong>${escapeHtml(tok.name || t('未命名 Token'))}</strong><span>${escapeHtml(tok.id || '')}</span></div>
                <div class="agent-token-value"><code>${revealed ? escapeHtml(revealed) : '••••••••••••••••••••••••••••••••'}</code></div>
                <div class="agent-token-meta">${t('创建：')}${escapeHtml(formatAgentTokenTime(tok.createdAt))} · ${t('更新：')}${escapeHtml(formatAgentTokenTime(tok.updatedAt))} · ${t('最后使用：')}${escapeHtml(formatAgentTokenTime(tok.lastUsedAt))}</div>
            </div>
            <div class="agent-token-buttons">
                <button class="tool-btn" type="button" data-agent-reveal-token="${escapeHtml(tok.id)}">${t('查看')}</button>
                <button class="tool-btn" type="button" data-agent-copy-token="${escapeHtml(tok.id)}">${t('复制')}</button>
                <button class="tool-btn" type="button" data-agent-rename-token="${escapeHtml(tok.id)}">${t('重命名')}</button>
                <button class="tool-btn" type="button" data-agent-regen-token="${escapeHtml(tok.id)}">${t('重新生成')}</button>
                <button class="tool-btn danger" type="button" data-agent-delete-token="${escapeHtml(tok.id)}">${t('删除')}</button>
            </div>
        </div>`;
    }).join('');
}

function currentAgentServerUrl() {
    return window.location.origin;
}

function updateAgentServerInfo() {
    const el = $('#agentServerUrlText');
    if (el) el.textContent = currentAgentServerUrl();
}

function currentAgentTokenLength() {
    const n = Number($('#agentTokenLengthInput')?.value || 50);
    return Math.max(16, Math.min(256, Number.isFinite(n) ? n : 50));
}

async function refreshAgentTokensKeeping(tokenRecord) {
    if (tokenRecord?.id && tokenRecord?.token) {
        agentRevealedTokens.set(tokenRecord.id, tokenRecord.token);
        renderAgentTokens([tokenRecord], agentRevealedTokens);
    }
    try {
        const data = await api('/api/rdp/file-agent-tokens');
        const list = Array.isArray(data.tokens) ? data.tokens : [];
        if (tokenRecord?.id && !list.some((t) => t.id === tokenRecord.id)) list.unshift(tokenRecord);
        renderAgentTokens(list, agentRevealedTokens);
    } catch (err) {
        if (!tokenRecord?.id) throw err;
        toast(t('列表刷新失败，已显示新 Token：{error}', { error: err.message || 'unknown' }));
    }
}

async function createAgentToken() {
    const name = prompt(t('Token 名称，例如：我的手机 / 办公室 Windows / Pad'), 'Zephyr Client Token');
    if (name === null) return;
    const data = await api('/api/rdp/file-agent-tokens', { method: 'POST', body: JSON.stringify({ name, length: currentAgentTokenLength() }) });
    const tokenRecord = data.token;
    if (!tokenRecord?.token) throw new Error(t('服务端未返回新 Token'));
    await refreshAgentTokensKeeping(tokenRecord);
    toast(t('Token 已创建并显示'));
}

async function renameAgentToken(id) {
    const item = document.querySelector(`[data-token-id="${CSS.escape(id)}"] .agent-token-title strong`);
    const name = prompt(t('新的 Token 名称'), item?.textContent || 'Zephyr Client Token');
    if (name === null) return;
    await api(`/api/rdp/file-agent-tokens/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) });
    await loadAgentTokens();
    toast(t('Token 已重命名'));
}

async function regenerateAgentToken(id) {
    if (!confirm(t('重新生成后，使用旧 Token 的 Agent / One 会断开，需要重新填写新 Token。继续？'))) return;
    const secret = await requestSensitiveSecret(t('重新生成 Zephyr Client Token'));
    if (secret == null || secret === '') throw new Error(t('已取消'));
    const data = await api(`/api/rdp/file-agent-tokens/${encodeURIComponent(id)}/regenerate`, {
        method: 'POST',
        body: JSON.stringify({ length: currentAgentTokenLength(), secret }),
    });
    const tokenRecord = data.token;
    if (!tokenRecord?.token) throw new Error(t('服务端未返回新 Token'));
    await refreshAgentTokensKeeping(tokenRecord);
    toast(t('Token 已重新生成并显示'));
}

async function deleteAgentToken(id) {
    if (!confirm(t('删除后，使用此 Token 的 Agent / One 会断开。删除需验证密码或两步验证码。继续？'))) return;
    const secret = await requestSensitiveSecret(t('删除 Zephyr Client Token'));
    if (secret == null || secret === '') throw new Error(t('已取消'));
    await api(`/api/rdp/file-agent-tokens/${encodeURIComponent(id)}/delete`, {
        method: 'POST',
        body: JSON.stringify({ secret }),
    });
    agentRevealedTokens.delete(id);
    await loadAgentTokens();
    toast(t('Token 已删除'));
}

async function revealAgentToken(id, { copy = false } = {}) {
    let token = agentRevealedTokens.get(id) || '';
    if (!token) {
        const secret = await requestSensitiveSecret(copy ? t('复制 Zephyr Client Token') : t('查看 Zephyr Client Token'));
        if (secret == null || secret === '') throw new Error(t('已取消'));
        const data = await api(`/api/rdp/file-agent-tokens/${encodeURIComponent(id)}/open`, {
            method: 'POST',
            body: JSON.stringify({ secret }),
        });
        token = data.token?.token || '';
        if (!token) throw new Error(t('Token 为空'));
        agentRevealedTokens.set(id, token);
    }
    const code = document.querySelector(`[data-token-id="${CSS.escape(id)}"] .agent-token-value code`);
    if (code) code.textContent = token;
    if (copy) {
        await copyTextToClipboard(token, t('Token 已复制'));
    } else {
        toast(t('Token 已显示'));
    }
}

async function copyAgentToken(id) {
    await revealAgentToken(id, { copy: true });
}

async function resetAllAgentTokens() {
    if (!confirm(t('这会删除当前账号所有 Client Token，并断开所有已连接 Agent / One。继续？'))) return;
    const secret = await requestSensitiveSecret(t('重置全部 Zephyr Client Token'));
    if (secret == null || secret === '') throw new Error(t('已取消'));
    const name = prompt(t('新 Token 名称'), t('默认 Token'));
    if (name === null) return;
    const data = await api('/api/rdp/file-agent-tokens/reset-all', {
        method: 'POST',
        body: JSON.stringify({ secret, name, length: currentAgentTokenLength() }),
    });
    const tokenRecord = data.token;
    if (!tokenRecord?.token) throw new Error(t('服务端未返回新 Token'));
    agentRevealedTokens.clear();
    await refreshAgentTokensKeeping(tokenRecord);
    toast(t('全部 Token 已重置，新 Token 已显示'));
}

function formatOneClientTime(ms) {
    if (!ms) return t('从未');
    try { return new Date(Number(ms)).toLocaleString(); } catch { return t('未知'); }
}

async function loadOneClients() {
    const list = $('#oneClientList');
    if (!list) return;
    list.innerHTML = `<p class="empty-state">${t('正在加载...')}</p>`;
    try {
        const data = await api('/api/one/clients');
        renderOneClients(data.clients || []);
    } catch (err) {
        list.innerHTML = `<p class="empty-state">${t('加载失败：')}${escapeHtml(err.message || 'unknown')}</p>`;
    }
}

function renderOneClients(clients) {
    const list = $('#oneClientList');
    if (!list) return;
    if (!clients.length) {
        list.innerHTML = `<p class="empty-state">${t('尚无绑定的 Zephyr One 客户端')}</p>`;
        return;
    }
    list.innerHTML = clients.map((c) => `
        <div class="agent-token-item" data-one-client-id="${escapeHtml(c.clientId)}">
            <div class="agent-token-main">
                <div class="agent-token-title"><strong>${escapeHtml(c.deviceName || 'Zephyr One')}</strong><span>${escapeHtml(c.clientId || '')}</span></div>
                <div class="agent-token-meta">${escapeHtml(c.platform || '—')} · ${c.enabled ? t('同步已启用') : t('已禁用')} · Token ${escapeHtml(c.tokenId || '—')}</div>
                <div class="agent-token-meta">${t('最近同步：')}${escapeHtml(formatOneClientTime(c.lastSyncAt))} · ${t('间隔：')}${escapeHtml(String(c.syncIntervalSec || 300))}s · ${t('创建：')}${escapeHtml(formatOneClientTime(c.createdAt))}</div>
            </div>
            <div class="agent-token-buttons">
                <button class="tool-btn danger" type="button" data-one-delete-client="${escapeHtml(c.clientId)}">${t('删除客户端')}</button>
            </div>
        </div>`).join('');
}

async function deleteOneClient(clientId) {
    if (!confirm(t('删除后该 Zephyr One 将无法同步，需重新登录绑定。删除需密码或两步验证码。继续？'))) return;
    const secret = await requestSensitiveSecret(t('删除 Zephyr One 客户端'));
    if (secret == null || secret === '') throw new Error(t('已取消'));
    await api(`/api/one/clients/${encodeURIComponent(clientId)}/revoke`, {
        method: 'POST',
        body: JSON.stringify({ secret, reason: 'deleted_from_settings' }),
    });
    await loadOneClients();
    toast(t('Zephyr One 客户端已删除'));
}

function setupAgentTokenSettings() {
    $('#agentCreateTokenBtn')?.addEventListener('click', () => createAgentToken().catch((err) => toast(err.message || t('创建失败'))));
    $('#agentRefreshTokenBtn')?.addEventListener('click', () => loadAgentTokens());
    $('#agentResetAllTokenBtn')?.addEventListener('click', () => resetAllAgentTokens().catch((err) => toast(err.message || t('重置失败'))));
    $('#oneClientRefreshBtn')?.addEventListener('click', () => loadOneClients().catch(() => {}));
    $('#agentCopyServerUrlBtn')?.addEventListener('click', async () => {
        try {
            await copyTextToClipboard(currentAgentServerUrl(), t('主端地址已复制'));
        } catch (err) {
            toast(err.message || t('复制失败'));
        }
    });
    $('#agentTokenList')?.addEventListener('click', (e) => {
        const reveal = e.target.dataset.agentRevealToken;
        const copy = e.target.dataset.agentCopyToken;
        const rename = e.target.dataset.agentRenameToken;
        const regen = e.target.dataset.agentRegenToken;
        const del = e.target.dataset.agentDeleteToken;
        if (reveal) revealAgentToken(reveal).catch((err) => toast(err.message || t('查看失败')));
        if (copy) copyAgentToken(copy).catch((err) => toast(err.message || t('复制失败')));
        if (rename) renameAgentToken(rename).catch((err) => toast(err.message || t('重命名失败')));
        if (regen) regenerateAgentToken(regen).catch((err) => toast(err.message || t('重新生成失败')));
        if (del) deleteAgentToken(del).catch((err) => toast(err.message || t('删除失败')));
    });
    $('#oneClientList')?.addEventListener('click', (e) => {
        const del = e.target.dataset.oneDeleteClient;
        if (del) deleteOneClient(del).catch((err) => toast(err.message || t('删除失败')));
    });
    updateAgentServerInfo();
    loadAgentTokens().catch(() => {});
    loadOneClients().catch(() => {});
}
