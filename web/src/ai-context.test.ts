import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, type AppState, type Entry, type EntrySummary, type Task } from './lib';
import { loadAiContext, readProjectAiBrief, saveProjectAiBrief, selectedAiContext } from './ai-context';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

const summary = (id: string, patch: Partial<EntrySummary> = {}): EntrySummary => ({
  id, title: `Imprimante ${id}`, project_id: 'p1', entry_date: '2026-10-21', updated_at: '2026-10-21',
  kind: 'note', excerpt: '', archived: 0, attachments: 0, ...patch,
});
const task = (id: string, patch: Partial<Task> = {}): Task => ({
  id, title: `Imprimante ${id}`, project_id: 'p1', status: 'todo', due_date: null, pinned: 0,
  position: 0, priority: 'normal', created_at: '', updated_at: '', documents: [], ...patch,
});
const entry = (item: EntrySummary, patch: Partial<Entry> = {}): Entry => ({
  ...item, content_md: `Résolution imprimante ${item.id}`, created_at: '', attachments: [], ...patch,
});

function mockState(entries: EntrySummary[], tasks: Task[] = []) {
  return vi.spyOn(api, 'state').mockResolvedValue({
    projects: [
      { id: 'p1', name: 'Atelier', color: '#123456', created_at: '', entries: 0, open_tasks: 0 },
      { id: 'p2', name: 'Autre', color: '#654321', created_at: '', entries: 0, open_tasks: 0 },
    ], entries, tasks,
    procedure_attachments: [], stats: { entries: entries.length, entriesThisWeek: 0, overdue: 0, tasks: { todo: 0, doing: 0, done: 0 } },
  } as AppState);
}

describe('contexte IA limité au projet', () => {
  test('écarte autre projet, Google, note active et archive avant toute lecture', async () => {
    const good = summary('good');
    const forbidden = [
      summary('other', { project_id: 'p2' }),
      summary('google', { google_document_id: 'google-document' }),
      summary('google-tab', { google_tab_id: 'google-tab' }),
      summary('active'), summary('archive', { archived: 1 }),
    ];
    const state = mockState([good, ...forbidden], [
      task('current'), task('open', { title: 'Vérifier le toner' }),
      task('done', { status: 'done', title: 'Facturer' }), task('other', { project_id: 'p2', title: 'Pisciculture bassin' }),
    ]);
    const read = vi.spyOn(api, 'entry').mockResolvedValue(entry(good));
    const context = await loadAiContext({ projectId: 'p1', title: 'Imprimante', entryId: 'active', taskId: 'current' });
    expect(state).toHaveBeenCalledWith('', 'p1');
    expect(read.mock.calls).toEqual([['good']]);
    expect(context.project).toBe('Atelier');
    expect(context.relatedTasks).toEqual(['Vérifier le toner']);
    expect(context.vocabulary).not.toContain('pisciculture');
    expect(context.vocabulary).not.toContain('bassin');
    expect(context.sources?.map((source) => source.id)).toEqual(['good']);
  });

  test('sans projet, ne réutilise aucune entrée ni tâche d’un projet nommé', async () => {
    const orphan = summary('orphan', { project_id: null });
    const state = mockState([summary('project'), orphan], [task('project'), task('orphan', { project_id: null, title: 'Libre' })]);
    const read = vi.spyOn(api, 'entry').mockResolvedValue(entry(orphan));
    saveProjectAiBrief(null, 'Espace personnel');
    const context = await loadAiContext({ projectId: null, title: 'Imprimante' });
    expect(state).toHaveBeenCalledWith('', '');
    expect(read.mock.calls).toEqual([['orphan']]);
    expect(context.project).toBeUndefined();
    expect(context.projectBrief).toBe('Espace personnel');
    expect(context.relatedTasks).toEqual(['Libre']);
  });

  test('ne prend pas de documents au hasard quand le titre ne correspond pas', async () => {
    mockState([summary('unrelated', { title: 'Congés annuels', excerpt: 'Planning et absences' })]);
    const read = vi.spyOn(api, 'entry');
    const context = await loadAiContext({ projectId: 'p1', title: 'Configuration imprimante' });
    expect(context.sources).toEqual([]);
    expect(context.recentNotes).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  test('un brouillon au titre générique trouve les sources et tâches pertinentes sans sortir du projet', async () => {
    const matching = summary('pump', { title: 'Entretien de la pompe', kind: 'procedure' });
    const unrelated = summary('other', { title: 'Congés annuels', excerpt: 'Planning' });
    const foreign = summary('foreign', { title: 'Pompe confidentielle', project_id: 'p2' });
    const google = summary('google', { title: 'Pompe Google', google_document_id: 'doc' });
    mockState([unrelated, matching, foreign, google], [
      ...Array.from({ length: 6 }, (_, i) => task(`a${i}`, { title: `Autre tâche ${i}` })),
      task('pump-task', { title: 'Remplacer la pompe' }),
    ]);
    const read = vi.spyOn(api, 'entry').mockResolvedValue(entry(matching, { content_md: 'Pompe : nettoyer le filtre.' }));
    const context = await loadAiContext({ projectId: 'p1', title: 'Compte rendu', text: 'La pompe présente une panne.' });
    expect(read.mock.calls).toEqual([['pump']]);
    expect(context.sources?.map((source) => source.id)).toEqual(['pump']);
    expect(context.relatedTasks?.[0]).toBe('Remplacer la pompe');
  });

  test('limite la planification aux cinq tâches ouvertes les plus pertinentes du projet', async () => {
    mockState([], [
      ...Array.from({ length: 6 }, (_, i) => task(`a${i}`, { title: `Autre pompe ${i}`, due_date: '2026-11-10' })),
      task('pump', { title: 'Réparer la pompe', priority: 'high', due_date: '2026-10-31' }),
      task('unrelated', { title: 'Comptabilité', due_date: '2026-11-12' }),
      task('done', { title: 'Pompe terminée', status: 'done', due_date: '2026-10-30' }),
      task('foreign', { title: 'Pompe privée', project_id: 'p2', due_date: '2026-11-03' }),
    ]);
    const context = await loadAiContext({ projectId: 'p1', title: 'Compte rendu', text: 'Réparer la pompe qui fuit.' });
    expect(context.relatedTaskPlanning).toHaveLength(5);
    expect(context.relatedTaskPlanning?.[0]).toEqual({ title: 'Réparer la pompe', priority: 'high', due_date: '2026-10-31' });
    expect(JSON.stringify(context.relatedTaskPlanning)).not.toContain('Pompe privée');
    expect(JSON.stringify(context.relatedTaskPlanning)).not.toContain('Pompe terminée');
    expect(JSON.stringify(context.relatedTaskPlanning)).not.toContain('Comptabilité');
  });

  test('un sujet situé en fin de brouillon long reste utilisable pour choisir un passage', async () => {
    const item = summary('pump', { title: 'Entretien', excerpt: 'Pompe de relevage' });
    mockState([item]);
    vi.spyOn(api, 'entry').mockResolvedValue(entry(item, {
      content_md: 'Ancien contenu sans rapport. '.repeat(200) + '\n\nPompe : purger avant le redémarrage.',
    }));
    const words = Array.from({ length: 100 }, (_, i) => `terme${i}`).join(' ');
    const text = words + ' introduction. '.repeat(1500) + ' La pompe de relevage fuit.';
    const context = await loadAiContext({ projectId: 'p1', title: 'Compte rendu', text });
    expect(context.sources?.[0].text).toContain('Pompe : purger avant le redémarrage.');
  });

  test('priorité aux documents liés, dédupliqués, puis aux trois sources pertinentes', async () => {
    const linked = summary('linked', { title: 'Inventaire matériel' });
    const procedure = summary('procedure', { kind: 'procedure' });
    const note = summary('note');
    const extra = summary('extra', { updated_at: '2026-01-01' });
    mockState([note, procedure, extra, linked], [task('current', { documents: [linked] })]);
    const documents = new Map([linked, procedure, note, extra].map((item) => [item.id, entry(item, { content_md: 'x'.repeat(5000) })]));
    const read = vi.spyOn(api, 'entry').mockImplementation(async (id) => documents.get(id)!);
    const context = await loadAiContext({ projectId: 'p1', title: 'Imprimante', taskId: 'current', linkedDocumentIds: ['linked', 'linked'] });
    expect(context.sources?.map((source) => source.id)).toEqual(['linked', 'procedure', 'note']);
    expect(read).toHaveBeenCalledTimes(3);
    expect(context.sources?.every((source) => source.text.length <= 2000)).toBe(true);
    expect(context.sources?.reduce((total, source) => total + source.text.length, 0)).toBeLessThanOrEqual(6000);
  });

  test('repère la pertinence dans l’extrait et garde le passage situé en fin de texte', async () => {
    const item = summary('detailed', { title: 'Compte rendu', excerpt: 'Configuration imprimante du bureau' });
    mockState([item]);
    vi.spyOn(api, 'entry').mockResolvedValue(entry(item, {
      content_md: 'Anciennes informations sans rapport. '.repeat(150)
        + '\n\nImprimante : conserver la commande lpadmin -p bureau -E exactement.',
    }));
    const context = await loadAiContext({ projectId: 'p1', title: 'Configurer imprimante' });
    expect(context.sources?.[0].text).toContain('lpadmin -p bureau -E exactement.');
    expect(context.sources?.[0].text.length).toBeLessThanOrEqual(2000);
  });

  test('préserve aussi le sujet à la fin d’un paragraphe unique très long', async () => {
    const item = summary('long');
    mockState([item]);
    vi.spyOn(api, 'entry').mockResolvedValue(entry(item, { content_md: 'Introduction. '.repeat(500) + 'Imprimante : code 0x713 à résoudre.' }));
    const context = await loadAiContext({ projectId: 'p1', title: 'Imprimante' });
    expect(context.sources?.[0].text).toContain('code 0x713 à résoudre.');
  });

  test('convertit les procédures riches et récupère les consignes locales du projet', async () => {
    const item = summary('rich', { kind: 'procedure' });
    mockState([item]);
    saveProjectAiBrief('p1', 'Garder les commandes Linux intactes');
    vi.spyOn(api, 'entry').mockResolvedValue(entry(item, {
      content_md: 'Ancien cache',
      content_json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Imprimante : vérifier CUPS' }] }] },
    }));
    const context = await loadAiContext({ projectId: 'p1', title: 'Imprimante' });
    expect(context.projectBrief).toBe('Garder les commandes Linux intactes');
    expect(context.sources?.[0].text).toBe('Imprimante : vérifier CUPS');
    expect(context.sources?.[0].kind).toBe('procedure');
  });

  test('échoue explicitement si un document sélectionné ne peut pas être lu', async () => {
    mockState([summary('missing', { title: 'Imprimante réseau' })]);
    vi.spyOn(api, 'entry').mockRejectedValue(new Error('réseau indisponible'));
    await expect(loadAiContext({ projectId: 'p1', title: 'Imprimante' }))
      .rejects.toThrow('Impossible de lire « Imprimante réseau » pour le contexte IA.');
  });

  test('bloque également si une source est devenue Google pendant son chargement', async () => {
    const item = summary('changed');
    mockState([item]);
    vi.spyOn(api, 'entry').mockResolvedValue(entry(item, { google_sync: { document_id: 'google', synced_at: null, dirty: false } }));
    await expect(loadAiContext({ projectId: 'p1', title: 'Imprimante' })).rejects.toThrow('Impossible de lire');
  });

  test('une exclusion retire le texte et le titre annexe sans modifier le contexte original', () => {
    const context = {
      project: 'Atelier', projectBrief: 'Contrainte', relatedTasks: ['Vérifier le toner'],
      sources: [
        { id: 'a', title: 'Compte rendu', kind: 'note' as const, text: 'Texte retiré' },
        { id: 'b', title: 'CUPS', kind: 'procedure' as const, text: 'Texte gardé' },
      ], recentNotes: ['Compte rendu'],
    };
    expect(selectedAiContext(context, ['a'])).toEqual({ ...context, sources: [context.sources[1]], recentNotes: [] });
    expect(context.sources).toHaveLength(2);
  });

  test('décocher une source retire aussi son vocabulaire, tout en gardant celui des autres documents et tâches', async () => {
    const privateSource = summary('private', { title: 'Pompe zirchon' });
    const otherSource = summary('other', { title: 'Pompe rotor' });
    mockState([privateSource, otherSource, summary('foreign', { title: 'Pompe confidentiel', project_id: 'p2' })], [task('task', { title: 'Pompe moteur' })]);
    vi.spyOn(api, 'entry').mockImplementation(async (id) => entry(id === 'private' ? privateSource : otherSource));
    const full = await loadAiContext({ projectId: 'p1', title: 'Pompe' });
    expect(full.vocabulary).toContain('zirchon');
    expect(full.vocabulary).not.toContain('confidentiel');
    const selected = selectedAiContext(full, ['private']);
    expect(selected.vocabulary).not.toContain('zirchon');
    expect(selected.vocabulary).toEqual(expect.arrayContaining(['rotor', 'moteur']));
    expect(selected.sources?.map((source) => source.id)).toEqual(['other']);
    expect(selected.vocabularyInputs).toBeUndefined();
    expect(full.vocabulary).toContain('zirchon');
    expect(selectedAiContext(full, []).vocabulary).toContain('zirchon');
  });
});

describe('fiche IA facultative par projet', () => {
  test('sépare les projets, borne le texte et efface une fiche vidée', () => {
    saveProjectAiBrief('p1', '  Contexte atelier  ');
    saveProjectAiBrief('p2', 'x'.repeat(2300));
    saveProjectAiBrief(null, 'Personnel');
    expect(readProjectAiBrief('p1')).toBe('Contexte atelier');
    expect(readProjectAiBrief('p2')).toHaveLength(2000);
    expect(readProjectAiBrief(null)).toBe('Personnel');
    saveProjectAiBrief('p1', '   ');
    expect(readProjectAiBrief('p1')).toBe('');
    expect(readProjectAiBrief('p2')).toHaveLength(2000);
  });

  test('tolère stockage corrompu ou indisponible', () => {
    localStorage.setItem('worklogs-ai-project-contexts', '{cassé');
    expect(readProjectAiBrief('p1')).toBe('');
    saveProjectAiBrief('p1', 'Atelier');
    expect(readProjectAiBrief('p1')).toBe('Atelier');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('refusé'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('refusé'); });
    expect(readProjectAiBrief('p1')).toBe('');
    expect(() => saveProjectAiBrief('p1', 'Atelier')).not.toThrow();
  });
});
