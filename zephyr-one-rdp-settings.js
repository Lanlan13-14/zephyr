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
 * The native shell sends the selected directory directly to the embedded core.
 * This page receives only a display label and whether a mapping exists.
 *
 * Why the picker is a polled handoff rather than a Tauri invoke:
 *   The WebView navigates to the loopback core, so the page is a *remote* origin
 *   to Tauri and cannot invoke a command. Granting IPC to a loopback origin would
 *   hand it to any process that can bind a local port. So the page files a
 *   request and the Rust shell claims it. The core persists the result before
 *   the page sees the non-sensitive completion response.
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
    var pickerSequence = 0;
    var activePicker = null;

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

    function stalePickerError() {
        var error = new Error('folder picker request is no longer active');
        error.stalePicker = true;
        return error;
    }

    function disposePicker(request) {
        if (!request) return;
        request.id = '';
        if (activePicker === request) activePicker = null;
    }

    function isActivePicker(request) {
        return activePicker === request
            && request.connectionId === currentConnectionId();
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
            if (!data || connectionId !== currentConnectionId()) return;
            folder.value = data.configured ? (data.folderLabel || 'Selected folder') : '';
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
    function saveMapping(connectionId, snapshot) {
        if (!connectionId || !snapshot) return Promise.resolve(null);

        /* A response to an older connection save must not update whichever
         * connection is open now. */
        if (snapshot.connectionId !== connectionId) return Promise.resolve(null);

        var enabled = snapshot.enabled;
        var body = {
            enabled: enabled,
            deviceName: enabled ? snapshot.deviceName : '',
        };

        var mappingRequest = fetch('/api/one/rdp/storage-mapping/' + encodeURIComponent(connectionId), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return mappingRequest.then(function (response) {
            return response.json().then(function (data) {
                if (!response.ok) throw new Error(data && data.error ? data.error : '保存映射失败');
                return data;
            });
        });
    }

    /* ── native folder picker ─────────────────────────────────────────────── */

    function pollPick(request, deadline) {
        return new Promise(function (resolve, reject) {
            function tick() {
                if (Date.now() > deadline) {
                    disposePicker(request);
                    reject(new Error('选择文件夹超时'));
                    return;
                }
                if (!isActivePicker(request)) {
                    reject(stalePickerError());
                    return;
                }
                fetch('/api/one/rdp/pick-folder/' + encodeURIComponent(request.id), {
                    credentials: 'same-origin',
                }).then(function (response) {
                    return response.ok ? response.json() : null;
                }).then(function (data) {
                    if (!isActivePicker(request)) {
                        reject(stalePickerError());
                        return;
                    }
                    if (!data) { setTimeout(tick, POLL_MS); return; }
                    if (data.status === 'pending') { setTimeout(tick, POLL_MS); return; }
                    if (data.status === 'done') {
                        if (data.error) { reject(new Error(pickErrorText(data.error))); return; }
                        if (data.selected !== true || !data.folderLabel) {
                            reject(new Error('Folder selection could not be verified.'));
                            return;
                        }
                        request.folderLabel = String(data.folderLabel);
                        resolve(request);
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

        var connectionId = currentConnectionId();
        if (!connectionId) {
            setHint('Save the connection before selecting a mapped folder.', true);
            return;
        }

        disposePicker(activePicker);
        var request = {
            sequence: ++pickerSequence,
            connectionId: connectionId,
            id: '',
            folderLabel: '',
        };
        activePicker = request;

        if (button) button.disabled = true;
        setHint('请在弹出的系统窗口中选择文件夹…');

        fetch('/api/one/rdp/pick-folder', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ connectionId: connectionId }),
        }).then(function (response) {
            if (!response.ok) throw new Error('无法请求系统文件夹选择器');
            return response.json();
        }).then(function (data) {
            if (!data || !data.id) throw new Error('无法请求系统文件夹选择器');
            if (!isActivePicker(request)) throw stalePickerError();
            request.id = String(data.id);
            return pollPick(request, Date.now() + POLL_TIMEOUT_MS);
        }).then(function (picked) {
            if (!isActivePicker(picked)) throw stalePickerError();
            folder.value = picked.folderLabel;
            /* Default the share name to the folder's own name: it is what the
             * user just chose, and an empty device name is the most common way to
             * end up with a mapping the remote refuses. Never overwrite a name
             * the user typed. */
            if (device && !String(device.value || '').trim()) {
                device.value = picked.folderLabel.replace(/[\\/:]/g, '') || 'Zephyr';
            }
            disposePicker(picked);
            setHint('Folder selected and mapped.');
        }).catch(function (error) {
            if (error && error.stalePicker) {
                disposePicker(request);
                return;
            }
            disposePicker(request);
            setHint(error && error.message ? error.message : '选择文件夹失败', true);
        }).then(function () {
            if (button && (!activePicker || activePicker === request)) button.disabled = false;
        });
    }

    /* ── persist alongside the connection save ────────────────────────────── */

    /*
     * app.js owns the save; it neither knows nor should know about One's mapping
     * store. Wrapping fetch means the mapping is attached using the *public* HTTP
     * contract (POST /api/connections -> { id }), so nothing here breaks when
     * app.js's internals change.
     *
     * The picker requires an existing connection id and the core persists its
     * result atomically. The observer updates only enablement and display name.
     */
    function captureMappingSave() {
        var folder = $('#rdpStorageFolder');
        var device = $('#rdpStorageDeviceName');
        var connectionId = currentConnectionId();
        return {
            connectionId: connectionId,
            isRdp: String(($('#connProtocol') && $('#connProtocol').value) || '').toUpperCase() === 'RDP',
            enabled: !!($('#rdpStorage') && $('#rdpStorage').checked),
            configured: !!(folder && String(folder.value || '').trim()),
            deviceName: device ? String(device.value || '').trim() : '',
        };
    }

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

            var mappingSave = isSave ? captureMappingSave() : null;
            var promise = original.apply(this, arguments);
            if (!isSave) return promise;

            return promise.then(function (response) {
                if (!response.ok) return response;
                if (!mappingSave || !mappingSave.isRdp) return response;

                /* Clone: app.js still needs to read this body. */
                var probe = response.clone();
                probe.json().then(function (data) {
                    var id = (data && (data.id || (data.connection && data.connection.id)))
                        || currentConnectionId();
                    if (!id) return;
                    return saveMapping(String(id), mappingSave).then(function () {
                        if (mappingSave.connectionId === currentConnectionId()) setHint('');
                    }).catch(function (error) {
                        if (mappingSave.connectionId !== currentConnectionId()) return;
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
