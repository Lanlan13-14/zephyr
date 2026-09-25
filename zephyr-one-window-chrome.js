// Zephyr One window chrome. Loaded only inside the embedded One surface.
// In a browser, or on macOS (native traffic lights), the controls stay hidden.
(function () {
    var bridge = window.zephyrOne;
    if (!bridge || typeof bridge.invoke !== 'function') return;
    var controls = document.querySelector('.one-window-controls');
    if (!controls) return;

    bridge.invoke('get_platform').then(function (platform) {
        var mode = platform && platform.windowControls;
        if (mode !== 'overlay' && mode !== 'native') return;
        document.documentElement.dataset.zephyrWindowControls = mode;
        if (mode === 'overlay') controls.hidden = false;
    }).catch(function () {});


    controls.addEventListener('click', function (event) {
        var button = event.target.closest('[data-one-window]');
        if (!button) return;
        var action = button.getAttribute('data-one-window');
        if (action === 'minimize') bridge.invoke('window_minimize');
        else if (action === 'maximize') {
            bridge.invoke('window_toggle_maximize').then(function (state) {
                controls.classList.toggle('is-maximized', !!(state && state.maximized));
            });
        } else if (action === 'close') bridge.invoke('window_close');
    });

    if (typeof bridge.onWindowState === 'function') {
        bridge.onWindowState(function (state) {
            controls.classList.toggle('is-maximized', !!(state && state.maximized));
        });
    }

})();
