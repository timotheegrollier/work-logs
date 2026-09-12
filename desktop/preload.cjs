const { contextBridge, ipcRenderer } = require('electron');

// Le renderer ne reçoit ni accès Node, ni accès IPC général, ni jeton du serveur.
let beforeClose = async () => {};
ipcRenderer.on('worklogs:prepare-close', async () => {
  try {
    await beforeClose();
    ipcRenderer.send('worklogs:close-ready', null);
  } catch (error) {
    ipcRenderer.send('worklogs:close-ready', error instanceof Error ? error.message : String(error));
  }
});
contextBridge.exposeInMainWorld('worklogsDesktop', {
  onBeforeClose(callback) {
    beforeClose = callback;
    return () => { beforeClose = async () => {}; };
  },
  checkUpdatesNow() {
    return ipcRenderer.invoke('worklogs:check-updates-now');
  },
});
