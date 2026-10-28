/* Zephyr-owned replacement for the browser's native single-select popup. */
(() => {
  'use strict';
  if (window.ZephyrNativeSelect) return;
  let openShell = null;

  const close = (shell = openShell) => {
    if (!shell) return;
    if (typeof shell._zephyrCloseMenu === 'function') shell._zephyrCloseMenu();
    else {
      shell.classList.remove('open');
      shell.querySelector('.ui-toggle-select-trigger')?.setAttribute('aria-expanded', 'false');
    }
    if (openShell === shell) openShell = null;
  };

  function sync(select) {
    const shell = select?.closest?.('.ui-toggle-select');
    if (!shell) return;
    const trigger = shell.querySelector('.ui-toggle-select-trigger');
    const menu = shell.querySelector('.ui-toggle-select-menu');
    const options = [...select.options];
    const current = options.find((option) => option.value === select.value) || options[0];
    if (trigger) {
      trigger.textContent = current?.textContent || current?.value || '';
      trigger.disabled = select.disabled;
      trigger.setAttribute('aria-label', select.getAttribute('aria-label') || current?.textContent || '');
    }
    if (!menu) return;
    menu.replaceChildren();
    options.forEach((option, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `ui-toggle-select-option${option.value === select.value ? ' is-selected' : ''}`;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(option.value === select.value));
      button.dataset.index = String(index);
      button.disabled = option.disabled;
      button.textContent = option.textContent || option.value;
      menu.appendChild(button);
    });
  }

  function enhance(select) {
    if (!(select instanceof HTMLSelectElement) || select.multiple) return null;
    if (select.dataset.toggleSelect === '1') { sync(select); return select.closest('.ui-toggle-select'); }
    if (select.dataset.nativeSelect === 'off') return null;
    const shell = document.createElement('div');
    shell.className = 'ui-toggle-select';
    for (const className of select.classList) {
      if (className === 'login-locale-select' || className === 'force-hidden' || className === 'sr-only') shell.classList.add(className);
    }
    shell.dataset.selectId = String(select.id || '').startsWith('jumpRouteSelect-') ? 'jumpRouteSelect' : (select.id || '');
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
    shell.append(trigger, menu);
    sync(select);
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const willOpen = !shell.classList.contains('open');
      close();
      if (!willOpen) { shell._zephyrCloseMenu?.(); return; }
      sync(select);
      if (typeof shell._zephyrOpenMenu === 'function') shell._zephyrOpenMenu();
      else if (typeof window.ZephyrNativeSelectMotion?.open === 'function') window.ZephyrNativeSelectMotion.open(shell);
      else {
        shell.classList.add('open');
        trigger.setAttribute('aria-expanded', 'true');
      }
      openShell = shell;
      requestAnimationFrame(() => {
        const selected = menu.querySelector('.is-selected') || menu.querySelector('button:not(:disabled)');
        selected?.scrollIntoView({ block: 'nearest' });
      });
    });
    menu.addEventListener('click', (event) => {
      const button = event.target.closest('.ui-toggle-select-option');
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      const option = select.options[Number(button.dataset.index)];
      if (!option || option.disabled) return;
      if (select.value !== option.value) {
        select.value = option.value;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      sync(select);
      close(shell);
      trigger.focus({ preventScroll: true });
    });
    select.addEventListener('change', () => sync(select));
    shell.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); close(shell); trigger.focus(); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const options = [...select.options];
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        let index = select.selectedIndex;
        for (let count = 0; count < options.length; count += 1) {
          index = (index + delta + options.length) % options.length;
          if (!options[index].disabled) break;
        }
        select.selectedIndex = index;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        sync(select);
        if (shell.classList.contains('open')) menu.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
      }
    });
    return shell;
  }

  function scan(root = document) {
    if (root instanceof HTMLSelectElement) enhance(root);
    root.querySelectorAll?.('select:not([multiple])').forEach(enhance);
  }

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.target instanceof HTMLSelectElement) {
        if (record.type === 'attributes' && record.attributeName === 'value') {
          const option = [...record.target.options].find((item) => item.value === record.target.getAttribute('value'));
          if (option) record.target.value = option.value;
        }
        sync(record.target);
        if (record.type === 'attributes' && record.attributeName === 'disabled') {
          const trigger = record.target.closest('.ui-toggle-select')?.querySelector('.ui-toggle-select-trigger');
          if (trigger) trigger.disabled = record.target.disabled;
        }
      }
      record.addedNodes.forEach((node) => {
        if (node.nodeType === 1) scan(node);
      });
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['value', 'disabled', 'selected'] });
  document.addEventListener('pointerdown', (event) => { if (!event.target.closest('.ui-toggle-select')) close(); }, true);
  window.addEventListener('resize', () => close());
  document.addEventListener('scroll', (event) => { if (!event.target?.closest?.('.ui-toggle-select-menu')) close(); }, true);
  window.ZephyrNativeSelect = Object.freeze({ enhance, sync, scan, close });
  window.enhanceToggleSelect = enhance;
  window.syncToggleSelectFace = sync;
  scan();
})();
