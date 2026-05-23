const $ = (sel) => document.querySelector(sel);

function getParams() {
    try {
        const qs = new URLSearchParams(location.search);
        const tabId = qs.get('tabId');
        const key = tabId ? `zephyr_ssh_params_${tabId}` : 'zephyr_ssh_params';
        const raw = sessionStorage.getItem(key);
        const params = raw ? JSON.parse(raw) : null;
        if (params && tabId) params.tabId = tabId;
        return params;
    } catch { return null; }
}

const params = getParams();
const embeddedMode = new URLSearchParams(location.search).get('embed') === '1' || !!params?.embedded;
function notifyParentStatus(status) {
    if (embeddedMode && window.parent && window.parent !== window) {
        window.parent.postMessage({ source: 'zephyr-terminal', tabId: params?.tabId, status }, '*');
    }
}
function notifyParentCloseRequest(reason = 'terminal-closed') {
    if (embeddedMode && window.parent && window.parent !== window) {
        console.info('[TerminalClose]', 'request parent to close tab', {
            tabId: params?.tabId,
            reason,
            connected: isConnected,
            readyState: wsConnection?.readyState,
        });
        window.parent.postMessage({ source: 'zephyr-terminal', type: 'close-request', tabId: params?.tabId, reason }, '*');
    }
}
function notifyParentActivity() {
    if (embeddedMode && window.parent && window.parent !== window) {
        window.parent.postMessage({ source: 'zephyr-terminal', type: 'activity', tabId: params?.tabId }, '*');
    }
}
['keydown', 'pointerdown', 'mousedown', 'touchstart'].forEach((eventName) => {
    document.addEventListener(eventName, notifyParentActivity, { passive: true, capture: true });
});
if (!params) {
    if (!embeddedMode) window.location.href = '/';
    throw new Error('缺少连接参数');
}

// ---------- DOM 元素 ----------
const statusDot = $('#statusDot');
const statusText = $('#statusText');
const connInfo = $('#connInfo');
const terminalOverlay = $('#terminalOverlay');
const overlayMsg = $('#overlayMsg');
const terminalContainer = $('#terminalContainer');
const wtermWrapper = $('#wtermWrapper');
const terminalScrollbar = $('#terminalScrollbar');
const terminalScrollbarThumb = $('#terminalScrollbarThumb');
const topbarActions = $('#topbarActions');
const reconnectBtn = $('#reconnectBtn');
const disconnectBtn = $('#disconnectBtn');
const themeToggle = $('#themeToggle');
const wtermThemeToggle = $('#wtermThemeToggle');
const cmdInput = $('#cmdInput');
const cmdSendBtn = $('#cmdSendBtn');
const copyBtn = $('#copyBtn');
const pasteBtn = $('#pasteBtn');
const fileBtn = $('#fileBtn');
const infoBtn = $('#infoBtn');
const dockerBtn = $('#dockerBtn');
const snippetBtn = $('#snippetBtn');
const shortcutBtn = $('#shortcutBtn');
const snippetPanel = $('#snippetPanel');
const snippetSearch = $('#snippetSearch');
const snippetList = $('#snippetList');
const snippetEmpty = $('#snippetEmpty');
const shortcutPanel = $('#shortcutPanel');
const fontDecreaseBtn = $('#fontDecreaseBtn');
const fontIncreaseBtn = $('#fontIncreaseBtn');

// 文件管理器 DOM
const fileManager = $('#fileManager');
const fmBackBtn = $('#fmBackBtn');
const fmPathInput = $('#fmPathInput');
const fmGoBtn = $('#fmGoBtn');
const fmRefreshBtn = $('#fmRefreshBtn');
const fmCloseBtn = $('#fmCloseBtn');
const fmNewFolderBtn = $('#fmNewFolderBtn');
const fmNewFileBtn = $('#fmNewFileBtn');
const fmUploadInput = $('#fmUploadInput');
const fmDropOverlay = $('#fmDropOverlay');
const fmSearchInput = $('#fmSearchInput');
const fmList = $('#fmList');
const fmEditorModal = $('#fmEditorModal');
const fmEditorTitle = $('#fmEditorTitle');
const fmEditorMain = $('#fmEditorMain');
const fmEditorTextarea = $('#fmEditorTextarea');
let fmEditorLineNumbers = $('#fmEditorLineNumbers');
const fmEditorHighlight = $('#fmEditorHighlight');
let fmEditorIndentGuides = $('#fmEditorIndentGuides');
const fmEditorMinimap = $('#fmEditorMinimap');
const fmEditorMinimapCode = $('#fmEditorMinimapCode');
const fmEditorMinimapToggle = $('#fmEditorMinimapToggle');
const fmEditorFullscreenBtn = $('#fmEditorFullscreenBtn');
const fmEditorSaveBtn = $('#fmEditorSaveBtn');
const fmEditorCancelBtn = $('#fmEditorCancelBtn');
const fmEditorCloseBtn = $('#fmEditorCloseBtn');
const fmEditorUndoBtn = $('#fmEditorUndoBtn');
const fmEditorRedoBtn = $('#fmEditorRedoBtn');
const fmEditorEncoding = $('#fmEditorEncoding');
const fmEditorLineEnding = $('#fmEditorLineEnding');
const fmEditorTabSize = $('#fmEditorTabSize');
const fmEditorWrap = $('#fmEditorWrap');
const fmEditorStatus = $('#fmEditorStatus');

// 监控相关 DOM
const infoModal = $('#infoModal');
const infoCloseBtn = $('#infoCloseBtn');
const infoBody = $('#infoBody');

// Docker 面板 DOM
const dockerPanel = $('#dockerPanel');
const dockerCloseBtn = $('#dockerCloseBtn');
const dockerRestartBtn = $('#dockerRestartBtn');
const dockerRefreshBtn = $('#dockerRefreshBtn');
const dockerStatus = $('#dockerStatus');
const dockerInstallHint = $('#dockerInstallHint');
const dockerContent = $('#dockerContent');
const dockerContainersBody = $('#dockerContainersBody');
const dockerImagesBody = $('#dockerImagesBody');
const dockerPullInput = $('#dockerPullInput');
const dockerPullBtn = $('#dockerPullBtn');
const dockerPullLog = $('#dockerPullLog');
const dockerMirrorList = $('#dockerMirrorList');
const dockerMirrorInput = $('#dockerMirrorInput');
const dockerMirrorAddBtn = $('#dockerMirrorAddBtn');
const dockerMirrorSaveBtn = $('#dockerMirrorSaveBtn');
const dockerLogDrawer = $('#dockerLogDrawer');
const dockerLogTitle = $('#dockerLogTitle');
const dockerLogPauseBtn = $('#dockerLogPauseBtn');
const dockerLogDownloadBtn = $('#dockerLogDownloadBtn');
const dockerLogCloseBtn = $('#dockerLogCloseBtn');
const dockerContainerLog = $('#dockerContainerLog');
const toolbar = $('#toolbar');

// ---------- 全局变量 ----------
let term = null;
let wsConnection = null;
let isConnected = false;
let sftpReady = false;
let currentPath = '.';
let allFiles = [];
let pendingUploadFiles = [];
const SFTP_UPLOAD_CHUNK_SIZE = 192 * 1024;
const activeSftpUploads = new Map();
let fileDragDepth = 0;
let searchQuery = '';
let editorFilePath = null;
let editorLanguage = 'plain';
let editorRawBytes = null;
let editorMinimapHidden = localStorage.getItem('zephyr-editor-minimap-hidden') === '1';
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;
let activeConnectionToken = 0;
let reconnectTimer = 0;
let userClosedConnection = false;
let reconnectInProgress = false;

let dockerChecked = false;
let dockerInstalled = false;
let dockerMirrors = [];
let dockerCurrentLogContainer = null;
let dockerAutoScrollLog = true;
let dockerLogBuffer = '';

// 图表实例管理
let chartInstances = {};
let latestStatsData = null;
let terminalScrollRaf = 0;
let terminalScrollbarRaf = 0;
let isProgrammaticTerminalScroll = false;
let terminalScrollCleanup = null;
let terminalResizeCleanup = null;
let suppressWTermResizeEvent = false;
let terminalFontSize = 14;
let mobileKeyboardOpen = false;
let mobileKeyboardUserControlled = false;
let mobileWTermInputGuard = null;
let mobileClipboardActionInProgress = false;
let mobileKeyboardResizeFreezeUntil = 0;
let keyboardFocusLikely = false;
let keyboardViewportBaseline = 0;
let keyboardFallbackTimer = 0;
let keyboardFallbackActive = false;
let keyboardFallbackAppliedAt = 0;
let pinchStartDistance = 0;
let pinchStartFontSize = 14;
let pinchLastAppliedFontSize = 14;
let suppressNextLayoutClick = false;
let viewportAnimationRaf = 0;
let viewportAnimationResizeTimer = 0;
let cachedSelectionText = '';
let mobileTerminalSelectionMode = false;
let mobileTerminalSelectionTimer = 0;
let mobileTerminalSelectionRestoreTimer = 0;
let terminalTouchFocusTimer = 0;
let terminalTouchStartX = 0;
let terminalTouchStartY = 0;
let terminalTouchMoved = false;
const TERMINAL_COPY_DIAGNOSTICS = false;

function logTerminalCopyDiagnostics(event, details = {}) {
    if (!TERMINAL_COPY_DIAGNOSTICS) return;
    try {
        const selection = window.getSelection?.();
        const viewport = window.visualViewport;
        console.info('[TerminalCopyDiagnostics]', {
            event,
            touchKeyboardDevice: isTouchKeyboardDevice?.(),
            activeElement: document.activeElement?.id || document.activeElement?.className || document.activeElement?.tagName,
            selectionCollapsed: selection?.isCollapsed,
            selectionLength: selection?.toString?.().length || 0,
            cachedSelectionLength: cachedSelectionText.length,
            mobileKeyboardOpen,
            keyboardFocusLikely,
            mobileTerminalSelectionMode,
            viewportHeight: Math.round(viewport?.height || 0),
            viewportOffsetTop: Math.round(viewport?.offsetTop || 0),
            innerHeight: Math.round(window.innerHeight || 0),
            ...details,
        });
    } catch (err) {
        console.info('[TerminalCopyDiagnostics]', event, details, err);
    }
}

function hasLiveTerminalSelection() {
    const selection = window.getSelection?.();
    return Boolean(selection && !selection.isCollapsed && (selection.toString?.().length || 0) > 0);
}

function blurTerminalInputsForSelection() {
    if (isTouchKeyboardDevice()) return;
    try { cmdInput?.blur?.(); } catch (_) {}
    try { document.activeElement?.blur?.(); } catch (_) {}
}

function enterMobileTerminalSelectionMode(reason = 'selection') {
    if (!isTouchKeyboardDevice()) return;
    window.clearTimeout(mobileTerminalSelectionRestoreTimer);
    window.clearTimeout(terminalTouchFocusTimer);
    window.clearTimeout(mobileTerminalSelectionTimer);
    const wasActive = mobileTerminalSelectionMode;
    mobileTerminalSelectionMode = true;
    keyboardFocusLikely = false;
    blurTerminalInputsForSelection();
    // 移动端选择/复制时不强制收键盘，避免布局回弹。
    // 如果用户想收键盘，让系统返回键或键盘按钮自己处理。
    if (!isTouchKeyboardDevice()) {
        if (mobileKeyboardOpen || getViewportKeyboardMetrics().keyboardInset > 8) {
            finalizeKeyboardClose({ force: true });
        }
    }
    document.documentElement.classList.add('terminal-selection-mode');
    logTerminalCopyDiagnostics(wasActive ? 'selection-mode-keep' : 'selection-mode-enter', { reason });
}

function scheduleExitMobileTerminalSelectionMode(delay = 900) {
    window.clearTimeout(mobileTerminalSelectionRestoreTimer);
    mobileTerminalSelectionRestoreTimer = window.setTimeout(() => {
        if (hasLiveTerminalSelection()) {
            scheduleExitMobileTerminalSelectionMode(900);
            return;
        }
        mobileTerminalSelectionMode = false;
        document.documentElement.classList.remove('terminal-selection-mode');
        logTerminalCopyDiagnostics('selection-mode-exit');
    }, delay);
}

function scheduleMobileLongPressSelectionGuard(reason = 'touchstart') {
    if (!isTouchKeyboardDevice()) return;
    window.clearTimeout(mobileTerminalSelectionTimer);
    mobileTerminalSelectionTimer = window.setTimeout(() => {
        enterMobileTerminalSelectionMode(reason);
    }, 260);
}

const viewportAnimationState = {
    currentHeight: 0,
    currentOffsetTop: 0,
    targetHeight: 0,
    targetOffsetTop: 0,
    startHeight: 0,
    startOffsetTop: 0,
    startTime: 0,
    duration: 560,
};

const TERMINAL_FONT_MIN = 10;
const TERMINAL_FONT_MAX = 28;
const TERMINAL_FONT_STEP = 1;
const TERMINAL_FONT_STORAGE_KEY = 'zephyr-terminal-font-size';
const TERMINAL_BOTTOM_THRESHOLD = 8;
const TERMINAL_SCROLLBAR_MIN_THUMB = 28;
const TERMINAL_XTERM_SCROLL_LOCK_THRESHOLD = 18;
const TERMINAL_ALT_SCROLL_REPEAT_MS = 16;
const TERMINAL_LINK_PROTOCOL_RE = /\b(?:https?:\/\/|ftp:\/\/|ssh:\/\/|mailto:)[^\s<>'"`\u3000]+/ig;
const TERMINAL_LAYOUT_DIAGNOSTICS = false;
const TERMINAL_SCROLL_DIAGNOSTICS = false;
const TERMINAL_MIN_RESIZE_WIDTH = 120;
const TERMINAL_MIN_RESIZE_HEIGHT = 80;
const TERMINAL_RESIZE_DEBOUNCE_MS = 120;
let lastSentTerminalSize = { cols: 0, rows: 0 };
let pendingTerminalResize = { cols: 0, rows: 0, timer: 0, reason: '' };
const TERMINAL_STABLE_LAYOUT_DELAYS = [0, 60, 160, 360, 720];
const TERMINAL_OVERSIZED_ROWS_RATIO = 1.18;
let terminalAutoFollowEnabled = true;
let terminalUserScrolledAway = false;
let terminalLastUserScrollAt = 0;
let terminalLastWheelAt = 0;
let parentKeyboardResizeFreezeUntil = 0;
const terminalMouseState = {
    enabled: false,
    sgr: false,
    mode: 'none',
    buttonDown: false,
};

function logTerminalScrollDiagnostics(event, details = {}) {
    if (!TERMINAL_SCROLL_DIAGNOSTICS) return;
    try {
        const el = getTerminalScrollElement?.();
        const viewport = window.visualViewport;
        console.info('[TerminalScrollDiagnostics]', {
            event,
            isProgrammaticTerminalScroll,
            mobileKeyboardOpen,
            keyboardFocusLikely,
            keyboardFallbackActive,
            activeElement: document.activeElement?.id || document.activeElement?.className || document.activeElement?.tagName,
            scroll: el ? {
                top: Math.round(el.scrollTop || 0),
                height: Math.round(el.scrollHeight || 0),
                clientHeight: Math.round(el.clientHeight || 0),
                bottomDistance: Math.round(getTerminalBottomDistance?.(el) || 0),
                atBottom: Boolean(isTerminalAtBottom?.(el)),
            } : null,
            viewport: viewport ? {
                height: Math.round(viewport.height || 0),
                offsetTop: Math.round(viewport.offsetTop || 0),
            } : null,
            ...details,
        });
    } catch (err) {
        console.info('[TerminalScrollDiagnostics]', event, details, err);
    }
}

function logTerminalLayoutDiagnostics(event, details = {}) {
    if (!TERMINAL_LAYOUT_DIAGNOSTICS) return;
    try {
        const viewport = window.visualViewport;
        const wrapperRect = wtermWrapper?.getBoundingClientRect?.();
        const containerRect = terminalContainer?.getBoundingClientRect?.();
        const gridRect = wtermWrapper?.querySelector?.('.term-grid')?.getBoundingClientRect?.();
        console.info('[TerminalLayoutDiagnostics]', {
            event,
            embeddedMode,
            visibility: document.visibilityState,
            mobileKeyboardOpen,
            keyboardFocusLikely,
            wrapper: wrapperRect ? {
                width: Math.round(wrapperRect.width),
                height: Math.round(wrapperRect.height),
                top: Math.round(wrapperRect.top),
                left: Math.round(wrapperRect.left),
                scrollTop: Math.round(wtermWrapper?.scrollTop || 0),
                scrollHeight: Math.round(wtermWrapper?.scrollHeight || 0),
                clientHeight: Math.round(wtermWrapper?.clientHeight || 0),
            } : null,
            container: containerRect ? {
                width: Math.round(containerRect.width),
                height: Math.round(containerRect.height),
                top: Math.round(containerRect.top),
                left: Math.round(containerRect.left),
            } : null,
            grid: gridRect ? {
                width: Math.round(gridRect.width),
                height: Math.round(gridRect.height),
            } : null,
            viewport: viewport ? {
                width: Math.round(viewport.width || 0),
                height: Math.round(viewport.height || 0),
                offsetTop: Math.round(viewport.offsetTop || 0),
                offsetLeft: Math.round(viewport.offsetLeft || 0),
            } : null,
            inner: {
                width: Math.round(window.innerWidth || 0),
                height: Math.round(window.innerHeight || 0),
            },
            term: term ? {
                cols: Number(term.cols ?? term._cols ?? term.options?.cols ?? 0),
                rows: Number(term.rows ?? term._rows ?? term.options?.rows ?? 0),
            } : null,
            ...details,
        });
    } catch (err) {
        console.info('[TerminalLayoutDiagnostics]', event, details, err);
    }
}

function getCssPxVar(name) {
    return Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0);
}

function getVirtualKeyboardInset() {
    const rect = navigator.virtualKeyboard?.boundingRect;
    const height = Math.round(rect?.height || 0);
    return height > 0 ? height : 0;
}

function isTouchKeyboardDevice() {
    return (navigator.maxTouchPoints || 0) > 0
        || window.matchMedia?.('(hover: none) and (pointer: coarse)')?.matches;
}

function getKeyboardBaselineHeight() {
    return Math.round(Math.max(
        keyboardViewportBaseline || 0,
        getCssPxVar('--stable-vh'),
        window.innerHeight || 0,
        document.documentElement.clientHeight || 0,
        window.visualViewport?.height || 0,
    ));
}

function getEstimatedKeyboardInset() {
    const baseline = getKeyboardBaselineHeight() || 720;
    return Math.round(Math.min(380, Math.max(230, baseline * 0.33)));
}

function notifyParentKeyboardMetrics(metrics) {
    if (embeddedMode && window.parent && window.parent !== window) {
        window.parent.postMessage({
            source: 'zephyr-terminal',
            type: 'keyboard-metrics',
            tabId: params?.tabId,
            keyboardOpen: !!metrics.keyboardOpen,
            keyboardInset: metrics.keyboardInset || 0,
            viewportHeight: metrics.viewportHeight || 0,
            layoutHeight: metrics.layoutHeight || 0,
            offsetTop: metrics.offsetTop || 0,
        }, '*');
    }
}

function getViewportKeyboardMetrics() {
    const viewport = window.visualViewport;
    const layoutHeight = Math.round(window.innerHeight || document.documentElement.clientHeight || 0);
    const stableHeight = getCssPxVar('--stable-vh');
    const baselineHeight = Math.max(layoutHeight, stableHeight || 0, keyboardViewportBaseline || 0);
    const rawViewportHeight = Math.round(viewport?.height || layoutHeight || 0);
    const offsetTop = Math.round(viewport?.offsetTop || 0);
    const visualViewportInset = viewport ? Math.max(0, baselineHeight - rawViewportHeight - offsetTop) : 0;
    const virtualKeyboardInset = getVirtualKeyboardInset();
    const keyboardInset = Math.max(visualViewportInset, virtualKeyboardInset);
    const viewportHeight = virtualKeyboardInset > visualViewportInset
        ? Math.max(1, baselineHeight - virtualKeyboardInset - offsetTop)
        : rawViewportHeight;
    const roundedInset = Math.round(keyboardInset);
    const openThreshold = Math.min(260, Math.max(110, baselineHeight * 0.15));
    // 关闭阈值刻意低于开启阈值：标准键盘收起时持续跟随 visualViewport，
    // 直到几乎恢复全高才释放布局，避免出现/消失最后一帧突然跳动。
    const closeThreshold = 8;
    const wantsAvoidance = isKeyboardAvoidanceTarget();
    const keyboardOpen = (wantsAvoidance || mobileKeyboardOpen)
        && roundedInset > (mobileKeyboardOpen ? closeThreshold : openThreshold);
    return {
        layoutHeight: baselineHeight || layoutHeight,
        viewportHeight,
        offsetTop,
        keyboardInset: roundedInset,
        keyboardOpen,
        wantsAvoidance,
    };
}

function isViewportVisuallyRestored(metrics, tolerance = 8) {
    if (!window.visualViewport) return true;
    return metrics.keyboardInset <= tolerance
        || metrics.viewportHeight >= metrics.layoutHeight - tolerance;
}

function isKeyboardAvoidanceTarget(element = document.activeElement) {
    if (!element) return false;
    if (element === cmdInput) return mobileKeyboardUserControlled || !isTouchKeyboardDevice();
    const tag = element.tagName?.toLowerCase();
    const editable = tag === 'textarea'
        || (tag === 'input' && !['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'range', 'color'].includes((element.type || '').toLowerCase()))
        || element.isContentEditable;
    return Boolean(editable || terminalContainer?.contains(element));
}

function setViewportCssMetrics(height, offsetTop) {
    const roundedHeight = Math.max(1, Math.round(height));
    const roundedOffset = Math.round(offsetTop);
    document.documentElement.style.setProperty('--visual-vh', `${roundedHeight}px`);
    document.documentElement.style.setProperty('--visual-offset-top', `${roundedOffset}px`);
}

function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
}

function animateViewportCssMetrics(targetHeight, targetOffsetTop, { immediate = false } = {}) {
    const targetH = Math.max(1, Math.round(targetHeight || window.innerHeight || document.documentElement.clientHeight || 1));
    const targetY = Math.round(targetOffsetTop || 0);
    if (viewportAnimationRaf) cancelAnimationFrame(viewportAnimationRaf);
    viewportAnimationRaf = 0;
    viewportAnimationState.currentHeight = targetH;
    viewportAnimationState.currentOffsetTop = targetY;
    viewportAnimationState.targetHeight = targetH;
    viewportAnimationState.targetOffsetTop = targetY;
    document.documentElement.classList.toggle('viewport-updating', !immediate);
    setViewportCssMetrics(targetH, targetY);
    window.clearTimeout(viewportAnimationResizeTimer);
    viewportAnimationResizeTimer = window.setTimeout(() => {
        document.documentElement.classList.remove('viewport-updating');
        requestTerminalAutoFollow('viewport-css-animation-settled');
        requestStableTerminalLayout('viewport-css-animation-settled', { includeResize: true });
    }, immediate ? 40 : 600);  // 增加延迟到 600ms 以匹配更长的 transition
}

function animateViewportCssMetricsOld(targetHeight, targetOffsetTop, { immediate = false } = {}) {
    const targetH = Math.max(1, Math.round(targetHeight || window.innerHeight || document.documentElement.clientHeight || 1));
    const targetY = Math.round(targetOffsetTop || 0);
    if (!viewportAnimationState.currentHeight || immediate) {
        viewportAnimationState.currentHeight = targetH;
        viewportAnimationState.currentOffsetTop = targetY;
        viewportAnimationState.targetHeight = targetH;
        viewportAnimationState.targetOffsetTop = targetY;
        setViewportCssMetrics(targetH, targetY);
        window.clearTimeout(viewportAnimationResizeTimer);
        viewportAnimationResizeTimer = window.setTimeout(scheduleTerminalResize, 80);
        return;
    }

    viewportAnimationState.targetHeight = targetH;
    viewportAnimationState.targetOffsetTop = targetY;
    if (viewportAnimationRaf) return;

    const step = () => {
        viewportAnimationRaf = 0;
        const state = viewportAnimationState;
        const heightDelta = state.targetHeight - state.currentHeight;
        const offsetDelta = state.targetOffsetTop - state.currentOffsetTop;
        const stiffness = mobileKeyboardOpen ? 0.24 : 0.20;

        state.currentHeight += heightDelta * stiffness;
        state.currentOffsetTop += offsetDelta * stiffness;

        if (Math.abs(heightDelta) < 0.75 && Math.abs(offsetDelta) < 0.75) {
            state.currentHeight = state.targetHeight;
            state.currentOffsetTop = state.targetOffsetTop;
        }

        setViewportCssMetrics(state.currentHeight, state.currentOffsetTop);

        if (state.currentHeight !== state.targetHeight || state.currentOffsetTop !== state.targetOffsetTop) {
            viewportAnimationRaf = requestAnimationFrame(step);
        } else {
            requestTerminalAutoFollow('viewport-css-animation-old-step-settled');
            scheduleTerminalResize();
        }
    };

    viewportAnimationRaf = requestAnimationFrame(step);
    window.clearTimeout(viewportAnimationResizeTimer);
    viewportAnimationResizeTimer = window.setTimeout(() => {
        requestTerminalAutoFollow('viewport-css-animation-old-timer-settled');
        scheduleTerminalResize();
    }, mobileKeyboardOpen ? 360 : 420);
}

function setStableViewportHeight({ force = false } = {}) {
    if (embeddedMode) {
        document.documentElement.style.setProperty('--stable-vh', '100vh');
        document.documentElement.style.setProperty('--visual-vh', '100vh');
        document.documentElement.style.setProperty('--visual-offset-top', '0px');
        document.documentElement.style.setProperty('--keyboard-inset', '0px');
        document.documentElement.classList.remove('keyboard-open', 'viewport-updating');
        return;
    }
    const { keyboardOpen } = getViewportKeyboardMetrics();
    if (!force && keyboardOpen) return;
    const height = Math.round(Math.max(
        window.innerHeight || 0,
        document.documentElement.clientHeight || 0,
        !keyboardOpen && window.visualViewport ? window.visualViewport.height || 0 : 0,
    ));
    if (height > 0) {
        document.documentElement.style.setProperty('--stable-vh', `${height}px`);
        if (!keyboardOpen) {
            document.documentElement.style.setProperty('--keyboard-inset', '0px');
            document.documentElement.classList.remove('keyboard-open');
            animateViewportCssMetrics(height, 0, { immediate: force });
        }
    }
}

setStableViewportHeight({ force: true });

// ---------- 主题管理 ----------
const TERMINAL_THEME_OVERRIDE_KEY = 'zephyr-terminal-theme-override';
function hasTerminalThemeOverride() {
    const saved = localStorage.getItem(TERMINAL_THEME_OVERRIDE_KEY);
    return saved === 'light' || saved === 'dark';
}
function getPreferredTheme() {
    const terminalOverride = localStorage.getItem(TERMINAL_THEME_OVERRIDE_KEY);
    if (terminalOverride === 'light' || terminalOverride === 'dark') return terminalOverride;
    const saved = localStorage.getItem('zephyr-theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyTheme(theme, { persist = false, terminalOverride = false } = {}) {
    if (document.documentElement.getAttribute('data-theme') !== theme) {
        document.documentElement.classList.add('theme-transitioning');
        window.clearTimeout(applyTheme._transitionTimer);
        applyTheme._transitionTimer = window.setTimeout(() => {
            document.documentElement.classList.remove('theme-transitioning');
        }, 300);
    }
    document.documentElement.setAttribute('data-theme', theme);
    if (terminalOverride) localStorage.setItem(TERMINAL_THEME_OVERRIDE_KEY, theme);
    else if (persist) localStorage.setItem('zephyr-theme', theme);
    themeToggle.textContent = theme === 'dark' ? '☀️' : '🌙';
}
applyTheme(getPreferredTheme());

function getPreferredWtermTheme() {
    const saved = localStorage.getItem('zephyr-wterm-theme');
    return saved === 'light' ? 'light' : 'default';
}

function applyWtermTheme(theme) {
    const normalized = theme === 'light' ? 'light' : 'default';
    const changed = document.documentElement.getAttribute('data-wterm-theme') !== normalized;
    if (changed) {
        document.documentElement.classList.add('wterm-theme-transitioning');
        terminalContainer?.classList.remove('wterm-theme-animating');
        wtermThemeToggle?.classList.remove('switching');
        void terminalContainer?.offsetWidth;
        terminalContainer?.classList.add('wterm-theme-animating');
        wtermThemeToggle?.classList.add('switching');
        window.clearTimeout(applyWtermTheme._transitionTimer);
        applyWtermTheme._transitionTimer = window.setTimeout(() => {
            document.documentElement.classList.remove('wterm-theme-transitioning');
            terminalContainer?.classList.remove('wterm-theme-animating');
            wtermThemeToggle?.classList.remove('switching');
        }, 460);
    }
    document.documentElement.setAttribute('data-wterm-theme', normalized);
    localStorage.setItem('zephyr-wterm-theme', normalized);
    if (wtermThemeToggle) {
        wtermThemeToggle.textContent = normalized === 'light' ? '终端: Light' : '终端: 默认';
        wtermThemeToggle.classList.toggle('active', normalized === 'light');
        wtermThemeToggle.setAttribute('aria-pressed', normalized === 'light' ? 'true' : 'false');
    }
    try { term?.setOption?.('theme', normalized === 'light' ? 'light' : 'default'); } catch (_) {}
    scheduleTerminalScrollbarUpdate();
}

applyWtermTheme(getPreferredWtermTheme());
wtermThemeToggle?.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-wterm-theme');
    applyWtermTheme(current === 'light' ? 'default' : 'light');
});

themeToggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'dark' ? 'light' : 'dark', { terminalOverride: true });
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!localStorage.getItem('zephyr-theme')) {
        applyTheme(e.matches ? 'dark' : 'light');
    }
});

window.addEventListener('message', (e) => {
    if (e.data?.source !== 'zephyr-app') return;
    if (e.data.type === 'theme-change' && ['light', 'dark'].includes(e.data.theme)) {
        if (!hasTerminalThemeOverride()) applyTheme(e.data.theme);
        requestStableTerminalLayout('parent-theme-change', { includeResize: false });
    }
    if (e.data.type === 'focus-terminal') {
        requestStableTerminalLayout('parent-focus-terminal', { includeResize: true, focus: true });
    }
    if (e.data.type === 'reconnect-terminal') {
        reconnectBtn?.click?.();
    }
    if (e.data.type === 'keyboard-freeze') {
        const settleMs = Math.max(300, Math.min(2500, Number(e.data.settleMs) || 1000));
        parentKeyboardResizeFreezeUntil = e.data.frozen ? Date.now() + settleMs : 0;
        logTerminalLayoutDiagnostics('parent-keyboard-freeze-message', { payload: e.data, freezeUntil: parentKeyboardResizeFreezeUntil });
        scheduleTerminalScrollbarUpdate();
        if (!e.data.frozen) window.setTimeout(() => repairOversizedWTermRows(`keyboard-freeze-release:${e.data.reason || ''}`, { force: false }), 180);
        return;
    }
    if (e.data.type === 'layout-stabilize') {
        const reason = e.data.reason || 'parent-layout-stabilize';
        const keyboardRelated = isTouchKeyboardDevice() && (
            String(reason).includes('keyboard')
            || String(reason).includes('viewport')
            || String(reason).includes('visual')
        );
        logTerminalLayoutDiagnostics('parent-layout-stabilize-message', { payload: e.data });
        if (keyboardRelated) {
            scheduleTerminalScrollbarUpdate();
            window.setTimeout(() => repairOversizedWTermRows(`keyboard-related:${reason}`, { force: false }), 900);
            return;
        }
        requestStableTerminalLayout(reason, { includeResize: true, focus: !!e.data.focus });
    }
});

// ---------- 终端字体缩放 ----------
function clampTerminalFontSize(size) {
    return Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, Math.round(size)));
}

function getStoredTerminalFontSize() {
    const saved = Number(localStorage.getItem(TERMINAL_FONT_STORAGE_KEY));
    return Number.isFinite(saved) ? clampTerminalFontSize(saved) : terminalFontSize;
}

function updateFontSizeButtons() {
    if (fontDecreaseBtn) fontDecreaseBtn.disabled = terminalFontSize <= TERMINAL_FONT_MIN;
    if (fontIncreaseBtn) fontIncreaseBtn.disabled = terminalFontSize >= TERMINAL_FONT_MAX;
}

function getTerminalCharMetrics() {
    const root = getTerminalScrollElement?.() || wtermWrapper;
    const grid = wtermWrapper?.querySelector?.('.term-grid');
    const computed = getComputedStyle(root);
    const fontSize = terminalFontSize || parseFloat(computed.fontSize) || 14;
    const cssRowHeight = parseFloat(computed.getPropertyValue('--term-row-height')) || 0;
    const existingRow = grid?.querySelector?.('.term-row, .term-scrollback-row');
    const existingRowHeight = existingRow?.getBoundingClientRect?.().height || 0;

    const rowProbe = document.createElement('div');
    rowProbe.className = 'term-row zephyr-measure-row';
    rowProbe.style.position = 'absolute';
    rowProbe.style.visibility = 'hidden';
    rowProbe.style.pointerEvents = 'none';
    rowProbe.style.whiteSpace = 'pre';
    rowProbe.textContent = 'W';
    (grid || root).appendChild(rowProbe);
    const rowProbeRect = rowProbe.getBoundingClientRect();
    const span = document.createElement('span');
    span.textContent = 'W';
    span.style.whiteSpace = 'pre';
    rowProbe.textContent = '';
    rowProbe.appendChild(span);
    const spanRect = span.getBoundingClientRect();
    rowProbe.remove();

    // 行高必须跟 wterm renderer 的 .term-row 一致；裸 span 高度会偏小，导致 rows 被算大，出现底部大量空白行。
    const lineHeight = Math.max(1,
        Number(term?._rowHeight || 0),
        existingRowHeight,
        rowProbeRect.height,
        cssRowHeight,
        parseFloat(computed.lineHeight) || 0,
        fontSize * 1.2,
    );
    const charWidth = Math.max(1, spanRect.width || fontSize * 0.62);
    return { lineHeight, charWidth };
}

function getMeasuredTerminalSize() {
    normalizeWTermContainerLayout('measure-terminal-size');
    const rect = getStableTerminalSurfaceRect();
    const style = getComputedStyle(wtermWrapper);
    const paddingX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    const paddingY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    const { lineHeight, charWidth } = getTerminalCharMetrics();
    let effectiveHeight = Math.max(0, rect.height - paddingY);
    const effectiveWidth = Math.max(0, rect.width - paddingX);
    const measuredRows = Math.max(2, Math.floor(effectiveHeight / Math.max(1, lineHeight)));
    const measuredCols = Math.max(20, Math.floor(effectiveWidth / Math.max(1, charWidth)));
    const rows = Math.min(200, measuredRows);
    const cols = Math.min(500, measuredCols);
    return {
        cols,
        rows,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        effectiveWidth: Math.round(effectiveWidth),
        effectiveHeight: Math.round(effectiveHeight),
        lineHeight,
        charWidth,
    };
}

function getInitialTerminalSize() {
    const measured = getMeasuredTerminalSize();
    return {
        cols: Math.max(20, Math.floor(measured.cols || Number(term?.cols || 80))),
        rows: Math.max(2, Math.floor(measured.rows || Number(term?.rows || 24))),
    };
}

function isEmbeddedTerminalFrameVisible() {
    if (!embeddedMode) return true;
    try {
        const frame = window.frameElement;
        if (!frame) return true;
        const rect = frame.getBoundingClientRect();
        const style = window.parent?.getComputedStyle?.(frame);
        const parentWidth = window.parent?.innerWidth || rect.right;
        const parentHeight = window.parent?.innerHeight || rect.bottom;
        return rect.width >= TERMINAL_MIN_RESIZE_WIDTH
            && rect.height >= TERMINAL_MIN_RESIZE_HEIGHT
            && rect.right > 0
            && rect.bottom > 0
            && rect.left < parentWidth
            && rect.top < parentHeight
            && style?.display !== 'none'
            && style?.visibility !== 'hidden';
    } catch (_) {
        return true;
    }
}

function normalizeWTermContainerLayout(reason = 'normalize-layout') {
    if (!wtermWrapper) return;
    // @wterm/dom 在 autoResize:false 时会 _lockHeight()，给根元素写入 rows*rowHeight 的 inline height。
    // 该根元素在本项目中同时是 flex 滚动容器；页面/标签隐藏、分屏比例变化后，旧 inline height 会污染下一次测量，
    // 造成“大量空行”或“只剩一行高”。这里强制恢复为由外层 flex/viewport 决定尺寸，模拟 xterm.js FitAddon 的容器语义。
    if (wtermWrapper.style.height) wtermWrapper.style.height = '';
    if (wtermWrapper.style.minHeight) wtermWrapper.style.minHeight = '';
    if (wtermWrapper.style.maxHeight) wtermWrapper.style.maxHeight = '';
    wtermWrapper.style.flex = '1 1 auto';
    wtermWrapper.style.width = '100%';
    wtermWrapper.style.overflowY = 'auto';
    wtermWrapper.style.overflowX = 'hidden';
    logTerminalLayoutDiagnostics('wterm-layout:normalized-container', { reason });
}

function getStableTerminalSurfaceRect() {
    normalizeWTermContainerLayout('measure-surface');
    const wrapperRect = wtermWrapper?.getBoundingClientRect?.();
    const containerRect = terminalContainer?.getBoundingClientRect?.();
    if (wrapperRect && wrapperRect.width >= TERMINAL_MIN_RESIZE_WIDTH && wrapperRect.height >= TERMINAL_MIN_RESIZE_HEIGHT) return wrapperRect;
    if (containerRect && containerRect.width >= TERMINAL_MIN_RESIZE_WIDTH && containerRect.height >= TERMINAL_MIN_RESIZE_HEIGHT) return containerRect;
    return wrapperRect || containerRect || { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
}

function repairWTermLayoutAfterVisibilityChange(reason = 'layout-repair', { sendResize = true, follow = null } = {}) {
    if (!term || !wtermWrapper || document.visibilityState !== 'visible' || !isEmbeddedTerminalFrameVisible()) return false;
    normalizeWTermContainerLayout(reason);
    const rect = getStableTerminalSurfaceRect();
    if (!rect || rect.width < TERMINAL_MIN_RESIZE_WIDTH || rect.height < TERMINAL_MIN_RESIZE_HEIGHT || wtermWrapper.offsetParent === null) {
        logTerminalLayoutDiagnostics('wterm-layout:repair-skipped-hidden-or-tiny', {
            reason,
            width: Math.round(rect?.width || 0),
            height: Math.round(rect?.height || 0),
        });
        return false;
    }
    const shouldFollow = follow ?? (terminalAutoFollowEnabled || isTerminalAtBottom(undefined, TERMINAL_XTERM_SCROLL_LOCK_THRESHOLD));
    const measured = getMeasuredTerminalSize();
    const cols = Math.max(20, measured.cols);
    const rows = Math.max(2, measured.rows);
    const changed = Number(term.cols ?? term._cols ?? 0) !== cols || Number(term.rows ?? term._rows ?? 0) !== rows;
    resizeWTermSafely(cols, rows, reason);
    repairOversizedWTermRows(`${reason}:oversized-check`, { force: false });
    normalizeWTermContainerLayout(`${reason}:after-resize`);
    try { term._scheduleRender?.(); } catch (_) {}
    if (sendResize && changed) sendTerminalResize(cols, rows, { reason, force: true });
    requestAnimationFrame(() => {
        normalizeWTermContainerLayout(`${reason}:raf`);
        const el = getTerminalScrollElement();
        if (el && !shouldFollow) el.scrollTop = Math.min(el.scrollTop, getTerminalMaxScroll(el));
        if (shouldFollow) requestTerminalAutoFollow(`${reason}:follow`);
        else scheduleTerminalScrollbarUpdate();
    });
    return true;
}

function repairOversizedWTermRows(reason = 'oversized-rows-repair', { force = false } = {}) {
    if (!term || !wtermWrapper || document.visibilityState !== 'visible' || !isEmbeddedTerminalFrameVisible()) return false;
    if (!force && isTouchKeyboardDevice() && isMobileKeyboardActiveOrSettling()) return false;
    normalizeWTermContainerLayout(`${reason}:normalize`);
    const measured = getMeasuredTerminalSize();
    const currentRows = Number(term.rows ?? term._rows ?? term.options?.rows ?? 0);
    const currentCols = Number(term.cols ?? term._cols ?? term.options?.cols ?? 0);
    if (!currentRows || !measured.rows) return false;
    const currentPixelHeight = currentRows * measured.lineHeight;
    const allowedPixelHeight = measured.effectiveHeight * TERMINAL_OVERSIZED_ROWS_RATIO;
    const rowsTooLarge = currentRows > measured.rows + 2 && currentPixelHeight > allowedPixelHeight;
    const colsTooLarge = currentCols > measured.cols + 2;
    if (!rowsTooLarge && !colsTooLarge) return false;
    const nextRows = Math.max(2, measured.rows);
    const nextCols = Math.max(20, measured.cols);
    logTerminalLayoutDiagnostics('wterm-layout:oversized-rows-repair', {
        reason,
        currentRows,
        currentCols,
        nextRows,
        nextCols,
        currentPixelHeight: Math.round(currentPixelHeight),
        allowedPixelHeight: Math.round(allowedPixelHeight),
        effectiveHeight: measured.effectiveHeight,
        lineHeight: measured.lineHeight,
    });
    resizeWTermSafely(nextCols, nextRows, reason);
    sendTerminalResize(nextCols, nextRows, { reason, force: true });
    requestAnimationFrame(() => requestTerminalAutoFollow(`${reason}:follow`));
    return true;
}

function resizeWTermSafely(cols, rows, reason = 'safe-resize') {
    if (!term || !wtermWrapper) return false;
    const nextCols = Math.floor(Number(cols));
    const nextRows = Math.floor(Number(rows));
    if (!Number.isFinite(nextCols) || !Number.isFinite(nextRows) || nextCols < 20 || nextRows < 2) {
        logTerminalLayoutDiagnostics('wterm-layout:ignored-tiny-safe-resize', {
            reason,
            cols: nextCols,
            rows: nextRows,
        });
        return false;
    }

    const currentCols = Number(term.cols ?? term._cols ?? term.options?.cols ?? 0);
    const currentRows = Number(term.rows ?? term._rows ?? term.options?.rows ?? 0);
    try {
        if ((currentCols !== nextCols || currentRows !== nextRows) && typeof term.resize === 'function') {
            suppressWTermResizeEvent = true;
            try {
                term.resize(nextCols, nextRows);
            } finally {
                suppressWTermResizeEvent = false;
            }
        } else if (term.options) {
            term.options.cols = nextCols;
            term.options.rows = nextRows;
        }
        try { term.refresh?.(); } catch (_) {}
        normalizeWTermContainerLayout(`${reason}:resizeWTermSafely`);
        logTerminalLayoutDiagnostics('wterm-layout:safe-resized', {
            reason,
            cols: nextCols,
            rows: nextRows,
            previousCols: currentCols,
            previousRows: currentRows,
        });
        return true;
    } catch (err) {
        logTerminalLayoutDiagnostics('wterm-layout:safe-resize-failed', {
            reason,
            cols: nextCols,
            rows: nextRows,
            error: err?.message || String(err),
        });
        try { term.refresh?.(); } catch (_) {}
        return false;
    }
}

function invokeWTermLayoutRefresh(reason = 'layout-refresh') {
    if (!term || !wtermWrapper) return;
    const rect = wtermWrapper.getBoundingClientRect();
    if (rect.width < TERMINAL_MIN_RESIZE_WIDTH || rect.height < TERMINAL_MIN_RESIZE_HEIGHT) {
        logTerminalLayoutDiagnostics('wterm-layout:skipped-unstable-rect', {
            reason,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
        });
        return;
    }

    const measured = getMeasuredTerminalSize();
    resizeWTermSafely(measured.cols, measured.rows, reason);

    logTerminalLayoutDiagnostics('wterm-layout:refreshed-safe', {
        reason,
        measuredCols: measured.cols,
        measuredRows: measured.rows,
        measuredWidth: measured.width,
        measuredHeight: measured.height,
    });
}

function requestStableTerminalLayout(reason = 'stable-layout', { includeResize = true, focus = false } = {}) {
    if (isTouchKeyboardDevice() && /keyboard|viewport|visual/.test(String(reason))) {
        scheduleTerminalScrollbarUpdate();
        return;
    }
    window.clearTimeout(requestStableTerminalLayout._coalesceTimer);
    requestStableTerminalLayout._pendingReason = reason;
    requestStableTerminalLayout._focus = requestStableTerminalLayout._focus || focus;
    requestStableTerminalLayout._coalesceTimer = window.setTimeout(() => {
        const runReason = requestStableTerminalLayout._pendingReason || reason;
        const shouldFocus = !!requestStableTerminalLayout._focus;
        requestStableTerminalLayout._pendingReason = '';
        requestStableTerminalLayout._focus = false;

        logTerminalLayoutDiagnostics('stable-layout:official-refresh', { reason: runReason, includeResize, focus: shouldFocus });
        // 仅在可见且尺寸稳定后刷新渲染/可视区；不要因父页面切换或 focus 主动滚到底。
        requestAnimationFrame(() => {
            if (includeResize) {
                if (isTouchKeyboardDevice() && isMobileKeyboardActiveOrSettling()) refreshTerminalAfterVisibilityRestore(runReason, { focus: shouldFocus });
                else scheduleTerminalResize(runReason, isTouchKeyboardDevice() ? 240 : 160);
            } else {
                refreshTerminalAfterVisibilityRestore(runReason, { focus: shouldFocus });
            }
            scheduleTerminalScrollbarUpdate();
            if (shouldFocus && !isTouchKeyboardDevice()) {
                try { term?.focus?.(); } catch (_) {}
            }
        });
    }, 24);
}

function sendTerminalResize(cols, rows, { reason = 'direct', force = false } = {}) {
    if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN || !isConnected) return;
    const explicitCols = Math.floor(Number(cols));
    const explicitRows = Math.floor(Number(rows));

    if (isTouchKeyboardDevice() && isMobileKeyboardActiveOrSettling() && /keyboard|viewport|visual|resize-observer/.test(String(reason))) {
        logTerminalLayoutDiagnostics('resize:ignored-mobile-keyboard-settling', { reason, explicitCols, explicitRows });
        return;
    }

    if (reason === 'wterm-onResize') {
        if (isTouchKeyboardDevice() && isMobileKeyboardActiveOrSettling()) {
            logTerminalLayoutDiagnostics('resize:ignored-mobile-keyboard-settling', { reason, explicitCols, explicitRows });
            return;
        }
        // WTerm 的 ResizeObserver 在 iframe 被隐藏/最小化/父标签切换时会收到 0/1px 的瞬时尺寸。
        // ssh2 的 Channel#setWindow(rows, cols, height, width) 会立刻改变远端 PTY；
        // 如果把这些瞬时小尺寸发给后端，远端程序会按 1~几列重排，回来后就出现截图里的竖向破损。
        if (!Number.isFinite(explicitCols) || !Number.isFinite(explicitRows) || explicitCols < 20 || explicitRows < 2) {
            logTerminalLayoutDiagnostics('resize:ignored-invalid-wterm-size', {
                reason,
                explicitCols,
                explicitRows,
            });
            return;
        }
        const rect = wtermWrapper?.getBoundingClientRect?.();
        const visibleSurface = rect
            && rect.width >= TERMINAL_MIN_RESIZE_WIDTH
            && rect.height >= TERMINAL_MIN_RESIZE_HEIGHT
            && wtermWrapper?.offsetParent !== null
            && document.visibilityState === 'visible'
            && isEmbeddedTerminalFrameVisible();
        if (!visibleSurface) {
            logTerminalLayoutDiagnostics('resize:defer-hidden-wterm-size', {
                reason,
                explicitCols,
                explicitRows,
                rectWidth: Math.round(rect?.width || 0),
                rectHeight: Math.round(rect?.height || 0),
            });
            pendingTerminalResize.cols = explicitCols;
            pendingTerminalResize.rows = explicitRows;
            pendingTerminalResize.reason = reason;
            return;
        }
        window.clearTimeout(pendingTerminalResize.timer);
        pendingTerminalResize = { cols: explicitCols, rows: explicitRows, reason, timer: window.setTimeout(() => {
            if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN || !isConnected) return;
            if (!isEmbeddedTerminalFrameVisible()) return;
            const freshRect = wtermWrapper?.getBoundingClientRect?.();
            if (!freshRect || freshRect.width < TERMINAL_MIN_RESIZE_WIDTH || freshRect.height < TERMINAL_MIN_RESIZE_HEIGHT || document.visibilityState !== 'visible') return;
            const measured = getMeasuredTerminalSize();
            if (Math.abs(measured.cols - explicitCols) > 1 || Math.abs(measured.rows - explicitRows) > 1) {
                logTerminalLayoutDiagnostics('resize:ignored-stale-wterm-size', { reason, explicitCols, explicitRows, measuredCols: measured.cols, measuredRows: measured.rows });
                return;
            }
            if (lastSentTerminalSize.cols === explicitCols && lastSentTerminalSize.rows === explicitRows && !force) return;
            lastSentTerminalSize = { cols: explicitCols, rows: explicitRows };
            wsConnection.send(JSON.stringify({ type: 'resize', rows: explicitRows, cols: explicitCols }));
            logTerminalLayoutDiagnostics('resize:sent', { reason, force, cols: explicitCols, rows: explicitRows });
        }, TERMINAL_RESIZE_DEBOUNCE_MS) };
        return;
    }

    if (reason === 'stable-visible-resize' || reason === 'resize-observer-stable' || reason === 'initial-visible-resize' || reason === 'pageshow-visible' || reason === 'visibility-visible' || reason === 'window-resize' || reason === 'parent-focus-terminal' || String(reason).startsWith('render-terminal-workspace') || String(reason).startsWith('switch-view-terminal') || String(reason).startsWith('terminal-window-morph')) {
        if (!Number.isFinite(explicitCols) || !Number.isFinite(explicitRows) || explicitCols < 20 || explicitRows < 2) return;
        const rect = wtermWrapper?.getBoundingClientRect?.();
        const visibleSurface = rect
            && rect.width >= TERMINAL_MIN_RESIZE_WIDTH
            && rect.height >= TERMINAL_MIN_RESIZE_HEIGHT
            && wtermWrapper?.offsetParent !== null
            && document.visibilityState === 'visible'
            && isEmbeddedTerminalFrameVisible();
        if (!visibleSurface) {
            logTerminalLayoutDiagnostics('resize:ignored-hidden-stable-size', { reason, explicitCols, explicitRows, rectWidth: Math.round(rect?.width || 0), rectHeight: Math.round(rect?.height || 0) });
            return;
        }
        if (isTouchKeyboardDevice() && isMobileKeyboardActiveOrSettling() && /keyboard|viewport|visual|resize-observer/.test(String(reason))) {
            logTerminalLayoutDiagnostics('resize:ignored-mobile-keyboard-settling', { reason, explicitCols, explicitRows });
            return;
        }
        const measured = getMeasuredTerminalSize();
        if (Math.abs(measured.cols - explicitCols) > 1 || Math.abs(measured.rows - explicitRows) > 1) {
            logTerminalLayoutDiagnostics('resize:ignored-stale-stable-size', { reason, explicitCols, explicitRows, measuredCols: measured.cols, measuredRows: measured.rows });
            return;
        }
        if (lastSentTerminalSize.cols === explicitCols && lastSentTerminalSize.rows === explicitRows && !force) return;
        lastSentTerminalSize = { cols: explicitCols, rows: explicitRows };
        wsConnection.send(JSON.stringify({ type: 'resize', rows: explicitRows, cols: explicitCols }));
        logTerminalLayoutDiagnostics('resize:sent', { reason, force, cols: explicitCols, rows: explicitRows });
        return;
    }

    const measured = getMeasuredTerminalSize();
    if (!isEmbeddedTerminalFrameVisible()) return;
    if (!force && (measured.width < TERMINAL_MIN_RESIZE_WIDTH || measured.height < TERMINAL_MIN_RESIZE_HEIGHT)) {
        logTerminalLayoutDiagnostics('resize:skipped-unstable-rect', {
            reason,
            width: measured.width,
            height: measured.height,
        });
        return;
    }

    const nextCols = measured.cols;
    const nextRows = measured.rows;

    wsConnection.send(JSON.stringify({ type: 'resize', rows: nextRows, cols: nextCols }));
    logTerminalLayoutDiagnostics('resize:sent', {
        reason,
        force,
        cols: nextCols,
        rows: nextRows,
        measuredWidth: measured.width,
        measuredHeight: measured.height,
        effectiveWidth: measured.effectiveWidth,
        effectiveHeight: measured.effectiveHeight,
        lineHeight: Number(measured.lineHeight.toFixed(2)),
        charWidth: Number(measured.charWidth.toFixed(2)),
    });
}

function isParentKeyboardResizeFrozen() {
    return Date.now() < parentKeyboardResizeFreezeUntil;
}

function isMobileKeyboardActiveOrSettling() {
    if (isParentKeyboardResizeFrozen()) return true;
    if (!isTouchKeyboardDevice()) return false;
    const metrics = getViewportKeyboardMetrics();
    return Boolean(
        mobileKeyboardOpen
        || keyboardFocusLikely
        || metrics.keyboardInset > 8
        || document.documentElement.classList.contains('keyboard-open')
    );
}

function scheduleTerminalResize(reason = 'scheduled', delay = 120) {
    if (isTouchKeyboardDevice() && isMobileKeyboardActiveOrSettling() && /keyboard|viewport|visual|resize-observer/.test(String(reason))) {
        logTerminalLayoutDiagnostics('resize:blocked-mobile-keyboard-settling', { reason });
        scheduleTerminalScrollbarUpdate();
        return;
    }
    const shouldFollowAfterResize = terminalAutoFollowEnabled || isTerminalAtBottom(undefined, TERMINAL_XTERM_SCROLL_LOCK_THRESHOLD);
    window.clearTimeout(scheduleTerminalResize._timer);
    scheduleTerminalResize._timer = window.setTimeout(() => {
        if (!term || !wtermWrapper || document.visibilityState !== 'visible' || !isEmbeddedTerminalFrameVisible()) return;
        const rect = wtermWrapper.getBoundingClientRect();
        if (rect.width < TERMINAL_MIN_RESIZE_WIDTH || rect.height < TERMINAL_MIN_RESIZE_HEIGHT || wtermWrapper.offsetParent === null) {
            logTerminalLayoutDiagnostics('resize:skipped-hidden-or-tiny-refresh', {
                reason,
                width: Math.round(rect.width || 0),
                height: Math.round(rect.height || 0),
            });
            return;
        }
        const measured = getMeasuredTerminalSize();
        const cols = Math.max(20, measured.cols);
        const rows = Math.max(2, measured.rows);
        const changed = lastSentTerminalSize.cols !== cols || lastSentTerminalSize.rows !== rows;
        repairWTermLayoutAfterVisibilityChange(`scheduled:${reason}`, { sendResize: false, follow: shouldFollowAfterResize });
        if (changed) {
            sendTerminalResize(cols, rows, { reason, force: true });
        }
        if (shouldFollowAfterResize) requestAnimationFrame(() => requestTerminalAutoFollow(`resize:${reason}`));
        else scheduleTerminalScrollbarUpdate();
    }, delay);
    logTerminalLayoutDiagnostics('resize:scheduled-stable-refresh', { reason, delay });
    scheduleTerminalScrollbarUpdate();
}

function setupStableTerminalResizeObserver() {
    if (!window.ResizeObserver || !wtermWrapper) return () => {};
    const observer = new ResizeObserver(() => {
        normalizeWTermContainerLayout('resize-observer');
        scheduleTerminalResize('resize-observer-stable', 160);
    });
    observer.observe(wtermWrapper);
    if (terminalContainer) observer.observe(terminalContainer);
    return () => observer.disconnect();
}

function applyTerminalFontSize(size, { persist = true } = {}) {
    terminalFontSize = clampTerminalFontSize(size);
    const wasAtBottom = isTerminalAtBottom(undefined, TERMINAL_XTERM_SCROLL_LOCK_THRESHOLD) || terminalAutoFollowEnabled;
    document.documentElement.style.setProperty('--terminal-font-size', `${terminalFontSize}px`);
    wtermWrapper.style.fontSize = `${terminalFontSize}px`;
    try { term?.setOption?.('fontSize', terminalFontSize); } catch (_) {}
    try { term?.options && (term.options.fontSize = terminalFontSize); } catch (_) {}
    try { term?._setRowHeight?.(); } catch (_) {}
    if (persist) localStorage.setItem(TERMINAL_FONT_STORAGE_KEY, String(terminalFontSize));
    updateFontSizeButtons();
    if (!isTouchKeyboardDevice()) scheduleTerminalResize('font-size-change', 80);
    if (wasAtBottom) requestAnimationFrame(() => requestTerminalAutoFollow('font-size-change'));
    else scheduleTerminalScrollbarUpdate();
}

function getTouchDistance(touches) {
    const [a, b] = touches;
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function setupTerminalPinchZoom() {
    wtermWrapper.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 2) return;
        e.preventDefault();
        pinchStartDistance = getTouchDistance(e.touches);
        pinchStartFontSize = terminalFontSize;
        pinchLastAppliedFontSize = terminalFontSize;
    }, { passive: false });

    wtermWrapper.addEventListener('touchmove', (e) => {
        if (e.touches.length !== 2 || !pinchStartDistance) return;
        e.preventDefault();
        const distance = getTouchDistance(e.touches);
        const nextSize = clampTerminalFontSize(pinchStartFontSize * (distance / pinchStartDistance));
        if (nextSize !== pinchLastAppliedFontSize) {
            pinchLastAppliedFontSize = nextSize;
            applyTerminalFontSize(nextSize);
        }
    }, { passive: false });

    const endPinch = () => { pinchStartDistance = 0; };
    wtermWrapper.addEventListener('touchend', endPinch, { passive: true });
    wtermWrapper.addEventListener('touchcancel', endPinch, { passive: true });
}

applyTerminalFontSize(getStoredTerminalFontSize(), { persist: false });
fontDecreaseBtn?.addEventListener('click', () => applyTerminalFontSize(terminalFontSize - TERMINAL_FONT_STEP));
fontIncreaseBtn?.addEventListener('click', () => applyTerminalFontSize(terminalFontSize + TERMINAL_FONT_STEP));
setupTerminalPinchZoom();

// ---------- 复制功能 ----------
copyBtn.addEventListener('click', async () => {
    const text = getCopyableSelectionText();
    if (!text) {
        toast?.('请先选择要复制的终端内容');
        return;
    }
    mobileClipboardActionInProgress = true;
    enterMobileTerminalSelectionMode('copy-button');
    const originalText = copyBtn.textContent;
    try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = '已复制';
    } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', 'readonly');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '0';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        const active = document.activeElement;
        ta.select();
        try { document.execCommand('copy'); copyBtn.textContent = '已复制'; } catch (_) { copyBtn.textContent = '失败'; }
        document.body.removeChild(ta);
        try { active?.focus?.({ preventScroll: true }); } catch (_) {}
    } finally {
        window.setTimeout(() => { mobileClipboardActionInProgress = false; }, 220);
    }
    scheduleExitMobileTerminalSelectionMode(1200);
    setTimeout(() => { copyBtn.textContent = originalText; }, 1500);
});

pasteBtn?.addEventListener('click', async () => {
    mobileClipboardActionInProgress = true;
    try {
        const pasted = await pasteClipboardIntoTerminal('mobile-paste-button');
        if (!pasted) toast?.('剪贴板为空或浏览器未授权');
    } finally {
        window.setTimeout(() => { mobileClipboardActionInProgress = false; }, 220);
    }
});

copyBtn.addEventListener('pointerdown', (e) => e.preventDefault(), { passive: false });
copyBtn.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
pasteBtn?.addEventListener('pointerdown', (e) => e.preventDefault(), { passive: false });
pasteBtn?.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });

document.addEventListener('copy', (e) => {
    const selection = window.getSelection?.();
    const text = getTerminalSelectionTextFromDom(selection);
    if (!text) return;
    e.preventDefault();
    e.clipboardData?.setData('text/plain', text);
    cachedSelectionText = text;
    console.debug('[TerminalCopy]', 'native copy overridden', {
        length: text.length,
        newlines: (text.match(/\n/g) || []).length,
    });
});

function normalizeCopiedTerminalText(text = '') {
    let value = String(text)
        .replace(/\u00a0/g, ' ')
        .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
        .replace(/\r\n?/g, '\n');
    // 仅作为兜底：如果浏览器默认 selection 已经把 URI 内部软换行变成空白，
    // 这里会把常见 URI 片段拼回去。真正的根治在 getTerminalSelectionTextFromDom：
    // 按终端屏幕行宽区分软换行/真实换行。
    value = value.replace(/\b([a-z][a-z0-9+.-]{1,31}:\/\/[^\s<>'"]+(?:[ \t\n]+[^\s<>'"]+)*)/gi, (match) => {
        const compact = match.replace(/[ \t\n]+/g, '');
        return /^[a-z][a-z0-9+.-]{1,31}:\/\//i.test(compact) ? compact : match;
    });
    return value;
}

function getSelectionTextFromRanges(selection) {
    if (!selection || selection.rangeCount === 0) return '';
    const parts = [];
    for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        parts.push(range.cloneContents().textContent || range.toString() || '');
    }
    return parts.join('');
}

function getTerminalColsForCopy() {
    const optionCols = Number(term?.cols ?? term?._cols ?? term?.options?.cols);
    if (Number.isFinite(optionCols) && optionCols > 0) return Math.floor(optionCols);
    const rect = wtermWrapper?.getBoundingClientRect?.();
    if (!rect?.width) return 80;
    const { charWidth } = getTerminalCharMetrics();
    return Math.max(2, Math.floor(rect.width / Math.max(1, charWidth)));
}

function terminalDisplayColumns(text = '') {
    let columns = 0;
    for (const ch of String(text)) {
        if (ch === '\t') columns += 8 - (columns % 8 || 0);
        else if (/[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch)) columns += 2;
        else columns += 1;
    }
    return columns;
}

function cleanTerminalRowText(text = '') {
    return String(text)
        .replace(/\u00a0/g, ' ')
        .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
        .replace(/[ \t]+$/g, '');
}

function selectionTouchesTerminal(selection) {
    if (!selection || selection.rangeCount === 0 || !wtermWrapper) return false;
    for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        if (wtermWrapper.contains(range.commonAncestorContainer)) return true;
        const rows = wtermWrapper.querySelectorAll?.('.term-row') || [];
        for (const row of rows) {
            try {
                if (range.intersectsNode(row)) return true;
            } catch (_) {}
        }
    }
    return false;
}

function getRangeIntersectionText(range, node) {
    const nodeRange = document.createRange();
    nodeRange.selectNodeContents(node);
    if (range.compareBoundaryPoints(Range.END_TO_START, nodeRange) <= 0 || range.compareBoundaryPoints(Range.START_TO_END, nodeRange) >= 0) {
        return '';
    }
    const intersection = range.cloneRange();
    if (intersection.compareBoundaryPoints(Range.START_TO_START, nodeRange) < 0) {
        intersection.setStart(nodeRange.startContainer, nodeRange.startOffset);
    }
    if (intersection.compareBoundaryPoints(Range.END_TO_END, nodeRange) > 0) {
        intersection.setEnd(nodeRange.endContainer, nodeRange.endOffset);
    }
    const text = intersection.cloneContents().textContent || intersection.toString() || '';
    nodeRange.detach?.();
    intersection.detach?.();
    return text;
}

function bridgeCellToChar(cell) {
    const cp = Number(cell?.char || 0);
    return cp >= 32 ? String.fromCodePoint(cp) : ' ';
}

function readMainBufferRowText(rowIndex, cols) {
    const bridge = term?.bridge;
    if (!bridge || rowIndex < 0) return '';
    let text = '';
    for (let col = 0; col < cols; col++) text += bridgeCellToChar(bridge.getCell(rowIndex, col));
    return cleanTerminalRowText(text);
}

function readScrollbackBufferRowText(rowEl, cols) {
    const bridge = term?.bridge;
    const renderer = term?.renderer;
    if (!bridge || !renderer?._scrollbackRowEls) return '';
    const index = renderer._scrollbackRowEls.indexOf(rowEl);
    const count = bridge.getScrollbackCount?.() || 0;
    if (index < 0 || count <= 0) return '';

    // renderer.syncScrollback() 以 offset 从大到小插入 DOM，因此 DOM 中第 0 个 scrollback row
    // 对应最老的 scrollback offset = count - 1。
    const offset = count - 1 - index;
    if (offset < 0) return '';

    const lineLen = Math.max(0, Math.min(cols, bridge.getScrollbackLineLen(offset) || 0));
    let text = '';
    for (let col = 0; col < lineLen; col++) text += bridgeCellToChar(bridge.getScrollbackCell(offset, col));
    const fromBridge = cleanTerminalRowText(text);
    const fromDom = cleanTerminalRowText(rowEl.textContent || '');

    // 如果 offset 映射因 wterm 内部滚动更新而不一致，回退 DOM 行文本，避免复制错行或空白。
    if (fromBridge && (!fromDom || fromBridge === fromDom || fromDom.includes(fromBridge) || fromBridge.includes(fromDom))) return fromBridge;
    return fromDom;
}

function readWTermBufferRowText(rowEl, cols) {
    const renderer = term?.renderer;
    if (!rowEl || !renderer) return cleanTerminalRowText(rowEl?.textContent || '');
    if (rowEl.classList.contains('term-scrollback-row')) return readScrollbackBufferRowText(rowEl, cols);

    const rowIndex = renderer.rowEls?.indexOf(rowEl) ?? -1;
    const fromBridge = readMainBufferRowText(rowIndex, cols);
    const fromDom = cleanTerminalRowText(rowEl.textContent || '');

    // 主屏行没有 lineLen API，bridge 读取后需要 trim；若异常则回退 DOM。
    return fromBridge || fromDom;
}

function getTerminalRowSelectionText(row, selection) {
    let text = '';
    if (!row || !selection) return text;
    for (let i = 0; i < selection.rangeCount; i++) {
        try {
            text += getRangeIntersectionText(selection.getRangeAt(i), row);
        } catch (_) {}
    }
    return cleanTerminalRowText(text);
}

function getSelectedTerminalRowSlice(row, bufferText, selectedDomText) {
    const selectedText = cleanTerminalRowText(selectedDomText);
    const fullBufferText = cleanTerminalRowText(bufferText);
    const fullDomText = cleanTerminalRowText(row?.textContent || '');
    if (!selectedText) {
        return {
            text: '',
            startOffset: 0,
            endOffset: 0,
            startsAtRowStart: true,
            endsAtRowEnd: true,
            partial: false,
        };
    }

    const referenceText = fullDomText || fullBufferText;
    const startOffset = referenceText ? referenceText.indexOf(selectedText) : -1;
    const isFullDomRow = referenceText && selectedText === referenceText;
    const isFullBufferRow = fullBufferText && selectedText === fullBufferText;

    if (startOffset >= 0 && !isFullDomRow && fullBufferText) {
        const sliced = fullBufferText.slice(startOffset, startOffset + selectedText.length);
        return {
            text: sliced || selectedText,
            startOffset,
            endOffset: startOffset + selectedText.length,
            startsAtRowStart: startOffset <= 0,
            endsAtRowEnd: startOffset + selectedText.length >= referenceText.length,
            partial: true,
        };
    }

    if (isFullDomRow || isFullBufferRow) {
        return {
            text: fullBufferText || selectedText,
            startOffset: 0,
            endOffset: referenceText.length,
            startsAtRowStart: true,
            endsAtRowEnd: true,
            partial: false,
        };
    }

    // DOM 选区文本和 buffer 文本无法可靠对齐时，优先返回浏览器真实选中的片段，
    // 避免再次退化成“复制整行”。
    return {
        text: selectedText,
        startOffset: 0,
        endOffset: selectedText.length,
        startsAtRowStart: false,
        endsAtRowEnd: false,
        partial: true,
    };
}

function getTerminalSelectionTextFromDom(selection = window.getSelection?.()) {
    if (!selection || selection.rangeCount === 0 || !selectionTouchesTerminal(selection)) return '';
    const fallbackText = getSelectionTextFromRanges(selection) || selection.toString?.() || '';
    if (!fallbackText || !fallbackText.trim()) return '';

    const rows = Array.from(wtermWrapper.querySelectorAll('.term-row'));
    if (!rows.length || !term?.bridge) return normalizeCopiedTerminalText(fallbackText);

    const cols = Math.max(2, Number(term.bridge.getCols?.() || getTerminalColsForCopy()));
    const selectedRows = [];
    for (const row of rows) {
        const selectedDomText = getTerminalRowSelectionText(row, selection);
        if (!selectedDomText) continue;

        const bufferText = readWTermBufferRowText(row, cols);
        const slice = getSelectedTerminalRowSlice(row, bufferText, selectedDomText);
        if (!slice.text) continue;

        selectedRows.push({
            text: slice.text,
            fullColumns: terminalDisplayColumns(bufferText || row.textContent || ''),
            selectedColumns: terminalDisplayColumns(slice.text),
            startsAtRowStart: slice.startsAtRowStart,
            endsAtRowEnd: slice.endsAtRowEnd,
            partial: slice.partial,
            source: row.classList.contains('term-scrollback-row') ? 'scrollback' : 'screen',
        });
    }

    if (!selectedRows.length) return normalizeCopiedTerminalText(fallbackText);

    let result = '';
    let softWrapJoins = 0;
    let hardLineBreaks = 0;
    selectedRows.forEach((row, index) => {
        result += row.text;
        if (index >= selectedRows.length - 1) return;
        const nextRow = selectedRows[index + 1];
        const isSoftWrapped = row.fullColumns >= cols && row.endsAtRowEnd && nextRow.startsAtRowStart;
        if (isSoftWrapped) softWrapJoins += 1;
        else {
            hardLineBreaks += 1;
            result += '\n';
        }
    });

    const normalized = normalizeCopiedTerminalText(result);
    if (!normalized.trim()) return normalizeCopiedTerminalText(fallbackText);
    console.debug('[TerminalCopy]', 'selection reconstructed from wterm bridge with row slicing', {
        rows: selectedRows.length,
        cols,
        softWrapJoins,
        hardLineBreaks,
        partialRows: selectedRows.filter((row) => row.partial).length,
        fallbackLength: fallbackText.length,
        rawLength: result.length,
        normalizedLength: normalized.length,
        rawNewlines: (result.match(/\n/g) || []).length,
        normalizedNewlines: (normalized.match(/\n/g) || []).length,
        sources: [...new Set(selectedRows.map((row) => row.source))],
    });
    return normalized;
}

function getCopyableSelectionText() {
    const selection = window.getSelection();
    const terminalText = getTerminalSelectionTextFromDom(selection);
    const liveText = terminalText || normalizeCopiedTerminalText(getSelectionTextFromRanges(selection) || selection?.toString?.() || '');
    if (liveText) {
        cachedSelectionText = liveText;
        return liveText;
    }
    return cachedSelectionText;
}

document.addEventListener('selectionchange', () => {
    const selection = window.getSelection();
    if (!selection) return;
    logTerminalCopyDiagnostics('selectionchange', {
        collapsed: selection.isCollapsed,
        textLength: selection.toString?.().length || 0,
    });
    if (selection.isCollapsed) {
        if (mobileTerminalSelectionMode) scheduleExitMobileTerminalSelectionMode(900);
        return;
    }
    const text = normalizeCopiedTerminalText(getSelectionTextFromRanges(selection) || selection.toString());
    if (text) {
        cachedSelectionText = text;
        enterMobileTerminalSelectionMode('selectionchange');
    }
}, { passive: true });

// ---------- Ctrl+C 智能判断 ----------
document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'c') {
        const selection = window.getSelection();
        const text = selection.toString();
        if (text) return;
        e.preventDefault();
        sendData('\x03', { source: 'keyboard-shortcut', forceFollow: false });
    }
});

// ---------- 通用提示 ----------
function showToast(message, type = 'info', timeout = 2800) {
    let container = document.querySelector('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    window.setTimeout(() => {
        toast.classList.remove('show');
        window.setTimeout(() => toast.remove(), 220);
    }, timeout);
}

function sendJsonMessage(payload) {
    if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN || !isConnected) {
        showToast('SSH 尚未连接', 'error');
        return false;
    }
    wsConnection.send(JSON.stringify(payload));
    return true;
}

function animatePanelFromButton(panel, button, opening = true) {
    if (!panel || !button) return;
    const panelRect = panel.getBoundingClientRect?.();
    const buttonRect = button.getBoundingClientRect?.();
    if (!panelRect || !buttonRect || panelRect.width <= 1 || panelRect.height <= 1) return;
    const originX = ((buttonRect.left + buttonRect.width / 2 - panelRect.left) / panelRect.width) * 100;
    const originY = ((buttonRect.top + buttonRect.height / 2 - panelRect.top) / panelRect.height) * 100;
    panel.style.setProperty('--panel-origin-x', `${Math.max(8, Math.min(92, originX))}%`);
    panel.style.setProperty('--panel-origin-y', `${Math.max(8, Math.min(92, originY))}%`);
    panel.classList.remove('panel-opening', 'panel-closing');
    void panel.offsetWidth;
    panel.classList.add(opening ? 'panel-opening' : 'panel-closing');
}
function clearPanelMotion(panel) {
    if (!panel) return;
    panel.classList.remove('panel-opening', 'panel-closing');
}

// ---------- 文件管理器 ----------
function showFileManager() {
    ensureFloatingPanel(fileManager, getDefaultPanelOptions(fileManager));
    fileManager.classList.add('open');
    fileBtn.classList.add('active');
    bringPanelToFront(fileManager);
    requestAnimationFrame(() => animatePanelFromButton(fileManager, fileBtn, true));
    if (!sftpReady) {
        initSFTP();
    } else {
        refreshFileList();
    }
}
function hideFileManager() {
    if (typeof closePanelLayoutMenu === 'function') closePanelLayoutMenu({ instant: true });
    animatePanelFromButton(fileManager, fileBtn, false);
    fileManager.classList.remove('open');
    fileBtn.classList.remove('active');
    window.setTimeout(() => clearPanelMotion(fileManager), 320);
}
fileBtn.addEventListener('click', () => {
    if (fileManager.classList.contains('open')) hideFileManager();
    else showFileManager();
});
fmCloseBtn.addEventListener('click', hideFileManager);

const SNIPPET_STORAGE_KEY = 'zephyr-ssh-snippets';
function loadTerminalSnippets() {
    if (Array.isArray(params?.snippets)) return params.snippets.filter((item) => item && item.command);
    try {
        const data = JSON.parse(localStorage.getItem(SNIPPET_STORAGE_KEY) || '[]');
        return Array.isArray(data) ? data.filter((item) => item && item.command) : [];
    } catch { return []; }
}
function renderSnippetPanel() {
    if (!snippetList) return;
    const query = String(snippetSearch?.value || '').trim().toLowerCase();
    const snippets = loadTerminalSnippets().filter((item) => !query
        || String(item.name || '').toLowerCase().includes(query)
        || String(item.group || '').toLowerCase().includes(query)
        || String(item.command || '').toLowerCase().includes(query));
    snippetList.innerHTML = '';
    snippets.forEach((item) => {
        const btn = document.createElement('button');
        btn.className = 'snippet-item';
        btn.type = 'button';
        btn.innerHTML = `<strong>${escapeHtml(item.name || '未命名片段')}</strong><em>${escapeHtml(item.group || '未分组')} · ${item.autoRun ? '直接执行' : '填入输入框'}</em><code>${escapeHtml(item.command || '')}</code>`;
        btn.addEventListener('click', () => {
            const command = String(item.command || '');
            if (item.autoRun) sendData(command.endsWith('\n') || command.endsWith('\r') ? command : command + '\r', { normalizeNewlines: true, source: 'snippet-run', forceFollow: true });
            else {
                cmdInput.value = command;
                resizeCommandInput();
                cmdInput.focus();
            }
        });
        snippetList.appendChild(btn);
    });
    if (snippetEmpty) snippetEmpty.style.display = snippets.length ? 'none' : 'block';
}
function showSnippetPanel() {
    ensureFloatingPanel(snippetPanel, getDefaultPanelOptions(snippetPanel));
    snippetPanel.style.display = 'flex';
    renderSnippetPanel();
    requestAnimationFrame(() => {
        snippetPanel.classList.add('open');
        snippetBtn?.classList.add('active');
        bringPanelToFront(snippetPanel);
        animatePanelFromButton(snippetPanel, snippetBtn, true);
    });
}
function hideSnippetPanel() {
    if (typeof closePanelLayoutMenu === 'function') closePanelLayoutMenu({ instant: true });
    animatePanelFromButton(snippetPanel, snippetBtn, false);
    snippetPanel.classList.remove('open');
    snippetBtn?.classList.remove('active');
    window.setTimeout(() => { clearPanelMotion(snippetPanel); if (!snippetPanel.classList.contains('open')) snippetPanel.style.display = 'none'; }, 320);
}
function showShortcutPanel() {
    ensureFloatingPanel(shortcutPanel, getDefaultPanelOptions(shortcutPanel));
    shortcutPanel.style.display = 'flex';
    requestAnimationFrame(() => {
        shortcutPanel.classList.add('open');
        shortcutBtn?.classList.add('active');
        bringPanelToFront(shortcutPanel);
        animatePanelFromButton(shortcutPanel, shortcutBtn, true);
    });
}
function hideShortcutPanel() {
    if (typeof closePanelLayoutMenu === 'function') closePanelLayoutMenu({ instant: true });
    animatePanelFromButton(shortcutPanel, shortcutBtn, false);
    shortcutPanel.classList.remove('open');
    shortcutBtn?.classList.remove('active');
    window.setTimeout(() => { clearPanelMotion(shortcutPanel); if (!shortcutPanel.classList.contains('open')) shortcutPanel.style.display = 'none'; }, 320);
}
snippetBtn?.addEventListener('click', () => snippetPanel.classList.contains('open') ? hideSnippetPanel() : showSnippetPanel());
snippetSearch?.addEventListener('input', renderSnippetPanel);
shortcutBtn?.addEventListener('click', () => shortcutPanel.classList.contains('open') ? hideShortcutPanel() : showShortcutPanel());
window.addEventListener('storage', (event) => { if (event.key === SNIPPET_STORAGE_KEY && snippetPanel?.classList.contains('open')) renderSnippetPanel(); });

function initSFTP() {
    if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN) return;
    wsConnection.send(JSON.stringify({ type: 'sftp-init' }));
}
function refreshFileList() {
    if (!sftpReady) return;
    wsConnection.send(JSON.stringify({ type: 'sftp-list', path: currentPath }));
    fmPathInput.value = currentPath;
}
fmRefreshBtn.addEventListener('click', refreshFileList);

function navigateTo(path) {
    currentPath = path;
    searchQuery = '';
    fmSearchInput.value = '';
    refreshFileList();
}
fmGoBtn.addEventListener('click', () => {
    const p = fmPathInput.value.trim();
    if (p) navigateTo(p);
});
fmPathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        const p = fmPathInput.value.trim();
        if (p) navigateTo(p);
    }
});
fmBackBtn.addEventListener('click', () => {
    const parts = currentPath.replace(/\/+$/, '').split('/');
    parts.pop();
    navigateTo(parts.join('/') || '/');
});
fmSearchInput.addEventListener('input', () => {
    searchQuery = fmSearchInput.value.trim();
    renderFileList(allFiles);
});

function sortFiles(files) {
    return [...files].sort((a, b) => {
        if (a.type === b.type) return a.name.localeCompare(b.name);
        return a.type === 'd' ? -1 : 1;
    });
}
function filterFiles(files, query) {
    if (!query) return files;
    return files.filter(f => f.name.toLowerCase().includes(query.toLowerCase()));
}

fmList.addEventListener('click', (e) => {
    if (e.target.closest('.fm-item-actions')) return;
    const item = e.target.closest('.fm-item');
    if (!item) return;
    const fileName = item.dataset.fileName;
    const fileType = item.dataset.fileType;
    if (!fileName) return;
    const fullPath = currentPath.replace(/\/+$/, '') + '/' + fileName;
    if (fileType === 'd') navigateTo(fullPath);
    else openEditor(fullPath);
});

function renderFileList(files) {
    allFiles = sortFiles(files);
    const filtered = filterFiles(allFiles, searchQuery);
    fmList.innerHTML = '';
    filtered.forEach(file => {
        const item = document.createElement('div');
        item.className = 'fm-item';
        item.dataset.fileName = file.name;
        item.dataset.fileType = file.type;
        const icon = file.type === 'd' ? '📁' : '📄';
        const nameSpan = document.createElement('span');
        nameSpan.textContent = `${icon} ${file.name}`;
        const actions = document.createElement('div');
        actions.className = 'fm-item-actions';

        const renameBtn = document.createElement('button');
        renameBtn.textContent = '✏️';
        renameBtn.title = '重命名';
        renameBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const newName = prompt('新名称:', file.name);
            if (!newName) return;
            const oldPath = currentPath.replace(/\/+$/, '') + '/' + file.name;
            const newPath = currentPath.replace(/\/+$/, '') + '/' + newName;
            wsConnection.send(JSON.stringify({ type: 'sftp-rename', oldPath, newPath }));
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.textContent = '🗑️';
        deleteBtn.title = '删除';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm(`确认删除 ${file.name}?`)) {
                wsConnection.send(JSON.stringify({
                    type: 'sftp-delete',
                    path: currentPath.replace(/\/+$/, '') + '/' + file.name
                }));
            }
        });

        if (file.type !== 'd') {
            const downloadBtn = document.createElement('button');
            downloadBtn.textContent = '⬇️';
            downloadBtn.title = '下载';
            downloadBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                wsConnection.send(JSON.stringify({
                    type: 'sftp-download',
                    path: currentPath.replace(/\/+$/, '') + '/' + file.name
                }));
            });
            actions.appendChild(downloadBtn);
        }

        actions.appendChild(renameBtn);
        actions.appendChild(deleteBtn);
        item.appendChild(nameSpan);
        item.appendChild(actions);
        fmList.appendChild(item);
    });
}

// 新建文件夹
fmNewFolderBtn.addEventListener('click', () => {
    const name = prompt('请输入文件夹名称:');
    if (!name) return;
    wsConnection.send(JSON.stringify({ type: 'sftp-mkdir', path: currentPath.replace(/\/+$/, '') + '/' + name }));
});
// 新建文件
fmNewFileBtn.addEventListener('click', () => {
    const name = prompt('请输入文件名:');
    if (!name) return;
    wsConnection.send(JSON.stringify({ type: 'sftp-touch', path: currentPath.replace(/\/+$/, '') + '/' + name }));
});
// 上传文件：分片发送，避免拖拽大文件时单条 WebSocket 消息过大导致连接断开。
function sendSftpUploadChunk(upload, offset = 0) {
    if (!upload || upload.cancelled) return;
    if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN || !isConnected) {
        showToast(`上传中断：SSH 连接不可用（${upload.file.name}）`, 'error');
        activeSftpUploads.delete(upload.id);
        return;
    }
    if (offset >= upload.file.size) {
        wsConnection.send(JSON.stringify({ type: 'sftp-upload-complete', uploadId: upload.id, path: upload.path }));
        return;
    }
    const chunk = upload.file.slice(offset, Math.min(offset + SFTP_UPLOAD_CHUNK_SIZE, upload.file.size));
    const reader = new FileReader();
    reader.onload = (ev) => {
        const base64 = String(ev.target.result || '').split(',')[1] || '';
        wsConnection.send(JSON.stringify({
            type: 'sftp-upload-chunk',
            uploadId: upload.id,
            path: upload.path,
            name: upload.file.name,
            offset,
            size: upload.file.size,
            data: base64,
        }));
    };
    reader.onerror = () => {
        showToast(`读取文件失败：${upload.file.name}`, 'error');
        activeSftpUploads.delete(upload.id);
    };
    reader.readAsDataURL(chunk);
}

function uploadFile(file) {
    if (!file || !sftpReady || !wsConnection || wsConnection.readyState !== WebSocket.OPEN) return;
    const upload = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        path: currentPath.replace(/\/+$/, '') + '/' + file.name,
        cancelled: false,
    };
    activeSftpUploads.set(upload.id, upload);
    wsConnection.send(JSON.stringify({ type: 'sftp-upload-start', uploadId: upload.id, path: upload.path, name: file.name, size: file.size }));
}

function uploadFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (!sftpReady) {
        pendingUploadFiles.push(...files);
        showToast('SFTP 正在初始化，文件将在就绪后自动上传', 'info');
        showFileManager();
        initSFTP();
        return;
    }
    showToast(`开始上传 ${files.length} 个文件到 ${currentPath}`, 'info');
    files.forEach(uploadFile);
}

function flushPendingUploads() {
    if (!pendingUploadFiles.length || !sftpReady) return;
    const files = pendingUploadFiles.splice(0);
    uploadFiles(files);
}

function hasDraggedFiles(e) {
    return Array.from(e.dataTransfer?.types || []).includes('Files');
}

function setFileDragActive(active) {
    fileManager.classList.toggle('drag-over', active);
}

fmUploadInput.addEventListener('change', (e) => {
    uploadFiles(e.target.files);
    fmUploadInput.value = '';
});

document.addEventListener('dragenter', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    fileDragDepth += 1;
    if (!fileManager.classList.contains('open')) showFileManager();
    setFileDragActive(true);
}, { passive: false });

document.addEventListener('dragover', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!fileManager.classList.contains('open')) showFileManager();
    setFileDragActive(true);
}, { passive: false });

document.addEventListener('dragleave', (e) => {
    if (!hasDraggedFiles(e)) return;
    fileDragDepth = Math.max(0, fileDragDepth - 1);
    if (fileDragDepth === 0 || !e.relatedTarget) setFileDragActive(false);
}, { passive: true });

document.addEventListener('drop', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    fileDragDepth = 0;
    setFileDragActive(false);
    if (!fileManager.classList.contains('open')) showFileManager();
    uploadFiles(e.dataTransfer?.files);
}, { passive: false });

// 直接在文件管理器上处理拖拽
fmDropOverlay.addEventListener('dragenter', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
}, { passive: false });

fmDropOverlay.addEventListener('dragover', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
}, { passive: false });

fmDropOverlay.addEventListener('drop', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    fileDragDepth = 0;
    setFileDragActive(false);
    uploadFiles(e.dataTransfer?.files);
}, { passive: false });

fmList.addEventListener('dragenter', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    fileDragDepth += 1;
    setFileDragActive(true);
}, { passive: false });

fmList.addEventListener('dragover', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    setFileDragActive(true);
}, { passive: false });

fmList.addEventListener('dragleave', (e) => {
    if (!hasDraggedFiles(e)) return;
    fileDragDepth = Math.max(0, fileDragDepth - 1);
    if (fileDragDepth === 0) setFileDragActive(false);
}, { passive: true });

fmList.addEventListener('drop', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    fileDragDepth = 0;
    setFileDragActive(false);
    uploadFiles(e.dataTransfer?.files);
}, { passive: false });
// 编辑器
function base64ToBytes(base64) {
    const binary = atob(base64 || '');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function bytesToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

function decodeBytes(bytes, encoding) {
    if (!bytes) return '';
    if (encoding === 'utf-16be') {
        const swapped = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i += 2) {
            swapped[i] = bytes[i + 1] || 0;
            swapped[i + 1] = bytes[i] || 0;
        }
        return new TextDecoder('utf-16le').decode(swapped);
    }
    const decoderEncoding = encoding === 'latin1' ? 'iso-8859-1' : encoding;
    return new TextDecoder(decoderEncoding).decode(bytes);
}

function encodeText(text, encoding) {
    if (encoding === 'utf-16le' || encoding === 'utf-16be') {
        const bytes = new Uint8Array(text.length * 2);
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            const offset = i * 2;
            if (encoding === 'utf-16le') {
                bytes[offset] = code & 0xff;
                bytes[offset + 1] = code >> 8;
            } else {
                bytes[offset] = code >> 8;
                bytes[offset + 1] = code & 0xff;
            }
        }
        return bytes;
    }
    if (encoding === 'latin1') {
        const bytes = new Uint8Array(text.length);
        for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
        return bytes;
    }
    return new TextEncoder().encode(text);
}

function detectEncoding(bytes) {
    if (!bytes || bytes.length < 2) return 'utf-8';
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
    return 'utf-8';
}

function detectLineEnding(text) {
    return /\r\n/.test(text) ? 'crlf' : 'lf';
}

function normalizeLineEnding(text, lineEnding) {
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return lineEnding === 'crlf' ? normalized.replace(/\n/g, '\r\n') : normalized;
}

function updateEditorStatus() {
    const text = fmEditorTextarea.value || '';
    const lines = text.length ? text.split(/\r\n|\r|\n/).length : 1;
    const langLabel = getEditorLanguageLabel(editorLanguage);
    fmEditorStatus.textContent = `${lines} 行 · ${text.length} 字符 · ${editorRawBytes?.length || 0} bytes · ${langLabel}`;
    renderEditorCodeLayers();
}

const EDITOR_LANGUAGE_BY_EXT = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', json: 'json', jsonc: 'javascript',
    html: 'html', htm: 'html', xml: 'html', vue: 'html', svelte: 'html',
    css: 'css', scss: 'css', sass: 'css', less: 'css',
    py: 'python', rb: 'ruby', php: 'php',
    sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', ksh: 'shell',
    yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini', env: 'shell',
    md: 'markdown', markdown: 'markdown',
    go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
    cs: 'csharp', swift: 'swift', sql: 'sql', lua: 'lua',
};

const EDITOR_LANGUAGE_BY_NAME = {
    dockerfile: 'dockerfile', containerfile: 'dockerfile', makefile: 'makefile',
    'compose.yml': 'yaml', 'compose.yaml': 'yaml',
};

const EDITOR_LANGUAGE_LABELS = {
    plain: 'Plain Text', javascript: 'JavaScript', typescript: 'TypeScript', json: 'JSON',
    html: 'HTML/XML', css: 'CSS', python: 'Python', shell: 'Shell', yaml: 'YAML',
    markdown: 'Markdown', go: 'Go', rust: 'Rust', java: 'Java', c: 'C', cpp: 'C++',
    csharp: 'C#', php: 'PHP', ruby: 'Ruby', sql: 'SQL', lua: 'Lua', dockerfile: 'Dockerfile',
    makefile: 'Makefile', toml: 'TOML', ini: 'INI', kotlin: 'Kotlin', swift: 'Swift',
};

const EDITOR_KEYWORDS = {
    javascript: new Set('as async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield null true false undefined'.split(' ')),
    typescript: new Set('abstract any as async await boolean break case catch class const constructor continue debugger declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let module namespace never new null number object of private protected public readonly return set static string super switch symbol this throw true try type typeof undefined unknown var void while with yield'.split(' ')),
    json: new Set('true false null'.split(' ')),
    python: new Set('and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self'.split(' ')),
    shell: new Set('alias bg bind break builtin case cd command continue do done echo elif else esac eval exec exit export false fg fi for function getopts hash if in jobs kill let local logout popd printf pushd pwd read readonly return select set shift source test then time trap true type typeset ulimit umask unalias unset until wait while sudo'.split(' ')),
    yaml: new Set('true false null yes no on off'.split(' ')),
    css: new Set('important import media supports keyframes from to and or not only screen print all root'.split(' ')),
    go: new Set('break default func interface select case defer go map struct chan else goto package switch const fallthrough if range type continue for import return var nil true false iota'.split(' ')),
    rust: new Set('as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'.split(' ')),
    java: new Set('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new null package private protected public return short static strictfp super switch synchronized this throw throws transient true try void volatile while'.split(' ')),
    c: new Set('auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while null NULL'.split(' ')),
    cpp: new Set('alignas alignof and asm auto bitand bitor bool break case catch char char16_t char32_t class compl const constexpr const_cast continue decltype default delete do double dynamic_cast else enum explicit export extern false final float for friend goto if inline int long mutable namespace new noexcept not nullptr operator or override private protected public register reinterpret_cast return short signed sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while xor'.split(' ')),
    php: new Set('abstract and array as break callable case catch class clone const continue declare default die do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile eval exit extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list namespace new null or print private protected public require require_once return static switch throw trait try unset use var while xor yield true false'.split(' ')),
    ruby: new Set('BEGIN END alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield'.split(' ')),
    sql: new Set('add all alter and as asc by case check column constraint create database default delete desc distinct drop else exists foreign from group having in index inner insert into is join key left like limit not null on or order outer primary references right select set table then union unique update values view where true false'.split(' ')),
    lua: new Set('and break do else elseif end false for function goto if in local nil not or repeat return then true until while'.split(' ')),
    dockerfile: new Set('FROM RUN CMD LABEL MAINTAINER EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL AS'.split(' ')),
    makefile: new Set('include define endef ifeq ifneq ifdef ifndef else endif export unexport override private vpath'.split(' ')),
    markdown: new Set(), toml: new Set('true false'.split(' ')), ini: new Set('true false yes no on off'.split(' ')),
};

function detectEditorLanguage(filePath = '') {
    const fileName = (filePath.split('/').pop() || '').toLowerCase();
    if (EDITOR_LANGUAGE_BY_NAME[fileName]) return EDITOR_LANGUAGE_BY_NAME[fileName];
    const ext = fileName.includes('.') ? fileName.split('.').pop() : '';
    return EDITOR_LANGUAGE_BY_EXT[ext] || 'plain';
}

function getEditorLanguageLabel(language) {
    return EDITOR_LANGUAGE_LABELS[language] || EDITOR_LANGUAGE_LABELS.plain;
}

function escapeHtml(text = '') {
    return String(text).replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

function tok(type, text) {
    if (!text) return '';
    return `<span class="tok-${type}">${escapeHtml(text)}</span>`;
}

function getLineComment(language) {
    if (['python', 'shell', 'yaml', 'ruby', 'toml', 'ini', 'dockerfile', 'makefile'].includes(language)) return '#';
    if (['sql', 'lua'].includes(language)) return '--';
    if (language === 'plain' || language === 'json') return '';
    return '//';
}

function getBlockComment(language) {
    if (['javascript', 'typescript', 'css', 'go', 'rust', 'java', 'c', 'cpp', 'csharp', 'php', 'swift', 'kotlin'].includes(language)) {
        return ['/*', '*/'];
    }
    return null;
}

function readQuoted(line, start, quote, language, state) {
    const triple = (language === 'python' || language === 'ruby') && (quote === '"' || quote === "'") && line.startsWith(quote.repeat(3), start);
    const delimiter = triple ? quote.repeat(3) : quote;
    let i = start + delimiter.length;
    while (i < line.length) {
        if (!triple && line[i] === '\\') {
            i += 2;
            continue;
        }
        if (line.startsWith(delimiter, i)) {
            i += delimiter.length;
            return { end: i, closed: true, delimiter };
        }
        i++;
    }
    const canContinue = triple || quote === '`' || (!triple && line.endsWith('\\'));
    if (canContinue) state.stringQuote = delimiter;
    return { end: line.length, closed: false, delimiter };
}

function finishOpenString(line, state) {
    const delimiter = state.stringQuote;
    let i = 0;
    while (i < line.length) {
        if (delimiter.length === 1 && line[i] === '\\') {
            i += 2;
            continue;
        }
        if (line.startsWith(delimiter, i)) {
            i += delimiter.length;
            state.stringQuote = '';
            return { html: tok('string', line.slice(0, i)), index: i };
        }
        i++;
    }
    return { html: tok('string', line), index: line.length };
}

function classifyIdentifier(identifier, line, start, end, language) {
    const keywords = EDITOR_KEYWORDS[language] || EDITOR_KEYWORDS.plain;
    const upper = identifier.toUpperCase();
    const normalized = language === 'dockerfile' ? upper : identifier;
    const after = line.slice(end).trimStart();
    const before = line.slice(0, start).trimEnd();

    if (keywords?.has(normalized) || keywords?.has(identifier)) return tok('keyword', identifier);
    if (/^(true|false|null|nil|None|True|False|undefined|NaN|Infinity)$/i.test(identifier)) return tok('literal', identifier);
    if ((language === 'json' || language === 'yaml' || language === 'toml' || language === 'ini') && after.startsWith(':')) return tok('attr', identifier);
    if (language === 'css' && (after.startsWith(':') || identifier.startsWith('--'))) return tok(identifier.startsWith('--') ? 'variable' : 'attr', identifier);
    if (after.startsWith('(') && !before.endsWith('.')) return tok('function', identifier);
    if (before.endsWith('.') || before.endsWith('::')) return tok('property', identifier);
    if (/^[A-Z][A-Za-z0-9_$]*$/.test(identifier)) return tok('type', identifier);
    return escapeHtml(identifier);
}

function highlightHtmlTag(rawTag) {
    const match = rawTag.match(/^(<\/?)([^\s>/]+)([\s\S]*?)(\/?>)$/);
    if (!match) return tok('tag', rawTag);
    const [, open, name, attrs, close] = match;
    let html = `${tok('punctuation', open)}${tok('tag', name)}`;
    const attrRegex = /([:@A-Za-z_][\w:.-]*)(\s*=\s*)?("[^"]*"|'[^']*'|[^\s"'=<>`]+)?/g;
    let lastIndex = 0;
    let attrMatch;
    while ((attrMatch = attrRegex.exec(attrs))) {
        html += escapeHtml(attrs.slice(lastIndex, attrMatch.index));
        html += tok('attr', attrMatch[1]);
        if (attrMatch[2]) html += tok('operator', attrMatch[2]);
        if (attrMatch[3]) html += tok('string', attrMatch[3]);
        lastIndex = attrRegex.lastIndex;
    }
    html += escapeHtml(attrs.slice(lastIndex));
    html += tok('punctuation', close);
    return html;
}

function highlightHtmlLine(line, state) {
    let html = '';
    let i = 0;
    while (i < line.length) {
        if (state.htmlComment) {
            const end = line.indexOf('-->', i);
            if (end === -1) return html + tok('comment', line.slice(i));
            html += tok('comment', line.slice(i, end + 3));
            state.htmlComment = false;
            i = end + 3;
            continue;
        }
        if (line.startsWith('<!--', i)) {
            const end = line.indexOf('-->', i + 4);
            if (end === -1) {
                state.htmlComment = true;
                return html + tok('comment', line.slice(i));
            }
            html += tok('comment', line.slice(i, end + 3));
            i = end + 3;
            continue;
        }
        if (line[i] === '<') {
            const end = line.indexOf('>', i + 1);
            if (end !== -1) {
                html += highlightHtmlTag(line.slice(i, end + 1));
                i = end + 1;
                continue;
            }
        }
        if (line[i] === '&') {
            const entity = line.slice(i).match(/^&[A-Za-z0-9#]+;/)?.[0];
            if (entity) {
                html += tok('literal', entity);
                i += entity.length;
                continue;
            }
        }
        html += escapeHtml(line[i]);
        i++;
    }
    return html;
}

function highlightMarkdownLine(line) {
    if (/^\s{0,3}#{1,6}\s/.test(line)) return tok('keyword', line);
    if (/^\s{0,3}([-*+]\s|\d+\.\s)/.test(line)) return line.replace(/^([\s\d.*+-]+)/, (m) => tok('operator', m));
    return highlightGenericLine(line, 'plain', {});
}

function highlightGenericLine(line, language, state) {
    if (language === 'html') return highlightHtmlLine(line, state);
    if (language === 'markdown') return highlightMarkdownLine(line);

    let html = '';
    let i = 0;
    const lineComment = getLineComment(language);
    const blockComment = getBlockComment(language);

    while (i < line.length) {
        if (state.stringQuote) {
            const open = finishOpenString(line.slice(i), state);
            html += open.html;
            i += open.index;
            continue;
        }

        if (state.blockComment) {
            const end = line.indexOf(state.blockComment, i);
            if (end === -1) return html + tok('comment', line.slice(i));
            html += tok('comment', line.slice(i, end + state.blockComment.length));
            i = end + state.blockComment.length;
            state.blockComment = '';
            continue;
        }

        if (blockComment && line.startsWith(blockComment[0], i)) {
            const end = line.indexOf(blockComment[1], i + blockComment[0].length);
            if (end === -1) {
                state.blockComment = blockComment[1];
                return html + tok('comment', line.slice(i));
            }
            html += tok('comment', line.slice(i, end + blockComment[1].length));
            i = end + blockComment[1].length;
            continue;
        }

        if (lineComment && line.startsWith(lineComment, i)) {
            html += tok('comment', line.slice(i));
            break;
        }

        const rest = line.slice(i);
        if (language === 'markdown' && /^\s{0,3}>/.test(rest)) {
            html += tok('comment', rest);
            break;
        }

        const ch = line[i];
        if (ch === '"' || ch === "'" || ch === '`') {
            const quoted = readQuoted(line, i, ch, language, state);
            html += tok('string', line.slice(i, quoted.end));
            i = quoted.end;
            continue;
        }

        const atRule = rest.match(/^@[A-Za-z_-][\w-]*/)?.[0];
        if (atRule && (language === 'css' || language === 'java' || language === 'typescript')) {
            html += tok('keyword', atRule);
            i += atRule.length;
            continue;
        }

        const number = rest.match(/^(0x[\da-fA-F]+|0b[01]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
        if (number && !/[\w$]/.test(line[i - 1] || '')) {
            html += tok('number', number);
            i += number.length;
            continue;
        }

        const identifier = rest.match(/^[A-Za-z_$-][\w$-]*/)?.[0];
        if (identifier && !identifier.startsWith('-')) {
            html += classifyIdentifier(identifier, line, i, i + identifier.length, language);
            i += identifier.length;
            continue;
        }

        const operator = rest.match(/^(===|!==|=>|->|::|&&|\|\||\+\+|--|==|!=|<=|>=|[-+*/%=&|^!~?:]+)/)?.[0];
        if (operator) {
            html += tok('operator', operator);
            i += operator.length;
            continue;
        }

        if (/^[{}()[\],.;]$/.test(ch)) {
            html += tok('punctuation', ch);
            i++;
            continue;
        }

        html += escapeHtml(ch);
        i++;
    }
    return html;
}

function highlightCode(text, language) {
    const normalized = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n');
    const state = { blockComment: '', stringQuote: '', htmlComment: false };
    const highlighted = lines.map(line => highlightGenericLine(line, language, state));
    return highlighted.join('\n') || '&#8203;';
}

function getEditorLines(text = '') {
    return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function getDisplayColumnCount(line = '', tabSize = Number(fmEditorTabSize?.value) || 4) {
    let columns = 0;
    for (const ch of String(line)) {
        if (ch === '\t') {
            columns += tabSize - (columns % tabSize || 0);
        } else if (/[^\x00-\xff]/.test(ch)) {
            columns += 2;
        } else {
            columns += 1;
        }
    }
    return columns;
}

function getEditorWrapColumns() {
    if (!fmEditorTextarea) return 120;
    const computed = getComputedStyle(fmEditorTextarea);
    const fontSize = parseFloat(computed.fontSize) || 13;
    const charWidth = fontSize * 0.62;
    const paddingLeft = parseFloat(computed.paddingLeft) || 0;
    const paddingRight = parseFloat(computed.paddingRight) || 0;
    const codeWidth = Math.max(charWidth, fmEditorTextarea.clientWidth - paddingLeft - paddingRight);
    return Math.max(1, Math.floor(codeWidth / charWidth));
}

function getEditorVisualRows(lines) {
    const wrapEnabled = fmEditorWrap?.checked !== false && fmEditorMain?.classList.contains('wrap-enabled');
    if (!wrapEnabled) return lines.map(() => 1);
    const columns = getEditorWrapColumns();
    const tabSize = Number(fmEditorTabSize?.value) || 4;
    return lines.map((line) => Math.max(1, Math.ceil(Math.max(1, getDisplayColumnCount(line, tabSize)) / columns)));
}

function syncEditorCodeScroll() {
    if (!fmEditorTextarea) return;
    if (fmEditorHighlight) {
        fmEditorHighlight.style.transform = `translate3d(${-fmEditorTextarea.scrollLeft}px, ${-fmEditorTextarea.scrollTop}px, 0)`;
    }
    if (fmEditorIndentGuides) {
        fmEditorIndentGuides.style.transform = `translate3d(${-fmEditorTextarea.scrollLeft}px, ${-fmEditorTextarea.scrollTop}px, 0)`;
    }
    if (fmEditorLineNumbers) {
        fmEditorLineNumbers.style.transform = `translate3d(0, ${-fmEditorTextarea.scrollTop}px, 0)`;
    }
    updateEditorMinimapViewport();
}

function renderEditorCodeLayers() {
    if (!fmEditorTextarea) return;
    const text = fmEditorTextarea.value || '';
    const lines = getEditorLines(text);
    const visualRows = getEditorVisualRows(lines);
    const highlighted = highlightCode(text, editorLanguage);
    if (fmEditorHighlight) fmEditorHighlight.innerHTML = highlighted;
    renderEditorIndentGuides(lines, visualRows);
    renderEditorLineNumbers(lines, visualRows);
    syncEditorMinimapMetrics();
    if (fmEditorMinimapCode && !editorMinimapHidden) fmEditorMinimapCode.innerHTML = renderMinimapCode(lines, editorLanguage, visualRows);
    syncEditorCodeScroll();
}

function ensureEditorLineNumbers() {
    if (!fmEditorMain) return null;
    if (!fmEditorLineNumbers) {
        fmEditorLineNumbers = document.createElement('div');
        fmEditorLineNumbers.id = 'fmEditorLineNumbers';
        fmEditorLineNumbers.className = 'fm-editor-line-numbers';
        fmEditorLineNumbers.setAttribute('aria-hidden', 'true');
        fmEditorMain.insertBefore(fmEditorLineNumbers, fmEditorMain.firstChild);
    }
    return fmEditorLineNumbers;
}

function ensureEditorIndentGuides() {
    if (!fmEditorMain) return null;
    if (!fmEditorIndentGuides) {
        fmEditorIndentGuides = document.createElement('pre');
        fmEditorIndentGuides.id = 'fmEditorIndentGuides';
        fmEditorIndentGuides.className = 'fm-editor-indent-guides';
        fmEditorIndentGuides.setAttribute('aria-hidden', 'true');
        fmEditorMain.insertBefore(fmEditorIndentGuides, fmEditorHighlight || fmEditorTextarea);
    }
    return fmEditorIndentGuides;
}

function getLeadingIndentColumns(line = '', tabSize = Number(fmEditorTabSize?.value) || 4) {
    let columns = 0;
    for (const ch of String(line)) {
        if (ch === ' ') columns += 1;
        else if (ch === '\t') columns += tabSize - (columns % tabSize || 0);
        else break;
    }
    return columns;
}

function getEditorCharWidth() {
    if (!fmEditorTextarea) return 8;
    const computed = getComputedStyle(fmEditorTextarea);
    const fontSize = parseFloat(computed.fontSize) || 13;
    const probe = document.createElement('span');
    probe.textContent = 'mmmmmmmmmm';
    probe.style.position = 'fixed';
    probe.style.left = '-9999px';
    probe.style.top = '-9999px';
    probe.style.visibility = 'hidden';
    probe.style.font = computed.font;
    probe.style.fontFamily = computed.fontFamily;
    probe.style.fontSize = computed.fontSize;
    probe.style.fontWeight = computed.fontWeight;
    probe.style.letterSpacing = computed.letterSpacing;
    document.body.appendChild(probe);
    const width = probe.getBoundingClientRect().width / 10;
    probe.remove();
    return Number.isFinite(width) && width > 0 ? width : fontSize * 0.62;
}

function getEditorIndentGuideColumns(lines, index, tabSize) {
    const line = String(lines[index] ?? '');
    if (line.trim()) return getLeadingIndentColumns(line, tabSize);

    // VSCode 风格：空白行不会简单变成 0，而是继承相邻代码块中较小的缩进层级，
    // 这样块内部空行的参考线保持连续，但块之间不会错误贯穿。
    let previous = 0;
    for (let i = index - 1; i >= 0; i--) {
        if (String(lines[i] ?? '').trim()) {
            previous = getLeadingIndentColumns(lines[i], tabSize);
            break;
        }
    }

    let next = 0;
    for (let i = index + 1; i < lines.length; i++) {
        if (String(lines[i] ?? '').trim()) {
            next = getLeadingIndentColumns(lines[i], tabSize);
            break;
        }
    }

    if (previous && next) return Math.min(previous, next);
    return previous || next || 0;
}

function renderEditorIndentGuides(lines = getEditorLines(fmEditorTextarea?.value || ''), visualRows = getEditorVisualRows(lines)) {
    const layer = ensureEditorIndentGuides();
    if (!layer || !fmEditorTextarea) return;
    const tabSize = Number(fmEditorTabSize?.value) || 4;
    const lineHeight = parseFloat(getComputedStyle(fmEditorTextarea).lineHeight) || 20.15;
    const charWidth = getEditorCharWidth();
    const step = Math.max(1, tabSize * charWidth);
    const guideColumns = lines.map((_, index) => getEditorIndentGuideColumns(lines, index, tabSize));
    const signature = `${lines.length}:${tabSize}:${step.toFixed(2)}:${visualRows.join(',')}:${guideColumns.join(',')}`;
    if (layer._signature === signature) return;
    layer._signature = signature;
    layer.style.setProperty('--editor-indent-step', `${step}px`);
    layer.innerHTML = lines.map((line, index) => {
        const columns = guideColumns[index];
        const levels = Math.floor(columns / tabSize);
        const rowHeight = Math.max(1, visualRows[index] || 1) * lineHeight;
        const guideWidth = Math.max(0, levels * step);
        return `<span class="fm-indent-guide-line" style="--editor-indent-line-height:${rowHeight}px;--editor-indent-guide-width:${guideWidth}px"></span>`;
    }).join('');

    console.debug('[EditorIndentGuides]', {
        lines: lines.length,
        tabSize,
        charWidth: Number(charWidth.toFixed(3)),
        step: Number(step.toFixed(3)),
        sampleGuideColumns: guideColumns.slice(0, 20),
    });
}

function renderEditorLineNumbers(lines = getEditorLines(fmEditorTextarea?.value || ''), visualRows = getEditorVisualRows(lines)) {
    const gutter = ensureEditorLineNumbers();
    if (!gutter) return;
    const lineCount = Math.max(1, lines.length);
    const digits = String(lineCount).length;
    const gutterWidth = Math.max(48, 22 + digits * 8);
    fmEditorMain?.style.setProperty('--editor-gutter-width', `${gutterWidth}px`);
    const lineHeight = parseFloat(getComputedStyle(fmEditorTextarea).lineHeight) || 20.15;
    const signature = `${lineCount}:${gutterWidth}:${visualRows.join(',')}`;
    if (gutter._signature === signature) return;
    gutter._signature = signature;
    gutter.innerHTML = Array.from({ length: lineCount }, (_, i) => {
        const rowHeight = Math.max(1, visualRows[i] || 1) * lineHeight;
        return `<span style="--editor-line-number-height:${rowHeight}px">${i + 1}</span>`;
    }).join('');
}

function syncEditorMinimapMetrics() {
    if (!fmEditorTextarea || !fmEditorMinimap) return;
    const computed = getComputedStyle(fmEditorTextarea);
    const fontSize = parseFloat(computed.fontSize) || 13;
    const lineHeight = parseFloat(computed.lineHeight) || fontSize * 1.55;
    const paddingTop = parseFloat(computed.paddingTop) || 0;
    const paddingLeft = parseFloat(computed.paddingLeft) || 0;
    const scale = Number(getComputedStyle(fmEditorMinimap).getPropertyValue('--minimap-scale')) || 0.22;
    fmEditorMinimap.style.setProperty('--minimap-font-size', `${Math.max(3, fontSize * scale)}px`);
    fmEditorMinimap.style.setProperty('--minimap-line-height', `${Math.max(4, lineHeight * scale)}px`);
    fmEditorMinimap.style.setProperty('--minimap-padding-top', `${Math.max(0, paddingTop * scale)}px`);
    fmEditorMinimap.style.setProperty('--minimap-padding-left', `${Math.max(0, paddingLeft * scale)}px`);
}

function renderMinimapCode(textOrLines = '', language = 'plain', visualRows = null) {
    const lines = Array.isArray(textOrLines) ? textOrLines : getEditorLines(textOrLines);
    const rows = visualRows || getEditorVisualRows(lines);
    return lines.map((line, index) => {
        const trimmed = line.trim();
        const commentPrefix = getLineComment(language);
        const type = commentPrefix && trimmed.startsWith(commentPrefix)
            ? 'comment'
            : (/^<\/?[A-Za-z]/.test(trimmed) ? 'tag'
                : (/^(const|let|var|function|class|if|else|for|while|return|import|export|def|class|from|async|await|public|private|protected|static)\b/.test(trimmed) ? 'keyword'
                    : (/(['"`]).*\1/.test(trimmed) ? 'string'
                        : (/\b\d+(\.\d+)?\b/.test(trimmed) ? 'number' : 'text'))));
        const preview = escapeHtml(line.slice(0, 120)) || '&nbsp;';
        const lineRows = Math.max(1, rows[index] || 1);
        return `<span class="fm-minimap-line" style="height:calc(var(--minimap-line-height) * ${lineRows})"><span class="fm-minimap-seg ${type}">${preview}</span></span>`;
    }).join('');
}

function updateEditorMinimap() {
    if (!fmEditorMinimap) return;
    fmEditorModal.classList.toggle('minimap-hidden', editorMinimapHidden);
    fmEditorMinimapToggle?.classList.toggle('active', !editorMinimapHidden);
    renderEditorCodeLayers();
}

function updateEditorMinimapViewport() {
    if (!fmEditorMinimap || !fmEditorTextarea) return;
    if (editorMinimapHidden) return;
    const maxScroll = Math.max(1, fmEditorTextarea.scrollHeight - fmEditorTextarea.clientHeight);
    const ratio = fmEditorTextarea.scrollTop / maxScroll;
    const viewportRatio = Math.min(1, fmEditorTextarea.clientHeight / Math.max(fmEditorTextarea.scrollHeight, 1));
    const heightPercent = Math.max(10, viewportRatio * 100);
    fmEditorMinimap.style.setProperty('--minimap-view-top', `${ratio * (100 - heightPercent)}%`);
    fmEditorMinimap.style.setProperty('--minimap-view-height', `${heightPercent}%`);
    if (fmEditorMinimapCode) {
        const overflow = Math.max(0, fmEditorMinimapCode.scrollHeight - fmEditorMinimap.clientHeight);
        fmEditorMinimap.style.setProperty('--minimap-code-top', `${-(ratio * overflow)}px`);
    }
}

function setEditorScrollFromMinimap(clientY) {
    if (!fmEditorMinimap || editorMinimapHidden) return;
    const rect = fmEditorMinimap.getBoundingClientRect();
    const maxScroll = Math.max(0, fmEditorTextarea.scrollHeight - fmEditorTextarea.clientHeight);
    const viewportRatio = Math.min(1, fmEditorTextarea.clientHeight / Math.max(fmEditorTextarea.scrollHeight, 1));
    const thumbHeight = Math.max(18, rect.height * viewportRatio);
    const ratio = Math.min(1, Math.max(0, (clientY - rect.top - thumbHeight / 2) / Math.max(1, rect.height - thumbHeight)));
    fmEditorTextarea.scrollTop = ratio * maxScroll;
    syncEditorCodeScroll();
}

function updateEditorFullscreenButton() {
    const isFullscreen = fmEditorModal?.classList.contains('fullscreen');
    if (!fmEditorFullscreenBtn) return;
    fmEditorFullscreenBtn.classList.toggle('active', !!isFullscreen);
    fmEditorFullscreenBtn.setAttribute('aria-pressed', isFullscreen ? 'true' : 'false');
    fmEditorFullscreenBtn.setAttribute('title', isFullscreen ? '退出全屏编辑' : '全屏编辑');
    fmEditorFullscreenBtn.setAttribute('aria-label', isFullscreen ? '退出全屏编辑' : '全屏编辑');
}

function animateEditorFullscreenTransition(firstRect, shouldFullscreen) {
    if (!fmEditorModal || !firstRect || !fmEditorModal.animate) return;
    const lastRect = fmEditorModal.getBoundingClientRect();
    if (!lastRect.width || !lastRect.height) return;
    const dx = firstRect.left - lastRect.left;
    const dy = firstRect.top - lastRect.top;
    const sx = firstRect.width / lastRect.width;
    const sy = firstRect.height / lastRect.height;
    const fromRadius = shouldFullscreen ? 'var(--radius-lg)' : '22px';
    const toRadius = shouldFullscreen ? '22px' : 'var(--radius-lg)';
    fmEditorModal.getAnimations?.().forEach((animation) => {
        if (animation.effect?.target === fmEditorModal) animation.cancel();
    });
    fmEditorModal.style.transformOrigin = 'top left';
    const animation = fmEditorModal.animate([
        {
            transform: `translate3d(${dx}px, ${dy}px, 0) scale(${sx}, ${sy})`,
            borderRadius: fromRadius,
            boxShadow: shouldFullscreen ? '0 18px 54px rgba(0,0,0,0.32)' : '0 30px 100px rgba(0,0,0,0.46)'
        },
        {
            transform: 'translate3d(0, 0, 0) scale(1, 1)',
            borderRadius: toRadius,
            boxShadow: shouldFullscreen ? '0 30px 100px rgba(0,0,0,0.46)' : '0 18px 54px rgba(0,0,0,0.32)'
        }
    ], {
        duration: 620,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
        fill: 'both'
    });
    animation.finished
        .catch(() => {})
        .then(() => {
            fmEditorModal.style.transformOrigin = '';
        });
}

function toggleEditorFullscreen(force) {
    if (!fmEditorModal || !fileManager) return;
    const isFullscreen = fmEditorModal.classList.contains('fullscreen');
    const shouldFullscreen = typeof force === 'boolean' ? force : !isFullscreen;
    if (shouldFullscreen === isFullscreen) {
        updateEditorFullscreenButton();
        return;
    }
    const firstRect = fmEditorModal.getBoundingClientRect();
    fmEditorModal.classList.add('fullscreen-animating');
    fmEditorModal.classList.toggle('fullscreen', shouldFullscreen);
    fileManager.classList.toggle('editor-fullscreen-active', shouldFullscreen);
    animateEditorFullscreenTransition(firstRect, shouldFullscreen);
    updateEditorFullscreenButton();
    window.clearTimeout(toggleEditorFullscreen._timer);
    toggleEditorFullscreen._timer = window.setTimeout(() => {
        fmEditorModal.classList.remove('fullscreen-animating');
        renderEditorCodeLayers();
        updateEditorMinimapViewport();
    }, 680);
    requestAnimationFrame(() => {
        renderEditorCodeLayers();
        updateEditorMinimapViewport();
        if (shouldFullscreen) fmEditorTextarea?.focus();
    });
}

function closeEditor({ animated = true } = {}) {
    toggleEditorFullscreen(false);
    if (!animated) {
        fmEditorModal.style.display = 'none';
        fmEditorModal.classList.remove('open', 'closing');
        return;
    }
    fmEditorModal.classList.remove('open');
    fmEditorModal.classList.add('closing');
    window.clearTimeout(closeEditor._timer);
    closeEditor._timer = window.setTimeout(() => {
        fmEditorModal.style.display = 'none';
        fmEditorModal.classList.remove('closing');
    }, 260);
}

function applyEditorOptions() {
    fmEditorTextarea.wrap = fmEditorWrap.checked ? 'soft' : 'off';
    fmEditorTextarea.style.tabSize = fmEditorTabSize.value;
    fmEditorMain?.classList.toggle('wrap-enabled', fmEditorWrap.checked);
    fmEditorHighlight?.style.setProperty('tab-size', fmEditorTabSize.value);
    fmEditorMinimapCode?.style.setProperty('tab-size', fmEditorTabSize.value);
    updateEditorMinimap();
}

function loadEditorFromBytes(bytes, encoding = fmEditorEncoding.value) {
    editorRawBytes = bytes;
    let text = decodeBytes(bytes, encoding);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    fmEditorTextarea.value = text;
    fmEditorLineEnding.value = detectLineEnding(text);
    applyEditorOptions();
    updateEditorStatus();
}

function openEditor(filePath) {
    editorFilePath = filePath;
    editorLanguage = detectEditorLanguage(filePath);
    toggleEditorFullscreen(false);
    fmEditorModal.style.display = 'flex';
    fmEditorModal.classList.remove('closing');
    requestAnimationFrame(() => fmEditorModal.classList.add('open'));
    fmEditorTitle.textContent = `编辑: ${filePath}`;
    fmEditorStatus.textContent = '读取中...';
    fmEditorTextarea.value = '';
    updateEditorMinimap();
    wsConnection.send(JSON.stringify({ type: 'sftp-readfile', path: filePath }));
}
fmEditorCloseBtn.addEventListener('click', () => closeEditor());
fmEditorCancelBtn.addEventListener('click', () => closeEditor());
fmEditorUndoBtn.addEventListener('click', () => {
    fmEditorTextarea.focus();
    document.execCommand('undo');
    updateEditorStatus();
});
fmEditorRedoBtn.addEventListener('click', () => {
    fmEditorTextarea.focus();
    document.execCommand('redo');
    updateEditorStatus();
});
fmEditorFullscreenBtn?.addEventListener('click', () => toggleEditorFullscreen());
fmEditorSaveBtn.addEventListener('click', () => {
    if (!editorFilePath) return;
    const text = normalizeLineEnding(fmEditorTextarea.value, fmEditorLineEnding.value);
    const bytes = encodeText(text, fmEditorEncoding.value);
    wsConnection.send(JSON.stringify({
        type: 'sftp-writefile',
        path: editorFilePath,
        data: bytesToBase64(bytes),
        encoding: 'base64',
    }));
    closeEditor();
});
fmEditorEncoding.addEventListener('change', () => {
    if (editorRawBytes) loadEditorFromBytes(editorRawBytes, fmEditorEncoding.value);
});
fmEditorLineEnding.addEventListener('change', updateEditorStatus);
fmEditorTabSize.addEventListener('change', applyEditorOptions);
fmEditorWrap.addEventListener('change', applyEditorOptions);
fmEditorTextarea.addEventListener('input', updateEditorStatus);
fmEditorTextarea.addEventListener('scroll', syncEditorCodeScroll, { passive: true });
fmEditorMinimap?.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    fmEditorMinimap.setPointerCapture?.(e.pointerId);
    fmEditorMinimap.classList.add('dragging');
    setEditorScrollFromMinimap(e.clientY);
    fmEditorTextarea.focus();
    const onMove = (ev) => setEditorScrollFromMinimap(ev.clientY);
    const onUp = () => {
        fmEditorMinimap.classList.remove('dragging');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
});
fmEditorMinimapToggle?.addEventListener('click', () => {
    editorMinimapHidden = !editorMinimapHidden;
    localStorage.setItem('zephyr-editor-minimap-hidden', editorMinimapHidden ? '1' : '0');
    updateEditorMinimap();
});
fmEditorTextarea.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const tab = ' '.repeat(Number(fmEditorTabSize.value) || 4);
    const { selectionStart, selectionEnd, value } = fmEditorTextarea;
    fmEditorTextarea.value = value.slice(0, selectionStart) + tab + value.slice(selectionEnd);
    fmEditorTextarea.selectionStart = fmEditorTextarea.selectionEnd = selectionStart + tab.length;
    updateEditorStatus();
});

if (window.ResizeObserver && fmEditorTextarea) {
    const editorResizeObserver = new ResizeObserver(() => {
        window.cancelAnimationFrame(editorResizeObserver._raf);
        editorResizeObserver._raf = window.requestAnimationFrame(() => {
            renderEditorCodeLayers();
            updateEditorMinimapViewport();
        });
    });
    editorResizeObserver.observe(fmEditorTextarea);
    if (fmEditorMinimap) editorResizeObserver.observe(fmEditorMinimap);
}

// ---------- SFTP 消息处理 ----------
function handleSFTPMessage(msg) {
    switch (msg.type) {
        case 'sftp-ready': sftpReady = true; refreshFileList(); flushPendingUploads(); break;
        case 'sftp-list':
            if (msg.error) alert('列出目录失败: ' + msg.error);
            else { renderFileList(msg.files); currentPath = msg.path; fmPathInput.value = currentPath; }
            break;
        case 'sftp-mkdir': case 'sftp-touch': case 'sftp-delete': case 'sftp-rename': case 'sftp-upload':
            if (msg.success) { refreshFileList(); if (msg.type === 'sftp-upload') showToast('文件上传完成', 'success'); }
            else showToast('操作失败: ' + (msg.error || '未知错误'), 'error');
            break;
        case 'sftp-upload-ready': {
            const upload = activeSftpUploads.get(msg.uploadId);
            if (upload) sendSftpUploadChunk(upload, 0);
            break;
        }
        case 'sftp-upload-progress': {
            const upload = activeSftpUploads.get(msg.uploadId);
            if (upload) sendSftpUploadChunk(upload, Number(msg.nextOffset) || 0);
            break;
        }
        case 'sftp-upload-complete':
            activeSftpUploads.delete(msg.uploadId);
            refreshFileList();
            showToast('文件上传完成', 'success');
            break;
        case 'sftp-upload-error':
            activeSftpUploads.delete(msg.uploadId);
            showToast('上传失败: ' + (msg.error || '未知错误'), 'error');
            break;
        case 'sftp-download':
            if (msg.error) alert('下载失败: ' + msg.error);
            else {
                const byteChars = atob(msg.data);
                const byteNums = new Array(byteChars.length).fill(0).map((_, i) => byteChars.charCodeAt(i));
                const blob = new Blob([new Uint8Array(byteNums)]);
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = msg.path.split('/').pop(); a.click();
                URL.revokeObjectURL(url);
            }
            break;
        case 'sftp-readfile':
            if (msg.error) {
                alert('读取失败: ' + msg.error);
                fmEditorStatus.textContent = '读取失败';
            } else {
                const bytes = msg.encoding === 'base64' ? base64ToBytes(msg.data) : new TextEncoder().encode(msg.data || '');
                fmEditorEncoding.value = detectEncoding(bytes);
                loadEditorFromBytes(bytes, fmEditorEncoding.value);
            }
            break;
        case 'sftp-writefile':
            if (msg.success) { refreshFileList(); closeEditor(); } else alert('保存失败: ' + (msg.error || '未知错误'));
            break;
        case 'sftp-error': alert('SFTP 错误: ' + msg.message); sftpReady = false; break;
    }
}

// ---------- Docker 管理面板 ----------
function setDockerStatus(message, loading = false, type = 'info') {
    if (!dockerStatus) return;
    dockerStatus.textContent = message;
    dockerStatus.classList.toggle('loading', loading);
    dockerStatus.dataset.type = type;
}

function dockerSend(payload) {
    return sendJsonMessage(payload);
}

function dockerRefreshAll() {
    if (!dockerInstalled) return;
    dockerSend({ type: 'docker-list-containers' });
    dockerSend({ type: 'docker-list-images' });
    dockerSend({ type: 'docker-mirrors-get' });
}

function checkDockerStatus({ force = false } = {}) {
    if (!force && dockerChecked) {
        if (dockerInstalled) dockerRefreshAll();
        return;
    }
    setDockerStatus('正在检测 Docker...', true);
    dockerInstallHint.style.display = 'none';
    dockerContent.style.display = 'none';
    dockerSend({ type: 'docker-check' });
}

function showDockerPanel() {
    if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN || !isConnected) {
        showToast('请先连接 SSH', 'error');
        return;
    }
    ensureFloatingPanel(dockerPanel, getDefaultPanelOptions(dockerPanel));
    dockerPanel.style.display = 'flex';
    requestAnimationFrame(() => {
        dockerPanel.classList.add('open');
        dockerBtn.classList.add('active');
        bringPanelToFront(dockerPanel);
        animatePanelFromButton(dockerPanel, dockerBtn, true);
    });
    checkDockerStatus();
}

function hideDockerPanel() {
    if (typeof closePanelLayoutMenu === 'function') closePanelLayoutMenu({ instant: true });
    animatePanelFromButton(dockerPanel, dockerBtn, false);
    dockerPanel.classList.remove('open');
    dockerBtn.classList.remove('active');
    window.setTimeout(() => {
        clearPanelMotion(dockerPanel);
        if (!dockerPanel.classList.contains('open')) dockerPanel.style.display = 'none';
    }, 320);
}

function normalizeContainer(row = {}) {
    return {
        id: row.ID || row.IDs || row.ContainerID || '',
        name: row.Names || row.Name || row.names || 'N/A',
        image: row.Image || 'N/A',
        status: row.Status || row.State || 'N/A',
        ports: row.Ports || '—',
        created: row.CreatedAt || row.Created || 'N/A',
    };
}

function normalizeImage(row = {}) {
    return {
        id: row.ID || row.ImageID || '',
        repository: row.Repository || 'N/A',
        tag: row.Tag || 'N/A',
        size: row.Size || 'N/A',
        created: row.CreatedAt || row.CreatedSince || row.Created || 'N/A',
    };
}

function shortId(id = '') {
    return String(id).replace(/^sha256:/, '').slice(0, 12) || '';
}

function renderDockerContainers(containers = []) {
    if (!dockerContainersBody) return;
    dockerContainersBody.innerHTML = '';
    if (!containers.length) {
        dockerContainersBody.innerHTML = '<tr><td colspan="6">暂无容器</td></tr>';
        return;
    }
    containers.map(normalizeContainer).forEach((container) => {
        const tr = document.createElement('tr');
        const target = container.id || container.name;
        const running = /up|running/i.test(container.status);
        tr.innerHTML = `
            <td title="${escapeHtml(container.id)}">${escapeHtml(container.name)}<div class="docker-sub-id">${escapeHtml(shortId(container.id))}</div></td>
            <td>${escapeHtml(container.image)}</td>
            <td><span class="docker-badge ${running ? 'running' : 'stopped'}">${escapeHtml(container.status)}</span></td>
            <td>${escapeHtml(container.ports || '—')}</td>
            <td>${escapeHtml(container.created)}</td>
            <td><div class="docker-actions"></div></td>
        `;
        const actions = tr.querySelector('.docker-actions');
        const actionButtons = [
            ['start', '启动', '▶️'],
            ['stop', '停止', '⏹️'],
            ['restart', '重启', '🔄'],
            ['logs', '日志', '📜'],
            ['remove', '删除', '🗑️'],
        ];
        actionButtons.forEach(([action, label, icon]) => {
            const btn = document.createElement('button');
            btn.className = `tool-btn ${action === 'remove' ? 'danger-text' : ''}`;
            btn.textContent = `${icon} ${label}`;
            btn.disabled = (action === 'start' && running) || (action === 'stop' && !running);
            btn.addEventListener('click', () => {
                if (action === 'logs') return openDockerLogs(target, container.name);
                if (action === 'remove' && !confirm(`确认删除容器 ${container.name}?`)) return;
                setDockerStatus(`正在执行容器${label}操作...`, true);
                dockerSend({ type: 'docker-container-action', action, id: target });
            });
            actions.appendChild(btn);
        });
        dockerContainersBody.appendChild(tr);
    });
}

function renderDockerImages(images = []) {
    if (!dockerImagesBody) return;
    dockerImagesBody.innerHTML = '';
    if (!images.length) {
        dockerImagesBody.innerHTML = '<tr><td colspan="5">暂无镜像</td></tr>';
        return;
    }
    images.map(normalizeImage).forEach((image) => {
        const imageRef = image.repository !== '<none>' && image.tag !== '<none>' ? `${image.repository}:${image.tag}` : image.id;
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td title="${escapeHtml(image.id)}">${escapeHtml(image.repository)}<div class="docker-sub-id">${escapeHtml(shortId(image.id))}</div></td>
            <td>${escapeHtml(image.tag)}</td>
            <td>${escapeHtml(image.size)}</td>
            <td>${escapeHtml(image.created)}</td>
            <td><div class="docker-actions"></div></td>
        `;
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'tool-btn danger-text';
        deleteBtn.textContent = '🗑️ 删除';
        deleteBtn.addEventListener('click', () => {
            if (!confirm(`确认删除镜像 ${imageRef}?`)) return;
            setDockerStatus('正在检查镜像使用情况...', true);
            dockerSend({ type: 'docker-delete-image', image: imageRef, id: image.id });
        });
        tr.querySelector('.docker-actions').appendChild(deleteBtn);
        dockerImagesBody.appendChild(tr);
    });
}

function renderDockerMirrors() {
    if (!dockerMirrorList) return;
    dockerMirrorList.innerHTML = '';
    if (!dockerMirrors.length) {
        const empty = document.createElement('div');
        empty.className = 'docker-empty-row';
        empty.textContent = '尚未配置镜像加速器';
        dockerMirrorList.appendChild(empty);
        return;
    }
    dockerMirrors.forEach((mirror, index) => {
        const row = document.createElement('div');
        row.className = 'docker-mirror-item';
        const input = document.createElement('input');
        input.value = mirror;
        input.addEventListener('input', () => { dockerMirrors[index] = input.value.trim(); });
        const del = document.createElement('button');
        del.className = 'tool-btn danger-text';
        del.textContent = '删除';
        del.addEventListener('click', () => {
            dockerMirrors.splice(index, 1);
            renderDockerMirrors();
        });
        row.append(input, del);
        dockerMirrorList.appendChild(row);
    });
}

function openDockerLogs(containerId, name) {
    if (!containerId) return;
    if (dockerCurrentLogContainer) dockerSend({ type: 'docker-logs-stop', id: dockerCurrentLogContainer });
    dockerCurrentLogContainer = containerId;
    dockerLogBuffer = '';
    dockerAutoScrollLog = true;
    dockerContainerLog.textContent = '';
    dockerLogTitle.textContent = `容器日志 · ${name || shortId(containerId)}`;
    dockerLogPauseBtn.textContent = '暂停滚动';
    dockerLogDrawer.style.display = 'flex';
    dockerSend({ type: 'docker-logs-start', id: containerId });
}

function appendDockerLog(data = '') {
    dockerLogBuffer += data;
    dockerContainerLog.textContent += data;
    if (dockerAutoScrollLog) dockerContainerLog.scrollTop = dockerContainerLog.scrollHeight;
}

function closeDockerLogs() {
    if (dockerCurrentLogContainer) dockerSend({ type: 'docker-logs-stop', id: dockerCurrentLogContainer });
    dockerCurrentLogContainer = null;
    dockerLogDrawer.style.display = 'none';
}

function handleDockerMessage(msg) {
    switch (msg.type) {
        case 'docker-status':
            dockerChecked = true;
            dockerInstalled = !!msg.installed;
            if (!dockerInstalled) {
                setDockerStatus('未检测到 Docker，请先安装 Docker', false, 'warning');
                dockerInstallHint.style.display = 'flex';
                dockerContent.style.display = 'none';
            } else {
                setDockerStatus(msg.version || 'Docker 已安装，正在加载资源...', true, 'success');
                dockerInstallHint.style.display = 'none';
                dockerContent.style.display = 'flex';
                dockerRefreshAll();
            }
            break;
        case 'docker-containers':
            if (msg.error) { setDockerStatus(`容器列表加载失败：${msg.error}`, false, 'error'); return; }
            renderDockerContainers(msg.containers || []);
            setDockerStatus('容器列表已更新', false, 'success');
            break;
        case 'docker-images':
            if (msg.error) { setDockerStatus(`镜像列表加载失败：${msg.error}`, false, 'error'); return; }
            renderDockerImages(msg.images || []);
            break;
        case 'docker-action':
            showToast('Docker 容器操作完成', 'success');
            dockerRefreshAll();
            break;
        case 'docker-image-delete':
            if (msg.requiresForce) {
                const ok = confirm(`该镜像正在被以下容器使用：\n${msg.usedBy}\n\n是否强制删除？`);
                if (ok) dockerSend({ type: 'docker-delete-image', image: msg.image, force: true });
                else setDockerStatus('已取消删除镜像', false);
                return;
            }
            if (msg.success) { showToast('镜像已删除', 'success'); dockerRefreshAll(); }
            else showToast(`镜像删除失败：${msg.error || '未知错误'}`, 'error');
            break;
        case 'docker-pull-start':
            dockerPullBtn.disabled = true;
            dockerPullLog.textContent = `开始拉取 ${msg.image}...\n`;
            setDockerStatus('正在拉取镜像...', true);
            break;
        case 'docker-pull-log':
            dockerPullLog.textContent += msg.data || '';
            dockerPullLog.scrollTop = dockerPullLog.scrollHeight;
            break;
        case 'docker-pull-complete':
            dockerPullBtn.disabled = false;
            setDockerStatus(msg.success ? '镜像拉取完成' : `镜像拉取失败（code=${msg.code ?? 'N/A'}）`, false, msg.success ? 'success' : 'error');
            showToast(msg.success ? '镜像拉取完成' : '镜像拉取失败', msg.success ? 'success' : 'error');
            dockerRefreshAll();
            break;
        case 'docker-mirrors':
            dockerMirrors = Array.isArray(msg.mirrors) ? msg.mirrors : [];
            renderDockerMirrors();
            break;
        case 'docker-mirrors-save':
            showToast('镜像加速器配置已保存，请重启 Docker 服务', 'success', 4200);
            dockerMirrors = Array.isArray(msg.mirrors) ? msg.mirrors : dockerMirrors;
            renderDockerMirrors();
            setDockerStatus('配置已保存，请重启 Docker 服务', false, 'success');
            break;
        case 'docker-service-restart':
            setDockerStatus('Docker 服务已重启，正在刷新资源...', true, 'success');
            showToast('Docker 服务已重启', 'success');
            window.setTimeout(() => checkDockerStatus({ force: true }), 1200);
            break;
        case 'docker-log-start':
            appendDockerLog('--- 日志流已连接 ---\n');
            break;
        case 'docker-log-data':
            appendDockerLog(msg.data || '');
            break;
        case 'docker-log-end':
            if (msg.container === dockerCurrentLogContainer) appendDockerLog('\n--- 日志流已结束 ---\n');
            break;
        case 'docker-log-error':
        case 'docker-error':
            setDockerStatus(msg.message || msg.error || 'Docker 操作失败', false, 'error');
            showToast(msg.message || msg.error || 'Docker 操作失败', 'error');
            dockerPullBtn.disabled = false;
            break;
    }
}

function resetFeatureStateAfterReconnect() {
    sftpReady = false;
    dockerChecked = false;
    dockerInstalled = false;
    dockerCurrentLogContainer = null;
    dockerLogBuffer = '';
    dockerAutoScrollLog = true;
    if (dockerLogDrawer) dockerLogDrawer.style.display = 'none';
    if (dockerPullBtn) dockerPullBtn.disabled = false;
    if (dockerPanel?.classList.contains('open')) checkDockerStatus({ force: true });
    if (fileManager?.classList.contains('open')) initSFTP();
}

dockerBtn?.addEventListener('click', () => {
    if (dockerPanel.classList.contains('open')) hideDockerPanel();
    else showDockerPanel();
});
dockerCloseBtn?.addEventListener('click', hideDockerPanel);
dockerRefreshBtn?.addEventListener('click', () => checkDockerStatus({ force: true }));
dockerRestartBtn?.addEventListener('click', () => {
    if (!confirm('确认重启目标主机 Docker 服务？运行中的容器通常会继续运行，但 Docker API 会短暂不可用。')) return;
    setDockerStatus('正在重启 Docker 服务...', true);
    dockerSend({ type: 'docker-restart-service' });
});
document.querySelectorAll('[data-docker-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('[data-docker-tab]').forEach((item) => item.classList.toggle('active', item === tab));
        document.querySelectorAll('.docker-tab-panel').forEach((panel) => panel.classList.remove('active'));
        const target = document.getElementById(`docker${tab.dataset.dockerTab[0].toUpperCase()}${tab.dataset.dockerTab.slice(1)}Panel`);
        target?.classList.add('active');
    });
});
dockerPullBtn?.addEventListener('click', () => {
    const image = dockerPullInput.value.trim();
    if (!image) { showToast('请输入镜像名，例如 nginx:alpine', 'error'); return; }
    dockerSend({ type: 'docker-pull-image', image });
});
dockerPullInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') dockerPullBtn.click(); });
dockerMirrorAddBtn?.addEventListener('click', () => {
    const value = dockerMirrorInput.value.trim();
    if (!value) return;
    dockerMirrors.push(value);
    dockerMirrorInput.value = '';
    renderDockerMirrors();
});
dockerMirrorSaveBtn?.addEventListener('click', () => {
    dockerMirrors = dockerMirrors.map((item) => item.trim()).filter(Boolean);
    setDockerStatus('正在保存镜像加速器配置...', true);
    dockerSend({ type: 'docker-mirrors-set', mirrors: dockerMirrors });
});
dockerLogCloseBtn?.addEventListener('click', closeDockerLogs);
dockerLogPauseBtn?.addEventListener('click', () => {
    dockerAutoScrollLog = !dockerAutoScrollLog;
    dockerLogPauseBtn.textContent = dockerAutoScrollLog ? '暂停滚动' : '继续滚动';
    if (dockerAutoScrollLog) dockerContainerLog.scrollTop = dockerContainerLog.scrollHeight;
});
dockerContainerLog?.addEventListener('scroll', () => {
    const atBottom = dockerContainerLog.scrollHeight - dockerContainerLog.scrollTop - dockerContainerLog.clientHeight < 24;
    if (!atBottom) {
        dockerAutoScrollLog = false;
        dockerLogPauseBtn.textContent = '继续滚动';
    }
}, { passive: true });
dockerLogDownloadBtn?.addEventListener('click', () => {
    const blob = new Blob([dockerLogBuffer || dockerContainerLog.textContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(dockerLogTitle.textContent || 'container').replace(/[^\w.-]+/g, '_')}.log`;
    a.click();
    URL.revokeObjectURL(url);
});

// ---------- 监控面板 ----------
function safeVal(val, fallback = 0) {
    return (val != null && !isNaN(val)) ? val : fallback;
}

function destroyCharts() {
    Object.values(chartInstances).forEach(chart => {
        try { chart.destroy(); } catch (_) {}
    });
    chartInstances = {};
}

// 自定义插件：环形图中心显示百分比
const centerTextPlugin = {
    id: 'centerText',
    afterDraw(chart) {
        const { ctx, chartArea, config: { type } } = chart;
        if (type !== 'doughnut' || !chartArea) return;
        const { left, top, right, bottom } = chartArea;
        if ([left, top, right, bottom].some((v) => typeof v !== 'number' || isNaN(v))) return;
        const centerX = (left + right) / 2;
        const centerY = (top + bottom) / 2 + (bottom - top) * 0.05;
        const value = chart.data.datasets[0].data[0] || 0;
        ctx.save();
        const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#e6edf3';
        ctx.font = 'bold 18px "JetBrains Mono", "Fira Code", monospace';
        ctx.fillStyle = textColor;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${Math.round(value)}%`, centerX, centerY);
        ctx.restore();
    }
};

function initCharts() {
    destroyCharts();

    const commonDoughnut = {
        type: 'doughnut',
        data: { datasets: [{ data: [0, 100], backgroundColor: ['#3fb950', 'rgba(139,148,158,0.25)'], borderWidth: 0 }] },
        options: {
            circumference: 270,
            rotation: 225,
            cutout: '80%',
            responsive: true,
            maintainAspectRatio: true,
            animation: { duration: 0 },
            plugins: { legend: { display: false }, tooltip: { enabled: false } }
        },
        plugins: [centerTextPlugin]
    };

    const commonLine = {
        type: 'line',
        data: { labels: Array(20).fill(''), datasets: [{ data: Array(20).fill(0), borderWidth: 1.5, pointRadius: 0, tension: 0.2 }] },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 0 },
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
            scales: { x: { display: false }, y: { display: false } }
        }
    };

    document.querySelectorAll('.doughnut-wrap canvas').forEach(canvas => {
        const id = canvas.id;
        if (!id) return;
        chartInstances[id] = new Chart(canvas, commonDoughnut);
    });

    document.querySelectorAll('.sparkline-row canvas, .line-canvas').forEach(canvas => {
        const id = canvas.id;
        if (!id) return;
        const color = canvas.dataset.color || '#3fb950';
        const config = JSON.parse(JSON.stringify(commonLine));
        config.data.datasets[0].borderColor = color;
        config.data.datasets[0].fill = false;
        chartInstances[id] = new Chart(canvas, config);
    });
}

function updateDoughnut(id, value) {
    const chart = chartInstances[id];
    if (!chart) return;
    const p = Math.min(100, Math.max(0, safeVal(value)));
    if (chart.data.datasets[0].data[0] === p) return; // 无变化不更新
    chart.data.datasets[0].data = [p, 100 - p];
    const color = p < 50 ? '#3fb950' : p < 80 ? '#d2991d' : '#f85149';
    chart.data.datasets[0].backgroundColor = [color, 'rgba(139,148,158,0.25)'];
    chart.update('none');
}

function updateLine(id, value) {
    const chart = chartInstances[id];
    if (!chart) return;
    const data = chart.data.datasets[0].data;
    data.push(safeVal(value));
    if (data.length > 20) data.shift();
    chart.update('none');
}

function getTerminalScrollElement() {
    return wtermWrapper;
}

function getTerminalBottomDistance(el = getTerminalScrollElement()) {
    if (!el) return 0;
    return el.scrollHeight - el.scrollTop - el.clientHeight;
}

function isTerminalAtBottom(el = getTerminalScrollElement(), threshold = TERMINAL_BOTTOM_THRESHOLD) {
    if (!el) return true;
    return getTerminalBottomDistance(el) <= threshold;
}

function setTerminalAutoFollow(enabled, reason = 'unknown') {
    terminalAutoFollowEnabled = !!enabled;
    terminalUserScrolledAway = !terminalAutoFollowEnabled;
    terminalContainer?.classList.toggle('terminal-follow-paused', !terminalAutoFollowEnabled);
    terminalContainer?.classList.toggle('terminal-following', terminalAutoFollowEnabled);
    logTerminalScrollDiagnostics('auto-follow:set', { enabled: terminalAutoFollowEnabled, reason });
}

function updateTerminalAutoFollowFromScroll(reason = 'scroll') {
    const el = getTerminalScrollElement();
    if (!el) return true;
    const atBottom = isTerminalAtBottom(el, TERMINAL_XTERM_SCROLL_LOCK_THRESHOLD);
    if (atBottom) setTerminalAutoFollow(true, reason);
    else if (!isProgrammaticTerminalScroll) {
        terminalLastUserScrollAt = Date.now();
        setTerminalAutoFollow(false, reason);
    }
    return terminalAutoFollowEnabled;
}

function scrollTerminalToBottom(reason = 'scroll-bottom') {
    const el = getTerminalScrollElement();
    if (!el) return;
    isProgrammaticTerminalScroll = true;
    try {
        if (term?._zephyrOriginalScrollToBottom) term._zephyrOriginalScrollToBottom();
        else el.scrollTop = getTerminalMaxScroll(el);
        setTerminalAutoFollow(true, reason);
    } finally {
        scheduleTerminalScrollbarUpdate();
        requestAnimationFrame(() => { isProgrammaticTerminalScroll = false; });
    }
}

function getTerminalMaxScroll(el = getTerminalScrollElement()) {
    if (!el) return 0;
    return Math.max(0, el.scrollHeight - el.clientHeight);
}

function updateTerminalScrollbarNow() {
    const el = getTerminalScrollElement();
    if (!el || !terminalContainer || !terminalScrollbar || !terminalScrollbarThumb) return;
    const maxScroll = getTerminalMaxScroll(el);
    const scrollable = maxScroll > 1;
    terminalContainer.classList.toggle('scrollable', scrollable);
    el.classList.toggle('terminal-scrollable', scrollable);
    if (terminalScrollbar) terminalScrollbar.style.display = scrollable ? 'block' : 'none';
    if (!scrollable) {
        terminalScrollbar.style.setProperty('--terminal-scroll-thumb-top', '0px');
        terminalScrollbar.style.setProperty('--terminal-scroll-thumb-height', '100%');
        return;
    }

    const trackHeight = terminalScrollbar.clientHeight || terminalScrollbar.getBoundingClientRect().height || 1;
    const thumbHeight = Math.min(trackHeight, Math.max(TERMINAL_SCROLLBAR_MIN_THUMB, (el.clientHeight / Math.max(el.scrollHeight, 1)) * trackHeight));
    const movable = Math.max(1, trackHeight - thumbHeight);
    const ratio = Math.min(1, Math.max(0, el.scrollTop / maxScroll));
    terminalScrollbar.style.setProperty('--terminal-scroll-thumb-height', `${thumbHeight}px`);
    terminalScrollbar.style.setProperty('--terminal-scroll-thumb-top', `${ratio * movable}px`);
}

function scheduleTerminalScrollbarUpdate() {
    if (terminalScrollbarRaf) return;
    terminalScrollbarRaf = requestAnimationFrame(() => {
        terminalScrollbarRaf = 0;
        updateTerminalScrollbarNow();
    });
}

function requestTerminalAutoFollow(reason = 'auto-follow') {
    const el = getTerminalScrollElement();
    if (!el) return;
    if (hasLiveTerminalSelection() || mobileTerminalSelectionMode) {
        logTerminalScrollDiagnostics('auto-follow:selection-active', { reason });
        scheduleTerminalScrollbarUpdate();
        return;
    }
    if (!terminalAutoFollowEnabled && !isTerminalAtBottom(el, TERMINAL_XTERM_SCROLL_LOCK_THRESHOLD)) {
        logTerminalScrollDiagnostics('auto-follow:paused', { reason });
        scheduleTerminalScrollbarUpdate();
        return;
    }
    scrollTerminalToBottom(reason);
}

function stopTerminalAutoScrollObserver() {
    if (terminalScrollRaf) {
        cancelAnimationFrame(terminalScrollRaf);
        terminalScrollRaf = 0;
    }
    if (terminalScrollbarRaf) {
        cancelAnimationFrame(terminalScrollbarRaf);
        terminalScrollbarRaf = 0;
    }
    terminalScrollCleanup?.();
    terminalScrollCleanup = null;
    isProgrammaticTerminalScroll = false;
}

function getTerminalAltScreenActive() {
    try { return !!term?.bridge?.usingAltScreen?.(); } catch (_) { return false; }
}

function sendTerminalAltScroll(deltaY) {
    if (!getTerminalAltScreenActive() || !wsConnection || wsConnection.readyState !== WebSocket.OPEN || !isConnected) return false;
    if (hasLiveTerminalSelection()) return false;
    const now = Date.now();
    if (now - terminalLastWheelAt < TERMINAL_ALT_SCROLL_REPEAT_MS) return true;
    terminalLastWheelAt = now;
    const seq = deltaY < 0 ? '\x1b[A' : '\x1b[B';
    const repeats = Math.max(1, Math.min(5, Math.round(Math.abs(deltaY) / 48)));
    sendData(seq.repeat(repeats), { source: 'alt-screen-wheel', forceFollow: true });
    return true;
}

function setupTerminalScrollHooks({ followOnConnect = true } = {}) {
    stopTerminalAutoScrollObserver();
    resetTerminalScrollState();
    setTerminalAutoFollow(!!followOnConnect, 'connect-init');

    const onScroll = () => {
        updateTerminalAutoFollowFromScroll('user-scroll');
        scheduleTerminalScrollbarUpdate();
    };

    const onWheel = (e) => {
        if (sendTerminalMouseWheelEvent(e)) {
            e.preventDefault();
            return;
        }
        if (sendTerminalAltScroll(e.deltaY)) {
            e.preventDefault();
            return;
        }
        terminalLastWheelAt = Date.now();
        scheduleTerminalScrollbarUpdate();
    };

    let resizeObserver = null;
    if (window.ResizeObserver) {
        resizeObserver = new ResizeObserver(() => {
            // 模仿 xterm.js：尺寸/内容变化时，如果用户原本在底部才跟随；历史区阅读时不抢滚动。
            if (terminalAutoFollowEnabled || isTerminalAtBottom(undefined, TERMINAL_XTERM_SCROLL_LOCK_THRESHOLD)) {
                requestTerminalAutoFollow('resize-observer-follow');
            } else {
                scheduleTerminalScrollbarUpdate();
            }
        });
        resizeObserver.observe(wtermWrapper);
        const grid = wtermWrapper.querySelector('.term-grid');
        if (grid) resizeObserver.observe(grid);
    }

    wtermWrapper.addEventListener('scroll', onScroll, { passive: true });
    wtermWrapper.addEventListener('wheel', onWheel, { passive: false });

    setupTerminalCustomScrollbar();
    terminalScrollCleanup = () => {
        wtermWrapper.removeEventListener('scroll', onScroll);
        wtermWrapper.removeEventListener('wheel', onWheel);
        resizeObserver?.disconnect();
    };

    scheduleTerminalScrollbarUpdate();
}

function isModifierOnlyKeyEvent(e) {
    return ['Alt', 'Control', 'Meta', 'Shift', 'CapsLock'].includes(e.key);
}

function setupTerminalInputActivityHooks() {
    // 以官方 @wterm/dom 行为为准：不要在外层监听 keydown 并滚动。
    // WTerm 的 InputHandler 会在输入 onData 前执行内部滚动；外层再次滚动会造成输入上下跳动。
}

function setupTerminalCustomScrollbar() {
    if (!terminalScrollbar || !terminalScrollbarThumb || terminalScrollbar._zephyrReady) return;
    terminalScrollbar._zephyrReady = true;

    const setScrollFromClientY = (clientY) => {
        const el = getTerminalScrollElement();
        const maxScroll = getTerminalMaxScroll(el);
        if (!el || maxScroll <= 0) return;
        const rect = terminalScrollbar.getBoundingClientRect();
        const thumbHeight = terminalScrollbarThumb.getBoundingClientRect().height || TERMINAL_SCROLLBAR_MIN_THUMB;
        const ratio = Math.min(1, Math.max(0, (clientY - rect.top - thumbHeight / 2) / Math.max(1, rect.height - thumbHeight)));
        isProgrammaticTerminalScroll = true;
        el.scrollTop = ratio * maxScroll;
        scheduleTerminalScrollbarUpdate();
        requestAnimationFrame(() => { isProgrammaticTerminalScroll = false; });
    };

    terminalScrollbar.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        terminalScrollbar.classList.add('dragging');
        terminalScrollbar.setPointerCapture?.(e.pointerId);
        setScrollFromClientY(e.clientY);
        const onMove = (ev) => {
            ev.preventDefault();
            setScrollFromClientY(ev.clientY);
        };
        const onUp = () => {
            terminalScrollbar.classList.remove('dragging');
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            if (!isTouchKeyboardDevice()) term?.focus?.();
        };
        window.addEventListener('pointermove', onMove, { passive: false });
        window.addEventListener('pointerup', onUp, { once: true });
    }, { passive: false });
}

function getFallbackKeyboardMetrics() {
    const layoutHeight = getKeyboardBaselineHeight() || Math.round(window.innerHeight || document.documentElement.clientHeight || 720);
    const keyboardInset = getEstimatedKeyboardInset();
    return {
        layoutHeight,
        viewportHeight: Math.max(240, layoutHeight - keyboardInset),
        offsetTop: 0,
        keyboardInset,
        keyboardOpen: true,
        wantsAvoidance: true,
        fallback: true,
    };
}

function applyKeyboardFallbackAvoidance() {
    if (!keyboardFocusLikely || !isTouchKeyboardDevice()) return false;
    const metrics = getFallbackKeyboardMetrics();
    keyboardViewportBaseline = Math.max(metrics.layoutHeight, keyboardViewportBaseline || 0);
    const signature = `fallback:${metrics.keyboardInset}:${metrics.viewportHeight}:${metrics.layoutHeight}`;
    if (updateViewportInsets._lastSignature === signature && mobileKeyboardOpen) return true;
    updateViewportInsets._lastSignature = signature;
    updateViewportInsets._lastViewportHeight = metrics.viewportHeight;
    updateViewportInsets._lastKeyboardInset = metrics.keyboardInset;
    mobileKeyboardOpen = true;
    keyboardFallbackActive = true;
    keyboardFallbackAppliedAt = performance.now();
    notifyParentKeyboardMetrics(metrics);
    document.documentElement.style.setProperty('--keyboard-inset', `${metrics.keyboardInset}px`);
    document.documentElement.classList.add('keyboard-open');
    requestTerminalAutoFollow('keyboard-fallback-applied');
    scheduleTerminalScrollbarUpdate();
    scheduleTerminalResize('keyboard-fallback-applied', 650);
    return true;
}

function scheduleKeyboardFallbackAvoidance() {
    if (!keyboardFocusLikely || !isTouchKeyboardDevice()) return;
    window.clearTimeout(keyboardFallbackTimer);
    keyboardFallbackTimer = window.setTimeout(() => {
        const metrics = getViewportKeyboardMetrics();
        if (!keyboardFocusLikely || metrics.keyboardInset >= 100 || mobileKeyboardOpen) return;
        applyKeyboardFallbackAvoidance();
    }, 220);
}

function markKeyboardFocusActive() {
    keyboardFocusLikely = isTouchKeyboardDevice();
    keyboardViewportBaseline = Math.max(getKeyboardBaselineHeight(), keyboardViewportBaseline || 0);
    updateViewportInsets();
    scheduleKeyboardFallbackAvoidance();
}

function markKeyboardFocusInactive() {
    if (mobileClipboardActionInProgress) return;
    keyboardFocusLikely = false;
    window.clearTimeout(keyboardFallbackTimer);
    if (keyboardFallbackActive) {
        window.clearTimeout(markKeyboardFocusInactive._timer);
        markKeyboardFocusInactive._timer = window.setTimeout(() => {
            if (!keyboardFocusLikely) finalizeKeyboardClose({ force: true });
        }, 160);
    }
}

function updateViewportInsets() {
    if (embeddedMode) return;
    if (mobileTerminalSelectionMode && !mobileClipboardActionInProgress) return;
    if (mobileClipboardActionInProgress) return;
    if (!isTouchKeyboardDevice()) return;
    const wasKeyboardOpen = mobileKeyboardOpen;
    const viewport = window.visualViewport;
    if (!viewport && !navigator.virtualKeyboard) return;
    const metrics = getViewportKeyboardMetrics();
    const keyboardOpen = metrics.keyboardInset >= 80 && mobileKeyboardUserControlled;
    if (mobileKeyboardUserControlled && !keyboardOpen && mobileKeyboardOpen) {
        // Android/浏览器返回键可能绕过按钮直接收起 IME。网页无法可靠取消系统返回键，
        // 这里至少立即恢复为按钮关闭态，避免状态半开和布局残留。
        finalizeKeyboardClose({ force: true });
        return;
    }
    const inset = keyboardOpen ? metrics.keyboardInset : 0;
    const signature = `${keyboardOpen}:${Math.round(inset / 4) * 4}`;
    if (updateViewportInsets._lastSignature === signature) return;
    updateViewportInsets._lastSignature = signature;
    mobileKeyboardOpen = keyboardOpen;
    if (keyboardOpen !== wasKeyboardOpen) {
        mobileKeyboardResizeFreezeUntil = Date.now() + 1200;
    }
    cancelAnimationFrame(updateViewportInsets._raf);
    updateViewportInsets._raf = requestAnimationFrame(() => {
        document.documentElement.style.setProperty('--keyboard-inset', `${inset}px`);
        document.documentElement.classList.toggle('keyboard-open', keyboardOpen);
        if (isTouchKeyboardDevice()) requestInitialMobileRenderFlush(keyboardOpen ? 'keyboard-open' : 'keyboard-close');
        notifyParentKeyboardMetrics({
            keyboardOpen,
            keyboardInset: inset,
            viewportHeight: Math.round(viewport?.height || window.innerHeight || 0),
            layoutHeight: Math.round(window.innerHeight || document.documentElement.clientHeight || 0),
            offsetTop: Math.round(viewport?.offsetTop || 0)
        });
        requestTerminalAutoFollow(keyboardOpen ? 'keyboard-open-settled' : 'keyboard-close-settled');
        scheduleTerminalScrollbarUpdate();
        // 移动端键盘开关只改变 CSS 可视区域；等键盘关闭后再刷新 WTerm 视图，避免远端内容重排出空行/截断。
        if (!keyboardOpen) scheduleTerminalResize('keyboard-close-settled', 650);
    });
    window.clearTimeout(updateViewportInsets._settleTimer);
    updateViewportInsets._settleTimer = window.setTimeout(() => {
        requestTerminalAutoFollow('keyboard-final-settled');
        scheduleTerminalScrollbarUpdate();
        if (!keyboardOpen) scheduleTerminalResize('keyboard-final-settled', 360);
    }, keyboardOpen ? 720 : 360);
}

function finalizeKeyboardClose({ force = false } = {}) {
    if (!isTouchKeyboardDevice()) {
        const metrics = getViewportKeyboardMetrics();
        const visuallyRestored = isViewportVisuallyRestored(metrics);
        if (!force && !visuallyRestored) {
            window.clearTimeout(finalizeKeyboardClose._timer);
            finalizeKeyboardClose._timer = window.setTimeout(() => finalizeKeyboardClose(), 120);
            return;
        }
        updateViewportInsets._lastSignature = '';
        mobileKeyboardOpen = false;
        if (force) keyboardFocusLikely = false;
        window.clearTimeout(keyboardFallbackTimer);
        keyboardFallbackActive = false;
        keyboardFallbackAppliedAt = 0;
        keyboardViewportBaseline = 0;
        document.documentElement.style.setProperty('--keyboard-inset', '0px');
        document.documentElement.classList.remove('keyboard-open');
        setStableViewportHeight({ force });
        const restoredHeight = Math.round(Math.max(
            window.innerHeight || 0,
            document.documentElement.clientHeight || 0,
            window.visualViewport?.height || 0,
            getCssPxVar('--stable-vh'),
        ));
        notifyParentKeyboardMetrics({
            keyboardOpen: false,
            keyboardInset: 0,
            viewportHeight: restoredHeight,
            layoutHeight: restoredHeight,
            offsetTop: 0,
        });
        return;
    }

    updateViewportInsets._lastSignature = '';
    mobileKeyboardOpen = false;
    if (force) keyboardFocusLikely = false;
    window.clearTimeout(keyboardFallbackTimer);
    keyboardFallbackActive = false;
    keyboardFallbackAppliedAt = 0;
    keyboardViewportBaseline = 0;
    document.documentElement.style.setProperty('--keyboard-inset', '0px');
    document.documentElement.classList.remove('keyboard-open', 'viewport-updating');
    notifyParentKeyboardMetrics({
        keyboardOpen: false,
        keyboardInset: 0,
        viewportHeight: Math.round(window.visualViewport?.height || window.innerHeight || 0),
        layoutHeight: Math.round(window.innerHeight || document.documentElement.clientHeight || 0),
        offsetTop: Math.round(window.visualViewport?.offsetTop || 0),
    });
    scheduleTerminalScrollbarUpdate();
    // 键盘完全收起后再允许一次稳定 resize，避免恢复旧 viewport/buffer 高度。
    scheduleTerminalResize('keyboard-close-final', 500);
}

function restoreMobileWTermNativeInput() {
    if (!isTouchKeyboardDevice() || !term?.input?.textarea) return;
    const textarea = term.input.textarea;
    textarea.removeAttribute('readonly');
    textarea.setAttribute('tabindex', '0');
    textarea.removeAttribute('inputmode');
    textarea.style.pointerEvents = 'auto';
    textarea.style.webkitTextSecurity = '';
    if (mobileWTermInputGuard) {
        try { textarea.removeEventListener('focus', mobileWTermInputGuard.guard, true); } catch (_) {}
        try { textarea.removeEventListener('beforeinput', mobileWTermInputGuard.guard, true); } catch (_) {}
        try { textarea.removeEventListener('input', mobileWTermInputGuard.guard, true); } catch (_) {}
        try { wtermWrapper.removeEventListener('click', mobileWTermInputGuard.stopPointer, true); } catch (_) {}
        try { wtermWrapper.removeEventListener('pointerdown', mobileWTermInputGuard.stopPointer, true); } catch (_) {}
        try { wtermWrapper.removeEventListener('touchstart', mobileWTermInputGuard.stopPointer, true); } catch (_) {}
        if (mobileWTermInputGuard.originalFocus) term.focus = mobileWTermInputGuard.originalFocus;
        if (mobileWTermInputGuard.originalInputFocus) term.input.focus = mobileWTermInputGuard.originalInputFocus;
        mobileWTermInputGuard = null;
    }
}

function setupHorizontalScrollbarVisibility(...elements) {
    elements.filter(Boolean).forEach((el) => {
        let timer = 0;
        const show = () => {
            el.classList.add('scroll-active');
            window.clearTimeout(timer);
            timer = window.setTimeout(() => el.classList.remove('scroll-active'), 1100);
        };
        el.addEventListener('pointerdown', show, { passive: true });
        el.addEventListener('touchstart', show, { passive: true });
        el.addEventListener('wheel', show, { passive: true });
        el.addEventListener('scroll', show, { passive: true });
        el.addEventListener('mouseenter', show, { passive: true });
        el.addEventListener('mouseleave', () => {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => el.classList.remove('scroll-active'), 260);
        }, { passive: true });
    });
}

function setupMobileKeyboardAvoidance() {
    if (embeddedMode) return;
    if (!window.visualViewport && !navigator.virtualKeyboard && !isTouchKeyboardDevice()) return;
    try {
        if (navigator.virtualKeyboard) navigator.virtualKeyboard.overlaysContent = true;
    } catch (_) {}
    window.visualViewport?.addEventListener('resize', updateViewportInsets, { passive: true });
    window.visualViewport?.addEventListener('scroll', updateViewportInsets, { passive: true });
    navigator.virtualKeyboard?.addEventListener?.('geometrychange', updateViewportInsets);
    document.addEventListener('focusin', (e) => {
        if (isTouchKeyboardDevice() && e.target === cmdInput && !mobileKeyboardUserControlled) {
            cmdInput.blur();
            return;
        }
        if (isKeyboardAvoidanceTarget(e.target)) markKeyboardFocusActive();
    }, true);
    document.addEventListener('focusout', (e) => {
        if (mobileClipboardActionInProgress) return;
        if (isKeyboardAvoidanceTarget(e.target)) markKeyboardFocusInactive();
    }, true);
    cmdInput?.addEventListener('focus', () => {
        mobileTerminalSelectionMode = false;
        document.documentElement.classList.remove('terminal-selection-mode');
        window.clearTimeout(mobileTerminalSelectionRestoreTimer);
        keyboardViewportBaseline = Math.max(
            window.innerHeight || 0,
            document.documentElement.clientHeight || 0,
            window.visualViewport?.height || 0,
            getCssPxVar('--stable-vh'),
        );
        markKeyboardFocusActive();
        updateViewportInsets();
        window.setTimeout(updateViewportInsets, 80);
        window.setTimeout(updateViewportInsets, 260);
        window.setTimeout(updateViewportInsets, 520);
    });
    cmdInput?.addEventListener('blur', () => {
        markKeyboardFocusInactive();
        // 不在 blur 立即复位。iOS/Android 标准键盘收起时 visualViewport 仍在动画中，
        // 过早恢复 100vh 会造成页面先下坠再回弹；改为继续跟随到接近全高后再释放。
        [80, 180, 320, 520].forEach((delay) => window.setTimeout(updateViewportInsets, delay));
        window.setTimeout(() => {
            if (!keyboardFocusLikely && !isKeyboardAvoidanceTarget()) finalizeKeyboardClose();
        }, 680);
    });
    updateViewportInsets();
}

function renderStats(d) {
    if (!infoBody || !d) return;
    latestStatsData = d;
    const cpuUsage = safeVal(d.cpu?.usage);
    const memUsedGB = (safeVal(d.memUsed) / 1024).toFixed(1);
    const memTotalGB = (safeVal(d.memTotal) / 1024).toFixed(1);
    const swapUsedGB = (safeVal(d.swapUsed) / 1024).toFixed(1);
    const swapTotalGB = (safeVal(d.swapTotal) / 1024).toFixed(1);
    const rxMbps = safeVal(d.net?.rx).toFixed(1);
    const txMbps = safeVal(d.net?.tx).toFixed(1);
    const ipv4 = d.ip?.ipv4 || 'N/A';
    const ipv6 = d.ip?.ipv6 || 'N/A';
    const hostName = d.host?.hostname || 'N/A';
    const hostOS = d.host?.os || 'N/A';
    const diskDevices = Array.isArray(d.disk?.devices) ? d.disk.devices : [];
    const diskDeviceCards = diskDevices.map(device => `
        <div class="doughnut-item disk-card">
            <div class="disk-card-meta">
                <div class="doughnut-label">${device.mountpoint}</div>
                <div class="doughnut-text">${device.usedGB} / ${device.totalGB} GB</div>
                <div class="doughnut-sub">${device.filesystem}</div>
                <div class="doughnut-sub">已用 ${device.usageLabel}</div>
                <div class="doughnut-sub">读 ${device.readKBps} KB/s · 写 ${device.writeKBps} KB/s</div>
            </div>
            <div class="doughnut-wrap"><canvas id="${device.id}"></canvas></div>
        </div>
    `).join('');

    infoBody.innerHTML = `
        <div class="doughnut-row">
            <div class="doughnut-item disk-card full-width">
                <div class="disk-card-meta">
                    <div class="doughnut-label">主机</div>
                    <div class="doughnut-text">${hostName}</div>
                    <div class="doughnut-sub">${hostOS}</div>
                </div>
            </div>
        </div>
        <div class="doughnut-row">
            <div class="doughnut-item disk-card full-width">
                <div class="disk-card-meta">
                    <div class="doughnut-label">CPU</div>
                    <div class="doughnut-text">${d.cpu?.model || 'N/A'}</div>
                    <div class="doughnut-sub">${d.cpu?.freq || 'N/A'}</div>
                    <div class="doughnut-sub">${d.cpu?.cores || 0} 核心</div>
                </div>
                <div class="doughnut-wrap"><canvas id="cpuDoughnut"></canvas></div>
            </div>
        </div>
        <div class="doughnut-row two-col">
            <div class="doughnut-item">
                <div class="doughnut-label">内存</div>
                <div class="doughnut-wrap"><canvas id="ramDoughnut"></canvas></div>
                <div class="doughnut-text">${memUsedGB} / ${memTotalGB} GB</div>
            </div>
            <div class="doughnut-item">
                <div class="doughnut-label">Swap</div>
                <div class="doughnut-wrap"><canvas id="swapDoughnut"></canvas></div>
                <div class="doughnut-text">${swapUsedGB} / ${swapTotalGB} GB</div>
            </div>
        </div>
        <div class="doughnut-row disk-card-row">
            ${diskDeviceCards}
        </div>
        <div class="doughnut-row two-col">
            <div class="doughnut-item">
                <div class="doughnut-label">下载</div>
                <div class="doughnut-text">${rxMbps} Mbps</div>
                <div class="sparkline-row">
                    <canvas id="rxLine" data-color="#3fb950" class="line-canvas" height="30"></canvas>
                </div>
            </div>
            <div class="doughnut-item">
                <div class="doughnut-label">上传</div>
                <div class="doughnut-text">${txMbps} Mbps</div>
                <div class="sparkline-row">
                    <canvas id="txLine" data-color="#58a6ff" class="line-canvas" height="30"></canvas>
                </div>
            </div>
        </div>
        <div class="ip-section">
            <div class="ip-box"><span>IPv4</span><code>${ipv4}</code><button class="copy-ip-btn" onclick="navigator.clipboard.writeText('${ipv4}')">📋</button></div>
            <div class="ip-box"><span>IPv6</span><code>${ipv6}</code><button class="copy-ip-btn" onclick="navigator.clipboard.writeText('${ipv6}')">📋</button></div>
        </div>
    `;

    try {
        initCharts();
        updateDoughnut('cpuDoughnut', cpuUsage);
        updateDoughnut('ramDoughnut', (safeVal(d.memUsed) / safeVal(d.memTotal)) * 100);
        updateDoughnut('swapDoughnut', safeVal(d.swapTotal) ? (safeVal(d.swapUsed) / safeVal(d.swapTotal)) * 100 : 0);
        diskDevices.forEach(device => updateDoughnut(device.id, device.percent));
        updateLine('rxLine', rxMbps);
        updateLine('txLine', txMbps);
    } catch (err) {
        console.warn('[Stats] 图表初始化失败:', err);
    }
}

function showInfoModal() {
    if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN || !isConnected) {
        alert('请先连接 SSH');
        return;
    }
    ensureFloatingPanel(infoModal, getDefaultPanelOptions(infoModal));
    if (latestStatsData) {
        renderStats(latestStatsData);
    } else if (infoBody && !infoBody.children.length) {
        infoBody.innerHTML = '<div class="info-loading">正在加载服务器实时监控数据...</div>';
    }
    if (wsConnection?.readyState === WebSocket.OPEN) {
        wsConnection.send(JSON.stringify({ type: 'stats-request' }));
    }
    infoModal.style.display = 'flex';
    // display 从 none 切换为 flex 后，下一帧再加 open，确保浏览器能播放开启动画。
    requestAnimationFrame(() => {
        infoModal.classList.add('open');
        infoBtn.classList.add('active');
        bringPanelToFront(infoModal);
        animatePanelFromButton(infoModal, infoBtn, true);
    });
}

function patchWTermScrollBehavior() {
    if (!term || term._zephyrScrollPatched) return;

    // xterm.js 风格滚动语义：
    // - 输出/resize 前若贴底，则渲染后跟随到底；
    // - 用户滚到历史区时锁定视图，不被远端输出、输入回显、键盘布局事件抢走；
    // - 回到底部后自动恢复 follow。
    const originalScrollToBottom = typeof term._scrollToBottom === 'function' ? term._scrollToBottom.bind(term) : null;
    const originalIsScrolledToBottom = typeof term._isScrolledToBottom === 'function' ? term._isScrolledToBottom.bind(term) : null;
    const originalDoRender = typeof term._doRender === 'function' ? term._doRender.bind(term) : null;
    const originalScheduleRender = typeof term._scheduleRender === 'function' ? term._scheduleRender.bind(term) : null;
    const originalWrite = typeof term.write === 'function' ? term.write.bind(term) : null;
    const originalResize = typeof term.resize === 'function' ? term.resize.bind(term) : null;

    if (originalScrollToBottom) {
        term._scrollToBottom = () => {
            const fromRender = term._zephyrRenderingDepth > 0;
            const alreadyAtBottom = originalIsScrolledToBottom ? originalIsScrolledToBottom() : isTerminalAtBottom();
            if (!fromRender && !alreadyAtBottom && !terminalAutoFollowEnabled) {
                scheduleTerminalScrollbarUpdate();
                return;
            }
            isProgrammaticTerminalScroll = true;
            try {
                originalScrollToBottom();
                setTerminalAutoFollow(true, fromRender ? 'wterm-render-scroll-bottom' : 'wterm-scroll-bottom');
            } finally {
                scheduleTerminalScrollbarUpdate();
                requestAnimationFrame(() => { isProgrammaticTerminalScroll = false; });
            }
        };
    }

    if (originalIsScrolledToBottom) {
        term._isScrolledToBottom = () => originalIsScrolledToBottom() || isTerminalAtBottom(undefined, TERMINAL_BOTTOM_THRESHOLD);
    }

    if (originalWrite) {
        term.write = (data) => {
            const shouldFollow = terminalAutoFollowEnabled || (originalIsScrolledToBottom ? originalIsScrolledToBottom() : isTerminalAtBottom());
            term._zephyrShouldFollowAfterRender = shouldFollow;
            const result = originalWrite(data);
            if (shouldFollow) requestAnimationFrame(() => requestTerminalAutoFollow('write-follow'));
            else scheduleTerminalScrollbarUpdate();
            return result;
        };
    }

    if (originalResize) {
        term.resize = (cols, rows) => {
            const shouldFollow = terminalAutoFollowEnabled || (originalIsScrolledToBottom ? originalIsScrolledToBottom() : isTerminalAtBottom());
            term._zephyrShouldFollowAfterRender = shouldFollow;
            const result = originalResize(cols, rows);
            if (shouldFollow) requestAnimationFrame(() => requestTerminalAutoFollow('resize-follow'));
            else scheduleTerminalScrollbarUpdate();
            return result;
        };
    }

    if (originalDoRender) {
        term._doRender = () => {
            term._zephyrRenderingDepth = (term._zephyrRenderingDepth || 0) + 1;
            const shouldFollow = !!term._zephyrShouldFollowAfterRender || terminalAutoFollowEnabled;
            try {
                return originalDoRender();
            } finally {
                term._zephyrRenderingDepth = Math.max(0, (term._zephyrRenderingDepth || 1) - 1);
                term._zephyrShouldFollowAfterRender = false;
                if (shouldFollow) requestAnimationFrame(() => requestTerminalAutoFollow('render-follow'));
                else scheduleTerminalScrollbarUpdate();
                updateTerminalWebLinks();
            }
        };
    }

    if (originalScheduleRender) {
        term._scheduleRender = () => {
            originalScheduleRender();
            requestAnimationFrame(() => requestAnimationFrame(() => {
                if (terminalAutoFollowEnabled) requestTerminalAutoFollow('scheduled-render-follow');
                scheduleTerminalScrollbarUpdate();
                updateTerminalWebLinks();
            }));
        };
    }

    term._zephyrOriginalScrollToBottom = originalScrollToBottom;
    term._zephyrOriginalIsScrolledToBottom = originalIsScrolledToBottom;
    term._zephyrOriginalDoRender = originalDoRender;
    term._zephyrOriginalScheduleRender = originalScheduleRender;
    term._zephyrScrollPatched = true;
}

function requestInitialMobileRenderFlush(reason = 'mobile-initial-render') {
    if (!isTouchKeyboardDevice()) return;
    // 移动端页面/键盘恢复只刷新渲染和滚动条；不强制滚到底、不改变远端 PTY。
    // 这避免 iOS/Android WebView 恢复后 viewport 与 buffer 错配造成空白撑开、截断和光标漂移。
    const keyboardRelated = /keyboard|viewport|visual/.test(String(reason));
    const delays = keyboardRelated ? [0, 80, 220] : [0, 40, 120, 260, 520];
    delays.forEach((delay) => {
        window.setTimeout(() => {
            if (!term || !wtermWrapper || document.visibilityState !== 'visible') return;
            try { term._scheduleRender?.(); } catch (_) {}
            scheduleTerminalScrollbarUpdate();
        }, delay);
    });
}

function writeTerminalData(data = '') {
    if (!term?.write) return;
    updateTerminalMouseTrackingFromData(data);
    const wasAtBottom = Boolean(term._isScrolledToBottom ? term._isScrolledToBottom() : isTerminalAtBottom());
    const shouldFollow = terminalAutoFollowEnabled || wasAtBottom;
    logTerminalScrollDiagnostics('terminal-data:before-write-xterm-follow', {
        length: String(data).length,
        wasAtBottom,
        shouldFollow,
    });
    term._zephyrShouldFollowAfterRender = shouldFollow;
    term.write(data);
    if (shouldFollow) requestAnimationFrame(() => requestTerminalAutoFollow('terminal-data'));
    else requestAnimationFrame(scheduleTerminalScrollbarUpdate);
}

function hideInfoModal() {
    if (typeof closePanelLayoutMenu === 'function') closePanelLayoutMenu({ instant: true });
    animatePanelFromButton(infoModal, infoBtn, false);
    infoModal.classList.remove('open');
    infoBtn.classList.remove('active');
    window.setTimeout(() => {
        clearPanelMotion(infoModal);
        if (!infoModal.classList.contains('open')) {
            infoModal.style.display = 'none';
        }
    }, 320);
}

function toggleInfoModal() {
    if (infoModal.classList.contains('open')) hideInfoModal();
    else showInfoModal();
}

infoBtn.addEventListener('click', toggleInfoModal);

infoCloseBtn.addEventListener('click', hideInfoModal);

// ---------- 浮动面板拖动 / 缩放 ----------
const panelState = new WeakMap();

function ensureFloatingPanel(panel, defaults = {}) {
    if (!panel || panelState.has(panel)) return;
    const parentRect = panel.parentElement.getBoundingClientRect();
    const width = defaults.width || Math.min(parentRect.width * 0.72, 760);
    const height = defaults.height || Math.min(parentRect.height * 0.72, 560);
    const left = defaults.left ?? Math.max(12, (parentRect.width - width) / 2);
    const top = defaults.top ?? 52;

    Object.assign(panel.style, {
        left: `${left}px`,
        top: `${top}px`,
        right: 'auto',
        bottom: 'auto',
        width: `${width}px`,
        height: `${height}px`,
    });
    panelState.set(panel, { left, top, width, height });
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
function isCompactScreen() {
    return isPhoneLikeEnvironment();
}

function getDefaultPanelOptions(panel) {
    const parentRect = panel?.parentElement?.getBoundingClientRect?.() || { width: window.innerWidth, height: window.innerHeight };
    if (isCompactScreen()) {
        return {
            left: 8,
            top: 44,
            width: Math.max(280, parentRect.width - 16),
            height: Math.max(300, parentRect.height - 58),
        };
    }
    if (panel === fileManager) {
        return { width: Math.min(parentRect.width * 0.72, 820), height: Math.min(parentRect.height * 0.68, 620), left: 16, top: 52 };
    }
    if (panel === dockerPanel) {
        return { width: Math.min(parentRect.width * 0.8, 980), height: Math.min(parentRect.height * 0.72, 660), left: 28, top: 52 };
    }
    if (panel === snippetPanel) {
        return { width: Math.min(460, parentRect.width - 24), height: Math.min(parentRect.height * 0.62, 520), left: 42, top: 64 };
    }
    if (panel === shortcutPanel) {
        return { width: Math.min(420, parentRect.width - 24), height: Math.min(parentRect.height * 0.46, 360), left: 72, top: 74 };
    }
    return { width: Math.min(480, parentRect.width - 24), height: Math.min(parentRect.height * 0.72, 620), top: 52 };
}

function clampPanel(panel) {
    const rect = panel.getBoundingClientRect();
    const parentRect = panel.parentElement.getBoundingClientRect();
    const minVisible = isCompactScreen() ? 140 : 80;
    const left = Math.min(Math.max(rect.left - parentRect.left, -rect.width + minVisible), parentRect.width - minVisible);
    const top = Math.min(Math.max(rect.top - parentRect.top, 8), parentRect.height - minVisible);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
}

function applyPanelLayout(panel, layout) {
    if (!panel) return;
    const parentRect = panel.parentElement.getBoundingClientRect();
    const margin = isCompactScreen() ? 6 : 12;
    const topbar = isCompactScreen() ? 38 : 52;
    let left = margin;
    let top = topbar;
    let width = parentRect.width - margin * 2;
    let height = parentRect.height - topbar - margin;

    if (layout === 'half') {
        width = parentRect.width;
        height = Math.max(260, parentRect.height / 2);
        left = 0;
        top = parentRect.height - height;
    } else if (layout === 'left-quarter') {
        width = Math.max(260, parentRect.width / 4);
        height = parentRect.height - topbar;
        left = 0;
        top = topbar;
    } else if (layout === 'right-quarter') {
        width = Math.max(260, parentRect.width / 4);
        height = parentRect.height - topbar;
        left = parentRect.width - width;
        top = topbar;
    }

    panel.classList.add('layout-animating');
    window.clearTimeout(panel._layoutAnimationTimer);
    Object.assign(panel.style, {
        left: `${left}px`,
        top: `${top}px`,
        right: 'auto',
        bottom: 'auto',
        width: `${width}px`,
        height: `${height}px`,
    });
    bringPanelToFront(panel);
    panel._layoutAnimationTimer = window.setTimeout(() => {
        panel.classList.remove('layout-animating');
        clampPanel(panel);
    }, 480);
}

function hidePanelByElement(panel) {
    if (panel === fileManager) hideFileManager();
    else if (panel === infoModal) hideInfoModal();
    else if (panel === dockerPanel) hideDockerPanel();
    else if (panel === snippetPanel) hideSnippetPanel();
    else if (panel === shortcutPanel) hideShortcutPanel();
}

let panelLayoutMenu = null;
let panelLayoutButton = null;
function positionPanelLayoutMenu(menu, button, { collapsed = false } = {}) {
    if (!menu || !button) return;
    const rect = button.getBoundingClientRect();
    const viewport = window.visualViewport;
    const vvLeft = viewport?.offsetLeft || 0;
    const vvTop = viewport?.offsetTop || 0;
    const vvWidth = viewport?.width || window.innerWidth;
    const vvHeight = viewport?.height || window.innerHeight;
    const anchorX = rect.left + rect.width / 2;
    const finalWidth = Math.min(284, Math.max(160, vvWidth - 16));
    const finalHeight = 50;
    const finalLeft = anchorX - finalWidth / 2;
    const finalTop = rect.top;
    menu.style.left = `${collapsed ? rect.left : finalLeft}px`;
    menu.style.top = `${finalTop}px`;
    menu.style.setProperty('--panel-island-menu-width', `${collapsed ? rect.width : finalWidth}px`);
    menu.style.setProperty('--panel-island-menu-height', `${collapsed ? rect.height : finalHeight}px`);
    menu.style.setProperty('--panel-island-radius', `${Math.round((collapsed ? rect.height : 36) / 2)}px`);
    menu.dataset.placement = 'inline';
}
function closePanelLayoutMenu({ instant = false } = {}) {
    const menu = panelLayoutMenu;
    const button = panelLayoutButton;
    if (!menu) {
        button?.classList.remove('active-layout');
        panelLayoutButton = null;
        return;
    }
    window.clearTimeout(menu._closeTimer);
    if (instant || !button?.isConnected) {
        button?.classList.remove('active-layout');
        button?.style.removeProperty('opacity');
        menu.remove();
        panelLayoutMenu = null;
        panelLayoutButton = null;
        return;
    }
    menu.style.transition = 'none';
    positionPanelLayoutMenu(menu, button, { collapsed: false });
    menu.style.opacity = '1';
    void menu.offsetWidth;
    menu.classList.remove('island-open');
    menu.classList.add('island-closing', 'island-animating');
    button.classList.remove('active-layout');
    button.style.opacity = '0';
    requestAnimationFrame(() => {
        menu.style.removeProperty('transition');
        positionPanelLayoutMenu(menu, button, { collapsed: true });
    });
    menu._closeTimer = window.setTimeout(() => {
        button.classList.remove('active-layout');
        button.style.opacity = '1';
        requestAnimationFrame(() => button.style.removeProperty('opacity'));
        menu.remove();
        if (panelLayoutMenu === menu) panelLayoutMenu = null;
        if (panelLayoutButton === button) panelLayoutButton = null;
    }, 460);
}

function openPanelLayoutMenu(button, panel) {
    closePanelLayoutMenu({ instant: true });
    panelLayoutButton = button;
    button?.classList.remove('active-layout');
    const menu = document.createElement('div');
    menu.className = 'panel-layout-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '窗口布局');
    menu.innerHTML = `
        <button data-layout="full" title="全屏" aria-label="全屏"><span class="panel-layout-icon full"></span></button>
        <button data-layout="half" title="半屏" aria-label="半屏"><span class="panel-layout-icon half"></span></button>
        <button data-layout="left-quarter" title="左侧四分之一" aria-label="左侧四分之一"><span class="panel-layout-icon left"></span></button>
        <button data-layout="right-quarter" title="右侧四分之一" aria-label="右侧四分之一"><span class="panel-layout-icon right"></span></button>
        <button data-layout="close" class="panel-layout-close" title="关闭窗口" aria-label="关闭窗口"><span class="panel-layout-icon close"></span></button>
    `;
    menu.style.transition = 'none';
    document.body.appendChild(menu);
    panelLayoutMenu = menu;
    positionPanelLayoutMenu(menu, button, { collapsed: true });
    button.style.opacity = '0';
    menu.style.opacity = '1';
    menu.classList.add('island-animating');
    void menu.offsetWidth;
    requestAnimationFrame(() => {
        menu.style.removeProperty('transition');
        menu.classList.add('island-open');
        positionPanelLayoutMenu(menu, button, { collapsed: false });
        window.setTimeout(() => {
            menu.classList.remove('island-animating');
            menu.style.removeProperty('opacity');
        }, 540);
    });
    menu.addEventListener('click', (event) => {
        const item = event.target.closest('[data-layout]');
        if (!item) return;
        if (item.dataset.layout === 'close') {
            hidePanelByElement(panel);
            closePanelLayoutMenu({ instant: true });
            return;
        }
        applyPanelLayout(panel, item.dataset.layout);
        closePanelLayoutMenu();
    });
    if (panelLayoutMenu !== menu) panelLayoutMenu = menu;
}

function setupPanelLayoutMenu() {
    document.querySelectorAll('[data-layout-panel]').forEach((button) => {
        const panel = document.getElementById(button.dataset.layoutPanel);
        if (!panel) return;
        button.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            bringPanelToFront(panel);
            button.classList.add('pressing');
            button.setPointerCapture?.(e.pointerId);

            const startX = e.clientX;
            const startY = e.clientY;
            const startLeft = panel.offsetLeft;
            const startTop = panel.offsetTop;
            let moved = false;

            const onMove = (ev) => {
                ev.preventDefault();
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                if (!moved && Math.hypot(dx, dy) > 7) {
                    moved = true;
                    closePanelLayoutMenu({ instant: true });
                    panel.classList.add('dragging');
                }
                if (!moved) return;
                panel.style.left = `${startLeft + dx}px`;
                panel.style.top = `${startTop + dy}px`;
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
                clampPanel(panel);
            };

            const onUp = () => {
                panel.classList.remove('dragging');
                button.classList.remove('pressing');
                suppressNextLayoutClick = moved;
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                window.removeEventListener('pointercancel', onUp);
            };

            window.addEventListener('pointermove', onMove, { passive: false });
            window.addEventListener('pointerup', onUp, { once: true });
            window.addEventListener('pointercancel', onUp, { once: true });
        });
        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (suppressNextLayoutClick) {
                suppressNextLayoutClick = false;
                return;
            }
            bringPanelToFront(panel);
            console.info('[DynamicIslandDiagnostics]', {
                event: 'layout-menu-toggle',
                panelId: panel?.id || '',
                buttonId: button?.id || '',
                open: !panelLayoutMenu,
                suppressNextLayoutClick: false,
            });
            if (navigator.vibrate) navigator.vibrate(8);
            if (panelLayoutMenu && panelLayoutButton === button) closePanelLayoutMenu();
            else openPanelLayoutMenu(button, panel);
        });
    });
    document.addEventListener('pointerdown', (e) => {
        if (panelLayoutMenu && !e.target.closest('.panel-layout-menu') && !e.target.closest('[data-layout-panel]')) {
            closePanelLayoutMenu();
        }
    });
    window.addEventListener('resize', closePanelLayoutMenu);
}

function bringPanelToFront(panel) {
    if (!panel) return;
    const wasFront = panel.classList.contains('front');
    document.querySelectorAll('.file-manager, .info-modal, .docker-panel, .snippet-panel, .shortcut-panel').forEach((p) => {
        p.classList.remove('front');
        if (p !== panel) p.classList.remove('front-switching');
    });
    panel.classList.add('front');
    if (!wasFront) {
        panel.classList.remove('front-switching');
        // 重新触发布局动画：模拟 iPadOS 窗口切到前台时的轻微弹性抬起感。
        void panel.offsetWidth;
        panel.classList.add('front-switching');
        window.clearTimeout(panel._frontSwitchTimer);
        panel._frontSwitchTimer = window.setTimeout(() => {
            panel.classList.remove('front-switching');
        }, 360);
    }
}

function setupFloatingPanel(panel, options) {
    ensureFloatingPanel(panel, options);
    panel.addEventListener('pointerdown', () => bringPanelToFront(panel));
}

function setupPanelDrag() {
    const handles = [
        ...document.querySelectorAll('[data-drag-panel]'),
        ...document.querySelectorAll('.panel-titlebar'),
    ];
    handles.forEach((handle) => {
        const panel = handle.dataset.dragPanel
            ? document.getElementById(handle.dataset.dragPanel)
            : handle.closest('.file-manager, .info-modal, .docker-panel');
        if (!panel) return;
        handle.addEventListener('pointerdown', (e) => {
            if (e.target.closest('button,input,select,textarea,label')) return;
            e.preventDefault();
            bringPanelToFront(panel);
            panel.classList.add('dragging');
            handle.setPointerCapture?.(e.pointerId);
            const startX = e.clientX;
            const startY = e.clientY;
            const startLeft = panel.offsetLeft;
            const startTop = panel.offsetTop;

            const onMove = (ev) => {
                ev.preventDefault();
                panel.style.left = `${startLeft + ev.clientX - startX}px`;
                panel.style.top = `${startTop + ev.clientY - startY}px`;
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
                clampPanel(panel);
            };
            const onUp = () => {
                panel.classList.remove('dragging');
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
            };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp, { once: true });
        });
    });
}

function setupPanelResize() {
    document.querySelectorAll('[data-resize-panel]').forEach((handle) => {
        const panel = document.getElementById(handle.dataset.resizePanel);
        if (!panel) return;
        handle.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            bringPanelToFront(panel);
            panel.classList.add('resizing');
            handle.setPointerCapture?.(e.pointerId);
            const startX = e.clientX;
            const startY = e.clientY;
            const startWidth = panel.offsetWidth;
            const startHeight = panel.offsetHeight;
            const startLeft = panel.offsetLeft;
            const edge = handle.dataset.resizeEdge || 'right';
            const parentRect = panel.parentElement.getBoundingClientRect();
            const compact = isCompactScreen();
            const minWidth = compact ? 260 : (Number(getComputedStyle(panel).minWidth.replace('px', '')) || 420);
            const minHeight = compact ? 240 : (Number(getComputedStyle(panel).minHeight.replace('px', '')) || 320);

            const onMove = (ev) => {
                ev.preventDefault();
                let nextLeft = startLeft;
                let nextWidth = startWidth + ev.clientX - startX;
                if (edge === 'left') {
                    nextWidth = startWidth - (ev.clientX - startX);
                    nextLeft = startLeft + (ev.clientX - startX);
                    if (nextWidth < minWidth) {
                        nextLeft -= minWidth - nextWidth;
                        nextWidth = minWidth;
                    }
                    if (nextLeft < 8) {
                        nextWidth += nextLeft - 8;
                        nextLeft = 8;
                    }
                    panel.style.left = `${nextLeft}px`;
                }
                const maxWidth = edge === 'left' ? startLeft + startWidth - 8 : parentRect.width - panel.offsetLeft - 12;
                const maxHeight = parentRect.height - panel.offsetTop - 12;
                const width = Math.min(Math.max(minWidth, nextWidth), maxWidth);
                const height = Math.min(Math.max(minHeight, startHeight + ev.clientY - startY), maxHeight);
                panel.style.width = `${width}px`;
                panel.style.height = `${height}px`;
            };
            const onUp = () => {
                panel.classList.remove('resizing');
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
            };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp, { once: true });
        });
    });
}

setupFloatingPanel(fileManager, getDefaultPanelOptions(fileManager));
setupFloatingPanel(infoModal, getDefaultPanelOptions(infoModal));
setupFloatingPanel(dockerPanel, getDefaultPanelOptions(dockerPanel));
setupFloatingPanel(snippetPanel, getDefaultPanelOptions(snippetPanel));
setupFloatingPanel(shortcutPanel, getDefaultPanelOptions(shortcutPanel));
setupPanelLayoutMenu();
setupPanelDrag();
setupPanelResize();
setupTerminalInputActivityHooks();
setupMobileKeyboardAvoidance();
setupHorizontalScrollbarVisibility(topbarActions, toolbar);
window.addEventListener('resize', () => {
    setStableViewportHeight();
    [fileManager, infoModal, dockerPanel, snippetPanel, shortcutPanel].forEach((panel) => panel && clampPanel(panel));
    updateViewportInsets();
    logTerminalLayoutDiagnostics('window-resize');
    if (!isTouchKeyboardDevice()) requestStableTerminalLayout('window-resize', { includeResize: true });
});
window.visualViewport?.addEventListener('resize', () => {
    logTerminalLayoutDiagnostics('visual-viewport-resize');
    if (isTouchKeyboardDevice()) updateViewportInsets();
    else requestStableTerminalLayout('visual-viewport-resize', { includeResize: true });
}, { passive: true });
window.visualViewport?.addEventListener('scroll', () => {
    logTerminalLayoutDiagnostics('visual-viewport-scroll');
    if (isTouchKeyboardDevice()) updateViewportInsets();
    else requestStableTerminalLayout('visual-viewport-scroll', { includeResize: true });
}, { passive: true });
window.addEventListener('pageshow', (e) => {
    logTerminalLayoutDiagnostics('pageshow', { persisted: !!e.persisted });
    refreshTerminalAfterVisibilityRestore('pageshow', { focus: true });
    if (!isTouchKeyboardDevice()) scheduleTerminalResize('pageshow-visible', 220);
});
document.addEventListener('visibilitychange', () => {
    logTerminalLayoutDiagnostics('visibilitychange');
    if (document.visibilityState === 'visible') {
        refreshTerminalAfterVisibilityRestore('visibility-visible', { focus: true });
        if (!isTouchKeyboardDevice()) scheduleTerminalResize('visibility-visible', 220);
    }
});

// ---------- 辅助键 / 终端输入 ----------
const modifierState = { ctrl: false, alt: false, shift: false };
const modifierButtons = document.querySelectorAll('.modifier');
function updateModifierUI() {
    modifierButtons.forEach(btn => btn.classList.toggle('active', modifierState[btn.dataset.key]));
}
function processModifiers(data) {
    if (!modifierState.ctrl && !modifierState.alt && !modifierState.shift) return data;
    let result = '';
    for (const ch of data) {
        const code = ch.charCodeAt(0);
        let transformed = ch;
        if (modifierState.ctrl) {
            if (code >= 65 && code <= 90) transformed = String.fromCharCode(code - 64);
            else if (code >= 97 && code <= 122) transformed = String.fromCharCode(code - 96);
        }
        if (modifierState.alt) transformed = '\x1b' + transformed;
        result += transformed;
    }
    return result;
}
function normalizeTerminalInputNewlines(data = '') {
    return String(data).replace(/\r\n/g, '\r').replace(/\n/g, '\r');
}
function logTerminalPasteDiagnostics(source, text = '') {
    const raw = String(text);
    console.info('[TerminalPaste]', {
        source,
        length: raw.length,
        lf: (raw.match(/\n/g) || []).length,
        cr: (raw.match(/\r/g) || []).length,
        preview: raw.slice(0, 120).replace(/\r/g, '\\r').replace(/\n/g, '\\n'),
    });
}

function sendData(data, { normalizeNewlines = false, source = 'unknown', forceFollow = false, applyModifiers = true } = {}) {
    if (wsConnection && wsConnection.readyState === WebSocket.OPEN && isConnected) {
        const fromWTerm = source === 'wterm-onData';
        if (forceFollow) setTerminalAutoFollow(true, `${source}:force-follow`);
        // 官方 SSH 示例中 WTerm onData 只负责把数据发给后端，不参与外层滚动状态机。
        // 本项目仍需 JSON 包装以匹配现有 /ssh 协议，但 payload 保持 WTerm 产生的原始字节序列。
        const payload = fromWTerm ? data : (normalizeNewlines ? normalizeTerminalInputNewlines(data) : data);
        const input = fromWTerm || !applyModifiers ? payload : processModifiers(payload);
        wsConnection.send(JSON.stringify({ type: 'input', data: input }));
        if (forceFollow) requestTerminalAutoFollow(`${source}:sent`);
        else scheduleTerminalScrollbarUpdate();
    }
}
function preserveTerminalScrollWhileEditingCommandInput(reason = 'command-input-edit', callback = () => {}) {
    const el = getTerminalScrollElement();
    const shouldPreserve = Boolean(el && !isTerminalAtBottom(el));
    const previousTop = shouldPreserve ? el.scrollTop : 0;
    try {
        callback();
    } finally {
        if (shouldPreserve) {
            const restore = () => {
                el.scrollTop = previousTop;
                scheduleTerminalScrollbarUpdate();
                logTerminalScrollDiagnostics('command-input:preserve-after', {
                    reason,
                    scrollTop: Math.round(el.scrollTop),
                    bottomDistance: Math.round(getTerminalBottomDistance(el)),
                });
            };
            restore();
            requestAnimationFrame(restore);
        }
    }
}

function resizeCommandInput() {
    if (!cmdInput) return;
    cmdInput.style.height = 'auto';
    const maxHeight = parseFloat(getComputedStyle(cmdInput).maxHeight) || 112;
    cmdInput.style.height = `${Math.min(maxHeight, Math.max(34, cmdInput.scrollHeight))}px`;
}
function sendCommand() {
    const text = cmdInput.value;
    if (text && wsConnection && wsConnection.readyState === WebSocket.OPEN && isConnected) {
        logTerminalPasteDiagnostics('command-box-send', text);
        sendData(text + '\r', { normalizeNewlines: true, source: 'command-box-send' });
    }
    cmdInput.value = '';
    resizeCommandInput();
}
cmdInput.addEventListener('input', () => {
    preserveTerminalScrollWhileEditingCommandInput('cmdInput-input', resizeCommandInput);
});
cmdInput.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text/plain') || '';
    if (!text.includes('\n') && !text.includes('\r')) {
        window.setTimeout(resizeCommandInput, 0);
        return;
    }
    e.preventDefault();
    logTerminalPasteDiagnostics('command-box-paste', text);
    const { selectionStart, selectionEnd, value } = cmdInput;
    cmdInput.value = value.slice(0, selectionStart) + text + value.slice(selectionEnd);
    const nextPos = selectionStart + text.length;
    cmdInput.selectionStart = cmdInput.selectionEnd = nextPos;
    resizeCommandInput();
});
cmdInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.shiftKey) {
        window.setTimeout(resizeCommandInput, 0);
        return;
    }
    e.preventDefault();
    sendCommand();
});
cmdSendBtn.addEventListener('click', sendCommand);
resizeCommandInput();

document.querySelectorAll('.func, .arrow, .combo, .modifier').forEach(btn => {
    btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        if (btn.classList.contains('modifier')) { modifierState[key] = !modifierState[key]; updateModifierUI(); return; }
        if (keySequences[key]) sendData(keySequences[key], { source: 'keypad', forceFollow: true });
        if (comboSequences[key]) sendData(comboSequences[key], { source: 'keypad', forceFollow: true });
    });
});

const keySequences = {
    esc: '\x1b', tab: '\t', home: '\x1b[1~', end: '\x1b[4~',
    up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C',
    f1: '\x1bOP', f2: '\x1bOQ', f3: '\x1bOR', f4: '\x1bOS',
    f5: '\x1b[15~', f6: '\x1b[17~', f7: '\x1b[18~', f8: '\x1b[19~',
    f9: '\x1b[20~', f10: '\x1b[21~', f11: '\x1b[23~', f12: '\x1b[24~',
};
const comboSequences = Object.fromEntries('abcdefghijklmnopqrstuvwxyz'.split('').map((ch) => [`ctrl-${ch}`, String.fromCharCode(ch.charCodeAt(0) - 96)]));

// 保留选区
wtermWrapper.addEventListener('mouseup', () => {
    const selection = window.getSelection();
    if (mobileTerminalSelectionMode || selection?.toString?.().length > 0 || isTouchKeyboardDevice()) return;
    term?.focus?.();
});
async function pasteClipboardIntoTerminal(source = 'terminal-contextmenu') {
    let text = '';
    try {
        text = await navigator.clipboard?.readText?.() || '';
    } catch (err) {
        console.warn('[terminal-paste]', 'clipboard read failed', err);
    }
    if (!text) return false;
    logTerminalPasteDiagnostics(source, text);
    sendData(prepareTerminalPastePayload(text), { source, forceFollow: true, applyModifiers: false });
    if (!isTouchKeyboardDevice()) {
        try { term?.focus?.(); } catch (_) {}
    }
    return true;
}

function prepareTerminalPastePayload(text = '') {
    const raw = String(text);
    const bridge = term?.bridge;
    try {
        if (bridge?.bracketedPaste?.()) {
            return '\x1b[200~' + raw.replace(/\x1b/g, '') + '\x1b[201~';
        }
    } catch (_) {}
    return raw;
}

function terminalPointerCellFromEvent(e) {
    if (!wtermWrapper) return null;
    const rect = wtermWrapper.getBoundingClientRect();
    const style = getComputedStyle(wtermWrapper);
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const { lineHeight, charWidth } = getTerminalCharMetrics();
    const x = (e.clientX ?? e.touches?.[0]?.clientX ?? 0) - rect.left - paddingLeft;
    const y = (e.clientY ?? e.touches?.[0]?.clientY ?? 0) - rect.top - paddingTop + (wtermWrapper.scrollTop || 0);
    const col = Math.max(0, Math.min(Number(term?.cols || 80) - 1, Math.floor(x / Math.max(1, charWidth))));
    const absoluteRow = Math.max(0, Math.floor(y / Math.max(1, lineHeight)));
    const scrollback = Number(term?.bridge?.getScrollbackCount?.() || 0);
    const row = Math.max(0, Math.min(Number(term?.rows || 24) - 1, absoluteRow - scrollback));
    return { col, row };
}

function encodeSgrMouse(button, col, row, suffix = 'M') {
    return `\x1b[<${button};${col + 1};${row + 1}${suffix}`;
}

function updateTerminalMouseTrackingFromData(data = '') {
    const text = String(data || '');
    if (!text.includes('\x1b[')) return;
    const re = /\x1b\[\?([0-9;]+)([hl])/g;
    let match;
    while ((match = re.exec(text))) {
        const params = match[1].split(';').map(Number);
        const enable = match[2] === 'h';
        for (const p of params) {
            if (p === 1006) terminalMouseState.sgr = enable;
            if (p === 1000 || p === 1002 || p === 1003) {
                terminalMouseState.enabled = enable;
                terminalMouseState.mode = enable ? String(p) : 'none';
            }
        }
    }
    terminalContainer?.classList.toggle('terminal-mouse-mode', terminalMouseState.enabled);
}

function terminalMouseTrackingEnabled() {
    return !!terminalMouseState.enabled && !!terminalMouseState.sgr;
}

function sendTerminalMouseEvent(e, kind = 'press') {
    if (!terminalMouseTrackingEnabled()) return false;
    const cell = terminalPointerCellFromEvent(e);
    if (!cell) return false;
    const base = e.button === 2 ? 2 : e.button === 1 ? 1 : 0;
    let button = kind === 'release' ? 3 : base;
    if (e.shiftKey) button += 4;
    if (e.altKey) button += 8;
    if (e.ctrlKey) button += 16;
    if (kind === 'move') button = 32 + (terminalMouseState.buttonDown ? base : 3);
    if (kind === 'press') terminalMouseState.buttonDown = true;
    if (kind === 'release') terminalMouseState.buttonDown = false;
    sendData(encodeSgrMouse(button, cell.col, cell.row, kind === 'release' ? 'm' : 'M'), { source: 'mouse-sgr', applyModifiers: false });
    return true;
}

function sendTerminalMouseWheelEvent(e) {
    if (!terminalMouseTrackingEnabled()) return false;
    const cell = terminalPointerCellFromEvent(e);
    if (!cell) return false;
    const button = e.deltaY < 0 ? 64 : 65;
    sendData(encodeSgrMouse(button, cell.col, cell.row, 'M'), { source: 'mouse-wheel-sgr', applyModifiers: false });
    return true;
}

function updateTerminalWebLinks() {
    // 只给整行纯文本输出做链接化；如果 wterm 已经用 span 渲染颜色/样式，绝不重写 DOM，避免破坏 ANSI 颜色和复制。
    if (!wtermWrapper || updateTerminalWebLinks._raf) return;
    updateTerminalWebLinks._raf = requestAnimationFrame(() => {
        updateTerminalWebLinks._raf = 0;
        const rows = wtermWrapper.querySelectorAll?.('.term-row, .term-scrollback-row') || [];
        rows.forEach((row) => {
            const text = row.textContent || '';
            if (row.dataset.zephyrLinks === '1' && row.dataset.zephyrLinkText === text) return;
            if (row.dataset.zephyrLinks === '1' && row.dataset.zephyrLinkText !== text) {
                delete row.dataset.zephyrLinks;
                delete row.dataset.zephyrLinkText;
            }
            if (row.children.length > 0) return;
            TERMINAL_LINK_PROTOCOL_RE.lastIndex = 0;
            if (!TERMINAL_LINK_PROTOCOL_RE.test(text)) return;
            TERMINAL_LINK_PROTOCOL_RE.lastIndex = 0;
            const frag = document.createDocumentFragment();
            let last = 0;
            let match;
            while ((match = TERMINAL_LINK_PROTOCOL_RE.exec(text))) {
                const start = match.index;
                const url = match[0].replace(/[),.;:!?]+$/g, '');
                if (start > last) frag.appendChild(document.createTextNode(text.slice(last, start)));
                const a = document.createElement('a');
                a.className = 'terminal-link';
                a.href = url;
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                a.textContent = url;
                frag.appendChild(a);
                last = start + url.length;
                if (url.length < match[0].length) frag.appendChild(document.createTextNode(match[0].slice(url.length)));
            }
            if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
            row.textContent = '';
            row.appendChild(frag);
            row.dataset.zephyrLinks = '1';
            row.dataset.zephyrLinkText = text;
        });
    });
}

wtermWrapper.addEventListener('contextmenu', async (e) => {
    const selection = window.getSelection();
    if (selection?.toString?.().length > 0) return;
    if (terminalMouseTrackingEnabled()) {
        sendTerminalMouseEvent(e, 'press');
        return;
    }
    e.preventDefault();
    const ok = await pasteClipboardIntoTerminal('terminal-right-click-paste');
    if (!ok) console.info('[terminal-paste]', '右键粘贴需要浏览器剪贴板权限或非空文本剪贴板');
});
 // 粘贴交给 @wterm/dom 官方 InputHandler 处理：
 // - 支持 bracketed paste；
 // - 在 onData 前执行 WTerm 内置输入滚动；
 // - 避免外层捕获 paste 后强制滚到底。
['pointerdown', 'touchstart'].forEach((eventName) => {
    wtermWrapper.addEventListener(eventName, (e) => {
        terminalTouchMoved = false;
        terminalTouchStartX = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
        terminalTouchStartY = e.clientY ?? e.touches?.[0]?.clientY ?? 0;
        scheduleMobileLongPressSelectionGuard(eventName);
        logTerminalCopyDiagnostics('wterm-wrapper-touch-start', {
            eventName,
            pointerType: e.pointerType || '',
            touches: e.touches?.length || 0,
        });

        window.clearTimeout(terminalTouchFocusTimer);
        if (eventName === 'pointerdown' && e.pointerType !== 'touch' && !hasLiveTerminalSelection() && sendTerminalMouseEvent(e, 'press')) {
            e.preventDefault();
            return;
        }
        terminalTouchFocusTimer = window.setTimeout(() => {
            const hasSelection = hasLiveTerminalSelection();
            if (mobileTerminalSelectionMode || terminalTouchMoved || hasSelection) {
                if (hasSelection) enterMobileTerminalSelectionMode('touch-has-selection');
                notifyParentActivity();
                return;
            }
            if (isTouchKeyboardDevice() && !mobileKeyboardUserControlled) {
                notifyParentActivity();
                return;
            }
            if (isTouchKeyboardDevice()) {
                notifyParentActivity();
                return;
            }
            try { term?.focus?.(); } catch (_) {}
            notifyParentActivity();
        }, 180);
    }, { passive: true });
});

['pointermove', 'touchmove'].forEach((eventName) => {
    wtermWrapper.addEventListener(eventName, (e) => {
        const x = e.clientX ?? e.touches?.[0]?.clientX ?? terminalTouchStartX;
        const y = e.clientY ?? e.touches?.[0]?.clientY ?? terminalTouchStartY;
        if (Math.hypot(x - terminalTouchStartX, y - terminalTouchStartY) > 8) {
            terminalTouchMoved = true;
            if (eventName === 'pointermove' && e.pointerType !== 'touch' && terminalMouseState.buttonDown && sendTerminalMouseEvent(e, 'move')) {
                e.preventDefault();
            }
            window.clearTimeout(terminalTouchFocusTimer);
            window.clearTimeout(mobileTerminalSelectionTimer);
        }
    }, { passive: true });
});

['pointerup', 'touchend', 'touchcancel'].forEach((eventName) => {
    wtermWrapper.addEventListener(eventName, (e) => {
        if (eventName === 'pointerup' && e.pointerType !== 'touch' && sendTerminalMouseEvent(e, 'release')) {
            e.preventDefault();
        }
        window.clearTimeout(mobileTerminalSelectionTimer);
        window.setTimeout(() => {
            if (hasLiveTerminalSelection()) enterMobileTerminalSelectionMode(eventName);
            else if (mobileTerminalSelectionMode) scheduleExitMobileTerminalSelectionMode(900);
        }, 80);
    }, { passive: true });
});

// ---------- 状态指示 ----------
function setStatus(state, msg) {
    notifyParentStatus(state === 'connected' ? 'connected' : state === 'error' ? 'error' : state === 'disconnected' ? 'closed' : 'connecting');
    statusDot.className = 'status-dot';
    if (state === 'connecting') {
        statusText.textContent = msg || '连接中...';
        terminalOverlay.classList.remove('hidden');
        overlayMsg.textContent = msg || '正在建立 SSH 连接...';
    } else if (state === 'connected') {
        statusDot.classList.add('connected');
        statusText.textContent = msg || '已连接';
        terminalOverlay.classList.add('hidden');
        isConnected = true;
    } else if (state === 'disconnected') {
        statusDot.classList.add('disconnected');
        statusText.textContent = msg || '已断开';
        isConnected = false;
        terminalOverlay.classList.remove('hidden');
        overlayMsg.textContent = msg || '连接已断开';
    } else if (state === 'error') {
        statusDot.classList.add('disconnected');
        statusText.textContent = '错误';
        isConnected = false;
        terminalOverlay.classList.remove('hidden');
        overlayMsg.textContent = msg || '连接出错';
    }
}
connInfo.textContent = `${params.username}@${params.host}:${params.port}`;

function clearReconnectTimer() {
    if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = 0;
    }
}

function stopTerminalResizeObserver() {
    terminalResizeCleanup?.();
    terminalResizeCleanup = null;
    window.clearTimeout(scheduleTerminalResize._timer);
    window.clearTimeout(pendingTerminalResize.timer);
    pendingTerminalResize = { cols: 0, rows: 0, timer: 0, reason: '' };
}

function refreshTerminalAfterVisibilityRestore(reason = 'visibility-restore', { focus = false } = {}) {
    if (!term || !wtermWrapper || document.visibilityState !== 'visible') return;
    const wasAtBottom = Boolean(term._isScrolledToBottom ? term._isScrolledToBottom() : isTerminalAtBottom());
    const run = (phase) => {
        if (!term || !wtermWrapper || document.visibilityState !== 'visible' || !isEmbeddedTerminalFrameVisible()) return;
        normalizeWTermContainerLayout(`${reason}:${phase}:before`);
        const rect = getStableTerminalSurfaceRect();
        if (!rect || rect.width < TERMINAL_MIN_RESIZE_WIDTH || rect.height < TERMINAL_MIN_RESIZE_HEIGHT || wtermWrapper.offsetParent === null) {
            logTerminalLayoutDiagnostics('restore:skip-hidden-or-tiny', { reason, phase, width: Math.round(rect?.width || 0), height: Math.round(rect?.height || 0) });
            return;
        }
        repairWTermLayoutAfterVisibilityChange(`${reason}:${phase}`, { follow: wasAtBottom });
        scheduleTerminalScrollbarUpdate();
        if (focus && !isTouchKeyboardDevice()) {
            try { term.focus?.(); } catch (_) {}
        }
    };
    [0, 60, 160, 360, 720, 1200].forEach((delay, index) => window.setTimeout(() => run(`phase-${index}`), delay));
}

function resetTerminalScrollState() {
    isProgrammaticTerminalScroll = false;
    terminalAutoFollowEnabled = true;
    terminalUserScrolledAway = false;
    terminalLastUserScrollAt = 0;
    terminalLastWheelAt = 0;
    parentKeyboardResizeFreezeUntil = 0;
    terminalMouseState.enabled = false;
    terminalMouseState.sgr = false;
    terminalMouseState.mode = 'none';
    terminalMouseState.buttonDown = false;
    terminalContainer?.classList.remove('terminal-follow-paused', 'terminal-mouse-mode');
    terminalContainer?.classList.add('terminal-following');
}

function destroyTerminalInstance({ clear = true } = {}) {
    stopTerminalAutoScrollObserver();
    stopTerminalResizeObserver();
    if (term) {
        try { term.destroy?.(); } catch (_) {}
        term = null;
    }
    resetTerminalScrollState();
    if (clear) wtermWrapper.innerHTML = '';
}

function closeWebSocketOnly(reason = '重建连接', { sendDisconnect = false } = {}) {
    const ws = wsConnection;
    wsConnection = null;
    if (!ws) return;
    try {
        if (sendDisconnect && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'disconnect' }));
    } catch (_) {}
    try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000, reason);
    } catch (_) {}
}

function disconnect({ userInitiated = true, updateStatus = true, destroyTerminal = true } = {}) {
    userClosedConnection = userInitiated;
    reconnectInProgress = false;
    clearReconnectTimer();
    activeConnectionToken += 1;
    closeWebSocketOnly(userInitiated ? '用户主动断开' : '重建连接', { sendDisconnect: userInitiated });
    if (destroyTerminal) destroyTerminalInstance();
    isConnected = false;
    sftpReady = false;
    if (updateStatus) setStatus('disconnected', '已断开');
}

function syncFeaturePanelsAfterConnection() {
    // 重置所有特性状态
    sftpReady = false;
    dockerChecked = false;
    dockerInstalled = false;
    dockerCurrentLogContainer = null;
    dockerLogBuffer = '';
    dockerAutoScrollLog = true;
    if (dockerLogDrawer) dockerLogDrawer.style.display = 'none';
    if (dockerPullBtn) dockerPullBtn.disabled = false;
    
    // 现在重新初始化打开的面板
    if (fileManager?.classList.contains('open')) {
        initSFTP();
    }
    if (dockerPanel?.classList.contains('open')) {
        checkDockerStatus({ force: true });
    }
    
    // 确保桌面端终端获得焦点并可见；移动端只能通过键盘按钮唤起输入法。
    setTimeout(() => {
        if (!isTouchKeyboardDevice() && term && typeof term.focus === 'function') {
            try { term.focus(); } catch (_) {}
        }
    }, 100);
}

function sleep(ms) {
    return new Promise((resolve) => { reconnectTimer = window.setTimeout(resolve, ms); });
}

async function startFreshConnection({ message = '正在建立 SSH 连接...', resetAttempts = false, followOnConnect = true } = {}) {
    clearReconnectTimer();
    userClosedConnection = false;
    activeConnectionToken += 1;
    const token = activeConnectionToken;
    closeWebSocketOnly('重建连接');
    destroyTerminalInstance();
    setStatus('connecting', message);
    if (resetAttempts) reconnectAttempts = 0;
    await initWTerm(token, { followOnConnect });
    await connectWebSocket(token, { followOnConnect });
    if (token !== activeConnectionToken) throw new Error('连接已被新的会话替换');
    syncFeaturePanelsAfterConnection();
    if (!isTouchKeyboardDevice()) scheduleTerminalResize();
}

async function startAutoReconnect(reason = '连接已断开') {
    if (userClosedConnection || reconnectInProgress) return;
    reconnectInProgress = true;
    while (!userClosedConnection && !isConnected && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts += 1;
        const label = `正在重连 (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`;
        setStatus('connecting', label);
        showToast(`${reason}，${label}`, 'info', 2200);
        try {
            await sleep(2000);
            reconnectTimer = 0;
            if (userClosedConnection || isConnected) break;
            await startFreshConnection({ message: label, resetAttempts: false, followOnConnect: false });
            reconnectAttempts = 0;
            reconnectInProgress = false;
            showToast('自动重连成功', 'success');
            return;
        } catch (err) {
            reconnectTimer = 0;
            if (userClosedConnection || isConnected) break;
            console.warn('[SSH] 自动重连失败:', err.message);
        }
    }
    reconnectInProgress = false;
    if (!userClosedConnection && !isConnected) {
        setStatus('error', '自动重连失败，请手动点击“重连”');
        showToast('自动重连失败，请手动点击“重连”', 'error', 4200);
    }
}

// ---------- WTerm 初始化 ----------
async function initWTerm(connectionToken = activeConnectionToken, { followOnConnect = true } = {}) {
    mobileWTermInputGuard = null;
    let WTermClass;
    try {
        const module = await import('/vendor/@wterm/dom/dist/index.js');
        WTermClass = module.WTerm;
    } catch {
        const module = await import('/vendor/@wterm/dom/dist/wterm.js');
        WTermClass = module.WTerm || module.default;
    }
    if (connectionToken !== activeConnectionToken) throw new Error('终端初始化已取消');
    wtermWrapper.innerHTML = '';
    normalizeWTermContainerLayout('init-before-create');
    try {
        term = new WTermClass(wtermWrapper, {
            cols: 80,
            rows: 24,
            // 滚动逻辑完全交给 @wterm/dom 官方 write()/InputHandler；
            // resize 仍由项目层在“可见且尺寸稳定”时手动转发到 ssh2，避免隐藏 iframe/iOS 恢复时的 0px 瞬时尺寸破坏 PTY。
            autoResize: false,
            cursorBlink: true,
            theme: getPreferredWtermTheme() === 'light' ? 'light' : 'default',
            fontSize: terminalFontSize,
            onData: (data) => sendData(data, { source: 'wterm-onData' }),
            onResize: (cols, rows) => {
                if (!suppressWTermResizeEvent) sendTerminalResize(cols, rows, { reason: 'wterm-onResize' });
            },
        });
    } catch {
        term = new WTermClass(wtermWrapper);
        if (typeof term.onData === 'function') term.onData(data => sendData(data, { source: 'wterm-onData' }));
        else if (typeof term.on === 'function') term.on('data', data => sendData(data, { source: 'wterm-onData' }));
    }
    if (typeof term.init === 'function') await term.init();
    normalizeWTermContainerLayout('init-after-wterm-init');
    if (connectionToken !== activeConnectionToken) throw new Error('终端初始化已取消');
    lastSentTerminalSize = { cols: Number(term.cols || 80), rows: Number(term.rows || 24) };
    applyWtermTheme(getPreferredWtermTheme());
    applyTerminalFontSize(terminalFontSize, { persist: false });
    patchWTermScrollBehavior();
    restoreMobileWTermNativeInput();

    // 滚动逻辑使用 @wterm/dom 官方实现；项目层只在 iframe/页面可见且尺寸稳定时调用 term.resize，并同步 ssh2 setWindow。
    terminalResizeCleanup = setupStableTerminalResizeObserver();
    scheduleTerminalResize('initial-visible-resize', 80);
    setupTerminalScrollHooks({ followOnConnect });
}

// ---------- WebSocket 连接 ----------
function connectWebSocket(connectionToken = activeConnectionToken, { followOnConnect = true } = {}) {
    writeTerminalData._mobileFirstDataFlushed = false;
    return new Promise((resolve, reject) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${proto}//${location.host}/ssh`);
        let settled = false;
        let ready = false;
        const fail = (err) => {
            if (settled) return;
            settled = true;
            reject(err instanceof Error ? err : new Error(String(err || '连接失败')));
        };
        const timeout = setTimeout(() => {
            try { ws.close(); } catch (_) {}
            fail(new Error('连接超时'));
        }, 10000);

        ws.addEventListener('open', () => {
            if (connectionToken !== activeConnectionToken) { try { ws.close(); } catch (_) {} return; }
            clearTimeout(timeout);
            const initialSize = getInitialTerminalSize();
            ws.send(JSON.stringify({
                type: 'connect',
                sessionId: params.tabId || params.sessionId || params.connectionId || '',
                connectionId: params.connectionId || '',
                host: params.host,
                port: params.port,
                username: params.username,
                password: params.password || '',
                privateKey: params.privateKey || '',
                init: params.init || '',
                cols: initialSize.cols,
                rows: initialSize.rows
            }));
        });

        ws.addEventListener('message', (event) => {
            if (connectionToken !== activeConnectionToken) return;
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'stats') { renderStats(msg.data); return; }
                if (msg.type === 'stats-error') {
                    if (infoBody && (!latestStatsData || infoBody.querySelector('.info-loading'))) {
                        infoBody.innerHTML = `<div class="info-loading error">实时监控数据加载失败：${escapeHtml(msg.message || '未知错误')}</div>`;
                    }
                    return;
                }
                if (msg.type?.startsWith('sftp-')) { handleSFTPMessage(msg); return; }
                if (msg.type?.startsWith('docker-')) { handleDockerMessage(msg); return; }
                switch (msg.type) {
                    case 'ready':
                        ready = true;
                        settled = true;
                        if (msg.cols && msg.rows) {
                            const readyCols = Math.floor(Number(msg.cols));
                            const readyRows = Math.floor(Number(msg.rows));
                            if (Number.isFinite(readyCols) && Number.isFinite(readyRows) && readyCols >= 20 && readyRows >= 2) {
                                const measured = getInitialTerminalSize();
                                const sameAsCurrentView = Math.abs(measured.cols - readyCols) <= 1 && Math.abs(measured.rows - readyRows) <= 1;
                                const attachedReady = !!msg.attached;
                                lastSentTerminalSize = { cols: readyCols, rows: readyRows };
                                if (attachedReady || sameAsCurrentView) resizeWTermSafely(readyCols, readyRows, attachedReady ? 'attach-existing-pty' : 'ready-pty');
                            }
                        }
                        setStatus('connected', '已连接');
                        window.setTimeout(() => repairOversizedWTermRows('ready-oversized-rows', { force: true }), 120);
                        if (!isTouchKeyboardDevice() && term?.focus) term.focus();
                        reconnectAttempts = 0;
                        if (followOnConnect) {
                            requestAnimationFrame(() => {
                                if (term?._zephyrOriginalScrollToBottom) {
                                    isProgrammaticTerminalScroll = true;
                                    try { term._zephyrOriginalScrollToBottom(); } catch (_) {}
                                    finally { requestAnimationFrame(() => { isProgrammaticTerminalScroll = false; }); }
                                }
                                scheduleTerminalScrollbarUpdate();
                            });
                        } else {
                            scheduleTerminalScrollbarUpdate();
                        }
                        requestInitialMobileRenderFlush('connect-ready');
                        resolve(ws);
                        break;
                    case 'data':
                        writeTerminalData(msg.data);
                        if (isTouchKeyboardDevice() && !writeTerminalData._mobileFirstDataFlushed) {
                            writeTerminalData._mobileFirstDataFlushed = true;
                            requestInitialMobileRenderFlush('first-data');
                        }
                        break;
                    case 'error':
                        setStatus('error', msg.message);
                        fail(new Error(msg.message));
                        break;
                    case 'close':
                        setStatus('disconnected', msg.message || '会话已关闭');
                        if (!userClosedConnection) {
                            try { ws.close(4000, 'SSH 会话关闭'); } catch (_) {}
                            startAutoReconnect(msg.message || 'SSH 会话已关闭');
                        } else if (embeddedMode) {
                            notifyParentCloseRequest('ssh-session-close');
                        }
                        break;
                    case 'banner':
                        writeTerminalData(msg.data);
                        break;
                }
            } catch (_) {}
        });

        ws.addEventListener('error', () => clearTimeout(timeout));
        ws.addEventListener('close', (e) => {
            clearTimeout(timeout);
            if (connectionToken !== activeConnectionToken) return;
            if (wsConnection === ws) wsConnection = null;
            if (!ready) {
                fail(new Error(`连接已关闭 (${e.code || 'N/A'})`));
                return;
            }
            if (isConnected) setStatus('disconnected', `断开 (${e.code})`);
            if (!userClosedConnection) {
                startAutoReconnect(`连接已断开 (${e.code || 'N/A'})`);
            } else if (embeddedMode) {
                notifyParentCloseRequest(`websocket-close-${e.code || 'N/A'}`);
            }
        });

        if (connectionToken === activeConnectionToken) wsConnection = ws;
        else { try { ws.close(); } catch (_) {} }
    });
}

async function reconnect() {
    if (reconnectInProgress) return;
    reconnectInProgress = true;
    reconnectBtn.disabled = true;
    try {
        await startFreshConnection({ message: '正在重连...', resetAttempts: true });
        showToast('重连成功', 'success');
    } catch (err) {
        setStatus('error', err.message);
        showToast(`重连失败：${err.message}`, 'error', 4200);
    } finally {
        reconnectInProgress = false;
        reconnectBtn.disabled = false;
    }
}

async function main() {
    try {
        await startFreshConnection({ message: '正在初始化终端...', resetAttempts: true });
    } catch (err) {
        setStatus('error', err.message);
        startAutoReconnect(err.message);
    }
}

reconnectBtn.addEventListener('click', reconnect);

// ---------- 移动端软键盘处理 ----------
function handleKeyboardShow() {
    updateViewportInsets();
}

function handleKeyboardHide() {
    finalizeKeyboardClose({ force: true });
    notifyParentKeyboardMetrics(getViewportKeyboardMetrics());
}

if (typeof visualViewport !== 'undefined') {
    // 监听已在 setupMobileKeyboardAvoidance 中统一注册，避免重复触发布局更新造成跳动。
}

window.addEventListener('orientationchange', () => {
    setTimeout(() => {
        setStableViewportHeight({ force: true });
        handleKeyboardHide();
        if (!isTouchKeyboardDevice()) scheduleTerminalResize();
    }, 300);
});
disconnectBtn.addEventListener('click', () => {
    disconnect({ userInitiated: true });
    sessionStorage.removeItem(params?.tabId ? `zephyr_ssh_params_${params.tabId}` : 'zephyr_ssh_params');
    if (embeddedMode) {
        notifyParentStatus('closed');
        notifyParentCloseRequest('user-disconnect-button');
        document.body.innerHTML = '<div class="terminal-placeholder" style="padding:24px;color:#8b949e">会话已断开，正在关闭此终端窗口...</div>';
    } else {
        window.location.href = '/';
    }
});
window.addEventListener('beforeunload', () => {
    userClosedConnection = true;
    clearReconnectTimer();
    closeWebSocketOnly('页面卸载', { sendDisconnect: false });
});

main();