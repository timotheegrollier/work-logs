import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const PREFIX = 'Classement e2e';
const categories = (page: Page) => page.getByRole('region', { name: 'Catégories', exact: true });
const journal = (page: Page) => page.getByRole('region', { name: 'Journal', exact: true });
const board = (page: Page) => page.getByRole('region', { name: 'Tâches', exact: true });

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
  await categories(page).getByLabel('Nom de la catégorie').fill(name);
  await categories(page).getByRole('button', { name: 'Enregistrer la catégorie', exact: true }).click();
  await expect(categories(page).getByRole('button', { name: `Afficher la catégorie ${name}`, exact: true })).toBeVisible();
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
    await categories(page).getByRole('button', { name: '＋ Catégorie', exact: true }).click();
    await saveCategory(page, 'Préparation');
    await categories(page).getByRole('button', { name: 'Ajouter une sous-catégorie à Préparation', exact: true }).click();
    await saveCategory(page, 'Déploiement');
    await categories(page).getByRole('button', { name: '＋ Catégorie', exact: true }).click();
    await saveCategory(page, 'Exploitation');
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

    // Le filtre parent inclut les descendants, puis les groupes gardent leur chemin.
    await categories(page).getByRole('button', { name: 'Afficher la catégorie Préparation', exact: true }).click();
    await expect(journal(page).getByRole('button', { name: /Bilan installation/ })).toBeVisible();
    await expect(journal(page).getByRole('button', { name: /Note non classée/ })).toBeHidden();
    await expect(board(page).getByRole('button', { name: 'Préparer déploiement', exact: true })).toBeVisible();
    await categories(page).getByLabel('Regrouper par catégorie').check();
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
    await page.screenshot({ path: '/tmp/worklogs-categories-desktop.png', fullPage: true });

    // Déplacer le groupe modifie ses chemins sans changer les associations.
    await categories(page).getByRole('button', { name: 'Modifier la catégorie Déploiement', exact: true }).click();
    await categories(page).getByLabel('Catégorie parente').selectOption(destination.id);
    await categories(page).getByRole('button', { name: 'Enregistrer la catégorie', exact: true }).click();
    await expect(categories(page).getByRole('form', { name: 'Modifier une catégorie', exact: true })).toBeHidden();
    await categories(page).getByRole('button', { name: 'Afficher la catégorie Déploiement', exact: true }).click();
    await expect(page.getByLabel('Catégorie de l’entrée')).toHaveValue(child.id);
    await expect(journal(page).getByRole('heading', { name: /Exploitation \/ Déploiement/ })).toBeVisible();

    // La note ouverte reçoit le parent après suppression. La prochaine frappe ne
    // doit pas réintroduire l'ancien identifiant dans l'enregistrement automatique.
    await board(page).getByRole('button', { name: 'Préparer déploiement', exact: true }).click();
    await page.getByLabel('Titre de la tâche', { exact: true }).fill('Préparer déploiement vérifié');
    page.once('dialog', (dialog) => dialog.accept());
    await categories(page).getByRole('button', { name: 'Supprimer la catégorie Déploiement', exact: true }).click();
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
    await categories(page).getByRole('button', { name: `Afficher la catégorie ${parent.name}`, exact: true }).click();
    await categories(page).getByLabel('Regrouper par catégorie').check();
    await expect(journal(page).getByRole('button', { name: /Compte rendu de la prochaine intervention/ })).toBeVisible();
    await expect(board(page).getByRole('button', { name: 'Valider les postes administratifs', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    // Le formulaire est utilisable au clavier tactile, même avec un chemin profond.
    await categories(page).getByRole('button', { name: `Modifier la catégorie ${leaf.name}`, exact: true }).click();
    await expect(categories(page).getByLabel('Nom de la catégorie')).toBeVisible();
    await expect(categories(page).getByLabel('Catégorie parente')).toHaveValue(child.id);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await categories(page).getByRole('button', { name: 'Annuler', exact: true }).click();
    await categories(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: '/tmp/worklogs-categories-mobile.png', fullPage: true });
  });
});
