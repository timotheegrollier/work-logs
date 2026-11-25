import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import { AiQuotas, AI_STATUS_REFRESH_MS } from './AiQuotas';
import { AI_USED_EVENT, aiModelName, readAiStatus, type AiStatus } from '../ai-status';

const status = (over: Partial<AiStatus> = {}): AiStatus => ({
  updated_at: '2026-11-24T10:00:00.000Z',
  gemini_configured: true,
  catalog_checked_at: '2026-11-24T09:00:00.000Z',
  models: [
    {
      id: 'gemini-flash-latest', provider: 'google', label: 'Gemini Flash Latest', version: null, resolved: 'gemini-3.8-flash',
      today: { requests: 20, input_tokens: 40_000, output_tokens: 5_000 }, last_minute: 2,
      limits: { requests_per_day: { value: 20, learned_at: '2026-11-24T09:58:00.000Z' } },
      reset_at: '2026-11-25T08:00:00.000Z', blocked_until: '2026-11-25T08:00:00.000Z', blocked_reason: 'quota du jour atteint',
      last_used_at: '2026-11-24T09:58:00.000Z', last_error: null,
    },
    {
      id: 'gemini-flash-lite-latest', provider: 'google', label: 'Gemini Flash-Lite Latest', version: null, resolved: null,
      today: { requests: 1, input_tokens: 900, output_tokens: 100 }, last_minute: 0, limits: {},
      reset_at: '2026-11-25T08:00:00.000Z', blocked_until: null, blocked_reason: null,
      last_used_at: '2026-11-24T09:59:00.000Z', last_error: { at: '2026-11-24T09:30:00.000Z', reason: 'demande refusée par Google' },
    },
    {
      id: '@cf/google/gemma-4-26b-a4b-it', provider: 'cloudflare', label: 'Gemma 4 26B (Cloudflare Workers AI)', version: null, resolved: null,
      today: { requests: 3, input_tokens: 12_000, output_tokens: 1_500 }, last_minute: 0, limits: {},
      neurons: { used: 150, limit: 10_000 },
      reset_at: '2026-11-25T00:00:00.000Z', blocked_until: null, blocked_reason: null, last_used_at: null, last_error: null,
    },
  ],
  ...over,
});

afterEach(() => {
  vi.mocked(readAiStatus).mockReset().mockImplementation(() => new Promise(() => {}));
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('modèles et quotas de l’IA', () => {
  test('chaque modèle dans l’ordre d’essai : usage du jour, limite apprise de Google, blocage et retour', async () => {
    vi.mocked(readAiStatus).mockResolvedValue(status());
    render(<AiQuotas />);
    const region = screen.getByRole('region', { name: 'Modèles et quotas de l’IA' });
    const [flash, lite, gemma] = await within(region).findAllByRole('listitem');
    expect(flash).toHaveAccessibleName('Gemini Flash Latest → Gemini 3.8 Flash');
    expect(flash).toHaveClass('is-blocked');
    expect(flash).toHaveTextContent(/Quota du jour atteint — retour à \d\d:\d\d/);
    expect(flash).toHaveTextContent('Aujourd’hui : 20 requêtes · 45 000 jetons · 2 dans la dernière minute');
    expect(flash).toHaveTextContent(/Limite : 20 requêtes \/ jour, indiquée par Google le 24\/11/);
    expect(lite).toHaveTextContent('Disponible');
    expect(lite).toHaveTextContent('Aujourd’hui : 1 requête · 1 000 jetons');
    expect(within(lite).getByRole('link', { name: 'visible dans AI Studio' })).toHaveAttribute('href', 'https://aistudio.google.com/rate-limit');
    expect(lite).toHaveTextContent('dernière erreur : demande refusée par Google');
    expect(gemma).toHaveTextContent('≈ 150 / 10 000 neurones utilisés (quota gratuit Cloudflare)');
    expect(region).toHaveTextContent(/Comptés par le Worker pour tous tes appareils, actualisés à \d\d:\d\d/);
    expect(screen.queryByText(/pas encore activé/)).not.toBeInTheDocument();
  });

  test('relu après chaque réponse IA et toutes les minutes ; une panne garde le dernier état', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const read = vi.mocked(readAiStatus).mockResolvedValue(status());
    render(<AiQuotas />);
    await screen.findAllByRole('listitem');
    expect(read).toHaveBeenCalledTimes(1);
    act(() => { window.dispatchEvent(new CustomEvent(AI_USED_EVENT, { detail: { model: 'gemini-3.8-flash' } })); });
    expect(read).toHaveBeenCalledTimes(2);
    read.mockRejectedValue(new Error('hors ligne'));
    await act(async () => { await vi.advanceTimersByTimeAsync(AI_STATUS_REFRESH_MS); });
    expect(read).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('status')).toHaveTextContent('le Worker WorkLogs ne répond pas');
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  test('clés absentes du Worker : nommées ; Groq renvoie à sa console tant que la limite n’est pas connue', async () => {
    const oss = {
      ...status().models[1], id: 'openai/gpt-oss-120b', provider: 'groq' as const, label: 'GPT-OSS 120B (Groq)', resolved: null, last_error: null,
    };
    const llama = {
      ...oss, id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B (Groq)',
      limits: { tokens_per_day: { value: 200_000, learned_at: '2026-11-24T09:58:00.000Z' } },
    };
    vi.mocked(readAiStatus).mockResolvedValue(status({ missing_providers: ['Gemini'], models: [oss, llama, status().models[2]] }));
    render(<AiQuotas />);
    expect(await screen.findByText('Pas encore activé sur le Worker WorkLogs, faute de clé : Gemini.')).toBeVisible();
    const [first, second] = screen.getAllByRole('listitem');
    expect(first).toHaveAccessibleName('GPT-OSS 120B (Groq)');
    expect(within(first).getByRole('link', { name: 'visible dans la console Groq' })).toHaveAttribute('href', 'https://console.groq.com/settings/limits');
    expect(second).toHaveTextContent(/Limite : 200 000 jetons \/ jour, indiquée par Groq le 24\/11/);
  });

  test('lecture réelle : `/ai/status` du Worker, sans cookie ni redirection', async () => {
    const { readAiStatus: realRead } = await vi.importActual<typeof import('../ai-status')>('../ai-status');
    const fetch = vi.fn(async () => Response.json(status()));
    vi.stubGlobal('fetch', fetch);
    await expect(realRead()).resolves.toMatchObject({ gemini_configured: true });
    expect(fetch).toHaveBeenCalledWith('https://worklogs-google.cocodexcocoder.workers.dev/ai/status', expect.objectContaining({ credentials: 'omit', redirect: 'error' }));
    fetch.mockResolvedValueOnce(Response.json({ error: 'x' }));
    await expect(realRead()).rejects.toThrow('État de l’IA illisible.');
  });

  test('noms courts des modèles', () => {
    expect(aiModelName('gemini-3.8-flash')).toBe('Gemini 3.8 Flash');
    expect(aiModelName('gemini-3.5-flash-lite')).toBe('Gemini 3.5 Flash-Lite');
    expect(aiModelName('@cf/google/gemma-4-26b-a4b-it')).toBe('Gemma 4 26B');
    expect(aiModelName('openai/gpt-oss-120b')).toBe('GPT-OSS 120B');
    expect(aiModelName('llama-3.3-70b-versatile')).toBe('Llama 3.3 70B');
  });
});
