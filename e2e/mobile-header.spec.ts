import { expect, test } from '@playwright/test';

// Pixel 9a : 412 px de large CSS. L'en-tête y était une rangée unique où logo,
// version, thème, Journal, Écriture, Tâches, Exporter et Paramètres se marchaient dessus.
// Depuis la refonte, les panneaux vivent dans une barre fixée en bas, à portée de pouce.
test.use({ viewport: { width: 412, height: 860 } });

test('en-tête mobile : deux lignes aérées, panneaux dans la barre du bas, cibles tactiles', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Journal' })).toBeVisible();

  const head = page.locator('header.head');
  const search = page.getByRole('searchbox', { name: 'Rechercher' });
  const theme = page.getByRole('button', { name: 'Changer de thème' });
  const journal = page.getByRole('button', { name: 'Journal', exact: true });
  const writing = page.getByRole('button', { name: 'Écriture', exact: true });
  const tasks = page.getByRole('button', { name: 'Tâches', exact: true });
  const procedures = page.getByRole('button', { name: 'Procédures', exact: true });
  const exporter = page.getByRole('button', { name: 'Exporter' });
  const settings = page.getByRole('button', { name: 'Compte et paramètres' });
  for (const control of [search, theme, journal, writing, tasks, procedures, exporter, settings]) {
    await expect(control).toBeVisible();
  }

  // Tout tient dans 412 px : aucun défilement horizontal.
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)
  ).toBe(true);

  // Marque et actions en haut, recherche toute largeur dessous.
  const searchBox = (await search.boundingBox())!;
  const themeBox = (await theme.boundingBox())!;
  const headBox = (await head.boundingBox())!;
  expect(themeBox.y + themeBox.height).toBeLessThanOrEqual(searchBox.y + 1);
  expect(searchBox.width).toBeGreaterThan(headBox.width * 0.9);

  // Panneaux : barre fixée en bas de l'écran, sous le pouce, quatre parts égales.
  const viewport = page.viewportSize()!;
  const boxes = await Promise.all([journal, writing, tasks, procedures].map(async (b) => (await b.boundingBox())!));
  for (const box of boxes) {
    expect(box.y + box.height).toBeGreaterThan(viewport.height - 70);
    expect(box.y).toBeGreaterThan(headBox.y + headBox.height);
    expect(Math.abs(box.width - boxes[0].width)).toBeLessThan(8);
  }
  // Elle reste en place quand le contenu défile.
  await page.locator('.columns').evaluate((el) => el.scrollTo(0, 400));
  expect((await journal.boundingBox())!.y).toBeCloseTo(boxes[0].y, 0);

  // Cibles tactiles : 40 px minimum dans les deux dimensions.
  for (const box of [themeBox, ...boxes, (await exporter.boundingBox())!, (await settings.boundingBox())!]) {
    expect(box.height).toBeGreaterThanOrEqual(40);
    expect(box.width).toBeGreaterThanOrEqual(40);
  }

  // Toujours utilisable : replier le journal depuis la barre du bas.
  await journal.click();
  await expect(page.getByRole('region', { name: 'Journal' })).toBeHidden();
  await expect(journal).toHaveAttribute('aria-pressed', 'false');
});

test('paramètres mobiles : la version s’y lit et les trois blocs sont des cartes', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Journal' })).toBeVisible();

  // La pastille de l'en-tête est masquée à 412 px : le dialogue prend le relais.
  await expect(page.locator('.head .logo .version')).toBeHidden();
  await page.getByRole('button', { name: 'Compte et paramètres' }).click();
  await page.getByRole('menuitem', { name: 'Paramètres' }).click();
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

test('bandeau projets : global, sans débordement, utilisable journal replié', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Journal' })).toBeVisible();

  // Sous l'en-tête, au-dessus des trois cartes : ni dans le journal, ni dedans.
  const strip = page.locator('.project-strip');
  await expect(strip).toBeVisible();
  const filters = page.getByRole('group', { name: 'Filtrer par projet' });
  await expect(filters).toBeVisible();
  expect(await page.locator('#workspace-journal .projects').count()).toBe(0);
  const headBox = (await page.locator('header.head').boundingBox())!;
  const stripBox = (await strip.boundingBox())!;
  expect(stripBox.y).toBeGreaterThanOrEqual(headBox.y + headBox.height - 1);

  // Journal replié : le filtre reste visible et cliquable.
  await page.getByRole('button', { name: 'Journal', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Journal' })).toBeHidden();
  await expect(filters).toBeVisible();
  await expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)
  ).toBe(true);
});
