/*
 * zephyr-one-recovery.js - Zephyr One session self-repair.
 *
 * Zephyr One only. Served at /zephyr-one-recovery.js and loaded by the tiny
 * document the core returns for "/" when no valid embedded session exists.
 *
 * Why it exists: the WebView can outlive the local core. A restarted core has
 * an empty in-memory capability set, so the WebView's old zephyr_sid is dead
 * and the startup challenge is already spent - neither "/" nor "/app.html"
 * can be satisfied, and they redirect to each other forever. This page breaks
 * the loop instead of bouncing.
 *
 * Order of attempts, cheapest first:
 *   1. POST /__zephyr_one/recover  - swap a still-valid (but capability-less)
 *      session for a fresh one. No shell involvement, works for pure
 *      in-memory capability loss.
 *   2. zephyr-one:restart          - ask the Tauri shell to restart the core
 *      and re-provision from scratch. The iframe cannot invoke Tauri commands
 *      from the loopback origin, so it posts to the trusted shell document.
 */
'use strict';

(function () {
    var RETRY_DELAY_MS = 1500;
    var RESTART_TIMEOUT_MS = 20000;
    var restarting = false;
    var timer = null;

    function show(text) {
        var el = document.getElementById('msg');
        if (!el) {
            el = document.createElement('p');
            el.id = 'msg';
            el.style.cssText = 'font:14px -apple-system,"Segoe UI",system-ui,sans-serif;color:#9aa4b0;text-align:center;margin:40vh 24px 0;';
            document.body.style.cssText = 'background:#0a0c0f;margin:0;';
            document.body.appendChild(el);
        }
        el.textContent = text;
    }

    function enterApp() {
        if (timer) clearTimeout(timer);
        location.replace('/app.html');
    }

    function tryRecover() {
        return fetch('/__zephyr_one/recover', { method: 'POST', credentials: 'same-origin' })
            .then(function (r) { return r.status === 204; })
            .catch(function () { return false; });
    }

    function askShellRestart() {
        if (restarting) return;
        restarting = true;
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () {
            restarting = false;
            schedule();
        }, RESTART_TIMEOUT_MS);
        /* The shell (src/main.js) owns the listener for this message and only
         * accepts it from the expected loopback origin of its own core. */
        window.parent.postMessage({ type: 'zephyr-one:restart' }, '*');
    }

    function schedule() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(run, RETRY_DELAY_MS);
    }

    function run() {
        tryRecover().then(function (ok) {
            if (ok) {
                enterApp();
            } else {
                askShellRestart();
            }
        });
    }

    window.addEventListener('message', function (event) {
        var data = event && event.data;
        if (data && data.type === 'zephyr-one:restarted' && event.source === window.parent) {
            enterApp();
        }
    });

    show('Zephyr One is restarting its local service\u2026');
    run();
})();