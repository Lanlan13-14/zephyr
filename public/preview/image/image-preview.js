(function () {
    'use strict';

    const t = (key, vars = {}) => {
        const translated = window.__zephyrT ? window.__zephyrT(key, vars) : key;
        return String(translated).replace(/\{([A-Za-z0-9_]+)\}/g, (_, name) => vars[name] ?? `{${name}}`);
    };

    const IMAGE_EXTENSIONS = new Set([
        'jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'avif',
        'tif', 'tiff', 'heic', 'heif', 'jxl', 'jp2', 'j2k', 'bmp', 'dib', 'ico', 'cur', 'icns',
        'psd', 'psb', 'xcf', 'dds', 'tga', 'hdr', 'exr', 'pnm', 'pbm', 'pgm', 'ppm', 'pam',
        'pcx', 'sgi', 'ras', 'sun', 'fits', 'fit', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'orf',
        'rw2', 'raf', 'pef', 'srw', 'x3f', 'mrw', 'erf', 'kdc', 'dcr', 'mos'
    ]);

    function extname(filePath) {
        const base = String(filePath || '').split(/[\\/]/).pop() || '';
        const idx = base.lastIndexOf('.');
        return idx > -1 ? base.slice(idx + 1).toLowerCase() : '';
    }

    function escapeHtml(value) {
        return String(value || '').replace(/[&<>"']/g, (ch) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[ch]));
    }

    function formatSize(bytes) {
        const value = Number(bytes) || 0;
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let size = value;
        let unit = 0;
        while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
        return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
    }

    class ZephyrImagePreview {
        constructor(options = {}) {
            this.send = options.send || (() => {});
            this.getImages = options.getImages || (() => []);
            this.notify = options.notify || (() => {});
            this.bringToFront = options.bringToFront || (() => {});
            this.layoutMenu = options.layoutMenu || null;
            this.formatSize = options.formatSize || formatSize;
            this.onFocus = options.onFocus || (() => {});
            this.onClose = options.onClose || (() => {});
            this.index = Number(options.index) || 0;
            this.currentPath = options.path || '';
            this.pending = new Set();
            this.viewer = null;
            this.closed = false;
            this.modal = this.createModal();
            this.modal._imagePreviewInstance = this;
            (document.querySelector('.terminal-page') || document.body).appendChild(this.modal);
        }

        static isImage(filePath) {
            return IMAGE_EXTENSIONS.has(extname(filePath));
        }

        createModal() {
            const modal = document.createElement('div');
            modal.className = 'image-preview-modal';
            modal.style.display = 'none';
            modal.innerHTML = `
                <div class="image-preview-titlebar panel-titlebar">
                    <button class="panel-traffic-btn" type="button" data-action="layout" title="${t('窗口布局')}"><span></span></button>
                </div>
                <div class="image-preview-header">
                    <div class="image-preview-title" data-role="title">${t('图片预览')}</div>
                    <div class="image-preview-actions">
                        <button class="tool-btn" type="button" data-action="refresh" title="${t('重新加载预览')}">${t('刷新')}</button>
                        <button class="tool-btn" type="button" data-action="open-viewer" title="${t('打开 Viewer.js 查看器')}">${t('查看')}</button>
                    </div>
                </div>
                <div class="image-preview-body" data-role="body">
                    <div class="image-preview-state" data-role="state">${t('准备预览...')}</div>
                    <div class="image-preview-stage" data-role="stage" style="display:none;"><img data-role="image" alt="${t('图片预览')}"></div>
                </div>
                <div class="image-preview-meta" data-role="meta"></div>
                <div class="panel-resize-handle left" data-role="resize-left" title="${t('拖动调整大小')}"></div>
                <div class="panel-resize-handle right" data-role="resize-right" title="${t('拖动调整大小')}"></div>`;
            modal.addEventListener('pointerdown', () => this.focus());
            modal.querySelector('[data-action="refresh"]')?.addEventListener('click', () => this.open(this.currentPath, { force: true }));
            modal.querySelector('[data-action="open-viewer"]')?.addEventListener('click', () => this.showViewer());
            this.setupPhysicsDrag(modal);
            this.setupLayoutButton(modal);
            this.setupResize(modal);
            return modal;
        }

        focus() {
            this.onFocus(this);
            this.bringToFront(this.modal);
        }

        // AI panel parity: gray .panel-drag-handle → physics; ⋯ → hard drag.
        // Titlebar body / header content are NOT drag surfaces.
        setupPhysicsDrag(modal) {
            const physics = window.ZephyrFloatingPanelPhysics;
            if (!physics?.ensure) return;
            void physics.ensure(modal, {
                handle: modal.querySelector('.panel-drag-handle'),
                layoutButton: modal.querySelector('[data-action="layout"], .panel-traffic-btn'),
                layoutSelector: '[data-action="layout"], [data-layout-panel], .panel-traffic-btn',
                bringToFront: () => this.focus(),
                onActivate: () => physics.markLayoutClickSuppressed?.(true),
            });
        }

        setupLayoutButton(modal) {
            const button = modal.querySelector('[data-action="layout"]');
            if (!button) return;
            // Hard drag is bound by setupPhysicsDrag; click only opens layout menu.
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (window.ZephyrFloatingPanelPhysics?.consumeLayoutClickSuppression?.()) return;
                if (this.suppressLayoutClick) { this.suppressLayoutClick = false; return; }
                this.focus();
                if (navigator.vibrate) navigator.vibrate(8);
                this.layoutMenu?.open?.(button, modal);
            });
        }

        setupResize(modal) {
            modal.querySelectorAll('[data-role^="resize-"]').forEach((handle) => {
                handle.addEventListener('pointerdown', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    handle.setPointerCapture?.(event.pointerId);
                    this.focus();
                    modal.classList.add('resizing');
                    const edge = handle.dataset.role === 'resize-left' ? 'left' : 'right';
                    const startX = event.clientX;
                    const startY = event.clientY;
                    const startWidth = modal.offsetWidth;
                    const startHeight = modal.offsetHeight;
                    const startLeft = modal.offsetLeft;
                    const parentRect = modal.parentElement?.getBoundingClientRect?.() || document.documentElement.getBoundingClientRect();
                    const onMove = (ev) => {
                        ev.preventDefault();
                        let width = edge === 'left' ? startWidth - (ev.clientX - startX) : startWidth + (ev.clientX - startX);
                        let left = startLeft;
                        width = Math.min(Math.max(300, width), Math.max(300, parentRect.width - 12));
                        const height = Math.min(Math.max(260, startHeight + ev.clientY - startY), Math.max(260, parentRect.height - modal.offsetTop));
                        if (edge === 'left') left = Math.max(0, startLeft + startWidth - width);
                        modal.style.width = `${width}px`;
                        modal.style.height = `${height}px`;
                        modal.style.left = `${left}px`;
                        modal.style.right = 'auto';
                    };
                    const onUp = () => {
                        modal.classList.remove('resizing');
                        window.removeEventListener('pointermove', onMove);
                        window.removeEventListener('pointerup', onUp);
                    };
                    window.addEventListener('pointermove', onMove, { passive: false });
                    window.addEventListener('pointerup', onUp, { once: true });
                });
            });
        }

        open(filePath, options = {}) {
            if (!filePath || !ZephyrImagePreview.isImage(filePath)) return false;
            this.currentPath = filePath;
            this.closed = false;
            this.pending.add(filePath);
            this.modal.dataset.previewPath = filePath;
            this.modal.style.display = 'flex';
            this.modal.classList.remove('panel-opening', 'panel-closing');
            if (!this.modal.style.left) {
                const offset = (this.index % 5) * 22;
                this.modal.style.left = window.innerWidth <= 720 ? '6px' : `${56 + offset}px`;
                this.modal.style.top = window.innerWidth <= 720 ? '6px' : `${72 + offset}px`;
            }
            this.focus();
            requestAnimationFrame(() => {
                if (!this.closed && this.modal.isConnected) {
                    this.modal.classList.add('panel-opening');
                    // animation-fill:both must not stick or Motion.drag loses transform.
                    window.clearTimeout(this.modal._panelMotionClearTimer);
                    this.modal._panelMotionClearTimer = window.setTimeout(() => {
                        this.modal?.classList?.remove('panel-opening');
                    }, 400);
                }
            });
            this.setLoading(filePath);
            this.send({ type: 'sftp-preview', path: filePath, force: !!options.force });
            return true;
        }

        handleMessage(message) {
            if (message?.path && message.path !== this.currentPath) return false;
            if (message?.type === 'sftp-preview-ready') {
                this.pending.delete(message.path);
                this.renderImage(message);
                return true;
            }
            if (message?.type === 'sftp-preview') {
                this.pending.delete(message.path);
                if (message.error) this.setError(message.path, message.error);
                return true;
            }
            return false;
        }

        setLoading(filePath) {
            this.destroyViewer();
            const title = this.modal.querySelector('[data-role="title"]');
            const state = this.modal.querySelector('[data-role="state"]');
            const stage = this.modal.querySelector('[data-role="stage"]');
            const meta = this.modal.querySelector('[data-role="meta"]');
            const image = this.modal.querySelector('[data-role="image"]');
            title.textContent = t('图片预览: {name}', { name: filePath.split('/').pop() || filePath });
            state.className = 'image-preview-state loading';
            state.textContent = t('正在准备图片预览...');
            state.style.display = 'grid';
            stage.style.display = 'none';
            image.onload = null;
            image.onerror = null;
            image.removeAttribute('src');
            meta.textContent = filePath;
        }

        setError(filePath, error) {
            const state = this.modal.querySelector('[data-role="state"]');
            const stage = this.modal.querySelector('[data-role="stage"]');
            state.className = 'image-preview-state error';
            state.innerHTML = `<strong>${t('预览失败')}</strong><span>${escapeHtml(error || t('未知错误'))}</span>`;
            state.style.display = 'grid';
            stage.style.display = 'none';
            this.notify(t('图片预览失败：{error}', { error: error || t('未知错误') }), 'error');
        }

        renderImage(message) {
            if (!message?.url) return this.setError(message?.path || this.currentPath, t('缺少预览地址'));
            this.currentPath = message.path || this.currentPath;
            const state = this.modal.querySelector('[data-role="state"]');
            const stage = this.modal.querySelector('[data-role="stage"]');
            const image = this.modal.querySelector('[data-role="image"]');
            const meta = this.modal.querySelector('[data-role="meta"]');
            const cacheBust = message.converted ? `&t=${Date.now()}` : '';
            image.onload = () => {
                state.style.display = 'none';
                stage.style.display = 'grid';
                this.initViewer(image);
            };
            image.onerror = () => this.setError(this.currentPath, '浏览器加载预览图片失败');
            image.alt = this.currentPath.split('/').pop() || t('图片预览');
            image.src = `${message.url}${message.url.includes('?') ? '&' : '?'}inline=1${cacheBust}`;
            meta.innerHTML = `<span title="${escapeHtml(this.currentPath)}">${escapeHtml(this.currentPath)}</span><b>${message.converted ? '已转 WebP' : '原图直出'}</b><em>${this.formatSize(message.size)}</em>`;
        }

        initViewer(image) {
            this.destroyViewer();
            if (!window.Viewer) return;
            this.viewer = new window.Viewer(image, {
                inline: false,
                navbar: false,
                fullscreen: false,
                title: [1, () => this.currentPath.split('/').pop() || t('图片预览')],
                toolbar: {
                    zoomIn: 1,
                    zoomOut: 1,
                    oneToOne: 1,
                    reset: 1,
                    prev: () => this.openSibling(-1),
                    next: () => this.openSibling(1),
                    rotateLeft: 1,
                    rotateRight: 1,
                    flipHorizontal: 1,
                    flipVertical: 1,
                },
                viewed() { this.viewer.zoomTo(1); },
            });
        }

        showViewer() {
            this.focus();
            if (this.viewer) this.viewer.show();
            else this.modal.querySelector('[data-role="image"]')?.click();
        }

        openSibling(delta) {
            const images = this.getImages(this.currentPath) || [];
            if (!images.length) return;
            const current = images.findIndex((item) => item.path === this.currentPath);
            const index = current >= 0 ? current : 0;
            const next = images[(index + delta + images.length) % images.length];
            if (next?.path) {
                try { this.viewer?.hide?.(); } catch {}
                this.destroyViewer();
                this.open(next.path);
            }
        }

        destroyViewer() {
            if (!this.viewer) return;
            try { this.viewer.destroy(); } catch {}
            this.viewer = null;
        }

        close() {
            if (this.closed) return;
            this.closed = true;
            this.destroyViewer();
            this.layoutMenu?.close?.({ instant: true });
            this.modal.classList.remove('panel-opening');
            this.modal.classList.add('panel-closing');
            const onAnimationEnd = (event) => {
                if (event.target !== this.modal || event.animationName !== 'floatingPanelCloseToButton') return;
                remove();
            };
            const remove = () => {
                if (!this.modal.isConnected) return;
                window.clearTimeout(this.closeTimer);
                this.modal.removeEventListener('animationend', onAnimationEnd);
                this.modal.remove();
                this.onClose(this);
            };
            this.modal.addEventListener('animationend', onAnimationEnd);
            this.closeTimer = window.setTimeout(remove, 360);
        }
    }

    window.ZephyrImagePreview = ZephyrImagePreview;
})();
