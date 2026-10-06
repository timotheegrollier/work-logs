import { expect, test } from '@playwright/test';

// Pixel 9a (412 px) : le choix du projet partageait sa rangée avec
// « Gérer les projets » et devenait trop étroit dès 2-3 projets.
// Les pastilles occupent désormais toute leur rangée, la gestion passe dessous.
test.use({ viewport: { width: 412, height: 860 } });

test('bandeau projets mobile : pastilles toute largeur, gestion dessous, filtre OK', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Journal' })).toBeVisible();

  const strip = page.locator('.project-strip');
  const chips = strip.locator('.chips');
  const manage = strip.locator('.manage > summary');
  const stripBox = (await strip.boundingBox())!;
  const chipsBox = (await chips.boundingBox())!;
  const manageBox = (await manage.boundingBox())!;
  // Pastilles : presque toute la largeur du bandeau…
  expect(chipsBox.width).toBeGreaterThan(stripBox.width * 0.9);
  // …« Gérer » sur sa propre rangée dessous…
  expect(manageBox.y).toBeGreaterThanOrEqual(chipsBox.y + chipsBox.height - 1);
  // …et cibles tactiles.
  expect(chipsBox.height).toBeGreaterThanOrEqual(40);

  // Toujours utilisable : créer un projet puis le sélectionner comme filtre.
  await manage.click();
  await strip.getByLabel('Nom du nouveau projet').fill('Chantier');
  await strip.getByRole('button', { name: 'Créer' }).click();
  const chantier = strip.locator('.chips').getByRole('button', { name: 'Chantier', exact: true });
  await expect(chantier).toBeVisible();
  await chantier.click();
  await expect(chantier).toHaveAttribute('aria-pressed', 'true');

  // Pas de défilement horizontal sur la page.
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)
  ).toBe(true);
});
