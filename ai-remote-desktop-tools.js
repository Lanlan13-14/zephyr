'use strict';

const REMOTE_DESKTOP_CAPTURE_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        tabId: { type: 'string', maxLength: 160 },
        maxWidth: { type: 'number', minimum: 320, maximum: 1600 },
        afterCaptureId: { type: 'string', maxLength: 160 },
        requireFresh: { type: 'boolean' },
    },
    additionalProperties: false,
});

const REMOTE_DESKTOP_ACTION_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        tabId: { type: 'string', minLength: 1, maxLength: 160 },
        action: { type: 'string', enum: ['toolbar', 'send_text', 'mouse'] },
        captureId: { type: 'string', minLength: 1, maxLength: 160 },
        control: { type: 'string', enum: ['quality', 'fit', 'zoom', 'clipboard', 'keyboard', 'shortcuts', 'joystick', 'drag', 'ctrl_alt_del', 'reconnect', 'disconnect', 'clipboard_send', 'clipboard_read_local', 'clipboard_copy_remote', 'shortcut', 'text', 'mouse_click'] },
        text: { type: 'string', maxLength: 20000 },
        sequence: { type: 'string', maxLength: 120 },
        paste: { type: 'boolean' },
        qualityMode: { type: 'string', enum: ['balanced', 'performance', 'quality'] },
        fitMode: { type: 'string', enum: ['fit', '1:1', '16:9', '4:3', 'original', 'drag'] },
        zoomPercent: { type: 'number', minimum: 25, maximum: 400 },
        x: { type: 'number', minimum: 0 },
        y: { type: 'number', minimum: 0 },
        button: { type: 'number', minimum: 1, maximum: 3 },
        waitMs: { type: 'number', minimum: 0, maximum: 15000 },
        maxWidth: { type: 'number', minimum: 320, maximum: 1600 },
    },
    required: ['tabId', 'action', 'captureId'],
    additionalProperties: false,
});

const REMOTE_DESKTOP_VERIFY_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        tabId: { type: 'string', minLength: 1, maxLength: 160 },
        beforeCaptureId: { type: 'string', minLength: 1, maxLength: 160 },
        afterCaptureId: { type: 'string', minLength: 1, maxLength: 160 },
        actionId: { type: 'string', maxLength: 160 },
    },
    required: ['tabId', 'beforeCaptureId', 'afterCaptureId'],
    additionalProperties: false,
});

function captureIdFor(snapshot = {}) {
    return String(snapshot.captureId || [snapshot.tabId || 'remote', snapshot.frameAt || snapshot.at || 0, snapshot.width || 0, snapshot.height || 0]
        .map((part) => String(part || 0).replace(/[^A-Za-z0-9_.-]/g, '_')).join(':'));
}

function publicCapture(snapshot = {}) {
    const captureId = captureIdFor(snapshot);
    return {
        ...snapshot,
        captureId,
        frameAt: Number(snapshot.frameAt || snapshot.at || 0),
        hasScreenshot: !!snapshot.dataUrl,
    };
}

function validateActionAgainstCapture(args = {}, snapshot = {}) {
    const current = publicCapture(snapshot);
    if (!current.captureId || current.captureId !== String(args.captureId || '')) {
        const error = new Error('远程桌面画面已变化或 captureId 无效，请重新截图后再操作');
        error.code = 'stale_capture';
        error.retryable = true;
        throw error;
    }
    if (args.action === 'mouse') {
        const x = Number(args.x), y = Number(args.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw Object.assign(new Error('鼠标操作需要 x/y'), { code: 'invalid_remote_coordinates' });
        if (x > Number(current.width || 0) || y > Number(current.height || 0)) throw Object.assign(new Error('鼠标坐标超出 captureId 对应截图范围'), { code: 'invalid_remote_coordinates' });
    }
    if (args.action === 'send_text' && !String(args.text || '') && !String(args.sequence || '')) {
        throw Object.assign(new Error('发送文本操作需要 text 或 sequence'), { code: 'invalid_remote_action' });
    }
    return current;
}

function clientAction(args = {}) {
    const action = args.action === 'mouse' ? 'remote_desktop_mouse' : args.action === 'send_text' ? 'remote_desktop_send_text' : 'remote_desktop_toolbar';
    return {
        action,
        tabId: String(args.tabId || ''),
        desktopControl: args.control || (args.action === 'mouse' ? 'mouse_click' : args.action === 'send_text' ? (args.sequence ? 'shortcut' : 'text') : ''),
        captureId: String(args.captureId || ''),
        text: String(args.text || ''),
        sequence: String(args.sequence || ''),
        paste: args.paste !== false,
        qualityMode: args.qualityMode,
        fitMode: args.fitMode,
        zoomPercent: args.zoomPercent,
        x: args.x,
        y: args.y,
        button: args.button || 1,
        coordinateSpace: 'screenshot',
        screenshotWidth: args.screenshotWidth,
        screenshotHeight: args.screenshotHeight,
        originalWidth: args.originalWidth,
        originalHeight: args.originalHeight,
        waitMs: args.waitMs,
        maxWidth: args.maxWidth,
    };
}

module.exports = {
    REMOTE_DESKTOP_CAPTURE_SCHEMA,
    REMOTE_DESKTOP_ACTION_SCHEMA,
    REMOTE_DESKTOP_VERIFY_SCHEMA,
    captureIdFor,
    publicCapture,
    validateActionAgainstCapture,
    clientAction,
};
