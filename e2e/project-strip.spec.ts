import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Beaucoup de projets : le bandeau prenait deux rangées (pastilles, puis
// « Gérer les projets ») et la gestion dépliait une liste pleine largeur qui
// repoussait journal, écriture et tâches hors de l'écran, desktop comme mobile.
// Désormais : une seule rangée qui défile, la gestion s'ouvre par-dessus.
const NAMES = [
  'Active Directory', 'Intranet RH', 'Inventaire GLPI', 'Licences Microsoft 365', 'Messagerie',
  'Migration Exchange', 'Onboarding', 'Parc imprimantes', 'Pare-feu Fortinet', 'Réseau Wi-Fi bâtiment B',
  'Sauvegardes Veeam', 'Serveur de fichiers', 'Téléphonie Teams', 'Vidéosurveillance',
];
const COLORS = ['#8b5cf6', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#64748b'];

// Les parcours partagent la base du serveur : on retire ce qu'on a créé,
// les autres fichiers filtrent sur « Pro » et ne doivent rien voir de plus.
test.beforeEach(async ({ request }) => {
  for (const [i, name] of NAMES.entries()) {
    await request.post('/api/projects', { data: { name, color: COLORS[i % COLORS.length] } });
  }
});
test.afterEach(async ({ request }) => {
  await removeProjects(request, [...NAMES, 'Chantier']);
});

async function removeProjects(request: APIRequestContext, names: string[]) {
  const state = await (await request.get('/api/state')).json();
  for (const project of state.projects as { id: string; name: string }[]) {
    if (names.includes(project.name)) await request.delete(`/api/projects/${project.id}`);
  }
}

const box = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!;
const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test.describe('mobile', () => {
  // Pixel 9a : 412 px de large CSS. La rangée n'y montrait qu'une pastille et demie :
  // un bouton nomme le projet courant et ouvre la liste complète (§54).
  test.use({ viewport: { width: 412, height: 860 }, hasTouch: true });

  test('téléphone : un bouton nomme le projet, la liste complète choisit, la gestion est au pied', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('region', { name: 'Journal' })).toBeVisible();
    const switcher = page.getByRole('button', { name: 'Projet : Tous les projets' });
    await expect(switcher).toBeVisible();
    await expect(page.getByRole('group', { name: 'Filtrer par projet' })).toHaveCount(0);
    const stripBox = await box(page, '.project-strip');
    expect(stripBox.height).toBeLessThanOrEqual(64);
    expect((await switcher.boundingBox())!.width).toBeGreaterThan(stripBox.width * 0.7);
    expect(await noHorizontalScroll(page)).toBe(true);

    // La liste monte du bas, ne déplace rien derrière elle et montre tous les projets.
    const columnsTop = (await box(page, '.columns')).y;
    await switcher.click();
    const sheet = page.getByRole('dialog', { name: /^Projets/ });
    await expect(sheet).toBeVisible();
    await sheet.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    const sheetBox = (await sheet.boundingBox())!;
    expect(sheetBox.width).toBeCloseTo(412, 0);
    expect(sheetBox.y + sheetBox.height).toBeCloseTo(860, 0);
    expect(sheetBox.height).toBeLessThan(860 * 0.9);
    expect((await box(page, '.columns')).y).toBeCloseTo(columnsTop, 0);
    const choices = sheet.getByRole('list', { name: 'Choisir un projet' });
    for (const name of NAMES) await expect(choices.getByRole('button', { name: new RegExp('^' + name) })).toBeAttached();
    await expect(choices.getByRole('button', { name: 'Tous les projets' })).toHaveAttribute('aria-pressed', 'true');
    expect(await choices.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    expect((await choices.getByRole('button', { name: /^Active Directory/ }).boundingBox())!.height).toBeGreaterThanOrEqual(48);
    // Toucher un nom choisit : aucun champ de renommage dans cette liste.
    await expect(sheet.getByLabel('Nom de Messagerie')).toHaveCount(0);

    // Retrouver au clavier : quelques lettres, Entrée prend le premier trouvé.
    await sheet.getByLabel('Retrouver un projet').fill('veeam');
    await expect(choices.getByRole('button')).toHaveCount(1);
    await sheet.getByLabel('Retrouver un projet').press('Enter');
    await expect(sheet).toBeHidden();
    const veeam = page.getByRole('button', { name: 'Projet : Sauvegardes Veeam' });
    await expect(veeam).toBeFocused();

    // Rouverte, elle montre le projet en cours, coché.
    await veeam.click();
    const current = choices.getByRole('button', { name: /^Sauvegardes Veeam/ });
    await expect(current).toHaveAttribute('aria-pressed', 'true');
    await expect(current).toBeInViewport();

    // Gérer : au pied de la liste, la gestion connue, dans la même feuille.
    await sheet.getByRole('button', { name: 'Gérer les projets' }).click();
    await sheet.getByLabel('Nom du nouveau projet').fill('Chantier');
    await sheet.getByRole('button', { name: 'Créer' }).click();
    await expect(sheet.getByLabel('Nom de Chantier')).toBeVisible();
    expect((await sheet.getByLabel('Supprimer Sauvegardes Veeam').boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await sheet.getByRole('button', { name: 'Fermer' }).click();
    await expect(sheet).toBeHidden();
    await expect(veeam).toBeFocused();

    // Le nouveau projet se choisit d'un toucher.
    await veeam.click();
    await choices.getByRole('button', { name: /^Chantier/ }).click();
    await expect(page.getByRole('button', { name: 'Projet : Chantier' })).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
  });
});

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('bandeau : une rangée, molette, gestion posée sous son bouton', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('region', { name: 'Journal' })).toBeVisible();
    const rail = page.getByRole('group', { name: 'Filtrer par projet' });
    const manage = page.getByRole('button', { name: 'Gérer les projets' });
    await expect(rail.getByRole('button', { name: 'Vidéosurveillance' })).toBeAttached();

    // Une rangée : « Gérer les projets » ne passe plus à la ligne.
    expect((await box(page, '.project-strip')).height).toBeLessThanOrEqual(50);
    const manageBox = (await manage.boundingBox())!;
    const railBox = (await rail.boundingBox())!;
    expect(Math.abs(manageBox.y + manageBox.height / 2 - (railBox.y + railBox.height / 2))).toBeLessThan(3);

    // La molette verticale fait défiler les pastilles.
    expect(await rail.evaluate((el) => el.scrollLeft)).toBe(0);
    await rail.hover();
    await page.mouse.wheel(0, 500);
    await expect.poll(() => rail.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);
    await expect(rail).toHaveClass(/fade-start/);

    // Gestion : fenêtre bornée, calée sous le bouton, la page derrière ne bouge pas.
    const columnsTop = (await box(page, '.columns')).y;
    await manage.click();
    const popover = page.getByRole('dialog', { name: /^Projets/ });
    await expect(popover).toBeVisible();
    await popover.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    const popBox = (await popover.boundingBox())!;
    expect(popBox.y).toBeGreaterThanOrEqual(manageBox.y + manageBox.height);
    expect(Math.abs(popBox.x + popBox.width - (manageBox.x + manageBox.width))).toBeLessThan(3);
    expect(popBox.width).toBeLessThanOrEqual(401);
    expect(popBox.height).toBeLessThanOrEqual(581);
    expect((await box(page, '.columns')).y).toBeCloseTo(columnsTop, 0);
    // Clavier physique : on tape le nom tout de suite.
    await expect(popover.getByLabel('Nom du nouveau projet')).toBeFocused();

    // Échap annule d'abord un renommage commencé, sans fermer la fenêtre…
    const field = popover.getByLabel('Nom de Messagerie');
    await field.fill('Messagerie Exchange');
    await field.press('Escape');
    await expect(field).toHaveValue('Messagerie');
    await expect(popover).toBeVisible();
    // …un second Échap ferme.
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(manage).toBeFocused();

    // Clic hors de la fenêtre : elle se ferme, et un renommage en cours est gardé.
    await manage.click();
    await popover.getByLabel('Nom de Onboarding').fill('Onboarding 2026');
    await page.mouse.click(200, 600);
    await expect(popover).toBeHidden();
    await expect(rail.getByRole('button', { name: 'Onboarding 2026' })).toBeAttached();
    await removeProjects(page.request, ['Onboarding 2026']);
  });
});
