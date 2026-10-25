import { Motion as ZephyrWasmMotion } from '../zephyr-motion/index.js?v=20261019-ui122';
if (typeof window !== 'undefined' && ZephyrWasmMotion) { window.Motion = ZephyrWasmMotion; }
/* ══════════════════════════════════════════════════════════════════════════
 * public/vendor/zephyr-pro/app-continuity-guard-pro.js
 *
 * Implements Plan Chapters 4.3, 5 (5.1~5.7), 6.1.1, 7.2.2, 10.5 & 10.6:
 *  1. 5.1 & 5.6: `resolveActiveSurfaceMode()` & `isPadLandscapeSurface()`
 *     (`smallestScreenWidth >= 600` Pad landscape 1:1 Desktop UI + draggable
 *      `.floating-modifier-capsule`)
 *  2. 5.3 & 5.4: `MOBILE_SHEET_DETENTS` & `BottomSheetController` (3-detent
 *     draggable Bottom Sheet + `visualViewport` IME auto-promotion)
 *  3. 5.7: `ZephyrHaptics` 7-level tactile feedback engine (`navigator.vibrate` +
 *     iOS 17.4+/18+ hidden `<input type="checkbox" switch>` Taptic bridge)
 *  4. 4.3 #1: `parseSshConfigAndAutoLink()` & Dashboard `~/.ssh/config` drag/paste
 *     inline 1-click import with automatic `ProxyJump` chain linking
 *  5. 6.1.1: Mobile RDP/VNC `SmartDot` two-stage tap state machine (`barsHidden` ->
 *     1st tap reveals bars, 2nd tap expands `Smartbar`) + Landscape & Trackpad toggle
 *  6. 10.5 & 10.6: `ZephyrGuard` Tier 1 deterministic regex/AST/Shannon-entropy
 *     local security engine + `SecretVaultRehydrator` (Pre-Tool-Execution JIT
 *     rehydration & output reverse scrubbing) + Notes plaintext secret warning pill +
 *     Indirect Prompt Injection scanner + Background Privacy Shield
 * ══════════════════════════════════════════════════════════════════════════ */

/* ── 1. 5.7 ZephyrHaptics (7-Level Tactile Feedback System) ─────────────── */
export const ZephyrHapticPattern = {
  SELECTION_TICK: [4],
  LIGHT_IMPACT: [8],
  MEDIUM_IMPACT: [14],
  HEAVY_IMPACT: [22],
  SUCCESS: [8, 40, 12],
  WARNING: [14, 50, 14],
  ERROR: [18, 40, 18, 40, 24],
};

let iosSwitchInput = null;
function triggerIosSwitchHaptic() {
  if (typeof document === 'undefined') return;
  try {
    if (!iosSwitchInput) {
      const label = document.createElement('label');
      label.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
      label.setAttribute('aria-hidden', 'true');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('switch', '');
      label.appendChild(input);
      document.body.appendChild(label);
      iosSwitchInput = { label, input };
    }
    iosSwitchInput.label.click();
  } catch {}
}

export const ZephyrHaptics = {
  enabled: true,
  fire(pattern = ZephyrHapticPattern.LIGHT_IMPACT) {
    if (!this.enabled) return;
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return;
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        navigator.vibrate(pattern);
        return;
      }
    } catch {}
    triggerIosSwitchHaptic();
  },
  selectionTick() { this.fire(ZephyrHapticPattern.SELECTION_TICK); },
  lightImpact() { this.fire(ZephyrHapticPattern.LIGHT_IMPACT); },
  mediumImpact() { this.fire(ZephyrHapticPattern.MEDIUM_IMPACT); },
  heavyImpact() { this.fire(ZephyrHapticPattern.HEAVY_IMPACT); },
  success() { this.fire(ZephyrHapticPattern.SUCCESS); },
  warning() { this.fire(ZephyrHapticPattern.WARNING); },
  error() { this.fire(ZephyrHapticPattern.ERROR); },
};

/* ── 2. 5.1 & 5.6 Surface Mode & Pad Landscape 1:1 Desktop Shell ───────── */
export function isPadLandscapeSurface(win = typeof window !== 'undefined' ? window : null) {
  if (!win) return false;
  const sw = win.screen?.width || win.innerWidth || 0;
  const sh = win.screen?.height || win.innerHeight || 0;
  const shortEdge = Math.min(sw, sh);
  return shortEdge >= 600 && win.innerWidth > win.innerHeight && win.innerWidth >= 840;
}

export function resolveActiveSurfaceMode(win = typeof window !== 'undefined' ? window : null) {
  if (!win) return 'desktop';
  try {
    const params = new URLSearchParams(win.location?.search || '');
    const explicit = params.get('desktop') === '1' ? 'desktop'
      : params.get('mobile') === '1' ? 'mobile'
      : params.get('surface');
    if (explicit === 'desktop' || explicit === 'mobile') {
      try { win.sessionStorage?.setItem('zephyr_surface_mode', explicit); } catch {}
      return explicit;
    }
  } catch {}
  try {
    const saved = win.sessionStorage?.getItem('zephyr_surface_mode')
      || win.localStorage?.getItem('zephyr_prefer_surface');
    if (saved === 'desktop' || saved === 'mobile') return saved;
  } catch {}
  // 5.6: Pad / Foldable unfolded (shortEdge >= 600) in landscape uses 1:1 Desktop UI
  if (isPadLandscapeSurface(win)) return 'desktop';
  const ua = (win.navigator && win.navigator.userAgent) || '';
  const isMobileUa = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua);
  if (!isMobileUa && win.innerWidth >= 820) return 'desktop';
  return win.innerWidth <= 820 ? 'mobile' : 'desktop';
}

export function ensurePadFloatingModifierCapsule(_onSendKey) {
  if (typeof document !== 'undefined') {
    document.getElementById('zephyrPadFloatingModifiers')?.remove();
    document.querySelectorAll('.floating-modifier-capsule').forEach((el) => el.remove());
  }
  return null;
}

/* ── 3. 5.3 & 5.4 Mobile 3-Detent BottomSheetController + IME Auto-Promotion ── */
export const MOBILE_SHEET_DETENTS = { DISMISS: 0, MID: 0.44, MAX: 0.96 };

export function attachMobileBottomSheet(panel, { defaultDetent = 'MID', onDismiss } = {}) {
  if (!panel || typeof window === 'undefined') return null;
  panel.classList.add('mobile-bottom-sheet', 'z-glass-thick');
  let currentDetent = defaultDetent;
  let preImeDetent = defaultDetent;
  let imeOpen = false;

  if (!panel.querySelector('.mobile-sheet-grabber')) {
    const grabber = document.createElement('div');
    grabber.className = 'mobile-sheet-grabber';
    grabber.innerHTML = '<span class="mobile-sheet-pill"></span>';
    panel.prepend(grabber);

    let startY = 0, startH = 0, dragging = false;
    grabber.addEventListener('pointerdown', (e) => {
      dragging = true;
      startY = e.clientY;
      startH = panel.getBoundingClientRect().height;
      grabber.setPointerCapture?.(e.pointerId);
    });
    grabber.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dy = startY - e.clientY;
      const vh = window.innerHeight || 800;
      const nextFrac = Math.max(0.15, Math.min(0.96, (startH + dy) / vh));
      panel.style.height = `${Math.round(nextFrac * 100)}vh`;
    });
    grabber.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      const dy = startY - e.clientY;
      const vh = window.innerHeight || 800;
      const frac = (startH + dy) / vh;
      if (frac < 0.26) {
        setDetent('DISMISS');
        onDismiss?.();
      } else if (frac > 0.70) {
        setDetent('MAX');
      } else {
        setDetent('MID');
      }
      ZephyrHaptics.lightImpact();
    });
  }

  function setDetent(detentName, { imeHeight = 0 } = {}) {
    currentDetent = detentName;
    panel.dataset.sheetDetent = detentName;
    if (detentName === 'DISMISS') {
      panel.style.transform = 'translate3d(0, 105%, 0)';
      return;
    }
    const frac = MOBILE_SHEET_DETENTS[detentName] || MOBILE_SHEET_DETENTS.MID;
    panel.style.transform = 'translate3d(0, 0, 0)';
    panel.style.height = `${Math.round(frac * 100)}vh`;
    panel.style.paddingBottom = imeHeight > 0 ? `${imeHeight}px` : '';
  }

  // 5.3 #3: IME-Aware Sheet Auto-Promotion
  if (window.visualViewport && !panel._imeViewportBound) {
    panel._imeViewportBound = true;
    window.visualViewport.addEventListener('resize', () => {
      if (!panel.classList.contains('open') && panel.style.display === 'none') return;
      if (resolveActiveSurfaceMode() !== 'mobile') return;
      const fullH = window.innerHeight || 800;
      const vvH = window.visualViewport.height || fullH;
      const kbHeight = Math.max(0, fullH - vvH);
      if (kbHeight > 120 && !imeOpen) {
        imeOpen = true;
        preImeDetent = currentDetent;
        setDetent('MAX', { imeHeight: kbHeight });
      } else if (kbHeight <= 80 && imeOpen) {
        imeOpen = false;
        setDetent(preImeDetent || 'MID', { imeHeight: 0 });
      }
    });
  }

  setDetent(defaultDetent);
  return { setDetent, getDetent: () => currentDetent };
}

/* ── 4. 4.3 #1: ~/.ssh/config Parser & Auto ProxyJump Linker ────────────── */
export function parseSshConfigAndAutoLink(rawText) {
  const lines = String(rawText || '').split(/\r?\n/);
  const blocks = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*(?:=|\s+)\s*(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim().replace(/^['"]|['"]$/g, '');
    if (key === 'host') {
      const patterns = val.split(/\s+/).filter((p) => p && !p.includes('*') && !p.includes('?'));
      if (!patterns.length) {
        current = null;
        continue;
      }
      current = {
        alias: patterns[0],
        name: patterns[0],
        host: patterns[0],
        port: 22,
        username: 'root',
        protocol: 'ssh',
        identityFile: '',
        proxyJump: '',
      };
      blocks.push(current);
    } else if (current) {
      if (key === 'hostname') current.host = val;
      else if (key === 'user') current.username = val;
      else if (key === 'port') current.port = Number(val) || 22;
      else if (key === 'identityfile') current.identityFile = val;
      else if (key === 'proxyjump') current.proxyJump = val;
    }
  }

  const byAlias = new Map(blocks.map((b) => [b.alias, b]));
  for (const b of blocks) {
    if (b.proxyJump && byAlias.has(b.proxyJump)) {
      b.linkedJumpHostAlias = b.proxyJump;
    }
  }
  return blocks;
}

/* ── 5. 10.6 ZephyrGuard Tier 1 Engine & SecretVaultRehydrator ──────────── */
const STRUCTURED_SECRET_PATTERNS = [
  { kind: 'SECRET_PRIVATE_KEY', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { kind: 'SECRET_API_TOKEN', re: /\b(?:AKIA[0-9A-Z]{16}|ghp_[0-9A-Za-z]{30,}|sk-[0-9A-Za-z_-]{20,}|xox[baprs]-[0-9A-Za-z-]{16,})\b/g },
  { kind: 'SECRET_DB_URI', re: /\b(?:postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?):\/\/[^:\s]+:([^@\s]+)@[^\s]+/gi },
];

const CONTEXT_PASS_RE = /(?:密码|口令|passwd|password|passphrase|secret|api[_-]?key|token)(?:\s*(?:是|为|填|设为|:|=)\s*|\s+)['"]?([^\s,，。;；'"]{6,})['"]?/gi;

export function shannonEntropy(str) {
  const s = String(str || '');
  if (!s.length) return 0;
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) || 0) + 1);
  let h = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export function extractSecretSpans(text) {
  const src = String(text || '');
  if (!src) return [];
  const spans = [];

  for (const { kind, re } of STRUCTURED_SECRET_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (m[1]) {
        const subIdx = m[0].indexOf(m[1]);
        spans.push({ start: m.index + subIdx, end: m.index + subIdx + m[1].length, kind });
      } else {
        spans.push({ start: m.index, end: m.index + m[0].length, kind });
      }
    }
  }

  CONTEXT_PASS_RE.lastIndex = 0;
  let cm;
  while ((cm = CONTEXT_PASS_RE.exec(src)) !== null) {
    const candidate = cm[1];
    if (!candidate || /^\{\{ZEPHYR_SECRET_\d+\}\}$/.test(candidate)) continue;
    const entropy = shannonEntropy(candidate);
    if (candidate.length >= 6 && entropy >= 2.5) {
      const rel = cm[0].lastIndexOf(candidate);
      const start = cm.index + rel;
      spans.push({ start, end: start + candidate.length, kind: 'SECRET_PASSWORD' });
    }
  }

  spans.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const sp of spans) {
    if (!merged.length || sp.start >= merged[merged.length - 1].end) {
      merged.push(sp);
    }
  }
  return merged;
}

const SECRET_TOKEN_RE = /\{\{ZEPHYR_SECRET_\d+\}\}/g;

export class SecretVaultRehydrator {
  constructor() {
    this.vault = new Map(); // token -> Uint8Array
    this.counter = 0;
  }

  redactUserPromptBeforeSend(rawPrompt) {
    const src = String(rawPrompt || '');
    const spans = extractSecretSpans(src);
    if (!spans.length) return { sanitized: src, hasSecrets: false, tokens: [] };
    let out = '';
    let cursor = 0;
    const tokens = [];
    const encoder = new TextEncoder();
    for (const sp of spans) {
      if (sp.start < cursor || sp.end > src.length || sp.start >= sp.end) continue;
      out += src.slice(cursor, sp.start);
      this.counter += 1;
      const token = `{{ZEPHYR_SECRET_${this.counter}}}`;
      const rawSlice = src.slice(sp.start, sp.end);
      this.vault.set(token, encoder.encode(rawSlice));
      tokens.push({ token, kind: sp.kind });
      out += token;
      cursor = sp.end;
    }
    out += src.slice(cursor);
    ZephyrHaptics.lightImpact();
    return { sanitized: out, hasSecrets: tokens.length > 0, tokens };
  }

  /* JIT Pre-Tool-Execution Hook ONLY — never call on chat history or logs */
  rehydrateString(input) {
    const s = String(input ?? '');
    if (!this.vault.size) return s;
    const decoder = new TextDecoder();
    return s.replace(SECRET_TOKEN_RE, (token) => {
      const buf = this.vault.get(token);
      return buf ? decoder.decode(buf) : token;
    });
  }

  scrubResultBeforeReturn(output) {
    let res = String(output ?? '');
    if (!this.vault.size) return res;
    const decoder = new TextDecoder();
    for (const [token, buf] of this.vault.entries()) {
      const raw = decoder.decode(buf);
      if (raw) res = res.split(raw).join(token);
    }
    return res;
  }

  peekSecret(token) {
    const buf = this.vault.get(token);
    return buf ? new TextDecoder().decode(buf) : '';
  }

  disposeAndZeroize() {
    for (const buf of this.vault.values()) {
      if (buf instanceof Uint8Array) buf.fill(0);
    }
    this.vault.clear();
  }
}

export function scanIncomingServerOutputForInjection(output) {
  const s = String(output || '');
  if (!s) return { injected: false, score: 0, wrapped: s };
  const hasBidi = /[\u202a-\u202e\u2066-\u2069]/.test(s);
  const hasPromptInjection = /(?:ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions|system\s+prompt\s*:|you\s+are\s+now\s+in\s+developer\s+mode|<\s*\/?\s*system\s*>|请忽略(?:之前|以上)的所有指令)/i.test(s);
  if (hasBidi || hasPromptInjection) {
    return {
      injected: true,
      score: 0.96,
      wrapped: `<untrusted_terminal_data warning="prompt_injection_detected">\n${s}\n</untrusted_terminal_data>`,
    };
  }
  return { injected: false, score: 0.01, wrapped: s };
}

/* ── 6. 6.1.1 Mobile RDP / VNC SmartDot Two-Stage Tap State Machine ────── */
export class RemoteSmartDotController {
  constructor({ onBarsVisibilityChange, onSmartbarExpandChange } = {}) {
    this.barsHidden = false;
    this.smartbarExpanded = false;
    this.onBarsVisibilityChange = onBarsVisibilityChange;
    this.onSmartbarExpandChange = onSmartbarExpandChange;
    this._idleTimer = null;
  }

  onCanvasTouch() {
    this.barsHidden = true;
    this.smartbarExpanded = false;
    this.onBarsVisibilityChange?.(true);
    this.onSmartbarExpandChange?.(false);
  }

  onSmartDotTap() {
    ZephyrHaptics.selectionTick();
    if (this.barsHidden) {
      // Stage 1: when bars are hidden, 1st tap ONLY reveals top/bottom bars
      this.barsHidden = false;
      this.smartbarExpanded = false;
      this.onBarsVisibilityChange?.(false);
      this.onSmartbarExpandChange?.(false);
      this.scheduleAutoHide();
      return { stage: 1, barsHidden: false, smartbarExpanded: false };
    }
    // Stage 2: when bars are already visible, 2nd tap expands Smartbar
    this.smartbarExpanded = !this.smartbarExpanded;
    this.onSmartbarExpandChange?.(this.smartbarExpanded);
    return { stage: 2, barsHidden: false, smartbarExpanded: this.smartbarExpanded };
  }

  scheduleAutoHide(delayMs = 3500) {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      if (!this.smartbarExpanded) {
        this.barsHidden = true;
        this.onBarsVisibilityChange?.(true);
      }
    }, delayMs);
  }
}


/* ── Global IP Protection Mode (4.3 #4 & 10.5 #8, default false) ────────── */
export const IPV4_OR_IPV6_RE = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b|\[?(?:[0-9a-fA-F]{1,4}:){2,}[0-9a-fA-F:]+\]?(?::\d{1,5})?/g;

export function isIpProtectionEnabled(settingsObj) {
  if (typeof settingsObj?.appearance?.ipProtection === 'boolean') {
    return settingsObj.appearance.ipProtection;
  }
  if (typeof window !== 'undefined' && typeof window.__zephyrIpProtection === 'boolean') {
    return window.__zephyrIpProtection;
  }
  if (typeof settingsObj?.ipProtection === 'boolean' && !settingsObj._admin) {
    return settingsObj.ipProtection;
  }
  try {
    return localStorage.getItem('zephyr_ip_protection_saved') === '1';
  } catch (_) {
    return false;
  }
}

export function scrubIpLiterals(text = '') {
  return String(text || '').replace(IPV4_OR_IPV6_RE, '').replace(/\s*[·@:()-]\s*$/g, '').trim();
}

export function scrubIpWhenProtected(text = '', fallback = '', settingsObj) {
  const raw = String(text || '');
  if (!isIpProtectionEnabled(settingsObj)) return raw;
  const cleaned = scrubIpLiterals(raw);
  return cleaned || fallback;
}

export function formatProtectedName(name = '', protocol = 'SSH', settingsObj) {
  const raw = String(name || '').trim();
  const protoLabel = String(protocol || 'SSH').toUpperCase();
  const fallback = protoLabel + ' 主机';
  if (!isIpProtectionEnabled(settingsObj)) return raw || fallback;
  const cleaned = scrubIpLiterals(raw);
  return cleaned || fallback;
}

export function applyIpProtectionState(enabled, settingsObj) {
  const flag = enabled === true;
  if (typeof window !== 'undefined') {
    window.__zephyrIpProtection = flag;
  }
  if (settingsObj && typeof settingsObj === 'object') {
    settingsObj.ipProtection = flag;
    if (settingsObj.appearance && typeof settingsObj.appearance === 'object') {
      settingsObj.appearance.ipProtection = flag;
    }
  }
  try {
    localStorage.removeItem('zephyr_ip_protection');
    localStorage.setItem('zephyr_ip_protection_saved', flag ? '1' : '0');
  } catch (_) {}
  if (typeof document !== 'undefined' && document.body) {
    document.body.classList.toggle('ip-protection-on', flag);
  }
  if (typeof document !== 'undefined') {
    document.querySelectorAll('#ipProtectionToggle, #ipProtectionToggleSecurity').forEach((el) => {
      if (el.checked !== flag) el.checked = flag;
    });
    document.querySelectorAll('iframe.terminal-frame').forEach((frame) => {
      try {
        frame.contentWindow?.postMessage({
          source: 'zephyr-app',
          type: 'ip-protection-change',
          enabled: flag,
        }, '*');
      } catch (_) {}
    });
  }
  return flag;
}
