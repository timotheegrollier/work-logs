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
  googleDocs: {
    open: (request) => ipcRenderer.invoke('worklogs:google-view:open', request),
    bounds: (request) => ipcRenderer.send('worklogs:google-view:bounds', request),
    hide: (token) => ipcRenderer.send('worklogs:google-view:hide', token),
    close: (documentId) => ipcRenderer.invoke('worklogs:google-view:close', documentId),
    reload: (token) => ipcRenderer.invoke('worklogs:google-view:reload', token),
    print: () => ipcRenderer.invoke('worklogs:google-view:print'),
    onState(callback) {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('worklogs:google-view', listener);
      return () => ipcRenderer.removeListener('worklogs:google-view', listener);
    },
  },
  onBeforeClose(callback) {
    beforeClose = callback;
    return () => { beforeClose = async () => {}; };
  },
  // Renvoie '' si l'application du système a pris le fichier, sinon le message d'erreur.
  openAttachment: (stored, filename) => ipcRenderer.invoke('worklogs:open-attachment', { stored, filename }),
  shared: {
    // Renvoient `{ status }`, `{ canceled: true }` ou `{ error }`.
    chooseRoot: () => ipcRenderer.invoke('worklogs:shared-choose-root'),
    forgetRoot: () => ipcRenderer.invoke('worklogs:shared-forget-root'),
    // Monte le partage par son adresse (comme Nemo) et le choisit.
    connect: (address, account) => ipcRenderer.invoke('worklogs:shared-connect', { address, account }),
    // Renvoie '' si l'application du système a pris le fichier, sinon le message d'erreur.
    openWith: (path) => ipcRenderer.invoke('worklogs:shared-open-with', { path }),
  },
  checkUpdatesNow() {
    return ipcRenderer.invoke('worklogs:check-updates-now');
  },
  onUpdateProgress(callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('worklogs:update-progress', listener);
    return () => ipcRenderer.removeListener('worklogs:update-progress', listener);
  },
});
