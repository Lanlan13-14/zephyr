export const INPUT_BARRIERS = new Set(['mouse-down', 'mouse-up', 'wheel', 'hwheel', 'key-down', 'key-up', 'control']);

export class OrderedRdpInputChannel {
    constructor(send, { now = () => performance.now() } = {}) {
        this.send = send;
        this.now = now;
        this.sequence = 0;
        this.pendingMove = null;
        this.keysDown = new Set();
        this.buttonsDown = new Set();
        this.layoutVersion = 0;
    }

    setLayoutVersion(version) { this.flushMove(); this.layoutVersion = Number(version) || 0; }

    push(type, payload = {}) {
        if (type === 'mouse-move') {
            this.pendingMove = this._envelope(type, payload);
            return this.pendingMove.sequence;
        }
        this.flushMove();
        const envelope = this._envelope(type, payload);
        this._track(envelope);
        this.send(envelope);
        return envelope.sequence;
    }

    flushMove() {
        if (!this.pendingMove) return;
        const envelope = this.pendingMove;
        this.pendingMove = null;
        this.send(envelope);
    }

    releaseAll() {
        this.pendingMove = null;
        for (const code of [...this.keysDown].reverse()) this.send(this._envelope('key-up', { code, synthetic: true }));
        for (const button of [...this.buttonsDown].reverse()) this.send(this._envelope('mouse-up', { button, synthetic: true }));
        this.keysDown.clear();
        this.buttonsDown.clear();
    }

    _envelope(type, payload) {
        return { sequence: ++this.sequence, sampleTime: this.now(), layoutVersion: this.layoutVersion, type, payload: structuredClone(payload) };
    }

    _track(envelope) {
        const { type, payload } = envelope;
        if (type === 'key-down') this.keysDown.add(payload.code);
        else if (type === 'key-up') this.keysDown.delete(payload.code);
        else if (type === 'mouse-down') this.buttonsDown.add(payload.button);
        else if (type === 'mouse-up') this.buttonsDown.delete(payload.button);
    }
}
