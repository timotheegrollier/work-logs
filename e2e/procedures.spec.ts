import { expect, test } from '@playwright/test';

const panel = (page) => page.getByRole('group', { name: 'Procédures du projet' });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Journal' })).toBeVisible();
});

test('procédures du projet : création, pièce jointe rassemblée, ouverture', async ({ page }) => {
  const filters = page.getByRole('group', { name: 'Filtrer par projet' });
  await filters.getByRole('button', { name: /Pro/ }).click();

  await page.getByRole('button', { name: 'Procédures', exact: true }).click();
  await panel(page).locator('summary').click();
  await page.getByRole('button', { name: 'Nouvelle procédure' }).click();
  const title = page.getByLabel('Titre de l’entrée');
  await expect(title).toHaveValue('Sans titre');
  await title.fill('Dallage terrasse');
  await expect(page.getByText('Enregistré')).toBeVisible();
  await expect(panel(page).getByText('Dallage terrasse')).toBeVisible();

  await panel(page).getByLabel('Joindre un fichier à Dallage terrasse').setInputFiles({
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

test('sidebar Procédures : repliée, persistée, et envoi direct de fichier', async ({ page }) => {
  const bar = page.locator('#workspace-procedures');
  const toggle = page.getByRole('button', { name: 'Procédures', exact: true });
  await expect(bar).toBeHidden();
  await toggle.click();
  await expect(bar).toBeVisible();
  await page.reload();
  await expect(bar).toBeVisible();
  await toggle.click();
  await expect(bar).toBeHidden();
  await toggle.click();
  await expect(bar).toBeVisible();

  const filters = page.getByRole('group', { name: 'Filtrer par projet' });
  await filters.getByRole('button', { name: /Pro/ }).click();
  await panel(page).locator('summary').click();
  await page.getByRole('button', { name: 'Nouvelle procédure' }).click();
  const title = page.getByLabel('Titre de l’entrée');
  await expect(title).toHaveValue('Sans titre');
  await title.fill('Envoi direct');
  await expect(page.getByText('Enregistré')).toBeVisible();
  await expect(panel(page).getByText('Envoi direct')).toBeVisible();

  // Envoi direct depuis le panneau, sans ouvrir l'éditeur.
  await panel(page).getByLabel('Joindre un fichier à Envoi direct').setInputFiles({
    name: 'direct.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('envoyé depuis le panneau'),
  });
  await expect(panel(page).getByRole('link', { name: 'direct.pdf' })).toBeVisible();

  // On rend un journal sans filtre : les specs suivantes partent d'un écran complet.
  await page.getByRole('group', { name: 'Filtrer par projet' }).getByRole('button', { name: 'Tout' }).click();
});
