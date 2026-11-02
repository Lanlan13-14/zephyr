import { encodeShortcutKeys } from './terminal-shortcuts.js';

// No shell, socket, auth settings or approval UI lives here. Only tickets minted
// by the existing AI confirmation path can reach the existing page dispatcher.
export function createBatchExecutionBridge({ api, getAccountId, getView, getFocusedId, getSessions, getConnections,
    canControl, dispatch, select, deselect, focus, promote, reconnect, getTimeoutSeconds,
    now = Date.now, uuid = () => crypto.randomUUID() }) {
    const snapshots = new Map();
    const executions = new Map();
    const timeoutStates = new WeakMap();
    let account = '';
    function syncAccount() {
        const next = String(getAccountId() || '');
        if (account !== next) { snapshots.clear(); executions.clear(); account = next; }
        return next;
    }
    function sessions() { return Array.from(getSessions() || []); }
    function snapshot() {
        const accountId = syncAccount();
        const capturedAt = now();
        for (const [id, record] of snapshots) if (capturedAt - record.capturedAt > 600000) snapshots.delete(id);
        const all = sessions();
        const refs = new Map(all.map(s => [String(s.id), { session: s, frame: s.frame, window: s.frame?.contentWindow }]));
        const snapshotId = uuid();
        if (snapshots.size >= 200) snapshots.delete(snapshots.keys().next().value);
        const view = String(getView() || '');
        const targets = all.map(s => ({
            id: String(s.id), sessionId: String(s.sessionId || s.id), connectionId: String(s.connectionId),
            status: String(s.status || 'unknown'), loaded: s.loaded === true, sharedView: !!s.sharedView,
            canControl: view === 'remote' && !s.closing && s.loaded === true
                && ['connected', 'running'].includes(s.status) && canControl(s) === true,
            lastSentAt: Number(s.lastSentAt) || 0,
            timeout: timeoutStates.get(s) || (s.timeoutStopFallback ? { state: 'interrupt_ack_pending', at: 0 }
                : s.timeoutTimer ? { state: 'armed', at: 0 } : null),
        }));
        snapshots.set(snapshotId, { refs, capturedAt, accountId, view });
        return { snapshotId, accountId, capturedAt, view, focusedTargetId: String(getFocusedId() || ''), targets };
    }
    function observeTimeout(session, data) {
        if (data.type === 'remote-exec-timeout-stopped') timeoutStates.set(session, { state: 'interrupt_sent_not_process_exit', at: now() });
        if (data.type === 'remote-exec-timeout-failed') timeoutStates.set(session, { state: 'interrupt_unconfirmed', at: now() });
    }
    function check(ticket, signal, remainingIds = ticket.args.targetIds) {
        if (signal?.aborted) throw Object.assign(new Error('cancelled_before_send'), { name: 'AbortError' });
        if (!account || String(getAccountId() || '') !== account || ticket.accountId !== account) throw new Error('batch_account_changed');
        if (getView() !== 'remote') throw new Error('batch_view_changed');
        const record = snapshots.get(ticket.args.snapshotId);
        if (!record || record.accountId !== account || record.view !== 'remote' || now() - record.capturedAt > 600000 || ticket.expiresAt < now()) throw new Error('batch_snapshot_stale');
        const current = new Map(sessions().map(s => [String(s.id), s]));
        const selected = [];
        if (ticket.args.action === 'select') {
            const connections = getConnections();
            for (const id of ticket.args.connectionIds) if (!connections.some(c => String(c.id) === id && String(c.protocol).toUpperCase() === 'SSH')) throw new Error('batch_connection_stale');
        } else {
            for (const id of remainingIds) {
                const ref = record.refs.get(id), s = current.get(id);
                if (!ref || s !== ref.session || s.frame !== ref.frame || s.frame?.contentWindow !== ref.window
                    || ticket.targets.find(t => t.id === id)?.connectionId !== String(s.connectionId)) throw new Error('batch_target_stale');
                if (!['deselect', 'focus', 'promote', 'reconnect'].includes(ticket.args.action)
                    && (!s.loaded || s.closing || !['connected', 'running'].includes(s.status) || !canControl(s))) throw new Error('batch_not_controller');
                selected.push(s);
            }
        }
        return selected;
    }
    async function executeOnce(capture, { signal = null } = {}) {
        syncAccount();
        let ticket = null;
        let started = false;
        let result;
        try {
            if (signal?.aborted) return { state: 'cancelled_before_send', sent: 0 };
            ticket = await api('/api/ai/batch-execution/claim', { method: 'POST', signal,
                body: JSON.stringify({ ticketId: capture.ticketId, snapshotId: capture.snapshotId }) });
            const targets = check(ticket, signal);
            const args = ticket.args;
            const scope = { targetIds: args.targetIds, focusOnly: false, detailed: true };
            let type, payload;
            if (args.action === 'command') {
                const seconds = args.timeoutSeconds ?? getTimeoutSeconds();
                type = 'remote-exec-tool-command';
                payload = { command: args.command, appendEnter: true, timeoutSeconds: seconds };
            } else if (args.action === 'shortcut') {
                encodeShortcutKeys(args.keys); // Same validation as the user shortcut panel.
                type = 'remote-exec-shortcut'; payload = { shortcut: { keys: args.keys } };
            } else if (args.action === 'font') {
                type = 'remote-exec-font-size'; payload = { delta: args.delta };
            } else if (['interrupt', 'clear'].includes(args.action)) {
                type = 'remote-exec-tool-command';
                payload = { command: args.action === 'interrupt' ? '\u0003' : '\u000c', appendEnter: false, timeoutSeconds: null };
            }
            // No awaits between the final scope/controller check and dispatch.
            check(ticket, signal);
            started = true;
            if (type) {
                const receipt = await dispatch(type, payload, scope);
                result = { state: 'transport_receipt', ...receipt };
                // A late cancel/view/account change never invalidates a real ACK
                // and never triggers a retry; report the transport evidence.
                try { check(ticket, signal); } catch (err) { result.postDispatchChanged = err.message; }
                if (args.action === 'command' && payload.timeoutSeconds) for (const s of targets) {
                    if (receipt.targets?.some(t => t.id === String(s.id) && t.state === 'transport_accepted')) timeoutStates.set(s, { state: 'armed', at: now() });
                }
            } else {
                const applied = [];
                const ids = args.action === 'select' ? args.connectionIds : args.targetIds;
                for (const [index, id] of ids.entries()) {
                    check(ticket, signal, ids.slice(index));
                    let ok;
                    if (args.action === 'select') ok = await select(id);
                    if (args.action === 'deselect') ok = await deselect(id);
                    if (args.action === 'focus') ok = await focus(id);
                    if (args.action === 'promote') ok = await promote(id);
                    if (args.action === 'reconnect') ok = await reconnect(id);
                    applied.push({ id, state: ok === false || ok === null ? 'ui_unconfirmed' : 'ui_applied', at: now() });
                }
                result = { state: 'ui_applied', sent: 0, failed: applied.filter(t => t.state === 'ui_unconfirmed').length, targets: applied };
            }
        } catch (err) {
            result = { state: !started && err.name === 'AbortError' ? 'cancelled_before_send' : 'client_error', sent: 0,
                error: err.message || String(err), deliveryUnknown: started };
        }
        if (ticket) {
            try {
                // Record even if the AI run was cancelled. Cancellation never
                // retries the command and does not assert the remote process died.
                result = await api('/api/ai/batch-execution/receipt', { method: 'POST',
                    body: JSON.stringify({ ticketId: capture.ticketId, result }) });
            } catch (err) { result = { ...result, receiptPersisted: false, receiptError: err.message }; }
        }
        return { ...result, clientCaptured: true, vision: false, commandCompleted: false };
    }
    function execute(capture, options = {}) {
        const owner = syncAccount();
        if (!capture?.ticketId) return Promise.resolve({ state: 'client_error', error: 'batch_ticket_required' });
        const key = `${owner}:${capture.ticketId}`;
        if (executions.has(key)) return executions.get(key);
        if (executions.size >= 200) return Promise.resolve({ state: 'client_error', error: 'batch_client_ledger_full' });
        const flight = executeOnce(capture, options);
        executions.set(key, flight);
        return flight;
    }
    return { snapshot, execute, observeTimeout, invalidate: () => snapshots.clear() };
}
