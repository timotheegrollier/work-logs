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
    const message = route.request().postDataJSON().messages[1].content;
    const prompt: string = typeof message === 'string' ? message
      : message.map((part: { type: string; text?: string }) => part.type === 'text' ? part.text : `[${part.type}]`).join('\n');
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

test('assistant : retrouve deux conversations titrées après rechargement et persiste leur suppression', async ({ page, request }) => {
  const project = await post(request, '/api/projects', { name: 'Atelier historique' });
  try {
    const note = await post(request, '/api/entries', { title: 'Semaine de maintenance', project_id: project.id });
    await configure(page, project.id, note.id);
    const prompts = await stubAssistant(page, {
      reply: 'La pompe passe en révision mardi.',
      conversation_title: 'Révision de la pompe · Atelier historique',
    }, {
      reply: 'La vanne est prête.',
      conversation_title: 'Contrôle de la vanne',
    }, {
      reply: 'Le raccord est prévu.',
    });
    await page.goto('/');
    const opener = page.getByRole('button', { name: 'Ouvrir l’assistant IA', exact: true });
    await opener.click();
    const chat = assistant(page);
    const first = chat.getByRole('region', { name: 'Conversation 1', exact: true });
    const second = chat.getByRole('region', { name: 'Conversation 2', exact: true });
    const firstField = first.getByRole('textbox');
    await firstField.fill('Quand faut-il revoir la pompe ?');
    await firstField.press('Enter');
    await expect(first.getByRole('heading', { name: 'Révision de la pompe · Atelier historique' })).toBeVisible();
    await firstField.fill('Et le raccord ?');
    await chat.getByRole('button', { name: 'Nouvelle conversation' }).click();
    await second.getByRole('textbox').fill('Où en est la vanne ?');
    await second.getByRole('textbox').press('Enter');
    await expect(second.getByText('La vanne est prête.')).toBeVisible();

    await page.reload();
    await opener.click();
    const list = chat.getByRole('navigation', { name: 'Conversations' });
    await expect(list.getByRole('button', { name: /Contrôle de la vanne/ })).toBeVisible();
    await list.getByRole('button', { name: /Révision de la pompe · Atelier historique/ }).click();
    await expect(first.getByText('La pompe passe en révision mardi.')).toBeVisible();
    await expect(firstField).toHaveValue('Et le raccord ?');
    await firstField.press('Enter');
    await expect(first.getByText('Le raccord est prévu.')).toBeVisible();
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain('La pompe passe en révision mardi.');

    await list.getByRole('button', { name: /Contrôle de la vanne/ }).click();
    await second.getByRole('button', { name: 'Effacer la conversation' }).click();
    await expect(list.getByRole('button', { name: /Contrôle de la vanne/ })).toHaveCount(0);
    await page.reload();
    await opener.click();
    await expect(first.getByText('Le raccord est prévu.')).toBeVisible();
    await expect(list.getByRole('button', { name: /Contrôle de la vanne/ })).toHaveCount(0);
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

test('une conversation visible à la fois et les recherches continuent pendant les autres échanges', async ({ page }) => {
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
    const reply = first ? 'Premier chantier prêt.'
      : prompt.includes('Confirme le second chantier') ? 'Le second chantier est confirmé.' : 'Second chantier prêt.';
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
    await expect(firstPane).toHaveCount(0);
    await expect(chat.getByRole('region', { name: /^Conversation \d+$/ })).toHaveCount(1);
    await expect(secondField).toHaveValue('');
    await secondField.fill('Liste du second chantier');
    await secondField.press('Enter');
    await expect(secondPane.getByText('Second chantier prêt.')).toBeVisible();
    expect(received).toHaveLength(2);
    expect(received[1]).not.toContain('Liste du premier chantier');
    const list = chat.getByRole('navigation', { name: 'Conversations' });
    const firstConversation = list.getByRole('button', { name: /^Conversation 1(?: ·|$)/ });
    const secondConversation = list.getByRole('button', { name: /^Conversation 2(?: ·|$)/ });
    await expect(firstConversation).toHaveAccessibleDescription('Recherche en cours');
    await firstConversation.click();
    await expect(firstPane.getByRole('button', { name: 'Arrêter la demande IA' })).toBeVisible();
    await expect(firstPane.locator('.ai-chat-working').locator('.ai-chat-working-icon')).toHaveCSS('animation-name', 'ai-chat-spin');
    await expect(secondPane).toHaveCount(0);
    await secondConversation.click();
    await secondField.fill('Confirme le second chantier');
    await secondField.press('Enter');
    await expect(secondPane.getByText('Le second chantier est confirmé.')).toBeVisible();
    expect(received).toHaveLength(3);
    expect(received[2]).toContain('Second chantier prêt.');
    expect(received[2]).not.toContain('Liste du premier chantier');
    await expect(firstConversation).toHaveAccessibleDescription('Recherche en cours');
    await expectNoOverflow(page);

    await page.keyboard.press('Escape');
    await expect(chat).toBeHidden();
    releaseFirst();
    await opener.click();
    await expect(secondPane.getByText('Second chantier prêt.')).toBeVisible();
    await expect(secondPane.getByText('Le second chantier est confirmé.')).toBeVisible();
    await expect(firstConversation).not.toHaveAccessibleDescription('Recherche en cours');
    await expect(firstPane).toHaveCount(0);
    await firstConversation.click();
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
  const initialDraft = '## Objectif\n\nPréparer la revue du classeur.\n\n## Étapes\n\n- Repérer les relevés concernés.\n- Fixer la date de revue.';
  const initialContent = initialDraft.replace(/^- /gm, '- [ ] ');
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
      { reply: 'La tâche est prête à créer.', actions: [{ kind: 'create_task', title, content: initialDraft }] },
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
    await expect(creation.locator('pre')).toContainText('- [ ] Repérer les relevés concernés.');
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

test('l’assistant coche la sous-tâche choisie et actualise la note de tâche ouverte', async ({ page, request }) => {
  const project = await post(request, '/api/projects', { name: 'Atelier checklist assistant' });
  const title = 'Contrôler la pression du circuit';
  const content = '- [ ] Mesurer à 3 bars\n- [ ] Noter l’heure du relevé';
  try {
    const task = await post(request, '/api/tasks', { title, project_id: project.id, content_md: content });
    await configure(page, project.id, task.entry_id);
    let noteNumber = 0;
    const prompts = await stubAssistant(page,
      (prompt) => {
        const taskLine = prompt.split('\n').find((line) => line.includes(`. ${title} [`));
        noteNumber = Number(taskLine?.match(/note principale D(\d+)/)?.[1]);
        return { read_entries: [noteNumber] };
      },
      () => ({
        reply: 'La mesure est prête à être cochée.',
        actions: [{ kind: 'update_entry', n: noteNumber, checklist_updates: [{ n: 1, checked: true }] }],
      }),
    );
    await page.goto('/');
    const progress = page.getByRole('progressbar', { name: 'Avancement de la tâche' });
    await expect(progress).toHaveAttribute('value', '0');
    await page.getByRole('banner').getByRole('button', { name: 'Ouvrir l’assistant IA', exact: true }).click();
    const chat = assistant(page);
    const field = messageField(page);
    await field.fill('Coche « Mesurer à 3 bars » dans la tâche Contrôler la pression du circuit.');
    await field.press('Enter');
    const apply = chat.getByRole('button', { name: /Appliquer .* cocher « Mesurer à 3 bars »/ });
    await expect(apply).toBeVisible();
    expect(prompts[1]).toContain('"checklist":[{"n":1,"text":"Mesurer à 3 bars","checked":false}');
    const readNote = async () => (await request.get(`/api/entries/${task.entry_id}`)).json();
    expect(await readNote()).toMatchObject({ content_md: content });
    await apply.click();
    await expect(chat.getByText('✓ Appliqué', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(progress).toHaveAttribute('value', '50');
    expect(await readNote()).toMatchObject({ content_md: content.replace('[ ] Mesurer', '[x] Mesurer'), archived: 0 });
  } finally {
    await cleanProject(page, request, project.id);
  }
});

test('l’assistant ajoute des cases à une note même si le fournisseur n’a pas demandé son texte', async ({ page, request }) => {
  const project = await post(request, '/api/projects', { name: 'Projet commandes' });
  try {
    const title = 'Retours sur la saisie des commandes';
    const content = `${'Compte rendu de la réunion. '.repeat(12).trim()}\n\n- [x] Valider la saisie client`;
    const checklist = ['Exiger une option par article', 'Vérifier la répartition de la marge',
      'Afficher tous les tarifs du client', 'Expliquer le calcul des frais dans une infobulle'];
    const append = checklist.map((label) => `- [ ] ${label}`).join('\n');
    const note = await post(request, '/api/entries', { title, project_id: project.id, content_md: content });
    await configure(page, project.id, note.id);
    const prompts = await stubAssistant(page, {
      reply: 'Je propose d’ajouter ces quatre points à la note.',
      actions: [{ kind: 'update_entry', n: 1, append_content: append }],
    });

    await page.goto('/');
    const editor = page.getByRole('region', { name: 'Entrée', exact: true });
    await expect(editor.getByLabel('Titre de l’entrée')).toHaveValue(title);
    await page.getByRole('banner').getByRole('button', { name: 'Ouvrir l’assistant IA', exact: true }).click();
    const chat = assistant(page);
    await messageField(page).fill(`Dans « ${title} » du projet commandes, ajoute ces quatre points à vérifier : ${checklist.join(', ')}.`);
    await messageField(page).press('Enter');

    const apply = chat.getByRole('button', { name: /^Appliquer/ });
    await expect(apply).toBeVisible();
    await expect(chat.getByText(/action écartée/)).toHaveCount(0);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain('Valider la saisie client');
    const readEntry = async () => (await request.get(`/api/entries/${note.id}`)).json();
    expect(await readEntry()).toMatchObject({ content_md: content });

    await apply.click();
    await expect(chat.getByText('✓ Appliqué', { exact: true })).toBeVisible();
    expect(await readEntry()).toMatchObject({ content_md: `${content}\n\n${append}` });
    await page.keyboard.press('Escape');
    for (const label of checklist) await expect(editor.getByText(label, { exact: true })).toBeVisible();
  } finally {
    await cleanProject(page, request, project.id);
  }
});

test('l’assistant ajoute un point à une liste à puces existante sans en changer la forme', async ({ page, request }) => {
  const project = await post(request, '/api/projects', { name: 'Projet saisie articles' });
  try {
    const title = 'Retours sur la saisie des articles';
    const content = '## À faire\n\n- Recherche création article direct\n- Cindy voir œuf';
    const addition = '- Vérifier la répartition de la marge livraison';
    const note = await post(request, '/api/entries', { title, project_id: project.id, content_md: content });
    await configure(page, project.id, note.id);
    const prompts = await stubAssistant(page, {
      reply: 'J’ajoute ce point à la liste existante.',
      actions: [{ kind: 'update_entry', n: 1, append_content: addition }],
    });

    await page.goto('/');
    const editor = page.getByRole('region', { name: 'Entrée', exact: true });
    await expect(editor.getByLabel('Titre de l’entrée')).toHaveValue(title);
    await page.getByRole('banner').getByRole('button', { name: 'Ouvrir l’assistant IA', exact: true }).click();
    const chat = assistant(page);
    await messageField(page).fill(`Ajoute à la liste de « ${title} » : Vérifier la répartition de la marge livraison.`);
    await messageField(page).press('Enter');

    const apply = chat.getByRole('button', { name: /^Appliquer/ });
    await expect(apply).toBeVisible();
    expect(prompts).toHaveLength(1);
    const readEntry = async () => (await request.get(`/api/entries/${note.id}`)).json();
    expect(await readEntry()).toMatchObject({ content_md: content });

    await apply.click();
    await expect(chat.getByText('✓ Appliqué', { exact: true })).toBeVisible();
    expect(await readEntry()).toMatchObject({ content_md: `${content}\n\n${addition}` });
    await page.keyboard.press('Escape');
    await expect(editor.locator('li')).toHaveCount(3);
    for (const label of ['Recherche création article direct', 'Cindy voir œuf', 'Vérifier la répartition de la marge livraison']) {
      await expect(editor.getByText(label, { exact: true })).toBeVisible();
    }
  } finally {
    await cleanProject(page, request, project.id);
  }
});

test('l’assistant rejette les puces après une checklist et réessaie en cases', async ({ page, request }) => {
  const project = await post(request, '/api/projects', { name: 'Projet commandes MM' });
  try {
    const title = 'Retour de la prise de commande';
    const content = '## À faire\n\n- [ ] Valider la saisie client\n- [ ] Vérifier la marge livraison';
    const points = [
      'Rendre impossible la création d’un article sans option en vivant',
      'Vérifier comment est répartie la marge livraison',
      'Afficher tous les tarifs dans la fiche client',
      'Ajouter une infobulle sur le calcul du tarif livraison',
    ];
    const wrongAddition = points.map((point) => `- ${point}`).join('\n');
    const addition = points.map((point) => `- [ ] ${point}`).join('\n');
    const note = await post(request, '/api/entries', { title, project_id: project.id, content_md: content });
    await configure(page, project.id, note.id);
    const prompts = await stubAssistant(page,
      {
        reply: 'J’ajoute ces quatre points à la note.',
        actions: [{ kind: 'update_entry', n: 1, append_content: wrongAddition }],
      },
      {
        reply: 'Je reprends ces points en cases à cocher.',
        actions: [{ kind: 'update_entry', n: 1, append_content: addition }],
      },
    );

    await page.goto('/');
    const editor = page.getByRole('region', { name: 'Entrée', exact: true });
    await expect(editor.getByLabel('Titre de l’entrée')).toHaveValue(title);
    await page.getByRole('banner').getByRole('button', { name: 'Ouvrir l’assistant IA', exact: true }).click();
    const chat = assistant(page);
    await messageField(page).fill(`Met à jour « ${title} » : ${points.join(', ')}.`);
    await messageField(page).press('Enter');

    const apply = chat.getByRole('button', { name: /^Appliquer/ });
    await expect(apply).toBeVisible();
    await expect(chat.getByText(/action écartée/)).toHaveCount(0);
    expect(prompts).toHaveLength(2);
    const readEntry = async () => (await request.get(`/api/entries/${note.id}`)).json();
    expect(await readEntry()).toMatchObject({ content_md: content });

    await apply.click();
    await expect(chat.getByText('✓ Appliqué', { exact: true })).toBeVisible();
    expect(await readEntry()).toMatchObject({ content_md: `${content}\n\n${addition}` });
    await page.keyboard.press('Escape');
    for (const point of points) await expect(editor.getByText(point, { exact: true })).toBeVisible();
  } finally {
    await cleanProject(page, request, project.id);
  }
});

test('l’assistant demande la forme voulue après un second refus et applique le choix', async ({ page, request }) => {
  const project = await post(request, '/api/projects', { name: 'Projet commandes forme' });
  try {
    const title = 'Retour de la prise de commande';
    const content = '## À faire\n\n- [ ] Valider la saisie client';
    const note = await post(request, '/api/entries', { title, project_id: project.id, content_md: content });
    await configure(page, project.id, note.id);
    // La note ouverte n’est pas forcément le document n° 1 : lire son numéro dans le prompt.
    const noteNumber = (prompt: string) => Number(prompt.split('\n')
      .find((line) => /^\d+\.\s/.test(line) && line.includes(title))?.match(/^(\d+)\./)?.[1]);
    const prompts = await stubAssistant(page,
      (prompt) => ({ reply: 'J’ajoute un point.', actions: [{ kind: 'update_entry', n: noteNumber(prompt), append_content: 'Paragraphe isolé.' }] }),
      (prompt) => ({ reply: 'Je ne peux pas respecter la forme.', actions: [{ kind: 'update_entry', n: noteNumber(prompt), append_content: 'Autre paragraphe.' }] }),
      (prompt) => ({ reply: 'Voici les points en cases.', actions: [{ kind: 'update_entry', n: noteNumber(prompt), append_content: '- [ ] Premier point\n- [ ] Second point' }] }),
    );

    await page.goto('/');
    const editor = page.getByRole('region', { name: 'Entrée', exact: true });
    await expect(editor.getByLabel('Titre de l’entrée')).toHaveValue(title);
    await page.getByRole('banner').getByRole('button', { name: 'Ouvrir l’assistant IA', exact: true }).click();
    const chat = assistant(page);
    await messageField(page).fill('Ajoute ces deux points à la note.');
    await messageField(page).press('Enter');

    // Deux paragraphes refusés : l’assistant pose la question au lieu de rester muet.
    const question = 'Je n’ai pas pu ajouter ces points sans casser la forme de la note. Comment veux-tu que je les ajoute ?';
    await expect(chat.getByText(question, { exact: true })).toBeVisible();
    expect(prompts).toHaveLength(2);
    expect(noteNumber(prompts[0])).toBeGreaterThan(0);
    for (const choice of ['Garde le format de la liste en place', 'Ouvre une rubrique « ## »'])
      await expect(chat.getByRole('button', { name: choice, exact: true })).toBeVisible();
    expect(await (await request.get(`/api/entries/${note.id}`)).json()).toMatchObject({ content_md: content });

    await chat.getByRole('button', { name: 'Garde le format de la liste en place', exact: true }).click();
    await expect.poll(() => prompts.length).toBe(3);
    expect(prompts[2]).toContain('Garde le format de la liste en place');
    const apply = chat.getByRole('button', { name: /^Appliquer/ });
    await expect(apply).toBeVisible();

    await apply.click();
    await expect(chat.getByText('✓ Appliqué', { exact: true })).toBeVisible();
    expect(await (await request.get(`/api/entries/${note.id}`)).json())
      .toMatchObject({ content_md: `${content}\n\n- [ ] Premier point\n- [ ] Second point` });
    await page.keyboard.press('Escape');
    await expect(editor.getByText('Premier point', { exact: true })).toBeVisible();
    await expect(editor.getByText('Second point', { exact: true })).toBeVisible();
  } finally {
    await cleanProject(page, request, project.id);
  }
});

test('l’assistant refuse une correction ciblée qui casse la forme d’une liste', async ({ page, request }) => {
  const project = await post(request, '/api/projects', { name: 'Projet contrôles' });
  try {
    const title = 'Contrôles de la semaine';
    const content = '## À faire\n\n- [ ] Vérifier la commande\n- [ ] Relancer le client';
    const note = await post(request, '/api/entries', { title, project_id: project.id, content_md: content });
    await configure(page, project.id, note.id);
    // Le second appel est le réessai automatique : le modèle ne corrige pas sa forme.
    const prompts = await stubAssistant(page,
      {
        reply: 'Je corrige ce point.',
        actions: [{ kind: 'update_entry', n: 1, text_edits: [{ find: '- [ ] Vérifier la commande', replace: 'Vérifier la commande' }] }],
      },
      { reply: 'Je ne peux pas corriger sans casser la liste.', actions: [] },
    );

    await page.goto('/');
    const editor = page.getByRole('region', { name: 'Entrée', exact: true });
    await expect(editor.getByLabel('Titre de l’entrée')).toHaveValue(title);
    await page.getByRole('banner').getByRole('button', { name: 'Ouvrir l’assistant IA', exact: true }).click();
    const chat = assistant(page);
    await messageField(page).fill(`Corrige le libellé de « ${title} ».`);
    await messageField(page).press('Enter');

    await expect(chat.getByText(/correction hors du format de la liste existante/)).toBeVisible();
    await expect(chat.getByRole('button', { name: /^Appliquer/ })).toHaveCount(0);
    expect(prompts).toHaveLength(2);
    expect(await (await request.get(`/api/entries/${note.id}`)).json()).toMatchObject({ content_md: content });
    await page.keyboard.press('Escape');
    await expect(editor.getByText('Vérifier la commande', { exact: true })).toBeVisible();
    await expect(editor.getByText('Relancer le client', { exact: true })).toBeVisible();
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
    await chat.getByText('Étapes de l’assistant', { exact: true }).click();
    await expect(chat.locator('.ai-chat-activity li')).toHaveText([
      'Lecture du contexte de travail…',
      'Préparation de la réponse, étape 1…',
      'Lecture de « Vérification du filtre »…',
      'Préparation de la réponse, étape 2…',
      'Vérification des changements proposés…',
    ]);
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
    await page.reload();
    await page.getByRole('banner').getByRole('button', { name: 'Ouvrir l’assistant IA', exact: true }).click();
    await chat.getByText('Étapes de l’assistant', { exact: true }).click();
    await expect(chat.getByText('Lecture de « Vérification du filtre »…', { exact: true })).toBeVisible();
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

test('l’assistant discute du besoin, puis reçoit les réponses aux sondages dans le même fil', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('worklogs-ai-key', 'cle-e2e'));
  const prompts = await stubAssistant(page,
    { reply: 'Définissons d’abord le résultat attendu.', question: { text: 'Quel est l’objectif ?' } },
    { question: { text: 'Quels points faut-il contrôler ?', options: ['Les délais', 'La qualité', 'Les coûts'], multiple: true } },
    { question: { text: 'Quand faut-il faire le point ?', options: ['Vendredi', 'Lundi'] } },
    { reply: 'Je retiens un contrôle des délais et de la qualité vendredi.' },
  );
  await page.goto('/');
  await page.getByRole('banner').getByRole('button', { name: 'Ouvrir l’assistant IA', exact: true }).click();
  const chat = assistant(page);
  const message = messageField(page);
  await message.fill('Aide-moi à préparer le prochain contrôle.');
  await message.press('Enter');
  await expect(chat.getByText('Quel est l’objectif ?', { exact: true })).toBeVisible();
  await chat.getByRole('group', { name: 'Quel est l’objectif ?' }).getByRole('button', { name: 'Répondre librement' }).click();
  await expect(message).toBeFocused();
  await message.fill('Préparer la reprise de l’atelier.');
  await message.press('Enter');

  const poll = chat.getByRole('group', { name: 'Quels points faut-il contrôler ?' });
  await poll.getByRole('checkbox', { name: 'La qualité' }).check();
  await poll.getByRole('checkbox', { name: 'Les délais' }).check();
  expect(prompts).toHaveLength(2);
  await poll.getByRole('button', { name: 'Répondre avec ces choix' }).click();
  const date = chat.getByRole('group', { name: 'Quand faut-il faire le point ?' });
  await date.getByRole('button', { name: 'Vendredi' }).click();
  await expect(chat.getByText('Je retiens un contrôle des délais et de la qualité vendredi.')).toBeVisible();
  expect(prompts).toHaveLength(4);
  expect(prompts[1]).toContain('Quel est l’objectif ?');
  expect(prompts[2]).toContain('Quels points faut-il contrôler ?');
  expect(prompts[2]).toContain('Les délais\nLa qualité');
  expect(prompts[3]).toContain('Quand faut-il faire le point ?');
  expect(prompts[3]).toContain('Vendredi');
  await expect(chat.getByRole('group', { name: 'Quand faut-il faire le point ?' })).toHaveCount(0);
});

test('l’assistant sans clé lit une image et un extrait de PDF dans le même message', async ({ page }) => {
  let conversions = 0;
  let inference = 0;
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ePmUAAAAASUVORK5CYII=';
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
  await page.route('https://worklogs-google.cocodexcocoder.workers.dev/ai/pdf', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    expect(request.method()).toBe('POST');
    expect(request.headers()).toMatchObject({ 'content-type': 'application/pdf' });
    expect(await request.headerValue('authorization')).toBeNull();
    expect(request.postDataBuffer()?.toString()).toBe('%PDF-1.7\nTest');
    conversions++;
    return route.fulfill({ headers, json: { text: 'La pression cible est de trois bars.', truncated: false } });
  });
  await page.route('**/chat/completions', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    expect(request.url()).toBe('https://worklogs-google.cocodexcocoder.workers.dev/ai/chat/completions');
    expect(await request.headerValue('authorization')).toBeNull();
    const body = request.postDataJSON();
    expect(body.model).toBe('worklogs-auto');
    expect(body.messages[1].content).toEqual([
      { type: 'text', text: expect.stringContaining('La pression cible est de trois bars.') },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } },
    ]);
    expect(body.messages[1].content[0].text).not.toContain('%PDF-');
    inference++;
    return route.fulfill({ headers, json: { choices: [{ message: { content: JSON.stringify({ reply: 'La pression cible est de trois bars.' }) } }] } });
  });
  await page.goto('/');
  await page.getByRole('banner').getByRole('button', { name: 'Ouvrir l’assistant IA', exact: true }).click();
  const chat = assistant(page);
  await chat.getByLabel('Fichiers à joindre').setInputFiles([
    { name: 'manuel.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nTest') },
    { name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') },
  ]);
  const draft = chat.getByRole('list', { name: 'Pièces jointes du brouillon' });
  await expect(draft.getByText('manuel.pdf')).toBeVisible();
  await expect(draft.getByText('photo.png')).toBeVisible();
  expect(conversions).toBe(0);
  expect(inference).toBe(0);

  await messageField(page).fill('Quelle pression appliquer ?');
  await chat.getByRole('button', { name: 'Envoyer', exact: true }).click();
  await expect(chat.getByText('La pression cible est de trois bars.', { exact: true })).toBeVisible();
  const sent = chat.getByRole('list', { name: 'Pièces jointes envoyées' });
  await expect(sent.getByText('manuel.pdf')).toBeVisible();
  await expect(sent.getByText('photo.png')).toBeVisible();
  expect(conversions).toBe(1);
  expect(inference).toBe(1);
});

test('sélectionne, colle et dépose des pièces, puis récupère le brouillon avant de l’envoyer', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('worklogs-ai-key', 'cle-e2e');
    localStorage.setItem('worklogs-ai-endpoint', 'https://assistant.test/v1');
    localStorage.setItem('worklogs-ai-model', 'modele-compatible');
  });
  const prompts = await stubAssistant(page, { reply: 'J’ai examiné les pièces.' }, { reply: 'Je garde le contexte.' });
  await page.setViewportSize({ width: 375, height: 680 });
  await page.goto('/');
  const opener = page.locator('.project-strip').getByRole('button', { name: 'Ouvrir l’assistant IA', exact: true });
  await opener.click();
  const chat = assistant(page);
  const picker = page.waitForEvent('filechooser');
  await chat.getByRole('button', { name: 'Joindre des fichiers' }).click();
  await (await picker).setFiles([
    { name: 'controle.ts', mimeType: 'text/plain', buffer: Buffer.from('const limite = 12;') },
    { name: 'retirer.txt', mimeType: 'text/plain', buffer: Buffer.from('Un texte que je retire.') },
    { name: 'revue.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]) },
  ]);
  const draftFiles = chat.getByRole('list', { name: 'Pièces jointes du brouillon' });
  await draftFiles.getByRole('button', { name: 'Retirer retirer.txt' }).click();
  await expect(draftFiles.getByText('controle.ts')).toBeVisible();
  await expect(draftFiles.getByText('revue.pptx')).toBeVisible();
  await expect(draftFiles.getByText('Non lu')).toBeVisible();

  const fileDrop = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['Contrôler le débit.'], 'notes.md', { type: 'text/markdown' }));
    return transfer;
  });
  await chat.locator('.ai-chat-pane').dispatchEvent('drop', { dataTransfer: fileDrop });
  await expect(draftFiles.getByText('notes.md')).toBeVisible();
  await messageField(page).evaluate((field) => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7ePmUAAAAASUVORK5CYII='), (character) => character.charCodeAt(0));
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([bytes], 'capture.png', { type: 'image/png' }));
    field.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));
  });
  await expect(draftFiles.getByText('capture.png')).toBeVisible();

  await chat.getByRole('button', { name: 'Joindre un lien' }).click();
  await chat.getByRole('textbox', { name: 'Adresse du lien' }).fill('https://example.org/documentation');
  await chat.getByRole('button', { name: 'Ajouter le lien' }).click();
  await expect(draftFiles.getByText('https://example.org/documentation')).toBeVisible();
  expect(prompts).toHaveLength(0);

  await page.reload();
  await opener.click();
  const code = '  const option = {\n    balise: "<filtre>"\n  };';
  await messageField(page).fill(code);
  await expect(draftFiles.getByRole('listitem')).toHaveCount(5);
  await expectNoOverflow(page);
  await chat.getByRole('button', { name: 'Envoyer', exact: true }).click();
  await expect(chat.getByText('J’ai examiné les pièces.')).toBeVisible();
  const sent = chat.getByRole('list', { name: 'Pièces jointes envoyées' });
  await expect(sent.getByRole('listitem')).toHaveCount(5);
  await expect(draftFiles).toHaveCount(0);
  expect(await chat.locator('.ai-chat-bubble.is-user').textContent()).toBe(code);
  expect(prompts[0]).toContain('const limite = 12;');
  expect(prompts[0]).toContain('Contrôler le débit.');
  expect(prompts[0]).toContain('[image_url]');
  expect(prompts[0]).toContain('https://example.org/documentation');
  expect(prompts[0]).toContain(code);
  expect(prompts[0]).toContain('"name":"revue.pptx","type":"file","unread":true');
  expect(prompts[0]).not.toContain('Un texte que je retire.');
  await messageField(page).fill('Et la limite du contrôle ?');
  await messageField(page).press('Enter');
  await expect(chat.getByText('Je garde le contexte.')).toBeVisible();
  expect(prompts[1]).toContain('const limite = 12;');
  expect(prompts[1]).toContain('"name":"revue.pptx","type":"file","previous":true,"unread":true');
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


test('un lien GitHub privé est lu localement avant la réponse de l’assistant', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('worklogs-ai-key', 'cle-e2e');
    localStorage.setItem('worklogs-ai-endpoint', 'https://ia.example/v1');
  });
  const url = 'https://github.com/Murgat-Ingenierie/deployer';
  const excerpt = 'README du dépôt privé — Le déploiement est lancé depuis le tableau de bord.';
  let read = 0;
  await page.route('**/api/github/link?*', (route) => {
    expect(new URL(route.request().url()).searchParams.get('url')).toBe(url);
    read += 1;
    return route.fulfill({ json: { url, text: excerpt, private: true } });
  });
  const prompts = await stubAssistant(page, { reply: 'Le déploiement se lance depuis le tableau de bord.' });
  await page.goto('/');
  await page.getByRole('banner').getByRole('button', { name: 'Ouvrir l’assistant IA', exact: true }).click();
  const chat = assistant(page);
  await chat.getByRole('button', { name: 'Joindre un lien', exact: true }).click();
  await chat.getByRole('textbox', { name: 'Adresse du lien' }).fill(url);
  await chat.getByRole('button', { name: 'Ajouter le lien', exact: true }).click();
  await messageField(page).fill('Explique le fonctionnement de ce dépôt.');
  await messageField(page).press('Enter');
  await expect(chat.getByText('Le déploiement se lance depuis le tableau de bord.', { exact: true })).toBeVisible();
  expect(read).toBe(1);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain(excerpt);
  await expect(chat.getByText(/Lien non consulté/)).toHaveCount(0);
});
