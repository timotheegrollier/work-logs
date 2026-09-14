import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
