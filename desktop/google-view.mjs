import electron from 'electron';
import path from 'node:path';

// Electron n'expose ses exports nommés que dans son propre runtime : l'import par
// défaut garde ce module chargeable par `node --test`, donc ses contrôles testables.
const { app, dialog, ipcMain, session, WebContentsView } = electron;

const channel = 'worklogs:google-view';
const hosts = new Set(['docs.google.com', 'accounts.google.com', 'drive.google.com', 'myaccount.google.com']);

export function googleViewUrl(documentId, tabId = '') {
  if (typeof documentId !== 'string' || !/^[\w-]{1,200}$/.test(documentId)
    || typeof tabId !== 'string' || !/^[\w.-]{0,200}$/.test(tabId)) throw new Error('Document Google invalide.');
  return `https://docs.google.com/document/d/${documentId}/edit${tabId ? `?tab=${encodeURIComponent(tabId)}` : ''}`;
}

export function allowedGoogleNavigation(value) {
  try {
    const url = new URL(value);
    // L’autorisation OAuth des API conserve son navigateur système (politique Google).
    return url.protocol === 'https:' && !url.port && !url.username && !url.password
      && hosts.has(url.hostname) && !/^\/o\/oauth2(?:\/|$)/.test(url.pathname);
  } catch { return false; }
}

export function viewBounds(bounds, size) {
  if (!bounds || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key]))) throw new Error('Zone du document invalide.');
  const x = Math.max(0, Math.min(size[0], Math.round(bounds.x)));
  const y = Math.max(0, Math.min(size[1], Math.round(bounds.y)));
  return { x, y, width: Math.max(0, Math.min(size[0] - x, Math.round(bounds.width))), height: Math.max(0, Math.min(size[1] - y, Math.round(bounds.height))) };
}

/** Page Google de premier niveau, dans le canevas WorkLogs ; aucun preload distant. */
export function installGoogleView(window) {
  const googleSession = session.fromPartition('persist:google-docs');
  googleSession.setPermissionCheckHandler(() => false);
  googleSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (!allowedGoogleNavigation(contents.getURL()) || !allowedGoogleNavigation(details.requestingUrl)
      || !['clipboard-read', 'clipboard-sanitized-write', 'media'].includes(permission)) return callback(false);
    void dialog.showMessageBox(window, {
      type: 'question', title: 'Google Docs dans WorkLogs',
      message: permission === 'media' ? 'Autoriser Google Docs à utiliser le microphone ou la caméra ?' : 'Autoriser Google Docs à accéder au presse-papiers ?',
      buttons: ['Refuser', 'Autoriser'], defaultId: 0, cancelId: 0,
    }).then(result => callback(result.response === 1), () => callback(false));
  });
  googleSession.on('will-download', (_event, item) => {
    item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())) });
  });
  const views = new Map();
  let active;
  let closing = false;
  const trusted = event => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
    && event.senderFrame.url.startsWith('worklogs://app/');
  const emit = record => {
    if (active?.record === record && !window.isDestroyed()) window.webContents.send(channel, { ...record.state, token: active.token });
  };
  function hide() {
    if (active) active.record.view.setVisible(false);
    active = undefined;
  }
  function create(documentId) {
    const view = new WebContentsView({ webPreferences: {
      session: googleSession, nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, backgroundThrottling: false,
    } });
    window.contentView.addChildView(view);
    view.setVisible(false);
    const record = { view, documentId, tabId: undefined, state: { phase: 'loading', message: 'Chargement de Google Docs…' } };
    views.set(documentId, record);
    const contents = view.webContents;
    const state = (phase, message) => { record.state = { phase, message }; emit(record); };
    const sameDocument = url => {
      if (!allowedGoogleNavigation(url)) return false;
      const match = new URL(url).pathname.match(/^\/document\/(?:u\/\d+\/)?d\/([^/]+)/);
      return !match || match[1] === documentId;
    };
    const navigate = (event, url) => {
      if (sameDocument(url)) return;
      event.preventDefault();
      state('error', 'Cette destination ne peut pas être ouverte dans l’éditeur Google intégré.');
    };
    contents.on('will-navigate', navigate);
    contents.on('will-redirect', (event, url, _inPlace, isMainFrame) => { if (isMainFrame) navigate(event, url); });
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (sameDocument(url)) void contents.loadURL(url).catch(() => {});
      else state('error', 'Cette fenêtre ne peut pas être ouverte dans l’éditeur Google intégré.');
      return { action: 'deny' };
    });
    contents.on('did-start-loading', () => state('loading', 'Chargement de Google Docs…'));
    contents.on('did-stop-loading', () => {
      if (record.state.phase === 'error') return;
      // Un chargement abandonné — changer d'onglet pendant le précédent — laisse une
      // adresse vide : rester en « chargement » plutôt que lire une URL inexistante.
      const current = contents.getURL();
      if (!allowedGoogleNavigation(current)) return;
      const signingIn = new URL(current).hostname === 'accounts.google.com';
      state(signingIn ? 'signin' : 'ready', signingIn ? 'Connecte ton compte Google dans la zone ci-dessous.' : 'L’état d’enregistrement et tes droits de modification sont affichés par Google dans le document.');
    });
    contents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
      if (mainFrame && code !== -3) state('error', 'Google Docs est inaccessible. Vérifie la connexion puis réessaie.');
    });
    contents.on('render-process-gone', () => state('error', 'L’éditeur Google s’est arrêté. Recharge-le pour reprendre.'));
    contents.on('will-prevent-unload', event => {
      // Vue d'arrière-plan qu'on libère : Google signale un enregistrement en cours,
      // donc elle reste — sans rien demander pour un document qu'on n'affiche plus.
      if (record.evicting && !closing) return record.cancelClose?.();
      const choice = dialog.showMessageBoxSync(window, {
        type: 'warning', title: 'Google Docs dans WorkLogs',
        message: 'Google Docs signale des modifications en cours. Quitter ce document ?',
        detail: 'Attends l’enregistrement Google pour conserver les dernières modifications.',
        buttons: ['Continuer à travailler', 'Quitter quand même'], defaultId: 0, cancelId: 0,
      });
      if (choice === 1) event.preventDefault();
      else record.cancelClose?.();
      if (!window.isDestroyed()) { window.focus(); contents.focus(); }
    });
    contents.on('destroyed', () => {
      if (views.get(documentId) === record) views.delete(documentId);
      if (active?.record === record) active = undefined;
      if (!window.isDestroyed()) window.contentView.removeChildView(view);
    });
    return record;
  }
  /** Un document Google affiché est une application complète qui continue de tourner :
   * n'en garder qu'une, et laisser partir les autres dès qu'elles n'enregistrent plus. */
  function evict(keep) {
    for (const record of [...views.values()]) {
      if (record === keep || record.closePromise) continue;
      record.evicting = true;
      void closeRecord(record).finally(() => { record.evicting = false; });
    }
  }
  function closeRecord(record) {
    if (record.closePromise) return record.closePromise;
    record.closePromise = new Promise(resolve => {
      const contents = record.view.webContents;
      const done = result => { contents.removeListener('destroyed', destroyed); record.cancelClose = undefined; resolve(result); };
      const destroyed = () => done(true);
      record.cancelClose = () => done(false);
      contents.once('destroyed', destroyed);
      contents.close({ waitForBeforeUnload: true });
    }).finally(() => { record.closePromise = undefined; });
    return record.closePromise;
  }
  ipcMain.handle(`${channel}:open`, (event, request) => {
    if (!trusted(event) || closing) throw new Error('Éditeur indisponible.');
    const url = googleViewUrl(request?.documentId, request?.tabId ?? '');
    const bounds = viewBounds(request.bounds, window.getContentSize());
    if (typeof request.token !== 'string' || request.token.length > 100) throw new Error('Vue invalide.');
    hide();
    const previous = views.get(request.documentId);
    const record = previous && !previous.closePromise ? previous : create(request.documentId);
    active = { record, token: request.token };
    evict(record);
    record.view.setBounds(bounds);
    record.view.setVisible(true);
    if (record.tabId !== (request.tabId ?? '')) {
      const previousTab = record.tabId;
      record.tabId = request.tabId ?? '';
      void record.view.webContents.loadURL(url).catch(() => { record.tabId = previousTab; });
    }
    emit(record);
    return record.state;
  });
  ipcMain.on(`${channel}:bounds`, (event, request) => {
    if (!trusted(event) || active?.token !== request?.token) return;
    try {
      active.record.view.setBounds(viewBounds(request.bounds, window.getContentSize()));
      active.record.view.setVisible(Boolean(request.visible));
    } catch { /* Les dimensions périmées ne doivent pas fermer le document. */ }
  });
  ipcMain.on(`${channel}:hide`, (event, token) => { if (trusted(event) && active?.token === token) hide(); });
  ipcMain.handle(`${channel}:close`, async (event, documentId) => {
    if (!trusted(event) || closing) return false;
    const record = views.get(documentId);
    return record ? closeRecord(record) : true;
  });
  ipcMain.handle(`${channel}:reload`, (event, token) => {
    if (trusted(event) && active?.token === token) active.record.view.webContents.reload();
  });
  function print() {
    if (!active) return false;
    const contents = active.record.view.webContents;
    contents.focus();
    // Google prépare lui-même le document entier avant l’impression.
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'P', modifiers: ['control'] });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'P', modifiers: ['control'] });
    return true;
  }
  ipcMain.handle(`${channel}:print`, event => { if (trusted(event)) print(); });
  return {
    focus() { if (active && active.record.view.getVisible()) { active.record.view.webContents.focus(); return true; } return false; },
    print,
    async close() {
      closing = true;
      try { for (const record of [...views.values()]) if (!await closeRecord(record)) return false; return true; }
      finally { closing = false; }
    },
  };
}
