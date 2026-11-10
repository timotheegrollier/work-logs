import { afterEach, describe, expect, test, vi } from 'vitest';
import { api, type AppState, type Entry, type EntrySummary, type Task } from './lib';
import { contextWords, loadAiContext, readProjectAiBrief, saveProjectAiBrief, selectedAiContext } from './ai-context';
import { buildSuggestPrompt } from './ai-suggest';
import { seedData, useRealApi } from './test/server';

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

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Comme la vraie recherche : sous-chaîne repliée, dans le titre et le texte complet (`bodies`). */
function mockState(entries: EntrySummary[], tasks: Task[] = [], bodies: Record<string, string> = {}) {
  return vi.spyOn(api, 'state').mockImplementation(async (q = '') => ({
    projects: [
      { id: 'p1', name: 'Atelier', color: '#123456', created_at: '', entries: 0, open_tasks: 0 },
      { id: 'p2', name: 'Autre', color: '#654321', created_at: '', entries: 0, open_tasks: 0 },
    ], entries: entries.filter((item) => fold(`${item.title}\n${item.excerpt}\n${bodies[item.id] ?? ''}`).includes(fold(q))), tasks,
    procedure_attachments: [], stats: { entries: entries.length, entriesThisWeek: 0, overdue: 0, tasks: { todo: 0, doing: 0, done: 0 } },
  } as AppState));
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
      task('current'), task('open', { title: 'Vérifier le toner imprimante' }),
      task('done', { status: 'done', title: 'Facturer' }), task('other', { project_id: 'p2', title: 'Pisciculture bassin' }),
    ]);
    const read = vi.spyOn(api, 'entry').mockResolvedValue(entry(good));
    const context = await loadAiContext({ projectId: 'p1', title: 'Imprimante', entryId: 'active', taskId: 'current' });
    expect(state).toHaveBeenCalledWith('', 'p1');
    expect(read.mock.calls).toEqual([['good']]);
    expect(context.project).toBe('Atelier');
    expect(context.relatedTasks).toEqual(['Vérifier le toner imprimante']);
    expect(context.vocabulary).not.toContain('pisciculture');
    expect(context.vocabulary).not.toContain('bassin');
    expect(context.sources?.map((source) => source.id)).toEqual(['good']);
  });

  test('sans projet, ne réutilise aucune entrée ni tâche d’un projet nommé', async () => {
    const orphan = summary('orphan', { project_id: null });
    const state = mockState([summary('project'), orphan], [task('project'), task('orphan', { project_id: null, title: 'Imprimante libre' })]);
    const read = vi.spyOn(api, 'entry').mockResolvedValue(entry(orphan));
    saveProjectAiBrief(null, 'Espace personnel');
    const context = await loadAiContext({ projectId: null, title: 'Imprimante' });
    expect(state).toHaveBeenCalledWith('', '');
    expect(read.mock.calls).toEqual([['orphan']]);
    expect(context.project).toBeUndefined();
    expect(context.projectBrief).toBe('Espace personnel');
    expect(context.relatedTasks).toEqual(['Imprimante libre']);
  });

  test('ne prend pas de documents au hasard quand le titre ne correspond pas', async () => {
    mockState([summary('unrelated', { title: 'Congés annuels', excerpt: 'Planning et absences' })], [
      task('budget', { title: 'Budget Gabin' }), task('meeting', { title: 'Appeler Gabin' }),
    ]);
    const read = vi.spyOn(api, 'entry');
    const context = await loadAiContext({ projectId: 'p1', title: 'Configuration imprimante' });
    expect(context.sources).toEqual([]);
    expect(context.relatedTasks).toEqual([]);
    expect(context.relatedTaskPlanning).toEqual([]);
    expect(context.vocabulary).toEqual([]);
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
    expect(context.relatedTasks).toEqual(['Remplacer la pompe']);
    expect(context.vocabulary).not.toContain('autre');
  });

  test('deux comptes rendus ne sont pas liés par leur seul intitulé générique', async () => {
    const matching = summary('pump', { title: 'Entretien pompe', kind: 'procedure' });
    const unrelated = summary('meeting', { title: 'Compte rendu', excerpt: 'Réunion avec Gabin.' });
    mockState([unrelated, matching], [task('meeting-task', { title: 'Rédiger le compte rendu' })]);
    const read = vi.spyOn(api, 'entry').mockResolvedValue(entry(matching, { content_md: 'Pompe : contrôler le joint.' }));
    const context = await loadAiContext({ projectId: 'p1', title: 'Compte rendu', text: 'La pompe fuit.' });
    expect(read.mock.calls).toEqual([['pump']]);
    expect(context.relatedTasks).toEqual([]);
    expect(JSON.stringify(context)).not.toContain('Gabin');
  });

  test('le mot compte reste pertinent hors de l’expression compte rendu', async () => {
    const item = summary('account', { title: 'Accès au compte' });
    mockState([item]);
    const read = vi.spyOn(api, 'entry').mockResolvedValue(entry(item, { content_md: 'Compte : vérifier les droits.' }));
    const context = await loadAiContext({ projectId: 'p1', title: 'Compte Google' });
    expect(read.mock.calls).toEqual([['account']]);
    expect(context.sources?.[0].text).toContain('vérifier les droits');
  });

  test('garde une tâche explicitement liée même si son titre ne reprend pas le sujet', async () => {
    const active = summary('active', { title: 'Panne de la pompe' });
    mockState([active], [
      task('linked', { title: 'Commander le joint', documents: [active], priority: 'high', due_date: '2026-11-10' }),
      task('unrelated', { title: 'Appeler Gabin' }),
    ]);
    const read = vi.spyOn(api, 'entry');
    const context = await loadAiContext({ projectId: 'p1', title: 'Panne de la pompe', entryId: active.id });
    expect(context.relatedTasks).toEqual(['Commander le joint']);
    expect(context.relatedTaskPlanning).toEqual([{ title: 'Commander le joint', priority: 'high', due_date: '2026-11-10' }]);
    expect(context.vocabulary).not.toContain('gabin');
    expect(read).not.toHaveBeenCalled();
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

  test('un passage ciblé et ses voisins remplacent le remplissage hors sujet, sans changer les faits utiles', async () => {
    const item = summary('pump', { title: 'Pompe de relevage' });
    const useful = 'Pompe de relevage : fermer la vanne avant le démontage. Contrôler la pression : 3 bar maximum.';
    const unrelated = Array.from({ length: 40 }, (_, index) => `Réunion administrative ${index} : revue du budget commercial et des horaires de transport.`).join('\n\n');
    mockState([item]);
    vi.spyOn(api, 'entry').mockResolvedValue(entry(item, { content_md: unrelated + '\n\n' + useful + '\n\n' + unrelated }));
    const context = await loadAiContext({ projectId: 'p1', title: 'Pompe de relevage' });
    const excerpt = context.sources![0].text;
    expect(excerpt).toContain(useful);
    expect(excerpt).toContain('Réunion administrative 39');
    expect(excerpt).toContain('Réunion administrative 0');
    expect(excerpt).not.toContain('Réunion administrative 20');
    // Le même corpus produisait 1 976 caractères avant la sélection du voisinage.
    expect(excerpt.length).toBeLessThan(1976 * 0.2);
    expect(excerpt.startsWith('[…]')).toBe(true);
    expect(excerpt.endsWith('[…]')).toBe(true);
  });

  test('conserve la section pertinente, ses titres parents, toutes ses étapes et son avertissement', async () => {
    const item = summary('pump', { title: 'Maintenance pompe' });
    const steps = '1. Couper l’alimentation.\n\n2. Fermer la vanne.\n\n3. Contrôler la pression : 3 bar maximum.';
    const warning = '⚠ Ne jamais redémarrer sans remettre le cache.';
    mockState([item]);
    vi.spyOn(api, 'entry').mockResolvedValue(entry(item, { content_md: `# Atelier\n\n## Administration\n\nRéunion avec Gabin.\n\n## Pompe\n\n${steps}\n\n${warning}\n\n## Comptabilité\n\nFacturer la réunion.` }));
    const excerpt = (await loadAiContext({ projectId: 'p1', title: 'Pompe' })).sources![0].text;
    expect(excerpt).toContain('# Atelier');
    expect(excerpt).toContain('## Pompe');
    expect(excerpt).toContain(steps);
    expect(excerpt).toContain(warning);
    expect(excerpt).not.toContain('Gabin');
    expect(excerpt).not.toContain('Facturer');
    expect(excerpt.length).toBeLessThanOrEqual(2000);
  });

  test('ne sépare pas les lignes d’une commande ni les étapes espacées d’une liste', async () => {
    const item = summary('pump', { title: 'Pompe' });
    const code = '```sh\n# Arrêt contrôlé\n\npompe --stop\n\n# Limite de pression\npression --max 3\n```';
    const steps = '1. Couper l’alimentation.\n\n2. Purger la pompe.\n\n3. Remonter le cache.';
    mockState([item]);
    vi.spyOn(api, 'entry').mockResolvedValue(entry(item, { content_md: `Administration.\n\n${code}\n\n${steps}\n\n⚠ Attendre le refroidissement.\n\nComptabilité.\n\nAutre réunion.` }));
    const excerpt = (await loadAiContext({ projectId: 'p1', title: 'Pompe' })).sources![0].text;
    expect(excerpt).toContain(code);
    expect(excerpt).toContain(steps);
    expect(excerpt).toContain('⚠ Attendre le refroidissement.');
    expect(excerpt).not.toContain('Autre réunion.');
  });

  test('une source trouvée par son titre ou un lien reste lisible sans mot commun dans son texte', async () => {
    const byTitle = summary('title', { title: 'Pompe' });
    const linked = summary('linked', { title: 'Inventaire' });
    const content = 'Couper l’alimentation.\n\nFermer l’arrivée.\n\nAttendre le refroidissement.';
    mockState([byTitle, linked], [task('current', { documents: [linked] })]);
    vi.spyOn(api, 'entry').mockImplementation(async (id) => entry(id === 'title' ? byTitle : linked, { content_md: content }));
    const context = await loadAiContext({ projectId: 'p1', title: 'Pompe', taskId: 'current' });
    expect(context.sources?.map((source) => source.id)).toEqual(['linked', 'title']);
    expect(context.sources?.map((source) => source.text)).toEqual([content, content]);
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

  test('une exclusion retire la source sans modifier le contexte original', () => {
    const context = {
      project: 'Atelier', projectBrief: 'Contrainte', relatedTasks: ['Vérifier le toner'],
      sources: [
        { id: 'a', title: 'Compte rendu', kind: 'note' as const, text: 'Texte retiré' },
        { id: 'b', title: 'CUPS', kind: 'procedure' as const, text: 'Texte gardé' },
      ],
    };
    expect(selectedAiContext(context, ['a'])).toEqual({ ...context, sources: [context.sources[1]] });
    expect(context.sources).toHaveLength(2);
  });

  test('une source exclue ne laisse pas son titre dans le prompt, même au-delà de 80 caractères', async () => {
    const note = summary('long', { title: 'Rapport confidentiel sur la vanne du bassin principal et les réglages de la station aval' });
    mockState([note]);
    vi.spyOn(api, 'entry').mockResolvedValue(entry(note));
    const context = await loadAiContext({ projectId: 'p1', title: 'Vanne du bassin' });
    expect(context.sources?.map((source) => source.id)).toEqual(['long']);
    expect(buildSuggestPrompt('Vanne du bassin', selectedAiContext(context, ['long'])).user).not.toContain('Rapport confidentiel');
  });

  test('déduplique les copies exactes après les exclusions et conserve les provenances distinctes', () => {
    const source = { title: 'Pompe', kind: 'procedure' as const, text: 'Fermer la vanne puis contrôler 3 bar.' };
    const context = { sources: [
      { ...source, id: 'a' }, { ...source, id: 'b' },
      { ...source, id: 'other-title', title: 'Autre pompe' }, { ...source, id: 'note', kind: 'note' as const },
      { ...source, id: 'other-text', text: 'Fermer la vanne puis contrôler 4 bar.' },
    ] };
    expect(selectedAiContext(context, []).sources?.map((item) => item.id)).toEqual(['a', 'other-title', 'note', 'other-text']);
    expect(selectedAiContext(context, ['a']).sources?.map((item) => item.id)).toEqual(['b', 'other-title', 'note', 'other-text']);
    expect(context.sources).toHaveLength(5);
    expect(selectedAiContext(context, ['a', 'b']).sources?.map((item) => item.id)).toEqual(['other-title', 'note', 'other-text']);
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

describe('choix des sources du contexte IA', () => {
  test('liens, images, chemins, courriels et adresses IP ne sont pas des mots-clés, les autres nombres si', () => {
    expect([...contextWords('Serveur 192.168.1.10 https://wiki.exemple.fr/page')]).toEqual(['serveur']);
    expect([...contextWords('![capture](/api/files/abc.png)')]).toEqual(['capture']);
    expect([...contextWords('Erreur 404 sur HP 3015')]).toEqual(['erreur', '404', '3015']);
    expect([...contextWords('Serveur intranet.exemple.fr/wiki www.exemple.fr contact@exemple.fr /mnt/partage/archives fin')]).toEqual(['serveur', 'fin']);
  });

  test.each(['intranet.exemple.fr/stock', 'www.exemple.fr/stock', '/mnt/partage/stock', 'contact@exemple.fr'])('une adresse commune (%s) ne retient pas un document sans rapport', async (address) => {
    mockState([summary('other', { title: 'Inventaire', excerpt: `Voir ${address}` })]);
    const read = vi.spyOn(api, 'entry');
    await loadAiContext({ projectId: 'p1', title: 'Compte rendu', text: `Consulter ${address}` });
    expect(read).not.toHaveBeenCalled();
  });

  test('une année ne rapproche pas deux documents, un autre nombre si', async () => {
    const model = summary('model', { title: 'Cartouche HP 3015' });
    mockState([summary('budget', { title: 'Budget 2026' }), summary('stock', { title: 'Inventaire 2026' }), summary('badges', { title: 'Badges' }), model], [], { badges: 'La pointeuse est en panne.' });
    const read = vi.spyOn(api, 'entry').mockResolvedValue(entry(model));
    // L'année reste cherchée : seul, « point » ferait retenir la pointeuse.
    expect((await loadAiContext({ projectId: 'p1', title: 'Point du 12/03/2026' })).sources).toEqual([]);
    expect((await loadAiContext({ projectId: 'p1', title: 'Compte rendu', text: 'Commande prévue en 2026.' })).sources).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    await loadAiContext({ projectId: 'p1', title: 'Panne 3015' });
    expect(read.mock.calls).toEqual([['model']]);
  });

  test('des mots courants partagés ne font pas retenir un document sans rapport', async () => {
    const related = summary('joint', { title: 'Réception du joint' });
    mockState([
      summary('conges', { title: 'Congés d’été', excerpt: 'Il faut remplir le formulaire, on peut aussi écrire au service.' }),
      summary('repas', { title: 'Repas de fin d’année', excerpt: 'Besoin d’une réponse demain pour le traiteur.' }),
      summary('compta', { title: 'Compta', excerpt: 'Un très bon trimestre, la même marge.' }),
      related,
    ]);
    const read = vi.spyOn(api, 'entry').mockResolvedValue(entry(related));
    await loadAiContext({ projectId: 'p1', title: 'Joint V12', text: 'Il faut changer le joint, on peut le faire demain matin : besoin d’une cale très fine, la même que l’an dernier.' });
    expect(read.mock.calls).toEqual([['joint']]);
  });

  test('les mots vides sont écartés au singulier comme au pluriel', () => {
    expect([...contextWords('Mises à jours de mon serveur')]).toEqual(['serveur']);
    expect([...contextWords('Voir ici : ils ont une réunion')]).toEqual([]);
  });

  test('un sigle de trois lettres garde son s, un pluriel plus long le perd', async () => {
    expect([...contextWords('Panne NAS et certificats DNS')]).toEqual(['panne', 'nas', 'certificat', 'dns']);
    const state = mockState([]);
    await loadAiContext({ projectId: 'p1', title: 'NAS' });
    expect(state.mock.calls).toEqual([['', 'p1'], ['nas', 'p1']]);
  });

  test('une adresse et un lien communs ne font pas passer une note hors sujet devant le sujet', async () => {
    const noise = summary('nas', { title: 'Panne NAS', excerpt: 'Le NAS 192.168.1.20 ne répond plus, voir https://wiki.exemple.fr/nas' });
    const toner = summary('toner', { title: 'Toner de l’atelier' });
    mockState([noise, toner]);
    const read = vi.spyOn(api, 'entry').mockResolvedValue(entry(toner));
    await loadAiContext({ projectId: 'p1', title: 'Imprimante HP atelier', text: 'Adresse 192.168.1.50, voir https://wiki.exemple.fr/imprimantes' });
    expect(read.mock.calls).toEqual([['toner']]);
  });

  test('« Mise à jour » ne rapproche rien, le mot du sujet dans un extrait suffit', async () => {
    const service = summary('service', { title: 'Mise en service de la pompe' });
    const rules = summary('rules', { title: 'Règles pare-feu du site', excerpt: 'Le firewall filtre le site.' });
    mockState([service, rules]);
    const read = vi.spyOn(api, 'entry').mockResolvedValue(entry(rules));
    await loadAiContext({ projectId: 'p1', title: 'Mise à jour du firewall' });
    expect(read.mock.calls).toEqual([['rules']]);
  });

  test('un seul mot du brouillon dans un extrait ne suffit pas, deux mots ou un titre oui', async () => {
    mockState([
      summary('weak', { title: 'Inventaire', excerpt: 'La vanne du local.' }),
      summary('excerpt', { title: 'Relevé', excerpt: 'La vanne fuit encore.' }),
      summary('title', { title: 'Vanne de purge' }),
    ]);
    const read = vi.spyOn(api, 'entry').mockImplementation(async (id) => entry(summary(id)));
    await loadAiContext({ projectId: 'p1', title: 'Compte rendu', text: 'La vanne fuit.' });
    expect(read.mock.calls.flat().sort()).toEqual(['excerpt', 'title']);
  });

  test('une section au-delà de l’extrait est trouvée quand deux mots du titre y figurent', async () => {
    const item = summary('poste', { title: 'Préparation d’un poste', kind: 'procedure', excerpt: 'Installer le système.' });
    const content = 'Installer le système. '.repeat(40) + '\n\n## Certificat VPN\n\nImporter le fichier dans le profil.';
    mockState([item], [], { poste: content });
    vi.spyOn(api, 'entry').mockResolvedValue(entry(item, { content_md: content }));
    const context = await loadAiContext({ projectId: 'p1', title: 'Renouveler le certificat VPN' });
    expect(context.sources?.map((source) => source.id)).toEqual(['poste']);
    expect(context.sources?.[0].text).toContain('Importer le fichier dans le profil.');
  });

  test('un seul mot courant du titre dans un texte ne suffit pas', async () => {
    const item = summary('stock', { title: 'Inventaire' });
    mockState([item], [], { stock: 'Le serveur est rangé en baie 3.' });
    const read = vi.spyOn(api, 'entry');
    expect((await loadAiContext({ projectId: 'p1', title: 'Redémarrer le serveur de sauvegarde' })).sources).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  test('un titre d’un seul mot s’appuie sur le texte, sauf si ce mot est un simple nombre', async () => {
    const item = summary('rules', { title: 'Règles du site' });
    mockState([item], [], { rules: 'Le firewall date de 2026.' });
    const read = vi.spyOn(api, 'entry').mockResolvedValue(entry(item));
    await loadAiContext({ projectId: 'p1', title: 'Mise à jour du firewall' });
    expect(read.mock.calls).toEqual([['rules']]);
    read.mockClear();
    expect((await loadAiContext({ projectId: 'p1', title: 'Compte rendu 2026-11-05' })).sources).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  test('cherche dans les textes les quatre mots les plus longs du titre, dans le projet', async () => {
    const state = mockState([]);
    await loadAiContext({ projectId: 'p1', title: 'Renouveler certificat sauvegarde principal serveur VPN' });
    expect(state.mock.calls).toEqual([['', 'p1'], ['renouveler', 'p1'], ['certificat', 'p1'], ['sauvegarde', 'p1'], ['principal', 'p1']]);
  });

  test('un titre sans mot utilisable ne lance aucune recherche ni ne retient de document', async () => {
    const state = mockState([summary('any', { title: 'Inventaire' })]);
    const read = vi.spyOn(api, 'entry');
    expect((await loadAiContext({ projectId: 'p1', title: 'Compte rendu' })).sources).toEqual([]);
    expect(state.mock.calls).toEqual([['', 'p1']]);
    expect(read).not.toHaveBeenCalled();
  });

  test('un document trouvé dans son texte reste soumis aux exclusions de projet, Google et archive', async () => {
    const good = summary('good', { title: 'Inventaire' });
    const forbidden = [summary('other', { project_id: 'p2' }), summary('google', { google_document_id: 'g' }), summary('tab', { google_tab_id: 't' }), summary('archive', { archived: 1 })];
    mockState([good, ...forbidden], [], Object.fromEntries([good, ...forbidden].map((item) => [item.id, 'Imprimante du réseau'])));
    const read = vi.spyOn(api, 'entry').mockResolvedValue(entry(good));
    await loadAiContext({ projectId: 'p1', title: 'Imprimante réseau' });
    expect(read.mock.calls).toEqual([['good']]);
  });

  test('un document absent de la lecture générale reste trouvable par son texte', async () => {
    const old = summary('old', { title: 'Archive atelier' });
    const state = mockState([old], [], { old: 'Certificat VPN du site.' });
    // Au-delà de 500 entrées, la lecture générale ne rend que les plus récentes.
    state.mockResolvedValueOnce({ ...await api.state(), entries: [] });
    const read = vi.spyOn(api, 'entry').mockResolvedValue(entry(old));
    await loadAiContext({ projectId: 'p1', title: 'Certificat VPN' });
    expect(read.mock.calls).toEqual([['old']]);
  });

  test.each([
    ['une recherche de mot', (q: string) => q !== ''],
    ['la lecture générale', (q: string) => q === ''],
  ])('%s impossible interrompt la demande', async (_, fails) => {
    const state = mockState([]);
    const implementation = state.getMockImplementation()!;
    state.mockImplementation(async (q = '', project) => {
      if (fails(q)) throw new Error('réseau indisponible');
      return implementation(q, project);
    });
    await expect(loadAiContext({ projectId: 'p1', title: 'Imprimante' })).rejects.toThrow('Impossible de charger le contexte IA du projet.');
  });

  test('les autres documents de la tâche liée à la note sont retenus, sans lier d’autres tâches', async () => {
    const active = summary('active', { title: 'CR intervention' });
    const sibling = summary('sibling', { title: 'Démontage P4', kind: 'procedure' });
    mockState([active, sibling, summary('other', { title: 'Comptabilité' })], [
      task('shared', { title: 'Remplacer la pompe', documents: [active, sibling] }),
      task('indirect', { title: 'Commander le joint', documents: [sibling] }),
    ]);
    const read = vi.spyOn(api, 'entry').mockResolvedValue(entry(sibling));
    const context = await loadAiContext({ projectId: 'p1', title: 'CR intervention', entryId: active.id });
    expect(read.mock.calls).toEqual([['sibling']]);
    expect(context.relatedTasks).toEqual(['Remplacer la pompe']);
  });

  test('un document voisin par sa tâche reste derrière les titres correspondants', async () => {
    const active = summary('active');
    const sibling = summary('sibling', { title: 'Démontage P4' });
    mockState([sibling, active, summary('a'), summary('b'), summary('c')], [task('shared', { documents: [active, sibling] })]);
    const read = vi.spyOn(api, 'entry').mockImplementation(async (id) => entry(summary(id)));
    await loadAiContext({ projectId: 'p1', title: 'Imprimante', entryId: active.id });
    expect(read.mock.calls.flat().sort()).toEqual(['a', 'b', 'c']);
  });

  test('date les notes, jamais les procédures dont la date reste celle de leur création', async () => {
    const note = summary('note', { title: 'Imprimante panne', entry_date: '2026-03-04' });
    const procedure = summary('procedure', { title: 'Imprimante réglage', kind: 'procedure', entry_date: '2024-01-01' });
    mockState([note, procedure]);
    vi.spyOn(api, 'entry').mockImplementation(async (id) => entry(id === 'note' ? note : procedure));
    const context = await loadAiContext({ projectId: 'p1', title: 'Imprimante' });
    expect(context.sources?.find((source) => source.id === 'note')?.date).toBe('2026-03-04');
    expect(context.sources?.find((source) => source.id === 'procedure')?.date).toBeUndefined();
  });
});

describe('contexte IA sur la vraie recherche', () => {
  test('retrouve une section au-delà de l’extrait, sans casse ni accent, et jamais hors du projet', async () => {
    const server = await useRealApi();
    try {
      const filler = 'Installer le système. '.repeat(40);
      seedData(server.db, {
        projects: [{ id: 'p_parc', name: 'Parc' }, { id: 'p_autre', name: 'Autre' }],
        entries: [
          { id: 'en_far', title: 'Préparation d’un poste', kind: 'procedure', project_id: 'p_parc', content_md: `${filler}\n\n## Certificat VPN\n\nImporter le fichier dans le profil.` },
          { id: 'en_lone', title: 'Inventaire', project_id: 'p_parc', content_md: `${filler}\n\nLe certificat papier est rangé.` },
          { id: 'en_other', title: 'Confidentiel', kind: 'procedure', project_id: 'p_autre', content_md: `${filler}\n\nCertificat VPN privé.` },
        ],
      });
      const context = await loadAiContext({ projectId: 'p_parc', title: 'Renouveler le CERTIFICAT VPN' });
      expect(context.sources?.map((source) => source.id)).toEqual(['en_far']);
      expect(context.sources?.[0].text).toContain('Importer le fichier dans le profil.');
    } finally {
      await server.close();
    }
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
