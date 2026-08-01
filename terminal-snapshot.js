const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_SCROLLBACK = 2000;
const DEFAULT_MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

function clampInt(value, min, max, fallback) {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

/**
 * Maintain a canonical headless terminal for a detached SSH/Telnet session.
 * Raw PTY journals are useful for search/audit, but replaying them from an
 * arbitrary byte tail cannot reconstruct carriage-return/progress/TUI state.
 * A serialized framebuffer can.
 */
function createTerminalSnapshot(options = {}) {
    let cols = clampInt(options.cols, 2, 1000, DEFAULT_COLS);
    let rows = clampInt(options.rows, 1, 500, DEFAULT_ROWS);
    const scrollback = clampInt(options.scrollback, 0, 100000, DEFAULT_SCROLLBACK);
    const maxSnapshotBytes = clampInt(
        options.maxSnapshotBytes,
        64 * 1024,
        16 * 1024 * 1024,
        DEFAULT_MAX_SNAPSHOT_BYTES,
    );
    const terminal = new Terminal({
        cols,
        rows,
        scrollback,
        allowProposedApi: true,
        convertEol: false,
    });
    const serializeAddon = new SerializeAddon();
    terminal.loadAddon(serializeAddon);

    let disposed = false;
    let pending = Promise.resolve();
    let revision = 0;
    let outputSequence = 0;

    function enqueue(task) {
        if (disposed) return Promise.resolve(false);
        pending = pending.then(() => {
            if (disposed) return false;
            return task();
        }, () => {
            if (disposed) return false;
            return task();
        });
        return pending;
    }

    function write(data, sequence = outputSequence + 1) {
        if (disposed || data == null || data === '') return pending;
        const payload = Buffer.isBuffer(data) || data instanceof Uint8Array
            ? new Uint8Array(data)
            : String(data);
        return enqueue(() => new Promise((resolve) => {
            terminal.write(payload, () => {
                revision += 1;
                outputSequence = Math.max(outputSequence, Math.max(0, Number(sequence) || 0));
                resolve(true);
            });
        }));
    }

    function resize(nextCols, nextRows) {
        const c = clampInt(nextCols, 2, 1000, cols);
        const r = clampInt(nextRows, 1, 500, rows);
        if (c === cols && r === rows) return pending;
        cols = c;
        rows = r;
        return enqueue(() => {
            terminal.resize(cols, rows);
            revision += 1;
            return true;
        });
    }

    async function serialize({ scrollback: requestedScrollback = scrollback } = {}) {
        await pending;
        if (disposed) return { data: '', cols, rows, revision, outputSequence, truncated: false };
        const requested = clampInt(requestedScrollback, 0, 100000, scrollback);
        let data = serializeAddon.serialize({ scrollback: requested });
        let truncated = false;
        if (Buffer.byteLength(data, 'utf8') > maxSnapshotBytes) {
            // Serialize fewer complete rows instead of slicing escape sequences.
            let low = 0;
            let high = requested;
            let best = serializeAddon.serialize({ scrollback: 0 });
            while (low <= high) {
                const mid = Math.floor((low + high) / 2);
                const candidate = serializeAddon.serialize({ scrollback: mid });
                if (Buffer.byteLength(candidate, 'utf8') <= maxSnapshotBytes) {
                    best = candidate;
                    low = mid + 1;
                } else {
                    high = mid - 1;
                }
            }
            data = best;
            truncated = true;
        }
        return { data, cols, rows, revision, outputSequence, truncated };
    }

    function dispose() {
        disposed = true;
        try { serializeAddon.dispose?.(); } catch {}
        try { terminal.dispose?.(); } catch {}
    }

    return {
        write,
        resize,
        serialize,
        dispose,
        get cols() { return cols; },
        get rows() { return rows; },
        get revision() { return revision; },
    };
}

module.exports = { createTerminalSnapshot };
