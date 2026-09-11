import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let directory: string;
let application: ElectronApplication | undefined;
let page: Page;

async function launch() {
  const env = Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] =>
    item[1] !== undefined && item[0] !== 'ELECTRON_RUN_AS_NODE'));
  application = await _electron.launch({
    ...(process.env.WORKLOGS_EXECUTABLE ? { executablePath: process.env.WORKLOGS_EXECUTABLE, args: [] }
      : { args: [path.resolve('desktop/main.mjs')] }),
    // Uniquement les environnements CI/conteneurs sans sandbox Chromium utilisable.
    chromiumSandbox: process.env.WORKLOGS_TEST_NO_SANDBOX !== '1',
    env: { ...env, WORKLOGS_DATA_DIR: path.join(directory, 'data'), WORKLOGS_PROFILE_DIR: path.join(directory, 'profile') },
  });
  page = await application.firstWindow();
  await expect(page.getByLabel('Titre de l’entrée')).toHaveValue('Comment ça marche');
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

test('fichiers joints et export JSON fonctionnent dans l’application empaquetée', async () => {
  await page.getByLabel('Joindre un fichier').setInputFiles({ name: 'pièce.txt', mimeType: 'text/plain', buffer: Buffer.from('contenu desktop') });
  await expect(page.getByRole('link', { name: 'pièce.txt' })).toBeVisible();
  await application!.evaluate(({ session }, dir) => {
    session.defaultSession.on('will-download', (_event, item) => item.setSavePath(dir + '/' + item.getFilename()));
  }, directory);
  const fileDownload = page.waitForEvent('download');
  await page.getByRole('link', { name: 'pièce.txt' }).click();
  const file = await fileDownload;
  expect(await file.failure()).toBeNull();
  expect(fs.readFileSync((await file.path())!, 'utf8')).toBe('contenu desktop');
  const exportDownload = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Exporter' }).click();
  const exported = await exportDownload;
  expect(await exported.failure()).toBeNull();
  expect(JSON.parse(fs.readFileSync((await exported.path())!, 'utf8')).entries[0].title).toBe('Comment ça marche');
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
