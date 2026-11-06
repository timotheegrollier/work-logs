import { afterEach, expect, test, vi } from 'vitest';
import {
  buildDraftProcedurePrompt, buildPrioritizePrompt, buildProofreadPrompt, buildSuggestPrompt,
  completeNote, extractEntryActions, suggestEntryTasks, type AiWorkContext, type PrioritizableTask,
} from './ai-suggest';

const settings = { endpoint: 'https://ia.example/v1', model: 'test', key: 'cle-test', profile: '' };
const primary = 'Pression : 2,5 bars.\n- [ ] Contrôler le joint le 2026-11-09.\n```sh\nsystemctl status pompe\n```';
const reference = { id: 'ref', title: 'Contrôler le joint', kind: 'procedure' as const, text: 'SOURCE_UNIQUE : fermer la vanne avant démontage.' };
const occurrences = (text: string, value: string) => text.split(value).length - 1;
const response = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), { status: 200 });
afterEach(() => vi.unstubAllGlobals());

test('un même extrait et son titre ne sont pas répétés, sans confondre deux procédures différentes', () => {
  const context: AiWorkContext = { sources: [reference, { ...reference, id: 'copie' }], recentNotes: [reference.title] };
  const prompt = buildSuggestPrompt('Vanne', context);
  expect(occurrences(prompt.user, reference.text)).toBe(1);
  expect(occurrences(prompt.user, reference.title)).toBe(1);
  const distinct = buildSuggestPrompt('Vanne', { sources: [reference, { ...reference, id: 'autre', title: 'Autre équipement' }, { ...reference, id: 'note', kind: 'note' }] });
  expect(occurrences(distinct.user, reference.text)).toBe(3);
  expect(distinct.user).toContain('Autre équipement');
});

test('la relecture garde la source exacte et le contexte lexical, sans les autres travaux du projet', () => {
  const prompt = buildProofreadPrompt('Pompe', primary, '', false, 'markdown', {
    project: 'Atelier', projectBrief: 'Réponses concises.', sources: [reference], vocabulary: ['joint'],
    relatedTasks: ['Réunion étrangère avec Gabin'], recentNotes: ['Préparer les congés'],
  });
  expect(prompt.user).not.toContain('Gabin');
  expect(prompt.user).not.toContain('congés');
  expect(prompt.user).toContain('Réponses concises.');
  expect(prompt.user).toContain(reference.text);
  expect(prompt.user).toContain('Vocabulaire du métier : joint');
  expect(prompt.user.endsWith(primary)).toBe(true);
});

test('les suggestions ne doublent pas les titres du planning ; l’extraction explicite reste centrée sur la note', async () => {
  const fetch = vi.fn(async () => response('[]')); vi.stubGlobal('fetch', fetch);
  const context = {
    sources: [reference], relatedTasks: ['Réparer la pompe'], recentNotes: ['Congés sans rapport'],
    relatedTaskPlanning: [{ title: 'Réparer la pompe', priority: 'high' as const, due_date: '2026-11-09' }],
  };
  await suggestEntryTasks(settings, 'Joint', primary, { context, today: '2026-11-06' });
  const suggested = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).messages[1].content;
  expect(occurrences(suggested, 'Réparer la pompe')).toBe(1);
  expect(suggested).toContain('2026-11-09');
  expect(suggested).toContain(primary);
  await extractEntryActions(settings, 'Joint', primary, { context });
  const extracted = JSON.parse((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].body as string).messages[1].content;
  expect(extracted).not.toContain('Réparer la pompe');
  expect(extracted).not.toContain('Congés sans rapport');
  expect(extracted).toContain(reference.text);
  expect(extracted).toContain(primary);
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('une procédure garde ses documents primaires entiers sans réexpédier leur texte comme référence', () => {
  const prompt = buildDraftProcedurePrompt({ origin: 'task', title: 'Réparer la vanne', sources: [reference], documents: [{ title: reference.title, text: reference.text, date: '2026-11-06' }] });
  expect(occurrences(prompt.user, reference.text)).toBe(1);
  expect(prompt.user).toContain('2026-11-06');
  expect(prompt.user).toContain('procédure');
  expect(prompt.truncated).toBe(false);
});

test('un affinement identique à la source évite une seconde copie, sans rogner la source ni son budget de sortie', async () => {
  const text = `${primary}\n${'Le circuit reste arrêté, en attente du joint.\n'.repeat(40)}`.trim();
  const fetch = vi.fn(async () => response(text)); vi.stubGlobal('fetch', fetch);
  await completeNote(settings, 'Pompe', { context: { text }, refinement: { previous: text, instruction: 'Plus court, garde les commandes.' } });
  const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
  expect(occurrences(body.messages[1].content, text)).toBe(1);
  expect(body.messages[1].content).toContain('Plus court, garde les commandes.');
  expect(body.messages[0].content).toContain('jamais une nouvelle source de faits');
  expect(body.max_tokens).toBe(8000);
  expect(fetch).toHaveBeenCalledOnce();
});

test('un nom de projet est envoyé une fois avec tous ses liens et les champs de chaque tâche', () => {
  const project = 'Atelier de maintenance hydraulique et de contrôle des circuits';
  const tasks: PrioritizableTask[] = Array.from({ length: 12 }, (_, index) => ({
    id: `secret-${index}`, title: `Circuit ${index + 1}`, status: 'doing', priority: 'high', due_date: '2026-11-09',
    pinned: 1, created_at: '2026-10-01T12:00:00Z', project, projectId: 'projet-secret', projectBrief: 'Continuité de circulation.', documents: 2,
  }));
  const prompt = buildPrioritizePrompt(tasks, { today: '2026-11-06' });
  expect(occurrences(prompt.user, project)).toBe(1);
  expect(occurrences(prompt.user, 'Continuité de circulation.')).toBe(1);
  const rows = prompt.user.split('\n').filter((line) => /^\d+ · /.test(line));
  expect(rows).toHaveLength(tasks.length);
  for (const [index, row] of rows.entries()) {
    expect(row.startsWith(`${index + 1} · ${tasks[index].title} · `)).toBe(true);
    expect(row).toContain('2026-11-09');
    expect(row).toContain('2026-10-01');
  }
  expect(prompt.user).not.toContain('projet-secret');
  expect(prompt.user).not.toContain('secret-');
});
