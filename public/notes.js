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
        connectionFilter: '', // terminal side-panel hand-off (§9)
        sortBy: 'updated', // updated | created | title (§6.4.3)
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
            btn.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                const action = confirm(`分组：${btn.dataset.group}\n确定 = 重命名，取消 = 删除（笔记移到未分组）`);
                if (action) {
                    const newName = prompt('新分组路径：', btn.dataset.group);
                    if (newName && newName !== btn.dataset.group) {
                        api('/api/notes/groups/rename', { method: 'POST', body: JSON.stringify({ oldPath: btn.dataset.group, newPath: newName }) })
                            .then(() => { toast?.('已重命名分组'); loadList(); })
                            .catch((err) => toast?.(err.message));
                    }
                } else {
                    if (confirm(`确定删除分组 "${btn.dataset.group}"？该分组下的笔记将移到未分组。`)) {
                        api('/api/notes/groups/delete', { method: 'POST', body: JSON.stringify({ groupPath: btn.dataset.group }) })
                            .then(() => { toast?.('已删除分组'); loadList(); })
                            .catch((err) => toast?.(err.message));
                    }
                }
            });
        });
    }

    function renderList() {
        const list = $('#notesList');
        const empty = $('#notesListEmpty');
        if (!list) return;
        // Sort (§6.4.3): updated / created / title
        const sorted = [...state.notes];
        const sortBy = state.sortBy || 'updated';
        sorted.sort((a, b) => {
            if (sortBy === 'title') return String(a.title || '').localeCompare(String(b.title || ''));
            if (sortBy === 'created') return Number(b.createdAt || 0) - Number(a.createdAt || 0);
            return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
        });
        if (!sorted.length) {
            list.innerHTML = '';
            empty?.classList.remove('force-hidden');
            return;
        }
        empty?.classList.add('force-hidden');
        list.innerHTML = sorted.map((n) => {
            const tags = (n.tags || []).slice(0, 4).map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`).join('');
            const connLinks = (n.linkedConnectionIds || n.linkedConnections || []).length
                ? `<span class="tag-chip" style="background:color-mix(in srgb, var(--accent) 12%, transparent)">🔗 ${(n.linkedConnectionIds || n.linkedConnections || []).length}</span>`
                : '';
            const dirtyBadge = n.noteId === state.selectedId && state.dirty ? '<span class="tag-chip" style="background:var(--warning);color:#fff">未保存</span>' : '';
            return `<button type="button" class="notes-list-item${n.noteId === state.selectedId ? ' active' : ''}" data-note-id="${escapeHtml(n.noteId)}" role="option" aria-selected="${n.noteId === state.selectedId ? 'true' : 'false'}">
                <div class="notes-list-title">${escapeHtml(n.title || '未命名笔记')}</div>
                <div class="notes-list-preview">${escapeHtml(n.preview || n.summary || '')}</div>
                <div class="notes-list-meta"><span>${escapeHtml(formatRelativeTime(n.updatedAt))}</span>${tags}${connLinks}${dirtyBadge}</div>
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
        updateTrashButtons();
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
                // Fetch server version and show conflict resolution window (§6.4.4)
                try {
                    const serverData = await api(`/api/notes/${encodeURIComponent(state.current.noteId)}`);
                    await showConflictWindow(state.current.noteId, serverData.note);
                } catch {
                    toast?.('笔记已被更新，请重新加载后再编辑');
                }
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
        if (state.trash) {
            // In trash view: permanent delete (purge)
            if (!confirm('彻底删除这条笔记？此操作不可撤销，无法恢复。')) return;
            await api(`/api/notes/${encodeURIComponent(state.current.noteId)}/purge`, { method: 'DELETE' });
            state.current = null;
            state.selectedId = null;
            state.dirty = false;
            fillEditor(null);
            await loadList();
            toast?.('已彻底删除');
        } else {
            // Normal view: soft delete (move to trash)
            if (!confirm('删除这条笔记？可在回收站恢复。')) return;
            await api(`/api/notes/${encodeURIComponent(state.current.noteId)}`, { method: 'DELETE' });
            state.current = null;
            state.selectedId = null;
            state.dirty = false;
            fillEditor(null);
            await loadList();
            toast?.('已移到回收站');
        }
    }

    async function purgeCurrent() {
        if (!state.current) return;
        if (!confirm('彻底删除这条笔记？此操作不可撤销，无法恢复。')) return;
        await api(`/api/notes/${encodeURIComponent(state.current.noteId)}/purge`, { method: 'DELETE' });
        state.current = null;
        state.selectedId = null;
        state.dirty = false;
        fillEditor(null);
        await loadList();
        toast?.('已彻底删除');
    }

    async function emptyTrash() {
        if (!confirm('清空回收站？所有已删除的笔记将被彻底移除，无法恢复。')) return;
        const result = await api('/api/notes/trash/empty', { method: 'POST' });
        await loadList();
        toast?.(result?.purged ? `已清空回收站（${result.purged} 条）` : '回收站已空');
    }

    function updateTrashButtons() {
        const inTrash = state.trash || state.groupFilter === '__trash';
        $('#notesDeleteBtn')?.classList.toggle('force-hidden', inTrash);
        $('#notesPurgeBtn')?.classList.toggle('force-hidden', !inTrash || !state.current);
        $('#notesEmptyTrashBtn')?.classList.toggle('force-hidden', !inTrash);
        $('#notesNewBtn')?.classList.toggle('force-hidden', inTrash);
    }

    /* ── Link connection modal (§6.4.5): search + multi-select SSH/RDP/VNC ── */
    async function openLinkConnectionModal() {
        if (!state.current) { toast?.('请先选择一条笔记'); return; }
        // Build a lightweight modal using existing styles
        let modal = document.getElementById('notesLinkModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'notesLinkModal';
            modal.className = 'modal-backdrop';
            modal.innerHTML = `
                <div class="connection-modal" style="max-width:480px">
                    <div class="modal-head"><h2>关联连接</h2><button type="button" class="icon-btn" id="notesLinkModalClose">✕</button></div>
                    <div style="padding:16px;display:flex;flex-direction:column;gap:12px">
                        <input class="search-input" id="notesLinkSearch" placeholder="搜索连接名称或主机…" autocomplete="off">
                        <div id="notesLinkList" style="max-height:320px;overflow:auto;display:flex;flex-direction:column;gap:4px"></div>
                    </div>
                    <div class="modal-actions"><button class="btn" type="button" id="notesLinkCancel">取消</button><button class="btn btn-primary" type="button" id="notesLinkSave">保存</button></div>
                </div>`;
            document.body.appendChild(modal);
        }
        modal.classList.add('show');
        modal.setAttribute('aria-hidden', 'false');
        const listEl = modal.querySelector('#notesLinkList');
        const searchEl = modal.querySelector('#notesLinkSearch');
        let allConns = [];
        let selected = new Set(state.current.linkedConnectionIds || []);
        try {
            const data = await api('/api/connections');
            allConns = data.connections || [];
        } catch { allConns = []; }
        function renderConns() {
            const q = String(searchEl.value || '').toLowerCase();
            const filtered = allConns.filter((c) => !q || String(c.name || '').toLowerCase().includes(q) || String(c.host || '').toLowerCase().includes(q));
            listEl.innerHTML = filtered.length ? filtered.map((c) => {
                const checked = selected.has(c.id);
                return `<label class="check-line" style="padding:6px 8px;border-radius:6px;cursor:pointer"><input type="checkbox" data-conn-id="${escapeHtml(c.id)}" ${checked ? 'checked' : ''}> <b>${escapeHtml(c.name)}</b> <span class="muted">${escapeHtml(c.protocol)} ${escapeHtml(c.host)}:${escapeHtml(c.port)}</span></label>`;
            }).join('') : '<p class="muted">无匹配连接</p>';
            listEl.querySelectorAll('[data-conn-id]').forEach((cb) => {
                cb.addEventListener('change', () => {
                    if (cb.checked) selected.add(cb.dataset.connId);
                    else selected.delete(cb.dataset.connId);
                });
            });
        }
        renderConns();
        searchEl.oninput = renderConns;
        modal.querySelector('#notesLinkModalClose').onclick = closeLinkModal;
        modal.querySelector('#notesLinkCancel').onclick = closeLinkModal;
        modal.querySelector('#notesLinkSave').onclick = async () => {
            try {
                const updated = await api(`/api/notes/${encodeURIComponent(state.current.noteId)}`, {
                    method: 'PUT', body: JSON.stringify({
                        linkedConnectionIds: Array.from(selected),
                        expectedRevision: state.current.revision,
                    }),
                });
                state.current = updated.note;
                state.dirty = false;
                fillEditor(updated.note);
                toast?.('关联连接已保存');
            } catch (err) { toast?.(err.message || '保存失败'); }
            closeLinkModal();
        };
        function closeLinkModal() {
            modal.classList.remove('show');
            modal.setAttribute('aria-hidden', 'true');
        }
    }

    /* ── Note context menu (§6.4.3): rename, move, copy, export, delete ── */
    function showNoteContextMenu(noteId, x, y) {
        let menu = document.getElementById('notesContextMenu');
        if (!menu) {
            menu = document.createElement('div');
            menu.id = 'notesContextMenu';
            menu.className = 'notes-context-menu';
            menu.style.cssText = 'position:fixed;z-index:9999;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:4px;box-shadow:0 4px 16px rgba(0,0,0,0.2);min-width:140px';
            document.body.appendChild(menu);
        }
        const note = state.notes.find((n) => n.noteId === noteId);
        if (!note) return;
        menu.innerHTML = `
            <button class="ctx-item" data-ctx-action="rename" data-note-id="${escapeHtml(noteId)}" style="display:block;width:100%;padding:6px 12px;text-align:left;background:none;border:none;color:var(--text);cursor:pointer;border-radius:4px">重命名</button>
            <button class="ctx-item" data-ctx-action="move" data-note-id="${escapeHtml(noteId)}" style="display:block;width:100%;padding:6px 12px;text-align:left;background:none;border:none;color:var(--text);cursor:pointer;border-radius:4px">移动分组</button>
            <button class="ctx-item" data-ctx-action="copy" data-note-id="${escapeHtml(noteId)}" style="display:block;width:100%;padding:6px 12px;text-align:left;background:none;border:none;color:var(--text);cursor:pointer;border-radius:4px">复制</button>
            <button class="ctx-item" data-ctx-action="export" data-note-id="${escapeHtml(noteId)}" style="display:block;width:100%;padding:6px 12px;text-align:left;background:none;border:none;color:var(--text);cursor:pointer;border-radius:4px">导出 Markdown</button>
            <button class="ctx-item" data-ctx-action="delete" data-note-id="${escapeHtml(noteId)}" style="display:block;width:100%;padding:6px 12px;text-align:left;background:none;border:none;color:var(--danger);cursor:pointer;border-radius:4px">删除</button>`;
        menu.style.left = `${Math.min(x, window.innerWidth - 160)}px`;
        menu.style.top = `${Math.min(y, window.innerHeight - 180)}px`;
        menu.classList.remove('force-hidden');
        menu.querySelectorAll('[data-ctx-action]').forEach((btn) => {
            btn.addEventListener('click', () => {
                menu.classList.add('force-hidden');
                handleContextAction(btn.dataset.ctxAction, btn.dataset.noteId);
            });
            btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--surface-2)'; });
            btn.addEventListener('mouseleave', () => { btn.style.background = 'none'; });
        });
    }

    async function handleContextAction(action, noteId) {
        const note = state.notes.find((n) => n.noteId === noteId);
        if (!note) return;
        if (action === 'rename') {
            const name = prompt('新标题：', note.title || '');
            if (!name) return;
            try {
                const cur = await api(`/api/notes/${encodeURIComponent(noteId)}`);
                const updated = await api(`/api/notes/${encodeURIComponent(noteId)}`, { method: 'PUT', body: JSON.stringify({ title: name, expectedRevision: cur.note.revision }) });
                toast?.('已重命名');
                await loadList();
            } catch (err) { toast?.(err.message); }
        } else if (action === 'move') {
            const group = prompt('移动到分组（留空移到未分组）：', note.groupPath || '');
            if (group === null) return;
            try {
                const cur = await api(`/api/notes/${encodeURIComponent(noteId)}`);
                const updated = await api(`/api/notes/${encodeURIComponent(noteId)}`, { method: 'PUT', body: JSON.stringify({ groupPath: group || '', expectedRevision: cur.note.revision }) });
                toast?.('已移动');
                await loadList();
            } catch (err) { toast?.(err.message); }
        } else if (action === 'copy') {
            try {
                const full = await api(`/api/notes/${encodeURIComponent(noteId)}`);
                const created = await api('/api/notes', { method: 'POST', body: JSON.stringify({ title: `${full.note.title} (副本)`, content: full.note.content, tags: full.note.tags, groupPath: full.note.groupPath }) });
                toast?.('已复制');
                await loadList();
                await selectNote(created.note.noteId);
            } catch (err) { toast?.(err.message); }
        } else if (action === 'export') {
            window.open(`/api/notes/${encodeURIComponent(noteId)}/export.md`, '_blank');
        } else if (action === 'delete') {
            if (!confirm('删除这条笔记？可在回收站恢复。')) return;
            await api(`/api/notes/${encodeURIComponent(noteId)}`, { method: 'DELETE' });
            if (state.current?.noteId === noteId) { state.current = null; state.selectedId = null; fillEditor(null); }
            await loadList();
            toast?.('已移到回收站');
        }
    }

    /* ── Conflict resolution window (§6.4.4): 409 revision conflict ── */
    async function showConflictWindow(noteId, serverNote) {
        let modal = document.getElementById('notesConflictModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'notesConflictModal';
            modal.className = 'modal-backdrop';
            modal.innerHTML = `
                <div class="connection-modal" style="max-width:600px">
                    <div class="modal-head"><h2>笔记冲突</h2><button type="button" class="icon-btn" id="notesConflictClose">✕</button></div>
                    <div style="padding:16px;display:flex;flex-direction:column;gap:12px">
                        <p>该笔记已被另一处修改（版本冲突）。请选择：</p>
                        <div style="display:flex;gap:8px;flex-wrap:wrap">
                            <button class="btn btn-primary" type="button" id="conflictKeepMine">保留我的版本</button>
                            <button class="btn" type="button" id="conflictLoadServer">载入服务器版本</button>
                        </div>
                        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                            <div><h3>我的版本</h3><pre id="conflictMyVersion" style="max-height:300px;overflow:auto;background:var(--surface-2);padding:8px;border-radius:6px;font-size:12px;white-space:pre-wrap"></pre></div>
                            <div><h3>服务器版本</h3><pre id="conflictServerVersion" style="max-height:300px;overflow:auto;background:var(--surface-2);padding:8px;border-radius:6px;font-size:12px;white-space:pre-wrap"></pre></div>
                        </div>
                    </div>
                </div>`;
            document.body.appendChild(modal);
        }
        const myContent = state.current?.content || '';
        const serverContent = serverNote?.content || '';
        modal.querySelector('#conflictMyVersion').textContent = myContent;
        modal.querySelector('#conflictServerVersion').textContent = serverContent;
        modal.classList.add('show');
        modal.setAttribute('aria-hidden', 'false');
        const close = () => { modal.classList.remove('show'); modal.setAttribute('aria-hidden', 'true'); };
        modal.querySelector('#notesConflictClose').onclick = close;
        modal.querySelector('#conflictLoadServer').onclick = async () => {
            state.current = serverNote;
            state.dirty = false;
            fillEditor(serverNote);
            close();
            toast?.('已载入服务器版本');
        };
        modal.querySelector('#conflictKeepMine').onclick = async () => {
            try {
                const updated = await api(`/api/notes/${encodeURIComponent(noteId)}`, {
                    method: 'PUT', body: JSON.stringify({
                        title: state.current.title, content: state.current.content,
                        tags: state.current.tags, groupPath: state.current.groupPath,
                        expectedRevision: serverNote.revision, // force overwrite with server's revision
                    }),
                });
                state.current = updated.note;
                state.dirty = false;
                fillEditor(updated.note);
                close();
                toast?.('已保留我的版本');
            } catch (err) { toast?.(err.message || '保存失败'); }
        };
    }

    /* ── Preview link interception (§6.4.5): ssh://telnet://jms:// → transient ── */
    function interceptPreviewLinks(previewEl) {
        if (!previewEl) return;
        previewEl.querySelectorAll('a[href]').forEach((a) => {
            const href = String(a.getAttribute('href') || '');
            if (/^(ssh:|telnet:|jms:)/i.test(href)) {
                a.addEventListener('click', (e) => {
                    e.preventDefault();
                    if (typeof window.openTransientFromUri === 'function') {
                        window.openTransientFromUri(href);
                    } else {
                        toast?.('请在应用主界面打开此链接');
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

    function bind() {
        $('#notesNewBtn')?.addEventListener('click', () => createNote().catch((e) => toast?.(e.message)));
        $('#notesDeleteBtn')?.addEventListener('click', () => deleteCurrent().catch((e) => toast?.(e.message)));
        $('#notesPurgeBtn')?.addEventListener('click', () => purgeCurrent().catch((e) => toast?.(e.message)));
        $('#notesEmptyTrashBtn')?.addEventListener('click', () => emptyTrash().catch((e) => toast?.(e.message)));
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
            updateTrashButtons();
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
        $('#notesLinkConnBtn')?.addEventListener('click', () => openLinkConnectionModal().catch((err) => toast?.(err.message)));
        $('#notesSortSelect')?.addEventListener('change', (e) => {
            state.sortBy = e.target.value || 'updated';
            renderList();
        });
        $('#notesList')?.addEventListener('contextmenu', (e) => {
            const item = e.target.closest('[data-note-id]');
            if (!item) return;
            e.preventDefault();
            showNoteContextMenu(item.dataset.noteId, e.clientX, e.clientY);
        });
        $('#notesList')?.addEventListener('click', (e) => {
            const action = e.target.closest('[data-ctx-action]');
            if (action) return; // context menu handled separately
            const item = e.target.closest('[data-note-id]');
            if (item) selectNote(item.dataset.noteId).catch((err) => toast?.(err.message));
        });
        document.addEventListener('click', (e) => {
            const menu = document.getElementById('notesContextMenu');
            if (menu && !menu.contains(e.target) && !e.target.closest('[data-note-id]')) {
                menu.classList.add('force-hidden');
            }
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

    /* Terminal side-panel hand-off: filter notes by the current connection
     * so the user sees only notes relevant to the SSH/RDP session they're
     * looking at (FREEZE plan §6.4 / §9). */
    async function filterByConnection(connectionId) {
        state.connectionFilter = connectionId || '';
        const connInput = document.getElementById('notesConnectionFilter');
        if (connInput) connInput.value = state.connectionFilter;
        await loadList();
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
        filterByConnection,
    };
}
