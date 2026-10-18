/* ==========================================================================
 * public/zephyr-icons.js — ZephyrIcons neutral geometric vector icon set
 *
 * Spec: ZEPHYR-UNIFIED-MASTER-PLAN 2.4.1
 *   - viewBox="0 0 24 24", fill="none", stroke="currentColor",
 *     stroke-width="1.75", linecap/linejoin="round"
 *   - Zero Emoji policy: every glyph that used to be an emoji is drawn here.
 *   - Trademark neutrality: no third-party brand marks (no whale glyph).
 *
 * Usage (ESM):
 *   import { renderZephyrIconSvg, ZEPHYR_ICON_PATHS } from './zephyr-icons.js';
 *   el.innerHTML = renderZephyrIconSvg('eye');
 *
 * Usage (inline HTML / template string): setZephyrIcon(el, 'moon')
 * ========================================================================== */

const STROKE_DEFAULT = 1.75;

/* Path bodies only. Keeping them as raw markup lets the same table drive
 * innerHTML, template strings and setZephyrIcon without re-serialising. */
export const ZEPHYR_ICON_PATHS = Object.freeze({
  /* ── brand ─────────────────────────────────────────────────────────── */
  'wind': '<path d="M3 8h9.5a2.5 2.5 0 1 0-2.4-3.2"/><path d="M3 12h13a2.5 2.5 0 1 1-2.4 3.2"/><path d="M3 16h7.5a2 2 0 1 1-1.9 2.6"/>',

  /* ── theme ─────────────────────────────────────────────────────────── */
  'sun': '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42"/>',
  'moon': '<path d="M20.6 14.5A8.8 8.8 0 0 1 9.5 3.4a.7.7 0 0 0-.9-.9A10.2 10.2 0 1 0 21.5 15.4a.7.7 0 0 0-.9-.9z"/>',
  'sun-moon': '<circle cx="12" cy="12" r="3.2"/><path d="M12 4.2v1.6M12 18.2v1.6M6.5 6.5l1.1 1.1M16.4 16.4l1.1 1.1M4.2 12h1.6M18.2 12h1.6M6.5 17.5l1.1-1.1M16.4 7.6l1.1-1.1"/>',

  /* ── password reveal ───────────────────────────────────────────────── */
  'eye': '<path d="M2.2 12S5.8 5.4 12 5.4 21.8 12 21.8 12 18.2 18.6 12 18.6 2.2 12 2.2 12z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M9.9 5.7A9.9 9.9 0 0 1 12 5.4c6.2 0 9.8 6.6 9.8 6.6a17 17 0 0 1-3 3.7"/><path d="M6.4 7.4A16.8 16.8 0 0 0 2.2 12S5.8 18.6 12 18.6a9.8 9.8 0 0 0 4-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M3 3l18 18"/>',

  /* ── navigation ────────────────────────────────────────────────────── */
  'grid': '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
  'activity-wave': '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  'terminal': '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  'bolt-circle': '<circle cx="12" cy="12" r="9"/><path d="M13.2 6.4 8.4 13h3.6l-.9 4.6 4.8-6.6h-3.6z"/>',
  'note-text': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  'settings-gear': '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',

  /* ── terminal dock ─────────────────────────────────────────────────── */
  'keyboard': '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/>',
  'copy': '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  'clipboard-paste': '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
  'folder': '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  'port-tunnel': '<rect x="2" y="9" width="20" height="6" rx="3"/><path d="M7 12h10"/><circle cx="12" cy="12" r="1"/>',
  'code-snippet': '<polyline points="9 7 4 12 9 17"/><polyline points="15 7 20 12 15 17"/>',
  'cube-box': '<path d="M12 2.5 21 7v10l-9 4.5L3 17V7z"/><path d="M3 7l9 4.5L21 7"/><path d="M12 11.5V21.5"/>',
  'chart-line': '<polyline points="3 17 9 11 13 15 21 6"/><polyline points="16 6 21 6 21 11"/>',
  'close-circle': '<circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/>',
  'stats-pulse': '<path d="M3 12h3l2-6 3 12 2.5-7 2 4h5.5"/>',
  'alert-triangle': '<path d="M10.3 3.7 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  'shield': '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',

  /* ── AI capabilities ───────────────────────────────────────────────── */
  'image': '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  'file-text': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="15" x2="15" y2="15"/>',
  'audio-wave': '<path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/>',
  'video': '<rect x="2" y="5" width="14" height="14" rx="2"/><path d="M16 10l6-3v10l-6-3z"/>',
  'sparkles': '<path d="M12 3l1.7 4.6L18 9.3l-4.3 1.7L12 15.6l-1.7-4.6L6 9.3l4.3-1.7z"/><path d="M18 15l.9 2.4L21 18.3l-2.1.9L18 21.6l-.9-2.4L15 18.3l2.1-.9z"/>',
  'bolt': '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',

  /* ── devices (cross-end badge) ─────────────────────────────────────── */
  'device-laptop': '<rect x="2" y="4" width="20" height="12" rx="1.6"/><path d="M1 19h22"/>',
  'device-phone': '<rect x="6.5" y="2" width="11" height="20" rx="2.2"/><path d="M10.5 18.4h3"/>',
  'device-tablet': '<rect x="4" y="2.5" width="16" height="19" rx="2"/><path d="M11 18.6h2"/>',

  /* ── misc chrome ───────────────────────────────────────────────────── */
  'chevron-up': '<polyline points="18 15 12 9 6 15"/>',
  'chevron-down': '<polyline points="6 9 12 15 18 9"/>',
  'plus': '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  'close': '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  'check': '<polyline points="20 6 9 17 4 12"/>',
  'drive-link': '<path d="M10 13a5 5 0 0 0 7.1 0l2.4-2.4a5 5 0 0 0-7.1-7.1L11 4.9"/><path d="M14 11a5 5 0 0 0-7.1 0l-2.4 2.4a5 5 0 0 0 7.1 7.1L13 19.1"/>',
});

/**
 * Render one ZephyrIcons glyph as an inline SVG string.
 * @param {string} id       key in ZEPHYR_ICON_PATHS
 * @param {object} [opts]
 * @param {number} [opts.size=16]        pixel size (width + height)
 * @param {number} [opts.strokeWidth]    override stroke width
 * @param {string} [opts.className]      extra class names
 * @param {string} [opts.title]          accessible title (adds <title>)
 * @param {boolean} [opts.decorative]    when true, aria-hidden instead of titled
 * @returns {string} SVG markup, or '' when the id is unknown
 */
export function renderZephyrIconSvg(id, opts = {}) {
  const body = ZEPHYR_ICON_PATHS[id];
  if (!body) return '';
  const size = Number(opts.size) > 0 ? Number(opts.size) : 16;
  const stroke = Number(opts.strokeWidth) > 0 ? Number(opts.strokeWidth) : STROKE_DEFAULT;
  const cls = opts.className ? ` class="${String(opts.className).replace(/"/g, '')}"` : '';
  const title = opts.title && !opts.decorative ? String(opts.title) : '';
  const a11y = opts.decorative || !title
    ? ' aria-hidden="true"'
    : ' role="img"';
  const titleTag = title ? `<title>${title.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</title>` : '';
  return `<svg${cls} width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"${a11y}>${titleTag}${body}</svg>`;
}

/**
 * Replace an element's content with one glyph. Used by every control that
 * previously wrote an emoji through textContent (which also nuked child SVG).
 */
export function setZephyrIcon(el, id, opts = {}) {
  if (!el) return false;
  const markup = renderZephyrIconSvg(id, opts);
  if (!markup) return false;
  el.innerHTML = markup;
  return true;
}

/**
 * Swap a sun/moon icon according to the active theme. Never writes plain text,
 * so the SVG survives theme flips (plan 2.3 table row 1 bug).
 */
export function applyThemeIcon(el, theme, opts = {}) {
  if (!el) return false;
  return setZephyrIcon(el, theme === 'light' ? 'sun' : 'moon', { size: 16, ...opts, decorative: opts.title ? false : true });
}

/**
 * Swap an eye / eye-off glyph for a password visibility control.
 */
export function applyPasswordRevealIcon(el, revealed, opts = {}) {
  if (!el) return false;
  return setZephyrIcon(el, revealed ? 'eye-off' : 'eye', { size: 16, ...opts });
}

/** Brand mark markup (replaces DEFAULT_BRAND_ICON emoji). */
export function zephyrBrandWindIconHtml(size = 20, className = 'zephyr-brand-wind') {
  return renderZephyrIconSvg('wind', { size, className, decorative: true });
}

/** Convenience map for callers that only need markup per key. */
export const ZEPHYR_ICONS = Object.freeze(
  Object.fromEntries(Object.keys(ZEPHYR_ICON_PATHS).map((k) => [k, renderZephyrIconSvg(k, { decorative: true })]))
);
