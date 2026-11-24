import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRoot } from 'react-dom/client';
import App from './App';
import { EntryEditor } from './components/EntryEditor';
import { seedData } from './test/server';
import { flushPendingSaves } from './autosave';
import { setLeaveGuard } from './shared-leave';
import { api as clientApi, type Project } from './lib';
import { TaskAdvice } from './components/TaskAdvice';
import { useAppHarness, api, journal, board, editor, filters, aiAction, row, seedGoogleLink, aiBodies, mockAiSuggest, openProjects } from './test/app-harness';

useAppHarness();

describe('catégories et sous-catégories', () => {
  // Requêtes DOM directes : un getByRole sur toute l'application, à chaque geste, coûtait des secondes sous charge.
  const trigger = () => document.querySelector<HTMLButtonElement>('.category-trigger')!;
  /** La fenêtre des catégories, ouverte depuis le bandeau des projets si besoin. */
  const categories = () => {
    if (trigger().getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger());
    return within(document.querySelector<HTMLElement>('.category-sheet')!);
  };
  const showCategory = async (name: string) => fireEvent.click(await categories().findByRole('button', { name }));
  const createCategory = (name: string, parent_id?: string) => clientApi.createCategory({ name, project_id: 'p', parent_id });

  test('crée une catégorie et sa sous-catégorie puis les renomme, regroupe et supprime sans perdre les notes', async () => {
    // Chaque attente couvre un aller-retour serveur et la relecture de l'état : sous charge, plus d'une seconde.
    const backend = { timeout: 5000 };
    seedData(api.db, { projects: [{ id: 'p', name: 'Chantier' }] });
    render(<App />);
    // Premier test du fichier : il paie aussi le démarrage du worker jsdom.
    await screen.findByRole('button', { name: 'Chantier' }, backend);
    fireEvent.click(categories().getByRole('button', { name: '＋ Catégorie' }));
    fireEvent.change(categories().getByLabelText('Nom de la catégorie'), { target: { value: 'Préparation' } });
    fireEvent.click(categories().getByRole('button', { name: 'Enregistrer la catégorie' }));
    fireEvent.click(await categories().findByRole('button', { name: 'Ajouter une sous-catégorie à Préparation' }, backend));
    fireEvent.change(categories().getByLabelText('Nom de la catégorie'), { target: { value: 'Devis' } });
    fireEvent.click(categories().getByRole('button', { name: 'Enregistrer la catégorie' }));
    await categories().findByRole('button', { name: 'Modifier la catégorie Devis' }, backend);
    const parent = row(api.db, 'SELECT * FROM categories WHERE name=?', 'Préparation');
    const child = row(api.db, 'SELECT * FROM categories WHERE name=?', 'Devis');
    expect(child.parent_id).toBe(parent.id);
    const note = await clientApi.createEntry({ title: 'Note classée', project_id: 'p', category_id: child.id as string });
    fireEvent.click(categories().getByRole('button', { name: 'Modifier la catégorie Devis' }));
    fireEvent.change(categories().getByLabelText('Nom de la catégorie'), { target: { value: 'Contrats' } });
    fireEvent.change(categories().getByLabelText('Catégorie parente'), { target: { value: '' } });
    fireEvent.click(categories().getByRole('button', { name: 'Enregistrer la catégorie' }));
    await categories().findByRole('button', { name: 'Modifier la catégorie Contrats' }, backend);
    expect(row(api.db, 'SELECT * FROM categories WHERE id=?', child.id).parent_id).toBeNull();
    fireEvent.click(categories().getByRole('button', { name: 'Supprimer la catégorie Contrats' }));
    await waitFor(() => expect(categories().queryByRole('button', { name: 'Modifier la catégorie Contrats' })).not.toBeInTheDocument(), backend);
    expect((await clientApi.entry(note.id)).category_id).toBeNull();
    await within(journal()).findByText('Note classée');
  }, 15_000);

  test('filtre ensemble entrées et tâches, inclut les descendants et hérite du filtre à la création', async () => {
    seedData(api.db, { projects: [{ id: 'p', name: 'Chantier' }] });
    const parent = await createCategory('Préparation');
    const child = await createCategory('Devis', parent.id);
    await clientApi.createEntry({ title: 'Note devis', project_id: 'p', category_id: child.id });
    await clientApi.createEntry({ title: 'Note libre', project_id: 'p' });
    await clientApi.createTask({ title: 'Signer devis', project_id: 'p', category_id: child.id });
    await clientApi.createTask({ title: 'Tâche libre', project_id: 'p' });
    render(<App />);
    await showCategory('Afficher la catégorie Préparation');
    await waitFor(() => expect(within(journal()).queryByText('Note libre')).not.toBeInTheDocument());
    expect(trigger()).toHaveAccessibleName('Catégories : Préparation');
    expect(within(journal()).getByText('Note devis')).toBeInTheDocument();
    expect(within(board()).getByRole('button', { name: 'Signer devis' })).toBeInTheDocument();
    expect(within(board()).queryByRole('button', { name: 'Tâche libre' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Nouvelle tâche'), { target: { value: 'Nouvel objectif' } });
    fireEvent.click(within(board()).getByRole('button', { name: 'Ajouter' }));
    await within(board()).findByRole('button', { name: 'Nouvel objectif' });
    await within(journal()).findByText('Nouvel objectif');
    expect(row(api.db, 'SELECT * FROM tasks WHERE title=?', 'Nouvel objectif')).toMatchObject({ project_id: 'p', category_id: parent.id });
    const linked = row(api.db, 'SELECT te.entry_id FROM task_entries te JOIN tasks t ON t.id=te.task_id WHERE t.title=?', 'Nouvel objectif');
    expect(linked).toBeTruthy();
    fireEvent.click(within(journal()).getByRole('button', { name: 'Nouvelle entrée' }));
    await waitFor(() => expect(screen.getByLabelText('Catégorie de l’entrée')).toHaveValue(parent.id));
    await showCategory('Sans catégorie');
    await within(journal()).findByText('Note libre');
    expect(within(journal()).queryByText('Note devis')).not.toBeInTheDocument();
    expect(within(board()).getByRole('button', { name: 'Tâche libre' })).toBeInTheDocument();
  });

  test('classe depuis l’éditeur et les cartes et affiche les groupes par projet', async () => {
    seedData(api.db, { projects: [{ id: 'p', name: 'Chantier' }], entries: [{ id: 'e', title: 'Compte rendu', project_id: 'p' }], tasks: [{ id: 't', title: 'Objectif', project_id: 'p' }] });
    const parent = await createCategory('Préparation');
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Catégorie de l’entrée', {}, { timeout: 5000 }), { target: { value: parent.id } });
    await waitFor(() => expect(row(api.db, 'SELECT category_id FROM entries WHERE id=?', 'e').category_id).toBe(parent.id));
    fireEvent.click(within(board()).getByRole('button', { name: 'Objectif' }));
    fireEvent.change(screen.getByLabelText('Catégorie de la tâche'), { target: { value: parent.id } });
    fireEvent.click(within(board()).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(row(api.db, 'SELECT category_id FROM tasks WHERE id=?', 't').category_id).toBe(parent.id));
    fireEvent.click(categories().getByLabelText('Regrouper par catégorie'));
    await within(journal()).findByRole('heading', { name: /Chantier · Préparation/ });
    await within(board()).findByRole('heading', { name: /Chantier · Préparation/ });
    fireEvent.change(screen.getByLabelText('Projet de l’entrée'), { target: { value: '' } });
    await waitFor(() => expect(row(api.db, 'SELECT category_id FROM entries WHERE id=?', 'e').category_id).toBeNull());
  });

  test('lier une entrée déjà classée choisit sa catégorie pour la tâche et la garde visible sous le filtre', async () => {
    seedData(api.db, { projects: [{ id: 'p', name: 'Chantier' }], entries: [{ id: 'e', title: 'Devis à signer', project_id: 'p' }], tasks: [{ id: 't', title: 'Relire le devis', project_id: 'p' }] });
    const category = await createCategory('Préparation');
    await clientApi.updateEntry('e', { category_id: category.id });
    render(<App />);
    const card = (await within(board()).findByRole('button', { name: 'Relire le devis' })).closest('.card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Lier des documents' }));
    fireEvent.click(await within(card).findByRole('checkbox', { name: 'Lier Devis à signer à Relire le devis' }));
    fireEvent.click(within(card).getByRole('button', { name: /Relier la sélection/ }));
    await within(card).findByText('Préparation');
    expect(row(api.db, 'SELECT category_id FROM tasks WHERE id=?', 't').category_id).toBe(category.id);
    await showCategory('Afficher la catégorie Préparation');
    await within(journal()).findByText('Devis à signer');
    expect(within(board()).getByRole('button', { name: 'Relire le devis' })).toBeInTheDocument();
    fireEvent.click(within(board()).getByRole('button', { name: 'Relire le devis' }));
    expect(screen.getByLabelText('Catégorie de la tâche')).toHaveValue(category.id);
  });

  test('pendant l’édition d’une tâche, lier une entrée classée sélectionne sa catégorie et « Enregistrer » la garde', async () => {
    seedData(api.db, { projects: [{ id: 'p', name: 'Chantier' }], entries: [{ id: 'e', title: 'Devis à signer', project_id: 'p' }], tasks: [{ id: 't', title: 'Relire le devis', project_id: 'p' }] });
    const category = await createCategory('Préparation');
    await clientApi.updateEntry('e', { category_id: category.id });
    render(<App />);
    fireEvent.click(await within(board()).findByRole('button', { name: 'Relire le devis' }));
    expect(screen.getByLabelText('Catégorie de la tâche')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Titre de la tâche'), { target: { value: 'Relire et signer le devis' } });
    fireEvent.click(within(board()).getByRole('button', { name: 'Lier des documents' }));
    fireEvent.click(await within(board()).findByRole('checkbox', { name: 'Lier Devis à signer à Relire le devis' }));
    fireEvent.click(within(board()).getByRole('button', { name: /Relier la sélection/ }));
    await waitFor(() => expect(screen.getByLabelText('Catégorie de la tâche')).toHaveValue(category.id));
    expect(screen.getByLabelText('Titre de la tâche')).toHaveValue('Relire et signer le devis');
    fireEvent.click(within(board()).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(row(api.db, 'SELECT title, category_id FROM tasks WHERE id=?', 't')).toMatchObject({ title: 'Relire et signer le devis', category_id: category.id }));
  });

  test('un choix de catégorie en cours d’édition l’emporte sur celle qu’un document lié apporte', async () => {
    seedData(api.db, { projects: [{ id: 'p', name: 'Chantier' }], entries: [{ id: 'e', title: 'Devis à signer', project_id: 'p' }], tasks: [{ id: 't', title: 'Relire le devis', project_id: 'p' }] });
    const inherited = await createCategory('Préparation');
    const chosen = await createCategory('Livraison');
    await clientApi.updateEntry('e', { category_id: inherited.id });
    render(<App />);
    fireEvent.click(await within(board()).findByRole('button', { name: 'Relire le devis' }));
    fireEvent.change(screen.getByLabelText('Catégorie de la tâche'), { target: { value: chosen.id } });
    fireEvent.click(within(board()).getByRole('button', { name: 'Lier des documents' }));
    fireEvent.click(await within(board()).findByRole('checkbox', { name: 'Lier Devis à signer à Relire le devis' }));
    fireEvent.click(within(board()).getByRole('button', { name: /Relier la sélection/ }));
    await waitFor(() => expect(row(api.db, 'SELECT category_id FROM tasks WHERE id=?', 't').category_id).toBe(inherited.id));
    await within(board()).findByRole('button', { name: 'Ouvrir Devis à signer' });
    expect(screen.getByLabelText('Catégorie de la tâche')).toHaveValue(chosen.id);
    fireEvent.click(within(board()).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(row(api.db, 'SELECT category_id FROM tasks WHERE id=?', 't').category_id).toBe(chosen.id));
  });

  test('un reclassement distant actualise projet et catégorie ensemble en gardant le texte saisi', async () => {
    seedData(api.db, { projects: [{ id: 'p', name: 'Projet P' }, { id: 'q', name: 'Projet Q' }], entries: [{ id: 'e', title: 'Note initiale', project_id: 'p' }], tasks: [{ id: 't', title: 'Relire', project_id: 'p' }] });
    const destination = await clientApi.createCategory({ name: 'Destination', project_id: 'q' });
    render(<App />);
    const title = await screen.findByDisplayValue('Note initiale');
    fireEvent.change(title, { target: { value: 'Texte en cours' } });
    await clientApi.updateEntry('e', { project_id: 'q', category_id: destination.id });
    fireEvent.click(within(board()).getByRole('button', { name: 'Épingler Relire' }));
    await waitFor(() => expect(screen.getByLabelText('Projet de l’entrée')).toHaveValue('q'));
    expect(screen.getByLabelText('Catégorie de l’entrée')).toHaveValue(destination.id);
    expect(title).toHaveValue('Texte en cours');
    await flushPendingSaves();
    expect(await clientApi.entry('e')).toMatchObject({ title: 'Texte en cours', project_id: 'q', category_id: destination.id });
  });

  test('une frappe avant les effets de l’éditeur ne réécrit pas un reclassement distant', async () => {
    seedData(api.db, { projects: [{ id: 'p', name: 'Projet P' }, { id: 'q', name: 'Projet Q' }], entries: [{ id: 'e', title: 'Note initiale', project_id: 'p' }] });
    const destination = await clientApi.createCategory({ name: 'Destination', project_id: 'q' });
    const projects = [{ id: 'p', name: 'Projet P' }, { id: 'q', name: 'Projet Q' }] as Project[];
    const editor = async () => <EntryEditor key="e" entry={await clientApi.entry('e')} projects={projects} categories={[destination]} onChanged={() => {}} onDeleted={() => {}} />;
    // Hors act, comme dans l'application : la frappe arrive après la pose du DOM, avant les effets.
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previous = env.IS_REACT_ACT_ENVIRONMENT;
    env.IS_REACT_ACT_ENVIRONMENT = false;
    const container = document.body.appendChild(document.createElement('div'));
    const root = createRoot(container);
    try {
      const committed = new Promise<void>((resolve) => new MutationObserver((_, observer) => { observer.disconnect(); resolve(); }).observe(container, { childList: true }));
      root.render(await editor());
      await committed;
      fireEvent.change(container.querySelector('input[aria-label="Titre de l’entrée"]')!, { target: { value: 'Texte en cours' } });
      await clientApi.updateEntry('e', { project_id: 'q', category_id: destination.id });
      root.render(await editor());
      await new Promise((resolve) => setTimeout(resolve, 50));
      await flushPendingSaves();
      expect(await clientApi.entry('e')).toMatchObject({ title: 'Texte en cours', project_id: 'q', category_id: destination.id });
    } finally {
      root.unmount();
      container.remove();
      env.IS_REACT_ACT_ENVIRONMENT = previous;
    }
  });

  test('une sauvegarde de texte en vol ne réécrit pas le classement changé à distance', async () => {
    seedData(api.db, { projects: [{ id: 'p', name: 'Projet P' }, { id: 'q', name: 'Projet Q' }], entries: [{ id: 'e', title: 'Note initiale', project_id: 'p' }] });
    const destination = await clientApi.createCategory({ name: 'Destination', project_id: 'q' });
    render(<App />);
    const title = await screen.findByDisplayValue('Note initiale');
    let started!: () => void;
    let release!: () => void;
    const sending = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const original = clientApi.updateEntry;
    vi.spyOn(clientApi, 'updateEntry').mockImplementation(async (id, body) => {
      started();
      await pending;
      return original(id, body);
    });
    fireEvent.change(title, { target: { value: 'Texte en cours' } });
    const saving = flushPendingSaves();
    await sending;
    try {
      await original('e', { project_id: 'q', category_id: destination.id });
    } finally {
      release();
    }
    await act(async () => { await saving; });
    await waitFor(() => expect(screen.getByLabelText('Projet de l’entrée')).toHaveValue('q'));
    expect(title).toHaveValue('Texte en cours');
    expect(await clientApi.entry('e')).toMatchObject({ title: 'Texte en cours', project_id: 'q', category_id: destination.id });
  });

  test('une réponse de création de catégorie tardive ne recharge pas le projet quitté', async () => {
    seedData(api.db, { projects: [{ id: 'p', name: 'Projet P' }, { id: 'q', name: 'Projet Q' }], entries: [{ id: 'ep', title: 'Note P', project_id: 'p' }, { id: 'eq', title: 'Note Q', project_id: 'q' }] });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const original = clientApi.createCategory;
    vi.spyOn(clientApi, 'createCategory').mockImplementation(async (body) => { await pending; return original(body); });
    render(<App />);
    fireEvent.click(await within(filters()).findByRole('button', { name: /^Projet P/ }));
    await waitFor(() => expect(within(journal()).queryByText('Note Q')).not.toBeInTheDocument());
    fireEvent.click(categories().getByRole('button', { name: '＋ Catégorie' }));
    fireEvent.change(categories().getByLabelText('Nom de la catégorie'), { target: { value: 'Réponse tardive' } });
    fireEvent.click(categories().getByRole('button', { name: 'Enregistrer la catégorie' }));
    fireEvent.click(within(filters()).getByRole('button', { name: /^Projet Q/ }));
    await within(journal()).findByText('Note Q');
    await act(async () => { release(); await pending; });
    await waitFor(() => expect(row(api.db, 'SELECT count(*) n FROM categories WHERE name=?', 'Réponse tardive').n).toBe(1));
    expect(within(journal()).getByText('Note Q')).toBeInTheDocument();
    expect(within(journal()).queryByText('Note P')).not.toBeInTheDocument();
  });

  test('la dernière navigation attendue pendant une sauvegarde garde un couple projet et catégorie cohérent', async () => {
    seedData(api.db, { projects: [{ id: 'p', name: 'Projet P' }, { id: 'q', name: 'Projet Q' }], entries: [{ id: 'e', title: 'Note initiale', project_id: 'p' }] });
    const category = await createCategory('Préparation');
    render(<App />);
    await screen.findByDisplayValue('Note initiale');
    fireEvent.click(within(filters()).getByRole('button', { name: /^Projet P/ }));
    await waitFor(() => expect(within(filters()).getByRole('button', { name: /^Projet P/ })).toHaveAttribute('aria-pressed', 'true'));
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const original = clientApi.updateEntry;
    vi.spyOn(clientApi, 'updateEntry').mockImplementation(async (id, body) => { await pending; return original(id, body); });
    fireEvent.change(screen.getByLabelText('Titre de l’entrée'), { target: { value: 'Brouillon' } });
    fireEvent.click(within(filters()).getByRole('button', { name: /^Projet Q/ }));
    await showCategory('Afficher la catégorie Préparation');
    await act(async () => { release(); await pending; });
    await waitFor(() => expect(trigger()).toHaveAccessibleName('Catégories : Préparation'));
    expect(within(filters()).getByRole('button', { name: /^Projet P/ })).toHaveAttribute('aria-pressed', 'true');
    expect(category.project_id).toBe('p');
  });

  test('reclasser un onglet Google hors du filtre ouvre son frère encore visible', async () => {
    seedData(api.db, { projects: [{ id: 'p', name: 'Projet P' }], entries: [{ id: 'e1', title: 'Onglet un', project_id: 'p' }, { id: 'e2', title: 'Onglet deux', project_id: 'p' }] });
    const source = await createCategory('Source');
    const destination = await createCategory('Destination');
    seedGoogleLink(api.db, 'e1', 'doc');
    seedGoogleLink(api.db, 'e2', 'doc2');
    api.db.prepare('UPDATE google_documents SET document_id=?,tab_id=?,tab_title=?,tab_order=1 WHERE entry_id=?').run('doc', 'tab-1', 'Onglet deux', 'e2');
    api.db.prepare('UPDATE entries SET category_id=?').run(source.id);
    localStorage.setItem('worklogs-entry', 'e1');
    render(<App />);
    await screen.findByDisplayValue('Onglet un');
    await showCategory('Afficher la catégorie Source');
    await waitFor(() => expect(trigger()).toHaveAccessibleName('Catégories : Source'));
    fireEvent.change(screen.getByLabelText('Catégorie de l’entrée'), { target: { value: destination.id } });
    await act(async () => { await flushPendingSaves(); });
    await screen.findByDisplayValue('Onglet deux');
    expect(screen.getByLabelText('Catégorie de l’entrée')).toHaveValue(source.id);
  });

  test('une sauvegarde de tâche en attente verrouille les champs et ne ferme pas une autre carte', async () => {
    seedData(api.db, { projects: [{ id: 'p', name: 'Projet' }], tasks: [{ id: 't1', title: 'Premier objectif', project_id: 'p' }, { id: 't2', title: 'Second objectif', project_id: 'p' }] });
    render(<App />);
    fireEvent.click(await within(board()).findByRole('button', { name: 'Premier objectif' }));
    fireEvent.change(screen.getByLabelText('Titre de la tâche'), { target: { value: 'Premier objectif modifié' } });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const original = clientApi.updateTask;
    vi.spyOn(clientApi, 'updateTask').mockImplementation(async (id, body) => { await pending; return original(id, body); });
    fireEvent.click(within(board()).getByRole('button', { name: 'Enregistrer' }));
    expect(screen.getByLabelText('Titre de la tâche')).toBeDisabled();
    expect(screen.getByLabelText('Échéance')).toBeDisabled();
    expect(screen.getByLabelText('Priorité')).toBeDisabled();
    fireEvent.keyDown(screen.getByLabelText('Titre de la tâche'), { key: 'Escape' });
    expect(screen.getByLabelText('Titre de la tâche')).toBeInTheDocument();
    fireEvent.click(within(board()).getByRole('button', { name: 'Second objectif' }));
    fireEvent.change(screen.getByLabelText('Titre de la tâche'), { target: { value: 'Deuxième brouillon' } });
    await act(async () => { release(); await pending; });
    await waitFor(() => expect(row(api.db, 'SELECT title FROM tasks WHERE id=?', 't1').title).toBe('Premier objectif modifié'));
    expect(screen.getByLabelText('Titre de la tâche')).toHaveValue('Deuxième brouillon');
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

  test('changer de projet quitte aussitôt l’entrée du précédent', async () => {
    const user = userEvent.setup();
    seedData(api.db, {
      projects: [{ id: 'pr_a', name: 'Alpha' }, { id: 'pr_b', name: 'Beta' }],
      entries: [
        { id: 'en_a', title: 'Entrée Alpha', project_id: 'pr_a' },
        { id: 'en_b', title: 'Entrée Beta', project_id: 'pr_b' },
      ],
    });
    // L'entrée du nouveau projet met du temps à revenir : entre les deux, le
    // centre ne doit pas continuer d'afficher celle du projet quitté.
    const loadEntry = clientApi.entry;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const load = vi.spyOn(clientApi, 'entry').mockImplementation(async (id) => {
      if (id === 'en_b') await gate;
      return loadEntry(id);
    });
    try {
      render(<App />);
      await user.click(await within(filters()).findByRole('button', { name: /Alpha/ }));
      await waitFor(() => expect(within(editor()).getByLabelText('Titre de l’entrée')).toHaveValue('Entrée Alpha'));

      await user.click(within(filters()).getByRole('button', { name: /Beta/ }));
      await waitFor(() => expect(within(journal()).queryByText('Entrée Alpha')).not.toBeInTheDocument());
      expect(screen.queryByRole('region', { name: 'Entrée' })).not.toBeInTheDocument();

      release();
      await waitFor(() => expect(within(editor()).getByLabelText('Titre de l’entrée')).toHaveValue('Entrée Beta'));
    } finally {
      release();
      load.mockRestore();
    }
  });

  test('changer de projet n’ouvre jamais une archive ; ouverte exprès, elle se dit archivée', async () => {
    const user = userEvent.setup();
    seedData(api.db, {
      projects: [{ id: 'pr_a', name: 'Alpha' }, { id: 'pr_b', name: 'Beta' }, { id: 'pr_c', name: 'Gamma' }],
      entries: [
        { id: 'en_a', title: 'Entrée Alpha', project_id: 'pr_a' },
        { id: 'en_b_old', title: 'Panne réglée', project_id: 'pr_b', date: '2026-06-03' },
        { id: 'en_b', title: 'Entrée Beta', project_id: 'pr_b', date: '2026-06-01' },
        { id: 'en_c', title: 'Procédure close', project_id: 'pr_c', kind: 'procedure' },
      ],
    });
    for (const id of ['en_b_old', 'en_c']) api.db.prepare('UPDATE entries SET archived=1 WHERE id=?').run(id);
    const load = vi.spyOn(clientApi, 'entry');
    render(<App />);
    await user.click(await within(filters()).findByRole('button', { name: /Alpha/ }));
    await waitFor(() => expect(within(editor()).getByLabelText('Titre de l’entrée')).toHaveValue('Entrée Alpha'));

    // La plus récente de Beta est archivée : c'est la suivante qui s'ouvre.
    await user.click(within(filters()).getByRole('button', { name: /Beta/ }));
    await waitFor(() => expect(within(editor()).getByLabelText('Titre de l’entrée')).toHaveValue('Entrée Beta'));
    expect(within(editor()).queryByText('Document archivé.')).not.toBeInTheDocument();

    // Gamma n'a qu'une procédure archivée : rien ne s'ouvre tout seul.
    await user.click(within(filters()).getByRole('button', { name: /Gamma/ }));
    await waitFor(() => expect(within(journal()).queryByText('Entrée Beta')).not.toBeInTheDocument());
    expect(screen.queryByRole('region', { name: 'Entrée' })).not.toBeInTheDocument();
    expect(load.mock.calls.map(([id]) => id)).not.toContain('en_b_old');
    expect(load.mock.calls.map(([id]) => id)).not.toContain('en_c');

    // Allée chercher dans les Archives, elle s'ouvre et le dit.
    await user.click(within(journal()).getByText('Archives', { selector: 'summary' }));
    await user.click(await within(journal()).findByText('Procédure close'));
    await waitFor(() => expect(within(editor()).getByLabelText('Titre de l’entrée')).toHaveValue('Procédure close'));
    expect(within(editor()).getByText('Document archivé.')).toBeInTheDocument();
    await user.click(within(editor()).getByRole('button', { name: 'Désarchiver' }));
    await waitFor(() => expect(within(editor()).queryByText('Document archivé.')).not.toBeInTheDocument());
    load.mockRestore();
  });

  test('une procédure ouverte au centre déplie la colonne Procédures, qui la montre', async () => {
    const user = userEvent.setup();
    seedData(api.db, {
      entries: [{ id: 'en_note', title: 'Note du jour' }, { id: 'en_proc', title: 'Vidange', kind: 'procedure' }],
      tasks: [{ id: 'tk_v', title: 'Vidanger le bassin' }],
    });
    api.db.prepare('INSERT INTO task_entries (task_id,entry_id,created_at) VALUES (?,?,?)').run('tk_v', 'en_proc', new Date().toISOString());
    render(<App />);
    const toggle = await screen.findByRole('button', { name: 'Procédures' });
    await waitFor(() => expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Note du jour'));
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    // Ouverte depuis sa tâche : la colonne se déplie, la procédure y est désignée.
    await user.click(await within(board()).findByRole('button', { name: 'Ouvrir Vidange' }));
    await waitFor(() => expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Vidange'));
    await waitFor(() => expect(toggle).toHaveAttribute('aria-pressed', 'true'));
    const panel = screen.getByRole('region', { name: 'Procédures du projet' });
    expect(within(panel).getByRole('button', { current: true })).toHaveTextContent('Vidange');

    // Refermée à la main, elle le reste pendant qu'on travaille la même procédure.
    await user.click(toggle);
    await user.type(screen.getByLabelText('Titre de l’entrée'), ' du bassin');
    await waitFor(() => expect(row(api.db, 'SELECT title FROM entries WHERE id=?', 'en_proc').title).toBe('Vidange du bassin'));
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    // Une note n'y touche pas ; rouvrir la procédure la redéplie.
    await user.click(within(journal()).getByText('Note du jour'));
    await waitFor(() => expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Note du jour'));
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(within(board()).getByRole('button', { name: 'Ouvrir Vidange du bassin' }));
    await waitFor(() => expect(toggle).toHaveAttribute('aria-pressed', 'true'));
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
  test('renommer un projet écarte les priorités calculées avec son ancien nom', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, { projects: [{ id: 'pr_a', name: 'Avant' }], tasks: [{ id: 'tk_1', title: 'Devis', project_id: 'pr_a' }] });
    mockAiSuggest('[{"n":1,"priority":"high"}]');
    render(<App />);
    await within(board()).findByRole('button', { name: 'Devis' });
    fireEvent.click(await aiAction('Prioriser les tâches', board(), 'Assistance IA des tâches'));
    expect(await within(board()).findByRole('region', { name: 'Priorités proposées par l’IA' })).toBeInTheDocument();
    const dialog = await openProjects();
    const name = dialog.getByLabelText('Nom de Avant');
    await user.clear(name);
    await user.type(name, 'Après{Enter}');
    await waitFor(() => expect(row(api.db, 'SELECT name FROM projects WHERE id=?', 'pr_a').name).toBe('Après'));
    await waitFor(() => expect(within(board()).queryByRole('region', { name: 'Priorités proposées par l’IA' })).not.toBeInTheDocument());
    expect(row(api.db, 'SELECT priority FROM tasks WHERE id=?', 'tk_1').priority).toBe('normal');
  });

  test('une proposition IA est écartée si une tâche change avant son application', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, { tasks: [{ id: 'tk_1', title: 'Relancer le devis' }] });
    mockAiSuggest('[{"n":1,"priority":"high","reason":"À relancer"}]');
    render(<App />);
    await within(board()).findByRole('button', { name: 'Relancer le devis' });
    fireEvent.click(await aiAction('Prioriser les tâches', board(), 'Assistance IA des tâches'));
    expect(await within(board()).findByRole('region', { name: 'Priorités proposées par l’IA' })).toBeInTheDocument();
    await user.click(within(board()).getByRole('button', { name: 'Mettre en cours Relancer le devis' }));
    await waitFor(() => expect(row(api.db, 'SELECT status FROM tasks WHERE id=?', 'tk_1').status).toBe('doing'));
    await waitFor(() => expect(within(board()).queryByRole('region', { name: 'Priorités proposées par l’IA' })).not.toBeInTheDocument());
    expect(row(api.db, 'SELECT priority FROM tasks WHERE id=?', 'tk_1').priority).toBe('normal');
    expect(within(board()).getByRole('alert')).toHaveTextContent('Les tâches ont changé');
  });

  test('une tâche modifiée pendant « Prioriser » le dit', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, { tasks: [{ id: 'tk_1', title: 'Relancer le devis' }] });
    const diverted = globalThis.fetch;
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => (
      String(input).includes('chat/completions') ? new Promise<Response>((resolve) => { finish = resolve; }) : diverted(input, init)
    )));
    render(<App />);
    await within(board()).findByRole('button', { name: 'Relancer le devis' });
    fireEvent.click(await aiAction('Prioriser les tâches', board(), 'Assistance IA des tâches'));
    await waitFor(() => expect(finish).toBeDefined());
    await user.click(within(board()).getByRole('button', { name: 'Mettre en cours Relancer le devis' }));
    expect(await within(board()).findByRole('alert')).toHaveTextContent('Les tâches ont changé');
    await act(async () => finish({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '[{"n":1,"priority":"high"}]' } }] }) } as Response));
    expect(within(board()).queryByRole('region', { name: 'Priorités proposées par l’IA' })).not.toBeInTheDocument();
  });

  test('un échec pendant l’application de la proposition garde son message', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, { tasks: [{ id: 'tk_1', title: 'Un' }, { id: 'tk_2', title: 'Deux' }] });
    mockAiSuggest('[{"n":1,"priority":"high"},{"n":2,"priority":"low"}]');
    render(<App />);
    await within(board()).findByRole('button', { name: 'Un' });
    fireEvent.click(await aiAction('Prioriser les tâches', board(), 'Assistance IA des tâches'));
    const proposal = await within(board()).findByRole('region', { name: 'Priorités proposées par l’IA' });
    const write = clientApi.updateTask;
    vi.spyOn(clientApi, 'updateTask').mockImplementationOnce(write).mockRejectedValueOnce(new Error('Écriture refusée.'));
    await user.click(within(proposal).getByRole('button', { name: 'Appliquer' }));
    await waitFor(() => expect(within(board()).queryByRole('region', { name: 'Priorités proposées par l’IA' })).not.toBeInTheDocument());
    expect(within(board()).getByRole('alert')).toHaveTextContent('Écriture refusée.');
  });

  test('la liste regroupée indique toujours les tâches en cours', async () => {
    seedData(api.db, {
      projects: [{ id: 'pr_a', name: 'Alpha' }, { id: 'pr_b', name: 'Beta' }],
      tasks: [{ id: 'tk_1', title: 'Relancer le devis', project_id: 'pr_a', status: 'doing' }],
    });
    render(<App />);
    await within(board()).findByRole('button', { name: 'Relancer le devis' });
    fireEvent.click(document.querySelector<HTMLButtonElement>('.category-trigger')!);
    fireEvent.click(screen.getByLabelText('Regrouper par catégorie'));
    await within(board()).findByRole('heading', { name: /Alpha · Sans catégorie/ });
    const groupedCard = within(board()).getByRole('button', { name: 'Relancer le devis' }).closest('.card') as HTMLElement;
    expect(within(groupedCard).getByTitle('En cours')).toHaveTextContent('En cours');
  });

  test('la priorisation respecte la vue rapide et abandonne une réponse après changement de filtre', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, {
      projects: [{ id: 'pr_a', name: 'Alpha' }, { id: 'pr_b', name: 'Beta' }],
      tasks: [
        { id: 'tk_doing', title: 'Travail en cours', project_id: 'pr_a', status: 'doing' },
        { id: 'tk_todo', title: 'Travail à faire', project_id: 'pr_b' },
      ],
    });
    const diverted = globalThis.fetch;
    let finish!: (response: Response) => void;
    let sent = '';
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('chat/completions')) {
        sent = (JSON.parse(init!.body as string) as { messages: { content: string }[] }).messages[1].content;
        return new Promise<Response>((resolve) => { finish = resolve; });
      }
      return diverted(input, init);
    }));
    render(<App />);
    const views = await within(board()).findByRole('group', { name: 'Filtrer les tâches' });
    await user.click(within(views).getByRole('button', { name: 'En cours 1' }));
    fireEvent.click(await aiAction('Prioriser les tâches', board(), 'Assistance IA des tâches'));
    await waitFor(() => expect(sent).toContain('Travail en cours'));
    expect(sent).not.toContain('Travail à faire');
    await user.click(within(views).getByRole('button', { name: 'Toutes' }));
    await act(async () => finish({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '[{"n":1,"priority":"high"}]' } }] }) } as Response));
    await waitFor(() => expect(within(board()).queryByRole('button', { name: 'Priorisation…' })).not.toBeInTheDocument());
    expect(within(board()).queryByRole('region', { name: 'Priorités proposées par l’IA' })).not.toBeInTheDocument();
    expect(within(board()).queryByRole('alert')).not.toBeInTheDocument();
  });

  test('« Tout » range les tâches ouvertes en une liste ; ✨ IA › Prioriser propose, relit, applique ou ignore', async () => {
    const user = userEvent.setup();
    const future = new Date();
    future.setUTCDate(future.getUTCDate() + 7);
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, {
      projects: [{ id: 'pr_a', name: 'Pisciculture' }, { id: 'pr_b', name: 'Site web' }],
      tasks: [
        { id: 'tk_photos', title: 'Photos des bassins', project_id: 'pr_b' },
        { id: 'tk_filtre', title: 'Changer le filtre', project_id: 'pr_a', due_date: future.toISOString().slice(0, 10) },
        { id: 'tk_tarifs', title: 'Page tarifs', project_id: 'pr_b', status: 'doing' },
        { id: 'tk_fini', title: 'Déjà fait', project_id: 'pr_a', status: 'done' },
      ],
    });
    // Numérotées dans l'ordre envoyé : 1 Page tarifs (en cours), 2 Changer le filtre (échéance), 3 Photos.
    mockAiSuggest(JSON.stringify([
      { n: 3, priority: 'high', reason: 'Bloque la page tarifs.' },
      { n: 2, priority: 'low', reason: 'Échéance lointaine.' },
      { n: 1, priority: 'normal', reason: '' },
    ]));
    render(<App />);

    // Une seule liste : en cours d'abord, puis l'échéance la plus proche avant les sans-échéance ; Terminé reste à part.
    const titles = () => within(board()).getAllByRole('button', { name: /^(Photos des bassins|Changer le filtre|Page tarifs|Déjà fait)$/ }).map((button) => button.textContent);
    await within(board()).findByRole('heading', { name: 'À faire · En cours 3' });
    expect(titles()).toEqual(['Page tarifs', 'Changer le filtre', 'Photos des bassins']);
    expect(within(board()).getByRole('heading', { name: 'Terminé' })).toBeInTheDocument();
    expect(within(board()).queryByRole('heading', { name: /^En cours/ })).not.toBeInTheDocument();

    fireEvent.click(await aiAction('Prioriser les tâches', board(), 'Assistance IA des tâches'));
    const proposal = await within(board()).findByRole('region', { name: 'Priorités proposées par l’IA' });
    expect(proposal).toHaveTextContent('2 priorités à changer');
    // Les champs enregistrés partent, jamais la tâche terminée.
    const sent = (aiBodies[0] as { messages: { content: string }[] }).messages[1].content;
    expect(sent).toContain('3 · Photos des bassins · P1 · à faire · normale · sans échéance');
    expect(sent).toContain('1 · Page tarifs · P1 · en cours');
    expect(sent).not.toContain('Déjà fait');
    // La liste suit la proposition : priorité proposée, puis le rang de l'IA.
    expect(titles()).toEqual(['Page tarifs', 'Photos des bassins', 'Changer le filtre']);
    const photos = within(board()).getByRole('button', { name: 'Photos des bassins' }).closest('.card') as HTMLElement;
    expect(within(photos).getByText('Haute proposée')).toBeInTheDocument();
    expect(within(photos).getByText('Bloque la page tarifs.')).toBeInTheDocument();
    expect(row(api.db, 'SELECT priority FROM tasks WHERE id=?', 'tk_photos').priority).toBe('normal');

    await user.click(within(proposal).getByRole('button', { name: 'Appliquer' }));
    await waitFor(() => expect(row(api.db, 'SELECT priority FROM tasks WHERE id=?', 'tk_photos').priority).toBe('high'));
    await waitFor(() => expect(row(api.db, 'SELECT priority FROM tasks WHERE id=?', 'tk_filtre').priority).toBe('low'));
    expect(row(api.db, 'SELECT priority FROM tasks WHERE id=?', 'tk_tarifs').priority).toBe('normal');
    await waitFor(() => expect(within(board()).queryByRole('region', { name: 'Priorités proposées par l’IA' })).not.toBeInTheDocument());
    expect(await within(photos).findByText('Haute')).toBeInTheDocument();
    expect(within(photos).queryByText('Bloque la page tarifs.')).not.toBeInTheDocument();
    expect(within(board()).queryByRole('alert')).not.toBeInTheDocument();

    // Ignorer n'écrit rien.
    mockAiSuggest(JSON.stringify([{ n: 2, priority: 'low', reason: 'Peut attendre.' }]));
    fireEvent.click(await aiAction('Prioriser les tâches', board(), 'Assistance IA des tâches'));
    const again = await within(board()).findByRole('region', { name: 'Priorités proposées par l’IA' });
    expect(await within(photos).findByText('Basse proposée')).toBeInTheDocument();
    await user.click(within(again).getByRole('button', { name: 'Ignorer' }));
    expect(within(board()).queryByRole('region', { name: 'Priorités proposées par l’IA' })).not.toBeInTheDocument();
    expect(row(api.db, 'SELECT priority FROM tasks WHERE id=?', 'tk_photos').priority).toBe('high');

    // Un projet choisi retrouve ses colonnes.
    await user.click(within(filters()).getByRole('button', { name: /Pisciculture/ }));
    await within(board()).findByRole('heading', { name: 'En cours 0' });
    expect(within(board()).getByRole('heading', { name: 'À faire 1' })).toBeInTheDocument();
  });

  test('« Mettre en cours » d’un clic, puis « Remettre à faire » ; la carte dit son projet quand tous sont affichés', async () => {
    const user = userEvent.setup();
    seedData(api.db, {
      projects: [{ id: 'pr_a', name: 'Pisciculture', color: '#2f9e6f' }, { id: 'pr_b', name: 'Site web' }],
      tasks: [{ id: 'tk_1', title: 'Commander les alevins', project_id: 'pr_a' }, { id: 'tk_2', title: 'Photos des bassins', project_id: 'pr_b', status: 'doing' }],
    });
    render(<App />);

    const start = await within(board()).findByRole('button', { name: 'Mettre en cours Commander les alevins' });
    expect(start).toHaveAttribute('aria-pressed', 'false');
    const card = start.closest('.card') as HTMLElement;
    expect(within(card).getByTitle('Projet Pisciculture')).toHaveTextContent('Pisciculture');
    await user.click(start);
    await waitFor(() => expect(row(api.db, 'SELECT status, position FROM tasks WHERE id=?', 'tk_1')).toMatchObject({ status: 'doing', position: 1 }));
    const back = await within(board()).findByRole('button', { name: 'Remettre à faire Commander les alevins' });
    expect(back).toHaveAttribute('aria-pressed', 'true');
    await user.click(back);
    await waitFor(() => expect(row(api.db, 'SELECT status FROM tasks WHERE id=?', 'tk_1').status).toBe('todo'));
    // Une tâche terminée ne se met pas en cours : la case la rouvre d'abord.
    await user.click(within(board()).getByRole('checkbox', { name: 'Terminer Photos des bassins' }));
    await waitFor(() => expect(within(board()).queryByRole('button', { name: /Photos des bassins$/ })).not.toBeInTheDocument());

    // Projet filtré : l’étiquette du projet n’apprend plus rien.
    await user.click(within(filters()).getByRole('button', { name: /Pisciculture/ }));
    await waitFor(() => expect(within(board()).queryByTitle('Projet Pisciculture')).not.toBeInTheDocument());
    expect(within(board()).getByRole('button', { name: 'Commander les alevins' })).toBeInTheDocument();
  });

  test('les tâches terminées sont repliées par défaut et se masquent à nouveau', async () => {
    const user = userEvent.setup();
    seedData(api.db, { tasks: [{ id: 'tk_done', title: 'Tâche terminée', status: 'done' }] });
    render(<App />);

    const show = await within(board()).findByRole('button', { name: 'Afficher les tâches terminées (1)' });
    expect(show).toHaveAttribute('aria-expanded', 'false');
    expect(within(board()).queryByRole('button', { name: 'Tâche terminée' })).not.toBeInTheDocument();

    await user.click(show);
    expect(await within(board()).findByRole('button', { name: 'Tâche terminée' })).toBeInTheDocument();
    const hide = within(board()).getByRole('button', { name: 'Masquer les tâches terminées (1)' });
    expect(hide).toHaveAttribute('aria-expanded', 'true');
    await user.click(hide);
    expect(within(board()).queryByRole('button', { name: 'Tâche terminée' })).not.toBeInTheDocument();
  });

  test('ajoute une tâche à la volée avec Entrée', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(await screen.findByLabelText('Nouvelle tâche'), 'Rappeler le client{Enter}');

    expect(await within(board()).findByRole('button', { name: 'Rappeler le client' })).toBeInTheDocument();
    expect(await within(journal()).findByText('Rappeler le client')).toBeInTheDocument();
    expect(screen.getByLabelText('Nouvelle tâche')).toHaveValue('');
    await waitFor(() => expect(within(editor()).getByLabelText('Titre de l’entrée')).toHaveValue('Rappeler le client'));
    expect(within(editor()).queryByRole('progressbar')).not.toBeInTheDocument();
    expect(row(api.db, 'SELECT * FROM tasks').status).toBe('todo');
  });

  test('la saisie d’une tâche reste hors de la liste qui défile', async () => {
    seedData(api.db, { tasks: [{ id: 'tk_1', title: 'Rappeler le client' }] });
    render(<App />);

    const card = (await within(board()).findByText('Rappeler le client')).closest('.card') as HTMLElement;
    const lists = board().querySelector('.board-lists') as HTMLElement;
    // Les cartes et les intitulés de colonne défilent ensemble…
    expect(lists).toContainElement(card);
    expect(lists).toContainElement(within(board()).getByRole('heading', { name: /En cours/ }));
    // …la saisie, elle, est l'en-tête du panneau : rien ne défile dessous.
    expect(lists).not.toContainElement(screen.getByLabelText('Nouvelle tâche'));
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
    // La pastille de la carte : la vue rapide « ▲ Haute » porte le même mot.
    expect(await within(board()).findByText('Haute', { selector: '.card .priority' })).toBeInTheDocument();
    expect(within(board()).queryByText('Normale')).not.toBeInTheDocument();
  });

  test('change le statut d’une tâche sans glisser-déposer : elle finit en bas de sa colonne', async () => {
    const user = userEvent.setup();
    seedData(api.db, { tasks: [{ id: 'tk_1', title: 'À démarrer' }, { id: 'tk_2', title: 'Déjà commencée', status: 'doing' }] });
    render(<App />);

    await user.click(await within(board()).findByRole('button', { name: 'À démarrer' }));
    expect(screen.getByLabelText('Statut')).toHaveValue('todo');
    await user.selectOptions(screen.getByLabelText('Statut'), 'doing');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

    await waitFor(() => expect(row(api.db, 'SELECT status FROM tasks WHERE id=?', 'tk_1').status).toBe('doing'));
    const position = (id: string) => Number(row(api.db, 'SELECT position FROM tasks WHERE id=?', id).position);
    expect(position('tk_1')).toBeGreaterThan(position('tk_2'));
    const doing = (await within(board()).findByRole('heading', { name: /En cours/ })).closest('.column') as HTMLElement;
    await waitFor(() => expect(within(doing).getAllByRole('button', { name: /^(À démarrer|Déjà commencée)$/ }).map((b) => b.textContent)).toEqual(['Déjà commencée', 'À démarrer']));
  });

  test('un déplacement fait ailleurs pendant l’édition tient : « Enregistrer » ne remet pas l’ancien statut', async () => {
    const user = userEvent.setup();
    seedData(api.db, { tasks: [{ id: 'tk_1', title: 'Partagée' }] });
    render(<App />);

    await user.click(await within(board()).findByRole('button', { name: 'Partagée' }));
    // L'autre appareil la passe en cours pendant que le formulaire est ouvert ; l'écran
    // le reçoit à la relecture suivante (ici, l'ajout d'une autre tâche).
    api.db.prepare("UPDATE tasks SET status='doing' WHERE id=?").run('tk_1');
    await user.type(screen.getByLabelText('Nouvelle tâche'), 'Autre{Enter}');
    const doing = (await within(board()).findByRole('heading', { name: /En cours/ })).closest('.column') as HTMLElement;
    await waitFor(() => expect(within(doing).getByLabelText('Titre de la tâche')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Titre de la tâche'), { target: { value: 'Partagée renommée' } });
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));

    // Formulaire refermé : l'enregistrement (et un éventuel déplacement) est terminé.
    await waitFor(() => expect(screen.queryByLabelText('Titre de la tâche')).not.toBeInTheDocument());
    expect(row(api.db, 'SELECT title FROM tasks WHERE id=?', 'tk_1').title).toBe('Partagée renommée');
    expect(row(api.db, 'SELECT status FROM tasks WHERE id=?', 'tk_1').status).toBe('doing');
  });

  test('signale une échéance dépassée', async () => {
    const hier = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    seedData(api.db, { tasks: [{ id: 'tk_1', title: 'Facture oubliée', due_date: hier }] });
    render(<App />);

    expect(await within(board()).findByText('hier')).toHaveClass('is-late');
    expect(await screen.findByText(/en retard/)).toHaveTextContent('1');
  });

  describe('vues rapides', () => {
    const hier = () => new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    const views = () => within(board()).getByRole('group', { name: 'Filtrer les tâches' });
    const titles = () => within(board()).getAllByRole('button', { name: /^Tâche / }).map((button) => button.textContent);

    test('comptent les tâches à surveiller et les montrent d’un clic', async () => {
      const user = userEvent.setup();
      const today = new Date().toISOString().slice(0, 10);
      seedData(api.db, {
        tasks: [
          { id: 'tk_late', title: 'Tâche en retard', due_date: hier() },
          { id: 'tk_today', title: 'Tâche du jour', due_date: today },
          { id: 'tk_doing', title: 'Tâche en cours', status: 'doing' },
          { id: 'tk_pin', title: 'Tâche épinglée', pinned: 1 },
          { id: 'tk_high', title: 'Tâche urgente' },
          { id: 'tk_plain', title: 'Tâche ordinaire' },
          // Terminée : ni en retard, ni épinglée, ni prioritaire.
          { id: 'tk_done', title: 'Tâche finie', status: 'done', due_date: hier(), pinned: 1 },
        ],
      });
      api.db.prepare("UPDATE tasks SET priority='high' WHERE id IN ('tk_high','tk_done')").run();
      render(<App />);

      await within(board()).findByText('Tâche ordinaire');
      for (const name of ['En retard 1', 'Aujourd\'hui 1', 'En cours 1', 'Épinglées 1', 'Haute 1']) {
        expect(within(views()).getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false');
      }
      expect(within(views()).getByRole('button', { name: 'Toutes' })).toHaveAttribute('aria-pressed', 'true');

      await user.click(within(views()).getByRole('button', { name: 'En retard 1' }));
      expect(within(views()).getByRole('button', { name: 'En retard 1' })).toHaveAttribute('aria-pressed', 'true');
      expect(titles()).toEqual(['Tâche en retard']);
      // Seules les colonnes où la vue trouve quelque chose restent.
      expect(within(board()).getAllByRole('heading').map((heading) => heading.textContent)).toEqual(['À faire 1']);

      await user.click(within(views()).getByRole('button', { name: 'En cours 1' }));
      expect(titles()).toEqual(['Tâche en cours']);
      await user.click(within(views()).getByRole('button', { name: 'Épinglées 1' }));
      expect(titles()).toEqual(['Tâche épinglée']);
      await user.click(within(views()).getByRole('button', { name: 'Haute 1' }));
      expect(titles()).toEqual(['Tâche urgente']);
      await user.click(within(views()).getByRole('button', { name: "Aujourd'hui 1" }));
      expect(titles()).toEqual(['Tâche du jour']);

      // Recliquer la vue active la lève, comme une pastille de projet.
      await user.click(within(views()).getByRole('button', { name: "Aujourd'hui 1" }));
      expect(titles()).toHaveLength(6);
      await user.click(within(board()).getByRole('button', { name: 'Afficher les tâches terminées (1)' }));
      expect(titles()).toHaveLength(7);
      await user.click(within(views()).getByRole('button', { name: 'En cours 1' }));
      await user.click(within(views()).getByRole('button', { name: 'Toutes' }));
      expect(titles()).toHaveLength(7);
    });

    test('rien à surveiller : pas de pastilles', async () => {
      seedData(api.db, { tasks: [{ id: 'tk_1', title: 'Tâche calme' }] });
      render(<App />);

      await within(board()).findByText('Tâche calme');
      expect(within(board()).queryByRole('group', { name: 'Filtrer les tâches' })).not.toBeInTheDocument();
    });

    test('une vue vidée le dit et garde sa pastille pour en sortir', async () => {
      const user = userEvent.setup();
      seedData(api.db, {
        tasks: [
          { id: 'tk_late', title: 'Tâche en retard', due_date: hier() },
          { id: 'tk_plain', title: 'Tâche ordinaire' },
        ],
      });
      render(<App />);

      await user.click(await within(board()).findByRole('button', { name: 'En retard 1' }));
      await user.click(within(board()).getByLabelText('Terminer Tâche en retard'));

      expect(await within(board()).findByText('Rien en retard.')).toBeInTheDocument();
      expect(within(views()).getByRole('button', { name: 'En retard 0' })).toHaveAttribute('aria-pressed', 'true');
      await user.click(within(views()).getByRole('button', { name: 'Toutes' }));
      expect(await within(board()).findByText('Tâche ordinaire')).toBeInTheDocument();
      // Plus rien à surveiller : les pastilles s'effacent.
      expect(within(board()).queryByRole('group', { name: 'Filtrer les tâches' })).not.toBeInTheDocument();
    });

    test('ajouter une tâche lève la vue pour la montrer', async () => {
      const user = userEvent.setup();
      seedData(api.db, { tasks: [{ id: 'tk_doing', title: 'Tâche en cours', status: 'doing' }] });
      render(<App />);

      await user.click(await within(board()).findByRole('button', { name: 'En cours 1' }));
      await user.type(screen.getByLabelText('Nouvelle tâche'), 'Tâche neuve{Enter}');

      expect(await within(board()).findByRole('button', { name: 'Tâche neuve' })).toBeInTheDocument();
      expect(within(views()).getByRole('button', { name: 'Toutes' })).toHaveAttribute('aria-pressed', 'true');
    });

    test('déposer sur une carte d’une vue la place dans la colonne entière', async () => {
      seedData(api.db, {
        projects: [{ id: 'pr_a', name: 'Alpha' }],
        tasks: [
          { id: 'tk_a', title: 'Tâche ordinaire', project_id: 'pr_a' },
          { id: 'tk_b', title: 'Tâche en retard', due_date: hier(), project_id: 'pr_a' },
          { id: 'tk_c', title: 'Tâche en cours en retard', status: 'doing', due_date: hier(), project_id: 'pr_a' },
        ],
      });
      render(<App />);

      // Le glisser-déposer est celui des colonnes d'un projet.
      fireEvent.click(await within(filters()).findByRole('button', { name: /Alpha/ }));
      await within(board()).findByRole('heading', { name: 'À faire 2' });
      fireEvent.click(within(board()).getByRole('button', { name: 'En retard 2' }));
      const dataTransfer = { data: {} as Record<string, string>, setData(k: string, v: string) { this.data[k] = v; }, getData(k: string) { return this.data[k]; } };
      fireEvent.dragStart(within(board()).getByText('Tâche en cours en retard').closest('.card')!, { dataTransfer });
      fireEvent.drop(within(board()).getByText('Tâche en retard').closest('.card')!, { dataTransfer });

      // « Tâche ordinaire » est cachée par la vue mais garde sa place devant.
      const todo = () => (api.db.prepare("SELECT id FROM tasks WHERE status='todo' ORDER BY position").all() as { id: string }[]).map((task) => task.id);
      await waitFor(() => expect(todo()).toEqual(['tk_a', 'tk_c', 'tk_b']));
    });

    test('les compteurs de l’en-tête ouvrent les tâches, et lèvent le projet s’il en cache', async () => {
      const user = userEvent.setup();
      seedData(api.db, {
        projects: [{ id: 'pr_a', name: 'Alpha' }, { id: 'pr_b', name: 'Bravo' }],
        tasks: [
          { id: 'tk_doing', title: 'Tâche en cours', status: 'doing', project_id: 'pr_a' },
          { id: 'tk_late', title: 'Tâche en retard', due_date: hier(), project_id: 'pr_b' },
        ],
      });
      localStorage.setItem('worklogs-project', 'pr_a');
      localStorage.setItem('worklogs-show-right', '0');
      render(<App />);
      const header = await screen.findByRole('banner');
      const alpha = () => within(filters()).getByRole('button', { name: /Alpha/ });

      // La tâche en cours est dans Alpha : le projet reste filtré.
      await user.click(await within(header).findByRole('button', { name: '1 en cours' }));
      expect(within(header).getByRole('button', { name: 'Tâches' })).toHaveAttribute('aria-pressed', 'true');
      expect(within(views()).getByRole('button', { name: 'En cours 1' })).toHaveAttribute('aria-pressed', 'true');
      expect(alpha()).toHaveAttribute('aria-pressed', 'true');
      expect(titles()).toEqual(['Tâche en cours']);

      // La tâche en retard est dans Bravo : le filtre Alpha la cacherait, il est levé.
      await user.click(within(header).getByRole('button', { name: '1 en retard' }));
      await waitFor(() => expect(within(filters()).getByRole('button', { name: 'Tout' })).toHaveAttribute('aria-pressed', 'true'));
      expect(await within(board()).findByText('Tâche en retard')).toBeInTheDocument();
      expect(within(views()).getByRole('button', { name: 'En retard 1' })).toHaveAttribute('aria-pressed', 'true');
      expect(titles()).toEqual(['Tâche en retard']);
    });
  });

  test('supprime une tâche', async () => {
    const user = userEvent.setup();
    seedData(api.db, { tasks: [{ id: 'tk_1', title: 'À jeter' }] });
    render(<App />);

    await user.click(await screen.findByLabelText('Supprimer À jeter'));

    await waitFor(() => expect(row(api.db, 'SELECT COUNT(*) n FROM tasks').n).toBe(0));
  });

  test('déplace une carte d’une colonne à l’autre par glisser-déposer', async () => {
    // Les colonnes et leur glisser-déposer sont ceux d'un projet ; « Tout » montre une liste.
    seedData(api.db, { projects: [{ id: 'pr_a', name: 'Alpha' }], tasks: [{ id: 'tk_1', title: 'À déplacer', project_id: 'pr_a' }] });
    render(<App />);
    fireEvent.click(await within(filters()).findByRole('button', { name: /Alpha/ }));
    await within(board()).findByRole('heading', { name: 'À faire 1' });

    const card = within(board()).getByText('À déplacer').closest('.card')!;
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
    // Une ligne par document : l'origine et la date passent dans l'infobulle.
    expect(await within(board()).findByRole('button', { name: 'Ouvrir Note locale' })).toHaveAttribute('title', expect.stringContaining('Note locale — local ·'));
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
    const opener = await within(board()).findByRole('button', { name: 'Ouvrir Note Google' });
    expect(opener).toHaveAttribute('title', expect.stringContaining('Note Google — Google ·'));
    expect(opener.previousElementSibling).toHaveClass('is-google');
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

    await user.click(await within(board()).findByRole('button', { name: 'Afficher les tâches terminées (1)' }));
    const card = (await within(board()).findByText('Tâche finie')).closest('.card') as HTMLElement;
    // Replié par défaut : le compteur reste visible, le document est masqué.
    expect(within(card).getByRole('button', { name: 'Afficher l’historique des documents de Tâche finie' })).toHaveTextContent('Historique · 1 document');
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

    const projects = await openProjects();
    await user.type(projects.getByLabelText('Nom du nouveau projet'), 'Nouveau chantier{Enter}');

    expect(await within(filters()).findByRole('button', { name: /Nouveau chantier/ })).toBeInTheDocument();
    expect(row(api.db, 'SELECT * FROM projects').name).toBe('Nouveau chantier');
  });

  test('cliquer « Créer » à vide explique au lieu de ne rien faire', async () => {
    const user = userEvent.setup();
    seedData(api.db, { projects: [{ id: 'pr_a', name: 'Alpha' }] });
    render(<App />);

    const projects = await openProjects();
    // Le bouton était désactivé : sans projet à l'écran, il se lisait comme cassé.
    const bouton = projects.getByRole('button', { name: 'Créer' });
    expect(bouton).toBeEnabled();

    await user.click(bouton);
    expect(await projects.findByText('Donne un nom au projet.')).toBeInTheDocument();
    expect(projects.getByLabelText('Nom du nouveau projet')).toHaveFocus();
    expect(row(api.db, 'SELECT COUNT(*) n FROM projects').n).toBe(1);

    await user.type(projects.getByLabelText('Nom du nouveau projet'), 'Atelier');
    expect(projects.queryByText('Donne un nom au projet.')).not.toBeInTheDocument();
    await user.click(bouton);
    await waitFor(() => expect(row(api.db, 'SELECT COUNT(*) n FROM projects WHERE name=?', 'Atelier').n).toBe(1));
  });

  test('sans aucun projet, le panneau dit quoi faire et reste utilisable', async () => {
    const user = userEvent.setup();
    render(<App />);

    const projects = await openProjects();
    expect(projects.getByText(/Aucun projet/)).toBeInTheDocument();

    await user.type(projects.getByLabelText('Nom du nouveau projet'), 'Premier projet{Enter}');

    expect(await within(filters()).findByRole('button', { name: /Premier projet/ })).toBeInTheDocument();
    expect(projects.queryByText(/Aucun projet/)).not.toBeInTheDocument();
  });

  test('renomme un projet', async () => {
    const user = userEvent.setup();
    seedData(api.db, { projects: [{ id: 'pr_a', name: 'Avant' }] });
    render(<App />);

    const projects = await openProjects();
    const field = projects.getByLabelText('Nom de Avant');
    await user.clear(field);
    await user.type(field, 'Après');
    fireEvent.blur(field);

    await waitFor(() => expect(row(api.db, 'SELECT * FROM projects').name).toBe('Après'));
  });

  test('Entrée valide le renommage', async () => {
    const user = userEvent.setup();
    seedData(api.db, { projects: [{ id: 'pr_a', name: 'Avant' }] });
    render(<App />);

    const projects = await openProjects();
    const field = projects.getByLabelText('Nom de Avant');
    await user.clear(field);
    await user.type(field, 'Après{Enter}');

    // Sans cette validation au clavier, le renommage n'était enregistré qu'en
    // cliquant ailleurs — l'utilisateur croyait la fonction cassée.
    await waitFor(() => expect(row(api.db, 'SELECT * FROM projects').name).toBe('Après'));
    expect(await within(filters()).findByRole('button', { name: /Après/ })).toBeInTheDocument();
  });

  test('Échap annule le renommage en cours sans fermer la gestion', async () => {
    const user = userEvent.setup();
    seedData(api.db, { projects: [{ id: 'pr_a', name: 'Avant' }] });
    render(<App />);

    const projects = await openProjects();
    const field = projects.getByLabelText('Nom de Avant');
    await user.clear(field);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await user.type(field, 'Jamais enregistré');
    field.dispatchEvent(escape);

    expect(field).toHaveValue('Avant');
    // Échap « consommé » : la fenêtre (qui se ferme sur Échap) reste ouverte.
    expect(escape.defaultPrevented).toBe(true);
    expect(screen.getByRole('dialog', { name: /^Projets/ })).toBeInTheDocument();
    expect(row(api.db, 'SELECT * FROM projects').name).toBe('Avant');
  });

  test('la gestion s’annonce comme un dialogue et ne laisse rien derrière elle', async () => {
    const user = userEvent.setup();
    render(<App />);

    const bouton = await screen.findByRole('button', { name: 'Gérer les projets' });
    expect(bouton).toHaveAttribute('aria-haspopup', 'dialog');
    expect(bouton).toHaveAttribute('aria-expanded', 'false');
    // Fermée, la gestion ne doit rien laisser d'utilisable : c'est ce qui rendait
    // la création introuvable quand le dépliant passait pour une simple légende.
    expect(screen.queryByLabelText('Nom du nouveau projet')).not.toBeInTheDocument();

    await user.click(bouton);
    const dialog = await screen.findByRole('dialog', { name: /^Projets/ });
    expect(bouton).toHaveAttribute('aria-expanded', 'true');
    // Hors du bandeau : rien ne s'insère dans la page, rien ne pousse les colonnes.
    expect(document.querySelector('.project-strip')!.contains(dialog)).toBe(false);

    await user.click(within(dialog).getByRole('button', { name: 'Fermer' }));
    expect(screen.queryByRole('dialog', { name: /^Projets/ })).not.toBeInTheDocument();
    expect(bouton).toHaveAttribute('aria-expanded', 'false');
    expect(bouton).toHaveFocus();
  });

  test('fermer la gestion enregistre le renommage en cours', async () => {
    const user = userEvent.setup();
    seedData(api.db, { projects: [{ id: 'pr_a', name: 'Avant' }] });
    render(<App />);

    await openProjects();
    const field = screen.getByLabelText('Nom de Avant');
    await user.clear(field);
    await user.type(field, 'Après');
    // Échap sur la fenêtre (ou clic sur le voile) : le champ encore actif valide d'abord.
    fireEvent(screen.getByRole('dialog', { name: /^Projets/ }), new Event('cancel', { cancelable: true }));

    await waitFor(() => expect(row(api.db, 'SELECT * FROM projects').name).toBe('Après'));
    expect(screen.queryByRole('dialog', { name: /^Projets/ })).not.toBeInTheDocument();
  });

  test('au-delà de sept projets, un champ retrouve un projet par son nom', async () => {
    const user = userEvent.setup();
    const names = ['Active Directory', 'Intranet RH', 'Messagerie', 'Onboarding', 'Pare-feu Fortinet', 'Sauvegardes', 'Téléphonie', 'Wi-Fi'];
    seedData(api.db, { projects: names.map((name, i) => ({ id: `pr_${i}`, name })) });
    render(<App />);

    const projects = await openProjects();
    const search = projects.getByLabelText('Retrouver un projet');
    await user.type(search, 'FORTI');
    expect(projects.getByLabelText('Nom de Pare-feu Fortinet')).toBeInTheDocument();
    expect(projects.queryByLabelText('Nom de Messagerie')).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, 'compta');
    expect(projects.getByText('Aucun projet ne s’appelle « compta ».')).toBeInTheDocument();
    // Créer depuis la gestion vide le filtre : le nouveau projet est à l'écran.
    await user.type(projects.getByLabelText('Nom du nouveau projet'), 'Compta{Enter}');
    expect(await projects.findByLabelText('Nom de Compta')).toBeInTheDocument();
    expect(search).toHaveValue('');
  });

  test('peu de projets : pas de champ de recherche', async () => {
    seedData(api.db, { projects: [{ id: 'pr_a', name: 'Alpha' }, { id: 'pr_b', name: 'Bêta' }] });
    render(<App />);

    const projects = await openProjects();
    expect(projects.getByLabelText('Nom de Alpha')).toBeInTheDocument();
    expect(projects.queryByLabelText('Retrouver un projet')).not.toBeInTheDocument();
  });

  test('supprimer un projet garde ses entrées', async () => {
    const user = userEvent.setup();
    seedData(api.db, {
      projects: [{ id: 'pr_a', name: 'Alpha' }],
      entries: [{ id: 'en_a', title: 'Survivante', project_id: 'pr_a' }],
    });
    render(<App />);

    const projects = await openProjects();
    await user.click(projects.getByLabelText('Supprimer Alpha'));

    await waitFor(() => expect(row(api.db, 'SELECT COUNT(*) n FROM projects').n).toBe(0));
    expect(await within(journal()).findByText('Survivante')).toBeInTheDocument();
  });

  test('la pastille d’un projet porte sa couleur, celle du filtre actif comprise', async () => {
    const user = userEvent.setup();
    seedData(api.db, { projects: [{ id: 'pr_a', name: 'Alpha', color: '#10b981' }] });
    render(<App />);

    const alpha = await within(filters()).findByRole('button', { name: 'Alpha' });
    expect(alpha.style.getPropertyValue('--project')).toBe('#10b981');
    await user.click(alpha);
    await waitFor(() => expect(alpha).toHaveAttribute('aria-pressed', 'true'));
    expect(alpha).toHaveClass('is-on');
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

describe('vue d’ensemble des projets', () => {
  const hier = () => new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const page = () => screen.getByRole('region', { name: 'Vue d’ensemble des projets' });
  const toggle = () => screen.getByRole('button', { name: 'Vue d’ensemble des tâches' });
  const columns = () => document.querySelector('.columns') as HTMLElement;
  const panel = (name: string) => within(screen.getByRole('group', { name: 'Panneaux latéraux' })).getByRole('button', { name });

  test('une entrée choisie pendant l’attente de la vue d’ensemble reste au centre', async () => {
    seedData(api.db, { entries: [{ id: 'en_1', title: 'Première entrée' }, { id: 'en_2', title: 'Entrée choisie' }] });
    render(<App />);
    await within(journal()).findByText('Entrée choisie');
    let finish!: (ok: boolean) => void;
    let calls = 0;
    const removeGuard = setLeaveGuard(() => ++calls === 1 ? new Promise<boolean>((resolve) => { finish = resolve; }) : Promise.resolve(true));
    try {
      fireEvent.click(toggle());
      await waitFor(() => expect(calls).toBe(1));
      fireEvent.click(within(journal()).getByText('Entrée choisie'));
      await waitFor(() => expect(calls).toBe(2));
      expect(await screen.findByDisplayValue('Entrée choisie')).toBeInTheDocument();
      await act(async () => finish(true));
      expect(screen.queryByRole('region', { name: 'Vue d’ensemble des projets' })).not.toBeInTheDocument();
      expect(screen.getByDisplayValue('Entrée choisie')).toBeInTheDocument();
    } finally {
      removeGuard();
    }
  });

  test('une voie par projet au centre : terminées comptées, nœuds des ouvertes ; un nom filtre, un nœud mène à la carte, Fermer rend l’entrée', async () => {
    const user = userEvent.setup();
    seedData(api.db, {
      projects: [{ id: 'pr_a', name: 'Alpha' }, { id: 'pr_b', name: 'Bravo' }],
      entries: [{ id: 'en_1', title: 'Compte rendu', project_id: 'pr_a', date: hier() }],
      tasks: [
        { id: 'tk_done', title: 'Faite', status: 'done', project_id: 'pr_a' },
        { id: 'tk_doing', title: 'Préparer le devis', status: 'doing', project_id: 'pr_a' },
        { id: 'tk_late', title: 'Relancer', due_date: hier(), project_id: 'pr_a' },
        { id: 'tk_pin', title: 'Appeler', pinned: 1, project_id: 'pr_a' },
        { id: 'tk_free', title: 'Libre', project_id: null },
      ],
    });
    render(<App />);
    await screen.findByDisplayValue('Compte rendu');
    await user.click(toggle());

    expect(await screen.findByRole('region', { name: 'Vue d’ensemble des projets' })).toBeInTheDocument();
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('region', { name: 'Entrée' })).not.toBeInTheDocument();
    // Elle recouvre les panneaux ; le panneau Tâches n'a plus son propre bouton.
    expect(columns()).toHaveClass('hide-left', 'hide-right');
    expect(columns()).not.toHaveClass('hide-center');
    expect(columns()).not.toHaveClass('show-procedures');
    expect(panel('Journal')).toHaveAttribute('aria-pressed', 'false');
    expect(within(board()).queryByRole('button', { name: /Vue d’ensemble/ })).not.toBeInTheDocument();
    expect(within(page()).getByText(/4 ouvertes · 1 terminée/)).toHaveTextContent('1 en retard');
    const alpha = within(page()).getByRole('listitem', { name: 'Alpha : 1 terminée sur 4, 1 en cours, 2 à faire' });
    expect(within(alpha).getByTitle('1 terminée')).toHaveTextContent('1');
    expect(within(alpha).getByText('1/4 · 25 %')).toBeInTheDocument();
    expect(within(alpha).getByText('note hier')).toBeInTheDocument();
    expect(within(alpha).getByText('Préparer le devis')).toBeInTheDocument();
    expect(within(alpha).getByRole('button', { name: 'Préparer le devis — en cours' })).toHaveClass('is-doing');
    expect(within(alpha).getByRole('button', { name: 'Relancer — à faire · en retard de 1 jour' })).toHaveClass('is-late');
    expect(within(alpha).getByRole('button', { name: 'Appeler — à faire · épinglée' })).toHaveClass('is-pinned');
    expect(within(page()).getByRole('listitem', { name: 'Bravo : 0 terminée sur 0, 0 en cours, 0 à faire' })).toHaveTextContent('Aucune tâche');
    expect(within(page()).getByRole('listitem', { name: 'Sans projet : 0 terminée sur 1, 0 en cours, 1 à faire' })).toHaveTextContent('Rien en cours');

    // Un nœud ferme la vue et ouvre directement la carte de la tâche.
    await user.click(within(alpha).getByRole('button', { name: 'Relancer — à faire · en retard de 1 jour' }));
    await waitFor(() => expect(document.activeElement).toBe(within(board()).getByRole('textbox', { name: 'Titre de la tâche' })));
    expect(within(board()).getByRole('textbox', { name: 'Titre de la tâche' })).toHaveValue('Relancer');
    expect(columns()).not.toHaveClass('hide-right');
    expect(panel('Tâches')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('region', { name: 'Vue d’ensemble des projets' })).not.toBeInTheDocument();
    await user.click(toggle());
    await screen.findByRole('region', { name: 'Vue d’ensemble des projets' });
    // Les boutons de l'en-tête rouvrent un panneau à côté, ou le replient, sans fermer la vue.
    await user.click(panel('Journal'));
    expect(columns()).not.toHaveClass('hide-left');
    await user.click(panel('Tâches'));
    expect(columns()).not.toHaveClass('hide-right');
    await user.click(panel('Tâches'));
    expect(columns()).toHaveClass('hide-right');
    expect(page()).toBeInTheDocument();

    // Un nom filtre le projet et referme la vue ; depuis un projet, « Vue d’ensemble » lève le filtre.
    await user.click(within(page()).getByRole('button', { name: 'Filtrer sur Alpha' }));
    await waitFor(() => expect(within(filters()).getByRole('button', { name: /Alpha/ })).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.queryByRole('region', { name: 'Vue d’ensemble des projets' })).not.toBeInTheDocument();
    await user.click(toggle());
    await screen.findByRole('region', { name: 'Vue d’ensemble des projets' });
    await waitFor(() => expect(within(filters()).getByRole('button', { name: 'Tout' })).toHaveAttribute('aria-pressed', 'true'));

    // Rouverte, elle recouvre de nouveau tout ; un compteur de l'en-tête rouvre Tâches à côté.
    expect(columns()).toHaveClass('hide-left', 'hide-right');
    await user.click(screen.getByTitle('Voir les tâches en retard'));
    expect(columns()).not.toHaveClass('hide-right');
    expect(page()).toBeInTheDocument();

    // Fermer rend l'entrée et les panneaux tels quels ; « Écriture » et ouvrir une entrée referment aussi.
    await user.click(screen.getByRole('button', { name: 'Fermer la vue d’ensemble' }));
    expect(await screen.findByDisplayValue('Compte rendu')).toBeInTheDocument();
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    expect(columns()).not.toHaveClass('hide-left');
    expect(columns()).not.toHaveClass('hide-right');
    await user.click(toggle());
    await screen.findByRole('region', { name: 'Vue d’ensemble des projets' });
    await user.click(panel('Écriture'));
    expect(await screen.findByDisplayValue('Compte rendu')).toBeInTheDocument();
    expect(panel('Écriture')).toHaveAttribute('aria-pressed', 'true');
    await user.click(toggle());
    await screen.findByRole('region', { name: 'Vue d’ensemble des projets' });
    await user.click(within(journal()).getByText('Compte rendu'));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Vue d’ensemble des projets' })).not.toBeInTheDocument());
    expect(await screen.findByDisplayValue('Compte rendu')).toBeInTheDocument();
  });

  test('ouvrir une tâche ferme la vue et montre sa carte même si le panneau était replié', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-show-right', '0');
    seedData(api.db, { projects: [{ id: 'pr_a', name: 'Alpha' }, { id: 'pr_b', name: 'Bravo' }], tasks: [{ id: 'tk_1', title: 'Relancer', project_id: 'pr_a' }] });
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Vue d’ensemble des tâches' }));
    await user.click(await within(page()).findByRole('button', { name: 'Relancer — à faire' }));
    expect(columns()).not.toHaveClass('hide-right');
    expect(screen.queryByRole('region', { name: 'Vue d’ensemble des projets' })).not.toBeInTheDocument();
    expect(await within(board()).findByRole('textbox', { name: 'Titre de la tâche' })).toHaveValue('Relancer');
    expect(localStorage.getItem('worklogs-show-right')).toBe('1');
  });

  test('ouvrir une tâche depuis la vue affiche son entrée liée la plus récente et respecte la garde de sortie', async () => {
    seedData(api.db, {
      entries: [
        { id: 'en_initial', title: 'Entrée initiale', date: '2026-11-05' },
        { id: 'en_old', title: 'Ancien diagnostic', date: '2026-11-01' },
        { id: 'en_recent', title: 'Dernières avancées', date: '2026-11-04' },
      ],
      tasks: [{ id: 'tk_linked', title: 'Contrôler la pompe' }],
    });
    // L'ordre des liens ne choisit pas l'entrée : la date la plus récente gagne.
    const link = api.db.prepare('INSERT INTO task_entries (task_id,entry_id,created_at) VALUES (?,?,?)');
    for (const id of ['en_recent', 'en_old']) link.run('tk_linked', id, new Date().toISOString());
    render(<App />);
    await screen.findByDisplayValue('Entrée initiale');
    fireEvent.click(toggle());
    const overview = await screen.findByRole('region', { name: 'Vue d’ensemble des projets' });
    const task = within(overview).getByRole('button', { name: 'Contrôler la pompe — à faire' });
    const guard = vi.fn(async () => false);
    const removeGuard = setLeaveGuard(guard);
    try {
      await act(async () => fireEvent.click(task));
      expect(guard).toHaveBeenCalledOnce();
      expect(overview).toBeInTheDocument();
    } finally {
      removeGuard();
    }
    fireEvent.click(task);
    expect(await screen.findByDisplayValue('Dernières avancées')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Vue d’ensemble des projets' })).not.toBeInTheDocument();
    expect(within(board()).queryByRole('textbox', { name: 'Titre de la tâche' })).not.toBeInTheDocument();
  });

  test('la vue ne garde ni liste de tâches, ni journal, ni ajout : les gestes restent sur les suivis', async () => {
    seedData(api.db, {
      projects: [{ id: 'pr_a', name: 'Alpha' }],
      entries: [{ id: 'en_free', title: 'Note libre' }],
      tasks: [{ id: 'tk_free', title: 'Tâche libre', project_id: 'pr_a' }, { id: 'tk_followed', title: 'Tâche suivie', project_id: 'pr_a' }],
    });
    await clientApi.saveFollowUp('task', 'tk_followed', { enabled: false });
    render(<App />);
    await within(board()).findByRole('button', { name: 'Tâche libre' });
    fireEvent.click(screen.getByRole('button', { name: 'Vue d’ensemble des tâches' }));
    const overview = await screen.findByRole('region', { name: 'Vue d’ensemble des projets' });
    expect(within(overview).queryByRole('list', { name: 'Liste des tâches de la vue d’ensemble' })).not.toBeInTheDocument();
    expect(within(overview).queryByText(/^Entrées du journal/)).not.toBeInTheDocument();
    expect(within(overview).queryByText('Note libre')).not.toBeInTheDocument();
    expect(within(overview).queryByLabelText('Nouvelle tâche dans la vue d’ensemble')).not.toBeInTheDocument();
    // Une tâche sans suivi n'a plus de gestes ici : elle reste un nœud de la frise.
    expect(within(overview).queryByLabelText('Statut de Tâche libre')).not.toBeInTheDocument();
    expect(within(overview).getByRole('button', { name: 'Tâche libre — à faire' })).toBeInTheDocument();
    expect(within(within(overview).getByRole('region', { name: 'Bilans et suivis IA' })).getByLabelText('Statut de Tâche suivie')).toHaveValue('todo');
  });

  test('valider depuis la vue termine la tâche et archive ses documents ; rouvrir conserve les archives', async () => {
    const backend = { timeout: 5000 };
    seedData(api.db, {
      entries: [{ id: 'en_note', title: 'Intervention réalisée' }, { id: 'en_proc', title: 'Mode opératoire', kind: 'procedure' }],
      tasks: [{ id: 'tk_finish', title: 'Finir le contrôle' }],
    });
    const link = api.db.prepare('INSERT INTO task_entries (task_id,entry_id,created_at) VALUES (?,?,?)');
    for (const id of ['en_note', 'en_proc']) link.run('tk_finish', id, new Date().toISOString());
    await clientApi.saveFollowUp('task', 'tk_finish', { enabled: false });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Vue d’ensemble des tâches' }));
    const overview = await screen.findByRole('region', { name: 'Vue d’ensemble des projets' }, backend);
    const validate = within(overview).getByRole('button', { name: 'Valider la tâche Finir le contrôle' });
    validate.focus();
    fireEvent.click(validate);
    await waitFor(() => expect(row(api.db, 'SELECT status FROM tasks WHERE id=?', 'tk_finish').status).toBe('done'), backend);
    await waitFor(() => expect(within(overview).getByLabelText('Statut de Finir le contrôle')).toHaveValue('done'), backend);
    expect(row(api.db, 'SELECT archived FROM entries WHERE id=?', 'en_note').archived).toBe(1);
    expect(row(api.db, 'SELECT archived FROM entries WHERE id=?', 'en_proc').archived).toBe(1);
    expect(overview.querySelector('.overview-status')).toHaveTextContent(/validée|terminée/i);

    // La carte reste affichée : le focus reste sur le bouton, devenu « Rouvrir ».
    const reopen = await within(overview).findByRole('button', { name: 'Rouvrir la tâche Finir le contrôle' }, backend);
    expect(reopen).toHaveFocus();
    fireEvent.click(reopen);
    await waitFor(() => expect(row(api.db, 'SELECT status FROM tasks WHERE id=?', 'tk_finish').status).toBe('todo'), backend);
    expect(await within(overview).findByRole('button', { name: 'Valider la tâche Finir le contrôle' }, backend)).toBeInTheDocument();
    expect(row(api.db, 'SELECT archived FROM entries WHERE id=?', 'en_note').archived).toBe(1);
    fireEvent.change(within(overview).getByLabelText('Statut de Finir le contrôle'), { target: { value: 'doing' } });
    await waitFor(() => expect(row(api.db, 'SELECT status FROM tasks WHERE id=?', 'tk_finish').status).toBe('doing'), backend);
    expect(screen.getByRole('region', { name: 'Vue d’ensemble des projets' })).toBeInTheDocument();
  }, 20_000);

  test('archive et désarchive une entrée suivie depuis sa carte sans retirer son suivi', async () => {
    const backend = { timeout: 5000 };
    seedData(api.db, { entries: [{ id: 'en_followed', title: 'Note suivie archivée' }] });
    api.db.prepare('UPDATE entries SET archived=1 WHERE id=?').run('en_followed');
    await clientApi.saveFollowUp('entry', 'en_followed', { enabled: false });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Vue d’ensemble des tâches' }));
    const overview = await screen.findByRole('region', { name: 'Vue d’ensemble des projets' }, backend);
    const reports = within(overview).getByRole('region', { name: 'Bilans et suivis IA' });
    fireEvent.click(within(reports).getByRole('button', { name: 'Désarchiver l’entrée Note suivie archivée' }));
    await waitFor(() => expect(row(api.db, 'SELECT archived FROM entries WHERE id=?', 'en_followed').archived).toBe(0), backend);
    fireEvent.click(await within(reports).findByRole('button', { name: 'Archiver l’entrée Note suivie archivée' }, backend));
    await waitFor(() => expect(row(api.db, 'SELECT archived FROM entries WHERE id=?', 'en_followed').archived).toBe(1), backend);
    expect(within(reports).getByRole('region', { name: 'Suivi IA de Note suivie archivée' })).toBeInTheDocument();
  }, 20_000);

  test('un statut ou un archivage refusé conserve la source et annonce l’erreur sans quitter la vue', async () => {
    const backend = { timeout: 5000 };
    seedData(api.db, { entries: [{ id: 'en_keep', title: 'Note à garder' }], tasks: [{ id: 'tk_keep', title: 'Contrôle à garder' }] });
    api.db.prepare('INSERT INTO task_entries (task_id,entry_id,created_at) VALUES (?,?,?)').run('tk_keep', 'en_keep', new Date().toISOString());
    await clientApi.saveFollowUp('task', 'tk_keep', { enabled: false });
    await clientApi.saveFollowUp('entry', 'en_keep', { enabled: false });
    const originalMove = clientApi.moveTask.bind(clientApi);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Vue d’ensemble des tâches' }));
    const overview = await screen.findByRole('region', { name: 'Vue d’ensemble des projets' }, backend);
    vi.spyOn(clientApi, 'moveTask').mockRejectedValueOnce(new Error('Changement de statut refusé'));
    const status = within(overview).getByLabelText('Statut de Contrôle à garder');
    status.focus();
    fireEvent.change(status, { target: { value: 'doing' } });
    expect(await within(overview).findByRole('alert', {}, backend)).toHaveTextContent('Changement de statut refusé');
    expect(status).toHaveValue('todo');
    expect(status).toHaveFocus();
    expect(row(api.db, 'SELECT status FROM tasks WHERE id=?', 'tk_keep').status).toBe('todo');
    vi.spyOn(clientApi, 'updateEntry').mockRejectedValueOnce(new Error('Archivage refusé'));
    const archive = within(overview).getByRole('button', { name: 'Archiver l’entrée Note à garder' });
    archive.focus();
    fireEvent.click(archive);
    expect(await within(overview).findByRole('alert', {}, backend)).toHaveTextContent('Archivage refusé');
    expect(archive).toBeInTheDocument();
    expect(archive).toHaveFocus();
    expect(row(api.db, 'SELECT archived FROM entries WHERE id=?', 'en_keep').archived).toBe(0);
    expect(screen.getByRole('region', { name: 'Vue d’ensemble des projets' })).toBeInTheDocument();
    // Une réponse perdue après écriture doit relire le statut réel, sans rejouer
    // la validation ni laisser la tâche comme si le serveur l'avait refusée.
    vi.mocked(clientApi.moveTask).mockImplementationOnce(async (...args) => {
      await originalMove(...args);
      throw new Error('Réponse perdue après validation');
    });
    fireEvent.click(within(overview).getByRole('button', { name: 'Valider la tâche Contrôle à garder' }));
    expect(await within(overview).findByRole('alert', {}, backend)).toHaveTextContent('Réponse perdue après validation');
    await waitFor(() => expect(within(overview).getByLabelText('Statut de Contrôle à garder')).toHaveValue('done'), backend);
    expect(row(api.db, 'SELECT status FROM tasks WHERE id=?', 'tk_keep').status).toBe('done');
    expect(row(api.db, 'SELECT archived FROM entries WHERE id=?', 'en_keep').archived).toBe(1);
    expect(clientApi.moveTask).toHaveBeenCalledTimes(2);
  }, 20_000);

  test('la vue prévient et bloque l’IA si des tâches ouvertes dépassent la limite du serveur', async () => {
    seedData(api.db, { tasks: [
      ...Array.from({ length: 500 }, (_, i) => ({ id: `done_${i}`, title: `Terminée ${i}`, status: 'done' })),
      { id: 'tk_lost', title: 'Ouverte hors limite', status: 'todo' },
    ] });
    render(<App />);
    await screen.findByRole('button', { name: 'Vue d’ensemble des tâches' });
    fireEvent.click(screen.getByRole('button', { name: 'Vue d’ensemble des tâches' }));
    const overview = await screen.findByRole('region', { name: 'Vue d’ensemble des projets' });
    expect(within(overview).getByText(/1 tâche ouverte.*manquante/i)).toBeInTheDocument();
    fireEvent.click(within(overview).getByText('Conseils détaillés avec l’IA'));
    const advice = within(overview).getByRole('region', { name: 'Conseils IA pour les tâches' });
    expect(within(advice).getByRole('button', { name: 'Préparer les conseils' })).toBeDisabled();
    expect(within(advice).getByText(/1 tâche ouverte manque/)).toBeInTheDocument();
  }, 15_000);

  test('au-delà de 60 tâches, on sélectionne explicitement celles à conseiller et une réponse partielle le dit', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, { tasks: Array.from({ length: 61 }, (_, i) => ({ id: `tk_${i}`, title: `Tâche ${i + 1}` })) });
    mockAiSuggest('[{"n":1,"reason":"À examiner.","advice":"Vérifier."}]');
    render(<App />);
    await within(board()).findByRole('button', { name: 'Tâche 1' });
    fireEvent.click(screen.getByRole('button', { name: 'Vue d’ensemble des tâches' }));
    fireEvent.click(await screen.findByText('Conseils détaillés avec l’IA'));
    const advice = await screen.findByRole('region', { name: 'Conseils IA pour les tâches' });
    expect(within(advice).getByRole('button', { name: 'Préparer les conseils' })).toBeDisabled();
    fireEvent.click(within(advice).getByRole('button', { name: 'Sélectionner les 60 premières' }));
    expect(within(advice).getByText(/60\/60/)).toBeInTheDocument();
    fireEvent.click(within(advice).getByRole('button', { name: 'Préparer les conseils' }));
    fireEvent.click(await within(advice).findByRole('button', { name: 'Demander les conseils à l’IA' }));
    const answer = await within(advice).findByRole('region', { name: 'Ordre conseillé par l’IA' });
    expect(within(answer).getByText(/Réponse incomplète : 1 tâche conseillée sur 60/)).toBeInTheDocument();
  }, 15_000);

  test('passer une tâche en cours puis la cocher garde la réponse IA et l’ordre conseillé', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    // Chaque attente suit un aller-retour du backend : 1 s ne tient pas sous charge.
    const backend = { timeout: 5000 };
    seedData(api.db, { tasks: [{ id: 'tk_a', title: 'Préparer la pompe' }] });
    await clientApi.saveFollowUp('task', 'tk_a', { enabled: false });
    const diverted = globalThis.fetch;
    let finish!: (response: Response) => void;
    let called = false;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('chat/completions')) {
        called = true;
        return new Promise<Response>((resolve) => { finish = resolve; });
      }
      return diverted(input, init);
    }));
    render(<App />);
    await within(board()).findByRole('button', { name: 'Préparer la pompe' }, backend);
    fireEvent.click(screen.getByRole('button', { name: 'Vue d’ensemble des tâches' }));
    const overview = await screen.findByRole('region', { name: 'Vue d’ensemble des projets' }, backend);
    fireEvent.click(within(overview).getByText('Conseils détaillés avec l’IA'));
    const advice = within(overview).getByRole('region', { name: 'Conseils IA pour les tâches' });
    fireEvent.click(within(advice).getByRole('button', { name: 'Préparer les conseils' }));
    fireEvent.click(await within(advice).findByRole('button', { name: 'Demander les conseils à l’IA' }, backend));
    await waitFor(() => expect(called).toBe(true), backend);
    fireEvent.change(within(overview).getByLabelText('Statut de Préparer la pompe'), { target: { value: 'doing' } });
    await waitFor(() => expect(row(api.db, 'SELECT status FROM tasks WHERE id=?', 'tk_a').status).toBe('doing'), backend);
    // L'état rejoué après le changement de statut ne coupe plus la demande en vol.
    await within(board()).findByRole('heading', { name: 'En cours 1' }, backend);
    expect(within(advice).getByRole('button', { name: 'Arrêter' })).toBeInTheDocument();
    await act(async () => finish({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"summary":"Commence par la pompe.","order":[{"n":1,"reason":"Premier","advice":"Couper l’arrivée."}]}' } }] }) } as Response));
    const answer = await within(advice).findByRole('region', { name: 'Ordre conseillé par l’IA' }, backend);
    fireEvent.click(within(board()).getByRole('checkbox', { name: 'Terminer Préparer la pompe' }));
    await waitFor(() => expect(row(api.db, 'SELECT status FROM tasks WHERE id=?', 'tk_a').status).toBe('done'), backend);
    await waitFor(() => expect(within(answer).getByRole('listitem')).toHaveTextContent('Préparer la pompe · terminée'), backend);
    expect(within(answer).getByText('Couper l’arrivée.')).toBeInTheDocument();
    expect(within(answer).getByRole('region', { name: 'Résumé des conseils IA' })).toHaveTextContent('Commence par la pompe.');
    expect(within(advice).queryByRole('alert')).not.toBeInTheDocument();
  }, 15_000);

  test('préparer les conseils survit à la mise à jour d’une note sans lien', async () => {
    seedData(api.db, {
      tasks: [{ id: 'tk_a', title: 'Vérifier pompe' }],
      entries: [{ id: 'en_keep', title: 'Note liée', content_md: 'Pompe' }, { id: 'en_other', title: 'Note indépendante', content_md: 'Autre' }],
    });
    api.db.prepare('INSERT INTO task_entries (task_id,entry_id,created_at) VALUES (?,?,?)').run('tk_a', 'en_keep', new Date().toISOString());
    const state = await clientApi.state('', '');
    const source = await clientApi.entry('en_keep');
    let finish!: (entry: typeof source) => void;
    const read = vi.spyOn(clientApi, 'entry').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const renderAdvice = (tasks: typeof state.tasks) => <TaskAdvice tasks={tasks} projects={state.projects} onTask={() => {}} />;
    const view = render(renderAdvice(state.tasks));
    fireEvent.click(screen.getByRole('button', { name: 'Préparer les conseils' }));
    await waitFor(() => expect(read).toHaveBeenCalledWith('en_keep'));
    // L'état rejoué après la mise à jour de la note indépendante : mêmes tâches, nouveaux objets.
    view.rerender(renderAdvice(state.tasks.map((task) => ({ ...task, documents: task.documents.map((doc) => ({ ...doc })) }))));
    await act(async () => finish(source));
    expect(await screen.findByRole('checkbox', { name: 'Note : Note liée' })).toBeInTheDocument();
  }, 15_000);

  test('une modification de document lié annule et explique la préparation périmée', async () => {
    seedData(api.db, {
      tasks: [{ id: 'tk_a', title: 'Vérifier pompe' }],
      entries: [{ id: 'en_keep', title: 'Note liée', content_md: 'Pompe' }],
    });
    api.db.prepare('INSERT INTO task_entries (task_id,entry_id,created_at) VALUES (?,?,?)').run('tk_a', 'en_keep', new Date().toISOString());
    const state = await clientApi.state('', '');
    const source = await clientApi.entry('en_keep');
    let finish!: (entry: typeof source) => void;
    const read = vi.spyOn(clientApi, 'entry').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const renderAdvice = (tasks: typeof state.tasks) => <TaskAdvice tasks={tasks} projects={state.projects} onTask={() => {}} />;
    const view = render(renderAdvice(state.tasks));
    fireEvent.click(screen.getByRole('button', { name: 'Préparer les conseils' }));
    await waitFor(() => expect(read).toHaveBeenCalledWith('en_keep'));
    view.rerender(renderAdvice(state.tasks.map((task) => ({ ...task, documents: task.documents.map((doc) => ({ ...doc, updated_at: '2099-01-01' })) }))));
    expect(await screen.findByRole('alert')).toHaveTextContent('Les tâches ou leur contexte ont changé');
    await act(async () => finish(source));
    expect(screen.queryByRole('checkbox', { name: 'Note : Note liée' })).not.toBeInTheDocument();
  }, 15_000);

  test('les conseils IA relisent les sources choisies et proposent un ordre sans modifier les tâches', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, {
      projects: [{ id: 'pr_a', name: 'Alpha' }],
      tasks: [{ id: 'tk_a', title: 'Vérifier pompe', project_id: 'pr_a' }],
      entries: [
        { id: 'en_keep', title: 'Note à lire', content_md: 'La pompe fuit depuis lundi.', project_id: 'pr_a' },
        { id: 'en_skip', title: 'Note exclue', content_md: 'SECRET NON ENVOYÉ', project_id: 'pr_a' },
      ],
    });
    for (const id of ['en_keep', 'en_skip']) api.db.prepare('INSERT INTO task_entries (task_id,entry_id,created_at) VALUES (?,?,?)').run('tk_a', id, new Date().toISOString());
    mockAiSuggest('{"summary":"Commence par la fuite de la pompe, puis vérifie le joint.","order":[{"n":1,"reason":"Une fuite attend.","advice":"Vérifier le joint."}]}');
    render(<App />);
    await within(board()).findByRole('button', { name: 'Vérifier pompe' });
    fireEvent.click(screen.getByRole('button', { name: 'Vue d’ensemble des tâches' }));
    fireEvent.click(await screen.findByText('Conseils détaillés avec l’IA'));
    const advice = await screen.findByRole('region', { name: 'Conseils IA pour les tâches' });
    fireEvent.click(within(advice).getByRole('button', { name: 'Préparer les conseils' }));
    const excluded = await within(advice).findByRole('checkbox', { name: 'Note : Note exclue' });
    expect(aiBodies).toHaveLength(0);
    fireEvent.click(excluded);
    fireEvent.click(within(advice).getByRole('button', { name: 'Demander les conseils à l’IA' }));
    const answer = await within(advice).findByRole('region', { name: 'Ordre conseillé par l’IA' });
    expect(within(answer).getByText('Une fuite attend.')).toBeInTheDocument();
    expect(within(answer).getByText('Vérifier le joint.')).toBeInTheDocument();
    expect(within(answer).getByRole('region', { name: 'Résumé des conseils IA' })).toHaveTextContent('Commence par la fuite de la pompe, puis vérifie le joint.');
    const prompt = (aiBodies[0] as { messages: { content: string }[] }).messages[1].content;
    expect(prompt).toContain('La pompe fuit depuis lundi.');
    expect(prompt).not.toContain('SECRET NON ENVOYÉ');
    expect(row(api.db, 'SELECT status, priority FROM tasks WHERE id=?', 'tk_a')).toMatchObject({ status: 'todo', priority: 'normal' });
  }, 15_000);

  test('sans projet ni tâche, la page le dit ; un seul projet garde ses colonnes mais ouvre la vue', async () => {
    const user = userEvent.setup();
    seedData(api.db, { projects: [{ id: 'pr_a', name: 'Alpha' }] });
    render(<App />);
    await within(board()).findByRole('heading', { name: 'À faire 0' });
    await user.click(toggle());
    const alpha = await within(await screen.findByRole('region', { name: 'Vue d’ensemble des projets' })).findByRole('listitem', { name: /^Alpha/ });
    expect(alpha).toHaveTextContent('Aucune tâche');
    expect(within(board()).getByRole('heading', { name: 'En cours 0' })).toBeInTheDocument();
  });
});
