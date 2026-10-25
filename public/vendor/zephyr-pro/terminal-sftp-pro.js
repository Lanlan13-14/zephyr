import { Motion as ZephyrWasmMotion } from '../zephyr-motion/index.js?v=20261019-ui123';
if (typeof window !== 'undefined' && ZephyrWasmMotion) { window.Motion = ZephyrWasmMotion; }

export const IPV4_OR_IPV6_RE = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b|\[?(?:[0-9a-fA-F]{1,4}:){2,}[0-9a-fA-F:]+\]?(?::\d{1,5})?/g;

export function isIpProtectionEnabled() {
  try {
    if (typeof window !== 'undefined' && window.parent && window.parent !== window && typeof window.parent.__zephyrIpProtection === 'boolean') {
      return window.parent.__zephyrIpProtection;
    }
  } catch (_) {}
  if (typeof window !== 'undefined' && typeof window.__zephyrIpProtection === 'boolean') {
    return window.__zephyrIpProtection;
  }
  try {
    return localStorage.getItem('zephyr_ip_protection_saved') === '1';
  } catch (_) {
    return false;
  }
}

export function scrubIpWhenProtected(text = '', fallback = '') {
  const raw = String(text || '');
  if (!isIpProtectionEnabled()) return raw;
  const cleaned = raw.replace(IPV4_OR_IPV6_RE, '').replace(/\s*[·@:()-]\s*$/g, '').trim();
  return cleaned || fallback;
}
function escapeHtml(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ══════════════════════════════════════════════════════════════════════════
 * public/vendor/zephyr-pro/terminal-sftp-pro.js
 *
 * Implements Plan 4.2.5, 4.2.6, 8.2 & 10.5.1/10.5.6 for SSH & Telnet Terminals:
 *  1. SFTP same-type directory multi-tabs (Tab Strip) + `cd` initial directory
 *     tracking (`lastCdCwd` + `sftpOpenedSinceLastCd` state machine)
 *  2. SFTP built-in `/zephyr-agent` virtual directory (backed by `/api/rdp/file-agents`
 *     & `/api/rdp/file-agents/:agentId/rpc`) + `.fm-footer` status bar
 *  3. SFTP non-root inline `sudo` privilege-escalation save + Optimistic Lock
 *     2-column Diff comparison + 10MB/50MB 3-tier memory safety gate +
 *     Byte-Offset Resume (`.zpart`) + streaming `SHA-256` integrity badge
 *  4. Inline SSH Port Forwarding (`-L` Local / `-R` Remote / `-D` Dynamic SOCKS5) panel
 *  5. Terminal inline full-text/regex Search Bar (`Cmd/Ctrl+F`) + History-Read
 *     unread output capsule (`[↓ N 行新输出 · 点击回到底部]`)
 *  6. Terminal `OSC 133` semantic command gutter + 1-click AI error diagnosis
 *  7. Terminal `/path/to/file:line` Ctrl/Alt-click direct jump to SFTP editor/preview
 *  8. Terminal `ZMODEM` (`rz`/`sz`) & `trzsz` (`trz`/`tsz`) stream sniffer & inline transfer bar
 *  9. Terminal Paste-Bomb & Bracketed-Paste escape guard (`sanitizeTerminalPaste`) +
 *     Optional Terminal Input High-Risk Command AST/Rule guard (`terminalInputGuardMode`)
 * 10. Telnet lossless streaming multi-charset decoder (`UTF-8 / GB18030 / GBK / Big5 / Shift-JIS / CP437`)
 * ══════════════════════════════════════════════════════════════════════════ */

const HIGH_RISK_CMD_RE = /(?:^|[\r\n;&|]\s*)(?:sudo\s+)?(?:rm\s+-(?:[a-zA-Z]*r[a-zA-Z]*f|[a-zA-Z]*f[a-zA-Z]*r)\s+(?:\/|\*|--no-preserve-root)|mkfs(?:\.[a-z0-9]+)?\s+|dd\s+[^;&|]*of=\/dev\/|(?:chmod|chown)\s+-R\s+[^\s]+\s+\/\s*$|:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:|(?:curl|wget)\s+[^|;&]+\|\s*(?:sudo\s+)?(?:ba)?sh\b|DROP\s+(?:DATABASE|TABLE)\b)/im;
const ARG_SECRET_LEAK_RE = /(?:mysql\s+.*-p[^\s]+|curl\s+.*(?:-u|--user)\s+[^\s:]+:[^\s]+|sshpass\s+-p\s*[^\s]+|PGPASSWORD=[^\s]+)/i;

export function sanitizeTerminalPaste(rawText) {
  const raw = String(rawText ?? '');
  // Unconditionally strip bracketed paste escape injections (\x1b[200~, \x1b[201~) and dangerous C0 controls
  const cleaned = raw
    .replace(/\x1b\[20[01]~/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  const lines = cleaned.split(/\r?\n/);
  const isMultiline = lines.length > 1 && lines.some((l, idx) => idx < lines.length - 1 && l.trim().length > 0);
  const isHighRisk = HIGH_RISK_CMD_RE.test(cleaned);
  return {
    cleaned,
    lines,
    isMultiline,
    isHighRisk,
    needsConfirmation: isMultiline || isHighRisk,
  };
}

export function classifyTerminalCommandRisk(cmd) {
  const s = String(cmd || '').trim();
  if (!s) return { riskClass: 'SAFE', score: 0 };
  if (HIGH_RISK_CMD_RE.test(s)) {
    return { riskClass: 'HIGH_RISK_DESTRUCTIVE', score: 0.98 };
  }
  if (/base64\s+(?:-d|--decode)\s*\|\s*(?:ba)?sh/i.test(s)) {
    return { riskClass: 'MALICIOUS_OBFUSCATED', score: 0.96 };
  }
  if (ARG_SECRET_LEAK_RE.test(s)) {
    return { riskClass: 'WARN_ARG_SECRET_LEAK', score: 0.85 };
  }
  return { riskClass: 'SAFE', score: 0.02 };
}

export async function computeSha256Hex(bytesOrBuffer) {
  try {
    const buf = bytesOrBuffer instanceof Uint8Array
      ? bytesOrBuffer
      : new TextEncoder().encode(String(bytesOrBuffer || ''));
    if (globalThis.crypto?.subtle) {
      const hash = await globalThis.crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {}
  return '';
}

/* CP437 high-byte lookup table (0x80..0xFF) for classic BBS / DOS ANSI art */
const CP437_HIGH = [
  '\u00c7','\u00fc','\u00e9','\u00e2','\u00e4','\u00e0','\u00e5','\u00e7',
  '\u00ea','\u00eb','\u00e8','\u00ef','\u00ee','\u00ec','\u00c4','\u00c5',
  '\u00c9','\u00e6','\u00c6','\u00f4','\u00f6','\u00f2','\u00fb','\u00f9',
  '\u00ff','\u00d6','\u00dc','\u00a2','\u00a3','\u00a5','\u20a7','\u0192',
  '\u00e1','\u00ed','\u00f3','\u00fa','\u00f1','\u00d1','\u00aa','\u00ba',
  '\u00bf','\u2310','\u00ac','\u00bd','\u00bc','\u00a1','\u00ab','\u00bb',
  '\u2591','\u2592','\u2593','\u2502','\u2524','\u2561','\u2562','\u2556',
  '\u2555','\u2563','\u2551','\u2557','\u255d','\u255c','\u255b','\u2510',
  '\u2514','\u2534','\u252c','\u251c','\u2500','\u253c','\u255e','\u255f',
  '\u255a','\u2554','\u2569','\u2566','\u2560','\u2550','\u256c','\u2567',
  '\u2568','\u2564','\u2565','\u2559','\u2558','\u2552','\u2553','\u256b',
  '\u256a','\u2518','\u250c','\u2588','\u2584','\u258c','\u2590','\u2580',
  '\u03b1','\u00df','\u0393','\u03c0','\u03a3','\u03c3','\u00b5','\u03c4',
  '\u03a6','\u0398','\u03a9','\u03b4','\u221e','\u03c6','\u03b5','\u2229',
  '\u2261','\u00b1','\u2265','\u2264','\u2320','\u2321','\u00f7','\u2248',
  '\u00b0','\u2219','\u00b7','\u221a','\u207f','\u00b2','\u25a0','\u00a0',
];

export class StreamingCharsetDecoder {
  constructor(encoding = 'utf-8') {
    this.setEncoding(encoding);
  }
  setEncoding(encoding) {
    this.encoding = String(encoding || 'utf-8').toLowerCase();
    this._decoder = null;
    if (this.encoding !== 'cp437') {
      try {
        this._decoder = new TextDecoder(this.encoding, { fatal: false });
      } catch {
        this._decoder = new TextDecoder('utf-8', { fatal: false });
      }
    }
  }
  decode(chunk) {
    if (typeof chunk === 'string') return chunk;
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk || []);
    if (this.encoding === 'cp437') {
      let out = '';
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        out += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
      }
      return out;
    }
    return this._decoder ? this._decoder.decode(bytes, { stream: true }) : '';
  }
}

export function isAgentVfsPath(p) {
  const norm = String(p || '').replace(/\/+$/, '') || '/';
  return norm === '/zephyr-agent' || norm.startsWith('/zephyr-agent/');
}

export async function fetchAgentVfsListing(virtualPath) {
  const norm = String(virtualPath || '/zephyr-agent').replace(/\/+$/, '') || '/zephyr-agent';
  const rest = norm.slice('/zephyr-agent'.length).replace(/^\/+/, '');
  if (!rest) {
    // Root of /zephyr-agent: list all online/bound agents
    let agents = [];
    try {
      const r1 = await fetch('/api/rdp/file-agents', { credentials: 'same-origin', cache: 'no-store' });
      if (r1.ok) {
        const d1 = await r1.json();
        if (Array.isArray(d1?.agents)) agents = d1.agents;
      }
    } catch {}
    if (!agents.length) {
      try {
        const r2 = await fetch('/api/one/agents', { credentials: 'same-origin', cache: 'no-store' });
        if (r2.ok) {
          const d2 = await r2.json();
          if (Array.isArray(d2?.agents)) agents = d2.agents;
        }
      } catch {}
    }
    return agents.map((a) => ({
      name: a.agentId || a.clientId || a.deviceName || 'agent-device',
      displayName: `${a.deviceName || a.name || a.clientId || 'Agent'} (${a.platform || 'Local'})`,
      type: 'd',
      size: 0,
      modifyTime: a.lastSeenAt || Date.now(),
      rights: 'drwxr-xr-x',
      isAgentDevice: true,
    }));
  }
  const parts = rest.split('/');
  const agentId = parts[0];
  const innerPath = '/' + parts.slice(1).join('/');
  try {
    const res = await fetch(`/api/rdp/file-agents/${encodeURIComponent(agentId)}/rpc`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'list', path: innerPath }),
    });
    if (res.ok) {
      const data = await res.json();
      const entries = data?.entries || data?.files || [];
      return entries.map((e) => ({
        name: e.name || e.filename || 'item',
        type: e.isDirectory || e.type === 'd' ? 'd' : '-',
        size: Number(e.size) || 0,
        modifyTime: Number(e.mtimeMs || e.modifyTime) || Date.now(),
        rights: e.rights || (e.isDirectory ? 'drwxr-xr-x' : '-rw-r--r--'),
      }));
    }
  } catch {}
  return [];
}

export function installTerminalSftpPro(ctx) {
  const {
    getTerm,
    getWs,
    getCurrentPath,
    setCurrentPath,
    navigateTo,
    openEditor,
    requestDownload,
    showToast,
    t: rawT = (k) => k,
    hostName = '',
  } = ctx || {};
  const t = (k, p) => (typeof window !== 'undefined' && typeof window.__zephyrI18n?.t === 'function') ? window.__zephyrI18n.t(k, p) : rawT(k, p);

  /* ── 1. cd tracking state machine (4.2.5 #2: lastCdCwd + sftpOpenedSinceLastCd) ── */
  const cdState = {
    lastCdCwd: '',
    sftpOpenedSinceLastCd: true,
  };

  function recordCdCommand(targetDir) {
    const raw = String(targetDir || '').trim().replace(/^['"]|['"]$/g, '');
    if (!raw || raw === '-') return;
    let resolved = raw;
    if (!raw.startsWith('/')) {
      const base = (cdState.lastCdCwd || getCurrentPath?.() || '/').replace(/\/+$/, '');
      if (raw === '~') resolved = '/root';
      else if (raw.startsWith('~/')) resolved = '/root/' + raw.slice(2);
      else if (raw === '..') {
        const segs = base.split('/').filter(Boolean);
        segs.pop();
        resolved = '/' + segs.join('/');
      } else {
        resolved = (base === '' ? '' : base) + '/' + raw;
      }
    }
    resolved = resolved.replace(/\/+/g, '/') || '/';
    cdState.lastCdCwd = resolved;
    cdState.sftpOpenedSinceLastCd = false;
  }

  function parseInputForCd(dataStr) {
    const s = String(dataStr || '');
    const m = s.match(/(?:^|[\r\n;&|])\s*cd\s+([^\r\n;&|]+)/);
    if (m && m[1]) recordCdCommand(m[1].trim());
  }

  function consumeInitialSftpPath(fallbackPath = '/') {
    if (!cdState.sftpOpenedSinceLastCd && cdState.lastCdCwd) {
      cdState.sftpOpenedSinceLastCd = true;
      return cdState.lastCdCwd;
    }
    return fallbackPath || getCurrentPath?.() || '/';
  }

  /* ── 2. SFTP Same-Type Directory Multi-Tab Strip (4.2.5 #2) ───────────── */
  const fileManager = document.getElementById('fileManager');
  const sftpTabs = [
    { id: 'sftp-tab-1', label: '/var/www', path: getCurrentPath?.() || '/' },
  ];
  let activeSftpTabId = 'sftp-tab-1';
  let tabSeq = 1;

  function ensureSftpChrome() {
    if (!fileManager) return;
    // Ensure .panel-pin-toggle (#fmDockBtn) is in .fm-header.panel-titlebar (4.2.0.1 #3 & 4.2.3 #1)
    const firstHeader = fileManager.querySelector('.fm-header.panel-titlebar');
    if (firstHeader && !firstHeader.querySelector('.panel-pin-toggle, #fmDockBtn')) {
      const dockBtn = document.createElement('button');
      dockBtn.type = 'button';
      dockBtn.id = 'fmDockBtn';
      dockBtn.className = 'tool-btn panel-pin-toggle';
      dockBtn.title = t('停靠/悬浮切换');
      dockBtn.setAttribute('aria-label', t('停靠/悬浮切换'));
      dockBtn.setAttribute('aria-pressed', 'false');
      dockBtn.innerHTML = '<svg class="z-pin-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1 1 1 0 0 1 1 1z"/></svg>';
      const closeBtn = firstHeader.querySelector('#fmCloseBtn, .fm-close-btn');
      if (closeBtn) firstHeader.insertBefore(dockBtn, closeBtn);
      else firstHeader.appendChild(dockBtn);
    }
    // Tab strip for same-type SFTP directory tabs
    if (!document.getElementById('fmTabStrip')) {
      const strip = document.createElement('div');
      strip.id = 'fmTabStrip';
      strip.className = 'fm-tab-strip';
      const firstHeader = fileManager.querySelector('.fm-header.panel-titlebar');
      if (firstHeader && firstHeader.nextSibling) {
        fileManager.insertBefore(strip, firstHeader.nextSibling);
      } else {
        fileManager.prepend(strip);
      }
    }
    // Quick jump button for /zephyr-agent in toolbar
    const toolbar = fileManager.querySelector('.fm-toolbar');
    if (toolbar && !document.getElementById('fmAgentJumpBtn')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'fmAgentJumpBtn';
      btn.className = 'tool-btn fm-agent-jump-btn';
      btn.title = 'Zephyr Agent';
      btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="6" rx="2"/><line x1="6" y1="8" x2="6.01" y2="8"/><line x1="6" y1="17" x2="6.01" y2="17"/></svg><span>/zephyr-agent</span>`;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        navigateTo?.('/zephyr-agent');
      });
      toolbar.prepend(btn);
    }
    // Bottom status bar (.fm-footer: "6 项 /var/www   db-primary")
    if (!document.getElementById('fmFooter')) {
      const footer = document.createElement('div');
      footer.id = 'fmFooter';
      footer.className = 'fm-footer';
      footer.innerHTML = `<span id="fmFooterCount">0 items</span><span id="fmFooterHost">${hostName || 'SSH'}</span>`;
      const fmList = document.getElementById('fmList');
      if (fmList && fmList.nextSibling) {
        fileManager.insertBefore(footer, fmList.nextSibling);
      } else {
        fileManager.appendChild(footer);
      }
    }
    renderSftpTabs();
  }

  function renderSftpTabs() {
    const strip = document.getElementById('fmTabStrip');
    if (!strip) return;
    strip.innerHTML = '';
    for (const tab of sftpTabs) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = `fm-tab-pill${tab.id === activeSftpTabId ? ' active' : ''}`;
      pill.dataset.tabId = tab.id;
      const shortName = tab.path === '/' ? '/' : (tab.path.split('/').filter(Boolean).pop() || tab.path);
      pill.innerHTML = `<span class="fm-tab-title">${shortName}</span>${sftpTabs.length > 1 ? '<span class="fm-tab-close" data-close-tab="1">×</span>' : ''}`;
      pill.title = tab.path;
      pill.addEventListener('click', (e) => {
        if (e.target.closest('[data-close-tab]')) {
          e.stopPropagation();
          const idx = sftpTabs.findIndex((x) => x.id === tab.id);
          if (idx >= 0 && sftpTabs.length > 1) {
            sftpTabs.splice(idx, 1);
            if (activeSftpTabId === tab.id) {
              const next = sftpTabs[Math.max(0, idx - 1)];
              activeSftpTabId = next.id;
              navigateTo?.(next.path);
            }
            renderSftpTabs();
          }
          return;
        }
        activeSftpTabId = tab.id;
        renderSftpTabs();
        if (getCurrentPath?.() !== tab.path) navigateTo?.(tab.path);
      });
      strip.appendChild(pill);
    }
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.id = 'fmNewTabBtn';
    addBtn.className = 'fm-tab-add-btn';
    addBtn.title = 'New SFTP Tab';
    addBtn.textContent = '+';
    addBtn.addEventListener('click', (e) => {
      e.preventDefault();
      tabSeq += 1;
      const initialPath = consumeInitialSftpPath(getCurrentPath?.() || '/');
      const newTab = { id: `sftp-tab-${tabSeq}`, label: initialPath, path: initialPath };
      sftpTabs.push(newTab);
      activeSftpTabId = newTab.id;
      renderSftpTabs();
      navigateTo?.(initialPath);
    });
    strip.appendChild(addBtn);
  }

  function syncActiveSftpTab(path, fileCount = 0) {
    const active = sftpTabs.find((x) => x.id === activeSftpTabId) || sftpTabs[0];
    if (active && path) active.path = path;
    renderSftpTabs();
    const countEl = document.getElementById('fmFooterCount');
    const hostEl = document.getElementById('fmFooterHost');
    if (countEl) countEl.textContent = `${fileCount} · ${path || '/'}`;
    if (hostEl && hostName) hostEl.textContent = hostName;
  }

  /* ── 3. 10MB / 50MB 3-Tier Memory Gate & Inline Sudo Save (4.2.5 #7) ── */
  const SIZE_10MB = 10 * 1024 * 1024;
  const SIZE_50MB = 50 * 1024 * 1024;

  function checkFileMemoryGate(file, itemEl) {
    const size = Number(file?.size) || 0;
    const filePath = file?.path || '';
    if (size <= SIZE_10MB) return 'allow-full';
    if (size <= SIZE_50MB) {
      // 10MB ~ 50MB: Stream Chunk / Tail Readonly Viewer
      openTailPreviewInEditor(filePath, size, 500);
      return 'chunk-viewer';
    }
    // > 50MB: Inline row action bar (never load into editor memory!)
    if (itemEl) {
      let gateBar = itemEl.querySelector('.fm-large-file-gate');
      if (!gateBar) {
        gateBar = document.createElement('div');
        gateBar.className = 'fm-large-file-gate z-glass-thin';
        const mb = (size / (1024 * 1024)).toFixed(1);
        gateBar.innerHTML = `
          <span class="gate-label">${mb} MB</span>
          <button type="button" class="tool-btn" data-gate-action="tail">Tail 1000</button>
          <button type="button" class="tool-btn primary" data-gate-action="download">Download</button>
        `;
        gateBar.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const btn = ev.target.closest('[data-gate-action]');
          if (!btn) return;
          if (btn.dataset.gateAction === 'tail') {
            openTailPreviewInEditor(filePath, size, 1000);
          } else if (btn.dataset.gateAction === 'download') {
            requestDownload?.({ ...file, path: filePath });
          }
        });
        itemEl.appendChild(gateBar);
      }
    }
    return 'blocked-50mb';
  }

  function openTailPreviewInEditor(filePath, size, lines = 1000) {
    const ws = getWs?.();
    if (ws && ws.readyState === WebSocket.OPEN) {
      showToast?.(`Reading tail ${lines} lines (${(size / 1048576).toFixed(1)} MB)...`, 'info');
      ws.send(JSON.stringify({ type: 'input', data: `tail -n ${lines} -- "${filePath.replace(/"/g, '\\"')}"\r` }));
    }
  }

  function showInlineSudoSaveBar(editorPanel, filePath, pendingBase64) {
    if (!editorPanel) return;
    let bar = editorPanel.querySelector('.fm-editor-sudo-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'fm-editor-sudo-bar z-glass-thin';
      bar.innerHTML = `
        <span class="sudo-bar-msg">EACCES / Permission denied</span>
        <input type="password" class="sudo-pass-input" placeholder="sudo password (optional)">
        <button type="button" class="tool-btn primary sudo-save-confirm-btn">sudo Save</button>
        <button type="button" class="tool-btn sudo-save-cancel-btn">×</button>
      `;
      const header = editorPanel.querySelector('.fm-editor-header');
      if (header && header.nextSibling) editorPanel.insertBefore(bar, header.nextSibling);
      else editorPanel.prepend(bar);
      bar.querySelector('.sudo-save-cancel-btn')?.addEventListener('click', () => {
        bar.style.display = 'none';
      });
    }
    bar.style.display = 'flex';
    const confirmBtn = bar.querySelector('.sudo-save-confirm-btn');
    const passInput = bar.querySelector('.sudo-pass-input');
    if (confirmBtn) {
      confirmBtn.onclick = () => {
        const ws = getWs?.();
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const tmpFile = `/tmp/.zephyr_sudo_${Date.now().toString(36)}`;
        const safeTarget = String(filePath || '').replace(/'/g, `'\\''`);
        const pass = passInput?.value || '';
        const sudoCmd = pass
          ? `printf '%s\\n' '${pass.replace(/'/g, `'\\''`)}' | sudo -S sh -c 'cp -p "${safeTarget}" "${tmpFile}.bak" 2>/dev/null || true; base64 -d "${tmpFile}.b64" > "${tmpFile}" && chmod --reference="${safeTarget}" "${tmpFile}" 2>/dev/null || true; mv -f "${tmpFile}" "${safeTarget}"; rm -f "${tmpFile}.b64"'`
          : `sudo -n sh -c 'base64 -d "${tmpFile}.b64" > "${tmpFile}" && chmod --reference="${safeTarget}" "${tmpFile}" 2>/dev/null || true; mv -f "${tmpFile}" "${safeTarget}"; rm -f "${tmpFile}.b64"'`;
        ws.send(JSON.stringify({
          type: 'sftp-writefile',
          path: `${tmpFile}.b64`,
          data: btoa(pendingBase64 || ''),
          encoding: 'base64',
        }));
        setTimeout(() => {
          ws.send(JSON.stringify({ type: 'input', data: `${sudoCmd}\r` }));
          bar.style.display = 'none';
          if (passInput) passInput.value = '';
          showToast?.('sudo save dispatched', 'success');
        }, 260);
      };
    }
  }

  /* ── 4. SSH Port Forwarding (-L / -R / -D) Inline Panel (4.2.5 #6) ───── */
  const tunnels = [];
  function togglePortForwardPanel(open) {
    const panel = document.getElementById('portForwardPanel');
    const btn = document.getElementById('portForwardBtn');
    if (!panel) return;
    const Motion = window.Motion;
    if (open) {
      ensureFloatingDefaultPosition(panel, { triggerBtn: btn });
      panel.style.display = 'flex';
      panel.classList.add('open');
      btn?.classList.add('active');
      setFocusedFloatingPanel(panel);
      renderPortForwards();
      Motion?.panelOpenWasm?.(panel, btn, { preset: 'mac' });
      syncHostWindowDockAndFloatState();
    } else {
      btn?.classList.remove('active');
      closeUnifiedPanel(panel, { triggerBtn: btn });
    }
  }

  function ensurePortForwardPanel() {
    // UI124: temporarily commented out per user request (hide Port Forwarding UI without deleting code)
    // if (!document.getElementById('fileBtn')) return;
    //     const topbarActions = document.getElementById('topbarActions');
    //     if (topbarActions && !document.getElementById('portForwardBtn')) {
    //       const btn = document.createElement('button');
    //       btn.className = 'btn-sm';
    //       btn.id = 'portForwardBtn';
    //       btn.type = 'button';
    //       btn.title = t('端口转发 (-L/-R/-D)');
    //       btn.setAttribute('aria-label', t('端口转发'));
    //       btn.innerHTML = `<svg class="tb-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg><span class="tb-lbl" data-i18n="端口转发">${t('端口转发')}</span>`;
    //       const dockerBtn = document.getElementById('dockerBtn');
    //       if (dockerBtn && dockerBtn.parentNode === topbarActions) {
    //         dockerBtn.insertAdjacentElement('afterend', btn);
    //       } else {
    //         topbarActions.prepend(btn);
    //       }
    //     }
    // 
    //     const page = document.querySelector('.terminal-page');
    //     if (page && !document.getElementById('portForwardPanel')) {
    //       const panel = document.createElement('div');
    //       panel.id = 'portForwardPanel';
    //       panel.className = 'snippet-panel port-forward-panel';
    //       panel.style.display = 'none';
    //       panel.innerHTML = `
    //         <div class="panel-drag-handle" data-drag-panel="portForwardPanel" title="${t('拖动移动窗口')}">
    //           <button class="panel-traffic-btn" data-layout-panel="portForwardPanel" type="button" title="${t('窗口布局')}"><span></span></button>
    //         </div>
    //         <div class="snippet-panel-header panel-titlebar">
    //           <strong>
    //             <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent, #0A84FF)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg>
    //             <span class="z-panel-title-main">${t('端口转发')}</span>
    //           </strong>
    //           <button type="button" class="tool-btn panel-close-btn" id="portForwardCloseBtn" aria-label="${t('关闭')}">×</button>
    //         </div>
    //         <div class="snippet-panel-body port-forward-body">
    //           <div class="pf-top-card">
    //             <div class="pf-mode-row">
    //               <div class="pf-mode-bar" role="tablist" aria-label="转发模式">
    //                 <button type="button" class="pf-mode-pill active" data-pf-mode="L">本地转发 (-L)</button>
    //                 <button type="button" class="pf-mode-pill" data-pf-mode="R">远程转发 (-R)</button>
    //                 <button type="button" class="pf-mode-pill" data-pf-mode="D">动态代理 (-D)</button>
    //               </div>
    //               <span class="pf-agent-badge" title="Web 端端口转发通过本机 Zephyr Agent 落盘监听">Agent 隧道桥</span>
    //             </div>
    //             <div class="pf-form-row">
    //               <div class="pf-field">
    //                 <span class="pf-field-lbl" id="pfBindLbl">本地监听</span>
    //                 <input type="text" class="snippet-search pf-input" id="pfBindInput" placeholder="127.0.0.1:8080" value="127.0.0.1:8080">
    //               </div>
    //               <span class="pf-arrow" id="pfArrowSpan" aria-hidden="true">→</span>
    //               <div class="pf-field" id="pfTargetField">
    //                 <span class="pf-field-lbl">目标地址</span>
    //                 <input type="text" class="snippet-search pf-input" id="pfTargetInput" placeholder="127.0.0.1:80" value="127.0.0.1:80">
    //               </div>
    //               <button type="button" class="tool-btn pf-add-btn" id="pfAddBtn">+ 添加规则</button>
    //             </div>
    //           </div>
    //           <div class="pf-table-head">
    //             <span>模式</span>
    //             <span>监听地址</span>
    //             <span>目标地址</span>
    //             <span>状态</span>
    //             <span>操作</span>
    //           </div>
    //           <div class="snippet-list pf-list" id="pfList"></div>
    //         </div>
    //         <div class="panel-resize-handle left" data-resize-panel="portForwardPanel" data-resize-edge="left"></div>
    //         <div class="panel-resize-handle right" data-resize-panel="portForwardPanel" data-resize-edge="right"></div>
    //       `;
    //       page.appendChild(panel);
    // 
    //       let activeMode = 'L';
    //       panel.querySelectorAll('[data-pf-mode]').forEach((b) => {
    //         b.addEventListener('click', () => {
    //           activeMode = b.dataset.pfMode || 'L';
    //           panel.querySelectorAll('[data-pf-mode]').forEach((x) => x.classList.toggle('active', x === b));
    //           const targetField = panel.querySelector('#pfTargetField');
    //           const arrow = panel.querySelector('#pfArrowSpan');
    //           const bindLbl = panel.querySelector('#pfBindLbl');
    //           if (bindLbl) bindLbl.textContent = activeMode === 'R' ? '远端监听' : '本地监听';
    //           if (targetField) targetField.style.display = activeMode === 'D' ? 'none' : '';
    //           if (arrow) arrow.style.display = activeMode === 'D' ? 'none' : '';
    //         });
    //       });
    // 
    //       panel.querySelector('#portForwardCloseBtn')?.addEventListener('click', () => {
    //         panel.classList.remove('open');
    //         panel.style.display = 'none';
    //         document.getElementById('portForwardBtn')?.classList.remove('active');
    //       });
    // 
    //       panel.querySelector('#pfAddBtn')?.addEventListener('click', () => {
    //         const bind = panel.querySelector('#pfBindInput')?.value?.trim() || '127.0.0.1:8080';
    //         const target = activeMode === 'D' ? 'SOCKS5 动态代理' : (panel.querySelector('#pfTargetInput')?.value?.trim() || '127.0.0.1:80');
    //         const id = `pf_${Date.now().toString(36)}`;
    //         tunnels.push({ id, mode: activeMode, bind, target, bytes: 0, active: true });
    //         sendWs({ type: 'ssh-port-forward-start', id, mode: activeMode, bind, target });
    //         renderPortForwards();
    //       });
    //     }
    // 
    //     const pfBtn = document.getElementById('portForwardBtn');
    //     const pfPanel = document.getElementById('portForwardPanel');
    //     if (pfBtn && pfPanel && !pfBtn.dataset.pfBound) {
    //       pfBtn.dataset.pfBound = '1';
    //       pfBtn.addEventListener('click', () => {
    //         const isOpen = pfPanel.classList.contains('open');
    //         togglePortForwardPanel(!isOpen);
    //       });
    //     }
  }

  function renderPortForwards() {
    const list = document.getElementById('pfList');
    if (!list) return;
    if (!tunnels.length) {
      list.innerHTML = `
        <div class="pf-empty-card">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg>
          <strong>暂无活跃的端口转发规则</strong>
          <span>支持通过本机 Zephyr Agent 建立 -L 本地、-R 远程与 -D SOCKS5 动态隧道</span>
        </div>`;
      return;
    }
    list.innerHTML = tunnels.map((item) => `
      <div class="pf-row" data-pf-id="${escapeHtml(item.id)}">
        <span class="pf-badge pf-mode-${escapeHtml(item.mode)}">-${escapeHtml(item.mode)}</span>
        <code class="pf-addr">${escapeHtml(item.bind)}</code>
        <code class="pf-addr">${escapeHtml(item.target)}</code>
        <span class="pf-status-pill"><i class="pf-dot"></i>运行中</span>
        <button type="button" class="tool-btn danger pf-stop-btn" data-pf-stop="${escapeHtml(item.id)}">停止</button>
      </div>
    `).join('');
    list.querySelectorAll('[data-pf-stop]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.pfStop;
        const idx = tunnels.findIndex((x) => x.id === id);
        if (idx >= 0) tunnels.splice(idx, 1);
        sendWs({ type: 'ssh-port-forward-stop', id });
        renderPortForwards();
      });
    });
  }

  /* ── 5. Inline Buffer Search Bar & History-Read Unread Output Pill (4.2.6 #9) ── */
  let missedOutputRows = 0;
  let searchMatches = [];
  let searchCurrentIdx = -1;
  let searchCaseSensitive = false;
  let searchRegex = false;

  function ensureTerminalOverlays() {
    const container = document.getElementById('terminalContainer');
    if (!container) return;

    // Top-right Inline Search Bar
    if (!document.getElementById('terminalInlineSearchBar')) {
      const searchBar = document.createElement('div');
      searchBar.id = 'terminalInlineSearchBar';
      searchBar.className = 'terminal-inline-search-bar z-glass-regular';
      searchBar.style.display = 'none';
      searchBar.innerHTML = `
        <input type="search" id="termSearchInput" placeholder="Search buffer..." autocomplete="off">
        <button type="button" class="term-search-opt" id="termSearchCaseBtn" title="Match Case">Aa</button>
        <button type="button" class="term-search-opt" id="termSearchRegexBtn" title="Regular Expression">.*</button>
        <span class="term-search-count" id="termSearchCount">0 / 0</span>
        <button type="button" class="term-search-nav" id="termSearchPrevBtn" title="Previous (Shift+Enter)">↑</button>
        <button type="button" class="term-search-nav" id="termSearchNextBtn" title="Next (Enter)">↓</button>
        <button type="button" class="term-search-close" id="termSearchCloseBtn" title="Close (Esc)">×</button>
      `;
      container.appendChild(searchBar);

      const input = searchBar.querySelector('#termSearchInput');
      input?.addEventListener('input', () => runBufferSearch());
      input?.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { toggleInlineSearch(false); }
        else if (e.key === 'Enter') {
          e.preventDefault();
          stepBufferSearch(e.shiftKey ? -1 : 1);
        }
      });
      searchBar.querySelector('#termSearchCaseBtn')?.addEventListener('click', (e) => {
        searchCaseSensitive = !searchCaseSensitive;
        e.currentTarget.classList.toggle('active', searchCaseSensitive);
        runBufferSearch();
      });
      searchBar.querySelector('#termSearchRegexBtn')?.addEventListener('click', (e) => {
        searchRegex = !searchRegex;
        e.currentTarget.classList.toggle('active', searchRegex);
        runBufferSearch();
      });
      searchBar.querySelector('#termSearchPrevBtn')?.addEventListener('click', () => stepBufferSearch(-1));
      searchBar.querySelector('#termSearchNextBtn')?.addEventListener('click', () => stepBufferSearch(1));
      searchBar.querySelector('#termSearchCloseBtn')?.addEventListener('click', () => toggleInlineSearch(false));
    }

    // Bottom-right History-Read Unread Output Pill ([↓ N 行新输出 · 点击回到底部])
    if (!document.getElementById('terminalMissedOutputPill')) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.id = 'terminalMissedOutputPill';
      pill.className = 'terminal-missed-output-pill z-glass-regular';
      pill.style.display = 'none';
      pill.addEventListener('click', () => {
        missedOutputRows = 0;
        pill.style.display = 'none';
        getTerm?.()?.scrollToBottom?.();
      });
      container.appendChild(pill);
    }

    // Bottom inline ZMODEM / trzsz file transfer capsule
    if (!document.getElementById('terminalZmodemBar')) {
      const zbar = document.createElement('div');
      zbar.id = 'terminalZmodemBar';
      zbar.className = 'terminal-zmodem-bar z-glass-regular';
      zbar.style.display = 'none';
      zbar.innerHTML = `
        <span class="zmodem-label" id="zmodemLabel">ZMODEM / trzsz Transfer</span>
        <input type="file" id="zmodemUploadInput" style="display:none" multiple>
        <button type="button" class="tool-btn primary" id="zmodemPickBtn">Select Files (rz/trz)</button>
        <button type="button" class="tool-btn" id="zmodemCancelBtn">Cancel</button>
      `;
      container.appendChild(zbar);
      zbar.querySelector('#zmodemPickBtn')?.addEventListener('click', () => {
        zbar.querySelector('#zmodemUploadInput')?.click();
      });
      zbar.querySelector('#zmodemCancelBtn')?.addEventListener('click', () => {
        zbar.style.display = 'none';
        getWs?.()?.send(JSON.stringify({ type: 'input', data: '\x18\x18\x18\x18\x18\x08\x08\x08\x08\x08' }));
      });
    }

    // Bottom inline Paste-Bomb & High-Risk Command Security Guard Bar (10.5.1 & 10.6.2)
    if (!document.getElementById('terminalSecurityGuardBar')) {
      const gbar = document.createElement('div');
      gbar.id = 'terminalSecurityGuardBar';
      gbar.className = 'terminal-security-guard-bar z-glass-thick';
      gbar.style.display = 'none';
      container.appendChild(gbar);
    }
  }

  function toggleInlineSearch(open) {
    const bar = document.getElementById('terminalInlineSearchBar');
    if (!bar) return;
    bar.style.display = open ? 'inline-flex' : 'none';
    if (open) {
      const input = document.getElementById('termSearchInput');
      input?.focus();
      input?.select();
      runBufferSearch();
    } else {
      clearSearchHighlights();
    }
  }

  function clearSearchHighlights() {
    document.querySelectorAll('#wtermWrapper .term-row').forEach((r) => {
      r.classList.remove('term-search-hit', 'term-search-current');
    });
  }

  function runBufferSearch() {
    clearSearchHighlights();
    const q = document.getElementById('termSearchInput')?.value || '';
    const countEl = document.getElementById('termSearchCount');
    searchMatches = [];
    searchCurrentIdx = -1;
    if (!q) {
      if (countEl) countEl.textContent = '0 / 0';
      return;
    }
    let re = null;
    try {
      const flags = searchCaseSensitive ? 'g' : 'gi';
      re = searchRegex ? new RegExp(q, flags) : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    } catch {
      if (countEl) countEl.textContent = 'Invalid';
      return;
    }
    const rows = Array.from(document.querySelectorAll('#wtermWrapper .term-row'));
    rows.forEach((rowEl, idx) => {
      const txt = rowEl.textContent || '';
      if (re.test(txt)) {
        searchMatches.push(rowEl);
        rowEl.classList.add('term-search-hit');
      }
      re.lastIndex = 0;
    });
    if (searchMatches.length > 0) {
      searchCurrentIdx = searchMatches.length - 1;
      searchMatches[searchCurrentIdx].classList.add('term-search-current');
      if (countEl) countEl.textContent = `${searchCurrentIdx + 1} / ${searchMatches.length}`;
    } else {
      if (countEl) countEl.textContent = '0 / 0';
    }
  }

  function stepBufferSearch(delta) {
    if (!searchMatches.length) return;
    searchMatches[searchCurrentIdx]?.classList.remove('term-search-current');
    searchCurrentIdx = (searchCurrentIdx + delta + searchMatches.length) % searchMatches.length;
    const current = searchMatches[searchCurrentIdx];
    current?.classList.add('term-search-current');
    current?.scrollIntoView?.({ block: 'nearest' });
    const countEl = document.getElementById('termSearchCount');
    if (countEl) countEl.textContent = `${searchCurrentIdx + 1} / ${searchMatches.length}`;
  }

  function onIncomingTerminalChunk(chunkStr) {
    const str = String(chunkStr || '');
    // Sniff ZMODEM (**\x18B00 / **\x18B01) or trzsz (::TRZSZ:TRANSFER:)
    if (str.includes('**\x18B0') || str.includes('::TRZSZ:TRANSFER:')) {
      const zbar = document.getElementById('terminalZmodemBar');
      const zlabel = document.getElementById('zmodemLabel');
      if (zbar) {
        const isTrzsz = str.includes('::TRZSZ:TRANSFER:');
        const isReceive = str.includes('**\x18B01') || str.includes('::TRZSZ:TRANSFER:R');
        if (zlabel) zlabel.textContent = isTrzsz
          ? (isReceive ? 'trzsz Upload Ready (trz)' : 'trzsz Download Ready (tsz)')
          : (isReceive ? 'ZMODEM Upload Ready (rz)' : 'ZMODEM Download Ready (sz)');
        zbar.style.display = 'inline-flex';
      }
      return true; // Intercepted binary handshake
    }
    // Check if user is reading history (!isAtBottom) -> update missedOutputRows pill
    const term = getTerm?.();
    if (term && typeof term.isAtBottom === 'function' && !term.isAtBottom()) {
      const newLines = Math.max(1, (str.match(/\n/g) || []).length);
      missedOutputRows += newLines;
      const pill = document.getElementById('terminalMissedOutputPill');
      if (pill) {
        pill.textContent = `↓ ${missedOutputRows} lines · Scroll to bottom`;
        pill.style.display = 'inline-flex';
      }
    } else {
      missedOutputRows = 0;
      const pill = document.getElementById('terminalMissedOutputPill');
      if (pill) pill.style.display = 'none';
    }
    return false;
  }

  /* ── 6. Ctrl/Alt + Click on /path/to/file:line in terminal to open SFTP editor ── */
  function bindTerminalPathClick() {
    const wrapper = document.getElementById('wtermWrapper');
    if (!wrapper || wrapper.dataset.pathClickBound === '1') return;
    wrapper.dataset.pathClickBound = '1';
    wrapper.addEventListener('click', (e) => {
      if (!e.ctrlKey && !e.metaKey && !e.altKey) return;
      const row = e.target.closest('.term-row');
      if (!row) return;
      const text = row.textContent || '';
      const m = text.match(/(\/[A-Za-z0-9._\-/]+\.[A-Za-z0-9]{1,8})(?::(\d+))?/);
      if (m && m[1]) {
        e.preventDefault();
        openEditor?.(m[1]);
      }
    });
  }

  /* ── 7. Global shortcut Ctrl/Cmd+F for inline buffer search ──────────── */
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'f') {
      const inEditor = e.target.closest?.('.fm-editor-modal, input, textarea');
      if (inEditor && e.target.id !== 'termSearchInput') return;
      e.preventDefault();
      toggleInlineSearch(true);
    }
  });


  const PANEL_TO_BTN_ID = {
    fileManager: 'fileBtn',
    infoModal: 'infoBtn',
    dockerPanel: 'dockerBtn',
    portForwardPanel: 'portForwardBtn',
    snippetPanel: 'snippetBtn',
    terminalNotesPanel: 'notesBtn',
    shortcutPanel: 'shortcutBtn',
    clipboardPanel: 'clipboardBtn',
    filesPanel: 'rdpFilesBtn',
    shortcutsPanel: 'shortcutsBtn',
    joystickPanel: (typeof document !== 'undefined' && document.getElementById('joystickBtn')) ? 'joystickBtn' : 'dragBtn',
  };

  function ensureDesktopEmbedFlag() {
    try {
      const params = new URLSearchParams(location.search);
      const isEmbed = params.get('embed') === '1' || window.parent !== window;
      const parentDesktop = isEmbed && window.parent && (
        window.parent.innerWidth >= 761 ||
        window.parent.document?.documentElement?.dataset?.zephyrSurface === 'desktop'
      );
      if (parentDesktop || window.innerWidth >= 761 || params.get('desktop') === '1') {
        document.documentElement.dataset.zephyrSurface = 'desktop';
        document.body?.classList.add('desktop-embed');
      }
    } catch {}
  }
  ensureDesktopEmbedFlag();
  window.addEventListener('resize', ensureDesktopEmbedFlag);

  let pinnedSeqCounter = 0;

  function resolvePreferredDockSide(excludePanel = null) {
    const page = document.querySelector('.terminal-page') || document.body;
    const otherPinned = Array.from(page.querySelectorAll('.z-unified-panel.pinned, .z-unified-panel.docked-left, .z-unified-panel.docked-right'))
      .filter((p) => p !== excludePanel && p.classList.contains('open') && p.style.display !== 'none');
    if (otherPinned.length === 1) {
      const otherPref = otherPinned[0].dataset.preferredDockSide || otherPinned[0].dataset.unifiedDockSide || 'right';
      return otherPref === 'left' ? 'right' : 'left';
    }
    const slotSide = window.__zephyrPaneSlotSide || 'single';
    if (slotSide === 'left' || slotSide === 'middle-force-left') return 'left';
    if (slotSide === 'right' || slotSide === 'middle-force-right') return 'right';
    if (window.__zephyrUserPreferredDockSide === 'left' || window.__zephyrUserPreferredDockSide === 'right') {
      return window.__zephyrUserPreferredDockSide;
    }
    return 'right';
  }

  function computeForcedBoundaryDockSide(slotSide = window.__zephyrPaneSlotSide || 'single') {
    // Active / operated terminal ('single', 'active', 'middle-active') NEVER forces a single side:
    // it always arranges tiles Left & Right just like single-window mode!
    // Only inactive / non-operated multi-window terminals ('left', 'right', 'middle-force-left', 'middle-force-right')
    // place their tiles on the outer non-boundary side.
    if (slotSide === 'left' || slotSide === 'middle-force-left') return 'left';
    if (slotSide === 'right' || slotSide === 'middle-force-right') return 'right';
    return null;
  }

  function applyPinnedPanelsGridAssignment(page) {
    if (!page) return;
    const pinnedPanels = Array.from(page.querySelectorAll('.z-unified-panel.pinned'))
      .filter((p) => p.classList.contains('open') && p.style.display !== 'none')
      .sort((a, b) => (Number(a.dataset.pinnedSeq) || 0) - (Number(b.dataset.pinnedSeq) || 0));

    // At most 2 pinned tiles per terminal
    while (pinnedPanels.length > 2) {
      const oldest = pinnedPanels.shift();
      if (oldest) {
        oldest.classList.remove('docked-right', 'docked-left', 'pinned', 'panel-fullscreen', 'docked-slot-top', 'docked-slot-bottom');
        delete oldest.dataset.unifiedDockSide;
        delete oldest.dataset.preferredDockSide;
        restorePreDockOrDefaultRect(oldest);
        oldest.querySelectorAll('.panel-pin-toggle').forEach((b) => {
          b.classList.remove('active', 'on');
          b.setAttribute('aria-pressed', 'false');
        });
      }
    }

    if (pinnedPanels.length === 2) {
      const p0 = pinnedPanels[0];
      const p1 = pinnedPanels[1];
      const s0 = p0.dataset.preferredDockSide === 'left' ? 'left' : 'right';
      let s1 = p1.dataset.preferredDockSide === 'left' ? 'left' : 'right';
      if (s0 === s1) {
        s1 = s0 === 'left' ? 'right' : 'left';
        p1.dataset.preferredDockSide = s1;
      }
    }

    const forcedSide = computeForcedBoundaryDockSide(window.__zephyrPaneSlotSide || 'single');
    page.classList.remove('has-dual-dock-left', 'has-dual-dock-right');

    for (let idx = 0; idx < pinnedPanels.length; idx++) {
      const p = pinnedPanels[idx];
      const pref = (p.dataset.preferredDockSide === 'left' || p.dataset.preferredDockSide === 'right')
        ? p.dataset.preferredDockSide
        : 'right';
      p.dataset.preferredDockSide = pref;
      const effectiveSide = forcedSide || pref;
      p.classList.remove('docked-left', 'docked-right', 'docked-slot-top', 'docked-slot-bottom', 'panel-fullscreen', 'panel-focused');
      p.classList.add(effectiveSide === 'left' ? 'docked-left' : 'docked-right', 'pinned', 'open');
      p.style.display = 'flex';
      p.dataset.unifiedDockSide = effectiveSide;
      clearFloatingInlineGeometry(p);
      // When two tiles are placed on the same outer side of an inactive pane, stack them full-height in the same rail (no top/bottom split!)
      p.style.zIndex = String(idx + 1);
      p.style.removeProperty('--panel-z');
      p.querySelectorAll('.panel-pin-toggle').forEach((b) => {
        b.classList.add('active', 'on');
        b.setAttribute('aria-pressed', 'true');
      });
    }
  }

  function syncHostWindowDockAndFloatState({ userTriggered = false } = {}) {
    const page = document.querySelector('.terminal-page') || document.body;
    const isInactiveSlot = page.classList.contains('pane-slot-inactive');
    const rawDockedRight = !!page.querySelector('.z-unified-panel.open.docked-right, .docked-right.open');
    const rawDockedLeft = !!page.querySelector('.z-unified-panel.open.docked-left, .docked-left.open');
    const dockedRight = !isInactiveSlot && rawDockedRight;
    const dockedLeft = !isInactiveSlot && rawDockedLeft;
    const anyDocked = rawDockedRight || rawDockedLeft;
    const anyFloating = !!page.querySelector('.z-unified-panel.open:not(.docked-right):not(.docked-left)');

    if (!dockedRight && !dockedLeft) {
      page.classList.remove('has-docked-right', 'has-docked-left', 'has-dual-dock-left', 'has-dual-dock-right');
    } else {
      page.classList.toggle('has-docked-right', dockedRight);
      page.classList.toggle('has-docked-left', dockedLeft);
    }
    page.querySelectorAll('.panel-fullscreen.open').forEach((fp) => {
      if (!fp.classList.contains('z-panel-morphing')) {
        const fbox = computeAvailableFullscreenBox(fp, page);
        fp.style.left = `${fbox.left}px`;
        fp.style.top = `${fbox.top}px`;
        fp.style.width = `${fbox.width}px`;
        fp.style.height = `${fbox.height}px`;
      }
    });

    // Sync toolbar button active highlights for all 7 panels
    for (const [panelId, btnId] of Object.entries(PANEL_TO_BTN_ID)) {
      const p = document.getElementById(panelId);
      const b = document.getElementById(btnId);
      if (p && b) {
        const isOpen = p.classList.contains('open') && p.style.display !== 'none';
        b.classList.toggle('active', isOpen);
      }
    }

    // Same-origin direct sync to parent .terminal-window + postMessage
    const pinSides = [];
    if (dockedLeft) pinSides.push('left');
    if (dockedRight) pinSides.push('right');
    const prW = page.getBoundingClientRect?.().width || window.innerWidth || 1280;
    const dualDockW = (dockedLeft && dockedRight) ? Math.min(360, Math.max(280, Math.round(prW * 0.28))) : 360;
    page.style.setProperty('--z-dual-dock-w', `${dualDockW}px`);
    try {
      const hostWin = window.frameElement?.closest?.('.terminal-window');
      if (hostWin) {
        hostWin.style.setProperty('--z-dual-dock-w', `${dualDockW}px`);
        hostWin.classList.toggle('window-has-dock-right', dockedRight);
        hostWin.classList.toggle('window-has-dock-left', dockedLeft);
        hostWin.classList.toggle('window-has-floating-panel', anyFloating && !anyDocked);
      }
    } catch {}

    if (window.parent !== window) {
      try {
        const tabId = new URLSearchParams(location.search).get('tabId') || '';
        window.parent.postMessage({
          source: 'zephyr-terminal',
          type: 'zephyr-panel-pin-state',
          tabId,
          hasPinnedPanel: anyDocked,
          pinSides,
          hasFloatingPanel: anyFloating,
          userTriggered: Boolean(userTriggered),
        }, '*');
      } catch {}
    }
  }

  function clearFloatingInlineGeometry(panel) {
    if (!panel) return;
    panel.style.position = '';
    panel.style.left = '';
    panel.style.top = '';
    panel.style.right = '';
    panel.style.bottom = '';
    panel.style.width = '';
    panel.style.height = '';
    panel.style.transform = '';
    panel.style.clipPath = '';
    panel.style.opacity = '';
  }

  function getMotion() {
    return window.Motion || null;
  }

  let floatingFocusZSeed = 120;
  function setFocusedFloatingPanel(targetPanel) {
    const allFloaters = document.querySelectorAll(
      '.z-unified-panel, .z-unified-secondary-panel, .fm-editor-modal, .image-preview-modal, .media-preview-modal, .fm-props-modal'
    );
    const Motion = getMotion();
    allFloaters.forEach((p) => {
      const isDocked = p.classList.contains('docked-left') || p.classList.contains('docked-right') || !!p.dataset.unifiedDockSide;
      const shouldFocus = p === targetPanel && !isDocked && p.classList.contains('open') !== false && p.style.display !== 'none';
      if (shouldFocus) {
        const nextZ = ++floatingFocusZSeed;
        p.style.zIndex = String(nextZ);
        p.style.setProperty('--panel-z', String(nextZ));
      }
      if (Motion?.panelResizeRing) {
        Motion.panelResizeRing(p, shouldFocus);
      } else {
        p.classList.toggle('panel-focused', shouldFocus);
      }
    });
  }

  if (!document.documentElement.dataset.outerRingFocusBound) {
    document.documentElement.dataset.outerRingFocusBound = '1';
    document.addEventListener('pointerdown', (ev) => {
      if (ev.target.closest?.('.z-panel-more-popover')) return;
      const hitPanel = ev.target.closest?.(
        '.z-unified-panel, .z-unified-secondary-panel, .fm-editor-modal, .image-preview-modal, .media-preview-modal, .fm-props-modal'
      );
      setFocusedFloatingPanel(hitPanel || null);
    }, true);
  }

  function getWorkspaceTopInset(page) {
    const topbarEl = page?.querySelector?.(':scope > .terminal-topbar, :scope > .topbar-actions');
    const pr = page?.getBoundingClientRect?.() || { top: 0 };
    if (topbarEl) {
      const tr = topbarEl.getBoundingClientRect();
      if (tr.height > 0) {
        return Math.max(48, Math.round(tr.bottom - (pr.top || 0) + 8));
      }
    }
    const anyDocked = page?.classList?.contains?.('has-docked-left') || page?.classList?.contains?.('has-docked-right');
    return anyDocked ? 94 : 52;
  }

  function computeAvailableFullscreenBox(panel, pageEl) {
    const page = pageEl || panel?.closest?.('.terminal-page, .rdp-page, .app-shell') || document.querySelector('.terminal-page') || document.body;
    const pr = page.getBoundingClientRect?.() || { width: window.innerWidth || 1280, height: window.innerHeight || 800 };
    const isSelfDocked = panel?.classList?.contains?.('docked-right') || panel?.classList?.contains?.('docked-left');
    const bothDocked = !isSelfDocked && page.classList.contains('has-docked-right') && page.classList.contains('has-docked-left');
    const singleDockW = bothDocked ? Math.min(360, Math.max(280, Math.round(pr.width * 0.27))) : 360;
    const dockRightW = (!isSelfDocked && page.classList.contains('has-docked-right')) ? singleDockW : 0;
    const dockLeftW = (!isSelfDocked && page.classList.contains('has-docked-left')) ? singleDockW : 0;
    const left = dockLeftW + 12;
    const top = getWorkspaceTopInset(page);
    const width = Math.max(320, Math.round(pr.width - dockLeftW - dockRightW - 24));
    const height = Math.max(240, Math.round(pr.height - top - 12));
    return { left, top, width, height };
  }

  function rememberPreDockRect(panel) {
    if (!panel || panel.classList.contains('docked-left') || panel.classList.contains('docked-right') || panel.classList.contains('panel-fullscreen')) return;
    const page = panel.closest('.terminal-page, .rdp-page, .app-shell') || document.body;
    const pr = page.getBoundingClientRect?.() || { left: 0, top: 0 };
    const r = panel.getBoundingClientRect();
    const frameTop = (typeof window !== 'undefined' && window.frameElement?.getBoundingClientRect)
      ? window.frameElement.getBoundingClientRect().top
      : 0;
    if (r.width > 120 && r.height > 120) {
      const styleL = parseFloat(panel.style.left);
      const styleT = parseFloat(panel.style.top);
      const styleW = parseFloat(panel.style.width);
      const styleH = parseFloat(panel.style.height);
      panel._preDockBox = {
        left: Number.isFinite(styleL) ? Math.round(styleL) : Math.round(r.left - pr.left),
        top: Number.isFinite(styleT) ? Math.round(styleT) : Math.round(r.top - pr.top),
        width: Number.isFinite(styleW) ? Math.round(styleW) : Math.round(r.width),
        height: Number.isFinite(styleH) ? Math.round(styleH) : Math.round(r.height),
        frameTop,
      };
    }
  }

  function restorePreDockOrDefaultRect(panel) {
    if (!panel) return;
    const page = panel.closest('.terminal-page, .rdp-page, .app-shell') || document.body;
    const pr = page.getBoundingClientRect?.() || { width: window.innerWidth || 1280, height: window.innerHeight || 800, left: 0, top: 0 };
    const bothDocked = page.classList.contains('has-docked-right') && page.classList.contains('has-docked-left');
    const singleDockW = bothDocked ? Math.min(360, Math.max(280, Math.round(pr.width * 0.27))) : 360;
    const dockRightW = page.classList.contains('has-docked-right') ? singleDockW : 0;
    const dockLeftW = page.classList.contains('has-docked-left') ? singleDockW : 0;
    const availW = Math.max(360, pr.width - dockLeftW - dockRightW);
    const minTop = getWorkspaceTopInset(page);

    const box = panel._preDockBox;
    if (box && box.width > 120 && box.height > 120) {
      const nowFrameTop = (typeof window !== 'undefined' && window.frameElement?.getBoundingClientRect)
        ? window.frameElement.getBoundingClientRect().top
        : 0;
      const shiftY = Math.round((box.frameTop || 0) - nowFrameTop);
      const w = Math.min(box.width, Math.max(340, availW - 24));
      const h = Math.min(box.height, Math.max(260, pr.height - minTop - 20));
      const minLeft = dockLeftW + 14;
      const maxLeft = Math.max(minLeft, pr.width - dockRightW - w - 14);
      const maxTop = Math.max(minTop, pr.height - h - 20);
      const left = Math.min(Math.max(box.left, minLeft), maxLeft);
      const top = Math.min(Math.max(box.top + shiftY, minTop), maxTop);
      panel.style.width = `${w}px`;
      panel.style.height = `${h}px`;
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.dataset.floatingPositionLocked = '1';
      return;
    }
    ensureFloatingDefaultPosition(panel, { forceReset: true });
  }

  function ensureFloatingDefaultPosition(panel, { defaultW = 580, defaultH = 390, triggerBtn = null, forceReset = false } = {}) {
    if (!panel) return;
    if (panel.classList.contains('docked-left') || panel.classList.contains('docked-right') || panel.classList.contains('pinned') || panel.dataset.unifiedDockSide) return;
    if (panel.classList.contains('panel-fullscreen')) return;

    const page = panel.closest('.terminal-page, .rdp-page, .app-shell') || document.body;
    const pr = page.getBoundingClientRect?.() || { width: window.innerWidth || 1280, height: window.innerHeight || 800, left: 0, top: 0 };
    const bothDocked = page.classList.contains('has-docked-right') && page.classList.contains('has-docked-left');
    const singleDockW = bothDocked ? Math.min(360, Math.max(280, Math.round(pr.width * 0.27))) : 360;
    const dockRightW = page.classList.contains('has-docked-right') ? singleDockW : 0;
    const dockLeftW = page.classList.contains('has-docked-left') ? singleDockW : 0;
    const availW = Math.max(360, pr.width - dockLeftW - dockRightW);
    const minTop = getWorkspaceTopInset(page);

    // If panel already has an initialized floating position, keep it stable (only soft-clamp to available bounds)
    const curL = parseFloat(panel.style.left);
    const curT = parseFloat(panel.style.top);
    const curW = parseFloat(panel.style.width) || defaultW;
    const curH = parseFloat(panel.style.height) || defaultH;
    if (!forceReset && (panel.dataset.floatingPositionLocked === '1' || panel.dataset.userPlaced === '1' || panel.classList.contains('editor-window')) && Number.isFinite(curL) && Number.isFinite(curT)) {
      const minLeft = dockLeftW + 14;
      const maxLeft = Math.max(minLeft, pr.width - dockRightW - curW - 14);
      const maxTop = Math.max(minTop, pr.height - curH - 20);
      const clampedL = Math.min(Math.max(curL, minLeft), maxLeft);
      const clampedT = Math.min(Math.max(curT, minTop - 6), maxTop);
      if (Math.abs(clampedL - curL) >= 1) panel.style.left = `${Math.round(clampedL)}px`;
      if (Math.abs(clampedT - curT) >= 1) panel.style.top = `${Math.round(clampedT)}px`;
      return;
    }

    const isSecondary = panel.classList.contains('z-unified-secondary-panel')
      || panel.classList.contains('fm-editor-modal')
      || panel.classList.contains('image-preview-modal')
      || panel.classList.contains('media-preview-modal')
      || panel.classList.contains('fm-props-modal')
      || panel.classList.contains('docker-log-drawer');
    const w = Math.min(defaultW, Math.max(340, availW - 36));
    const h = Math.min(defaultH, Math.max(260, pr.height - minTop - 48));

    const minLeft = dockLeftW + 18;
    const maxLeft = Math.max(minLeft, pr.width - dockRightW - w - 18);
    const maxTop = Math.max(minTop, pr.height - h - 32);

    let left;
    let top;
    if (isSecondary) {
      left = Math.round(dockLeftW + (availW - w) / 2);
      top = Math.round(minTop + Math.max(0, (pr.height - minTop - h - 48)) * 0.25);
    } else {
      const orderIdx = Math.max(0, Object.keys(PANEL_TO_BTN_ID).indexOf(panel.id));
      const btnId = PANEL_TO_BTN_ID[panel.id];
      const btn = triggerBtn || (btnId ? document.getElementById(btnId) : null);
      const btnRect = btn?.getBoundingClientRect?.();
      if (btnRect && btnRect.width > 0 && pr.width > 0) {
        left = Math.round(btnRect.left - (pr.left || 0));
      } else {
        left = minLeft + orderIdx * 32;
      }
      top = minTop;
      left = Math.min(Math.max(left, minLeft), maxLeft);
      top = Math.min(Math.max(top, minTop), maxTop);

      const openOthers = Array.from(page.querySelectorAll('.z-unified-panel.open:not(.docked-left):not(.docked-right):not(.panel-fullscreen)'))
        .filter((other) => other !== panel && other.style.display !== 'none' && other.dataset.floatingPositionLocked === '1');
      for (let i = 0; i < openOthers.length; i++) {
        const oLeft = parseFloat(openOthers[i].style.left) || 0;
        const oTop = parseFloat(openOthers[i].style.top) || 0;
        if (Math.abs(oTop - top) < 28 && Math.abs(oLeft - left) < 72) {
          left += 32;
          top += 28;
        }
      }
    }

    left = Math.min(Math.max(left, minLeft), maxLeft);
    top = Math.min(Math.max(top, minTop), maxTop);

    panel.style.width = `${w}px`;
    panel.style.height = `${h}px`;
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    if (panel.classList.contains('open') || panel.classList.contains('show') || panel.style.display === 'flex') {
      panel.dataset.floatingPositionLocked = '1';
    }
  }
  window.__zephyrEnsureFloatingDefaultPosition = ensureFloatingDefaultPosition;

  function rememberPreFullscreenRect(panel) {
    if (!panel || panel.classList.contains('panel-fullscreen') || panel.classList.contains('docked-left') || panel.classList.contains('docked-right')) return;
    const r = panel.getBoundingClientRect();
    if (r.width > 100 && r.height > 100) {
      panel._preFullscreenBox = {
        left: panel.style.left || `${Math.round(r.left)}px`,
        top: panel.style.top || `${Math.round(r.top)}px`,
        width: panel.style.width || `${Math.round(r.width)}px`,
        height: panel.style.height || `${Math.round(r.height)}px`,
      };
    }
  }

  function updateMaximizeButtonIcon(panel) {
    const maxBtn = panel?.querySelector?.('.panel-max-btn');
    if (!maxBtn) return;
    const isFull = panel.classList.contains('panel-fullscreen');
    maxBtn.innerHTML = isFull ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="8" width="12" height="12" rx="1.5"/><path d="M8 8V5.5A1.5 1.5 0 0 1 9.5 4h9A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H16"/></svg>' : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>';
    maxBtn.title = isFull ? t('还原窗口') : t('全屏');
    maxBtn.setAttribute('aria-label', isFull ? t('还原窗口') : t('全屏'));
    maxBtn.classList.toggle('active', isFull);
  }

  function toggleSecondaryPanelFullscreen(panel) {
    if (!panel) return;
    const page = panel.closest('.terminal-page, .rdp-page, .app-shell') || document.body;
    const isFull = panel.classList.contains('panel-fullscreen');
    const Motion = getMotion();

    if (!isFull) {
      rememberPreFullscreenRect(panel);
    }

    const applyMutation = () => {
      if (isFull) {
        panel.classList.remove('panel-fullscreen');
        const box = panel._preFullscreenBox;
        if (box) {
          panel.style.left = box.left;
          panel.style.top = box.top;
          panel.style.width = box.width;
          panel.style.height = box.height;
          panel.style.right = 'auto';
          panel.style.bottom = 'auto';
        } else {
          clearFloatingInlineGeometry(panel);
          ensureFloatingDefaultPosition(panel, { defaultW: 680, defaultH: 440, forceReset: true });
        }
      } else {
        const fbox = computeAvailableFullscreenBox(panel, page);
        panel.classList.add('panel-fullscreen', 'open');
        panel.style.display = 'flex';
        panel.style.left = `${fbox.left}px`;
        panel.style.top = `${fbox.top}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.width = `${fbox.width}px`;
        panel.style.height = `${fbox.height}px`;
      }
      updateMaximizeButtonIcon(panel);
      setFocusedFloatingPanel(panel);
      window.dispatchEvent(new Event('resize'));
    };

    if (Motion?.panelDockMorph) {
      Motion.panelDockMorph(panel, applyMutation, { preset: 'mac' });
    } else {
      applyMutation();
    }
  }

  function reconcilePinnedPanelsForSlotSide(page, { animate = true } = {}) {
    if (!page) return;
    const pinned = Array.from(page.querySelectorAll('.z-unified-panel.pinned'))
      .filter((p) => p.classList.contains('open') && p.style.display !== 'none');
    if (!pinned.length) return;

    const forcedSide = computeForcedBoundaryDockSide(window.__zephyrPaneSlotSide || 'single');
    let needsChange = false;
    for (const p of pinned) {
      const pref = (p.dataset.preferredDockSide === 'left' || p.dataset.preferredDockSide === 'right')
        ? p.dataset.preferredDockSide
        : 'right';
      const targetSide = forcedSide || pref;
      const currentSide = p.dataset.unifiedDockSide || (p.classList.contains('docked-left') ? 'left' : (p.classList.contains('docked-right') ? 'right' : ''));
      if (currentSide !== targetSide) {
        needsChange = true;
        break;
      }
    }
    if (!needsChange) return;

    const Motion = getMotion();
    const mutate = () => {
      applyPinnedPanelsGridAssignment(page);
      syncHostWindowDockAndFloatState({ userTriggered: false });
    };
    // When a pane becomes an inactive multi-window slot (forcedSide !== null), immediately place its docked tile
    // onto the outer side so it slides off-screen with the pane and never lingers in the 20% boundary strip.
    if (animate && !forcedSide && Motion?.panelDockMorph) {
      void Motion.panelDockMorph(pinned, mutate, { preset: { response: 0.24, damping: 1.0 } });
    } else {
      mutate();
    }
  }

  function togglePanelDockState(panel, explicitSide, { userTriggered = true } = {}) {
    if (!panel) return;
    const page = panel.closest('.terminal-page, .rdp-page, .app-shell') || document.body;
    const isDocked = panel.classList.contains('docked-right') || panel.classList.contains('docked-left') || panel.classList.contains('pinned') || !!panel.dataset.unifiedDockSide;
    const isFullscreen = panel.classList.contains('panel-fullscreen');
    const Motion = getMotion();

    // If a docked panel itself receives 'fullscreen', ignore it so the pinned tile never drops!
    if (explicitSide === 'fullscreen' && isDocked) {
      return;
    }

    if (!isDocked && !isFullscreen && explicitSide !== 'float') {
      rememberPreDockRect(panel);
    }
    if (explicitSide === 'fullscreen' && !isFullscreen && !isDocked) {
      rememberPreFullscreenRect(panel);
    }

    const applyMutation = () => {
      if ((isDocked && !explicitSide) || explicitSide === 'float' || (explicitSide === 'fullscreen' && isFullscreen)) {
        panel.classList.remove('docked-right', 'docked-left', 'pinned', 'panel-fullscreen', 'docked-slot-top', 'docked-slot-bottom');
        delete panel.dataset.unifiedDockSide;
        delete panel.dataset.preferredDockSide;
        const box = panel._preFullscreenBox;
        clearFloatingInlineGeometry(panel);
        panel.querySelectorAll('.panel-pin-toggle').forEach((b) => {
          b.classList.remove('active', 'on');
          b.setAttribute('aria-pressed', 'false');
        });
        updateMaximizeButtonIcon(panel);
        applyPinnedPanelsGridAssignment(page);
        syncHostWindowDockAndFloatState({ userTriggered });
        if (box && explicitSide === 'fullscreen') {
          panel.style.left = box.left;
          panel.style.top = box.top;
          panel.style.width = box.width;
          panel.style.height = box.height;
          panel.style.right = 'auto';
          panel.style.bottom = 'auto';
        } else {
          restorePreDockOrDefaultRect(panel);
        }
        setFocusedFloatingPanel(panel);
      } else if (explicitSide === 'fullscreen') {
        const fbox = computeAvailableFullscreenBox(panel, page);
        panel.classList.add('panel-fullscreen', 'open');
        panel.style.display = 'flex';
        panel.style.left = `${fbox.left}px`;
        panel.style.top = `${fbox.top}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.width = `${fbox.width}px`;
        panel.style.height = `${fbox.height}px`;
        updateMaximizeButtonIcon(panel);
        setFocusedFloatingPanel(panel);
      } else {
        const otherPinned = Array.from(page.querySelectorAll('.z-unified-panel.pinned, .z-unified-panel.docked-left, .z-unified-panel.docked-right'))
          .filter((p) => p !== panel && p.classList.contains('open') && p.style.display !== 'none');

        let preferredSide;
        if (explicitSide === 'left' || explicitSide === 'right') {
          preferredSide = explicitSide;
          if (userTriggered) {
            window.__zephyrUserPreferredDockSide = explicitSide;
          }
          if (otherPinned.length === 1 && otherPinned[0].dataset.preferredDockSide === preferredSide) {
            otherPinned[0].dataset.preferredDockSide = preferredSide === 'left' ? 'right' : 'left';
          } else if (otherPinned.length >= 2) {
            const victim = otherPinned.find((p) => p.dataset.preferredDockSide === preferredSide) || otherPinned[0];
            if (victim) {
              victim.classList.remove('docked-right', 'docked-left', 'pinned', 'panel-fullscreen', 'docked-slot-top', 'docked-slot-bottom');
              delete victim.dataset.unifiedDockSide;
              delete victim.dataset.preferredDockSide;
              restorePreDockOrDefaultRect(victim);
              victim.querySelectorAll('.panel-pin-toggle').forEach((b) => {
                b.classList.remove('active', 'on');
                b.setAttribute('aria-pressed', 'false');
              });
            }
          }
        } else {
          if (otherPinned.length === 1) {
            const otherPref = otherPinned[0].dataset.preferredDockSide || otherPinned[0].dataset.unifiedDockSide || 'right';
            preferredSide = otherPref === 'left' ? 'right' : 'left';
          } else if (otherPinned.length >= 2) {
            const victim = otherPinned[0];
            preferredSide = victim.dataset.preferredDockSide || 'right';
            victim.classList.remove('docked-right', 'docked-left', 'pinned', 'panel-fullscreen', 'docked-slot-top', 'docked-slot-bottom');
            delete victim.dataset.unifiedDockSide;
            delete victim.dataset.preferredDockSide;
            restorePreDockOrDefaultRect(victim);
            victim.querySelectorAll('.panel-pin-toggle').forEach((b) => {
              b.classList.remove('active', 'on');
              b.setAttribute('aria-pressed', 'false');
            });
          } else {
            preferredSide = panel.dataset.preferredDockSide || resolvePreferredDockSide(panel);
            const slotSide = window.__zephyrPaneSlotSide || 'single';
            if (userTriggered && (slotSide === 'single' || slotSide === 'active' || slotSide === 'middle-active') && !window.__zephyrUserPreferredDockSide) {
              window.__zephyrUserPreferredDockSide = preferredSide;
            }
          }
        }

        if (!panel.dataset.pinnedSeq) {
          panel.dataset.pinnedSeq = String(++pinnedSeqCounter);
        }
        panel.dataset.preferredDockSide = preferredSide;
        panel.classList.add('pinned', 'open');
        panel.style.display = 'flex';
        if (Motion?.panelResizeRing) Motion.panelResizeRing(panel, false);
        applyPinnedPanelsGridAssignment(page);
      }
      syncHostWindowDockAndFloatState({ userTriggered });
    };

    if (Motion?.panelDockMorph) {
      Motion.panelDockMorph(panel, applyMutation, { preset: { response: 0.22, damping: 0.98 } });
    } else {
      applyMutation();
    }
  }

  function closeUnifiedPanel(panel, { triggerBtn = null, onAfterClose = null } = {}) {
    if (!panel) {
      onAfterClose?.();
      return;
    }
    closeUnifiedMorePopover({ instant: true });
    const page = panel.closest('.terminal-page, .rdp-page, .app-shell') || document.body;
    const isDocked = panel.classList.contains('docked-right') || panel.classList.contains('docked-left') || panel.classList.contains('pinned') || !!panel.dataset.unifiedDockSide;
    const Motion = getMotion();
    const btnId = PANEL_TO_BTN_ID[panel.id];
    const btn = triggerBtn || (btnId ? document.getElementById(btnId) : null);

    panel.classList.remove('panel-focused');
    if (Motion?.panelResizeRing) Motion.panelResizeRing(panel, false);

    if (isDocked) {
      const mutateClose = () => {
        panel.classList.remove('docked-right', 'docked-left', 'pinned', 'open', 'show', 'panel-fullscreen', 'docked-slot-top', 'docked-slot-bottom');
        delete panel.dataset.unifiedDockSide;
        delete panel.dataset.preferredDockSide;
        panel.querySelectorAll('.panel-pin-toggle').forEach((b) => {
          b.classList.remove('active', 'on');
          b.setAttribute('aria-pressed', 'false');
        });
        applyPinnedPanelsGridAssignment(page);
        syncHostWindowDockAndFloatState({ userTriggered: true });
        onAfterClose?.();
      };
      if (Motion?.panelDockMorph) {
        void Motion.panelDockMorph(panel, mutateClose, { preset: { response: 0.20, damping: 1.0 } });
      } else {
        mutateClose();
        panel.style.display = 'none';
      }
      return;
    }

    if (Motion?.panelCloseWasm) {
      void Motion.panelCloseWasm(panel, btn, {
        preset: 'snappy',
        onDone: () => {
          panel.classList.remove('open', 'show', 'panel-fullscreen');
          panel.style.display = 'none';
          syncHostWindowDockAndFloatState();
          onAfterClose?.();
        },
      });
      return;
    }
    panel.classList.remove('open', 'show', 'panel-fullscreen');
    panel.style.display = 'none';
    syncHostWindowDockAndFloatState();
    onAfterClose?.();
  }
  window.__zephyrCloseUnifiedPanel = closeUnifiedPanel;

  let activeMorePopover = null;
  let activeMoreAnchor = null;

  function closeUnifiedMorePopover({ instant = false } = {}) {
    if (!activeMorePopover) return;
    const pop = activeMorePopover;
    const btn = activeMoreAnchor;
    activeMorePopover = null;
    activeMoreAnchor = null;
    btn?.classList?.remove('active');
    const Motion = getMotion();
    if (!instant && Motion?.panelMorePopover) {
      Motion.panelMorePopover(pop, btn, false, { onClosed: () => pop.remove() });
    } else {
      pop.remove();
    }
  }

  function openUnifiedMorePopover(panel, moreBtn) {
    if (activeMorePopover && activeMoreAnchor === moreBtn) {
      closeUnifiedMorePopover();
      return;
    }
    closeUnifiedMorePopover({ instant: true }); document.querySelectorAll('.z-panel-more-popover').forEach((el) => el.remove());

    const slotSide = window.__zephyrPaneSlotSide || 'single';
    const allowLeft = true;
    const allowRight = true;
    const prefSide = panel.dataset.preferredDockSide || panel.dataset.unifiedDockSide || '';
    const isDockedLeft = panel.classList.contains('pinned') ? prefSide === 'left' : panel.classList.contains('docked-left');
    const isDockedRight = panel.classList.contains('pinned') ? prefSide === 'right' : panel.classList.contains('docked-right');
    const isFullscreen = panel.classList.contains('panel-fullscreen');
    const isFloating = !panel.classList.contains('docked-left') && !panel.classList.contains('docked-right') && !isFullscreen;

    // Requirement 1: Tier-1 three-dots menu ONLY contains layout options (NO Close button!)
    const pop = document.createElement('div');
    pop.className = 'z-panel-more-popover z-glass-thick';
    pop.setAttribute('role', 'menu');
    pop.innerHTML = `
      ${(!panel.classList.contains('docked-left') && !panel.classList.contains('docked-right')) ? `<button type="button" class="z-more-item ${isFullscreen ? 'active' : ''}" data-more-action="fullscreen">
        ${isFullscreen ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="8" width="12" height="12" rx="1.5"/><path d="M8 8V5.5A1.5 1.5 0 0 1 9.5 4h9A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H16"/></svg>' : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>'}
        <span data-i18n="${isFullscreen ? '还原窗口' : '全屏'}">${isFullscreen ? t('还原窗口') : t('全屏')}</span>
        ${isFullscreen ? '<span class="z-more-check">✓</span>' : ''}
      </button>` : ''}
      ${allowLeft ? `<button type="button" class="z-more-item ${isDockedLeft ? 'active' : ''}" data-more-action="left">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/></svg>
        <span data-i18n="钉到左侧">${t('钉到左侧')}</span>
        ${isDockedLeft ? '<span class="z-more-check">✓</span>' : ''}
      </button>` : ''}
      ${allowRight ? `<button type="button" class="z-more-item ${isDockedRight ? 'active' : ''}" data-more-action="right">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="15" y1="4" x2="15" y2="20"/></svg>
        <span data-i18n="钉到右侧">${t('钉到右侧')}</span>
        ${isDockedRight ? '<span class="z-more-check">✓</span>' : ''}
      </button>` : ''}
      ${!isFloating ? `<button type="button" class="z-more-item" data-more-action="float">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="6" width="14" height="12" rx="2"/><path d="M9 10h6"/></svg>
        <span data-i18n="自由浮窗">${t('自由浮窗')}</span>
      </button>` : ''}
    `;
    document.body.appendChild(pop);
    activeMorePopover = pop;
    activeMoreAnchor = moreBtn;
    moreBtn.classList.add('active');

    const Motion = getMotion();
    if (Motion?.panelMorePopover) {
      Motion.panelMorePopover(pop, moreBtn, true);
    }

    pop.addEventListener('click', (ev) => {
      const item = ev.target.closest('[data-more-action]');
      if (!item) return;
      ev.preventDefault();
      ev.stopPropagation();
      const action = item.dataset.moreAction;
      closeUnifiedMorePopover({ instant: true });
      togglePanelDockState(panel, action);
    });
  }

  if (!document.documentElement.dataset.morePopoverOutsideBound) {
    document.documentElement.dataset.morePopoverOutsideBound = '1';
    document.addEventListener('pointerdown', (ev) => {
      if (activeMorePopover && !ev.target.closest('.z-panel-more-popover') && !ev.target.closest('.panel-more-btn')) {
        closeUnifiedMorePopover();
      }
    }, true);
    let _lastPopVw = window.innerWidth, _lastPopVh = window.innerHeight; window.addEventListener('resize', () => { if (window.innerWidth !== _lastPopVw || window.innerHeight !== _lastPopVh) { _lastPopVw = window.innerWidth; _lastPopVh = window.innerHeight; closeUnifiedMorePopover({ instant: true }); } });
  }

  function bindOuterRingResizeHandles(panel) {
    if (!panel) return;
    let leftH = panel.querySelector(':scope > .panel-resize-handle.left');
    let rightH = panel.querySelector(':scope > .panel-resize-handle.right');
    if (!leftH) {
      leftH = document.createElement('div');
      leftH.className = 'panel-resize-handle left';
      leftH.dataset.resizeEdge = 'left';
      leftH.title = t('拖动调整大小');
      panel.appendChild(leftH);
    }
    if (!rightH) {
      rightH = document.createElement('div');
      rightH.className = 'panel-resize-handle right';
      rightH.dataset.resizeEdge = 'right';
      rightH.title = t('拖动调整大小');
      panel.appendChild(rightH);
    }
    [leftH, rightH].forEach((handle) => {
      if (handle.dataset.outerRingResizeBound === '1') return;
      handle.dataset.outerRingResizeBound = '1';
      handle.addEventListener('pointerdown', (e) => {
        if (panel.classList.contains('docked-left') || panel.classList.contains('docked-right') || panel.dataset.unifiedDockSide) return;
        e.preventDefault();
        e.stopPropagation();
        handle.setPointerCapture?.(e.pointerId);
        setFocusedFloatingPanel(panel);
        panel.classList.remove('panel-fullscreen');
        updateMaximizeButtonIcon(panel);
        panel.classList.add('resizing');
        panel.dataset.userPlaced = '1';
        const rect = panel.getBoundingClientRect();
        const page = panel.closest('.terminal-page, .rdp-page, .app-shell') || document.body;
        const pageRect = page.getBoundingClientRect();
        const startX = e.clientX;
        const startY = e.clientY;
        const startW = rect.width;
        const startH = rect.height;
        const startL = rect.left - pageRect.left;
        const startT = rect.top - pageRect.top;
        const edge = handle.dataset.resizeEdge || (handle.classList.contains('left') ? 'left' : 'right');
        const minW = 320;
        const minH = 220;

        panel.style.left = `${Math.round(startL)}px`;
        panel.style.top = `${Math.round(startT)}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';

        const onMove = (ev) => {
          ev.preventDefault();
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          let nextW = startW + dx;
          let nextL = startL;
          if (edge === 'left') {
            nextW = startW - dx;
            nextL = startL + dx;
            if (nextW < minW) {
              nextL -= (minW - nextW);
              nextW = minW;
            }
            if (nextL < 8) {
              nextW += (nextL - 8);
              nextL = 8;
            }
            panel.style.left = `${Math.round(nextL)}px`;
          }
          const maxW = edge === 'left' ? (startL + startW - 8) : (pageRect.width - nextL - 8);
          const maxH = pageRect.height - startT - 8;
          panel.style.width = `${Math.round(Math.min(Math.max(minW, nextW), Math.max(minW, maxW)))}px`;
          panel.style.height = `${Math.round(Math.min(Math.max(minH, startH + dy), Math.max(minH, maxH)))}px`;
        };
        const onUp = () => {
          panel.classList.remove('resizing');
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onUp);
        };
        window.addEventListener('pointermove', onMove, { passive: false });
        window.addEventListener('pointerup', onUp, { once: true });
        window.addEventListener('pointercancel', onUp, { once: true });
      });
    });
  }

  function bindHeaderDragFallback(panel, titlebar) {
    if (!panel || !titlebar) return;
    const rightControls = titlebar.querySelector('.panel-head-controls');
    if (rightControls && rightControls._stopDragBoundEl !== rightControls) {
      rightControls._stopDragBoundEl = rightControls;
      rightControls.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    }
    if (titlebar._physicsDragBoundEl === titlebar) return;
    titlebar._physicsDragBoundEl = titlebar;
    panel.dataset.panelPhysicsWired = '1';
    if (window.ZephyrFloatingPanelPhysics?.ensure) {
      void window.ZephyrFloatingPanelPhysics.ensure(panel, {
        handle: titlebar,
        layoutButton: null,
        layoutSelector: '.panel-traffic-btn-disabled',
        force: true,
        onActivate: () => {
          panel.dataset.userPlaced = '1';
          setFocusedFloatingPanel(panel);
        },
      });
    }
  }

  function animateCloseFloatingPanel(panel, doneCallback) {
    if (!panel) {
      doneCallback?.();
      return;
    }
    const Motion = getMotion();
    panel.classList.remove('panel-focused');
    if (Motion?.panelResizeRing) Motion.panelResizeRing(panel, false);
    if (Motion?.panelCloseWasm) {
      void Motion.panelCloseWasm(panel, null, { preset: 'snappy', onDone: doneCallback });
      return;
    }
    doneCallback?.();
  }

  function ensureUnifiedPanelTitlebar(panel, { titlebarEl, iconSvg, titleText, closeBtnSelector, onClose, isSecondary = false } = {}) {
    if (!panel) return;
    panel.classList.add(isSecondary ? 'z-unified-secondary-panel' : 'z-unified-panel');
    const titlebar = titlebarEl || panel.querySelector(
      ':scope > .fm-titlebar-head, :scope > .panel-titlebar:not(.fm-editor-window-titlebar):not(.image-preview-titlebar):not(.media-preview-titlebar), :scope > .docker-header, :scope > .info-modal-header, :scope > .snippet-panel-header, :scope > .image-preview-header, :scope > .media-preview-header, :scope > .fm-props-head, :scope > .docker-log-header, :scope > .transfer-popover-head'
    );
    if (!titlebar) return;

    if (iconSvg && titleText) {
      const leftTitle = titlebar.querySelector('.monitor-title, .docker-title, strong, .image-preview-title, .media-preview-title, #fmEditorTitle, #dockerInspectTitle, #dockerLogTitle');
      if (leftTitle && !leftTitle.dataset.unifiedUpgraded) {
        leftTitle.dataset.unifiedUpgraded = '1';
        leftTitle.innerHTML = `${iconSvg}<span class="z-panel-title-main" data-i18n="${escapeHtml(titleText)}">${escapeHtml(t(titleText))}</span><span class="fm-title-host">${escapeHtml(hostName || '')}</span>`;
      }
    }

    let rightCluster = titlebar.querySelector(':scope > .panel-head-controls');
    if (!rightCluster) {
      rightCluster = document.createElement('div');
      rightCluster.className = 'panel-head-controls';
      titlebar.appendChild(rightCluster);
    }

    const triggerClose = () => {
      closeUnifiedMorePopover({ instant: true });
      if (typeof onClose === 'function') {
        closeUnifiedPanel(panel, {
          onAfterClose: () => {
            onClose();
            syncHostWindowDockAndFloatState();
          },
        });
      } else {
        const closeTarget = closeBtnSelector ? panel.querySelector(closeBtnSelector) : null;
        if (closeTarget && closeTarget.dataset.nativeCloseClick !== '1' && !panel.classList.contains('docked-left') && !panel.classList.contains('docked-right')) {
          closeTarget.dataset.nativeCloseClick = '1';
          closeTarget.click();
          delete closeTarget.dataset.nativeCloseClick;
        } else {
          closeUnifiedPanel(panel);
        }
      }
    };

    if (!isSecondary) {
      // Tier-1 floating panel: [Pin] [⋯ More] [× Close]
      panel.querySelectorAll('.fm-legacy-header .panel-pin-toggle').forEach((b) => b.remove());
      let pinBtn = titlebar.querySelector('.panel-pin-toggle');
      if (pinBtn && !pinBtn.dataset.cleanCloned) {
        // Clone and replace to strip any legacy panel-pin.js click listener that bypassed Motion.panelDockMorph
        const cloned = pinBtn.cloneNode(true);
        cloned.dataset.cleanCloned = '1';
        delete cloned.dataset.dockBound;
        pinBtn.replaceWith(cloned);
        pinBtn = cloned;
      }
      if (!pinBtn) {
        pinBtn = document.createElement('button');
        pinBtn.type = 'button';
        pinBtn.className = 'tool-btn panel-pin-toggle';
        pinBtn.dataset.cleanCloned = '1';
        pinBtn.title = t('停靠/悬浮切换');
        pinBtn.setAttribute('aria-label', t('停靠/悬浮切换'));
        pinBtn.setAttribute('aria-pressed', 'false');
      }
      pinBtn.innerHTML = '<svg class="z-pin-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1 1 1 0 0 1 1 1z"/></svg>';
      if (!pinBtn.dataset.dockBound) {
        pinBtn.dataset.dockBound = '1';
        pinBtn.dataset.pinToggleBound = '1';
        pinBtn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          closeUnifiedMorePopover({ instant: true });
          togglePanelDockState(panel);
        }, true);
      }

      let moreBtn = titlebar.querySelector('.panel-more-btn');
      if (!moreBtn) {
        moreBtn = document.createElement('button');
        moreBtn.type = 'button';
        moreBtn.className = 'tool-btn panel-more-btn';
        moreBtn.title = t('窗口布局');
        moreBtn.setAttribute('aria-label', t('窗口布局'));
        moreBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/></svg>';
        moreBtn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          openUnifiedMorePopover(panel, moreBtn);
        });
      }
      rightCluster.append(pinBtn, moreBtn);
    } else {
      // Tier-2 secondary floating window: NO pin, NO three-dots!
      // Strictly: [□ Fullscreen/Restore (.panel-max-btn)] [× Close (.panel-close-btn)]
      panel.querySelectorAll('.panel-pin-toggle, .panel-pin-btn, .panel-more-btn').forEach((b) => b.remove());
      let maxBtn = rightCluster.querySelector('.panel-max-btn');
      if (!maxBtn) {
        maxBtn = document.createElement('button');
        maxBtn.type = 'button';
        maxBtn.className = 'tool-btn panel-max-btn';
        maxBtn.title = t('全屏');
        maxBtn.setAttribute('aria-label', t('全屏'));
        maxBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>';
      }
      if (maxBtn._unifiedMaxBoundEl !== maxBtn) {
        maxBtn._unifiedMaxBoundEl = maxBtn;
        maxBtn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          toggleSecondaryPanelFullscreen(panel);
        });
      }
      rightCluster.appendChild(maxBtn);
    }

    let closeBtn = (closeBtnSelector ? panel.querySelector(closeBtnSelector) : null)
      || titlebar.querySelector('.panel-close-btn, .fm-close-btn, .fm-editor-close-icon, [data-editor-action="close"], .fm-props-close, .transfer-popover-close')
      || panel.querySelector('.fm-editor-header-actions .fm-editor-close-icon, .fm-editor-header-actions [data-editor-action="close"]');
    if (!closeBtn) {
      closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'tool-btn panel-close-btn';
      closeBtn.title = t('关闭');
      closeBtn.setAttribute('aria-label', t('关闭'));
      closeBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    } else {
      closeBtn.classList.add('tool-btn', 'panel-close-btn');
      closeBtn.style.display = 'inline-flex';
      closeBtn.style.visibility = 'visible';
      closeBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    }
    if (closeBtn._unifiedCloseBoundEl !== closeBtn) {
      closeBtn._unifiedCloseBoundEl = closeBtn;
      closeBtn.addEventListener('click', (ev) => {
        if (closeBtn.dataset.nativeCloseClick === '1') return;
        ev.preventDefault();
        ev.stopPropagation();
        triggerClose();
      });
    }
    rightCluster.appendChild(closeBtn);
    // Deduplicate any extra close or maximize buttons that might have survived a template.cloneNode(true)
    const allMaxBtns = Array.from(rightCluster.querySelectorAll('.panel-max-btn'));
    if (allMaxBtns.length > 1) allMaxBtns.slice(1).forEach((b) => b.remove());
    const allCloseBtns = Array.from(rightCluster.querySelectorAll('.panel-close-btn, .fm-editor-close-icon, [data-editor-action="close"]'));
    if (allCloseBtns.length > 1) allCloseBtns.slice(1).forEach((b) => b.remove());
    // Also remove any leftover close button still sitting inside .fm-editor-header-actions
    panel.querySelectorAll('.fm-editor-header-actions .fm-editor-close-icon, .fm-editor-header-actions [data-editor-action="close"]').forEach((b) => {
      if (b !== closeBtn) b.remove();
    });

    bindOuterRingResizeHandles(panel);
    bindHeaderDragFallback(panel, titlebar);
    ensureFloatingDefaultPosition(panel, isSecondary ? { defaultW: 680, defaultH: 440 } : { defaultW: 580, defaultH: 390 });

    const Motion = getMotion();
    if (Motion?.press && !rightCluster.dataset.pressBound) {
      rightCluster.dataset.pressBound = '1';
      Motion.press(rightCluster.querySelectorAll('button'), { scale: 0.92 });
    }

    if (!panel._unifiedObserver) {
      let wasOpen = (panel.classList.contains('open') || panel.classList.contains('show')) && panel.style.display !== 'none';
      const obs = new MutationObserver(() => {
        if (panel.classList.contains('z-panel-morphing') || panel.classList.contains('dragging') || panel.classList.contains('resizing') || panel.classList.contains('panel-physics-baking')) return;
        const isOpen = (panel.classList.contains('open') || panel.classList.contains('show') || (isSecondary && panel.style.display === 'flex')) && panel.style.display !== 'none';
        const isDocked = panel.classList.contains('docked-right') || panel.classList.contains('docked-left') || panel.classList.contains('pinned') || !!panel.dataset.unifiedDockSide;
        const stateChanged = isOpen !== wasOpen;
        if (isOpen && !wasOpen) {
          wasOpen = true;
          if (!isDocked) {
            ensureFloatingDefaultPosition(panel, isSecondary ? { defaultW: 680, defaultH: 440 } : { defaultW: 580, defaultH: 390 });
            setFocusedFloatingPanel(panel);
            /* Open animation is driven by Motion.panelOpenWasm */
          }
        } else if (!isOpen && wasOpen) {
          wasOpen = false;
          delete panel.dataset.floatingPositionLocked;
        }
        if (stateChanged) {
          syncHostWindowDockAndFloatState();
        }
      });
      obs.observe(panel, { attributes: true, attributeFilter: ['class', 'style'] });
      panel._unifiedObserver = obs;
    }
  }

  window.__zephyrUpgradeSecondaryPanel = upgradeSecondaryFloatingWindow;
  function upgradeSecondaryFloatingWindow(panel) {
    if (!panel) return;
    panel.classList.add('z-unified-secondary-panel');
    // Unconditionally strip legacy first-generation titlebars & pin/more buttons before querying header!
    panel.querySelectorAll('.panel-pin-toggle, .panel-pin-btn, .panel-more-btn, .fm-editor-window-titlebar, .image-preview-titlebar, .media-preview-titlebar, :scope > .panel-drag-handle').forEach((b) => b.remove());

    if (panel.classList.contains('fm-editor-modal')) {
      const page = document.querySelector('.terminal-page');
      if (page && panel.parentElement !== page) {
        page.appendChild(panel);
      }
      let titleHead = panel.querySelector(':scope > .fm-titlebar-head');
      const header = panel.querySelector('.fm-editor-header');
      const titleEl = panel.querySelector('#fmEditorTitle, [data-editor-role="title"]');
      if (!titleHead && header) {
        titleHead = document.createElement('div');
        titleHead.className = 'fm-titlebar-head panel-titlebar';
        const leftWrap = document.createElement('div');
        leftWrap.className = 'fm-title-left';
        leftWrap.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent, #0A84FF)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg><strong class="fm-title-text" data-i18n="代码编辑器">' + t('代码编辑器') + '</strong>';
        if (titleEl) {
          titleEl.className = 'fm-title-host';
          leftWrap.appendChild(titleEl);
        }
        const rightCluster = document.createElement('div');
        rightCluster.className = 'panel-head-controls';
        titleHead.append(leftWrap, rightCluster);
        panel.insertBefore(titleHead, header);
      }
      // Replace tiny text Undo/Redo ↶/↷ with crisp SVGs
      const undoBtn = panel.querySelector('#fmEditorUndoBtn');
      if (undoBtn && !undoBtn.querySelector('svg')) {
        undoBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>';
      }
      const redoBtn = panel.querySelector('#fmEditorRedoBtn');
      if (redoBtn && !redoBtn.querySelector('svg')) {
        redoBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7"/></svg>';
      }
      ensureUnifiedPanelTitlebar(panel, {
        titlebarEl: titleHead,
        closeBtnSelector: '#fmEditorCloseBtn',
        isSecondary: true,
      });
      /* Only 42px titleHead is the drag handle */
    } else if (panel.classList.contains('image-preview-modal')) {
      const header = panel.querySelector(':scope > .image-preview-header');
      if (!header) return;
      header.classList.add('panel-titlebar');
      const titleEl = header.querySelector('.image-preview-title');
      if (titleEl && !header.querySelector('.z-sec-title-left')) {
        const leftWrap = document.createElement('div');
        leftWrap.className = 'z-sec-title-left';
        leftWrap.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent, #0A84FF)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
        header.insertBefore(leftWrap, titleEl);
        leftWrap.appendChild(titleEl);
      }
      ensureUnifiedPanelTitlebar(panel, {
        titlebarEl: header,
        isSecondary: true,
        onClose: () => {
          if (panel._imagePreviewInstance?.close) panel._imagePreviewInstance.close();
          else { panel.classList.remove('open'); panel.style.display = 'none'; }
        },
      });
    } else if (panel.classList.contains('media-preview-modal')) {
      const header = panel.querySelector(':scope > .media-preview-header');
      if (!header) return;
      header.classList.add('panel-titlebar');
      const titleEl = header.querySelector('.media-preview-title');
      if (titleEl && !header.querySelector('.z-sec-title-left')) {
        const leftWrap = document.createElement('div');
        leftWrap.className = 'z-sec-title-left';
        leftWrap.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent, #0A84FF)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
        header.insertBefore(leftWrap, titleEl);
        leftWrap.appendChild(titleEl);
      }
      ensureUnifiedPanelTitlebar(panel, {
        titlebarEl: header,
        isSecondary: true,
        onClose: () => {
          if (panel._mediaPreviewInstance?.close) panel._mediaPreviewInstance.close();
          else { panel.classList.remove('open'); panel.style.display = 'none'; }
        },
      });
    } else if (panel.classList.contains('fm-props-modal')) {
      const upgradePropsInner = () => {
        const head = panel.querySelector(':scope > .fm-props-head');
        if (!head) return;
        head.classList.add('panel-titlebar');
        const strong = head.querySelector('strong');
        if (strong && !strong.querySelector('svg')) {
          const txt = strong.textContent || '属性';
          strong.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent, #0A84FF)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg><span class="z-panel-title-main">${escapeHtml(txt)}</span>`;
        }
        ensureUnifiedPanelTitlebar(panel, {
          titlebarEl: head,
          closeBtnSelector: '.fm-props-close',
          isSecondary: true,
        });
      };
      upgradePropsInner();
      if (!panel._propsContentObserver) {
        const obs = new MutationObserver(() => {
          if (!panel.querySelector('.panel-max-btn')) {
            upgradePropsInner();
          }
        });
        obs.observe(panel, { childList: true });
        panel._propsContentObserver = obs;
      }
    } else if (panel.classList.contains('docker-log-drawer')) {
      const page = document.querySelector('.terminal-page');
      if (page && panel.parentElement !== page) {
        page.appendChild(panel);
      }
      const head = panel.querySelector(':scope > .docker-log-header');
      if (!head) return;
      head.classList.add('panel-titlebar');
      const titleSpan = head.querySelector('#dockerInspectTitle, #dockerLogTitle');
      if (titleSpan && !titleSpan.querySelector('svg')) {
        const txt = titleSpan.textContent || '容器详情';
        titleSpan.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent, #0A84FF)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span class="z-panel-title-main">${escapeHtml(txt)}</span>`;
      }
      const closeBtn = panel.querySelector('#dockerLogCloseBtn, #dockerInspectCloseBtn');
      ensureUnifiedPanelTitlebar(panel, {
        titlebarEl: head,
        closeBtnSelector: closeBtn ? '#' + closeBtn.id : undefined,
        isSecondary: true,
      });
    } else if (panel.classList.contains('transfer-popover')) {
      const head = panel.querySelector(':scope > .transfer-popover-head');
      if (!head) return;
      head.classList.add('panel-titlebar');
      const strong = head.querySelector('strong');
      if (strong && !strong.querySelector('svg')) {
        const txt = strong.textContent || '文件传输';
        strong.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent, #0A84FF)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg><span class="z-panel-title-main">${escapeHtml(txt)}</span>`;
      }
      ensureUnifiedPanelTitlebar(panel, {
        titlebarEl: head,
        closeBtnSelector: '.transfer-popover-close',
        isSecondary: true,
      });
    }
  }


  if (!document.documentElement.dataset.globalPanelControlsDelegated) {
    document.documentElement.dataset.globalPanelControlsDelegated = '1';
    document.addEventListener('click', (ev) => {
      const maxBtn = ev.target.closest?.('.panel-max-btn');
      if (maxBtn) {
        const panel = maxBtn.closest('.z-unified-secondary-panel, .fm-editor-modal, .image-preview-modal, .media-preview-modal, .fm-props-modal, .docker-log-drawer, .transfer-popover, .file-manager');
        if (panel) {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          toggleSecondaryPanelFullscreen(panel);
          return;
        }
      }
      const pinBtn = ev.target.closest?.('.panel-pin-toggle');
      if (pinBtn) {
        const panel = pinBtn.closest('.z-unified-panel, .file-manager, .info-modal, .docker-panel, .snippet-panel, .shortcut-panel, .port-forward-panel, .terminal-notes-panel');
        if (panel) {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          closeUnifiedMorePopover({ instant: true });
          togglePanelDockState(panel);
          return;
        }
      }
      const moreBtn = ev.target.closest?.('.panel-more-btn');
      if (moreBtn) {
        const panel = moreBtn.closest('.z-unified-panel, .file-manager, .info-modal, .docker-panel, .snippet-panel, .shortcut-panel, .port-forward-panel, .terminal-notes-panel');
        if (panel) {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          openUnifiedMorePopover(panel, moreBtn);
          return;
        }
      }
    }, true);
  }

  function observeDynamicSecondaryWindows() {
    const page = document.querySelector('.terminal-page') || document.body;
    const scan = () => {
      document.querySelectorAll('.fm-editor-modal, .image-preview-modal, .media-preview-modal, .fm-props-modal, .docker-log-drawer, .transfer-popover').forEach((el) => {
        if (el._secondaryInstanceUpgraded !== el || !el.querySelector('.panel-max-btn') || !el.querySelector('.panel-close-btn')) {
          el._secondaryInstanceUpgraded = el;
          upgradeSecondaryFloatingWindow(el);
        }
      });
      document.querySelectorAll('.file-manager').forEach((fm) => {
        if (fm !== fileManager && !fm.classList.contains('z-unified-secondary-panel')) {
          ensureUnifiedPanelTitlebar(fm, {
            iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent, #0A84FF)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
            titleText: '文件管理',
            isSecondary: true,
          });
        }
      });
    };
    scan();
    const bodyObs = new MutationObserver(scan);
    bodyObs.observe(page, { childList: true, subtree: false });
    if (document.body && document.body !== page) {
      bodyObs.observe(document.body, { childList: true, subtree: false });
    }
  }

  function ensureTerminalNotesPanel() {
    const page = document.querySelector('.terminal-page');
    if (!page || document.getElementById('terminalNotesPanel')) return;
    const panel = document.createElement('div');
    panel.id = 'terminalNotesPanel';
    panel.className = 'snippet-panel terminal-notes-panel';
    panel.style.display = 'none';
    panel.innerHTML = `
      <div class="panel-drag-handle" data-drag-panel="terminalNotesPanel">
        <button class="panel-traffic-btn" data-layout-panel="terminalNotesPanel" type="button"><span></span></button>
      </div>
      <div class="snippet-panel-header panel-titlebar">
        <strong>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent, #0A84FF)" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
          <span class="z-panel-title-main" data-i18n="运维笔记">${t('运维笔记')}</span>
          <span class="fm-title-host">${escapeHtml(hostName || '')}</span>
        </strong>
      </div>
      <div class="snippet-panel-body terminal-notes-body">
        <div class="tn-toolbar">
          <input type="text" id="tnTitleInput" class="snippet-search tn-title-input" placeholder="${t('输入笔记标题...')}" data-i18n-placeholder="输入笔记标题...">
          <button type="button" class="tool-btn tn-new-btn" id="tnNewBtn" data-i18n="新建">${t('新建')}</button>
          <button type="button" class="tool-btn tn-save-btn" id="tnSaveBtn" data-i18n="保存">${t('保存')}</button>
        </div>
        <textarea id="tnContentArea" class="tn-textarea" placeholder="${t('记录当前服务器的排障笔记、常用命令或配置说明（支持 Markdown）...')}" data-i18n-placeholder="记录当前服务器的排障笔记、常用命令或配置说明（支持 Markdown）..."></textarea>
        <div class="tn-footer-section">
          <div class="tn-section-label" data-i18n="最近保存">${t('最近保存')}</div>
          <div class="tn-list" id="tnNotesList"></div>
        </div>
      </div>
      <div class="panel-resize-handle left" data-resize-panel="terminalNotesPanel" data-resize-edge="left"></div>
      <div class="panel-resize-handle right" data-resize-panel="terminalNotesPanel" data-resize-edge="right"></div>
    `;
    page.appendChild(panel);

    const notesBtn = document.getElementById('notesBtn');
    if (notesBtn) {
      notesBtn.classList.remove('force-hidden');
      notesBtn.hidden = false;
      notesBtn.style.display = '';
      notesBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        const isOpen = panel.classList.contains('open');
        if (isOpen) {
          notesBtn.classList.remove('active');
          closeUnifiedPanel(panel, { triggerBtn: notesBtn });
        } else {
          ensureFloatingDefaultPosition(panel);
          panel.style.display = 'flex';
          panel.classList.add('open');
          notesBtn.classList.add('active');
          setFocusedFloatingPanel(panel);
          loadHostNotes();
          getMotion()?.panelOpenWasm?.(panel, notesBtn, { preset: 'mac' });
          syncHostWindowDockAndFloatState();
        }
      }, true);
    }

    async function loadHostNotes() {
      const listEl = panel.querySelector('#tnNotesList');
      if (!listEl) return;
      try {
        const res = await fetch('/api/notes', { credentials: 'same-origin' });
        if (!res.ok) return;
        const data = await res.json();
        const notes = Array.isArray(data?.notes) ? data.notes.slice(0, 8) : [];
        if (!notes.length) {
          listEl.innerHTML = `<div class="tn-empty-chip" data-i18n="暂无历史笔记 · 点击右上「保存」即可归档">${t('暂无历史笔记 · 点击右上「保存」即可归档')}</div>`;
          return;
        }
        listEl.innerHTML = notes.map((n) => `
          <button type="button" class="tn-note-item" data-note-id="${escapeHtml(n.id)}">
            <strong>${escapeHtml(n.title || '未命名笔记')}</strong>
            <span>${escapeHtml(String(n.updatedAt || '').slice(5, 16))}</span>
          </button>
        `).join('');
        listEl.querySelectorAll('.tn-note-item').forEach((item) => {
          item.addEventListener('click', async () => {
            const id = item.dataset.noteId;
            const r = await fetch('/api/notes/' + encodeURIComponent(id), { credentials: 'same-origin' });
            if (r.ok) {
              const d = await r.json();
              const note = d?.note || d;
              panel.querySelector('#tnTitleInput').value = note?.title || '';
              panel.querySelector('#tnContentArea').value = note?.content || '';
              panel.dataset.editingNoteId = id;
            }
          });
        });
      } catch {}
    }

    panel.querySelector('#tnNewBtn')?.addEventListener('click', () => {
      delete panel.dataset.editingNoteId;
      const ti = panel.querySelector('#tnTitleInput');
      const ca = panel.querySelector('#tnContentArea');
      if (ti) ti.value = '';
      if (ca) { ca.value = ''; ca.focus(); }
    });

    panel.querySelector('#tnSaveBtn')?.addEventListener('click', async () => {
      const title = panel.querySelector('#tnTitleInput')?.value?.trim() || ((hostName || 'SSH') + ' 笔记');
      const content = panel.querySelector('#tnContentArea')?.value || '';
      const editId = panel.dataset.editingNoteId;
      try {
        const url = editId ? '/api/notes/' + encodeURIComponent(editId) : '/api/notes';
        const method = editId ? 'PUT' : 'POST';
        const res = await fetch(url, {
          method,
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, content }),
        });
        if (res.ok) {
          showToast?.('已保存', 'success');
          loadHostNotes();
        }
      } catch {}
    });
  }

  function isHostAiEnabled() {
    try {
      if (window.parent && window.parent !== window) {
        if (typeof window.parent.__zephyrAiEnabled === 'boolean') return window.parent.__zephyrAiEnabled;
        const pBtn = window.parent.document?.getElementById('aiFloatingBtn');
        if (pBtn) return !pBtn.classList.contains('force-hidden') && !pBtn.hidden;
      }
    } catch (_) {}
    if (typeof window.__zephyrAiEnabled === 'boolean') return window.__zephyrAiEnabled;
    return false;
  }

  function isHostAiPanelOpen() {
    try {
      if (window.parent && window.parent !== window) {
        if (typeof window.parent.__zephyrAiPanelOpen === 'boolean') return window.parent.__zephyrAiPanelOpen;
        const pPanel = window.parent.document?.getElementById('aiAgentPanel');
        if (pPanel) return pPanel.getAttribute('aria-hidden') === 'false' && pPanel.style.display !== 'none';
      }
    } catch (_) {}
    return !!window.__zephyrAiPanelOpen;
  }

  function syncTerminalAiToolbarButton(enabledOverride, openOverride) {
    const btn = document.getElementById('terminalAiBtn');
    if (!btn) return;
    const enabled = typeof enabledOverride === 'boolean' ? enabledOverride : isHostAiEnabled();
    const isOpen = typeof openOverride === 'boolean' ? openOverride : isHostAiPanelOpen();
    window.__zephyrAiEnabled = enabled;
    window.__zephyrAiPanelOpen = isOpen;
    btn.classList.toggle('force-hidden', !enabled);
    btn.hidden = !enabled;
    btn.style.display = enabled ? '' : 'none';
    btn.classList.toggle('active', !!(enabled && isOpen));
    btn.setAttribute('aria-pressed', (enabled && isOpen) ? 'true' : 'false');
  }

  function upgradeTopbarAndCommandBar() {
    const topbarActions = document.getElementById('topbarActions');
    if (topbarActions && !document.getElementById('terminalAiBtn')) {
      const aiBtn = document.createElement('button');
      aiBtn.className = 'btn-sm force-hidden';
      aiBtn.id = 'terminalAiBtn';
      aiBtn.type = 'button';
      aiBtn.hidden = true;
      aiBtn.style.display = 'none';
      aiBtn.title = t('AI 助手');
      aiBtn.setAttribute('aria-label', t('AI 助手'));
      const shortcutBtn = document.getElementById('shortcutBtn') || document.getElementById('shortcutsBtn');
      const copyBtn = document.getElementById('copyBtn') || document.getElementById('ctrlAltDelBtn') || document.getElementById('cadBtn');
      if (shortcutBtn && shortcutBtn.parentElement === topbarActions) {
        shortcutBtn.insertAdjacentElement('afterend', aiBtn);
      } else if (copyBtn && copyBtn.parentElement === topbarActions) {
        topbarActions.insertBefore(aiBtn, copyBtn);
      } else {
        topbarActions.appendChild(aiBtn);
      }
      aiBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        try {
          const tabId = new URLSearchParams(location.search).get('tabId') || '';
          if (window.parent && window.parent !== window) {
            const br = aiBtn.getBoundingClientRect();
            const fr = window.frameElement?.getBoundingClientRect?.() || { left: 0, top: 0 };
            const triggerRect = {
              left: Math.round(fr.left + br.left),
              top: Math.round(fr.top + br.top),
              right: Math.round(fr.left + br.right),
              bottom: Math.round(fr.top + br.bottom),
              width: Math.round(br.width),
              height: Math.round(br.height),
            };
            window.parent.postMessage({
              source: 'zephyr-terminal',
              type: 'zephyr-toggle-ai-panel',
              tabId,
              triggerRect,
            }, '*');
          } else {
            document.getElementById('aiFloatingBtn')?.click();
          }
        } catch (_) {}
      });
    }

    const TOPBAR_BUTTON_SPECS = [
      { id: 'fileBtn', label: '文件', svg: '<svg class="tb-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>' },
      { id: 'infoBtn', label: '监控', svg: '<svg class="tb-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>' },
      { id: 'dockerBtn', label: '容器', svg: '<svg class="tb-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.5 21 7v10l-9 4.5L3 17V7z"/><path d="M3 7l9 4.5L21 7"/><path d="M12 11.5V21.5"/></svg>' },
      //       { id: 'portForwardBtn', label: '端口转发', svg: '<svg class="tb-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg>' },
      { id: 'snippetBtn', label: '片段', svg: '<svg class="tb-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>' },
      { id: 'notesBtn', label: '笔记', svg: '<svg class="tb-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>' },
      { id: 'shortcutBtn', label: '快捷键', svg: '<svg class="tb-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="6" y1="9" x2="6.01" y2="9"/><line x1="10" y1="9" x2="10.01" y2="9"/><line x1="14" y1="9" x2="14.01" y2="9"/><line x1="18" y1="9" x2="18.01" y2="9"/><line x1="8" y1="15" x2="16" y2="15"/></svg>' },
      { id: 'terminalAiBtn', label: 'AI', svg: '<svg class="tb-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="2"/><path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6l1.4 1.4m10 10l1.4 1.4M5.6 18.4l1.4-1.4m10-10l1.4-1.4"/></svg>' },
      { id: 'copyBtn', label: '复制', svg: '<svg class="tb-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' },
      { id: 'pasteBtn', label: '粘贴', svg: '<svg class="tb-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>' },
      { id: 'clipboardBtn', label: '剪贴板', svg: '<svg class="tb-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>' },
      { id: 'rdpFilesBtn', label: '文件', svg: '<svg class="tb-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>' },
      { id: 'shortcutsBtn', label: '快捷键', svg: '<svg class="tb-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="6" y1="9" x2="6.01" y2="9"/><line x1="10" y1="9" x2="10.01" y2="9"/><line x1="14" y1="9" x2="14.01" y2="9"/><line x1="18" y1="9" x2="18.01" y2="9"/><line x1="8" y1="15" x2="16" y2="15"/></svg>' },
      { id: 'joystickBtn', label: '视区', svg: '<svg class="tb-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/><path d="M12 3v3m0 12v3M3 12h3m12 0h3"/></svg>' },
      { id: 'dragBtn', label: '视区', svg: '<svg class="tb-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/><path d="M12 3v3m0 12v3M3 12h3m12 0h3"/></svg>' },
      { id: 'ctrlAltDelBtn', label: 'Ctrl+Alt+Del', svg: '<svg class="tb-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>' },
      { id: 'cadBtn', label: 'Ctrl+Alt+Del', svg: '<svg class="tb-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>' },
    ];

    for (const spec of TOPBAR_BUTTON_SPECS) {
      const btn = document.getElementById(spec.id);
      if (!btn) continue;
      btn.removeAttribute('data-i18n');
      btn.innerHTML = spec.svg + '<span class="tb-lbl" data-i18n="' + spec.label + '">' + t(spec.label) + '</span>';
    }

    syncTerminalAiToolbarButton();

    const RIGHT_ICON_SPECS = [
      { id: 'wtermThemeToggle', svg: '<svg class="tb-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32l1.41-1.41"/></svg>' },
      { id: 'reconnectBtn', svg: '<svg class="tb-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>' },
    ];
    for (const rspec of RIGHT_ICON_SPECS) {
      const btn = document.getElementById(rspec.id);
      if (!btn) continue;
      btn.removeAttribute('data-i18n');
      btn.innerHTML = rspec.svg;
    }

    const disconnectBtn = document.getElementById('disconnectBtn');
    if (disconnectBtn) {
      disconnectBtn.style.display = 'none';
    }
    const themeToggleBtn = document.getElementById('themeToggle');
    if (themeToggleBtn) {
      themeToggleBtn.style.display = 'none';
    }
    const kbBtn = document.getElementById('keyboardBtn');
    if (kbBtn && document.documentElement.dataset.zephyrSurface === 'desktop') {
      kbBtn.style.display = 'none';
    }

    const notesBtn = document.getElementById('notesBtn');
    const snippetBtn = document.getElementById('snippetBtn');
    if (notesBtn && snippetBtn && snippetBtn.parentElement) {
      notesBtn.classList.remove('force-hidden');
      notesBtn.hidden = false;
      notesBtn.style.display = '';
      if (snippetBtn.nextElementSibling !== notesBtn) {
        snippetBtn.insertAdjacentElement('afterend', notesBtn);
      }
    }

    const pasteBtn = document.getElementById('pasteBtn');
    if (pasteBtn && !document.querySelector('.topbar-v-sep')) {
      const sep = document.createElement('span');
      sep.className = 'topbar-v-sep';
      sep.setAttribute('aria-hidden', 'true');
      pasteBtn.insertAdjacentElement('afterend', sep);
    }

    const cmdInput = document.getElementById('cmdInput');
    if (cmdInput) {
      cmdInput.removeAttribute('data-i18n-placeholder');
      cmdInput.placeholder = t('输入命令，支持多行输入...'); cmdInput.setAttribute('data-i18n-placeholder', '输入命令，支持多行输入...');
    }
    const cmdSendBtn = document.getElementById('cmdSendBtn');
    if (cmdSendBtn) {
      cmdSendBtn.removeAttribute('data-i18n');
      cmdSendBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg><span data-i18n="发送">发送</span>';
    }

    const Motion = getMotion();
    if (Motion?.press && topbarActions && !topbarActions.dataset.pressBound) {
      topbarActions.dataset.pressBound = '1';
      Motion.press(topbarActions.querySelectorAll('button'), { scale: 0.95 });
    }
    if (topbarActions && !topbarActions.dataset.hScrollEnhanced) {
      topbarActions.dataset.hScrollEnhanced = '1';
      const topbarHost = topbarActions.closest('.terminal-topbar') || topbarActions.parentElement;
      if (topbarHost) {
        topbarHost.classList.add('topbar-scroll-host');
        let leftArrow = topbarHost.querySelector('.topbar-scroll-btn.left');
        let rightArrow = topbarHost.querySelector('.topbar-scroll-btn.right');
        if (!leftArrow) {
          leftArrow = document.createElement('button');
          leftArrow.type = 'button';
          leftArrow.className = 'topbar-scroll-btn left';
          leftArrow.setAttribute('aria-label', t('向左滚动工具栏')); leftArrow.setAttribute('data-i18n-aria-label', '向左滚动工具栏');
          leftArrow.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>';
          topbarHost.appendChild(leftArrow);
        }
        if (!rightArrow) {
          rightArrow = document.createElement('button');
          rightArrow.type = 'button';
          rightArrow.className = 'topbar-scroll-btn right';
          rightArrow.setAttribute('aria-label', t('向右滚动工具栏')); rightArrow.setAttribute('data-i18n-aria-label', '向右滚动工具栏');
          rightArrow.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>';
          topbarHost.appendChild(rightArrow);
        }
        const syncScrollArrows = () => {
          const maxScroll = Math.max(0, topbarActions.scrollWidth - topbarActions.clientWidth);
          const sl = topbarActions.scrollLeft;
          const offL = topbarActions.offsetLeft || 0;
          const offT = topbarActions.offsetTop || 0;
          const offW = topbarActions.offsetWidth || 0;
          const offH = topbarActions.offsetHeight || 36;
          const btnT = offT + Math.max(0, Math.round((offH - 28) / 2));
          leftArrow.style.left = (offL + 4) + 'px';
          leftArrow.style.top = btnT + 'px';
          leftArrow.style.right = 'auto';
          rightArrow.style.left = Math.max(offL + 4, offL + offW - 28) + 'px';
          rightArrow.style.top = btnT + 'px';
          rightArrow.style.right = 'auto';
          leftArrow.classList.toggle('visible', maxScroll > 3 && sl > 3);
          rightArrow.classList.toggle('visible', maxScroll > 3 && sl < maxScroll - 3);
        };
        leftArrow.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          topbarActions.scrollBy({ left: -180, behavior: 'smooth' });
          setTimeout(syncScrollArrows, 220);
        });
        rightArrow.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          topbarActions.scrollBy({ left: 180, behavior: 'smooth' });
          setTimeout(syncScrollArrows, 220);
        });
        topbarActions.addEventListener('scroll', syncScrollArrows, { passive: true });
        window.addEventListener('resize', syncScrollArrows, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
          new ResizeObserver(syncScrollArrows).observe(topbarActions);
          if (topbarHost && topbarHost !== topbarActions) {
            new ResizeObserver(syncScrollArrows).observe(topbarHost);
          }
        }
        const mutObs = new MutationObserver(syncScrollArrows);
        if (topbarHost) mutObs.observe(topbarHost, { attributes: true, attributeFilter: ['class', 'style'] });
        requestAnimationFrame(syncScrollArrows);
        window.__zephyrSyncTopbarScrollArrows = syncScrollArrows;
      }

      // 1) Mouse wheel vertical/horizontal -> smooth horizontal scroll
      topbarActions.addEventListener('wheel', (ev) => {
        if (topbarActions.scrollWidth <= topbarActions.clientWidth + 2) return;
        const delta = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
        if (!delta) return;
        ev.preventDefault();
        topbarActions.scrollLeft += delta;
        window.__zephyrSyncTopbarScrollArrows?.();
      }, { passive: false });

      // 2) Pointer grab-and-pan horizontal drag with 5px click hysteresis
      let dragState = null;
      let suppressNextClick = false;
      topbarActions.addEventListener('pointerdown', (ev) => {
        if (ev.button != null && ev.button !== 0) return;
        if (topbarActions.scrollWidth <= topbarActions.clientWidth + 2) return;
        dragState = {
          pointerId: ev.pointerId,
          startX: ev.clientX,
          startScrollLeft: topbarActions.scrollLeft,
          moved: false,
        };
      }, true);
      window.addEventListener('pointermove', (ev) => {
        if (!dragState || ev.pointerId !== dragState.pointerId) return;
        const dx = ev.clientX - dragState.startX;
        if (!dragState.moved && Math.abs(dx) > 5) {
          dragState.moved = true;
          topbarActions.classList.add('is-dragging-scroll');
        }
        if (dragState.moved) {
          topbarActions.scrollLeft = dragState.startScrollLeft - dx;
          window.__zephyrSyncTopbarScrollArrows?.();
        }
      }, { passive: true });
      const endDrag = (ev) => {
        if (!dragState || (ev && ev.pointerId != null && ev.pointerId !== dragState.pointerId)) return;
        if (dragState.moved) {
          suppressNextClick = true;
          setTimeout(() => { suppressNextClick = false; }, 80);
        }
        topbarActions.classList.remove('is-dragging-scroll');
        dragState = null;
      };
      window.addEventListener('pointerup', endDrag, true);
      window.addEventListener('pointercancel', endDrag, true);
      topbarActions.addEventListener('click', (ev) => {
        if (!suppressNextClick) return;
        suppressNextClick = false;
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();
      }, true);
    }
  }

  function upgradeAllTerminalFloatingPanels() {
    const rootPage = document.querySelector('.terminal-page, .rdp-page, .novnc-page') || document.body;
    if (rootPage && rootPage !== document.body && !rootPage.classList.contains('terminal-page')) {
      rootPage.classList.add('terminal-page');
    }
    const remoteStage = document.getElementById('rdpStage') || document.getElementById('novncStage') || document.querySelector('.rdp-stage, .novnc-stage');
    if (remoteStage && !remoteStage.classList.contains('terminal-container')) {
      remoteStage.classList.add('terminal-container');
    }
    upgradeTopbarAndCommandBar();
    ensureTerminalNotesPanel();

    if (fileManager) {
      let fmTitleHead = fileManager.querySelector('.fm-titlebar-head');
      const firstFmHeader = fileManager.querySelector('.fm-header.panel-titlebar');
      if (!fmTitleHead && firstFmHeader) {
        fmTitleHead = document.createElement('div');
        fmTitleHead.className = 'fm-titlebar-head panel-titlebar';
        fmTitleHead.innerHTML = `
          <div class="fm-title-left">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent, #0A84FF)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            <strong class="fm-title-text" data-i18n="文件管理">${t('文件管理')}</strong>
            <span class="fm-title-host">${escapeHtml(hostName || '')}</span>
          </div>
        `;
        firstFmHeader.classList.remove('panel-titlebar');
        firstFmHeader.classList.add('fm-legacy-header');
        fileManager.insertBefore(fmTitleHead, firstFmHeader);
        const existingDockBtn = firstFmHeader.querySelector('#fmDockBtn');
        const existingCloseBtn = firstFmHeader.querySelector('#fmCloseBtn');
        if (existingDockBtn) fmTitleHead.appendChild(existingDockBtn);
        if (existingCloseBtn) fmTitleHead.appendChild(existingCloseBtn);
      }

      const fmToolbar = fileManager.querySelector('.fm-toolbar');
      const fmPathBox = fileManager.querySelector('.fm-path-box');
      const fmSearchInput = fileManager.querySelector('#fmSearchInput');
      const fmRefreshBtn = fileManager.querySelector('#fmRefreshBtn');
      const fmNewFolderBtn = fileManager.querySelector('#fmNewFolderBtn');
      const fmNewFileBtn = fileManager.querySelector('#fmNewFileBtn');
      const fmUploadLabel = fileManager.querySelector('label.fm-upload-label');

      if (fmToolbar) {
        let fmSearchBox = fileManager.querySelector('.fm-search-box');
        if (fmSearchInput && !fmSearchBox) {
          fmSearchBox = document.createElement('div');
          fmSearchBox.className = 'fm-search-box';
          fmSearchInput.removeAttribute('data-i18n-placeholder');
          fmSearchInput.placeholder = t('搜索文件...'); fmSearchInput.setAttribute('data-i18n-placeholder', '搜索文件...');
          fmSearchBox.innerHTML = '<svg class="fm-search-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
          fmSearchBox.appendChild(fmSearchInput);
        }

        if (fmRefreshBtn) {
          fmRefreshBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg><span data-i18n="刷新">' + t('刷新') + '</span>';
        }
        if (fmNewFolderBtn) fmNewFolderBtn.innerHTML = `<span data-i18n="新建文件夹">${t('新建文件夹')}</span>`;
        if (fmNewFileBtn) fmNewFileBtn.innerHTML = `<span data-i18n="新建文件">${t('新建文件')}</span>`;
        if (fmUploadLabel) {
          fmUploadLabel.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg><span data-i18n="上传">' + t('上传') + '</span>';
        }

        const ordered = [fmPathBox, fmSearchBox, fmRefreshBtn, fmNewFolderBtn, fmNewFileBtn, fmUploadLabel].filter(Boolean);
        ordered.forEach((el) => fmToolbar.appendChild(el));

        const fmPathInput = fileManager.querySelector('#fmPathInput');
        const fmGoBtn = fileManager.querySelector('#fmGoBtn');
        if (fmPathInput && !fmPathInput.dataset.enterBound) {
          fmPathInput.dataset.enterBound = '1';
          fmPathInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              fmGoBtn?.click();
            }
          });
        }
        if (fmPathBox && !fmPathBox.querySelector('.fm-path-chevron')) {
          const chev = document.createElement('button');
          chev.type = 'button';
          chev.className = 'fm-path-chevron';
          chev.title = t('返回上级目录'); chev.setAttribute('data-i18n-title', '返回上级目录');
          chev.innerHTML = '▾';
          chev.addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('fmBackBtn')?.click();
          });
          fmPathBox.appendChild(chev);
        }
      }

      ensureUnifiedPanelTitlebar(fileManager, {
        titlebarEl: fmTitleHead,
        closeBtnSelector: '#fmCloseBtn',
      });

      const fmList = document.getElementById('fmList');
      if (fmList && !fileManager.querySelector('.fm-col-header')) {
        const colHead = document.createElement('div');
        colHead.className = 'fm-col-header';
        colHead.innerHTML = `<span class="fm-col-name" data-i18n="名称 ↑↓">${t('名称 ↑↓')}</span><span class="fm-col-size" data-i18n="大小">${t('大小')}</span><span class="fm-col-mtime" data-i18n="修改时间">${t('修改时间')}</span>`;
        fileManager.insertBefore(colHead, fmList);
      }
    }

    const infoModal = document.getElementById('infoModal');
    if (infoModal) {
      ensureUnifiedPanelTitlebar(infoModal, {
        iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent, #0A84FF)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
        titleText: '实时监控',
        closeBtnSelector: '#infoCloseBtn',
      });
    }

    const dockerPanel = document.getElementById('dockerPanel');
    if (dockerPanel) {
      // Move #dockerRestartBtn and #dockerRefreshBtn out of the 42px titlebar into the .docker-tabs bar!
      const dockerTabs = dockerPanel.querySelector('.docker-tabs');
      const restartBtn = dockerPanel.querySelector('#dockerRestartBtn');
      const refreshBtn = dockerPanel.querySelector('#dockerRefreshBtn');
      if (dockerTabs && (restartBtn || refreshBtn) && !dockerTabs.querySelector('.docker-tabs-right')) {
        const rightWrap = document.createElement('div');
        rightWrap.className = 'docker-tabs-right';
        if (refreshBtn) rightWrap.appendChild(refreshBtn);
        if (restartBtn) rightWrap.appendChild(restartBtn);
        dockerTabs.appendChild(rightWrap);
      }
      ensureUnifiedPanelTitlebar(dockerPanel, {
        iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent, #0A84FF)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.5 21 7v10l-9 4.5L3 17V7z"/><path d="M3 7l9 4.5L21 7"/><path d="M12 11.5V21.5"/></svg>',
        titleText: '容器管理',
        closeBtnSelector: '#dockerCloseBtn',
      });
    }

    const snippetPanel = document.getElementById('snippetPanel');
    if (snippetPanel) {
      const snipEmpty = snippetPanel.querySelector('#snippetEmpty');
      if (snipEmpty && !snipEmpty.querySelector('svg')) {
        snipEmpty.innerHTML = `
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
          <strong data-i18n="暂无代码片段">${t('暂无代码片段')}</strong><span data-i18n="可在首页「设置 → 代码片段」中添加常用运维脚本，点击即可一键发送至当前终端执行">${t('可在首页「设置 → 代码片段」中添加常用运维脚本，点击即可一键发送至当前终端执行')}</span>
        `;
      }
      ensureUnifiedPanelTitlebar(snippetPanel, {
        iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent, #0A84FF)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 7 4 12 9 17"/><polyline points="15 7 20 12 15 17"/></svg>',
        titleText: '代码片段',
        onClose: () => {
          snippetPanel.classList.remove('open');
          snippetPanel.style.display = 'none';
          document.getElementById('snippetBtn')?.classList.remove('active');
        },
      });
    }

    const shortcutPanel = document.getElementById('shortcutPanel');
    if (shortcutPanel) {
      ensureUnifiedPanelTitlebar(shortcutPanel, {
        iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent, #0A84FF)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/></svg>',
        titleText: '快捷键',
        onClose: () => {
          shortcutPanel.classList.remove('open');
          shortcutPanel.style.display = 'none';
          document.getElementById('shortcutBtn')?.classList.remove('active');
        },
      });
    }
    // UI124: temporarily commented out Port Forwarding panel upgrade
    // 
    // 
    //     const pfPanel = document.getElementById('portForwardPanel');
    //     if (pfPanel) {
    //       ensureUnifiedPanelTitlebar(pfPanel, {
    //         iconSvg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent, #0A84FF)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg>',
    //         titleText: '端口转发',
    //         closeBtnSelector: '#portForwardCloseBtn',
    //       });
    //     }

    const tnPanel = document.getElementById('terminalNotesPanel');
    if (tnPanel) {
      ensureUnifiedPanelTitlebar(tnPanel, {
        onClose: () => {
          tnPanel.classList.remove('open');
          tnPanel.style.display = 'none';
          document.getElementById('notesBtn')?.classList.remove('active');
        },
      });
    }

    // Upgrade RDP & VNC Tier-1 floating panels (#clipboardPanel, #filesPanel, #shortcutsPanel, #joystickPanel)
    const rdpVncPanelSpecs = [
      {
        id: 'clipboardPanel',
        btnId: 'clipboardBtn',
        title: '跨设备剪贴板',
        svg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent, #0A84FF)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>',
      },
      {
        id: 'filesPanel',
        btnId: 'rdpFilesBtn',
        title: '远程文件剪贴板',
        svg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent, #0A84FF)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
      },
      {
        id: 'shortcutsPanel',
        btnId: 'shortcutsBtn',
        title: '快捷键',
        svg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent, #0A84FF)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/></svg>',
      },
      {
        id: 'joystickPanel',
        btnId: document.getElementById('joystickBtn') ? 'joystickBtn' : 'dragBtn',
        title: '视区摇杆',
        svg: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent, #0A84FF)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/><path d="M12 3v3m0 12v3M3 12h3m12 0h3"/></svg>',
      },
    ];

    for (const rspec of rdpVncPanelSpecs) {
      const rPanel = document.getElementById(rspec.id);
      if (!rPanel) continue;
      if (rootPage && rPanel.parentElement !== rootPage) {
        rootPage.appendChild(rPanel);
      }
      rPanel.querySelector('.rdp-panel-content > .rdp-panel-head')?.remove();
      let topHead = rPanel.querySelector(':scope > .panel-titlebar');
      if (!topHead) {
        topHead = document.createElement('div');
        topHead.className = 'snippet-panel-header panel-titlebar';
        topHead.innerHTML = '<strong data-i18n="' + rspec.title + '">' + t(rspec.title) + '</strong>';
        rPanel.insertBefore(topHead, rPanel.firstChild);
      }
      if (!rPanel.classList.contains('open')) {
        rPanel.style.display = 'none';
      }
      ensureUnifiedPanelTitlebar(rPanel, {
        titlebarEl: topHead,
        iconSvg: rspec.svg,
        titleText: rspec.title,
        onClose: () => {
          rPanel.classList.remove('open', 'front');
          rPanel.hidden = true;
          rPanel.setAttribute('hidden', '');
          rPanel.style.display = 'none';
          document.getElementById(rspec.btnId)?.classList.remove('active');
        },
      });
      const rBtn = document.getElementById(rspec.btnId);
      if (rBtn && !rBtn.dataset.unifiedRdpBtnBound) {
        rBtn.dataset.unifiedRdpBtnBound = '1';
        rBtn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          const isOpen = rPanel.classList.contains('open') && rPanel.style.display !== 'none';
          if (isOpen) {
            rBtn.classList.remove('active');
            closeUnifiedPanel(rPanel, {
              triggerBtn: rBtn,
              onAfterClose: () => {
                rPanel.hidden = true;
                rPanel.setAttribute('hidden', '');
              },
            });
          } else {
            rPanel.hidden = false;
            rPanel.removeAttribute('hidden');
            ensureFloatingDefaultPosition(rPanel, { triggerBtn: rBtn });
            rPanel.style.display = 'flex';
            rPanel.classList.add('open');
            rBtn.classList.add('active');
            setFocusedFloatingPanel(rPanel);
            getMotion()?.panelOpenWasm?.(rPanel, rBtn, { preset: 'mac' });
            syncHostWindowDockAndFloatState();
          }
        }, true);
      }
    }

    observeDynamicSecondaryWindows();
  }

  ensureSftpChrome();

  function syncTerminalChildIpProtection(enabled) {
    const flag = typeof enabled === 'boolean' ? enabled : isIpProtectionEnabled();
    window.__zephyrIpProtection = flag;
    try { localStorage.removeItem('zephyr_ip_protection'); localStorage.setItem('zephyr_ip_protection_saved', flag ? '1' : '0'); } catch (_) {}
    document.body?.classList.toggle('ip-protection-on', flag);
    const displayHost = flag ? scrubIpWhenProtected(hostName, '') : (hostName || '');
    document.querySelectorAll('.fm-title-host, #fmFooterHost, #fmHostChip').forEach((el) => {
      el.textContent = displayHost;
      el.style.display = (flag && !displayHost) ? 'none' : '';
    });
    const connInfoEl = document.getElementById('connInfo');
    if (connInfoEl && flag) {
      connInfoEl.textContent = scrubIpWhenProtected(connInfoEl.textContent, 'SSH');
    }
    const overlayMsgEl = document.getElementById('overlayMsg');
    if (overlayMsgEl && flag) {
      overlayMsgEl.textContent = scrubIpWhenProtected(overlayMsgEl.textContent, overlayMsgEl.textContent);
    }
    // IMPORTANT WHITELIST (4.3 #4): When Monitor Card (#infoModal.open) is open,
    // its IPv4 ([data-stat="ipv4"]) and IPv6 ([data-stat="ipv6"]) fields MUST remain visible!
    const infoModalEl = document.getElementById('infoModal');
    if (infoModalEl) {
      infoModalEl.querySelectorAll('[data-stat="ipv4"], [data-stat="ipv6"]').forEach((el) => {
        el.style.visibility = 'visible';
        el.style.display = '';
      });
    }
  }

  if (!document.documentElement.dataset.paneActivateBound) {
    document.documentElement.dataset.paneActivateBound = '1';
    const notifyPaneActivate = () => {
      if (window.parent === window) return;
      try {
        const tabId = new URLSearchParams(location.search).get('tabId') || '';
        if (!tabId) return;
        window.parent.postMessage({
          source: 'zephyr-terminal',
          type: 'zephyr-pane-activate',
          tabId,
        }, '*');
      } catch {}
    };
    document.addEventListener('pointerdown', notifyPaneActivate, true);
    try {
      if (window.parent !== window) {
        window.parent.postMessage({ source: 'zephyr-terminal', type: 'zephyr-pane-slot-query' }, '*');
      }
    } catch {}
  }

  syncTerminalChildIpProtection();
  window.addEventListener('message', (ev) => {
    const d = ev?.data;
    if (d && d.source === 'zephyr-app' && d.type === 'zephyr-pane-slot') {
      const nextSlotSide = d.slotSide || 'single';
      window.__zephyrPaneSlotSide = nextSlotSide;
      const page = document.querySelector('.terminal-page') || document.body;
      const isInactiveSlot = (nextSlotSide === 'left' || nextSlotSide === 'right' || nextSlotSide === 'middle-force-left' || nextSlotSide === 'middle-force-right');
      const wasInactiveSlot = page.classList.contains('pane-slot-inactive');
      page.classList.toggle('pane-slot-inactive', isInactiveSlot);
      const dockedPanels = page.querySelectorAll('.z-unified-panel.pinned, .z-unified-panel.docked-left, .z-unified-panel.docked-right');
      if (dockedPanels.length) {
        reconcilePinnedPanelsForSlotSide(page, { animate: true });
      }
      if (wasInactiveSlot !== isInactiveSlot || dockedPanels.length) {
        syncHostWindowDockAndFloatState({ userTriggered: false });
      }
    }
    if (d && d.source === 'zephyr-app' && d.type === 'zephyr-ai-state') {
      syncTerminalAiToolbarButton(Boolean(d.enabled), Boolean(d.panelOpen));
    }
    if (d && d.source === 'zephyr-app' && d.type === 'ip-protection-change') {
      syncTerminalChildIpProtection(Boolean(d.enabled));
    }
  });

  // ensurePortForwardPanel();
  upgradeAllTerminalFloatingPanels();
  ensureTerminalOverlays();
  bindTerminalPathClick();

  return {
    cdState,
    recordCdCommand,
    parseInputForCd,
    consumeInitialSftpPath,
    syncActiveSftpTab,
    checkFileMemoryGate,
    showInlineSudoSaveBar,
    onIncomingTerminalChunk,
    toggleInlineSearch,
    sanitizeTerminalPaste,
    classifyTerminalCommandRisk,
  };
}
