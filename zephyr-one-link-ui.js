/*
 * zephyr-one-link-ui.js — Zephyr Link settings overlay for desktop One.
 *
 * Injected only in embedded mode. Mirrors Android FileSyncScreen:
 * hero status card, grouped 状态 / 策略 rows, browser enrollment, no
 * password / TOTP / Client Token. Dropdowns are the same
 * `.ui-toggle-select` + Motion.morph('mac') path as the dashboard filters.
 */
'use strict';

(function () {
    var POLL_MS = 1000;
    var INTERVALS = [30, 60, 300, 900, 1800, 3600];
    var CONFLICT_MARKER = '<<<<<<<';
    var lastState = {};
    var conflictLoadGen = 0;
    var importLoadGen = 0;

    function $(id) { return document.getElementById(id); }

    function api(path, options) {
        var opts = options || {};
        return fetch(path, {
            method: opts.method || 'GET',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: opts.body ? JSON.stringify(opts.body) : undefined,
        }).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (data) {
                if (!res.ok) {
                    var err = new Error(data && data.error && data.error.message ? data.error.message : 'HTTP ' + res.status);
                    err.code = data && data.error && data.error.code ? data.error.code : '';
                    err.retryable = !!(data && data.error && data.error.retryable);
                    throw err;
                }
                return data;
            });
        });
    }

    function t(key, vars) {
        if (typeof window.t === 'function') return window.t(key, vars);
        var text = String(key);
        if (vars) {
            Object.keys(vars).forEach(function (name) {
                text = text.replace('{' + name + '}', String(vars[name]));
            });
        }
        return text;
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function dumpText(value) {
        if (value == null) return '';
        if (typeof value === 'string') return value;
        try { return JSON.stringify(value); } catch (_) { return String(value); }
    }

    function needsManualMerge(conflict) {
        if (!conflict) return false;
        var blob = dumpText(conflict.mergedPayload)
            + dumpText(conflict.local)
            + dumpText(conflict.server);
        return blob.indexOf(CONFLICT_MARKER) !== -1;
    }

    function conflictIdOf(row) {
        if (!row) return '';
        return String(row.conflictId || row.id || '');
    }

    function normalizeConflicts(data) {
        if (!data) return [];
        if (Array.isArray(data.conflicts)) return data.conflicts;
        if (Array.isArray(data)) return data;
        return [];
    }

    function normalizeImportTypes(data) {
        if (!data) return [];
        if (Array.isArray(data)) {
            return data.map(function (row) {
                if (typeof row === 'string') return { entityType: row, localCount: 0 };
                return {
                    entityType: row.entityType || row.type || '',
                    localCount: Number(row.localCount) || 0,
                    defaultAction: row.defaultAction,
                    sample: row.sample,
                };
            }).filter(function (row) { return row.entityType; });
        }
        if (Array.isArray(data.types)) return normalizeImportTypes(data.types);
        if (data.importPreview) return normalizeImportTypes(data.importPreview);
        if (data.preview) return normalizeImportTypes(data.preview);
        if (data.types && typeof data.types === 'object') return normalizeImportTypes(data.types);
        if (typeof data === 'object') {
            return Object.keys(data).map(function (entityType) {
                var row = data[entityType];
                if (!row || typeof row !== 'object') return null;
                if (!('localCount' in row) && !('defaultAction' in row) && !('remoteCount' in row)) return null;
                return {
                    entityType: entityType,
                    localCount: Number(row.localCount) || 0,
                    defaultAction: row.defaultAction,
                    sample: row.sample,
                };
            }).filter(Boolean);
        }
        return [];
    }

    function intervalLabel(seconds) {
        var n = Number(seconds) || 300;
        if (n < 60) return n + ' ' + t('秒');
        if (n % 60 === 0) return (n / 60) + ' ' + t('分钟');
        return n + ' ' + t('秒');
    }

    function phaseOf(state) {
        if (state.running) return t('正在同步');
        if (state.importDecisionRequired) return t('先完成导入决定');
        if (state.lastError) return t('同步失败') + ' · ' + state.lastError;
        if (state.conflictCount > 0) return t('需要处理冲突');
        if (state.lastSuccessAt) return t('镜像已同步');
        if (state.bound) return t('镜像待同步');
        return t('未绑定主端 · 本机工作区可离线使用');
    }

    function subOf(state) {
        if (!state.bound) return t('未绑定主端 · 本机工作区可离线使用');
        if (state.importDecisionRequired) return t('先完成导入决定');
        if (state.lastError) return String(state.lastError).slice(0, 96);
        if (state.bootstrapResume) return t('快照未完成 · 下次从断点继续');
        if (state.lastSuccessAt) return t('上次成功 · 下次自动 {interval}', { interval: intervalLabel(state.intervalSec) });
        return t('等待首次同步 · 下次自动 {interval}', { interval: intervalLabel(state.intervalSec) });
    }

    function setHidden(el, hidden) {
        if (!el) return;
        el.hidden = !!hidden;
    }

    function enhanceSelects() {
        try {
            if (typeof window.enhanceToggleSelect === 'function') {
                window.enhanceToggleSelect($('linkIntervalSelect'));
                window.enhanceToggleSelect($('linkNetworkPolicySelect'));
            }
            if (typeof window.syncToggleSelectFace === 'function') {
                window.syncToggleSelectFace($('linkIntervalSelect'));
                window.syncToggleSelectFace($('linkNetworkPolicySelect'));
            }
        } catch (_) { /* app.js may not have exported them */ }
    }

    function renderEnrollment(state) {
        var status = $('linkBindStatus');
        if (!status) return;
        var enrollment = state.enrollment;
        if (state.bound) {
            status.innerHTML = '';
            setHidden(status, true);
            return;
        }
        setHidden(status, false);
        if (!enrollment) {
            status.innerHTML = ''
                + '<section class="link-group link-enroll">'
                + '<label class="link-field"><span>' + t('主端地址') + '</span>'
                + '<input id="linkServerUrl" type="url" placeholder="https://your-zephyr-host" spellcheck="false" autocomplete="url"></label>'
                + '<label class="link-field"><span>' + t('设备名') + '</span>'
                + '<input id="linkDeviceName" type="text" placeholder="Zephyr One" maxlength="120"></label>'
                + '<label class="settings-switch-option" for="linkAllowInsecureTls">'
                + '<span class="settings-switch-copy"><strong>' + t('允许不安全的证书') + '</strong>'
                + '<small>' + t('仅本机调试；正式环境必须是 https') + '</small></span>'
                + '<span class="connection-share-switch"><input type="checkbox" id="linkAllowInsecureTls"><span aria-hidden="true"></span></span>'
                + '</label>'
                + '<button type="button" class="btn btn-primary" id="linkBindBtn">' + t('绑定主端') + '</button>'
                + '</section>';
            return;
        }
        var qr = enrollment.qrDataUrl
            ? '<img class="link-qr" alt="" src="' + enrollment.qrDataUrl + '" width="180" height="180">'
            : '';
        status.innerHTML = ''
            + '<section class="link-group link-enroll-pending">'
            + '<p class="link-hero-phase">' + t('在系统浏览器批准这台设备') + '</p>'
            + qr
            + '<p class="link-enroll-code">' + t('短码') + ' <code>' + enrollment.userCode + '</code></p>'
            + '<p class="link-enroll-code">SAS <code>' + enrollment.sas + '</code></p>'
            + '<p class="link-enroll-code">' + t('指纹') + ' <code>' + enrollment.fingerprint + '</code></p>'
            + '<button type="button" class="btn btn-primary" id="linkOpenApproveBtn">' + t('打开批准页') + '</button>'
            + '</section>';
    }

    function collectImportDecisions() {
        var decisions = {};
        var mount = $('linkImportList');
        if (!mount) return decisions;
        var seen = {};
        mount.querySelectorAll('input[type="radio"][name^="link-import-"]').forEach(function (input) {
            var type = input.getAttribute('data-entity-type') || '';
            if (!type || seen[type]) return;
            seen[type] = true;
            var value = 'keep_local';
            mount.querySelectorAll('input[type="radio"][name="' + input.name + '"]').forEach(function (radio) {
                if (radio.checked) value = radio.value;
            });
            if (value !== 'import' && value !== 'copy_as_new') value = 'keep_local';
            decisions[type] = value;
        });
        return decisions;
    }

    function renderImportTypes(types) {
        var mount = $('linkImportList');
        if (!mount) return;
        var prev = collectImportDecisions();
        types = Array.isArray(types) ? types : [];
        if (!types.length) {
            mount.innerHTML = '';
            return;
        }
        mount.innerHTML = types.map(function (row) {
            var entityType = String(row && (row.entityType || row.type) || '');
            if (!entityType) return '';
            var count = Number(row && row.localCount) || 0;
            var selected = prev[entityType] || row.defaultAction || 'keep_local';
            if (selected !== 'import' && selected !== 'copy_as_new') selected = 'keep_local';
            var name = 'link-import-' + entityType.replace(/[^A-Za-z0-9_-]/g, '_');
            function radio(value, labelKey) {
                return '<label class="link-field"><span>'
                    + '<input type="radio" name="' + escapeHtml(name) + '" value="' + escapeHtml(value) + '"'
                    + ' data-entity-type="' + escapeHtml(entityType) + '"'
                    + (selected === value ? ' checked' : '') + '> '
                    + t(labelKey)
                    + '</span></label>';
            }
            return '<section class="link-import-type">'
                + '<p class="link-row-copy"><strong>' + escapeHtml(entityType) + '</strong>'
                + '<small>' + t('本机 {count} 条', { count: count }) + '</small></p>'
                + radio('import', '导入')
                + radio('keep_local', '仅保本地')
                + radio('copy_as_new', '副本')
                + '</section>';
        }).join('');
    }

    function loadImportPreview() {
        var panel = $('linkImportPanel');
        if (!panel || panel.hidden) return;
        var gen = ++importLoadGen;
        api('/api/one/link/import-preview').then(function (data) {
            if (gen !== importLoadGen) return;
            renderImportTypes(normalizeImportTypes(data));
        }).catch(function (err) {
            if (gen !== importLoadGen) return;
            var mount = $('linkImportList');
            if (mount && !mount.querySelector('input[name^="link-import-"]')) {
                mount.innerHTML = '<p class="gate-error">' + escapeHtml(err && err.message ? err.message : 'HTTP') + '</p>';
            }
        });
    }

    function applyImportDecisions() {
        var btn = $('linkImportApplyBtn');
        if (btn) btn.disabled = true;
        api('/api/one/link/import-apply', {
            method: 'POST',
            body: { decisions: collectImportDecisions() },
        }).then(function () {
            toast(t('应用导入决定'));
            return refresh();
        }).catch(function (err) {
            toast(err && err.message ? err.message : t('应用导入决定'));
        }).then(function () {
            if (btn) btn.disabled = false;
        });
    }

    function renderConflictCard(row) {
        var cid = conflictIdOf(row);
        var title = String(row.entityType || '') + ' · ' + String(row.entityId || row.id || cid);
        var reason = String(row.reason || '');
        var tpl = $('linkConflictCardTemplate');
        if (tpl && tpl.content && tpl.content.firstElementChild) {
            var node = tpl.content.firstElementChild.cloneNode(true);
            node.setAttribute('data-conflict-id', cid);
            var titleEl = node.querySelector('.link-conflict-title');
            var reasonEl = node.querySelector('.link-conflict-reason');
            var manualEl = node.querySelector('.link-conflict-manual');
            if (titleEl) titleEl.textContent = title;
            if (reasonEl) reasonEl.textContent = reason;
            if (manualEl) {
                manualEl.hidden = !needsManualMerge(row);
                manualEl.textContent = t('需手动合并');
            }
            node.querySelectorAll('[data-link-action]').forEach(function (btn) {
                btn.removeAttribute('id');
                btn.setAttribute('data-conflict-id', cid);
                var action = btn.getAttribute('data-link-action');
                if (action === 'keep_local') btn.textContent = t('保留本机');
                else if (action === 'keep_server') btn.textContent = t('用主端');
                else if (action === 'copy') btn.textContent = t('另存副本');
            });
            return node;
        }
        var attr = escapeHtml(cid);
        var manual = needsManualMerge(row)
            ? '<p class="field-hint link-conflict-manual">' + t('需手动合并') + '</p>'
            : '';
        return '<article class="link-conflict-card" data-conflict-id="' + attr + '">'
            + '<p class="link-row-copy"><strong>' + escapeHtml(title) + '</strong>'
            + '<small>' + escapeHtml(reason) + '</small></p>'
            + manual
            + '<button type="button" class="btn linkConflictKeepLocal" data-link-action="keep_local" data-conflict-id="' + attr + '">' + t('保留本机') + '</button>'
            + '<button type="button" class="btn linkConflictKeepServer" data-link-action="keep_server" data-conflict-id="' + attr + '">' + t('用主端') + '</button>'
            + '<button type="button" class="btn linkConflictCopy" data-link-action="copy" data-conflict-id="' + attr + '">' + t('另存副本') + '</button>'
            + '</article>';
    }

    function findConflictCard(conflictId) {
        var list = $('linkConflictList');
        if (!list) return null;
        var found = null;
        list.querySelectorAll('article.link-conflict-card').forEach(function (card) {
            if (!found && card.getAttribute('data-conflict-id') === conflictId) found = card;
        });
        return found;
    }

    function loadConflicts() {
        var list = $('linkConflictList');
        if (!list || list.hidden) return;
        var gen = ++conflictLoadGen;
        api('/api/one/link/conflicts').then(function (data) {
            if (gen !== conflictLoadGen) return;
            var rows = normalizeConflicts(data).filter(function (row) {
                return row && row.unresolved !== false;
            });
            list.innerHTML = '';
            if (!rows.length) {
                list.innerHTML = '<p class="empty-state">' + t('没有冲突') + '</p>';
            } else {
                rows.forEach(function (row) {
                    var card = renderConflictCard(row);
                    if (typeof card === 'string') list.insertAdjacentHTML('beforeend', card);
                    else list.appendChild(card);
                });
            }
            var badge = $('linkConflictBadge');
            var meta = $('linkConflictMeta');
            if (badge) {
                badge.hidden = rows.length <= 0;
                badge.textContent = rows.length > 0 ? (rows.length + ' ' + t('个冲突')) : '';
            }
            if (meta) meta.textContent = rows.length > 0 ? '' : t('没有冲突');
        }).catch(function (err) {
            if (gen !== conflictLoadGen) return;
            list.innerHTML = '<p class="gate-error">' + escapeHtml(err && err.message ? err.message : 'HTTP') + '</p>';
        });
    }

    function handleConflictAction(action, conflictId) {
        if (!conflictId) return;
        if (action !== 'keep_local' && action !== 'keep_server' && action !== 'copy') return;
        var card = findConflictCard(conflictId);
        if (card) {
            card.querySelectorAll('button').forEach(function (btn) { btn.disabled = true; });
        }
        var req = action === 'copy'
            ? api('/api/one/link/conflicts/' + encodeURIComponent(conflictId) + '/copy', { method: 'POST' })
            : api('/api/one/link/conflicts/' + encodeURIComponent(conflictId) + '/resolve', {
                method: 'POST',
                body: { resolution: action },
            });
        req.then(function () {
            toast(action === 'copy' ? t('另存副本') : (action === 'keep_local' ? t('保留本机') : t('用主端')));
            return refresh();
        }).catch(function (err) {
            toast(err && err.message ? err.message : t('冲突'));
            if (card) {
                card.querySelectorAll('button').forEach(function (btn) { btn.disabled = false; });
            }
            refresh().catch(function () {});
        });
    }

    function applyState(state) {
        state = state || {};
        lastState = state;
        var bound = !!state.bound;
        var waiting = !!state.enrollment;
        renderEnrollment(state);

        setHidden($('linkSyncSettings'), false);
        setHidden($('linkStatusLabel'), false);
        setHidden($('linkStatusGroup'), false);
        setHidden($('linkPolicyLabel'), false);
        setHidden($('linkFilterBar'), false);
        setHidden($('linkPolicyGroup'), false);
        setHidden($('linkShares'), true);
        setHidden($('linkBindRow'), bound || waiting);
        setHidden($('linkUnbindBtn'), !bound);

        var auto = $('linkAutoSyncToggle');
        if (auto) {
            auto.checked = bound ? state.automaticEnabled !== false : false;
            auto.disabled = !bound;
        }
        var autoRow = $('linkAutoSyncToggleRow');
        if (autoRow) {
            autoRow.checked = bound ? state.automaticEnabled !== false : false;
            autoRow.disabled = !bound;
        }
        var interval = $('linkIntervalSelect');
        if (interval) {
            var sec = String(state.intervalSec || 300);
            if (!Array.prototype.some.call(interval.options, function (o) { return o.value === sec; })) {
                if (INTERVALS.indexOf(Number(sec)) === -1) interval.value = '300';
            } else {
                interval.value = sec;
            }
        }
        var policy = $('linkNetworkPolicySelect');
        if (policy) policy.value = state.networkPolicy === 'wifiOnly' ? 'wifiOnly' : 'any';

        var phase = $('linkSyncStatus');
        if (phase) phase.textContent = phaseOf(state);
        var sub = $('linkSyncSub');
        if (sub) sub.textContent = subOf(state);
        var pending = $('linkPendingText');
        if (pending) {
            var parts = [t('待推送 {count}', { count: Number(state.pendingCount) || 0 })];
            if (state.lastErrorCode) parts.push(state.lastErrorCode);
            pending.textContent = parts.join(' · ');
        }
        var progress = $('linkSyncProgress');
        if (progress) progress.style.transform = state.running ? 'scaleX(.55)' : 'scaleX(0)';
        var hero = $('linkSyncSettings');
        if (hero) hero.classList.toggle('is-running', !!state.running);
        if (hero) hero.classList.toggle('is-error', !!(state.lastError && !state.running));
        var nowBtn = $('linkSyncNowBtn');
        if (nowBtn) {
            nowBtn.disabled = !bound || !!state.running || !!state.importDecisionRequired;
            nowBtn.title = state.importDecisionRequired ? t('先完成导入决定') : '';
        }

        var conflictBadge = $('linkConflictBadge');
        var conflictMeta = $('linkConflictMeta');
        var conflictCount = Number(state.conflictCount) || 0;
        if (conflictBadge) {
            conflictBadge.hidden = conflictCount <= 0;
            conflictBadge.textContent = conflictCount > 0 ? (conflictCount + ' ' + t('个冲突')) : '';
        }
        if (conflictMeta) conflictMeta.textContent = conflictCount > 0 ? '' : t('没有冲突');
        if (openSection === 'conflicts') loadConflicts();

        var importPanel = $('linkImportPanel');
        if (importPanel) {
            var needImport = bound && !!state.importDecisionRequired;
            setHidden(importPanel, !needImport);
            if (needImport) {
                var mount = $('linkImportList');
                if (mount && !mount.querySelector('input[name^="link-import-"]')) {
                    renderImportTypes(normalizeImportTypes(state.importPreview));
                }
                loadImportPreview();
            } else {
                importLoadGen += 1;
                var importList = $('linkImportList');
                if (importList) importList.innerHTML = '';
            }
        }

        var deviceMeta = $('linkDeviceMeta');
        if (deviceMeta) deviceMeta.textContent = bound ? t('本机与已绑定设备') : t('未绑定 · 只显示本机');
        var deviceList = $('linkDeviceList');
        if (deviceList && !deviceList.hidden) {
            deviceList.innerHTML = bound
                ? '<div class="link-device-row"><strong>' + (state.deviceName || 'Zephyr One') + '</strong>'
                    + '<span class="muted"> · ' + (state.platform || '') + ' · ' + t('本机') + '</span></div>'
                : '<p class="empty-state">' + t('未绑定') + '</p>';
        }

        var diag = $('linkDiagnosticsText');
        if (diag) {
            if (!bound) diag.textContent = t('本机模式 · 无同步会话');
            else if (state.lastErrorCode) diag.textContent = state.lastErrorCode;
            else if (state.lastSuccessAt) diag.textContent = t('最近同步成功') + ' · cursor ' + (state.appliedCursor || 0);
            else diag.textContent = t('幂等 / 墓碑 / secret envelope');
        }

        enhanceSelects();
        return waiting;
    }

    var pollTimer = 0;
    var openSection = '';

    function stopPoll() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = 0;
    }

    function startPoll() {
        stopPoll();
        pollTimer = setInterval(function () {
            api('/api/one/link/enroll/status').then(function (state) {
                var waiting = applyState(state);
                if (!waiting) stopPoll();
            }).catch(function () {});
        }, POLL_MS);
    }

    async function refresh() {
        var state = await api('/api/one/link/state');
        var waiting = applyState(state);
        if (waiting) startPoll();
        else stopPoll();
        return state;
    }

    function toast(message) {
        if (typeof window.toast === 'function') window.toast(message);
    }

    function patchSettings() {
        return api('/api/one/link/settings', {
            method: 'PUT',
            body: {
                automaticEnabled: !!($('linkAutoSyncToggle') && $('linkAutoSyncToggle').checked),
                intervalSec: Number($('linkIntervalSelect') && $('linkIntervalSelect').value) || 300,
                networkPolicy: ($('linkNetworkPolicySelect') && $('linkNetworkPolicySelect').value) || 'any',
            },
        }).then(applyState).catch(function (err) {
            toast(err.message);
        });
    }

    function toggleSection(name) {
        var panels = {
            conflicts: $('linkConflictList'),
            devices: $('linkDeviceList'),
        };
        var next = openSection === name ? '' : name;
        openSection = next;
        Object.keys(panels).forEach(function (key) {
            setHidden(panels[key], key !== next);
        });
        if (next) refresh().catch(function () {});
    }

    function wire() {
        var panel = $('settings-link');
        if (!panel || panel.dataset.linkUiWired === '1') return;
        panel.dataset.linkUiWired = '1';
        panel.addEventListener('click', function (event) {
            var actionEl = event.target && event.target.closest && event.target.closest('[data-link-action]');
            if (actionEl && panel.contains(actionEl)) {
                handleConflictAction(actionEl.getAttribute('data-link-action'), actionEl.getAttribute('data-conflict-id'));
                return;
            }
            var id = event.target && event.target.closest && event.target.closest('[id]') && event.target.closest('[id]').id;
            if (id === 'linkBindBtn' || id === 'linkBindRow') {
                if (id === 'linkBindRow' && !$('linkServerUrl')) {
                    var status = $('linkBindStatus');
                    if (status) status.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                    return;
                }
                var url = ($('linkServerUrl') && $('linkServerUrl').value || '').trim();
                var deviceName = ($('linkDeviceName') && $('linkDeviceName').value || '').trim();
                var insecure = !!($('linkAllowInsecureTls') && $('linkAllowInsecureTls').checked);
                api('/api/one/link/enroll', {
                    method: 'POST',
                    body: {
                        serverUrl: url,
                        deviceName: deviceName,
                        allowInsecureTls: insecure,
                    },
                }).then(function (state) {
                    applyState(state);
                    startPoll();
                    if (state.enrollment && state.enrollment.verificationUri) {
                        window.open(state.enrollment.verificationUri, '_blank', 'noopener');
                    }
                }).catch(function (err) {
                    toast(t('绑定失败：{message}', { message: err.message }));
                });
            }
            if (id === 'linkOpenApproveBtn') {
                api('/api/one/link/state').then(function (state) {
                    if (state.enrollment && state.enrollment.verificationUri) {
                        window.open(state.enrollment.verificationUri, '_blank', 'noopener');
                    }
                }).catch(function () {});
            }
            if (id === 'linkSyncNowBtn') {
                if (lastState && lastState.importDecisionRequired) {
                    toast(t('先完成导入决定'));
                    return;
                }
                var btn = $('linkSyncNowBtn');
                if (btn) btn.disabled = true;
                api('/api/one/link/sync', { method: 'POST' }).then(function (state) {
                    applyState(state);
                    toast(state.lastError ? t('同步失败：{message}', { message: state.lastError }) : t('同步已触发'));
                }).catch(function (err) {
                    toast(t('同步失败：{message}', { message: err.message }));
                    refresh().catch(function () {});
                });
            }
            if (id === 'linkImportApplyBtn') {
                applyImportDecisions();
            }
            if (id === 'linkUnbindBtn') {
                if (!window.confirm(t('解绑后本机镜像会停止同步。确定？'))) return;
                api('/api/one/link/unbind', { method: 'POST' }).then(applyState).catch(function (err) {
                    toast(err.message);
                });
            }
            if (id === 'linkConflicts') toggleSection('conflicts');
            if (id === 'linkDevices') toggleSection('devices');
        });
        panel.addEventListener('change', function (event) {
            var id = event.target && event.target.id;
            if (id === 'linkAutoSyncToggle' || id === 'linkAutoSyncToggleRow') {
                var on = !!event.target.checked;
                if ($('linkAutoSyncToggle')) $('linkAutoSyncToggle').checked = on;
                if ($('linkAutoSyncToggleRow')) $('linkAutoSyncToggleRow').checked = on;
                patchSettings();
            }
            if (id === 'linkIntervalSelect' || id === 'linkNetworkPolicySelect') patchSettings();
        });
        refresh().catch(function (err) {
            var status = $('linkBindStatus');
            if (status) {
                setHidden(status, false);
                status.innerHTML = '<p class="gate-error">' + t('加载失败：{message}', { message: err.message }) + '</p>';
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wire);
    } else {
        wire();
    }
})();
