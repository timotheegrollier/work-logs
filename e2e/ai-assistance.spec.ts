import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function configure(page: Page, project: string, entry: string) {
  await page.addInitScript(({ project, entry }) => {
    localStorage.setItem('worklogs-ai-key', 'cle-e2e');
    localStorage.setItem('worklogs-project', project);
    localStorage.setItem('worklogs-entry', entry);
  }, { project, entry });
}

async function cleanProject(page: Page, request: APIRequestContext, id: string) {
  await page.goto('about:blank');
  const state = await (await request.get(`/api/state?project_id=${id}`)).json();
  for (const task of state.tasks.filter((item: { project_id: string }) => item.project_id === id)) await request.delete(`/api/tasks/${task.id}`);
  for (const entry of state.entries.filter((item: { project_id: string }) => item.project_id === id)) await request.delete(`/api/entries/${entry.id}`);
  await request.delete(`/api/projects/${id}`);
}

test('IA sur une tâche : lit les documents liés, affine et retire une source', async ({ page, request }) => {
  const project = await post(request, '/api/projects', { name: 'Atelier IA' });
  const other = await post(request, '/api/projects', { name: 'Autre atelier IA' });
  try {
    const note = await post(request, '/api/entries', { title: 'Diagnostic filtre IA', project_id: project.id, content_md: 'Cartouche modèle XY, eau coupée au robinet bleu.' });
    await post(request, '/api/entries', { title: 'Diagnostic filtre IA autre atelier', project_id: other.id, content_md: 'CONFIDENTIEL AUTRE ATELIER' });
    const task = await post(request, '/api/tasks', { title: 'Changer le filtre IA', project_id: project.id });
    await post(request, `/api/tasks/${task.id}/documents/${note.id}`, {});
    await configure(page, project.id, note.id);
    const prompts: string[] = [];
    await page.route('**/chat/completions', async (route) => {
      const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      prompts.push(route.request().postDataJSON().messages[1].content);
      return route.fulfill({ headers, json: { choices: [{ message: { content: prompts.length === 1 ? 'Couper l’eau\nChanger la cartouche' : 'Remplacer la cartouche' } }] } });
    });
    await page.goto('/');
    const card = page.locator('.card').filter({ has: page.getByText('Changer le filtre IA', { exact: true }) });
    await card.getByRole('button', { name: 'Créer une entrée liée', exact: true }).click();
    await card.getByRole('button', { name: '✨ Suggérer', exact: true }).click();
    const content = card.getByLabel('Sous-tâches de l’entrée liée, une par ligne');
    await expect(content).toHaveValue('Couper l’eau\nChanger la cartouche');
    expect(prompts[0]).toContain('Cartouche modèle XY');
    expect(prompts[0]).not.toContain('CONFIDENTIEL AUTRE ATELIER');
    await card.getByRole('button', { name: 'Plus court', exact: true }).click();
    await expect(content).toHaveValue('Remplacer la cartouche');
    expect(prompts[1]).toContain('Proposition précédente');
    expect(prompts[1]).toContain('Couper l’eau');
    expect(prompts[1]).toContain('Plus court');
    await card.getByText('Contexte utilisé par l’IA', { exact: true }).click();
    await card.getByRole('checkbox', { name: 'Note : Diagnostic filtre IA', exact: true }).uncheck();
    await card.getByRole('button', { name: '✨ Suggérer', exact: true }).click();
    await expect.poll(() => prompts.length).toBe(3);
    await expect(card.getByRole('button', { name: '✨ Suggérer', exact: true })).toBeEnabled();
    expect(prompts[2]).not.toContain('Cartouche modèle XY');
    expect(prompts[2]).not.toContain('Diagnostic filtre IA');
    await expect(card.getByRole('checkbox', { name: 'Note : Diagnostic filtre IA', exact: true })).not.toBeChecked();
    await card.getByRole('checkbox', { name: 'Note : Diagnostic filtre IA', exact: true }).check();
  } finally {
    await cleanProject(page, request, project.id);
    await cleanProject(page, request, other.id);
  }
});

test('IA sur mobile : extrait des actions sourcées, ne crée que la sélection et garde la note', async ({ page, request }) => {
  const project = await post(request, '/api/projects', { name: 'Maintenance IA' });
  const source = 'À faire : Appeler le fournisseur le 2026-10-30.\n\nPréparer le devis.';
  try {
    const note = await post(request, '/api/entries', { title: 'Point maintenance IA', project_id: project.id, content_md: source });
    await configure(page, project.id, note.id);
    await page.setViewportSize({ width: 412, height: 915 });
    await page.route('**/chat/completions', async (route) => {
      const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      return route.fulfill({ headers, json: { choices: [{ message: { content: JSON.stringify([
        { title: 'Appeler le fournisseur', due_date: '2026-10-30', evidence: 'Appeler le fournisseur le 2026-10-30.' },
        { title: 'Préparer le devis', due_date: null, evidence: 'Préparer le devis.' },
      ]) } }] } });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Assistance IA', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Extraire les actions', exact: true }).click();
    const proposal = page.getByRole('region', { name: 'Actions proposées', exact: true });
    await expect(proposal.getByLabel('Titre de l’action 1')).toHaveValue('Appeler le fournisseur');
    await expect(proposal.getByLabel('Échéance de l’action 1')).toHaveValue('2026-10-30');
    await proposal.getByRole('checkbox', { name: 'Créer l’action Préparer le devis', exact: true }).uncheck();
    await proposal.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await proposal.getByRole('button', { name: 'Créer les tâches sélectionnées', exact: true }).click();
    await expect(proposal.getByText('Créée et liée', { exact: true })).toBeVisible();
    const state = await (await request.get('/api/state')).json();
    const tasks = state.tasks.filter((task: { project_id: string }) => task.project_id === project.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].due_date).toBe('2026-10-30');
    expect(tasks[0].documents.map((document: { id: string }) => document.id)).toContain(note.id);
    expect((await (await request.get(`/api/entries/${note.id}`)).json()).content_md).toBe(source);
  } finally {
    await cleanProject(page, request, project.id);
  }
});

test('IA dans le partage : affine avec le contexte du projet puis applique en brouillon', async ({ page, request }) => {
  const project = await post(request, '/api/projects', { name: 'Filtration IA' });
  const filename = 'Filtration IA.md';
  const file = path.resolve('.e2e-share', filename);
  const source = '# Filtration IA\n\nfermer la vane avant intervention.\n';
  fs.writeFileSync(file, source);
  try {
    const note = await post(request, '/api/entries', { title: 'Filtration IA repères', project_id: project.id, content_md: 'La vanne rouge isole le circuit.' });
    await configure(page, project.id, note.id);
    const prompts: string[] = [];
    const answers = ['# Filtration IA\n\nFermer la vanne avant intervention.', '# Filtration IA\n\nFermer la vanne.'];
    await page.route('**/chat/completions', async (route) => {
      const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      prompts.push(route.request().postDataJSON().messages[1].content);
      return route.fulfill({ headers, json: { choices: [{ message: { content: answers[prompts.length - 1] } }] } });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Procédures', exact: true }).click();
    await page.getByRole('button', { name: `Ouvrir ${filename}`, exact: true }).click();
    const editor = page.getByRole('region', { name: 'Fichier partagé' });
    await editor.getByRole('button', { name: 'Assistance IA', exact: true }).click();
    await editor.getByRole('menuitem', { name: 'Mettre en page', exact: true }).click();
    const proposal = editor.getByRole('region', { name: 'Mise en page proposée', exact: true });
    await expect(proposal.getByText('Fermer la vanne avant intervention.', { exact: true })).toBeVisible();
    expect(prompts[0]).toContain('La vanne rouge isole le circuit.');
    await proposal.getByRole('button', { name: 'Plus court', exact: true }).click();
    await expect(proposal.getByText('Fermer la vanne.', { exact: true })).toBeVisible();
    expect(prompts[1]).toContain('fermer la vane avant intervention.');
    expect(prompts[1]).toContain('Fermer la vanne avant intervention.');
    expect(prompts[1]).toContain('Plus court');
    expect(fs.readFileSync(file, 'utf8')).toBe(source);
    await proposal.getByRole('button', { name: 'Appliquer la mise en page', exact: true }).click();
    await expect(editor.getByLabel(`Contenu de ${filename}`)).toHaveValue(answers[1] + '\n');
    expect(fs.readFileSync(file, 'utf8')).toBe(source);
    await editor.getByRole('button', { name: 'Enregistrer sur le partage', exact: true }).click();
    await expect(editor.getByText('Enregistré sur le partage.', { exact: true })).toBeVisible();
    expect(fs.readFileSync(file, 'utf8')).toBe(answers[1] + '\n');
  } finally {
    await cleanProject(page, request, project.id);
    fs.rmSync(file, { force: true });
  }
});
