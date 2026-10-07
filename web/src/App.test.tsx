import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { seedData, useRealApi } from './test/server';
import { flushPendingSaves } from './autosave';
import { api as clientApi } from './lib';

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

function seedGoogleLink(db: typeof api.db, entryId: string, documentId: string) {
  const rich = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Google' }] }] });
  db.prepare('UPDATE entries SET content_json=? WHERE id=?').run(rich, entryId);
  db.prepare(`INSERT INTO google_documents (entry_id,document_id,tab_id,revision_id,synced_content_json,document_title,tab_title,tab_order,tab_depth)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(entryId, documentId, 'tab-0', 'r1', rich, 'Document Google', 'Onglet', 0, 0);
}

/** Les largeurs au pixel près vivent dans Paramètres › Affichage. */
async function openDisplaySettings() {
  fireEvent.click(await screen.findByRole('button', { name: 'Compte et paramètres' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Paramètres' }));
  return within(await screen.findByRole('region', { name: 'Affichage' }));
}

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
    api = await useRealApi(); // pour que le nettoyage de fin de test reste valide
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
});

describe('réglages IA', () => {
  test('endpoint, modèle et clé modifiables, avec valeurs Gemini gratuites', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('region', { name: 'Journal' });

    await user.click(screen.getByRole('button', { name: 'Compte et paramètres' }));
    await user.click(screen.getByRole('menuitem', { name: 'Paramètres' }));
    const dialog = await screen.findByRole('dialog', { name: 'Paramètres' });
    expect(within(dialog).getByLabelText('Endpoint IA')).toHaveValue(
      'https://generativelanguage.googleapis.com/v1beta/openai'
    );
    expect(within(dialog).getByLabelText('Modèle IA')).toHaveValue('gemini-3-flash-preview');
    expect(within(dialog).getByLabelText('Clé IA')).toHaveValue('');

    await user.type(within(dialog).getByLabelText('Clé IA'), 'cle-test');
    expect(localStorage.getItem('worklogs-ai-key')).toBe('cle-test');

    await user.selectOptions(within(dialog).getByLabelText('Modèle IA'), 'gemini-3.5-flash');
    expect(localStorage.getItem('worklogs-ai-model')).toBe('gemini-3.5-flash');
    await user.click(within(dialog).getByRole('button', { name: 'Valeurs Gemini gratuites' }));
    expect(within(dialog).getByLabelText('Modèle IA')).toHaveValue('gemini-3-flash-preview');
    // La clé collée survit au reset des valeurs.
    expect(within(dialog).getByLabelText('Clé IA')).toHaveValue('cle-test');

    await user.type(within(dialog).getByLabelText('Mon contexte de travail'), 'Dev solo en pisciculture');
    expect(localStorage.getItem('worklogs-ai-profile')).toBe('Dev solo en pisciculture');
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

  test('coche une case en mode Lire et enregistre le Markdown', async () => {
    const user = userEvent.setup();
    seedData(api.db, { entries: [{ id: 'en_1', title: 'Note', content_md: '- [ ] Relire\n- [ ] Payer' }] });
    render(<App />);

    const preview = await screen.findByRole('article', { name: 'Aperçu' });
    const boxes = within(preview).getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    // Mode Lire par défaut : les cases sont actives, pas inertes.
    for (const box of boxes) expect(box).toBeEnabled();

    await user.click(boxes[1]);
    await waitFor(() => {
      expect(row(api.db, 'SELECT content_md AS v FROM entries WHERE id=?', 'en_1').v)
        .toBe('- [ ] Relire\n- [x] Payer');
    });
    // Le re-rendu suit le Markdown : la case cochée reste cochée.
    expect(within(await screen.findByRole('article', { name: 'Aperçu' })).getAllByRole('checkbox')[1])
      .toBeChecked();

    // En mode Écrire, le textarea fait foi : les cases d'aperçu restent inertes.
    await user.click(screen.getByRole('button', { name: 'Écrire' }));
    const writePreview = within(editor()).getByRole('article', { name: 'Aperçu' });
    for (const box of within(writePreview).getAllByRole('checkbox')) expect(box).toBeDisabled();
  });

  test('« Bloc de code » entoure de ``` les lignes sélectionnées, puis en insère un vide au curseur', async () => {
    const user = userEvent.setup();
    seedData(api.db, { entries: [{ id: 'en_1', title: 'Note', content_md: 'Relancer :\nsudo systemctl restart app\nPuis vérifier.' }] });
    render(<App />);

    // En lecture, rien à entourer : le bouton n'apparaît qu'en écriture.
    await screen.findByRole('article', { name: 'Aperçu' });
    expect(within(editor()).queryByRole('button', { name: 'Bloc de code' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Écrire' }));
    const source = screen.getByLabelText('Contenu en Markdown') as HTMLTextAreaElement;
    const start = source.value.indexOf('restart');
    source.setSelectionRange(start, start + 3);
    await user.click(within(editor()).getByRole('button', { name: 'Bloc de code' }));

    expect(source).toHaveValue('Relancer :\n```\nsudo systemctl restart app\n```\nPuis vérifier.');
    // La ligne entière est entourée et reste sélectionnée ; le textarea garde la main.
    expect(source).toHaveFocus();
    expect(source.value.slice(source.selectionStart, source.selectionEnd)).toBe('sudo systemctl restart app');
    const preview = within(editor()).getByRole('article', { name: 'Aperçu' });
    expect(within(preview).getByText('sudo systemctl restart app').closest('pre')).not.toBeNull();

    // Sans sélection : un bloc vide au curseur, où la frappe entre directement.
    source.setSelectionRange(source.value.length, source.value.length);
    await user.click(within(editor()).getByRole('button', { name: 'Bloc de code' }));
    await user.keyboard('journalctl -u app');
    await waitFor(() => expect(row(api.db, 'SELECT content_md AS v FROM entries WHERE id=?', 'en_1').v)
      .toBe('Relancer :\n```\nsudo systemctl restart app\n```\nPuis vérifier.\n```\njournalctl -u app\n```'));
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

  test('crée une tâche liée depuis l’entrée ouverte et affiche son document sur la carte', async () => {
    const user = userEvent.setup();
    seedData(api.db, { entries: [{ id: 'en_context', title: 'Contexte de réunion' }] });
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Créer une tâche liée' }));
    expect(screen.getByLabelText('Titre de la tâche liée')).toHaveValue('Contexte de réunion');
    await user.click(screen.getByRole('button', { name: 'Créer et lier' }));

    await waitFor(() => expect(row(api.db, 'SELECT COUNT(*) n FROM task_entries').n).toBe(1));
    expect(await within(editor()).findByText('Tâche créée et liée à cette entrée.')).toBeVisible();
    const card = (await within(board()).findByRole('button', { name: 'Contexte de réunion' })).closest('.card') as HTMLElement;
    expect(within(card).getByRole('button', { name: 'Ouvrir Contexte de réunion' })).toBeInTheDocument();
    expect(within(card).getByText('local')).toBeInTheDocument();
  });

  test('lie l’entrée ouverte à une tâche existante, sans en créer', async () => {
    const user = userEvent.setup();
    seedData(api.db, {
      entries: [{ id: 'en_reunion', title: 'Contexte de réunion' }],
      tasks: [{ id: 'tk_dossier', title: 'Préparer le dossier' }, { id: 'tk_facture', title: 'Envoyer la facture' }],
    });
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Lier une tâche existante' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Lier Préparer le dossier à cette entrée' }));
    await user.click(screen.getByRole('button', { name: 'Relier la sélection (1)' }));

    await waitFor(() => expect(row(api.db, 'SELECT COUNT(*) n FROM task_entries').n).toBe(1));
    expect(await within(editor()).findByText('Tâche liée à cette entrée.')).toBeVisible();
    // La tâche liée sort du lieur, l’autre reste proposée.
    await user.click(await screen.findByRole('button', { name: 'Lier une tâche existante' }));
    expect(screen.queryByRole('checkbox', { name: 'Lier Préparer le dossier à cette entrée' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Lier Envoyer la facture à cette entrée' })).toBeVisible();
  });

  test('crée une entrée liée depuis une tâche, avec ses sous-tâches en cases', async () => {
    const user = userEvent.setup();
    seedData(api.db, { tasks: [{ id: 'tk_dossier', title: 'Préparer le dossier' }] });
    render(<App />);

    const card = (await within(board()).findByText('Préparer le dossier')).closest('.card') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: /Créer une entrée liée/ }));
    expect(screen.getByLabelText('Titre de l’entrée liée')).toHaveValue('Préparer le dossier');
    // fireEvent : user.type avale les séquences `[x]` (syntaxe clavier), ce qui
    // fausserait justement le statut coché qu'on veut vérifier ici.
    fireEvent.change(screen.getByLabelText('Sous-tâches de l’entrée liée, une par ligne'), {
      target: { value: 'Relire\n- [x] Payer' },
    });
    await user.click(screen.getByRole('button', { name: 'Créer et ouvrir' }));

    await waitFor(() => expect(row(api.db, 'SELECT COUNT(*) n FROM task_entries').n).toBe(1));
    // L'entrée s'ouvre aussitôt, titre repris et liste à puces préremplie.
    await waitFor(() => expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Préparer le dossier'));
    await user.click(screen.getByRole('button', { name: 'Écrire' }));
    expect(screen.getByLabelText('Contenu en Markdown')).toHaveValue('## Sous-tâches\n- [ ] Relire\n- [x] Payer\n');
    // La carte affiche le document lié, comme dans l'autre sens.
    expect(await within(board()).findByRole('button', { name: 'Ouvrir Préparer le dossier' })).toBeInTheDocument();
  });

  // Le fetch détourné vers l'API locale ne voit que le relatif : l'URL absolue
  // du service IA reste mockable sans toucher au backend réel.
  const aiBodies: unknown[] = [];
  function mockAiSuggest(content: string) {
    aiBodies.length = 0;
    const diverted = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('chat/completions')) {
        if (init?.body) aiBodies.push(JSON.parse(init.body as string));
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) } as Response;
      }
      return diverted(input, init);
    }));
  }

  test('suggère des sous-tâches dans le créateur d’entrée liée', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    localStorage.setItem('worklogs-ai-profile', 'Dev solo en pisciculture');
    mockAiSuggest('Relire\nPayer');
    seedData(api.db, {
      projects: [{ id: 'pr_a', name: 'Chantier' }],
      entries: [{ id: 'en_cr', title: 'Compte rendu', project_id: 'pr_a' }],
      tasks: [
        { id: 'tk_dossier', title: 'Préparer le dossier', project_id: 'pr_a' },
        { id: 'tk_devis', title: 'Relire le devis', project_id: 'pr_a' },
      ],
    });
    render(<App />);

    const card = (await within(board()).findByText('Préparer le dossier')).closest('.card') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: /Créer une entrée liée/ }));
    await user.click(screen.getByRole('button', { name: '✨ Suggérer' }));

    await waitFor(() => {
      expect(screen.getByLabelText('Sous-tâches de l’entrée liée, une par ligne')).toHaveValue('Relire\nPayer');
    });
    // Le prompt connaît le projet, la tâche voisine, la note récente,
    // le profil et le vocabulaire appris des titres.
    const sent = (aiBodies.at(-1) as { messages: { role: string; content: string }[] }).messages[1].content;
    expect(sent).toContain('Profil : Dev solo en pisciculture');
    expect(sent).toContain('Projet : Chantier');
    expect(sent).toContain('- Relire le devis');
    expect(sent).toContain('- Compte rendu');
    expect(sent).toContain('Vocabulaire du métier : compte, devis, dossier');
    await user.click(screen.getByRole('button', { name: 'Créer et ouvrir' }));
    await waitFor(() => expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Préparer le dossier'));
    await user.click(screen.getByRole('button', { name: 'Écrire' }));
    expect(screen.getByLabelText('Contenu en Markdown')).toHaveValue('## Sous-tâches\n- [ ] Relire\n- [ ] Payer\n');
  });

  test('suggérer remplace le contenu du créateur, effacer le vide', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest('Relire');
    seedData(api.db, { tasks: [{ id: 'tk_dossier', title: 'Préparer le dossier' }] });
    render(<App />);

    const card = (await within(board()).findByText('Préparer le dossier')).closest('.card') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: /Créer une entrée liée/ }));
    // Effacer n'existe que quand la zone est remplie.
    expect(within(card).queryByRole('button', { name: 'Effacer la suggestion' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '✨ Suggérer' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Sous-tâches de l’entrée liée, une par ligne')).toHaveValue('Relire');
    });

    // Second appel : remplace, jamais empilé.
    mockAiSuggest('Payer');
    await user.click(screen.getByRole('button', { name: '✨ Suggérer' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Sous-tâches de l’entrée liée, une par ligne')).toHaveValue('Payer');
    });

    await user.click(within(card).getByRole('button', { name: 'Effacer la suggestion' }));
    expect(screen.getByLabelText('Sous-tâches de l’entrée liée, une par ligne')).toHaveValue('');
    expect(within(card).queryByRole('button', { name: 'Effacer la suggestion' })).not.toBeInTheDocument();
  });

  test('sans clé IA, la suggestion renvoie aux Paramètres sans appeler personne', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    const diverted = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      return diverted(input, init);
    }));
    seedData(api.db, { tasks: [{ id: 'tk_dossier', title: 'Préparer le dossier' }] });
    render(<App />);

    const card = (await within(board()).findByText('Préparer le dossier')).closest('.card') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: /Créer une entrée liée/ }));
    await user.click(screen.getByRole('button', { name: '✨ Suggérer' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('⚙ Paramètres');
    expect(calls.some((url) => url.includes('chat/completions'))).toBe(false);
  });

  test('suggère des sous-tâches dans l’éditeur d’une entrée Markdown', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest('Relire');
    seedData(api.db, {
      entries: [{ id: 'en_note', title: 'Note', content_md: 'Intro.\n- [ ] Déjà là\n' }],
      tasks: [{ id: 'tk_call', title: 'Appeler le client' }],
    });
    api.db.prepare('INSERT INTO task_entries (task_id,entry_id,created_at) VALUES (?,?,?)').run('tk_call', 'en_note', new Date().toISOString());
    await api.upload('devis.pdf', '%PDF', { entry_id: 'en_note' });
    render(<App />);

    await user.click(await screen.findByRole('button', { name: '✨ Suggérer des sous-tâches' }));
    // Le prompt connaît le contenu : texte, case existante, pièce jointe et tâche liée.
    const sent = (aiBodies.at(-1) as { messages: { role: string; content: string }[] }).messages[1].content;
    expect(sent).toContain('Intro.');
    expect(sent).toContain('- [ ] Déjà là');
    expect(sent).toContain('devis.pdf');
    expect(sent).toContain('Appeler le client');
    await user.click(screen.getByRole('button', { name: 'Écrire' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Contenu en Markdown')).toHaveValue('Intro.\n- [ ] Déjà là\n## Sous-tâches\n- [ ] Relire\n');
    });
  });

  test('suggérer remplace le bloc dans l’éditeur, retirer le supprime', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest('Relire');
    seedData(api.db, { entries: [{ id: 'en_note', title: 'Note', content_md: 'Intro.' }] });
    render(<App />);

    await user.click(await screen.findByRole('button', { name: '✨ Suggérer des sous-tâches' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Retirer la suggestion' })).toBeInTheDocument();
    });

    // Second appel : le bloc est remplacé en place, pas dupliqué.
    mockAiSuggest('Payer');
    await user.click(screen.getByRole('button', { name: '✨ Suggérer des sous-tâches' }));
    await user.click(screen.getByRole('button', { name: 'Écrire' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Contenu en Markdown')).toHaveValue('Intro.\n## Sous-tâches\n- [ ] Payer\n');
    });

    await user.click(screen.getByRole('button', { name: 'Retirer la suggestion' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Contenu en Markdown')).toHaveValue('Intro.');
    });
    expect(screen.queryByRole('button', { name: 'Retirer la suggestion' })).not.toBeInTheDocument();
  });

  test('met en page une entrée Markdown après relecture de la proposition', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest('## Réunion\n\nOn a décidé.');
    seedData(api.db, { entries: [{ id: 'en_note', title: 'Réunion', content_md: 'on a decidé' }] });
    render(<App />);

    await user.click(await screen.findByRole('button', { name: '✨ Mettre en page' }));
    const proposal = await screen.findByRole('region', { name: 'Mise en page proposée' });
    expect(within(proposal).getByRole('heading', { name: 'Réunion' })).toBeInTheDocument();
    const sent = (aiBodies.at(-1) as { messages: { role: string; content: string }[] }).messages[1].content;
    expect(sent).toContain('Titre : Réunion');
    expect(sent).toContain('on a decidé');
    // Rien n'est écrit tant que la proposition n'est pas appliquée.
    await user.click(screen.getByRole('button', { name: 'Écrire' }));
    expect(screen.getByLabelText('Contenu en Markdown')).toHaveValue('on a decidé');

    await user.click(within(proposal).getByRole('button', { name: 'Appliquer la mise en page' }));
    expect(screen.getByLabelText('Contenu en Markdown')).toHaveValue('## Réunion\n\nOn a décidé.');
    expect(screen.queryByRole('region', { name: 'Mise en page proposée' })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(row(api.db, "SELECT content_md FROM entries WHERE id='en_note'").content_md).toBe('## Réunion\n\nOn a décidé.');
    });
  });

  test('rafraîchir remplace la proposition de mise en page affichée', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest('Première proposition.');
    seedData(api.db, { entries: [{ id: 'en_note', title: 'Note', content_md: 'texte original' }] });
    render(<App />);

    await user.click(await screen.findByRole('button', { name: '✨ Mettre en page' }));
    const proposal = await screen.findByRole('region', { name: 'Mise en page proposée' });
    expect(within(proposal).getByText('Première proposition.')).toBeInTheDocument();

    mockAiSuggest('Nouvelle proposition.');
    await user.click(within(proposal).getByRole('button', { name: 'Rafraîchir' }));
    await waitFor(() => {
      const refreshed = screen.getByRole('region', { name: 'Mise en page proposée' });
      expect(within(refreshed).getByText('Nouvelle proposition.')).toBeInTheDocument();
      expect(within(refreshed).queryByText('Première proposition.')).not.toBeInTheDocument();
    });
  });

  test('mise en page ignorée ou dépassée par une frappe : le texte reste intact', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest('Corrigé.');
    seedData(api.db, { entries: [{ id: 'en_note', title: 'Note', content_md: 'corige' }] });
    render(<App />);

    await user.click(await screen.findByRole('button', { name: '✨ Mettre en page' }));
    await user.click(await screen.findByRole('button', { name: 'Ignorer' }));
    expect(screen.queryByRole('region', { name: 'Mise en page proposée' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Écrire' }));
    expect(screen.getByLabelText('Contenu en Markdown')).toHaveValue('corige');

    // Une frappe après la demande : appliquer l'écraserait, on refuse.
    await user.click(screen.getByRole('button', { name: '✨ Mettre en page' }));
    await screen.findByRole('region', { name: 'Mise en page proposée' });
    await user.type(screen.getByLabelText('Contenu en Markdown'), '!');
    await user.click(screen.getByRole('button', { name: 'Appliquer la mise en page' }));
    expect(screen.getByRole('alert')).toHaveTextContent('relance-la');
    expect(screen.getByLabelText('Contenu en Markdown')).toHaveValue('corige!');
  });

  /** Procédure ouverte depuis sa sidebar : le journal ne liste que les notes. */
  async function openProcedure(user: ReturnType<typeof userEvent.setup>, title: string) {
    await user.click(await screen.findByRole('button', { name: 'Procédures' }));
    const panel = await screen.findByRole('region', { name: 'Procédures du projet' });
    await user.click(await within(panel).findByText(title));
    await waitFor(() => expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue(title));
  }
  const richText = (...paragraphs: string[]) =>
    JSON.stringify({ type: 'doc', content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })) });
  const documentContent = () => screen.getByRole('textbox', { name: 'Contenu du document' });

  test('procédure riche : « Suggérer une procédure » propose les étapes, appliquées après relecture', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest('```markdown\n# Changer le filtre\n\nRemplacer le filtre du bassin 3.\n\n## Étapes\n\n1. Couper l’arrivée d’eau\n2. Changer la cartouche\n```');
    seedData(api.db, {
      projects: [{ id: 'pr_ferme', name: 'Ferme' }],
      entries: [{ id: 'en_note', title: 'Journal' }, { id: 'en_proc', title: 'Changer le filtre', project_id: 'pr_ferme', kind: 'procedure' }],
    });
    api.db.prepare('UPDATE entries SET content_json=? WHERE id=?').run(richText('Bassin 3 seulement.'), 'en_proc');
    await api.upload('notice.pdf', '%PDF', { entry_id: 'en_proc' });
    render(<App />);
    await openProcedure(user, 'Changer le filtre');

    // Une procédure propose ses étapes, pas des sous-tâches.
    expect(screen.queryByRole('button', { name: '✨ Suggérer des sous-tâches' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '✨ Suggérer une procédure' }));
    const proposal = await screen.findByRole('region', { name: 'Procédure proposée' });
    expect(within(proposal).getByText('Changer la cartouche')).toBeInTheDocument();
    // Le titre en tête de réponse ferait doublon avec celui de l'entrée.
    expect(within(proposal).queryByRole('heading', { name: 'Changer le filtre' })).not.toBeInTheDocument();
    const sent = (aiBodies.at(-1) as { messages: { role: string; content: string }[] }).messages[1].content;
    expect(sent).toContain('Procédure : Changer le filtre');
    expect(sent).toContain('Projet : Ferme');
    expect(sent).toContain('Pièces jointes : notice.pdf');
    expect(sent).toContain('Déjà écrit :\nBassin 3 seulement.');
    // Rien n'est écrit avant « Appliquer ».
    expect(documentContent()).toHaveTextContent('Bassin 3 seulement.');
    expect(documentContent()).not.toHaveTextContent('Couper l’arrivée d’eau');

    await user.click(within(proposal).getByRole('button', { name: 'Appliquer la procédure' }));
    await waitFor(() => expect(documentContent()).toHaveTextContent('Couper l’arrivée d’eau'));
    expect(documentContent().querySelectorAll('ol > li')).toHaveLength(2);
    expect(screen.queryByRole('region', { name: 'Procédure proposée' })).not.toBeInTheDocument();
    await waitFor(() => {
      const saved = JSON.parse(row(api.db, "SELECT content_json FROM entries WHERE id='en_proc'").content_json as string);
      // (L'éditeur ajoute ensuite son paragraphe de fin, après la liste.)
      expect(saved.content.map((node: { type: string }) => node.type).slice(0, 3)).toEqual(['paragraph', 'heading', 'orderedList']);
      expect(JSON.stringify(saved)).toContain('Changer la cartouche');
    });
  });

  test('procédure riche : « Mettre en page » envoie le document en Markdown et applique la correction', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest('## Étapes\n\n1. Couper l’eau\n2. Vider le bassin');
    seedData(api.db, { entries: [{ id: 'en_note', title: 'Journal' }, { id: 'en_proc', title: 'Vidange', kind: 'procedure' }] });
    api.db.prepare('UPDATE entries SET content_json=? WHERE id=?').run(JSON.stringify({ type: 'doc', content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'etapes' }] },
      { type: 'orderedList', attrs: { start: 1 }, content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'coupé l’eau' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'vider le bassin' }] }] },
      ] },
    ] }), 'en_proc');
    render(<App />);
    await openProcedure(user, 'Vidange');

    await user.click(screen.getByRole('button', { name: '✨ Mettre en page' }));
    const proposal = await screen.findByRole('region', { name: 'Mise en page proposée' });
    // Le document riche part en Markdown, annoncé comme une procédure.
    const request = aiBodies.at(-1) as { messages: { role: string; content: string }[] };
    expect(request.messages[1].content).toBe('Procédure : Vidange\n\nTexte :\n## etapes\n\n1. coupé l’eau\n2. vider le bassin');
    expect(request.messages[0].content).toContain('liste numérotée');
    expect(within(proposal).getByText(/surlignage, couleurs et alignements sont remis à plat/)).toBeInTheDocument();

    await user.click(within(proposal).getByRole('button', { name: 'Appliquer la mise en page' }));
    await waitFor(() => expect(documentContent()).toHaveTextContent('Couper l’eau'));
    await waitFor(() => expect(row(api.db, "SELECT content_json FROM entries WHERE id='en_proc'").content_json).toContain('Couper l’eau'));
  });

  test('procédure riche modifiée avant d’appliquer : la proposition est refusée, rien n’est écrasé', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest('1. Tout autre chose');
    seedData(api.db, { entries: [{ id: 'en_note', title: 'Journal' }, { id: 'en_proc', title: 'Vidange', kind: 'procedure' }] });
    api.db.prepare('UPDATE entries SET content_json=? WHERE id=?').run(richText('Texte gardé'), 'en_proc');
    render(<App />);
    await openProcedure(user, 'Vidange');

    await user.click(screen.getByRole('button', { name: '✨ Suggérer une procédure' }));
    const proposal = await screen.findByRole('region', { name: 'Procédure proposée' });
    // Le document change après la demande (Rechercher et remplacer) : appliquer l'écraserait.
    // La procédure s'ouvre en lecture : Écrire donne la barre d'outils.
    await user.click(screen.getByRole('button', { name: 'Écrire' }));
    await user.click(screen.getByRole('button', { name: 'Rechercher et remplacer' }));
    const search = screen.getByRole('search', { name: 'Rechercher dans le document' });
    await user.type(within(search).getByLabelText('Rechercher'), 'gardé');
    await user.type(within(search).getByLabelText('Remplacer par'), 'modifié');
    await user.click(within(search).getByRole('button', { name: 'Remplacer' }));
    await waitFor(() => expect(documentContent()).toHaveTextContent('Texte modifié'));
    await user.click(within(proposal).getByRole('button', { name: 'Appliquer la procédure' }));
    expect(screen.getByRole('alert')).toHaveTextContent('relance-la');
    expect(documentContent()).toHaveTextContent('Texte modifié');
    expect(documentContent()).not.toHaveTextContent('Tout autre chose');
  });

  test('procédure liée à Google : pas d’IA, le document Google ne transite pas', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, { entries: [{ id: 'en_note', title: 'Journal' }, { id: 'en_proc', title: 'Consignes Google', kind: 'procedure' }] });
    seedGoogleLink(api.db, 'en_proc', 'doc-procedure');
    render(<App />);
    await openProcedure(user, 'Consignes Google');
    expect(documentContent()).toHaveTextContent('Google');
    expect(screen.queryByRole('button', { name: '✨ Suggérer une procédure' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '✨ Mettre en page' })).not.toBeInTheDocument();
    // Ni Lire ni Écrire : un document Google garde son propre parcours d'édition.
    expect(screen.queryByRole('button', { name: 'Lire' })).not.toBeInTheDocument();
    expect(documentContent()).toHaveAttribute('contenteditable', 'true');
  });

  test('crée une tâche liée depuis un document Google', async () => {
    const user = userEvent.setup();
    seedData(api.db, { entries: [{ id: 'en_google_task', title: 'Contexte Google' }] });
    seedGoogleLink(api.db, 'en_google_task', 'doc-task');
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Créer une tâche liée' }));
    await user.click(screen.getByRole('button', { name: 'Créer et lier' }));

    await waitFor(() => expect(row(api.db, 'SELECT COUNT(*) n FROM task_entries').n).toBe(1));
    const card = (await within(board()).findByRole('button', { name: 'Contexte Google' })).closest('.card') as HTMLElement;
    expect(within(card).getByText('Google')).toBeInTheDocument();
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

  test('archive un document du journal puis le restaure depuis les Archives', async () => {
    const user = userEvent.setup();
    seedData(api.db, {
      entries: [
        { id: 'en_old', title: 'Vieux dossier', date: '2026-06-02' },
        { id: 'en_new', title: 'En cours', date: '2026-06-01' },
      ],
    });
    render(<App />);

    await user.click(await within(journal()).findByText('Vieux dossier'));
    await user.click(await screen.findByRole('button', { name: 'Archiver' }));
    await waitFor(() => expect(row(api.db, 'SELECT archived FROM entries WHERE id=?', 'en_old').archived).toBe(1));

    // Masqué du journal, sans rien détruire : les Archives le proposent.
    await waitFor(() => expect(within(journal()).queryByText('Vieux dossier')).not.toBeInTheDocument());
    expect(within(journal()).getByText('Archives')).toBeInTheDocument();
    await user.click(within(journal()).getByText('Archives', { selector: 'summary' }));
    await user.click(await within(journal()).findByText('Vieux dossier'));
    await waitFor(() => expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Vieux dossier'));

    await user.click(await screen.findByRole('button', { name: 'Désarchiver' }));
    await waitFor(() => expect(row(api.db, 'SELECT archived FROM entries WHERE id=?', 'en_old').archived).toBe(0));
    await waitFor(() => expect(within(journal()).queryByText('Archives')).not.toBeInTheDocument());
  });

  test('ouvre l’aperçu d’une pièce jointe sans la télécharger', async () => {
    const user = userEvent.setup();
    seedData(api.db, { entries: [{ id: 'en_pj', title: 'Avec aperçu' }] });
    const entry = row(api.db, 'SELECT * FROM entries WHERE id=?', 'en_pj') as { id: string };
    const upload = await api.upload('notes.md', '# Notes\nligne', { entry_id: entry.id });
    // Le helper envoie tout en text/plain ; on pose le type d'un fichier Markdown.
    api.db.prepare('UPDATE attachments SET mime=? WHERE id=?').run('text/markdown', upload.body.id);
    render(<App />);
    await user.click(await within(journal()).findByText('Avec aperçu'));
    await user.click(await screen.findByRole('button', { name: 'Aperçu de notes.md' }));

    const dialog = await screen.findByRole('dialog', { name: 'Aperçu de notes.md' });
    expect(await within(dialog).findByText(/ligne/)).toBeInTheDocument();
    // Le téléchargement direct reste accessible depuis l'aperçu.
    expect(within(dialog).getByRole('link', { name: 'Télécharger' })).toHaveAttribute(
      'href', `/api/files/${upload.body.stored}`
    );

    await user.click(within(dialog).getByRole('button', { name: 'Fermer' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Aperçu de notes.md' })).not.toBeInTheDocument());
  });

  test('un document Word s’affiche dans l’aperçu : titres, liste, lien, image', async () => {
    const user = userEvent.setup();
    seedData(api.db, { entries: [{ id: 'en_docx', title: 'Étiqueteuse' }] });
    const docx = (await import('node:fs')).readFileSync((await import('node:path')).resolve('src/__fixtures__/procedure.docx'));
    await api.upload('Changer format balance etiqueteuse.docx', docx, { entry_id: 'en_docx' });

    render(<App />);
    await user.click(await within(journal()).findByText('Étiqueteuse'));
    await user.click(await screen.findByRole('button', { name: 'Aperçu de Changer format balance etiqueteuse.docx' }));
    const dialog = await screen.findByRole('dialog', { name: 'Aperçu de Changer format balance etiqueteuse.docx' });
    const page = await within(dialog).findByRole('article', { name: 'Contenu de Changer format balance etiqueteuse.docx' });
    expect(within(page).getByRole('heading', { level: 1, name: 'Changer le format de la balance' })).toBeInTheDocument();
    expect(within(page).getAllByRole('listitem').map((li) => li.textContent)).toContain('Valider');
    expect(within(page).getByRole('link', { name: 'notice du fabricant' })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(within(page).getByRole('img', { name: 'schéma' })).toHaveAttribute('src', expect.stringMatching(/^data:image\/png/));
    expect(within(dialog).queryByText(/ne prend pas en charge/)).not.toBeInTheDocument();
  });

  test('un tableur est annoncé tel quel plutôt que rendu de travers', async () => {
    const user = userEvent.setup();
    seedData(api.db, { entries: [{ id: 'en_xlsx', title: 'Budget' }] });
    const entry = row(api.db, 'SELECT * FROM entries WHERE id=?', 'en_xlsx') as { id: string };
    const upload = await api.upload('budget.xlsx', 'PK binaire', { entry_id: entry.id });
    api.db.prepare('UPDATE attachments SET mime=? WHERE id=?').run(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', upload.body.id
    );

    render(<App />);
    await user.click(await within(journal()).findByText('Budget'));
    await user.click(await screen.findByRole('button', { name: 'Aperçu de budget.xlsx' }));

    const dialog = await screen.findByRole('dialog', { name: 'Aperçu de budget.xlsx' });
    expect(within(dialog).getByText(/tableur/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('img')).not.toBeInTheDocument();
    // Pas encore sur Drive : seule l'ouverture par l'application du système est proposée.
    expect(within(dialog).queryByRole('link', { name: 'Ouvrir dans Drive' })).not.toBeInTheDocument();

    const openAttachment = vi.fn(async () => '');
    window.worklogsDesktop = { onBeforeClose: () => () => {}, openAttachment };
    try {
      await user.click(within(dialog).getByRole('button', { name: 'Ouvrir avec…' }));
      await waitFor(() => expect(openAttachment).toHaveBeenCalledWith(upload.body.stored, 'budget.xlsx'));
      expect(await within(dialog).findByRole('status')).toHaveTextContent(/lecture seule/);
    } finally {
      delete window.worklogsDesktop;
    }
  });

  test('un tableur déjà sur Drive propose « Ouvrir dans Drive »', async () => {
    const user = userEvent.setup();
    seedData(api.db, { entries: [{ id: 'en_ods', title: 'Stock' }] });
    const upload = await api.upload('stock.ods', 'PK', { entry_id: 'en_ods' });
    api.db.prepare('UPDATE attachments SET drive_file_id=? WHERE id=?').run('drive-ods-1', upload.body.id);

    render(<App />);
    await user.click(await within(journal()).findByText('Stock'));
    await user.click(await screen.findByRole('button', { name: 'Aperçu de stock.ods' }));
    const dialog = await screen.findByRole('dialog', { name: 'Aperçu de stock.ods' });
    const link = within(dialog).getByRole('link', { name: 'Ouvrir dans Drive' });
    expect(link).toHaveAttribute('href', 'https://drive.google.com/file/d/drive-ods-1/view');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  test('une pièce jointe adossée à Drive affiche son badge et propose Récupérer', async () => {
    const user = userEvent.setup();
    seedData(api.db, { entries: [{ id: 'en_drive', title: 'Dossier Drive' }] });
    const entry = row(api.db, 'SELECT * FROM entries WHERE id=?', 'en_drive') as { id: string };
    const upload = await api.upload('contrat.pdf', '%PDF', { entry_id: entry.id });
    api.db.prepare('UPDATE attachments SET drive_file_id=? WHERE id=?').run('drive-contrat-1', upload.body.id);
    await api.upload('local.txt', 'x', { entry_id: entry.id });
    render(<App />);
    await user.click(await within(journal()).findByText('Dossier Drive'));
    expect(await screen.findByText('☁ Drive')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Récupérer contrat\.pdf depuis Drive/ })).toBeInTheDocument();
    // Un fichier local seul n'a ni badge Drive ni bouton Récupérer.
    expect(screen.getByText('local seul')).toBeInTheDocument();
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

  test('persiste le projet sélectionné après remontage', async () => {
    const user = userEvent.setup();
    seedData(api.db, {
      projects: [{ id: 'pr_a', name: 'Alpha' }, { id: 'pr_b', name: 'Beta' }],
      entries: [
        { id: 'en_a', title: 'Entrée Alpha', project_id: 'pr_a' },
        { id: 'en_b', title: 'Entrée Beta', project_id: 'pr_b' },
      ],
    });
    const first = render(<App />);
    await user.click(await within(filters()).findByRole('button', { name: /Alpha/ }));
    await waitFor(() => expect(within(journal()).queryByText('Entrée Beta')).not.toBeInTheDocument());
    expect(localStorage.getItem('worklogs-project')).toBe('pr_a');

    first.unmount();
    render(<App />);
    await waitFor(() => expect(within(filters()).getByRole('button', { name: /Alpha/ })).toHaveAttribute('aria-pressed', 'true'));
    expect(within(journal()).getByText('Entrée Alpha')).toBeInTheDocument();
    expect(within(journal()).queryByText('Entrée Beta')).not.toBeInTheDocument();
  });

  test('réinitialise un projet mémorisé qui n’existe plus', async () => {
    localStorage.setItem('worklogs-project', 'pr_absent');
    seedData(api.db, {
      projects: [{ id: 'pr_a', name: 'Alpha' }],
      entries: [{ id: 'en_a', title: 'Entrée Alpha', project_id: 'pr_a' }],
    });
    render(<App />);

    await waitFor(() => expect(within(filters()).getByRole('button', { name: 'Tout' })).toHaveAttribute('aria-pressed', 'true'));
    await waitFor(() => expect(localStorage.getItem('worklogs-project')).toBe(''));
    expect(await within(journal()).findByText('Entrée Alpha')).toBeInTheDocument();
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

  test('termine une tâche, archive son document et le laisse restaurable depuis Archives', async () => {
    const user = userEvent.setup();
    seedData(api.db, {
      entries: [{ id: 'en_task_doc', title: 'Document de la tâche' }],
      tasks: [{ id: 'tk_task_doc', title: 'Tâche finie' }],
    });
    api.db.prepare('INSERT INTO task_entries (task_id,entry_id,created_at) VALUES (?,?,?)').run('tk_task_doc', 'en_task_doc', new Date().toISOString());
    render(<App />);

    expect(await within(journal()).findByText('Document de la tâche')).toBeInTheDocument();
    await user.click(await screen.findByLabelText('Terminer Tâche finie'));
    await waitFor(() => expect(row(api.db, 'SELECT archived FROM entries WHERE id=?', 'en_task_doc').archived).toBe(1));
    await waitFor(() => expect(within(journal()).queryByText('Document de la tâche')).not.toBeInTheDocument());

    await user.click(within(journal()).getByText('Archives', { selector: 'summary' }));
    expect(await within(journal()).findByText('Document de la tâche')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Désarchiver' })).toBeInTheDocument();
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

  test('change la priorité d’une tâche et l’affiche en pastille', async () => {
    const user = userEvent.setup();
    seedData(api.db, { tasks: [{ id: 'tk_1', title: 'À trier' }] });
    render(<App />);

    // Les tâches d’avant la fonctionnalité (sans colonne) arrivent en « Normale ».
    const card = (await within(board()).findByText('À trier')).closest('.card') as HTMLElement;
    // « Normale » est la valeur par défaut : elle ne s'affiche plus sur chaque carte.
    expect(within(card).queryByText('Normale')).not.toBeInTheDocument();

    await user.click(within(card).getByRole('button', { name: 'À trier' }));
    await user.selectOptions(screen.getByLabelText('Priorité'), 'high');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() => expect(row(api.db, 'SELECT priority FROM tasks WHERE id=?', 'tk_1').priority).toBe('high'));
    expect(await within(board()).findByText('Haute')).toBeInTheDocument();
    expect(within(board()).queryByText('Normale')).not.toBeInTheDocument();
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
    expect(await within(doing).findByText('À déplacer')).toBeInTheDocument();
  });

  test('associe un document local, l’ouvre puis le retire', async () => {
    const user = userEvent.setup();
    seedData(api.db, {
      entries: [{ id: 'en_local', title: 'Note locale' }],
      tasks: [{ id: 'tk_1', title: 'Préparer la réunion' }],
    });
    render(<App />);

    const card = (await within(board()).findByText('Préparer la réunion')).closest('.card') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: /Lier des documents/ }));
    await user.click(within(card).getByRole('checkbox', { name: 'Lier Note locale à Préparer la réunion' }));
    await user.click(within(card).getByRole('button', { name: /Relier la sélection/ }));

    await waitFor(() => expect(row(api.db, 'SELECT COUNT(*) n FROM task_entries').n).toBe(1));
    expect(await within(board()).findByRole('button', { name: 'Ouvrir Note locale' })).toBeInTheDocument();
    expect(board().textContent).toMatch(/local ·/);
    await user.click(within(board()).getByRole('button', { name: 'Ouvrir Note locale' }));
    await waitFor(() => expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Note locale'));

    await user.click(within(board()).getByRole('button', { name: 'Retirer Note locale de Préparer la réunion' }));
    await waitFor(() => expect(row(api.db, 'SELECT COUNT(*) n FROM task_entries').n).toBe(0));
    await waitFor(() => expect(within(board()).queryByRole('button', { name: 'Ouvrir Note locale' })).not.toBeInTheDocument());
  });

  test('associe un document Google et l’indique sur la carte', async () => {
    const user = userEvent.setup();
    seedData(api.db, {
      entries: [{ id: 'en_google', title: 'Note Google' }],
      tasks: [{ id: 'tk_1', title: 'Relire le compte rendu' }],
    });
    seedGoogleLink(api.db, 'en_google', 'doc-1');
    render(<App />);

    const card = (await within(board()).findByText('Relire le compte rendu')).closest('.card') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: /Lier des documents/ }));
    const picker = within(card).getByRole('checkbox', { name: 'Lier Note Google à Relire le compte rendu' });
    expect(picker.closest('label')).toHaveTextContent('Google');
    await user.click(picker);
    await user.click(within(card).getByRole('button', { name: /Relier la sélection/ }));

    await waitFor(() => expect(row(api.db, 'SELECT COUNT(*) n FROM task_entries').n).toBe(1));
    expect(await within(board()).findByRole('button', { name: 'Ouvrir Note Google' })).toBeInTheDocument();
    expect(board().textContent).toMatch(/Google ·/);
  });

  test('lie plusieurs documents d’un coup, avec recherche', async () => {
    const user = userEvent.setup();
    seedData(api.db, {
      entries: [
        { id: 'en_1', title: 'Compte rendu client' },
        { id: 'en_2', title: 'Devis atelier' },
        { id: 'en_3', title: 'Note interne' },
      ],
      tasks: [{ id: 'tk_1', title: 'Préparer le dossier' }],
    });
    render(<App />);

    const card = (await within(board()).findByText('Préparer le dossier')).closest('.card') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: /Lier des documents/ }));

    // La recherche restreint la liste sans perdre la sélection.
    await user.type(within(card).getByLabelText('Rechercher un document à lier à Préparer le dossier'), 'devis');
    expect(within(card).queryByRole('checkbox', { name: /Compte rendu client/ })).not.toBeInTheDocument();
    await user.click(within(card).getByRole('checkbox', { name: 'Lier Devis atelier à Préparer le dossier' }));
    await user.clear(within(card).getByLabelText('Rechercher un document à lier à Préparer le dossier'));
    await user.click(within(card).getByRole('checkbox', { name: 'Lier Note interne à Préparer le dossier' }));

    await user.click(within(card).getByRole('button', { name: 'Relier la sélection (2)' }));

    await waitFor(() => expect(row(api.db, 'SELECT COUNT(*) n FROM task_entries').n).toBe(2));
    expect(await within(card).findByText('📎 2 documents')).toBeInTheDocument();
    expect(await within(card).findByRole('button', { name: 'Ouvrir Devis atelier' })).toBeInTheDocument();
    expect(await within(card).findByRole('button', { name: 'Ouvrir Note interne' })).toBeInTheDocument();
  });

  test('ouvre un document lié hors projet en basculant vers son projet', async () => {
    const user = userEvent.setup();
    seedData(api.db, {
      projects: [{ id: 'pr_task', name: 'Tâches' }, { id: 'pr_doc', name: 'Documents' }],
      entries: [{ id: 'en_doc', title: 'Document hors projet', project_id: 'pr_doc' }],
      tasks: [{ id: 'tk_1', title: 'Tâche active', project_id: 'pr_task' }],
    });
    api.db.prepare('INSERT INTO task_entries (task_id,entry_id,created_at) VALUES (?,?,?)').run('tk_1', 'en_doc', new Date().toISOString());
    localStorage.setItem('worklogs-project', 'pr_task');
    render(<App />);

    const card = (await within(board()).findByText('Tâche active')).closest('.card') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: 'Ouvrir Document hors projet' }));
    await waitFor(() => expect(within(filters()).getByRole('button', { name: /Documents/ })).toHaveAttribute('aria-pressed', 'true'));
    await waitFor(() => expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Document hors projet'));
  });

  test('les documents d’une tâche terminée sont repliés dans un historique', async () => {
    const user = userEvent.setup();
    seedData(api.db, {
      entries: [{ id: 'en_doc', title: 'Document archivé' }],
      tasks: [{ id: 'tk_1', title: 'Tâche finie', status: 'done' }],
    });
    api.db.prepare('INSERT INTO task_entries (task_id,entry_id,created_at) VALUES (?,?,?)').run('tk_1', 'en_doc', new Date().toISOString());
    render(<App />);

    const card = (await within(board()).findByText('Tâche finie')).closest('.card') as HTMLElement;
    // Replié par défaut : le compteur reste visible, le document est masqué.
    expect(within(card).getByText('📎 1 document')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Ouvrir Document archivé' })).not.toBeInTheDocument();

    await user.click(within(card).getByRole('button', { name: 'Afficher l’historique des documents de Tâche finie' }));
    expect(await within(card).findByRole('button', { name: 'Ouvrir Document archivé' })).toBeInTheDocument();

    await user.click(within(card).getByRole('button', { name: 'Masquer l’historique des documents de Tâche finie' }));
    await waitFor(() => expect(within(card).queryByRole('button', { name: 'Ouvrir Document archivé' })).not.toBeInTheDocument());
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

  test('cliquer « Créer » à vide explique au lieu de ne rien faire', async () => {
    const user = userEvent.setup();
    seedData(api.db, { projects: [{ id: 'pr_a', name: 'Alpha' }] });
    render(<App />);

    await user.click(await screen.findByText('Gérer les projets'));
    // Le bouton était désactivé : sans projet à l'écran, il se lisait comme cassé.
    const bouton = screen.getByRole('button', { name: 'Créer' });
    expect(bouton).toBeEnabled();

    await user.click(bouton);
    expect(await screen.findByText('Donne un nom au projet.')).toBeInTheDocument();
    expect(screen.getByLabelText('Nom du nouveau projet')).toHaveFocus();
    expect(row(api.db, 'SELECT COUNT(*) n FROM projects').n).toBe(1);

    await user.type(screen.getByLabelText('Nom du nouveau projet'), 'Atelier');
    expect(screen.queryByText('Donne un nom au projet.')).not.toBeInTheDocument();
    await user.click(bouton);
    await waitFor(() => expect(row(api.db, 'SELECT COUNT(*) n FROM projects WHERE name=?', 'Atelier').n).toBe(1));
  });

  test('sans aucun projet, le panneau dit quoi faire et reste utilisable', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByText('Gérer les projets'));
    expect(screen.getByText(/Aucun projet/)).toBeInTheDocument();

    await user.type(screen.getByLabelText('Nom du nouveau projet'), 'Premier projet{Enter}');

    expect(await within(filters()).findByRole('button', { name: /Premier projet/ })).toBeInTheDocument();
    expect(screen.queryByText(/Aucun projet/)).not.toBeInTheDocument();
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

  test('Entrée valide le renommage', async () => {
    const user = userEvent.setup();
    seedData(api.db, { projects: [{ id: 'pr_a', name: 'Avant' }] });
    render(<App />);

    await user.click(await screen.findByText('Gérer les projets'));
    const field = screen.getByLabelText('Nom de Avant');
    await user.clear(field);
    await user.type(field, 'Après{Enter}');

    // Sans cette validation au clavier, le renommage n'était enregistré qu'en
    // cliquant ailleurs — l'utilisateur croyait la fonction cassée.
    await waitFor(() => expect(row(api.db, 'SELECT * FROM projects').name).toBe('Après'));
    expect(await within(filters()).findByRole('button', { name: /Après/ })).toBeInTheDocument();
  });

  test('Échap annule le renommage en cours', async () => {
    const user = userEvent.setup();
    seedData(api.db, { projects: [{ id: 'pr_a', name: 'Avant' }] });
    render(<App />);

    await user.click(await screen.findByText('Gérer les projets'));
    const field = screen.getByLabelText('Nom de Avant');
    await user.clear(field);
    await user.type(field, 'Jamais enregistré{Escape}');

    expect(field).toHaveValue('Avant');
    expect(row(api.db, 'SELECT * FROM projects').name).toBe('Avant');
  });

  test('le panneau de gestion s’annonce comme un contrôle cliquable', async () => {
    render(<App />);

    const summary = await screen.findByText('Gérer les projets');
    const details = summary.closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(summary.closest('summary')).toBeInTheDocument();

    // Fermé, le panneau ne doit rien laisser d'utilisable : c'est ce qui rendait
    // la création introuvable quand le dépliant passait pour une simple légende.
    expect(screen.queryByLabelText('Nom du nouveau projet')).not.toBeVisible();
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

  test('le bandeau projets vit hors du journal et reste utilisable replié', async () => {
    const user = userEvent.setup();
    seedData(api.db, {
      projects: [{ id: 'pr_a', name: 'Alpha' }],
      entries: [{ id: 'en_a', title: 'Entrée Alpha', project_id: 'pr_a' }],
    });
    render(<App />);
    await screen.findByRole('region', { name: 'Journal' });

    // Ni dans le panneau journal, ni dans l'en-tête : un bandeau global.
    const strip = document.querySelector('.project-strip') as HTMLElement;
    expect(strip).toBeInTheDocument();
    expect(within(strip).getByRole('group', { name: 'Filtrer par projet' })).toBeVisible();
    expect(document.querySelector('#workspace-journal .projects')).toBeNull();

    // Journal replié (jsdom n'applique pas les feuilles de style : on lit les
    // classes, comme les tests des panneaux) : filtrer reste possible.
    await user.click(screen.getByRole('button', { name: 'Journal' }));
    expect(document.querySelector('.columns')).toHaveClass('hide-left');
    const chips = within(strip).getByRole('group', { name: 'Filtrer par projet' });
    await user.click(within(chips).getByRole('button', { name: 'Alpha' }));
    await waitFor(() => expect(within(chips).getByRole('button', { name: 'Alpha' })).toHaveAttribute('aria-pressed', 'true'));
    expect(localStorage.getItem('worklogs-project')).toBe('pr_a');
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
});

describe('dossier partagé', () => {
  // Le « partage » est un dossier temporaire : le test y joue le collègue du TSE.
  let share: string;
  const nodeFs = () => import('node:fs');
  const nodePath = () => import('node:path');
  const write = async (rel: string, contents: string | Uint8Array) => {
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.writeFileSync(path.join(share, rel), contents);
  };
  const read = async (rel: string, encoding: BufferEncoding = 'utf8') => {
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    return fs.readFileSync(path.join(share, rel), encoding);
  };
  const latin1 = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));
  /** Fichier `~$` qu'Excel laisse à côté d'un fichier ouvert (nom UTF-16 à l'octet 55). */
  const excelOwner = (name: string) => {
    const bytes = new Uint8Array(165).fill(0x20);
    bytes[0] = name.length;
    bytes[55] = name.length;
    bytes[56] = 0;
    [...name].forEach((char, i) => { bytes[57 + i * 2] = char.charCodeAt(0); bytes[58 + i * 2] = 0; });
    return bytes;
  };
  const sharedEditor = () => screen.getByRole('region', { name: 'Fichier partagé' });
  const openFromTree = async (name: string) => {
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^Ouvrir ${name.replace(/[.()]/g, '\\$&')}`) }));
    return screen.findByRole('region', { name: 'Fichier partagé' });
  };

  beforeEach(async () => {
    const [fs, os, path] = await Promise.all([nodeFs(), import('node:os'), nodePath()]);
    share = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-share-front-'));
    await api.close();
    api = await useRealApi({ sharedRoot: share });
    // La section vit dans la colonne Procédures : elle ne lit le partage qu'affichée.
    localStorage.setItem('worklogs-show-procedures', '1');
  });
  afterEach(async () => {
    const fs = await nodeFs();
    fs.rmSync(share, { recursive: true, force: true });
  });

  test('colonne Procédures masquée : aucune lecture du partage', async () => {
    localStorage.setItem('worklogs-show-procedures', '0');
    const spy = vi.spyOn(clientApi, 'sharedStatus');
    render(<App />);
    await screen.findByRole('region', { name: 'Journal' });
    expect(spy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Procédures/ }));
    expect(await screen.findByText('Dossier partagé')).toBeInTheDocument();
  });

  test('sans partage configuré, la section n’existe pas', async () => {
    await api.close();
    api = await useRealApi();
    render(<App />);
    await screen.findByRole('region', { name: 'Journal' });
    await waitFor(() => expect(screen.queryByText('Dossier partagé')).not.toBeInTheDocument());
  });

  test('un CSV d’Excel s’ouvre au centre ; il ne part sur le partage qu’au geste, ligne touchée seule', async () => {
    const original = 'Date;Mesure;Commentaire\r\n05/10/2026;12,5;"pH ; chlore"\r\n06/10/2026;0123;\r\n';
    await write('relevés.csv', latin1(original));
    render(<App />);
    expect(await screen.findByText('Dossier partagé')).toBeInTheDocument();
    const editorRegion = await openFromTree('relevés.csv');

    const grid = await within(editorRegion).findByRole('grid', { name: 'Tableau relevés.csv' });
    fireEvent.click(within(grid).getByRole('gridcell', { name: 'C3 : vide' }));
    fireEvent.change(within(editorRegion).getByLabelText('Contenu de la cellule'), { target: { value: 'Filtre lavé' } });
    await waitFor(() => expect(within(editorRegion).getByText('Brouillon sur cet ordinateur')).toBeInTheDocument());
    expect(await read('relevés.csv', 'latin1')).toBe(original);

    fireEvent.click(within(editorRegion).getByRole('button', { name: 'Enregistrer sur le partage' }));
    await waitFor(() => expect(within(sharedEditor()).getByText('Enregistré sur le partage.')).toBeInTheDocument());
    expect(await read('relevés.csv', 'latin1')).toBe('Date;Mesure;Commentaire\r\n05/10/2026;12,5;"pH ; chlore"\r\n06/10/2026;0123;Filtre lavé\r\n');
    expect(within(sharedEditor()).getByText('À jour avec le partage')).toBeInTheDocument();
  });

  test('Ctrl+S envoie un fichier texte, encodage et fins de ligne gardés', async () => {
    await write('notes.md', '# Consignes\r\n\r\nLaver le filtre.\r\n');
    render(<App />);
    const editorRegion = await openFromTree('notes.md');
    const area = await within(editorRegion).findByLabelText('Contenu de notes.md');
    expect(area).toHaveValue('# Consignes\n\nLaver le filtre.\n');
    fireEvent.change(area, { target: { value: '# Consignes\n\nLaver le filtre.\nContrôler le pH.\n' } });
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await waitFor(async () => expect(await read('notes.md')).toBe('# Consignes\r\n\r\nLaver le filtre.\r\nContrôler le pH.\r\n'));
  });

  test('ouvert dans Excel par un collègue : lecture seule avec son nom, brouillon possible sur demande', async () => {
    await write('relevés.csv', 'a;b\n1;2\n');
    await write('~$relevés.csv', excelOwner('Jean Dupont'));
    render(<App />);
    expect(await screen.findByRole('button', { name: /^Ouvrir relevés\.csv — Ouvert par Jean Dupont dans Excel/ })).toBeInTheDocument();
    const editorRegion = await openFromTree('relevés.csv');
    expect(await within(editorRegion).findByText(/Lecture seule — Ouvert par Jean Dupont dans Excel/)).toBeInTheDocument();
    expect(within(editorRegion).getByRole('grid')).toHaveAttribute('aria-readonly', 'true');
    fireEvent.click(within(editorRegion).getByRole('button', { name: 'Écrire un brouillon quand même' }));
    expect(within(editorRegion).getByRole('grid')).not.toHaveAttribute('aria-readonly');
  });

  test('conflit : un collègue enregistre pendant mon brouillon — rien n’est écrasé, « garder les deux »', async () => {
    await write('notes.md', 'v1\n');
    render(<App />);
    const editorRegion = await openFromTree('notes.md');
    fireEvent.change(await within(editorRegion).findByLabelText('Contenu de notes.md'), { target: { value: 'v1\nmoi\n' } });
    await waitFor(() => expect(within(editorRegion).getByText('Brouillon sur cet ordinateur')).toBeInTheDocument());
    await write('notes.md', 'v1\ncollègue\n');

    fireEvent.click(within(editorRegion).getByRole('button', { name: 'Enregistrer sur le partage' }));
    const alert = await within(sharedEditor()).findByRole('alert');
    expect(alert).toHaveTextContent('Rien n’a été écrasé');
    expect(await read('notes.md')).toBe('v1\ncollègue\n');

    fireEvent.click(within(alert).getByRole('button', { name: 'Garder les deux' }));
    await waitFor(() => expect(within(sharedEditor()).getByLabelText('Contenu de notes.md')).toHaveValue('v1\ncollègue\n'));
    const [fs] = await Promise.all([nodeFs()]);
    const copy = fs.readdirSync(share).find((name) => name.startsWith('notes (copie '));
    expect(copy).toBeDefined();
    expect(await read(copy!)).toBe('v1\nmoi\n');
    expect(within(sharedEditor()).getByRole('button', { name: copy })).toBeInTheDocument();
  });

  test('conflit sur des lignes différentes : « Fusionner » garde les deux modifications', async () => {
    await write('relevés.csv', 'Date;Mesure\n05/10;12,5\n06/10;13\n');
    render(<App />);
    const editorRegion = await openFromTree('relevés.csv');
    const grid = await within(editorRegion).findByRole('grid', { name: 'Tableau relevés.csv' });
    fireEvent.click(within(grid).getByRole('gridcell', { name: 'B3 : 13' }));
    fireEvent.change(within(editorRegion).getByLabelText('Contenu de la cellule'), { target: { value: '14,2' } });
    await waitFor(() => expect(within(editorRegion).getByText('Brouillon sur cet ordinateur')).toBeInTheDocument());
    // Le collègue corrige l'autre ligne dans Excel.
    await write('relevés.csv', 'Date;Mesure\n05/10;12,8\n06/10;13\n');

    fireEvent.click(within(editorRegion).getByRole('button', { name: 'Enregistrer sur le partage' }));
    const alert = await within(sharedEditor()).findByRole('alert');
    expect(await within(alert).findByText(/Vos modifications ne se touchent pas : « Fusionner » garde les deux \(1 modification de ta part ajoutée à leur version\)/)).toBeInTheDocument();
    fireEvent.click(within(alert).getByRole('button', { name: 'Fusionner' }));
    await waitFor(async () => expect(await read('relevés.csv')).toBe('Date;Mesure\n05/10;12,8\n06/10;14,2\n'));
    expect(await within(sharedEditor()).findByText(/Fusionné et enregistré sur le partage/)).toBeInTheDocument();
    expect(within(sharedEditor()).getByRole('grid', { name: 'Tableau relevés.csv' })).toBeInTheDocument();
    expect(within(sharedEditor()).getByRole('gridcell', { name: 'B2 : 12,8' })).toBeInTheDocument();
    expect(within(sharedEditor()).getByRole('gridcell', { name: 'B3 : 14,2' })).toBeInTheDocument();
  });

  test('conflit sur la même ligne : pas de fusion, la raison est dite', async () => {
    await write('notes.md', 'v1\n');
    render(<App />);
    const editorRegion = await openFromTree('notes.md');
    fireEvent.change(await within(editorRegion).findByLabelText('Contenu de notes.md'), { target: { value: 'v1 moi\n' } });
    await waitFor(() => expect(within(editorRegion).getByText('Brouillon sur cet ordinateur')).toBeInTheDocument());
    await write('notes.md', 'v1 collègue\n');
    fireEvent.click(within(editorRegion).getByRole('button', { name: 'Enregistrer sur le partage' }));
    const alert = await within(sharedEditor()).findByRole('alert');
    expect(await within(alert).findByText('Fusion impossible : vous avez modifié tous les deux la ligne 1.')).toBeInTheDocument();
    expect(within(alert).queryByRole('button', { name: 'Fusionner' })).not.toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Garder ma version' })).toBeInTheDocument();
  });

  test('chercher dans le partage : un fichier s’ouvre, un dossier se déplie dans l’arbre', async () => {
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, 'Global', 'MURGAT INGENIERIE', '00. PROCEDURE'), { recursive: true });
    await write('Global/MURGAT INGENIERIE/00. PROCEDURE/Procédure filtration.md', '# Filtration\n');
    await write('notes.md', 'x');
    render(<App />);
    const field = await screen.findByLabelText('Chercher dans le partage');
    fireEvent.change(field, { target: { value: 'procedure' } });
    const results = await screen.findByRole('region', { name: 'Résultats de la recherche' });
    expect(await within(results).findByText('2 résultats.')).toBeInTheDocument();
    fireEvent.click(within(results).getByRole('button', { name: 'Ouvrir Global/MURGAT INGENIERIE/00. PROCEDURE/Procédure filtration.md' }));
    const editorRegion = await screen.findByRole('region', { name: 'Fichier partagé' });
    expect(await within(editorRegion).findByLabelText('Contenu de Procédure filtration.md')).toHaveValue('# Filtration\n');

    fireEvent.click(within(screen.getByRole('region', { name: 'Résultats de la recherche' })).getByRole('button', { name: 'Afficher le dossier Global/MURGAT INGENIERIE/00. PROCEDURE' }));
    expect(field).toHaveValue('');
    expect(await screen.findByRole('list', { name: 'Contenu de Global/MURGAT INGENIERIE/00. PROCEDURE' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dossier 00. PROCEDURE' })).toHaveAttribute('aria-expanded', 'true');
  });

  test('hors ligne : l’arbre reste celui vu en dernier, les fichiers non gardés ici sont signalés', async () => {
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, 'Global'));
    await write('Global/Procédure filtration.md', '# Filtration\n');
    await write('Global/relevés.csv', 'a;b\n');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dossier Global' }));
    const editorRegion = await openFromTree('relevés.csv');
    // Ouvert pour de bon (lu, donc gardé ici) avant que le partage ne tombe.
    await within(editorRegion).findByRole('grid', { name: 'Tableau relevés.csv' });
    fs.renameSync(share, share + '-ailleurs');
    try {
      act(() => { window.dispatchEvent(new Event('focus')); });
      expect(await screen.findAllByText(/^Hors ligne — liste vue /)).not.toHaveLength(0);
      const missing = await screen.findByRole('button', { name: /^Ouvrir Procédure filtration\.md — pas gardé sur cet ordinateur/ });
      expect(missing).toBeDisabled();
      expect(screen.getByRole('button', { name: /^Ouvrir relevés\.csv/ })).toBeEnabled();
    } finally {
      fs.renameSync(share + '-ailleurs', share);
    }
  });

  test('sans brouillon, la version du collègue s’affiche d’elle-même au retour sur la fenêtre', async () => {
    await write('notes.md', 'v1\n');
    render(<App />);
    const editorRegion = await openFromTree('notes.md');
    expect(await within(editorRegion).findByLabelText('Contenu de notes.md')).toHaveValue('v1\n');
    await write('notes.md', 'v2 du collègue\n');
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(within(sharedEditor()).getByLabelText('Contenu de notes.md')).toHaveValue('v2 du collègue\n'));
    expect(within(sharedEditor()).getByText('Mis à jour depuis le partage.')).toBeInTheDocument();
  });

  test('un brouillon survit à la fermeture et se retrouve à la réouverture', async () => {
    await write('notes.md', 'v1\n');
    const { unmount } = render(<App />);
    const editorRegion = await openFromTree('notes.md');
    fireEvent.change(await within(editorRegion).findByLabelText('Contenu de notes.md'), { target: { value: 'v1\nen cours\n' } });
    await flushPendingSaves();
    unmount();
    render(<App />);
    expect(await within(await screen.findByRole('region', { name: 'Fichier partagé' })).findByLabelText('Contenu de notes.md')).toHaveValue('v1\nen cours\n');
    expect(await read('notes.md')).toBe('v1\n');
  });

  const exists = async (rel: string) => {
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    return fs.existsSync(path.join(share, rel));
  };
  const typeIn = async (name: string, value: string) => {
    const area = await within(sharedEditor()).findByLabelText(`Contenu de ${name}`);
    fireEvent.change(area, { target: { value } });
    return area;
  };

  test('la première frappe prend la main (verrou à mon nom) ; fermer avec un brouillon pose la question', async () => {
    await write('notes.md', 'v1\n');
    render(<App />);
    await openFromTree('notes.md');
    expect(await exists('.~lock.notes.md#')).toBe(false);
    await typeIn('notes.md', 'v1\nmoi\n');
    await waitFor(async () => expect(await exists('.~lock.notes.md#')).toBe(true));
    expect(await read('.~lock.notes.md#')).toMatch(/\(WorkLogs\),.*worklogs:test:/);
    expect(await within(sharedEditor()).findByText('Tu as la main')).toBeInTheDocument();

    fireEvent.click(within(sharedEditor()).getByRole('button', { name: 'Fermer' }));
    const question = await screen.findByRole('dialog', { name: 'Tes modifications ne sont pas sur le partage' });
    fireEvent.click(within(question).getByRole('button', { name: 'Garder le brouillon ici' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Fichier partagé' })).not.toBeInTheDocument());
    await waitFor(async () => expect(await exists('.~lock.notes.md#')).toBe(false));
    expect(await read('notes.md')).toBe('v1\n');

    await openFromTree('notes.md');
    expect(await within(sharedEditor()).findByLabelText('Contenu de notes.md')).toHaveValue('v1\nmoi\n');
  });

  test('quitter vers une entrée : « Envoyer sur le partage » l’enregistre, puis ouvre l’entrée', async () => {
    seedData(api.db, { entries: [{ id: 'en_1', title: 'Compte rendu' }] });
    await write('notes.md', 'v1\n');
    render(<App />);
    await openFromTree('notes.md');
    await typeIn('notes.md', 'v1\nenvoyé\n');
    await waitFor(() => expect(within(sharedEditor()).getByText('Brouillon sur cet ordinateur')).toBeInTheDocument());
    fireEvent.click(await within(journal()).findByText('Compte rendu'));
    const question = await screen.findByRole('dialog', { name: 'Tes modifications ne sont pas sur le partage' });
    fireEvent.click(within(question).getByRole('button', { name: 'Envoyer sur le partage' }));
    expect(await screen.findByRole('region', { name: 'Entrée' })).toBeInTheDocument();
    expect(await read('notes.md')).toBe('v1\nenvoyé\n');
  });

  test('« Annuler » garde le fichier ouvert', async () => {
    seedData(api.db, { entries: [{ id: 'en_1', title: 'Compte rendu' }] });
    await write('notes.md', 'v1\n');
    render(<App />);
    await openFromTree('notes.md');
    await typeIn('notes.md', 'v1\nen cours\n');
    fireEvent.click(await within(journal()).findByText('Compte rendu'));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Annuler' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(sharedEditor()).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Entrée' })).not.toBeInTheDocument();
  });

  test('un collègue ouvre le fichier dans LibreOffice après moi : ma frappe passe en lecture seule, gardée en brouillon', async () => {
    await write('planning.txt', 'lundi\n');
    render(<App />);
    await openFromTree('planning.txt');
    await write('.~lock.planning.txt#', 'Hélène Martin,hmartin,TSE01,05.10.2026 09:00,file:///C:/x;');
    const area = await typeIn('planning.txt', 'lundi\nmardi\n');
    expect(await within(sharedEditor()).findByText(/Lecture seule — Ouvert par Hélène Martin dans LibreOffice/)).toBeInTheDocument();
    expect(area).toHaveAttribute('readonly');
    await flushPendingSaves();
    expect((await clientApi.sharedFile('planning.txt')).draft?.model).toMatchObject({ text: 'lundi\nmardi\n' });
    expect(await read('.~lock.planning.txt#')).toMatch(/^Hélène Martin/);
  });

  test('relier un projet à un sous-dossier : son filtre n’affiche que lui', async () => {
    seedData(api.db, { projects: [{ id: 'pr_p', name: 'Piscine' }] });
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, 'Piscine'));
    await write('Piscine/consignes.md', '# Consignes');
    await write('autre.md', 'x');
    render(<App />);
    expect(await screen.findByRole('button', { name: /^Ouvrir autre\.md/ })).toBeInTheDocument();
    fireEvent.click(within(filters()).getByRole('button', { name: /Piscine/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Relier Piscine à un dossier…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Relier Piscine au dossier Piscine' }));
    expect(await screen.findByRole('button', { name: /^Ouvrir consignes\.md/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Ouvrir autre\.md/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Délier Piscine de son dossier' }));
    expect(await screen.findByRole('button', { name: /^Ouvrir autre\.md/ })).toBeInTheDocument();
  });

  test('projet relié à un dossier absent du partage : on le dit, « Délier » rend tout le partage', async () => {
    seedData(api.db, { projects: [{ id: 'pr_w', name: 'work-logs' }] });
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, 'Global'));
    await write('notes.md', 'x');
    await clientApi.linkSharedFolder('pr_w', 'Global');
    // Le dossier disparaît du partage (ou la racine a changé) : le lien ne mène plus nulle part.
    fs.rmdirSync(path.join(share, 'Global'));
    render(<App />);
    fireEvent.click(await within(filters()).findByRole('button', { name: /work-logs/ }));
    expect(await screen.findByText('Le dossier relié à work-logs (« Global ») n’est pas dans ce partage. « Délier work-logs de son dossier » affiche tout le partage.')).toHaveAttribute('role', 'alert');
    fireEvent.click(screen.getByRole('button', { name: 'Délier work-logs de son dossier' }));
    expect(await screen.findByRole('button', { name: /^Ouvrir notes\.md/ })).toBeInTheDocument();
  });

  test('nouveau fichier : créé dans le dossier déplié, ouvert au centre ; un nom pris n’écrase rien', async () => {
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, '00. PROCEDURE'));
    await write('00. PROCEDURE/existant.md', 'à garder\n');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dossier 00. PROCEDURE' }));
    await screen.findByRole('button', { name: /^Ouvrir existant\.md/ });

    fireEvent.click(screen.getByRole('button', { name: '＋ Nouveau fichier…' }));
    const form = screen.getByRole('form', { name: 'Nouveau fichier' });
    expect(within(form).getByLabelText('Dossier du nouveau fichier')).toHaveValue('00. PROCEDURE');
    fireEvent.change(within(form).getByLabelText('Type de fichier'), { target: { value: 'md' } });
    fireEvent.change(within(form).getByLabelText('Nom du fichier'), { target: { value: 'Procédure sauvegarde' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Créer' }));
    const editorRegion = await screen.findByRole('region', { name: 'Fichier partagé' });
    expect(await within(editorRegion).findByLabelText('Contenu de Procédure sauvegarde.md')).toHaveValue('# Procédure sauvegarde\n\n');
    expect(await read('00. PROCEDURE/Procédure sauvegarde.md')).toBe('# Procédure sauvegarde\n\n');
    expect(screen.getByRole('button', { name: /^Ouvrir Procédure sauvegarde\.md/ })).toBeInTheDocument();

    // Un nom déjà pris : refusé, l'existant intact.
    fireEvent.click(screen.getByRole('button', { name: '＋ Nouveau fichier…' }));
    const again = screen.getByRole('form', { name: 'Nouveau fichier' });
    fireEvent.change(within(again).getByLabelText('Type de fichier'), { target: { value: 'md' } });
    fireEvent.change(within(again).getByLabelText('Nom du fichier'), { target: { value: 'existant' } });
    fireEvent.click(within(again).getByRole('button', { name: 'Créer' }));
    expect(await screen.findByText('« existant.md » existe déjà dans ce dossier : rien n’a été écrasé. Choisis un autre nom.')).toBeInTheDocument();
    expect(await read('00. PROCEDURE/existant.md')).toBe('à garder\n');
  });

  test('nouveau document Word à la racine : il s’ouvre dans l’éditeur Word, titré de son nom', async () => {
    await write('notes.md', 'x');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '＋ Nouveau fichier…' }));
    const form = screen.getByRole('form', { name: 'Nouveau fichier' });
    expect(within(form).getByLabelText('Type de fichier')).toHaveValue('docx');
    fireEvent.change(within(form).getByLabelText('Nom du fichier'), { target: { value: 'Compte rendu' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Créer' }));
    const editorRegion = await screen.findByRole('region', { name: 'Fichier partagé' });
    const content = await within(editorRegion).findByRole('textbox', { name: 'Contenu du document Word' });
    expect(content.querySelector('h1')).toHaveTextContent('Compte rendu');
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    expect(fs.existsSync(path.join(share, 'Compte rendu.docx'))).toBe(true);
  });

  test('l’historique restaure une ancienne version en brouillon, puis l’envoi la remet sur le partage', async () => {
    await write('notes.md', 'version 1\n');
    render(<App />);
    await openFromTree('notes.md');
    expect(await within(sharedEditor()).findByLabelText('Contenu de notes.md')).toHaveValue('version 1\n');
    await write('notes.md', 'version 2 du collègue\n');
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(within(sharedEditor()).getByLabelText('Contenu de notes.md')).toHaveValue('version 2 du collègue\n'));

    fireEvent.click(within(sharedEditor()).getByText('Historique sur cet ordinateur'));
    const buttons = await within(sharedEditor()).findAllByRole('button', { name: /^Restaurer la version du/ });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]);
    await waitFor(() => expect(within(sharedEditor()).getByLabelText('Contenu de notes.md')).toHaveValue('version 1\n'));
    expect(within(sharedEditor()).getByText(/restaurée en brouillon/)).toBeInTheDocument();
    expect(await read('notes.md')).toBe('version 2 du collègue\n');
    fireEvent.click(within(sharedEditor()).getByRole('button', { name: 'Enregistrer sur le partage' }));
    await waitFor(async () => expect(await read('notes.md')).toBe('version 1\n'));
  });

  test('Paramètres › Dossier partagé : le nom affiché dans mes verrous', async () => {
    await write('notes.md', 'v1\n');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Compte et paramètres' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Paramètres' }));
    const settings = within(await screen.findByRole('region', { name: 'Dossier partagé' }));
    const input = await settings.findByLabelText('Nom affiché dans les verrous');
    fireEvent.change(input, { target: { value: 'T. Grollier' } });
    fireEvent.click(settings.getByRole('button', { name: 'Enregistrer' }));
    expect(await settings.findByText('Enregistré.')).toBeInTheDocument();
    expect((await clientApi.sharedStatus()).displayName).toBe('T. Grollier');
  });

  test('un document Word s’ouvre dans son éditeur ; changer un style ne réécrit que ce paragraphe', async () => {
    const { wordDocx } = await import('./test/docx-fixture');
    const { readZip, readZipText } = await import('./zip');
    const original = wordDocx();
    await write('Procédure filtration.docx', original);
    await clientApi.setSharedDisplayName('T. Grollier');
    render(<App />);
    const editorRegion = await openFromTree('Procédure filtration.docx');
    const content = await within(editorRegion).findByRole('textbox', { name: 'Contenu du document Word' });
    expect(content).toHaveTextContent('Filtration');
    expect(content.querySelector('h1')).toHaveTextContent('Filtration');
    expect(within(editorRegion).getByText(/Image — conservé/)).toBeInTheDocument();
    expect(within(editorRegion).getByText(/Table des matières — conservé/)).toBeInTheDocument();
    await waitFor(() => expect(content.querySelector('[data-marker="1."]')).toHaveTextContent('Arrêter la pompe'));
    expect(content.querySelector('[data-marker="a)"]')).toHaveTextContent('Vanne fermée');

    const style = within(editorRegion).getByLabelText('Style du paragraphe');
    expect(style).toHaveValue('Titre1');
    fireEvent.change(style, { target: { value: '' } });
    await waitFor(() => expect(within(sharedEditor()).getByText('Brouillon sur cet ordinateur')).toBeInTheDocument());
    fireEvent.click(within(sharedEditor()).getByRole('button', { name: 'Enregistrer sur le partage' }));
    await waitFor(() => expect(within(sharedEditor()).getByText('Enregistré sur le partage.')).toBeInTheDocument());

    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    const sent = new Uint8Array(fs.readFileSync(path.join(share, 'Procédure filtration.docx')));
    const before = (await readZipText(readZip(original), 'word/document.xml'))!;
    const after = (await readZipText(readZip(sent), 'word/document.xml'))!;
    expect(after).toBe(before.replace('<w:pPr><w:pStyle w:val="Titre1"/><w:spacing w:after="120"/></w:pPr><w:bookmarkStart w:id="0" w:name="_Toc1"/><w:r><w:t>Filtration</w:t></w:r>',
      '<w:pPr><w:spacing w:after="120"/></w:pPr><w:bookmarkStart w:id="0" w:name="_Toc1"/><w:r><w:t xml:space="preserve">Filtration</w:t></w:r>'));
    expect(await readZipText(readZip(sent), 'docProps/core.xml')).toContain('<cp:lastModifiedBy>T. Grollier</cp:lastModifiedBy>');
  });

  test('document Word en suivi des modifications : lecture seule, raison donnée', async () => {
    const { wordDocx } = await import('./test/docx-fixture');
    await write('suivi.docx', wordDocx({ trackRevisions: true }));
    render(<App />);
    const editorRegion = await openFromTree('suivi.docx');
    expect(await within(editorRegion).findByText(/Le suivi des modifications est activé/)).toBeInTheDocument();
    expect(within(editorRegion).getByLabelText('Style du paragraphe')).toBeDisabled();
    expect(within(editorRegion).getByRole('textbox', { name: 'Contenu du document Word' })).toHaveAttribute('contenteditable', 'false');
  });

  test('un classeur Excel s’ouvre dans la grille ; une cellule modifiée, seule sa balise change', async () => {
    const { excelWorkbook } = await import('./test/xlsx-fixture');
    const { readZip, readZipText } = await import('./zip');
    const original = excelWorkbook();
    await write('Budget atelier.xlsx', original);
    await clientApi.setSharedDisplayName('T. Grollier');
    render(<App />);
    const editorRegion = await openFromTree('Budget atelier.xlsx');
    const grid = await within(editorRegion).findByRole('grid', { name: 'Feuille Suivi' });
    expect(within(grid).getByRole('gridcell', { name: 'B2 : 1 234,50 €' })).toHaveClass('is-numeric');
    expect(within(grid).getByRole('gridcell', { name: 'C2 : 05/10/2026' })).toBeInTheDocument();
    const bar = within(editorRegion).getByLabelText('Contenu de la cellule');

    // La barre montre la formule, en français.
    fireEvent.click(within(grid).getByRole('gridcell', { name: 'B4 : 1 334,50 €' }));
    expect(bar).toHaveValue('=SOMME(B2:B3)');
    // Fusionnée : la raison, pas de saisie.
    fireEvent.click(within(grid).getByRole('gridcell', { name: 'B5 : vide' }));
    expect(within(editorRegion).getByText(/B5 : Cellule fusionnée avec A5/)).toBeInTheDocument();
    expect(bar).toHaveAttribute('readonly');

    const target = within(grid).getByRole('gridcell', { name: 'B3 : 100,00 €' });
    fireEvent.click(target);
    fireEvent.keyDown(target, { key: '2' });
    fireEvent.change(bar, { target: { value: '250' } });
    fireEvent.keyDown(bar, { key: 'Enter' });
    expect(within(grid).getByRole('gridcell', { name: 'B3 : 250,00 €' })).toBeInTheDocument();
    await waitFor(() => expect(within(sharedEditor()).getByText('Brouillon sur cet ordinateur')).toBeInTheDocument());

    fireEvent.click(within(sharedEditor()).getByRole('button', { name: 'Enregistrer sur le partage' }));
    await waitFor(() => expect(within(sharedEditor()).getByText('Enregistré sur le partage.')).toBeInTheDocument());
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    const sent = new Uint8Array(fs.readFileSync(path.join(share, 'Budget atelier.xlsx')));
    const sheet = (await readZipText(readZip(sent), 'xl/worksheets/sheet1.xml'))!;
    expect(sheet).toContain('<c r="B3" s="2"><v>250</v></c>');
    expect(sheet).toContain('<c r="B2" s="2"><v>1234.5</v></c>');
    expect(await readZipText(readZip(sent), 'xl/sharedStrings.xml')).toBe(await readZipText(readZip(original), 'xl/sharedStrings.xml'));
    expect(await readZipText(readZip(sent), 'docProps/core.xml')).toContain('<cp:lastModifiedBy>T. Grollier</cp:lastModifiedBy>');
    // Relu depuis le partage : la formule qui lit B3 attend son recalcul, WorkLogs la montre.
    await waitFor(() => expect(within(sharedEditor()).getByRole('gridcell', { name: 'B4 : =SOMME(B2:B3)' })).toBeInTheDocument());
  });

  test('classeur : feuille masquée et protégée, formule fautive signalée avant l’envoi', async () => {
    const { excelWorkbook } = await import('./test/xlsx-fixture');
    const original = excelWorkbook();
    await write('Budget.xlsx', original);
    render(<App />);
    const editorRegion = await openFromTree('Budget.xlsx');
    await within(editorRegion).findByRole('grid', { name: 'Feuille Suivi' });
    const sheets = within(editorRegion).getByLabelText('Feuille');
    expect([...(sheets as HTMLSelectElement).options].map((option) => option.text)).toEqual(['Suivi', 'Paramètres (masquée)', 'Résumé']);
    fireEvent.change(sheets, { target: { value: '1' } });
    const grid = await within(editorRegion).findByRole('grid', { name: 'Feuille Paramètres' });
    fireEvent.click(within(grid).getByRole('gridcell', { name: 'A1 : Taux' }));
    expect(within(editorRegion).getByText(/A1 : Feuille protégée dans Excel/)).toBeInTheDocument();

    fireEvent.change(sheets, { target: { value: '0' } });
    const suivi = await within(editorRegion).findByRole('grid', { name: 'Feuille Suivi' });
    fireEvent.click(within(suivi).getByRole('gridcell', { name: 'B3 : 100,00 €' }));
    fireEvent.change(within(editorRegion).getByLabelText('Contenu de la cellule'), { target: { value: '=SOMME(B2' } });
    const problems = await within(editorRegion).findByRole('alert', { name: 'À corriger avant l’envoi' });
    expect(problems).toHaveTextContent(/Suivi!B3 : formule incomprise \(parenthèse/);
    fireEvent.click(within(sharedEditor()).getByRole('button', { name: 'Enregistrer sur le partage' }));
    await waitFor(() => expect(within(sharedEditor()).getAllByText(/formule incomprise/).length).toBeGreaterThan(1));
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    expect(Buffer.from(fs.readFileSync(path.join(share, 'Budget.xlsx'))).equals(Buffer.from(original))).toBe(true);
  });

  test('dossier fermé au compte du montage : « accès refusé » sous ce dossier, pas « Lecture… » sans fin', async () => {
    if (process.getuid?.() === 0) return; // root lit partout : test sans objet.
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, 'Global', 'MURGAT INGENIERIE'), { recursive: true });
    await write('notes.md', 'y');
    fs.chmodSync(path.join(share, 'Global'), 0o000);
    try {
      render(<App />);
      fireEvent.click(await screen.findByRole('button', { name: 'Dossier Global' }));
      expect(await screen.findByText(/Accès refusé à ce dossier : le compte avec lequel le partage est monté n’y a pas droit/)).toHaveAttribute('role', 'alert');
      expect(screen.queryByText('Lecture…')).not.toBeInTheDocument();
      // Le reste de l'arbre reste utilisable.
      expect(screen.getByRole('button', { name: /^Ouvrir notes\.md/ })).toBeInTheDocument();
    } finally {
      fs.chmodSync(path.join(share, 'Global'), 0o755);
    }
  });

  test('choisir une entrée referme le fichier partagé', async () => {
    seedData(api.db, { entries: [{ id: 'en_1', title: 'Compte rendu' }] });
    await write('notes.md', 'v1\n');
    render(<App />);
    await openFromTree('notes.md');
    fireEvent.click(await within(journal()).findByText('Compte rendu'));
    expect(await screen.findByRole('region', { name: 'Entrée' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Fichier partagé' })).not.toBeInTheDocument();
  });
});
