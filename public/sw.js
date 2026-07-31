const CACHE_NAME = 'zephyr-static-20260731-panel-drag-physics4';
const PRECACHE = [
    '/app.js?v=20260731-activity-ux1',
    '/style.css?v=20260731-panel-drag-physics4',
    '/theme-runtime.js?v=20260615-visual-color-picker',
    '/terminal.js?v=20260731-panel-drag-physics4',
    '/floating-panel.js?v=20260731-panel-drag-physics4',
    '/notes.js',
    '/markdown.js',
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

    const isStaticAsset = url.searchParams.has('v')
        || /\.(?:js|mjs|css|wasm|png|jpe?g|gif|webp|svg|woff2?)$/i.test(url.pathname);
    if (!isStaticAsset) return;

    event.respondWith((async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok && (response.type === 'basic' || response.type === 'cors')) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(request, response.clone());
            await trimCache(cache);
        }
        return response;
    })());
});
