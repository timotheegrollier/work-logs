import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { seedData } from './test/server';
import { api as clientApi } from './lib';
import { DEFAULT_AI_MODEL } from './ai-suggest';
import { useAppHarness, api, reopenApi, journal, board, filters, row, seedGoogleLink, aiBodies, mockAiSuggest, openDisplaySettings } from './test/app-harness';

useAppHarness();

describe('contrôles de largeur des colonnes', () => {
  test('ne sont plus dans l’en-tête : ils vivent dans Paramètres › Affichage', async () => {
    render(<App />);
    const header = await screen.findByRole('banner');
    expect(within(header).queryByLabelText('Largeur de la colonne de gauche (px)')).not.toBeInTheDocument();
    const display = await openDisplaySettings();
    expect(display.getByLabelText('Largeur de la colonne de gauche (px)')).toBeInTheDocument();
    expect(display.getByRole('button', { name: 'Largeurs par défaut' })).toBeInTheDocument();
  });

  test('les contrôles affichent les valeurs lues depuis localStorage', async () => {
    seedData(api.db, { entries: [{ id: 'en_1', title: 'Entrée' }, { id: 'en_2', title: 'Deuxième' }] });
    render(<App />);

    await screen.findByRole('region', { name: 'Journal' });
    await openDisplaySettings();
    expect(screen.getByLabelText('Largeur de la colonne de gauche (px)')).toHaveValue(290);
    expect(screen.getByLabelText('Largeur de la colonne de droite (px)')).toHaveValue(320);
  });

  test('changer la largeur gauche met à jour la variable CSS et localStorage', async () => {
    seedData(api.db, { entries: [{ id: 'en_1', title: 'Entrée' }] });
    render(<App />);
    await screen.findByRole('region', { name: 'Journal' });
    await openDisplaySettings();

    const leftInput = screen.getByLabelText('Largeur de la colonne de gauche (px)');
    fireEvent.change(leftInput, { target: { value: '400' } });
    expect(globalThis.localStorage.getItem('worklogs-col-left')).toBe('400');
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--col-left')).toBe('400px')
    );
  });

  test('changer la largeur droite met à jour la variable CSS et localStorage', async () => {
    seedData(api.db, { entries: [{ id: 'en_1', title: 'Entrée' }] });
    render(<App />);
    await screen.findByRole('region', { name: 'Journal' });
    await openDisplaySettings();

    const rightInput = screen.getByLabelText('Largeur de la colonne de droite (px)');
    fireEvent.change(rightInput, { target: { value: '480' } });
    expect(globalThis.localStorage.getItem('worklogs-col-right')).toBe('480');
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--col-right')).toBe('480px')
    );
  });

  test('les valeurs hors plage sont ramenées aux bornes', async () => {
    seedData(api.db, { entries: [{ id: 'en_1', title: 'Entrée' }] });
    render(<App />);
    await screen.findByRole('region', { name: 'Journal' });
    await openDisplaySettings();

    const leftInput = screen.getByLabelText('Largeur de la colonne de gauche (px)');
    const rightInput = screen.getByLabelText('Largeur de la colonne de droite (px)');

    fireEvent.change(leftInput, { target: { value: '80' } });
    expect(leftInput).toHaveValue(120);
    expect(globalThis.localStorage.getItem('worklogs-col-left')).toBe('120');

    fireEvent.change(rightInput, { target: { value: '900' } });
    expect(rightInput).toHaveValue(600);
    expect(globalThis.localStorage.getItem('worklogs-col-right')).toBe('600');
  });

  test('le bouton Par défaut restaure les largeurs d’origine', async () => {
    seedData(api.db, { entries: [{ id: 'en_1', title: 'Entrée' }] });
    globalThis.localStorage.setItem('worklogs-col-left', '360');
    globalThis.localStorage.setItem('worklogs-col-right', '420');
    render(<App />);
    await screen.findByRole('region', { name: 'Journal' });
    await openDisplaySettings();

    expect(screen.getByLabelText('Largeur de la colonne de gauche (px)')).toHaveValue(360);
    expect(screen.getByLabelText('Largeur de la colonne de droite (px)')).toHaveValue(420);

    fireEvent.click(screen.getByRole('button', { name: /Largeurs par défaut/ }));
    expect(screen.getByLabelText('Largeur de la colonne de gauche (px)')).toHaveValue(290);
    expect(screen.getByLabelText('Largeur de la colonne de droite (px)')).toHaveValue(320);
    expect(globalThis.localStorage.getItem('worklogs-col-left')).toBe('290');
    expect(globalThis.localStorage.getItem('worklogs-col-right')).toBe('320');
  });
});

describe('écran unique', () => {
  test('affiche les trois zones côte à côte', async () => {
    seedData(api.db, { entries: [{ id: 'en_1', title: 'Première entrée' }] });
    render(<App />);

    expect(await screen.findByRole('region', { name: 'Journal' })).toBeInTheDocument();
    expect(board()).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Entrée' })).toBeInTheDocument();
  });

  test('affiche le logo et la version dans l’en-tête', async () => {
    seedData(api.db, { entries: [{ id: 'en_1', title: 'Première entrée' }] });
    render(<App />);

    expect(await screen.findByRole('img', { name: 'Logo WorkLogs' })).toBeInTheDocument();
    expect(screen.getByTitle('Vérifier les mises à jour')).toHaveTextContent(/\d+\.\d+\.\d+/);
  });

  test('un clic sur la version déclenche une vérification immédiate', async () => {
    const user = userEvent.setup();
    const checkUpdatesNow = vi.fn().mockResolvedValue('0.6.4');
    (window as unknown as { worklogsDesktop: unknown }).worklogsDesktop = {
      onBeforeClose: () => () => {},
      checkUpdatesNow,
    };
    seedData(api.db, { entries: [{ id: 'en_1', title: 'Première entrée' }] });
    render(<App />);

    await user.click(await screen.findByTitle('Vérifier les mises à jour'));
    expect(checkUpdatesNow).toHaveBeenCalledTimes(1);
    delete (window as unknown as { worklogsDesktop?: unknown }).worklogsDesktop;
  });

  test('ouvre l’entrée la plus récente au démarrage', async () => {
    seedData(api.db, {
      entries: [
        { id: 'en_old', title: 'Ancienne', date: '2026-01-01' },
        { id: 'en_new', title: 'Récente', date: '2026-06-01' },
      ],
    });
    render(<App />);

    const title = await screen.findByLabelText('Titre de l’entrée');
    expect(title).toHaveValue('Récente');
  });

  test('invite à créer quand le journal est vide', async () => {
    render(<App />);
    expect(await screen.findByText(/Rien encore/)).toBeInTheDocument();
    expect(screen.getByText(/crée-en une nouvelle/)).toBeInTheDocument();
  });

  test('prévient quand l’API ne répond pas', async () => {
    await api.close();
    render(<App />);
    expect(await screen.findByText(/API injoignable/)).toBeInTheDocument();
    await reopenApi(); // pour que le nettoyage de fin de test reste valide
  });
});

describe('en-tête', () => {
  test('expose recherche, thème, panneaux et export avec des noms stables', async () => {
    seedData(api.db, { entries: [{ id: 'en_1', title: 'Entrée' }] });
    render(<App />);

    const header = await screen.findByRole('banner');
    expect(within(header).getByRole('searchbox', { name: 'Rechercher' })).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Changer de thème' })).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Journal' })).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Écriture' })).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Tâches' })).toBeInTheDocument();
    // Noms en aria-label : ils survivent au passage en icônes seules sur mobile.
    expect(within(header).getByRole('button', { name: 'Exporter' })).toHaveAttribute('aria-label', 'Exporter');
    expect(within(header).getByRole('button', { name: 'Compte et paramètres' })).toHaveAttribute('aria-haspopup', 'menu');
  });

  test('masque Exporter une fois connecté à Google : la synchro automatique suffit', async () => {
    const connected = { available: true, configured: true, connected: true, pending: false, error: '', selectedIds: [],
      account: { email: 'timo@example.com', name: 'Timo' } };
    vi.spyOn(clientApi, 'googleStatus').mockResolvedValue(connected);
    vi.spyOn(clientApi, 'googleSync').mockResolvedValue({ state: 'idle', error: '', lastSyncedAt: null, revision: 0 });
    render(<App />);
    const header = await screen.findByRole('banner');
    await within(header).findByRole('button', { name: /Compte Google : Timo/ });
    expect(within(header).queryByRole('button', { name: 'Exporter' })).not.toBeInTheDocument();
  });

  test('garde Exporter si la session Google a expiré : la synchro est en pause', async () => {
    vi.spyOn(clientApi, 'googleStatus').mockResolvedValue({ available: true, configured: true, connected: true, pending: false,
      error: '', selectedIds: [], expired: true, account: { email: 'timo@example.com', name: 'Timo' } });
    vi.spyOn(clientApi, 'googleSync').mockResolvedValue({ state: 'off', error: '', lastSyncedAt: null, revision: 0 });
    render(<App />);
    const header = await screen.findByRole('banner');
    await within(header).findByRole('button', { name: /Compte Google : Timo/ });
    expect(within(header).getByRole('button', { name: 'Exporter' })).toBeInTheDocument();
  });
});

describe('gestion Google Drive', () => {
  test('vit dans les paramètres, pas dans le journal, et s’ouvre dans un dialogue', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('region', { name: 'Journal' });

    expect(within(journal()).queryByRole('button', { name: 'Gérer Google Drive' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Gestion Google Drive' })).not.toBeInTheDocument();
    expect(screen.queryByText('La connexion Drive est disponible dans l’application desktop Linux.')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Compte et paramètres' }));
    await user.click(screen.getByRole('menuitem', { name: 'Paramètres' }));
    expect(await screen.findByRole('dialog', { name: 'Paramètres' })).toBeVisible();
    // La pastille de version de l'en-tête est masquée sur mobile : le dialogue
    // garde le numéro accessible partout.
    expect(
      within(screen.getByRole('dialog', { name: 'Paramètres' })).getByText(/WorkLogs \d+\.\d+\.\d+/)
    ).toBeInTheDocument();
    await user.click(within(screen.getByRole('dialog', { name: 'Paramètres' })).getByRole('button', { name: 'Gérer Google Drive' }));
    expect(await screen.findByRole('dialog', { name: 'Gestion Google Drive' })).toBeVisible();
    await user.click(within(screen.getByRole('dialog', { name: 'Gestion Google Drive' })).getByRole('button', { name: 'Fermer' }));
    expect(screen.queryByRole('dialog', { name: 'Gestion Google Drive' })).not.toBeInTheDocument();
    await user.click(within(screen.getByRole('dialog', { name: 'Paramètres' })).getByRole('button', { name: 'Fermer' }));
    expect(screen.queryByRole('dialog', { name: 'Paramètres' })).not.toBeInTheDocument();
  });

  test('le pied des paramètres mène à la politique de confidentialité publique', async () => {
    render(<App />);
    await screen.findByRole('region', { name: 'Journal' });

    fireEvent.click(screen.getByRole('button', { name: 'Compte et paramètres' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Paramètres' }));
    const dialog = await screen.findByRole('dialog', { name: 'Paramètres' });
    const link = within(dialog).getByRole('link', { name: 'Politique de confidentialité' });
    expect(link).toHaveAttribute('href', 'https://timotheegrollier.github.io/work-logs/confidentialite.html');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });
});

describe('réglages IA', () => {
  test('les anciens réglages Gemini passent au Worker WorkLogs sans demander de clé et gardent le contexte', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-endpoint', 'https://generativelanguage.googleapis.com/v1beta/openai');
    localStorage.setItem('worklogs-ai-model', 'gemini-3-flash-preview');
    localStorage.setItem('worklogs-ai-key', 'AIza-cle-google');
    localStorage.setItem('worklogs-ai-profile', 'Dev solo en pisciculture');
    mockAiSuggest('OK');
    render(<App />);
    await screen.findByRole('region', { name: 'Journal' });

    await user.click(screen.getByRole('button', { name: 'Compte et paramètres' }));
    await user.click(screen.getByRole('menuitem', { name: 'Paramètres' }));
    const dialog = await screen.findByRole('dialog', { name: 'Paramètres' });
    expect(within(dialog).getByLabelText('Endpoint IA')).not.toBeVisible();
    expect(within(dialog).getByText('IA gratuite sans clé.')).toBeVisible();
    expect(within(dialog).queryByLabelText('Clé IA')).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText('Mon contexte de travail')).toHaveValue('Dev solo en pisciculture');
    const testConnection = within(dialog).getByRole('button', { name: 'Tester la connexion' });
    await user.click(testConnection);
    expect(await within(dialog).findByText(/Connexion vérifiée/)).toBeVisible();
    expect(aiBodies).toMatchObject([{ model: DEFAULT_AI_MODEL }]);
  });

  test('ouvre la fiche du projet actif et teste la connexion sans ouvrir les réglages avancés', async () => {
    const user = userEvent.setup();
    seedData(api.db, {
      projects: [{ id: 'pr_atelier', name: 'Atelier' }, { id: 'pr_bassin', name: 'Bassin' }],
      entries: [{ id: 'en_note', title: 'Maintenance', project_id: 'pr_atelier' }],
    });
    localStorage.setItem('worklogs-project', 'pr_atelier');
    localStorage.setItem('worklogs-ai-project-contexts', JSON.stringify({ pr_atelier: 'Postes Linux', pr_bassin: 'Pompes immergées' }));
    mockAiSuggest('OK');
    render(<App />);
    await screen.findByLabelText('Titre de l’entrée');
    await user.click(screen.getByRole('button', { name: 'Compte et paramètres' }));
    await user.click(screen.getByRole('menuitem', { name: 'Paramètres' }));
    const settings = within(await screen.findByRole('dialog', { name: 'Paramètres' }));
    expect(settings.getByLabelText('Projet du contexte IA')).toHaveValue('pr_atelier');
    expect(settings.getByLabelText('Contexte IA du projet')).toHaveValue('Postes Linux');
    expect(settings.getByLabelText('Endpoint IA')).not.toBeVisible();
    expect(settings.queryByLabelText('Clé IA')).not.toBeInTheDocument();
    await user.click(settings.getByRole('button', { name: 'Tester la connexion' }));
    await settings.findByText(/Connexion vérifiée/);
    expect(aiBodies).toHaveLength(1);
    expect(settings.getByLabelText('Endpoint IA')).not.toBeVisible();
    await user.selectOptions(settings.getByLabelText('Projet du contexte IA'), 'pr_bassin');
    expect(settings.getByLabelText('Contexte IA du projet')).toHaveValue('Pompes immergées');
  });
});

describe('cartes empilées (tablette) et vues du téléphone', () => {
  /** Simule la largeur d'écran et relève les cartes amenées à l'écran. */
  function stackedScreen(stacked: boolean, phone = false) {
    const shown: string[] = [];
    vi.stubGlobal('matchMedia', (query: string) => ({
      // `PHONE` (App.tsx) est la seule requête qui parle de hauteur.
      matches: query.includes('max-height: 500px') ? phone : query.includes('max-width: 900px') ? stacked : false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    Element.prototype.scrollIntoView = function (this: Element) {
      if (this.id) shown.push(this.id);
    };
    return shown;
  }
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });

  test('ouvrir une entrée du journal amène à la carte Écriture', async () => {
    const user = userEvent.setup();
    seedData(api.db, { entries: [{ id: 'en_1', title: 'Récente' }, { id: 'en_2', title: 'Plus ancienne', date: '2026-01-05' }] });
    const shown = stackedScreen(true);
    render(<App />);

    await user.click(await within(journal()).findByText('Plus ancienne'));

    await waitFor(() => expect(shown).toContain('workspace-editor'));
    expect(await screen.findByDisplayValue('Plus ancienne')).toBeInTheDocument();
  });

  test('« Nouvelle entrée » amène aussi à l’écriture', async () => {
    const user = userEvent.setup();
    const shown = stackedScreen(true);
    render(<App />);

    await user.click(await within(journal()).findByRole('button', { name: /Nouvelle entrée/ }));

    await waitFor(() => expect(shown).toContain('workspace-editor'));
  });

  test('colonnes côte à côte : la page ne bouge pas', async () => {
    const user = userEvent.setup();
    seedData(api.db, { entries: [{ id: 'en_1', title: 'Récente' }, { id: 'en_2', title: 'Plus ancienne', date: '2026-01-05' }] });
    const shown = stackedScreen(false);
    render(<App />);

    await user.click(await within(journal()).findByText('Plus ancienne'));

    expect(await screen.findByDisplayValue('Plus ancienne')).toBeInTheDocument();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(shown).not.toContain('workspace-editor');
  });

  // jsdom n'applique pas la feuille de style : on lit les classes qui décident des panneaux.
  const columns = () => document.querySelector('.columns') as HTMLElement;

  test('téléphone : « Vue d’ensemble » passe à la vue Écriture, un nœud ramène aux tâches', async () => {
    const user = userEvent.setup();
    seedData(api.db, { projects: [{ id: 'pr_a', name: 'Alpha' }, { id: 'pr_b', name: 'Bravo' }], tasks: [{ id: 'tk_1', title: 'Relancer', project_id: 'pr_a' }] });
    stackedScreen(true, true);
    render(<App />);
    const nav = (name: string) => within(screen.getByRole('group', { name: 'Panneaux latéraux' })).getByRole('button', { name });
    await user.click(await screen.findByRole('button', { name: 'Vue d’ensemble des tâches' }));

    expect(await screen.findByRole('region', { name: 'Vue d’ensemble des projets' })).toBeInTheDocument();
    expect(nav('Écriture')).toHaveAttribute('aria-pressed', 'true');
    expect(columns()).not.toHaveClass('hide-center');

    await user.click(screen.getByRole('button', { name: 'Relancer — à faire' }));
    expect(nav('Tâches')).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(document.activeElement).toBe(within(board()).getByRole('textbox', { name: 'Titre de la tâche' })));
    expect(within(board()).getByRole('textbox', { name: 'Titre de la tâche' })).toHaveValue('Relancer');
    expect(screen.queryByRole('region', { name: 'Vue d’ensemble des projets' })).not.toBeInTheDocument();
  });
  const nav = (name: string) => within(screen.getByRole('group', { name: 'Panneaux latéraux' })).getByRole('button', { name });

  test('téléphone : une vue à la fois, ouvrir une entrée passe à l’écriture, le retour ramène au journal', async () => {
    const user = userEvent.setup();
    seedData(api.db, { entries: [{ id: 'en_1', title: 'Récente' }, { id: 'en_2', title: 'Plus ancienne', date: '2026-01-05' }] });
    stackedScreen(true, true);
    render(<App />);

    await within(journal()).findByText('Plus ancienne');
    expect(columns()).not.toHaveClass('hide-left');
    expect(columns()).toHaveClass('hide-center', 'hide-right');
    expect(nav('Journal')).toHaveAttribute('aria-pressed', 'true');

    await user.click(within(journal()).getByText('Plus ancienne'));
    expect(await screen.findByDisplayValue('Plus ancienne')).toBeInTheDocument();
    expect(columns()).toHaveClass('hide-left', 'hide-right');
    expect(columns()).not.toHaveClass('hide-center');
    expect(nav('Écriture')).toHaveAttribute('aria-pressed', 'true');
    expect(nav('Journal')).toHaveAttribute('aria-pressed', 'false');

    // Le geste retour d'Android : une marche d'historique, rien d'autre.
    act(() => window.history.back());
    await waitFor(() => expect(columns()).not.toHaveClass('hide-left'));
    expect(columns()).toHaveClass('hide-center');

    // La barre choisit sans rien replier pour le desktop.
    await user.click(nav('Procédures'));
    expect(columns()).toHaveClass('show-procedures', 'hide-left', 'hide-center', 'hide-right');
    await user.click(nav('Tâches'));
    expect(columns()).not.toHaveClass('hide-right');
    expect(columns()).not.toHaveClass('show-procedures');
    expect(localStorage.getItem('worklogs-show-left')).not.toBe('0');
    expect(localStorage.getItem('worklogs-show-right')).not.toBe('0');
  });

  test('téléphone : un bouton nomme le projet courant, la liste complète choisit d’un toucher', async () => {
    const user = userEvent.setup();
    seedData(api.db, { projects: [{ id: 'pr_a', name: 'Alpha' }, { id: 'pr_b', name: 'Beta' }] });
    stackedScreen(true, true);
    render(<App />);

    // Plus de rangée de pastilles à faire défiler : un bouton, le projet en toutes lettres.
    const switcher = await screen.findByRole('button', { name: 'Projet : Tous les projets' });
    expect(screen.queryByRole('group', { name: 'Filtrer par projet' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Gérer les projets' })).not.toBeInTheDocument();

    await user.click(switcher);
    const sheet = await screen.findByRole('dialog', { name: /Projets/ });
    const choices = within(sheet).getByRole('list', { name: 'Choisir un projet' });
    expect(within(choices).getByRole('button', { name: 'Tous les projets' })).toHaveAttribute('aria-pressed', 'true');
    // Toucher un nom choisit, il ne lance pas un renommage.
    expect(within(sheet).queryByLabelText('Nom de Beta')).not.toBeInTheDocument();
    await user.click(within(choices).getByRole('button', { name: 'Beta' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Projets/ })).not.toBeInTheDocument());
    expect(await screen.findByRole('button', { name: 'Projet : Beta' })).toHaveFocus();
    expect(localStorage.getItem('worklogs-project')).toBe('pr_b');

    // Gérer est un autre geste, au pied de la liste : la gestion connue, dans la même feuille.
    await user.click(screen.getByRole('button', { name: 'Projet : Beta' }));
    await user.click(within(await screen.findByRole('dialog', { name: /Projets/ })).getByRole('button', { name: 'Gérer les projets' }));
    expect(screen.getByLabelText('Nom du nouveau projet')).toBeInTheDocument();
    expect(screen.getByLabelText('Nom de Alpha')).toBeInTheDocument();
  });

  test('téléphone : les réglages de l’entrée se replient derrière leur résumé', async () => {
    const user = userEvent.setup();
    seedData(api.db, { projects: [{ id: 'p', name: 'Chantier' }], entries: [{ id: 'en_1', title: 'Compte rendu', project_id: 'p' }] });
    stackedScreen(true, true);
    render(<App />);

    await user.click(await within(journal()).findByText('Compte rendu'));
    const toggle = await screen.findByRole('button', { name: 'Réglages de l’entrée' });
    expect(toggle).toHaveTextContent("aujourd'hui · Chantier");
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.querySelector('.editor-meta')).toHaveClass('is-folded');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(document.querySelector('.editor-meta')).not.toHaveClass('is-folded');
  });

  test('hors téléphone, pas de résumé : les réglages restent dépliés', async () => {
    seedData(api.db, { entries: [{ id: 'en_1', title: 'Compte rendu' }] });
    stackedScreen(true);
    render(<App />);

    expect(await screen.findByDisplayValue('Compte rendu')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Réglages de l’entrée' })).not.toBeInTheDocument();
    expect(document.querySelector('.editor-meta')).not.toHaveClass('is-folded');
  });
});

describe('confort', () => {
  test('quitter la page envoie ce qui n’est pas encore enregistré', async () => {
    const user = userEvent.setup();
    seedData(api.db, { entries: [{ id: 'en_1', title: 'Brouillon' }] });
    render(<App />);

    const titre = await screen.findByLabelText('Titre de l’entrée');
    await user.clear(titre);
    await user.type(titre, 'Sauvé de justesse');
    // Sans attendre la cadence d'enregistrement : la page s'en va maintenant.
    expect(row(api.db, 'SELECT * FROM entries WHERE id=?', 'en_1').title).toBe('Brouillon');

    window.dispatchEvent(new Event('pagehide'));

    // L'écriture doit partir immédiatement, sinon ces frappes seraient perdues
    // à chaque rechargement ou fermeture.
    await waitFor(() =>
      expect(row(api.db, 'SELECT * FROM entries WHERE id=?', 'en_1').title).toBe('Sauvé de justesse')
    );
  });


  test('bascule et retient le thème clair', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByLabelText('Changer de thème'));

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('worklogs-theme')).toBe('light');
  });

  test('propose l’export JSON de la base', async () => {
    const user = userEvent.setup();
    render(<App />);
    const button = await screen.findByRole('button', { name: 'Exporter' });
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
    await user.click(button);
    await waitFor(() => expect(created).toHaveBeenCalled());
    const blob = created.mock.calls[0][0] as Blob;
    expect(JSON.parse(await blob.text()).entries).toHaveLength(0);
  });

  test('résume la semaine dans l’en-tête', async () => {
    seedData(api.db, {
      entries: [{ id: 'en_1', title: 'Aujourd’hui' }],
      tasks: [{ id: 'tk_1', title: 'À faire' }],
    });
    render(<App />);

    const stats = await screen.findByText(/entrée\(s\) cette semaine/);
    expect(stats).toHaveTextContent('1 entrée(s) cette semaine');
    expect(stats).toHaveTextContent('1 à faire');
  });
});

describe('barre de progression des mises à jour', () => {
  test('affiche téléchargement puis disparaît', async () => {
    let listener: ((payload: { phase: string; percent?: number }) => void) | null = null;
    (window as unknown as { worklogsDesktop: unknown }).worklogsDesktop = {
      onBeforeClose: () => () => {},
      onUpdateProgress: (callback: (payload: { phase: string; percent?: number }) => void) => {
        listener = callback;
        return () => { listener = null; };
      },
    };
    seedData(api.db, { entries: [{ id: 'en_1', title: 'Première entrée' }] });
    render(<App />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    await act(async () => { listener?.({ phase: 'download', percent: 42 }); });
    const bar = await screen.findByRole('status');
    expect(bar).toHaveTextContent(/42/);
    expect(bar.firstElementChild).toHaveStyle({ width: '42%' });

    await act(async () => { listener?.({ phase: 'install' }); });
    expect(await screen.findByText('Installation…')).toBeInTheDocument();

    await act(async () => { listener?.({ phase: 'idle' }); });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    delete (window as unknown as { worklogsDesktop?: unknown }).worklogsDesktop;
  });
});

describe('espace Google Docs', () => {
  function seedTabs() {
    seedData(api.db, { entries: [
      { id: 'en_intro', title: 'Dossier — Introduction', content_md: 'Introduction' },
      { id: 'en_budget', title: 'Dossier — Budget', content_md: 'Budget' },
    ] });
    for (const [order, id] of ['en_intro', 'en_budget'].entries()) {
      const rich = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: order ? 'Budget' : 'Introduction' }] }] });
      api.db.prepare('UPDATE entries SET content_json=? WHERE id=?').run(rich, id);
      api.db.prepare(`INSERT INTO google_documents (entry_id,document_id,tab_id,revision_id,synced_content_json,document_title,tab_title,tab_order,tab_depth)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(id, 'dossier', `tab-${order}`, 'r1', rich, 'Dossier', order ? 'Budget' : 'Introduction', order, order);
    }
    localStorage.setItem('worklogs-entry', 'en_intro');
  }

  test('navigation verticale, clavier, brouillons distincts et dernier onglet conservé', async () => {
    seedTabs();
    render(<App />);
    const intro = await screen.findByRole('tab', { name: /Introduction/ });
    const budget = screen.getByRole('tab', { name: /Budget/ });
    expect(screen.getByRole('tablist')).toHaveAttribute('aria-orientation', 'vertical');
    expect(budget).toHaveAttribute('data-depth', '1');
    fireEvent.keyDown(intro, { key: 'ArrowDown' });
    expect(budget).toHaveFocus();
    fireEvent.click(budget);
    await waitFor(() => expect(screen.getByRole('tab', { name: /Budget/ })).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByRole('textbox', { name: 'Contenu du document' })).toHaveTextContent('Budget');
    expect(localStorage.getItem('worklogs-entry')).toBe('en_budget');
    expect(screen.getByRole('link', { name: /Ouvrir dans Google Docs/ })).toHaveAttribute('href', 'https://docs.google.com/document/d/dossier/edit?tab=tab-1');
    expect(within(journal()).getAllByRole('button', { name: /Dossier/ })).toHaveLength(1);
  });

  test('filtrer le journal conserve les autres onglets du document et permet leur sélection', async () => {
    seedTabs();
    render(<App />);
    await screen.findByRole('tab', { name: /Introduction/ });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Rechercher' }), { target: { value: 'Introduction' } });
    await waitFor(() => expect(within(journal()).getAllByRole('button', { name: /Dossier/ })).toHaveLength(1));
    fireEvent.click(screen.getByRole('tab', { name: /Budget/ }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Contenu du document' })).toHaveTextContent('Budget'));
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  test('les tâches se replient pour le document et se rouvrent sur demande', async () => {
    seedTabs();
    render(<App />);
    const show = await screen.findByRole('button', { name: 'Afficher les tâches' });
    expect(show).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(show);
    expect(screen.getByRole('button', { name: 'Masquer les tâches' })).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('panneau Procédures', () => {
  async function openPanel(user: { click: (element: Element) => Promise<void> }) {
    await user.click(screen.getByRole('button', { name: 'Procédures' }));
    return screen.findByRole('region', { name: 'Procédures du projet' });
  }
  test('rassemble procédures et pièces jointes du projet filtré, ouvre au clic', async () => {
    const user = userEvent.setup();
    seedData(api.db, {
      projects: [{ id: 'pr_villa', name: 'Villa' }, { id: 'pr_autre', name: 'Autre' }],
      entries: [
        { id: 'en_proc', title: 'Dallage', project_id: 'pr_villa', kind: 'procedure' },
        { id: 'en_note', title: 'Pense-bête', project_id: 'pr_villa' },
        { id: 'en_ailleurs', title: 'Élec', project_id: 'pr_autre', kind: 'procedure' },
      ],
    });
    await api.upload('devis.pdf', 'contenu', { entry_id: 'en_proc' });
    render(<App />);
    await user.click(await within(filters()).findByRole('button', { name: /Villa/ }));
    const panel = await openPanel(user);
    expect(await within(panel).findByText('Dallage')).toBeVisible();
    expect(within(panel).queryByText('Élec')).not.toBeInTheDocument();
    expect(within(panel).queryByText('Pense-bête')).not.toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'Télécharger devis.pdf' })).toHaveAttribute('href', expect.stringContaining('/api/files/'));
    await user.click(within(panel).getByText('Dallage'));
    await waitFor(() => expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Dallage'));
    // Le journal ne liste que les notes : les procédures ont leur sidebar.
    const journal = screen.getByRole('region', { name: 'Journal' });
    expect(within(journal).getByText('Pense-bête')).toBeInTheDocument();
    expect(within(journal).queryByText('Dallage')).not.toBeInTheDocument();
  });

  test('au premier chargement, ouvre la dernière entrée du journal, jamais une procédure', async () => {
    seedData(api.db, {
      entries: [
        { id: 'en_note', title: 'Compte rendu', date: '2026-01-01' },
        { id: 'en_proc', title: 'Dallage', kind: 'procedure', date: '2026-02-01' },
      ],
    });
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Compte rendu'));
  });

  test('crée une procédure riche dans le projet filtré', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-show-center', '0');
    seedData(api.db, { projects: [{ id: 'pr_villa', name: 'Villa' }] });
    render(<App />);
    await user.click(await within(filters()).findByRole('button', { name: /Villa/ }));
    const panel = await openPanel(user);
    expect(await within(panel).findByText('Aucune procédure pour Villa.')).toBeVisible();
    await user.click(within(panel).getByRole('button', { name: 'Nouvelle procédure' }));
    expect(await screen.findByLabelText('Titre de l’entrée')).toHaveValue('Sans titre');
    expect(document.querySelector('.columns')).not.toHaveClass('hide-center');
    // Une procédure neuve s'ouvre en écriture, comme une entrée neuve.
    expect(screen.getByRole('button', { name: 'Écrire' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('toolbar', { name: 'Mise en forme du document' })).toBeInTheDocument();
    await waitFor(() => expect(row(api.db, "SELECT kind, project_id FROM entries WHERE title='Sans titre'")).toEqual(
      expect.objectContaining({ kind: 'procedure', project_id: 'pr_villa' })));
  });

  test('la sidebar se replie et persiste, comme les autres panneaux', async () => {
    render(<App />);
    await screen.findByRole('region', { name: 'Journal' });
    // Repliée par défaut : seul le câblage se teste ici (le DOM reste monté,
    // la visibilité réelle est couverte en e2e).
    expect(document.querySelector('.columns')).not.toHaveClass('show-procedures');
    const toggle = screen.getByRole('button', { name: 'Procédures' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    await screen.findByRole('region', { name: 'Procédures du projet' });
    expect(document.querySelector('.columns')).toHaveClass('show-procedures');
    expect(globalThis.localStorage.getItem('worklogs-show-procedures')).toBe('1');
    fireEvent.click(toggle);
    expect(document.querySelector('.columns')).not.toHaveClass('show-procedures');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(globalThis.localStorage.getItem('worklogs-show-procedures')).toBe('0');
  });

  test('Modifier réaffiche l’écriture et permet de modifier le titre et le contenu, même déjà sélectionnés', async () => {
    const user = userEvent.setup();
    seedData(api.db, { entries: [
      { id: 'en_note', title: 'Journal' },
      { id: 'en_proc', title: 'Dallage', kind: 'procedure', content_md: 'Avant' },
    ] });
    localStorage.setItem('worklogs-show-center', '0');
    render(<App />);
    const panel = await openPanel(user);
    await user.click(await within(panel).findByRole('button', { name: 'Modifier la procédure Dallage' }));
    expect(document.querySelector('.columns')).not.toHaveClass('hide-center');
    await waitFor(() => expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Dallage'));
    await user.clear(screen.getByLabelText('Titre de l’entrée'));
    await user.type(screen.getByLabelText('Titre de l’entrée'), 'Dallage corrigé');
    fireEvent.change(screen.getByLabelText('Contenu en Markdown'), { target: { value: 'Étapes corrigées' } });
    await waitFor(() => expect(row(api.db, 'SELECT title, content_md FROM entries WHERE id=?', 'en_proc')).toMatchObject({ title: 'Dallage corrigé', content_md: 'Étapes corrigées' }));
    await user.click(screen.getByRole('button', { name: 'Lire' }));
    await user.click(within(panel).getByRole('button', { name: 'Modifier la procédure Dallage corrigé' }));
    expect(screen.getByRole('button', { name: 'Écrire' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('une procédure riche s’ouvre en lecture ; Écrire et Modifier rendent la barre d’outils', async () => {
    const user = userEvent.setup();
    seedData(api.db, { entries: [
      { id: 'en_note', title: 'Journal' },
      { id: 'en_proc', title: 'Redémarrer', kind: 'procedure' },
      { id: 'en_doc', title: 'Document riche' },
    ] });
    const rich = JSON.stringify({ type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Lancer :' }] },
      { type: 'codeBlock', content: [{ type: 'text', text: 'sudo systemctl restart app' }] },
    ] });
    api.db.prepare('UPDATE entries SET content_json=? WHERE id IN (?, ?)').run(rich, 'en_proc', 'en_doc');
    render(<App />);
    const panel = await openPanel(user);
    await user.click(await within(panel).findByText('Redémarrer'));
    await waitFor(() => expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Redémarrer'));

    // Lire : le document tel quel, bloc de code compris, sans barre d'outils ni saisie.
    const content = screen.getByRole('textbox', { name: 'Contenu du document' });
    expect(screen.getByRole('button', { name: 'Lire' })).toHaveAttribute('aria-pressed', 'true');
    expect(content).toHaveAttribute('contenteditable', 'false');
    expect(content).toHaveAttribute('aria-readonly', 'true');
    expect(content.querySelector('pre code')).toHaveTextContent('sudo systemctl restart app');
    expect(screen.queryByRole('toolbar', { name: 'Mise en forme du document' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Écrire' }));
    expect(screen.getByRole('toolbar', { name: 'Mise en forme du document' })).toBeInTheDocument();
    expect(content).toHaveAttribute('contenteditable', 'true');
    expect(content).toHaveAttribute('aria-readonly', 'false');

    // Modifier, depuis la colonne, repasse en écriture la procédure ouverte en lecture.
    await user.click(screen.getByRole('button', { name: 'Lire' }));
    expect(content).toHaveAttribute('contenteditable', 'false');
    await user.click(within(panel).getByRole('button', { name: 'Modifier la procédure Redémarrer' }));
    expect(screen.getByRole('button', { name: 'Écrire' })).toHaveAttribute('aria-pressed', 'true');
    expect(content).toHaveAttribute('contenteditable', 'true');

    // Un document riche du journal garde son éditeur toujours ouvert, sans modes.
    await user.click(within(screen.getByRole('region', { name: 'Journal' })).getByText('Document riche'));
    await waitFor(() => expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Document riche'));
    expect(screen.queryByRole('button', { name: 'Lire' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Contenu du document' })).toHaveAttribute('contenteditable', 'true');
  });

  test('supprime une pièce jointe depuis la colonne Procédures, après confirmation', async () => {
    const user = userEvent.setup();
    seedData(api.db, { entries: [{ id: 'en_proc', title: 'Dallage', kind: 'procedure' }] });
    const kept = await api.upload('devis.pdf', '%PDF', { entry_id: 'en_proc' });
    const plan = await api.upload('plan.pdf', '%PDF', { entry_id: 'en_proc' });
    api.db.prepare('UPDATE attachments SET drive_file_id=? WHERE id=?').run('drive-plan', plan.body.id);
    render(<App />);
    const panel = await openPanel(user);
    const files = await within(panel).findByRole('list', { name: 'Pièces jointes de Dallage' });
    // Même pictogramme que dans l'arbre du partage ; l'emplacement reste dit par la pastille.
    expect(within(files).getByRole('button', { name: 'Consulter devis.pdf' }).querySelector('.file-icon.is-pdf')).toHaveTextContent('PDF');
    expect(within(files).getAllByText('local seul')).toHaveLength(1);
    expect(within(files).getByText('☁ Drive')).toBeInTheDocument();

    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await user.click(within(files).getByRole('button', { name: 'Supprimer plan.pdf' }));
    expect(row(api.db, 'SELECT COUNT(*) n FROM attachments')).toMatchObject({ n: 2 });

    await user.click(within(files).getByRole('button', { name: 'Supprimer plan.pdf' }));
    // La question annonce la corbeille Drive pour un fichier qui y est.
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining('corbeille'));
    await waitFor(() => expect(within(files).queryByText('plan.pdf')).not.toBeInTheDocument());
    expect(within(files).getByText('devis.pdf')).toBeInTheDocument();
    expect(row(api.db, 'SELECT id FROM attachments')).toMatchObject({ id: kept.body.id });
  });

  test('ouvre une procédure Google dans l’éditeur de l’app quand Écriture est masqué', async () => {
    const user = userEvent.setup();
    seedData(api.db, { entries: [{ id: 'en_proc', title: 'Consignes Google', kind: 'procedure' }] });
    seedGoogleLink(api.db, 'en_proc', 'doc-procedure');
    localStorage.setItem('worklogs-show-center', '0');
    render(<App />);
    const panel = await openPanel(user);
    await user.click(await within(panel).findByRole('button', { name: 'Modifier la procédure Consignes Google' }));
    expect(document.querySelector('.columns')).not.toHaveClass('hide-center');
    const content = await screen.findByRole('textbox', { name: 'Contenu du document' });
    expect(content).toHaveTextContent('Google');
    expect(content).toHaveAttribute('contenteditable', 'true');
  });

  test('consulte une pièce jointe dans l’app sans changer l’entrée ouverte', async () => {
    const user = userEvent.setup();
    seedData(api.db, { entries: [
      { id: 'en_note', title: 'Note ouverte' },
      { id: 'en_proc', title: 'Dallage', kind: 'procedure' },
    ] });
    const uploaded = await api.upload('consignes.txt', 'Contenu de la pièce jointe', { entry_id: 'en_proc' });
    render(<App />);
    const panel = await openPanel(user);
    await user.click(await within(panel).findByRole('button', { name: 'Consulter consignes.txt' }));
    const dialog = await screen.findByRole('dialog', { name: 'Aperçu de consignes.txt' });
    expect(await within(dialog).findByText('Contenu de la pièce jointe')).toBeVisible();
    expect(within(dialog).getByRole('link', { name: 'Télécharger' })).toHaveAttribute('href', `/api/files/${uploaded.body.stored}`);
    await user.click(within(dialog).getByRole('button', { name: 'Fermer' }));
    expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Note ouverte');
  });

  test('annule ou supprime une procédure non ouverte et ses fichiers depuis la sidebar', async () => {
    const user = userEvent.setup();
    seedData(api.db, { entries: [
      { id: 'en_note', title: 'Note ouverte' },
      { id: 'en_proc', title: 'Dallage', kind: 'procedure' },
    ] });
    const uploaded = await api.upload('plan.pdf', '%PDF', { entry_id: 'en_proc' });
    render(<App />);
    const panel = await openPanel(user);
    const remove = await within(panel).findByRole('button', { name: 'Supprimer la procédure Dallage' });
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await user.click(remove);
    expect(row(api.db, 'SELECT id FROM entries WHERE id=?', 'en_proc')).toBeDefined();
    await user.click(remove);
    await waitFor(() => expect(row(api.db, 'SELECT id FROM entries WHERE id=?', 'en_proc')).toBeUndefined());
    await waitFor(() => expect(within(panel).queryByText('Dallage')).not.toBeInTheDocument());
    expect((await fetch(`/api/files/${uploaded.body.stored}`)).status).toBe(404);
    expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Note ouverte');
  });

  test('supprimer la procédure ouverte termine sa sauvegarde et revient au journal', async () => {
    const user = userEvent.setup();
    seedData(api.db, { entries: [
      { id: 'en_note', title: 'Note ouverte' },
      { id: 'en_proc', title: 'Dallage', kind: 'procedure' },
    ] });
    render(<App />);
    const panel = await openPanel(user);
    await user.click(await within(panel).findByRole('button', { name: 'Modifier la procédure Dallage' }));
    await waitFor(() => expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Dallage'));
    fireEvent.change(await screen.findByLabelText('Contenu en Markdown'), { target: { value: 'Dernière frappe' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Supprimer la procédure Dallage' }));
    await waitFor(() => expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Note ouverte'));
    expect(row(api.db, 'SELECT id FROM entries WHERE id=?', 'en_proc')).toBeUndefined();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('une suppression refusée conserve la procédure et permet de réessayer', async () => {
    const user = userEvent.setup();
    seedData(api.db, { entries: [{ id: 'en_proc', title: 'Dallage', kind: 'procedure' }] });
    vi.spyOn(clientApi, 'deleteEntry').mockRejectedValueOnce(new Error('Suppression impossible'));
    render(<App />);
    const panel = await openPanel(user);
    const remove = await within(panel).findByRole('button', { name: 'Supprimer la procédure Dallage' });
    await user.click(remove);
    expect(await within(panel).findByRole('alert')).toHaveTextContent('Suppression impossible');
    expect(remove).toBeEnabled();
    expect(row(api.db, 'SELECT id FROM entries WHERE id=?', 'en_proc')).toBeDefined();
    await user.click(remove);
    await waitFor(() => expect(within(panel).queryByText('Dallage')).not.toBeInTheDocument());
  });

  test('récupère une pièce jointe Drive depuis son aperçu et affiche les erreurs dans le dialogue', async () => {
    const user = userEvent.setup();
    seedData(api.db, { entries: [{ id: 'en_proc', title: 'Dallage', kind: 'procedure' }] });
    const uploaded = await api.upload('consignes.txt', 'Consignes', { entry_id: 'en_proc' });
    api.db.prepare('UPDATE attachments SET drive_file_id=? WHERE id=?').run('drive-consignes', uploaded.body.id);
    vi.spyOn(clientApi, 'fetchDriveAttachment').mockRejectedValueOnce(new Error('Drive indisponible'));
    render(<App />);
    const panel = await openPanel(user);
    await user.click(await within(panel).findByRole('button', { name: 'Consulter consignes.txt' }));
    let dialog = await screen.findByRole('dialog', { name: 'Aperçu de consignes.txt' });
    await user.click(within(dialog).getByRole('button', { name: /Récupérer depuis Drive/ }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Drive indisponible');
    vi.mocked(clientApi.fetchDriveAttachment).mockResolvedValueOnce({ ...uploaded.body, driveFileId: 'drive-consignes' });
    await user.click(within(dialog).getByRole('button', { name: /Récupérer depuis Drive/ }));
    dialog = await screen.findByRole('dialog', { name: 'Aperçu de consignes.txt' });
    expect(await within(dialog).findByText('Consignes')).toBeVisible();
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  // Envoi réel depuis le panneau : couvert en e2e (jsdom n'encode pas le
  // multipart vers le vrai serveur — voir le commentaire de test/server.ts).
});

describe('panneaux repliables', () => {
  const columns = () => document.querySelector('.columns') as HTMLElement;
  test('masquer le journal et les tâches ne garde que l’écriture', async () => {
    seedData(api.db, { entries: [{ id: 'en_1', title: 'Entrée' }] });
    render(<App />);
    await screen.findByRole('region', { name: 'Entrée' });
    const journalToggle = screen.getByRole('button', { name: 'Journal' });
    expect(journalToggle).toHaveAttribute('aria-pressed', 'true');
    expect(columns()).not.toHaveClass('hide-left');
    fireEvent.click(journalToggle);
    expect(columns()).toHaveClass('hide-left');
    expect(journalToggle).toHaveAttribute('aria-pressed', 'false');
    expect(globalThis.localStorage.getItem('worklogs-show-left')).toBe('0');
    fireEvent.click(screen.getByRole('button', { name: 'Tâches' }));
    expect(columns()).toHaveClass('hide-left', 'hide-right');
    expect(screen.getByRole('region', { name: 'Entrée' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Journal' }));
    expect(columns()).not.toHaveClass('hide-left');
    expect(globalThis.localStorage.getItem('worklogs-show-left')).toBe('1');
  });

  test('l’état replié survit au rechargement', async () => {
    globalThis.localStorage.setItem('worklogs-show-right', '0');
    render(<App />);
    await screen.findByRole('region', { name: 'Journal' });
    expect(columns()).toHaveClass('hide-right');
    expect(screen.getByRole('button', { name: 'Tâches' })).toHaveAttribute('aria-pressed', 'false');
  });

  test('masquer l’écriture garde le journal et les tâches côte à côte', async () => {
    seedData(api.db, { entries: [{ id: 'en_1', title: 'Entrée' }] });
    render(<App />);
    await screen.findByRole('region', { name: 'Entrée' });
    const writingToggle = screen.getByRole('button', { name: 'Écriture' });
    expect(writingToggle).toHaveAttribute('aria-pressed', 'true');
    expect(columns()).not.toHaveClass('hide-center');
    fireEvent.click(writingToggle);
    expect(columns()).toHaveClass('hide-center');
    expect(writingToggle).toHaveAttribute('aria-pressed', 'false');
    expect(globalThis.localStorage.getItem('worklogs-show-center')).toBe('0');
    expect(screen.getByRole('region', { name: 'Journal' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Tâches' })).toBeVisible();
    fireEvent.click(writingToggle);
    expect(columns()).not.toHaveClass('hide-center');
    expect(globalThis.localStorage.getItem('worklogs-show-center')).toBe('1');
  });

  test('l’écriture repliée survit au rechargement', async () => {
    globalThis.localStorage.setItem('worklogs-show-center', '0');
    render(<App />);
    await screen.findByRole('region', { name: 'Journal' });
    expect(columns()).toHaveClass('hide-center');
    expect(screen.getByRole('button', { name: 'Écriture' })).toHaveAttribute('aria-pressed', 'false');
  });

  test('cliquer sur une entrée du journal réaffiche directement l’écriture', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-show-center', '0');
    seedData(api.db, {
      entries: [
        { id: 'en_recent', title: 'Entrée récente', date: '2026-09-22' },
        { id: 'en_journal', title: 'Entrée du journal', date: '2026-09-21' },
      ],
    });
    render(<App />);

    await user.click(await within(journal()).findByText('Entrée du journal'));
    await waitFor(() => expect(columns()).not.toHaveClass('hide-center'));
    await waitFor(() => expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Entrée du journal'));
  });

  test('ouvrir une entrée depuis les tâches réaffiche directement l’écriture', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-show-center', '0');
    seedData(api.db, {
      entries: [{ id: 'en_task_doc', title: 'Document de la tâche' }],
      tasks: [{ id: 'tk_task', title: 'Tâche avec document' }],
    });
    api.db.prepare('INSERT INTO task_entries (task_id,entry_id,created_at) VALUES (?,?,?)').run(
      'tk_task', 'en_task_doc', new Date().toISOString()
    );
    render(<App />);

    const card = (await within(board()).findByText('Tâche avec document')).closest('.card') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: 'Ouvrir Document de la tâche' }));
    await waitFor(() => expect(columns()).not.toHaveClass('hide-center'));
    await waitFor(() => expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Document de la tâche'));
  });

  test.each([
    ['Nouvelle entrée', /Nouvelle entrée/],
    ['Nouveau document', /Nouveau document/],
  ])('« %s » réaffiche directement l’écriture', async (_label, name) => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-show-center', '0');
    render(<App />);

    await user.click(await within(journal()).findByRole('button', { name }));
    await waitFor(() => expect(columns()).not.toHaveClass('hide-center'));
    expect(screen.getByRole('button', { name: 'Écriture' })).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByLabelText('Titre de l’entrée')).toHaveValue('Sans titre');
  });
});
