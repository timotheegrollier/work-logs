import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { wordDocx } from '../web/src/test/docx-fixture';
import { excelWorkbook } from '../web/src/test/xlsx-fixture';
import { readZip, readZipText } from '../web/src/zip';

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

test('document Word : taper dans un paragraphe puis Ctrl+S ne réécrit que lui, mise en forme d’origine gardée', async ({ page }) => {
  const original = wordDocx();
  put('procédure.docx', Buffer.from(original));
  const editor = await openShared(page, 'procédure.docx');
  const content = editor.getByRole('textbox', { name: 'Contenu du document Word' });
  await content.getByText('chaque lundi.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Puis rincer.');
  await expect(editor.getByText('Tu as la main')).toBeVisible();
  await expect(editor.getByText('Brouillon sur cet ordinateur')).toBeVisible();
  await page.keyboard.press('Control+s');
  await expect(editor.getByText('Enregistré sur le partage.')).toBeVisible();

  const sent = readZip(new Uint8Array(fs.readFileSync(path.join(share, 'procédure.docx'))));
  const before = (await readZipText(readZip(original), 'word/document.xml'))!;
  const after = (await readZipText(sent, 'word/document.xml'))!;
  expect(after).toContain('<w:t xml:space="preserve"> chaque lundi. Puis rincer.</w:t>');
  // Le run en italique rouge, les autres paragraphes, le tableau et l'image : intacts.
  expect(after).toContain('<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:i/><w:color w:val="FF0000"/><w:lang w:val="fr-FR"/></w:rPr>');
  const start = before.indexOf('<w:p><w:r><w:t xml:space="preserve">Voir </w:t>');
  expect(after.slice(after.indexOf('<w:p><w:r><w:t xml:space="preserve">Voir </w:t>'))).toBe(before.slice(start));
  expect(await readZipText(sent, 'word/styles.xml')).toBe(await readZipText(readZip(original), 'word/styles.xml'));
});

test('classeur Excel : nombre et formule en français au clavier, Ctrl+S ne réécrit que ces cellules', async ({ page }) => {
  const original = excelWorkbook();
  put('budget.xlsx', Buffer.from(original));
  const editor = await openShared(page, 'budget.xlsx');
  await expect(editor.getByRole('grid', { name: 'Feuille Suivi' })).toBeVisible();

  await editor.getByRole('gridcell', { name: 'B3 : 100,00 €' }).click();
  await page.keyboard.type('87,5');
  await page.keyboard.press('Enter');
  await expect(editor.getByRole('gridcell', { name: 'B3 : 87,50 €' })).toBeVisible();
  await page.keyboard.type('=SOMME(B2:B3;10)');
  await page.keyboard.press('Enter');
  await expect(editor.getByRole('gridcell', { name: 'B4 : =SOMME(B2:B3;10)' })).toBeVisible();
  await expect(editor.getByText('Brouillon sur cet ordinateur')).toBeVisible();
  expect(Buffer.from(fs.readFileSync(path.join(share, 'budget.xlsx'))).equals(Buffer.from(original))).toBe(true);

  await page.keyboard.press('Control+s');
  await expect(editor.getByText('Enregistré sur le partage.')).toBeVisible();
  const sent = readZip(new Uint8Array(fs.readFileSync(path.join(share, 'budget.xlsx'))));
  const before = (await readZipText(readZip(original), 'xl/worksheets/sheet1.xml'))!;
  expect(await readZipText(sent, 'xl/worksheets/sheet1.xml')).toBe(before
    .replace('<c r="B3" s="2"><v>100</v></c>', '<c r="B3" s="2"><v>87.5</v></c>')
    .replace('<c r="B4" s="2"><f>SUM(B2:B3)</f><v>1334.5</v></c>', '<c r="B4" s="2"><f>SUM(B2:B3,10)</f></c>')
    .replace('<f t="shared" si="0"/><v>200</v>', '<f t="shared" si="0"/>'));
  expect(sent.byName.has('xl/calcChain.xml')).toBe(false);
  expect(await readZipText(sent, 'xl/styles.xml')).toBe(await readZipText(readZip(original), 'xl/styles.xml'));
});

test('conflit sur des lignes différentes : « Fusionner » réunit les deux versions sur le partage', async ({ page }) => {
  // Un fichier à lui : un autre parcours garde exprès un brouillon sur consignes.md.
  put('entretien.md', '# Consignes\n\nLaver le filtre.\n\nContrôler le pH.\n');
  const editor = await openShared(page, 'entretien.md');
  await editor.getByLabel('Contenu de entretien.md').fill('# Consignes\n\nLaver le filtre.\n\nContrôler le pH chaque matin.\n');
  await expect(editor.getByText('Brouillon sur cet ordinateur')).toBeVisible();
  put('entretien.md', '# Consignes\n\nLaver le filtre le lundi.\n\nContrôler le pH.\n');

  await page.keyboard.press('Control+s');
  const alert = editor.getByRole('alert');
  await expect(alert).toContainText('Vos modifications ne se touchent pas');
  await alert.getByRole('button', { name: 'Fusionner' }).click();
  await expect(editor.getByText(/Fusionné et enregistré sur le partage/)).toBeVisible();
  expect(get('entretien.md')).toBe('# Consignes\n\nLaver le filtre le lundi.\n\nContrôler le pH chaque matin.\n');
  await expect(editor.getByLabel('Contenu de entretien.md')).toHaveValue('# Consignes\n\nLaver le filtre le lundi.\n\nContrôler le pH chaque matin.\n');
});

test('chercher dans le partage : taper un mot, ouvrir le fichier trouvé au fond de l’arborescence', async ({ page }) => {
  fs.mkdirSync(path.join(share, 'Global', 'MURGAT INGENIERIE', '13. SI', '00. PROCEDURE'), { recursive: true });
  put('Global/MURGAT INGENIERIE/13. SI/00. PROCEDURE/Procédure sauvegarde.md', '# Sauvegarde\n');
  put('notes.md', 'x');
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Journal' })).toBeVisible();
  if (await page.locator('#workspace-procedures').isHidden()) await page.getByRole('button', { name: 'Procédures', exact: true }).click();
  await page.getByLabel('Chercher dans le partage').fill('sauvegarde');
  const results = page.getByRole('region', { name: 'Résultats de la recherche' });
  await results.getByRole('button', { name: 'Ouvrir Global/MURGAT INGENIERIE/13. SI/00. PROCEDURE/Procédure sauvegarde.md' }).click();
  await expect(page.getByRole('region', { name: 'Fichier partagé' }).getByLabel('Contenu de Procédure sauvegarde.md')).toHaveValue('# Sauvegarde\n');
});

test('nouveau classeur Excel dans un dossier : créé, rempli au clavier, enregistré par Ctrl+S', async ({ page }) => {
  fs.mkdirSync(path.join(share, '00. PROCEDURE'));
  put('00. PROCEDURE/lisez-moi.md', '# x\n');
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Journal' })).toBeVisible();
  if (await page.locator('#workspace-procedures').isHidden()) await page.getByRole('button', { name: 'Procédures', exact: true }).click();
  await page.getByRole('button', { name: 'Dossier 00. PROCEDURE' }).click();
  await expect(page.getByRole('button', { name: /^Ouvrir lisez-moi\.md/ })).toBeVisible();
  await page.getByRole('button', { name: '＋ Nouveau fichier…' }).click();
  const form = page.getByRole('form', { name: 'Nouveau fichier' });
  await form.getByLabel('Type de fichier').selectOption('xlsx');
  await form.getByLabel('Nom du fichier').fill('Inventaire');
  await form.getByRole('button', { name: 'Créer' }).click();

  const editor = page.getByRole('region', { name: 'Fichier partagé' });
  await expect(editor.getByRole('grid', { name: 'Feuille Feuil1' })).toBeVisible();
  await editor.getByRole('gridcell', { name: 'A1 : vide' }).click();
  await page.keyboard.type('Imprimante');
  await page.keyboard.press('Tab');
  await page.keyboard.type('3');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+s');
  await expect(editor.getByText('Enregistré sur le partage.')).toBeVisible();
  const sent = readZip(new Uint8Array(fs.readFileSync(path.join(share, '00. PROCEDURE', 'Inventaire.xlsx'))));
  expect(await readZipText(sent, 'xl/worksheets/sheet1.xml')).toContain('<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>3</v></c></row></sheetData>');
  expect(await readZipText(sent, 'xl/sharedStrings.xml')).toContain('<si><t>Imprimante</t></si>');
});
