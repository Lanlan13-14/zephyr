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

    function intervalLabel(seconds) {
        var n = Number(seconds) || 300;
        if (n < 60) return n + ' ' + t('秒');
        if (n % 60 === 0) return (n / 60) + ' ' + t('分钟');
        return n + ' ' + t('秒');
    }

    function phaseOf(state) {
        if (state.running) return t('正在同步');
        if (state.lastError) return t('同步失败') + ' · ' + state.lastError;
        if (state.conflictCount > 0) return t('需要处理冲突');
        if (state.lastSuccessAt) return t('镜像已同步');
        if (state.bound) return t('镜像待同步');
        return t('未绑定主端 · 本机工作区可离线使用');
    }

    function subOf(state) {
        if (!state.bound) return t('未绑定主端 · 本机工作区可离线使用');
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

    function applyState(state) {
        state = state || {};
        var bound = !!state.bound;
        var waiting = !!state.enrollment;
        renderEnrollment(state);

        setHidden($('linkSyncSettings'), false);
        setHidden($('linkStatusLabel'), false);
        setHidden($('linkStatusGroup'), false);
        setHidden($('linkPolicyLabel'), false);
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
        if (nowBtn) nowBtn.disabled = !bound || !!state.running;

        var conflictBadge = $('linkConflictBadge');
        var conflictMeta = $('linkConflictMeta');
        var conflictCount = Number(state.conflictCount) || 0;
        if (conflictBadge) {
            conflictBadge.hidden = conflictCount <= 0;
            conflictBadge.textContent = conflictCount > 0 ? (conflictCount + ' ' + t('个冲突')) : '';
        }
        if (conflictMeta) conflictMeta.textContent = conflictCount > 0 ? '' : t('没有冲突');
        var conflictList = $('linkConflictList');
        if (conflictList && !conflictList.hidden) {
            conflictList.innerHTML = conflictCount
                ? '<p class="field-hint">' + conflictCount + ' ' + t('个冲突') + '</p>'
                : '<p class="empty-state">' + t('没有冲突') + '</p>';
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
