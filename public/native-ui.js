/* Zephyr-owned desktop interactions. No Chromium context menus or JS dialogs. */
(() => {
  'use strict';
  if (window.ZephyrNativeUI) return;
  const doc = document;
  let menu = null;
  let menuFocus = null;
  let lastDialogFocus = null;
  let pointerFocus = null;
  let pointerSelection = null;
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
  const zh = () => (doc.documentElement.lang || 'zh').toLowerCase().startsWith('zh');
  const L = (a, b) => (zh() ? a : b);
  const text = {
    undo: () => L('撤销', 'Undo'), redo: () => L('重做', 'Redo'),
    cut: () => L('剪切', 'Cut'), copy: () => L('复制', 'Copy'),
    paste: () => L('粘贴', 'Paste'), all: () => L('全选', 'Select all'),
    visibleAll: () => L('全选可见文本', 'Select visible text'),
    open: () => L('打开链接', 'Open link'), copyLink: () => L('复制链接', 'Copy link'),
    ok: () => L('确定', 'OK'), cancel: () => L('取消', 'Cancel'),
  };

  function closeMenu() {
    if (!menu) return;
    menu.remove();
    menu = null;
  }

  function editableTarget(target) {
    const el = target?.closest?.('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"], .cm-content');
    if (!el || el.disabled) return null;
    if (el.matches('input') && !/^(text|search|url|tel|password|email|number)?$/i.test(el.type || 'text')) return null;
    return el;
  }

  function selectionText() {
    try { return String(window.getSelection()?.toString() || ''); } catch { return ''; }
  }

  function inputSelection(el) {
    if (!el) return '';
    if (el.matches('input, textarea')) {
      try { return el.value.slice(el.selectionStart || 0, el.selectionEnd || 0); } catch { return ''; }
    }
    return selectionText();
  }

  async function writeClipboard(value) {
    const valueString = String(value ?? '');
    if (!valueString) return false;
    try { await navigator.clipboard.writeText(valueString); return true; } catch {}
    const area = doc.createElement('textarea');
    area.value = valueString;
    area.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0';
    doc.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = doc.execCommand('copy'); } catch {}
    area.remove();
    return ok;
  }

  async function readClipboard() {
    try { return await navigator.clipboard.readText(); } catch { return ''; }
  }

  function restoreFocus(el) {
    try { el?.focus?.({ preventScroll: true }); } catch { try { el?.focus?.(); } catch {} }
  }

  function insertAtCaret(el, value, savedSelection = null) {
    if (!el || !value) return;
    restoreFocus(el);
    if (savedSelection) {
      try { el.setSelectionRange(savedSelection.start, savedSelection.end, savedSelection.direction); } catch {}
    }
    if (el.matches('input, textarea')) {
      const start = Number.isInteger(el.selectionStart) ? el.selectionStart : el.value.length;
      const end = Number.isInteger(el.selectionEnd) ? el.selectionEnd : start;
      try { el.setRangeText(value, start, end, 'end'); }
      catch { el.value = el.value.slice(0, start) + value + el.value.slice(end); }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: value }));
      return;
    }
    if (el.matches('.cm-content')) {
      const transfer = new DataTransfer();
      transfer.setData('text/plain', value);
      el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
      return;
    }
    try { doc.execCommand('insertText', false, value); } catch {}
  }

  function selectEditable(el) {
    restoreFocus(el);
    if (el?.matches?.('#wtermWrapper, .wterm-wrapper, [data-zephyr-terminal]')) {
      el.dispatchEvent(new CustomEvent('zephyr:native-select-all', { bubbles: true }));
      return;
    }
    if (el?.matches?.('input, textarea')) {
      try { el.select(); } catch {}
      return;
    }
    if (!el) return;
    const range = doc.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  function command(el, name) {
    restoreFocus(el);
    try { doc.execCommand(name); } catch {}
  }

  let menuReturnFocus = null;

  async function pasteInto(target, savedSelection = null) {
    const value = await readClipboard();
    if (!value) return;
    const terminal = target?.closest?.('#wtermWrapper, .wterm-wrapper, [data-zephyr-terminal]');
    if (terminal) {
      terminal.dispatchEvent(new CustomEvent('zephyr:native-paste', { bubbles: true, detail: { text: value } }));
      return;
    }
    insertAtCaret(editableTarget(target), value, savedSelection);
  }

  function showMenu(x, y, items) {
    closeMenu();
    const available = items.filter((item) => item && !item.hidden);
    if (!available.length) return;
    menu = doc.createElement('div');
    menu.className = 'zephyr-native-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', L('上下文菜单', 'Context menu'));
    available.forEach((item) => {
      if (item.separator) {
        const separator = doc.createElement('div');
        separator.className = 'zephyr-native-menu-separator';
        separator.setAttribute('role', 'separator');
        menu.appendChild(separator);
        return;
      }
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'zephyr-native-menu-item';
      button.setAttribute('role', 'menuitem');
      button.disabled = !!item.disabled;
      const label = doc.createElement('span');
      label.textContent = item.label;
      button.appendChild(label);
      if (item.shortcut) {
        const shortcut = doc.createElement('kbd');
        shortcut.textContent = mac ? item.shortcut.replace('Ctrl+', '⌘') : item.shortcut;
        button.appendChild(shortcut);
      }
      button.addEventListener('pointerdown', (event) => {
        /* Menu buttons must not collapse the input selection before a command. */
        event.preventDefault();
      });
      button.addEventListener('click', async () => {
        closeMenu();
        restoreFocus(menuFocus);
        await item.action();
        menuFocus = null;
      });
      menu.appendChild(button);
    });
    doc.body.appendChild(menu);
    /* Focus is restored before every command; selectionStart/End must not be
     * read after the menu button steals focus from a password/input field. */
    menuFocus = pointerFocus || doc.activeElement;
    menuReturnFocus = menuFocus;
    pointerFocus = null;
    pointerSelection = null;
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;
    menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
  }

  function onContextMenu(event) {
    if (event.defaultPrevented) return;
    if (event.target?.closest?.('.zephyr-native-menu, [data-native-context-menu]')) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const editable = editableTarget(target);
    if (editable && pointerFocus === editable) restoreFocus(pointerFocus);
    if (editable && pointerSelection) {
      try { editable.setSelectionRange(pointerSelection.start, pointerSelection.end, pointerSelection.direction); } catch {}
    }
    const terminal = target?.closest?.('#wtermWrapper, .wterm-wrapper, [data-zephyr-terminal]');
    const link = target?.closest?.('a[href]');
    const selected = inputSelection(editable) || selectionText();
    const selectionForCommand = pointerSelection ? { ...pointerSelection } : null;
    event.preventDefault();
    event.stopPropagation();
    const items = [];
    if (editable) {
      const readOnly = !!editable.readOnly;
      items.push(
        { label: text.undo(), shortcut: 'Ctrl+Z', disabled: readOnly, action: () => command(editable, 'undo') },
        { label: text.redo(), shortcut: 'Ctrl+Y', disabled: readOnly, action: () => command(editable, 'redo') },
        { separator: true },
        { label: text.cut(), shortcut: 'Ctrl+X', disabled: readOnly || !selected, action: async () => { if (await writeClipboard(selected)) command(editable, 'delete'); } },
        { label: text.copy(), shortcut: 'Ctrl+C', disabled: !selected, action: () => writeClipboard(selected) },
        { label: text.paste(), shortcut: 'Ctrl+V', disabled: readOnly, action: () => pasteInto(editable, selectionForCommand) },
        { separator: true },
        { label: text.all(), shortcut: 'Ctrl+A', action: () => selectEditable(editable) },
      );
    } else {
      if (link) {
        items.push(
          { label: text.open(), action: () => link.click() },
          { label: text.copyLink(), action: () => writeClipboard(link.href) },
          { separator: true },
        );
      }
      items.push(
        { label: text.copy(), shortcut: 'Ctrl+C', disabled: !selected, action: () => writeClipboard(selected) },
        { label: text.paste(), shortcut: 'Ctrl+V', hidden: !terminal, action: () => pasteInto(terminal) },
        { label: terminal ? text.visibleAll() : text.all(), shortcut: 'Ctrl+A', action: () => selectEditable(terminal || doc.body) },
      );
    }
    showMenu(event.clientX, event.clientY, items);
  }

  function dialog({ message = '', defaultValue = null, title = '', danger = false, password = false }) {
    closeMenu();
    lastDialogFocus = doc.activeElement;
    return new Promise((resolve) => {
      const backdrop = doc.createElement('div');
      backdrop.className = 'zephyr-native-dialog-backdrop';
      const box = doc.createElement('section');
      box.className = 'zephyr-native-dialog';
      box.setAttribute('role', defaultValue === null ? 'alertdialog' : 'dialog');
      box.setAttribute('aria-modal', 'true');
      const heading = doc.createElement('h2');
      heading.textContent = title || L('Zephyr 提示', 'Zephyr');
      heading.id = `zephyr-dialog-title-${Date.now()}`;
      box.setAttribute('aria-labelledby', heading.id);
      const body = doc.createElement('p');
      body.textContent = String(message ?? '');
      const actions = doc.createElement('div');
      actions.className = 'zephyr-native-dialog-actions';
      let input = null;
      if (defaultValue !== null && typeof defaultValue !== 'boolean') {
        input = doc.createElement('input');
        input.type = password ? 'password' : 'text';
        input.value = String(defaultValue ?? '');
        input.setAttribute('aria-label', String(message || L('输入内容', 'Input')));
      }
      const finish = (value) => {
        backdrop.remove();
        doc.removeEventListener('keydown', keydown, true);
        restoreFocus(lastDialogFocus);
        resolve(value);
      };
      const cancel = doc.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn';
      cancel.textContent = text.cancel();
      cancel.addEventListener('click', () => finish(defaultValue === null ? false : null));
      const ok = doc.createElement('button');
      ok.type = 'button';
      ok.className = `btn btn-primary${danger ? ' danger' : ''}`;
      ok.textContent = text.ok();
      ok.addEventListener('click', () => finish(input ? input.value : true));
      actions.append(cancel, ok);
      box.append(heading, body);
      if (input) box.appendChild(input);
      box.appendChild(actions);
      backdrop.appendChild(box);
      function keydown(event) {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel.click(); }
        if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); ok.click(); }
        if (event.key === 'Tab') {
          const controls = [...box.querySelectorAll('input, button:not(:disabled)')];
          const first = controls[0], last = controls[controls.length - 1];
          if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }
      doc.addEventListener('keydown', keydown, true);
      doc.body.appendChild(backdrop);
      if (input) { input.focus(); input.select(); } else ok.focus();
    });
  }

  doc.addEventListener('contextmenu', onContextMenu);
  doc.addEventListener('pointerdown', (event) => {
    if (event.button === 2) {
      pointerFocus = doc.activeElement;
      const el = editableTarget(pointerFocus);
      if (el?.matches?.('input, textarea')) {
        try { pointerSelection = { start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection }; } catch { pointerSelection = null; }
      } else pointerSelection = null;
    }
    if (event.button === 2) event.preventDefault();
    if (!event.target?.closest?.('.zephyr-native-menu')) closeMenu();
  }, true);
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menu) {
      /* The menu owns this Escape even when focus is on the original input;
       * otherwise the surrounding modal also closes on the same keypress. */
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      closeMenu();
      restoreFocus(menuReturnFocus || menuFocus);
      menuReturnFocus = null;
    }
    if (!menu) return;
    const items = [...menu.querySelectorAll('button:not(:disabled)')];
    const index = items.indexOf(doc.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      items[(index + delta + items.length) % items.length]?.focus();
    }
  }, true);
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', closeMenu);
  doc.addEventListener('scroll', closeMenu, true);

  window.ZephyrNativeUI = Object.freeze({
    closeMenu,
    showMenu,
    readClipboard,
    writeClipboard,
    alert: (message, title) => dialog({ message, title }).then(() => undefined),
    confirm: (message, options = {}) => dialog({ message, ...options }),
    prompt: (message, defaultValue = '', options = {}) => dialog({ message, defaultValue, ...options }),
  });
})();
