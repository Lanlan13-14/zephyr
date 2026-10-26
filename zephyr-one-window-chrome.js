// Zephyr One window chrome. Loaded only inside the embedded One surface.
// In a browser, or on macOS (native traffic lights), the controls stay hidden.
(function () {
    var bridge = window.zephyrOne;
    if (!bridge || typeof bridge.invoke !== 'function') return;
    var controls = document.querySelector('.one-window-controls');
    if (!controls) return;

    function resolveLabel(key) {
        var state = window.__zephyrI18nState;
        if (state && state.messages && typeof state.messages[key] === 'string' && state.messages[key]) {
            return state.messages[key];
        }
        return key;
    }

    function applyWindowState(state) {
        var isMax = !!(state && (state.maximized || state.fullScreen));
        controls.classList.toggle('is-maximized', isMax);
        var maxBtn = controls.querySelector('[data-one-window="maximize"]');
        if (maxBtn) {
            maxBtn.classList.toggle('active', isMax);
            maxBtn.setAttribute('aria-pressed', isMax ? 'true' : 'false');
            var key = isMax ? '还原窗口' : '最大化';
            var label = resolveLabel(key);
            maxBtn.setAttribute('title', label);
            maxBtn.setAttribute('aria-label', label);
            maxBtn.setAttribute('data-i18n-title', key);
            maxBtn.setAttribute('data-i18n-aria-label', key);
        }
    }

    function bindPressMotion() {
        if (controls.dataset.pressBound === '1') return;
        if (window.Motion && typeof window.Motion.press === 'function') {
            controls.dataset.pressBound = '1';
            window.Motion.press(controls.querySelectorAll('.one-window-btn'), { scale: 0.92 });
        }
    }

    bridge.invoke('get_platform').then(function (platform) {
        var mode = platform && platform.windowControls;
        if (mode !== 'overlay' && mode !== 'native') return;
        document.documentElement.dataset.zephyrWindowControls = mode;
        if (mode === 'overlay') {
            controls.hidden = false;
            bindPressMotion();
            bridge.invoke('window_get_state').then(applyWindowState).catch(function () {});
        }
        if (mode === 'native') placeTrafficLights();
    }).catch(function () {});

    window.addEventListener('DOMContentLoaded', bindPressMotion);
    window.addEventListener('load', bindPressMotion);

    /* The three traffic lights are about 54px wide and must sit immediately
     * left of the product controls, which move whenever the window resizes.
     * A fixed position in the main process cannot track that, so the page
     * measures and reports it. */
    function placeTrafficLights() {
        var actions = document.querySelector('.main-nav .nav-actions');
        var nav = document.querySelector('.main-nav');
        if (!actions || !nav || typeof bridge.invoke !== 'function') return;
        var navBox = nav.getBoundingClientRect();
        var box = actions.getBoundingClientRect();
        var x = Math.round(box.left - navBox.left - 62);
        var y = Math.round((navBox.height - 14) / 2);
        bridge.invoke('window_place_traffic_lights', { x: x, y: y }).catch(function () {});
    }
    window.addEventListener('resize', function () {
        if (document.documentElement.dataset.zephyrWindowControls === 'native') placeTrafficLights();
    });


    controls.addEventListener('click', function (event) {
        var button = event.target.closest('[data-one-window]');
        if (!button) return;
        var action = button.getAttribute('data-one-window');
        if (action === 'minimize') bridge.invoke('window_minimize');
        else if (action === 'maximize') {
            bridge.invoke('window_toggle_maximize').then(function (state) {
                applyWindowState(state);
            });
        } else if (action === 'close') bridge.invoke('window_close');
    });

    if (typeof bridge.onWindowState === 'function') {
        bridge.onWindowState(function (state) {
            applyWindowState(state);
        });
    }

})();
