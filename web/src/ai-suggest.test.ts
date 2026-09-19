import { describe, expect, test, vi, afterEach } from 'vitest';
import {
  AiError,
  buildSuggestPrompt,
  cleanSuggestionLines,
  readAiSettings,
  saveAiSettings,
  suggestSubtasks,
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

const settings = { endpoint: 'https://ia.example/v1', model: 'flash', key: 'cle-test' };

describe('consigne et nettoyage', () => {
  test('la consigne reprend le titre et exige des lignes courtes en français', () => {
    const prompt = buildSuggestPrompt('  Préparer le dossier  ');
    expect(prompt.user).toBe('Tâche : Préparer le dossier');
    expect(prompt.system).toMatch(/français/);
    expect(prompt.system).toMatch(/une par ligne/);
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

describe('réglages', () => {
  test('défauts Gemini gratuits, clé vide sans collage', () => {
    expect(readAiSettings()).toEqual({ endpoint: DEFAULT_AI_ENDPOINT, model: DEFAULT_AI_MODEL, key: '' });
  });

  test('les valeurs collées en Paramètres sont relues et rognées', () => {
    saveAiSettings({ endpoint: 'https://autre/v1/ ', model: '  perso ', key: ' k ' });
    expect(readAiSettings()).toEqual({ endpoint: 'https://autre/v1/', model: 'perso', key: 'k' });
  });
});

describe('appel', () => {
  test('un clic envoie le titre seul en Bearer et nettoie la réponse', async () => {
    const fetch = vi.fn(async () => aiResponse('Relire\n1. Payer\n'));
    vi.stubGlobal('fetch', fetch);
    const result = await suggestSubtasks(settings, 'Préparer le dossier', 5000);
    expect(result).toBe('Relire\nPayer');
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ia.example/v1/chat/completions');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer cle-test' });
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('flash');
    expect(body.messages[1]).toMatchObject({ role: 'user', content: 'Tâche : Préparer le dossier' });
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
