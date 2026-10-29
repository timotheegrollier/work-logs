import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Pixel 9a : 412 px de large CSS. Sur téléphone, une vue à la fois (§53) : la barre du
// bas choisit Journal, Écriture, Tâches ou Procédures, comme dans une application.
test.use({ viewport: { width: 412, height: 860 } });

const nav = (page: Page, name: string) =>
  page.getByRole('group', { name: 'Panneaux latéraux' }).getByRole('button', { name, exact: true });
const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const views = [
  ['Journal', '#workspace-journal'],
  ['Écriture', '#workspace-editor'],
  ['Tâches', '#workspace-tasks'],
  ['Procédures', '#workspace-procedures'],
] as const;

/** De quoi faire défiler le journal : `count` entrées, des plus anciennes aux plus récentes. */
async function longJournal(request: APIRequestContext, count = 18) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const day = String(i + 1).padStart(2, '0');
    const entry = await (await request.post('/api/entries', { data: { title: `Journal long ${day}`, entry_date: `2025-02-${day}`, content_md: 'Une ligne.' } })).json();
    ids.push(entry.id);
  }
  return ids;
}

test('en-tête mobile : une rangée, barre du bas à quatre destinations, cibles tactiles', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Journal' })).toBeVisible();

  const head = page.locator('header.head');
  const search = page.getByRole('searchbox', { name: 'Rechercher' });
  const theme = page.getByRole('button', { name: 'Changer de thème' });
  const exporter = page.getByRole('button', { name: 'Exporter' });
  const settings = page.getByRole('button', { name: 'Compte et paramètres' });
  const buttons = views.map(([name]) => nav(page, name));
  for (const control of [search, theme, exporter, settings, ...buttons]) await expect(control).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);

  // Logo, recherche et icônes sur une seule rangée : la recherche prend le reste.
  const searchBox = (await search.boundingBox())!;
  const themeBox = (await theme.boundingBox())!;
  const headBox = (await head.boundingBox())!;
  expect(Math.abs(searchBox.y + searchBox.height / 2 - (themeBox.y + themeBox.height / 2))).toBeLessThan(2);
  expect(searchBox.x + searchBox.width).toBeLessThanOrEqual(themeBox.x);
  expect(searchBox.width).toBeGreaterThan(headBox.width * 0.4);
  expect(headBox.height).toBeLessThanOrEqual(64);

  // La barre : fixée en bas, sous le pouce, quatre parts égales qui restent en place.
  const viewport = page.viewportSize()!;
  const boxes = await Promise.all(buttons.map(async (button) => (await button.boundingBox())!));
  for (const box of boxes) {
    expect(box.y + box.height).toBeGreaterThan(viewport.height - 70);
    expect(Math.abs(box.width - boxes[0].width)).toBeLessThan(2);
  }
  await page.locator('.app').evaluate((el) => el.scrollTo(0, 400));
  expect((await buttons[0].boundingBox())!.y).toBeCloseTo(boxes[0].y, 0);
  await page.locator('.app').evaluate((el) => el.scrollTo(0, 0));

  // Cibles tactiles : 44 px dans les deux dimensions.
  for (const box of [themeBox, ...boxes, (await exporter.boundingBox())!, (await settings.boundingBox())!]) {
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
  }

  // La barre choisit une vue (une seule à la fois) : elle ne replie rien.
  await expect(buttons[0]).toHaveAttribute('aria-pressed', 'true');
  await buttons[2].click();
  await expect(page.getByRole('region', { name: 'Tâches' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Journal' })).toBeHidden();
  await expect(buttons[2]).toHaveAttribute('aria-pressed', 'true');
  await expect(buttons[0]).toHaveAttribute('aria-pressed', 'false');
  await buttons[2].click();
  await expect(page.getByRole('region', { name: 'Tâches' })).toBeVisible();
});

test('téléphone : chaque vue occupe l’écran de bord à bord, la version se lit dans Paramètres', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Journal' })).toBeVisible();

  // La pastille de l'en-tête est masquée à 412 px : le dialogue prend le relais.
  await expect(page.locator('.head .logo .version')).toBeHidden();
  await page.getByRole('button', { name: 'Compte et paramètres' }).click();
  await page.getByRole('menuitem', { name: 'Paramètres' }).click();
  const dialog = page.getByRole('dialog', { name: 'Paramètres' });
  await expect(dialog.getByText(/WorkLogs \d+\.\d+\.\d+/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Fermer' }).click();

  // Plus de carte dans la carte ni d'intitulé : la barre du bas dit où l'on est.
  for (const [name, selector] of views) {
    await nav(page, name).click();
    await expect(page.locator(selector)).toBeVisible();
    for (const [, other] of views) if (other !== selector) await expect(page.locator(other)).toBeHidden();
    const panel = (await page.locator(selector).boundingBox())!;
    expect(panel.x).toBeCloseTo(0, 0);
    expect(panel.width).toBeCloseTo(412, 0);
    await expect(page.locator(selector)).toHaveCSS('border-radius', '0px');
    expect(await page.locator(selector).evaluate((el) => getComputedStyle(el, '::before').content)).toMatch(/^(none|normal)$/);
    expect(await noHorizontalScroll(page)).toBe(true);
  }
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

test('bandeau projets : global, sans débordement, utilisable dans chaque vue', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Journal' })).toBeVisible();

  // Sous l'en-tête, au-dessus des vues : ni dans le journal, ni dedans.
  const strip = page.locator('.project-strip');
  await expect(strip).toBeVisible();
  // Téléphone : un bouton qui nomme le projet courant (§54), pas une rangée à faire défiler.
  const filters = page.getByRole('button', { name: /^Projet : / });
  await expect(filters).toBeVisible();
  expect(await page.locator('#workspace-journal .projects').count()).toBe(0);
  const headBox = (await page.locator('header.head').boundingBox())!;
  const stripBox = (await strip.boundingBox())!;
  expect(stripBox.y).toBeGreaterThanOrEqual(headBox.y + headBox.height - 1);

  // Ailleurs que dans le journal, le filtre reste visible et cliquable.
  await nav(page, 'Tâches').click();
  await expect(page.getByRole('region', { name: 'Journal' })).toBeHidden();
  await expect(filters).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
});

test('mobile : la marque s’efface en descendant, le bandeau projets reste collé en haut', async ({ page, request }) => {
  const ids = await longJournal(request);
  try {
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
    await expect(page.getByRole('button', { name: /^Projet : / })).toBeVisible();

    // Seul le bandeau colle : les jours défilent avec leurs entrées
    // (`scroll-overlap.spec.ts` vérifie que rien ne passe devant la liste).
    expect(await page.locator('.day').evaluateAll((days) => days.map((d) => getComputedStyle(d).position)))
      .not.toContain('sticky');
  } finally {
    for (const id of ids) await request.delete(`/api/entries/${id}`);
  }
});

test('mobile en paysage : une vue à la fois, barre horizontale et cibles tactiles', async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto('/');

  const viewport = page.viewportSize()!;
  const navigation = page.locator('.head .panel-toggles');
  const buttons = navigation.locator('.panel-toggle');
  await expect(buttons).toHaveCount(4);
  await expect(page.getByRole('region', { name: 'Journal' })).toBeVisible();
  await expect(page.locator('#workspace-editor')).toBeHidden();

  const navBounds = (await navigation.boundingBox())!;
  expect(navBounds.y + navBounds.height).toBeCloseTo(viewport.height, 0);
  expect(navBounds.height).toBeLessThanOrEqual(56);
  for (const button of await buttons.all()) {
    const bounds = (await button.boundingBox())!;
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    expect(bounds.width).toBeGreaterThanOrEqual(44);
    expect(await button.evaluate((el) => getComputedStyle(el).flexDirection)).toBe('row');
  }
  // L'en-tête tient sur une rangée et part en défilant : 390 px de haut, c'est peu.
  expect((await page.locator('header.head').boundingBox())!.height).toBeLessThanOrEqual(64);
  expect(await page.locator('.app').evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto');
  expect(await noHorizontalScroll(page)).toBe(true);
});

test('téléphone : ouvrir une entrée passe à l’écriture, le retour ramène au journal là où on l’avait laissé', async ({ page, request }) => {
  const ids = await longJournal(request);
  try {
    await page.goto('/');
    const journal = page.getByRole('region', { name: 'Journal' });
    const app = page.locator('.app');
    const old = journal.getByText('Journal long 02', { exact: true });
    await old.scrollIntoViewIfNeeded();
    const scrolled = await app.evaluate((el) => el.scrollTop);
    expect(scrolled).toBeGreaterThan(300);

    // Une nouvelle page : l'écriture seule, par le haut, titre en vue.
    await old.click();
    await expect(page.getByLabel('Titre de l’entrée')).toHaveValue('Journal long 02');
    await expect(journal).toBeHidden();
    await expect(nav(page, 'Écriture')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByLabel('Titre de l’entrée')).toBeInViewport();
    expect(await app.evaluate((el) => el.scrollTop)).toBe(0);

    // Le geste retour d'Android : le journal, à l'endroit quitté, et pas la sortie de l'application.
    await page.goBack();
    await expect(journal).toBeVisible();
    await expect(page.locator('#workspace-editor')).toBeHidden();
    await expect.poll(() => app.evaluate((el) => el.scrollTop)).toBeCloseTo(scrolled, 0);
    await expect(old).toBeInViewport();

    // Depuis une autre vue, le journal par la barre efface la marche : un retour de plus
    // quitterait la page au lieu de revenir à l'écriture.
    await nav(page, 'Tâches').click();
    await nav(page, 'Journal').click();
    await expect(journal).toBeVisible();
    await expect.poll(() => page.evaluate(() => history.state?.worklogsView ?? null)).toBeNull();
  } finally {
    for (const id of ids) await request.delete(`/api/entries/${id}`);
  }
});

test('mobile : écriture compacte, réglages repliés, actions à parts égales, mise en forme sur une rangée', async ({ page, request }) => {
  const rich = { type: 'doc', content: Array.from({ length: 40 }, (_, i) => ({ type: 'paragraph', content: [{ type: 'text', text: `Ligne ${i + 1} du document.` }] })) };
  const entry = await (await request.post('/api/entries', { data: { title: 'Long document', entry_date: '2025-03-15', content_json: rich } })).json();
  try {
    await page.addInitScript((id) => localStorage.setItem('worklogs-entry', id), entry.id);
    await page.goto('/');
    await nav(page, 'Écriture').click();
    await expect(page.getByLabel('Titre de l’entrée')).toHaveValue('Long document');

    // Réglages repliés : une seule ligne qui les résume (un document riche n'a pas Écrire / Lire).
    const region = page.getByRole('region', { name: 'Entrée' });
    const toggle = region.getByRole('button', { name: 'Réglages de l’entrée' });
    await expect(toggle).toHaveText(/sam\. 15 mars 2025/);
    await expect(page.getByLabel('Date de l’entrée')).toBeHidden();
    await expect(region.getByRole('button', { name: 'Supprimer', exact: true })).toBeHidden();
    expect((await region.locator('.editor-meta').boundingBox())!.height).toBeLessThanOrEqual(44);

    // Dépliés : Imprimer, Archiver, Supprimer sur une rangée, trois parts égales.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByLabel('Date de l’entrée')).toBeVisible();
    const actions = await Promise.all(['Imprimer', 'Archiver', 'Supprimer'].map(async (name) =>
      (await region.getByRole('button', { name, exact: true }).boundingBox())!));
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
    expect(await noHorizontalScroll(page)).toBe(true);
  } finally {
    await request.delete(`/api/entries/${entry.id}`);
  }
});
