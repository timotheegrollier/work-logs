import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { seedData, useRealApi } from './test/server';
import { flushPendingSaves } from './autosave';

let api: Awaited<ReturnType<typeof useRealApi>>;

beforeEach(async () => {
  api = await useRealApi();
  localStorage.clear();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(async () => {
  await flushPendingSaves();
  vi.restoreAllMocks();
  await api.close();
});

const journal = () => screen.getByRole('region', { name: 'Journal' });
const board = () => screen.getByRole('region', { name: 'Tâches' });
const editor = () => screen.getByRole('region', { name: 'Entrée' });
const filters = () => screen.getByRole('group', { name: 'Filtrer par projet' });
const row = (db: typeof api.db, sql: string, ...args: unknown[]) =>
  db.prepare(sql).get(...args) as Record<string, unknown>;

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
    expect(screen.getByTitle('Version de l’application')).toHaveTextContent(/\d+\.\d+\.\d+/);
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
    api = await useRealApi(); // pour que le nettoyage de fin de test reste valide
  });
});

describe('écrire une entrée', () => {
  test('crée une entrée et la sélectionne aussitôt', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: /Nouvelle entrée/ }));

    expect(await screen.findByLabelText('Titre de l’entrée')).toHaveValue('Sans titre');
    expect(await within(journal()).findByText('Sans titre')).toBeInTheDocument();
    expect(row(api.db, 'SELECT COUNT(*) n FROM entries').n).toBe(1);
  });

  test('enregistre automatiquement le titre et le contenu', async () => {
    const user = userEvent.setup();
    seedData(api.db, { entries: [{ id: 'en_1', title: 'Brouillon' }] });
    render(<App />);

    await user.clear(await screen.findByLabelText('Titre de l’entrée'));
    await user.type(screen.getByLabelText('Titre de l’entrée'), 'Réunion du 11');

    await user.click(screen.getByRole('button', { name: 'Écrire' }));
    await user.type(screen.getByLabelText('Contenu en Markdown'), '## Décisions');

    await waitFor(() => expect(screen.getByText('Enregistré')).toBeInTheDocument());
    await waitFor(() => {
      const saved = row(api.db, 'SELECT * FROM entries WHERE id=?', 'en_1');
      expect(saved.title).toBe('Réunion du 11');
      expect(saved.content_md).toBe('## Décisions');
    });
  });

  test('affiche l’aperçu Markdown mis en page pendant la frappe', async () => {
    const user = userEvent.setup();
    seedData(api.db, { entries: [{ id: 'en_1', title: 'Note' }] });
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Écrire' }));
    await user.type(screen.getByLabelText('Contenu en Markdown'), '## Bilan');

    const preview = within(editor()).getByRole('article', { name: 'Aperçu' });
    expect(await within(preview).findByRole('heading', { name: 'Bilan' })).toBeInTheDocument();
  });

  test('bascule entre écriture et lecture', async () => {
    const user = userEvent.setup();
    seedData(api.db, { entries: [{ id: 'en_1', title: 'Note', content_md: '# Titre' }] });
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Écrire' }));
    expect(screen.getByLabelText('Contenu en Markdown')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Lire' }));
    expect(screen.queryByLabelText('Contenu en Markdown')).not.toBeInTheDocument();
    expect(within(editor()).getByRole('heading', { name: 'Titre' })).toBeInTheDocument();
  });

  test('change la date et le projet d’une entrée', async () => {
    const user = userEvent.setup();
    seedData(api.db, {
      projects: [{ id: 'pr_1', name: 'Chantier' }],
      entries: [{ id: 'en_1', title: 'Note' }],
    });
    render(<App />);

    await user.selectOptions(await screen.findByLabelText('Projet de l’entrée'), 'pr_1');
    fireEvent.change(screen.getByLabelText('Date de l’entrée'), { target: { value: '2026-02-03' } });

    await waitFor(() => {
      const saved = row(api.db, 'SELECT * FROM entries WHERE id=?', 'en_1');
      expect(saved.project_id).toBe('pr_1');
      expect(saved.entry_date).toBe('2026-02-03');
    });
  });

  test('ne remonte pas le brouillon d’une entrée sur une autre', async () => {
    const user = userEvent.setup();
    seedData(api.db, {
      entries: [
        { id: 'en_a', title: 'A', date: '2026-06-02' },
        { id: 'en_b', title: 'B', date: '2026-06-01' },
      ],
    });
    render(<App />);

    await user.type(await screen.findByLabelText('Titre de l’entrée'), ' modifié');
    await user.click(within(journal()).getByText('B'));

    // Le changement d’entrée recharge l’éditeur via l’API : attendre le nouveau
    // rendu au lieu d’affirmer sur l’éditeur précédent encore monté.
    await waitFor(() =>
      expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('B')
    );
    await waitFor(() => expect(row(api.db, 'SELECT title FROM entries WHERE id=?', 'en_a').title).toBe('A modifié'));
  });

  test('supprime une entrée et ouvre la suivante', async () => {
    const user = userEvent.setup();
    seedData(api.db, {
      entries: [
        { id: 'en_a', title: 'À supprimer', date: '2026-06-02' },
        { id: 'en_b', title: 'La suivante', date: '2026-06-01' },
      ],
    });
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Supprimer' }));

    await waitFor(() =>
      expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('La suivante')
    );
    expect(within(journal()).queryByText('À supprimer')).not.toBeInTheDocument();
  });
});

describe('retrouver son travail', () => {
  test('la recherche filtre entrées et tâches ensemble', async () => {
    const user = userEvent.setup();
    seedData(api.db, {
      entries: [
        { id: 'en_1', title: 'Devis toiture' },
        { id: 'en_2', title: 'Note sans rapport' },
      ],
      tasks: [
        { id: 'tk_1', title: 'Relancer la toiture' },
        { id: 'tk_2', title: 'Autre tâche' },
      ],
    });
    render(<App />);

    await user.type(await screen.findByLabelText('Rechercher'), 'toiture');

    await waitFor(() =>
      expect(within(journal()).queryByText('Note sans rapport')).not.toBeInTheDocument()
    );
    expect(within(journal()).getByText('Devis toiture')).toBeInTheDocument();
    expect(within(board()).getByText('Relancer la toiture')).toBeInTheDocument();
    expect(within(board()).queryByText('Autre tâche')).not.toBeInTheDocument();
  });

  test('le filtre projet s’applique aux deux colonnes', async () => {
    const user = userEvent.setup();
    seedData(api.db, {
      projects: [{ id: 'pr_a', name: 'Alpha' }, { id: 'pr_b', name: 'Beta' }],
      entries: [
        { id: 'en_a', title: 'Entrée Alpha', project_id: 'pr_a' },
        { id: 'en_b', title: 'Entrée Beta', project_id: 'pr_b' },
      ],
      tasks: [
        { id: 'tk_a', title: 'Tâche Alpha', project_id: 'pr_a' },
        { id: 'tk_b', title: 'Tâche Beta', project_id: 'pr_b' },
      ],
    });
    render(<App />);

    await user.click(await within(filters()).findByRole('button', { name: /Alpha/ }));

    await waitFor(() =>
      expect(within(journal()).queryByText('Entrée Beta')).not.toBeInTheDocument()
    );
    expect(within(journal()).getByText('Entrée Alpha')).toBeInTheDocument();
    expect(within(board()).getByText('Tâche Alpha')).toBeInTheDocument();
    expect(within(board()).queryByText('Tâche Beta')).not.toBeInTheDocument();
  });

  test('recliquer sur le projet actif enlève le filtre', async () => {
    const user = userEvent.setup();
    seedData(api.db, {
      projects: [{ id: 'pr_a', name: 'Alpha' }],
      entries: [
        { id: 'en_a', title: 'Entrée Alpha', project_id: 'pr_a' },
        { id: 'en_x', title: 'Entrée libre' },
      ],
    });
    render(<App />);

    const chip = await within(filters()).findByRole('button', { name: /Alpha/ });
    await user.click(chip);
    await waitFor(() => expect(within(journal()).queryByText('Entrée libre')).not.toBeInTheDocument());

    await user.click(chip);
    expect(await within(journal()).findByText('Entrée libre')).toBeInTheDocument();
  });
});

describe('organiser les tâches', () => {
  test('ajoute une tâche à la volée avec Entrée', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(await screen.findByLabelText('Nouvelle tâche'), 'Rappeler le client{Enter}');

    expect(await within(board()).findByText('Rappeler le client')).toBeInTheDocument();
    expect(screen.getByLabelText('Nouvelle tâche')).toHaveValue('');
    expect(row(api.db, 'SELECT * FROM tasks').status).toBe('todo');
  });

  test('rattache la nouvelle tâche au projet filtré', async () => {
    const user = userEvent.setup();
    seedData(api.db, { projects: [{ id: 'pr_a', name: 'Alpha' }] });
    render(<App />);

    await user.click(await within(filters()).findByRole('button', { name: /Alpha/ }));
    await user.type(screen.getByLabelText('Nouvelle tâche'), 'Dans Alpha{Enter}');

    await waitFor(() => expect(row(api.db, 'SELECT * FROM tasks').project_id).toBe('pr_a'));
  });

  test('terminer puis rouvrir une tâche', async () => {
    const user = userEvent.setup();
    seedData(api.db, { tasks: [{ id: 'tk_1', title: 'Balayer' }] });
    render(<App />);

    await user.click(await screen.findByLabelText('Terminer Balayer'));
    await waitFor(() => expect(row(api.db, 'SELECT * FROM tasks').status).toBe('done'));

    await user.click(await screen.findByLabelText('Rouvrir Balayer'));
    await waitFor(() => expect(row(api.db, 'SELECT * FROM tasks').status).toBe('todo'));
  });

  test('épingle une tâche', async () => {
    const user = userEvent.setup();
    seedData(api.db, { tasks: [{ id: 'tk_1', title: 'Important' }] });
    render(<App />);

    await user.click(await screen.findByLabelText('Épingler Important'));
    await waitFor(() => expect(row(api.db, 'SELECT * FROM tasks').pinned).toBe(1));
    expect(await screen.findByLabelText('Désépingler Important')).toBeInTheDocument();
  });

  test('renomme une tâche et lui pose une échéance', async () => {
    const user = userEvent.setup();
    seedData(api.db, { tasks: [{ id: 'tk_1', title: 'Ancien nom' }] });
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Ancien nom' }));
    await user.clear(screen.getByLabelText('Titre de la tâche'));
    await user.type(screen.getByLabelText('Titre de la tâche'), 'Nouveau nom');
    fireEvent.change(screen.getByLabelText('Échéance'), { target: { value: '2026-12-25' } });
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() => {
      const saved = row(api.db, 'SELECT * FROM tasks WHERE id=?', 'tk_1');
      expect(saved.title).toBe('Nouveau nom');
      expect(saved.due_date).toBe('2026-12-25');
    });
  });

  test('signale une échéance dépassée', async () => {
    const hier = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    seedData(api.db, { tasks: [{ id: 'tk_1', title: 'Facture oubliée', due_date: hier }] });
    render(<App />);

    expect(await within(board()).findByText('hier')).toHaveClass('is-late');
    expect(await screen.findByText(/en retard/)).toHaveTextContent('1');
  });

  test('supprime une tâche', async () => {
    const user = userEvent.setup();
    seedData(api.db, { tasks: [{ id: 'tk_1', title: 'À jeter' }] });
    render(<App />);

    await user.click(await screen.findByLabelText('Supprimer À jeter'));

    await waitFor(() => expect(row(api.db, 'SELECT COUNT(*) n FROM tasks').n).toBe(0));
  });

  test('déplace une carte d’une colonne à l’autre par glisser-déposer', async () => {
    seedData(api.db, { tasks: [{ id: 'tk_1', title: 'À déplacer' }] });
    render(<App />);

    const card = (await within(board()).findByText('À déplacer')).closest('.card')!;
    const dataTransfer = { data: {} as Record<string, string>, setData(k: string, v: string) { this.data[k] = v; }, getData(k: string) { return this.data[k]; } };

    fireEvent.dragStart(card, { dataTransfer });
    const doing = within(board()).getByRole('heading', { name: /En cours/ }).parentElement!;
    fireEvent.dragOver(doing, { dataTransfer });
    fireEvent.drop(doing, { dataTransfer });

    await waitFor(() => expect(row(api.db, 'SELECT * FROM tasks').status).toBe('doing'));
    expect(within(doing).getByText('À déplacer')).toBeInTheDocument();
  });
});

describe('projets', () => {
  test('crée un projet depuis le panneau de gestion', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByText('Gérer les projets'));
    await user.type(screen.getByLabelText('Nom du nouveau projet'), 'Nouveau chantier{Enter}');

    expect(await within(filters()).findByRole('button', { name: /Nouveau chantier/ })).toBeInTheDocument();
    expect(row(api.db, 'SELECT * FROM projects').name).toBe('Nouveau chantier');
  });

  test('renomme un projet', async () => {
    const user = userEvent.setup();
    seedData(api.db, { projects: [{ id: 'pr_a', name: 'Avant' }] });
    render(<App />);

    await user.click(await screen.findByText('Gérer les projets'));
    const field = screen.getByLabelText('Nom de Avant');
    await user.clear(field);
    await user.type(field, 'Après');
    fireEvent.blur(field);

    await waitFor(() => expect(row(api.db, 'SELECT * FROM projects').name).toBe('Après'));
  });

  test('supprimer un projet garde ses entrées', async () => {
    const user = userEvent.setup();
    seedData(api.db, {
      projects: [{ id: 'pr_a', name: 'Alpha' }],
      entries: [{ id: 'en_a', title: 'Survivante', project_id: 'pr_a' }],
    });
    render(<App />);

    await user.click(await screen.findByText('Gérer les projets'));
    await user.click(screen.getByLabelText('Supprimer Alpha'));

    await waitFor(() => expect(row(api.db, 'SELECT COUNT(*) n FROM projects').n).toBe(0));
    expect(await within(journal()).findByText('Survivante')).toBeInTheDocument();
  });
});

describe('confort', () => {
  test('bascule et retient le thème clair', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByLabelText('Changer de thème'));

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('worklogs-theme')).toBe('light');
  });

  test('propose le lien d’export de la base', async () => {
    render(<App />);
    const link = await screen.findByRole('link', { name: 'Exporter' });
    expect(link).toHaveAttribute('href', '/api/export');
    expect(link).toHaveAttribute('download', 'worklogs.json');
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
