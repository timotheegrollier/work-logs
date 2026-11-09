import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function cleanProject(page: Page, request: APIRequestContext, id: string) {
  await page.goto('about:blank').catch(() => {});
  const state = await (await request.get(`/api/state?project_id=${id}`)).json();
  for (const task of state.tasks.filter((item: { project_id: string }) => item.project_id === id)) await request.delete(`/api/tasks/${task.id}`);
  for (const entry of state.entries.filter((item: { project_id: string }) => item.project_id === id)) await request.delete(`/api/entries/${entry.id}`);
  await request.delete(`/api/projects/${id}`);
}

const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
async function touchTarget(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  const box = (await control.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
}

async function manualReport(request: APIRequestContext, kind: 'task' | 'entry', id: string) {
  const snapshot = await (await request.get(`/api/follow-up/${kind}/${id}`)).json();
  const result = await request.put(`/api/follow-up/${kind}/${id}`, { data: {
    enabled: false, source_key: snapshot.source_key,
    report: { status: 'doing', summary: 'Le contrôle final reste à réaliser avant la remise en service.', completed: ['Diagnostic confirmé.'], next_steps: ['Contrôler le raccord.'], blockers: [], warnings: [] },
  } });
  expect(result.ok()).toBeTruthy();
}

for (const viewport of [{ width: 320, height: 740 }, { width: 375, height: 812 }, { width: 800, height: 1000 }, { width: 1440, height: 1000 }, { width: 800, height: 390 }]) {
  test(`gestes sur les suivis : statut, validation et archives sans débordement à ${viewport.width}×${viewport.height}`, async ({ page, request }, testInfo) => {
    const project = await post(request, '/api/projects', { name: `Actions vue ${viewport.width}×${viewport.height}` });
    try {
      const task = await post(request, '/api/tasks', { title: 'Contrôler le raccord de filtration avant la remise en service', project_id: project.id });
      const note = await post(request, '/api/entries', { title: 'Diagnostic du raccord à contrôler', project_id: project.id, content_md: 'Raccord posé. Contrôle restant.' });
      const free = await post(request, '/api/entries', { title: 'Compte rendu sans suivi', project_id: project.id, content_md: 'Une note ordinaire.' });
      const followed = await post(request, '/api/entries', { title: 'Suivi de la commande déjà archivée', project_id: project.id, content_md: 'La livraison est confirmée.' });
      await post(request, `/api/tasks/${task.id}/documents/${note.id}`, {});
      await manualReport(request, 'task', task.id);
      await manualReport(request, 'entry', followed.id);
      const archived = await request.put(`/api/entries/${followed.id}`, { data: { archived: 1 } });
      expect(archived.ok()).toBeTruthy();
      await page.addInitScript(() => localStorage.setItem('worklogs-theme', 'light'));
      await page.setViewportSize(viewport);
      await page.goto('/');
      await page.getByRole('button', { name: 'Vue d’ensemble des tâches', exact: true }).click();
      const overview = page.getByRole('region', { name: 'Vue d’ensemble des projets', exact: true });
      const reports = overview.getByRole('region', { name: 'Bilans et suivis IA', exact: true });
      // Ce que l'IA propose se lit sans déplier ; les avancées restent dans les détails.
      await expect(reports.getByText('Contrôler le raccord.', { exact: true }).first()).toBeVisible();
      await expect(reports.getByText('Diagnostic confirmé.', { exact: true }).first()).toBeHidden();
      // Plus de liste de tâches, de journal ni d'ajout ici : la colonne Tâches s'en charge.
      await expect(overview.getByText(/^Entrées du journal \(/)).toHaveCount(0);
      await expect(overview.getByText(free.title, { exact: true })).toHaveCount(0);
      await expect(overview.getByRole('textbox', { name: 'Nouvelle tâche dans la vue d’ensemble', exact: true })).toHaveCount(0);

      const status = reports.getByLabel(`Statut de ${task.title}`, { exact: true });
      const validate = reports.getByRole('button', { name: `Valider la tâche ${task.title}`, exact: true });
      await touchTarget(status);
      await touchTarget(validate);
      await status.selectOption('doing');
      await expect(overview.getByRole('status').filter({ hasText: 'passée en cours.' })).toBeVisible();
      await expect(status).toHaveValue('doing');
      await validate.click();
      const reopen = reports.getByRole('button', { name: `Rouvrir la tâche ${task.title}`, exact: true });
      await touchTarget(reopen);
      await expect(status).toHaveValue('done');
      await expect.poll(async () => (await (await request.get(`/api/entries/${note.id}`)).json()).archived).toBe(1);
      await reopen.click();
      await expect(status).toHaveValue('todo');
      await expect.poll(async () => (await (await request.get('/api/state')).json()).tasks.find((item: { id: string }) => item.id === task.id).status).toBe('todo');
      expect((await (await request.get(`/api/entries/${note.id}`)).json()).archived).toBe(1);

      const unarchive = reports.getByRole('button', { name: `Désarchiver l’entrée ${followed.title}`, exact: true });
      await touchTarget(unarchive);
      await unarchive.click();
      const archive = reports.getByRole('button', { name: `Archiver l’entrée ${followed.title}`, exact: true });
      await expect(archive).toBeVisible();
      await expect.poll(async () => (await (await request.get(`/api/entries/${followed.id}`)).json()).archived).toBe(0);
      await expect(reports.getByRole('region', { name: `Suivi IA de ${followed.title}`, exact: true })).toBeVisible();
      expect(await noHorizontalScroll(page)).toBe(true);
      await expect(overview).toBeVisible();

      if (viewport.width === 1440 || viewport.width === 375) {
        await overview.getByRole('heading', { name: 'Vue d’ensemble', exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`${viewport.width === 1440 ? 'desktop' : 'mobile'}.png`), fullPage: true });
        await page.getByRole('button', { name: 'Changer de thème', exact: true }).click();
        await page.screenshot({ path: testInfo.outputPath(`${viewport.width === 1440 ? 'desktop-dark' : 'mobile-dark'}.png`), fullPage: true });
      }
    } finally {
      await cleanProject(page, request, project.id);
    }
  });
}

test('un changement de statut refusé garde le statut et un point de focus accessible', async ({ page, request }) => {
  const project = await post(request, '/api/projects', { name: 'Refus gestes vue' });
  try {
    const task = await post(request, '/api/tasks', { title: 'Contrôle conservé après refus', project_id: project.id });
    await manualReport(request, 'task', task.id);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Vue d’ensemble des tâches', exact: true }).click();
    const overview = page.getByRole('region', { name: 'Vue d’ensemble des projets', exact: true });
    await page.route(`**/api/tasks/${task.id}/move`, (route) => route.fulfill({ status: 500, json: { error: 'Statut refusé pour le test' } }));
    const status = overview.getByLabel(`Statut de ${task.title}`, { exact: true });
    await status.focus();
    await status.selectOption('doing');
    await expect(overview.getByRole('alert')).toHaveText('Statut refusé pour le test');
    await expect(status).toHaveValue('todo');
    await expect(status).toBeEnabled();
    await expect.poll(async () => status.evaluate((element) => element === document.activeElement || document.activeElement?.textContent === 'Suivis IA')).toBe(true);
    expect(await noHorizontalScroll(page)).toBe(true);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    await cleanProject(page, request, project.id);
  }
});
