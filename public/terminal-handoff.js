/** PTY transport state, independent from terminal chrome and testable with real/fake sockets.
 * Never invents an owner id. Server derives the lease from this authenticated WebSocket. */
export function createTerminalHandoff({ rpc, applySnapshot, applyFrames, onTaken, onError, schedule = setTimeout, cancel = clearTimeout }) {
    let lease = null, timer = null, stopped = false, inputSeq = 0, queued = 0, generation = 0, taking = false;
    let writes = Promise.resolve();
    const clearTimer = () => { if (timer !== null) cancel(timer); timer = null; };
    function lose(error) {
        stopped = true; clearTimer(); lease = null;
        onError(error);
    }
    async function checked(body) {
        const result = await rpc(body);
        if (!result?.ok) throw Object.assign(new Error(result?.error?.code || 'handoff_failed'), result?.error);
        return result;
    }
    async function poll() {
        if (!lease || stopped) return;
        const active = lease;
        try {
            const result = await checked({ op: 'pty.read', sessionId: active.sessionId, sessionEpoch: active.sessionEpoch, afterSeq: active.afterSeq });
            if (active !== lease || stopped) return;
            await applyFrames(result.frames || []);
            if (active !== lease || stopped) return;
            active.afterSeq = result.nextSeq;
            timer = schedule(poll, result.hasMore ? 0 : 60);
        } catch (error) { if (active === lease && !stopped) lose(error); }
    }
    return {
        get epoch() { return lease?.sessionEpoch; },
        get active() { return Boolean(lease) && !stopped; },
        list: () => checked({ op: 'handoff.list' }),
        async offer() {
            const result = await checked({ op: 'handoff.enable' });
            return result;
        },
        async take(sessionId) {
            if (taking) throw new Error('handoff_in_progress');
            taking = true;
            const current = ++generation;
            stopped = false; clearTimer(); lease = null;
            let prepared;
            try {
                prepared = await checked({ op: 'handoff.prepare', sessionId });
                if (current !== generation || stopped) throw new Error('handoff_cancelled');
                // Must resolve after parser consumption AND the visible renderer, not after enqueue.
                await applySnapshot(prepared.snapshot);
                if (current !== generation || stopped) throw new Error('handoff_cancelled');
                const committed = await checked({ op: 'handoff.commit', prepareId: prepared.prepareId,
                    snapshotHash: prepared.snapshot.snapshotHash, appliedSequence: prepared.snapshot.outputSequence });
                if (current !== generation || stopped) throw new Error('handoff_cancelled');
                await applyFrames(committed.frames || []);
                if (current !== generation || stopped) throw new Error('handoff_cancelled');
                lease = { sessionId, sessionEpoch: committed.sessionEpoch, afterSeq: committed.nextSeq };
                inputSeq = 0;
                onTaken(committed);
                timer = schedule(poll, 0);
                return committed;
            } catch (error) {
                // Abort only a preparation. No automatic retry/ownership reversal on uncertain commit.
                if (prepared) try { await rpc({ op: 'handoff.abort', prepareId: prepared.prepareId }); } catch {}
                if (current === generation) lose(error);
                throw error;
            } finally { taking = false; }
        },
        input(bytes) {
            if (!lease || stopped) return false;
            if (queued >= 64 || bytes.byteLength > 65536) { lose(new Error('input_queue_full')); return true; }
            const active = lease, sequence = ++inputSeq;
            const data = Array.from(bytes, value => String.fromCharCode(value)).join('');
            queued++;
            writes = writes.then(async () => {
                if (active !== lease || stopped) throw new Error('stale_owner');
                await checked({ op: 'pty.input', sessionId: active.sessionId, sessionEpoch: active.sessionEpoch,
                    inputSeq: sequence, data: btoa(data) });
            }).catch(error => {
                if (active !== lease || stopped) return;
                lose(error);
            }).finally(() => { queued--; });
            return true;
        },
        async resize(cols, rows) {
            if (!lease || stopped) return;
            try { await checked({ op: 'pty.resize', sessionId: lease.sessionId, sessionEpoch: lease.sessionEpoch, cols, rows }); }
            catch (error) { lose(error); }
        },
        stop() { generation++; stopped = true; lease = null; clearTimer(); },
    };
}
