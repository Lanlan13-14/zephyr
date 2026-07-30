export class OrderedRenderCommandQueue {
    constructor({ onError = (error) => { throw error; }, maxDepth = 512 } = {}) {
        this.onError = onError;
        this.maxDepth = Math.max(8, Number(maxDepth) || 512);
        this.entries = [];
        this.head = 0;
        this.nextSequence = 0;
        this.draining = false;
        this.closed = false;
        this.stats = { enqueued: 0, applied: 0, skipped: 0, maxDepth: 0 };
    }

    enqueue(apply, label = '') {
        const ticket = this.reserve(label);
        ticket.resolve(apply);
        return ticket.sequence;
    }

    reserve(label = '') {
        if (this.closed) throw new Error('render command queue is closed');
        const entry = {
            sequence: ++this.nextSequence,
            label: String(label || ''),
            ready: false,
            apply: null,
            dispose: null,
            skipped: false,
            settled: false,
        };
        this.entries.push(entry);
        if (this.depth > this.maxDepth) {
            this.entries.pop();
            throw new Error(`render command queue exceeded ${this.maxDepth}`);
        }
        this.stats.enqueued++;
        this.stats.maxDepth = Math.max(this.stats.maxDepth, this.depth);
        const settle = (apply, { skipped = false, dispose = null } = {}) => {
            if (entry.settled || this.closed) {
                try { dispose?.(); } catch {}
                return false;
            }
            entry.settled = true;
            entry.ready = true;
            entry.apply = typeof apply === 'function' ? apply : null;
            entry.dispose = typeof dispose === 'function' ? dispose : null;
            entry.skipped = skipped;
            this._drain();
            return true;
        };
        return {
            sequence: entry.sequence,
            resolve: (apply, dispose = null) => settle(apply, { dispose }),
            skip: (dispose = null) => settle(null, { skipped: true, dispose }),
        };
    }

    clear() {
        for (let i = this.head; i < this.entries.length; i++) {
            const entry = this.entries[i];
            entry.settled = true;
            entry.ready = true;
            entry.skipped = true;
            try { entry.dispose?.(); } catch {}
            entry.dispose = null;
            entry.apply = null;
        }
        this.entries.length = 0;
        this.head = 0;
    }

    close() {
        this.closed = true;
        this.clear();
    }

    get depth() { return this.entries.length - this.head; }
    get blocked() { return this.depth > 0 && !this.entries[this.head].ready; }

    _drain() {
        if (this.draining || this.closed) return;
        this.draining = true;
        try {
            while (this.head < this.entries.length) {
                const entry = this.entries[this.head];
                if (!entry.ready) break;
                this.head++;
                try {
                    if (entry.apply) entry.apply();
                    if (entry.skipped) this.stats.skipped++;
                    else this.stats.applied++;
                } catch (error) {
                    try { this.onError(error, entry); } catch {}
                } finally {
                    try { entry.dispose?.(); } catch {}
                }
            }
            if (this.head > 1024 && this.head * 2 >= this.entries.length) {
                this.entries = this.entries.slice(this.head);
                this.head = 0;
            } else if (this.head === this.entries.length) {
                this.entries.length = 0;
                this.head = 0;
            }
        } finally {
            this.draining = false;
        }
    }
}
