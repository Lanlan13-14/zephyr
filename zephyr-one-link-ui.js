/*
 * zephyr-one-link-ui.js — Zephyr Link settings overlay for desktop One.
 *
 * Injected only in embedded mode. Aligns the existing #settings-link panel
 * with Android One: browser enrollment, automatic interval, network policy,
 * immediate sync, devices, conflicts and diagnostics. No password, TOTP or
 * Client Token is collected here.
 */
'use strict';

(function () {
    var POLL_MS = 1000;

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
        if (n < 60) return n + ' 秒';
        if (n % 60 === 0) return (n / 60) + ' 分钟';
        return n + ' 秒';
    }

    function phaseOf(state) {
        if (state.running) return t('正在同步');
        if (state.lastError) return t('同步失败') + ' · ' + state.lastError;
        if (state.conflictCount > 0) return t('需要处理冲突');
        if (state.lastSuccessAt) return t('镜像已同步');
        if (state.bound) return t('镜像待同步');
        return t('未绑定主端 · 本机工作区可离线使用');
    }

    function hide(el, on) {
        if (!el) return;
        el.style.display = on ? 'none' : '';
    }

    function renderEnrollment(state) {
        var status = $('linkBindStatus');
        if (!status) return;
        var enrollment = state.enrollment;
        if (!enrollment) {
            status.innerHTML = '<p class="empty-state">' + t('未绑定') + '</p>'
                + '<div class="form-group"><label for="linkServerUrl">' + t('主端地址') + '</label>'
                + '<input id="linkServerUrl" type="url" placeholder="https://your-zephyr-host" spellcheck="false"></div>'
                + '<div class="form-group"><label for="linkDeviceName">' + t('设备名') + '</label>'
                + '<input id="linkDeviceName" type="text" placeholder="Zephyr One"></div>'
                + '<label class="z-check"><input type="checkbox" id="linkAllowInsecureTls"><span>' + t('允许不安全的证书') + '</span></label>'
                + '<button type="button" class="btn btn-primary" id="linkBindBtn">' + t('绑定主端') + '</button>';
            return;
        }
        var qr = enrollment.qrDataUrl
            ? '<img alt="QR" src="' + enrollment.qrDataUrl + '" width="180" height="180" style="border-radius:12px;background:#fff;padding:8px">'
            : '';
        status.innerHTML = '<p class="field-hint">' + t('在系统浏览器批准这台设备') + '</p>'
            + qr
            + '<p class="field-hint">' + t('短码') + ' <code>' + enrollment.userCode + '</code></p>'
            + '<p class="field-hint">SAS <code>' + enrollment.sas + '</code></p>'
            + '<p class="field-hint">' + t('指纹') + ' <code>' + enrollment.fingerprint + '</code></p>'
            + '<button type="button" class="btn btn-primary" id="linkOpenApproveBtn">' + t('打开批准页') + '</button>';
    }

    function renderBound(state) {
        var status = $('linkBindStatus');
        if (!status) return;
        status.innerHTML = '<p class="field-hint">' + t('已绑定 {user}', { user: state.username || state.userId || '' }) + '</p>'
            + '<p class="field-hint">' + phaseOf(state) + '</p>';
    }

    function renderDevices(state) {
        var list = $('linkDeviceList');
        if (!list) return;
        if (!state.bound) {
            list.innerHTML = '';
            return;
        }
        list.innerHTML = '<div class="one-client-row"><strong>' + (state.deviceName || 'Zephyr One') + '</strong>'
            + '<span class="muted"> · ' + (state.platform || '') + ' · ' + t('本机') + '</span></div>';
    }

    function renderDiagnostics(state) {
        var text = $('linkDiagnosticsText');
        if (!text) return;
        if (!state.bound) {
            text.textContent = t('本机模式 · 无同步会话');
            return;
        }
        var parts = [
            state.lastErrorCode || (state.lastSuccessAt ? t('最近同步成功') : t('等待首次同步')),
            'cursor ' + (state.appliedCursor || 0),
        ];
        text.textContent = parts.join(' · ');
    }

    function applyState(state) {
        var bound = !!(state && state.bound);
        var waiting = !!(state && state.enrollment);
        if (bound) renderBound(state);
        else renderEnrollment(state);
        hide($('linkSyncSettings'), !bound);
        hide($('linkDevices'), !bound);
        hide($('linkShares'), true);
        hide($('linkConflicts'), !bound);
        hide($('linkDiagnostics'), !bound);
        if (bound) {
            var auto = $('linkAutoSyncToggle');
            if (auto) auto.checked = state.automaticEnabled !== false;
            var interval = $('linkIntervalSelect');
            if (interval) interval.value = String(state.intervalSec || 300);
            var policy = $('linkNetworkPolicySelect');
            if (policy) policy.value = state.networkPolicy === 'wifiOnly' ? 'wifiOnly' : 'any';
            var hint = $('linkSyncStatus');
            if (hint) hint.textContent = phaseOf(state);
        }
        renderDevices(state);
        renderDiagnostics(state);
        var conflicts = $('linkConflictList');
        if (conflicts) {
            conflicts.innerHTML = state.conflictCount
                ? '<p class="field-hint">' + state.conflictCount + ' ' + t('个冲突') + '</p>'
                : '<p class="empty-state">' + t('没有冲突') + '</p>';
        }
        return waiting;
    }

    var pollTimer = 0;

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

    function wire() {
        var panel = $('settings-link');
        if (!panel || panel.dataset.linkUiWired === '1') return;
        panel.dataset.linkUiWired = '1';
        panel.addEventListener('click', function (event) {
            var id = event.target && event.target.id;
            if (id === 'linkBindBtn') {
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
                api('/api/one/link/sync', { method: 'POST' }).then(function (state) {
                    applyState(state);
                    toast(t('同步已触发'));
                }).catch(function (err) {
                    toast(t('同步失败：{message}', { message: err.message }));
                });
            }
        });
        panel.addEventListener('change', function (event) {
            var id = event.target && event.target.id;
            if (id === 'linkAutoSyncToggle' || id === 'linkIntervalSelect' || id === 'linkNetworkPolicySelect') {
                api('/api/one/link/settings', {
                    method: 'PUT',
                    body: {
                        automaticEnabled: !($('linkAutoSyncToggle') && !$('linkAutoSyncToggle').checked),
                        intervalSec: Number($('linkIntervalSelect') && $('linkIntervalSelect').value) || 300,
                        networkPolicy: ($('linkNetworkPolicySelect') && $('linkNetworkPolicySelect').value) || 'any',
                    },
                }).then(applyState).catch(function (err) {
                    toast(err.message);
                });
            }
        });
        refresh().catch(function (err) {
            var status = $('linkBindStatus');
            if (status) status.innerHTML = '<p class="gate-error">' + t('加载失败：{message}', { message: err.message }) + '</p>';
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wire);
    } else {
        wire();
    }
})();
