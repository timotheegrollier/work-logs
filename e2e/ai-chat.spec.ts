import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { Task } from '../web/src/lib';
import { readZip, readZipText } from '../web/src/zip';

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
async function stubAssistant(page: Page, ...replies: (object | ((prompt: string) => object))[]) {
  const prompts: string[] = [];
  await page.route('**/chat/completions', async (route) => {
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const prompt: string = route.request().postDataJSON().messages[1].content;
    prompts.push(prompt);
    const next = replies.shift();
    const reply = typeof next === 'function' ? next(prompt) : next ?? { reply: 'Rien de plus.' };
    return route.fulfill({ headers, json: { choices: [{ message: { content: JSON.stringify(reply) } }] } });
  });
  return prompts;
}

const tasksOf = async (request: APIRequestContext, project: string) =>
  ((await (await request.get('/api/state')).json()).tasks as Task[]).filter((task) => task.project_id === project);

const assistant = (page: Page) => page.getByRole('dialog', { name: 'Assistant IA', exact: true });
const messageField = (page: Page) => assistant(page).getByRole('textbox', { name: 'Message pour l’assistant', exact: true });

async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  expect(await assistant(page).evaluate((dialog) => [dialog, ...dialog.querySelectorAll('.ai-chat-log, .ai-chat-sidebar, .ai-chat-composer, .ai-chat-footer')]
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

test('assistant sur ordinateur : espace de travail, proposition appliquée en base, Échap et focus', async ({ page, request }) => {
  const project = await post(request, '/api/projects', { name: 'Atelier assistant' });
  try {
    const opened = await post(request, '/api/entries', { title: 'Journal du matin', project_id: project.id, content_md: 'Rien à signaler.' });
    await post(request, '/api/entries', { title: 'Réglage de la pompe', project_id: project.id, content_md: 'Pression à 3 bars.' });
    await post(request, '/api/tasks', { title: 'Réparer la pompe', project_id: project.id });
    await configure(page, project.id, opened.id);
    const prompts = await stubAssistant(page, {
      reply: 'La réparation reste à faire. Voici ce que je propose.',
      show_tasks: [1],
      show_documents: [2],
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
    expect(panel.width).toBeGreaterThanOrEqual(viewport.width * 0.75);
    await expect(chat.getByRole('navigation', { name: 'Conversations' })).toBeVisible();

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

    expect(await chat.evaluate((dialog) => [...dialog.querySelectorAll('button, summary, textarea, select')]
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
    await expect(page.getByLabel('Titre de l’entrée')).toHaveValue(task.title);
    await expect(page.getByRole('group', { name: 'Panneaux latéraux' }).getByRole('button', { name: 'Écriture', exact: true })).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await cleanProject(page, request, project.id);
  }
});

test('deux conversations avancent en parallèle et reprennent après fermeture du panneau', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('worklogs-ai-key', 'cle-e2e'));
  let releaseFirst!: () => void;
  const firstReply = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const received: string[] = [];
  await page.route('**/chat/completions', async (route) => {
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const prompt = route.request().postDataJSON().messages[1].content as string;
    received.push(prompt);
    const first = prompt.includes('Liste du premier chantier');
    if (first) await firstReply;
    const reply = first ? 'Premier chantier prêt.' : 'Second chantier prêt.';
    return route.fulfill({ headers, json: { choices: [{ message: { content: JSON.stringify({ reply }) } }] } });
  });
  try {
    await page.goto('/');
    const opener = page.getByRole('banner').getByRole('button', { name: 'Ouvrir l’assistant IA', exact: true });
    const chat = assistant(page);
    await opener.click();
    const firstPane = chat.getByRole('region', { name: 'Conversation 1', exact: true });
    const firstField = firstPane.getByRole('textbox', { name: 'Message pour l’assistant' });
    await firstField.fill('Liste du premier chantier');
    await firstField.press('Enter');
    await expect.poll(() => received.length).toBe(1);
    await firstField.fill('Brouillon à garder');

    await chat.getByRole('button', { name: 'Nouvelle conversation' }).click();
    const secondPane = chat.getByRole('region', { name: 'Conversation 2', exact: true });
    const secondField = secondPane.getByRole('textbox', { name: 'Message pour l’assistant' });
    await expect(secondField).toHaveValue('');
    await secondField.fill('Liste du second chantier');
    await secondField.press('Enter');
    await expect(secondPane.getByText('Second chantier prêt.')).toBeVisible();
    expect(received).toHaveLength(2);
    expect(received[1]).not.toContain('Liste du premier chantier');
    await expect(firstPane.getByRole('button', { name: 'Arrêter la demande IA' })).toBeVisible();
    await expect(firstPane.locator('.ai-chat-working').locator('.ai-chat-working-icon')).toHaveCSS('animation-name', 'ai-chat-spin');
    expect((await secondPane.boundingBox())!.x).toBeGreaterThan((await firstPane.boundingBox())!.x);

    await page.keyboard.press('Escape');
    await expect(chat).toBeHidden();
    releaseFirst();
    await opener.click();
    await expect(secondPane.getByText('Second chantier prêt.')).toBeVisible();
    await expect(firstField).toHaveValue('Brouillon à garder');
    await expect(firstPane.getByText('Premier chantier prêt.')).toBeVisible();
    await expect(firstPane.getByText('Second chantier prêt.')).toHaveCount(0);
  } finally {
    releaseFirst();
  }
});

test('l’assistant crée un brouillon lié, le complète ensuite et ouvre le résultat appliqué', async ({ page, request }) => {
  const project = await post(request, '/api/projects', { name: 'Atelier contenu de tâche' });
  const title = 'Préparer la revue du classeur';
  const initialContent = '## Objectif\n\nPréparer la revue du classeur.\n\n## Étapes\n\n- [ ] À préciser.';
  const instruction = 'Comparer les deux relevés avant la revue.';
  const content = `## Préparation\n\n${instruction}`;
  const unrelatedContent = 'Ancienne note de réunion sans lien avec cette tâche.';
  try {
    const unrelated = await post(request, '/api/entries', { title, content_md: unrelatedContent, project_id: project.id });
    await configure(page, project.id, '');
    let taskNumber = 0;
    let linkedNoteNumber = 0;
    let taskLine: string | undefined;
    const prompts = await stubAssistant(page,
      { reply: 'La tâche est prête à créer.', actions: [{ kind: 'create_task', title, content: initialContent }] },
      (prompt) => {
        taskLine = prompt.split('\n').find((line) => line.replace(/^\d+\. /, '').startsWith(`${title} [`));
        taskNumber = Number(taskLine?.match(/^(\d+)\. /)?.[1]);
        linkedNoteNumber = Number(taskLine?.match(/documents liés D(\d+)/)?.[1]);
        return { read_entries: [linkedNoteNumber] };
      },
      () => ({
        reply: 'Le contenu est prêt à relire.',
        show_tasks: [taskNumber],
        actions: [{ kind: 'update_entry', n: linkedNoteNumber, content }],
      }),
    );
    await page.goto('/');
    await page.getByRole('banner').getByRole('button', { name: 'Ouvrir l’assistant IA', exact: true }).click();
    const chat = assistant(page);
    const field = messageField(page);
    await field.fill(`Crée la tâche « ${title} ».`);
    await field.press('Enter');
    const creation = chat.locator('.ai-action-row').filter({ hasText: 'Créer la tâche' });
    await creation.getByText('Relire le texte proposé', { exact: true }).click();
    await expect(creation.locator('pre')).toContainText('Préparer la revue du classeur.');
    expect(await tasksOf(request, project.id)).toHaveLength(0);
    await chat.getByRole('button', { name: /^Appliquer : Créer la tâche/ }).click();
    await expect(chat.getByText('✓ Appliqué', { exact: true })).toHaveCount(1);

    const [task] = await tasksOf(request, project.id);
    expect(task).toMatchObject({ title, documents: [expect.objectContaining({ title })] });
    const [note] = task.documents;
    expect(note.id).not.toBe(unrelated.id);
    const readEntry = async (id: string) => (await request.get(`/api/entries/${id}`)).json();
    expect(await readEntry(note.id)).toMatchObject({ content_md: initialContent });
    await field.fill('Rédige le contenu de cette tâche.');
    await field.press('Enter');
    await expect(chat.getByText('Le contenu est prêt à relire.')).toBeVisible();
    expect(prompts).toHaveLength(3);
    expect(taskLine).toContain('créée ici');
    expect(taskLine).toMatch(/documents liés D\d+/);
    const fullText = prompts[2].split('\n\n').find((block) => block.startsWith('Textes locaux'));
    expect(fullText).toContain(`"n":${linkedNoteNumber},"content":"## Objectif`);
    await chat.locator('.ai-action-row').filter({ hasText: 'remplacer le texte' }).getByText('Relire le texte proposé', { exact: true }).click();
    await expect(chat.locator('.ai-action-row').filter({ hasText: 'remplacer le texte' }).locator('pre')).toContainText(instruction);
    expect(await readEntry(note.id)).toMatchObject({ content_md: expect.stringContaining('## Étapes') });

    await chat.getByRole('button', { name: /^Appliquer/ }).click();
    await expect(chat.getByText('✓ Appliqué', { exact: true })).toHaveCount(2);
    const [savedTask] = await tasksOf(request, project.id);
    expect(savedTask.documents.map(({ id }) => id)).toEqual([note.id]);
    expect(await readEntry(note.id)).toMatchObject({ content_md: content });
    expect(await readEntry(unrelated.id)).toMatchObject({ content_md: unrelatedContent });

    await creation.getByRole('button', { name: 'Ouvrir la note', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Entrée', exact: true }).getByText(instruction)).toBeVisible();
    await page.getByRole('banner').getByRole('button', { name: 'Ouvrir l’assistant IA', exact: true }).click();
    await chat.getByRole('button', { name: 'Ouvrir la tâche', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Entrée', exact: true }).getByText(instruction)).toBeVisible();
    await page.getByRole('banner').getByRole('button', { name: 'Ouvrir l’assistant IA', exact: true }).click();
    await chat.getByRole('button', { name: 'Ouvrir le document', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Entrée', exact: true }).getByText(instruction)).toBeVisible();
  } finally {
    await cleanProject(page, request, project.id);
  }
});

test('sur téléphone, la liste ouvre une seule conversation et conserve les brouillons', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/');
  await page.locator('.project-strip').getByRole('button', { name: 'Ouvrir l’assistant IA', exact: true }).click();
  const chat = assistant(page);
  await messageField(page).fill('Brouillon de la première');
  await chat.getByRole('button', { name: 'Conversations', exact: true }).click();
  const list = chat.getByRole('navigation', { name: 'Conversations' });
  await list.getByRole('button', { name: 'Nouvelle conversation' }).click();
  await expect(chat.getByRole('region', { name: 'Conversation 1' })).toHaveCount(0);
  await expect(chat.getByRole('region', { name: 'Conversation 2' })).toBeVisible();
  await expect(messageField(page)).toHaveValue('');
  await messageField(page).fill('Brouillon de la deuxième');
  await chat.getByRole('button', { name: 'Conversations', exact: true }).click();
  await list.getByRole('button', { name: 'Conversation 1', exact: true }).click();
  await expect(messageField(page)).toHaveValue('Brouillon de la première');
  await expectNoOverflow(page);
});

test('une note ouverte révisée depuis l’assistant affiche son nouveau texte et son statut', async ({ page, request }) => {
  const project = await post(request, '/api/projects', { name: 'Atelier révision de note' });
  try {
    const note = await post(request, '/api/entries', {
      title: 'Vérification du filtre',
      project_id: project.id,
      content_md: `${'Compte rendu de la vérification. '.repeat(12)}\n\nDétail après l’extrait.`,
    });
    await configure(page, project.id, note.id);
    const body = '# Intervention validée\n\nPièces contrôlées, intervention clôturée.';
    const prompts = await stubAssistant(page,
      { read_entries: [1] },
      { reply: 'La mise à jour est prête.', actions: [{ kind: 'update_entry', n: 1, title: 'Vérification validée', content: body, status: 'done', entry_date: '2026-12-10' }] },
    );
    await page.goto('/');
    const editor = page.getByRole('region', { name: 'Entrée', exact: true });
    await expect(editor.getByLabel('Titre de l’entrée')).toHaveValue('Vérification du filtre');
    await page.getByRole('banner').getByRole('button', { name: 'Ouvrir l’assistant IA', exact: true }).click();
    const chat = assistant(page);
    await messageField(page).fill('Réécris la note ouverte sur la vérification du filtre et marque-la terminée.');
    await messageField(page).press('Enter');
    await expect(chat.getByText('La mise à jour est prête.')).toBeVisible();
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain('Détail après l’extrait.');
    expect(prompts[1]).toContain('Détail après l’extrait.');
    await chat.getByText('Relire le texte proposé', { exact: true }).click();
    await expect(chat.locator('pre')).toContainText('Pièces contrôlées, intervention clôturée.');
    const readEntry = async () => (await request.get(`/api/entries/${note.id}`)).json();
    expect(await readEntry()).toMatchObject({ title: 'Vérification du filtre', status: 'todo' });

    await chat.getByRole('button', { name: /^Appliquer/ }).click();
    await expect(chat.getByText('✓ Appliqué')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(editor.getByLabel('Titre de l’entrée')).toHaveValue('Vérification validée');
    await expect(editor.getByLabel('Date de l’entrée')).toHaveValue('2026-12-10');
    await expect(editor.getByLabel('Statut de l’entrée : Terminée')).toBeVisible();
    await expect(editor.getByText('Pièces contrôlées, intervention clôturée.')).toBeVisible();
    expect(await readEntry()).toMatchObject({ title: 'Vérification validée', content_md: body, status: 'done', archived: 0 });
  } finally {
    await cleanProject(page, request, project.id);
  }
});

test('la saisie dans la note pendant une écriture de l’assistant conserve les deux modifications', async ({ page, request }) => {
  const project = await post(request, '/api/projects', { name: 'Atelier modifications simultanées' });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  try {
    const note = await post(request, '/api/entries', { title: 'Note du filtre', project_id: project.id, content_md: 'Corps initial.' });
    await configure(page, project.id, note.id);
    await stubAssistant(page, {
      reply: 'Le changement de titre est prêt.',
      actions: [{ kind: 'update_entry', n: 1, title: 'Rapport du filtre', status: 'doing' }],
    });
    await page.route(`**/api/entries/${note.id}`, async (route) => {
      if (route.request().method() !== 'PUT' || !route.request().postDataJSON().expected_entry) return route.continue();
      const response = await route.fetch();
      await held;
      return route.fulfill({ response });
    });
    const readEntry = async () => (await request.get(`/api/entries/${note.id}`)).json();
    await page.goto('/');
    const editor = page.getByRole('region', { name: 'Entrée', exact: true });
    await expect(editor.getByLabel('Titre de l’entrée')).toHaveValue('Note du filtre');
    await page.getByRole('banner').getByRole('button', { name: 'Ouvrir l’assistant IA', exact: true }).click();
    const chat = assistant(page);
    await messageField(page).fill('Renomme la note du filtre et marque-la en cours.');
    await messageField(page).press('Enter');
    await chat.getByRole('button', { name: /^Appliquer/ }).click();
    await expect.poll(readEntry).toMatchObject({ title: 'Rapport du filtre', status: 'doing' });

    await page.keyboard.press('Escape');
    await expect(editor.getByLabel('Titre de l’entrée')).toHaveValue('Note du filtre');
    await editor.getByRole('button', { name: 'Écrire', exact: true }).click();
    const source = editor.getByLabel('Contenu en Markdown');
    await source.fill('Observation saisie à la main.');
    await expect.poll(readEntry).toMatchObject({ title: 'Rapport du filtre', status: 'doing', content_md: 'Observation saisie à la main.' });
    release();
    await expect(editor.getByLabel('Titre de l’entrée')).toHaveValue('Rapport du filtre');
    await expect(source).toHaveValue('Observation saisie à la main.');
  } finally {
    release();
    await cleanProject(page, request, project.id);
  }
});

test('l’assistant lit une procédure du partage avec accord et y crée un Word après validation', async ({ page, request }) => {
  const project = await post(request, '/api/projects', { name: 'Atelier procédure partagée' });
  const folder = await mkdtemp(path.resolve('.e2e-share', 'assistant-procedure-'));
  const directory = path.basename(folder);
  const source = 'Sauvegarde du classeur.md';
  const excerpt = 'Comparer le total du journal à celui du classeur.';
  const target = path.join(folder, 'Contrôle après restauration.docx');
  try {
    await writeFile(path.join(folder, source), `# Sauvegarde\n\n${excerpt}\n`);
    await configure(page, project.id, '');
    const prompts = await stubAssistant(page,
      { shared_search: ['Sauvegarde du classeur'] },
      { read_shared: [1] },
      {
        reply: 'Le document est prêt à relire.',
        show_shared: [1],
        actions: [{ kind: 'create_shared_procedure', title: 'Contrôle après restauration', directory: 2, content: `## Contrôle\n\n${excerpt}` }],
      },
    );
    await page.goto('/');
    await page.getByRole('banner').getByRole('button', { name: 'Ouvrir l’assistant IA', exact: true }).click();
    const chat = assistant(page);
    await chat.getByText('Données envoyées au service IA', { exact: true }).click();
    const consent = chat.getByRole('checkbox', { name: 'Autoriser l’envoi d’extraits des fichiers partagés dans cette conversation' });
    await expect(consent).not.toBeChecked();
    await consent.check();
    await messageField(page).fill('Cherche la sauvegarde du classeur et prépare la procédure de contrôle dans le même dossier.');
    await messageField(page).press('Enter');

    await expect(chat.getByText('Le document est prêt à relire.')).toBeVisible();
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain(`${directory}/${source}`);
    expect(prompts[1]).not.toContain(excerpt);
    expect(prompts[2]).toContain(excerpt);
    await chat.getByText('Relire le texte proposé', { exact: true }).click();
    await expect(chat.locator('pre')).toContainText(excerpt);
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    await chat.getByRole('button', { name: `Appliquer : Créer la procédure Word « ${directory}/Contrôle après restauration.docx » sur le partage` }).click();
    await expect(chat.getByText('✓ Appliqué')).toBeVisible();
    const word = await readZip(await readFile(target));
    expect(await readZipText(word, 'word/document.xml')).toContain(excerpt);
    expect(await readFile(path.join(folder, source), 'utf8')).toContain(excerpt);

    await chat.getByRole('button', { name: `Ouvrir le fichier partagé ${directory}/${source}` }).click();
    await expect(page.getByRole('region', { name: 'Fichier partagé' }).getByRole('heading', { name: source })).toBeVisible();
    await page.getByRole('banner').getByRole('button', { name: 'Ouvrir l’assistant IA', exact: true }).click();
    await chat.getByRole('button', { name: 'Ouvrir le fichier partagé', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Fichier partagé' }).getByRole('heading', { name: path.basename(target) })).toBeVisible();
  } finally {
    await cleanProject(page, request, project.id);
    await rm(folder, { recursive: true, force: true });
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
  const hint = assistant(page).getByText(/rien n’est écrit sans ton clic/i);
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
