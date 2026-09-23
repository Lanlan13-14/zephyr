const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zephyrOne', {
  invoke(command, args) {
    return ipcRenderer.invoke(command, args);
  },
  onProgress(listener) {
    if (typeof listener !== 'function') return () => {};
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('runtime_progress', handler);
    return () => ipcRenderer.removeListener('runtime_progress', handler);
  },
  onShown(listener) {
    if (typeof listener !== 'function') return () => {};
    const handler = () => listener();
    ipcRenderer.on('zephyr-one:shown', handler);
    return () => ipcRenderer.removeListener('zephyr-one:shown', handler);
  },
});
