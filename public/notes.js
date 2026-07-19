/**
 * notes.js — Notes workspace UI (FREEZE plan §6.4).
 * Uses existing Zephyr CSS variables / components. Markdown preview reuses
 * the page's escape-first renderer when available.
 */

const NOTES_DEBOUNCE_MS = 800;

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function safeMarkdown(src) {
    // Prefer the app's existing renderer if present.
    if (typeof window.renderMarkdown === 'function') {
        try { return window.renderMarkdown(String(src || '')); } catch {}
    }
    // Minimal escape-first fallback: no raw HTML, links allowlist http(s)/ssh/telnet/jms/mailto.
    let text = escapeHtml(src || '');
    text = text.replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${code}</code></pre>`);
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
    text = text.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    text = text.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    text = text.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    text = text.replace(/~~([^~]+)~~/g, '<s>$1</s>');
    text = text.replace(/^\s*[-*] (.+)$/gm, '<li>$1</li>');
    text = text.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
        const url = String(href || '').trim();
        if (!/^(https?:|ssh:|telnet:|jms:|mailto:)/i.test(url)) return label;
        return `<a href="${escapeHtml(url)}" rel="noopener noreferrer">${label}</a>`;
    });
    text = text.replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>');
    return `<p>${text}</p>`;
}

function formatRelativeTime(ts) {
    const delta = Date.now() - Number(ts || 0);
    if (!Number.isFinite(delta) || delta < 0) return '';
    if (delta < 60_000) return '刚刚';
    if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
    if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
    if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`;
    try { return new Date(ts).toLocaleDateString(); } catch { return ''; }
}

export function createNotesController({ api, toast, openTransientFromUri, $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)] }) {
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
    };

    function setSaveState(kind, text) {
        const el = $('#notesSaveState');
        if (!el) return;
        el.dataset.state = kind;
        el.textContent = text;
    }

    function setMode(mode) {
        state.mode = mode;
        $$('.notes-mode-btn').forEach((btn) => {
            const active = btn.dataset.notesMode === mode;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        const body = $('#notesBody');
        if (body) body.dataset.mode = mode;
        const preview = $('#notesPreview');
        const input = $('#notesContentInput');
        if (mode === 'preview' || mode === 'split') {
            if (preview) preview.innerHTML = safeMarkdown(input?.value || '');
        }
        // Wire note links in preview to transient UI.
        preview?.querySelectorAll?.('a[href^="ssh:"],a[href^="telnet:"],a[href^="jms:"]')?.forEach((a) => {
            a.addEventListener('click', (e) => {
                e.preventDefault();
                openTransientFromUri?.(a.getAttribute('href'));
            });
        });
    }

    function renderGroups() {
        const tree = $('#notesGroupTree');
        if (!tree) return;
        const counts = { all: state.notes.length, ungrouped: 0 };
        for (const n of state.notes) {
            if (!n.groupPath) counts.ungrouped += 1;
        }
        if ($('#notesCountAll')) $('#notesCountAll').textContent = String(counts.all);
        if ($('#notesCountUngrouped')) $('#notesCountUngrouped').textContent = String(counts.ungrouped);
        tree.innerHTML = state.groups
            .filter((g) => g.groupPath)
            .map((g) => `<button type="button" class="notes-group-item${state.groupFilter === g.groupPath ? ' active' : ''}" data-group="${escapeHtml(g.groupPath)}">${escapeHtml(g.groupPath)} <span class="notes-group-count">${g.count}</span></button>`)
            .join('');
        $$('.notes-group-item').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset.group === state.groupFilter);
        });
    }

    function renderList() {
        const list = $('#notesList');
        const empty = $('#notesListEmpty');
        if (!list) return;
        if (!state.notes.length) {
            list.innerHTML = '';
            empty?.classList.remove('force-hidden');
            return;
        }
        empty?.classList.add('force-hidden');
        list.innerHTML = state.notes.map((n) => {
            const tags = (n.tags || []).slice(0, 4).map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`).join('');
            return `<button type="button" class="notes-list-item${n.noteId === state.selectedId ? ' active' : ''}" data-note-id="${escapeHtml(n.noteId)}" role="option" aria-selected="${n.noteId === state.selectedId ? 'true' : 'false'}">
                <div class="notes-list-title">${escapeHtml(n.title || '未命名笔记')}</div>
                <div class="notes-list-preview">${escapeHtml(n.preview || '')}</div>
                <div class="notes-list-meta"><span>${escapeHtml(formatRelativeTime(n.updatedAt))}</span>${tags}</div>
            </button>`;
        }).join('');
    }

    function showEditor(show) {
        $('#notesEditorEmpty')?.classList.toggle('force-hidden', show);
        $('#notesEditor')?.classList.toggle('force-hidden', !show);
    }

    function fillEditor(note) {
        showEditor(!!note);
        if (!note) return;
        $('#notesTitleInput').value = note.title || '';
        $('#notesContentInput').value = note.content || '';
        $('#notesTagsInput').value = (note.tags || []).join(', ');
        $('#notesGroupInput').value = note.groupPath || '';
        setSaveState('saved', '已保存');
        state.dirty = false;
        if (state.mode !== 'edit') setMode(state.mode);
    }

    async function loadList() {
        const gen = ++state.generation;
        const params = new URLSearchParams();
        if (state.query) params.set('q', state.query);
        if (state.groupFilter !== '__all' && state.groupFilter !== '__trash') {
            // empty string means ungrouped; must still be sent
            params.set('group', state.groupFilter == null ? '' : String(state.groupFilter));
        }
        if (state.trash || state.groupFilter === '__trash') params.set('trash', '1');
        if (state.tagFilter && state.tagFilter !== 'all') params.set('tag', state.tagFilter);
        const data = await api(`/api/notes?${params.toString()}`);
        if (gen !== state.generation) return;
        state.notes = data.notes || [];
        renderList();
        try {
            const groups = await api('/api/notes/groups');
            if (gen !== state.generation) return;
            state.groups = groups.groups || [];
            renderGroups();
        } catch {}
        // tag filter options
        const tagSelect = $('#notesTagFilter');
        if (tagSelect) {
            const tags = [...new Set(state.notes.flatMap((n) => n.tags || []))].sort();
            const current = state.tagFilter;
            tagSelect.innerHTML = `<option value="all">全部标签</option>${tags.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')}`;
            tagSelect.value = tags.includes(current) ? current : 'all';
        }
        state.loaded = true;
    }

    async function selectNote(noteId) {
        if (state.dirty && state.current) {
            try { await flushSave(); } catch (err) { toast?.(err.message || '保存失败'); return; }
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
    }

    function markDirty() {
        if (!state.current) return;
        state.dirty = true;
        setSaveState('dirty', '未保存');
        window.clearTimeout(state.saveTimer);
        state.saveTimer = window.setTimeout(() => { flushSave().catch((err) => toast?.(err.message || '自动保存失败')); }, NOTES_DEBOUNCE_MS);
    }

    async function flushSave() {
        if (!state.current || !state.dirty || state.saving) return state.current;
        state.saving = true;
        setSaveState('saving', '保存中…');
        try {
            const payload = {
                title: $('#notesTitleInput')?.value || '',
                content: $('#notesContentInput')?.value || '',
                groupPath: $('#notesGroupInput')?.value || '',
                tags: String($('#notesTagsInput')?.value || '').split(',').map((s) => s.trim()).filter(Boolean),
                expectedRevision: state.current.revision,
            };
            const data = await api(`/api/notes/${encodeURIComponent(state.current.noteId)}`, {
                method: 'PUT',
                body: JSON.stringify(payload),
            });
            state.current = data.note;
            state.dirty = false;
            setSaveState('saved', '已保存');
            // refresh list preview without full reload when possible
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
                };
                renderList();
            } else {
                await loadList();
            }
            return data.note;
        } catch (err) {
            if (String(err?.code || err?.message || '').includes('revision') || err?.status === 409) {
                setSaveState('error', '版本冲突');
                toast?.('笔记已被更新，请重新加载后再编辑');
            } else {
                setSaveState('error', '保存失败');
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
        const groupPath = state.groupFilter && state.groupFilter !== '__all' && state.groupFilter !== '__trash' ? state.groupFilter : '';
        const data = await api('/api/notes', {
            method: 'POST',
            body: JSON.stringify({ title: '未命名笔记', content: '', groupPath }),
        });
        state.trash = false;
        state.groupFilter = '__all';
        await loadList();
        await selectNote(data.note.noteId);
        $('#notesTitleInput')?.focus();
        toast?.('已新建笔记');
    }

    async function deleteCurrent() {
        if (!state.current) return;
        if (!confirm('删除这条笔记？可在回收站恢复。')) return;
        await api(`/api/notes/${encodeURIComponent(state.current.noteId)}`, { method: 'DELETE' });
        state.current = null;
        state.selectedId = null;
        state.dirty = false;
        fillEditor(null);
        await loadList();
        toast?.('已移到回收站');
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

    function bind() {
        $('#notesNewBtn')?.addEventListener('click', () => createNote().catch((e) => toast?.(e.message)));
        $('#notesDeleteBtn')?.addEventListener('click', () => deleteCurrent().catch((e) => toast?.(e.message)));
        $('#notesSearchInput')?.addEventListener('input', (e) => {
            state.query = e.target.value || '';
            window.clearTimeout(state.searchTimer);
            state.searchTimer = window.setTimeout(() => loadList().catch((err) => toast?.(err.message)), 220);
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
            loadList().catch((err) => toast?.(err.message));
            renderGroups();
        });
        $('#notesList')?.addEventListener('click', (e) => {
            const item = e.target.closest?.('[data-note-id]');
            if (!item) return;
            selectNote(item.dataset.noteId).catch((err) => toast?.(err.message));
        });
        $$('.notes-mode-btn').forEach((btn) => btn.addEventListener('click', () => setMode(btn.dataset.notesMode)));
        ['notesTitleInput', 'notesContentInput', 'notesTagsInput', 'notesGroupInput'].forEach((id) => {
            $(`#${id}`)?.addEventListener('input', markDirty);
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
                toast?.('已导入');
            } catch (err) {
                toast?.(err.message || '导入失败');
            } finally {
                e.target.value = '';
            }
        });
        $('#notesExportBtn')?.addEventListener('click', () => {
            if (!state.current) return toast?.('请先选择笔记');
            window.open(`/api/notes/${encodeURIComponent(state.current.noteId)}/export.md`, '_blank');
        });
        $('#notesNewGroupBtn')?.addEventListener('click', () => {
            const name = prompt('新分组路径（例如 ops/runbooks）');
            if (!name) return;
            state.groupFilter = name.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
            createNote().catch((err) => toast?.(err.message));
        });
        $('#notesLinkConnBtn')?.addEventListener('click', () => {
            toast?.('在正文中写入 ssh:// 链接，或在编辑后通过 API/AI 关联连接 ID');
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
    }

    async function activate() {
        if (!state.loaded) await loadList();
        else await loadList();
        setMode(state.mode);
    }

    bind();
    setMode('edit');

    return {
        activate,
        flushSave,
        state,
        selectNote,
        createNote,
        loadList,
    };
}
