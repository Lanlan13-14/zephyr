import { OrderedRdpInputChannel } from './rdp-input-channel.js';

const WORKER_EXPORTS = [
    'rdpConnect', 'rdpDisconnect', 'rdpMouseMove', 'rdpMouseDown', 'rdpMouseUp',
    'rdpMouseWheel', 'rdpMouseHScroll', 'rdpKeyDown', 'rdpKeyUp',
    'rdpClipboardChanged', 'rdpNotifyFilesChanged', 'rdpAudinData',
    'rdpLocationData', 'rdpCameraFrame', 'rdpFsAttachDrive', 'rdpFsDetachDrive',
    'rdpRequestFullRefresh',
];

export class RdpWorkerBridge {
    constructor(worker, { syncBytes = 8 * 1024 * 1024, timeoutMs = 30000 } = {}) {
        this.worker = worker;
        this.timeoutMs = timeoutMs;
        this.nextRequestId = 0;
        this.pending = new Map();
        this.closed = false;
        this.readySettled = false;
        this.bootStage = 'created';
        this.bootTimer = null;
        this.bootHistory = [];
        this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
        const sabAvailable = typeof SharedArrayBuffer === 'function';
        this.syncControl = sabAvailable ? new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 4) : null;
        this.syncData = sabAvailable ? new SharedArrayBuffer(syncBytes) : null;
        this.worker.addEventListener('message', (event) => this._message(event.data));
        this.worker.addEventListener('error', (event) => {
            const error = new Error(event.message || 'RDP Worker failed');
            if (!this.readySettled) { this.readySettled = true; if (this.bootTimer) { clearTimeout(this.bootTimer); this.bootTimer = null; } this.rejectReady(error); }
            for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
            this.pending.clear();
        });
        this.input = new OrderedRdpInputChannel((envelope) => worker.postMessage({ type: 'input', envelope }));
    }

    static probe({ url = './rdp-worker-probe.js', timeoutMs = 3000 } = {}) {
        return new Promise((resolve) => {
            if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
                resolve({ supported: false, reason: 'WORKER_OFFSCREEN_UNAVAILABLE' });
                return;
            }
            const worker = new Worker(url, { type: 'module' });
            let settled = false;
            const finish = (result) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                worker.terminate();
                resolve(result);
            };
            const timer = setTimeout(() => finish({ supported: false, reason: 'WORKER_WEBGL2_PROBE_TIMEOUT' }), timeoutMs);
            worker.addEventListener('message', ({ data }) => finish(data?.ok
                ? { supported: true, renderer: data.renderer || 'webgl2', goRuntime: data.goRuntime === true }
                : { supported: false, reason: 'WORKER_CAPABILITY_PROBE_FAILED', stage: data?.stage || 'unknown', error: data?.error || '' }));
            worker.addEventListener('error', (event) => finish({ supported: false, reason: 'WORKER_WEBGL2_PROBE_ERROR', error: event.message || '' }));
        });
    }

    async init(canvas, options = {}) {
        let offscreen = canvas;
        if (typeof canvas?.transferControlToOffscreen === 'function') offscreen = canvas.transferControlToOffscreen();
        const payload = { type: 'init', canvas: offscreen, options };
        if (this.syncControl && this.syncData) {
            payload.syncControl = this.syncControl;
            payload.syncData = this.syncData;
        }
        this.worker.postMessage(payload, [offscreen]);
        this.bootTimer = setTimeout(() => {
            if (this.readySettled) return;
            this.readySettled = true;
            this.rejectReady(new Error(`RDP Worker boot timed out at ${this.bootStage}`));
            this.close();
        }, this.timeoutMs);
        return this.ready;
    }

    installGlobals(target = globalThis) {
        for (const name of WORKER_EXPORTS) target[name] = (...args) => this.notify(name, args);
        // Connection startup is control-plane state, not a lossy notification.
        // Await a Worker response so missing Go exports and dispatch failures are
        // visible to the page instead of degrading into a watchdog reconnect.
        target.rdpConnect = (...args) => this.call('rdpConnect', args);
        target.rdpMouseMove = (x, y) => this.input.push('mouse-move', { x, y });
        target.rdpMouseDown = (button, x, y) => this.input.push('mouse-down', { button, x, y });
        target.rdpMouseUp = (button, x, y) => this.input.push('mouse-up', { button, x, y });
        target.rdpMouseWheel = (delta) => this.input.push('wheel', { delta });
        target.rdpMouseHScroll = (delta) => this.input.push('hwheel', { delta });
        target.rdpKeyDown = (code) => this.input.push('key-down', { code });
        target.rdpKeyUp = (code) => this.input.push('key-up', { code });
        target.rdpFsAttachDrive = (...args) => { this.notify('rdpFsAttachDrive', args); return `worker:${args[0]}`; };
        target.rdpFsDetachDrive = (...args) => { this.notify('rdpFsDetachDrive', args); return true; };
        target.rdpClipboardChangedSync = (...args) => this.call('rdpClipboardChangedSync', args);
        target.rdpDownloadServerFile = (index, callback) => this.call('rdpDownloadServerFile', [index]).then((data) => callback?.(data)).catch(() => callback?.(null));
        target.rdpGetServerFiles = () => { throw new Error('rdpGetServerFiles is asynchronous in Worker mode'); };
        target.rdpGetServerFilesAsync = () => this.call('rdpGetServerFiles', []);
        target.rdpGetWorkerDiagnostics = () => this.call('rdpGetWorkerDiagnostics', []);
        target.rdpFsListDrives = () => { throw new Error('rdpFsListDrives is asynchronous in Worker mode'); };
        target.rdpFsListDrivesAsync = () => this.call('rdpFsListDrives', []);
        return this;
    }

    /**
     * Replace the Worker-side local file list used by cliprdr/rdpefs.
     * When notify=true, advertise after the Worker has stored the bytes so
     * Windows does not request FileContents against an empty list.
     * @returns {Promise<{count:number}>}
     */
    setLocalFiles(files, { notify = false } = {}) {
        if (this.closed) return Promise.reject(new Error('RDP Worker is closed'));
        const entries = (files || []).map((file) => ({
            name: file.name,
            size: Number(file.size) || file.data?.byteLength || 0,
            isDir: !!file.isDir,
            data: file.data ? new Uint8Array(file.data).slice() : null,
        }));
        const id = ++this.nextRequestId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('setLocalFiles timed out'));
            }, this.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            // Structured clone copies page-owned file bytes so the UI retains
            // its clipboard source. Large files are not JSON/base64 or bounded
            // by the synchronous RPC buffer.
            this.worker.postMessage({ type: 'local-files', id, notify: !!notify, entries });
        });
    }

    notify(method, args = []) {
        if (this.closed) throw new Error('RDP Worker is closed');
        this.worker.postMessage({ type: 'call', method, args });
    }

    call(method, args = []) {
        if (this.closed) return Promise.reject(new Error('RDP Worker is closed'));
        const id = ++this.nextRequestId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, this.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.worker.postMessage({ type: 'request', id, method, args });
        });
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        if (this.bootTimer) { clearTimeout(this.bootTimer); this.bootTimer = null; }
        if (!this.readySettled) {
            this.readySettled = true;
            this.rejectReady(new Error(`RDP Worker closed during boot at ${this.bootStage}`));
        }
        this.input.releaseAll();
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('RDP Worker closed')); }
        this.pending.clear();
        this.worker.terminate();
    }

    _message(message) {
        if (message?.type === 'boot-stage') {
            this.bootStage = String(message.stage || 'unknown');
            this.bootHistory.push({ stage: this.bootStage, detail: message.detail || '', at: Date.now() });
            return;
        }
        if (message?.type === 'boot-error') {
            const error = new Error(`${message.code || 'WORKER_BOOT_FAILED'} at ${message.stage || this.bootStage}: ${message.error || 'unknown error'}`);
            if (!this.readySettled) {
                this.readySettled = true;
                if (this.bootTimer) { clearTimeout(this.bootTimer); this.bootTimer = null; }
                this.rejectReady(error);
            }
            return;
        }
        if (message?.type === 'ready') {
            if (!this.readySettled) {
                this.readySettled = true;
                if (this.bootTimer) { clearTimeout(this.bootTimer); this.bootTimer = null; }
                this.resolveReady(message.capabilities || {});
            }
            return;
        }
        if (message?.type === 'response') {
            const pending = this.pending.get(message.id);
            if (!pending) return;
            clearTimeout(pending.timer);
            this.pending.delete(message.id);
            if (message.ok) pending.resolve(message.value); else pending.reject(new Error(message.error || 'Worker request failed'));
            return;
        }
        if (message?.type === 'callback') {
            const fn = globalThis[message.name];
            if (typeof fn === 'function') {
                const result = fn(...(message.args || []));
                if (result && typeof result.then === 'function') result.catch(() => {});
            }
            return;
        }
        if (message?.type === 'sync-rpc') this._syncRpc(message);
    }

    _syncRpc(message) {
        if (!this.syncControl || !this.syncData) {
            console.warn('[rdp-worker] sync RPC ignored because SharedArrayBuffer is unavailable', message?.name || 'unknown');
            return;
        }
        const control = new Int32Array(this.syncControl);
        const output = new Uint8Array(this.syncData);
        try {
            const fn = globalThis[message.name];
            if (typeof fn !== 'function') throw new Error(`page RPC ${message.name} is unavailable`);
            let args = message.args || [];
            if (message.name === 'zephyrRdpFsWrite' && args.length >= 4) {
                // Worker->page binary arguments arrive as structured-cloned
                // Uint8Array and stay binary; never JSON/base64 encode them.
                args = [...args];
                args[3] = args[3] instanceof Uint8Array ? args[3] : new Uint8Array(args[3]);
            }
            const result = fn(...args);
            if (result && typeof result.then === 'function') throw new Error(`page RPC ${message.name} must be synchronous`);
            if (result instanceof Uint8Array || result instanceof ArrayBuffer) {
                const bytes = result instanceof Uint8Array ? result : new Uint8Array(result);
                if (bytes.byteLength > output.byteLength) throw new Error(`page RPC response exceeds ${output.byteLength} bytes`);
                output.set(bytes);
                Atomics.store(control, 1, 1);
                Atomics.store(control, 2, bytes.byteLength);
            } else {
                const bytes = new TextEncoder().encode(JSON.stringify(result ?? null));
                if (bytes.byteLength > output.byteLength) throw new Error(`page RPC response exceeds ${output.byteLength} bytes`);
                output.set(bytes);
                Atomics.store(control, 1, 0);
                Atomics.store(control, 2, bytes.byteLength);
            }
            Atomics.store(control, 3, 0);
        } catch (error) {
            const bytes = new TextEncoder().encode(error.message || String(error));
            output.set(bytes.subarray(0, output.byteLength));
            Atomics.store(control, 2, Math.min(bytes.byteLength, output.byteLength));
            Atomics.store(control, 3, 1);
        }
        Atomics.store(control, 0, 1);
        Atomics.notify(control, 0, 1);
    }
}
