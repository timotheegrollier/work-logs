import { afterEach, describe, expect, test, vi } from 'vitest';
import { deviceCompletion, deviceText, isLocalAiEndpoint, prepareDeviceAi, readDeviceAiStatus } from './ai-device';
import { postChatCompletions, resetAiFallbackMemory } from './ai-suggest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  resetAiFallbackMemory();
});

function fakeDevice(overrides: Record<string, unknown> = {}) {
  const create = vi.fn(async () => ({ prompt: vi.fn(async () => 'Réponse locale.'), destroy: vi.fn() }));
  vi.stubGlobal('LanguageModel', { availability: vi.fn(async () => 'available'), create, ...overrides });
  return { create };
}

const settings = (patch = {}) => ({ endpoint: 'https://openrouter.ai/api/v1', model: 'openrouter/free', key: '', profile: '', ...patch });

describe('IA intégrée au navigateur', () => {
  test('sans API dans le navigateur, l’état est « unsupported » et rien n’est tenté', async () => {
    expect(await readDeviceAiStatus()).toEqual({ state: 'unsupported' });
    expect(await deviceCompletion('système', 'demande')).toBeNull();
    expect(await prepareDeviceAi()).toEqual({ state: 'unsupported' });
  });

  test('disponible : la réponse part sans clé, sans réseau, et la session est libérée', async () => {
    const destroy = vi.fn();
    const prompt = vi.fn(async () => '  Réponse locale.  ');
    vi.stubGlobal('LanguageModel', { availability: async () => 'available', create: async () => ({ prompt, destroy }) });
    expect(await deviceCompletion('Tu es WorkLogs.', 'Résume.')).toBe('Réponse locale.');
    expect(prompt).toHaveBeenCalledWith('Résume.', expect.objectContaining({ signal: undefined }));
    expect(destroy).toHaveBeenCalledOnce();
  });

  test('seulement téléchargeable : aucun téléchargement dans le dos de l’utilisateur', async () => {
    const create = vi.fn();
    vi.stubGlobal('LanguageModel', { availability: async () => 'downloadable', create });
    expect(await deviceCompletion('s', 'u')).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  test('« Préparer l’IA gratuite » crée une session puis relit l’état', async () => {
    let available = false;
    const create = vi.fn(async () => {
      available = true;
      return { prompt: vi.fn(), destroy: vi.fn() };
    });
    vi.stubGlobal('LanguageModel', { availability: async () => available ? 'available' : 'downloadable', create });
    expect(await prepareDeviceAi()).toEqual({ state: 'available' });
    expect(create).toHaveBeenCalledOnce();
  });

  test('le JSON est extrait des clôtures Markdown du petit modèle', () => {
    expect(deviceText('```json\n{"a":1}\n```', true)).toBe('{"a":1}');
    expect(deviceText('Voici : {"a":1} — fin.', true)).toBe('{"a":1}');
    expect(deviceText('du texte', false)).toBe('du texte');
  });

  test('un endpoint local se passe de clé, sans en-tête Authorization', async () => {
    expect(isLocalAiEndpoint('http://127.0.0.1:11434/v1')).toBe(true);
    expect(isLocalAiEndpoint('http://localhost:1234/v1')).toBe(true);
    expect(isLocalAiEndpoint('https://openrouter.ai/api/v1')).toBe(false);
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) }));
    vi.stubGlobal('fetch', fetch);
    await expect(postChatCompletions(settings({ endpoint: 'http://127.0.0.1:11434/v1', model: 'qwen2.5' }), 'le test', 's', 'u', 300, 5000, { only: true }))
      .resolves.toBe('OK');
    expect(fetch.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
  });

  test('sans clé ni endpoint local ni IA intégrée, le message renvoie aux solutions gratuites', async () => {
    await expect(postChatCompletions(settings(), 'les suggestions', 's', 'u', 300, 5000))
      .rejects.toThrow(/Aucune IA intégrée.*recherche locale.*Prépare l’IA gratuite de Chrome/);
  });

  test('sans clé, toutes les actions IA passent par l’IA intégrée sans compter au plafond', async () => {
    fakeDevice();
    await expect(postChatCompletions(settings(), 'les suggestions', 's', 'u', 300, 5000)).resolves.toBe('Réponse locale.');
  });
});
