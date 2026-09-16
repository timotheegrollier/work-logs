import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { GoogleDocsBridge } from '../../web/src/google-desktop';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type DesktopWindow = Window & { worklogsDesktop: { googleDocs: GoogleDocsBridge } };

let directory: string;
let application: ElectronApplication | undefined;
let page: Page;

/**
 * `page.waitForEvent('download')` n'observe jamais les téléchargements servis par
 * le protocole personnalisé `worklogs://` (limite de l'intégration Electron de
 * Playwright, pas une panne applicative : `will-download` se déclenche bien côté
 * Electron, cf. docs/06-DESKTOP-CICD.md). On observe donc directement la session.
 */
function downloadNext(target: string): Promise<void> {
  return application!.evaluate(({ session }, savePath) => new Promise<void>((resolve, reject) => {
    session.defaultSession.once('will-download', (_event, item) => {
      item.setSavePath(savePath);
      item.once('done', (_e, state) => {
        if (state === 'completed') resolve();
        else reject(new Error('téléchargement en échec : ' + state));
      });
    });
  }), target);
}

async function launch(expectedTitle = 'Comment ça marche') {
  const env = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] =>
    item[1] !== undefined && item[0] !== 'ELECTRON_RUN_AS_NODE'));
  application = await _electron.launch({
    ...(process.env.WORKLOGS_EXECUTABLE ? { executablePath: process.env.WORKLOGS_EXECUTABLE, args: [] }
      : { args: [path.resolve('desktop/main.mjs')] }),
    // Uniquement les environnements CI/conteneurs sans sandbox Chromium utilisable.
    chromiumSandbox: process.env.WORKLOGS_TEST_NO_SANDBOX !== '1',
    env: { ...env, WORKLOGS_DATA_DIR: path.join(directory, 'data'), WORKLOGS_PROFILE_DIR: path.join(directory, 'profile'), WORKLOGS_SKIP_UPDATE_CHECK: '1' },
  });
  page = await application.firstWindow();
  await expect(page.getByLabel('Titre de l’entrée')).toHaveValue(expectedTitle);
}

test.beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-desktop-e2e-'));
  await launch();
});
test.afterEach(async () => {
  // Un beforeunload de la fixture ne doit pas bloquer le nettoyage après un échec.
  await application?.evaluate(({ webContents }) => {
    for (const contents of webContents.getAllWebContents()) if (contents.getURL().startsWith('https://')) contents.close({ waitForBeforeUnload: false });
  }).catch(() => {});
  await application?.close();
  application = undefined;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('démarre en fenêtre maximisée', async () => {
  // Sous Xvfb sans gestionnaire de fenêtres (CI), personne n'applique
  // maximize() : on ne peut l'affirmer que là où un WM tourne.
  test.skip(!process.env.XDG_CURRENT_DESKTOP && !process.env.DESKTOP_SESSION && !process.env.GDMSESSION,
    'pas de gestionnaire de fenêtres');
  await expect(page.getByRole('region', { name: 'Journal' })).toBeVisible();
  await expect.poll(() => application!.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].isMaximized()
  )).toBe(true);
});

test('fenêtre autonome, renderer isolé, liens externes dans le navigateur', async () => {
  expect(page.url()).toBe('worklogs://app/');
  await expect(page.getByRole('region', { name: 'Journal' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Tâches' })).toBeVisible();
  const preferences = await application!.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents as unknown as {
      getLastWebPreferences: () => { nodeIntegration: boolean; contextIsolation: boolean; sandbox: boolean };
    };
    const prefs = contents.getLastWebPreferences();
    return { nodeIntegration: prefs.nodeIntegration, contextIsolation: prefs.contextIsolation, sandbox: prefs.sandbox };
  });
  expect(preferences).toEqual({ nodeIntegration: false, contextIsolation: true, sandbox: true });
  expect(await page.evaluate(() => typeof (window as unknown as { require: unknown }).require)).toBe('undefined');
  await application!.evaluate(({ shell }) => {
    shell.openExternal = async (url) => { (globalThis as unknown as { opened: string }).opened = url; };
  });
  await page.evaluate(() => window.open('https://example.com/'));
  await expect.poll(() => application!.evaluate(() => (globalThis as unknown as { opened: string }).opened)).toBe('https://example.com/');
  await page.evaluate(() => { window.open('file:///etc/passwd'); });
  expect(application!.windows()).toHaveLength(1);
});

test('fermer immédiatement sauve le texte et le thème survit au redémarrage', async () => {
  await page.getByLabel('Changer de thème').click();
  await page.getByRole('button', { name: 'Écrire', exact: true }).click();
  await page.getByLabel('Contenu en Markdown').fill('## Dernière frappe avant fermeture');
  const closed = application!.waitForEvent('close');
  await application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  application = undefined;
  await launch();
  await expect(page.getByRole('heading', { name: 'Dernière frappe avant fermeture' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('document riche : fermeture, reprise et panneau Drive dans Electron', async () => {
  await page.getByRole('button', { name: 'Nouveau document', exact: false }).click();
  const content = page.getByRole('textbox', { name: 'Contenu du document' });
  await content.fill('Texte riche conservé');
  await content.press('Control+a');
  await page.getByRole('button', { name: 'Gras', exact: true }).click();
  const closed = application!.waitForEvent('close');
  await application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await closed;
  application = undefined;
  await launch('Sans titre');
  await expect(page.getByRole('textbox', { name: 'Contenu du document' }).locator('strong')).toHaveText('Texte riche conservé');
  const reopened = page.getByRole('textbox', { name: 'Contenu du document' });
  await reopened.click();
  await reopened.press('Control+h');
  const search = page.getByRole('search', { name: 'Rechercher dans le document' });
  await search.getByLabel('Rechercher', { exact: true }).fill('conservé');
  await search.getByLabel('Remplacer par').fill('retrouvé');
  await search.getByRole('button', { name: 'Tout remplacer' }).click();
  await search.getByRole('button', { name: 'Fermer la recherche' }).click();
  await expect(reopened.locator('strong')).toHaveText('Texte riche retrouvé');
  await reopened.press('Control+s');
  await expect(page.getByText('Enregistré', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Google Drive', exact: false }).click();
  await expect(page.getByLabel('Configuration Google JSON')).toBeAttached();
  await expect(page.getByRole('link', { name: 'Ouvrir Google Cloud' })).toBeVisible();
});

test('fichiers joints et export JSON fonctionnent dans l’application empaquetée', async () => {
  await page.getByLabel('Joindre un fichier').setInputFiles({ name: 'pièce.txt', mimeType: 'text/plain', buffer: Buffer.from('contenu desktop') });
  await expect(page.getByRole('link', { name: 'pièce.txt' })).toBeVisible();

  const fileTarget = path.join(directory, 'pièce.txt');
  const fileDownload = downloadNext(fileTarget);
  await page.getByRole('link', { name: 'pièce.txt' }).click();
  await fileDownload;
  expect(fs.readFileSync(fileTarget, 'utf8')).toBe('contenu desktop');

  const exportTarget = path.join(directory, 'export.json');
  const exportDownload = downloadNext(exportTarget);
  await page.getByRole('link', { name: 'Exporter' }).click();
  await exportDownload;
  expect(JSON.parse(fs.readFileSync(exportTarget, 'utf8')).entries[0].title).toBe('Comment ça marche');
});

test('impression PDF et refus de fermeture si l’enregistrement échoue', async () => {
  const bytes = await application!.evaluate(async ({ BrowserWindow }) => {
    const pdf = await BrowserWindow.getAllWindows()[0].webContents.printToPDF({ printBackground: true });
    return pdf.length;
  });
  expect(bytes).toBeGreaterThan(1000);
  await application!.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = (...args: unknown[]) => {
      (globalThis as unknown as { closeError: string }).closeError = JSON.stringify(args[1]);
      return 0;
    };
  });
  await page.getByLabel('Titre de l’entrée').fill('');
  await application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect.poll(() => application!.evaluate(() => (globalThis as unknown as { closeError: string }).closeError)).toContain('La fenêtre reste ouverte');
  await expect(page.getByLabel('Titre de l’entrée')).toBeVisible();
  await page.getByLabel('Titre de l’entrée').fill('Comment ça marche');
  await page.keyboard.press('Control+s');
  await expect(page.getByText('Enregistré', { exact: true })).toBeVisible();
});

test('Google intégré : outils dans le canevas, isolation, dimensions et copie locale', async () => {
  // Serveur Google simulé dans sa session isolée ; aucune connexion personnelle.
  await application!.evaluate(({ session }) => {
    session.fromPartition('persist:google-docs').protocol.handle('https', () => new Response(`<!doctype html><html><head><title>Google simulé</title></head><body>
      <label>Statut du projet <select><option>À faire</option><option>En cours</option></select></label>
      <div contenteditable="true" role="textbox" aria-label="Texte Google">Document natif</div>
      <a href="file:///etc/passwd">Interdit</a>
      <button onclick="window.open('https://accounts.google.com/v3/signin/identifier')">Connexion Google</button>
      <script>document.querySelector('select').onchange=()=>document.body.dataset.saved='yes';
      document.onkeydown=e=>{if(e.ctrlKey && e.key.toLowerCase()==='p'){e.preventDefault();document.body.dataset.printed='yes';}};</script>
      </body></html>`, { headers: { 'content-type': 'text/html' } }));
  });
  const entry = await page.evaluate(async () => (await fetch('/api/entries', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Google intégré', content_json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Copie' }] }] } }),
  })).json());
  const linked = { ...entry, google_sync: { document_id: 'native-doc', tab_id: 't.2', dirty: false, document_title: 'Google intégré' } };
  await page.route(`**/api/entries/${entry.id}`, route => route.fulfill({ json: linked }));
  await page.route('**/api/google/documents/open', route => route.fulfill({ json: { ...linked, content_json: {
    type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Copie actualisée' }] }],
  } } }));
  await page.reload();
  await page.getByRole('button', { name: /Google intégré/ }).click();
  await expect(page.getByLabel('Éditeur Google Docs intégré')).toBeVisible();
  await expect.poll(() => application!.context().pages().some(p => p.url().includes('/document/d/native-doc/'))).toBe(true);
  const googlePage = application!.context().pages().find(p => p.url().includes('/document/d/native-doc/'))!;
  expect(googlePage.url()).toContain('?tab=t.2');
  await googlePage.getByLabel('Statut du projet').selectOption('En cours');
  await expect(googlePage.locator('body')).toHaveAttribute('data-saved', 'yes');
  await googlePage.getByRole('textbox').fill('Édition native dans WorkLogs');
  await page.getByRole('button', { name: /Comment ça marche/ }).click();
  expect(googlePage.isClosed()).toBe(false);
  await page.getByRole('button', { name: /Google intégré/ }).click();
  await expect(googlePage.getByRole('textbox')).toHaveText('Édition native dans WorkLogs');
  await page.getByText('Détails du document', { exact: true }).click();
  await page.getByRole('button', { name: 'Imprimer', exact: true }).click();
  await expect(googlePage.locator('body')).toHaveAttribute('data-printed', 'yes');
  await page.getByText('Détails du document', { exact: true }).click();
  expect(await googlePage.evaluate(() => [typeof (window as unknown as DesktopWindow).worklogsDesktop, typeof (window as unknown as { require: unknown }).require])).toEqual(['undefined', 'undefined']);
  const isolation = await application!.evaluate(({ BrowserWindow, webContents, session }) => {
    const remote = webContents.getAllWebContents().find(w => w.getURL().includes('/document/d/native-doc/'))!;
    const prefs = (remote as unknown as { getLastWebPreferences: () => Record<string, unknown> }).getLastWebPreferences();
    return { windows: BrowserWindow.getAllWindows().length, sameSession: remote.session === session.defaultSession,
      sandbox: prefs.sandbox, node: prefs.nodeIntegration, isolation: prefs.contextIsolation, security: prefs.webSecurity, preload: prefs.preload };
  });
  expect(isolation).toEqual({ windows: 1, sameSession: false, sandbox: true, node: false, isolation: true, security: true, preload: undefined });
  const rect = await page.getByLabel('Zone du document Google').boundingBox();
  expect(rect!.width).toBeGreaterThan(650);
  await expect.poll(() => application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.at(-1)!.getBounds().width)).toBe(Math.round(rect!.width));
  await page.getByRole('button', { name: 'Afficher les tâches' }).click();
  const smaller = await page.getByLabel('Zone du document Google').boundingBox();
  expect(smaller!.width).toBeLessThan(rect!.width);
  // Les poignées déplacent aussi la vraie WebContentsView, sans sortir de l'éditeur.
  for (const [side, delta] of [['gauche', 60], ['droite', -50]] as const) {
    const handle = (await page.getByRole('separator', { name: `Redimensionner la colonne de ${side}` }).boundingBox())!;
    const before = (await page.getByLabel('Zone du document Google').boundingBox())!;
    const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + delta, y, { steps: 6 });
    await page.mouse.up();
    const resized = (await page.getByLabel('Zone du document Google').boundingBox())!;
    expect(resized.width).toBeCloseTo(before.width - Math.abs(delta), 0);
    await expect.poll(() => application!.evaluate(({ BrowserWindow }) => {
      const bounds = BrowserWindow.getAllWindows()[0].contentView.children.at(-1)!.getBounds();
      return { x: bounds.x, width: bounds.width };
    })).toEqual({ x: Math.round(resized.x), width: Math.round(resized.width) });
  }
  // Une navigation interdite ne reçoit ni page locale, ni privilège WorkLogs.
  await googlePage.getByRole('link', { name: 'Interdit' }).click();
  expect(googlePage.url()).toContain('docs.google.com');
  await page.getByRole('button', { name: 'Copie locale', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Contenu du document' })).toHaveText('Copie actualisée');
  await expect.poll(() => googlePage.isClosed()).toBe(true);
});

test('Google intégré : validation des adresses et fermeture respectant les modifications Google', async () => {
  await application!.evaluate(({ session }) => session.fromPartition('persist:google-docs').protocol.handle('https', () => new Response(
    '<button onclick="window.onbeforeunload=e=>{e.preventDefault();e.returnValue=true;}">Modifier</button>', { headers: { 'content-type': 'text/html' } },
  )));
  const rejected = await page.evaluate(async () => {
    try { await (window as unknown as DesktopWindow).worklogsDesktop!.googleDocs!.open({ documentId: '../../secret', tabId: '', token: 'bad', bounds: { x: 300, y: 300, width: 600, height: 300 } }); return false; }
    catch { return true; }
  });
  expect(rejected).toBe(true);
  await page.evaluate(() => (window as unknown as DesktopWindow).worklogsDesktop!.googleDocs!.open({ documentId: 'close-doc', tabId: '', token: 'close', bounds: { x: 300, y: 300, width: 600, height: 300 } }));
  await expect.poll(() => application!.context().pages().some(p => p.url().includes('/document/d/close-doc/'))).toBe(true);
  const googlePage = application!.context().pages().find(p => p.url().includes('/document/d/close-doc/'))!;
  // Electron répond au beforeunload via will-prevent-unload ; Playwright ne doit
  // pas envoyer une seconde réponse automatique au dialogue Chromium déjà traité.
  googlePage.on('dialog', () => {});
  await googlePage.getByRole('button', { name: 'Modifier' }).click();
  await application!.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 0; });
  expect(await page.evaluate(() => (window as unknown as DesktopWindow).worklogsDesktop!.googleDocs!.close('close-doc'))).toBe(false);
  expect(googlePage.isClosed()).toBe(false);
  await application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect(page.getByRole('region', { name: 'Journal' })).toBeVisible();
  expect(googlePage.isClosed()).toBe(false);
  await application!.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; });
  expect(await page.evaluate(() => (window as unknown as DesktopWindow).worklogsDesktop!.googleDocs!.close('close-doc'))).toBe(true);
  await expect.poll(() => googlePage.isClosed()).toBe(true);
});

type DialogCount = { worklogsDialogs: number };

test('Google intégré : une vue d’arrière-plan se libère seule, sauf si Google enregistre', async () => {
  await application!.evaluate(({ session }) => session.fromPartition('persist:google-docs').protocol.handle('https', () => new Response(
    '<button onclick="window.onbeforeunload=e=>{e.preventDefault();e.returnValue=true;}">Modifier</button>', { headers: { 'content-type': 'text/html' } },
  )));
  const open = (documentId: string) => page.evaluate(id => (window as unknown as DesktopWindow).worklogsDesktop!.googleDocs!
    .open({ documentId: id, tabId: '', token: id, bounds: { x: 300, y: 300, width: 600, height: 300 } }), documentId);
  const viewOf = (documentId: string) => application!.context().pages().find(p => p.url().includes(`/document/d/${documentId}/`));
  const live = () => application!.evaluate(({ webContents }) => webContents.getAllWebContents().filter(w => w.getURL().includes('/document/d/')).length);
  // Un document Google affiché reste une application complète qui tourne : ouvrir le
  // suivant libère le précédent au lieu d’empiler les sessions jusqu’à la fermeture.
  await open('premier-doc');
  await expect.poll(() => Boolean(viewOf('premier-doc'))).toBe(true);
  const first = viewOf('premier-doc')!;
  await open('second-doc');
  await expect.poll(() => first.isClosed()).toBe(true);
  await expect.poll(() => Boolean(viewOf('second-doc'))).toBe(true);
  const second = viewOf('second-doc')!;
  await expect.poll(live).toBe(1);
  // Un enregistrement Google en cours garde sa vue — et sans poser de question,
  // puisque l’utilisateur n’a pas demandé à fermer ce document-là.
  second.on('dialog', () => {});
  await second.getByRole('button', { name: 'Modifier' }).click();
  await application!.evaluate(({ dialog }) => {
    (globalThis as unknown as DialogCount).worklogsDialogs = 0;
    dialog.showMessageBoxSync = () => { (globalThis as unknown as DialogCount).worklogsDialogs++; return 1; };
  });
  await open('troisieme-doc');
  await expect.poll(() => Boolean(viewOf('troisieme-doc'))).toBe(true);
  expect(second.isClosed()).toBe(false);
  await expect.poll(live).toBe(2);
  expect(await application!.evaluate(() => (globalThis as unknown as DialogCount).worklogsDialogs)).toBe(0);
});

test('Google intégré : masquer le document rend le clavier aux champs WorkLogs', async () => {
  await application!.evaluate(({ session }) => session.fromPartition('persist:google-docs').protocol.handle('https', () => new Response(
    '<div contenteditable="true" role="textbox">Document natif</div>', { headers: { 'content-type': 'text/html' } },
  )));
  // Qui tient réellement le clavier, mesuré côté Electron : les frappes injectées par
  // Playwright court-circuitent cette couche et ne verraient jamais le défaut.
  const keyboard = () => application!.evaluate(({ BrowserWindow, webContents }) => {
    const google = webContents.getAllWebContents().find(w => w.getURL().includes('/document/d/'));
    return { worklogs: BrowserWindow.getAllWindows()[0].webContents.isFocused(), google: Boolean(google?.isFocused()) };
  });
  const focusGoogle = () => application!.evaluate(({ webContents }) => {
    webContents.getAllWebContents().find(w => w.getURL().includes('/document/d/'))!.focus();
  });
  await page.evaluate(() => (window as unknown as DesktopWindow).worklogsDesktop!.googleDocs!
    .open({ documentId: 'focus-doc', tabId: '', token: 'focus', bounds: { x: 300, y: 300, width: 600, height: 300 } }));
  await expect.poll(() => application!.context().pages().some(p => p.url().includes('/document/d/focus-doc/'))).toBe(true);

  await focusGoogle();
  await expect.poll(keyboard).toEqual({ worklogs: false, google: true });
  // Le défaut : la vue masquée gardait le clavier et rien ne le rétablissait — seul
  // minimiser puis rouvrir la fenêtre rendait la main aux champs WorkLogs.
  await page.evaluate(() => (window as unknown as DesktopWindow).worklogsDesktop!.googleDocs!.hide('focus'));
  await expect.poll(keyboard).toEqual({ worklogs: true, google: false });

  // Masquage sans fermeture — une boîte de dialogue s'ouvre par-dessus le document.
  await page.evaluate(() => (window as unknown as DesktopWindow).worklogsDesktop!.googleDocs!
    .open({ documentId: 'focus-doc', tabId: '', token: 'focus', bounds: { x: 300, y: 300, width: 600, height: 300 } }));
  await focusGoogle();
  await expect.poll(keyboard).toEqual({ worklogs: false, google: true });
  await page.evaluate(() => (window as unknown as DesktopWindow).worklogsDesktop!.googleDocs!
    .bounds({ token: 'focus', bounds: { x: 300, y: 300, width: 600, height: 300 }, visible: false }));
  await expect.poll(keyboard).toEqual({ worklogs: true, google: false });

  // Document réaffiché mais clavier aux champs WorkLogs : le retour de la fenêtre ne
  // doit pas le lui reprendre, sinon la frappe de l'utilisateur part dans le document.
  await page.evaluate(() => (window as unknown as DesktopWindow).worklogsDesktop!.googleDocs!
    .bounds({ token: 'focus', bounds: { x: 300, y: 300, width: 600, height: 300 }, visible: true }));
  await application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('focus'));
  await expect.poll(keyboard).toEqual({ worklogs: true, google: false });

  // Le document qui tenait le clavier le retrouve, lui, au retour de la fenêtre.
  await focusGoogle();
  await application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('focus'));
  await expect.poll(keyboard).toEqual({ worklogs: false, google: true });
});
