/**
 * notes.js — Notes workspace UI (FREEZE plan §6.4).
 * Craft-first shell: in-app dialogs only (no browser chrome dialogs),
 * Bear/Craft/Apple Notes-inspired layout, SVG chrome, master-detail mobile.
 */

import { renderMarkdown as renderMarkdownFull, escapeHtml as mdEscapeHtml } from './markdown.js?v=20260720-notes-md1';
import { t } from './i18n/runtime.js?v=20260727-ai-settings-fix1';

const NOTES_DEBOUNCE_MS = 800;
const NOTES_SEARCH_MS = 180;

function escapeHtml(value) {
    return mdEscapeHtml(value);
}

function prefersReducedMotion() {
    try {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
        return false;
    }
}

/** Full GFM render for notes preview (tables, tasks, nested lists, etc.). */
function safeMarkdown(src) {
    try {
        return renderMarkdownFull(String(src || ''));
    } catch (err) {
        console.warn('[notes] markdown render failed', err);
        return `<p>${escapeHtml(src)}</p>`;
    }
}

function formatRelativeTime(ts) {
    const delta = Date.now() - Number(ts || 0);
    if (!Number.isFinite(delta) || delta < 0) return '';
    if (delta < 60_000) return t('刚刚');
    if (delta < 3_600_000) return t('{count} 分钟前', { count: Math.floor(delta / 60_000) });
    if (delta < 86_400_000) return t('{count} 小时前', { count: Math.floor(delta / 3_600_000) });
    if (delta < 7 * 86_400_000) return t('{count} 天前', { count: Math.floor(delta / 86_400_000) });
    try {
        return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch {
        return '';
    }
}

function formatAbsoluteTime(ts) {
    try {
        return new Date(ts).toLocaleString();
    } catch {
        return '';
    }
}

const ICONS = {
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M16.2 16.2 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h4l1.5 1.8h7.5a2 2 0 0 1 2 2v7.2a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-9z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.8h7.2L19 8.6V20.2a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4.8a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M14 3.8V9h5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8.5 12.5h7M8.5 15.5h7M8.5 18.5h4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7.5h14M9.5 7.5V5.8a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.7M9 10.5v7M12 10.5v7M15 10.5v7M7.5 7.5l.7 11.2a1.2 1.2 0 0 0 1.2 1.1h5.2a1.2 1.2 0 0 0 1.2-1.1L16.5 7.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    /* Restore from trash — counterclockwise arrow out of bin (stroke, matches trash weight). */
    restore: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 10.2V7.6A1.1 1.1 0 0 1 8.6 6.5h6.8A1.1 1.1 0 0 1 16.5 7.6v2.6M9.2 6.5V5.3A1 1 0 0 1 10.2 4.3h3.6a1 1 0 0 1 1 1v1.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.2 14.2a4.3 4.3 0 1 0 1.3-3.1" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M7.2 9.4h3.4v3.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 12.2 10.2 16 17.5 8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    selectAll: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="4.5" width="15" height="15" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 12.2l2.4 2.4L16.2 9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    multi: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="10.5" height="10.5" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M9.5 15.5h7.3A1.7 1.7 0 0 0 18.5 13.8V6.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M7.6 10.2l1.8 1.8 3.4-3.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    purge: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7.5h14M9.5 7.5V5.8a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.7M7.5 7.5l.7 11.2a1.2 1.2 0 0 0 1.2 1.1h5.2a1.2 1.2 0 0 0 1.2-1.1L16.5 7.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 12.2 14 16.2M14 12.2 10 16.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 14.5 14.5 9.5M8.2 12.2l-1.4 1.4a3.2 3.2 0 1 0 4.5 4.5l1.4-1.4M15.8 11.8l1.4-1.4a3.2 3.2 0 0 0-4.5-4.5l-1.4 1.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    share: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6.5" cy="12" r="2.2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="17" cy="6.5" r="2.2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="17" cy="17.5" r="2.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8.5 11.1 14.8 7.6M8.6 13 14.8 16.3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="18" cy="12" r="1.5" fill="currentColor"/></svg>',
    back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5.5 8.5 12 15 18.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 9.5 12 13l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    export: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.5v9.5M8.5 8 12 4.5 15.5 8M5.5 14.5v3.2A1.3 1.3 0 0 0 6.8 19h10.4a1.3 1.3 0 0 0 1.3-1.3v-3.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    import: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14.5V5M8.5 11 12 14.5 15.5 11M5.5 16.5v1.2A1.3 1.3 0 0 0 6.8 19h10.4a1.3 1.3 0 0 0 1.3-1.3v-1.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
    bold: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 5.5h5.2a3.4 3.4 0 0 1 0 6.8H7.5zm0 6.8h5.8a3.5 3.5 0 0 1 0 7H7.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    italic: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5.5h6M7 18.5h6M13.5 5.5 10.5 18.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    strike: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12M9 7.5c.8-1.6 2-2.3 3.6-2.3 2.2 0 3.6 1.3 3.6 3.1 0 1.1-.4 1.9-1.2 2.5M8.4 14.2c.3 2.1 1.8 3.6 4 3.6 2.3 0 4-1.4 4-3.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    code: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7.5 4.5 12 9 16.5M15 7.5 19.5 12 15 16.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    codeblock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="5.5" width="15" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8.5 10 7 12l1.5 2M15.5 10 17 12l-1.5 2M12.4 9.5l-1.2 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    heading: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 5.5v13M17.5 5.5v13M6.5 12h11" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
    quote: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 17.5c-2.2 0-3.8-1.7-3.8-4.1 0-3.2 2.3-5.9 5.3-7.1l.7 1.4c-1.8.9-3 2.5-3.1 4.2.5-.3 1.1-.5 1.8-.5 1.7 0 3 1.2 3 3 0 1.7-1.3 3.1-3.9 3.1zm9 0c-2.2 0-3.8-1.7-3.8-4.1 0-3.2 2.3-5.9 5.3-7.1l.7 1.4c-1.8.9-3 2.5-3.1 4.2.5-.3 1.1-.5 1.8-.5 1.7 0 3 1.2 3 3 0 1.7-1.3 3.1-3.9 3.1z" fill="currentColor"/></svg>',
    list: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 7h9M9.5 12h9M9.5 17h9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="6" cy="7" r="1.1" fill="currentColor"/><circle cx="6" cy="12" r="1.1" fill="currentColor"/><circle cx="6" cy="17" r="1.1" fill="currentColor"/></svg>',
    olist: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 7h9M10 12h9M10 17h9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><text x="4.2" y="8.2" font-size="6.2" fill="currentColor" font-family="system-ui,sans-serif">1</text><text x="4.2" y="13.2" font-size="6.2" fill="currentColor" font-family="system-ui,sans-serif">2</text><text x="4.2" y="18.2" font-size="6.2" fill="currentColor" font-family="system-ui,sans-serif">3</text></svg>',
    task: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="4.5" width="15" height="15" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 12.2l2.4 2.4L16.2 9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
};

function icon(name) {
    return ICONS[name] || '';
}

/** In-app dialog layer — never reaches for browser chrome dialogs. */
function ensureDialogHost() {
    let host = document.getElementById('notesDialogHost');
    if (host) return host;
    host = document.createElement('div');
    host.id = 'notesDialogHost';
    host.className = 'notes-dialog-host';
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
    return host;
}

function openNativeDialog({
    title = '',
    message = '',
    input = null, // { value, placeholder, maxLength, label }
    confirmLabel = t('确定'),
    cancelLabel = t('取消'),
    danger = false,
    hideCancel = false,
} = {}) {
    return new Promise((resolve) => {
        const host = ensureDialogHost();
        const backdrop = document.createElement('div');
        backdrop.className = 'notes-dialog-backdrop';
        backdrop.setAttribute('role', 'presentation');
        const panel = document.createElement('div');
        panel.className = 'notes-dialog';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-label', title || t('对话框'));
        const inputId = `notesDialogInput-${Math.random().toString(36).slice(2, 8)}`;
        panel.innerHTML = `
            <div class="notes-dialog-head">
                <h2 class="notes-dialog-title">${escapeHtml(title)}</h2>
                <button type="button" class="notes-icon-btn notes-dialog-close" data-notes-dialog="cancel" aria-label="${t('关闭')}">${icon('close')}</button>
            </div>
            ${message ? `<p class="notes-dialog-message">${escapeHtml(message)}</p>` : ''}
            ${input ? `
                <label class="notes-dialog-field" for="${inputId}">
                    ${input.label ? `<span>${escapeHtml(input.label)}</span>` : ''}
                    <input id="${inputId}" class="notes-dialog-input" type="text"
                        value="${escapeHtml(input.value || '')}"
                        placeholder="${escapeHtml(input.placeholder || '')}"
                        maxlength="${Number(input.maxLength) || 200}"
                        autocomplete="off" spellcheck="false">
                </label>` : ''}
            <div class="notes-dialog-actions">
                ${hideCancel ? '' : `<button type="button" class="btn notes-dialog-cancel" data-notes-dialog="cancel">${escapeHtml(cancelLabel)}</button>`}
                <button type="button" class="btn btn-primary${danger ? ' notes-dialog-danger' : ''}" data-notes-dialog="confirm">${escapeHtml(confirmLabel)}</button>
            </div>`;
        backdrop.appendChild(panel);
        host.appendChild(backdrop);

        const inputEl = input ? panel.querySelector('.notes-dialog-input') : null;
        const confirmBtn = panel.querySelector('[data-notes-dialog="confirm"]');
        let settled = false;

        const settle = (value) => {
            if (settled) return;
            settled = true;
            backdrop.classList.add('closing');
            const done = () => {
                backdrop.removeEventListener('animationend', done);
                backdrop.remove();
            };
            if (prefersReducedMotion()) {
                backdrop.remove();
            } else {
                backdrop.addEventListener('animationend', done);
                window.setTimeout(done, 280);
            }
            window.removeEventListener('keydown', onKey);
            resolve(value);
        };

        const onKey = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                settle(input ? null : false);
            } else if (e.key === 'Enter' && !e.isComposing) {
                if (document.activeElement === inputEl || e.target === confirmBtn) {
                    e.preventDefault();
                    settle(input ? (inputEl?.value ?? '') : true);
                }
            }
        };

        backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop) settle(input ? null : false);
        });
        panel.querySelectorAll('[data-notes-dialog]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const kind = btn.getAttribute('data-notes-dialog');
                if (kind === 'cancel') settle(input ? null : false);
                else settle(input ? (inputEl?.value ?? '') : true);
            });
        });
        window.addEventListener('keydown', onKey);

        requestAnimationFrame(() => {
            backdrop.classList.add('show');
            if (inputEl) {
                inputEl.focus();
                inputEl.select?.();
            } else {
                confirmBtn?.focus();
            }
        });
    });
}

function nativeConfirm(opts) {
    return openNativeDialog({
        title: opts.title || t('确认'),
        message: opts.message || '',
        confirmLabel: opts.confirmLabel || t('确定'),
        cancelLabel: opts.cancelLabel || t('取消'),
        danger: !!opts.danger,
    }).then((v) => v === true);
}

function nativePrompt(opts) {
    return openNativeDialog({
        title: opts.title || '',
        message: opts.message || '',
        input: {
            value: opts.value || '',
            placeholder: opts.placeholder || '',
            maxLength: opts.maxLength || 200,
            label: opts.label || '',
        },
        confirmLabel: opts.confirmLabel || t('确定'),
        cancelLabel: opts.cancelLabel || t('取消'),
    });
}

export function createNotesController({
    api,
    toast,
    openTransientFromUri,
    $ = (s) => document.querySelector(s),
    $$ = (s) => [...document.querySelectorAll(s)],
}) {
    const state = {
        notes: [],
        groups: [],
        selectedId: null,
        current: null,
        mode: 'edit', // edit | split | preview
        groupFilter: '__all',
        tagFilter: 'all',
        query: '',
        trash: false,
        dirty: false,
        saving: false,
        saveTimer: null,
        searchTimer: null,
        generation: 0,
        loaded: false,
        connectionFilter: '',
        sortBy: 'updated',
        trashCount: 0,
        mobileDetail: false,
        allTags: [],
        /** Multi-select mode for bulk trash/restore/purge. */
        selectMode: false,
        selectedIds: new Set(),
    };

    const SORT_LABELS = {
        updated: t('最近更新'),
        created: t('最近创建'),
        title: t('标题'),
    };

    function setSaveState(kind, text) {
        const el = $('#notesSaveState');
        if (!el) return;
        el.dataset.state = kind;
        el.textContent = text;
        el.title = text;
    }

    function headingForFilter() {
        if (state.trash || state.groupFilter === '__trash') return t('回收站');
        if (state.groupFilter === '__all') return t('全部笔记');
        if (state.groupFilter === '' || state.groupFilter == null) return t('未分组');
        return state.groupFilter;
    }

    function updateListHeading() {
        const h = $('#notesListHeading');
        const c = $('#notesListCount');
        if (h) h.textContent = headingForFilter();
        if (c) c.textContent = String(state.notes.length);
        const sortBtn = $('#notesSortTrigger');
        if (sortBtn) {
            const label = SORT_LABELS[state.sortBy] || SORT_LABELS.updated;
            sortBtn.querySelector('.notes-filter-label') && (sortBtn.querySelector('.notes-filter-label').textContent = label);
        }
        const tagBtn = $('#notesTagTrigger');
        if (tagBtn) {
            const label = state.tagFilter === 'all' ? t('全部标签') : state.tagFilter;
            const span = tagBtn.querySelector('.notes-filter-label');
            if (span) span.textContent = label;
        }
    }

    function refreshPreview() {
        const preview = $('#notesPreview');
        if (!preview) return;
        if (state.mode !== 'preview' && state.mode !== 'split') return;
        const input = $('#notesContentInput');
        preview.innerHTML = safeMarkdown(input?.value || '');
        interceptPreviewLinks(preview);
        preview.querySelectorAll('a[href^="ssh:"],a[href^="telnet:"],a[href^="jms:"]').forEach((a) => {
            a.addEventListener('click', (e) => {
                e.preventDefault();
                openTransientFromUri?.(a.getAttribute('href'));
            });
        });
    }

    function schedulePreviewRefresh() {
        window.clearTimeout(schedulePreviewRefresh._timer);
        schedulePreviewRefresh._timer = window.setTimeout(refreshPreview, 80);
    }

    function setMode(mode) {
        state.mode = mode;
        $$('.notes-mode-btn').forEach((btn) => {
            const active = btn.dataset.notesMode === mode;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        const switcher = $('#notesModeSwitch');
        if (switcher) switcher.dataset.mode = mode;
        const body = $('#notesBody');
        if (body) body.dataset.mode = mode;
        refreshPreview();
    }

    function setMobileDetail(open) {
        state.mobileDetail = !!open;
        const shell = $('#notesShell') || $('#notesWorkspace');
        shell?.classList.toggle('notes-mobile-detail', !!open);
        shell?.classList.toggle('notes-mobile-list', !open);
    }

    function renderGroups() {
        const tree = $('#notesGroupTree');
        if ($('#notesCountAll')) $('#notesCountAll').textContent = String(
            state.groupFilter === '__all' ? state.notes.length : ($('#notesCountAll').dataset.total || state.notes.length),
        );
        // Keep all-count from last full list when filtered — refresh via data attr
        if (state.groupFilter === '__all' && !state.query && state.tagFilter === 'all' && !state.connectionFilter) {
            if ($('#notesCountAll')) {
                $('#notesCountAll').textContent = String(state.notes.length);
                $('#notesCountAll').dataset.total = String(state.notes.length);
            }
        }
        let ungrouped = 0;
        for (const n of state.notes) {
            if (!n.groupPath) ungrouped += 1;
        }
        // Only meaningful when viewing unfiltered; still update when possible
        if ($('#notesCountUngrouped') && state.groupFilter === '__all' && !state.query) {
            // count from groups API when available
            const gEmpty = state.groups.find((g) => !g.groupPath);
            $('#notesCountUngrouped').textContent = String(gEmpty ? gEmpty.count : ungrouped);
        }
        if ($('#notesCountTrash')) $('#notesCountTrash').textContent = String(state.trashCount);

        $$('.notes-group-item').forEach((btn) => {
            const g = btn.dataset.group;
            const active = g === state.groupFilter || (g === '' && state.groupFilter === '');
            // __all special
            btn.classList.toggle('active', String(g) === String(state.groupFilter));
        });

        if (!tree) return;
        tree.innerHTML = state.groups
            .filter((g) => g.groupPath)
            .map((g) => {
                const active = state.groupFilter === g.groupPath ? ' active' : '';
                return `<button type="button" class="notes-group-item${active}" data-group="${escapeHtml(g.groupPath)}" title="${escapeHtml(g.groupPath)}">
                    <span class="notes-group-icon">${icon('folder')}</span>
                    <span class="notes-group-label">${escapeHtml(g.groupPath)}</span>
                    <span class="notes-group-count">${g.count}</span>
                </button>`;
            })
            .join('');

        tree.querySelectorAll('.notes-group-item').forEach((btn) => {
            btn.addEventListener('contextmenu', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                await showGroupContextMenu(btn.dataset.group, e.clientX, e.clientY);
            });
        });
    }

    async function showGroupContextMenu(groupPath, x, y) {
        closeMenus();
        const menu = document.createElement('div');
        menu.id = 'notesContextMenu';
        menu.className = 'notes-menu notes-context-menu';
        menu.innerHTML = `
            <button type="button" class="notes-menu-item" data-g-action="rename">${icon('note')}<span>${t('重命名分组')}</span></button>
            <button type="button" class="notes-menu-item danger" data-g-action="delete">${icon('trash')}<span>${t('删除分组')}</span></button>`;
        placeMenu(menu, x, y);
        requestAnimationFrame(() => menu.classList.add('show'));
        menu.querySelectorAll('[data-g-action]').forEach((btn) => {
            btn.addEventListener('click', async () => {
                closeMenus();
                const action = btn.dataset.gAction;
                if (action === 'rename') {
                    const newName = await nativePrompt({
                        title: t('重命名分组'),
                        message: t('将「{group}」重命名为：', { group: groupPath }),
                        value: groupPath,
                        placeholder: 'ops/runbooks',
                        confirmLabel: t('重命名'),
                    });
                    if (newName == null) return;
                    const trimmed = String(newName).trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
                    if (!trimmed || trimmed === groupPath) return;
                    try {
                        await api('/api/notes/groups/rename', {
                            method: 'POST',
                            body: JSON.stringify({ oldPath: groupPath, newPath: trimmed }),
                        });
                        if (state.groupFilter === groupPath) state.groupFilter = trimmed;
                        toast?.(t('已重命名分组'));
                        await loadList();
                    } catch (err) {
                        toast?.(err.message || t('重命名失败'));
                    }
                } else if (action === 'delete') {
                    const ok = await nativeConfirm({
                        title: t('删除分组'),
                        message: t('确定删除分组「{group}」？该分组下的笔记会移到未分组。', { group: groupPath }),
                        confirmLabel: t('删除分组'),
                        danger: true,
                    });
                    if (!ok) return;
                    try {
                        await api('/api/notes/groups/delete', {
                            method: 'POST',
                            body: JSON.stringify({ groupPath }),
                        });
                        if (state.groupFilter === groupPath) state.groupFilter = '__all';
                        toast?.(t('已删除分组'));
                        await loadList();
                    } catch (err) {
                        toast?.(err.message || t('删除失败'));
                    }
                }
            });
        });
    }

    function renderList() {
        const list = $('#notesList');
        const empty = $('#notesListEmpty');
        if (!list) return;
        const sorted = [...state.notes];
        const sortBy = state.sortBy || 'updated';
        sorted.sort((a, b) => {
            if (sortBy === 'title') return String(a.title || '').localeCompare(String(b.title || ''), 'zh');
            if (sortBy === 'created') return Number(b.createdAt || 0) - Number(a.createdAt || 0);
            return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
        });
        updateListHeading();
        if (!sorted.length) {
            list.innerHTML = '';
            empty?.classList.remove('force-hidden');
            const emptyTitle = empty?.querySelector('[data-empty-title]');
            const emptyDesc = empty?.querySelector('[data-empty-desc]');
            if (state.trash) {
                if (emptyTitle) emptyTitle.textContent = t('回收站是空的');
                if (emptyDesc) emptyDesc.textContent = t('删除的笔记会出现在这里，可恢复或彻底清除。');
            } else if (state.query) {
                if (emptyTitle) emptyTitle.textContent = t('没有匹配的笔记');
                if (emptyDesc) emptyDesc.textContent = t('试试换个关键词，或清除筛选条件。');
            } else {
                if (emptyTitle) emptyTitle.textContent = t('还没有笔记');
                if (emptyDesc) emptyDesc.textContent = t('从左侧新建一条，或导入 Markdown 文件。');
            }
            return;
        }
        empty?.classList.add('force-hidden');
        // Drop selection of notes no longer in the list.
        if (state.selectMode) {
            const alive = new Set(sorted.map((n) => n.noteId));
            state.selectedIds = new Set([...state.selectedIds].filter((id) => alive.has(id)));
        }
        list.classList.toggle('notes-list-selecting', !!state.selectMode);
        list.innerHTML = sorted.map((n, i) => {
            const tags = (n.tags || []).slice(0, 3).map((t) => `<span class="notes-chip">${escapeHtml(t)}</span>`).join('');
            const links = (n.linkedConnectionIds || []).length;
            const connChip = links
                ? `<span class="notes-chip notes-chip-accent">${t('{count} 连接', { count: links })}</span>`
                : '';
            const dirtyBadge = n.noteId === state.selectedId && state.dirty
                ? `<span class="notes-chip notes-chip-warn">${t('未保存')}</span>`
                : '';
            const shared = n.shareWithUsers || n.shareWithAdmins || n.visibility === 'shared'
                ? `<span class="notes-chip">${t('共享')}</span>`
                : '';
            const delay = prefersReducedMotion() ? 0 : Math.min(i, 12) * 18;
            const checked = state.selectedIds.has(n.noteId);
            const active = n.noteId === state.selectedId && !state.selectMode;
            return `<div class="notes-list-item${active ? ' active' : ''}${checked ? ' is-checked' : ''}${state.selectMode ? ' is-selecting' : ''}" data-note-id="${escapeHtml(n.noteId)}" role="option" aria-selected="${active || checked ? 'true' : 'false'}" style="--notes-stagger:${delay}ms">
                <button type="button" class="notes-list-check" data-note-check="${escapeHtml(n.noteId)}" aria-label="${checked ? t('取消选择') : t('选择')}" aria-pressed="${checked ? 'true' : 'false'}">
                    <span class="notes-list-check-box" aria-hidden="true">${checked ? icon('check') : ''}</span>
                </button>
                <button type="button" class="notes-list-body" data-note-open="${escapeHtml(n.noteId)}">
                    <div class="notes-list-item-main">
                        <div class="notes-list-title">${escapeHtml(n.title || t('未命名笔记'))}</div>
                        <div class="notes-list-preview">${escapeHtml(n.preview || n.summary || t('暂无内容'))}</div>
                    </div>
                    <div class="notes-list-meta">
                        <time datetime="${escapeHtml(String(n.updatedAt || ''))}" title="${escapeHtml(formatAbsoluteTime(n.updatedAt))}">${escapeHtml(formatRelativeTime(n.updatedAt))}</time>
                        <div class="notes-list-chips">${tags}${connChip}${shared}${dirtyBadge}</div>
                    </div>
                </button>
            </div>`;
        }).join('');
        updateSelectionBar();
    }

    function showEditor(show) {
        $('#notesEditorEmpty')?.classList.toggle('force-hidden', show);
        $('#notesEditor')?.classList.toggle('force-hidden', !show);
    }

    function renderMetaChips(note) {
        const tagsHost = $('#notesTagsChips');
        const groupHost = $('#notesGroupChip');
        if (tagsHost) {
            const tags = note?.tags || [];
            tagsHost.innerHTML = tags.map((t) => (
                `<button type="button" class="notes-meta-chip" data-tag-chip="${escapeHtml(t)}" title="${t('移除标签')}">
                    <span>${escapeHtml(t)}</span>${icon('x')}
                </button>`
            )).join('') + `<button type="button" class="notes-meta-chip notes-meta-chip-add" id="notesAddTagBtn" title="${t('添加标签')}">${icon('plus')}<span>${t('标签')}</span></button>`;
        }
        if (groupHost) {
            const g = note?.groupPath || '';
            groupHost.innerHTML = g
                ? `<button type="button" class="notes-meta-chip notes-meta-chip-group" id="notesEditGroupBtn" title="${t('修改分组')}">${icon('folder')}<span>${escapeHtml(g)}</span></button>`
                : `<button type="button" class="notes-meta-chip notes-meta-chip-add" id="notesEditGroupBtn" title="${t('设置分组')}">${icon('folder')}<span>${t('分组')}</span></button>`;
        }
        // keep hidden inputs in sync for save path
        if ($('#notesTagsInput')) $('#notesTagsInput').value = (note?.tags || []).join(', ');
        if ($('#notesGroupInput')) $('#notesGroupInput').value = note?.groupPath || '';
    }

    function fillEditor(note) {
        showEditor(!!note);
        if (!note) {
            setMobileDetail(false);
            return;
        }
        $('#notesTitleInput').value = note.title || '';
        $('#notesContentInput').value = note.content || '';
        renderMetaChips(note);
        setSaveState('saved', t('已保存'));
        state.dirty = false;
        if (state.mode !== 'edit') setMode(state.mode);
        updateTrashButtons();
        setMobileDetail(true);
    }

    async function refreshTrashCount() {
        try {
            const data = await api('/api/notes?trash=1&limit=1');
            // trash list returns total as rows.length (limited) — fetch higher limit for count
            const full = await api('/api/notes?trash=1&limit=200');
            state.trashCount = (full.notes || []).length;
            if ($('#notesCountTrash')) $('#notesCountTrash').textContent = String(state.trashCount);
        } catch {
            /* ignore */
        }
    }

    async function loadList() {
        const gen = ++state.generation;
        const params = new URLSearchParams();
        if (state.query) params.set('q', state.query);
        if (state.groupFilter !== '__all' && state.groupFilter !== '__trash') {
            params.set('group', state.groupFilter == null ? '' : String(state.groupFilter));
        }
        if (state.trash || state.groupFilter === '__trash') params.set('trash', '1');
        if (state.tagFilter && state.tagFilter !== 'all') params.set('tag', state.tagFilter);
        if (state.connectionFilter) params.set('connectionId', state.connectionFilter);
        const data = await api(`/api/notes?${params.toString()}`);
        if (gen !== state.generation) return;
        state.notes = data.notes || [];
        renderList();
        try {
            const groups = await api('/api/notes/groups');
            if (gen !== state.generation) return;
            state.groups = groups.groups || [];
            renderGroups();
        } catch {
            renderGroups();
        }
        // Tags from current list + accumulate
        const tags = [...new Set([
            ...state.allTags,
            ...state.notes.flatMap((n) => n.tags || []),
        ])].sort((a, b) => a.localeCompare(b, 'zh'));
        state.allTags = tags;
        renderTagMenu();
        if (!(state.trash || state.groupFilter === '__trash')) {
            refreshTrashCount().catch(() => {});
        } else {
            state.trashCount = state.notes.length;
            if ($('#notesCountTrash')) $('#notesCountTrash').textContent = String(state.trashCount);
        }
        renderConnectionFilterBar();
        state.loaded = true;
    }

    function renderTagMenu() {
        const menu = $('#notesTagMenu');
        if (!menu) return;
        const tags = state.allTags;
        menu.innerHTML = `
            <button type="button" class="notes-menu-item${state.tagFilter === 'all' ? ' active' : ''}" data-tag-value="all"><span>${t('全部标签')}</span></button>
            ${tags.map((t) => `<button type="button" class="notes-menu-item${state.tagFilter === t ? ' active' : ''}" data-tag-value="${escapeHtml(t)}"><span>${escapeHtml(t)}</span></button>`).join('')}`;
    }

    function renderSortMenu() {
        const menu = $('#notesSortMenu');
        if (!menu) return;
        menu.innerHTML = Object.entries(SORT_LABELS).map(([value, label]) => (
            `<button type="button" class="notes-menu-item${state.sortBy === value ? ' active' : ''}" data-sort-value="${value}"><span>${label}</span></button>`
        )).join('');
    }

    function renderConnectionFilterBar() {
        const bar = $('#notesConnectionFilterBar');
        if (!bar) return;
        if (!state.connectionFilter) {
            bar.classList.add('force-hidden');
            bar.innerHTML = '';
            return;
        }
        bar.classList.remove('force-hidden');
        bar.innerHTML = `
            <div class="notes-filter-banner">
                <span>${t('已筛选关联连接')} <code>${escapeHtml(state.connectionFilter)}</code></span>
                <button type="button" class="notes-text-btn" id="notesClearConnectionFilter">${t('清除')}</button>
            </div>`;
        $('#notesClearConnectionFilter')?.addEventListener('click', () => {
            state.connectionFilter = '';
            loadList().catch((err) => toast?.(err.message));
        });
    }

    async function selectNote(noteId) {
        if (state.dirty && state.current) {
            try { await flushSave(); } catch (err) {
                toast?.(err.message || t('保存失败'));
                return;
            }
        }
        state.selectedId = noteId;
        renderList();
        if (!noteId) {
            state.current = null;
            fillEditor(null);
            return;
        }
        const note = await api(`/api/notes/${encodeURIComponent(noteId)}`);
        state.current = note.note;
        fillEditor(note.note);
        updateTrashButtons();
    }

    function markDirty() {
        if (!state.current) return;
        state.dirty = true;
        setSaveState('dirty', t('未保存'));
        window.clearTimeout(state.saveTimer);
        state.saveTimer = window.setTimeout(() => {
            flushSave().catch((err) => toast?.(err.message || t('自动保存失败')));
        }, NOTES_DEBOUNCE_MS);
        // live preview
        if (state.mode === 'split' || state.mode === 'preview') {
            const preview = $('#notesPreview');
            const input = $('#notesContentInput');
            if (preview && input) {
                preview.innerHTML = safeMarkdown(input.value || '');
                interceptPreviewLinks(preview);
            }
        }
        renderList();
    }

    async function flushSave() {
        if (!state.current || !state.dirty || state.saving) return state.current;
        state.saving = true;
        setSaveState('saving', t('保存中…'));
        try {
            const tags = String($('#notesTagsInput')?.value || '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            const payload = {
                title: $('#notesTitleInput')?.value || '',
                content: $('#notesContentInput')?.value || '',
                groupPath: $('#notesGroupInput')?.value || '',
                tags,
                expectedRevision: state.current.revision,
            };
            const data = await api(`/api/notes/${encodeURIComponent(state.current.noteId)}`, {
                method: 'PUT',
                body: JSON.stringify(payload),
            });
            state.current = data.note;
            state.dirty = false;
            setSaveState('saved', t('已保存'));
            const idx = state.notes.findIndex((n) => n.noteId === data.note.noteId);
            if (idx >= 0) {
                state.notes[idx] = {
                    ...state.notes[idx],
                    title: data.note.title,
                    preview: String(data.note.content || '').slice(0, 240),
                    tags: data.note.tags,
                    groupPath: data.note.groupPath,
                    updatedAt: data.note.updatedAt,
                    revision: data.note.revision,
                    shareWithUsers: data.note.shareWithUsers,
                    shareWithAdmins: data.note.shareWithAdmins,
                    visibility: data.note.visibility,
                };
                renderList();
                renderMetaChips(data.note);
            } else {
                await loadList();
            }
            return data.note;
        } catch (err) {
            if (String(err?.code || err?.message || '').includes('revision') || err?.status === 409) {
                setSaveState('error', t('版本冲突'));
                try {
                    const serverData = await api(`/api/notes/${encodeURIComponent(state.current.noteId)}`);
                    await showConflictWindow(state.current.noteId, serverData.note);
                } catch {
                    toast?.(t('笔记已被更新，请重新加载后再编辑'));
                }
            } else {
                setSaveState('error', t('保存失败'));
            }
            throw err;
        } finally {
            state.saving = false;
        }
    }

    async function createNote() {
        if (state.dirty) {
            try { await flushSave(); } catch {}
        }
        const groupPath = state.groupFilter && state.groupFilter !== '__all' && state.groupFilter !== '__trash'
            ? state.groupFilter
            : '';
        const data = await api('/api/notes', {
            method: 'POST',
            body: JSON.stringify({ title: t('未命名笔记'), content: '', groupPath }),
        });
        state.trash = false;
        if (state.groupFilter === '__trash') state.groupFilter = '__all';
        await loadList();
        await selectNote(data.note.noteId);
        $('#notesTitleInput')?.focus();
        $('#notesTitleInput')?.select?.();
        toast?.(t('已新建笔记'));
    }

    function selectedIdList() {
        return [...state.selectedIds];
    }

    function setSelectMode(on, { render = true } = {}) {
        state.selectMode = !!on;
        if (!state.selectMode) state.selectedIds = new Set();
        document.getElementById('notesShell')?.classList.toggle('notes-select-mode', state.selectMode);
        $('#notesSelectModeBtn')?.classList.toggle('is-active', state.selectMode);
        $('#notesSelectModeBtn')?.setAttribute('aria-pressed', state.selectMode ? 'true' : 'false');
        if (render) renderList();
        else updateSelectionBar();
    }

    function toggleNoteChecked(noteId, force) {
        if (!noteId) return;
        const next = force === true ? true : force === false ? false : !state.selectedIds.has(noteId);
        if (next) state.selectedIds.add(noteId);
        else state.selectedIds.delete(noteId);
        if (!state.selectMode && state.selectedIds.size) setSelectMode(true, { render: false });
        renderList();
    }

    function selectAllVisible() {
        if (!state.selectMode) setSelectMode(true, { render: false });
        state.selectedIds = new Set(state.notes.map((n) => n.noteId));
        renderList();
    }

    function clearSelection() {
        state.selectedIds = new Set();
        renderList();
    }

    function updateSelectionBar() {
        let bar = document.getElementById('notesSelectionBar');
        if (!bar) return;
        const count = state.selectedIds.size;
        const inTrash = state.trash || state.groupFilter === '__trash';
        bar.classList.toggle('force-hidden', !state.selectMode);
        bar.classList.toggle('is-empty', count === 0);
        const countEl = bar.querySelector('[data-sel-count]');
        if (countEl) countEl.textContent = String(count);
        bar.querySelectorAll('[data-sel-action]').forEach((btn) => {
            const action = btn.dataset.selAction;
            const needsSelection = action !== 'all' && action !== 'exit' && action !== 'none';
            btn.disabled = needsSelection && count === 0;
            if (action === 'trash') btn.classList.toggle('force-hidden', inTrash);
            if (action === 'restore') btn.classList.toggle('force-hidden', !inTrash);
            if (action === 'purge') btn.classList.toggle('force-hidden', !inTrash);
            if (action === 'purge_permanent') btn.classList.toggle('force-hidden', inTrash);
        });
        const allBtn = bar.querySelector('[data-sel-action="all"]');
        if (allBtn) {
            const allSelected = state.notes.length > 0 && state.selectedIds.size >= state.notes.length;
            allBtn.setAttribute('aria-pressed', allSelected ? 'true' : 'false');
            allBtn.title = allSelected ? t('取消全选') : t('全选当前列表');
        }
    }

    async function runBulk(action) {
        const ids = selectedIdList();
        if (!ids.length) return;
        const inTrash = state.trash || state.groupFilter === '__trash';
        let title = '';
        let message = '';
        let confirmLabel = t('确定');
        let apiAction = action;
        if (action === 'trash') {
            title = t('移到回收站');
            message = t('将 {count} 条笔记移到回收站？可稍后恢复。', { count: ids.length });
            confirmLabel = t('移到回收站');
        } else if (action === 'restore') {
            title = t('恢复笔记');
            message = t('恢复 {count} 条笔记？', { count: ids.length });
            confirmLabel = t('恢复');
        } else if (action === 'purge') {
            title = t('彻底删除');
            message = t('彻底删除回收站中的 {count} 条笔记？此操作不可撤销。', { count: ids.length });
            confirmLabel = t('彻底删除');
        } else if (action === 'purge_permanent') {
            title = t('直接删除');
            message = t('永久删除 {count} 条笔记？不会进入回收站，此操作不可撤销。', { count: ids.length });
            confirmLabel = t('永久删除');
            apiAction = 'purge_permanent';
        } else {
            return;
        }
        if (action === 'purge' && !inTrash) {
            toast?.(t('只能彻底删除回收站中的笔记'));
            return;
        }
        const ok = await nativeConfirm({ title, message, confirmLabel, danger: action !== 'restore' });
        if (!ok) return;
        try {
            const result = await api('/api/notes/bulk', {
                method: 'POST',
                body: JSON.stringify({ noteIds: ids, action: apiAction }),
            });
            if (state.selectedId && ids.includes(state.selectedId)) {
                state.current = null;
                state.selectedId = null;
                state.dirty = false;
                fillEditor(null);
            }
            state.selectedIds = new Set();
            await loadList();
            const n = result?.affected ?? ids.length;
            if (action === 'trash') toast?.(t('已移到回收站（{count}）', { count: n }));
            else if (action === 'restore') toast?.(t('已恢复（{count}）', { count: n }));
            else toast?.(t('已永久删除（{count}）', { count: n }));
        } catch (err) {
            toast?.(err.message || t('批量操作失败'));
        }
    }

    async function deleteCurrent() {
        if (!state.current) return;
        if (state.trash || state.groupFilter === '__trash') {
            const ok = await nativeConfirm({
                title: t('彻底删除'),
                message: t('彻底删除这条笔记？此操作不可撤销。'),
                confirmLabel: t('彻底删除'),
                danger: true,
            });
            if (!ok) return;
            await api(`/api/notes/${encodeURIComponent(state.current.noteId)}/purge`, { method: 'DELETE' });
            state.current = null;
            state.selectedId = null;
            state.dirty = false;
            fillEditor(null);
            await loadList();
            toast?.(t('已彻底删除'));
        } else {
            const ok = await nativeConfirm({
                title: t('删除笔记'),
                message: t('将笔记移到回收站？可稍后恢复。'),
                confirmLabel: t('移到回收站'),
                danger: true,
            });
            if (!ok) return;
            await api(`/api/notes/${encodeURIComponent(state.current.noteId)}`, { method: 'DELETE' });
            state.current = null;
            state.selectedId = null;
            state.dirty = false;
            fillEditor(null);
            await loadList();
            toast?.(t('已移到回收站'));
        }
    }

    async function purgeCurrent({ permanent = false } = {}) {
        if (!state.current) return;
        const inTrash = state.trash || state.groupFilter === '__trash';
        const ok = await nativeConfirm({
            title: permanent && !inTrash ? t('直接删除') : t('彻底删除'),
            message: permanent && !inTrash
                ? t('永久删除这条笔记？不会进入回收站，此操作不可撤销。')
                : t('彻底删除这条笔记？此操作不可撤销。'),
            confirmLabel: permanent && !inTrash ? t('永久删除') : t('彻底删除'),
            danger: true,
        });
        if (!ok) return;
        const q = permanent && !inTrash ? '?force=1' : '';
        await api(`/api/notes/${encodeURIComponent(state.current.noteId)}/purge${q}`, { method: 'DELETE' });
        state.current = null;
        state.selectedId = null;
        state.dirty = false;
        fillEditor(null);
        await loadList();
        toast?.(permanent && !inTrash ? t('已永久删除') : t('已彻底删除'));
    }

    async function emptyTrash() {
        const ok = await nativeConfirm({
            title: t('清空回收站'),
            message: t('清空回收站？所有已删除笔记将被永久移除。'),
            confirmLabel: t('清空'),
            danger: true,
        });
        if (!ok) return;
        const result = await api('/api/notes/trash/empty', { method: 'POST' });
        state.current = null;
        state.selectedId = null;
        fillEditor(null);
        await loadList();
        toast?.(result?.purged ? t('已清空回收站（{count} 条）', { count: result.purged }) : t('回收站已空'));
    }

    async function restoreCurrent() {
        if (!state.current) return;
        try {
            await api(`/api/notes/${encodeURIComponent(state.current.noteId)}/restore`, { method: 'POST' });
            toast?.(t('已恢复'));
            state.current = null;
            state.selectedId = null;
            fillEditor(null);
            await loadList();
        } catch (err) {
            toast?.(err.message || t('恢复失败'));
        }
    }

    function updateTrashButtons() {
        const inTrash = state.trash || state.groupFilter === '__trash';
        const hasCurrent = !!state.current;
        $('#notesDeleteBtn')?.classList.toggle('force-hidden', inTrash || !hasCurrent);
        // Permanent delete (skip trash) available on active notes.
        $('#notesPurgePermanentBtn')?.classList.toggle('force-hidden', inTrash || !hasCurrent);
        $('#notesPurgeBtn')?.classList.toggle('force-hidden', !inTrash || !hasCurrent);
        $('#notesRestoreBtn')?.classList.toggle('force-hidden', !inTrash || !hasCurrent);
        $('#notesEmptyTrashBtn')?.classList.toggle('force-hidden', !inTrash);
        $('#notesNewBtn')?.classList.toggle('force-hidden', inTrash);
        $('#notesEditorActions')?.classList.toggle('notes-in-trash', inTrash);
        // more-menu items
        document.querySelectorAll('#notesMoreMenu [data-more-action="delete"]').forEach((el) => {
            el.classList.toggle('force-hidden', inTrash);
        });
        document.querySelectorAll('#notesMoreMenu [data-more-action="purge_permanent"]').forEach((el) => {
            el.classList.toggle('force-hidden', inTrash);
        });
        document.querySelectorAll('#notesMoreMenu [data-more-action="restore"]').forEach((el) => {
            el.classList.toggle('force-hidden', !inTrash);
        });
        document.querySelectorAll('#notesMoreMenu [data-more-action="purge"]').forEach((el) => {
            el.classList.toggle('force-hidden', !inTrash);
        });
        updateSelectionBar();
    }

    function placeMenu(menu, x, y) {
        menu.style.left = '0px';
        menu.style.top = '0px';
        document.body.appendChild(menu);
        const rect = menu.getBoundingClientRect();
        const left = Math.min(Math.max(8, x), window.innerWidth - rect.width - 8);
        const top = Math.min(Math.max(8, y), window.innerHeight - rect.height - 8);
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
    }

    function closeMenus() {
        document.querySelectorAll('.notes-menu, .notes-context-menu, .notes-popover').forEach((el) => {
            el.classList.remove('show');
            if (el.id === 'notesContextMenu' || el.dataset.ephemeral === '1') {
                el.remove();
            } else {
                el.classList.add('force-hidden');
            }
        });
        $$('.notes-filter-trigger[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
        $('#notesMoreBtn')?.setAttribute('aria-expanded', 'false');
    }

    function togglePopover(trigger, menu) {
        if (!trigger || !menu) return;
        const open = menu.classList.contains('show') && !menu.classList.contains('force-hidden');
        closeMenus();
        if (open) return;
        menu.classList.remove('force-hidden');
        const rect = trigger.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.left = `${Math.min(rect.left, window.innerWidth - 200)}px`;
        menu.style.top = `${rect.bottom + 6}px`;
        requestAnimationFrame(() => menu.classList.add('show'));
        trigger.setAttribute('aria-expanded', 'true');
    }

    /* ── Share modal ── */
    async function openNoteShareModal() {
        if (!state.current) { toast?.(t('请先选择一条笔记')); return; }
        if (state.current.ownerUserId && state.current.ownerUserId !== window.__zephyrMyUserId) {
            toast?.(t('只有笔记所有者可以修改共享设置'));
            return;
        }
        let modal = document.getElementById('notesShareModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'notesShareModal';
            modal.className = 'notes-dialog-backdrop notes-modal-backdrop';
            modal.innerHTML = `
                <div class="notes-dialog notes-dialog-md" role="dialog" aria-modal="true" aria-label="${t('共享设置')}">
                    <div class="notes-dialog-head">
                        <h2 class="notes-dialog-title">${t('共享设置')}</h2>
                        <button type="button" class="notes-icon-btn" id="notesShareModalClose" aria-label="${t('关闭')}">${icon('close')}</button>
                    </div>
                    <p class="notes-dialog-message">${t('共享后其他用户可读此笔记，不可编辑。默认私有。')}</p>
                    <div class="notes-share-options">
                        <label class="notes-check"><input type="checkbox" id="notesShareUsers"><span>${t('共享给所有用户')}</span></label>
                        <label class="notes-check"><input type="checkbox" id="notesShareAdmins"><span>${t('共享给管理员')}</span></label>
                    </div>
                    <div class="notes-dialog-actions">
                        <button class="btn" type="button" id="notesShareCancel">${t('取消')}</button>
                        <button class="btn btn-primary" type="button" id="notesShareSave">${t('保存')}</button>
                    </div>
                </div>`;
            document.body.appendChild(modal);
        }
        modal.querySelector('#notesShareUsers').checked = !!state.current.shareWithUsers;
        modal.querySelector('#notesShareAdmins').checked = !!state.current.shareWithAdmins;
        modal.classList.add('show');
        const close = () => {
            modal.classList.remove('show');
        };
        modal.querySelector('#notesShareModalClose').onclick = close;
        modal.querySelector('#notesShareCancel').onclick = close;
        modal.onclick = (e) => { if (e.target === modal) close(); };
        modal.querySelector('#notesShareSave').onclick = async () => {
            const shareWithUsers = modal.querySelector('#notesShareUsers').checked;
            const shareWithAdmins = modal.querySelector('#notesShareAdmins').checked;
            try {
                const updated = await api(`/api/notes/${encodeURIComponent(state.current.noteId)}`, {
                    method: 'PUT',
                    body: JSON.stringify({
                        shareWithUsers,
                        shareWithAdmins,
                        expectedRevision: state.current.revision,
                    }),
                });
                state.current = updated.note;
                state.dirty = false;
                fillEditor(updated.note);
                close();
                toast?.(shareWithUsers ? t('已共享给所有用户') : shareWithAdmins ? t('已共享给管理员') : t('已设为私有'));
                await loadList();
            } catch (err) {
                toast?.(err.message || t('保存失败'));
            }
        };
    }

    async function openLinkConnectionModal() {
        if (!state.current) { toast?.(t('请先选择一条笔记')); return; }
        let modal = document.getElementById('notesLinkModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'notesLinkModal';
            modal.className = 'notes-dialog-backdrop notes-modal-backdrop';
            modal.innerHTML = `
                <div class="notes-dialog notes-dialog-lg" role="dialog" aria-modal="true" aria-label="${t('关联连接')}">
                    <div class="notes-dialog-head">
                        <h2 class="notes-dialog-title">${t('关联连接')}</h2>
                        <button type="button" class="notes-icon-btn" id="notesLinkModalClose" aria-label="${t('关闭')}">${icon('close')}</button>
                    </div>
                    <div class="notes-link-search-wrap">
                        <span class="notes-search-icon">${icon('search')}</span>
                        <input class="notes-dialog-input" id="notesLinkSearch" placeholder="${t('搜索连接名称或主机…')}" autocomplete="off">
                    </div>
                    <div id="notesLinkList" class="notes-link-list" role="listbox"></div>
                    <div class="notes-dialog-actions">
                        <button class="btn" type="button" id="notesLinkCancel">${t('取消')}</button>
                        <button class="btn btn-primary" type="button" id="notesLinkSave">${t('保存')}</button>
                    </div>
                </div>`;
            document.body.appendChild(modal);
        }
        modal.classList.add('show');
        const listEl = modal.querySelector('#notesLinkList');
        const searchEl = modal.querySelector('#notesLinkSearch');
        let allConns = [];
        let selected = new Set(state.current.linkedConnectionIds || []);
        try {
            const data = await api('/api/connections');
            allConns = data.connections || [];
        } catch {
            allConns = [];
        }
        function renderConns() {
            const q = String(searchEl.value || '').toLowerCase();
            const filtered = allConns.filter((c) => !q
                || String(c.name || '').toLowerCase().includes(q)
                || String(c.host || '').toLowerCase().includes(q));
            listEl.innerHTML = filtered.length
                ? filtered.map((c) => {
                    const checked = selected.has(c.id);
                    return `<label class="notes-check notes-link-row">
                        <input type="checkbox" data-conn-id="${escapeHtml(c.id)}" ${checked ? 'checked' : ''}>
                        <span class="notes-link-row-text">
                            <b>${escapeHtml(c.name)}</b>
                            <span class="muted">${escapeHtml(c.protocol)} · ${escapeHtml(c.host)}:${escapeHtml(String(c.port))}</span>
                        </span>
                    </label>`;
                }).join('')
                : `<p class="notes-empty-inline">${t('无匹配连接')}</p>`;
            listEl.querySelectorAll('[data-conn-id]').forEach((cb) => {
                cb.addEventListener('change', () => {
                    if (cb.checked) selected.add(cb.dataset.connId);
                    else selected.delete(cb.dataset.connId);
                });
            });
        }
        renderConns();
        searchEl.oninput = renderConns;
        const closeLinkModal = () => modal.classList.remove('show');
        modal.querySelector('#notesLinkModalClose').onclick = closeLinkModal;
        modal.querySelector('#notesLinkCancel').onclick = closeLinkModal;
        modal.onclick = (e) => { if (e.target === modal) closeLinkModal(); };
        modal.querySelector('#notesLinkSave').onclick = async () => {
            try {
                const updated = await api(`/api/notes/${encodeURIComponent(state.current.noteId)}`, {
                    method: 'PUT',
                    body: JSON.stringify({
                        linkedConnectionIds: Array.from(selected),
                        expectedRevision: state.current.revision,
                    }),
                });
                state.current = updated.note;
                state.dirty = false;
                fillEditor(updated.note);
                toast?.(t('关联连接已保存'));
                await loadList();
            } catch (err) {
                toast?.(err.message || t('保存失败'));
            }
            closeLinkModal();
        };
        searchEl.focus();
    }

    function showNoteContextMenu(noteId, x, y) {
        closeMenus();
        const note = state.notes.find((n) => n.noteId === noteId);
        if (!note) return;
        const menu = document.createElement('div');
        menu.id = 'notesContextMenu';
        menu.className = 'notes-menu notes-context-menu';
        menu.dataset.ephemeral = '1';
        const inTrash = state.trash || state.groupFilter === '__trash';
        menu.innerHTML = inTrash ? `
            <button type="button" class="notes-menu-item" data-ctx-action="restore" data-note-id="${escapeHtml(noteId)}">${icon('restore')}<span>${t('恢复')}</span></button>
            <button type="button" class="notes-menu-item danger" data-ctx-action="purge" data-note-id="${escapeHtml(noteId)}">${icon('purge')}<span>${t('彻底删除')}</span></button>
        ` : `
            <button type="button" class="notes-menu-item" data-ctx-action="rename" data-note-id="${escapeHtml(noteId)}"><span>${t('重命名')}</span></button>
            <button type="button" class="notes-menu-item" data-ctx-action="move" data-note-id="${escapeHtml(noteId)}">${icon('folder')}<span>${t('移动分组')}</span></button>
            <button type="button" class="notes-menu-item" data-ctx-action="copy" data-note-id="${escapeHtml(noteId)}"><span>${t('复制')}</span></button>
            <button type="button" class="notes-menu-item" data-ctx-action="export" data-note-id="${escapeHtml(noteId)}">${icon('export')}<span>${t('导出 Markdown')}</span></button>
            <button type="button" class="notes-menu-item" data-ctx-action="select" data-note-id="${escapeHtml(noteId)}">${icon('multi')}<span>${t('多选')}</span></button>
            <div class="notes-menu-sep"></div>
            <button type="button" class="notes-menu-item danger" data-ctx-action="delete" data-note-id="${escapeHtml(noteId)}">${icon('trash')}<span>${t('移到回收站')}</span></button>
            <button type="button" class="notes-menu-item danger" data-ctx-action="purge_permanent" data-note-id="${escapeHtml(noteId)}">${icon('purge')}<span>${t('直接删除')}</span></button>
        `;
        placeMenu(menu, x, y);
        requestAnimationFrame(() => menu.classList.add('show'));
        menu.querySelectorAll('[data-ctx-action]').forEach((btn) => {
            btn.addEventListener('click', () => {
                closeMenus();
                handleContextAction(btn.dataset.ctxAction, btn.dataset.noteId);
            });
        });
    }

    async function handleContextAction(action, noteId) {
        const note = state.notes.find((n) => n.noteId === noteId);
        if (!note && action !== 'purge' && action !== 'restore') return;
        if (action === 'rename') {
            const name = await nativePrompt({
                title: t('重命名'),
                value: note.title || '',
                placeholder: t('笔记标题'),
                maxLength: 200,
                confirmLabel: t('保存'),
            });
            if (name == null) return;
            try {
                const cur = await api(`/api/notes/${encodeURIComponent(noteId)}`);
                await api(`/api/notes/${encodeURIComponent(noteId)}`, {
                    method: 'PUT',
                    body: JSON.stringify({ title: name, expectedRevision: cur.note.revision }),
                });
                toast?.(t('已重命名'));
                if (state.current?.noteId === noteId) {
                    state.current.title = name;
                    if ($('#notesTitleInput')) $('#notesTitleInput').value = name;
                }
                await loadList();
            } catch (err) {
                toast?.(err.message);
            }
        } else if (action === 'move') {
            const group = await nativePrompt({
                title: t('移动分组'),
                message: t('留空则移到未分组'),
                value: note.groupPath || '',
                placeholder: 'ops/runbooks',
                confirmLabel: t('移动'),
            });
            if (group === null) return;
            try {
                const cur = await api(`/api/notes/${encodeURIComponent(noteId)}`);
                await api(`/api/notes/${encodeURIComponent(noteId)}`, {
                    method: 'PUT',
                    body: JSON.stringify({
                        groupPath: String(group || '').trim(),
                        expectedRevision: cur.note.revision,
                    }),
                });
                toast?.(t('已移动'));
                await loadList();
            } catch (err) {
                toast?.(err.message);
            }
        } else if (action === 'copy') {
            try {
                const full = await api(`/api/notes/${encodeURIComponent(noteId)}`);
                const created = await api('/api/notes', {
                    method: 'POST',
                    body: JSON.stringify({
                        title: t('{title} (副本)', { title: full.note.title }),
                        content: full.note.content,
                        tags: full.note.tags,
                        groupPath: full.note.groupPath,
                    }),
                });
                toast?.(t('已复制'));
                await loadList();
                await selectNote(created.note.noteId);
            } catch (err) {
                toast?.(err.message);
            }
        } else if (action === 'export') {
            window.open(`/api/notes/${encodeURIComponent(noteId)}/export.md`, '_blank');
        } else if (action === 'delete') {
            const ok = await nativeConfirm({
                title: t('删除笔记'),
                message: t('将笔记移到回收站？可稍后恢复。'),
                confirmLabel: t('移到回收站'),
                danger: true,
            });
            if (!ok) return;
            await api(`/api/notes/${encodeURIComponent(noteId)}`, { method: 'DELETE' });
            if (state.current?.noteId === noteId) {
                state.current = null;
                state.selectedId = null;
                fillEditor(null);
            }
            await loadList();
            toast?.(t('已移到回收站'));
        } else if (action === 'purge' || action === 'purge_permanent') {
            const permanent = action === 'purge_permanent';
            const ok = await nativeConfirm({
                title: permanent ? t('直接删除') : t('彻底删除'),
                message: permanent
                    ? t('永久删除这条笔记？不会进入回收站，此操作不可撤销。')
                    : t('彻底删除这条笔记？此操作不可撤销。'),
                confirmLabel: permanent ? t('永久删除') : t('彻底删除'),
                danger: true,
            });
            if (!ok) return;
            const q = permanent ? '?force=1' : '';
            await api(`/api/notes/${encodeURIComponent(noteId)}/purge${q}`, { method: 'DELETE' });
            if (state.current?.noteId === noteId) {
                state.current = null;
                state.selectedId = null;
                fillEditor(null);
            }
            state.selectedIds.delete(noteId);
            await loadList();
            toast?.(permanent ? t('已永久删除') : t('已彻底删除'));
        } else if (action === 'select') {
            setSelectMode(true, { render: false });
            toggleNoteChecked(noteId, true);
        } else if (action === 'restore') {
            try {
                await api(`/api/notes/${encodeURIComponent(noteId)}/restore`, { method: 'POST' });
                if (state.current?.noteId === noteId) {
                    state.current = null;
                    state.selectedId = null;
                    fillEditor(null);
                }
                state.selectedIds.delete(noteId);
                await loadList();
                toast?.(t('已恢复'));
            } catch (err) {
                toast?.(err.message);
            }
        }
    }

    async function showConflictWindow(noteId, serverNote) {
        let modal = document.getElementById('notesConflictModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'notesConflictModal';
            modal.className = 'notes-dialog-backdrop notes-modal-backdrop';
            modal.innerHTML = `
                <div class="notes-dialog notes-dialog-xl" role="dialog" aria-modal="true" aria-label="${t('笔记冲突')}">
                    <div class="notes-dialog-head">
                        <h2 class="notes-dialog-title">${t('版本冲突')}</h2>
                        <button type="button" class="notes-icon-btn" id="notesConflictClose" aria-label="${t('关闭')}">${icon('close')}</button>
                    </div>
                    <p class="notes-dialog-message">${t('该笔记在其他地方被修改。选择保留你的编辑，或载入服务器版本。')}</p>
                    <div class="notes-conflict-grid">
                        <div>
                            <h3>${t('我的版本')}</h3>
                            <pre id="conflictMyVersion" class="notes-conflict-pre"></pre>
                        </div>
                        <div>
                            <h3>${t('服务器版本')}</h3>
                            <pre id="conflictServerVersion" class="notes-conflict-pre"></pre>
                        </div>
                    </div>
                    <div class="notes-dialog-actions">
                        <button class="btn" type="button" id="conflictLoadServer">${t('载入服务器版本')}</button>
                        <button class="btn btn-primary" type="button" id="conflictKeepMine">${t('保留我的版本')}</button>
                    </div>
                </div>`;
            document.body.appendChild(modal);
        }
        modal.querySelector('#conflictMyVersion').textContent = state.current?.content || '';
        modal.querySelector('#conflictServerVersion').textContent = serverNote?.content || '';
        modal.classList.add('show');
        const close = () => modal.classList.remove('show');
        modal.querySelector('#notesConflictClose').onclick = close;
        modal.onclick = (e) => { if (e.target === modal) close(); };
        modal.querySelector('#conflictLoadServer').onclick = async () => {
            state.current = serverNote;
            state.dirty = false;
            fillEditor(serverNote);
            close();
            toast?.(t('已载入服务器版本'));
        };
        modal.querySelector('#conflictKeepMine').onclick = async () => {
            try {
                const updated = await api(`/api/notes/${encodeURIComponent(noteId)}`, {
                    method: 'PUT',
                    body: JSON.stringify({
                        title: state.current.title,
                        content: state.current.content,
                        tags: state.current.tags,
                        groupPath: state.current.groupPath,
                        expectedRevision: serverNote.revision,
                    }),
                });
                state.current = updated.note;
                state.dirty = false;
                fillEditor(updated.note);
                close();
                toast?.(t('已保留我的版本'));
            } catch (err) {
                toast?.(err.message || t('保存失败'));
            }
        };
    }

    function interceptPreviewLinks(previewEl) {
        if (!previewEl) return;
        previewEl.querySelectorAll('a[href]').forEach((a) => {
            const href = String(a.getAttribute('href') || '');
            if (/^(ssh:|telnet:|jms:)/i.test(href)) {
                a.addEventListener('click', (e) => {
                    e.preventDefault();
                    if (typeof openTransientFromUri === 'function') {
                        openTransientFromUri(href);
                    } else if (typeof window.openTransientFromUri === 'function') {
                        window.openTransientFromUri(href);
                    } else {
                        toast?.(t('请在应用主界面打开此链接'));
                    }
                });
            }
        });
    }

    function wrapSelection(before, after = before) {
        const ta = $('#notesContentInput');
        if (!ta) return;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const value = ta.value;
        const selected = value.slice(start, end) || 'text';
        ta.value = value.slice(0, start) + before + selected + after + value.slice(end);
        ta.focus();
        ta.selectionStart = start + before.length;
        ta.selectionEnd = start + before.length + selected.length;
        markDirty();
        if (state.mode !== 'edit') setMode(state.mode);
    }

    async function addTagInteractive() {
        const tag = await nativePrompt({
            title: t('添加标签'),
            placeholder: t('例如 runbook'),
            maxLength: 40,
            confirmLabel: t('添加'),
        });
        if (tag == null) return;
        const t = String(tag).trim();
        if (!t) return;
        const current = String($('#notesTagsInput')?.value || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        if (!current.includes(t)) current.push(t);
        if ($('#notesTagsInput')) $('#notesTagsInput').value = current.join(', ');
        if (state.current) {
            state.current.tags = current;
            renderMetaChips(state.current);
        }
        markDirty();
    }

    async function editGroupInteractive() {
        const group = await nativePrompt({
            title: t('设置分组'),
            message: t('使用 / 表示层级，例如 ops/runbooks。留空表示未分组。'),
            value: $('#notesGroupInput')?.value || '',
            placeholder: 'ops/runbooks',
            confirmLabel: t('保存'),
        });
        if (group === null) return;
        const g = String(group || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        if ($('#notesGroupInput')) $('#notesGroupInput').value = g;
        if (state.current) {
            state.current.groupPath = g;
            renderMetaChips(state.current);
        }
        markDirty();
    }

    function bind() {
        $('#notesNewBtn')?.addEventListener('click', () => createNote().catch((e) => toast?.(e.message)));
        $('#notesDeleteBtn')?.addEventListener('click', () => deleteCurrent().catch((e) => toast?.(e.message)));
        $('#notesPurgeBtn')?.addEventListener('click', () => purgeCurrent({ permanent: false }).catch((e) => toast?.(e.message)));
        $('#notesPurgePermanentBtn')?.addEventListener('click', () => purgeCurrent({ permanent: true }).catch((e) => toast?.(e.message)));
        $('#notesEmptyTrashBtn')?.addEventListener('click', () => emptyTrash().catch((e) => toast?.(e.message)));
        $('#notesRestoreBtn')?.addEventListener('click', () => restoreCurrent().catch((e) => toast?.(e.message)));
        $('#notesSelectModeBtn')?.addEventListener('click', () => {
            setSelectMode(!state.selectMode);
        });
        $('#notesSelectionBar')?.addEventListener('click', (e) => {
            const btn = e.target.closest?.('[data-sel-action]');
            if (!btn || btn.disabled) return;
            const action = btn.dataset.selAction;
            if (action === 'exit') setSelectMode(false);
            else if (action === 'all') {
                const allSelected = state.notes.length > 0 && state.selectedIds.size >= state.notes.length;
                if (allSelected) clearSelection();
                else selectAllVisible();
            } else if (action === 'none') clearSelection();
            else runBulk(action).catch((err) => toast?.(err.message));
        });
        $('#notesBackBtn')?.addEventListener('click', () => {
            setMobileDetail(false);
        });

        $('#notesSearchInput')?.addEventListener('input', (e) => {
            state.query = e.target.value || '';
            window.clearTimeout(state.searchTimer);
            state.searchTimer = window.setTimeout(() => {
                loadList().catch((err) => toast?.(err.message));
            }, NOTES_SEARCH_MS);
        });

        // Custom sort / tag menus
        renderSortMenu();
        $('#notesSortTrigger')?.addEventListener('click', (e) => {
            e.stopPropagation();
            togglePopover($('#notesSortTrigger'), $('#notesSortMenu'));
        });
        $('#notesTagTrigger')?.addEventListener('click', (e) => {
            e.stopPropagation();
            renderTagMenu();
            togglePopover($('#notesTagTrigger'), $('#notesTagMenu'));
        });
        $('#notesSortMenu')?.addEventListener('click', (e) => {
            const btn = e.target.closest?.('[data-sort-value]');
            if (!btn) return;
            state.sortBy = btn.dataset.sortValue || 'updated';
            closeMenus();
            renderSortMenu();
            updateListHeading();
            renderList();
        });
        $('#notesTagMenu')?.addEventListener('click', (e) => {
            const btn = e.target.closest?.('[data-tag-value]');
            if (!btn) return;
            state.tagFilter = btn.dataset.tagValue || 'all';
            closeMenus();
            updateListHeading();
            loadList().catch((err) => toast?.(err.message));
        });

        // Keep hidden native selects in sync for any external contract (if present)
        $('#notesSortSelect')?.addEventListener('change', (e) => {
            state.sortBy = e.target.value || 'updated';
            renderList();
        });
        $('#notesTagFilter')?.addEventListener('change', (e) => {
            state.tagFilter = e.target.value || 'all';
            loadList().catch((err) => toast?.(err.message));
        });

        $('#notesGroups')?.addEventListener('click', (e) => {
            const btn = e.target.closest?.('[data-group]');
            if (!btn) return;
            state.groupFilter = btn.dataset.group;
            state.trash = state.groupFilter === '__trash';
            if (state.selectMode) setSelectMode(false, { render: false });
            updateTrashButtons();
            setMobileDetail(false);
            loadList().catch((err) => toast?.(err.message));
            renderGroups();
        });

        $('#notesList')?.addEventListener('click', (e) => {
            const checkBtn = e.target.closest?.('[data-note-check]');
            if (checkBtn) {
                e.preventDefault();
                e.stopPropagation();
                if (!state.selectMode) setSelectMode(true, { render: false });
                toggleNoteChecked(checkBtn.dataset.noteCheck);
                return;
            }
            const item = e.target.closest?.('[data-note-id]');
            if (!item) return;
            const noteId = item.dataset.noteId;
            if (state.selectMode) {
                // In select mode, body click toggles checkbox (iOS Files style).
                toggleNoteChecked(noteId);
                return;
            }
            selectNote(noteId).catch((err) => toast?.(err.message));
        });
        $('#notesList')?.addEventListener('contextmenu', (e) => {
            const item = e.target.closest('[data-note-id]');
            if (!item) return;
            e.preventDefault();
            showNoteContextMenu(item.dataset.noteId, e.clientX, e.clientY);
        });

        $$('.notes-mode-btn').forEach((btn) => {
            btn.addEventListener('click', () => setMode(btn.dataset.notesMode));
        });

        ['notesTitleInput', 'notesContentInput'].forEach((id) => {
            $(`#${id}`)?.addEventListener('input', () => {
                markDirty();
                if (id === 'notesContentInput') schedulePreviewRefresh();
            });
        });

        // Meta chips (event delegation)
        $('#notesMetaRow')?.addEventListener('click', async (e) => {
            const removeTag = e.target.closest?.('[data-tag-chip]');
            if (removeTag) {
                const tag = removeTag.dataset.tagChip;
                const current = String($('#notesTagsInput')?.value || '')
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean)
                    .filter((t) => t !== tag);
                if ($('#notesTagsInput')) $('#notesTagsInput').value = current.join(', ');
                if (state.current) {
                    state.current.tags = current;
                    renderMetaChips(state.current);
                }
                markDirty();
                return;
            }
            if (e.target.closest?.('#notesAddTagBtn')) {
                await addTagInteractive();
                return;
            }
            if (e.target.closest?.('#notesEditGroupBtn')) {
                await editGroupInteractive();
            }
        });

        $('#notesToolbar')?.addEventListener('click', (e) => {
            const btn = e.target.closest?.('[data-md]');
            if (!btn) return;
            const kind = btn.dataset.md;
            if (kind === 'h2') wrapSelection('\n## ', '\n');
            else if (kind === 'bold') wrapSelection('**');
            else if (kind === 'italic') wrapSelection('*');
            else if (kind === 'strike') wrapSelection('~~');
            else if (kind === 'code') wrapSelection('`');
            else if (kind === 'codeblock') wrapSelection('\n```\n', '\n```\n');
            else if (kind === 'link') wrapSelection('[', '](https://)');
            else if (kind === 'quote') wrapSelection('\n> ', '\n');
            else if (kind === 'ul') wrapSelection('\n- ', '\n');
            else if (kind === 'ol') wrapSelection('\n1. ', '\n');
            else if (kind === 'task') wrapSelection('\n- [ ] ', '\n');
        });

        $('#notesImportBtn')?.addEventListener('click', () => $('#notesImportFile')?.click());
        $('#notesImportFile')?.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
                const content = await file.text();
                const data = await api('/api/notes/import-markdown', {
                    method: 'POST',
                    body: JSON.stringify({ filename: file.name, content }),
                });
                await loadList();
                await selectNote(data.note.noteId);
                toast?.(t('已导入'));
            } catch (err) {
                toast?.(err.message || t('导入失败'));
            } finally {
                e.target.value = '';
            }
        });

        $('#notesExportBtn')?.addEventListener('click', () => {
            if (!state.current) return toast?.(t('请先选择笔记'));
            window.open(`/api/notes/${encodeURIComponent(state.current.noteId)}/export.md`, '_blank');
        });

        $('#notesNewGroupBtn')?.addEventListener('click', async () => {
            const name = await nativePrompt({
                title: t('新建分组'),
                message: t('使用 / 表示层级，例如 ops/runbooks'),
                placeholder: 'ops/runbooks',
                confirmLabel: t('创建并写笔记'),
            });
            if (name == null) return;
            const path = String(name).trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
            if (!path) return;
            state.groupFilter = path;
            state.trash = false;
            createNote().catch((err) => toast?.(err.message));
        });

        $('#notesLinkConnBtn')?.addEventListener('click', () => {
            closeMenus();
            openLinkConnectionModal().catch((err) => toast?.(err.message));
        });
        $('#notesShareBtn')?.addEventListener('click', () => {
            closeMenus();
            openNoteShareModal().catch((err) => toast?.(err.message));
        });

        $('#notesMoreBtn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            togglePopover($('#notesMoreBtn'), $('#notesMoreMenu'));
        });
        $('#notesMoreMenu')?.addEventListener('click', (e) => {
            const btn = e.target.closest?.('[data-more-action]');
            if (!btn) return;
            const action = btn.dataset.moreAction;
            closeMenus();
            if (action === 'share') openNoteShareModal().catch((err) => toast?.(err.message));
            else if (action === 'link') openLinkConnectionModal().catch((err) => toast?.(err.message));
            else if (action === 'export') {
                if (!state.current) return toast?.(t('请先选择笔记'));
                window.open(`/api/notes/${encodeURIComponent(state.current.noteId)}/export.md`, '_blank');
            } else if (action === 'delete') deleteCurrent().catch((err) => toast?.(err.message));
            else if (action === 'purge_permanent') purgeCurrent({ permanent: true }).catch((err) => toast?.(err.message));
            else if (action === 'purge') purgeCurrent({ permanent: false }).catch((err) => toast?.(err.message));
            else if (action === 'restore') restoreCurrent().catch((err) => toast?.(err.message));
            else if (action === 'select') setSelectMode(true);
            else if (action === 'import') $('#notesImportFile')?.click();
        });

        document.addEventListener('click', (e) => {
            if (e.target.closest?.('.notes-menu') || e.target.closest?.('.notes-filter-trigger') || e.target.closest?.('#notesMoreBtn')) {
                return;
            }
            closeMenus();
        });

        window.addEventListener('beforeunload', (e) => {
            if (state.dirty) {
                e.preventDefault();
                e.returnValue = '';
            }
        });
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden' && state.dirty) {
                flushSave().catch(() => {});
            }
        });

        // Keyboard shortcuts (skip when typing in native dialogs / other inputs outside notes)
        document.addEventListener('keydown', (e) => {
            const view = document.getElementById('view-notes');
            if (!view?.classList.contains('active')) return;
            if (e.target?.closest?.('.notes-dialog, .notes-dialog-backdrop')) return;
            const meta = e.metaKey || e.ctrlKey;
            const key = e.key.toLowerCase();
            if (meta && key === 'n') {
                e.preventDefault();
                if (!(state.trash || state.groupFilter === '__trash')) {
                    createNote().catch((err) => toast?.(err.message));
                }
            } else if (meta && key === 's') {
                e.preventDefault();
                flushSave().catch((err) => toast?.(err.message));
            } else if (meta && key === 'f') {
                e.preventDefault();
                $('#notesSearchInput')?.focus();
                $('#notesSearchInput')?.select?.();
            } else if (meta && key === 'e') {
                e.preventDefault();
                const order = ['edit', 'split', 'preview'];
                const idx = order.indexOf(state.mode);
                setMode(order[(idx + 1) % order.length]);
            } else if (e.key === 'Escape' && state.mobileDetail && window.matchMedia('(max-width: 980px)').matches) {
                if (document.activeElement && document.activeElement !== document.body) {
                    // allow default blur first; second Esc handled next time
                    if (document.activeElement.id === 'notesContentInput' || document.activeElement.id === 'notesTitleInput') {
                        document.activeElement.blur();
                        return;
                    }
                }
                setMobileDetail(false);
            }
        });
    }

    async function activate() {
        await loadList();
        setMode(state.mode);
        updateTrashButtons();
        if (!state.selectedId) setMobileDetail(false);
    }

    async function filterByConnection(connectionId) {
        state.connectionFilter = connectionId || '';
        await loadList();
    }

    bind();
    setMode('edit');
    setMobileDetail(false);

    return {
        activate,
        flushSave,
        state,
        selectNote,
        createNote,
        loadList,
        filterByConnection,
    };
}
