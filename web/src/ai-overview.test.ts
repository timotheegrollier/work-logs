import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  AiCancelled, AiError, buildDailyReviewPrompt, buildReplanPrompt, generateDailyReview,
  MAX_DAILY_FOLLOW_UPS, MAX_DAILY_REVIEW_CHARS, MAX_REPLANNED_TASKS, replanTasks,
  type DailyFollowUpInput, type PrioritizableTask,
} from './ai-suggest';
import type { FollowUp } from './lib';

const settings = { endpoint: 'https://ia.example/v1', model: 'test', key: 'cle-test', profile: 'Maintenance des bassins' };
const today = '2026-11-05';
const followUp: FollowUp = {
  enabled: true, enabled_at: '2026-11-04T08:00:00Z',
  report: {
    generated_at: '2026-11-05T11:00:00Z', source_key: 'source-actuelle', status: 'blocked',
    summary: 'Le diagnostic est fait ; le remplacement attend la pièce.',
    completed: ['Le 2026-11-04 : diagnostic terminé.'],
    next_steps: ['Remplacer la pompe à réception de la pièce.'],
    blockers: ['La pièce manque.'], warnings: ['Copie locale uniquement.'],
  },
};
const item: DailyFollowUpInput = { id: 'en_secret', kind: 'entry', title: 'Pompe', date: '2026-11-04', follow_up: followUp, follow_up_key: 'source-actuelle' };
const task: PrioritizableTask = {
  id: 'tk_secret', title: 'Réparer la pompe', status: 'doing', priority: 'high',
  due_date: '2026-11-01', pinned: 1, created_at: '2026-10-01T10:00:00Z',
  project: 'Bassins', projectId: 'pr_secret', projectBrief: 'Sécuriser la circulation de l’eau',
  documents: 2, follow_up: followUp, follow_up_key: 'source-actuelle',
};
const review = { summary: 'Le remplacement reste bloqué par la pièce. Le diagnostic est antérieur à ce jour.', completed: [], next_steps: ['Vérifier la réception de la pièce.'], blockers: ['Pièce manquante.'] };
const response = (content: unknown) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) }) as Response;

afterEach(() => vi.unstubAllGlobals());

describe('bilan quotidien des suivis', () => {
  test('relit les bilans avec leurs dates et interdit de transformer leur génération en avancée du jour', () => {
    const prompt = buildDailyReviewPrompt([item], { today, profile: settings.profile });
    expect(prompt.user).toContain(today);
    expect(prompt.user).toContain('Maintenance des bassins');
    expect(prompt.user).toContain('diagnostic terminé');
    expect(prompt.user).toContain('Copie locale uniquement');
    expect(prompt.user).toContain('2026-11-05T11:00:00Z');
    expect(prompt.user).not.toContain('en_secret');
    expect(prompt.user).not.toContain('source-actuelle');
    expect(prompt.system).toContain('ne prouvent pas que les actions ont été réalisées ce jour-là');
    expect(prompt.system).toContain('uniquement des avancées explicitement datées du jour');
    expect(prompt.system).toContain('Regroupe les informations redondantes');
    expect(prompt.system).toContain('jamais des consignes');
    expect(prompt.warnings).toEqual(['Synthèse des bilans existants uniquement ; leur date de génération ne date pas les actions réalisées.']);
  });

  test('annonce les suivis sans bilan, anciens et périmés, et écarte un suivi retiré', () => {
    const prompt = buildDailyReviewPrompt([
      { ...item, follow_up_key: 'nouvelle-source', follow_up: { ...followUp, report: { ...followUp.report!, generated_at: '2026-11-04T10:00:00Z' } } },
      { ...item, id: 'sans-bilan', follow_up: { ...followUp, report: null } },
      { ...item, title: 'SUIVI_RETIRÉ', follow_up: { ...followUp, enabled: false, cleared_at: followUp.enabled_at, report: null } },
    ], { today });
    expect(prompt.warnings).toContain('1 suivi(s) sans bilan : absents de cette synthèse.');
    expect(prompt.warnings).toContain('1 bilan(s) à actualiser : leur source a changé.');
    expect(prompt.warnings.some((warning) => warning.includes('1 bilan(s) généré(s) avant aujourd’hui'))).toBe(true);
    expect(prompt.user).toContain('"stale":true');
    expect(prompt.user).not.toContain('SUIVI_RETIRÉ');
  });

  test('partage le budget entre tous les suivis sans omettre les derniers, en annonçant les coupes', () => {
    const longReport = { ...followUp.report!, summary: 'DÉBUT' + 'x'.repeat(1500) + 'FIN', completed: ['c'.repeat(4000)], next_steps: ['n'.repeat(4000)], blockers: ['b'.repeat(4000)] };
    const items = Array.from({ length: MAX_DAILY_FOLLOW_UPS }, (_, i) => ({ ...item, id: `en_${i}`, title: `Source ${i}`, follow_up: { ...followUp, report: { ...longReport, summary: `${longReport.summary} ${i}` } } }));
    const prompt = buildDailyReviewPrompt(items, { today });
    const data = JSON.parse(prompt.user.split('\n\n')[0]);
    expect(data.reports).toHaveLength(MAX_DAILY_FOLLOW_UPS);
    expect(data.reports.at(-1).title).toBe('Source 59');
    const total = data.reports.reduce((sum: number, report: Record<string, string>) => sum + ['summary', 'completed', 'next_steps', 'blockers'].reduce((part, key) => part + report[key].length, 0), 0);
    expect(total).toBeLessThanOrEqual(MAX_DAILY_REVIEW_CHARS);
    expect(data.reports[0].summary).toContain('DÉBUT');
    expect(data.reports[0].summary).toContain('FIN');
    expect(prompt.warnings.some((warning) => warning.includes('60 bilan(s) abrégé(s)'))).toBe(true);
  });

  test('mutualise seulement les détails identiques et garde les dates, fraîcheurs, états et limites de chaque bilan', () => {
    const common = followUp.report!;
    const items: DailyFollowUpInput[] = [
      { ...item, id: 'a_secret', title: 'Premier constat' },
      { ...item, id: 'b_secret', title: 'Copie du constat', date: '2026-11-01', follow_up_key: 'source_modifiee', follow_up: { ...followUp, report: { ...common, generated_at: '2026-11-04T10:00:00Z', status: 'done', warnings: [...common.warnings, 'Source ancienne à vérifier.'] } } },
      { ...item, id: 'c_secret', title: 'Situation différente', follow_up: { ...followUp, report: { ...common, blockers: ['La pièce ne manque plus.'] } } },
      { ...item, id: 'd_secret', title: 'Dernière copie' },
    ];
    const prompt = buildDailyReviewPrompt(items, { today });
    const data = JSON.parse(prompt.user.split('\n\n')[0]);
    expect(data.reports[1]).toMatchObject({ n: 2, title: 'Copie du constat', entry_date: '2026-11-01', generated_at: '2026-11-04T10:00:00Z', stale: true, status: 'done', same_details_as: 1 });
    expect(data.reports[1].summary).toBeUndefined();
    expect(data.reports[2].same_details_as).toBeUndefined();
    expect(data.reports[2].blockers).toBe('La pièce ne manque plus.');
    const shared = data.reports[data.reports[1].same_details_as - 1];
    expect(shared.same_details_as).toBeUndefined();
    expect(shared.summary).toBe(common.summary);
    expect(data.reports[3].same_details_as).toBe(1);
    expect(data.reading_limits).toEqual(['Copie locale uniquement.', 'Source ancienne à vérifier.']);
    expect(data.reports.map((value: { limits: number[] }) => value.limits)).toEqual([[1], [1, 2], [1], [1]]);
    expect(prompt.system).toContain('same_details_as');
    expect(prompt.user).not.toMatch(/a_secret|b_secret|c_secret|d_secret|source_modifiee/);
  });

  test('soixante copies d’un même bilan ne forcent pas l’abrègement de son contenu unique', () => {
    const common = {
      ...followUp.report!, summary: 'Résumé conservé. '.repeat(70),
      completed: Array.from({ length: 8 }, (_, i) => `Avancée ${i} : ${'a'.repeat(470)}`),
      next_steps: Array.from({ length: 8 }, (_, i) => `Action ${i} : ${'n'.repeat(470)}`),
      blockers: Array.from({ length: 8 }, (_, i) => `Blocage ${i} : ${'b'.repeat(470)}`),
    };
    const items = Array.from({ length: MAX_DAILY_FOLLOW_UPS }, (_, i) => ({ ...item, id: `en_${i}`, title: `Source ${i}`, follow_up: { ...followUp, report: common } }));
    const prompt = buildDailyReviewPrompt(items, { today });
    const data = JSON.parse(prompt.user.split('\n\n')[0]);
    expect(data.reports[0]).toMatchObject({ summary: common.summary, completed: common.completed.join('\n'), next_steps: common.next_steps.join('\n'), blockers: common.blockers.join('\n') });
    expect(data.reports.slice(1).every((value: { same_details_as?: number; summary?: string }) => value.same_details_as === 1 && value.summary === undefined)).toBe(true);
    expect(prompt.warnings.some((warning) => warning.includes('abrégé'))).toBe(false);
  });

  test('le budget des champs vides laisse les résumés courts et leurs dernières informations intacts', () => {
    const items = Array.from({ length: MAX_DAILY_FOLLOW_UPS }, (_, i) => ({
      ...item, id: `en_${i}`, title: `Source ${i}`,
      follow_up: { ...followUp, report: { ...followUp.report!, summary: `Début ${i}. ${'Information enregistrée. '.repeat(11)}Fin ${i}.`, completed: [], next_steps: [], blockers: [] } },
    }));
    const prompt = buildDailyReviewPrompt(items, { today });
    const data = JSON.parse(prompt.user.split('\n\n')[0]);
    expect(data.reports.map((value: { summary: string }) => value.summary)).toEqual(items.map((value) => value.follow_up.report.summary));
    expect(prompt.warnings.some((warning) => warning.includes('abrégé'))).toBe(false);
  });

  test('une tâche ouverte renvoie à son bilan sans répéter son titre, avec sa vraie priorité et son échéance', () => {
    const prompt = buildDailyReviewPrompt([
      { ...item, id: 'tk_secret_suivie', kind: 'task', title: 'TITRE_UNIQUE_SUIVI', status: 'doing', priority: 'high', due_date: '2026-11-09' },
      { id: 'tk_secret_sans_suivi', kind: 'task', title: 'Autre travail', status: 'todo', priority: 'low', due_date: null },
    ], { today });
    const data = JSON.parse(prompt.user.split('\n\n')[0]);
    expect(data.open_tasks).toEqual([
      { n: 1, report: 1, status: 'doing', priority: 'high', due_date: '2026-11-09' },
      { n: 2, title: 'Autre travail', status: 'todo', priority: 'low', due_date: null },
    ]);
    expect(prompt.user.match(/TITRE_UNIQUE_SUIVI/g)).toHaveLength(1);
    expect(data.reports[0].status).toBe('blocked');
    expect(prompt.user).not.toContain('tk_secret');
  });

  test('borne aussi les tâches ouvertes sans suivi avant tout appel réseau', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const items = Array.from({ length: MAX_DAILY_FOLLOW_UPS + 1 }, (_, i) => ({ id: `task_${i}`, kind: 'task' as const, title: `Tâche ${i}`, status: 'todo' as const }));
    await expect(generateDailyReview(settings, items, { today })).rejects.toThrow(/Trop de/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('refuse le vide et le dépassement avant un appel, sans tronquer la sélection', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(generateDailyReview(settings, [], { today })).rejects.toThrow('Aucun bilan de suivi');
    await expect(generateDailyReview(settings, Array(MAX_DAILY_FOLLOW_UPS + 1).fill(item), { today })).rejects.toThrow('Trop de suivis');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('lit la totalité des tâches non terminées : les ouvertes entrent dans le bilan, seules les suivies fournissent des bilans', async () => {
    const prompt = buildDailyReviewPrompt([{ id: 'tk_ouvrante', kind: 'task', title: 'Réparer la pompe', status: 'doing', follow_up: null }], { today });
    expect(prompt.user).toContain('Réparer la pompe');
    expect(prompt.user).toContain('"open_tasks"');
    const fetch = vi.fn(async () => response(JSON.stringify(review)));
    vi.stubGlobal('fetch', fetch);
    const result = await generateDailyReview(settings, [{ id: 'tk_ouvrante', kind: 'task', title: 'Réparer la pompe', status: 'doing', follow_up: null }], { today });
    expect(result).toMatchObject(review);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('rend une synthèse validée et les limites locales, jamais les avertissements inventés par le modèle', async () => {
    const fetch = vi.fn(async () => response(`Voici :\n\`\`\`json\n${JSON.stringify({ ...review, warnings: ['Tout est actuel et vérifié.'] })}\n\`\`\``));
    vi.stubGlobal('fetch', fetch);
    const result = await generateDailyReview(settings, [item], { today });
    expect(result).toMatchObject(review);
    expect(result.warnings).toEqual(buildDailyReviewPrompt([item], { today }).warnings);
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.messages[1].content).toContain('Maintenance des bassins');
  });

  test.each([
    { ...review, summary: '' },
    { ...review, completed: undefined }, { ...review, next_steps: [1] },
  ])('refuse une synthèse incomplète ou hors contrat (%j)', async (invalid) => {
    vi.stubGlobal('fetch', vi.fn(async () => response(JSON.stringify(invalid))));
    await expect(generateDailyReview(settings, [item], { today })).rejects.toBeInstanceOf(AiError);
  });

  test('rogne une synthèse qui dépasse de peu plutôt que de perdre l’appel', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(JSON.stringify({
      ...review, summary: 'a'.repeat(1501), next_steps: ['x'.repeat(501)],
      blockers: Array.from({ length: 9 }, (_, index) => `Blocage ${index}`),
    }))));
    const result = await generateDailyReview(settings, [item], { today });
    expect(result.summary).toBe('a'.repeat(1500));
    expect(result.next_steps).toEqual(['x'.repeat(500)]);
    expect(result.blockers).toHaveLength(8);
  });

  test('l’activité du jour part bornée dans le JSON, avec sa règle de preuve', async () => {
    const fetch = vi.fn(async () => response(JSON.stringify(review)));
    vi.stubGlobal('fetch', fetch);
    const doneTasks = ['Joint V12 remplacé', 'y'.repeat(200), ...Array.from({ length: 25 }, (_, index) => `Tâche ${index}`)];
    await generateDailyReview(settings, [item], { today, todayActivity: { doneTasks, notes: ['Note du jour'] } });
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    const data = JSON.parse(body.messages[1].content.split('\n\n')[1]);
    expect(data.today_activity.done_tasks).toHaveLength(20);
    expect(data.today_activity.done_tasks[0]).toBe('Joint V12 remplacé');
    expect(data.today_activity.done_tasks[1]).toBe('y'.repeat(119) + '…');
    expect(data.today_activity.notes).toEqual(['Note du jour']);
    expect(body.messages[0].content).toContain('sa date de clôture est inconnue');
    expect(body.messages[0].content).toContain('« Tâche terminée ou retouchée aujourd\'hui : titre »');
    expect(body.messages[0].content).not.toContain('« Tâche terminée : titre »');
    expect(body.messages[0].content).toContain('prouve seulement qu\'une note a été écrite');
    expect(buildDailyReviewPrompt([item], { today, todayActivity: { doneTasks: [], notes: [] } }).warnings.at(-1)).toContain('et des titres de l’activité du jour');
    expect(JSON.parse(buildDailyReviewPrompt([item], { today }).user.split('\n\n')[0])).not.toHaveProperty('today_activity');
  });

  test('un bilan de tâche porte le statut réel de la tâche, y compris terminée ; jamais un bilan d’entrée', () => {
    const data = JSON.parse(buildDailyReviewPrompt([
      { ...item, id: 'tk_finie', kind: 'task', title: 'Tâche finie', status: 'done' },
      { ...item, id: 'en_note', title: 'Note suivie' },
    ], { today }).user.split('\n\n')[0]);
    expect(data.reports[0]).toMatchObject({ status: 'blocked', task_status: 'done' });
    expect(data.reports[1]).not.toHaveProperty('task_status');
  });
});

describe('replanification des tâches selon leur importance', () => {
  test('fournit priorité, échéance et suivi, distingue impact réel et ancien retard, sans ids locaux', () => {
    const prompt = buildReplanPrompt([{ ...task, follow_up_key: 'source-modifiée' }, { ...task, id: 'done', title: 'TÂCHE_TERMINÉE', status: 'done' }], { today, profile: settings.profile });
    expect(prompt.user).toContain('Sécuriser la circulation');
    expect(prompt.user).toContain('La pièce manque');
    expect(prompt.user).toContain('"stale":true');
    expect(prompt.user).toContain('2026-11-01');
    expect(prompt.user).not.toContain('tk_secret');
    expect(prompt.user).not.toContain('pr_secret');
    expect(prompt.user).not.toContain('source-modifiée');
    expect(prompt.user).not.toContain('TÂCHE_TERMINÉE');
    expect(prompt.system).toContain("Une tâche ancienne en retard n'est pas automatiquement");
    expect(prompt.system).toContain('est une estimation à confirmer');
    expect(prompt.system).toContain(`jamais avant ${today}`);
    expect(prompt.system).toContain("sans tout concentrer aujourd'hui");
    expect(prompt.system).toContain('ni les durées, ni la disponibilité, ni les jours travaillés');
  });

  test('refuse aucune tâche ouverte et plus de 60 ouvertes, avant tout appel', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(replanTasks(settings, [{ ...task, status: 'done' }], { today })).rejects.toThrow('Aucune tâche ouverte');
    await expect(replanTasks(settings, Array(MAX_REPLANNED_TASKS + 1).fill(task), { today })).rejects.toThrow('Trop de tâches');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('accepte les dates valides à partir d’aujourd’hui, refuse dates impossibles/passées, numéros altérés, doublons et priorités inconnues', async () => {
    const tasks = Array.from({ length: 7 }, (_, n) => ({ ...task, id: `task_${n + 1}` }));
    const fetch = vi.fn(async () => response(JSON.stringify([
      { n: '1', priority: 'high', due_date: today, reason: 'Numéro texte altéré' },
      { n: 1, priority: 'high', due_date: today, reason: ' Priorité réelle, date estimée. ' },
      { n: 1, priority: 'low', due_date: '2026-11-07', reason: 'Doublon à ignorer.' },
      { n: 2, priority: 'normal', due_date: '2026-11-04', reason: 'Passée' },
      { n: 3, priority: 'normal', due_date: '2026-02-30', reason: 'Impossible' },
      { n: 4, priority: 'urgent', due_date: today, reason: 'Inconnue' },
      { n: 5, priority: 'normal', due_date: '2026-11-08', reason: '' },
      { n: 6.2, priority: 'low', due_date: '2026-11-09', reason: 'Numéro non entier' },
      { n: 100, priority: 'low', due_date: '2026-11-09', reason: 'Inconnue' },
      { n: 7, priority: 'low', due_date: '2026-11-12', reason: 'Date estimée : ' + 'x'.repeat(300) },
    ])));
    vi.stubGlobal('fetch', fetch);
    const result = await replanTasks(settings, tasks, { today });
    expect(result).toEqual([
      { id: 'task_1', priority: 'high', due_date: today, reason: 'Priorité réelle, date estimée.' },
      { id: 'task_7', priority: 'low', due_date: '2026-11-12', reason: expect.any(String) },
    ]);
    expect(result[1].reason).toHaveLength(240);
    expect(tasks[0].due_date).toBe('2026-11-01');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('une réponse sans date exploitable ne devient pas une proposition', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(JSON.stringify([{ n: 1, priority: 'high', due_date: null, reason: 'Pas de date' }]))));
    await expect(replanTasks(settings, [task], { today })).rejects.toThrow('aucune date de tâche reconnue');
  });

  test('les deux gestes respectent la clé manquante et l’annulation avant ou pendant la demande', async () => {
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('arrêté', 'AbortError')));
    }));
    vi.stubGlobal('fetch', fetch);
    for (const generate of [
      (config: typeof settings & { signal?: AbortSignal }) => generateDailyReview(config, [item], { today }),
      (config: typeof settings & { signal?: AbortSignal }) => replanTasks(config, [task], { today }),
    ]) {
      await expect(generate({ ...settings, key: '' })).rejects.toThrow('Colle ta clé IA');
      const stopped = new AbortController(); stopped.abort();
      const calls = fetch.mock.calls.length;
      await expect(generate({ ...settings, signal: stopped.signal })).rejects.toBeInstanceOf(AiCancelled);
      expect(fetch).toHaveBeenCalledTimes(calls);
      const controller = new AbortController();
      const pending = generate({ ...settings, signal: controller.signal });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(calls + 1));
      controller.abort();
      await expect(pending).rejects.toBeInstanceOf(AiCancelled);
      expect(fetch).toHaveBeenCalledTimes(calls + 1);
    }
  });
});
