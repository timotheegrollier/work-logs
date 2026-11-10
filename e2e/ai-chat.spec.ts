import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

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

/** Fournisseur simulé : joue les réponses données, garde les prompts reçus. */
async function stubAssistant(page: Page, ...replies: object[]) {
  const prompts: string[] = [];
  await page.route('**/chat/completions', async (route) => {
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    prompts.push(route.request().postDataJSON().messages[1].content);
    return route.fulfill({ headers, json: { choices: [{ message: { content: JSON.stringify(replies.shift() ?? { reply: 'Rien de plus.' }) } }] } });
  });
  return prompts;
}

const tasksOf = async (request: APIRequestContext, project: string) =>
  ((await (await request.get('/api/state')).json()).tasks as { title: string; status: string; priority: string; project_id: string }[]).filter((task) => task.project_id === project);

const assistant = (page: Page) => page.getByRole('dialog', { name: 'Assistant IA', exact: true });
const messageField = (page: Page) => assistant(page).getByRole('textbox', { name: 'Message pour l’assistant', exact: true });

async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  expect(await assistant(page).evaluate((dialog) => [dialog, ...dialog.querySelectorAll('.ai-chat-log, .ai-chat-composer, .ai-chat-footer')]
    .filter((box) => box.scrollWidth > box.clientWidth).map((box) => box.className))).toEqual([]);
}

/** Contraste WCAG du texte d'un élément sur le fond de son dialogue. */
const contrastInDialog = (element: Locator) => element.evaluate((node) => {
  const luminance = (color: string) => {
    const [r, g, b] = color.match(/[\d.]+/g)!.slice(0, 3).map((value) => {
      const channel = Number(value) / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [text, background] = [getComputedStyle(node).color, getComputedStyle(node.closest('dialog')!).backgroundColor].map(luminance);
  return (Math.max(text, background) + 0.05) / (Math.min(text, background) + 0.05);
});

test('assistant sur ordinateur : panneau à droite, proposition appliquée en base, Échap et focus', async ({ page, request }) => {
  const project = await post(request, '/api/projects', { name: 'Atelier assistant' });
  try {
    const opened = await post(request, '/api/entries', { title: 'Journal du matin', project_id: project.id, content_md: 'Rien à signaler.' });
    await post(request, '/api/entries', { title: 'Réglage de la pompe', project_id: project.id, content_md: 'Pression à 3 bars.' });
    await post(request, '/api/tasks', { title: 'Réparer la pompe', project_id: project.id });
    await configure(page, project.id, opened.id);
    const prompts = await stubAssistant(page, {
      reply: 'La réparation reste à faire. Voici ce que je propose.',
      show_tasks: [1],
      show_documents: [1],
      actions: [
        { kind: 'create_task', title: 'Commander le joint', priority: 'high' },
        { kind: 'update_task', n: 1, status: 'doing' },
      ],
    });
    await page.goto('/');

    const opener = page.getByRole('banner').getByRole('button', { name: 'Ouvrir l’assistant IA', exact: true });
    await opener.click();
    const chat = assistant(page);
    await expect(chat).toBeVisible();
    const viewport = page.viewportSize()!;
    const panel = (await chat.boundingBox())!;
    expect(Math.round(panel.x + panel.width)).toBe(viewport.width);
    expect(Math.round(panel.height)).toBe(viewport.height);
    expect(panel.width).toBeLessThan(viewport.width / 2);

    const field = messageField(page);
    await expect(field).toBeFocused();
    await field.fill('Où en est la pompe ?');
    await field.press('Shift+Enter');
    await field.pressSequentially('Et le joint ?');
    await expect(field).toHaveValue('Où en est la pompe ?\nEt le joint ?');
    await field.press('Enter');

    await expect(chat.getByText('La réparation reste à faire. Voici ce que je propose.', { exact: true })).toBeVisible();
    await expect(field).toHaveValue('');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Réparer la pompe');
    await expectNoOverflow(page);

    await chat.getByRole('button', { name: /^Appliquer : Créer la tâche « Commander le joint »/ }).click();
    await expect(chat.getByText('✓ Appliqué', { exact: true })).toBeVisible();
    const tasks = await tasksOf(request, project.id);
    expect(tasks.find((task) => task.title === 'Commander le joint')).toMatchObject({ status: 'todo', priority: 'high' });
    expect(tasks.find((task) => task.title === 'Réparer la pompe')).toMatchObject({ status: 'todo' });

    await chat.getByRole('button', { name: /^Ignorer : « Réparer la pompe »/ }).click();
    await expect(chat.getByText('Ignorée', { exact: true })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(chat).toBeHidden();
    await expect(opener).toBeFocused();
    expect((await tasksOf(request, project.id)).find((task) => task.title === 'Réparer la pompe')).toMatchObject({ status: 'todo' });

    await opener.click();
    await expect(chat.getByText('La réparation reste à faire. Voici ce que je propose.', { exact: true })).toBeVisible();
    await chat.getByRole('button', { name: 'Ouvrir le document Réglage de la pompe', exact: true }).click();
    await expect(chat).toBeHidden();
    await expect(page.getByLabel('Titre de l’entrée')).toHaveValue('Réglage de la pompe');
  } finally {
    await cleanProject(page, request, project.id);
  }
});

test('assistant sur téléphone : feuille plein écran, cibles au doigt, tout appliquer et carte révélée', async ({ page, request }) => {
  const project = await post(request, '/api/projects', { name: 'Atelier assistant mobile' });
  const long = 'Vérifier-le-raccord-de-la-pompe-sans-espace-'.repeat(4);
  try {
    const note = await post(request, '/api/entries', { title: 'Note du chantier', project_id: project.id, content_md: 'Pression à 3 bars.' });
    const task = await post(request, '/api/tasks', { title: 'Réparer la pompe', project_id: project.id });
    await configure(page, project.id, note.id);
    await stubAssistant(page, {
      reply: `La pompe est à réparer. ${long}`,
      show_tasks: [1],
      actions: [
        { kind: 'create_task', title: long.slice(0, 120), priority: 'high' },
        { kind: 'update_task', n: 1, status: 'doing' },
      ],
    });
    await page.setViewportSize({ width: 412, height: 915 });
    await page.goto('/');

    const opener = page.locator('.project-strip').getByRole('button', { name: 'Ouvrir l’assistant IA', exact: true });
    await expect(opener).toBeVisible();
    await opener.click();
    const chat = assistant(page);
    await expect(chat).toBeVisible();
    // La feuille monte en glissant : sa place se mesure une fois arrivée.
    await expect.poll(() => chat.boundingBox()).toEqual({ x: 0, y: 0, width: 412, height: 915 });
    const field = messageField(page);
    await expect(field).not.toBeFocused();
    expect(await field.evaluate((element) => getComputedStyle(element).fontSize)).toBe('16px');

    await field.fill('Où en est la pompe ?');
    await chat.getByRole('button', { name: 'Envoyer', exact: true }).click();
    const applyAll = chat.getByRole('button', { name: 'Tout appliquer (2)', exact: true });
    await expect(applyAll).toBeVisible();

    expect(await chat.evaluate((dialog) => [...dialog.querySelectorAll('button, summary, textarea')]
      .filter((target) => { const { width, height } = target.getBoundingClientRect(); return width > 0 && (width < 44 || height < 44); })
      .map((target) => target.getAttribute('aria-label') ?? target.textContent))).toEqual([]);
    await expectNoOverflow(page);
    await page.setViewportSize({ width: 320, height: 640 });
    await expectNoOverflow(page);
    await page.setViewportSize({ width: 412, height: 915 });

    await applyAll.click();
    await expect(chat.getByText('✓ Appliqué', { exact: true })).toHaveCount(2);
    const tasks = await tasksOf(request, project.id);
    expect(tasks.find((item) => item.title === 'Réparer la pompe')).toMatchObject({ status: 'doing' });
    expect(tasks.find((item) => item.title === long.slice(0, 120).trim())).toMatchObject({ status: 'todo', priority: 'high' });

    await page.keyboard.press('Escape');
    await expect(chat).toBeHidden();
    await expect(opener).toBeFocused();

    await opener.click();
    await chat.getByRole('button', { name: 'Ouvrir la tâche Réparer la pompe', exact: true }).click();
    await expect(chat).toBeHidden();
    await expect(page.locator(`#task-${task.id}`)).toBeInViewport();
    await expect(page.getByRole('group', { name: 'Panneaux latéraux' }).getByRole('button', { name: 'Tâches', exact: true })).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await cleanProject(page, request, project.id);
  }
});

test('en-tête avec statistiques : le bouton Assistant ne fait pas déborder la page', async ({ page, request }) => {
  const project = await post(request, '/api/projects', { name: 'Atelier en-tête' });
  try {
    await post(request, '/api/tasks', { title: 'Déjà commencée', project_id: project.id, status: 'doing' });
    await post(request, '/api/tasks', { title: 'Échéance passée', project_id: project.id, due_date: '2026-01-05' });
    await page.setViewportSize({ width: 1600, height: 800 });
    await page.goto('/');
    const head = page.getByRole('banner');
    await expect(head.locator('.stats')).toContainText('en retard');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1600);
    await page.setViewportSize({ width: 1200, height: 800 });
    await expect(head.getByRole('button', { name: 'Ouvrir l’assistant IA', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1200);
  } finally {
    await cleanProject(page, request, project.id);
  }
});

test('à l’ouverture, la consigne se lit dans les deux thèmes ; l’impression ignore le panneau', async ({ page }) => {
  await page.goto('/');
  const opener = page.getByRole('banner').getByRole('button', { name: 'Ouvrir l’assistant IA', exact: true });
  await opener.click();
  const hint = assistant(page).getByText(/rien n’est écrit sans ton clic/);
  expect(await contrastInDialog(hint)).toBeGreaterThanOrEqual(4.5);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Changer de thème', exact: true }).click();
  await opener.click();
  expect(await contrastInDialog(hint)).toBeGreaterThanOrEqual(4.5);

  await page.emulateMedia({ media: 'print' });
  await expect(assistant(page)).toBeHidden();
});

test('à 320 px, un motif d’erreur insécable reste dans le journal', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('worklogs-ai-key', 'cle-e2e'));
  await page.route('**/chat/completions', (route) => {
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    return route.fulfill({ status: 400, headers, json: { error: { message: 'GenerateContentRequest.generation_config.thinking_config.thinking_budget: invalide' } } });
  });
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  await page.locator('.project-strip').getByRole('button', { name: 'Ouvrir l’assistant IA', exact: true }).click();
  const chat = assistant(page);
  await messageField(page).fill('Où en est la pompe ?');
  await chat.getByRole('button', { name: 'Envoyer', exact: true }).click();
  await expect(chat.getByText(/thinking_budget/)).toBeVisible();
  await expectNoOverflow(page);
});

test('sur téléphone, le plafond de requêtes se règle au doigt', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Compte et paramètres', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Paramètres', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Paramètres', exact: true });
  await settings.getByText('Réglages avancés', { exact: true }).click();
  const limit = settings.getByLabel('Plafond de requêtes IA par jour', { exact: true });
  await expect(limit).toHaveCSS('font-size', '16px');
  expect((await limit.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});
