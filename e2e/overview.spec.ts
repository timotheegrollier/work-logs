import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// La vue d'ensemble des projets : au centre, une voie par projet (§60), par-dessus les autres
// panneaux (§65). jsdom ne voit ni la largeur de la page ni la vue d'une tâche de téléphone :
// on les vérifie ici.
const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

test('accès direct à la vue d’ensemble même quand les panneaux sont repliés', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('worklogs-show-right', '0');
    localStorage.setItem('worklogs-show-procedures', '0');
    localStorage.setItem('worklogs-show-center', '0');
  });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 800, height: 1000 }, { width: 320, height: 700 }, { width: 800, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.locator('#workspace-tasks')).toBeHidden();
    await expect(page.locator('#workspace-procedures')).toBeHidden();
    const button = page.getByRole('button', { name: 'Vue d’ensemble des tâches', exact: true });
    await expect(button).toBeVisible();
    if (viewport.width <= 600 || viewport.height <= 500) {
      const box = (await button.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      await expect(page.locator('.project-strip').getByRole('button', { name: 'Vue d’ensemble des tâches' })).toBeVisible();
    }
    expect(await noHorizontalScroll(page)).toBe(true);
    await button.click();
    await expect(page.getByRole('region', { name: 'Vue d’ensemble des projets' })).toBeVisible();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(await noHorizontalScroll(page)).toBe(true);
    await button.click();
    await expect(page.getByRole('region', { name: 'Vue d’ensemble des projets' })).toBeHidden();
    await expect(button).toHaveAttribute('aria-pressed', 'false');
  }
});

test('la vue attend les données globales et se ferme si une recherche ou une catégorie la filtre', async ({ page, request }) => {
  const project = await post(request, '/api/projects', { name: 'Projet vue globale' });
  const category = await post(request, '/api/categories', { name: 'Catégorie vue globale', project_id: project.id });
  const first = await post(request, '/api/tasks', { title: 'Filtre unique vue', project_id: project.id, category_id: category.id });
  const second = await post(request, '/api/tasks', { title: 'Autre tâche globale', project_id: project.id });
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  let blocked = false;
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const search = page.getByRole('searchbox', { name: 'Rechercher' });
    const searched = page.waitForResponse(response => response.url().includes('/api/state?q=Filtre') && response.ok());
    await search.fill('Filtre unique vue');
    await searched;
    await expect(page.getByRole('region', { name: 'Tâches', exact: true }).getByRole('button', { name: 'Filtre unique vue', exact: true })).toBeVisible();

    // Bloque la nouvelle réponse globale, pas la recherche précédente : aucune
    // suggestion ni action ne doit utiliser l'ancien jeu de tâches filtré.
    await page.route('**/api/state*', async (route) => {
      if (!blocked && !new URL(route.request().url()).search) {
        blocked = true;
        await paused;
      }
      await route.continue();
    });
    const trigger = page.getByRole('button', { name: 'Vue d’ensemble des tâches', exact: true });
    await trigger.click();
    await expect.poll(() => blocked).toBe(true);
    await expect(page.getByText('Chargement de la vue d’ensemble…')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Vue d’ensemble des projets' })).toHaveCount(0);
    resume();
    const overview = page.getByRole('region', { name: 'Vue d’ensemble des projets' });
    await expect(overview).toBeVisible();
    await expect(overview.getByRole('button', { name: 'Filtre unique vue — à faire', exact: true })).toBeVisible();
    await expect(overview.getByRole('button', { name: 'Autre tâche globale — à faire', exact: true })).toBeVisible();
    await search.fill('Filtre');
    await expect(overview).toBeHidden();

    await search.clear();
    await trigger.click();
    await expect(overview).toBeVisible();
    await page.getByRole('button', { name: 'Catégories', exact: true }).click();
    await page.getByRole('button', { name: 'Afficher la catégorie Catégorie vue globale', exact: true }).click();
    await expect(overview).toBeHidden();
  } finally {
    resume();
    await page.unrouteAll({ behavior: 'wait' });
    await request.delete(`/api/tasks/${first.id}`);
    await request.delete(`/api/tasks/${second.id}`);
    await request.delete(`/api/projects/${project.id}`);
  }
});

test('ouvrir la vue depuis une procédure au centre replié ne déplie pas les procédures', async ({ page, request }) => {
  const procedure = await post(request, '/api/entries', { title: 'Procédure vue globale', kind: 'procedure' });
  try {
    await page.addInitScript((id) => localStorage.setItem('worklogs-entry', id), procedure.id);
    await page.goto('/');
    const panels = page.getByRole('group', { name: 'Panneaux latéraux' });
    const procedures = panels.getByRole('button', { name: 'Procédures', exact: true });
    await expect(page.getByLabel('Titre de l’entrée')).toHaveValue('Procédure vue globale');
    await expect(page.locator('#workspace-procedures')).toBeVisible();
    await procedures.click();
    await expect(page.locator('#workspace-procedures')).toBeHidden();
    await panels.getByRole('button', { name: 'Écriture', exact: true }).click();
    await page.getByRole('button', { name: 'Vue d’ensemble des tâches', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Vue d’ensemble des projets' })).toBeVisible();
    await expect(page.locator('#workspace-procedures')).toBeHidden();
    await page.getByRole('button', { name: 'Vue d’ensemble des tâches', exact: true }).click();
    await expect(page.getByLabel('Titre de l’entrée')).toHaveValue('Procédure vue globale');
    await expect(page.locator('#workspace-procedures')).toBeHidden();
  } finally {
    await request.delete(`/api/entries/${procedure.id}`);
  }
});

test('une sauvegarde refusée garde la note ouverte et son brouillon avant la vue d’ensemble', async ({ page, request }) => {
  const entry = await post(request, '/api/entries', { title: 'Brouillon vue globale' });
  try {
    await page.addInitScript((id) => localStorage.setItem('worklogs-entry', id), entry.id);
    await page.goto('/');
    const title = page.getByLabel('Titre de l’entrée');
    await expect(title).toHaveValue('Brouillon vue globale');
    let failSave = true;
    await page.route(`**/api/entries/${entry.id}`, async (route) => {
      if (route.request().method() === 'PUT' && failSave) await route.fulfill({ status: 500, json: { error: 'Enregistrement refusé' } });
      else await route.continue();
    });
    await title.fill('Brouillon conservé');
    const trigger = page.getByRole('button', { name: 'Vue d’ensemble des tâches', exact: true });
    await trigger.click();
    await expect(page.getByText('Enregistrement refusé').first()).toBeVisible();
    await expect(title).toHaveValue('Brouillon conservé');
    await expect(page.getByRole('region', { name: 'Vue d’ensemble des projets' })).toBeHidden();
    failSave = false;
    await trigger.click();
    await expect(page.getByRole('region', { name: 'Vue d’ensemble des projets' })).toBeVisible();
    await expect.poll(async () => (await (await request.get(`/api/entries/${entry.id}`)).json()).title).toBe('Brouillon conservé');
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    await request.delete(`/api/entries/${entry.id}`);
  }
});

test('une voie par projet qui tient en largeur, sur desktop comme sur téléphone', async ({ page, request }) => {
  const project = await post(request, '/api/projects', { name: 'Bassins vue', color: '#d9486e' });
  const other = await post(request, '/api/projects', { name: 'Compta vue', color: '#e0912a' });
  const tasks: { id: string }[] = [];
  try {
    for (let i = 0; i < 15; i++) tasks.push(await post(request, '/api/tasks', { title: `Étude ${i + 1}`, project_id: project.id, status: i === 0 ? 'doing' : 'todo' }));
    for (let i = 0; i < 3; i++) tasks.push(await post(request, '/api/tasks', { title: `Faite ${i + 1}`, project_id: project.id, status: 'done' }));
    tasks.push(await post(request, '/api/tasks', { title: 'Déclaration vue', project_id: other.id, due_date: '2020-01-01' }));

    // Tablette : la liste fusionnée ne doit pas occuper seulement un tiers du panneau.
    await page.setViewportSize({ width: 800, height: 1000 });
    await page.goto('/');
    const lists = page.locator('.board-lists.is-overview');
    const listBox = (await lists.boundingBox())!;
    const columnBox = (await lists.locator('.column').first().boundingBox())!;
    expect(columnBox.width).toBeGreaterThan(listBox.width * 0.9);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    // Le panneau Tâches n'a plus son propre bouton : l'en-tête suffit.
    await expect(page.getByRole('region', { name: 'Tâches', exact: true }).getByRole('button', { name: /Vue d’ensemble/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Vue d’ensemble des tâches', exact: true }).click();
    const overview = page.getByRole('region', { name: 'Vue d’ensemble des projets' });
    await expect(overview).toBeVisible();
    // Elle recouvre les panneaux ; sans suivi IA, aucun bloc vide ne prend la moitié de la largeur.
    await expect(page.locator('#workspace-journal')).toBeHidden();
    await expect(page.locator('#workspace-tasks')).toBeHidden();
    await expect(overview.getByRole('region', { name: 'Bilans et suivis IA' })).toHaveCount(0);
    await expect(overview.getByRole('button', { name: /Activer le suivi IA/ })).toHaveCount(0);
    const work = overview.locator('.overview-work');
    const progress = overview.locator('.overview-progress');
    // Assez large : les textes de l'IA à gauche, la frise à droite, sur la même ligne (§75).
    const left = (await work.boundingBox())!;
    const right = (await progress.boundingBox())!;
    expect(right.x).toBeGreaterThanOrEqual(left.x + left.width);
    expect(Math.abs(right.y - left.y)).toBeLessThan(4);
    const stacked = async () => expect((await progress.boundingBox())!.y).toBeGreaterThanOrEqual((await work.boundingBox())!.y + (await work.boundingBox())!.height);
    const lane = overview.getByRole('listitem', { name: /^Bassins vue :/ });
    await expect(lane.getByRole('listitem').or(lane).first()).toBeVisible();
    await expect(lane.locator('.lane-node')).toHaveCount(10);
    await expect(lane.getByText('+5')).toBeVisible();
    // « +5 » reste au bout de la piste, sur la ligne des nœuds qu'il prolonge.
    const sameRow = async () => {
      const more = (await lane.getByText('+5').boundingBox())!;
      const last = (await lane.locator('.lane-node').last().boundingBox())!;
      expect(Math.abs(more.y + more.height / 2 - (last.y + last.height / 2))).toBeLessThan(4);
      expect(more.x).toBeGreaterThan(last.x);
    };
    await sameRow();
    // Le compteur des terminées garde l'encre du texte : du blanc sur la couleur du projet est illisible.
    await expect(lane.locator('.lane-done')).not.toHaveCSS('color', 'rgb(255, 255, 255)');
    await expect(lane.getByText('3/18 · 17 %')).toBeVisible();
    await expect(lane.getByText('Étude 1', { exact: true })).toBeVisible();
    await expect(overview.getByRole('listitem', { name: /^Compta vue :/ }).locator('.lane-node.is-late')).toHaveCount(1);
    expect(await noHorizontalScroll(page)).toBe(true);
    // Les nœuds d'une voie restent sur sa ligne, dans la page.
    const box = (await lane.boundingBox())!;
    const main = (await page.locator('main.center').boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(main.x + main.width + 1);
    // « Tâches » rouvre son panneau à côté de la vue, sans la fermer ni déborder.
    await page.getByRole('group', { name: 'Panneaux latéraux' }).getByRole('button', { name: 'Tâches', exact: true }).click();
    await expect(page.locator('#workspace-tasks')).toBeVisible();
    await expect(overview).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
    await sameRow();

    // Tablette : la vue passe seule en tête de page, sans le journal au-dessus.
    await page.setViewportSize({ width: 800, height: 1000 });
    await page.reload();
    await page.getByRole('button', { name: 'Vue d’ensemble des tâches', exact: true }).click();
    await expect(overview).toBeVisible();
    await expect(page.locator('#workspace-journal')).toBeHidden();
    expect((await overview.boundingBox())!.y).toBeLessThan(300);
    await stacked();
    expect(await noHorizontalScroll(page)).toBe(true);

    // Téléphone : la vue s'ouvre dans Écriture, en une colonne, sans débordement.
    await page.setViewportSize({ width: 412, height: 860 });
    await page.reload();
    const nav = (name: string) => page.getByRole('group', { name: 'Panneaux latéraux' }).getByRole('button', { name, exact: true });
    await nav('Tâches').click();
    await page.getByRole('button', { name: 'Vue d’ensemble des tâches', exact: true }).click();
    await expect(overview).toBeVisible();
    await expect(nav('Écriture')).toHaveAttribute('aria-pressed', 'true');
    await stacked();
    expect(await noHorizontalScroll(page)).toBe(true);
    await sameRow();
    await lane.locator('.lane-node').first().click();
    await expect(overview).toBeHidden();
    await expect(nav('Tâches')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('region', { name: 'Tâches', exact: true }).getByLabel('Titre de la tâche')).toHaveValue('Étude 1');
    await expect(page.getByRole('region', { name: 'Tâches', exact: true }).getByLabel('Titre de la tâche')).toBeFocused();
  } finally {
    for (const task of tasks) await request.delete(`/api/tasks/${task.id}`);
    await request.delete(`/api/projects/${project.id}`);
    await request.delete(`/api/projects/${other.id}`);
  }
});

test('choisir une tâche ou une entrée suivie ferme la vue et affiche la source, même une tâche terminée', async ({ page, request }) => {
  const project = await post(request, '/api/projects', { name: 'Navigation suivis vue' });
  const task = await post(request, '/api/tasks', { title: 'Préparer la revue navigation', project_id: project.id });
  const done = await post(request, '/api/tasks', { title: 'Contrôle terminé navigation', project_id: project.id, status: 'done' });
  const entry = await post(request, '/api/entries', { title: 'Journal suivi navigation', project_id: project.id, content_md: 'Contrôle réalisé et validé.' });
  // Le mode manuel rend les suivis visibles sans démarrer de requête IA.
  for (const [kind, id] of [['task', done.id], ['entry', entry.id]]) {
    const result = await request.put(`/api/follow-up/${kind}/${id}`, { data: { enabled: false } });
    expect(result.ok()).toBeTruthy();
  }
  try {
    await page.addInitScript(() => localStorage.setItem('worklogs-show-right', '0'));
    const overview = page.getByRole('region', { name: 'Vue d’ensemble des projets', exact: true });
    const board = page.getByRole('region', { name: 'Tâches', exact: true });
    for (const viewport of [{ width: 1440, height: 900 }, { width: 800, height: 1000 }, { width: 375, height: 812 }]) {
      await page.setViewportSize(viewport);
      await page.goto('/');
      const trigger = page.getByRole('button', { name: 'Vue d’ensemble des tâches', exact: true });
      await trigger.click();
      await overview.getByRole('button', { name: `${task.title} — à faire`, exact: true }).click();
      await expect(overview).toBeHidden();
      await expect(board.getByLabel('Titre de la tâche')).toHaveValue(task.title);
      await expect(board.getByLabel('Titre de la tâche')).toBeFocused();

      await trigger.click();
      await overview.getByRole('button', { name: `Ouvrir la tâche ${done.title}`, exact: true }).click();
      await expect(overview).toBeHidden();
      await expect(board.getByLabel('Titre de la tâche')).toHaveValue(done.title);
      await expect(board.getByLabel('Titre de la tâche')).toBeFocused();
      await expect(board.getByRole('button', { name: /Masquer les tâches terminées/ })).toHaveAttribute('aria-expanded', 'true');

      await trigger.click();
      await overview.getByRole('button', { name: `Ouvrir l’entrée ${entry.title}`, exact: true }).click();
      await expect(overview).toBeHidden();
      await expect(page.getByLabel('Titre de l’entrée')).toHaveValue(entry.title);
      expect(await noHorizontalScroll(page)).toBe(true);
    }
  } finally {
    await request.delete(`/api/tasks/${task.id}`);
    await request.delete(`/api/tasks/${done.id}`);
    await request.delete(`/api/entries/${entry.id}`);
    await request.delete(`/api/projects/${project.id}`);
  }
});

test('une tâche documentée ouvre son entrée liée la plus récente depuis un nœud ou son bilan', async ({ page, request }) => {
  const project = await post(request, '/api/projects', { name: 'Entrées des tâches vue' });
  const task = await post(request, '/api/tasks', { title: 'Reprendre le diagnostic documenté vue', project_id: project.id });
  const done = await post(request, '/api/tasks', { title: 'Intervention documentée terminée vue', project_id: project.id, status: 'done' });
  // La plus ancienne est créée et liée en dernier : l'ouverture suit la date de
  // l'entrée, pas la date de création du lien ni celle de la note.
  const latest = await post(request, '/api/entries', { title: 'Dernier avancement du diagnostic vue', project_id: project.id, entry_date: '2026-11-05', content_md: 'Le raccord est commandé ; contrôle à prévoir.' });
  const older = await post(request, '/api/entries', { title: 'Ancien diagnostic documenté vue', project_id: project.id, entry_date: '2026-10-01', content_md: 'Le raccord doit être commandé.' });
  const completed = await post(request, '/api/entries', { title: 'Compte rendu final de l’intervention vue', project_id: project.id, entry_date: '2026-11-04', content_md: 'Raccord posé et contrôle terminé.' });
  await post(request, `/api/tasks/${task.id}/documents/${latest.id}`, {});
  await post(request, `/api/tasks/${task.id}/documents/${older.id}`, {});
  await post(request, `/api/tasks/${done.id}/documents/${completed.id}`, {});
  const followed = await request.put(`/api/follow-up/task/${done.id}`, { data: { enabled: false } });
  expect(followed.ok()).toBeTruthy();
  try {
    const state = await (await request.get('/api/state')).json();
    expect(state.tasks.find((item: { id: string }) => item.id === task.id).documents.map((item: { id: string }) => item.id)).toEqual([task.documents[0].id, latest.id, older.id]);
    await page.addInitScript(() => localStorage.setItem('worklogs-show-right', '0'));
    for (const viewport of [{ width: 1440, height: 900 }, { width: 800, height: 1000 }, { width: 375, height: 812 }]) {
      await page.setViewportSize(viewport);
      await page.goto('/');
      const trigger = page.getByRole('button', { name: 'Vue d’ensemble des tâches', exact: true });
      const overview = page.getByRole('region', { name: 'Vue d’ensemble des projets', exact: true });
      const expectEntry = async (title: string) => {
        await expect(overview).toBeHidden();
        await expect(page.getByLabel('Titre de l’entrée')).toHaveValue(title);
        if (viewport.width <= 600) {
          await expect(page.getByRole('group', { name: 'Panneaux latéraux' }).getByRole('button', { name: 'Écriture', exact: true })).toHaveAttribute('aria-pressed', 'true');
        }
        expect(await noHorizontalScroll(page)).toBe(true);
      };

      await trigger.click();
      await overview.getByRole('group', { name: `Tâches ouvertes de ${project.name}`, exact: true }).getByRole('button', { name: `${task.title} — à faire`, exact: true }).click();
      await expectEntry(latest.title);

      await trigger.click();
      await overview.getByRole('region', { name: 'Bilans et suivis IA', exact: true }).getByRole('button', { name: `Ouvrir la tâche ${done.title}`, exact: true }).click();
      await expectEntry(completed.title);
    }
  } finally {
    await request.delete(`/api/tasks/${task.id}`);
    await request.delete(`/api/tasks/${done.id}`);
    for (const entry of [latest, older, completed]) await request.delete(`/api/entries/${entry.id}`);
    await request.delete(`/api/projects/${project.id}`);
  }
});

test('revenir à une carte depuis la vue conserve les brouillons de tâche, même après avoir ouvert une autre carte', async ({ page, request }) => {
  const project = await post(request, '/api/projects', { name: 'Brouillons navigation vue' });
  const first = await post(request, '/api/tasks', { title: 'Première tâche brouillon vue', project_id: project.id });
  const second = await post(request, '/api/tasks', { title: 'Seconde tâche brouillon vue', project_id: project.id });
  try {
    await page.goto('/');
    const trigger = page.getByRole('button', { name: 'Vue d’ensemble des tâches', exact: true });
    const overview = page.getByRole('region', { name: 'Vue d’ensemble des projets', exact: true });
    const board = page.getByRole('region', { name: 'Tâches', exact: true });
    const title = board.getByLabel('Titre de la tâche');
    await trigger.click();
    await overview.getByRole('button', { name: `${first.title} — à faire`, exact: true }).click();
    await title.fill('Première tâche : brouillon gardé');
    await trigger.click();
    await overview.getByRole('button', { name: `${first.title} — à faire`, exact: true }).click();
    await expect(title).toHaveValue('Première tâche : brouillon gardé');
    await trigger.click();
    await overview.getByRole('button', { name: `${second.title} — à faire`, exact: true }).click();
    await title.fill('Seconde tâche : brouillon gardé');
    await trigger.click();
    await overview.getByRole('button', { name: `${first.title} — à faire`, exact: true }).click();
    await expect(title).toHaveValue('Première tâche : brouillon gardé');
    expect((await (await request.get('/api/state')).json()).tasks.find((task: { id: string }) => task.id === first.id).title).toBe(first.title);
    await board.locator('.is-editing').getByRole('button', { name: 'Annuler', exact: true }).click();
    await trigger.click();
    await overview.getByRole('button', { name: `${first.title} — à faire`, exact: true }).click();
    await expect(title).toHaveValue(first.title);
  } finally {
    await request.delete(`/api/tasks/${first.id}`);
    await request.delete(`/api/tasks/${second.id}`);
    await request.delete(`/api/projects/${project.id}`);
  }
});

test('le bouton pour mettre en cours se voit au repos, plein au survol', async ({ page, request }) => {
  const task = await post(request, '/api/tasks', { title: 'Tâche au repos vue' });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const button = page.getByRole('button', { name: 'Mettre en cours Tâche au repos vue' });
    // 0,7 : le contraste de 3:1 d'une commande, sans attendre le survol (§47).
    await expect(button).toHaveCSS('opacity', '0.7');
    await page.getByRole('region', { name: 'Tâches', exact: true }).getByRole('button', { name: 'Tâche au repos vue', exact: true }).hover();
    await expect(button).toHaveCSS('opacity', '1');
  } finally {
    await request.delete(`/api/tasks/${task.id}`);
  }
});

test.describe('tactile', () => {
  test.use({ hasTouch: true });
  test('le bouton pour mettre en cours reste visible sans survol', async ({ page, request }) => {
    const task = await post(request, '/api/tasks', { title: 'Tâche tactile vue' });
    try {
      await page.setViewportSize({ width: 412, height: 860 });
      await page.goto('/');
      await page.getByRole('group', { name: 'Panneaux latéraux' }).getByRole('button', { name: 'Tâches', exact: true }).click();
      const button = page.getByRole('button', { name: 'Mettre en cours Tâche tactile vue' });
      await expect(button).toBeVisible();
      await expect(button).toHaveCSS('opacity', '1');
    } finally {
      await request.delete(`/api/tasks/${task.id}`);
    }
  });
});
