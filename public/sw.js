const CACHE_NAME = 'zephyr-static-20260831-terminal-iframe-focus1';
const PRECACHE = [
    '/app.js?v=20260831-terminal-iframe-focus1',
    '/style.css?v=20260831-terminal-iframe-focus1',
    '/i18n/runtime.js?v=20260831-terminal-iframe-focus1',
    '/i18n/locales/en.json?v=20260831-terminal-iframe-focus1',
    '/i18n/locales/zh-CN.json?v=20260831-terminal-iframe-focus1',
    '/activity-i18n.js?v=20260831-terminal-iframe-focus1',
    '/notes.js?v=20260831-terminal-iframe-focus1',
    '/preview-mock.js?v=20260831-terminal-iframe-focus1',
    '/theme-runtime.js?v=20260615-visual-color-picker',
    '/terminal.js?v=20260830-terminal-focus2',
    '/telnet-terminal.js?v=20260830-terminal-focus2',
    '/terminal-history-gesture.js?v=20260801-terminal-stability1',
    '/terminal-grid-convergence.js?v=20260801-terminal-grid-converge1',
    '/vendor/wterm-fork/index.js?v=20260801-terminal-stability1',
    '/vendor/wterm-fork/core/xterm-headless-register.js?v=20260801-terminal-stability1',
    '/floating-panel.js?v=20260731-panel-drag-physics4',
    '/panel-pin.js?v=20260830-desktop-panel-pin8',
    '/panel-pin.css?v=20260830-desktop-panel-pin8',
    '/markdown.js?v=20260720-notes-md1',
];
const MAX_CACHE_ENTRIES = 160;

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => Promise.all(
        PRECACHE.map((url) => cache.add(url).catch(() => null)),
    )));
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(caches.keys().then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
    )).then(() => self.clients.claim()));
});

async function trimCache(cache) {
    const keys = await cache.keys();
    if (keys.length <= MAX_CACHE_ENTRIES) return;
    const protectedUrls = new Set(PRECACHE.map((url) => new URL(url, self.location.origin).href));
    const removable = keys.filter((request) => !protectedUrls.has(request.url));
    const excess = Math.max(0, keys.length - MAX_CACHE_ENTRIES);
    await Promise.all(removable.slice(0, excess).map((request) => cache.delete(request)));
}

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (request.mode === 'navigate' || url.pathname.endsWith('.html')) return;
    if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;

    const isVersionedAsset = url.searchParams.has('v');
    const isStaticAsset = isVersionedAsset
        || /\.(?:js|mjs|css|wasm|png|jpe?g|gif|webp|svg|woff2?)$/i.test(url.pathname);
    if (!isStaticAsset) return;

    event.respondWith((async () => {
        if (isVersionedAsset) {
            const cached = await caches.match(request);
            if (cached) return cached;
        }
        try {
            const response = await fetch(request);
            if (response.ok && (response.type === 'basic' || response.type === 'cors')) {
                const cache = await caches.open(CACHE_NAME);
                await cache.put(request, response.clone());
                await trimCache(cache);
            }
            return response;
        } catch (error) {
            if (!isVersionedAsset) {
                const cached = await caches.match(request);
                if (cached) return cached;
            }
            throw error;
        }
    })());
});
