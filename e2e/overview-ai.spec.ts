import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

type TaskState = { id: string; title: string; status: string; priority: string; due_date: string | null };

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function configure(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('worklogs-ai-key', 'cle-vue-ensemble-e2e');
    localStorage.setItem('worklogs-theme', 'light');
  });
}

async function cleanProject(page: Page, request: APIRequestContext, id: string) {
  await page.goto('about:blank').catch(() => {});
  await page.unrouteAll({ behavior: 'wait' }).catch(() => {});
  const state = await (await request.get(`/api/state?project_id=${id}`)).json();
  for (const task of state.tasks.filter((item: { project_id: string }) => item.project_id === id)) await request.delete(`/api/tasks/${task.id}`);
  for (const entry of state.entries.filter((item: { project_id: string }) => item.project_id === id)) await request.delete(`/api/entries/${entry.id}`);
  await request.delete(`/api/projects/${id}`);
}

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

async function saveReport(request: APIRequestContext, kind: 'task' | 'entry', id: string, summary: string) {
  const snapshot = await (await request.get(`/api/follow-up/${kind}/${id}`)).json();
  const response = await request.put(`/api/follow-up/${kind}/${id}`, { data: {
    enabled: false, source_key: snapshot.source_key,
    report: { status: 'doing', summary, completed: [], next_steps: ['Contrôler le raccord avant remise en service.'], blockers: [], warnings: [] },
  } });
  expect(response.ok()).toBeTruthy();
}

test('bilan du jour en un clic : synthétise les suivis, accessibles en tête et lisibles sur téléphone', async ({ page, request }, testInfo) => {
  test.setTimeout(60_000);
  const project = await post(request, '/api/projects', { name: 'Bilan quotidien vue IA' });
  try {
    const task = await post(request, '/api/tasks', { title: 'Remise en service bilan quotidien', project_id: project.id });
    const entry = await post(request, '/api/entries', { title: 'Contrôle du raccord bilan quotidien', project_id: project.id, content_md: 'TEXTE BRUT NON ENVOYÉ PAR LE BILAN QUOTIDIEN' });
    await saveReport(request, 'task', task.id, 'Diagnostic confirmé ; le raccord reste à vérifier.');
    await saveReport(request, 'entry', entry.id, 'Le joint est posé ; le contrôle reste à réaliser.');
    await configure(page);
    const prompts: string[] = [];
    await page.route('**/chat/completions', async (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      prompts.push(route.request().postDataJSON().messages[1].content);
      return route.fulfill({ headers, json: { choices: [{ message: { content: JSON.stringify({
        summary: 'Le diagnostic est confirmé et le joint posé. Le contrôle du raccord reste prioritaire avant la remise en service.',
        completed: [], next_steps: ['Contrôler le raccord avant remise en service.'], blockers: [],
      }) } }] } });
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Vue d’ensemble des tâches', exact: true }).click();
    const overview = page.getByRole('region', { name: 'Vue d’ensemble des projets', exact: true });
    const dailyButton = overview.getByRole('button', { name: 'Bilan du jour', exact: true });
    await expect(dailyButton).toBeEnabled();
    expect((await dailyButton.boundingBox())!.y).toBeLessThan(350);
    await dailyButton.click();
    const daily = overview.getByRole('region', { name: 'Bilan IA du jour', exact: true });
    await expect(daily.getByText('Le diagnostic est confirmé et le joint posé. Le contrôle du raccord reste prioritaire avant la remise en service.')).toBeVisible();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Diagnostic confirmé ; le raccord reste à vérifier.');
    expect(prompts[0]).toContain('Le joint est posé ; le contrôle reste à réaliser.');
    expect(prompts[0]).not.toContain('TEXTE BRUT NON ENVOYÉ');
    expect(await noHorizontalScroll(page)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('overview-desktop-light.png'), fullPage: true });
    await overview.getByRole('button', { name: 'Voir les suivis (2)', exact: true }).click();
    await expect(overview.getByRole('heading', { name: 'Suivis IA', exact: true })).toBeFocused();

    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole('group', { name: 'Panneaux latéraux' }).getByRole('button', { name: 'Écriture', exact: true }).click();
    await dailyButton.scrollIntoViewIfNeeded();
    await expect(dailyButton).toBeVisible();
    await expect(daily).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('overview-mobile-light.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: 'Changer de thème', exact: true }).click();
    await dailyButton.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('overview-desktop-dark.png'), fullPage: true });
    expect(prompts).toHaveLength(1);
  } finally {
    await cleanProject(page, request, project.id);
  }
});

test('replanification : relit et corrige les dates et priorités de toutes les tâches ouvertes, sans toucher aux terminées', async ({ page, request }) => {
  const project = await post(request, '/api/projects', { name: 'Calendrier vue IA' });
  const original = (await (await request.get('/api/state')).json()).tasks as TaskState[];
  try {
    const urgent = await post(request, '/api/tasks', { title: 'Rétablir le débit calendrier IA', project_id: project.id, priority: 'normal' });
    const later = await post(request, '/api/tasks', { title: 'Ranger les outils calendrier IA', project_id: project.id, status: 'doing', priority: 'high' });
    const done = await post(request, '/api/tasks', { title: 'Diagnostic terminé calendrier IA', project_id: project.id, status: 'done', due_date: '2020-01-01', priority: 'low' });
    const before = (await (await request.get('/api/state')).json()).tasks as TaskState[];
    const open = before.filter((task) => task.status !== 'done');
    await saveReport(request, 'task', urgent.id, 'Débit interrompu : la remise en service débloque le travail.');
    await configure(page);
    const prompts: string[] = [];
    const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    const corrected = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
    await page.route('**/chat/completions', async (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      const prompt = route.request().postDataJSON().messages[1].content as string;
      prompts.push(prompt);
      const numbers = [...prompt.matchAll(/^(\d+) · (.+?) · /gm)];
      return route.fulfill({ headers, json: { choices: [{ message: { content: JSON.stringify(numbers.map((match) => ({
        n: Number(match[1]), priority: match[2] === urgent.title ? 'high' : 'normal', due_date: tomorrow,
        reason: 'Date estimée selon les priorités et les blocages connus.',
      }))) } }] } });
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Vue d’ensemble des tâches', exact: true }).click();
    const overview = page.getByRole('region', { name: 'Vue d’ensemble des projets', exact: true });
    await overview.getByRole('button', { name: 'Replanifier avec l’IA', exact: true }).click();
    const schedule = overview.getByRole('region', { name: 'Dates et priorités proposées par l’IA', exact: true });
    await expect(schedule.getByRole('checkbox')).toHaveCount(open.length);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Débit interrompu : la remise en service débloque le travail.');
    expect(prompts[0]).not.toContain(done.title);
    for (const task of open) expect(prompts[0]).toContain(task.title);
    // La génération seule n'écrit aucune échéance.
    expect((await (await request.get('/api/state')).json()).tasks.find((task: TaskState) => task.id === urgent.id).due_date).toBeNull();
    await schedule.getByLabel(`Priorité proposée pour ${later.title}`, { exact: true }).selectOption('low');
    await schedule.getByLabel(`Date proposée pour ${later.title}`, { exact: true }).fill(corrected);
    expect(await noHorizontalScroll(page)).toBe(true);
    await schedule.getByRole('button', { name: `Appliquer ${open.length} tâches`, exact: true }).click();
    await expect(overview.getByRole('status').filter({ hasText: `${open.length} tâches replanifiées.` })).toBeVisible();
    const state = (await (await request.get('/api/state')).json()).tasks as TaskState[];
    expect(state.find((task) => task.id === urgent.id)).toMatchObject({ status: 'todo', priority: 'high', due_date: tomorrow });
    expect(state.find((task) => task.id === later.id)).toMatchObject({ status: 'doing', priority: 'low', due_date: corrected });
    expect(state.find((task) => task.id === done.id)).toMatchObject({ status: 'done', priority: 'low', due_date: '2020-01-01' });
    for (const task of open.filter((task) => task.id !== later.id)) expect(state.find((next) => next.id === task.id)?.due_date).toBe(tomorrow);
  } finally {
    await cleanProject(page, request, project.id);
    for (const task of original) {
      const response = await request.put(`/api/tasks/${task.id}`, { data: { priority: task.priority, due_date: task.due_date } });
      expect(response.ok()).toBeTruthy();
    }
  }
});

test('ajout groupé au suivi : recherche, sélection conservée et documents déjà inclus signalés', async ({ page, request }) => {
  const project = await post(request, '/api/projects', { name: 'Sélection suivis vue IA' });
  try {
    const task = await post(request, '/api/tasks', { title: 'Contrôler la filtration sélection IA', project_id: project.id });
    const linked = await post(request, '/api/entries', { title: 'Détails de filtration sélection IA', project_id: project.id, content_md: 'Filtration à contrôler.' });
    const entry = await post(request, '/api/entries', { title: 'Commander le joint sélection IA', project_id: project.id, content_md: 'Le joint reste à commander.' });
    await post(request, `/api/tasks/${task.id}/documents/${linked.id}`, {});
    await configure(page);
    let calls = 0;
    await page.route('**/chat/completions', async (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      calls++;
      return route.fulfill({ headers, json: { choices: [{ message: { content: JSON.stringify({ status: 'todo', summary: 'Une vérification reste à effectuer.', completed: [], next_steps: ['Vérifier le travail restant.'], blockers: [] }) } }] } });
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Vue d’ensemble des tâches', exact: true }).click();
    const overview = page.getByRole('region', { name: 'Vue d’ensemble des projets', exact: true });
    await overview.getByRole('button', { name: 'Ajouter au suivi IA', exact: true }).click();
    const picker = overview.getByRole('region', { name: 'Choisir les suivis IA', exact: true });
    await expect(picker.getByRole('searchbox', { name: 'Rechercher un élément à suivre', exact: true })).toBeFocused();
    await picker.getByRole('checkbox', { name: new RegExp(`^${task.title}`) }).check();
    await expect(picker.getByRole('checkbox', { name: new RegExp(`^${linked.title}`) })).toHaveAccessibleName(new RegExp('Déjà incluse avec'));
    await picker.getByRole('searchbox').fill('commander le joint');
    await picker.getByRole('checkbox', { name: new RegExp(`^${entry.title}`) }).check();
    await picker.getByRole('button', { name: 'Suivre la sélection (2)', exact: true }).click();
    await expect(picker).toBeHidden();
    const reports = overview.getByRole('region', { name: 'Bilans et suivis IA', exact: true });
    await expect(reports.getByRole('region', { name: `Suivi IA de ${task.title}`, exact: true }).getByText('Une vérification reste à effectuer.', { exact: true })).toBeVisible();
    await expect(reports.getByRole('region', { name: `Suivi IA de ${entry.title}`, exact: true }).getByText('Une vérification reste à effectuer.', { exact: true })).toBeVisible();
    await expect(reports.getByRole('region', { name: `Suivi IA de ${linked.title}`, exact: true })).toHaveCount(0);
    await expect(overview.getByRole('button', { name: 'Voir les suivis (2)', exact: true })).toBeVisible();
    expect(calls).toBe(2);
    expect(await noHorizontalScroll(page)).toBe(true);
    expect((await (await request.get(`/api/entries/${entry.id}`)).json()).content_md).toBe('Le joint reste à commander.');
  } finally {
    await cleanProject(page, request, project.id);
  }
});
