import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Dossier partagé dans un vrai navigateur. `.e2e-share` joue le partage du TSE
 * (voir `playwright.config.ts`) : le test y joue le collègue — il réécrit un
 * fichier, dépose un verrou LibreOffice — et vérifie ce qui arrive sur disque.
 */
const share = path.resolve('.e2e-share');
const put = (name: string, contents: string | Buffer) => fs.writeFileSync(path.join(share, name), contents);
const get = (name: string, encoding: BufferEncoding = 'utf8') => fs.readFileSync(path.join(share, name), encoding);

async function openShared(page: Page, name: string) {
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Journal' })).toBeVisible();
  const toggle = page.getByRole('button', { name: 'Procédures', exact: true });
  if (await page.locator('#workspace-procedures').isHidden()) await toggle.click();
  await page.getByRole('button', { name: new RegExp(`^Ouvrir ${name.replace(/[.()]/g, '\\$&')}`) }).click();
  const editor = page.getByRole('region', { name: 'Fichier partagé' });
  await expect(editor.getByRole('heading', { name })).toBeVisible();
  return editor;
}

test.beforeEach(() => {
  for (const name of fs.readdirSync(share)) fs.rmSync(path.join(share, name), { recursive: true, force: true });
});

test('CSV au clavier dans la grille, envoyé par Ctrl+S : seule la ligne touchée change', async ({ page }) => {
  const original = 'Date;Mesure\r\n05/10/2026;12,5\r\n06/10/2026;13\r\n';
  put('relevés.csv', Buffer.from(original, 'latin1'));
  const editor = await openShared(page, 'relevés.csv');

  await editor.getByRole('gridcell', { name: 'B3 : 13' }).click();
  await page.keyboard.type('14,2');
  await page.keyboard.press('Enter');
  await expect(editor.getByRole('gridcell', { name: 'B3 : 14,2' })).toBeVisible();
  await expect(editor.getByText('Brouillon sur cet ordinateur')).toBeVisible();
  expect(get('relevés.csv', 'latin1')).toBe(original);

  await page.keyboard.press('Control+s');
  await expect(editor.getByText('Enregistré sur le partage.')).toBeVisible();
  expect(get('relevés.csv', 'latin1')).toBe('Date;Mesure\r\n05/10/2026;12,5\r\n06/10/2026;14,2\r\n');
});

test('conflit : le collègue a enregistré entre-temps, « garder les deux » laisse deux fichiers', async ({ page }) => {
  put('consignes.md', '# Consignes\n');
  const editor = await openShared(page, 'consignes.md');
  await editor.getByLabel('Contenu de consignes.md').fill('# Consignes\n\nMa version.\n');
  await expect(editor.getByText('Brouillon sur cet ordinateur')).toBeVisible();
  put('consignes.md', '# Consignes\n\nVersion du collègue.\n');

  await editor.getByRole('button', { name: 'Enregistrer sur le partage' }).click();
  const alert = editor.getByRole('alert');
  await expect(alert).toContainText('Rien n’a été écrasé');
  expect(get('consignes.md')).toBe('# Consignes\n\nVersion du collègue.\n');

  await alert.getByRole('button', { name: 'Garder les deux' }).click();
  await expect(editor.getByLabel('Contenu de consignes.md')).toHaveValue('# Consignes\n\nVersion du collègue.\n');
  const copy = fs.readdirSync(share).find((name) => name.startsWith('consignes (copie '));
  expect(copy).toBeTruthy();
  expect(get(copy!)).toBe('# Consignes\n\nMa version.\n');
  await editor.getByRole('button', { name: copy }).click();
  await expect(page.getByRole('region', { name: 'Fichier partagé' }).getByLabel(`Contenu de ${copy}`)).toHaveValue('# Consignes\n\nMa version.\n');
});

test('verrou LibreOffice d’un collègue : envoi en attente, parti quand il ferme', async ({ page }) => {
  put('planning.txt', 'lundi\n');
  put('.~lock.planning.txt#', 'Hélène Martin,hmartin,TSE01,05.10.2026 09:00,file:///C:/Users/hmartin;');
  const editor = await openShared(page, 'planning.txt');
  await expect(editor.getByText(/Lecture seule — Ouvert par Hélène Martin dans LibreOffice/)).toBeVisible();
  await editor.getByRole('button', { name: 'Écrire un brouillon quand même' }).click();
  await editor.getByLabel('Contenu de planning.txt').fill('lundi\nmardi\n');
  await editor.getByRole('button', { name: 'Enregistrer sur le partage' }).click();
  await expect(editor.getByText(/Envoi en attente — Ouvert par Hélène Martin dans LibreOffice/)).toBeVisible();
  expect(get('planning.txt')).toBe('lundi\n');

  fs.rmSync(path.join(share, '.~lock.planning.txt#'));
  await editor.getByRole('button', { name: 'Réessayer maintenant' }).click();
  await expect(editor.getByText('Enregistré sur le partage.')).toBeVisible();
  expect(get('planning.txt')).toBe('lundi\nmardi\n');
});

test('première frappe : mon verrou sur le partage ; fermer avec un brouillon demande, puis rend la main', async ({ page }) => {
  put('consignes.md', '# Consignes\n');
  const editor = await openShared(page, 'consignes.md');
  await editor.getByLabel('Contenu de consignes.md').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' (à relire)');
  await expect(editor.getByText('Tu as la main')).toBeVisible();
  expect(fs.existsSync(path.join(share, '.~lock.consignes.md#'))).toBe(true);
  expect(get('.~lock.consignes.md#')).toMatch(/\(WorkLogs\),/);

  await editor.getByRole('button', { name: 'Fermer' }).click();
  const question = page.getByRole('dialog', { name: 'Tes modifications ne sont pas sur le partage' });
  await expect(question).toBeVisible();
  await question.getByRole('button', { name: 'Garder le brouillon ici' }).click();
  await expect(page.getByRole('region', { name: 'Fichier partagé' })).toBeHidden();
  await expect.poll(() => fs.existsSync(path.join(share, '.~lock.consignes.md#'))).toBe(false);
  expect(get('consignes.md')).toBe('# Consignes\n');
  await expect(page.getByRole('button', { name: /^Ouvrir consignes\.md — Brouillon sur cet ordinateur/ })).toBeVisible();
});

test('un projet relié à un sous-dossier : son filtre n’affiche que lui', async ({ page }) => {
  fs.mkdirSync(path.join(share, 'Chantier'));
  put('Chantier/plan.md', '# Plan');
  put('ailleurs.md', 'x');
  await page.goto('/');
  if (await page.locator('#workspace-procedures').isHidden()) await page.getByRole('button', { name: 'Procédures', exact: true }).click();
  await page.getByRole('group', { name: 'Filtrer par projet' }).getByRole('button', { name: /Pro/ }).click();
  await page.getByRole('button', { name: 'Relier Pro à un dossier…' }).click();
  await page.getByRole('button', { name: 'Relier Pro au dossier Chantier' }).click();
  await expect(page.getByRole('button', { name: /^Ouvrir plan\.md/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Ouvrir ailleurs\.md/ })).toBeHidden();
  await page.getByRole('button', { name: 'Délier Pro de son dossier' }).click();
  await expect(page.getByRole('button', { name: /^Ouvrir ailleurs\.md/ })).toBeVisible();
});
