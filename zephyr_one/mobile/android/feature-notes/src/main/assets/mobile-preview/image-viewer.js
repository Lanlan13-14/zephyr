import Vips from './vendor/wasm-vips/vips-es6.js';
const image = document.querySelector('#image');
const stage = document.querySelector('#stage');
const status = document.querySelector('#status');
const transform = new window.ImageTransform();
let owned = '', closed = false, vips = null, decoded = null;
const update = () => { image.style.transform = transform.css(); };
const actions = {
    zoomIn: () => transform.scale(1.2), zoomOut: () => transform.scale(1 / 1.2),
    oneToOne: () => transform.oneToOne(image.naturalWidth, image.naturalHeight, stage.clientWidth, stage.clientHeight),
    reset: () => transform.reset(), rotateLeft: () => transform.rotate(-90), rotateRight: () => transform.rotate(90),
    flipHorizontal: () => transform.flip('x'), flipVertical: () => transform.flip('y'),
    view: () => { document.body.classList.toggle('viewer'); actions.oneToOne(); },
    prev: () => window.PreviewBridge?.sibling(-1), next: () => window.PreviewBridge?.sibling(1),
};
document.querySelector('#tools').addEventListener('click', event => {
    actions[event.target.closest('[data-action]')?.dataset.action]?.(); update();
});
const points = new Map();
let pinch = 0;
const distance = () => { const p = [...points.values()]; return p.length === 2 ? Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) : 0; };
stage.addEventListener('pointerdown', event => { stage.setPointerCapture(event.pointerId); points.set(event.pointerId, {x:event.clientX,y:event.clientY}); pinch = distance(); });
stage.addEventListener('pointermove', event => {
    const previous = points.get(event.pointerId); if (!previous) return;
    points.set(event.pointerId, {x:event.clientX,y:event.clientY});
    if (points.size === 2) { const next = distance(); if (pinch) transform.scale(next / pinch); pinch = next; }
    else transform.pan(event.clientX - previous.x, event.clientY - previous.y);
    update();
});
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) stage.addEventListener(name, event => { points.delete(event.pointerId); pinch = distance(); });
stage.addEventListener('wheel', event => { event.preventDefault(); transform.scale(event.deltaY < 0 ? 1.1 : 1 / 1.1); update(); }, {passive:false});
stage.addEventListener('dblclick', () => { actions.oneToOne(); update(); });
window.addEventListener('pagehide', () => { closed = true; if (owned) URL.revokeObjectURL(owned); owned = ''; decoded?.delete?.(); decoded = null; });

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_EDGE = 8192;
const DIRECT = {jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif',bmp:'image/bmp',avif:'image/avif'};
const name = new URL(location.href).searchParams.get('name') || '';
const ext = name.split(/[\\/]/).pop().split('.').pop().toLowerCase();

function fail(error) {
    if (!closed) status.textContent = `图片预览失败：${error?.message || '浏览器解码图片失败'}`;
}
async function show(url, bytes, label) {
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > MAX_EDGE || image.naturalHeight > MAX_EDGE || image.naturalWidth * image.naturalHeight > MAX_BYTES) {
        throw new Error('图片超过浏览器解码安全限制');
    }
    if (closed) return;
    status.hidden = true; image.style.display = 'block';
    document.querySelector('#meta').textContent = `${name} · ${image.naturalWidth}×${image.naturalHeight} · ${(bytes.length / 1024).toFixed(1)} KiB · ${label}`;
}
try {
    const response = await fetch('/raw/image');
    if (!response.ok) throw new Error('无法读取图片');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.byteLength) throw new Error('预览文件为空');
    if (bytes.byteLength > MAX_BYTES) throw new Error('图片超过32MiB安全限制');
    const mime = DIRECT[ext];
    if (mime) {
        const url = URL.createObjectURL(new Blob([bytes], {type:mime}));
        try { await show(url, bytes, '原图直出'); owned = url; }
        catch (directError) {
            URL.revokeObjectURL(url);
            if (directError.message === '图片超过浏览器解码安全限制') throw directError;
        }
    }
    if (!owned) {
        vips = await Vips({dynamicLibraries:['vips-jxl.wasm','vips-heif.wasm','vips-resvg.wasm']});
        vips.concurrency?.(1); vips.blockUntrusted?.(true);
        decoded = vips.Image.thumbnailBuffer(bytes, 4096, {height:4096,size:'down'});
        if (!decoded.width || !decoded.height || decoded.width > MAX_EDGE || decoded.height > MAX_EDGE || decoded.width * decoded.height > MAX_BYTES) {
            throw new Error('图片超过浏览器解码安全限制');
        }
        const encoded = decoded.webpsaveBuffer({Q:82,keep:0});
        const copy = new Uint8Array(encoded.byteLength); copy.set(encoded);
        owned = URL.createObjectURL(new Blob([copy], {type:'image/webp'}));
        if (closed) { URL.revokeObjectURL(owned); owned = ''; }
        else await show(owned, bytes, '客户端转 WebP');
    }
} catch (error) { fail(error); }
finally { decoded?.delete?.(); decoded = null; }
