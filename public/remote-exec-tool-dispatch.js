// Resolves scope at click time. Never queue tool keystrokes to a future session.
export function selectRemoteToolTargets(sessions, activeId, focusOnly = false) {
    const all = sessions instanceof Map ? [...sessions.values()] : Array.from(sessions || []);
    return (focusOnly ? all.filter((session) => String(session.id) === String(activeId || '')) : all)
        .filter((session) => session && !session.closing && session.loaded && ['connected', 'running'].includes(session.status));
}
export function createRemoteToolDispatcher({ getSessions, getActiveId, isActive, postMessage, onResult = () => {}, onSent = () => {}, timeoutMs = 2500, setTimer = setTimeout, clearTimer = clearTimeout }) {
    const pending = new Map();
    let sequence = 0;
    function finish(entry) {
        clearTimer(entry.timer);
        pending.delete(entry.requestId);
        const result = { sent: entry.sent, failed: entry.failed, total: entry.total };
        if (entry.detailed) result.targets = entry.receipts;
        entry.resolve(result);
        onResult(result);
    }
    function send(type, payload, { focusOnly = false, targetIds = null, detailed = false } = {}) {
        if (!isActive()) return Promise.resolve({ sent: 0, failed: 0, total: 0 });
        let targets = selectRemoteToolTargets(getSessions(), getActiveId(), focusOnly);
        if (targetIds) targets = targets.filter((session) => targetIds.includes(String(session.id)));
        if (!targets.length) { const result = { sent: 0, failed: 0, total: 0 }; onResult(result); return Promise.resolve(result); }
        const requestId = `remote-tool-${Date.now()}-${++sequence}`;
        return new Promise((resolve) => {
            const entry = { requestId, type, payload, resolve, waiting: new Map(targets.map((session) => [String(session.id), session])), sent: 0, failed: 0, total: targets.length, detailed, receipts: [], timer: null };
            pending.set(requestId, entry);
            entry.timer = setTimer(() => { entry.failed += entry.waiting.size; for (const id of entry.waiting.keys()) entry.receipts.push({ id, state: 'delivery_unknown', reason: 'ack_timeout', at: Date.now() }); entry.waiting.clear(); finish(entry); }, timeoutMs);
            for (const session of targets) {
                if (!postMessage(session, { type, ...payload, requestId, suppressBroadcast: true })) {
                    if (entry.waiting.delete(String(session.id))) { entry.failed++; entry.receipts.push({ id: String(session.id), state: 'not_sent', reason: 'post_failed', at: Date.now() }); }
                }
            }
            if (!entry.waiting.size && pending.has(requestId)) finish(entry);
        });
    }
    function acknowledge(session, data) {
        const entry = pending.get(data?.requestId);
        if (!entry || entry.waiting.get(String(session?.id)) !== session) return false;
        if (data.type !== `${entry.type}-sent` && data.type !== `${entry.type}-failed`) return false;
        entry.waiting.delete(String(session.id));
        entry.receipts.push({ id: String(session.id), state: data.type.endsWith('-sent') ? 'transport_accepted' : 'not_sent', reason: String(data.reason || ''), at: Date.now() });
        if (data.type.endsWith('-sent')) { entry.sent++; onSent(session, { type: entry.type, payload: entry.payload, requestId: entry.requestId }); } else entry.failed++;
        if (!entry.waiting.size) finish(entry);
        return true;
    }
    function destroy() {
        for (const entry of [...pending.values()]) { entry.failed += entry.waiting.size; entry.waiting.clear(); finish(entry); }
    }
    return { send, acknowledge, destroy };
}
