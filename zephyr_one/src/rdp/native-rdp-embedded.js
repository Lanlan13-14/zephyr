/* Zephyr One embedded RDP surface. Runs only in the staged local core. */
(function nativeRdpEmbeddedSurface() {
    'use strict';

    var CHANNEL = 'zephyr-one-native-rdp-v1';
    var REQUEST_DIRECTION = 'embedded-to-shell';
    var RESPONSE_DIRECTION = 'shell-to-embedded';
    var NATIVE_MARKER = 'zephyr-one-native-rdp';
    var WEB_RDP_PATH = '/rdp' + '.html';
    var blockedFrames = new WeakMap();
    var sessions = new Map();
    var pending = new Map();
    var sequence = 0;

    function requestId() {
        if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
            return globalThis.crypto.randomUUID();
        }
        sequence += 1;
        return 'native-rdp-' + Date.now().toString(36) + '-' + sequence.toString(36);
    }

    function parentAvailable() {
        return window.parent && window.parent !== window;
    }

    function tauriInvoke(command, args) {
        var invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
        if (typeof invoke !== 'function') {
            return Promise.reject(new Error('Native RDP requires the Zephyr One desktop runtime.'));
        }
        return invoke(command, args || {});
    }

    function directRequest(action, payload) {
        return tauriInvoke('rdp_bridge', { request: { action: action, payload: payload || {} } });
    }

    function shellRequest(action, payload, timeoutMs) {
        if (!parentAvailable()) {
            return directRequest(action, payload);
        }
        var id = requestId();
        return new Promise(function (resolve, reject) {
            var timeout = window.setTimeout(function () {
                pending.delete(id);
                reject(new Error('Native RDP shell did not respond.'));
            }, timeoutMs || 15000);
            pending.set(id, { resolve: resolve, reject: reject, timeout: timeout });
            window.parent.postMessage({
                channel: CHANNEL,
                direction: REQUEST_DIRECTION,
                requestId: id,
                action: action,
                payload: payload || {},
            }, '*');
        });
    }

    window.addEventListener('message', function (event) {
        if (event.source !== window.parent) return;
        var message = event.data;
        if (!message || message.channel !== CHANNEL || message.direction !== RESPONSE_DIRECTION) return;
        var request = pending.get(String(message.requestId || ''));
        if (!request) return;
        pending.delete(message.requestId);
        window.clearTimeout(request.timeout);
        if (message.ok) request.resolve(message.result);
        else request.reject(new Error(message.error && message.error.message || 'Native RDP failed.'));
    });

    function intentFromUrl(value) {
        var raw = String(value || '');
        if (!raw) return null;
        try {
            var url = new URL(raw, location.href);
            if (url.pathname === WEB_RDP_PATH) {
                return { raw: raw, params: url.searchParams };
            }
            var hash = String(url.hash || '');
            if (hash.indexOf('#' + NATIVE_MARKER) === 0) {
                var queryAt = hash.indexOf('?');
                return {
                    raw: raw,
                    params: new URLSearchParams(queryAt >= 0 ? hash.slice(queryAt + 1) : ''),
                };
            }
        } catch (_) { /* not an RDP URL */ }
        return null;
    }

    /* Install before app.js (a module script) executes. A browser RDP iframe is
     * converted to an inert marker before WebView can issue the navigation. */
    function blockBrowserRdpNavigation() {
        var descriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
        if (!descriptor || typeof descriptor.set !== 'function' || descriptor.configurable === false) return;
        Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
            configurable: descriptor.configurable,
            enumerable: descriptor.enumerable,
            get: descriptor.get,
            set: function (value) {
                var intent = intentFromUrl(value);
                if (intent) {
                    blockedFrames.set(this, intent);
                    descriptor.set.call(this, 'about:blank#' + NATIVE_MARKER);
                    return;
                }
                descriptor.set.call(this, value);
            },
        });
    }

    function dimensions(resolution, panel) {
        var presets = {
            '1080p': [1920, 1080],
            '2K': [2560, 1440],
            '4K': [3840, 2160],
            '8K': [7680, 4320],
        };
        if (presets[resolution]) return { width: presets[resolution][0], height: presets[resolution][1] };
        var rect = panel.getBoundingClientRect();
        var width = Math.max(800, Math.min(3840, Math.round(rect.width || window.innerWidth || 1280)));
        var height = Math.max(600, Math.min(2160, Math.round(width * 9 / 16)));
        return { width: width, height: height };
    }

    function geometryForOpen(view) {
        /* The workspace window the user sees is a floating rounded-corner card.
         * An initial corner/backing-store color fill that only the client area
         * would repaint would shine through those corners, so the native window
         * is told to paint them before the first frame arrives. */
        var size = dimensions('auto', view.panel);
        var style = window.getComputedStyle ? window.getComputedStyle(view.panel) : null;
        var radius = 0;
        var backdrop = '#101114';
        if (style) {
            var parsed = parseFloat(style.borderTopLeftRadius);
            if (isFinite(parsed)) radius = parsed;
            if (style.backgroundColor) backdrop = style.backgroundColor;
        }
        return {
            width: size.width,
            height: size.height,
            cornerRadius: radius,
            backdropColor: backdrop,
        };
    }

    function notifyAppStatus(sessionId, status) {
        window.postMessage({ source: 'zephyr-terminal', tabId: sessionId, status: status }, location.origin);
    }

    function latestEvent(result) {
        var events = result && result.session && Array.isArray(result.session.events)
            ? result.session.events : [];
        return events.length ? String(events[events.length - 1]) : '';
    }

    function setPanelState(view, phase, message, error) {
        view.panel.dataset.state = phase;
        view.panel.setAttribute('aria-busy', phase === 'checking' || phase === 'connecting' ? 'true' : 'false');
        view.status.textContent = message || '';
        view.error.hidden = !error;
        view.error.textContent = error || '';
        view.show.disabled = phase === 'checking' || phase === 'connecting' || phase === 'closed' || phase === 'error';
        view.focus.disabled = view.show.disabled;
        /* CAD only has a target once the wire is up. */
        view.cad.disabled = phase !== 'connected';
        view.close.disabled = phase === 'checking' || phase === 'connecting' || phase === 'closed';
        view.retry.hidden = phase !== 'closed' && phase !== 'error' && phase !== 'disconnected';
        notifyAppStatus(view.sessionId, phase === 'connected' ? 'connected' : phase === 'error' ? 'error' : phase);
    }

    function updateFromSnapshot(view, result) {
        var phase = result && result.phase || 'disconnected';
        if (phase === 'connected') {
            setPanelState(view, phase, 'Connected in a native FreeRDP window.', '');
        } else if (phase === 'connecting') {
            setPanelState(view, phase, 'Negotiating the native RDP session...', '');
        } else if (phase === 'closed') {
            setPanelState(view, phase, 'The native RDP window is closed.', '');
        } else if (phase === 'disconnected') {
            /* An auth/negotiation failure after the broker approved the open
             * lands here: the surface exists but the session never went live.
             * Reconnect is a legitimate reaction, so the panel stays instead
             * of blanking the workspace window. */
            var detail = latestEvent(result);
            setPanelState(view, 'disconnected', 'The native RDP session ended.', detail);
        } else {
            /* surface-detached or a phase this client does not know: do not
             * claim the session is over; keep polling for the next snapshot. */
            setPanelState(view, 'disconnected', 'The native RDP surface is unavailable.', '');
        }
    }

    function createButton(label, className) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = className || 'zephyr-one-rdp-button';
        button.textContent = label;
        return button;
    }

    /* One panel action row ↔ main-end rdp.html topbar tool. The native session
     * has no WASM canvas to embed, so the matching capability is a shell
     * command on the owner-checked session rather than an in-page widget. */
    var TOOL_BAR = [
        { label: 'Focus', action: 'focus', icon: 'fit' },
        { label: 'Ctrl+Alt+Del', action: 'cad', icon: 'security' },
        { label: 'Reconnect', action: 'retry', icon: 'reconnect' },
        { label: 'Close session', action: 'close', icon: 'disconnect', danger: true },
    ];

    function createPanel(sessionId, connectionId, title) {
        var panel = document.createElement('section');
        panel.className = 'terminal-frame zephyr-one-native-rdp';
        panel.dataset.frame = sessionId;
        panel.dataset.state = 'checking';
        panel.setAttribute('aria-label', 'Native RDP session');
        panel.setAttribute('aria-busy', 'true');

        var content = document.createElement('div');
        content.className = 'zephyr-one-rdp-content';
        var eyebrow = document.createElement('span');
        eyebrow.className = 'zephyr-one-rdp-eyebrow';
        eyebrow.textContent = 'FreeRDP';
        var heading = document.createElement('h3');
        heading.textContent = title || 'Remote Desktop';
        var status = document.createElement('p');
        status.className = 'zephyr-one-rdp-status';
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        status.setAttribute('aria-atomic', 'true');
        status.textContent = 'Checking native RDP support...';
        var error = document.createElement('p');
        error.className = 'zephyr-one-rdp-error';
        error.setAttribute('role', 'alert');
        error.setAttribute('aria-atomic', 'true');
        error.hidden = true;
        var actions = document.createElement('div');
        actions.className = 'zephyr-one-rdp-actions';
        var show = createButton('Show window');
        var focus = createButton('Focus');
        var cad = createButton('Ctrl+Alt+Del');
        var retry = createButton('Reconnect', 'zephyr-one-rdp-button zephyr-one-rdp-primary');
        var close = createButton('Close session', 'zephyr-one-rdp-button zephyr-one-rdp-danger');
        retry.hidden = true;
        cad.disabled = true;
        show.disabled = true;
        focus.disabled = true;
        close.disabled = true;
        actions.append(show, focus, cad, retry, close);
        content.append(eyebrow, heading, status, error, actions);
        panel.appendChild(content);

        var view = {
            panel: panel,
            content: content,
            status: status,
            error: error,
            show: show,
            focus: focus,
            cad: cad,
            retry: retry,
            close: close,
            sessionId: sessionId,
            connectionId: connectionId,
            pollTimer: 0,
            opening: false,
            disposed: false,
        };
        Object.defineProperty(panel, '__zephyrNativeRdpBridge', {
            configurable: false,
            enumerable: false,
            value: Object.freeze({
                snapshot: function (options) {
                    return shellRequest('capture', {
                        sessionId: sessionId,
                        maxWidth: Number(options && options.maxWidth) || 960,
                    }, 15000).then(function (capture) {
                        return Object.assign({
                            tabId: sessionId,
                            connectionId: connectionId,
                            protocol: 'RDP',
                            status: view.panel.dataset.state || '',
                            connected: view.panel.dataset.state === 'connected',
                        }, capture || {});
                    });
                },
                action: function (input) {
                    return shellRequest('input', Object.assign({}, input || {}, {
                        sessionId: sessionId,
                    }), 15000);
                },
            }),
        });
        return view;
    }

    function schedulePoll(view) {
        window.clearTimeout(view.pollTimer);
        if (view.disposed || !sessions.has(view.sessionId)) return;
        view.pollTimer = window.setTimeout(function () {
            shellRequest('status', { sessionId: view.sessionId }, 8000).then(function (result) {
                updateFromSnapshot(view, result);
                if (result && result.phase !== 'closed') schedulePoll(view);
            }).catch(function (error) {
                setPanelState(view, 'error', 'Unable to read native RDP status.', error.message);
            });
        }, 1200);
    }

    function openSession(view) {
        if (view.opening || view.disposed) return;
        view.opening = true;
        setPanelState(view, 'checking', 'Checking native FreeRDP support...', '');
        shellRequest('capabilities', {}, 8000).then(function (caps) {
            if (!caps || !caps.available) {
                throw new Error(caps && caps.reason || 'Native FreeRDP is unavailable in this build.');
            }
            setPanelState(view, 'connecting', 'Opening the native RDP session...', '');
            var geometry = geometryForOpen(view);
            return shellRequest('open', {
                sessionId: view.sessionId,
                connectionId: view.connectionId,
                width: geometry.width,
                height: geometry.height,
                dpi: Math.max(72, Math.min(480, Math.round((window.devicePixelRatio || 1) * 96))),
                cornerRadius: geometry.cornerRadius,
                backdropColor: geometry.backdropColor,
                title: view.title,
            }, 120000);
        }).then(function (result) {
            updateFromSnapshot(view, result);
            schedulePoll(view);
        }).catch(function (error) {
            setPanelState(view, 'error', 'Native RDP could not start.', error.message);
        }).finally(function () {
            view.opening = false;
        });
    }

    function wirePanel(view) {
        view.show.addEventListener('click', function () {
            view.show.disabled = true;
            shellRequest('show', { sessionId: view.sessionId }).then(function (result) {
                updateFromSnapshot(view, result);
            }).catch(function (error) {
                setPanelState(view, 'error', 'Unable to show the native RDP window.', error.message);
            });
        });
        view.focus.addEventListener('click', function () {
            view.focus.disabled = true;
            shellRequest('focus', { sessionId: view.sessionId }).then(function (result) {
                updateFromSnapshot(view, result);
            }).catch(function (error) {
                setPanelState(view, 'error', 'The operating system denied window focus.', error.message);
            });
        });
        view.cad.addEventListener('click', function () {
            view.cad.disabled = true;
            shellRequest('input', {
                sessionId: view.sessionId,
                captureId: '',
                control: 'ctrl_alt_del',
            }).then(function (result) {
                updateFromSnapshot(view, result);
            }).catch(function (error) {
                setPanelState(view, 'error', 'Unable to send Ctrl+Alt+Del.', error.message);
            });
        });
        view.retry.addEventListener('click', function () { openSession(view); });
        view.close.addEventListener('click', function () {
            view.close.disabled = true;
            setPanelState(view, 'connecting', 'Closing the native RDP session...', '');
            shellRequest('close', { sessionId: view.sessionId }).then(function () {
                setPanelState(view, 'closed', 'The native RDP session is closed.', '');
            }).catch(function (error) {
                setPanelState(view, 'error', 'Unable to close the native RDP session.', error.message);
            });
        });
    }

    function replaceFrame(frame) {
        if (!(frame instanceof HTMLIFrameElement) || frame.dataset.zephyrOneNativeHandled === 'true') return;
        var intent = blockedFrames.get(frame) || intentFromUrl(frame.getAttribute('src'));
        if (!intent) return;
        frame.dataset.zephyrOneNativeHandled = 'true';
        var sessionId = String(intent.params.get('tabId') || frame.dataset.frame || '').trim();
        var connectionId = String(intent.params.get('connectionId') || '').trim();
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) || !connectionId) {
            var invalid = document.createElement('div');
            invalid.className = 'terminal-frame zephyr-one-native-rdp zephyr-one-rdp-invalid';
            invalid.dataset.frame = sessionId;
            invalid.setAttribute('role', 'alert');
            invalid.textContent = 'Native RDP cannot start because the session metadata is invalid.';
            frame.replaceWith(invalid);
            return;
        }
        var view = createPanel(sessionId, connectionId, 'Remote Desktop');
        view.title = 'Zephyr One Remote Desktop';
        sessions.set(sessionId, view);
        wirePanel(view);
        frame.replaceWith(view.panel);
        openSession(view);
    }

    function closeRemovedSessions(node) {
        if (!(node instanceof Element)) return;
        var panels = node.matches('.zephyr-one-native-rdp')
            ? [node] : Array.from(node.querySelectorAll('.zephyr-one-native-rdp'));
        panels.forEach(function (panel) {
            var sessionId = String(panel.dataset.frame || '');
            var view = sessions.get(sessionId);
            if (!view || view.panel !== panel) return;
            view.disposed = true;
            window.clearTimeout(view.pollTimer);
            sessions.delete(sessionId);
            shellRequest('close', { sessionId: sessionId }, 5000).catch(function () {});
        });
    }

    function scan(node) {
        if (!(node instanceof Element)) return;
        if (node.matches('iframe.terminal-frame')) replaceFrame(node);
        node.querySelectorAll('iframe.terminal-frame').forEach(replaceFrame);
    }

    function installStyles() {
        if (document.getElementById('zephyrOneNativeRdpStyles')) return;
        var style = document.createElement('style');
        style.id = 'zephyrOneNativeRdpStyles';
        style.textContent = [
            '.zephyr-one-native-rdp{display:grid;place-items:center;width:100%;height:100%;min-height:240px;padding:24px;background:var(--bg-primary,#101114);color:var(--text-primary,#f5f7fa);overflow:auto}',
            '.zephyr-one-rdp-content{width:min(520px,100%);display:grid;gap:12px;text-align:left}',
            '.zephyr-one-rdp-eyebrow{font-size:12px;font-weight:700;color:var(--accent,#68a8ff)}',
            '.zephyr-one-rdp-content h3{margin:0;font-size:20px;line-height:1.3;letter-spacing:0}',
            '.zephyr-one-rdp-status,.zephyr-one-rdp-error{margin:0;font-size:14px;line-height:1.5;overflow-wrap:anywhere}',
            '.zephyr-one-rdp-status{color:var(--text-secondary,#aeb5c0)}',
            '.zephyr-one-rdp-error{color:var(--danger,#ff7b7b)}',
            '.zephyr-one-rdp-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}',
            '.zephyr-one-rdp-button{min-height:36px;padding:7px 12px;border:1px solid var(--border,#3a3f48);border-radius:6px;background:var(--bg-secondary,#1a1d22);color:inherit;font:inherit;cursor:pointer;transition:transform 120ms cubic-bezier(.23,1,.32,1),border-color 120ms ease}',
            '.zephyr-one-rdp-button:active:not(:disabled){transform:scale(.98)}',
            '.zephyr-one-rdp-button:focus-visible{outline:2px solid var(--accent,#68a8ff);outline-offset:2px}',
            '.zephyr-one-rdp-button:disabled{cursor:default;opacity:.5}',
            '.zephyr-one-rdp-primary{border-color:var(--accent,#68a8ff)}',
            '.zephyr-one-rdp-danger{color:var(--danger,#ff7b7b)}',
            '.zephyr-one-rdp-invalid{color:var(--danger,#ff7b7b);overflow-wrap:anywhere}',
            '@media (prefers-reduced-motion:reduce){.zephyr-one-rdp-button{transition:none}.zephyr-one-rdp-button:active:not(:disabled){transform:none}}',
        ].join('');
        document.head.appendChild(style);
    }

    blockBrowserRdpNavigation();
    installStyles();
    scan(document.body);
    new MutationObserver(function (mutations) {
        mutations.forEach(function (mutation) {
            mutation.addedNodes.forEach(scan);
            mutation.removedNodes.forEach(closeRemovedSessions);
        });
    }).observe(document.body, { childList: true, subtree: true });
}());
