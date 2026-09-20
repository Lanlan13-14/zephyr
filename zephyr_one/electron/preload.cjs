const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zephyrOne', {
  invoke(command, args) {
    return ipcRenderer.invoke(command, args);
  },
});
