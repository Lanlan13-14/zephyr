import { DEFAULT_TERMINAL_SHORTCUTS, normalizeTerminalShortcuts, shortcutLabel } from './terminal-shortcuts.js';
import { renderZephyrIconSvg } from './zephyr-icons.js';
import { Motion } from './vendor/zephyr-motion/index.js';

// Translation source strings; t receives the Chinese source, then placeholders
// are interpolated locally. No user-controlled text is interpreted as markup.
export const TERMINAL_SHORTCUT_SETTINGS_TEXT = Object.freeze({
  title: '终端快捷键',
  description: '自定义 SSH、Telnet 与批量终端的快捷键组合和显示顺序。',
  rules: '每组最多同时 3 键，最多一个非修饰键。单独的 Ctrl、Alt、Shift 保持粘滞键行为。',
  orderHelp: '拖动排序，或使用上移 / 下移按钮；聚焦排序按钮后可按 ↑ / ↓、Home / End。',
  add: '新增快捷键', edit: '编辑', remove: '删除', up: '上移', down: '下移',
  reorder: '排序：{label}', list: '快捷键顺序', empty: '尚无快捷键。保存空列表会隐藏自定义快捷键，不会恢复默认。',
  defaults: '恢复默认', discard: '放弃更改', save: '保存快捷键', saving: '正在保存…',
  saved: '快捷键已保存。', unsaved: '有未保存的更改。',
  preserved: '已保留未保存的更改，未重新载入设置。',
  saveError: '保存失败，草稿已保留，请重试。', readError: '读取快捷键失败，请稍后重试。',
  invalid: '包含未知或不支持的按键：{key}。', maxKeys: '每组最多同时 3 键。',
  oneKey: '每组最多包含一个非修饰键。', required: '请至少选择一个按键。',
  duplicate: '同一组合不能重复选择按键。', labelLong: '自定义名称最多 64 个字符。',
  newTitle: '新增组合', editTitle: '编辑组合', label: '自定义名称（可选）',
  labelHint: '留空时显示按键组合', search: '搜索按键', searchHint: '搜索字母、数字或键名',
  selected: '已选 {count} / 3 键', removeKey: '移除按键 {key}',
  modifiers: '修饰键', controls: '控制与方向键', letters: '字母', digits: '数字',
  functions: '功能键', symbols: '符号', noKeys: '没有匹配的按键。',
  capture: '录制组合（可选）', capturing: '录制中，按 Esc 结束',
  captureHelp: '始终可以点击选键。Ctrl+Alt+Delete 等组合可能被系统截获；录制仅在此区域聚焦时生效。',
  captureArea: '聚焦此处后按下组合；Esc 结束录制',
  applyNew: '添加到列表', applyEdit: '应用编辑', cancel: '取消',
  applyFirst: '请先应用或取消当前组合，再保存列表。',
  confirmDefaults: '用默认快捷键替换当前草稿？保存后才会生效。',
  confirmDiscard: '放弃所有未保存的更改并重新载入？', confirm: '确认',
  moved: '已将 {label} 移到第 {position} 项。',
});

const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'];
const GROUPS = [
  ['modifiers', MODIFIERS],
  ['controls', ['Escape', 'Tab', 'Enter', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']],
  ['letters', [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']],
  ['digits', [...'0123456789']],
  ['functions', Array.from({ length: 12 }, (_, i) => `F${i + 1}`)],
  ['symbols', [...'`-=[]\\;\',./~!@#$%^&*()_+{}|:"<>?']],
];
const clone = (items) => items.map(({ id, label, keys }) => ({ id, ...(label ? { label } : {}), keys: [...keys] }));
const signature = (items) => JSON.stringify(items);
let nextInstance = 0;

/**
 * Owns only its appended subtree (never the adjacent terminal layout form).
 * getValue() is synchronous; undefined => defaults, [] => explicitly empty.
 * onSave(items) must reject on persistence/broadcast failure. It receives a copy.
 * refresh({force:false}) returns false while dirty/editing/saving; force discards
 * drafts deliberately, but never interrupts an in-flight save. destroy() is
 * idempotent and does not cancel an already-dispatched persistence request.
 */
export function createTerminalShortcutSettings({ root, getValue, onSave, openEditorModal, closeEditorModal, saveOnApply = false, t = (text) => text } = {}) {
  if (!root?.ownerDocument || typeof getValue !== 'function' || typeof onSave !== 'function') {
    throw new TypeError('root, getValue and onSave are required');
  }
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  const prefix = `terminal-shortcuts-${++nextInstance}`;
  const host = doc.createElement('div');
  host.className = 'tss';
  root.append(host);
  const portal = doc.createElement('div'); portal.className = 'terminal-shortcut-settings tss';
  doc.body.append(portal);
  const cleanups = [];
  const rows = new Map();
  const animated = new Map();
  let draft = [], baseline = '[]', editor = null, saving = false, destroyed = false;
  let drag = null, confirmation = null, statusKey = '', detail = '', serial = 0;
  const tr = (name, params = {}) => {
    const source = TERMINAL_SHORTCUT_SETTINGS_TEXT[name];
    let translated;
    try { translated = t(source); } catch { /* use source */ }
    return String(translated || source).replace(/\{(\w+)\}/g, (all, key) => String(params[key] ?? all));
  };
  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const listen = (node, event, fn, options) => {
    node.addEventListener(event, fn, options);
    cleanups.push(() => node.removeEventListener(event, fn, options));
    if (node === host) { portal.addEventListener(event, fn, options); cleanups.push(() => portal.removeEventListener(event, fn, options)); }
  };
  const button = (action, text, icon) => {
    const node = el('button', 'tss-button');
    node.type = 'button';
    node.dataset.action = action;
    if (icon) {
      const glyph = el('span', 'tss-icon');
      // Only fixed IDs from the existing SVG catalogue enter this sink.
      glyph.innerHTML = renderZephyrIconSvg(icon, { size: 16, decorative: true });
      node.append(glyph);
    }
    node.append(el('span', '', text));
    return node;
  };
  const dirty = () => signature(draft) !== baseline || editor !== null;
  function validation(keys, allowModifierDraft = false) {
    if (!Array.isArray(keys) || !keys.length) return tr('required');
    if (keys.length > 3) return tr('maxKeys');
    if (new Set(keys).size !== keys.length) return tr('duplicate');
    const ordinary = keys.filter((key) => !MODIFIERS.includes(key));
    if (ordinary.length > 1) return tr('oneKey');
    if (!ordinary.length) return keys.length === 1 ? '' : (allowModifierDraft ? '' : tr('oneKey'));
    try {
      const normalized = normalizeTerminalShortcuts([{ id: 'tss-validation', keys }]);
      if (normalized.length !== 1) throw new Error('unsupported chord');
      return '';
    } catch {
      return tr('invalid', { key: keys.join(' + ') });
    }
  }
  const heading = el('h3', 'tss-title', tr('title'));
  heading.id = `${prefix}-title`;
  host.setAttribute('role', 'group');
  host.setAttribute('aria-labelledby', heading.id);
  const description = el('p', 'tss-muted', tr('description'));
  const rules = el('p', 'tss-muted', tr('rules'));
  const help = el('p', 'tss-muted', tr('orderHelp'));
  help.id = `${prefix}-order-help`;
  const header = el('div', 'tss-header');
  const headingGroup = el('div', 'tss-header-info');
  headingGroup.append(heading, description);
  const toolbar = el('div', 'tss-actions tss-header-actions');
  const add = button('add', tr('add'), 'plus');
  add.classList.add('tss-primary');
  const defaults = button('defaults', tr('defaults'));
  toolbar.append(add, defaults);
  header.append(headingGroup, toolbar);
  const confirmBox = el('div', 'tss-confirm');
  const list = el('ol', 'tss-list');
  list.setAttribute('aria-label', tr('list'));
  list.setAttribute('aria-describedby', help.id);
  const editorHost = el('div', 'tss-editor-host');
  const modal = el('div', 'modal-backdrop'); modal.id = 'shortcutEditorModal';
  modal.setAttribute('aria-hidden', 'true');
  const card = el('div', 'connection-modal snippet-modal tss-editor-card'); card.id = 'shortcutEditorCard';
  card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true');
  const inner = el('div', 'snippet-modal-inner'); inner.id = 'shortcutEditorInner';
  const modalHead = el('div', 'modal-head');
  const modalTitle = el('h2', '', tr('newTitle')); modalTitle.id = 'shortcutEditorTitle';
  card.setAttribute('aria-labelledby', modalTitle.id);
  const modalClose = button('cancel-editor', tr('cancel'), 'close'); modalClose.classList.add('icon-btn');
  modalClose.setAttribute('aria-label', tr('cancel'));
  modalHead.append(modalTitle, modalClose); inner.append(modalHead, editorHost); card.append(inner); modal.append(card);
  let editorTrigger = null, editorCycle = 0;
  listen(modal, 'click', event => { if (event.target === modal && !saving) closeEditor(); });
  const status = el('p', 'tss-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const error = el('p', 'tss-error');
  error.setAttribute('role', 'alert');
  const footer = el('div', 'tss-actions tss-footer');
  const discard = button('discard', tr('discard'));
  const save = button('save', tr('save'), 'check');
  save.classList.add('tss-primary');
  footer.append(discard, save);
  host.append(header, help, confirmBox, list, status, error, footer); portal.append(modal);

  function releaseMotion(node) {
    animated.delete(node);
    Motion.release(node);
  }
  function finishAnimations() {
    for (const node of [...animated.keys()]) releaseMotion(node);
  }
  function animateRows(before, skipId) {
    // No CSS/JS-backend spatial fallback: animate only on the real WASM engine.
    if (!Motion.ready || !Motion.usingWasm || Motion.reducedMotion || win.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    for (const [id, row] of rows) {
      const previous = before.get(id);
      if (!previous || id === skipId || !row.isConnected) continue;
      const offset = previous.top - row.getBoundingClientRect().top;
      if (Math.abs(offset) < 1) continue;
      const token = {};
      animated.set(row, token);
      Motion.set(row, { y: offset });
      Motion.to(row, { y: 0 }, { preset: 'snappy' }).then(() => {
        if (animated.get(row) === token) releaseMotion(row);
      });
    }
  }
  const rects = () => new Map([...rows].map(([id, row]) => [id, row.getBoundingClientRect()]));
  function updateStatus() {
    host.dataset.dirty = String(dirty());
    host.setAttribute('aria-busy', String(saving));
    status.textContent = saving ? tr('saving') : statusKey ? tr(statusKey) : dirty() ? tr('unsaved') : '';
    error.textContent = detail;
    error.hidden = !detail;
    add.disabled = saving || editor !== null;
    defaults.disabled = saving || editor !== null;
    discard.disabled = saving || !dirty();
    save.disabled = saving || !dirty() || editor !== null || readFailed;
    save.lastChild.textContent = tr(saving ? 'saving' : 'save');
  }
  function renderConfirmation() {
    confirmBox.replaceChildren();
    confirmBox.hidden = !confirmation;
    if (!confirmation) return;
    confirmBox.append(el('p', '', tr(confirmation === 'defaults' ? 'confirmDefaults' : 'confirmDiscard')));
    const actions = el('div', 'tss-actions');
    actions.append(button('confirm', tr('confirm')), button('cancel-confirm', tr('cancel')));
    confirmBox.append(actions);
  }
  function rowFor(item) {
    let row = rows.get(item.id);
    if (!row) {
      row = el('li', 'tss-row');
      row.dataset.id = item.id;
      const grip = button('reorder', '', 'grid');
      grip.classList.add('tss-grip');
      grip.setAttribute('aria-describedby', help.id);
      const text = el('div', 'tss-row-text');
      text.append(el('span', 'tss-row-label'), el('span', 'tss-row-keys'));
      const actions = el('div', 'tss-row-actions');
      actions.append(button('up', tr('up'), 'chevron-up'), button('down', tr('down'), 'chevron-down'), button('edit', tr('edit')), button('remove', tr('remove'), 'close'));
      row.append(grip, text, actions);
      rows.set(item.id, row);
    }
    const label = item.label || '';
    const labelNode = row.querySelector('.tss-row-label');
    labelNode.textContent = label;
    labelNode.hidden = !label;
    const keys = row.querySelector('.tss-row-keys');
    keys.replaceChildren(...item.keys.map((k) => el('kbd', 'tss-kbd', k)));
    const fullLabel = shortcutLabel(item);
    row.querySelector('[data-action="reorder"]').setAttribute('aria-label', tr('reorder', { label: fullLabel }));
    for (const node of row.querySelectorAll('[data-action]')) {
      const action = node.dataset.action;
      node.disabled = saving || editor !== null || (action === 'up' && draft[0]?.id === item.id) || (action === 'down' && draft.at(-1)?.id === item.id);
      if (action !== 'reorder') node.setAttribute('aria-label', `${tr(action)}: ${fullLabel}`);
    }
    return row;
  }
  function renderList() {
    const active = doc.activeElement;
    const ids = new Set(draft.map((item) => item.id));
    for (const [id, row] of rows) {
      if (!ids.has(id)) { releaseMotion(row); row.remove(); rows.delete(id); }
    }
    list.querySelector('.tss-empty')?.remove();
    for (const item of draft) list.append(rowFor(item));
    if (!draft.length) list.append(el('li', 'tss-empty tss-muted', tr('empty')));
    if (active?.isConnected && host.contains(active) && !active.disabled) active.focus({ preventScroll: true });
    updateStatus();
  }
  function changed() { statusKey = ''; detail = ''; confirmation = null; renderConfirmation(); renderList(); }
  function focusRow(id, action = 'reorder') {
    rows.get(id)?.querySelector(`[data-action="${action}"]`)?.focus({ preventScroll: true });
  }
  function move(id, index, animate = true) {
    if (saving || editor || drag) return;
    const old = draft.findIndex((item) => item.id === id);
    index = Math.max(0, Math.min(draft.length - 1, index));
    if (old < 0 || old === index) return;
    const before = rects();
    finishAnimations();
    const [item] = draft.splice(old, 1);
    draft.splice(index, 0, item);
    changed();
    if (animate) animateRows(before);
    focusRow(id);
    status.textContent = tr('moved', { label: shortcutLabel(item), position: index + 1 });
  }

  let readFailed = false;
  function refresh(options = {}) {
    if (destroyed || saving) return false;
    const force = options === true || options?.force === true;
    if (!force && (dirty() || drag)) { statusKey = 'preserved'; updateStatus(); return false; }
    let loaded;
    try {
      const value = getValue();
      loaded = clone(normalizeTerminalShortcuts(value === undefined ? DEFAULT_TERMINAL_SHORTCUTS : value));
    } catch { readFailed = true; detail = tr('readError'); updateStatus(); return false; }
    cancelDrag();
    finishAnimations();
    editor = null;
    editorHost.replaceChildren();
    draft = loaded;
    baseline = signature(draft);
    readFailed = false;
    statusKey = ''; detail = ''; confirmation = null;
    heading.textContent = tr('title');
    description.textContent = tr('description'); rules.textContent = tr('rules'); help.textContent = tr('orderHelp');
    add.lastChild.textContent = tr('add'); defaults.lastChild.textContent = tr('defaults'); discard.lastChild.textContent = tr('discard');
    list.setAttribute('aria-label', tr('list'));
    renderConfirmation(); renderList();
    return true;
  }
  async function persist() {
    if (destroyed || saving || readFailed) return;
    if (editor) { detail = tr('applyFirst'); updateStatus(); return; }
    if (!dirty()) return;
    for (const item of draft) {
      const message = validation(item.keys);
      if (message) { detail = message; updateStatus(); return; }
    }
    cancelDrag(); finishAnimations();
    const snapshot = clone(draft);
    saving = true; detail = ''; statusKey = ''; confirmation = null;
    renderConfirmation(); renderList();
    try {
      const result = await onSave(clone(snapshot));
      if (result === false) throw new Error();
      if (destroyed) return;
      baseline = signature(snapshot);
      statusKey = 'saved';
    } catch (err) {
      if (destroyed) return;
      detail = tr('saveError');
      // Do not expose backend details (which may contain credentials) or lie
      // about persistence; consumers can log the original error in onSave.
    } finally {
      saving = false;
      if (!destroyed) renderList();
    }
  }

  function showEditor(id = null, trigger = null) {
    if (saving || editor) return;
    cancelDrag(); finishAnimations(); finishKeyGroups();
    const item = draft.find((entry) => entry.id === id);
    editor = { id: item?.id || null, keys: [...(item?.keys || [])], label: item?.label || '', capturing: false, query: '' };
    confirmation = null; renderConfirmation();
    detail = ''; statusKey = '';
    const panel = el('div', 'tss-editor');
    modalTitle.textContent = tr(item ? 'editTitle' : 'newTitle');
    editorTrigger = trigger || add;
    const cycle = ++editorCycle;
    const labelId = `${prefix}-label`;
    const name = el('input', 'tss-input');
    name.type = 'text'; name.id = labelId; name.maxLength = 64;
    name.dataset.field = 'label'; name.value = editor.label;
    name.placeholder = tr('labelHint');
    name.autocomplete = 'off';
    panel.append(el('label', '', tr('label')));
    panel.lastChild.htmlFor = labelId; panel.append(name);
    const count = el('p', 'tss-selected-count');
    count.setAttribute('aria-live', 'polite');
    const selected = el('div', 'tss-selected');
    const editorError = el('p', 'tss-editor-error tss-error');
    editorError.id = `${prefix}-editor-error`; editorError.setAttribute('role', 'alert');
    panel.append(count, selected, editorError);
    panel.append(el('p', 'tss-muted', tr('rules')));
    const searchId = `${prefix}-search`;
    const searchLabel = el('label', '', tr('search')); searchLabel.htmlFor = searchId;
    const search = el('input', 'tss-input');
    search.type = 'search'; search.id = searchId; search.dataset.field = 'search';
    search.placeholder = tr('searchHint'); search.autocomplete = 'off';
    panel.append(searchLabel, search);
    const groups = el('div', 'tss-key-groups');
    for (const [group, source] of GROUPS) {
      // The shared normalizer owns which keys are supported. Never offer a key
      // the terminal encoder will drop, including unsupported function keys.
      const keys = [...new Set(source)].filter((key) => !validation([key]));
      if (!keys.length) continue;
      const section = el('div', 'tss-key-group');
      section.dataset.group = group;
      const toggle = button('toggle-group', tr(group), 'chevron-down');
      toggle.dataset.group = group;
      const expanded = false;
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.setAttribute('aria-controls', `${prefix}-group-${group}`);
      toggle.classList.add('tss-group-toggle');
      const grid = el('div', 'tss-key-grid'); grid.id = `${prefix}-group-${group}`;
      grid.hidden = !expanded;
      const content = el('div', 'tss-key-grid-content');
      for (const key of keys) {
        const pick = button('pick-key', key); pick.dataset.key = key;
        pick.setAttribute('aria-pressed', 'false'); content.append(pick);
      }
      grid.append(content);
      section.append(toggle, grid); groups.append(section);
    }
    const noKeys = el('p', 'tss-no-keys tss-muted', tr('noKeys')); noKeys.hidden = true;
    groups.append(noKeys); panel.append(groups);
    const record = button('capture', tr('capture'), 'keyboard');
    record.setAttribute('aria-pressed', 'false');
    const captureHelp = el('p', 'tss-muted', tr('captureHelp'));
    captureHelp.id = `${prefix}-capture-help`;
    const capture = el('div', 'tss-capture', tr('captureArea'));
    capture.tabIndex = 0; capture.dataset.capture = 'true';
    capture.setAttribute('role', 'group'); capture.setAttribute('aria-label', tr('captureArea'));
    capture.setAttribute('aria-describedby', captureHelp.id);
    capture.hidden = true;
    panel.append(record, captureHelp, capture);
    const actions = el('div', 'tss-actions');
    const apply = button('apply', tr(saveOnApply ? 'save' : item ? 'applyEdit' : 'applyNew'), 'check');
    apply.classList.add('tss-primary');
    actions.append(button('cancel-editor', tr('cancel')), apply); panel.append(actions);
    editorHost.replaceChildren(panel);
    updateSelection(); renderList();
    if (typeof openEditorModal === 'function') {
      void Promise.resolve(openEditorModal({ modal, card, inner, trigger: editorTrigger })).then(() => {
        if (cycle === editorCycle && editor) name.focus({ preventScroll: true });
      });
    } else {
      modal.classList.add('show', 'app-visible'); modal.setAttribute('aria-hidden', 'false');
      card.style.opacity = '1'; name.focus({ preventScroll: true });
    }
  }
  function editorError(message = '') {
    const node = editorHost.querySelector('.tss-editor-error');
    if (node) { node.textContent = message; node.hidden = !message; }
  }
  function updateSelection() {
    if (!editor) return;
    const selected = editorHost.querySelector('.tss-selected');
    selected.replaceChildren();
    for (let index = 0; index < 3; index++) {
      const key = editor.keys[index];
      if (key) {
        const cap = button('remove-key', key, 'close');
        cap.dataset.key = key; cap.classList.add('tss-capsule');
        cap.setAttribute('aria-label', tr('removeKey', { key })); selected.append(cap);
      } else {
        const slot = el('span', 'tss-slot', String(index + 1));
        slot.setAttribute('aria-hidden', 'true'); selected.append(slot);
      }
    }
    editorHost.querySelector('.tss-selected-count').textContent = tr('selected', { count: editor.keys.length });
    for (const node of editorHost.querySelectorAll('[data-action="pick-key"]')) {
      node.setAttribute('aria-pressed', String(editor.keys.includes(node.dataset.key)));
    }
  }
  function pickKey(key) {
    if (!editor) return;
    const keys = editor.keys.includes(key) ? editor.keys.filter((item) => item !== key) : [...editor.keys, key];
    const message = keys.length ? validation(keys, true) : '';
    if (message) { editorError(message); return; }
    editor.keys = keys; editorError(); updateSelection();
  }
  function filterKeys(query) {
    if (!editor) return;
    finishKeyGroups(false);
    editor.query = query.trim().toLowerCase();
    let found = false;
    for (const section of editorHost.querySelectorAll('.tss-key-group')) {
      let matches = 0;
      const groupMatch = tr(section.dataset.group).toLowerCase().includes(editor.query);
      for (const node of section.querySelectorAll('[data-key]')) {
        node.hidden = !!editor.query && !groupMatch && !node.dataset.key.toLowerCase().includes(editor.query);
        if (!node.hidden) matches++;
      }
      section.hidden = !matches;
      if (matches) found = true;
      const toggle = section.querySelector('[data-action="toggle-group"]');
      section.querySelector('.tss-key-grid').hidden = editor.query ? !matches : toggle.getAttribute('aria-expanded') !== 'true';
    }
    editorHost.querySelector('.tss-no-keys').hidden = found;
  }
  function closeEditor() {
    if (saving) return;
    const id = editor?.id;
    editor = null; detail = ''; ++editorCycle;
    const trigger = editorTrigger;
    const finish = () => { if (!editor) { finishKeyGroups(); editorHost.replaceChildren(); } };
    if (typeof closeEditorModal === 'function') void Promise.resolve(closeEditorModal({ modal, card, inner, trigger })).then(finish);
    else { modal.classList.remove('show', 'app-visible'); modal.setAttribute('aria-hidden', 'true'); finish(); }
    renderList();
    if (id && rows.has(id)) focusRow(id, 'edit'); else add.focus({ preventScroll: true });
  }
  async function applyEditor() {
    if (!editor || saving) return;
    const message = validation(editor.keys) || (editor.label.trim().length > 64 ? tr('labelLong') : '');
    if (message) { editorError(message); return; }
    const keys = normalizeTerminalShortcuts([{ id: 'tss-validation', keys: editor.keys }])[0].keys;
    const id = editor.id || `shortcut-${Date.now().toString(36)}-${prefix}-${++serial}`;
    const label = editor.label.trim();
    const item = { id, ...(label ? { label } : {}), keys: [...keys] };
    const index = draft.findIndex((entry) => entry.id === id);
    if (saveOnApply) {
      const snapshot = clone(draft);
      if (index < 0) snapshot.push(item); else snapshot[index] = item;
      saving = true;
      const apply = editorHost.querySelector('[data-action="apply"]');
      if (apply) apply.disabled = true;
      editorError();
      try {
        if (await onSave(clone(snapshot)) === false) throw new Error();
        if (destroyed) return;
        draft = snapshot; baseline = signature(snapshot); statusKey = 'saved';
        saving = false; closeEditor(); renderList(); focusRow(id, 'edit');
      } catch {
        if (!destroyed) editorError(tr('saveError'));
      } finally { saving = false; if (apply?.isConnected) apply.disabled = false; }
      return;
    }
    if (index < 0) draft.push(item); else draft[index] = item;
    closeEditor(); changed(); focusRow(id, 'edit');
  }
  function toggleCapture(enabled) {
    if (!editor) return;
    editor.capturing = enabled;
    const record = editorHost.querySelector('[data-action="capture"]');
    record.lastChild.textContent = tr(enabled ? 'capturing' : 'capture');
    record.setAttribute('aria-pressed', String(enabled));
    const capture = editorHost.querySelector('[data-capture]');
    void animateKeyGroup(capture, enabled);
    if (enabled) capture.focus({ preventScroll: true }); else record.focus({ preventScroll: true });
  }
  function captureKeys(event) {
    if (event.isComposing || event.repeat || !editor?.capturing) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Escape') { toggleCapture(false); return; }
    const aliases = { Control: 'Ctrl', Esc: 'Escape', Del: 'Delete', ' ': 'Space' };
    const key = aliases[event.key] || (/^[a-z]$/i.test(event.key) ? event.key.toUpperCase() : event.key);
    const keys = [];
    if (event.ctrlKey || key === 'Ctrl') keys.push('Ctrl');
    if (event.altKey || key === 'Alt') keys.push('Alt');
    if (event.shiftKey || key === 'Shift') keys.push('Shift');
    if (event.metaKey || key === 'Meta') keys.push('Meta');
    if (!MODIFIERS.includes(key)) keys.push(key);
    const message = validation(keys);
    if (message) { editorError(message); return; }
    editor.keys = keys; editorError(); updateSelection();
  }

  function dragTarget(y, id) {
    let index = 0;
    for (const item of draft) {
      if (item.id === id) continue;
      const rect = rows.get(item.id).getBoundingClientRect();
      if (y > rect.top + rect.height / 2) index++;
    }
    return index;
  }
  function paintDrag() {
    if (!drag?.active) return;
    const delta = drag.y - drag.startY + list.scrollTop - drag.scrollTop;
    drag.row.style.transform = `translate3d(0, ${delta}px, 0)`;
    drag.target = dragTarget(drag.y, drag.id);
    for (const row of rows.values()) row.classList.remove('tss-drop-before', 'tss-drop-after');
    const others = draft.filter((item) => item.id !== drag.id);
    const next = others[drag.target];
    const previous = others[drag.target - 1];
    if (next) rows.get(next.id).classList.add('tss-drop-before');
    else if (previous) rows.get(previous.id).classList.add('tss-drop-after');
  }
  function scrollDrag() {
    if (!drag?.active) return;
    const rect = list.getBoundingClientRect();
    const step = drag.y < rect.top + 36 ? -10 : drag.y > rect.bottom - 36 ? 10 : 0;
    if (step) { list.scrollTop += step; paintDrag(); }
    drag.raf = win.requestAnimationFrame(scrollDrag);
  }
  function startDrag(event) {
    const handle = event.target.closest?.('[data-action="reorder"]');
    if (!handle || !host.contains(handle) || handle.disabled || event.button !== 0 || event.isPrimary === false || drag || saving || editor) return;
    const row = handle.closest('.tss-row');
    finishAnimations();
    drag = { id: row.dataset.id, row, handle, pointerId: event.pointerId, startY: event.clientY, y: event.clientY, scrollTop: list.scrollTop, active: false, target: draft.findIndex((item) => item.id === row.dataset.id), raf: null };
    handle.focus({ preventScroll: true });
    try { handle.setPointerCapture(event.pointerId); } catch { /* document listeners remain usable */ }
  }
  function dragMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.y = event.clientY;
    if (!drag.active && Math.abs(drag.y - drag.startY) < 6) return;
    event.preventDefault();
    if (!drag.active) {
      drag.active = true; drag.row.classList.add('tss-dragging');
      drag.raf = win.requestAnimationFrame(scrollDrag);
    }
    paintDrag();
  }
  function cancelDrag() {
    if (!drag) return;
    const current = drag; drag = null;
    if (current.raf !== null) win.cancelAnimationFrame(current.raf);
    current.row.style.removeProperty('transform');
    current.row.classList.remove('tss-dragging');
    for (const row of rows.values()) row.classList.remove('tss-drop-before', 'tss-drop-after');
    try { if (current.handle.hasPointerCapture(current.pointerId)) current.handle.releasePointerCapture(current.pointerId); } catch { /* detached or synthetic pointer */ }
  }
  function dragEnd(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const current = drag;
    if (!current.active) { cancelDrag(); return; }
    drag.y = event.clientY; paintDrag();
    const before = rects();
    cancelDrag();
    const old = draft.findIndex((item) => item.id === current.id);
    if (old !== current.target) {
      const [item] = draft.splice(old, 1); draft.splice(current.target, 0, item); changed();
      status.textContent = tr('moved', { label: shortcutLabel(item), position: current.target + 1 });
    }
    animateRows(before); focusRow(current.id);
  }
  const groupCycles = new WeakMap();
  const activeGroups = new Set();
  const groupArrows = new Set();
  const disclosurePreset = { response: 0.2, damping: 1 };
  function finishKeyGroups(releaseArrows = true) {
    for (const grid of activeGroups) {
      groupCycles.set(grid, (groupCycles.get(grid) || 0) + 1);
      const collapsed = grid.previousElementSibling?.getAttribute('aria-expanded') === 'false';
      Motion.release(grid);
      grid.hidden = collapsed;
      grid.style.height = ''; grid.style.opacity = ''; grid.style.overflow = '';
    }
    activeGroups.clear();
    if (releaseArrows) {
      for (const arrow of groupArrows) Motion.release(arrow);
      groupArrows.clear();
    }
  }
  async function animateKeyGroup(grid, expanded) {
    const cycle = (groupCycles.get(grid) || 0) + 1; groupCycles.set(grid, cycle);
    const running = activeGroups.has(grid);
    const from = grid.hidden ? 0 : grid.getBoundingClientRect().height;
    const opacity = grid.hidden ? 0 : Number.parseFloat(win.getComputedStyle(grid).opacity);
    grid.hidden = false;
    // Measure the stable inner grid, not auto-height on the animated box.
    // Keeping the live channels on reversal preserves both position and velocity.
    const content = grid.firstElementChild;
    let to = 0;
    if (expanded) {
      if (content?.classList.contains('tss-key-grid-content')) to = content.getBoundingClientRect().height;
      else { grid.style.height = 'auto'; to = grid.getBoundingClientRect().height; }
    }
    grid.style.overflow = 'hidden';
    if (!running) Motion.set(grid, { h: from, opacity: Number.isFinite(opacity) ? opacity : 1 });
    activeGroups.add(grid);
    try { await Motion.to(grid, { h: to, opacity: expanded ? 1 : 0 }, { preset: disclosurePreset }); }
    finally {
      if (groupCycles.get(grid) !== cycle) return;
      activeGroups.delete(grid);
      // Hide before releasing the height channel: never paint the natural grid
      // between a zero-height last frame and display:none.
      grid.hidden = !expanded;
      Motion.release(grid); grid.style.height = ''; grid.style.opacity = ''; grid.style.overflow = '';
    }
  }
  function click(event) {
    const target = event.target.closest?.('button[data-action]');
    if (!target || !(host.contains(target) || portal.contains(target)) || target.disabled || destroyed) return;
    const action = target.dataset.action;
    const id = target.closest('.tss-row')?.dataset.id;
    const index = draft.findIndex((item) => item.id === id);
    switch (action) {
      case 'add': showEditor(null, target); break;
      case 'edit': showEditor(id, target); break;
      case 'remove': {
        if (saving || editor || index < 0) break;
        cancelDrag(); finishAnimations();
        draft.splice(index, 1); changed();
        const next = draft[Math.min(index, draft.length - 1)];
        if (next) focusRow(next.id, 'edit'); else add.focus({ preventScroll: true });
        break;
      }
      case 'up': move(id, index - 1, event.detail !== 0); break;
      case 'down': move(id, index + 1, event.detail !== 0); break;
      case 'defaults': case 'discard':
        if (saving || (editor && action !== 'discard')) break;
        cancelDrag(); confirmation = action; renderConfirmation();
        confirmBox.querySelector('[data-action="confirm"]')?.focus({ preventScroll: true }); break;
      case 'cancel-confirm': confirmation = null; renderConfirmation(); updateStatus(); break;
      case 'confirm': {
        if (saving) break;
        const selected = confirmation;
        if (selected === 'discard') { refresh({ force: true }); add.focus({ preventScroll: true }); }
        else if (selected === 'defaults') {
          cancelDrag(); finishAnimations(); draft = clone(normalizeTerminalShortcuts(DEFAULT_TERMINAL_SHORTCUTS));
          changed(); defaults.focus({ preventScroll: true });
        }
        break;
      }
      case 'save': void persist(); break;
      case 'cancel-editor': closeEditor(); break;
      case 'apply': applyEditor(); break;
      case 'pick-key': case 'remove-key': pickKey(target.dataset.key); break;
      case 'toggle-group': {
        const expanded = target.getAttribute('aria-expanded') !== 'true';
        target.setAttribute('aria-expanded', String(expanded));
        const arrow = target.querySelector('.tss-icon');
        if (arrow) {
          groupArrows.add(arrow);
          void Motion.to(arrow, { rotate: expanded ? 180 : 0 }, { preset: disclosurePreset });
        }
        void animateKeyGroup(target.nextElementSibling, expanded); break;
      }
      case 'capture': toggleCapture(!editor.capturing); break;
    }
  }
  listen(host, 'click', click);
  listen(host, 'input', (event) => {
    if (!editor) return;
    if (event.target.dataset.field === 'label') { editor.label = event.target.value; editorError(); }
    if (event.target.dataset.field === 'search') filterKeys(event.target.value);
  });
  listen(host, 'keydown', (event) => {
    if (event.target.dataset.capture && editor?.capturing) { captureKeys(event); return; }
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      if (drag) { event.preventDefault(); event.stopPropagation(); cancelDrag(); }
      else if (confirmation) { event.preventDefault(); event.stopPropagation(); confirmation = null; renderConfirmation(); updateStatus(); }
      else if (editor) { event.preventDefault(); event.stopPropagation(); closeEditor(); }
      return;
    }
    if (editor && event.key === 'Enter' && ['label', 'search'].includes(event.target.dataset.field)) {
      event.preventDefault(); event.stopPropagation();
      if (event.target.dataset.field === 'label') applyEditor();
      return;
    }
    if (event.target.dataset.action !== 'reorder' || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const id = event.target.closest('.tss-row').dataset.id;
    const index = draft.findIndex((item) => item.id === id);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? draft.length - 1 : index + (event.key === 'ArrowUp' ? -1 : 1);
    move(id, next, false);
  });
  listen(host, 'pointerdown', startDrag);
  listen(win, 'pointermove', dragMove, { passive: false });
  listen(win, 'pointerup', dragEnd);
  listen(win, 'pointercancel', (event) => { if (drag?.pointerId === event.pointerId) cancelDrag(); });
  listen(host, 'lostpointercapture', (event) => { if (drag?.pointerId === event.pointerId) cancelDrag(); });
  listen(win, 'blur', cancelDrag);
  listen(doc, 'visibilitychange', () => { if (doc.hidden) cancelDrag(); });
  refresh();
  return {
    refresh,
    destroy() {
      if (destroyed) return;
      destroyed = true; cancelDrag(); finishAnimations(); finishKeyGroups();
      for (const cleanup of cleanups.splice(0)) cleanup();
      for (const row of rows.values()) Motion.release(row);
      rows.clear(); editor = null; host.remove(); portal.remove();
    },
  };
}
