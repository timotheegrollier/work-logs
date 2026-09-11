import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDesktopServer } from './server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'worklogs://app';
app.setName('worklogs');
const profileDir = process.env.WORKLOGS_PROFILE_DIR || path.join(app.getPath('appData'), 'worklogs');
fs.mkdirSync(profileDir, { recursive: true });
app.setPath('userData', profileDir);
const dataDir = process.env.WORKLOGS_DATA_DIR || path.join(
  process.env.XDG_DATA_HOME || path.join(app.getPath('home'), '.local', 'share'), 'worklogs',
);

// Une origine stable conserve notamment le thème entre deux lancements.
protocol.registerSchemesAsPrivileged([{
  scheme: 'worklogs', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

let window;
let backend;
let stopping = false;
let closePending = false;
let closeTimer;

function external(url) {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
}

function finishClose(error) {
  clearTimeout(closeTimer);
  closePending = false;
  if (error && window && !window.isDestroyed()) {
    dialog.showMessageBoxSync(window, {
      type: 'error', title: 'WorkLogs', buttons: ['Revenir à l’entrée'],
      message: 'L’entrée n’a pas pu être enregistrée. La fenêtre reste ouverte.',
      detail: String(error).slice(0, 1000),
    });
    return;
  }
  window?.destroy();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', (event) => {
    if (!backend || stopping) return;
    event.preventDefault();
    stopping = true;
    backend.close().then(() => app.quit()).catch((error) => {
      console.error(error);
      app.exit(1);
    });
  });

  // Ne pas attendre ready au niveau supérieur d’un module ESM : Electron
  // attend lui-même la fin du module avant d’émettre cet événement.
  void app.whenReady().then(async () => {
    try {
      backend = await startDesktopServer({ dataDir, staticDir: path.join(root, 'web', 'dist') });
      const browserSession = session.defaultSession;
      browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      browserSession.setPermissionCheckHandler(() => false);
      browserSession.protocol.handle('worklogs', async (request) => {
        const url = new URL(request.url);
        if (url.host !== 'app') return new Response('Adresse inconnue', { status: 404 });
        const headers = new Headers();
        if (request.headers.has('content-type')) headers.set('content-type', request.headers.get('content-type'));
        headers.set('x-worklogs-token', backend.token);
        return fetch(backend.origin + url.pathname + url.search, {
          method: request.method, headers,
          ...(request.method !== 'GET' && request.method !== 'HEAD' ? { body: await request.arrayBuffer() } : {}),
        });
      });
      Menu.setApplicationMenu(null);
      window = new BrowserWindow({
        title: 'WorkLogs', width: 1440, height: 950, minWidth: 900, minHeight: 620,
        show: false, backgroundColor: '#0e1118', icon: path.join(root, 'desktop', 'icon.png'),
        webPreferences: {
          preload: path.join(root, 'desktop', 'preload.cjs'),
          nodeIntegration: false, contextIsolation: true, sandbox: true,
        },
      });
      window.once('ready-to-show', () => window.show());
      window.webContents.setWindowOpenHandler(({ url }) => {
        external(url);
        return { action: 'deny' };
      });
      window.webContents.on('will-navigate', (event, url) => {
        if (new URL(url).origin !== new URL(origin).origin || !url.startsWith(origin + '/')) {
          event.preventDefault();
          external(url);
        }
      });
      window.webContents.on('will-attach-webview', (event) => event.preventDefault());
      window.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.control && input.key.toLowerCase() === 'p') {
          event.preventDefault();
          window.webContents.print({ printBackground: true });
        }
      });
      window.on('close', (event) => {
        event.preventDefault();
        if (closePending) return;
        closePending = true;
        window.webContents.send('worklogs:prepare-close');
        closeTimer = setTimeout(() => {
          closePending = false;
          const choice = dialog.showMessageBoxSync(window, {
            type: 'warning', title: 'WorkLogs', buttons: ['Attendre', 'Fermer sans enregistrer'],
            defaultId: 0, cancelId: 0,
            message: 'L’enregistrement ne répond pas. Attendre ou fermer la fenêtre ?',
          });
          if (choice === 1) window.destroy();
        }, 15_000);
      });
      ipcMain.on('worklogs:close-ready', (event, error) => {
        if (event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && closePending)
          finishClose(error);
      });
      await window.loadURL(origin + '/');
    } catch (error) {
      console.error(error);
      dialog.showErrorBox('WorkLogs — démarrage impossible', String(error.message));
      await backend?.close();
      app.exit(1);
    }
  });
}
