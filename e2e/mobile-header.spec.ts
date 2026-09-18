import { expect, test } from '@playwright/test';

// Pixel 9a : 412 px de large CSS. L'en-tête y était une rangée unique où logo,
// version, thème, Journal, Écriture, Tâches, Exporter et Paramètres se marchaient dessus.
test.use({ viewport: { width: 412, height: 860 } });

test('en-tête mobile : trois lignes aérées, sans débordement, cibles tactiles', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Journal' })).toBeVisible();

  const head = page.locator('header.head');
  const search = page.getByRole('searchbox', { name: 'Rechercher' });
  const theme = page.getByRole('button', { name: 'Changer de thème' });
  const journal = page.getByRole('button', { name: 'Journal' });
  const writing = page.getByRole('button', { name: 'Écriture' });
  const tasks = page.getByRole('button', { name: 'Tâches' });
  const exporter = page.getByRole('button', { name: 'Exporter' });
  const settings = page.getByRole('button', { name: '⚙ Paramètres' });
  for (const control of [search, theme, journal, writing, tasks, exporter, settings]) {
    await expect(control).toBeVisible();
  }

  // Tout tient dans 412 px : aucun défilement horizontal.
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)
  ).toBe(true);

  // Marque et actions en haut, recherche toute largeur, panneaux en dessous.
  const searchBox = (await search.boundingBox())!;
  const themeBox = (await theme.boundingBox())!;
  const journalBox = (await journal.boundingBox())!;
  const writingBox = (await writing.boundingBox())!;
  const tasksBox = (await tasks.boundingBox())!;
  const headBox = (await head.boundingBox())!;
  expect(themeBox.y + themeBox.height).toBeLessThanOrEqual(searchBox.y + 1);
  expect(searchBox.width).toBeGreaterThan(headBox.width * 0.9);
  for (const box of [journalBox, writingBox, tasksBox]) {
    expect(box.y).toBeGreaterThan(searchBox.y + searchBox.height - 1);
  }
  // Les trois panneaux se partagent la largeur à parts égales.
  expect(Math.abs(journalBox.width - writingBox.width)).toBeLessThan(8);
  expect(Math.abs(writingBox.width - tasksBox.width)).toBeLessThan(8);

  // Cibles tactiles : 40 px minimum dans les deux dimensions.
  for (const box of [themeBox, journalBox, writingBox, tasksBox, (await exporter.boundingBox())!, (await settings.boundingBox())!]) {
    expect(box.height).toBeGreaterThanOrEqual(40);
    expect(box.width).toBeGreaterThanOrEqual(40);
  }

  // Toujours utilisable : replier le journal depuis la barre mobile.
  await journal.click();
  await expect(page.getByRole('region', { name: 'Journal' })).toBeHidden();
  await expect(journal).toHaveAttribute('aria-pressed', 'false');
});

test('paramètres mobiles : la version s’y lit et les trois blocs sont des cartes', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Journal' })).toBeVisible();

  // La pastille de l'en-tête est masquée à 412 px : le dialogue prend le relais.
  await expect(page.locator('.head .logo .version')).toBeHidden();
  await page.getByRole('button', { name: '⚙ Paramètres' }).click();
  const dialog = page.getByRole('dialog', { name: 'Paramètres' });
  await expect(dialog.getByText(/WorkLogs \d+\.\d+\.\d+/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Fermer' }).click();

  // Journal, Écriture et Tâches : trois cartes identifiées, pas un long continu.
  for (const [selector, title] of [['.left', 'Journal'], ['.center', 'Écriture'], ['.right', 'Tâches']] as const) {
    await expect(page.locator(selector)).toHaveCSS('border-radius', '14px');
    expect(
      await page.locator(selector).evaluate(
        (el, expected) => getComputedStyle(el, '::before').content.replace(/["']/g, '') === expected,
        title
      )
    ).toBe(true);
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)
  ).toBe(true);
});
