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
});
