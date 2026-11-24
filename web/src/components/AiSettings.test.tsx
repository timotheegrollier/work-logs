import { beforeEach, describe, expect, test, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AiSettings } from './AiSettings';
import { pacificDay } from '../ai-budget';
import { readProjectAiBrief, saveProjectAiBrief } from '../ai-context';
import { DEFAULT_AI_ENDPOINT, DEFAULT_AI_MODEL, GEMINI_AI_ENDPOINT, GEMINI_DEFAULT_MODEL, saveAiSettings, saveGoogleAiConsent } from '../ai-suggest';

beforeEach(() => {
  localStorage.clear();
  saveGoogleAiConsent(true);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function okResponse(content: string) {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) } as Response;
}

function configureExternal(endpoint = 'https://ia.example/v1', model = 'modele-perso', key = 'cle-test') {
  saveAiSettings({ endpoint, model, key, profile: '' });
}

describe('réglages IA', () => {
  test('Worker WorkLogs par défaut sans clé et aucun appel à l’ouverture', async () => {
    const user = userEvent.setup();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    render(<AiSettings />);
    const advanced = screen.getByText('Réglages avancés').closest('details');
    expect(advanced).not.toHaveAttribute('open');
    expect(screen.queryByLabelText('Clé IA')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tester la connexion' })).toBeVisible();
    expect(screen.getByText('IA gratuite sans clé.')).toBeVisible();
    expect(screen.getByText(/Gemini Flash chez Google/)).toHaveTextContent('puis Gemma 4 chez Cloudflare');
    expect(screen.getByRole('region', { name: 'Modèles et quotas de l’IA' })).toHaveTextContent('Lecture des quotas…');
    expect(screen.queryByLabelText('Accepter l’envoi à Google')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Endpoint IA')).not.toBeVisible();
    await user.click(screen.getByText('Réglages avancés'));
    expect(screen.getByLabelText('Endpoint IA')).toBeVisible();
    expect(screen.getByLabelText('Endpoint IA')).toHaveValue(DEFAULT_AI_ENDPOINT);
    expect(screen.getByLabelText('Plafond de requêtes IA par jour')).toHaveValue(150);
    await user.click(screen.getByText('Réglages avancés'));
    expect(advanced).not.toHaveAttribute('open');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('le projet actif initialise sa fiche sans modifier les autres projets', async () => {
    const user = userEvent.setup();
    saveProjectAiBrief('p1', 'Commandes Linux');
    saveProjectAiBrief('p2', 'Postes Windows');
    render(<AiSettings projects={[{ id: 'p1', name: 'Atelier' }, { id: 'p2', name: 'Bureau' }]} projectId="p2" />);
    expect(screen.getByLabelText('Projet du contexte IA')).toHaveValue('p2');
    expect(screen.getByLabelText('Contexte IA du projet')).toHaveValue('Postes Windows');
    await user.type(screen.getByLabelText('Contexte IA du projet'), ', réponses courtes');
    expect(readProjectAiBrief('p2')).toBe('Postes Windows, réponses courtes');
    expect(readProjectAiBrief('p1')).toBe('Commandes Linux');
  });

  test('les consignes sont propres au projet choisi et restent sur cet appareil', async () => {
    const user = userEvent.setup();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    render(<AiSettings projects={[{ id: 'p1', name: 'Atelier' }, { id: 'p2', name: 'Bureau' }]} />);
    expect(screen.getByRole('heading', { name: 'Assistance IA' })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Projet du contexte IA'), 'p1');
    await user.type(screen.getByLabelText('Contexte IA du projet'), 'Utiliser les commandes Linux');
    await user.selectOptions(screen.getByLabelText('Projet du contexte IA'), 'p2');
    expect(screen.getByLabelText('Contexte IA du projet')).toHaveValue('');
    await user.type(screen.getByLabelText('Contexte IA du projet'), 'Postes Windows');
    await user.selectOptions(screen.getByLabelText('Projet du contexte IA'), 'p1');
    expect(screen.getByLabelText('Contexte IA du projet')).toHaveValue('Utiliser les commandes Linux');
    expect(readProjectAiBrief('p2')).toBe('Postes Windows');
    expect(screen.getByText(/Facultatif, enregistré sur cet appareil uniquement/)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  test('le sélecteur propose les modèles Gemini gratuits et le modèle personnalisé', async () => {
    const user = userEvent.setup();
    configureExternal(GEMINI_AI_ENDPOINT, GEMINI_DEFAULT_MODEL, 'AIza-cle-test');
    render(<AiSettings />);
    await user.click(screen.getByText('Réglages avancés'));
    const select = screen.getByLabelText('Modèle IA');
    expect(select).toHaveValue(GEMINI_DEFAULT_MODEL);
    const options = [...(select as HTMLSelectElement).options].map((option) => option.value);
    expect(options).toEqual(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite', 'personnalise']);
    fireEvent.change(select, { target: { value: 'gemini-2.5-flash-lite' } });
    expect(localStorage.getItem('worklogs-ai-model')).toBe('gemini-2.5-flash-lite');
  });

  test('Google ne reçoit rien tant que la case de confidentialité n’est pas acceptée', async () => {
    const user = userEvent.setup();
    const fetch = vi.fn(async () => okResponse('OK'));
    vi.stubGlobal('fetch', fetch);
    configureExternal(GEMINI_AI_ENDPOINT, GEMINI_DEFAULT_MODEL, 'AIza-cle-test');
    localStorage.removeItem('worklogs-ai-google-consent');
    render(<AiSettings />);
    await user.click(screen.getByText('Réglages avancés'));
    expect(screen.getByLabelText('Accepter l’envoi à Google')).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Tester la connexion' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/accepte l’avertissement de confidentialité/);
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Créer une clé Gemini dans Google AI Studio' })).toHaveAttribute('href', 'https://aistudio.google.com/app/apikey');
  });

  test('« Utiliser Gemini » bascule en un clic, sans reprendre la clé d’un autre service', async () => {
    const user = userEvent.setup();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    configureExternal('https://openrouter.ai/api/v1', 'openrouter/free', 'sk-or-cle-test');
    localStorage.setItem('worklogs-ai-provider-v2', '1');
    render(<AiSettings />);
    await user.click(screen.getByText('Réglages avancés'));
    await user.click(screen.getByRole('button', { name: 'Utiliser Gemini avec ma clé gratuite' }));
    expect(screen.getByLabelText('Endpoint IA')).toHaveValue(GEMINI_AI_ENDPOINT);
    expect(screen.getByLabelText('Modèle IA')).toHaveValue(GEMINI_DEFAULT_MODEL);
    expect(screen.getByLabelText('Clé IA')).toHaveValue('');
    expect(screen.getByRole('link', { name: 'Créer une clé Gemini dans Google AI Studio' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Utiliser Gemini avec ma clé gratuite' })).not.toBeInTheDocument();
    expect(localStorage.getItem('worklogs-ai-endpoint')).toBe(GEMINI_AI_ENDPOINT);
    expect(localStorage.getItem('worklogs-ai-key')).toBe('');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('choisir un modèle l’enregistre sur l’appareil', async () => {
    const user = userEvent.setup();
    render(<AiSettings />);
    await user.click(screen.getByText('Réglages avancés'));
    fireEvent.change(screen.getByLabelText('Endpoint IA'), { target: { value: GEMINI_AI_ENDPOINT } });
    expect(screen.getByLabelText('Modèle IA')).toHaveValue(GEMINI_DEFAULT_MODEL);
    await user.selectOptions(screen.getByLabelText('Modèle IA'), 'gemini-3.1-flash-lite');
    expect(localStorage.getItem('worklogs-ai-model')).toBe('gemini-3.1-flash-lite');
  });

  test('la consommation du jour s’affiche et le plafond quotidien reste borné', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-usage', JSON.stringify({ day: pacificDay(), requests: 12, tokens: 18_400, background: 2 }));
    render(<AiSettings />);
    expect(screen.getByText('Aujourd’hui : 12 / 150 requêtes · ≈ 18 400 jetons')).toBeVisible();
    await user.click(screen.getByText('Réglages avancés'));
    const limit = screen.getByLabelText('Plafond de requêtes IA par jour');
    expect(limit).toHaveValue(150);
    expect(limit).toHaveAttribute('min', '10');
    expect(limit).toHaveAttribute('max', '5000');
    await user.clear(limit);
    await user.type(limit, '300');
    expect(localStorage.getItem('worklogs-ai-daily-limit')).toBe('300');
    expect(screen.getByText('Aujourd’hui : 12 / 300 requêtes · ≈ 18 400 jetons')).toBeVisible();
    // Libre le temps de la frappe, ramené dans les bornes en quittant le champ.
    await user.clear(limit);
    await user.type(limit, '3');
    expect(limit).toHaveValue(3);
    await user.tab();
    expect(limit).toHaveValue(10);
    expect(localStorage.getItem('worklogs-ai-daily-limit')).toBe('10');
    await user.clear(limit);
    await user.type(limit, '999999');
    await user.tab();
    expect(limit).toHaveValue(5000);
    expect(localStorage.getItem('worklogs-ai-daily-limit')).toBe('5000');
  });

  test('l’envoi automatique du suivi est annoncé et la garantie de gratuité expliquée', () => {
    render(<AiSettings />);
    expect(screen.queryByText(/jamais automatiquement/)).not.toBeInTheDocument();
    expect(screen.getByText(/Sans clic, seuls les\s+éléments ajoutés au suivi IA/)).toBeInTheDocument();
    expect(screen.getByText('IA gratuite sans clé.')).toBeVisible();
    expect(screen.getByText(/Le compteur porte sur cet appareil/)).toHaveTextContent('Le service peut atteindre son propre quota');
  });

  test('un modèle payant ou un autre service rétablit l’avertissement de prix', async () => {
    const user = userEvent.setup();
    const warning = /ne peut pas garantir la gratuité/;
    render(<AiSettings />);
    expect(screen.queryByText(warning)).not.toBeInTheDocument();
    await user.click(screen.getByText('Réglages avancés'));
    fireEvent.change(screen.getByLabelText('Endpoint IA'), { target: { value: 'https://ia.example/v1' } });
    expect(screen.getByLabelText('Plafond de requêtes IA par jour')).toHaveValue(50);
    expect(screen.queryByText(/10 000 neurones par jour/)).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText('Modèle personnalisé'));
    await user.type(screen.getByLabelText('Modèle personnalisé'), 'studio/modele-payant');
    expect(screen.getByText(warning)).toBeVisible();
  });

  test('modèle inconnu enregistré : saisie libre préremplie', async () => {
    const user = userEvent.setup();
    configureExternal('https://ia.example/v1', 'vieux-modele');
    render(<AiSettings />);
    expect(screen.getByText('Modèle choisi : vieux-modele')).toBeVisible();
    await user.click(screen.getByText('Réglages avancés'));
    expect(screen.getByLabelText('Modèle personnalisé')).toHaveValue('vieux-modele');
    await user.clear(screen.getByLabelText('Modèle personnalisé'));
    await user.type(screen.getByLabelText('Modèle personnalisé'), 'autre-modele');
    expect(localStorage.getItem('worklogs-ai-model')).toBe('autre-modele');
  });

  test('« Tester la connexion » envoie le diagnostic au Worker WorkLogs sans identifiants', async () => {
    const user = userEvent.setup();
    const fetch = vi.fn(async () => okResponse('OK'));
    vi.stubGlobal('fetch', fetch);
    render(<AiSettings />);
    await user.click(screen.getByRole('button', { name: 'Tester la connexion' }));
    expect(await screen.findByText(/Connexion vérifiée/)).toBeVisible();
    const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${DEFAULT_AI_ENDPOINT}/chat/completions`);
    expect(JSON.parse(options.body as string).model).toBe(DEFAULT_AI_MODEL);
    expect(new Headers(options.headers).has('authorization')).toBe(false);
    expect(options.credentials).toBe('omit');
    expect(localStorage.getItem('worklogs-ai-key')).toBeNull();
  });

  test('« Tester la connexion » en échec affiche le motif du fournisseur', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({ error: { message: 'models/inconnu is not found', code: 404 } }),
      }) as Response)
    );
    configureExternal();
    render(<AiSettings />);
    await user.click(screen.getByRole('button', { name: 'Tester la connexion' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/inconnu/);
  });

  test('« Tester la connexion » sur un service personnalisé sans clé explique le repli local', async () => {
    const user = userEvent.setup();
    const fetch = vi.fn(async () => okResponse('OK'));
    vi.stubGlobal('fetch', fetch);
    configureExternal('https://ia.example/v1', 'modele-perso', '');
    render(<AiSettings />);
    await user.click(screen.getByRole('button', { name: 'Tester la connexion' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Aucune IA intégrée/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each(['Clé IA', 'Endpoint IA', 'Modèle IA'])('modifier %s invalide le diagnostic réussi', async (field) => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(async () => okResponse('OK')));
    configureExternal(GEMINI_AI_ENDPOINT, GEMINI_DEFAULT_MODEL, 'AIza-cle-test');
    render(<AiSettings />);
    await user.click(screen.getByRole('button', { name: 'Tester la connexion' }));
    await screen.findByText(/Connexion vérifiée/);
    await user.type(screen.getByLabelText('Mon contexte de travail'), 'Maintenance');
    expect(screen.getByRole('status')).toHaveTextContent(/Connexion vérifiée/);
    await user.click(screen.getByText('Réglages avancés'));
    if (field === 'Modèle IA') {
      await user.selectOptions(screen.getByLabelText(field), 'gemini-3.1-flash-lite');
    } else await user.type(screen.getByLabelText(field), 'x');
    expect(screen.getByRole('status')).toHaveTextContent('Connexion non testée.');
    expect(screen.queryByText(/Connexion vérifiée/)).not.toBeInTheDocument();
  });

  test.each(['succès', 'échec'])('un %s ancien reçu après changement de clé reste ignoré', async (outcome) => {
    const user = userEvent.setup();
    let finish: ((response: Response) => void) | undefined;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal('fetch', fetch);
    localStorage.setItem('worklogs-ai-key', 'ancienne-cle');
    localStorage.setItem('worklogs-ai-endpoint', 'https://ia.example/v1');
    render(<AiSettings />);
    await user.click(screen.getByRole('button', { name: 'Tester la connexion' }));
    expect(screen.getByRole('status')).toHaveTextContent('Test en cours…');
    await user.click(screen.getByText('Réglages avancés'));
    await user.type(screen.getByLabelText('Clé IA'), '-modifiee');
    expect(screen.getByRole('status')).toHaveTextContent('Connexion non testée.');
    await act(async () => {
      finish!(outcome === 'succès' ? okResponse('OK') : {
        ok: false, status: 401, json: async () => ({ error: { message: 'ancienne clé refusée' } }),
      } as Response);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Connexion non testée.');
    expect(screen.queryByText(/Connexion vérifiée/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('restaurer les réglages gratuits efface la clé externe et conserve le contexte', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-key', 'sk-or-test');
    localStorage.setItem('worklogs-ai-endpoint', 'https://openrouter.ai/api/v1/');
    localStorage.setItem('worklogs-ai-model', 'modele-perso');
    localStorage.setItem('worklogs-ai-profile', 'Maintenance');
    render(<AiSettings />);
    await user.click(screen.getByText('Réglages avancés'));
    await user.click(screen.getByRole('button', { name: 'Restaurer les réglages gratuits' }));
    expect(screen.getByLabelText('Endpoint IA')).toHaveValue(DEFAULT_AI_ENDPOINT);
    expect(screen.queryByLabelText('Clé IA')).not.toBeInTheDocument();
    expect(localStorage.getItem('worklogs-ai-key')).toBe('');
    expect(screen.getByLabelText('Mon contexte de travail')).toHaveValue('Maintenance');
    expect(screen.getByLabelText('Mon contexte de travail')).toHaveAttribute('maxlength', '2000');
    expect(screen.queryByLabelText('Modèle personnalisé')).not.toBeInTheDocument();
    expect(localStorage.getItem('worklogs-ai-model')).toBe(DEFAULT_AI_MODEL);
  });

  test('modifier l’adresse garde la clé sur la même origine et la vide en changeant d’origine', async () => {
    const user = userEvent.setup();
    configureExternal(GEMINI_AI_ENDPOINT, GEMINI_DEFAULT_MODEL, 'AIza-cle-gemini');
    render(<AiSettings />);
    await user.click(screen.getByText('Réglages avancés'));
    const endpoint = screen.getByLabelText('Endpoint IA');
    fireEvent.change(endpoint, { target: { value: 'https://generativelanguage.googleapis.com/v1beta/openai/' } });
    expect(screen.getByLabelText('Clé IA')).toHaveValue('AIza-cle-gemini');
    fireEvent.change(endpoint, { target: { value: 'https://ia.example/v1' } });
    expect(screen.getByLabelText('Clé IA')).toHaveValue('');
    expect(localStorage.getItem('worklogs-ai-key')).toBe('');
  });
});
