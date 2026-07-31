(function () {
    'use strict';

    const t = (key, vars = {}) => {
        const translated = window.__zephyrT ? window.__zephyrT(key, vars) : key;
        return String(translated).replace(/\{([A-Za-z0-9_]+)\}/g, (_, name) => vars[name] ?? `{${name}}`);
    };

    const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'f4v', 'mpeg', 'mpg', 'mpe', 'ts', 'mts', 'm2ts', 'vob', 'ogv', '3gp', '3g2', 'asf', 'rm', 'rmvb', 'divx', 'mxf']);
    const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'weba', 'wma', 'alac', 'aiff', 'aif', 'ape', 'amr', 'mid', 'midi', 'mka', 'caf', 'ac3', 'dts', 'm4b']);

    function extname(filePath) {
        const base = String(filePath || '').split(/[\\/]/).pop() || '';
        const idx = base.lastIndexOf('.');
        return idx > -1 ? base.slice(idx + 1).toLowerCase() : '';
    }
    function escapeHtml(value) {
        return String(value || '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }
    function formatSize(bytes) {
        const value = Number(bytes) || 0;
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let size = value;
        let unit = 0;
        while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
        return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
    }
    function formatDuration(seconds) {
        const total = Math.max(0, Math.floor(Number(seconds) || 0));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
    }

    class ZephyrMediaPreview {
        constructor(options = {}) {
            this.send = options.send || (() => {});
            this.notify = options.notify || (() => {});
            this.bringToFront = options.bringToFront || (() => {});
            this.layoutMenu = options.layoutMenu || null;
            this.formatSize = options.formatSize || formatSize;
            this.onFocus = options.onFocus || (() => {});
            this.onClose = options.onClose || (() => {});
            this.index = Number(options.index) || 0;
            this.currentPath = options.path || '';
            this.pending = new Set();
            this.closed = false;
            this.objectTracks = [];
            this.manualSubtitles = [];
            this.remoteSubtitles = [];
            this.currentToken = '';
            this.remoteSubtitlePicker = options.remoteSubtitlePicker || null;
            this.modal = this.createModal();
            this.modal._mediaPreviewInstance = this;
            (document.querySelector('.terminal-page') || document.body).appendChild(this.modal);
        }

        static isMedia(filePath) {
            const ext = extname(filePath);
            return VIDEO_EXTENSIONS.has(ext) || AUDIO_EXTENSIONS.has(ext);
        }
        static isVideo(filePath) { return VIDEO_EXTENSIONS.has(extname(filePath)); }
        static isAudio(filePath) { return AUDIO_EXTENSIONS.has(extname(filePath)); }

        createModal() {
            const modal = document.createElement('div');
            modal.className = 'media-preview-modal';
            modal.style.display = 'none';
            modal.innerHTML = `
                <div class="media-preview-titlebar panel-titlebar">
                    <button class="panel-traffic-btn" type="button" data-action="layout" title="${t('窗口布局')}"><span></span></button>
                </div>
                <div class="media-preview-header">
                    <div class="media-preview-title" data-role="title">${t('媒体预览')}</div>
                    <div class="media-preview-actions">
                        <button class="tool-btn" type="button" data-action="remote-subtitle" title="${t('从当前终端/SFTP 路径选择字幕')}">${t('路径字幕')}</button>
                        <label class="tool-btn" data-action="subtitle-label" title="${t('上传本地字幕文件')}">${t('本地字幕')}<input type="file" data-role="subtitle-input" accept=".vtt,.srt,.ass,.ssa,.sub,text/vtt,text/plain" style="display:none;"></label>
                        <button class="tool-btn" type="button" data-action="refresh" title="${t('重新加载播放')}">${t('刷新')}</button>
                    </div>
                </div>
                <div class="media-preview-body" data-role="body">
                    <div class="media-preview-state" data-role="state">${t('准备播放...')}</div>
                    <div class="media-preview-stage" data-role="stage" style="display:none;"></div>
                </div>
                <div class="media-preview-meta" data-role="meta"></div>
                <div class="panel-resize-handle left" data-role="resize-left" title="${t('拖动调整窗口大小')}"></div>
                <div class="panel-resize-handle right" data-role="resize-right" title="${t('拖动调整窗口大小')}"></div>`;
            modal.addEventListener('pointerdown', () => this.focus());
            modal.querySelector('[data-action="refresh"]')?.addEventListener('click', () => this.open(this.currentPath, { force: true }));
            modal.querySelector('[data-action="remote-subtitle"]')?.addEventListener('click', () => this.pickRemoteSubtitle());
            modal.querySelector('[data-role="subtitle-input"]')?.addEventListener('change', (event) => this.mountManualSubtitle(event.target.files?.[0], event.target));
            this.setupPhysicsDrag(modal);
            this.setupLayoutButton(modal);
            this.setupResize(modal);
            return modal;
        }
        focus() { this.onFocus(this); this.bringToFront(this.modal); }

        // AI panel parity: titlebar chrome = physics handle; ⋯ = hard drag.
        // Header content is NOT a drag surface.
        setupPhysicsDrag(modal) {
            const physics = window.ZephyrFloatingPanelPhysics;
            if (!physics?.ensure) return;
            void physics.ensure(modal, {
                handle: modal.querySelector('.panel-drag-handle, .media-preview-titlebar'),
                layoutButton: modal.querySelector('[data-action="layout"], .panel-traffic-btn'),
                layoutSelector: '[data-action="layout"], [data-layout-panel], .panel-traffic-btn',
                bringToFront: () => this.focus(),
                onActivate: () => physics.markLayoutClickSuppressed?.(true),
            });
        }
        setupLayoutButton(modal) {
            const button = modal.querySelector('[data-action="layout"]');
            if (!button) return;
            button.addEventListener('click', (event) => {
                event.preventDefault(); event.stopPropagation();
                if (window.ZephyrFloatingPanelPhysics?.consumeLayoutClickSuppression?.()) return;
                if (this.suppressLayoutClick) { this.suppressLayoutClick = false; return; }
                this.focus();
                if (navigator.vibrate) navigator.vibrate(8);
                this.layoutMenu?.open?.(button, modal);
            });
        }
        setupResize(modal) {
            const handles = modal.querySelectorAll('[data-role="resize-left"], [data-role="resize-right"]');
            handles.forEach((handle) => {
                handle.addEventListener('pointerdown', (event) => {
                    event.preventDefault(); event.stopPropagation(); this.focus();
                    modal.classList.add('resizing'); handle.setPointerCapture?.(event.pointerId);
                    const side = handle.dataset.role === 'resize-left' ? 'left' : 'right';
                    const startX = event.clientX, startY = event.clientY;
                    const startWidth = modal.offsetWidth, startHeight = modal.offsetHeight, startLeft = modal.offsetLeft;
                    const parentRect = modal.parentElement?.getBoundingClientRect?.() || document.documentElement.getBoundingClientRect();
                    const minWidth = 300, maxWidth = Math.max(minWidth, parentRect.width - 12);
                    const minHeight = 240, maxHeight = Math.max(minHeight, parentRect.height - 12);
                    const onMove = (ev) => {
                        ev.preventDefault();
                        const dx = ev.clientX - startX;
                        const dy = ev.clientY - startY;
                        let nextWidth = side === 'left' ? startWidth - dx : startWidth + dx;
                        let nextHeight = startHeight + dy;
                        nextWidth = Math.min(Math.max(minWidth, nextWidth), maxWidth);
                        nextHeight = Math.min(Math.max(minHeight, nextHeight), maxHeight);
                        modal.style.width = `${nextWidth}px`;
                        modal.style.height = `${nextHeight}px`;
                        if (side === 'left') modal.style.left = `${Math.min(Math.max(0, startLeft + (startWidth - nextWidth)), Math.max(0, parentRect.width - 80))}px`;
                        modal.style.right = 'auto';
                        modal.style.bottom = 'auto';
                    };
                    const onUp = () => { modal.classList.remove('resizing'); window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onUp); };
                    window.addEventListener('pointermove', onMove, { passive: false });
                    window.addEventListener('pointerup', onUp, { once: true });
                    window.addEventListener('pointercancel', onUp, { once: true });
                });
            });
        }
        setState(text, type = '') {
            const state = this.modal.querySelector('[data-role="state"]');
            const stage = this.modal.querySelector('[data-role="stage"]');
            if (state) { state.style.display = 'grid'; state.className = `media-preview-state ${type}`.trim(); state.innerHTML = escapeHtml(text); }
            if (stage) {
                stage.querySelectorAll?.('video,audio')?.forEach?.((media) => { try { media.pause(); media.removeAttribute('src'); media.load?.(); } catch {} });
                stage.style.display = 'none';
                stage.innerHTML = '';
            }
        }
        open(filePath, options = {}) {
            if (!filePath || !ZephyrMediaPreview.isMedia(filePath)) return false;
            this.currentPath = filePath;
            this.manualSubtitles = [];
            this.remoteSubtitles = [];
            this.pending.add(filePath);
            this.closed = false;
            const title = this.modal.querySelector('[data-role="title"]');
            if (title) title.textContent = filePath;
            const meta = this.modal.querySelector('[data-role="meta"]');
            if (meta) meta.textContent = '';
            this.setState(t('正在准备媒体流...'), 'loading');
            this.modal.style.display = 'flex';
            this.modal.classList.remove('open', 'closing', 'panel-opening', 'panel-closing');
            requestAnimationFrame(() => {
                if (!this.closed && this.modal.isConnected) this.modal.classList.add('panel-opening');
            });
            this.focus();
            this.send({ type: 'sftp-media-preview', path: filePath, force: !!options.force, capabilities: this.getCapabilities(filePath) });
            return true;
        }
        getCapabilities(filePath) {
            const video = document.createElement('video');
            const audio = document.createElement('audio');
            const canPlay = (el, mime) => {
                const result = String(el.canPlayType(mime) || '').toLowerCase();
                return result === 'probably' || result === 'maybe';
            };
            return {
                ext: extname(filePath),
                video: {
                    h264: canPlay(video, 'video/mp4; codecs="avc1.42E01E"'),
                    hevc: canPlay(video, 'video/mp4; codecs="hvc1.1.6.L93.B0"'),
                    vp8: canPlay(video, 'video/webm; codecs="vp8"'),
                    vp9: canPlay(video, 'video/webm; codecs="vp9"'),
                    av1: canPlay(video, 'video/mp4; codecs="av01.0.05M.08"'),
                },
                audio: {
                    aac: canPlay(audio, 'audio/mp4; codecs="mp4a.40.2"'),
                    mp3: canPlay(audio, 'audio/mpeg'),
                    opus: canPlay(audio, 'audio/ogg; codecs="opus"') || canPlay(audio, 'audio/webm; codecs="opus"'),
                    vorbis: canPlay(audio, 'audio/ogg; codecs="vorbis"'),
                    flac: canPlay(audio, 'audio/flac'),
                    pcm_s16le: canPlay(audio, 'audio/wav; codecs="1"') || canPlay(audio, 'audio/wav'),
                    pcm_s24le: canPlay(audio, 'audio/wav'),
                },
            };
        }
        handleMessage(message) {
            if (message?.type === 'sftp-media-preview-ready' && (!message.path || message.path === this.currentPath || this.pending.has(message.path))) { this.renderPlayer(message); return true; }
            if (message?.type === 'sftp-media-preview' && (!message.path || message.path === this.currentPath || this.pending.has(message.path))) {
                this.pending.delete(message.path);
                if (message.error) this.setState(message.error, 'error');
                return true;
            }
            return false;
        }
        async pickRemoteSubtitle() {
            try {
                if (!this.remoteSubtitlePicker) throw new Error(t('当前页面不支持从终端路径选择字幕'));
                const item = await this.remoteSubtitlePicker(this.currentPath);
                if (!item) return;
                const name = item.name || String(item.path || '').split(/[\\/]/).pop() || t('远程字幕');
                const ext = extname(name);
                if (!['vtt', 'srt', 'ass', 'ssa', 'sub'].includes(ext)) throw new Error(t('仅支持 .vtt/.srt/.ass/.ssa/.sub 字幕'));
                let text = String(item.text || '');
                if (ext !== 'vtt') text = this.convertSubtitleTextToVtt(text, ext);
                else if (!/^WEBVTT/i.test(text.trim())) text = `WEBVTT\n\n${text}`;
                const url = URL.createObjectURL(new Blob([text], { type: 'text/vtt;charset=utf-8' }));
                this.objectTracks.push(url);
                this.manualSubtitles.push({ url, language: name.replace(/\.[^.]+$/, ''), manual: true, remotePath: item.path || '' });
                this.applySubtitles();
                this.notify(t('已挂载路径字幕：{name}', { name }), 'success');
            } catch (err) {
                this.notify(err.message || t('路径字幕挂载失败'), 'error');
            }
        }
        async mountManualSubtitle(file, input) {
            if (!file) return;
            try {
                const name = file.name || t('字幕');
                const ext = extname(name);
                if (!['vtt', 'srt', 'ass', 'ssa', 'sub'].includes(ext)) throw new Error(t('仅支持 .vtt/.srt/.ass/.ssa/.sub 字幕'));
                let text = await file.text();
                if (ext !== 'vtt') text = this.convertSubtitleTextToVtt(text, ext);
                else if (!/^WEBVTT/i.test(text.trim())) text = `WEBVTT\n\n${text}`;
                const url = URL.createObjectURL(new Blob([text], { type: 'text/vtt;charset=utf-8' }));
                this.objectTracks.push(url);
                this.manualSubtitles.push({ url, language: name.replace(/\.[^.]+$/, ''), manual: true });
                this.applySubtitles();
                this.notify(t('已挂载字幕：{name}', { name }), 'success');
            } catch (err) {
                this.notify(err.message || t('字幕挂载失败'), 'error');
            } finally {
                if (input) input.value = '';
            }
        }
        convertSubtitleTextToVtt(text, ext) {
            let raw = String(text || '').replace(/^\uFEFF/, '').replace(/\r/g, '');
            if (ext === 'ass' || ext === 'ssa') {
                const eventsIndex = raw.search(/^\[Events\]/mi);
                if (eventsIndex >= 0) raw = raw.slice(eventsIndex);
                const lines = raw.split('\n').filter((line) => /^Dialogue:/i.test(line)).map((line, index) => {
                    const parts = line.replace(/^Dialogue:\s*/i, '').split(',');
                    if (parts.length < 10) return '';
                    const start = this.assTimeToVtt(parts[1]);
                    const end = this.assTimeToVtt(parts[2]);
                    const body = parts.slice(9).join(',').replace(/\{[^}]*\}/g, '').replace(/\\N/g, '\n');
                    return `${index + 1}\n${start} --> ${end}\n${body}\n`;
                }).filter(Boolean);
                return `WEBVTT\n\n${lines.join('\n')}`;
            }
            raw = raw.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g, (_, hms, ms) => `${hms}.${String(ms).padEnd(3, '0')}`);
            return /^WEBVTT/i.test(raw.trim()) ? raw : `WEBVTT\n\n${raw}`;
        }
        assTimeToVtt(value) {
            const match = String(value || '').trim().match(/^(\d+):(\d{2}):(\d{2})[.](\d{1,2})/);
            if (!match) return '00:00:00.000';
            return `${String(match[1]).padStart(2, '0')}:${match[2]}:${match[3]}.${String(match[4]).padEnd(3, '0')}`;
        }
        applySubtitles() {
            const media = this.modal.querySelector('video,audio');
            if (!media) return;
            media.querySelectorAll('track').forEach((track) => track.remove());
            [...(this.remoteSubtitles || []), ...(this.manualSubtitles || [])].forEach((sub, index) => {
                const track = document.createElement('track');
                track.kind = 'subtitles';
                track.src = sub.url;
                track.label = sub.language || t('字幕 {count}', { count: index + 1 });
                track.srclang = sub.language || 'und';
                if (index === 0 || sub.manual) track.default = true;
                media.appendChild(track);
                if (sub.manual) window.setTimeout(() => {
                    try { if (media.textTracks?.[index]) media.textTracks[index].mode = 'showing'; } catch {}
                }, 80);
            });
        }
        renderPlayer(message) {
            this.pending.delete(message.path);
            if (message.path !== this.currentPath) return;
            this.currentToken = message.token || '';
            this.remoteSubtitles = message.subtitles || [];
            const previousManualSubtitles = [...(this.manualSubtitles || [])];
            this.manualSubtitles = previousManualSubtitles;
            const stage = this.modal.querySelector('[data-role="stage"]');
            const state = this.modal.querySelector('[data-role="state"]');
            if (!stage) return;
            stage.innerHTML = '';
            const media = document.createElement(message.kind === 'audio' ? 'audio' : 'video');
            media.controls = true;
            media.autoplay = false;
            media.playsInline = true;
            media.preload = 'metadata';
            media.src = message.streamUrl;
            media.load?.();
            media.addEventListener('error', () => {
                const err = media.error;
                this.notify(t('媒体播放失败{detail}，可点刷新尝试转码', { detail: err?.message ? `：${err.message}` : '' }), 'error');
            });
            if (message.kind === 'audio') {
                const audioWrap = document.createElement('div');
                audioWrap.className = 'media-audio-card';
                audioWrap.innerHTML = `
                    <div class="media-audio-info">
                        <div class="media-audio-name">${escapeHtml((message.path || '').split(/[\\/]/).pop() || t('音频'))}</div>
                        <div class="media-audio-hint">${t('点击下方控件播放 / 暂停')}</div>
                    </div>`;
                audioWrap.appendChild(media);
                stage.appendChild(audioWrap);
            } else {
                stage.appendChild(media);
            }
            this.applySubtitles();
            if (state) state.style.display = 'none';
            stage.style.display = 'grid';
            const meta = this.modal.querySelector('[data-role="meta"]');
            if (meta) {
                const info = message.info || {};
                const parts = [
                    `<span>${escapeHtml(message.path)}</span>`,
                    `<b>${escapeHtml(message.mode || '')}</b>`,
                    message.size ? `<em>${escapeHtml(this.formatSize(message.size))}</em>` : '',
                    info.duration ? `<em>${escapeHtml(formatDuration(info.duration))}</em>` : '',
                    info.video ? `<em>${escapeHtml(`${info.video.codec || '?'} ${info.video.width || ''}x${info.video.height || ''}`)}</em>` : '',
                    info.audio ? `<em>${escapeHtml(`${info.audio.codec || '?'} ${info.audio.channels || ''}ch`)}</em>` : '',
                ].filter(Boolean);
                meta.innerHTML = parts.join('');
            }
        }
        revokeTrackObjects() { this.objectTracks.splice(0).forEach((url) => URL.revokeObjectURL(url)); }
        close() {
            if (this.closed) return;
            this.closed = true;
            this.revokeTrackObjects();
            const stage = this.modal.querySelector('[data-role="stage"]');
            stage?.querySelectorAll('video,audio').forEach((media) => { try { media.pause(); media.removeAttribute('src'); media.load?.(); } catch {} });
            this.layoutMenu?.close?.({ instant: true });
            this.modal.classList.remove('open', 'closing', 'panel-opening');
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

    window.ZephyrMediaPreview = ZephyrMediaPreview;
})();
