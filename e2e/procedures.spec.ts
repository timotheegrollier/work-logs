import { expect, test } from '@playwright/test';

const panel = (page) => page.getByRole('group', { name: 'Procédures du projet' });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Journal' })).toBeVisible();
});

test('procédures du projet : création, pièce jointe rassemblée, ouverture', async ({ page }) => {
  const filters = page.getByRole('group', { name: 'Filtrer par projet' });
  await filters.getByRole('button', { name: /Pro/ }).click();

  await panel(page).locator('summary').click();
  await page.getByRole('button', { name: 'Nouvelle procédure' }).click();
  const title = page.getByLabel('Titre de l’entrée');
  await expect(title).toHaveValue('Sans titre');
  await title.fill('Dallage terrasse');
  await expect(page.getByText('Enregistré')).toBeVisible();
  await expect(panel(page).getByText('Dallage terrasse')).toBeVisible();

  await page.getByLabel('Joindre un fichier').setInputFiles({
    name: 'plan.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('plan de la terrasse'),
  });
  await expect(panel(page).getByRole('link', { name: 'plan.pdf' })).toBeVisible();

  // L'autre projet ne voit rien : le panneau suit le filtre.
  await filters.getByRole('button', { name: /Perso/ }).click();
  await expect(panel(page).getByText('Dallage terrasse')).toBeHidden();
  await expect(panel(page).getByText('Aucune procédure pour Perso.')).toBeVisible();
});
