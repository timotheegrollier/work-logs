import { describe, expect, test, vi, afterEach } from 'vitest';
import {
  AiError,
  AI_MODELS,
  buildProcedurePrompt,
  buildProofreadPrompt,
  buildSuggestPrompt,
  cleanProofreadMarkdown,
  cleanSuggestionLines,
  MAX_PROOFREAD_CHARS,
  parseChecklist,
  proofreadEntry,
  readAiSettings,
  recurringVocabulary,
  saveAiSettings,
  suggestProcedure,
  suggestSubtasks,
  taskSuggestContext,
  testAiConnection,
  truncate,
  DEFAULT_AI_ENDPOINT,
  DEFAULT_AI_MODEL,
  FALLBACK_AI_MODEL,
} from './ai-suggest';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

function aiResponse(content: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => ({ choices: [{ message: { content } }] }) } as Response;
}

const settings = { endpoint: 'https://ia.example/v1', model: 'flash', key: 'cle-test', profile: '' };

describe('consigne et nettoyage', () => {
  test('la consigne reprend le titre et exige des lignes courtes en français', () => {
    const prompt = buildSuggestPrompt('  Préparer le dossier  ');
    expect(prompt.user).toBe('Tâche : Préparer le dossier');
    expect(prompt.system).toMatch(/français/);
    expect(prompt.system).toMatch(/une par ligne/);
  });

  test('le prompt connaît l’app et le travail en cours, sans doublons ni pavés', () => {
    const prompt = buildSuggestPrompt('Préparer le dossier', {
      project: 'Chantier',
      relatedTasks: ['Relire le devis', 'relire le devis', 'Appeler le client', 'x'.repeat(100)],
      recentNotes: ['Compte rendu', ''],
    });
    expect(prompt.system).toMatch(/WorkLogs/);
    expect(prompt.system).toMatch(/doublon/);
    expect(prompt.user).toContain('Projet : Chantier');
    expect(prompt.user).toContain('- Relire le devis\n- Appeler le client');
    expect(prompt.user).not.toContain('relire le devis\n- relire');
    expect(prompt.user).toContain('x'.repeat(79) + '…');
    expect(prompt.user).toContain('Notes récentes du projet :\n- Compte rendu');
  });

  test('sans contexte, le prompt reste le titre seul', () => {
    expect(buildSuggestPrompt('Tâche').user).toBe('Tâche : Tâche');
  });

  test('profil et vocabulaire précèdent la tâche', () => {
    const prompt = buildSuggestPrompt('Dossier', {
      profile: 'Dev solo en pisciculture',
      vocabulary: ['bassin', 'filtration'],
    });
    expect(prompt.user).toBe('Profil : Dev solo en pisciculture\nTâche : Dossier\nVocabulaire du métier : bassin, filtration');
    expect(prompt.system).toMatch(/profil/);
  });

  test('puces, numéros et cases sont retirés, vide ignoré, plafond à huit', () => {
    const raw = '- Relire\n2. Payer\n- [x] Signer\n\n\n• Ranger';
    expect(cleanSuggestionLines(raw)).toBe('Relire\nPayer\nSigner\nRanger');
    const many = Array.from({ length: 12 }, (_, i) => `Tâche ${i + 1}`).join('\n');
    expect(cleanSuggestionLines(many).split('\n')).toHaveLength(8);
  });

  test('sans ligne utile, rien à insérer', () => {
    expect(cleanSuggestionLines('  \n- \n')).toBe('');
  });
});

describe('contexte de travail', () => {
  const projects = [{ id: 'pr_a', name: 'Chantier' }];
  const tasks = [
    { id: 'tk_mine', title: 'Dossier', project_id: 'pr_a', status: 'todo' as const },
    { id: 'tk_voisine', title: 'Devis', project_id: 'pr_a', status: 'doing' as const },
    { id: 'tk_finie', title: 'Payé', project_id: 'pr_a', status: 'done' as const },
    { id: 'tk_ailleurs', title: 'Autre projet', project_id: 'pr_b', status: 'todo' as const },
  ];
  const entries = [
    { title: 'Compte rendu', project_id: 'pr_a' },
    { title: 'Note libre', project_id: null },
  ];

  test('projet, voisines en cours et notes du projet — sans elle-même ni finies', () => {
    expect(taskSuggestContext(tasks[0], tasks, entries, projects)).toEqual({
      project: 'Chantier',
      relatedTasks: ['Devis'],
      recentNotes: ['Compte rendu'],
      vocabulary: expect.arrayContaining(['compte', 'devis', 'dossier']),
    });
  });

  test('sans projet connu, pas de nom mais les sans-projet restent voisins', () => {
    const orphans = [
      { id: 'tk_1', title: 'Libre', project_id: null, status: 'todo' as const },
      { id: 'tk_2', title: 'Aussi libre', project_id: null, status: 'todo' as const },
    ];
    expect(taskSuggestContext(orphans[0], orphans, [], [])).toEqual({
      project: undefined,
      relatedTasks: ['Aussi libre'],
      recentNotes: [],
      vocabulary: ['libre'],
    });
  });
});

describe('contexte de l’entrée', () => {
  test('les cases existantes sont lues avec leur statut', () => {
    expect(parseChecklist('Texte\n- [ ] Relire\n- [x] Payer\n- Simple puce\n')).toEqual([
      { text: 'Relire', done: false },
      { text: 'Payer', done: true },
    ]);
  });

  test('le prompt reprend texte, cases, pièces jointes et liens', () => {
    const prompt = buildSuggestPrompt('Dossier', {
      entryText: 'Compte rendu de visite.   Avec espaces.',
      existingSubtasks: [{ text: 'Relire', done: false }, { text: 'Payer', done: true }],
      attachments: ['devis.pdf', 'photo.jpg'],
      linkedTasks: ['Appeler le client'],
      linkedDocuments: ['Note de visite'],
    });
    expect(prompt.user).toContain("Contenu actuel de l'entrée (extrait) :\nCompte rendu de visite. Avec espaces.");
    expect(prompt.user).toContain('Sous-tâches déjà présentes (ne les repropose jamais) :\n- [ ] Relire\n- [x] Payer');
    expect(prompt.user).toContain('Pièces jointes : devis.pdf, photo.jpg');
    expect(prompt.user).toContain('Tâches déjà liées : Appeler le client');
    expect(prompt.user).toContain('Documents déjà liés : Note de visite');
    expect(prompt.system).toMatch(/déjà présente/);
  });

  test('texte plafonné et sections vides omises', () => {
    expect(truncate('a'.repeat(2000))).toHaveLength(1500);
    expect(truncate('a'.repeat(2000))).toMatch(/…$/);
    expect(truncate('  court  ')).toBe('court');
    const prompt = buildSuggestPrompt('Dossier', { existingSubtasks: [], attachments: [] });
    expect(prompt.user).toBe('Tâche : Dossier');
  });
});

describe('vocabulaire auto-appris', () => {
  test('fréquence puis alpha, mots vides et courts écartés', () => {
    expect(recurringVocabulary(['Bassin filtration', 'Filtration eau', 'le devis', 'Bassin'])).toEqual([
      'bassin',
      'filtration',
      'devis',
      'eau',
    ]);
  });

  test('plafond à huit et vide ignoré', () => {
    const mots = ['bassin', 'filtration', 'devis', 'alevin', 'pompe', 'oxygene', 'nourrir', 'releve', 'facture', 'client', 'livrer', 'controle'];
    expect(recurringVocabulary([...mots, ...mots, 'a', 'le', ''])).toHaveLength(8);
    expect(recurringVocabulary(['le', 'la', 'et', 'ab'])).toEqual([]);
  });
});

describe('réglages', () => {
  test('défauts Gemini gratuits, clé vide sans collage', () => {
    expect(readAiSettings()).toEqual({ endpoint: DEFAULT_AI_ENDPOINT, model: DEFAULT_AI_MODEL, key: '', profile: '' });
  });

  test('le modèle par défaut figure dans les options du select', () => {
    expect(AI_MODELS.map((option) => option.id)).toContain(DEFAULT_AI_MODEL);
    expect(new Set(AI_MODELS.map((option) => option.id)).size).toBe(AI_MODELS.length);
  });

  test('les valeurs collées en Paramètres sont relues et rognées', () => {
    saveAiSettings({ endpoint: 'https://autre/v1/ ', model: '  perso ', key: ' k ', profile: ' solo ' });
    expect(readAiSettings()).toEqual({ endpoint: 'https://autre/v1/', model: 'perso', key: 'k', profile: 'solo' });
  });
});

describe('appel', () => {
  test('un clic envoie le titre seul en Bearer et nettoie la réponse', async () => {
    const fetch = vi.fn(async () => aiResponse('Relire\n1. Payer\n'));
    vi.stubGlobal('fetch', fetch);
    const result = await suggestSubtasks(settings, 'Préparer le dossier', { timeoutMs: 5000 });
    expect(result).toBe('Relire\nPayer');
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ia.example/v1/chat/completions');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer cle-test' });
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('flash');
    expect(body.messages[1]).toMatchObject({ role: 'user', content: 'Tâche : Préparer le dossier' });
  });

  test('le contexte du projet voyage dans le message utilisateur', async () => {
    const fetch = vi.fn(async () => aiResponse('Relire'));
    vi.stubGlobal('fetch', fetch);
    await suggestSubtasks(settings, 'Dossier', {
      context: { project: 'Chantier', relatedTasks: ['Devis'], recentNotes: ['CR'] },
    });
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.messages[1].content).toContain('Projet : Chantier');
    expect(body.messages[1].content).toContain('- Devis');
    expect(body.messages[1].content).toContain('- CR');
  });

  test('le profil des réglages est joint à chaque appel', async () => {
    const fetch = vi.fn(async () => aiResponse('Relire'));
    vi.stubGlobal('fetch', fetch);
    await suggestSubtasks({ ...settings, profile: 'Dev solo en pisciculture' }, 'Dossier');
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.messages[1].content).toContain('Profil : Dev solo en pisciculture');
  });

  test('sans clé, aucun appel réseau et un message qui renvoie aux Paramètres', async () => {
    const fetch = vi.fn(async () => aiResponse('x'));
    vi.stubGlobal('fetch', fetch);
    await expect(suggestSubtasks({ ...settings, key: '  ' }, 'Tâche')).rejects.toThrow('⚙ Paramètres');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('clé refusée, limite atteinte et réponse illisible en français', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => aiResponse('x', 401)));
    await expect(suggestSubtasks(settings, 'T')).rejects.toThrow(/refusée/);
    vi.stubGlobal('fetch', vi.fn(async () => aiResponse('x', 429)));
    await expect(suggestSubtasks(settings, 'T')).rejects.toThrow(/Limite/);
    vi.stubGlobal('fetch', vi.fn(async () => aiResponse('   ')));
    await expect(suggestSubtasks(settings, 'T')).rejects.toThrow(/illisible/);
  });

  test('panne réseau : message franc, pas d’exception brute', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(suggestSubtasks(settings, 'T')).rejects.toBeInstanceOf(AiError);
    await expect(suggestSubtasks(settings, 'T')).rejects.toThrow(/injoignable/);
  });

  test('essai réel : appel minimal avec le modèle choisi, durée rendue', async () => {
    const fetch = vi.fn(async () => aiResponse('OK'));
    vi.stubGlobal('fetch', fetch);
    const ms = await testAiConnection({ ...settings, model: 'gemini-3.5-flash' });
    expect(typeof ms).toBe('number');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ia.example/v1/chat/completions');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('gemini-3.5-flash');
    expect(body.max_tokens).toBe(300);
  });

  test('essai réel en échec : le motif du fournisseur remonte', async () => {
    const google404 = {
      ok: false,
      status: 404,
      json: async () => ({ error: { message: 'models/inconnu is not found', code: 404 } }),
    } as Response;
    vi.stubGlobal('fetch', vi.fn(async () => google404));
    await expect(testAiConnection(settings)).rejects.toThrow(/inconnu/);
  });

  test('404 avec motif du fournisseur : le message dit quoi vérifier', async () => {
    const google404 = {
      ok: false,
      status: 404,
      json: async () => ({ error: { code: 404, message: 'models/vieux-modele is not found for API version v1beta', status: 'NOT_FOUND' } }),
    } as Response;
    vi.stubGlobal('fetch', vi.fn(async () => google404));
    await expect(suggestSubtasks(settings, 'T')).rejects.toThrow(/vieux-modele/);
    await expect(suggestSubtasks(settings, 'T')).rejects.toThrow(/Paramètres/);
  });

  test('404 sans corps lisible : message générique conservé', async () => {
    const empty404 = { ok: false, status: 404, json: async () => { throw new SyntaxError('corps vide'); } } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn(async () => empty404));
    await expect(suggestSubtasks(settings, 'T')).rejects.toThrow(/Service IA indisponible \(404\)/);
  });
});

describe('mise en page', () => {
  test('la consigne corrige sans inventer et joint profil, titre et texte', () => {
    const prompt = buildProofreadPrompt(' Réunion ', 'on a decidé', ' Dev solo ');
    expect(prompt.user).toBe('Profil : Dev solo\nTitre : Réunion\n\nTexte :\non a decidé');
    expect(prompt.system).toMatch(/sans rien inventer/);
    expect(prompt.system).toMatch(/uniquement avec le texte corrigé/);
    expect(buildProofreadPrompt('T', 'x').user).toBe('Titre : T\n\nTexte :\nx');
  });

  test('l’enveloppe de code est retirée, le code interne conservé', () => {
    expect(cleanProofreadMarkdown('```markdown\n## Titre\n- a\n```')).toBe('## Titre\n- a');
    expect(cleanProofreadMarkdown('  Texte\n\n```js\nx()\n```  ')).toBe('Texte\n\n```js\nx()\n```');
  });

  test('un appel envoie le texte entier et rend le Markdown corrigé', async () => {
    const fetch = vi.fn(async () => aiResponse('```md\n## Réunion\n\nOn a décidé.\n```'));
    vi.stubGlobal('fetch', fetch);
    const result = await proofreadEntry({ ...settings, profile: 'Dev' }, 'Réunion', '  on a decidé  ');
    expect(result).toBe('## Réunion\n\nOn a décidé.');
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.messages[1].content).toBe('Profil : Dev\nTitre : Réunion\n\nTexte :\non a decidé');
    expect(body.max_tokens).toBe(1200);
  });

  test('vide, trop long ou sans clé : aucun appel réseau', async () => {
    const fetch = vi.fn(async () => aiResponse('x'));
    vi.stubGlobal('fetch', fetch);
    await expect(proofreadEntry(settings, 'T', '   ')).rejects.toThrow(/vide/);
    await expect(proofreadEntry(settings, 'T', 'a'.repeat(MAX_PROOFREAD_CHARS + 1))).rejects.toThrow(/trop long/);
    await expect(proofreadEntry({ ...settings, key: '' }, 'T', 'texte')).rejects.toThrow('activer la mise en page');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('réponse réduite à une enveloppe vide : illisible', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => aiResponse('```\n\n```')));
    await expect(proofreadEntry(settings, 'T', 'texte')).rejects.toThrow(/illisible/);
  });
});

describe('procédures', () => {
  test('mise en page d’une procédure : annoncée comme telle, étapes en liste numérotée', () => {
    const prompt = buildProofreadPrompt('Vidange', '1. couper', '', true);
    expect(prompt.user).toBe('Procédure : Vidange\n\nTexte :\n1. couper');
    expect(prompt.system).toMatch(/mode opératoire/);
    expect(prompt.system).toMatch(/liste numérotée, une action par étape/);
    expect(prompt.system).toMatch(/sans rien inventer/);
    // Une note garde sa consigne d'origine.
    expect(buildProofreadPrompt('T', 'x').system).not.toMatch(/liste numérotée/);
  });

  test('la consigne de suggestion garde l’existant et n’invente rien de précis', () => {
    const prompt = buildProcedurePrompt(' Changer le filtre ', {
      project: 'Ferme', attachments: ['notice.pdf', 'notice.pdf', 'photo.jpg'], text: ' Bassin 3 seulement. ',
    }, ' Pisciculteur ');
    expect(prompt.user).toBe('Profil : Pisciculteur\nProcédure : Changer le filtre\nProjet : Ferme\nPièces jointes : notice.pdf, photo.jpg\nDéjà écrit :\nBassin 3 seulement.');
    expect(prompt.system).toMatch(/Garde tout ce qui est déjà écrit/);
    expect(prompt.system).toMatch(/« à préciser »/);
    expect(prompt.system).toMatch(/« ## Étapes » en liste numérotée/);
    expect(prompt.system).toMatch(/sans titre de premier niveau/);
    expect(buildProcedurePrompt('Vidange').user).toBe('Procédure : Vidange\nDéjà écrit : rien pour l’instant.');
  });

  test('un appel rend la procédure en Markdown, sans enveloppe ni titre en doublon', async () => {
    const fetch = vi.fn(async () => aiResponse('```markdown\n# Changer le filtre\n\nObjectif.\n\n## Étapes\n\n1. Couper l’eau\n```'));
    vi.stubGlobal('fetch', fetch);
    const result = await suggestProcedure({ ...settings, profile: 'Pisciculteur' }, 'Changer le filtre', { context: { project: 'Ferme', text: 'Bassin 3.' } });
    expect(result).toBe('Objectif.\n\n## Étapes\n\n1. Couper l’eau');
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.messages[1].content).toBe('Profil : Pisciculteur\nProcédure : Changer le filtre\nProjet : Ferme\nDéjà écrit :\nBassin 3.');
    expect(body.max_tokens).toBe(1500);
  });

  test('sans titre ni contenu, trop longue ou sans clé : aucun appel réseau', async () => {
    const fetch = vi.fn(async () => aiResponse('1. Étape'));
    vi.stubGlobal('fetch', fetch);
    await expect(suggestProcedure(settings, 'Sans titre')).rejects.toThrow(/Donne un titre/);
    await expect(suggestProcedure(settings, '  ')).rejects.toThrow(/Donne un titre/);
    await expect(suggestProcedure(settings, 'T', { context: { text: 'a'.repeat(MAX_PROOFREAD_CHARS + 1) } })).rejects.toThrow(/trop longue/);
    await expect(suggestProcedure({ ...settings, key: '' }, 'Vidange')).rejects.toThrow('activer les suggestions de procédure');
    expect(fetch).not.toHaveBeenCalled();
    // « Sans titre » mais déjà du texte : l'IA a de quoi travailler.
    await expect(suggestProcedure(settings, 'Sans titre', { context: { text: 'Vider le bassin' } })).resolves.toBe('1. Étape');
  });

  test('réponse réduite au titre : illisible', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => aiResponse('# Vidange')));
    await expect(suggestProcedure(settings, 'Vidange')).rejects.toBeInstanceOf(AiError);
  });
});

describe('modèle saturé', () => {
  const gemini = { endpoint: DEFAULT_AI_ENDPOINT, model: 'gemini-3.5-flash-lite', key: 'cle-test', profile: '' };
  const modelOf = (call: unknown) => JSON.parse((call as [string, RequestInit])[1].body as string).model;

  test('Gemini répond 503 : un seul essai de secours avec le modèle stable', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(aiResponse('x', 503)).mockResolvedValueOnce(aiResponse('Relire'));
    vi.stubGlobal('fetch', fetch);
    expect(await suggestSubtasks(gemini, 'Dossier')).toBe('Relire');
    expect(fetch.mock.calls.map(modelOf)).toEqual(['gemini-3.5-flash-lite', FALLBACK_AI_MODEL]);
  });

  test('Gemini trop lent : abandonné à mi-délai, le secours prend le relais', async () => {
    const fetch = vi.fn()
      .mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }))
      .mockResolvedValueOnce(aiResponse('## Propre'));
    vi.stubGlobal('fetch', fetch);
    const started = Date.now();
    expect(await proofreadEntry(gemini, 'Titre', 'brouillon', { timeoutMs: 200 })).toBe('## Propre');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(fetch.mock.calls.map(modelOf)).toEqual(['gemini-3.5-flash-lite', FALLBACK_AI_MODEL]);
  });

  test('secours saturé aussi : message « surchargé », jamais de troisième appel', async () => {
    const fetch = vi.fn(async () => aiResponse('x', 503));
    vi.stubGlobal('fetch', fetch);
    await expect(suggestSubtasks(gemini, 'T')).rejects.toThrow(/surchargé/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('pas de secours : autre fournisseur, modèle déjà stable, clé refusée ou hors ligne', async () => {
    let fetch = vi.fn(async () => aiResponse('x', 503));
    vi.stubGlobal('fetch', fetch);
    await expect(suggestSubtasks(settings, 'T')).rejects.toThrow(/surchargé/);
    expect(fetch).toHaveBeenCalledTimes(1);

    fetch = vi.fn(async () => aiResponse('x', 503));
    vi.stubGlobal('fetch', fetch);
    await expect(suggestSubtasks({ ...gemini, model: FALLBACK_AI_MODEL }, 'T')).rejects.toThrow(/surchargé/);
    expect(fetch).toHaveBeenCalledTimes(1);

    fetch = vi.fn(async () => aiResponse('x', 401));
    vi.stubGlobal('fetch', fetch);
    await expect(suggestSubtasks(gemini, 'T')).rejects.toThrow(/refusée/);
    expect(fetch).toHaveBeenCalledTimes(1);

    fetch = vi.fn(async () => { throw new TypeError('fetch failed'); });
    vi.stubGlobal('fetch', fetch);
    await expect(suggestSubtasks(gemini, 'T')).rejects.toThrow('IA injoignable : hors ligne ou endpoint incorrect.');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('délai dépassé sans secours : « surchargé », plus « hors ligne »', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })));
    await expect(suggestSubtasks(settings, 'T', { timeoutMs: 50 })).rejects.toThrow(/surchargé/);
  });

  test('le modèle enregistré est gardé tel quel, même hors select', () => {
    localStorage.setItem('worklogs-ai-model', 'gemini-3.5-flash-lite');
    expect(readAiSettings().model).toBe(DEFAULT_AI_MODEL);
    // Choix explicite conservé : pas de migration silencieuse (un modèle peut
    // marcher pour une ancienne clé et pas pour une nouvelle).
    localStorage.setItem('worklogs-ai-model', 'gemini-2.5-flash-lite');
    expect(readAiSettings().model).toBe('gemini-2.5-flash-lite');
  });
});
