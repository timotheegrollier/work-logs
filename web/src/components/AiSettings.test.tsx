import { beforeEach, describe, expect, test, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AiSettings } from './AiSettings';

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function okResponse(content: string) {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) } as Response;
}

describe('réglages IA', () => {
  test('le select propose les modèles vérifiés et le défaut est sélectionné', () => {
    render(<AiSettings />);
    const select = screen.getByLabelText('Modèle IA');
    expect(select).toHaveValue('gemini-3-flash-preview');
    const options = [...(select as HTMLSelectElement).options].map((option) => option.value);
    expect(options).toEqual([
      'gemini-3-flash-preview',
      'gemini-2.5-flash',
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
      'personnalise',
    ]);
  });

  test('choisir un modèle l’enregistre sur l’appareil', async () => {
    const user = userEvent.setup();
    render(<AiSettings />);
    await user.selectOptions(screen.getByLabelText('Modèle IA'), 'gemini-3.5-flash');
    expect(localStorage.getItem('worklogs-ai-model')).toBe('gemini-3.5-flash');
  });

  test('modèle inconnu enregistré : saisie libre préremplie', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-model', 'vieux-modele');
    render(<AiSettings />);
    expect(screen.getByLabelText('Modèle IA')).toHaveValue('personnalise');
    expect(screen.getByLabelText('Modèle personnalisé')).toHaveValue('vieux-modele');
    await user.clear(screen.getByLabelText('Modèle personnalisé'));
    await user.type(screen.getByLabelText('Modèle personnalisé'), 'autre-modele');
    expect(localStorage.getItem('worklogs-ai-model')).toBe('autre-modele');
  });

  test('« Tester le modèle » fait un vrai appel et affiche la réussite', async () => {
    const user = userEvent.setup();
    const fetch = vi.fn(async () => okResponse('OK'));
    vi.stubGlobal('fetch', fetch);
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    render(<AiSettings />);
    await user.click(screen.getByRole('button', { name: 'Tester le modèle' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/Modèle OK/);
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.model).toBe('gemini-3-flash-preview');
  });

  test('« Tester le modèle » en échec affiche le motif du fournisseur', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({ error: { message: 'models/inconnu is not found', code: 404 } }),
      }) as Response)
    );
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    render(<AiSettings />);
    await user.click(screen.getByRole('button', { name: 'Tester le modèle' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/inconnu/);
  });

  test('« Tester le modèle » sans clé renvoie aux Paramètres sans appel réseau', async () => {
    const user = userEvent.setup();
    const fetch = vi.fn(async () => okResponse('OK'));
    vi.stubGlobal('fetch', fetch);
    render(<AiSettings />);
    await user.click(screen.getByRole('button', { name: 'Tester le modèle' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Colle ta clé IA/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
