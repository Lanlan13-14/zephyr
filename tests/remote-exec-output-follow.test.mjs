import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

for (const name of ['terminal.js', 'telnet-terminal.js']) {
    const source = readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
    function pane() {
        const queue = [];
        const state = { scrolls: 0, writes: 0, locked: false, selection: false, mobile: false };
        const context = vm.createContext({
            term: { write() { state.writes++; } }, sftpPro: null,
            terminalAutoFollowEnabled: true, mobileTerminalSelectionMode: false,
            document: { documentElement: { dataset: { liteTerminal: '1' } } }, remoteLiteFollowPaused: false,
            mobileStableEchoSuppressUntil: 0,
            requestAnimationFrame(fn) { queue.push(fn); return queue.length; },
            isMobileTerminalAutoFollowLocked: () => state.locked,
            isTerminalUserReadingHistory: () => false,
            hasLiveTerminalSelection: () => state.selection,
            isTerminalAtBottom: () => false,
            isMobileStableInputMode: () => state.mobile,
            isMobileStablePlainEchoData: () => false,
            updateTerminalMouseTrackingFromData() {}, logTerminalScrollDiagnostics() {},
            scheduleTerminalScrollbarUpdate() {}, ensureTerminalSurface: () => null,
            getWTermScrollTarget: () => ({ scrollToBottom() { state.scrolls++; } }),
        });
        const start = source.indexOf('let terminalOutputFollowRaf = 0;');
        const end = source.indexOf('\nfunction hideInfoModal()', start);
        assert.ok(start > 0 && end > start);
        vm.runInContext(source.slice(start, end), context);
        return { context, state, flush() { while (queue.length) queue.shift()(); } };
    }
    test(`${name}: all four independently following panes follow output without focus`, () => {
        const panes = Array.from({ length: 4 }, pane);
        for (const p of panes) {
            p.context.writeTerminalData('chunk one\r\n');
            p.context.writeTerminalData('chunk two\r\n');
        }
        panes.forEach(p => p.flush());
        panes.forEach(p => { assert.equal(p.state.writes, 2); assert.equal(p.state.scrolls, 1); });
    });
    test(`${name}: xterm output follow runs after its own render commits the new viewport`, () => {
        const p = pane();
        const callbacks = [];
        let ydisp = 2;
        p.context.term.onRenderComplete = (fn) => { callbacks.push(fn); return () => {}; };
        p.context.term.bridge = { scrollToBottom() { ydisp = 40; } };
        p.context.term._scheduleRender = () => {};
        p.context.writeTerminalData('long output\r\n');
        p.flush();
        assert.equal(ydisp, 2, 'must wait for WTerm render completion');
        callbacks.forEach((fn) => fn());
        assert.equal(ydisp, 40, 'must move this pane viewport to latest output');
        assert.equal(p.state.scrolls, 0, 'must use xterm bridge, not stale DOM maxScroll');
    });

    test(`${name}: paused pane and live selection never follow`, () => {
        const p = pane();
        p.context.terminalAutoFollowEnabled = false;
        p.context.remoteLiteFollowPaused = true;
        p.context.writeTerminalData('history reading'); p.flush();
        assert.equal(p.state.scrolls, 0);
        p.context.terminalAutoFollowEnabled = true;
        p.state.selection = true;
        p.context.writeTerminalData('selection'); p.flush();
        assert.equal(p.state.scrolls, 0);
    });
    test(`${name}: user pause, selection, history lock or reconnect before paint cancels follow`, () => {
        for (const cancel of [p => p.context.terminalAutoFollowEnabled = false,
            p => p.state.selection = true, p => p.state.locked = true,
            p => p.context.term = { write() {} }]) {
            const p = pane(); p.context.writeTerminalData('pending output'); cancel(p); p.flush();
            assert.equal(p.state.scrolls, 0);
        }
    });
    test(`${name}: mobile retains existing surface-owned output policy`, () => {
        const p = pane(); p.state.mobile = true;
        p.context.writeTerminalData('mobile'); p.flush();
        assert.equal(p.state.scrolls, 0);
    });
    test(`${name}: native xterm wheel samples history intent without double scrolling`, () => {
        assert.match(source, /queueMicrotask\(\(\) => updateTerminalAutoFollowFromScroll\('native-wheel'\)\)/);
    });
}

test('remote structural wrappers do not receive square glass boxes and subtitle is absent', () => {
    const css = readFileSync(new URL('../public/zephyr-terminal-spec.css', import.meta.url), 'utf8');
    const html = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
    assert.doesNotMatch(css, /html body\.app-body \.remote-layout > \*,/);
    assert.doesNotMatch(css, /\.remote-layout:not\(\.remote-desktop-shell\) > \*/);
    assert.doesNotMatch(html, /remoteWorkspaceHint|勾选服务器开启多窗口实时终端 · 单击窗口放大与简单操作/);
    assert.match(css, /\.remote-servers-panel\s*\{[^}]*border-radius: var\(--z-radius-window, 24px\)/);
});

test('batch pane height overrides inactive full-terminal drawer minimum height', () => {
    const css = readFileSync(new URL('../public/zephyr-terminal-spec.css', import.meta.url), 'utf8');
    const body = '#remoteWorkspace.terminal-workspace-grid > .terminal-window.remote-exec-window > .terminal-window-body';
    assert.ok(css.indexOf(body + ' {') > css.indexOf('min-height: calc(var(--z-pane-full-h, 520px) - 42px)'));
    const rule = css.slice(css.indexOf(body + ' {'), css.indexOf('}', css.indexOf(body + ' {')));
    assert.match(rule, /min-height: 0 !important/);
    assert.match(rule, /height: 0 !important/);
    assert.match(rule, /flex: 1 1 0% !important/);
    assert.ok(css.includes(body + ' > iframe.terminal-frame {'));
});
