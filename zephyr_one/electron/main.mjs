import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { capabilities, unlock, unlockReason } from './auth.mjs';
import {
  appendRuntimeLog,
  currentBaseUrl,
  currentCorePid,
  ensureStarted,
  localAppUrl,
  readLaunchAppearance,
  runtimeInfo,
  sessionCookie,
  shouldAutostart,
  stopRuntime,
  writeLaunchAppearance,
  writeUiReadyMarker,
} from './runtime.mjs';
import { createShellIdentity } from './shell-auth.mjs';
import { applyThemeIcon, completeQueuedUnlock, spawnPickerWatcher, spawnThemeWatcher, spawnUnlockWatcher } from './watchers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const oneRoot = path.resolve(here, '..');
const identity = createShellIdentity();
const windowsRelease = process.platform === 'win32' && app.isPackaged;

let mainWindow = null;
let productWindow = null;
let watchersStarted = false;
let enteringProduct = null;

function emitRuntimeProgress(pct, message) {
  const payload = { pct: Number(pct) || 0, message: String(message || '') };
  for (const window of [mainWindow, productWindow]) {
    if (!window || window.isDestroyed()) continue;
    window.webContents.send('runtime_progress', payload);
  }
}

function iconsDir() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'runtime-icons');
  return path.join(oneRoot, 'src-tauri', 'runtime-icons');
}

function preloadPath() {
  return path.join(here, 'preload.cjs');
}

function createMainWindow() {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 880,
    minHeight: 600,
    title: 'Zephyr One',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#090b0e',
    icon: path.join(oneRoot, 'src-tauri', 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  /* The overlay's CSS animation starts when the document loads. A hidden
   * window still loads, so waiting for ready-to-show lets the blossom finish
   * before the user ever sees the window. Show as soon as the DOM exists,
   * then let the renderer restart the sequence on zephyr-one:shown. */
  window.webContents.once('dom-ready', () => {
    if (window.isDestroyed()) return;
    window.show();
    window.webContents.send('zephyr-one:shown');
  });
  window.on('closed', () => {
    mainWindow = null;
  });
  return window;
}

function createProductWindow() {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 880,
    minHeight: 600,
    title: 'Zephyr One',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#101114',
    icon: path.join(oneRoot, 'src-tauri', 'icons', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1:') || url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const origin = currentBaseUrl();
    if (!origin) return;
    if (url === 'about:blank') return;
    if (!url.startsWith(origin)) event.preventDefault();
  });
  window.webContents.on('did-fail-load', (event) => {
    appendRuntimeLog(
      app.getPath('userData'),
      `product window failed to load ${event.validatedURL || ''}: ${event.errorCode} ${event.errorDescription || ''}`,
    );
  });
  window.on('close', () => {
    app.quit();
  });
  window.on('closed', () => {
    productWindow = null;
  });
  return window;
}

async function startRuntime() {
  appendRuntimeLog(app.getPath('userData'), 'runtime_start command entered');
  const info = await ensureStarted({
    userDataDir: app.getPath('userData'),
    resourceDir: process.resourcesPath,
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    appVersion: app.getVersion(),
    shellSecret: identity.secret,
    shellInstance: identity.instance,
    onProgress: (pct, message) => emitRuntimeProgress(pct, message),
  });
  if (!watchersStarted) {
    spawnUnlockWatcher({ identity });
    spawnPickerWatcher({
      identity,
      dialog,
      getWindow: () => productWindow || mainWindow,
    });
    spawnThemeWatcher({
      getWindows: () => [mainWindow, productWindow].filter(Boolean),
      iconsDir: iconsDir(),
      persistAppearance: (appearance) => writeLaunchAppearance(app.getPath('userData'), appearance),
    });
    watchersStarted = true;
  }
  appendRuntimeLog(app.getPath('userData'), 'runtime_start command completed');
  return info;
}

async function restartProduct() {
  try { await stopRuntime(); } catch { /* best effort */ }
  await startRuntime();
  return enterProduct();
}

async function enterProduct() {
  if (enteringProduct) return enteringProduct;
  enteringProduct = openProductWindow().finally(() => {
    enteringProduct = null;
  });
  return enteringProduct;
}

async function openProductWindow() {
  const info = runtimeInfo();
  if (!info.running || !info.baseUrl) {
    throw new Error('embedded product is not ready for trusted entry');
  }
  if (!productWindow || productWindow.isDestroyed()) {
    productWindow = createProductWindow();
  }
  const cookie = sessionCookie();
  try {
    await session.defaultSession.cookies.remove(cookie.url, cookie.name);
  } catch { /* first launch has nothing to remove */ }
  await session.defaultSession.cookies.set(cookie);
  const target = localAppUrl();
  try {
    const health = await fetch(`${info.baseUrl.replace(/\/+$/, '')}/healthz`);
    const body = health.ok ? await health.json() : {};
    writeUiReadyMarker({
      nonce: process.env.ZEPHYR_ONE_UI_READY_NONCE || '',
      corePid: currentCorePid(),
      url: target,
      instanceId: body.instanceId || '',
    });
  } catch { /* smoke harness only */ }
  await productWindow.loadURL(target);
  productWindow.show();
  productWindow.focus();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  return info;
}

function wireIpc() {
  ipcMain.handle('get_platform', () => ({
    os: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
    arch: process.arch,
    family: process.platform === 'win32' ? 'windows' : 'unix',
  }));
  ipcMain.handle('get_app_version', () => app.getVersion());
  ipcMain.handle('auth_capabilities', () => capabilities());
  ipcMain.handle('auth_unlock', async (_event, payload) => unlock(unlockReason(payload)));
  ipcMain.handle('get_launch_appearance', () => readLaunchAppearance(app.getPath('userData')));
  ipcMain.handle('set_launch_appearance', (_event, appearance) => (
    writeLaunchAppearance(app.getPath('userData'), appearance)
  ));
  ipcMain.handle('set_theme_icon', (_event, theme) => (
    applyThemeIcon([mainWindow, productWindow].filter(Boolean), iconsDir(), theme)
  ));
  ipcMain.handle('runtime_start', () => startRuntime());
  ipcMain.handle('runtime_enter', () => enterProduct());
  ipcMain.handle('runtime_info', () => runtimeInfo());
  ipcMain.handle('runtime_stop', () => stopRuntime());
  ipcMain.handle('runtime_restart', () => restartProduct());
  ipcMain.handle('security_complete_unlock', (_event, payload) => completeQueuedUnlock({ identity, payload }));
}

app.setName('Zephyr One');
app.setAppUserModelId('com.zephyr.one');
app.setPath('userData', path.join(app.getPath('appData'), 'com.zephyr.one'));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = productWindow || mainWindow;
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });

  app.whenReady().then(async () => {
    wireIpc();
    mainWindow = createMainWindow();
    const index = path.join(oneRoot, 'index.html');
    if (app.isPackaged) {
      await mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'));
    } else if (process.env.ELECTRON_RENDERER_URL) {
      await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
      await mainWindow.loadFile(index);
    }

    /* Show the overlay first, then start Node. enterProduct still waits for
     * the core, so first paint is never the black product window. Joining the
     * renderer runtime_enter keeps a single Node and a single UI-ready marker. */
    if (shouldAutostart(process.env.ZEPHYR_ONE_AUTOSTART_RUNTIME, windowsRelease)) {
      startRuntime()
        .then(() => enterProduct())
        .catch((error) => {
          appendRuntimeLog(app.getPath('userData'), `runtime start failed: ${error.message}`);
        });
    }
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  stopRuntime().catch(() => {});
});
