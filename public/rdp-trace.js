const ALLOWED_EVENT_TYPES = new Set([
    'reset-graphics', 'begin-frame', 'end-frame', 'create-surface',
    'delete-surface', 'map-surface', 'map-surface-scaled', 'bitmap',
    'avc420', 'avc444', 'surface-copy', 'solid-fill', 'cache-put',
    'cache-evict',
]);

function finiteNumber(value, fallback = 0) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function sanitizeRect(rect = {}) {
    return {
        x: finiteNumber(rect.x),
        y: finiteNumber(rect.y),
        width: Math.max(0, finiteNumber(rect.width)),
        height: Math.max(0, finiteNumber(rect.height)),
    };
}

export function sanitizeRdpTraceEvent(event = {}) {
    const type = String(event.type || '');
    if (!ALLOWED_EVENT_TYPES.has(type)) throw new TypeError(`unsupported RDP trace event: ${type || '(empty)'}`);
    const clean = {
        sequence: Math.max(0, finiteNumber(event.sequence)),
        type,
    };
    for (const key of ['frameId', 'surfaceId', 'srcSurfaceId', 'dstSurfaceId', 'codec', 'lc', 'streamRole', 'pixelFormat']) {
        if (event[key] !== undefined) clean[key] = typeof event[key] === 'string' ? event[key] : finiteNumber(event[key]);
    }
    if (event.rect) clean.rect = sanitizeRect(event.rect);
    if (Array.isArray(event.regions)) clean.regions = event.regions.map(sanitizeRect);
    if (event.width !== undefined) clean.width = Math.max(0, finiteNumber(event.width));
    if (event.height !== undefined) clean.height = Math.max(0, finiteNumber(event.height));
    if (event.payloadLength !== undefined) clean.payloadLength = Math.max(0, finiteNumber(event.payloadLength));
    if (event.payloadHash !== undefined) clean.payloadHash = String(event.payloadHash).slice(0, 128);
    return clean;
}

export class RdpTraceRecorder {
    constructor({ maxEvents = 100000 } = {}) {
        this.maxEvents = Math.max(1, Number(maxEvents) || 100000);
        this.events = [];
        this.sequence = 0;
        this.droppedEvents = 0;
    }

    record(event) {
        const clean = sanitizeRdpTraceEvent({ ...event, sequence: ++this.sequence });
        if (this.events.length >= this.maxEvents) {
            this.droppedEvents++;
            return null;
        }
        this.events.push(clean);
        return clean;
    }

    export() {
        return {
            schema: 'zephyr-rdp-render-trace-v1',
            containsSensitivePixels: false,
            droppedEvents: this.droppedEvents,
            events: this.events.map((event) => structuredClone(event)),
        };
    }
}
