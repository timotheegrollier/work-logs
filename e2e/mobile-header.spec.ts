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
  // Elle reste en place quand le contenu défile (la page entière défile sur mobile).
  await page.locator('.app').evaluate((el) => el.scrollTo(0, 400));
  expect((await journal.boundingBox())!.y).toBeCloseTo(boxes[0].y, 0);
  await page.locator('.app').evaluate((el) => el.scrollTo(0, 0));

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

test('paramètres : la version reste lisible sur tablette et avec un contenu long', async ({ page }) => {
  // La pastille de l'en-tête est masquée dès 1180 px : entre 601 et 1180 px
  // (tablette, PWA étroite), le dialogue est la seule source du numéro.
  await page.setViewportSize({ width: 800, height: 800 });
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Journal' })).toBeVisible();
  await expect(page.locator('.head .logo .version')).toBeHidden();
  await page.getByRole('button', { name: 'Compte et paramètres' }).click();
  await page.getByRole('menuitem', { name: 'Paramètres' }).click();
  const dialog = page.getByRole('dialog', { name: 'Paramètres' });
  await expect(dialog.getByText(/WorkLogs \d+\.\d+\.\d+/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Fermer' }).click();

  // Contenu très long (Drive déplié, IA, affichage…) : le pied de version
  // reste ancré dans le dialogue au lieu d'être poussé hors champ.
  await page.setViewportSize({ width: 412, height: 860 });
  await page.getByRole('button', { name: 'Compte et paramètres' }).click();
  await page.getByRole('menuitem', { name: 'Paramètres' }).click();
  await expect(dialog).toBeVisible();
  await dialog.evaluate((el) => {
    const filler = document.createElement('div');
    filler.style.height = '2000px';
    el.querySelector('.settings-content')?.appendChild(filler);
  });
  await expect(dialog.getByText(/WorkLogs \d+\.\d+\.\d+/)).toBeVisible();
  const inside = await page.evaluate(() => {
    const dlg = document.querySelector('.settings-dialog') as HTMLElement;
    const ver = dlg.querySelector('.settings-version') as HTMLElement;
    const r = dlg.getBoundingClientRect();
    const v = ver.getBoundingClientRect();
    return v.bottom <= r.bottom + 1 && v.top >= r.top - 1;
  });
  expect(inside).toBe(true);
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

test('mobile : la marque s’efface en descendant, le bandeau projets reste collé en haut', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Journal' })).toBeVisible();
  const app = page.locator('.app');
  const strip = page.locator('.project-strip');
  const headHeight = (await page.locator('header.head').boundingBox())!.height;

  // Une seule page qui défile : l'en-tête part avec le contenu…
  await app.evaluate((el) => el.scrollTo(0, 600));
  await expect.poll(async () => (await page.locator('header.head').boundingBox())!.y).toBeLessThan(-headHeight + 1);
  // …le filtre des projets, lui, reste à portée en haut de l'écran.
  expect((await strip.boundingBox())!.y).toBeCloseTo(0, 0);
  await expect(page.getByRole('group', { name: 'Filtrer par projet' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Gérer les projets' })).toBeVisible();

  // Seul le bandeau colle : les jours défilent avec leurs entrées
  // (`scroll-overlap.spec.ts` vérifie que rien ne passe devant la liste).
  expect(await page.locator('.day').evaluateAll((days) => days.map((d) => getComputedStyle(d).position)))
    .not.toContain('sticky');
});

test('mobile : ouvrir une entrée amène à la carte Écriture, sous le bandeau', async ({ page, request }) => {
  const entry = await (await request.post('/api/entries', { data: { title: 'Compte rendu ancien', entry_date: '2025-03-14' } })).json();
  try {
    await page.goto('/');
    const journal = page.getByRole('region', { name: 'Journal' });
    await journal.getByText('Compte rendu ancien').click();
    await expect(page.getByLabel('Titre de l’entrée')).toHaveValue('Compte rendu ancien');

    // Le titre de la carte Écriture s'arrête juste sous le bandeau projets.
    const stripBottom = (await page.locator('.project-strip').boundingBox())!.height;
    await expect.poll(async () => (await page.locator('#workspace-editor').boundingBox())!.y).toBeLessThan(stripBottom + 30);
    expect((await page.locator('#workspace-editor').boundingBox())!.y).toBeGreaterThanOrEqual(stripBottom - 1);
    await expect(page.getByLabel('Titre de l’entrée')).toBeInViewport();
  } finally {
    await request.delete(`/api/entries/${entry.id}`);
  }
});

test('mobile : écriture compacte, actions à parts égales, mise en forme sur une rangée', async ({ page, request }) => {
  const rich = { type: 'doc', content: Array.from({ length: 40 }, (_, i) => ({ type: 'paragraph', content: [{ type: 'text', text: `Ligne ${i + 1} du document.` }] })) };
  const entry = await (await request.post('/api/entries', { data: { title: 'Long document', entry_date: '2025-03-15', content_json: rich } })).json();
  try {
    await page.addInitScript((id) => localStorage.setItem('worklogs-entry', id), entry.id);
    await page.goto('/');
    await expect(page.getByLabel('Titre de l’entrée')).toHaveValue('Long document');

    // Imprimer, Archiver, Supprimer : une rangée, trois parts égales.
    const actions = await Promise.all(['Imprimer', 'Archiver', 'Supprimer'].map(async (name) =>
      (await page.getByRole('region', { name: 'Entrée' }).getByRole('button', { name, exact: true }).boundingBox())!));
    for (const b of actions) {
      expect(Math.abs(b.y - actions[0].y)).toBeLessThan(2);
      expect(Math.abs(b.width - actions[0].width)).toBeLessThan(2);
      expect(b.height).toBeGreaterThanOrEqual(40);
    }

    // La barre de mise en forme tient sur une rangée qui défile au doigt…
    const toolbar = page.getByRole('toolbar', { name: 'Mise en forme du document' });
    expect((await toolbar.boundingBox())!.height).toBeLessThan(60);
    expect(await toolbar.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    // …et part avec le texte : collée, elle passait devant les lignes qu'on lisait.
    await page.locator('.app').evaluate((el) => {
      const content = document.querySelector('.rich-content') as HTMLElement;
      el.scrollTo(0, content.getBoundingClientRect().top + el.scrollTop + 400);
    });
    expect((await toolbar.boundingBox())!.y + (await toolbar.boundingBox())!.height).toBeLessThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  } finally {
    await request.delete(`/api/entries/${entry.id}`);
  }
});
