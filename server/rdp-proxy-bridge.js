'use strict';

const DEFAULTS = Object.freeze({
    wsHighWater: 4 * 1024 * 1024,
    wsLowWater: 1 * 1024 * 1024,
    wsHardLimit: 32 * 1024 * 1024,
    tcpHardLimit: 8 * 1024 * 1024,
});

function attachRdpProxyBridge({ ws, tcpConn, flowControlEnabled = false, limits = {}, logger = console, onFatal = () => {} }) {
    const cfg = { ...DEFAULTS, ...limits };
    let disposed = false;
    let listenersRemoved = false;
    let tcpPausedForWs = false;
    let tcpPausedByClient = false;
    let wsSocketPausedForTcp = false;
    let wsBacklogTimer = null;

    const fatal = (code, message) => {
        if (disposed) return;
        disposed = true;
        onFatal(code, message);
    };
    const applyTcpPause = () => {
        if (tcpPausedForWs || tcpPausedByClient) tcpConn.pause?.();
        else tcpConn.resume?.();
    };
    const inspectWsBacklog = () => {
        if (disposed) return;
        const buffered = Number(ws.bufferedAmount) || 0;
        if (buffered > cfg.wsHardLimit) return fatal('WS_BUFFER_HARD_LIMIT', `WebSocket bufferedAmount ${buffered} exceeded ${cfg.wsHardLimit}`);
        if (!tcpPausedForWs && buffered >= cfg.wsHighWater) {
            tcpPausedForWs = true;
            applyTcpPause();
        } else if (tcpPausedForWs && buffered <= cfg.wsLowWater) {
            tcpPausedForWs = false;
            applyTcpPause();
        }
    };
    const parseFlowControl = (data) => {
        if (!flowControlEnabled) return false;
        let message;
        try {
            const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
            if (Buffer.byteLength(text) > 4096) throw new Error('control frame too large');
            message = JSON.parse(text);
        } catch (error) {
            fatal('INVALID_FLOW_CONTROL', error.message);
            return true;
        }
        if (message?.type !== 'zephyr-rdp-flow' || !['pause', 'resume'].includes(message.state)) {
            fatal('INVALID_FLOW_CONTROL', 'unknown flow-control message');
            return true;
        }
        tcpPausedByClient = message.state === 'pause';
        applyTcpPause();
        return true;
    };

    const onWsMessage = (data, isBinary) => {
        if (disposed || tcpConn.destroyed) return;
        if (!isBinary) {
            if (parseFlowControl(data)) return;
            fatal('NON_BINARY_RDP_PAYLOAD', 'RDP proxy accepts binary payloads only');
            return;
        }
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
        try {
            const writable = tcpConn.write(buffer);
            if (!writable) {
                wsSocketPausedForTcp = true;
                ws._socket?.pause?.();
            }
            if ((Number(tcpConn.writableLength) || 0) > cfg.tcpHardLimit) {
                fatal('TCP_BUFFER_HARD_LIMIT', `TCP writableLength exceeded ${cfg.tcpHardLimit}`);
            }
        } catch (error) {
            logger.warn?.('[rdp-proxy] ws→tcp write error', error.message);
            fatal('TCP_WRITE_ERROR', error.message);
        }
    };
    const onTcpDrain = () => {
        if (disposed || !wsSocketPausedForTcp) return;
        wsSocketPausedForTcp = false;
        ws._socket?.resume?.();
    };
    const onTcpData = (chunk) => {
        if (disposed || ws.readyState !== ws.OPEN) return;
        try {
            ws.send(chunk, { binary: true }, (error) => {
                if (error) return fatal('WS_SEND_ERROR', error.message);
                inspectWsBacklog();
            });
            inspectWsBacklog();
        } catch (error) {
            logger.warn?.('[rdp-proxy] tcp→ws send error', error.message);
            fatal('WS_SEND_ERROR', error.message);
        }
    };

    ws.on('message', onWsMessage);
    tcpConn.on('data', onTcpData);
    tcpConn.on('drain', onTcpDrain);
    wsBacklogTimer = setInterval(inspectWsBacklog, 10);
    wsBacklogTimer.unref?.();

    return {
        dispose() {
            if (listenersRemoved) return;
            listenersRemoved = true;
            disposed = true;
            if (wsBacklogTimer) { clearInterval(wsBacklogTimer); wsBacklogTimer = null; }
            ws.off?.('message', onWsMessage);
            tcpConn.off?.('data', onTcpData);
            tcpConn.off?.('drain', onTcpDrain);
        },
        inspectWsBacklog,
        state() {
            return { disposed, tcpPausedForWs, tcpPausedByClient, wsSocketPausedForTcp };
        },
    };
}

module.exports = { attachRdpProxyBridge, RDP_PROXY_BACKPRESSURE_DEFAULTS: DEFAULTS };
