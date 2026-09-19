import { describe, expect, test, vi, afterEach } from 'vitest';
import {
  AiError,
  buildSuggestPrompt,
  cleanSuggestionLines,
  parseChecklist,
  readAiSettings,
  recurringVocabulary,
  saveAiSettings,
  suggestSubtasks,
  taskSuggestContext,
  truncate,
  DEFAULT_AI_ENDPOINT,
  DEFAULT_AI_MODEL,
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
});
