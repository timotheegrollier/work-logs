import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function configure(page: Page, project: string, entry: string) {
  await page.addInitScript(({ project, entry }) => {
    localStorage.setItem('worklogs-ai-key', 'cle-suivi-e2e');
    localStorage.setItem('worklogs-project', project);
    localStorage.setItem('worklogs-entry', entry);
  }, { project, entry });
}

async function cleanProject(page: Page, request: APIRequestContext, id: string) {
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'wait' });
  const state = await (await request.get(`/api/state?project_id=${id}`)).json();
  for (const task of state.tasks.filter((item: { project_id: string }) => item.project_id === id)) await request.delete(`/api/tasks/${task.id}`);
  for (const entry of state.entries.filter((item: { project_id: string }) => item.project_id === id)) await request.delete(`/api/entries/${entry.id}`);
  await request.delete(`/api/projects/${id}`);
}

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test('suivi IA : bilan conservé au rechargement, actualisé après la saisie et accessible depuis la vue d’ensemble', async ({ page, request }) => {
  const project = await post(request, '/api/projects', { name: 'Intervention suivi IA' });
  const title = 'Remplacement du joint — suivi IA';
  const initial = '## Diagnostic\n\nLa pompe fuit. Diagnostic confirmé.\n\nLe joint doit être livré avant l’intervention.';
  const update = `${initial}\n\n## Avancée du jour\n\nJoint posé, contrôle terminé.`;
  const firstSummary = 'Le diagnostic est fait ; le remplacement attend la livraison du joint.';
  const finalSummary = 'Le joint est remplacé ; le contrôle est terminé.';
  const prompts: string[] = [];
  try {
    const note = await post(request, '/api/entries', { title, project_id: project.id, content_md: initial });
    const task = await post(request, '/api/tasks', { title: 'Remplacer le joint — tâche suivie', project_id: project.id });
    await post(request, `/api/tasks/${task.id}/documents/${note.id}`, {});
    await configure(page, project.id, note.id);
    await page.clock.install();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.route('**/chat/completions', async (route) => {
      const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      const prompt = route.request().postDataJSON().messages[1].content as string;
      prompts.push(prompt);
      const finished = prompt.includes('Joint posé, contrôle terminé.');
      return route.fulfill({ headers, json: { choices: [{ message: { content: JSON.stringify({
        status: finished ? 'done' : 'blocked',
        summary: finished ? finalSummary : firstSummary,
        completed: finished ? ['Diagnostic confirmé.', 'Joint posé et contrôle terminé.'] : ['Diagnostic confirmé.'],
        next_steps: finished ? [] : ['Poser le joint après sa livraison.'],
        blockers: finished ? [] : ['Livraison du joint attendue.'],
        warnings: [],
      }) } }] } });
    });
    await page.goto('/');
    const panel = page.getByRole('region', { name: `Suivi IA de ${title}`, exact: true });
    // Sans suivi, une entrée n’affiche rien : pas de bouton d’activation.
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole('button', { name: `Activer le suivi IA de ${title}`, exact: true })).toHaveCount(0);
    expect(prompts).toHaveLength(0);
    await page.getByRole('button', { name: 'Vue d’ensemble des tâches', exact: true }).click();
    const overview = page.getByRole('region', { name: 'Vue d’ensemble des projets', exact: true });
    await overview.getByRole('button', { name: 'Ajouter au suivi IA', exact: true }).click();
    const picker = overview.getByRole('region', { name: 'Choisir les suivis IA', exact: true });
    await picker.getByRole('checkbox', { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).click();
    await picker.getByRole('button', { name: 'Suivre la sélection (1)', exact: true }).click();
    await expect(overview.getByRole('region', { name: 'Bilans et suivis IA', exact: true })).toBeVisible();
    await page.clock.fastForward(2_000);
    await overview.getByRole('button', { name: `Ouvrir l’entrée ${title}`, exact: true }).click();
    await expect(panel).toBeVisible();
    await expect(panel.getByText(firstSummary, { exact: true })).toBeVisible();
    await expect(panel.getByRole('checkbox', { name: `Actualisation automatique de ${title}`, exact: true })).toBeChecked();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('La pompe fuit.');
    expect((await (await request.get(`/api/entries/${note.id}`)).json()).content_md).toBe(initial);

    // Le bilan à jour reste disponible sans nouvel envoi, même après le délai
    // d'actualisation automatique. L'horloge évite une attente arbitraire.
    const reloadedState = page.waitForResponse((response) => response.url().includes('/api/state') && response.ok());
    await page.reload();
    await reloadedState;
    await expect(panel.getByText(firstSummary, { exact: true })).toBeVisible();
    await page.clock.fastForward(10_000);
    await page.waitForLoadState('networkidle');
    expect(prompts).toHaveLength(1);

    const editor = page.getByRole('region', { name: 'Entrée', exact: true });
    await editor.getByRole('button', { name: 'Écrire', exact: true }).click();
    const saved = page.waitForResponse((response) => response.url().endsWith(`/api/entries/${note.id}`) && response.request().method() === 'PUT' && response.ok());
    const savedState = page.waitForResponse((response) => response.url().includes('/api/state') && response.ok());
    await editor.getByLabel('Contenu en Markdown').fill(update);
    await page.clock.fastForward(1000);
    await saved;
    await savedState;
    await expect(editor.getByText('Enregistré', { exact: true })).toBeVisible();
    // Une pause courte ne relance pas l’IA : le bilan en place reste affiché.
    await page.clock.fastForward(5000);
    await expect(panel.getByText(firstSummary, { exact: true })).toBeVisible();
    expect(prompts).toHaveLength(1);
    // La pause d’écriture passée, le bilan se met à jour en arrière-plan.
    await page.clock.fastForward(6000);
    await expect(panel.getByText(finalSummary, { exact: true })).toBeVisible();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Joint posé, contrôle terminé.');
    const source = await (await request.get(`/api/entries/${note.id}`)).json();
    expect(source.content_md).toBe(update);
    expect(source.archived).toBe(0);
    const state = await (await request.get('/api/state')).json();
    expect(state.tasks.find((item: { id: string }) => item.id === task.id).status).toBe('todo');

    await page.getByRole('button', { name: 'Vue d’ensemble des tâches', exact: true }).click();
    const reports = page.getByRole('region', { name: 'Bilans et suivis IA', exact: true });
    await expect(reports.getByText(finalSummary, { exact: true })).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
    await reports.getByRole('button', { name: `Ouvrir l’entrée ${title}`, exact: true }).click();
    await expect(page.getByLabel('Titre de l’entrée')).toHaveValue(title);
    await expect(panel.getByText(finalSummary, { exact: true })).toBeVisible();
    expect(prompts).toHaveLength(2);

    // « Désactiver » : le bilan part, le panneau disparaît, sans bouton d’activation.
    await panel.getByRole('button', { name: `Désactiver le suivi IA de ${title}`, exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole('button', { name: `Activer le suivi IA de ${title}`, exact: true })).toHaveCount(0);
    await page.reload();
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole('button', { name: `Activer le suivi IA de ${title}`, exact: true })).toHaveCount(0);
    await page.clock.fastForward(10_000);
    expect(prompts).toHaveLength(2);
    expect((await (await request.get(`/api/entries/${note.id}`)).json()).content_md).toBe(update);
  } finally {
    await cleanProject(page, request, project.id);
  }
});

test('sur téléphone, le suivi et ses détails longs restent lisibles et la vue d’ensemble rouvre l’entrée', async ({ page, request }) => {
  const project = await post(request, '/api/projects', { name: 'Maintenance mobile suivi IA' });
  const title = 'Diagnostic du circuit de filtration et commande de la pièce de remplacement';
  const summary = 'Le diagnostic du circuit est terminé. La remise en service attend la confirmation du fournisseur puis la livraison de la pièce.';
  const blocker = `Confirmation de la référence fournisseur attendue : ${'REF-CIRCUIT-'.repeat(30)}`;
  try {
    const note = await post(request, '/api/entries', { title, project_id: project.id, content_md: 'Diagnostic terminé. Pièce commandée ; confirmation et livraison attendues.' });
    await configure(page, project.id, note.id);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.route('**/chat/completions', async (route) => {
      const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      return route.fulfill({ headers, json: { choices: [{ message: { content: JSON.stringify({
        status: 'blocked', summary, completed: ['Diagnostic du circuit terminé.'],
        next_steps: ['Obtenir la confirmation du fournisseur, puis remplacer la pièce après sa livraison.'],
        blockers: [blocker], warnings: [],
      }) } }] } });
    });
    await page.goto('/');
    const navigation = page.getByRole('group', { name: 'Panneaux latéraux' });
    const panel = page.getByRole('region', { name: `Suivi IA de ${title}`, exact: true });
    await expect(panel).toHaveCount(0);
    await page.getByRole('button', { name: 'Vue d’ensemble des tâches', exact: true }).click();
    const overview = page.getByRole('region', { name: 'Vue d’ensemble des projets', exact: true });
    await overview.getByRole('button', { name: 'Ajouter au suivi IA', exact: true }).click();
    const picker = overview.getByRole('region', { name: 'Choisir les suivis IA', exact: true });
    await picker.getByRole('checkbox', { name: /Diagnostic du circuit/ }).click();
    await picker.getByRole('button', { name: 'Suivre la sélection (1)', exact: true }).click();
    await expect(overview.getByRole('region', { name: 'Bilans et suivis IA', exact: true })).toBeVisible();
    await expect(overview.getByText(summary, { exact: true })).toBeVisible();
    await overview.getByRole('button', { name: `Ouvrir l’entrée ${title}`, exact: true }).click();
    await navigation.getByRole('button', { name: 'Écriture', exact: true }).click();
    await expect(panel).toBeVisible();
    await expect(panel.getByText(summary, { exact: true })).toBeVisible();
    await expect(panel.getByText(blocker, { exact: true })).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
    const box = (await panel.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(376);
    await expect(panel.getByRole('button', { name: `Actualiser le bilan de ${title}`, exact: true })).toBeEnabled();

    await page.getByRole('button', { name: 'Vue d’ensemble des tâches', exact: true }).click();
    const reports = page.getByRole('region', { name: 'Bilans et suivis IA', exact: true });
    await expect(reports.getByText(summary, { exact: true })).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
    await reports.getByRole('button', { name: `Ouvrir l’entrée ${title}`, exact: true }).click();
    await expect(navigation.getByRole('button', { name: 'Écriture', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.getByText(summary, { exact: true })).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
  } finally {
    await cleanProject(page, request, project.id);
  }
});
