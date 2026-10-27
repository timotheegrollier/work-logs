import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const PREFIX = 'Classement e2e';
const trigger = (page: Page) => page.getByRole('button', { name: /^Catégories/ });
const sheet = (page: Page) => page.getByRole('dialog', { name: /^Catégories/ });
const journal = (page: Page) => page.getByRole('region', { name: 'Journal', exact: true });
const board = (page: Page) => page.getByRole('region', { name: 'Tâches', exact: true });
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

/** La fenêtre des catégories, ouverte depuis le bandeau des projets si besoin. */
async function categories(page: Page) {
  if (!(await sheet(page).isVisible())) await trigger(page).click();
  await expect(sheet(page)).toBeVisible();
  return sheet(page);
}

async function create(request: APIRequestContext, path: string, data: Record<string, unknown>) {
  const response = await request.post(`/api/${path}`, { data });
  expect(response.ok()).toBe(true);
  return response.json();
}

// Chaque parcours dispose de son propre projet. Supprimer d'abord son contenu :
// supprimer le projet seul le détacherait et polluerait les autres parcours.
test.afterEach(async ({ request }) => {
  const state = await (await request.get('/api/state')).json();
  for (const project of state.projects.filter((item: { name: string }) => item.name.startsWith(PREFIX))) {
    for (const task of state.tasks.filter((item: { project_id: string }) => item.project_id === project.id)) {
      await request.delete(`/api/tasks/${task.id}`);
    }
    for (const entry of state.entries.filter((item: { project_id: string }) => item.project_id === project.id)) {
      await request.delete(`/api/entries/${entry.id}`);
    }
    await request.delete(`/api/projects/${project.id}`);
  }
});

async function chooseProject(page: Page, name: string) {
  await page.goto('/');
  await expect(journal(page)).toBeVisible();
  await page.getByRole('group', { name: 'Filtrer par projet' }).getByRole('button', { name: new RegExp('^' + name) }).click();
}

async function saveCategory(page: Page, name: string) {
  await sheet(page).getByLabel('Nom de la catégorie').fill(name);
  await sheet(page).getByRole('button', { name: 'Enregistrer la catégorie', exact: true }).click();
  await expect(sheet(page).getByRole('button', { name: `Afficher la catégorie ${name}`, exact: true })).toBeVisible();
}

test.describe('catégories desktop', () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test('arborescence, classement, groupes, déplacement et suppression sans perdre le brouillon', async ({ page, request }) => {
    const project = await create(request, 'projects', { name: `${PREFIX} desktop`, color: '#0ea5e9' });
    const note = await create(request, 'entries', { title: 'Bilan installation', project_id: project.id, content_md: 'Serveur prêt.' });
    await create(request, 'entries', { title: 'Note non classée', project_id: project.id });
    const task = await create(request, 'tasks', { title: 'Préparer déploiement', project_id: project.id });
    await chooseProject(page, project.name);

    // Création par l'interface, puis sous-catégorie directement depuis sa parente.
    await (await categories(page)).getByRole('button', { name: '＋ Catégorie', exact: true }).click();
    await saveCategory(page, 'Préparation');
    await sheet(page).getByRole('button', { name: 'Ajouter une sous-catégorie à Préparation', exact: true }).click();
    await saveCategory(page, 'Déploiement');
    await sheet(page).getByRole('button', { name: '＋ Catégorie', exact: true }).click();
    await saveCategory(page, 'Exploitation');
    await sheet(page).getByRole('button', { name: 'Fermer', exact: true }).click();
    await expect(trigger(page)).toBeFocused();
    const state = await (await request.get('/api/state')).json();
    const parent = state.categories.find((item: { name: string }) => item.name === 'Préparation');
    const child = state.categories.find((item: { name: string }) => item.name === 'Déploiement');
    const destination = state.categories.find((item: { name: string }) => item.name === 'Exploitation');

    // Un même classement est visible sur la note et sur la carte de tâche.
    await journal(page).getByRole('button', { name: /Bilan installation/ }).click();
    await expect(page.getByLabel('Titre de l’entrée')).toHaveValue('Bilan installation');
    await page.getByLabel('Catégorie de l’entrée').selectOption(child.id);
    await expect.poll(async () => (await (await request.get(`/api/entries/${note.id}`)).json()).category_id).toBe(child.id);
    await board(page).getByRole('button', { name: 'Préparer déploiement', exact: true }).click();
    await page.getByLabel('Catégorie de la tâche').selectOption(child.id);
    await board(page).getByRole('button', { name: 'Enregistrer', exact: true }).click();
    await expect.poll(async () => (await (await request.get('/api/state')).json()).tasks.find((item: { id: string }) => item.id === task.id).category_id).toBe(child.id);
    await expect(journal(page).locator('.category-badge', { hasText: 'Préparation / Déploiement' })).toBeVisible();
    await expect(board(page).locator('.category-badge', { hasText: 'Préparation / Déploiement' })).toBeVisible();

    // Les deux cibles ont un ordre manuel différent de l'ordre des groupes.
    const firstTarget = await create(request, 'tasks', { title: 'Vérifier les services', project_id: project.id, category_id: child.id, status: 'doing' });
    const secondTarget = await create(request, 'tasks', { title: 'Contrôler la recette', project_id: project.id, category_id: parent.id, status: 'doing' });

    // Le filtre parent inclut les descendants (la fenêtre se referme sur le choix),
    // puis les groupes gardent leur chemin.
    await (await categories(page)).getByRole('button', { name: 'Afficher la catégorie Préparation', exact: true }).click();
    await expect(sheet(page)).toBeHidden();
    await expect(trigger(page)).toHaveAccessibleName('Catégories : Préparation');
    await expect(journal(page).getByRole('button', { name: /Bilan installation/ })).toBeVisible();
    await expect(journal(page).getByRole('button', { name: /Note non classée/ })).toBeHidden();
    await expect(board(page).getByRole('button', { name: 'Préparer déploiement', exact: true })).toBeVisible();
    await (await categories(page)).getByLabel('Regrouper par catégorie').check();
    await page.keyboard.press('Escape');
    await expect(sheet(page)).toBeHidden();
    await expect(journal(page).getByRole('heading', { name: /Préparation \/ Déploiement/ })).toBeVisible();
    await expect(board(page).getByRole('heading', { name: /Préparation \/ Déploiement/ }).first()).toBeVisible();

    const card = (title: string) => board(page).locator('.card').filter({ has: page.getByRole('button', { name: title, exact: true }) });
    const originalTasks = (await (await request.get('/api/state')).json()).tasks;
    const firstPosition = originalTasks.find((item: { id: string }) => item.id === firstTarget.id).position;
    const targetPosition = originalTasks.find((item: { id: string }) => item.id === secondTarget.id).position;
    await card('Préparer déploiement').dragTo(card('Contrôler la recette'));
    await expect.poll(async () => {
      const tasks = (await (await request.get('/api/state')).json()).tasks;
      return [firstTarget.id, task.id, secondTarget.id].map((id) => {
        const current = tasks.find((item: { id: string }) => item.id === id);
        return { id: current.id, status: current.status, position: current.position };
      });
    }).toEqual([
      { id: firstTarget.id, status: 'doing', position: firstPosition },
      { id: task.id, status: 'doing', position: targetPosition },
      { id: secondTarget.id, status: 'doing', position: targetPosition + 1 },
    ]);
    await expect(card('Préparer déploiement').locator('.category-badge')).toHaveText('Préparation / Déploiement');
    await page.screenshot({ path: '/tmp/worklogs-categories-desktop.png', fullPage: true, animations: 'disabled' });

    // Déplacer le groupe modifie ses chemins sans changer les associations.
    await (await categories(page)).getByRole('button', { name: 'Modifier la catégorie Déploiement', exact: true }).click();
    await sheet(page).getByLabel('Catégorie parente').selectOption(destination.id);
    await sheet(page).getByRole('button', { name: 'Enregistrer la catégorie', exact: true }).click();
    await expect(sheet(page).getByRole('form', { name: 'Modifier une catégorie', exact: true })).toBeHidden();
    await sheet(page).getByRole('button', { name: 'Afficher la catégorie Déploiement', exact: true }).click();
    await expect(page.getByLabel('Catégorie de l’entrée')).toHaveValue(child.id);
    await expect(journal(page).getByRole('heading', { name: /Exploitation \/ Déploiement/ })).toBeVisible();

    // La note ouverte reçoit le parent après suppression. La prochaine frappe ne
    // doit pas réintroduire l'ancien identifiant dans l'enregistrement automatique.
    await board(page).getByRole('button', { name: 'Préparer déploiement', exact: true }).click();
    await page.getByLabel('Titre de la tâche', { exact: true }).fill('Préparer déploiement vérifié');
    page.once('dialog', (dialog) => dialog.accept());
    await (await categories(page)).getByRole('button', { name: 'Supprimer la catégorie Déploiement', exact: true }).click();
    await expect(sheet(page).getByRole('button', { name: 'Afficher la catégorie Déploiement', exact: true })).toBeHidden();
    await sheet(page).getByRole('button', { name: 'Fermer', exact: true }).click();
    await expect(page.getByLabel('Catégorie de l’entrée')).toHaveValue(destination.id);
    await expect(page.getByLabel('Catégorie de la tâche')).toHaveValue(destination.id);
    await expect(page.getByLabel('Titre de la tâche', { exact: true })).toHaveValue('Préparer déploiement vérifié');
    await board(page).getByRole('button', { name: 'Enregistrer', exact: true }).click();
    await expect.poll(async () => {
      const updated = (await (await request.get('/api/state')).json()).tasks.find((item: { id: string }) => item.id === task.id);
      return { category_id: updated.category_id, title: updated.title };
    }).toEqual({ category_id: destination.id, title: 'Préparer déploiement vérifié' });
    await page.getByLabel('Titre de l’entrée').fill('Bilan installation vérifié');
    await page.getByLabel('Titre de l’entrée').press('Control+s');
    await expect.poll(async () => {
      const updated = await (await request.get(`/api/entries/${note.id}`)).json();
      return { category_id: updated.category_id, title: updated.title };
    }).toEqual({ category_id: destination.id, title: 'Bilan installation vérifié' });
    await page.reload();
    await expect(page.getByLabel('Catégorie de l’entrée')).toHaveValue(destination.id);
    await expect(page.getByLabel('Titre de l’entrée')).toHaveValue('Bilan installation vérifié');
  });

  test('lier une note classée à une tâche libre lui donne sa catégorie, visible sur la carte', async ({ page, request }) => {
    const project = await create(request, 'projects', { name: `${PREFIX} héritage`, color: '#10b981' });
    const category = await create(request, 'categories', { name: 'Câblage', project_id: project.id });
    await create(request, 'entries', { title: 'Plan du câblage', project_id: project.id, category_id: category.id });
    const task = await create(request, 'tasks', { title: 'Tirer les câbles', project_id: project.id });
    await chooseProject(page, project.name);
    const card = board(page).locator('.card').filter({ has: page.getByRole('button', { name: 'Tirer les câbles', exact: true }) });
    await expect(card.locator('.category-badge')).toHaveCount(0);
    await card.getByRole('button', { name: 'Lier des documents', exact: true }).click();
    await card.getByRole('checkbox', { name: 'Lier Plan du câblage à Tirer les câbles', exact: true }).check();
    await card.getByRole('button', { name: /Relier la sélection/ }).click();
    await expect(card.locator('.category-badge')).toHaveText('Câblage');
    await expect.poll(async () => (await (await request.get('/api/state')).json()).tasks.find((item: { id: string }) => item.id === task.id).category_id).toBe(category.id);
  });
});

test.describe('catégories mobile', () => {
  test.use({ viewport: { width: 412, height: 860 }, hasTouch: true });

  test('les chemins longs, filtres et réglages restent accessibles sans débordement', async ({ page, request }) => {
    const project = await create(request, 'projects', { name: `${PREFIX} mobile`, color: '#8b5cf6' });
    const parent = await create(request, 'categories', { name: 'Infrastructure et services du bâtiment principal', project_id: project.id });
    const child = await create(request, 'categories', { name: 'Déploiement des postes du service administratif', project_id: project.id, parent_id: parent.id });
    const leaf = await create(request, 'categories', { name: 'Validation et objectifs de la prochaine intervention', project_id: project.id, parent_id: child.id });
    await create(request, 'entries', { title: 'Compte rendu de la prochaine intervention', project_id: project.id, category_id: leaf.id, content_md: 'Prévoir le déploiement des postes.' });
    await create(request, 'tasks', { title: 'Valider les postes administratifs', project_id: project.id, category_id: leaf.id });
    await chooseProject(page, project.name);
    // Filtré, le bouton du bandeau montre son nom sans élargir la page.
    await (await categories(page)).getByRole('button', { name: `Afficher la catégorie ${parent.name}`, exact: true }).click();
    await expect(trigger(page)).toHaveAccessibleName(`Catégories : ${parent.name}`);
    expect(await noOverflow(page)).toBe(true);
    await (await categories(page)).getByLabel('Regrouper par catégorie').check();
    await sheet(page).getByRole('button', { name: 'Fermer', exact: true }).click();
    await expect(journal(page).getByRole('button', { name: /Compte rendu de la prochaine intervention/ })).toBeVisible();
    await expect(board(page).getByRole('button', { name: 'Valider les postes administratifs', exact: true })).toBeVisible();
    expect(await noOverflow(page)).toBe(true);

    // Le formulaire est utilisable au clavier tactile, même avec un chemin profond.
    await (await categories(page)).getByRole('button', { name: `Modifier la catégorie ${leaf.name}`, exact: true }).click();
    await expect(sheet(page).getByLabel('Nom de la catégorie')).toBeVisible();
    await expect(sheet(page).getByLabel('Catégorie parente')).toHaveValue(child.id);
    const parentBounds = await sheet(page).getByLabel('Catégorie parente').boundingBox();
    expect(parentBounds).not.toBeNull();
    expect(parentBounds!.x).toBeGreaterThanOrEqual(0);
    expect(parentBounds!.x + parentBounds!.width).toBeLessThanOrEqual(412);
    expect(await noOverflow(page)).toBe(true);
    await page.screenshot({ path: '/tmp/worklogs-categories-mobile.png', animations: 'disabled' });
    await sheet(page).getByRole('button', { name: 'Annuler', exact: true }).click();
    await expect(sheet(page).getByLabel('Nom de la catégorie')).toHaveCount(0);
  });
});

test('catégories : un bouton dans le bandeau, une fenêtre pour filtrer et ranger, au clavier et sur petits écrans', async ({ page, request }) => {
  const project = await create(request, 'projects', { name: `${PREFIX} compact`, color: '#0ea5e9' });
  const root = await create(request, 'categories', { name: 'Infrastructure et services du bâtiment principal', project_id: project.id });
  const branches = await Promise.all(Array.from({ length: 18 }, (_, index) => create(request, 'categories', {
    name: `Service ${String(index + 1).padStart(2, '0')} et suivi des interventions de maintenance`, project_id: project.id, parent_id: root.id,
  })));
  await create(request, 'entries', { title: 'Compte rendu classé', project_id: project.id, category_id: branches[0].id });
  await create(request, 'entries', { title: 'Compte rendu à ranger', project_id: project.id });
  await chooseProject(page, project.name);

  // Le nombre et la profondeur des catégories n'ajoutent aucune rangée : un seul bouton,
  // dans le bandeau des projets, à toutes les tailles.
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 800, height: 900 }, { width: 412, height: 860 }, { width: 360, height: 780 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await expect(trigger(page)).toBeVisible();
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
    expect((await page.locator('.project-strip').boundingBox())!.height).toBeLessThanOrEqual(60);
    expect(await page.getByRole('button', { name: /^Modifier la catégorie/ }).count()).toBe(0);
    expect(await noOverflow(page)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await (await categories(page)).getByRole('button', { name: `Afficher la catégorie ${root.name}`, exact: true }).click();
  await expect(journal(page).getByRole('button', { name: /Compte rendu classé/ })).toBeVisible();
  await expect(journal(page).getByRole('button', { name: /Compte rendu à ranger/ })).toBeHidden();
  await (await categories(page)).getByRole('button', { name: 'Sans catégorie', exact: true }).click();
  await expect(journal(page).getByRole('button', { name: /Compte rendu à ranger/ })).toBeVisible();
  await expect(journal(page).getByRole('button', { name: /Compte rendu classé/ })).toBeHidden();
  await (await categories(page)).getByRole('button', { name: 'Toutes les catégories', exact: true }).click();
  await expect(trigger(page)).toHaveAccessibleName('Catégories');

  // Au fond d'un grand arbre, le formulaire reste en tête de la fenêtre.
  // Échap le referme et rend le focus à ✎, puis un second Échap ferme la fenêtre.
  await trigger(page).click();
  await expect(sheet(page).getByRole('button', { name: 'Toutes les catégories', exact: true })).toBeFocused();
  const edit = sheet(page).getByRole('button', { name: `Modifier la catégorie ${branches[17].name}`, exact: true });
  await edit.click();
  const name = sheet(page).getByLabel('Nom de la catégorie', { exact: true });
  await expect(name).toBeFocused();
  await expect(name).toBeInViewport();
  await name.fill('Brouillon gardé');
  await name.press('Escape');
  await expect(name).toHaveCount(0);
  await expect(edit).toBeFocused();
  await edit.press('Escape');
  await expect(sheet(page)).toBeHidden();
  await expect(trigger(page)).toBeFocused();

  // Entrée valide le nom ; seul le formulaire se referme et « ＋ Catégorie » reprend le focus.
  await trigger(page).click();
  const add = sheet(page).getByRole('button', { name: '＋ Catégorie', exact: true });
  await add.click();
  await name.fill('Validation au clavier');
  await name.press('Enter');
  await expect(sheet(page).getByRole('button', { name: 'Modifier la catégorie Validation au clavier', exact: true })).toBeAttached();
  await expect(add).toBeFocused();
  await expect(name).toHaveCount(0);
  await expect(sheet(page)).toBeVisible();
  await page.keyboard.press('Escape');

  // Captures : bandeau fermé et fenêtre ouverte, clair et sombre.
  for (const theme of ['light', 'dark']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: 'Changer de thème' }).click();
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 412, height: 860 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      await page.locator('.app').evaluate((el) => el.scrollTo(0, 0));
      await page.screenshot({ path: `/tmp/worklogs-ui-${theme}-${viewport.width}x${viewport.height}.png`, animations: 'disabled' });
      await trigger(page).click();
      await page.screenshot({ path: `/tmp/worklogs-ui-${theme}-${viewport.width}x${viewport.height}-categories.png`, animations: 'disabled' });
      await page.keyboard.press('Escape');
      await expect(sheet(page)).toBeHidden();
    }
  }
});

test.describe('catégories tablette tactile', () => {
  test.use({ viewport: { width: 800, height: 900 }, hasTouch: true });

  test('cibles tactiles et formulaire lisible sans débordement à 800 px', async ({ page, request }) => {
    const project = await create(request, 'projects', { name: `${PREFIX} tablette`, color: '#8b5cf6' });
    const category = await create(request, 'categories', { name: 'Infrastructure et services du bâtiment principal', project_id: project.id });
    await chooseProject(page, project.name);
    expect((await trigger(page).boundingBox())!.height).toBeGreaterThanOrEqual(40);
    const bar = await categories(page);
    for (const button of await bar.locator('.category-node .icon').all()) {
      const bounds = (await button.boundingBox())!;
      expect(bounds.width).toBeGreaterThanOrEqual(44);
      expect(bounds.height).toBeGreaterThanOrEqual(44);
    }
    await bar.getByRole('button', { name: `Modifier la catégorie ${category.name}`, exact: true }).click();
    const name = bar.getByLabel('Nom de la catégorie', { exact: true });
    await expect(name).toBeFocused();
    await name.fill('Infrastructure renommée sur tablette');
    for (const field of await bar.getByRole('form').locator('input, select').all()) {
      const bounds = (await field.boundingBox())!;
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(800);
    }
    await expect(name).toHaveCSS('font-size', '16px');
    expect(await noOverflow(page)).toBe(true);
    await page.screenshot({ path: '/tmp/worklogs-ui-tablet-touch-form.png', animations: 'disabled' });
    await name.press('Enter');
    await expect(bar.getByRole('button', { name: 'Modifier la catégorie Infrastructure renommée sur tablette', exact: true })).toBeAttached();
  });
});
