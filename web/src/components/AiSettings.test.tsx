import { beforeEach, describe, expect, test, vi, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AiSettings } from './AiSettings';
import { pacificDay } from '../ai-budget';
import { readProjectAiBrief, saveProjectAiBrief } from '../ai-context';

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
  test('clé et connexion visibles, réglages avancés repliés, aucun appel à l’ouverture', async () => {
    const user = userEvent.setup();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    render(<AiSettings />);
    const advanced = screen.getByText('Réglages avancés').closest('details');
    expect(advanced).not.toHaveAttribute('open');
    expect(screen.getByLabelText('Clé IA')).toBeVisible();
    expect(screen.getByLabelText('Clé IA')).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Tester la connexion' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Assistance inactive : clé IA manquante.');
    expect(screen.getByText('Colle ta clé IA pour activer l’assistance.')).toBeVisible();
    expect(screen.getByText('Modèle choisi : Gemini 3 Flash (preview)')).toBeVisible();
    expect(screen.getByLabelText('Endpoint IA')).not.toBeVisible();
    expect(screen.getByLabelText('Modèle IA')).not.toBeVisible();
    await user.click(screen.getByText('Réglages avancés'));
    expect(screen.getByLabelText('Endpoint IA')).toBeVisible();
    expect(screen.getByLabelText('Modèle IA')).toBeVisible();
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

  test('le select propose les modèles vérifiés et le défaut est sélectionné', async () => {
    const user = userEvent.setup();
    render(<AiSettings />);
    await user.click(screen.getByText('Réglages avancés'));
    const select = screen.getByLabelText('Modèle IA');
    expect(select).toHaveValue('gemini-3-flash-preview');
    const options = [...(select as HTMLSelectElement).options].map((option) => option.value);
    expect(options).toEqual([
      'gemini-3-flash-preview',
      'gemini-2.5-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
      'personnalise',
    ]);
  });

  test('choisir un modèle l’enregistre sur l’appareil', async () => {
    const user = userEvent.setup();
    render(<AiSettings />);
    await user.click(screen.getByText('Réglages avancés'));
    await user.selectOptions(screen.getByLabelText('Modèle IA'), 'gemini-3.6-flash');
    expect(localStorage.getItem('worklogs-ai-model')).toBe('gemini-3.6-flash');
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
    expect(screen.getByText(/d’un projet sans facturation ne coûte rien/)).toHaveTextContent('le compteur porte sur cet appareil');
  });

  test('la gratuité n’est garantie qu’avec un modèle de la chaîne de secours sur l’endpoint Gemini', async () => {
    const user = userEvent.setup();
    const warning = /ne peut pas garantir la gratuité/;
    render(<AiSettings />);
    expect(screen.queryByText(warning)).not.toBeInTheDocument();
    await user.click(screen.getByText('Réglages avancés'));
    await user.selectOptions(screen.getByLabelText('Modèle IA'), 'gemini-3.6-flash');
    expect(screen.queryByText(warning)).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Modèle IA'), 'personnalise');
    await user.type(screen.getByLabelText('Modèle personnalisé'), 'modele-payant');
    expect(screen.getByText(warning)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Restaurer les réglages Gemini' }));
    expect(screen.queryByText(warning)).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText('Endpoint IA'));
    await user.type(screen.getByLabelText('Endpoint IA'), 'https://ia.example/v1');
    expect(screen.getByText(warning)).toBeVisible();
  });

  test('modèle inconnu enregistré : saisie libre préremplie', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-model', 'vieux-modele');
    render(<AiSettings />);
    expect(screen.getByText('Modèle choisi : vieux-modele')).toBeVisible();
    await user.click(screen.getByText('Réglages avancés'));
    expect(screen.getByLabelText('Modèle IA')).toHaveValue('personnalise');
    expect(screen.getByLabelText('Modèle personnalisé')).toHaveValue('vieux-modele');
    await user.clear(screen.getByLabelText('Modèle personnalisé'));
    await user.type(screen.getByLabelText('Modèle personnalisé'), 'autre-modele');
    expect(localStorage.getItem('worklogs-ai-model')).toBe('autre-modele');
  });

  test('« Tester la connexion » envoie le diagnostic et affiche la réussite', async () => {
    const user = userEvent.setup();
    const fetch = vi.fn(async () => okResponse('OK'));
    vi.stubGlobal('fetch', fetch);
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    render(<AiSettings />);
    await user.click(screen.getByRole('button', { name: 'Tester la connexion' }));
    expect(await screen.findByText(/Connexion vérifiée/)).toBeVisible();
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.model).toBe('gemini-3-flash-preview');
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
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    render(<AiSettings />);
    await user.click(screen.getByRole('button', { name: 'Tester la connexion' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/inconnu/);
  });

  test('« Tester la connexion » sans clé renvoie aux Paramètres sans appel réseau', async () => {
    const user = userEvent.setup();
    const fetch = vi.fn(async () => okResponse('OK'));
    vi.stubGlobal('fetch', fetch);
    render(<AiSettings />);
    await user.click(screen.getByRole('button', { name: 'Tester la connexion' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Colle ta clé IA/);
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each(['Clé IA', 'Endpoint IA', 'Modèle IA'])('modifier %s invalide le diagnostic réussi', async (field) => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(async () => okResponse('OK')));
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    render(<AiSettings />);
    await user.click(screen.getByRole('button', { name: 'Tester la connexion' }));
    await screen.findByText(/Connexion vérifiée/);
    await user.type(screen.getByLabelText('Mon contexte de travail'), 'Maintenance');
    expect(screen.getByRole('status')).toHaveTextContent(/Connexion vérifiée/);
    if (field !== 'Clé IA') await user.click(screen.getByText('Réglages avancés'));
    if (field === 'Modèle IA') await user.selectOptions(screen.getByLabelText(field), 'gemini-3.6-flash');
    else await user.type(screen.getByLabelText(field), 'x');
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

  test('restaurer les réglages avancés conserve clé et contexte et demande un nouveau diagnostic', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(async () => okResponse('OK')));
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    localStorage.setItem('worklogs-ai-endpoint', 'https://ia.example/v1');
    localStorage.setItem('worklogs-ai-model', 'modele-perso');
    localStorage.setItem('worklogs-ai-profile', 'Maintenance');
    render(<AiSettings />);
    await user.click(screen.getByRole('button', { name: 'Tester la connexion' }));
    await screen.findByText(/Connexion vérifiée/);
    await user.click(screen.getByText('Réglages avancés'));
    await user.click(screen.getByRole('button', { name: 'Restaurer les réglages Gemini' }));
    expect(screen.getByLabelText('Modèle IA')).toHaveValue('gemini-3-flash-preview');
    expect(screen.getByLabelText('Endpoint IA')).toHaveValue('https://generativelanguage.googleapis.com/v1beta/openai');
    expect(screen.getByLabelText('Clé IA')).toHaveValue('cle-test');
    expect(screen.getByLabelText('Mon contexte de travail')).toHaveValue('Maintenance');
    expect(screen.getByLabelText('Mon contexte de travail')).toHaveAttribute('maxlength', '2000');
    expect(screen.getByRole('status')).toHaveTextContent('Connexion non testée.');
    expect(screen.queryByLabelText('Modèle personnalisé')).not.toBeInTheDocument();
    expect(localStorage.getItem('worklogs-ai-model')).toBe('gemini-3-flash-preview');
  });
});
