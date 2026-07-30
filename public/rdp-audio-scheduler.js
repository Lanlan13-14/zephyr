export class RdpAudioScheduler {
    constructor({ minLatency = 0.025, targetQueue = 0.055, maxQueue = 0.12 } = {}) {
        this.minLatency = minLatency;
        this.targetQueue = targetQueue;
        this.maxQueue = maxQueue;
        this.context = null;
        this.nextAt = 0;
        this.generation = 0;
        this.sources = new Set();
    }

    setContext(context) {
        if (context === this.context) return;
        this.reset();
        this.context = context || null;
        this.nextAt = this._nowPlus(this.minLatency);
    }

    reset({ stopSources = true } = {}) {
        this.generation++;
        if (stopSources) {
            for (const source of this.sources) {
                try { source.stop(); } catch {}
                try { source.disconnect(); } catch {}
            }
            this.sources.clear();
        }
        this.nextAt = this._nowPlus(this.minLatency);
    }

    schedule(buffer) {
        const context = this.context;
        if (!context || context.state === 'closed' || !buffer || !(buffer.duration > 0)) return null;
        const now = Number(context.currentTime) || 0;
        const queued = this.nextAt - now;
        const resync = !Number.isFinite(this.nextAt) || queued < -0.01 || queued > this.maxQueue;
        if (resync) this.reset({ stopSources: queued > this.maxQueue });
        if (this.nextAt < now + this.minLatency) this.nextAt = now + this.minLatency;
        if (resync || this.sources.size === 0) this.nextAt = Math.max(this.nextAt, now + this.targetQueue);

        const source = context.createBufferSource();
        const generation = this.generation;
        source.buffer = buffer;
        source.connect(context.destination);
        this.sources.add(source);
        source.onended = () => {
            this.sources.delete(source);
            try { source.disconnect(); } catch {}
            if (generation !== this.generation) return;
        };
        source.start(this.nextAt);
        this.nextAt += buffer.duration;
        return source;
    }

    close() {
        this.reset();
        this.context = null;
        this.nextAt = 0;
    }

    _nowPlus(offset) {
        if (!this.context || this.context.state === 'closed') return 0;
        return (Number(this.context.currentTime) || 0) + offset;
    }
}
