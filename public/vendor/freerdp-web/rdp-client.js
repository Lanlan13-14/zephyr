/**
 * RDP Web Client - Reusable ES Module
 * Shadow DOM isolated component for browser-based RDP via WebSocket
 * 
 * @example Basic usage
 * import { RDPClient } from './rdp-client.js';
 * 
 * const client = new RDPClient(document.getElementById('container'), {
 *   wsUrl: 'ws://localhost:8765',
 *   showTopBar: true,
 *   showBottomBar: true,
 *   keepConnectionModalOpen: false
 * });
 * 
 * await client.connect({ host: '192.168.1.100', user: 'admin', pass: 'secret' });
 * 
 * @example With theme customization
 * import { RDPClient } from './rdp-client.js';
 * 
 * const client = new RDPClient(container, {
 *   theme: {
 *     preset: 'dark',
 *     colors: {
 *       accent: '#00b4d8',
 *       buttonHover: '#0096c7'
 *     }
 *   }
 * });
 */

import { resolveTheme, themeToCssVars, sanitizeTheme, fontsToCss, themes } from './rdp-themes.js';
import { Magic, matchMagic, parsePointerPosition, parsePointerSystem, parsePointerSet } from './wire-format.js';
import { RDPSecurityPolicy } from './rdp-security.js';

// ============================================================
// BASE URL - Compute the directory containing this script for dynamic resource loading
// ============================================================
const RDP_CLIENT_BASE_URL = new URL('./', import.meta.url).href;

// ============================================================
// STYLES - Shadow DOM isolated styles (uses CSS custom properties for theming)
// ============================================================
const STYLES = `
:host {
    display: block;
    width: 100%;
    height: 100%;
    
    /* Typography */
    --rdp-font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    --rdp-font-size: 14px;
    --rdp-font-size-small: 0.85rem;
    
    /* Colors - defaults (overridden by theme) */
    --rdp-bg: #1a1a2e;
    --rdp-surface: #16213e;
    --rdp-border: #0f3460;
    --rdp-text: #eeeeee;
    --rdp-text-muted: #888888;
    --rdp-accent: #51cf66;
    --rdp-accent-text: #000000;
    --rdp-error: #ff6b6b;
    --rdp-success: #51cf66;
    --rdp-btn-bg: #0f3460;
    --rdp-btn-hover: #1a4a7a;
    --rdp-btn-text: #eeeeee;
    --rdp-btn-active-bg: #51cf66;
    --rdp-btn-active-text: #000000;
    --rdp-input-bg: #1a1a2e;
    --rdp-input-border: #0f3460;
    --rdp-input-focus-border: #51cf66;
    
    /* Shape */
    --rdp-border-radius: 4px;
    --rdp-border-radius-lg: 8px;
    
    font-family: var(--rdp-font-family);
    font-size: var(--rdp-font-size);
}

* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

.rdp-container {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    background: var(--rdp-bg);
    color: var(--rdp-text);
    overflow: hidden;
}

/* Top Bar */
.rdp-topbar {
    background: var(--rdp-surface);
    padding: 8px 16px;
    display: flex;
    align-items: center;
    gap: 16px;
    border-bottom: 1px solid var(--rdp-border);
    flex-shrink: 0;
}

.rdp-topbar.hidden { display: none; }

.rdp-status {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--rdp-font-size-small);
}

.rdp-status-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--rdp-error);
    transition: background 0.3s;
}

.rdp-status-dot.connected { background: var(--rdp-success); }

.rdp-controls {
    margin-left: auto;
    display: flex;
    gap: 8px;
}

.rdp-btn {
    background: var(--rdp-btn-bg);
    border: none;
    color: var(--rdp-btn-text);
    padding: 6px 14px;
    border-radius: var(--rdp-border-radius);
    cursor: pointer;
    font-size: var(--rdp-font-size-small);
    font-family: inherit;
    transition: background 0.2s, color 0.2s;
}

.rdp-btn:hover { background: var(--rdp-btn-hover); }
.rdp-btn:active { background: var(--rdp-btn-active-bg); color: var(--rdp-btn-active-text); }
.rdp-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* Overflow Menu */
.rdp-overflow-container {
    position: relative;
}

.rdp-btn-overflow {
    display: none;
    font-size: var(--rdp-font-size-small);
    padding: 6px 10px;
}

.rdp-btn-overflow.visible {
    display: inline-flex;
}

.rdp-overflow-dropdown {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 4px;
    background: var(--rdp-surface);
    border: 1px solid var(--rdp-border);
    border-radius: var(--rdp-border-radius);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    display: none;
    flex-direction: column;
    min-width: 140px;
    z-index: 100;
    padding: 4px 0;
}

.rdp-overflow-dropdown.open {
    display: flex;
}

.rdp-overflow-dropdown .rdp-btn {
    border-radius: 0;
    text-align: left;
    justify-content: flex-start;
    white-space: nowrap;
}

.rdp-overflow-dropdown .rdp-btn:first-child {
    border-radius: var(--rdp-border-radius) var(--rdp-border-radius) 0 0;
}

.rdp-overflow-dropdown .rdp-btn:last-child {
    border-radius: 0 0 var(--rdp-border-radius) var(--rdp-border-radius);
}

.rdp-btn.rdp-collapsed {
    display: none !important;
}

/* No word wrapping, single line text for buttons */
.rdp-btn-no-wrap {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 200px;
}

/* Screen Area */
.rdp-screen-wrapper {
    flex: 1;
    display: flex;
    justify-content: center;
    align-items: stretch;
    padding: 0;
    min-height: 0;
    /* Scrolling controlled via CSS custom properties - only scroll when needed */
    overflow-x: var(--rdp-overflow-x, hidden);
    overflow-y: var(--rdp-overflow-y, hidden);
}

.rdp-screen {
    background: transparent;
    border: 0;
    border-radius: 0;
    overflow: hidden;
    position: relative;
    flex: 1;
    width: 100%;
    height: 100%;
    min-height: 0;
    display: flex;
    justify-content: center;
    align-items: stretch;
    /* Minimum dimensions from options (0 = auto) */
    min-width: var(--rdp-screen-min-width, 0);
}

.rdp-screen canvas {
    display: block;
    width: 100%;
    height: 100%;
    /* When min dimensions are set, canvas respects them; otherwise scales to fit */
    min-width: var(--rdp-canvas-min-width, 0);
    min-height: var(--rdp-canvas-min-height, 0);
    max-width: 100%;
    max-height: 100%;
    object-fit: fill;
    background: #000;
    outline: none;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
}

/* API Cursor Overlay - shown when using programmatic mouse API */
.rdp-api-cursor {
    position: absolute;
    pointer-events: none;
    z-index: 100;
    display: none;
    transform: translate(-2px, -2px);
}

.rdp-api-cursor.visible {
    display: block;
}

.rdp-api-cursor-icon {
    width: 24px;
    height: 24px;
    filter: drop-shadow(1px 1px 2px rgba(0, 0, 0, 0.7));
}

.rdp-loading {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    text-align: center;
}

.rdp-loading p {
    color: #ccc;
}

.rdp-spinner {
    width: 36px;
    height: 36px;
    border: 3px solid #333;
    border-top-color: var(--rdp-accent);
    border-radius: 50%;
    animation: rdp-spin 1s linear infinite;
    margin: 0 auto 12px;
}

@keyframes rdp-spin {
    to { transform: rotate(360deg); }
}

/* Bottom Bar */
.rdp-bottombar {
    background: var(--rdp-surface);
    padding: 6px 16px;
    font-size: var(--rdp-font-size-small);
    color: var(--rdp-text-muted);
    display: flex;
    justify-content: space-between;
    border-top: 1px solid var(--rdp-border);
    flex-shrink: 0;
}

.rdp-bottombar.hidden { display: none; }

/* Modal */
.rdp-modal {
    display: none;
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.7);
    justify-content: center;
    align-items: center;
    z-index: 10;
}

.rdp-modal.active { display: flex; }

.rdp-modal-content {
    background: var(--rdp-surface);
    padding: 24px;
    border-radius: var(--rdp-border-radius-lg);
    max-width: 360px;
    width: 90%;
}

.rdp-modal-content h2 {
    margin-bottom: 16px;
    font-size: 1.1rem;
}

.rdp-form-group {
    margin-bottom: 12px;
}

.rdp-form-group label {
    display: block;
    margin-bottom: 4px;
    font-size: 0.85rem;
}

.rdp-form-group input {
    width: 100%;
    padding: 8px;
    border: 1px solid var(--rdp-input-border);
    border-radius: var(--rdp-border-radius);
    background: var(--rdp-input-bg);
    color: var(--rdp-text);
    font-size: var(--rdp-font-size-small);
    font-family: inherit;
}

.rdp-form-group input:focus {
    outline: none;
    border-color: var(--rdp-input-focus-border);
}

.rdp-form-checkbox label {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
}

.rdp-form-checkbox input[type="checkbox"] {
    width: auto;
    cursor: pointer;
}

.rdp-modal-buttons {
    display: flex;
    gap: 8px;
    margin-top: 16px;
}

.rdp-modal-buttons .rdp-btn { flex: 1; }
.rdp-modal-buttons .rdp-btn-primary { background: var(--rdp-accent); color: var(--rdp-accent-text); }
.rdp-modal-buttons .rdp-btn-primary:hover { opacity: 0.9; }

/* Virtual Keyboard Overlay */
.rdp-keyboard-overlay {
    display: none;
    position: absolute;
    background: color-mix(in srgb, var(--rdp-surface) 95%, transparent);
    border: 2px solid var(--rdp-border);
    border-radius: var(--rdp-border-radius-lg);
    padding: 8px;
    z-index: 100;
    user-select: none;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
    overflow: hidden;
}

.rdp-keyboard-overlay.visible { display: block; }

.rdp-keyboard-titlebar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 8px;
    margin-bottom: 8px;
    background: var(--rdp-surface);
    border-radius: var(--rdp-border-radius);
    cursor: move;
}

.rdp-keyboard-title {
    font-size: 0.8rem;
    color: var(--rdp-text-muted);
}

.rdp-keyboard-close {
    background: transparent;
    border: none;
    color: var(--rdp-text-muted);
    font-size: 1.2rem;
    cursor: pointer;
    padding: 2px 6px;
    line-height: 1;
}

.rdp-keyboard-close:hover { color: var(--rdp-error); }

.rdp-keyboard-content {
    transform-origin: top left;
    width: max-content;
}

.rdp-keyboard-rows {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.rdp-keyboard-row {
    display: flex;
    gap: 4px;
    justify-content: center;
}

.rdp-key {
    background: var(--rdp-btn-bg);
    border: 1px solid var(--rdp-border);
    color: var(--rdp-btn-text);
    padding: 8px 12px;
    min-width: 36px;
    height: 36px;
    border-radius: var(--rdp-border-radius);
    cursor: pointer;
    font-size: 0.75rem;
    font-family: inherit;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.1s, transform 0.05s, color 0.1s;
}

.rdp-key:hover { background: var(--rdp-btn-hover); }
.rdp-key:active { transform: scale(0.95); background: var(--rdp-btn-active-bg); color: var(--rdp-btn-active-text); }
.rdp-key.pressed { background: var(--rdp-btn-active-bg); color: var(--rdp-btn-active-text); }

.rdp-key-wide { min-width: 60px; }
.rdp-key-wider { min-width: 80px; }
.rdp-key-widest { min-width: 100px; }
.rdp-key-space { min-width: 200px; }
.rdp-key-special { background: color-mix(in srgb, var(--rdp-btn-bg) 80%, var(--rdp-accent) 20%); }
.rdp-key-special:hover { background: color-mix(in srgb, var(--rdp-btn-hover) 80%, var(--rdp-accent) 20%); }

.rdp-keyboard-resize {
    position: absolute;
    bottom: 4px;
    right: 4px;
    width: 16px;
    height: 16px;
    cursor: nwse-resize;
    opacity: 0.5;
}

.rdp-keyboard-resize:hover { opacity: 1; }

.rdp-keyboard-resize::before,
.rdp-keyboard-resize::after {
    content: '';
    position: absolute;
    background: var(--rdp-text-muted);
    border-radius: 1px;
}

.rdp-keyboard-resize::before {
    width: 12px;
    height: 2px;
    bottom: 2px;
    right: 0;
    transform: rotate(-45deg);
    transform-origin: right bottom;
}

.rdp-keyboard-resize::after {
    width: 8px;
    height: 2px;
    bottom: 6px;
    right: 0;
    transform: rotate(-45deg);
    transform-origin: right bottom;
}
`;

// ============================================================
// HTML TEMPLATE
// ============================================================
const TEMPLATE = `
<div class="rdp-container">
    <div class="rdp-topbar">
        <div class="rdp-status">
            <div class="rdp-status-dot"></div>
            <span class="rdp-status-text">Disconnected</span>
        </div>
        <div class="rdp-controls">
            <button class="rdp-btn rdp-btn-no-wrap rdp-btn-connect" data-collapse-priority="1">Connect</button>
            <button class="rdp-btn rdp-btn-no-wrap rdp-btn-disconnect" data-collapse-priority="2" disabled>Disconnect</button>
            <button class="rdp-btn rdp-btn-no-wrap rdp-btn-keyboard" data-collapse-priority="never" disabled title="Toggle Virtual Keyboard">⌨️</button>
            <button class="rdp-btn rdp-btn-no-wrap rdp-btn-mute" data-collapse-priority="never" disabled title="Toggle Audio">🔊</button>
            <button class="rdp-btn rdp-btn-no-wrap rdp-btn-screenshot" data-collapse-priority="never" disabled title="Take Screenshot">📷</button>
            <button class="rdp-btn rdp-btn-no-wrap rdp-btn-fullscreen" data-collapse-priority="never">⛶</button>
            <div class="rdp-overflow-container">
                <button class="rdp-btn rdp-btn-overflow" title="More options">▼</button>
                <div class="rdp-overflow-dropdown"></div>
            </div>
        </div>
    </div>

    <div class="rdp-screen-wrapper">
        <div class="rdp-screen">
            <div class="rdp-loading">
                <div class="rdp-spinner"></div>
                <p>Click Connect to start</p>
            </div>
            <canvas class="rdp-canvas" width="1280" height="720" style="display: none;"></canvas>
            
            <!-- API Cursor Overlay - shown when using programmatic mouse methods -->
            <div class="rdp-api-cursor">
                <svg class="rdp-api-cursor-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M4 4L10.5 20L12.5 13.5L19 11.5L4 4Z" fill="white" stroke="black" stroke-width="1.5" stroke-linejoin="round"/>
                </svg>
            </div>
            
            <!-- Virtual Keyboard Overlay -->
            <div class="rdp-keyboard-overlay">
                <div class="rdp-keyboard-titlebar">
                    <span class="rdp-keyboard-title">Virtual Keyboard</span>
                    <button class="rdp-keyboard-close" title="Close">×</button>
                </div>
                <div class="rdp-keyboard-content">
                    <div class="rdp-keyboard-rows">
                        <!-- Row 1: Function keys + special -->
                        <div class="rdp-keyboard-row">
                        <button class="rdp-key" data-code="Escape">Esc</button>
                        <button class="rdp-key" data-code="F1">F1</button>
                        <button class="rdp-key" data-code="F2">F2</button>
                        <button class="rdp-key" data-code="F3">F3</button>
                        <button class="rdp-key" data-code="F4">F4</button>
                        <button class="rdp-key" data-code="F5">F5</button>
                        <button class="rdp-key" data-code="F6">F6</button>
                        <button class="rdp-key" data-code="F7">F7</button>
                        <button class="rdp-key" data-code="F8">F8</button>
                        <button class="rdp-key" data-code="F9">F9</button>
                        <button class="rdp-key" data-code="F10">F10</button>
                        <button class="rdp-key" data-code="F11">F11</button>
                        <button class="rdp-key" data-code="F12">F12</button>
                        <button class="rdp-key rdp-key-wide" data-code="Delete">Del</button>
                    </div>
                    <!-- Row 2: Numbers -->
                    <div class="rdp-keyboard-row">
                        <button class="rdp-key" data-code="Backquote" data-key="\`" data-shift="~">\`</button>
                        <button class="rdp-key" data-code="Digit1" data-key="1" data-shift="!" data-altgr="¡" data-shift-altgr="¹">1</button>
                        <button class="rdp-key" data-code="Digit2" data-key="2" data-shift="@" data-altgr="²">2</button>
                        <button class="rdp-key" data-code="Digit3" data-key="3" data-shift="#" data-altgr="³">3</button>
                        <button class="rdp-key" data-code="Digit4" data-key="4" data-shift="$" data-altgr="¤" data-shift-altgr="£">4</button>
                        <button class="rdp-key" data-code="Digit5" data-key="5" data-shift="%" data-altgr="€">5</button>
                        <button class="rdp-key" data-code="Digit6" data-key="6" data-shift="^" data-altgr="¼">6</button>
                        <button class="rdp-key" data-code="Digit7" data-key="7" data-shift="&" data-altgr="½">7</button>
                        <button class="rdp-key" data-code="Digit8" data-key="8" data-shift="*" data-altgr="¾">8</button>
                        <button class="rdp-key" data-code="Digit9" data-key="9" data-shift="(" data-altgr="'">9</button>
                        <button class="rdp-key" data-code="Digit0" data-key="0" data-shift=")" data-altgr="'">0</button>
                        <button class="rdp-key" data-code="Minus" data-key="-" data-shift="_" data-altgr="¥">-</button>
                        <button class="rdp-key" data-code="Equal" data-key="=" data-shift="+" data-altgr="×" data-shift-altgr="÷">=</button>
                        <button class="rdp-key rdp-key-wider" data-code="Backspace">⌫</button>
                    </div>
                    <!-- Row 3: QWERTY top -->
                    <div class="rdp-keyboard-row">
                        <button class="rdp-key rdp-key-wide" data-code="Tab">Tab</button>
                        <button class="rdp-key" data-code="KeyQ" data-key="q" data-shift="Q">Q</button>
                        <button class="rdp-key" data-code="KeyW" data-key="w" data-shift="W">W</button>
                        <button class="rdp-key" data-code="KeyE" data-key="e" data-shift="E">E</button>
                        <button class="rdp-key" data-code="KeyR" data-key="r" data-shift="R">R</button>
                        <button class="rdp-key" data-code="KeyT" data-key="t" data-shift="T">T</button>
                        <button class="rdp-key" data-code="KeyY" data-key="y" data-shift="Y">Y</button>
                        <button class="rdp-key" data-code="KeyU" data-key="u" data-shift="U">U</button>
                        <button class="rdp-key" data-code="KeyI" data-key="i" data-shift="I">I</button>
                        <button class="rdp-key" data-code="KeyO" data-key="o" data-shift="O">O</button>
                        <button class="rdp-key" data-code="KeyP" data-key="p" data-shift="P">P</button>
                        <button class="rdp-key" data-code="BracketLeft" data-key="[" data-shift="{">[</button>
                        <button class="rdp-key" data-code="BracketRight" data-key="]" data-shift="}">]</button>
                        <button class="rdp-key rdp-key-wide" data-code="Backslash" data-key="\\" data-shift="|">\\</button>
                    </div>
                    <!-- Row 4: ASDF middle -->
                    <div class="rdp-keyboard-row">
                        <button class="rdp-key rdp-key-wider" data-code="CapsLock">Caps</button>
                        <button class="rdp-key" data-code="KeyA" data-key="a" data-shift="A" data-altgr="á" data-shift-altgr="Á">A</button>
                        <button class="rdp-key" data-code="KeyS" data-key="s" data-shift="S" data-altgr="ß" data-shift-altgr="§">S</button>
                        <button class="rdp-key" data-code="KeyD" data-key="d" data-shift="D" data-altgr="ð" data-shift-altgr="Ð">D</button>
                        <button class="rdp-key" data-code="KeyF" data-key="f" data-shift="F">F</button>
                        <button class="rdp-key" data-code="KeyG" data-key="g" data-shift="G">G</button>
                        <button class="rdp-key" data-code="KeyH" data-key="h" data-shift="H">H</button>
                        <button class="rdp-key" data-code="KeyJ" data-key="j" data-shift="J">J</button>
                        <button class="rdp-key" data-code="KeyK" data-key="k" data-shift="K">K</button>
                        <button class="rdp-key" data-code="KeyL" data-key="l" data-shift="L" data-altgr="ø" data-shift-altgr="Ø">L</button>
                        <button class="rdp-key" data-code="Semicolon" data-key=";" data-shift=":" data-altgr="¶" data-shift-altgr="°">;</button>
                        <button class="rdp-key" data-code="Quote" data-key="'" data-shift='"' data-altgr="´" data-shift-altgr="¨">'</button>
                        <button class="rdp-key rdp-key-widest" data-code="Enter">Enter</button>
                    </div>
                    <!-- Row 5: ZXCV bottom -->
                    <div class="rdp-keyboard-row">
                        <button class="rdp-key rdp-key-widest rdp-key-modifier" data-code="ShiftLeft" data-modifier="shift">Shift</button>
                        <button class="rdp-key" data-code="KeyZ" data-key="z" data-shift="Z" data-altgr="æ" data-shift-altgr="Æ">Z</button>
                        <button class="rdp-key" data-code="KeyX" data-key="x" data-shift="X">X</button>
                        <button class="rdp-key" data-code="KeyC" data-key="c" data-shift="C" data-altgr="©" data-shift-altgr="¢">C</button>
                        <button class="rdp-key" data-code="KeyV" data-key="v" data-shift="V">V</button>
                        <button class="rdp-key" data-code="KeyB" data-key="b" data-shift="B">B</button>
                        <button class="rdp-key" data-code="KeyN" data-key="n" data-shift="N" data-altgr="ñ" data-shift-altgr="Ñ">N</button>
                        <button class="rdp-key" data-code="KeyM" data-key="m" data-shift="M" data-altgr="µ">M</button>
                        <button class="rdp-key" data-code="Comma" data-key="," data-shift="<" data-altgr="ç" data-shift-altgr="Ç">,</button>
                        <button class="rdp-key" data-code="Period" data-key="." data-shift=">">.</button>
                        <button class="rdp-key" data-code="Slash" data-key="/" data-shift="?" data-altgr="¿">?</button>
                        <button class="rdp-key rdp-key-widest rdp-key-modifier" data-code="ShiftRight" data-modifier="shift">Shift</button>
                    </div>
                    <!-- Row 6: Bottom row -->
                    <div class="rdp-keyboard-row">
                        <button class="rdp-key rdp-key-wide rdp-key-modifier" data-code="ControlLeft" data-modifier="ctrl">Ctrl</button>
                        <button class="rdp-key rdp-key-wide rdp-key-modifier" data-code="MetaLeft" data-modifier="meta">Win</button>
                        <button class="rdp-key rdp-key-wide rdp-key-modifier" data-code="AltLeft" data-modifier="alt">Alt</button>
                        <button class="rdp-key rdp-key-space" data-code="Space" data-key=" ">Space</button>
                        <button class="rdp-key rdp-key-wide rdp-key-modifier" data-code="AltRight" data-modifier="altgr">AltGr</button>
                        <button class="rdp-key rdp-key-wide rdp-key-modifier" data-code="ControlRight" data-modifier="ctrl">Ctrl</button>
                        <button class="rdp-key" data-code="ArrowLeft">←</button>
                        <button class="rdp-key" data-code="ArrowUp">↑</button>
                        <button class="rdp-key" data-code="ArrowDown">↓</button>
                        <button class="rdp-key" data-code="ArrowRight">→</button>
                    </div>
                        <!-- Row 7: Special combos -->
                        <div class="rdp-keyboard-row">
                            <button class="rdp-key rdp-key-widest rdp-key-special" data-combo="alt+tab">Alt+Tab</button>
                            <button class="rdp-key rdp-key-widest rdp-key-special" data-combo="ctrl+alt+delete">Ctrl+Alt+Del</button>
                        </div>
                    </div>
                </div>
                <div class="rdp-keyboard-resize"></div>
            </div>
        </div>
    </div>

    <div class="rdp-bottombar">
        <span class="rdp-resolution">Resolution: --</span>
        <span class="rdp-latency">Latency: --</span>
    </div>

    <div class="rdp-modal">
        <div class="rdp-modal-content">
            <h2>Connect to Remote Desktop</h2>
            <div class="rdp-form-group">
                <label>Host</label>
                <input type="text" class="rdp-input-host" placeholder="192.168.1.100">
            </div>
            <div class="rdp-form-group">
                <label>Port</label>
                <input type="number" class="rdp-input-port" value="3389">
            </div>
            <div class="rdp-form-group">
                <label>Username</label>
                <input type="text" class="rdp-input-user" placeholder="Administrator">
            </div>
            <div class="rdp-form-group">
                <label>Password</label>
                <input type="password" class="rdp-input-pass" placeholder="Password">
            </div>
            <div class="rdp-modal-buttons">
                <button class="rdp-btn rdp-btn-primary rdp-modal-connect">Connect</button>
                <button class="rdp-btn rdp-modal-cancel">Cancel</button>
            </div>
        </div>
    </div>
</div>
`;

// ============================================================
// RDP CLIENT CLASS
// ============================================================
export class RDPClient {
    /** @type {RDPSecurityPolicy} */
    #securityPolicy;
    
    /**
     * Create an RDP Client instance
     * @param {HTMLElement} container - Container element to attach to
     * @param {Object} options - Configuration options
     * @param {string} [options.wsUrl='ws://localhost:8765'] - WebSocket server URL
     * @param {boolean} [options.showTopBar=true] - Show top toolbar
     * @param {boolean} [options.showBottomBar=true] - Show bottom status bar
     * @param {number} [options.reconnectDelay=3000] - Reconnection delay in ms
     * @param {boolean} [options.keepConnectionModalOpen=false] - Keep connection modal open when disconnected (cannot be closed)
     * @param {boolean} [options.loadingSpinnerOpensModal=true] - Whether clicking the loading area opens the connection modal
     * @param {number} [options.minWidth=0] - Minimum canvas width in pixels (0 = no minimum, scrollbar appears if container is smaller)
     * @param {number} [options.minHeight=0] - Minimum canvas height in pixels (0 = no minimum, scrollbar appears if container is smaller)
     * @param {import('./rdp-themes.js').RDPTheme} [options.theme] - Theme configuration
     * @param {import('./rdp-security.js').SecurityPolicy} [options.securityPolicy] - Security policy for connection restrictions
     * @param {Object} [options.visibleTopBarButtons] - Control visibility of top bar buttons
     * @param {boolean} [options.visibleTopBarButtons.connect=true] - Show Connect button
     * @param {boolean} [options.visibleTopBarButtons.disconnect=true] - Show Disconnect button
     * @param {boolean} [options.visibleTopBarButtons.keyboard=true] - Show Keyboard button
     * @param {boolean} [options.visibleTopBarButtons.mute=true] - Show Mute button
     * @param {boolean} [options.visibleTopBarButtons.screenshot=true] - Show Screenshot button
     * @param {boolean} [options.visibleTopBarButtons.fullscreen=true] - Show Fullscreen button
     * @param {Array<{name: string, click: function}>} [options.additionalTopBarButtons=[]] - Custom buttons (max 10) added before built-in controls. Buttons collapse into overflow menu when space is limited.
     */
    constructor(container, options = {}) {
        // Extract security policy before spreading options (we don't store it in this.options)
        const { securityPolicy, additionalTopBarButtons, visibleTopBarButtons, ...restOptions } = options;
        
        this.options = {
            wsUrl: 'ws://localhost:8765',
            showTopBar: true,
            showBottomBar: true,
            reconnectDelay: 3000,
            mouseThrottleMs: 16,
            resizeDebounceMs: 2000,
            keepConnectionModalOpen: false,
            loadingSpinnerOpensModal: true,
            minWidth: 0,    // Minimum canvas width (0 = no minimum, scrollbar appears if container is smaller)
            minHeight: 0,   // Minimum canvas height (0 = no minimum, scrollbar appears if container is smaller)
            theme: null,
            visibleTopBarButtons: {
                connect: true,
                disconnect: true,
                keyboard: true,
                mute: true,
                screenshot: true,
                fullscreen: true,
                ...visibleTopBarButtons
            },
            ...restOptions
        };
        
        // Validate and freeze additional top bar buttons (max 10)
        // Deep copy to prevent external mutation, callbacks stored separately
        this._additionalButtonConfigs = this._validateAdditionalButtons(additionalTopBarButtons || []);
        
        // Initialize security policy as private frozen field
        // Deep frozen by default to prevent tampering
        this.#securityPolicy = new RDPSecurityPolicy(securityPolicy || {}, true);

        this._container = container;
        this._initShadowDOM();
        this._applyTheme(this.options.theme);
        this._applyMinDimensions();  // Apply min dimension CSS vars
        this._initState();
        this._bindElements();
        this._initResponsiveToolbar();  // Setup responsive overflow handling
        this._setupEventListeners();
        
        // Auto-show modal on init when keepConnectionModalOpen is enabled
        if (this.options.keepConnectionModalOpen) {
            this._showModal();
        }
        
        console.log('[RDPClient] Initialized');
    }

    // --------------------------------------------------
    // INITIALIZATION
    // --------------------------------------------------
    
    _initShadowDOM() {
        this._shadow = this._container.attachShadow({ mode: 'open' });
        
        // Main styles
        const style = document.createElement('style');
        style.textContent = STYLES;
        style.id = 'rdp-main-styles';
        
        // Theme overrides (separate style element for easy updates)
        this._themeStyle = document.createElement('style');
        this._themeStyle.id = 'rdp-theme-styles';
        
        const template = document.createElement('template');
        template.innerHTML = TEMPLATE;
        
        this._shadow.appendChild(style);
        this._shadow.appendChild(this._themeStyle);
        this._shadow.appendChild(template.content.cloneNode(true));
        
        // Apply visibility options
        if (!this.options.showTopBar) {
            this._shadow.querySelector('.rdp-topbar').classList.add('hidden');
        }
        if (!this.options.showBottomBar) {
            this._shadow.querySelector('.rdp-bottombar').classList.add('hidden');
        }
    }
    
    /**
     * Apply theme configuration
     * Can be called after initialization to change theme dynamically
     * @param {import('./rdp-themes.js').RDPTheme} themeConfig - Theme configuration
     */
    _applyTheme(themeConfig) {
        if (!themeConfig) return;
        
        // Sanitize and resolve theme
        const sanitized = sanitizeTheme(themeConfig);
        const resolved = resolveTheme(sanitized);
        const cssVars = themeToCssVars(resolved);
        
        // Generate font imports CSS
        const fontCss = fontsToCss(sanitized.fonts);
        
        // Apply as :host styles with optional font imports
        this._themeStyle.textContent = `${fontCss}\n:host { ${cssVars}; }`;
    }
    
    /**
     * Set theme dynamically after initialization
     * @param {import('./rdp-themes.js').RDPTheme} themeConfig - Theme configuration
     * @example
     * client.setTheme({ preset: 'light' });
     * client.setTheme({ colors: { accent: '#ff5722' } });
     */
    setTheme(themeConfig) {
        this.options.theme = themeConfig;
        this._applyTheme(themeConfig);
    }
    
    /**
     * Apply minimum dimension constraints
     * Sets CSS custom properties to control canvas min size and scrollbar visibility
     */
    _applyMinDimensions() {
        const { minWidth, minHeight } = this.options;
        const host = this._shadow.host;
        
        // Set canvas minimum dimensions (0 means no constraint)
        host.style.setProperty('--rdp-canvas-min-width', minWidth > 0 ? `${minWidth}px` : '0');
        host.style.setProperty('--rdp-canvas-min-height', minHeight > 0 ? `${minHeight}px` : '0');
        host.style.setProperty('--rdp-screen-min-width', minWidth > 0 ? `${minWidth + 4}px` : '0');  // +4 for border
        
        // Enable scrollbars only when min dimensions are set
        host.style.setProperty('--rdp-overflow-x', minWidth > 0 ? 'auto' : 'hidden');
        host.style.setProperty('--rdp-overflow-y', minHeight > 0 ? 'auto' : 'hidden');
    }
    
    /**
     * Set minimum dimensions dynamically
     * @param {number} minWidth - Minimum canvas width in pixels (0 = no minimum)
     * @param {number} minHeight - Minimum canvas height in pixels (0 = no minimum)
     */
    setMinDimensions(minWidth, minHeight) {
        this.options.minWidth = minWidth || 0;
        this.options.minHeight = minHeight || 0;
        this._applyMinDimensions();
    }

    _initState() {
        this._ws = null;
        this._isConnected = false;
        this._canvas = null;
        this._ctx = null;
        this._lastMouseSend = 0;
        this._pingStart = 0;
        this._lastLatency = null;
        this._resizeTimeout = null;
        this._lastRequestedWidth = 0;
        this._lastRequestedHeight = 0;
        
        // Audio state - AudioWorklet low-latency system
        this._audioContext = null;
        this._audioGainNode = null;
        this._audioWorklet = null;           // AudioWorkletNode
        this._audioWorkletReady = false;
        this._audioWorkletWarned = false;    // Only warn once if worklet not ready
        this._audioSharedBuffer = null;      // SharedArrayBuffer for ring buffer
        this._audioControlView = null;       // Uint32Array for write index
        this._audioDataView = null;          // Float32Array for audio samples
        this._audioWriteIndex = 0;
        this._audioBufferSize = 24000;       // ~500ms at 48kHz (samples per channel)
        this._audioChannels = 2;
        this._isMuted = false;
        
        // Opus decoder (WebCodecs)
        this._opusDecoder = null;
        this._opusInitialized = false;
        this._opusSampleRate = 48000;
        this._opusChannels = 2;
        
        // GFX Worker for progressive/tile rendering
        this._gfxWorker = null;
        this._gfxWorkerReady = false;
        this._useOffscreenCanvas = typeof OffscreenCanvas !== 'undefined';
        this._pendingGfxMessages = [];
        this._wasmAvailable = false;  // Set by GFX worker on load
        
        // Screenshot pending requests
        this._screenshotRequests = new Map();
        this._screenshotRequestId = 0;
        
        // API cursor state (for programmatic mouse control)
        this._apiCursorVisible = false;
        this._apiCursorPos = { x: 0, y: 0 };
        
        // Virtual keyboard state
        this._keyboardVisible = false;
        this._keyboardModifiers = { ctrl: false, alt: false, shift: false, meta: false, altgr: false };
        this._keyboardDragging = false;
        this._keyboardResizing = false;
        this._keyboardDragOffset = { x: 0, y: 0 };
        this._keyboardBaseWidth = 0;    // Natural width of keyboard content
        this._keyboardBaseHeight = 0;   // Natural height of keyboard content (rows only)
        this._keyboardTitlebarHeight = 0; // Height of titlebar (not scaled)
        this._keyboardActiveKey = null;  // Currently pressed key element
        
        // Event callbacks
        this._eventHandlers = {};
        
        // Disconnect state
        this._pendingDisconnect = null;
        this._disconnectTimeout = null;
    }

    _bindElements() {
        const $ = sel => this._shadow.querySelector(sel);
        
        this._el = {
            container: $('.rdp-container'),
            screen: $('.rdp-screen'),
            canvas: $('.rdp-canvas'),
            loading: $('.rdp-loading'),
            statusDot: $('.rdp-status-dot'),
            statusText: $('.rdp-status-text'),
            btnConnect: $('.rdp-btn-connect'),
            btnDisconnect: $('.rdp-btn-disconnect'),
            btnMute: $('.rdp-btn-mute'),
            btnScreenshot: $('.rdp-btn-screenshot'),
            btnFullscreen: $('.rdp-btn-fullscreen'),
            modal: $('.rdp-modal'),
            modalConnect: $('.rdp-modal-connect'),
            modalCancel: $('.rdp-modal-cancel'),
            inputHost: $('.rdp-input-host'),
            inputPort: $('.rdp-input-port'),
            inputUser: $('.rdp-input-user'),
            inputPass: $('.rdp-input-pass'),
            resolution: $('.rdp-resolution'),
            latency: $('.rdp-latency'),
            // Virtual keyboard elements
            btnKeyboard: $('.rdp-btn-keyboard'),
            keyboardOverlay: $('.rdp-keyboard-overlay'),
            keyboardContent: $('.rdp-keyboard-content'),
            keyboardTitlebar: $('.rdp-keyboard-titlebar'),
            keyboardClose: $('.rdp-keyboard-close'),
            keyboardResize: $('.rdp-keyboard-resize'),
            // Overflow menu elements
            controls: $('.rdp-controls'),
            btnOverflow: $('.rdp-btn-overflow'),
            overflowDropdown: $('.rdp-overflow-dropdown'),
            // API cursor overlay
            apiCursor: $('.rdp-api-cursor'),
        };
        
        // Apply button visibility based on visibleTopBarButtons option
        const btns = this.options.visibleTopBarButtons;
        if (!btns.connect) this._el.btnConnect.style.display = 'none';
        if (!btns.disconnect) this._el.btnDisconnect.style.display = 'none';
        if (!btns.keyboard) this._el.btnKeyboard.style.display = 'none';
        if (!btns.mute) this._el.btnMute.style.display = 'none';
        if (!btns.screenshot) this._el.btnScreenshot.style.display = 'none';
        if (!btns.fullscreen) this._el.btnFullscreen.style.display = 'none';
        
        // Create additional custom buttons at the start of controls
        this._createAdditionalButtons();
        
        this._canvas = this._el.canvas;
        
        // Initialize GFX worker - OffscreenCanvas is required
        this._initGfxWorker();
    }
    
    /**
     * Validate and sanitize additional button configurations
     * @param {Array} buttons - Raw button config array
     * @returns {Array} Validated and frozen button configs with callbacks stored separately
     * @private
     */
    _validateAdditionalButtons(buttons) {
        if (!Array.isArray(buttons)) {
            console.warn('[RDPClient] additionalTopBarButtons must be an array, ignoring');
            return [];
        }
        
        const MAX_BUTTONS = 10;
        const validated = [];
        
        for (let i = 0; i < Math.min(buttons.length, MAX_BUTTONS); i++) {
            const btn = buttons[i];
            
            // Validate required properties
            if (!btn || typeof btn !== 'object') {
                console.warn(`[RDPClient] additionalTopBarButtons[${i}] is not an object, skipping`);
                continue;
            }
            
            if (typeof btn.name !== 'string' || btn.name.trim() === '') {
                console.warn(`[RDPClient] additionalTopBarButtons[${i}].name must be a non-empty string, skipping`);
                continue;
            }
            
            if (typeof btn.click !== 'function') {
                console.warn(`[RDPClient] additionalTopBarButtons[${i}].click must be a function, skipping`);
                continue;
            }
            
            // Truncate name to 30 characters max
            const MAX_NAME_LENGTH = 30;
            let displayName = btn.name.trim();
            const fullName = displayName;  // Store original for title attribute
            
            if (displayName.length > MAX_NAME_LENGTH) {
                displayName = displayName.substring(0, MAX_NAME_LENGTH) + '...';
                console.warn(`[RDPClient] additionalTopBarButtons[${i}].name exceeded ${MAX_NAME_LENGTH} characters, truncated to "${displayName}"`);
            }
            
            // Store config with callback reference (callbacks can't be frozen/cloned)
            validated.push({
                name: displayName,
                fullName: fullName,  // Original name for title tooltip
                callback: btn.click  // Store original function reference
            });
        }
        
        if (buttons.length > MAX_BUTTONS) {
            console.warn(`[RDPClient] additionalTopBarButtons limited to ${MAX_BUTTONS} buttons, ignoring extras`);
        }
        
        return validated;
    }
    
    /**
     * Create additional custom buttons in the top bar controls
     * Buttons are inserted at the beginning of .rdp-controls
     * Click handlers are isolated to prevent access to RDPClient internals
     * Buttons get collapse priority based on their index (lower = collapses first)
     * @private
     */
    _createAdditionalButtons() {
        if (!this._additionalButtonConfigs || this._additionalButtonConfigs.length === 0) {
            return;
        }
        
        const controlsContainer = this._shadow.querySelector('.rdp-controls');
        if (!controlsContainer) {
            console.warn('[RDPClient] Could not find .rdp-controls container');
            return;
        }
        
        // Create buttons in reverse order so they appear in original order when prepended
        const fragment = document.createDocumentFragment();
        
        // Priority starts at 10 for additional buttons (lower than built-in connect/disconnect)
        // First additional button collapses first (priority 10), then 11, etc.
        let priorityCounter = 10;
        
        for (const config of this._additionalButtonConfigs) {
            const btn = document.createElement('button');
            btn.className = 'rdp-btn rdp-btn-no-wrap';
            btn.textContent = config.name;
            btn.title = config.fullName;  // Use full name for tooltip
            btn.dataset.collapsePriority = String(priorityCounter++);
            
            // Isolate callback - call with null context and catch errors
            // This prevents the user's callback from accessing 'this' (RDPClient)
            const userCallback = config.callback;
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                try {
                    // Call with null context, pass only button name for identification (use fullName)
                    userCallback.call(null, { buttonName: config.fullName });
                } catch (err) {
                    console.error('[RDPClient] Additional button callback error:', err);
                }
            });
            
            fragment.appendChild(btn);
        }
        
        // Insert all buttons at the start of controls
        controlsContainer.prepend(fragment);
    }
    
    /**
     * Initialize responsive toolbar with overflow handling
     * Sets up ResizeObserver to detect when buttons need to collapse into dropdown
     * @private
     */
    _initResponsiveToolbar() {
        // Track collapsed state
        this._collapsedButtons = new Set();
        this._overflowMenuOpen = false;
        
        // Get all collapsible buttons (those with data-collapse-priority that's not "never")
        this._updateCollapsibleButtons();
        
        // Set up overflow button click handler
        this._el.btnOverflow.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleOverflowMenu();
        });
        
        // Close overflow menu when clicking outside
        this._shadow.addEventListener('click', (e) => {
            if (this._overflowMenuOpen && !e.target.closest('.rdp-overflow-container')) {
                this._closeOverflowMenu();
            }
        });
        
        // Set up ResizeObserver on the topbar
        const topbar = this._shadow.querySelector('.rdp-topbar');
        if (topbar && typeof ResizeObserver !== 'undefined') {
            this._toolbarResizeObserver = new ResizeObserver(() => {
                this._updateToolbarOverflow();
            });
            this._toolbarResizeObserver.observe(topbar);
            
            // Initial check
            requestAnimationFrame(() => this._updateToolbarOverflow());
        }
    }
    
    /**
     * Update the list of collapsible buttons based on data-collapse-priority
     * Should be called after adding/removing buttons
     * @private
     */
    _updateCollapsibleButtons() {
        const controls = this._el.controls;
        if (!controls) return;
        
        // Get all buttons with collapse priority (not "never")
        this._collapsibleButtons = Array.from(
            controls.querySelectorAll('.rdp-btn[data-collapse-priority]')
        ).filter(btn => btn.dataset.collapsePriority !== 'never')
         .sort((a, b) => {
             // Higher priority number = collapses first
             const priorityA = parseInt(a.dataset.collapsePriority, 10) || 0;
             const priorityB = parseInt(b.dataset.collapsePriority, 10) || 0;
             return priorityB - priorityA;  // Descending order (highest first to collapse)
         });
    }
    
    /**
     * Calculate if toolbar is overflowing and collapse/expand buttons accordingly
     * @private
     */
    _updateToolbarOverflow() {
        const controls = this._el.controls;
        const topbar = this._shadow.querySelector('.rdp-topbar');
        if (!controls || !topbar) return;
        
        const status = this._shadow.querySelector('.rdp-status');
        const statusWidth = status ? status.offsetWidth : 0;
        const topbarPadding = 32; // 16px padding on each side
        const gap = 16; // gap between status and controls
        const availableWidth = topbar.offsetWidth - statusWidth - topbarPadding - gap;
        
        // Temporarily show all buttons to measure
        const wasCollapsed = new Set(this._collapsedButtons);
        for (const btn of wasCollapsed) {
            btn.classList.remove('rdp-collapsed');
        }
        this._el.btnOverflow.classList.remove('visible');
        
        // Measure controls width
        let controlsWidth = controls.scrollWidth;
        
        // If controls fit, we're done
        if (controlsWidth <= availableWidth) {
            this._collapsedButtons.clear();
            this._syncOverflowDropdown();
            return;
        }
        
        // Need to collapse buttons - start with highest priority (first to collapse)
        this._collapsedButtons.clear();
        const overflowBtnWidth = 40; // Approximate width of overflow button
        
        for (const btn of this._collapsibleButtons) {
            // Check if button is visible (not hidden by visibleTopBarButtons)
            if (btn.style.display === 'none') continue;
            
            // Check if we still need to collapse more
            const currentWidth = this._measureVisibleControlsWidth();
            if (currentWidth + (this._collapsedButtons.size > 0 ? overflowBtnWidth : 0) <= availableWidth) {
                break;
            }
            
            // Collapse this button
            btn.classList.add('rdp-collapsed');
            this._collapsedButtons.add(btn);
        }
        
        // Show overflow button if we have collapsed buttons
        this._syncOverflowDropdown();
    }
    
    /**
     * Measure the width of visible (non-collapsed) controls
     * @returns {number} Width in pixels
     * @private
     */
    _measureVisibleControlsWidth() {
        const controls = this._el.controls;
        let width = 0;
        const gap = 8; // CSS gap between buttons
        let visibleCount = 0;
        
        for (const child of controls.children) {
            if (child.classList.contains('rdp-overflow-container')) continue;
            if (child.classList.contains('rdp-collapsed')) continue;
            if (child.style.display === 'none') continue;
            
            width += child.offsetWidth;
            visibleCount++;
        }
        
        // Add gaps between buttons
        if (visibleCount > 1) {
            width += (visibleCount - 1) * gap;
        }
        
        return width;
    }
    
    /**
     * Sync the overflow dropdown with collapsed buttons
     * @private
     */
    _syncOverflowDropdown() {
        const dropdown = this._el.overflowDropdown;
        if (!dropdown) return;
        
        // Clear dropdown
        dropdown.innerHTML = '';
        
        if (this._collapsedButtons.size === 0) {
            this._el.btnOverflow.classList.remove('visible');
            this._closeOverflowMenu();
            return;
        }
        
        // Show overflow button
        this._el.btnOverflow.classList.add('visible');
        
        // Add collapsed buttons to dropdown (in reverse order so first collapsed appears last)
        const sortedButtons = Array.from(this._collapsedButtons).reverse();
        
        for (const originalBtn of sortedButtons) {
            const dropdownBtn = document.createElement('button');
            dropdownBtn.className = 'rdp-btn';
            dropdownBtn.textContent = originalBtn.textContent;
            dropdownBtn.title = originalBtn.title || originalBtn.textContent;
            dropdownBtn.disabled = originalBtn.disabled;
            
            // Clone click behavior
            dropdownBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._closeOverflowMenu();
                originalBtn.click();
            });
            
            dropdown.appendChild(dropdownBtn);
        }
    }
    
    /**
     * Toggle the overflow dropdown menu
     * @private
     */
    _toggleOverflowMenu() {
        if (this._overflowMenuOpen) {
            this._closeOverflowMenu();
        } else {
            this._openOverflowMenu();
        }
    }
    
    /**
     * Open the overflow dropdown menu
     * @private
     */
    _openOverflowMenu() {
        this._el.overflowDropdown.classList.add('open');
        this._overflowMenuOpen = true;
    }
    
    /**
     * Close the overflow dropdown menu
     * @private
     */
    _closeOverflowMenu() {
        this._el.overflowDropdown.classList.remove('open');
        this._overflowMenuOpen = false;
    }
    
    /**
     * Initialize the GFX compositor worker
     * OffscreenCanvas is REQUIRED - will fail if not supported
     */
    _initGfxWorker() {
        if (!this._useOffscreenCanvas) {
            const msg = 'OffscreenCanvas is required but not supported by this browser';
            console.error('[RDPClient]', msg);
            this._handleError(msg);
            return;
        }
        
        try {
            this._gfxWorker = new Worker(RDP_CLIENT_BASE_URL + 'gfx-worker.js', { type: 'module' });
            
            this._gfxWorker.onmessage = (event) => {
                this._handleGfxWorkerMessage(event.data);
            };
            
            this._gfxWorker.onerror = (err) => {
                console.error('[RDPClient] GFX Worker error:', err);
                this._gfxWorker = null;
                this._gfxWorkerReady = false;
                this._handleError('GFX Worker failed to initialize');
            };
            
            console.log('[RDPClient] GFX Worker created');
        } catch (err) {
            console.error('[RDPClient] Failed to create GFX Worker:', err);
            this._gfxWorker = null;
            this._handleError('Failed to create GFX Worker: ' + err.message);
        }
    }
    
    /**
     * Handle messages from GFX worker
     */
    _handleGfxWorkerMessage(msg) {
        switch (msg.type) {
            case 'loaded':
                // Worker loaded with WASM pre-initialized
                this._wasmAvailable = !!msg.wasmReady;
                console.log('[RDPClient] GFX Worker loaded, WASM:', this._wasmAvailable);
                if (!this._wasmAvailable) {
                    console.warn('[RDPClient] Progressive WASM not available - will use fallback decoders');
                }
                break;
                
            case 'ready':
                this._gfxWorkerReady = true;
                console.log('[RDPClient] GFX Worker ready, WASM:', msg.wasmReady);
                // Flush pending messages
                for (const pending of this._pendingGfxMessages) {
                    this._gfxWorker.postMessage(pending.msg, pending.transfer);
                }
                this._pendingGfxMessages = [];
                break;
                
            case 'frameAck':
                // Send frame acknowledgment back to server
                if (this._ws && this._ws.readyState === WebSocket.OPEN && msg.data) {
                    this._ws.send(msg.data);
                }
                break;
                
            case 'unhandled':
                // Unhandled message from worker - process on main thread
                if (msg.data) {
                    this._handleFrameUpdate(msg.data);
                }
                break;
                
            case 'screenshotResult':
                // Resolve pending screenshot request
                const pending = this._screenshotRequests.get(msg.requestId);
                if (pending) {
                    this._screenshotRequests.delete(msg.requestId);
                    if (msg.error) {
                        pending.reject(new Error(msg.error));
                    } else {
                        pending.resolve({
                            blob: msg.blob,
                            width: msg.width,
                            height: msg.height
                        });
                    }
                }
                break;

            case 'fatal':
                this._handleError(msg.message || 'RDP graphics worker failed');
                this.disconnect();
                break;
        }
    }
    
    /**
     * Set a custom cursor from server-provided BGRA bitmap data
     * Uses CSS cursor with data URL for cursors up to 128x128 (browser limit)
     * @param {number} width - Cursor width in pixels
     * @param {number} height - Cursor height in pixels
     * @param {number} hotspotX - Hotspot X offset
     * @param {number} hotspotY - Hotspot Y offset
     * @param {Uint8Array} bgraData - BGRA pixel data (4 bytes per pixel)
     */
    _setCustomCursor(width, height, hotspotX, hotspotY, bgraData) {
        try {
            // Create temporary canvas to convert BGRA to image
            const cursorCanvas = document.createElement('canvas');
            cursorCanvas.width = width;
            cursorCanvas.height = height;
            const ctx = cursorCanvas.getContext('2d');
            
            // Create ImageData and convert BGRA to RGBA
            const imageData = ctx.createImageData(width, height);
            const rgba = imageData.data;
            
            for (let i = 0; i < bgraData.length; i += 4) {
                // BGRA -> RGBA: swap B and R channels
                rgba[i]     = bgraData[i + 2];  // R <- B
                rgba[i + 1] = bgraData[i + 1];  // G <- G
                rgba[i + 2] = bgraData[i];      // B <- R
                rgba[i + 3] = bgraData[i + 3];  // A <- A
            }
            
            ctx.putImageData(imageData, 0, 0);
            
            // Convert to data URL for CSS cursor
            const dataUrl = cursorCanvas.toDataURL('image/png');
            
            // Clamp hotspot to valid range
            const hx = Math.max(0, Math.min(hotspotX, width - 1));
            const hy = Math.max(0, Math.min(hotspotY, height - 1));
            
            // CSS cursor format: url(data:...), hotspot-x, hotspot-y, fallback
            // Note: Some browsers limit cursor size to 128x128
            this._canvas.style.cursor = `url(${dataUrl}) ${hx} ${hy}, auto`;
        } catch (err) {
            console.warn('[RDPClient] Failed to set custom cursor:', err);
            this._canvas.style.cursor = 'default';
        }
    }
    
    /**
     * Initialize GFX worker canvas when connected
     */
    _initGfxWorkerCanvas(width, height) {
        if (!this._gfxWorker || !this._useOffscreenCanvas) {
            this._handleError('GFX Worker not available');
            this.disconnect();
            return;
        }
        
        try {
            // Transfer canvas control to worker
            const offscreen = this._canvas.transferControlToOffscreen();
            
            this._gfxWorker.postMessage({
                type: 'init',
                data: { canvas: offscreen, width, height }
            }, [offscreen]);
            
            console.log('[RDPClient] Canvas transferred to GFX Worker');
        } catch (err) {
            console.error('[RDPClient] Failed to transfer canvas:', err);
            this._handleError('Failed to transfer canvas to worker: ' + err.message);
            this.disconnect();
        }
    }
    
    /**
     * Send message to GFX worker
     */
    _sendToGfxWorker(data) {
        if (!this._gfxWorker) return false;
        
        const msg = { type: 'binary', data };
        const transfer = data instanceof ArrayBuffer ? [data] : [];
        
        if (this._gfxWorkerReady) {
            this._gfxWorker.postMessage(msg, transfer);
        } else {
            this._pendingGfxMessages.push({ msg, transfer });
        }
        
        return true;
    }

    _setupEventListeners() {
        // UI buttons
        this._el.btnConnect.addEventListener('click', () => this._showModal());
        this._el.btnDisconnect.addEventListener('click', () => this.disconnect());
        this._el.btnMute.addEventListener('click', () => this._toggleMute());
        this._el.btnKeyboard.addEventListener('click', () => this._toggleKeyboard());
        this._el.btnScreenshot.addEventListener('click', () => this._handleScreenshotClick());
        this._el.btnFullscreen.addEventListener('click', () => this._toggleFullscreen());
        
        // Loading area - click to open modal if not connected/connecting
        if (this.options.loadingSpinnerOpensModal) {
            this._el.loading.addEventListener('click', () => {
                if (!this._isConnected && !this._pendingConnect) {
                    this._showModal();
                }
            });
            this._el.loading.style.cursor = 'pointer';
        }
        
        // Modal
        this._el.modalConnect.addEventListener('click', () => this._handleModalConnect());
        this._el.modalCancel.addEventListener('click', () => this._hideModal());
        this._el.modal.addEventListener('click', (e) => {
            if (e.target === this._el.modal) this._hideModal();
        });

        // Canvas interactions
        this._canvas.setAttribute('tabindex', '0');
        this._canvas.addEventListener('click', () => this._canvas.focus());
        this._canvas.addEventListener('mousemove', (e) => this._handleMouseMove(e));
        this._canvas.addEventListener('mousedown', (e) => this._handleMouseDown(e));
        this._canvas.addEventListener('mouseup', (e) => this._handleMouseUp(e));
        this._canvas.addEventListener('wheel', (e) => this._handleMouseWheel(e));
        this._canvas.addEventListener('contextmenu', (e) => e.preventDefault());

        // Keyboard - scoped to shadow root
        this._shadow.addEventListener('keydown', (e) => this._handleKeyDown(e));
        this._shadow.addEventListener('keyup', (e) => this._handleKeyUp(e));
        
        // Virtual keyboard events
        this._setupVirtualKeyboard();

        // Resize observer
        if (typeof ResizeObserver !== 'undefined') {
            this._resizeObserver = new ResizeObserver(() => this._handleResize());
            this._resizeObserver.observe(this._el.screen);
        }
    }

    // --------------------------------------------------
    // PUBLIC API
    // --------------------------------------------------

    /**
     * Connect to an RDP server
     * @param {Object} credentials
     * @param {string} credentials.host - RDP server hostname/IP
     * @param {number} [credentials.port=3389] - RDP port
     * @param {string} credentials.user - Username
     * @param {string} credentials.pass - Password
     * @returns {Promise<void>}
     */
    connect(credentials) {
        return new Promise((resolve, reject) => {
            if (this._ws && this._ws.readyState === WebSocket.OPEN) {
                reject(new Error('Already connected'));
                return;
            }

            // host, user and pass are required
            if (!credentials.host || !credentials.user || !credentials.pass) {
                reject(new Error('Missing required connection fields: host, user, pass'));
                return;
            }
            
            // Validate connection against security policy
            const port = credentials.port || 3389;
            const policyResult = this.#securityPolicy.validate(credentials.host, port);
            if (!policyResult.allowed) {
                reject(new Error(policyResult.reason || 'Connection blocked by security policy'));
                return;
            }

            // Reinitialize if this client object is reused after a previous disconnect.
            if (!this._gfxWorker) this._initGfxWorker();

            // Hide modal if it's open (e.g., when connect() is called via API)
            if (this._el.modal.classList.contains('active')) {
                this._el.modal.classList.remove('active');
            }

            this._pendingConnect = { resolve, reject };
            this._updateStatus('connecting', 'Connecting...');
            this._el.loading.querySelector('p').textContent = 'Connecting...';

            this._ws = new WebSocket(this.options.wsUrl);
            this._ws.binaryType = 'arraybuffer';

            // Show the canvas before measuring. Android WebView reports 0×0 for display:none,
            // which previously forced the session to the 640×480 minimum and made the
            // desktop appear as a broken black/white letterboxed strip.
            this._el.canvas.style.display = 'block';

            this._ws.onopen = () => {
                const { width, height } = this._getAvailableDimensions();
                this._lastRequestedWidth = width;
                this._lastRequestedHeight = height;
                this._canvas.width = width;
                this._canvas.height = height;

                this._sendMessage({
                    type: 'connect',
                    host: credentials.host,
                    port: credentials.port || 3389,
                    username: credentials.user,
                    password: credentials.pass,
                    width,
                    height
                });
                
                console.log('[RDPClient] Connect request to', credentials.host + ':' + (credentials.port || 3389));
            };

            this._ws.onmessage = (e) => this._handleMessage(e);
            this._ws.onerror = (e) => {
                this._updateStatus('error', 'Connection error');
                if (this._pendingConnect) {
                    this._pendingConnect.reject(new Error('WebSocket error'));
                    this._pendingConnect = null;
                }
            };
            this._ws.onclose = () => this._handleDisconnect();
        });
    }

    /**
     * Disconnect from the RDP server
     * @returns {Promise<void>} Resolves when disconnection is complete
     */
    disconnect() {
        return new Promise((resolve) => {
            // If already disconnected or no WebSocket, resolve immediately
            if (!this._ws || this._ws.readyState === WebSocket.CLOSED) {
                if (this._isConnected) {
                    this._handleDisconnect();
                } else if (this._el?.canvas) {
                    this._el.canvas.style.display = 'none';
                }
                resolve();
                return;
            }
            
            // If disconnect already in progress, chain to existing promise
            if (this._pendingDisconnect) {
                this._pendingDisconnect.then(resolve);
                return;
            }
            
            // Store pending disconnect resolver
            let resolveDisconnect;
            this._pendingDisconnect = new Promise((r) => { resolveDisconnect = r; });
            this._pendingDisconnect.resolve = resolveDisconnect;
            this._pendingDisconnect.then(resolve);
            
            // Send disconnect message to server
            this._sendMessage({ type: 'disconnect' });
            
            // Close WebSocket (will trigger onclose -> _handleDisconnect)
            this._ws.close();
            
            // Timeout fallback - force cleanup after 3 seconds
            this._disconnectTimeout = setTimeout(() => {
                if (this._pendingDisconnect) {
                    console.warn('[RDPClient] Disconnect timeout, forcing cleanup');
                    this._handleDisconnect();
                    this._pendingDisconnect.resolve();
                    this._pendingDisconnect = null;
                }
            }, 3000);
        });
    }

    /**
     * Send keystrokes to the remote desktop
     * @param {string|string[]} keys - Keys to send
     * @param {Object} [options] - Modifier options
     * @returns {Promise<void>}
     */
    sendKeys(keys, options = {}) {
        return new Promise((resolve, reject) => {
            if (!this._isConnected) {
                reject(new Error('Not connected'));
                return;
            }

            const keyArray = Array.isArray(keys) ? keys : keys.split('');
            const delay = options.delay ?? 50;
            let index = 0;

            const sendNext = () => {
                if (index >= keyArray.length) {
                    resolve();
                    return;
                }

                const key = keyArray[index];
                this._sendMessage({
                    type: 'key', action: 'down', key,
                    code: `Key${key.toUpperCase()}`,
                    ctrlKey: options.ctrl || false,
                    shiftKey: options.shift || false,
                    altKey: options.alt || false,
                    metaKey: options.meta || false
                });

                const releaseDelay = options.releaseDelay ?? 20;
                setTimeout(() => {
                    this._sendMessage({
                        type: 'key', action: 'up', key,
                        code: `Key${key.toUpperCase()}`,
                        ctrlKey: options.ctrl || false,
                        shiftKey: options.shift || false,
                        altKey: options.alt || false,
                        metaKey: options.meta || false
                    });
                    index++;
                    setTimeout(sendNext, delay);
                }, releaseDelay);
            };

            sendNext();
        });
    }

    /**
     * Send a key combination (e.g., "Ctrl+Alt+Delete")
     * @param {string} combo - Key combination
     */
    sendKeyCombo(combo) {
        if (!this._isConnected) throw new Error('Not connected');
        this._sendMessage({ type: 'keycombo', combo });
    }

    /**
     * Send Ctrl+Alt+Delete
     */
    sendCtrlAltDel() {
        this.sendKeyCombo('Ctrl+Alt+Delete');
    }

    /**
     * Send Backspace key press
     * @param {number} [count=1] - Number of backspace keys to send
     * @returns {Promise<void>} Resolves when all backspaces are sent
     */
    async sendBackspace(count = 1) {
        for (let i = 0; i < count; i++) {
            if (i > 0) {
                await this._delay(20);
            }
            this.sendKeyCombo('Backspace');
        }
    }

    // --------------------------------------------------
    // PUBLIC API: PROGRAMMATIC MOUSE CONTROL
    // --------------------------------------------------

    /**
     * Move the mouse cursor to a specific position
     * Shows a visual cursor overlay until real mouse movement is detected
     * @param {number} x - X coordinate in remote desktop pixels
     * @param {number} y - Y coordinate in remote desktop pixels
     * @returns {void}
     * @throws {Error} If not connected
     * @example
     * client.sendMouseMove(100, 200);
     */
    sendMouseMove(x, y) {
        if (!this._isConnected) throw new Error('Not connected');
        
        x = Math.round(x);
        y = Math.round(y);
        
        this._sendMessage({ type: 'mouse', action: 'move', x, y });
        this._showApiCursor(x, y);
    }

    /**
     * Perform a mouse click at the current cursor position or specified coordinates
     * Shows a visual cursor overlay until real mouse movement is detected
     * @param {Object} [options={}] - Click options
     * @param {number} [options.x] - X coordinate (if omitted, clicks at last API cursor position)
     * @param {number} [options.y] - Y coordinate (if omitted, clicks at last API cursor position)
     * @param {'left'|'right'|'middle'} [options.button='left'] - Mouse button to click
     * @param {number} [options.count=1] - Number of clicks (e.g., 2 for double-click)
     * @param {number} [options.delay=50] - Delay between clicks in ms (for multiple clicks)
     * @returns {Promise<void>} Resolves when all clicks are complete
     * @throws {Error} If not connected
     * @example
     * // Left click at current position
     * await client.sendMouseClick();
     * 
     * // Right click at specific position
     * await client.sendMouseClick({ x: 500, y: 300, button: 'right' });
     * 
     * // Double click
     * await client.sendMouseClick({ x: 100, y: 100, count: 2 });
     */
    async sendMouseClick(options = {}) {
        if (!this._isConnected) throw new Error('Not connected');
        
        const {
            x = this._apiCursorPos.x,
            y = this._apiCursorPos.y,
            button = 'left',
            count = 1,
            delay = 50
        } = options;
        
        const buttonCode = button === 'right' ? 2 : button === 'middle' ? 1 : 0;
        const posX = Math.round(x);
        const posY = Math.round(y);
        
        // Move to position first if coordinates provided
        if (options.x !== undefined || options.y !== undefined) {
            this._sendMessage({ type: 'mouse', action: 'move', x: posX, y: posY });
        }
        
        this._showApiCursor(posX, posY);
        
        for (let i = 0; i < count; i++) {
            if (i > 0) {
                await this._delay(delay);
            }
            this._sendMessage({ type: 'mouse', action: 'down', button: buttonCode, x: posX, y: posY });
            await this._delay(20);
            this._sendMessage({ type: 'mouse', action: 'up', button: buttonCode, x: posX, y: posY });
        }
    }

    /**
     * Perform a mouse scroll at the current cursor position or specified coordinates
     * Shows a visual cursor overlay until real mouse movement is detected
     * @param {Object} [options={}] - Scroll options
     * @param {number} [options.x] - X coordinate (if omitted, scrolls at last API cursor position)
     * @param {number} [options.y] - Y coordinate (if omitted, scrolls at last API cursor position)
     * @param {number} [options.deltaX=0] - Horizontal scroll amount (positive = right, negative = left)
     * @param {number} [options.deltaY=0] - Vertical scroll amount (positive = down, negative = up)
     * @returns {void}
     * @throws {Error} If not connected
     * @example
     * // Scroll down at current position
     * client.sendMouseScroll({ deltaY: 100 });
     * 
     * // Scroll up at specific position
     * client.sendMouseScroll({ x: 500, y: 300, deltaY: -100 });
     * 
     * // Horizontal scroll
     * client.sendMouseScroll({ deltaX: 50 });
     */
    sendMouseScroll(options = {}) {
        if (!this._isConnected) throw new Error('Not connected');
        
        const {
            x = this._apiCursorPos.x,
            y = this._apiCursorPos.y,
            deltaX = 0,
            deltaY = 0
        } = options;
        
        const posX = Math.round(x);
        const posY = Math.round(y);
        
        // Move to position first if coordinates provided
        if (options.x !== undefined || options.y !== undefined) {
            this._sendMessage({ type: 'mouse', action: 'move', x: posX, y: posY });
        }
        
        this._showApiCursor(posX, posY);
        
        this._sendMessage({
            type: 'mouse',
            action: 'wheel',
            deltaX,
            deltaY,
            x: posX,
            y: posY
        });
    }

    /**
     * Get current connection status
     * @returns {Object} Status object
     */
    getStatus() {
        return {
            connected: this._isConnected,
            resolution: this._isConnected ? 
                { width: this._canvas.width, height: this._canvas.height } : null,
            muted: this._isMuted
        };
    }

    /**
     * Set mute state
     * @param {boolean} muted
     */
    setMuted(muted) {
        this._isMuted = muted;
        if (this._audioGainNode) {
            this._audioGainNode.gain.value = muted ? 0 : 1;
        }
        // Notify AudioWorklet
        if (this._audioWorklet) {
            this._audioWorklet.port.postMessage({ type: 'mute', data: { muted } });
        }
        this._el.btnMute.textContent = muted ? '🔇' : '🔊';
        this._emit('mute', { muted });
    }

    /**
     * Get current mute state
     * @returns {boolean} True if muted
     */
    getMuted() {
        return this._isMuted;
    }

    /**
     * Get current resolution
     * @returns {Object|null} Resolution object { width, height } or null if not connected
     */
    getResolution() {
        if (!this._isConnected) return null;
        return { width: this._canvas.width, height: this._canvas.height };
    }

    /**
     * Check if connected to RDP server
     * @returns {boolean} True if connected
     */
    isConnected() {
        return this._isConnected;
    }

    /**
     * Get current latency in milliseconds
     * @returns {number|null} Latency in ms, or null if not yet measured
     */
    getLatency() {
        if (!this._isConnected || this._pingStart === 0) return null;
        return this._lastLatency || null;
    }

    /**
     * Get the security policy configuration (read-only)
     * The returned object is frozen and cannot be modified
     * @returns {import('./rdp-security.js').SecurityPolicy} Security policy
     */
    getSecurityPolicy() {
        return this.#securityPolicy.getPolicy();
    }

    /**
     * Check if a destination would be allowed by the security policy
     * @param {string} host - Hostname or IP address
     * @param {number} [port=3389] - Port number
     * @returns {{allowed: boolean, reason?: string}} Validation result
     */
    validateDestination(host, port = 3389) {
        return this.#securityPolicy.validate(host, port);
    }

    /**
     * Capture a screenshot of the current remote desktop
     * @param {string} [type='png'] - Image type: 'png' or 'jpg'
     * @param {number} [quality=0.9] - JPEG quality (0-1), ignored for PNG
     * @returns {Promise<{blob: Blob, width: number, height: number}>} Screenshot data
     * @throws {Error} If not connected or screenshot fails
     * @example
     * const { blob, width, height } = await client.getScreenshot();
     * const url = URL.createObjectURL(blob);
     */
    getScreenshot(type = 'png', quality = 0.9) {
        return new Promise((resolve, reject) => {
            if (!this._isConnected) {
                reject(new Error('Not connected'));
                return;
            }
            
            if (!this._gfxWorker || !this._gfxWorkerReady) {
                reject(new Error('GFX Worker not ready'));
                return;
            }
            
            const requestId = ++this._screenshotRequestId;
            const mimeType = type === 'jpg' || type === 'jpeg' ? 'image/jpeg' : 'image/png';
            if (typeof quality !== 'number' || quality < 0 || quality > 1) {
                quality = 0.9;
            }
            
            this._screenshotRequests.set(requestId, { resolve, reject });
            
            this._gfxWorker.postMessage({
                type: 'screenshot',
                data: { requestId, mimeType, quality }
            });
            
            // Timeout after 5 seconds
            setTimeout(() => {
                if (this._screenshotRequests.has(requestId)) {
                    this._screenshotRequests.delete(requestId);
                    reject(new Error('Screenshot timeout'));
                }
            }, 5000);
        });
    }

    /**
     * Capture and download a screenshot of the remote desktop
     * @param {string} [type='png'] - Image type: 'png' or 'jpg'
     * @param {number} [quality=0.9] - JPEG quality (0-1), ignored for PNG
     * @returns {Promise<void>} Resolves when download starts
     * @example
     * // Downloads as 'screenshot-2026-01-12--14-30.png'
     * await client.downloadScreenshot();
     * 
     * // Download as JPEG
     * await client.downloadScreenshot('jpg');
     */
    async downloadScreenshot(type = 'png', quality = 0.9) {
        const { blob } = await this.getScreenshot(type, quality);
        
        // Generate filename with timestamp: screenshot-YYYY-mm-dd--hh-mm.ext
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}--${pad(now.getHours())}-${pad(now.getMinutes())}`;
        const ext = (type === 'jpg' || type === 'jpeg') ? 'jpg' : 'png';
        const filename = `screenshot-${timestamp}.${ext}`;
        
        // Create download link and trigger
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    /**
     * Register an event handler
     * @param {string} event - Event name ('connected', 'disconnected', 'error')
     * @param {Function} handler - Callback function
     */
    on(event, handler) {
        if (!this._eventHandlers[event]) {
            this._eventHandlers[event] = [];
        }
        this._eventHandlers[event].push(handler);
    }

    /**
     * Remove an event handler
     * @param {string} event
     * @param {Function} handler
     */
    off(event, handler) {
        if (this._eventHandlers[event]) {
            this._eventHandlers[event] = this._eventHandlers[event]
                .filter(h => h !== handler);
        }
    }

    /**
     * Destroy the client and clean up resources
     * @returns {Promise<void>} Resolves when destruction is complete
     */
    async destroy() {
        await this.disconnect();
        if (this._gfxWorker) {
            this._gfxWorker.terminate();
            this._gfxWorker = null;
        }
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
        }
        if (this._toolbarResizeObserver) {
            this._toolbarResizeObserver.disconnect();
        }
        this._shadow.innerHTML = '';
    }

    // --------------------------------------------------
    // PRIVATE: UI
    // --------------------------------------------------

    _emit(event, data) {
        if (this._eventHandlers[event]) {
            this._eventHandlers[event].forEach(h => h(data));
        }
    }

    _showModal() {
        this._el.modal.classList.add('active');
        // Hide cancel button when keepConnectionModalOpen is enabled
        this._el.modalCancel.style.display = this.options.keepConnectionModalOpen ? 'none' : '';
        this._el.inputHost.focus();
    }

    _hideModal() {
        // Don't allow hiding modal if keepConnectionModalOpen is enabled and not connected
        if (this.options.keepConnectionModalOpen && !this._isConnected) {
            return;
        }
        this._el.modal.classList.remove('active');
    }

    _handleModalConnect() {
        const host = this._el.inputHost.value.trim();
        const port = parseInt(this._el.inputPort.value) || 3389;
        const user = this._el.inputUser.value.trim();
        const pass = this._el.inputPass.value;

        if (!host || !user) {
            alert('Please enter host and username');
            return;
        }

        this._hideModal();
        this.connect({ host, port, user, pass });
    }

    _updateStatus(state, text) {
        this._el.statusDot.classList.toggle('connected', state === 'connected');
        this._el.statusText.textContent = text;
    }

    _toggleMute() {
        this.setMuted(!this._isMuted);
    }

    async _handleScreenshotClick() {
        try {
            await this.downloadScreenshot();
        } catch (err) {
            console.error('[RDPClient] Screenshot failed:', err);
        }
    }

    _toggleFullscreen() {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            this._container.requestFullscreen();
        }
    }

    // --------------------------------------------------
    // PRIVATE: WEBSOCKET
    // --------------------------------------------------

    _sendMessage(msg) {
        if (this._ws && this._ws.readyState === WebSocket.OPEN) {
            this._ws.send(JSON.stringify(msg));
        }
    }

    _handleMessage(event) {
        if (event.data instanceof ArrayBuffer) {
            const bytes = new Uint8Array(event.data);
            
            // Audio - always handle on main thread
            if (matchMagic(bytes, Magic.OPUS)) {
                this._handleOpusFrame(bytes);
                return;
            }
            if (matchMagic(bytes, Magic.AUDI)) {
                this._handleAudioFrame(bytes);
                return;
            }
            
            // Pointer/cursor updates - handle on main thread (no GFX worker needed)
            if (matchMagic(bytes, Magic.PPOS)) {
                const msg = parsePointerPosition(bytes);
                if (msg) {
                    // Server-side cursor positioning (shadow cursor mode)
                    // Most browsers don't allow setting cursor position
                }
                return;
            }
            if (matchMagic(bytes, Magic.PSYS)) {
                const msg = parsePointerSystem(bytes);
                if (msg) {
                    // System pointer: 0=NULL (hide), 1=DEFAULT (arrow)
                    this._canvas.style.cursor = msg.ptrType === 0 ? 'none' : 'default';
                }
                return;
            }
            if (matchMagic(bytes, Magic.PSET)) {
                const msg = parsePointerSet(bytes);
                if (msg) {
                    this._setCustomCursor(msg.width, msg.height, msg.hotspotX, msg.hotspotY, msg.bgraData);
                }
                return;
            }
            
            // When using GFX worker, route ALL non-audio frames to worker
            // (canvas is transferred, so main thread cannot draw)
            if (this._gfxWorkerReady && this._sendToGfxWorker(event.data)) {
                return;
            }
            
            // If worker exists but not ready yet, queue frames
            // (canvas is transferred, but worker hasn't confirmed ready)
            if (this._gfxWorker && this._useOffscreenCanvas && !this._gfxWorkerReady) {
                this._pendingGfxMessages.push({
                    msg: { type: 'binary', data: event.data },
                    transfer: [event.data]
                });
                return;
            }
            
            // Main thread fallback (when worker not available)
            this._handleFrameUpdate(event.data);
            return;
        }

        try {
            const msg = JSON.parse(event.data);
            switch (msg.type) {
                case 'connected':
                    if (this._pendingConnect) {
                        this._handleConnected(msg);
                    } else {
                        console.warn('[RDPClient] Ignoring duplicate connected message');
                    }
                    break;
                case 'resize':
                    this._handleServerResize(msg.width, msg.height);
                    break;
                case 'pong':
                    this._handlePong();
                    break;
                case 'error':
                    this._handleError(msg.message);
                    break;
                case 'disconnected':
                    this._handleDisconnect();
                    break;
                default:
                    this._emit('message', msg);
                    break;
            }
        } catch (e) {
            console.error('[RDPClient] Parse error:', e);
        }
    }

    /**
     * Check if message is a new GFX event stream format
     */
    _isGfxEventMessage(bytes) {
        if (bytes.length < 4) return false;
        
        return matchMagic(bytes, Magic.SURF) ||
               matchMagic(bytes, Magic.DELS) ||
               matchMagic(bytes, Magic.MAPS) ||
               matchMagic(bytes, Magic.STFR) ||
               matchMagic(bytes, Magic.ENFR) ||
               matchMagic(bytes, Magic.PROG) ||
               matchMagic(bytes, Magic.WEBP) ||
               matchMagic(bytes, Magic.TILE) ||
               matchMagic(bytes, Magic.CLRC) ||
               matchMagic(bytes, Magic.SFIL) ||
               matchMagic(bytes, Magic.S2SF) ||
               matchMagic(bytes, Magic.C2SF) ||
               matchMagic(bytes, Magic.S2CH) ||
               matchMagic(bytes, Magic.EVCT) ||
               matchMagic(bytes, Magic.RSGR) ||
               matchMagic(bytes, Magic.CAPS) ||
               matchMagic(bytes, Magic.INIT) ||
               matchMagic(bytes, Magic.H264);
    }

    _handleConnected(msg) {
        this._isConnected = true;
        this._updateStatus('connected', 'Connected');
        this._el.canvas.style.display = 'block';
        this._el.loading.style.display = 'none';
        this._el.btnConnect.disabled = true;
        this._el.btnDisconnect.disabled = false;
        this._el.btnKeyboard.disabled = false;
        this._el.btnMute.disabled = false;
        this._el.btnScreenshot.disabled = false;
        this._canvas.focus();
        
        this._initAudio();

        if (msg.width && msg.height) {
            this._handleServerResize(msg.width, msg.height);
        }
        
        // Initialize GFX worker with canvas
        // Note: We only transfer canvas control on connect, not earlier,
        // because the canvas dimensions need to match the session size
        this._initGfxWorkerCanvas(msg.width || this._canvas.width, 
                                  msg.height || this._canvas.height);

        setInterval(() => this._sendPing(), 5000);
        
        this._emit('connected', { width: msg.width, height: msg.height });
        
        if (this._pendingConnect) {
            this._pendingConnect.resolve();
            this._pendingConnect = null;
        }
    }

    _handleDisconnect() {
        this._isConnected = false;
        this._ws = null;
        this._lastRequestedWidth = 0;
        this._lastRequestedHeight = 0;
        this._updateStatus('disconnected', 'Disconnected');
        this._el.canvas.style.display = 'none';
        this._el.loading.style.display = 'block';
        this._el.loading.querySelector('p').textContent = 'Click Connect to start';
        this._el.btnConnect.disabled = false;
        this._el.btnDisconnect.disabled = true;
        this._el.btnKeyboard.disabled = true;
        this._el.btnMute.disabled = true;
        this._el.btnScreenshot.disabled = true;
        
        // Hide virtual keyboard on disconnect
        this.hideKeyboard();
        
        this._cleanupAudio();
        this._cleanupGfxWorker();
        
        this._emit('disconnected');
        
        // Auto-show modal when keepConnectionModalOpen is enabled
        if (this.options.keepConnectionModalOpen) {
            this._showModal();
        }
        
        // Clear disconnect timeout
        if (this._disconnectTimeout) {
            clearTimeout(this._disconnectTimeout);
            this._disconnectTimeout = null;
        }
        
        // Resolve pending disconnect promise
        if (this._pendingDisconnect) {
            this._pendingDisconnect.resolve();
            this._pendingDisconnect = null;
        }
    }
    
    /**
     * Clean up GFX worker
     */
    _cleanupGfxWorker() {
        if (this._gfxWorker) {
            this._gfxWorker.terminate();
            this._gfxWorker = null;
        }
        this._gfxWorkerReady = false;
        this._pendingGfxMessages = [];
        
        // Re-acquire canvas context for next connection
        // (transferControlToOffscreen is one-way, so we need to recreate canvas)
        if (this._useOffscreenCanvas && this._el.canvas) {
            const parent = this._el.canvas.parentElement;
            const oldCanvas = this._el.canvas;
            const newCanvas = document.createElement('canvas');
            newCanvas.className = oldCanvas.className;
            newCanvas.width = oldCanvas.width;
            newCanvas.height = oldCanvas.height;
            newCanvas.style.display = oldCanvas.style.display;
            newCanvas.setAttribute('tabindex', '0');
            parent.replaceChild(newCanvas, oldCanvas);
            this._el.canvas = newCanvas;
            this._canvas = newCanvas;
            // Note: Do NOT acquire 2D context here - _initGfxWorker will handle it
            // or _initGfxWorkerCanvas will acquire context if transfer fails
            
            // Re-attach event listeners to new canvas
            this._canvas.addEventListener('click', () => this._canvas.focus());
            this._canvas.addEventListener('mousemove', (e) => this._handleMouseMove(e));
            this._canvas.addEventListener('mousedown', (e) => this._handleMouseDown(e));
            this._canvas.addEventListener('mouseup', (e) => this._handleMouseUp(e));
            this._canvas.addEventListener('wheel', (e) => this._handleMouseWheel(e));
            this._canvas.addEventListener('contextmenu', (e) => e.preventDefault());
            
            // Re-initialize worker for next connection
            this._initGfxWorker();
        }
    }

    _handleError(message) {
        console.error('[RDPClient] Error:', message);
        this._updateStatus('error', 'Error');
        this._emit('error', { message });
        
        // If we have a pending connect promise (connection attempt failed),
        // reject it and close the WebSocket to allow retry
        if (this._pendingConnect) {
            this._pendingConnect.reject(new Error(message));
            this._pendingConnect = null;
            
            // Close the WebSocket to allow reconnection attempts
            if (this._ws) {
                this._ws.close();
                // Note: _handleDisconnect will be called by onclose handler
            }
        }
        // If already connected, just emit the error - don't force disconnect
    }

    _sendPing() {
        if (this._isConnected) {
            this._pingStart = performance.now();
            this._sendMessage({ type: 'ping' });
        }
    }

    _handlePong() {
        const latency = Math.round(performance.now() - this._pingStart);
        this._lastLatency = latency;
        this._el.latency.textContent = `Latency: ${latency}ms`;
        this._emit('latency', { latencyMs: latency });
    }

    // --------------------------------------------------
    // PRIVATE: VIDEO FRAMES
    // --------------------------------------------------

    /**
     * Handle frame update on main thread (fallback - should not be called)
     * All rendering is handled by the GFX worker via OffscreenCanvas
     */
    _handleFrameUpdate(data) {
        // This should not be reached - all frames go to GFX worker
        console.error('[RDPClient] Unexpected frame on main thread - GFX worker should handle all frames');
    }

    // --------------------------------------------------
    // PRIVATE: AUDIO
    // --------------------------------------------------

    async _initAudio() {
        if (this._audioContext) return;
        
        try {
            this._audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this._audioGainNode = this._audioContext.createGain();
            this._audioGainNode.connect(this._audioContext.destination);
            this._audioGainNode.gain.value = this._isMuted ? 0 : 1;
            
            // Initialize AudioWorklet for low-latency playback
            await this._initAudioWorklet();
        } catch (e) {
            console.error('[RDPClient] Audio init failed:', e);
        }
    }
    
    /**
     * Initialize AudioWorklet with SharedArrayBuffer ring buffer
     */
    async _initAudioWorklet() {
        if (this._audioWorklet) return;
        
        try {
            // Check for SharedArrayBuffer support (requires CORS headers)
            if (typeof SharedArrayBuffer === 'undefined') {
                console.warn('[RDPClient] SharedArrayBuffer not available, audio may have higher latency');
                return;
            }
            
            // Load the AudioWorklet module
            await this._audioContext.audioWorklet.addModule(RDP_CLIENT_BASE_URL + 'audio-worklet.js');
            
            // Create SharedArrayBuffer for ring buffer
            // Layout: [writeIndex(4), readIndex(4), bufferSize(4), channels(4), audioData...]
            const controlBytes = 16; // 4 Uint32s
            const audioBytes = this._audioBufferSize * this._audioChannels * 4; // Float32
            this._audioSharedBuffer = new SharedArrayBuffer(controlBytes + audioBytes);
            
            // Create views into the shared buffer
            this._audioControlView = new Uint32Array(this._audioSharedBuffer, 0, 4);
            this._audioDataView = new Float32Array(this._audioSharedBuffer, controlBytes, 
                                                   this._audioBufferSize * this._audioChannels);
            
            // Initialize control data
            this._audioControlView[0] = 0; // writeIndex
            this._audioControlView[1] = 0; // readIndex
            this._audioControlView[2] = this._audioBufferSize;
            this._audioControlView[3] = this._audioChannels;
            this._audioWriteIndex = 0;
            
            // Create AudioWorkletNode
            this._audioWorklet = new AudioWorkletNode(this._audioContext, 'rdp-audio-processor');
            this._audioWorklet.connect(this._audioGainNode);
            
            // Handle messages from worklet
            this._audioWorklet.port.onmessage = (event) => {
                const { type } = event.data;
                if (type === 'ready') {
                    this._audioWorkletReady = true;
                    console.log('[RDPClient] AudioWorklet ready');
                } else if (type === 'stats') {
                    // Optional: log stats for debugging
                    // console.log('[RDPClient] Audio stats:', event.data);
                }
            };
            
            // Send init message with shared buffer
            this._audioWorklet.port.postMessage({
                type: 'init',
                data: {
                    sharedBuffer: this._audioSharedBuffer,
                    bufferSize: this._audioBufferSize,
                    channels: this._audioChannels
                }
            });
            
            console.log('[RDPClient] AudioWorklet initialized with', 
                        this._audioBufferSize, 'sample ring buffer');
        } catch (e) {
            console.error('[RDPClient] AudioWorklet init failed:', e);
            this._audioWorklet = null;
        }
    }

    async _handleOpusFrame(bytes) {
        if (!this._audioContext) this._initAudio();
        if (this._isMuted) return;
        
        try {
            if (this._audioContext?.state === 'suspended') {
                this._audioContext.resume();
            }
            
            const view = new DataView(bytes.buffer, bytes.byteOffset);
            const sampleRate = view.getUint32(4, true);
            const channels = view.getUint16(8, true);
            const frameSize = view.getUint16(10, true);
            
            if (frameSize === 0 || frameSize > 4000) return;
            
            if (!this._opusDecoder || this._opusSampleRate !== sampleRate || 
                this._opusChannels !== channels) {
                await this._initOpusDecoder(sampleRate, channels);
            }
            
            if (!this._opusDecoder || this._opusDecoder.state === 'closed') return;
            
            const opusData = bytes.slice(12, 12 + frameSize);
            if (opusData.length === 0) return;
            
            this._opusDecoder.decode(new EncodedAudioChunk({
                type: 'key',
                timestamp: performance.now() * 1000,
                data: opusData
            }));
        } catch (e) {
            console.error('[RDPClient] Opus error:', e);
        }
    }

    async _initOpusDecoder(sampleRate, channels) {
        if (typeof AudioDecoder === 'undefined') return false;
        
        if (this._opusDecoder) {
            try { this._opusDecoder.close(); } catch (e) {}
        }
        
        try {
            this._opusSampleRate = sampleRate;
            this._opusChannels = channels;
            
            this._opusDecoder = new AudioDecoder({
                output: (audioData) => this._handleDecodedAudio(audioData),
                error: (e) => console.error('[RDPClient] Opus decode error:', e)
            });
            
            await this._opusDecoder.configure({
                codec: 'opus',
                sampleRate,
                numberOfChannels: channels,
            });
            
            this._opusInitialized = true;
            return true;
        } catch (e) {
            this._opusDecoder = null;
            return false;
        }
    }

    _handleDecodedAudio(audioData) {
        if (!this._audioContext || this._isMuted) {
            audioData.close();
            return;
        }
        
        try {
            if (this._audioContext.state === 'suspended') {
                this._audioContext.resume();
            }
            
            const numFrames = audioData.numberOfFrames;
            const numChannels = audioData.numberOfChannels;
            const format = audioData.format; // e.g., 'f32-planar', 'f32', 's16', etc.
            
            // If AudioWorklet is ready, write directly to ring buffer
            if (this._audioWorkletReady && this._audioDataView) {
                this._writeToRingBuffer(audioData, numFrames, numChannels, format);
            } else {
                // AudioWorklet not available - audio will not play
                if (!this._audioWorkletWarned) {
                    console.warn('[RDPClient] AudioWorklet not ready - audio frames dropped');
                    this._audioWorkletWarned = true;
                }
            }
        } catch (e) {
            console.error('[RDPClient] Audio error:', e);
        } finally {
            audioData.close();
        }
    }
    
    /**
     * Write decoded audio samples to the ring buffer for AudioWorklet
     */
    _writeToRingBuffer(audioData, numFrames, numChannels, format) {
        const bufferSize = this._audioBufferSize;
        const channels = this._audioChannels;
        
        // Prepare temp buffer for reading from AudioData
        const tempChannels = [];
        for (let ch = 0; ch < numChannels; ch++) {
            tempChannels.push(new Float32Array(numFrames));
        }
        
        // Copy audio data to temp buffers
        if (format && format.includes('planar')) {
            for (let ch = 0; ch < numChannels; ch++) {
                audioData.copyTo(tempChannels[ch], { planeIndex: ch });
            }
        } else {
            // Interleaved - extract to planar
            let tempBuffer;
            if (format === 's16') {
                tempBuffer = new Int16Array(numFrames * numChannels);
            } else if (format === 's32') {
                tempBuffer = new Int32Array(numFrames * numChannels);
            } else {
                tempBuffer = new Float32Array(numFrames * numChannels);
            }
            audioData.copyTo(tempBuffer, { planeIndex: 0 });
            
            for (let ch = 0; ch < numChannels; ch++) {
                for (let i = 0; i < numFrames; i++) {
                    let sample = tempBuffer[i * numChannels + ch];
                    if (format === 's16') sample = sample / 32768.0;
                    else if (format === 's32') sample = sample / 2147483648.0;
                    tempChannels[ch][i] = sample;
                }
            }
        }
        
        // Write interleaved samples to ring buffer
        let writeIdx = this._audioWriteIndex;
        for (let i = 0; i < numFrames; i++) {
            const bufferIdx = writeIdx % bufferSize;
            for (let ch = 0; ch < channels; ch++) {
                const srcCh = ch < numChannels ? ch : numChannels - 1;
                this._audioDataView[bufferIdx * channels + ch] = tempChannels[srcCh][i];
            }
            writeIdx++;
        }
        
        this._audioWriteIndex = writeIdx % bufferSize;
        Atomics.store(this._audioControlView, 0, this._audioWriteIndex);
    }


    _handleAudioFrame(bytes) {
        if (!this._audioContext || this._isMuted) return;
        
        try {
            if (this._audioContext.state === 'suspended') {
                this._audioContext.resume();
            }
            
            const view = new DataView(bytes.buffer, bytes.byteOffset);
            const sampleRate = view.getUint32(4, true);
            const channels = view.getUint16(8, true);
            const bits = view.getUint16(10, true);
            
            const pcmData = bytes.slice(12);
            if (pcmData.length === 0) return;
            
            const bytesPerSample = bits / 8;
            const numSamples = Math.floor(pcmData.length / (channels * bytesPerSample));
            if (numSamples === 0) return;
            
            // If AudioWorklet is ready, write directly to ring buffer
            if (this._audioWorkletReady && this._audioDataView) {
                this._writePcmToRingBuffer(pcmData, numSamples, channels, bits);
            } else {
                // AudioWorklet not available - audio will not play
                if (!this._audioWorkletWarned) {
                    console.warn('[RDPClient] AudioWorklet not ready - audio frames dropped');
                    this._audioWorkletWarned = true;
                }
            }
        } catch (e) {
            console.error('[RDPClient] PCM audio error:', e);
        }
    }
    
    /**
     * Write PCM audio samples to ring buffer for AudioWorklet
     */
    _writePcmToRingBuffer(pcmData, numSamples, srcChannels, bits) {
        const bufferSize = this._audioBufferSize;
        const dstChannels = this._audioChannels;
        const bytesPerSample = bits / 8;
        
        let writeIdx = this._audioWriteIndex;
        
        for (let i = 0; i < numSamples; i++) {
            const bufferIdx = writeIdx % bufferSize;
            
            for (let ch = 0; ch < dstChannels; ch++) {
                const srcCh = ch < srcChannels ? ch : srcChannels - 1;
                const sampleIndex = i * srcChannels + srcCh;
                const byteOffset = sampleIndex * bytesPerSample;
                
                let sample;
                if (bits === 16) {
                    const int16 = pcmData[byteOffset] | (pcmData[byteOffset + 1] << 8);
                    sample = int16 > 32767 ? (int16 - 65536) / 32768 : int16 / 32768;
                } else if (bits === 8) {
                    sample = (pcmData[byteOffset] - 128) / 128;
                } else {
                    sample = 0;
                }
                
                this._audioDataView[bufferIdx * dstChannels + ch] = sample;
            }
            writeIdx++;
        }
        
        this._audioWriteIndex = writeIdx % bufferSize;
        Atomics.store(this._audioControlView, 0, this._audioWriteIndex);
    }


    _cleanupAudio() {
        // Clean up Opus decoder
        if (this._opusDecoder) {
            try { this._opusDecoder.close(); } catch (e) {}
            this._opusDecoder = null;
            this._opusInitialized = false;
        }
        
        // Clean up AudioWorklet
        if (this._audioWorklet) {
            this._audioWorklet.port.postMessage({ type: 'reset' });
            this._audioWorklet.disconnect();
            this._audioWorklet = null;
        }
        this._audioWorkletReady = false;
        this._audioWorkletWarned = false;
        this._audioSharedBuffer = null;
        this._audioControlView = null;
        this._audioDataView = null;
        this._audioWriteIndex = 0;
        
        // Clean up AudioContext
        if (this._audioContext) {
            this._audioContext.close();
            this._audioContext = null;
            this._audioGainNode = null;
        }
    }

    // --------------------------------------------------
    // PRIVATE: INPUT HANDLING
    // --------------------------------------------------

    /**
     * Simple delay helper for async operations
     * @param {number} ms - Milliseconds to delay
     * @returns {Promise<void>}
     * @private
     */
    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Show the API cursor overlay at the specified remote desktop coordinates
     * @param {number} x - X coordinate in remote desktop pixels
     * @param {number} y - Y coordinate in remote desktop pixels
     * @private
     */
    _showApiCursor(x, y) {
        this._apiCursorPos = { x, y };
        this._apiCursorVisible = true;
        
        // Convert remote desktop coordinates to screen coordinates
        const rect = this._canvas.getBoundingClientRect();
        const width = Math.max(2, Math.floor((rect.width || this._canvas.clientWidth || this._canvas.width || 1) / 2) * 2);
        const height = Math.max(2, Math.floor((rect.height || this._canvas.clientHeight || this._canvas.height || 1) / 2) * 2);
        const scaleX = width / this._canvas.width;
        const scaleY = height / this._canvas.height;
        
        // Calculate position relative to the screen container
        const screenX = x * scaleX;
        const screenY = y * scaleY;
        
        this._el.apiCursor.style.left = `${screenX}px`;
        this._el.apiCursor.style.top = `${screenY}px`;
        this._el.apiCursor.classList.add('visible');
    }

    /**
     * Hide the API cursor overlay
     * @private
     */
    _hideApiCursor() {
        if (this._apiCursorVisible) {
            this._apiCursorVisible = false;
            this._el.apiCursor.classList.remove('visible');
        }
    }

    _getMousePos(e) {
        const rect = this._canvas.getBoundingClientRect();
        const width = Math.max(2, Math.floor((rect.width || this._canvas.clientWidth || this._canvas.width || 1) / 2) * 2);
        const height = Math.max(2, Math.floor((rect.height || this._canvas.clientHeight || this._canvas.height || 1) / 2) * 2);
        const scaleX = this._canvas.width / width;
        const scaleY = this._canvas.height / height;
        return {
            x: Math.round((e.clientX - rect.left) * scaleX),
            y: Math.round((e.clientY - rect.top) * scaleY)
        };
    }

    _handleMouseMove(e) {
        if (!this._isConnected) return;
        
        // Hide API cursor when real mouse moves
        this._hideApiCursor();
        
        const now = Date.now();
        if (now - this._lastMouseSend < this.options.mouseThrottleMs) return;
        this._lastMouseSend = now;
        
        const pos = this._getMousePos(e);
        this._sendMessage({ type: 'mouse', action: 'move', x: pos.x, y: pos.y });
    }

    _handleMouseDown(e) {
        if (!this._isConnected) return;
        e.preventDefault();
        this._canvas.focus();
        
        const pos = this._getMousePos(e);
        this._sendMessage({ type: 'mouse', action: 'down', button: e.button, x: pos.x, y: pos.y });
    }

    _handleMouseUp(e) {
        if (!this._isConnected) return;
        e.preventDefault();
        
        const pos = this._getMousePos(e);
        this._sendMessage({ type: 'mouse', action: 'up', button: e.button, x: pos.x, y: pos.y });
    }

    _handleMouseWheel(e) {
        if (!this._isConnected) return;
        e.preventDefault();
        
        const pos = this._getMousePos(e);
        this._sendMessage({ 
            type: 'mouse', action: 'wheel', 
            deltaX: e.deltaX, deltaY: e.deltaY, 
            x: pos.x, y: pos.y 
        });
    }

    _handleKeyDown(e) {
        if (!this._isConnected) return;
        if (this._shadow.activeElement !== this._canvas) return;
        
        e.preventDefault();
        this._sendMessage({
            type: 'key', action: 'down',
            key: e.key, code: e.code, keyCode: e.keyCode,
            ctrlKey: e.ctrlKey, shiftKey: e.shiftKey,
            altKey: e.altKey, metaKey: e.metaKey
        });
    }

    _handleKeyUp(e) {
        if (!this._isConnected) return;
        if (this._shadow.activeElement !== this._canvas) return;
        
        e.preventDefault();
        this._sendMessage({
            type: 'key', action: 'up',
            key: e.key, code: e.code, keyCode: e.keyCode,
            ctrlKey: e.ctrlKey, shiftKey: e.shiftKey,
            altKey: e.altKey, metaKey: e.metaKey
        });
    }

    // --------------------------------------------------
    // PRIVATE: VIRTUAL KEYBOARD
    // --------------------------------------------------
    
    /**
     * Setup virtual keyboard event listeners
     */
    _setupVirtualKeyboard() {
        const overlay = this._el.keyboardOverlay;
        const titlebar = this._el.keyboardTitlebar;
        const resizeHandle = this._el.keyboardResize;
        
        // Close button
        this._el.keyboardClose.addEventListener('click', () => this.hideKeyboard());
        
        // Key press handlers
        overlay.querySelectorAll('.rdp-key').forEach(key => {
            key.addEventListener('mousedown', (e) => this._handleVirtualKeyDown(e, key));
            key.addEventListener('mouseup', (e) => this._handleVirtualKeyUp(e, key));
            key.addEventListener('mouseleave', (e) => this._handleVirtualKeyUp(e, key));
            // Touch support
            key.addEventListener('touchstart', (e) => {
                e.preventDefault();
                this._handleVirtualKeyDown(e, key);
            });
            key.addEventListener('touchend', (e) => {
                e.preventDefault();
                this._handleVirtualKeyUp(e, key);
            });
        });
        
        // Dragging
        titlebar.addEventListener('mousedown', (e) => this._startKeyboardDrag(e));
        titlebar.addEventListener('touchstart', (e) => {
            e.preventDefault();
            this._startKeyboardDrag(e.touches[0]);
        });
        
        // Resizing
        resizeHandle.addEventListener('mousedown', (e) => this._startKeyboardResize(e));
        resizeHandle.addEventListener('touchstart', (e) => {
            e.preventDefault();
            this._startKeyboardResize(e.touches[0]);
        });
        
        // Global mouse/touch move and up handlers
        this._shadow.addEventListener('mousemove', (e) => {
            if (this._keyboardDragging) this._handleKeyboardDrag(e);
            if (this._keyboardResizing) this._handleKeyboardResize(e);
        });
        this._shadow.addEventListener('mouseup', () => {
            this._keyboardDragging = false;
            this._keyboardResizing = false;
        });
        this._shadow.addEventListener('touchmove', (e) => {
            if (this._keyboardDragging || this._keyboardResizing) {
                e.preventDefault();
                const touch = e.touches[0];
                if (this._keyboardDragging) this._handleKeyboardDrag(touch);
                if (this._keyboardResizing) this._handleKeyboardResize(touch);
            }
        });
        this._shadow.addEventListener('touchend', () => {
            this._keyboardDragging = false;
            this._keyboardResizing = false;
        });
    }
    
    /**
     * Toggle virtual keyboard visibility
     */
    _toggleKeyboard() {
        if (this._keyboardVisible) {
            this.hideKeyboard();
        } else {
            this.showKeyboard();
        }
    }
    
    /**
     * Show the virtual keyboard
     * @public
     */
    showKeyboard() {
        if (!this._isConnected) return;
        
        const overlay = this._el.keyboardOverlay;
        const content = this._el.keyboardContent;
        const screenRect = this._el.screen.getBoundingClientRect();
        
        // Reset scale to measure natural size
        content.style.transform = 'scale(1)';
        overlay.classList.add('visible');
        
        // Measure natural keyboard size (only once)
        if (this._keyboardBaseWidth === 0) {
            const contentRect = content.getBoundingClientRect();
            const titlebarRect = this._el.keyboardTitlebar.getBoundingClientRect();
            this._keyboardBaseWidth = contentRect.width;
            this._keyboardBaseHeight = contentRect.height;  // Content only (rows)
            this._keyboardTitlebarHeight = titlebarRect.height + 8; // +8 for margin
        }
        
        // Scale limits - adjusted for better usability
        const minScale = 0.5;
        const maxScale = 1.2;
        
        // Calculate initial scale (try to fit 80% of screen width, but clamp to limits)
        let scale = Math.min((screenRect.width * 0.8 - 16) / this._keyboardBaseWidth, maxScale);
        scale = Math.max(scale, minScale);
        
        // Calculate dimensions: width and content are scaled, titlebar is not
        const calcWidth = (s) => (this._keyboardBaseWidth * s) + 16;
        const calcHeight = (s) => (this._keyboardBaseHeight * s) + this._keyboardTitlebarHeight + 16;
        
        // Check if max scale still fits in canvas
        const maxWidth = screenRect.width - 20;  // Leave some margin
        const maxHeight = screenRect.height - 40;  // Leave some margin
        
        if (calcWidth(scale) > maxWidth) {
            scale = Math.max(minScale, (maxWidth - 16) / this._keyboardBaseWidth);
        }
        if (calcHeight(scale) > maxHeight) {
            const heightScale = (maxHeight - this._keyboardTitlebarHeight - 16) / this._keyboardBaseHeight;
            scale = Math.max(minScale, Math.min(scale, heightScale));
        }
        
        const width = calcWidth(scale);
        const height = calcHeight(scale);
        
        // Apply scale
        content.style.transform = `scale(${scale})`;
        
        // Center horizontally, position at bottom
        const left = (screenRect.width - width) / 2;
        const top = Math.max(0, screenRect.height - height - 20);
        
        overlay.style.width = `${width}px`;
        overlay.style.height = `${height}px`;
        overlay.style.left = `${Math.max(0, left)}px`;
        overlay.style.top = `${top}px`;
        
        this._keyboardVisible = true;
        this._emit('keyboardShow');
    }
    
    /**
     * Hide the virtual keyboard
     * @public
     */
    hideKeyboard() {
        this._el.keyboardOverlay.classList.remove('visible');
        this._keyboardVisible = false;
        this._resetKeyboardModifiers();
        this._emit('keyboardHide');
    }
    
    /**
     * Check if virtual keyboard is visible
     * @public
     * @returns {boolean}
     */
    isKeyboardVisible() {
        return this._keyboardVisible;
    }
    
    /**
     * Reset all keyboard modifiers
     */
    _resetKeyboardModifiers() {
        this._keyboardModifiers = { ctrl: false, alt: false, shift: false, meta: false, altgr: false };
        this._el.keyboardOverlay.querySelectorAll('.rdp-key-modifier').forEach(key => {
            key.classList.remove('pressed');
        });
        this._updateKeyboardKeyLabels();
    }
    
    /**
     * Update keyboard key labels based on active modifiers (shift, altgr, shift+altgr)
     * Priority: shift+altgr > altgr > shift > normal
     */
    _updateKeyboardKeyLabels() {
        const shiftActive = this._keyboardModifiers.shift;
        const altgrActive = this._keyboardModifiers.altgr;
        
        this._el.keyboardOverlay.querySelectorAll('.rdp-key[data-key]').forEach(key => {
            let label;
            
            if (shiftActive && altgrActive) {
                // Shift+AltGr: use data-shift-altgr, fallback to data-altgr, then data-shift, then data-key
                label = key.dataset.shiftAltgr || key.dataset.altgr || key.dataset.shift || key.dataset.key;
            } else if (altgrActive) {
                // AltGr only: use data-altgr, fallback to data-key
                label = key.dataset.altgr || key.dataset.key;
            } else if (shiftActive) {
                // Shift only: use data-shift, fallback to data-key
                label = key.dataset.shift || key.dataset.key;
            } else {
                // No modifiers: use data-key
                label = key.dataset.key;
            }
            
            key.textContent = label;
        });
    }
    
    /**
     * Handle virtual key press
     */
    _handleVirtualKeyDown(e, key) {
        if (!this._isConnected) return;
        e.preventDefault();
        e.stopPropagation();
        
        const code = key.dataset.code;
        const combo = key.dataset.combo;
        const modifier = key.dataset.modifier;
        
        // Handle special combos (no tracking needed, instant action)
        if (combo) {
            key.classList.add('pressed');
            this._sendVirtualKeyCombo(combo);
            // Remove pressed state after a short delay for visual feedback
            setTimeout(() => key.classList.remove('pressed'), 150);
            return;
        }
        
        // Handle modifier keys (toggle mode, no tracking)
        if (modifier) {
            this._keyboardModifiers[modifier] = !this._keyboardModifiers[modifier];
            if (this._keyboardModifiers[modifier]) {
                key.classList.add('pressed');
            } else {
                key.classList.remove('pressed');
            }
            // Update key labels when shift or altgr state changes
            if (modifier === 'shift' || modifier === 'altgr') {
                this._updateKeyboardKeyLabels();
            }
            return;
        }
        
        // Track this as the active key
        this._keyboardActiveKey = key;
        key.classList.add('pressed');
        
        // Get key name based on modifier state (priority: shift+altgr > altgr > shift > normal)
        const shiftActive = this._keyboardModifiers.shift;
        const altgrActive = this._keyboardModifiers.altgr;
        let keyName;
        let hasAltGrChar = false; // True if we have a dedicated AltGr character for this key
        
        if (shiftActive && altgrActive) {
            // Check if key has a dedicated shift+altgr character
            hasAltGrChar = !!key.dataset.shiftAltgr || !!key.dataset.altgr;
            keyName = key.dataset.shiftAltgr || key.dataset.altgr || key.dataset.shift || key.textContent;
        } else if (altgrActive) {
            // Check if key has a dedicated altgr character
            hasAltGrChar = !!key.dataset.altgr;
            keyName = key.dataset.altgr || key.dataset.key || key.textContent;
        } else if (shiftActive) {
            keyName = key.dataset.shift || key.textContent;
        } else {
            keyName = key.dataset.key || key.textContent;
        }
        
        // If we have a dedicated AltGr character, send it directly without modifier events.
        // The character itself (e.g., €, ñ, ß) is sent as Unicode, no Ctrl+Alt needed.
        // Only send modifier events if we DON'T have a dedicated AltGr char.
        if (!hasAltGrChar) {
            this._sendActiveModifierDownEvents();
        } else if (shiftActive && !altgrActive) {
            // Only shift is active (no altgr), send shift
            this._sendActiveModifierDownEvents();
        }
        
        // Send main key - when hasAltGrChar is true, send without modifier flags
        // so backend uses Unicode input for the special character
        this._sendMessage({
            type: 'key', action: 'down',
            key: keyName, code: code, keyCode: 0,
            ctrlKey: hasAltGrChar ? false : this._keyboardModifiers.ctrl,
            shiftKey: hasAltGrChar ? false : this._keyboardModifiers.shift,
            altKey: hasAltGrChar ? false : this._keyboardModifiers.alt,
            metaKey: hasAltGrChar ? false : this._keyboardModifiers.meta
        });
    }
    
    /**
     * Send key down events for all active modifiers
     */
    _sendActiveModifierDownEvents() {
        // AltGr is equivalent to Ctrl+Alt on Windows
        if (this._keyboardModifiers.altgr) {
            this._sendMessage({
                type: 'key', action: 'down',
                key: 'Control', code: 'ControlLeft', keyCode: 0,
                ctrlKey: true, shiftKey: false, altKey: false, metaKey: false
            });
            this._sendMessage({
                type: 'key', action: 'down',
                key: 'Alt', code: 'AltRight', keyCode: 0,
                ctrlKey: true, shiftKey: false, altKey: true, metaKey: false
            });
        } else {
            if (this._keyboardModifiers.ctrl) {
                this._sendMessage({
                    type: 'key', action: 'down',
                    key: 'Control', code: 'ControlLeft', keyCode: 0,
                    ctrlKey: true, shiftKey: false, altKey: false, metaKey: false
                });
            }
            if (this._keyboardModifiers.alt) {
                this._sendMessage({
                    type: 'key', action: 'down',
                    key: 'Alt', code: 'AltLeft', keyCode: 0,
                    ctrlKey: this._keyboardModifiers.ctrl, shiftKey: false, altKey: true, metaKey: false
                });
            }
        }
        if (this._keyboardModifiers.shift) {
            this._sendMessage({
                type: 'key', action: 'down',
                key: 'Shift', code: 'ShiftLeft', keyCode: 0,
                ctrlKey: this._keyboardModifiers.ctrl, shiftKey: true, altKey: this._keyboardModifiers.alt, metaKey: false
            });
        }
        if (this._keyboardModifiers.meta) {
            this._sendMessage({
                type: 'key', action: 'down',
                key: 'Meta', code: 'MetaLeft', keyCode: 0,
                ctrlKey: this._keyboardModifiers.ctrl, shiftKey: this._keyboardModifiers.shift, altKey: this._keyboardModifiers.alt, metaKey: true
            });
        }
    }
    
    /**
     * Send key up events for all active modifiers
     */
    _sendActiveModifierUpEvents() {
        if (this._keyboardModifiers.meta) {
            this._sendMessage({
                type: 'key', action: 'up',
                key: 'Meta', code: 'MetaLeft', keyCode: 0,
                ctrlKey: this._keyboardModifiers.ctrl, shiftKey: this._keyboardModifiers.shift, altKey: this._keyboardModifiers.alt, metaKey: false
            });
        }
        if (this._keyboardModifiers.shift) {
            this._sendMessage({
                type: 'key', action: 'up',
                key: 'Shift', code: 'ShiftLeft', keyCode: 0,
                ctrlKey: this._keyboardModifiers.ctrl, shiftKey: false, altKey: this._keyboardModifiers.alt, metaKey: false
            });
        }
        // AltGr releases Ctrl+Alt in reverse order
        if (this._keyboardModifiers.altgr) {
            this._sendMessage({
                type: 'key', action: 'up',
                key: 'Alt', code: 'AltRight', keyCode: 0,
                ctrlKey: true, shiftKey: false, altKey: false, metaKey: false
            });
            this._sendMessage({
                type: 'key', action: 'up',
                key: 'Control', code: 'ControlLeft', keyCode: 0,
                ctrlKey: false, shiftKey: false, altKey: false, metaKey: false
            });
        } else {
            if (this._keyboardModifiers.alt) {
                this._sendMessage({
                    type: 'key', action: 'up',
                    key: 'Alt', code: 'AltLeft', keyCode: 0,
                    ctrlKey: this._keyboardModifiers.ctrl, shiftKey: false, altKey: false, metaKey: false
                });
            }
            if (this._keyboardModifiers.ctrl) {
                this._sendMessage({
                    type: 'key', action: 'up',
                    key: 'Control', code: 'ControlLeft', keyCode: 0,
                    ctrlKey: false, shiftKey: false, altKey: false, metaKey: false
                });
            }
        }
    }
    
    /**
     * Handle virtual key release
     */
    _handleVirtualKeyUp(e, key) {
        if (!this._isConnected) return;
        
        const modifier = key.dataset.modifier;
        const combo = key.dataset.combo;
        
        // Don't process modifier keys or combos on mouseup (they toggle/instant)
        if (modifier || combo) return;
        
        // Only send key up if this is the actively pressed key
        if (this._keyboardActiveKey !== key) return;
        
        this._keyboardActiveKey = null;
        key.classList.remove('pressed');
        
        const code = key.dataset.code;
        
        // Get key name based on modifier state (priority: shift+altgr > altgr > shift > normal)
        const shiftActive = this._keyboardModifiers.shift;
        const altGrActive = this._keyboardModifiers.altgr;
        let keyName;
        let hasAltGrChar = false; // True if we have a dedicated AltGr character
        
        if (shiftActive && altGrActive) {
            hasAltGrChar = !!key.dataset.shiftAltgr || !!key.dataset.altgr;
            keyName = key.dataset.shiftAltgr || key.dataset.altgr || key.dataset.shift || key.textContent;
        } else if (altGrActive) {
            hasAltGrChar = !!key.dataset.altgr;
            keyName = key.dataset.altgr || key.dataset.key || key.textContent;
        } else if (shiftActive) {
            keyName = key.dataset.shift || key.textContent;
        } else {
            keyName = key.dataset.key || key.textContent;
        }
        
        // Send main key up - when hasAltGrChar, send without modifier flags
        this._sendMessage({
            type: 'key', action: 'up',
            key: keyName, code: code, keyCode: 0,
            ctrlKey: hasAltGrChar ? false : this._keyboardModifiers.ctrl,
            shiftKey: hasAltGrChar ? false : this._keyboardModifiers.shift,
            altKey: hasAltGrChar ? false : this._keyboardModifiers.alt,
            metaKey: hasAltGrChar ? false : this._keyboardModifiers.meta
        });
        
        // Send modifier key up events only if we sent them on key down
        if (!hasAltGrChar) {
            this._sendActiveModifierUpEvents();
        } else if (shiftActive && !altGrActive) {
            this._sendActiveModifierUpEvents();
        }
        
        // Reset modifiers after non-modifier key press
        this._resetKeyboardModifiers();
    }
    
    /**
     * Send a key combination (properly simulates modifier key presses)
     */
    _sendVirtualKeyCombo(combo) {
        const keys = combo.toLowerCase().split('+');
        const modifierKeys = [];
        let mainKey = null;
        let mainCode = null;
        
        keys.forEach(k => {
            switch (k) {
                case 'ctrl': 
                    modifierKeys.push({ key: 'Control', code: 'ControlLeft' });
                    break;
                case 'alt': 
                    modifierKeys.push({ key: 'Alt', code: 'AltLeft' });
                    break;
                case 'shift': 
                    modifierKeys.push({ key: 'Shift', code: 'ShiftLeft' });
                    break;
                case 'meta': case 'win': 
                    modifierKeys.push({ key: 'Meta', code: 'MetaLeft' });
                    break;
                case 'tab': 
                    mainKey = 'Tab'; 
                    mainCode = 'Tab'; 
                    break;
                case 'delete': 
                    mainKey = 'Delete'; 
                    mainCode = 'Delete'; 
                    break;
                default: 
                    mainKey = k; 
                    mainCode = k;
            }
        });
        
        if (!mainKey) return;
        
        // Build modifier state
        const modifiers = {
            ctrl: modifierKeys.some(m => m.key === 'Control'),
            alt: modifierKeys.some(m => m.key === 'Alt'),
            shift: modifierKeys.some(m => m.key === 'Shift'),
            meta: modifierKeys.some(m => m.key === 'Meta')
        };
        
        // Press modifier keys down first
        modifierKeys.forEach(mod => {
            this._sendMessage({
                type: 'key', action: 'down',
                key: mod.key, code: mod.code, keyCode: 0,
                ctrlKey: false, shiftKey: false, altKey: false, metaKey: false
            });
        });
        
        // Small delay then press main key
        setTimeout(() => {
            // Press main key down
            this._sendMessage({
                type: 'key', action: 'down',
                key: mainKey, code: mainCode, keyCode: 0,
                ctrlKey: modifiers.ctrl, shiftKey: modifiers.shift,
                altKey: modifiers.alt, metaKey: modifiers.meta
            });
            
            // Release main key
            setTimeout(() => {
                this._sendMessage({
                    type: 'key', action: 'up',
                    key: mainKey, code: mainCode, keyCode: 0,
                    ctrlKey: modifiers.ctrl, shiftKey: modifiers.shift,
                    altKey: modifiers.alt, metaKey: modifiers.meta
                });
                
                // Release modifier keys in reverse order
                setTimeout(() => {
                    [...modifierKeys].reverse().forEach(mod => {
                        this._sendMessage({
                            type: 'key', action: 'up',
                            key: mod.key, code: mod.code, keyCode: 0,
                            ctrlKey: false, shiftKey: false, altKey: false, metaKey: false
                        });
                    });
                }, 20);
            }, 30);
        }, 20);
    }
    
    /**
     * Start dragging the keyboard
     */
    _startKeyboardDrag(e) {
        this._keyboardDragging = true;
        const overlay = this._el.keyboardOverlay;
        const rect = overlay.getBoundingClientRect();
        const screenRect = this._el.screen.getBoundingClientRect();
        
        this._keyboardDragOffset = {
            x: e.clientX - (rect.left - screenRect.left),
            y: e.clientY - (rect.top - screenRect.top)
        };
    }
    
    /**
     * Handle keyboard dragging
     */
    _handleKeyboardDrag(e) {
        if (!this._keyboardDragging) return;
        
        const overlay = this._el.keyboardOverlay;
        const screenRect = this._el.screen.getBoundingClientRect();
        const overlayRect = overlay.getBoundingClientRect();
        
        let newLeft = e.clientX - this._keyboardDragOffset.x;
        let newTop = e.clientY - this._keyboardDragOffset.y;
        
        // Constrain to screen bounds
        newLeft = Math.max(0, Math.min(newLeft, screenRect.width - overlayRect.width));
        newTop = Math.max(0, Math.min(newTop, screenRect.height - overlayRect.height));
        
        overlay.style.left = `${newLeft}px`;
        overlay.style.top = `${newTop}px`;
    }
    
    /**
     * Start resizing the keyboard
     */
    _startKeyboardResize(e) {
        this._keyboardResizing = true;
        e.stopPropagation();
    }
    
    /**
     * Handle keyboard resizing with content scaling
     */
    _handleKeyboardResize(e) {
        if (!this._keyboardResizing) return;
        if (this._keyboardBaseWidth === 0) return;  // Not initialized
        
        const overlay = this._el.keyboardOverlay;
        const content = this._el.keyboardContent;
        const screenRect = this._el.screen.getBoundingClientRect();
        const overlayRect = overlay.getBoundingClientRect();
        
        // Scale limits
        const minScale = 0.6;
        const maxScale = 1.2;
        
        // Helper functions for calculating dimensions
        const calcWidth = (s) => (this._keyboardBaseWidth * s) + 16;
        const calcHeight = (s) => (this._keyboardBaseHeight * s) + this._keyboardTitlebarHeight + 16;
        
        // Calculate new width based on mouse position
        let newWidth = e.clientX - overlayRect.left + 10;
        
        // Calculate desired scale
        let scale = (newWidth - 16) / this._keyboardBaseWidth;
        
        // Clamp scale between min and max
        scale = Math.max(minScale, Math.min(maxScale, scale));
        
        // Check canvas boundaries and adjust if needed
        const maxWidth = screenRect.width - (overlayRect.left - screenRect.left);
        const maxHeight = screenRect.height - (overlayRect.top - screenRect.top);
        
        if (calcWidth(scale) > maxWidth) {
            scale = Math.max(minScale, (maxWidth - 16) / this._keyboardBaseWidth);
        }
        
        if (calcHeight(scale) > maxHeight) {
            const heightScale = (maxHeight - this._keyboardTitlebarHeight - 16) / this._keyboardBaseHeight;
            scale = Math.max(minScale, Math.min(scale, heightScale));
        }
        
        // Ensure we're still within scale limits after boundary checks
        scale = Math.max(minScale, Math.min(maxScale, scale));
        
        newWidth = calcWidth(scale);
        const newHeight = calcHeight(scale);
        
        content.style.transform = `scale(${scale})`;
        overlay.style.width = `${newWidth}px`;
        overlay.style.height = `${newHeight}px`;
    }

    // --------------------------------------------------
    // PRIVATE: RESIZE
    // --------------------------------------------------

    _getAvailableDimensions() {
        const rect = this._el.screen.getBoundingClientRect();
        const fallbackRect = this._container?.getBoundingClientRect?.() || rect;
        let width = Math.floor((rect.width || fallbackRect.width || window.innerWidth || 1280) - 4);
        let height = Math.floor((rect.height || fallbackRect.height || window.innerHeight || 720) - 4);

        // do never send resize below RDP server minimums or above maximums
        const minRdpServerDimensions = { width: 640, height: 480 };
        const maxRdpServerDimensions = { width: 4096, height: 2304 };
        
        // Respect user-defined minWidth/minHeight (never send resize below these values)
        // But still honor minimums of rdp server
        const minW = Math.max(minRdpServerDimensions.width, this.options.minWidth || 0);
        const minH = Math.max(minRdpServerDimensions.height, this.options.minHeight || 0);
        // But still honor maximumof rdp server
        width = Math.max(minW, Math.min(width, maxRdpServerDimensions.width));
        height = Math.max(minH, Math.min(height, maxRdpServerDimensions.height));
        width = Math.floor(width / 2) * 2;
        height = Math.floor(height / 2) * 2;
        
        return { width, height };
    }

    _handleResize() {
        if (!this._isConnected) return;
        
        if (this._resizeTimeout) {
            clearTimeout(this._resizeTimeout);
        }
        
        this._resizeTimeout = setTimeout(() => {
            if (!this._isConnected) return;
            
            const { width, height } = this._getAvailableDimensions();
            
            if ((width !== this._canvas.width || height !== this._canvas.height) &&
                (width !== this._lastRequestedWidth || height !== this._lastRequestedHeight)) {
                this._lastRequestedWidth = width;
                this._lastRequestedHeight = height;
                this._sendMessage({ type: 'resize', width, height });
            }
        }, this.options.resizeDebounceMs);
    }

    _handleServerResize(width, height) {
        // Update resolution display
        this._el.resolution.textContent = `Resolution: ${width}x${height}`;
        
        // When using OffscreenCanvas (transferred to worker), we cannot resize
        // the HTMLCanvasElement directly. The worker owns the canvas now.
        // We need to notify the worker to resize the OffscreenCanvas instead.
        if (this._gfxWorker && this._gfxWorkerReady) {
            this._gfxWorker.postMessage({
                type: 'resize',
                data: { width, height }
            });
        } else {
            // Fallback: only resize HTMLCanvasElement if NOT transferred to worker
            try {
                this._canvas.width = width;
                this._canvas.height = height;
            } catch (e) {
                // Canvas was transferred to offscreen, ignore
            }
        }
        
        this._emit('resize', { width, height });
    }
}

// Re-export theme utilities for convenience
export { themes, resolveTheme, sanitizeTheme } from './rdp-themes.js';

// Default export for convenience
export default RDPClient;
