/*
 * zephyr-one-rdp-settings.js — wires the RDP 文件夹映射 UI to real storage.
 *
 * Zephyr One only. Injected into app.html by zephyr-one-embed-surface.js and
 * served by the core at /zephyr-one-rdp-settings.js in embedded mode.
 *
 * The markup (#rdpStorage, #rdpStorageFolder, #rdpStorageDeviceName,
 * #rdpStorageFolderPickBtn) already exists in the shared app.html but is purely
 * presentational there: the pick button has no handler and neither field is ever
 * read or written. tests/rdp-folder-mapping-ui.test.mjs records that boundary.
 * This file connects all three ends for One.
 *
 * Why it lives outside app.js:
 *   A mapped folder is an absolute path on *this* machine. The browser product
 *   has no such concept — showDirectoryPicker() yields an opaque handle, never a
 *   path — so putting these fields in the shared connection record would add
 *   columns only one client could ever populate. The mapping is stored One-side
 *   under /api/one/rdp/storage-mapping/:connectionId instead.
 *
 * Why the picker is a polled handoff rather than a Tauri invoke:
 *   The WebView navigates to the loopback core, so the page is a *remote* origin
 *   to Tauri and cannot invoke a command. Granting IPC to a loopback origin would
 *   hand it to any process that can bind a local port. So the page files a
 *   request, the Rust shell claims it, opens the OS dialog, and posts the path
 *   back — the same shape the shell already uses to follow the colour scheme.
 *
 * Reading #connectionId rather than app.js's `editingId`:
 *   app.js keeps `editingId` in module scope but mirrors it into the
 *   #connectionId input on every modal open. The input is a public contract;
 *   the variable is not.
 */
'use strict';

(function () {
    var POLL_MS = 250;
    var POLL_TIMEOUT_MS = 120000;

    function $(selector) { return document.querySelector(selector); }

    function currentConnectionId() {
        var field = $('#connectionId');
        return field ? String(field.value || '').trim() : '';
    }

    function setHint(message, isError) {
        var hint = $('#rdpStorageHint');
        if (!hint) return;
        hint.textContent = message || '';
        hint.style.color = isError ? 'var(--danger, #e5534b)' : 'var(--text-secondary, #888)';
        hint.hidden = !message;
    }

    /* ── load / save ──────────────────────────────────────────────────────── */

    function loadMapping(connectionId) {
        var folder = $('#rdpStorageFolder');
        var device = $('#rdpStorageDeviceName');
        if (!folder || !device) return;

        if (!connectionId) {
            /* Adding a new connection: nothing saved yet. Clear rather than
             * leaving the previous connection's folder on screen, which would
             * read as "this one is already mapped". */
            folder.value = '';
            device.value = '';
            setHint('');
            return;
        }

        fetch('/api/one/rdp/storage-mapping/' + encodeURIComponent(connectionId), {
            credentials: 'same-origin',
        }).then(function (response) {
            return response.ok ? response.json() : null;
        }).then(function (data) {
            if (!data) return;
            folder.value = data.folder || '';
            device.value = data.deviceName || '';
            setHint('');
        }).catch(function () { /* leave the fields as they are */ });
    }

    /*
     * Persist for a known connection id.
     *
     * Returns a promise so the save observer below can surface a rejected folder
     * instead of letting the connection save look fully successful while the
     * mapping was silently dropped.
     */
    function saveMapping(connectionId) {
        var folder = $('#rdpStorageFolder');
        var device = $('#rdpStorageDeviceName');
        if (!connectionId || !folder || !device) return Promise.resolve(null);

        var enabled = !!($('#rdpStorage') && $('#rdpStorage').checked);
        var body = {
            /* Toggling 文件夹映射 off clears the mapping rather than keeping a
             * hidden path that would come back on the next enable. */
            folder: enabled ? String(folder.value || '').trim() : '',
            deviceName: enabled ? String(device.value || '').trim() : '',
        };

        return fetch('/api/one/rdp/storage-mapping/' + encodeURIComponent(connectionId), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }).then(function (response) {
            return response.json().then(function (data) {
                if (!response.ok) throw new Error(data && data.error ? data.error : '保存映射失败');
                return data;
            });
        });
    }

    /* ── native folder picker ─────────────────────────────────────────────── */

    function pollPick(id, deadline) {
        return new Promise(function (resolve, reject) {
            function tick() {
                if (Date.now() > deadline) {
                    reject(new Error('选择文件夹超时'));
                    return;
                }
                fetch('/api/one/rdp/pick-folder/' + encodeURIComponent(id), {
                    credentials: 'same-origin',
                }).then(function (response) {
                    return response.ok ? response.json() : null;
                }).then(function (data) {
                    if (!data) { setTimeout(tick, POLL_MS); return; }
                    if (data.status === 'pending') { setTimeout(tick, POLL_MS); return; }
                    if (data.status === 'done') {
                        if (data.error) { reject(new Error(pickErrorText(data.error))); return; }
                        resolve(data.path || '');
                        return;
                    }
                    /* 'unknown': the entry expired or was already read. */
                    reject(new Error('未能获取所选文件夹'));
                }).catch(function () {
                    setTimeout(tick, POLL_MS);
                });
            }
            tick();
        });
    }

    /* The shell reports a dismissed dialog as the literal string 'cancelled'. */
    function pickErrorText(error) {
        return String(error) === 'cancelled' ? '已取消选择' : String(error);
    }

    function pickFolder() {
        var button = $('#rdpStorageFolderPickBtn');
        var folder = $('#rdpStorageFolder');
        var device = $('#rdpStorageDeviceName');
        if (!folder) return;

        if (button) button.disabled = true;
        setHint('请在弹出的系统窗口中选择文件夹…');

        fetch('/api/one/rdp/pick-folder', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        }).then(function (response) {
            if (!response.ok) throw new Error('无法请求系统文件夹选择器');
            return response.json();
        }).then(function (data) {
            if (!data || !data.id) throw new Error('无法请求系统文件夹选择器');
            return pollPick(data.id, Date.now() + POLL_TIMEOUT_MS);
        }).then(function (picked) {
            if (!picked) { setHint(''); return; }
            folder.value = picked;
            /* Default the share name to the folder's own name: it is what the
             * user just chose, and an empty device name is the most common way to
             * end up with a mapping the remote refuses. Never overwrite a name
             * the user typed. */
            if (device && !String(device.value || '').trim()) {
                var parts = picked.replace(/[\\/]+$/, '').split(/[\\/]/);
                var base = parts[parts.length - 1] || 'Zephyr';
                device.value = base.replace(/[\\/:]/g, '');
            }
            var connectionId = currentConnectionId();
            if (!connectionId) {
                /* New connection: no id to attach to yet. The save observer
                 * below persists it as soon as the POST returns one. */
                setHint('将在保存服务器后写入映射。');
                return;
            }
            return saveMapping(connectionId).then(function () {
                setHint('已保存映射文件夹。');
            });
        }).catch(function (error) {
            setHint(error && error.message ? error.message : '选择文件夹失败', true);
        }).then(function () {
            if (button) button.disabled = false;
        });
    }

    /* ── persist alongside the connection save ────────────────────────────── */

    /*
     * app.js owns the save; it neither knows nor should know about One's mapping
     * store. Wrapping fetch means the mapping is attached using the *public* HTTP
     * contract (POST /api/connections -> { id }), so nothing here breaks when
     * app.js's internals change.
     *
     * A new connection has no id until the POST responds, which is exactly why
     * this hook reads the id out of the response body rather than the DOM.
     */
    function installSaveObserver() {
        var original = window.fetch;
        if (!original || original.__zephyrOneRdpWrapped) return;

        var wrapped = function (input, init) {
            var url = typeof input === 'string' ? input : (input && input.url) || '';
            var method = String(
                (init && init.method) || (input && input.method) || 'GET',
            ).toUpperCase();
            var isSave = /\/api\/connections(?:\/[^/?#]+)?$/.test(url)
                && (method === 'POST' || method === 'PUT');

            var promise = original.apply(this, arguments);
            if (!isSave) return promise;

            return promise.then(function (response) {
                if (!response.ok) return response;
                var protocolField = $('#connProtocol');
                var isRdp = protocolField
                    && String(protocolField.value || '').toUpperCase() === 'RDP';
                if (!isRdp) return response;

                /* Clone: app.js still needs to read this body. */
                var probe = response.clone();
                probe.json().then(function (data) {
                    var id = (data && (data.id || (data.connection && data.connection.id)))
                        || currentConnectionId();
                    if (!id) return;
                    return saveMapping(String(id)).then(function () {
                        setHint('');
                    }).catch(function (error) {
                        /* The connection saved but the folder did not. Say so
                         * rather than leaving the user believing it is mapped. */
                        setHint(
                            (error && error.message ? error.message : '映射未保存')
                            + '（服务器已保存，映射未生效）',
                            true,
                        );
                    });
                }).catch(function () { /* non-JSON response: nothing to attach to */ });

                return response;
            });
        };
        wrapped.__zephyrOneRdpWrapped = true;
        window.fetch = wrapped;
    }

    /* ── init ─────────────────────────────────────────────────────────────── */

    function ensureHintNode() {
        if ($('#rdpStorageHint')) return;
        var detail = $('#rdpStorageDetail');
        if (!detail) return;
        var inner = detail.querySelector('.rdp-storage-detail-inner') || detail;
        var hint = document.createElement('p');
        hint.className = 'field-hint';
        hint.id = 'rdpStorageHint';
        hint.hidden = true;
        inner.appendChild(hint);
    }

    function init() {
        var button = $('#rdpStorageFolderPickBtn');
        if (!button) return; /* not the connection form */

        ensureHintNode();
        button.addEventListener('click', function (event) {
            event.preventDefault();
            pickFolder();
        });

        var toggle = $('#rdpStorage');
        if (toggle) {
            toggle.addEventListener('change', function () {
                if (!toggle.checked) setHint('');
            });
        }

        installSaveObserver();

        /*
         * The modal is reused for every connection, and app.js repopulates it on
         * open, so the mapping has to be re-read each time it becomes visible.
         * Watching the class/hidden attributes is how the modal announces that
         * without app.js needing to emit an event.
         */
        var modal = $('#connectionModal');
        if (modal) {
            var wasOpen = false;
            var observer = new MutationObserver(function () {
                var open = !modal.hidden
                    && !modal.classList.contains('force-hidden')
                    && !modal.classList.contains('hidden');
                if (open && !wasOpen) loadMapping(currentConnectionId());
                wasOpen = open;
            });
            observer.observe(modal, {
                attributes: true,
                attributeFilter: ['class', 'hidden', 'style'],
            });
        }

        loadMapping(currentConnectionId());
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
