import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, protocol, session, shell } from 'electron';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDesktopServer } from './server.mjs';
import { checkForUpdate, hasPackageKit, installKind, installedMatches, isNewer, pkconInstallArgs, RPM_REPO_URL, startPoll, SYSTEM_PACKAGE } from './update.mjs';
// electron-updater est CommonJS : contournement ESM documenté
// (electron-builder#7976) — destructurer après import par défaut.
import electronUpdater from 'electron-updater';

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
// Version refusée via « Plus tard » : on ne la repropose qu'à la suivante.
// Mise à jour système en cours : le polling ne doit pas doubler la proposition.
let dismissedVersion = null;
let systemUpdating = false;
let pollStop = null;

function external(url) {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
}

/**
 * Electron ne décode pas filename/filename* (RFC 6266) pour les téléchargements
 * servis par un protocole personnalisé : le nom suggéré retombe sur « download ».
 * L’en-tête est pourtant correct (cf. attachmentHeader côté API) ; on le relit
 * nous-mêmes pour corriger le nom proposé dans le dialogue d’enregistrement.
 */
function suggestedFilename(item) {
  const header = item.getContentDisposition();
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header || '');
  if (star) {
    try { return decodeURIComponent(star[1]); } catch { /* nom mal encodé : on garde le repli */ }
  }
  const plain = /filename\s*=\s*"([^"]*)"/i.exec(header || '');
  return plain ? plain[1] : item.getFilename();
}

/**
 * Vérifie les mises à jour à l'ouverture, puis en tâche de fond toutes les
 * POLL_INTERVAL_MS : une nouveauté est proposée dès qu'elle est vue, pas
 * seulement au lancement. Silencieux si à jour, hors ligne, ou version déjà
 * refusée — le démarrage et l'usage n'attendent jamais.
 */
async function notifyUpdateIfAvailable() {
  // Coupe-circuit pour les tests e2e : pas de réseau pendant la recette.
  // Hors paquet (dev) : rien à mettre à jour.
  if (process.env.WORKLOGS_SKIP_UPDATE_CHECK === '1' || !app.isPackaged) return;
  if (installKind() === 'appimage') {
    await updateAppImage();
    return;
  }
  await offerSystemOrManualUpdate();
}

/**
 * AppImage : vraie mise à jour sur place via electron-updater (téléchargement
 * différentiel grâce au blockmap publié avec la release). Consentement explicite
 * avant le téléchargement, redémarrage proposé une fois prête. En cas d'échec,
 * repli sur le dialogue de téléchargement manuel.
 */
async function updateAppImage() {
  const { autoUpdater } = electronUpdater;
  try {
    autoUpdater.autoDownload = false;
    const found = await autoUpdater.checkForUpdates();
    const next = found?.updateInfo?.version;
    if (!next || !isNewer(next, app.getVersion()) || dismissedVersion === next) return;
    const download = dialog.showMessageBoxSync(window, {
      type: 'info', title: 'WorkLogs', buttons: ['Mettre à jour', 'Plus tard'],
      defaultId: 0, cancelId: 1,
      message: `WorkLogs ${next} est disponible (tu as la ${app.getVersion()}).`,
      detail: 'Seuls les blocs modifiés sont téléchargés, puis l’application redémarre sur la nouvelle version.',
    });
    if (download !== 0) {
      dismissedVersion = next;
      return;
    }
    await autoUpdater.downloadUpdate();
    const restart = dialog.showMessageBoxSync(window, {
      type: 'info', title: 'WorkLogs', buttons: ['Redémarrer', 'Plus tard'],
      defaultId: 0, cancelId: 1,
      message: `WorkLogs ${next} est prête.`,
      detail: 'Redémarre pour basculer sur la nouvelle version.',
    });
    if (restart === 0) autoUpdater.quitAndInstall(false, true);
    else dismissedVersion = next;
  } catch {
    await offerSystemOrManualUpdate();
  }
}

/**
 * Paquet système (deb/rpm) : si PackageKit est là, un clic suffit — polkit
 * demande le mot de passe, le gestionnaire installe, on propose de relancer.
 * Sinon, consigne dnf/apt + page de release (comportement historique).
 */
async function offerSystemOrManualUpdate() {
  const found = await checkForUpdate({ currentVersion: app.getVersion() });
  if (!found || !window || window.isDestroyed()) return;
  if (dismissedVersion === found.version) return;
  if (installKind() === 'system' && hasPackageKit() && !systemUpdating) {
    await offerSystemUpdate(found.version);
    return;
  }
  await fallbackNotify(found);
}

async function offerSystemUpdate(next) {
  const choice = dialog.showMessageBoxSync(window, {
    type: 'info', title: 'WorkLogs', buttons: ['Mettre à jour maintenant', 'Plus tard'],
    defaultId: 0, cancelId: 1,
    message: `WorkLogs ${next} est disponible (tu as la ${app.getVersion()}).`,
    detail: 'Installation par le gestionnaire de paquets : ton mot de passe sera demandé une fois, puis tu redémarres l’application.',
  });
  if (choice !== 0) {
    dismissedVersion = next;
    return;
  }
  systemUpdating = true;
  new Notification({ title: 'WorkLogs', body: `Installation de la ${next}… ne ferme pas l’application.` }).show();
  const error = await runPackageKitUpdate();
  // Le cache PackageKit peut mentir : on ne propose le redémarrage que si la
  // version sur disque est vraiment celle attendue. Sinon, erreur explicite
  // au lieu d'un faux succès suivi d'un « downgrade » apparent.
  const installed = installedSystemVersion();
  systemUpdating = false;
  if (error || !installedMatches(installed ?? '', next)) {
    dialog.showMessageBoxSync(window, {
      type: 'error', title: 'WorkLogs', buttons: ['Compris'],
      message: error ?? `La version installée (${installed ?? 'illisible'}) n’est pas la ${next}.`,
      detail: 'Le gestionnaire a servi une version périmée. Relance la vérification ou mets à jour à la main : sudo dnf update worklogs.',
    });
    return;
  }
  const restart = dialog.showMessageBoxSync(window, {
    type: 'info', title: 'WorkLogs', buttons: ['Redémarrer', 'Plus tard'],
    defaultId: 0, cancelId: 1,
    message: `WorkLogs ${next} est installée.`,
    detail: 'Redémarre pour basculer sur la nouvelle version.',
  });
  if (restart === 0) {
    app.relaunch();
    app.quit();
  }
}

/** Version du paquet système installé, ou null si illisible. */
function installedSystemVersion() {
  try {
    return execFileSync('rpm', ['-q', '--qf', '%{VERSION}', SYSTEM_PACKAGE], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

/** `pkcon install worklogs`, sans interaction (polkit s'en charge, `--cache-age 1`
 * force des métadonnées fraîches). Résout vers null si OK, sinon un message court. */
function runPackageKitUpdate() {
  return runPkcon(pkconInstallArgs());
}

function runPkcon(args) {
  return new Promise((resolve) => {
    const child = spawn('pkcon', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', (error) => resolve(String(error.message || error).slice(0, 300)));
    child.on('close', (code) => resolve(code === 0 ? null : output.trim().split('\n').slice(-3).join(' ').slice(0, 300) || `code ${code}`));
  });
}

async function fallbackNotify(found) {
  const kind = installKind();
  // Paquet système (deb/rpm) : la mise à jour passe par le gestionnaire de
  // paquets, pas par un téléchargement manuel — root oblige.
  const hasDnf = fs.existsSync('/usr/bin/dnf');
  const detail = kind === 'system'
    ? (hasDnf
      ? `Dépôt configuré : lance « sudo dnf update worklogs ». Sinon, ajoute-le une fois (voir ${RPM_REPO_URL}/worklogs.repo), ou télécharge le paquet.`
      : 'Mets à jour via ton gestionnaire de paquets (dnf/apt), ou télécharge le paquet.')
    : 'Le téléchargement s’ouvre dans ton navigateur : installe le paquet, puis relance l’application.';
  const choice = dialog.showMessageBoxSync(window, {
    type: 'info', title: 'WorkLogs', buttons: ['Télécharger la mise à jour', 'Plus tard'],
    defaultId: 0, cancelId: 1,
    message: `WorkLogs ${found.version} est disponible (tu as la ${app.getVersion()}).`,
    detail,
  });
  if (choice === 0) external(found.url);
  else dismissedVersion = found.version;
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
      browserSession.on('will-download', (_event, item) => {
        item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), suggestedFilename(item)) });
      });
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
        show: false, fullscreen: true, backgroundColor: '#0e1118', icon: path.join(root, 'desktop', 'icon.png'),
        webPreferences: {
          preload: path.join(root, 'desktop', 'preload.cjs'),
          nodeIntegration: false, contextIsolation: true, sandbox: true,
        },
      });
      window.once('ready-to-show', () => {
        window.show();
        void notifyUpdateIfAvailable();
        // Puis en tâche de fond : une release publiée pendant l'usage est
        // proposée sans attendre la prochaine ouverture.
        pollStop ??= startPoll({ tick: () => notifyUpdateIfAvailable() });
      });
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
