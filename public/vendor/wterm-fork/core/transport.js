export class WebSocketTransport {
    constructor(options = {}) {
        this._ws = null;
        this._reconnectTimer = null;
        this._reconnectDelay = 1000;
        this._closed = false;
        this._buffer = [];
        this.url = options.url ?? null;
        this.reconnect = options.reconnect !== false;
        this.maxReconnectDelay = options.maxReconnectDelay ?? 30000;
        this.onData = options.onData ?? null;
        this.onOpen = options.onOpen ?? null;
        this.onClose = options.onClose ?? null;
        this.onError = options.onError ?? null;
    }
    connect(url) {
        if (url)
            this.url = url;
        if (!this.url)
            throw new Error("No WebSocket URL provided");
        this._closed = false;
        this._ws = new WebSocket(this.url);
        this._ws.binaryType = "arraybuffer";
        this._ws.onopen = () => {
            this._reconnectDelay = 1000;
            this._flushBuffer();
            if (this.onOpen)
                this.onOpen();
        };
        this._ws.onmessage = (event) => {
            if (this.onData) {
                if (event.data instanceof ArrayBuffer) {
                    this.onData(new Uint8Array(event.data));
                }
                else {
                    this.onData(event.data);
                }
            }
        };
        this._ws.onclose = () => {
            if (this.onClose)
                this.onClose();
            if (this.reconnect && !this._closed)
                this._scheduleReconnect();
        };
        this._ws.onerror = (event) => {
            if (this.onError)
                this.onError(event);
            this._ws?.close();
        };
    }
    send(data) {
        if (this._ws && this._ws.readyState === WebSocket.OPEN) {
            if (typeof data === "string") {
                this._ws.send(new TextEncoder().encode(data));
            }
            else {
                this._ws.send(data);
            }
        }
        else {
            this._buffer.push(data);
        }
    }
    close() {
        this._closed = true;
        if (this._reconnectTimer)
            clearTimeout(this._reconnectTimer);
        if (this._ws)
            this._ws.close();
    }
    get connected() {
        return this._ws !== null && this._ws.readyState === WebSocket.OPEN;
    }
    _flushBuffer() {
        const items = this._buffer.splice(0);
        for (const item of items) {
            this.send(item);
        }
    }
    _scheduleReconnect() {
        this._reconnectTimer = setTimeout(() => {
            this.connect();
        }, this._reconnectDelay);
        this._reconnectDelay = Math.min(this._reconnectDelay * 2, this.maxReconnectDelay);
    }
}
//# sourceMappingURL=transport.js.map