import { expect, test } from '@playwright/test';

// Chaque document est retiré après le test : la recette historique garde son amorçage.
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Nouveau document', exact: false }).click();
  await expect(page.getByRole('textbox', { name: 'Contenu du document' })).toBeVisible();
});
test.afterEach(async ({ page }) => {
  const field = page.getByLabel('Titre de l’entrée');
  if (!(await field.count())) return;
  const name = await field.inputValue();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('region', { name: 'Entrée' }).getByRole('button', { name: 'Supprimer', exact: true }).click();
  // Attendre la disparition effective : sans ça, la recette suivante démarre
  // pendant la suppression et voit encore le document dans le journal.
  await expect(page.getByRole('region', { name: 'Journal' }).getByText(name, { exact: true })).toHaveCount(0);
});

test('édition riche : styles, raccourcis, persistance et impression', async ({ page }, testInfo) => {
  const content = page.getByRole('textbox', { name: 'Contenu du document' });
  await page.getByLabel('Titre de l’entrée').fill('Document riche');
  await content.fill('Décisions du jour');
  await content.press('Control+a');
  await page.getByRole('button', { name: 'Gras', exact: true }).click();
  await page.getByRole('button', { name: 'Souligné', exact: true }).click();
  await page.getByLabel('Style du paragraphe').selectOption('2');
  await page.getByRole('button', { name: 'Centrer', exact: true }).click();
  await content.press('Control+s');
  await expect(page.getByText('Enregistré', { exact: true })).toBeVisible();
  await page.reload();
  await expect(content.locator('h2 strong u, h2 u strong')).toHaveText('Décisions du jour');
  await expect(content.locator('h2')).toHaveCSS('text-align', 'center');
  await page.screenshot({ path: testInfo.outputPath('rich-editor.png'), fullPage: true });
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('toolbar', { name: 'Mise en forme du document' })).toBeHidden();
  await expect(content).toBeVisible();
  await page.emulateMedia({ media: 'screen' });
});

test('liste, lien, annuler et rétablir fonctionnent dans l’éditeur', async ({ page }) => {
  const content = page.getByRole('textbox', { name: 'Contenu du document' });
  await content.fill('Compte rendu');
  await content.press('Control+a');
  page.once('dialog', dialog => dialog.accept('https://example.com/compte-rendu'));
  await page.getByRole('button', { name: 'Lien', exact: true }).click();
  await expect(content.locator('a')).toHaveAttribute('href', 'https://example.com/compte-rendu');
  await page.getByRole('button', { name: 'Liste à puces', exact: true }).click();
  await expect(content.locator('ul li')).toHaveText('Compte rendu');
  await page.getByRole('button', { name: 'Annuler', exact: true }).click();
  await expect(content.locator('ul')).toHaveCount(0);
  await page.getByRole('button', { name: 'Rétablir', exact: true }).click();
  await expect(content.locator('ul li')).toHaveText('Compte rendu');
});

test('tableau et image locale survivent au rechargement', async ({ page }) => {
  const content = page.getByRole('textbox', { name: 'Contenu du document' });
  await content.click();
  await page.getByRole('button', { name: 'Tableau', exact: true }).click();
  await expect(content.locator('tr')).toHaveCount(3);
  await content.locator('th').first().click();
  await page.keyboard.type('Échéance');
  await page.getByRole('button', { name: 'Ajouter une ligne', exact: true }).click();
  await expect(content.locator('tr')).toHaveCount(4);
  await content.press('Control+End');
  await page.getByLabel('Insérer une image').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64') });
  await expect(content.locator('img')).toBeVisible();
  await content.press('Control+s');
  await expect(page.getByText('Enregistré', { exact: true })).toBeVisible();
  await page.reload();
  await expect(content.locator('tr')).toHaveCount(4);
  await expect(content.locator('img')).toHaveAttribute('alt', 'pixel.png');
  await expect(page.getByText('Enregistré', { exact: true })).toBeVisible();
});

test('le panneau Drive explique la disponibilité desktop sans bloquer le document local', async ({ page }) => {
  await page.getByRole('button', { name: 'Google Drive', exact: false }).click();
  await expect(page.getByText('La connexion Drive est disponible dans l’application desktop Linux.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Contenu du document' })).toBeEditable();
});
