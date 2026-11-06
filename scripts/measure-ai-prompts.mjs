#!/usr/bin/env node
// Mesure reproductible des entrées IA sur un corpus synthétique, sans appel fournisseur.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error(`Valeur requise pour ${name}`);
  return process.argv[index + 1];
}
const root = path.resolve(option('--root') ?? fileURLToPath(new URL('../', import.meta.url)));
const output = option('--output');
const compare = option('--compare');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
function validateBaseline(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Rapport de référence invalide.');
  assert.equal(value.schema_version, 1, 'Version du rapport de référence inconnue.');
  assert.match(value.fixture_sha256 ?? '', /^[a-f0-9]{64}$/, 'Empreinte du corpus invalide.');
  assert(Array.isArray(value.cases) && value.cases.length > 0, 'Cas de référence absents.');
  for (const item of value.cases) {
    assert(item && typeof item.name === 'string' && item.name, 'Nom du cas de référence invalide.');
    for (const key of ['system_chars', 'user_chars', 'input_chars', 'input_utf8_bytes']) assert(Number.isSafeInteger(item[key]) && item[key] >= 0, `${item.name} : mesure ${key} invalide.`);
    assert(item.input_chars > 0 && item.input_utf8_bytes > 0, `${item.name} : mesure vide.`);
    assert.equal(item.input_chars, item.system_chars + item.user_chars, `${item.name} : total incohérent.`);
    assert(Array.isArray(item.retained_evidence) && item.retained_evidence.every((fact) => typeof fact === 'string' && fact), `${item.name} : indices de fidélité invalides.`);
  }
  assert.equal(value.totals?.input_chars, value.cases.reduce((n, item) => n + item.input_chars, 0), 'Total des caractères incohérent.');
  assert.equal(value.totals?.input_utf8_bytes, value.cases.reduce((n, item) => n + item.input_utf8_bytes, 0), 'Total des octets incohérent.');
}
const today = '2026-11-06';
const profile = 'Technicien de maintenance en pisciculture : réseaux hydrauliques et équipements.';
const primary = 'Constat : la vanne V12 fuit au raccord.\n- [x] Mesurer la pression : 2,5 bars.\n- [ ] Contrôler le joint le 2026-11-09.\nCommande à conserver : `systemctl status pompe`.\n';
const middle = '2026-11-04 — ALERTE : la fuite persiste en aval de V12 ; ne pas remettre la pompe en service.';
const ending = '2026-11-06 — Joint reçu ; remplacement prévu le 2026-11-09, action non réalisée.';
const journal = [primary, ...Array.from({ length: 36 }, (_, i) => [
  `Contrôle ${i + 1} : relever la pression et vérifier le raccord V12 avant intervention. La pompe P4 reste arrêtée.`,
  i === 18 ? middle : `Observation ${i + 1} : la mesure est conservée dans le relevé du circuit hydraulique.`,
].join('\n')), ending].join('\n\n');
assert(journal.length < 12_000);
const titles = ['Commander le joint V12', 'Contrôler le débit P4', 'Réparer le clapet', 'Nettoyer le tamis', 'Relever les pressions'];
const references = Array.from({ length: 3 }, (_, i) => ({
  id: `ref-${i}`, title: `Procédure du circuit ${i + 1}`, kind: 'procedure',
  text: `Circuit ${i + 1} : fermer la vanne V12 avant démontage.\n` +
    'Vérifier le joint et relever la pression après remontage.\n'.repeat(24),
}));
const context = {
  project: 'Atelier hydraulique',
  projectBrief: 'Privilégier la continuité de circulation. Utiliser les repères V12 et P4. '.repeat(16),
  sources: references,
  relatedTasks: titles,
  relatedTaskPlanning: titles.map((title) => ({ title, priority: 'normal', due_date: '2026-11-09' })),
  recentNotes: ['Relevé de pression V12', 'Contrôle P4', 'Réception du joint', 'Mesures de débit', 'Intervention circuit'],
  vocabulary: ['pression', 'joint', 'circuit', 'vanne', 'débit', 'pompe'],
  linkedTasks: ['Remettre la circulation en service'],
};
const report = {
  status: 'blocked', summary: 'Diagnostic effectué ; la pièce manque pour remplacer la vanne.',
  completed: ['Mesurer la pression : 2,5 bars.'], next_steps: ['Réceptionner le joint puis remplacer la vanne.'],
  blockers: ['Joint non reçu.'], warnings: ['Les pièces jointes et les fichiers du dossier partagé ne sont pas lus.'],
  generated_at: `${today}T09:00:00Z`, source_key: 'v1',
};
const tasks = Array.from({ length: 60 }, (_, i) => ({
  id: `tk_${i}`, title: `Contrôler le circuit hydraulique ${i + 1}`, status: i % 3 ? 'todo' : 'doing',
  priority: i % 4 ? 'normal' : 'high', due_date: i % 2 ? '2026-11-09' : null, pinned: i % 9 === 0 ? 1 : 0,
  created_at: '2026-10-02T08:00:00Z', project: `Atelier ${i % 6}`, projectId: `pr_${i % 6}`,
  projectBrief: `Assurer la continuité du circuit ${i % 6}, contrôler pression et débit.`, documents: 2,
  follow_up: { enabled: true, enabled_at: '2026-11-01T09:00:00Z', report }, follow_up_key: 'v1',
}));
const document = (id, text) => ({ id, kind: 'note', title: `Note ${id}`, entry_date: today, content_md: text, content_json: null, google: false });
const followedItems = tasks.map((task) => ({ id: task.id, kind: 'task', title: task.title, status: task.status, follow_up: task.follow_up, follow_up_key: task.follow_up_key }));
const settings = { endpoint: 'https://benchmark.invalid/v1', model: 'benchmark', key: 'cle-fictive-sans-reseau', profile };
const retrievalAlert = '⚠ Consigner le circuit avant toute commande ; la fuite en aval reste à vérifier.';
const retrievalText = [
  '# Réseau hydraulique',
  '## Administration', 'Ranger les cartons et classer les formulaires du bureau avant la clôture annuelle. '.repeat(32),
  '## V12', `${retrievalAlert}\nCommande : \`systemctl status pompe\`.\nContrôler le joint V12 le 2026-11-09.`,
  '## Comptabilité', 'Classer les factures par fournisseur et préparer les classeurs pour le trimestre. '.repeat(32),
].join('\n\n');
const retrievalEntries = [
  { id: 'v12-a', title: 'V12 — Remise en service', kind: 'procedure', text: retrievalText },
  { id: 'v12-b', title: 'V12 — Remise en service', kind: 'procedure', text: retrievalText },
  { id: 'v12-fallback', title: 'V12 — Inventaire', kind: 'note', text: 'Inventaire : deux adaptateurs conservés dans la caisse rouge, aucune opération indiquée.' },
  { id: 'foreign', title: 'V12 — Autre projet', kind: 'note', text: 'DONNÉE_AUTRE_PROJET', project_id: 'foreign' },
  { id: 'google', title: 'V12 — Google', kind: 'note', text: 'DONNÉE_GOOGLE', google_document_id: 'doc-google' },
];
const evidence = ['2,5 bars', '2026-11-09', '`systemctl status pompe`', middle, ending, retrievalAlert, 'Organiser l’intervention prévue'];
const fixtureDataHash = sha256(JSON.stringify({ today, profile, primary, journal, context, tasks, retrievalEntries, evidence }));
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-ai-benchmark-'));
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Le benchmark interdit tout accès réseau.'); };
let server;
try {
  const { createServer } = await import(pathToFileURL(path.join(root, 'web/node_modules/vite/dist/node/index.js')).href);
  server = await createServer({
    configFile: false, root: path.join(root, 'web'), mode: 'test', cacheDir: cache,
    server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom',
    optimizeDeps: { noDiscovery: true }, define: { __WORKLOGS_VERSION__: JSON.stringify('benchmark') },
  });
  const ai = await server.ssrLoadModule('/src/ai-suggest.ts');
  const { api } = await server.ssrLoadModule('/src/lib.ts');
  const contexts = await server.ssrLoadModule('/src/ai-context.ts');
  async function retrieve(excluded = []) {
    const originalState = api.state;
    const originalEntry = api.entry;
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const storage = new Map();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key), clear: () => storage.clear(),
    } });
    const entries = retrievalEntries.map((item) => ({
      id: item.id, title: item.title, kind: item.kind, project_id: item.project_id ?? 'atelier',
      entry_date: today, updated_at: `${today}T09:00:00Z`, archived: 0, excerpt: 'V12 fuite joint',
      attachments: 0, google_document_id: item.google_document_id,
    }));
    api.state = async () => ({
      projects: [{ id: 'atelier', name: 'Atelier hydraulique', color: '#123456', created_at: today, entries: entries.length, open_tasks: 8 }],
      entries, tasks: [
        { id: 'pertinente', title: 'Remplacer le joint V12', project_id: 'atelier', status: 'todo', priority: 'high', due_date: '2026-11-09', documents: [] },
        ...Array.from({ length: 6 }, (_, i) => ({ id: `sans-lien-${i}`, title: i % 2 ? 'Appeler Gabin' : 'Gabin : congés annuels', project_id: 'atelier', status: 'todo', priority: 'normal', due_date: null, documents: [] })),
        { id: 'liee', title: 'Organiser l’intervention prévue', project_id: 'atelier', status: 'doing', priority: 'normal', due_date: null, documents: [{ id: 'active' }] },
      ],
      procedure_attachments: [], stats: { entries: entries.length, entriesThisWeek: 0, overdue: 0, tasks: { todo: 7, doing: 1, done: 0 } },
    });
    api.entry = async (id) => {
      assert(!['foreign', 'google'].includes(id), 'Le contexte ne doit lire ni autre projet ni Google.');
      const index = entries.findIndex((item) => item.id === id);
      assert(index >= 0);
      return { ...entries[index], created_at: today, content_md: retrievalEntries[index].text, content_json: null, attachments: [] };
    };
    try {
      contexts.saveProjectAiBrief('atelier', 'Conserver les consignes de consignation et les références du matériel.');
      const loaded = await contexts.loadAiContext({ projectId: 'atelier', entryId: 'active', title: 'Compte rendu', text: 'La vanne V12 présente une fuite ; contrôler son joint.' });
      const selected = contexts.selectedAiContext(loaded, excluded);
      assert(!selected.sources.some((item) => excluded.includes(item.id)), 'La source exclue doit disparaître.');
      const prompt = ai.buildSuggestPrompt('Contrôler la vanne V12', { ...selected, profile, entryText: primary });
      assert(prompt.user.includes(retrievalAlert), 'Le passage pertinent et son avertissement doivent rester présents.');
      assert(prompt.user.includes(retrievalEntries[2].text), 'La source pertinente par son titre doit garder son texte quand le vocabulaire ne correspond pas.');
      assert(!prompt.user.includes('DONNÉE_AUTRE_PROJET') && !prompt.user.includes('DONNÉE_GOOGLE'));
      return prompt;
    } finally {
      api.state = originalState;
      api.entry = originalEntry;
      if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
      else delete globalThis.localStorage;
    }
  }
  async function capture(invoke, reply = '[]') {
    let request;
    globalThis.fetch = async (_url, init) => {
      assert(!request, 'Un seul appel IA est attendu pour chaque cas.');
      request = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    try { await invoke(); } finally { globalThis.fetch = async () => { throw new Error('Le benchmark interdit tout accès réseau.'); }; }
    assert(request, 'La requête IA doit être préparée.');
    return { system: request.messages[0].content, user: request.messages[1].content, maxTokens: request.max_tokens };
  }
  const followSource = (documents) => ({ kind: 'task', id: 'task', title: 'Réparer le circuit', project: 'Atelier', status: 'doing', due_date: null, documents });
  const cases = [
    ['connexion', () => capture(() => ai.testAiConnection(settings), 'OK')],
    ['contexte/selection', () => retrieve()],
    ['contexte/exclusion-doublon', () => retrieve(['v12-a'])],
    ['sous-taches/court', () => ai.buildSuggestPrompt('Contrôler la vanne V12')],
    ['sous-taches/contexte', () => ai.buildSuggestPrompt('Contrôler la vanne V12', { ...context, profile, entryText: primary })],
    ['relecture/court', () => ai.buildProofreadPrompt('Vanne V12', primary, profile), primary],
    ['relecture/contexte', () => ai.buildProofreadPrompt('Vanne V12', primary, profile, false, 'markdown', context), primary],
    ['relecture/long', () => ai.buildProofreadPrompt('Vanne V12', journal, profile, false, 'markdown', context), journal],
    ['completer/court', () => ai.buildCompleteNotePrompt('Vanne V12', { ...context, text: primary }, profile), primary],
    ['completer/long', () => ai.buildCompleteNotePrompt('Vanne V12', { ...context, text: journal }, profile), journal],
    ['procedure/existante', () => ai.buildProcedurePrompt('Contrôler la vanne', { ...context, text: primary }, profile), primary],
    ['procedure/tache-doublons', () => ai.buildDraftProcedurePrompt({ ...context, origin: 'task', title: 'Réparer le circuit', documents: references.map((ref) => ({ ...ref, date: today })) }, profile)],
    ['extraire/court', () => capture(() => ai.extractEntryActions(settings, 'Vanne V12', primary, { context })), primary],
    ['suggerer-taches/contexte', () => capture(() => ai.suggestEntryTasks(settings, 'Vanne V12', primary, { context, today, entryDate: today })), primary],
    ['affiner/texte-identique', () => capture(() => ai.completeNote(settings, 'Vanne V12', { context: { ...context, text: journal }, refinement: { previous: journal, instruction: 'Plus court, garde les valeurs et commandes.' } }), journal), journal],
    ['rechercher-document/contexte', () => ai.buildSearchTermsPrompt({ title: 'Contrôler la vanne V12', status: 'doing' }, { ...context, profile, linkedDocuments: references.map((ref) => ref.title) })],
    ['prioriser/60', () => ai.buildPrioritizePrompt(tasks, { profile, today })],
    ['conseiller/60-references-partagees', () => ai.buildTaskAdvicePrompt(tasks.map((task) => ({ ...task, sources: references })), { profile, today })],
    ['suivi/long-et-courts', () => ai.buildFollowUpPrompt(followSource([document('long', journal), ...Array.from({ length: 7 }, (_, i) => document(`court-${i}`, primary))]), profile)],
    ['suivi/documents-identiques', () => ai.buildFollowUpPrompt(followSource(Array.from({ length: 8 }, (_, i) => document(`copie-${i}`, journal.slice(0, 1900)))), profile)],
    ['bilan/60', () => ai.buildDailyReviewPrompt(followedItems, { profile, today })],
    ['replanifier/60', () => ai.buildReplanPrompt(tasks, { profile, today })],
  ];
  const fixtureHash = sha256(JSON.stringify({ fixtureDataHash, cases: cases.map(([name, build, wholeSource]) => [name, build.toString(), wholeSource ?? null]) }));
  const measured = [];
  for (const [name, build, wholeSource] of cases) {
    const prompt = await build();
    assert.equal(typeof prompt.system, 'string');
    assert.equal(typeof prompt.user, 'string');
    if (wholeSource) assert(prompt.user.includes(wholeSource.trim()), `${name} : le texte primaire doit rester intégral et à l’identique.`);
    if (name === 'procedure/tache-doublons') {
      for (const reference of references) assert(prompt.user.includes(reference.text.trim()), `${name} : chaque document primaire doit rester intégral.`);
    }
    const identities = ['prioriser/60', 'conseiller/60-references-partagees', 'bilan/60', 'replanifier/60'].includes(name)
      ? tasks.map((task) => task.title)
      : name === 'suivi/long-et-courts' ? ['Note long', ...Array.from({ length: 7 }, (_, i) => `Note court-${i}`)]
        : name === 'suivi/documents-identiques' ? Array.from({ length: 8 }, (_, i) => `Note copie-${i}`) : [];
    for (const title of identities) assert(prompt.user.includes(title), `${name} : un élément sélectionné manque : ${title}`);
    measured.push({
      name, system_chars: prompt.system.length, user_chars: prompt.user.length,
      input_chars: prompt.system.length + prompt.user.length,
      input_utf8_bytes: Buffer.byteLength(prompt.system + prompt.user, 'utf8'),
      retained_evidence: evidence.filter((fact) => prompt.user.includes(fact)),
      selected_items_represented: identities.length,
      local_identifiers_present: tasks.some((task) => prompt.user.includes(`"${task.id}"`) || prompt.user.includes(`"${task.projectId}"`)),
      ...(name.startsWith('contexte/') ? { unrelated_context_terms: ['Gabin', 'congés annuels'].filter((term) => prompt.user.toLowerCase().includes(term.toLowerCase())) } : {}),
      ...(prompt.maxTokens ? { output_token_ceiling: prompt.maxTokens } : {}),
    });
  }
  const results = {
    schema_version: 1, fixture_sha256: fixtureHash,
    measures: 'Longueur des contenus system+user en unités UTF-16 et octets UTF-8 ; ni tokens facturés ni qualité de réponse du modèle.',
    source_sha256: Object.fromEntries(['ai-suggest.ts', 'ai-context.ts'].map((file) => [file, sha256(fs.readFileSync(path.join(root, 'web/src', file)))])),
    cases: measured,
    totals: { input_chars: measured.reduce((n, value) => n + value.input_chars, 0), input_utf8_bytes: measured.reduce((n, value) => n + value.input_utf8_bytes, 0) },
  };
  if (compare) {
    const baseline = JSON.parse(fs.readFileSync(compare, 'utf8'));
    validateBaseline(baseline);
    assert.equal(baseline.schema_version, results.schema_version, 'Versions du rapport différentes.');
    assert.equal(baseline.fixture_sha256, fixtureHash, 'Corpus différents : comparaison refusée.');
    const previous = new Map(baseline.cases.map((value) => [value.name, value]));
    assert.equal(previous.size, measured.length, 'Le nombre de cas doit rester identique.');
    for (const value of measured) {
      const before = previous.get(value.name);
      assert(before, `Cas de référence manquant : ${value.name}`);
      for (const fact of before.retained_evidence) assert(value.retained_evidence.includes(fact), `${value.name} : fait auparavant présent désormais absent : ${fact}`);
      value.before_input_chars = before.input_chars;
      value.input_chars_change_pct = Number(((value.input_chars / before.input_chars - 1) * 100).toFixed(1));
    }
    results.totals.before_input_chars = baseline.totals.input_chars;
    results.totals.input_chars_change_pct = Number(((results.totals.input_chars / baseline.totals.input_chars - 1) * 100).toFixed(1));
  }
  if (output) fs.writeFileSync(output, JSON.stringify(results, null, 2) + '\n');
  console.log(results.measures);
  console.log('Corpus synthétique, pondération égale ; aucune mesure des habitudes réelles d’utilisation.');
  console.table(measured.map((value) => ({ cas: value.name, caracteres: value.input_chars, octets: value.input_utf8_bytes, indices_conserves: value.retained_evidence.length, elements: value.selected_items_represented, ...(compare ? { variation_pct: value.input_chars_change_pct } : {}) })));
  console.log(JSON.stringify(results.totals));
} finally {
  globalThis.fetch = realFetch;
  await server?.close();
  fs.rmSync(cache, { recursive: true, force: true });
}
