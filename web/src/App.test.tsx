import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRoot } from 'react-dom/client';
import App from './App';
import { EntryEditor } from './components/EntryEditor';
import { seedData, useRealApi } from './test/server';
import { discardPendingSaves, flushPendingSaves, hasPendingSaves } from './autosave';
import { setLeaveGuard } from './shared-leave';
import { api as clientApi, type Project } from './lib';
import { TaskAdvice } from './components/TaskAdvice';

let api: Awaited<ReturnType<typeof useRealApi>>;

beforeEach(async () => {
  api = await useRealApi();
  localStorage.clear();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
// Un brouillon en échec fait lever `flushPendingSaves` : le test reste rouge avec ce
// message, mais le reste est rangé et le brouillon oublié, sans quoi il se rejouerait
// sur le serveur du test suivant (« entrée introuvable »).
afterEach(async () => {
  try {
    await flushPendingSaves();
  } finally {
    discardPendingSaves();
    vi.restoreAllMocks();
    await api.close();
  }
});

const journal = () => screen.getByRole('region', { name: 'Journal' });
const board = () => screen.getByRole('region', { name: 'Tâches' });
const editor = () => screen.getByRole('region', { name: 'Entrée' });
const filters = () => screen.getByRole('group', { name: 'Filtrer par projet' });
/** Ouvre le menu « ✨ IA » (celui de l'entrée par défaut) et rend l'action demandée. */
async function aiAction(name: string, scope: HTMLElement = document.body, menu = 'Assistance IA') {
  const trigger = await within(scope).findByRole('button', { name: menu });
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
  return within(scope).findByRole('menuitem', { name });
}
const row = (db: typeof api.db, sql: string, ...args: unknown[]) =>
  db.prepare(sql).get(...args) as Record<string, unknown>;

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

function seedGoogleLink(db: typeof api.db, entryId: string, documentId: string) {
  const rich = JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Google' }] }] });
  db.prepare('UPDATE entries SET content_json=? WHERE id=?').run(rich, entryId);
  db.prepare(`INSERT INTO google_documents (entry_id,document_id,tab_id,revision_id,synced_content_json,document_title,tab_title,tab_order,tab_depth)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(entryId, documentId, 'tab-0', 'r1', rich, 'Document Google', 'Onglet', 0, 0);
}

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

  test('le pied des paramètres mène à la politique de confidentialité publique', async () => {
    render(<App />);
    await screen.findByRole('region', { name: 'Journal' });

    fireEvent.click(screen.getByRole('button', { name: 'Compte et paramètres' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Paramètres' }));
    const dialog = await screen.findByRole('dialog', { name: 'Paramètres' });
    const link = within(dialog).getByRole('link', { name: 'Politique de confidentialité' });
    expect(link).toHaveAttribute('href', 'https://worklogs-google.cocodexcocoder.workers.dev/confidentialite.html');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
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
    expect(within(dialog).getByLabelText('Endpoint IA')).not.toBeVisible();
    expect(within(dialog).getByLabelText('Modèle IA')).not.toBeVisible();
    expect(within(dialog).getByLabelText('Clé IA')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Tester la connexion' })).toBeVisible();
    await user.click(within(dialog).getByText('Réglages avancés', { selector: 'summary' }));
    expect(within(dialog).getByLabelText('Endpoint IA')).toHaveValue(
      'https://generativelanguage.googleapis.com/v1beta/openai'
    );
    expect(within(dialog).getByLabelText('Modèle IA')).toHaveValue('gemini-3-flash-preview');
    expect(within(dialog).getByLabelText('Clé IA')).toHaveValue('');

    await user.type(within(dialog).getByLabelText('Clé IA'), 'cle-test');
    expect(localStorage.getItem('worklogs-ai-key')).toBe('cle-test');

    await user.selectOptions(within(dialog).getByLabelText('Modèle IA'), 'gemini-3.6-flash');
    expect(localStorage.getItem('worklogs-ai-model')).toBe('gemini-3.6-flash');
    await user.click(within(dialog).getByRole('button', { name: 'Restaurer les réglages Gemini' }));
    expect(within(dialog).getByLabelText('Modèle IA')).toHaveValue('gemini-3-flash-preview');
    // La clé collée survit au reset des valeurs.
    expect(within(dialog).getByLabelText('Clé IA')).toHaveValue('cle-test');

    await user.type(within(dialog).getByLabelText('Mon contexte de travail'), 'Dev solo en pisciculture');
    expect(localStorage.getItem('worklogs-ai-profile')).toBe('Dev solo en pisciculture');
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
    await user.type(settings.getByLabelText('Clé IA'), 'cle-test');
    await user.click(settings.getByRole('button', { name: 'Tester la connexion' }));
    await settings.findByText(/Connexion vérifiée/);
    expect(aiBodies).toHaveLength(1);
    expect(settings.getByLabelText('Endpoint IA')).not.toBeVisible();
    await user.selectOptions(settings.getByLabelText('Projet du contexte IA'), 'pr_bassin');
    expect(settings.getByLabelText('Contexte IA du projet')).toHaveValue('Pompes immergées');
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

  test('un titre vidé garde l’ancien et ne bloque plus la fermeture une fois l’entrée quittée', async () => {
    // 0.49.1 : le brouillon sans titre échouait, restait en attente après le changement
    // d'entrée et la fermeture le rejouait sans fin — sur une entrée introuvable au
    // journal, qui y portait toujours son ancien titre.
    const user = userEvent.setup();
    seedData(api.db, {
      entries: [
        { id: 'en_a', title: 'A', date: '2026-06-02' },
        { id: 'en_b', title: 'B', date: '2026-06-01' },
      ],
    });
    render(<App />);

    await user.clear(await screen.findByLabelText('Titre de l’entrée'));
    expect(screen.getByLabelText('Titre de l’entrée')).toHaveAttribute('placeholder', 'A');
    await user.click(screen.getByRole('button', { name: 'Écrire' }));
    fireEvent.change(screen.getByLabelText('Contenu en Markdown'), { target: { value: 'Écrit sans titre' } });
    await user.click(within(journal()).getByText('B'));
    await waitFor(() => expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('B'));

    await flushPendingSaves();
    expect(hasPendingSaves()).toBe(false);
    expect(row(api.db, 'SELECT title, content_md FROM entries WHERE id=?', 'en_a'))
      .toMatchObject({ title: 'A', content_md: 'Écrit sans titre' });
  });

  test('suit la note ouverte comme tâche, synchronise son statut et conserve son texte après retrait du suivi', async () => {
    const user = userEvent.setup();
    seedData(api.db, { entries: [{ id: 'en_context', title: 'Contexte de réunion', content_md: 'Relire le compte rendu.' }] });
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Suivre comme tâche' }));
    const taskProgress = await within(editor()).findByRole('region', { name: 'Suivi de tâche' });
    const title = within(editor()).getByLabelText('Titre de l’entrée');
    expect(title).toHaveValue('Contexte de réunion');
    expect(row(api.db, 'SELECT COUNT(*) n FROM entries').n).toBe(1);
    expect(row(api.db, 'SELECT entry_id, progress FROM tasks')).toEqual({ entry_id: 'en_context', progress: 0 });
    expect(within(editor()).getByText('Relire le compte rendu.')).toBeVisible();

    const cardTitle = await within(board()).findByRole('button', { name: 'Contexte de réunion' });
    const card = cardTitle.closest('.card') as HTMLElement;
    await user.click(cardTitle);
    expect(within(card).queryByRole('button', { name: /Créer une entrée liée|Retirer Contexte de réunion/ })).toBeNull();
    const progress = within(taskProgress).getByLabelText('Avancement (%)');
    fireEvent.change(progress, { target: { value: '45' } });
    await user.click(within(taskProgress).getByRole('button', { name: 'Appliquer' }));
    const status = within(taskProgress).getByLabelText('Statut de la tâche');
    await waitFor(() => expect(status).toHaveValue('doing'));
    await waitFor(() => expect(within(board()).getByRole('progressbar', { name: 'Avancement de Contexte de réunion' })).toHaveAttribute('value', '45'));
    expect(row(api.db, 'SELECT status, progress FROM tasks')).toEqual({ status: 'doing', progress: 45 });

    await user.selectOptions(status, 'done');
    await waitFor(() => expect(within(taskProgress).getByRole('progressbar')).toHaveAttribute('value', '100'));
    // Terminer archive la note de la tâche ; la rouvrir la fait revenir.
    expect(row(api.db, 'SELECT status, archived FROM entries WHERE id=?', 'en_context')).toEqual({ status: 'done', archived: 1 });
    await user.selectOptions(status, 'doing');
    await waitFor(() => expect(row(api.db, 'SELECT status, archived FROM entries WHERE id=?', 'en_context')).toEqual({ status: 'doing', archived: 0 }));

    await user.click(within(taskProgress).getByRole('button', { name: 'Retirer le suivi de tâche' }));
    expect(await within(editor()).findByRole('button', { name: 'Suivre comme tâche' })).toBeVisible();
    expect(row(api.db, 'SELECT COUNT(*) n FROM tasks').n).toBe(0);
    expect(within(editor()).getByText('Relire le compte rendu.')).toBeVisible();
  });

  test('les cases cochées de la note de tâche règlent son avancement, sans IA', async () => {
    const user = userEvent.setup();
    seedData(api.db, { entries: [{ id: 'en_pompe', title: 'Contrôle pompe', content_md: '- [x] Démonter\n- [ ] Remonter\n- [ ] Tester' }] });
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Suivre comme tâche' }));
    const taskProgress = await within(editor()).findByRole('region', { name: 'Suivi de tâche' });
    await waitFor(() => expect(within(taskProgress).getByRole('progressbar')).toHaveAttribute('value', '33'), { timeout: 4000 });
    expect(within(taskProgress).getByText('Suit les cases cochées de la note.')).toBeVisible();
    expect(row(api.db, 'SELECT status, progress FROM tasks')).toEqual({ status: 'doing', progress: 33 });

    await user.click(within(screen.getByRole('article', { name: 'Aperçu' })).getAllByRole('checkbox')[1]);
    await waitFor(() => expect(row(api.db, 'SELECT status, progress FROM tasks')).toEqual({ status: 'doing', progress: 67 }), { timeout: 4000 });
    // Tout cocher ne termine pas la tâche : terminer reste un geste, qui archive la note.
    await user.click(within(screen.getByRole('article', { name: 'Aperçu' })).getAllByRole('checkbox')[2]);
    await waitFor(() => expect(row(api.db, 'SELECT status, progress FROM tasks')).toEqual({ status: 'doing', progress: 99 }), { timeout: 4000 });
  });

  test('lie l’entrée ouverte à une tâche existante, sans en créer', async () => {
    const user = userEvent.setup();
    seedData(api.db, {
      entries: [{ id: 'en_reunion', title: 'Contexte de réunion' }],
      tasks: [{ id: 'tk_dossier', title: 'Préparer le dossier' }, { id: 'tk_facture', title: 'Envoyer la facture' }],
    });
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Lier une tâche existante' }, { timeout: 5000 }));
    await user.click(await screen.findByRole('checkbox', { name: 'Lier Préparer le dossier à cette entrée' }));
    await user.click(screen.getByRole('button', { name: 'Relier la sélection (1)' }));

    await waitFor(() => expect(row(api.db, 'SELECT COUNT(*) n FROM task_entries').n).toBe(1));
    expect(await within(editor()).findByText('Tâche liée à cette entrée.')).toBeVisible();
    // La tâche liée sort du lieur, l’autre reste proposée.
    await user.click(await screen.findByRole('button', { name: 'Lier une tâche existante' }, { timeout: 5000 }));
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
    expect(await within(board()).findByRole('button', { name: 'Préparer le dossier' })).toHaveAttribute('title', 'Ouvrir la note de tâche');
  });

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
    // Le prompt connaît le projet et le profil ; une tâche ou une note sans mot
    // commun avec la tâche n'est plus envoyée, ni comme titre ni comme vocabulaire.
    const sent = (aiBodies.at(-1) as { messages: { role: string; content: string }[] }).messages[1].content;
    expect(sent).toContain('Profil : Dev solo en pisciculture');
    expect(sent).toContain('Projet : Chantier');
    expect(sent).not.toContain('Relire le devis');
    expect(sent).not.toContain('Compte rendu');
    expect(sent).not.toContain('Vocabulaire du métier');
    await user.click(screen.getByRole('button', { name: 'Créer et ouvrir' }));
    await waitFor(() => expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Préparer le dossier'));
    await user.click(screen.getByRole('button', { name: 'Écrire' }));
    expect(screen.getByLabelText('Contenu en Markdown')).toHaveValue('## Sous-tâches\n- [ ] Relire\n- [ ] Payer\n');
  });

  test('une entrée liée renommée complète le sujet de la tâche sans l’effacer', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest('Relire');
    seedData(api.db, { tasks: [{ id: 'tk_mail', title: 'Migrer le serveur mail' }] });
    render(<App />);

    const card = (await within(board()).findByText('Migrer le serveur mail')).closest('.card') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: /Créer une entrée liée/ }));
    await user.click(screen.getByRole('button', { name: '✨ Suggérer' }));
    await waitFor(() => expect(aiBodies).toHaveLength(1));
    expect((aiBodies[0] as { messages: { content: string }[] }).messages[1].content).toMatch(/^Tâche : Migrer le serveur mail$/m);

    await waitFor(() => expect(screen.getByLabelText('Titre de l’entrée liée')).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Titre de l’entrée liée'), { target: { value: 'Préparation' } });
    await user.click(screen.getByRole('button', { name: '✨ Suggérer' }));
    await waitFor(() => expect(aiBodies).toHaveLength(2));
    expect((aiBodies[1] as { messages: { content: string }[] }).messages[1].content).toContain('Tâche : Migrer le serveur mail — Préparation');
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

    await user.click(await aiAction('Suggérer des sous-tâches'));
    // Le prompt connaît le contenu : texte, case existante, pièce jointe et tâche liée.
    await waitFor(() => expect(aiBodies).toHaveLength(1));
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

  test('aucune sous-tâche nouvelle : le dit au lieu de se taire, sans toucher au texte, et une nouvelle demande efface le message', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest('Relire le devis');
    seedData(api.db, { entries: [{ id: 'en_note', title: 'Note', content_md: 'Intro.\n- [ ] Relire le devis\n' }] });
    render(<App />);

    await user.click(await aiAction('Suggérer des sous-tâches'));
    expect(await within(editor()).findByText('Aucune nouvelle sous-tâche à ajouter.')).toHaveAttribute('role', 'status');
    expect(row(api.db, 'SELECT content_md FROM entries WHERE id=?', 'en_note').content_md).toBe('Intro.\n- [ ] Relire le devis\n');
    expect(screen.queryByRole('button', { name: 'Retirer la suggestion' })).not.toBeInTheDocument();

    mockAiSuggest('Payer');
    await user.click(await aiAction('Suggérer des sous-tâches'));
    expect(await screen.findByRole('button', { name: 'Retirer la suggestion' })).toBeInTheDocument();
    expect(within(editor()).queryByText('Aucune nouvelle sous-tâche à ajouter.')).not.toBeInTheDocument();
  });

  test('suggérer remplace le bloc dans l’éditeur, retirer le supprime', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest('Relire');
    seedData(api.db, { entries: [{ id: 'en_note', title: 'Note', content_md: 'Intro.' }] });
    render(<App />);

    await user.click(await aiAction('Suggérer des sous-tâches'));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Retirer la suggestion' })).toBeInTheDocument();
    });

    // Second appel : le bloc est remplacé en place, pas dupliqué.
    mockAiSuggest('Payer');
    await user.click(await aiAction('Suggérer des sous-tâches'));
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

  test('affiner les sous-tâches suggérées les retravaille sans les donner pour déjà présentes', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest('Relire le devis\nPayer la facture');
    seedData(api.db, { entries: [{ id: 'en_note', title: 'Note', content_md: 'Intro.\n- [ ] Déjà là\n' }] });
    render(<App />);

    await user.click(await aiAction('Suggérer des sous-tâches'));
    const refine = await screen.findByRole('region', { name: 'Affiner les sous-tâches suggérées' });
    mockAiSuggest('Payer la facture');
    await user.click(within(refine).getByRole('button', { name: 'Plus court' }));
    await waitFor(() => expect(aiBodies).toHaveLength(1));
    const sent = (aiBodies.at(-1) as { messages: { role: string; content: string }[] }).messages[1].content;
    // Le bloc à retravailler est le brouillon précédent, pas une sous-tâche à ne jamais reproposer.
    const existing = sent.slice(sent.indexOf('Sous-tâches déjà présentes'), sent.indexOf('Proposition précédente'));
    expect(existing).toContain('- [ ] Déjà là');
    expect(existing).not.toContain('Relire le devis');
    expect(sent).toContain('Proposition précédente (brouillon) :\n## Sous-tâches\n- [ ] Relire le devis\n- [ ] Payer la facture');
    await user.click(screen.getByRole('button', { name: 'Écrire' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Contenu en Markdown')).toHaveValue('Intro.\n- [ ] Déjà là\n## Sous-tâches\n- [ ] Payer la facture\n');
    });
  });

  test('« ✨ IA » range les actions de la note dans un menu, au clavier comme à la souris', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, { entries: [{ id: 'en_note', title: 'Réunion', content_md: 'on a decidé' }] });
    const diverted = globalThis.fetch;
    let finish: (() => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('chat/completions')) return new Promise<Response>((resolve) => { finish = () => resolve({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '## Réunion' } }] }) } as Response); });
      return diverted(input, init);
    }));
    render(<App />);

    const trigger = await screen.findByRole('button', { name: 'Assistance IA' });
    await user.click(trigger);
    const menu = screen.getByRole('menu', { name: 'Assistance IA' });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(
      ['Compléter', 'Mettre en page', 'Suggérer des sous-tâches', 'Suggérer des tâches avec l’IA', 'Créer une procédure'],
    );
    expect(screen.queryByRole('button', { name: 'Suggérer des tâches avec l’IA' })).not.toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Compléter' })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(within(menu).getByRole('menuitem', { name: 'Créer une procédure' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    await user.click(screen.getByLabelText('Titre de l’entrée'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    // Choisir referme le menu : le bouton dit l'attente à sa place et garde le focus.
    trigger.focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Mise en page…' })).toHaveFocus();
    await act(async () => { finish?.(); });
    expect(await screen.findByRole('region', { name: 'Mise en page proposée' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Assistance IA' })).toBe(trigger);
  });

  test('met en page une entrée Markdown après relecture de la proposition', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest('## Réunion\n\nOn a décidé.');
    seedData(api.db, { entries: [{ id: 'en_note', title: 'Réunion', content_md: 'on a decidé' }] });
    render(<App />);

    await user.click(await aiAction('Mettre en page'));
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

  test('la mise en page proposée ne charge que les images déjà dans la note', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest('![schéma](https://intranet.exemple/schema.png)\n\n![pixel](https://traceur.exemple/p.png)');
    seedData(api.db, { entries: [{ id: 'en_note', title: 'Réunion', content_md: 'Voir ![schéma](https://intranet.exemple/schema.png)' }] });
    render(<App />);

    await user.click(await aiAction('Mettre en page'));
    const proposal = await screen.findByRole('region', { name: 'Mise en page proposée' });
    expect([...proposal.querySelectorAll('img')].map((image) => image.getAttribute('src'))).toEqual(['https://intranet.exemple/schema.png']);
    expect(within(proposal).getByText('pixel')).toBeInTheDocument();
  });

  test('rafraîchir remplace la proposition de mise en page affichée', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest('Première proposition.');
    seedData(api.db, { entries: [{ id: 'en_note', title: 'Note', content_md: 'texte original' }] });
    render(<App />);

    await user.click(await aiAction('Mettre en page'));
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

    await user.click(await aiAction('Mettre en page'));
    await user.click(await screen.findByRole('button', { name: 'Ignorer' }));
    expect(screen.queryByRole('region', { name: 'Mise en page proposée' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Écrire' }));
    expect(screen.getByLabelText('Contenu en Markdown')).toHaveValue('corige');

    // Une frappe après la demande : appliquer l'écraserait, on refuse.
    await user.click(await aiAction('Mettre en page'));
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

  test('procédure riche : « Compléter » propose les étapes, appliquées après relecture', async () => {
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

    const complete = await aiAction('Compléter');
    // Une procédure propose ses étapes, pas des sous-tâches.
    expect(screen.queryByRole('menuitem', { name: 'Suggérer des sous-tâches' })).not.toBeInTheDocument();
    await user.click(complete);
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

    await user.click(await aiAction('Mettre en page'));
    const proposal = await screen.findByRole('region', { name: 'Mise en page proposée' });
    // Le document riche part en Markdown, annoncé comme une procédure.
    const request = aiBodies.at(-1) as { messages: { role: string; content: string }[] };
    expect(request.messages[1].content).toContain('Procédure : Vidange\n\nTexte :\n## etapes\n\n1. coupé l’eau\n2. vider le bassin');
    // Le titre d'une note sans rapport n'est plus un « vocabulaire du métier ».
    expect(request.messages[1].content).not.toContain('Vocabulaire du métier');
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

    await user.click(await aiAction('Compléter'));
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
    // Ni « Compléter » ni « Mettre en page » : pas de menu IA du tout.
    expect(screen.queryByRole('button', { name: 'Assistance IA' })).not.toBeInTheDocument();
    // Ni Lire ni Écrire : un document Google garde son propre parcours d'édition.
    expect(screen.queryByRole('button', { name: 'Lire' })).not.toBeInTheDocument();
    expect(documentContent()).toHaveAttribute('contenteditable', 'true');
  });

  test('note Markdown : « Compléter » rédige la note à partir du titre et des points notés, appliquée après relecture', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest('```markdown\n# Panne de la pompe\n\nLa pompe du bassin 3 s’est arrêtée.\n\n- [ ] Commander un joint (référence à préciser)\n```');
    const points = '- pompe bassin 3 arrêtée\n- [ ] commander un joint';
    seedData(api.db, {
      entries: [{ id: 'en_panne', title: 'Panne de la pompe', content_md: points }],
      tasks: [{ id: 'tk_pompe', title: 'Réparer la pompe' }],
    });
    api.db.prepare('INSERT INTO task_entries (task_id,entry_id,created_at) VALUES (?,?,?)').run('tk_pompe', 'en_panne', new Date().toISOString());
    render(<App />);

    await user.click(await aiAction('Compléter'));
    const proposal = await screen.findByRole('region', { name: 'Note proposée' });
    expect(within(proposal).getByText('La pompe du bassin 3 s’est arrêtée.')).toBeInTheDocument();
    // Le titre en tête de réponse ferait doublon avec celui de l'entrée.
    expect(within(proposal).queryByRole('heading', { name: 'Panne de la pompe' })).not.toBeInTheDocument();
    const sent = (aiBodies.at(-1) as { messages: { role: string; content: string }[] }).messages[1].content;
    expect(sent).toContain('Note : Panne de la pompe');
    expect(sent).toContain('Tâches liées : Réparer la pompe');
    expect(sent).toContain(`Déjà écrit :\n${points}`);
    // Rien n'est écrit avant « Appliquer la note ».
    await user.click(screen.getByRole('button', { name: 'Écrire' }));
    expect(screen.getByLabelText('Contenu en Markdown')).toHaveValue(points);
    expect(row(api.db, "SELECT content_md FROM entries WHERE id='en_panne'").content_md).toBe(points);

    await user.click(within(proposal).getByRole('button', { name: 'Appliquer la note' }));
    const completed = 'La pompe du bassin 3 s’est arrêtée.\n\n- [ ] Commander un joint (référence à préciser)';
    expect(screen.getByLabelText('Contenu en Markdown')).toHaveValue(completed);
    expect(screen.queryByRole('region', { name: 'Note proposée' })).not.toBeInTheDocument();
    await waitFor(() => expect(row(api.db, "SELECT content_md FROM entries WHERE id='en_panne'").content_md).toBe(completed));
  });

  test('Compléter une note ignore les tâches sans lien du même projet, y compris leur vocabulaire', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest('La vanne fuit au raccord.');
    seedData(api.db, {
      projects: [{ id: 'p_vanne', name: 'Atelier' }],
      entries: [{ id: 'en_vanne', title: 'Contrôle de la vanne', project_id: 'p_vanne', content_md: 'La vanne fuit au raccord.' }],
      tasks: [
        { id: 'tk_gabin', title: 'Faire le point avec Gabin', project_id: 'p_vanne' },
        { id: 'tk_gabin2', title: 'Appeler Gabin', project_id: 'p_vanne' },
        { id: 'tk_vanne', title: 'Contrôler le joint', project_id: 'p_vanne' },
      ],
    });
    api.db.prepare('INSERT INTO task_entries (task_id,entry_id,created_at) VALUES (?,?,?)').run('tk_vanne', 'en_vanne', new Date().toISOString());
    render(<App />);
    fireEvent.click(await aiAction('Compléter'));
    const proposal = await screen.findByRole('region', { name: 'Note proposée' });
    const messages = (aiBodies.at(-1) as { messages: { role: string; content: string }[] }).messages;
    expect(messages[1].content).not.toMatch(/gabin/i);
    expect(messages[1].content).toContain('Tâches liées : Contrôler le joint');
    expect(messages[1].content).toContain('Déjà écrit :\nLa vanne fuit au raccord.');
    expect(messages[0].content).toContain('Le titre et le texte de la note sont les seules sources de faits');
    fireEvent.click(screen.getByText('Contexte utilisé par l’IA'));
    const context = document.querySelector<HTMLElement>('.ai-context-details')!;
    expect(context).not.toHaveTextContent(/gabin/i);
    fireEvent.click(within(proposal).getByRole('button', { name: 'Plus court' }));
    await waitFor(() => expect(aiBodies).toHaveLength(2));
    const refined = (aiBodies.at(-1) as { messages: { role: string; content: string }[] }).messages;
    expect(refined[1].content).not.toMatch(/gabin/i);
    expect(refined[1].content).toContain('Consigne d’affinement de l’utilisateur :\nPlus court');
    await waitFor(() => expect(proposal).toHaveAttribute('aria-busy', 'false'));
    expect(row(api.db, "SELECT content_md FROM entries WHERE id='en_vanne'").content_md).toBe('La vanne fuit au raccord.');
  });

  test('note riche locale : « Compléter » part en Markdown, la note appliquée s’enregistre dans le document', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest('## Constat\n\nLa vanne fuit au raccord du bassin 2.\n\n## Suite\n\n- Changer le joint (modèle à préciser)');
    seedData(api.db, { entries: [{ id: 'en_doc', title: 'Fuite de la vanne' }] });
    api.db.prepare('UPDATE entries SET content_json=? WHERE id=?').run(richText('vanne bassin 2 fuit', 'changer le joint'), 'en_doc');
    render(<App />);

    await user.click(await aiAction('Compléter'));
    const proposal = await screen.findByRole('region', { name: 'Note proposée' });
    expect(within(proposal).getByText(/surlignage, couleurs et alignements sont remis à plat/)).toBeInTheDocument();
    const sent = (aiBodies.at(-1) as { messages: { role: string; content: string }[] }).messages[1].content;
    expect(sent).toContain('Note : Fuite de la vanne');
    expect(sent).toContain('Déjà écrit :\nvanne bassin 2 fuit\n\nchanger le joint');
    expect(documentContent()).not.toHaveTextContent('La vanne fuit au raccord');

    await user.click(within(proposal).getByRole('button', { name: 'Appliquer la note' }));
    await waitFor(() => expect(documentContent()).toHaveTextContent('La vanne fuit au raccord du bassin 2.'));
    await waitFor(() => {
      const saved = row(api.db, "SELECT content_json FROM entries WHERE id='en_doc'").content_json as string;
      expect(saved).toContain('La vanne fuit au raccord du bassin 2.');
      expect(saved).not.toContain('vanne bassin 2 fuit');
    });
  });

  test('affiner une note proposée : « Plus court » envoie la proposition précédente, le texte d’origine reste la source', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest('Première rédaction, plutôt longue.');
    const points = '- délai de 3 semaines\n- prix à revoir';
    seedData(api.db, { entries: [{ id: 'en_note', title: 'Réunion fournisseur', content_md: points }] });
    render(<App />);

    await user.click(await aiAction('Compléter'));
    const proposal = await screen.findByRole('region', { name: 'Note proposée' });
    await within(proposal).findByText('Première rédaction, plutôt longue.');
    mockAiSuggest('Rédaction courte.');
    await user.click(within(proposal).getByRole('button', { name: 'Plus court' }));
    await within(proposal).findByText('Rédaction courte.');
    const sent = (aiBodies.at(-1) as { messages: { role: string; content: string }[] }).messages[1].content;
    expect(sent).toContain('Note : Réunion fournisseur');
    expect(sent.slice(sent.indexOf('Déjà écrit :'))).toBe(`Déjà écrit :\n${points}\n\nProposition précédente (brouillon) :\nPremière rédaction, plutôt longue.\n\nConsigne d’affinement de l’utilisateur :\nPlus court`);
    await user.click(screen.getByRole('button', { name: 'Écrire' }));
    expect(screen.getByLabelText('Contenu en Markdown')).toHaveValue(points);
  });

  test('note liée à Google : pas de « Compléter », le document Google ne transite pas', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, { entries: [{ id: 'en_google', title: 'Consignes Google' }] });
    seedGoogleLink(api.db, 'en_google', 'doc-consignes');
    render(<App />);

    await waitFor(() => expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Consignes Google'));
    expect(screen.queryByRole('button', { name: 'Suivre comme tâche' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Assistance IA' })).not.toBeInTheDocument();
  });

  test('une entrée devient une procédure : rédigée par l’IA, relue, créée à part puis ouverte', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest('```markdown\n# Relancer la pompe\n\nRemettre la pompe en route après une coupure.\n\n## Étapes\n\n1. Couper le disjoncteur\n2. Purger le circuit\n```');
    seedData(api.db, {
      projects: [{ id: 'pr_ferme', name: 'Ferme' }],
      entries: [{ id: 'en_panne', title: 'Panne du matin', project_id: 'pr_ferme', content_md: 'Coupé le disjoncteur, purgé, relancé.\n- [x] Prévenir Paul' }],
      tasks: [{ id: 'tk_pompe', title: 'Réparer la pompe', project_id: 'pr_ferme' }],
    });
    api.db.prepare('INSERT INTO task_entries (task_id,entry_id,created_at) VALUES (?,?,?)').run('tk_pompe', 'en_panne', new Date().toISOString());
    await api.upload('schéma.pdf', '%PDF', { entry_id: 'en_panne' });
    render(<App />);

    await user.click(await aiAction('Créer une procédure'));
    const draft = await screen.findByRole('form', { name: 'Procédure rédigée' });
    expect(within(draft).getByText('Purger le circuit')).toBeInTheDocument();
    // Le « # » de tête devient le titre, sans doublon dans le corps.
    expect(within(draft).getByLabelText('Titre de la procédure')).toHaveValue('Relancer la pompe');
    expect(within(draft).queryByRole('heading', { name: 'Relancer la pompe' })).not.toBeInTheDocument();
    const sent = (aiBodies.at(-1) as { messages: { role: string; content: string }[] }).messages[1].content;
    expect(sent).toContain('Entrée du journal : Panne du matin');
    expect(sent).toContain('Projet : Ferme');
    expect(sent).toContain('Pièces jointes : schéma.pdf');
    expect(sent).toContain('Tâches liées : Réparer la pompe');
    expect(sent).toContain('Contenu :\nCoupé le disjoncteur, purgé, relancé.\n- [x] Prévenir Paul');
    // Rien n'est créé avant de valider.
    expect(row(api.db, "SELECT COUNT(*) n FROM entries WHERE kind='procedure'").n).toBe(0);

    await user.clear(within(draft).getByLabelText('Titre de la procédure'));
    expect(within(draft).getByLabelText('Titre de la procédure')).toHaveValue('');
    await user.type(within(draft).getByLabelText('Titre de la procédure'), 'Relancer la pompe du bassin 3');
    expect(within(draft).getByLabelText('Titre de la procédure')).toHaveValue('Relancer la pompe du bassin 3');
    await user.click(within(draft).getByRole('button', { name: 'Créer la procédure' }));

    // Ouverte au centre, en lecture, avec ses étapes.
    await waitFor(() => expect(within(editor()).getByLabelText('Titre de l’entrée')).toHaveValue('Relancer la pompe du bassin 3'));
    // Le titre précède le morceau de l'éditeur riche chargé à la demande.
    await within(editor()).findByRole('textbox', { name: 'Contenu du document' });
    expect(screen.getByRole('button', { name: 'Lire' })).toHaveAttribute('aria-pressed', 'true');
    expect(documentContent()).toHaveAttribute('aria-readonly', 'true');
    expect(documentContent().querySelectorAll('ol > li')).toHaveLength(2);
    const created = row(api.db, "SELECT * FROM entries WHERE kind='procedure'");
    expect(created.project_id).toBe('pr_ferme');
    expect(created.archived).toBe(0);
    expect(created.content_json).toContain('Purger le circuit');
    // La note ne change pas, et la procédure n'est liée à aucune tâche.
    expect(row(api.db, "SELECT content_md FROM entries WHERE id='en_panne'").content_md).toBe('Coupé le disjoncteur, purgé, relancé.\n- [x] Prévenir Paul');
    expect(row(api.db, 'SELECT COUNT(*) n FROM task_entries').n).toBe(1);
    // Elle rejoint la colonne Procédures, jamais le journal.
    expect(within(journal()).queryByText('Relancer la pompe du bassin 3')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Procédures' })).toHaveAttribute('aria-pressed', 'true'));
    expect(await within(screen.getByRole('region', { name: 'Procédures du projet' })).findByText('Relancer la pompe du bassin 3')).toBeInTheDocument();
  });

  test('une tâche terminée devient une procédure : ses documents sont lus, la procédure n’est ni liée ni archivée', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest('# Changer la cartouche\n\n## Étapes\n\n1. Couper l’arrivée d’eau\n2. Changer la cartouche');
    seedData(api.db, {
      projects: [{ id: 'pr_ferme', name: 'Ferme' }, { id: 'pr_atelier', name: 'Atelier' }],
      entries: [
        { id: 'en_cr', title: 'Compte rendu filtre', project_id: 'pr_ferme', content_md: 'Cartouche changée, eau coupée 10 min.' },
        { id: 'en_google', title: 'Consignes', project_id: 'pr_ferme' },
        { id: 'en_atelier', title: 'Fiche atelier', project_id: 'pr_atelier', content_md: 'Joint torique de 12 mm.' },
      ],
      tasks: [{ id: 'tk_filtre', title: 'Changer le filtre', status: 'done', project_id: 'pr_ferme' }],
    });
    seedGoogleLink(api.db, 'en_google', 'doc-consignes');
    api.db.prepare('UPDATE entries SET content_md=?, content_json=? WHERE id=?')
      .run('Texte Google à ne pas transmettre', richText('Texte Google à ne pas transmettre'), 'en_google');
    for (const entryId of ['en_cr', 'en_google', 'en_atelier']) {
      api.db.prepare('INSERT INTO task_entries (task_id,entry_id,created_at) VALUES (?,?,?)').run('tk_filtre', entryId, new Date().toISOString());
    }
    render(<App />);

    await user.click(await within(board()).findByRole('button', { name: 'Afficher les tâches terminées (1)' }));
    const card = (await within(board()).findByText('Changer le filtre')).closest('.card') as HTMLElement;
    await user.click(await aiAction('Créer une procédure', card, 'Assistance IA de la tâche'));
    const draft = await within(card).findByRole('form', { name: 'Procédure rédigée' });
    expect(within(draft).getByLabelText('Titre de la procédure')).toHaveValue('Changer la cartouche');
    const sent = (aiBodies.at(-1) as { messages: { role: string; content: string }[] }).messages[1].content;
    expect(sent).toContain('Tâche : Changer le filtre\nStatut : Terminé\nProjet : Ferme');
    expect(sent).toContain('Document lié « Compte rendu filtre »');
    expect(sent).toContain('Cartouche changée, eau coupée 10 min.');
    // Lié exprès, un document d'un autre projet reste une source de la tâche.
    expect(sent).toContain('Joint torique de 12 mm.');
    // Le document Google ne donne que son titre.
    expect(sent).toMatch(/« Consignes » \(\d{4}-\d{2}-\d{2}\) : document Google, contenu non transmis\./);
    expect(sent).not.toContain('Texte Google');

    await user.click(within(draft).getByRole('button', { name: 'Créer la procédure' }));
    await waitFor(() => expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Changer la cartouche'));
    const created = row(api.db, "SELECT * FROM entries WHERE kind='procedure'");
    expect(created.project_id).toBe('pr_ferme');
    // Liée à une tâche terminée, elle aurait été archivée aussitôt (et masquée de sa colonne).
    expect(created.archived).toBe(0);
    expect(row(api.db, 'SELECT COUNT(*) n FROM task_entries WHERE entry_id=?', created.id).n).toBe(0);
    expect(within(card).queryByRole('form', { name: 'Procédure rédigée' })).not.toBeInTheDocument();
    expect(await aiAction('Créer une procédure', card, 'Assistance IA de la tâche')).toBeInTheDocument();
  });

  test('une recherche en cours ne masque pas la procédure créée', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest('# Relancer la pompe\n\n1. Couper le disjoncteur');
    seedData(api.db, { entries: [{ id: 'en_panne', title: 'Panne du matin', content_md: 'Disjoncteur coupé.' }, { id: 'en_autre', title: 'Autre note' }] });
    render(<App />);

    await user.type(await screen.findByLabelText('Rechercher'), 'Panne');
    await waitFor(() => expect(within(journal()).queryByText('Autre note')).not.toBeInTheDocument());
    await user.click(within(journal()).getByText('Panne du matin'));
    await waitFor(() => expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Panne du matin'));
    await user.click(await aiAction('Créer une procédure'));
    await user.click(within(await screen.findByRole('form', { name: 'Procédure rédigée' })).getByRole('button', { name: 'Créer la procédure' }));

    // « Relancer la pompe » ne contient pas « Panne » : la recherche est effacée, la procédure reste ouverte.
    await waitFor(() => expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Relancer la pompe'));
    expect(screen.getByLabelText('Rechercher')).toHaveValue('');
    expect(await within(journal()).findByText('Autre note')).toBeInTheDocument();
    expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Relancer la pompe');
  });

  test('procédure rédigée depuis un document riche : il part en Markdown ; rafraîchir la remplace, ignorer ne crée rien', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest('# Première version\n\n1. Ancienne étape');
    seedData(api.db, { entries: [{ id: 'en_doc', title: 'Document du jour' }] });
    api.db.prepare('UPDATE entries SET content_json=? WHERE id=?').run(richText('Vanne ouverte.', 'Bassin rempli.'), 'en_doc');
    render(<App />);

    await user.click(await aiAction('Créer une procédure'));
    const draft = await screen.findByRole('form', { name: 'Procédure rédigée' });
    expect(within(draft).getByLabelText('Titre de la procédure')).toHaveValue('Première version');
    expect((aiBodies.at(-1) as { messages: { role: string; content: string }[] }).messages[1].content)
      .toBe('Entrée du journal : Document du jour\nContenu :\nVanne ouverte.\n\nBassin rempli.');

    // Réponse retenue : pendant la rédaction, ni créer ni ignorer (la réponse rouvrirait le panneau).
    let answer = () => {};
    const answered = new Promise<void>((resolve) => { answer = resolve; });
    const diverted = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes('chat/completions')) return diverted(input, init);
      await answered;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '# Seconde version\n\n1. Nouvelle étape' } }] }) } as Response;
    }));
    await user.click(within(draft).getByRole('button', { name: 'Rafraîchir' }));
    expect(within(draft).getByRole('button', { name: 'Rédaction…' })).toBeDisabled();
    expect(within(draft).getByRole('button', { name: 'Ignorer' })).toBeDisabled();
    expect(within(draft).getByRole('button', { name: 'Créer la procédure' })).toBeDisabled();
    answer();
    await waitFor(() => expect(within(draft).getByLabelText('Titre de la procédure')).toHaveValue('Seconde version'));
    expect(within(draft).getByText('Nouvelle étape')).toBeInTheDocument();
    expect(within(draft).queryByText('Ancienne étape')).not.toBeInTheDocument();

    await user.click(within(draft).getByRole('button', { name: 'Ignorer' }));
    expect(screen.queryByRole('form', { name: 'Procédure rédigée' })).not.toBeInTheDocument();
    expect(row(api.db, "SELECT COUNT(*) n FROM entries WHERE kind='procedure'").n).toBe(0);
    expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Document du jour');
  });

  test('pas de procédure tirée d’une procédure ni d’un document Google ; sans clé, rien ne part', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    const diverted = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      return diverted(input, init);
    }));
    seedData(api.db, {
      entries: [{ id: 'en_google', title: 'Consignes Google' }, { id: 'en_proc', title: 'Vidange', kind: 'procedure' }],
      tasks: [{ id: 'tk_filtre', title: 'Changer le filtre' }],
    });
    seedGoogleLink(api.db, 'en_google', 'doc-consignes');
    api.db.prepare('UPDATE entries SET content_json=? WHERE id=?').run(richText('Couper l’eau.'), 'en_proc');
    localStorage.setItem('worklogs-entry', 'en_google');
    render(<App />);

    await waitFor(() => expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Consignes Google'));
    expect(screen.queryByRole('button', { name: 'Assistance IA' })).not.toBeInTheDocument();
    await openProcedure(user, 'Vidange');
    await aiAction('Compléter');
    expect(screen.queryByRole('menuitem', { name: 'Créer une procédure' })).not.toBeInTheDocument();

    // Sans clé, la carte renvoie aux Paramètres sans appeler personne.
    const card = (await within(board()).findByText('Changer le filtre')).closest('.card') as HTMLElement;
    await user.click(await aiAction('Créer une procédure', card, 'Assistance IA de la tâche'));
    expect(await within(card).findByRole('alert')).toHaveTextContent('⚙ Paramètres');
    expect(calls.some((url) => url.includes('chat/completions'))).toBe(false);
  });

  test('un document Google peut servir de référence à une note de tâche', async () => {
    const user = userEvent.setup();
    seedData(api.db, { entries: [{ id: 'en_google_task', title: 'Contexte Google' }] });
    seedGoogleLink(api.db, 'en_google_task', 'doc-task');
    const task = await clientApi.createTask({ title: 'Préparer le dossier' });
    localStorage.setItem('worklogs-entry', 'en_google_task');
    render(<App />);

    await user.click(await screen.findByRole('button', { name: 'Lier une tâche existante' }));
    await user.click(screen.getByRole('checkbox', { name: 'Lier Préparer le dossier à cette entrée' }));
    await user.click(screen.getByRole('button', { name: 'Relier la sélection (1)' }));

    const card = (await within(board()).findByRole('button', { name: 'Préparer le dossier' })).closest('.card') as HTMLElement;
    expect(await within(card).findByRole('button', { name: 'Ouvrir Contexte Google' })).toHaveAttribute('title', expect.stringContaining('Contexte Google — Google'));
    expect(row(api.db, 'SELECT entry_id FROM tasks WHERE id=?', task.id).entry_id).not.toBe('en_google_task');
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
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, {
      projects: [{ id: 'pr_a', name: 'Pisciculture' }, { id: 'pr_b', name: 'Site web' }],
      tasks: [
        { id: 'tk_photos', title: 'Photos des bassins', project_id: 'pr_b' },
        { id: 'tk_filtre', title: 'Changer le filtre', project_id: 'pr_a', due_date: '2026-11-20' },
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
    expect(within(editor()).getByRole('progressbar')).toHaveAttribute('value', '0');
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

/** La gestion des projets s'ouvre par-dessus le bandeau, depuis son bouton. */
async function openProjects() {
  // L'état chargé (les statistiques de l'en-tête en dépendent) : la liste est complète.
  await screen.findByText(/cette semaine/);
  fireEvent.click(screen.getByRole('button', { name: 'Gérer les projets' }));
  return within(await screen.findByRole('dialog', { name: /^Projets/ }));
}

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

// Vrai backend : la première lecture du partage démarre le worker de `shared-io` (démarrage
// borné à part, 10 s), qui traite ensuite un appel à la fois ; l'API tourne dans le fil de
// jsdom. Sous charge, une réponse de `/api/shared/…` dépasse la seconde des `findBy` (mesuré
// jusqu'à 4 s pour la première liste) : ces attentes-là ont `partage` (10 s), celles d'un
// simple rendu gardent le délai par défaut, et chaque test 30 s.
describe('dossier partagé', { timeout: 30_000 }, () => {
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
  const partage = { timeout: 10_000 };
  const sharedEditor = () => screen.getByRole('region', { name: 'Fichier partagé' });
  /** L'arbre du partage, une fois lu. Ses boutons s'y cherchent : `getByRole` sur tout l'écran coûte cher dans jsdom. */
  const tree = async () => within(await screen.findByRole('list', { name: 'Contenu du dossier partagé' }, partage));
  const openFromTree = async (name: string) => {
    // Un fichier d'un dossier déplié attend en plus la liste de ce dossier.
    fireEvent.click(await (await tree()).findByRole('button', { name: new RegExp(`^Ouvrir ${name.replace(/[.()]/g, '\\$&')}`) }, partage));
    return screen.findByRole('region', { name: 'Fichier partagé' }, partage);
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

  test('un fichier choisi pendant l’attente de la vue d’ensemble reste au centre', async () => {
    await write('choisi.md', '# Fichier choisi');
    render(<App />);
    const file = await (await tree()).findByRole('button', { name: /^Ouvrir choisi\.md/ }, partage);
    let finish!: (ok: boolean) => void;
    let calls = 0;
    const removeGuard = setLeaveGuard(() => ++calls === 1 ? new Promise<boolean>((resolve) => { finish = resolve; }) : Promise.resolve(true));
    try {
      fireEvent.click(await screen.findByRole('button', { name: 'Vue d’ensemble des tâches' }));
      await waitFor(() => expect(calls).toBe(1));
      fireEvent.click(file);
      await screen.findByRole('region', { name: 'Fichier partagé' }, partage);
      await act(async () => finish(true));
      expect(screen.queryByRole('region', { name: 'Vue d’ensemble des projets' })).not.toBeInTheDocument();
      expect(sharedEditor()).toBeInTheDocument();
    } finally {
      removeGuard();
    }
  });

  test('colonne Procédures masquée : aucune lecture du partage', async () => {
    localStorage.setItem('worklogs-show-procedures', '0');
    const spy = vi.spyOn(clientApi, 'sharedStatus');
    render(<App />);
    await screen.findByRole('region', { name: 'Journal' });
    expect(spy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Procédures/ }));
    expect(await screen.findByText('Dossier partagé', undefined, partage)).toBeInTheDocument();
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
    expect(await screen.findByText('Dossier partagé', undefined, partage)).toBeInTheDocument();
    const editorRegion = await openFromTree('relevés.csv');

    const grid = await within(editorRegion).findByRole('grid', { name: 'Tableau relevés.csv' }, partage);
    fireEvent.click(within(grid).getByRole('gridcell', { name: 'C3 : vide' }));
    fireEvent.change(within(editorRegion).getByLabelText('Contenu de la cellule'), { target: { value: 'Filtre lavé' } });
    await waitFor(() => expect(within(editorRegion).getByText('Brouillon sur cet ordinateur')).toBeInTheDocument(), partage);
    expect(await read('relevés.csv', 'latin1')).toBe(original);

    fireEvent.click(within(editorRegion).getByRole('button', { name: 'Enregistrer sur le partage' }));
    await waitFor(() => expect(within(sharedEditor()).getByText('Enregistré sur le partage.')).toBeInTheDocument(), partage);
    expect(await read('relevés.csv', 'latin1')).toBe('Date;Mesure;Commentaire\r\n05/10/2026;12,5;"pH ; chlore"\r\n06/10/2026;0123;Filtre lavé\r\n');
    expect(within(sharedEditor()).getByText('À jour avec le partage')).toBeInTheDocument();
  });

  test('Ctrl+S envoie un fichier texte, encodage et fins de ligne gardés', async () => {
    await write('notes.md', '# Consignes\r\n\r\nLaver le filtre.\r\n');
    render(<App />);
    const editorRegion = await openFromTree('notes.md');
    const area = await within(editorRegion).findByLabelText('Contenu de notes.md', undefined, partage);
    expect(area).toHaveValue('# Consignes\n\nLaver le filtre.\n');
    fireEvent.change(area, { target: { value: '# Consignes\n\nLaver le filtre.\nContrôler le pH.\n' } });
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await waitFor(async () => expect(await read('notes.md')).toBe('# Consignes\r\n\r\nLaver le filtre.\r\nContrôler le pH.\r\n'), partage);
  });

  test('Ctrl+S derrière l’assistant ne publie pas le brouillon', async () => {
    await write('notes.md', '# Consignes\n');
    render(<App />);
    const editorRegion = await openFromTree('notes.md');
    const area = await within(editorRegion).findByLabelText('Contenu de notes.md', undefined, partage);
    fireEvent.change(area, { target: { value: '# Consignes\n\nBrouillon pas fini.\n' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Ouvrir l’assistant IA' }, partage));
    const chat = await screen.findByRole('dialog', { name: 'Assistant IA' }, partage);

    // Le navigateur n'ouvre pas sa fenêtre d'enregistrement pour autant ; un envoi afficherait « Envoi… » dès le geste.
    expect(fireEvent.keyDown(window, { key: 's', ctrlKey: true })).toBe(false);
    expect(within(editorRegion).queryByText('Envoi…')).not.toBeInTheDocument();
    expect(await read('notes.md')).toBe('# Consignes\n');

    fireEvent.click(within(chat).getByRole('button', { name: 'Fermer l’assistant' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Assistant IA' })).not.toBeInTheDocument());
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await waitFor(async () => expect(await read('notes.md')).toBe('# Consignes\n\nBrouillon pas fini.\n'), partage);
  });

  test('un PDF du partage se lit au centre, sous son nom, sans être modifiable', async () => {
    await write('notice pompe.pdf', '%PDF-1.4\n% notice\n');
    await write('archive.zip', 'PK\u0003\u0004');
    render(<App />);
    expect(await screen.findByText('Dossier partagé')).toBeInTheDocument();
    // Grisé dans l'arbre = WorkLogs ne l'ouvre pas lui-même : plus le cas d'un PDF.
    expect(await screen.findByRole('button', { name: /^Ouvrir notice pompe\.pdf/ })).not.toHaveClass('is-foreign');
    expect(screen.getByRole('button', { name: /^Ouvrir archive\.zip/ })).toHaveClass('is-foreign');
    // Le type se lit au pictogramme (décoratif : le nom du bouton ne change pas).
    expect(screen.getByRole('button', { name: /^Ouvrir notice pompe\.pdf/ }).querySelector('.file-icon.is-pdf')).toHaveTextContent('PDF');
    expect(screen.getByRole('button', { name: /^Ouvrir archive\.zip/ }).querySelector('.file-icon.is-archive')).toHaveTextContent('ZIP');

    const editorRegion = await openFromTree('notice pompe.pdf');
    const frame = await within(editorRegion).findByTitle('Aperçu de notice pompe.pdf');
    const src = frame.getAttribute('src') ?? '';
    expect(src).toMatch(/^\/api\/shared\/preview\?hash=[0-9a-f]{64}&name=notice%20pompe\.pdf$/);
    const served = await fetch(src);
    expect(served.headers.get('content-type')).toBe('application/pdf');
    expect(served.headers.get('content-disposition')).toMatch(/^inline; filename="notice pompe\.pdf"/);
    expect(within(editorRegion).getByRole('button', { name: 'Enregistrer sur le partage' })).toBeDisabled();
    expect(within(editorRegion).queryByText(/WorkLogs ne modifie pas/)).not.toBeInTheDocument();

    // Un autre format garde l'explication et le téléchargement, sans visionneuse.
    await openFromTree('archive.zip');
    // Changer de fichier passe par la garde de sortie (asynchrone) : on relit la région à chaque essai.
    await waitFor(() => expect(within(sharedEditor()).getByText(/WorkLogs ne modifie pas les fichiers \.zip/)).toBeInTheDocument());
    expect(within(sharedEditor()).getByRole('link', { name: 'Télécharger cette version' })).toBeInTheDocument();
    expect(within(sharedEditor()).queryByTitle(/^Aperçu de/)).not.toBeInTheDocument();
  });

  test('un faux PDF (octets d’un autre format) n’ouvre pas la visionneuse', async () => {
    await write('rapport.pdf', '<html>pas un PDF</html>');
    render(<App />);
    const editorRegion = await openFromTree('rapport.pdf');
    expect(await within(editorRegion).findByText(/WorkLogs ne modifie pas les fichiers \.pdf/)).toBeInTheDocument();
    expect(within(editorRegion).queryByTitle('Aperçu de rapport.pdf')).not.toBeInTheDocument();
  });

  test('ouvert dans Excel par un collègue : lecture seule avec son nom, brouillon possible sur demande', async () => {
    await write('relevés.csv', 'a;b\n1;2\n');
    await write('~$relevés.csv', excelOwner('Jean Dupont'));
    render(<App />);
    expect((await tree()).getByRole('button', { name: /^Ouvrir relevés\.csv — Ouvert par Jean Dupont dans Excel/ })).toBeInTheDocument();
    const editorRegion = await openFromTree('relevés.csv');
    expect(await within(editorRegion).findByText(/Lecture seule — Ouvert par Jean Dupont dans Excel/, undefined, partage)).toBeInTheDocument();
    expect(within(editorRegion).getByRole('grid')).toHaveAttribute('aria-readonly', 'true');
    fireEvent.click(within(editorRegion).getByRole('button', { name: 'Écrire un brouillon quand même' }));
    expect(within(editorRegion).getByRole('grid')).not.toHaveAttribute('aria-readonly');
  });

  test('conflit : un collègue enregistre pendant mon brouillon — rien n’est écrasé, « garder les deux »', async () => {
    await write('notes.md', 'v1\n');
    render(<App />);
    const editorRegion = await openFromTree('notes.md');
    fireEvent.change(await within(editorRegion).findByLabelText('Contenu de notes.md', undefined, partage), { target: { value: 'v1\nmoi\n' } });
    await waitFor(() => expect(within(editorRegion).getByText('Brouillon sur cet ordinateur')).toBeInTheDocument(), partage);
    await write('notes.md', 'v1\ncollègue\n');

    fireEvent.click(within(editorRegion).getByRole('button', { name: 'Enregistrer sur le partage' }));
    const alert = await within(sharedEditor()).findByRole('alert', undefined, partage);
    expect(alert).toHaveTextContent('Rien n’a été écrasé');
    expect(await read('notes.md')).toBe('v1\ncollègue\n');

    fireEvent.click(within(alert).getByRole('button', { name: 'Garder les deux' }));
    await waitFor(() => expect(within(sharedEditor()).getByLabelText('Contenu de notes.md')).toHaveValue('v1\ncollègue\n'), partage);
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
    const grid = await within(editorRegion).findByRole('grid', { name: 'Tableau relevés.csv' }, partage);
    fireEvent.click(within(grid).getByRole('gridcell', { name: 'B3 : 13' }));
    fireEvent.change(within(editorRegion).getByLabelText('Contenu de la cellule'), { target: { value: '14,2' } });
    await waitFor(() => expect(within(editorRegion).getByText('Brouillon sur cet ordinateur')).toBeInTheDocument(), partage);
    // Le collègue corrige l'autre ligne dans Excel.
    await write('relevés.csv', 'Date;Mesure\n05/10;12,8\n06/10;13\n');

    fireEvent.click(within(editorRegion).getByRole('button', { name: 'Enregistrer sur le partage' }));
    const alert = await within(sharedEditor()).findByRole('alert', undefined, partage);
    expect(await within(alert).findByText(/Vos modifications ne se touchent pas : « Fusionner » garde les deux \(1 modification de ta part ajoutée à leur version\)/, undefined, partage)).toBeInTheDocument();
    fireEvent.click(within(alert).getByRole('button', { name: 'Fusionner' }));
    await waitFor(async () => expect(await read('relevés.csv')).toBe('Date;Mesure\n05/10;12,8\n06/10;14,2\n'), partage);
    expect(await within(sharedEditor()).findByText(/Fusionné et enregistré sur le partage/, undefined, partage)).toBeInTheDocument();
    expect(within(sharedEditor()).getByRole('grid', { name: 'Tableau relevés.csv' })).toBeInTheDocument();
    expect(within(sharedEditor()).getByRole('gridcell', { name: 'B2 : 12,8' })).toBeInTheDocument();
    expect(within(sharedEditor()).getByRole('gridcell', { name: 'B3 : 14,2' })).toBeInTheDocument();
  });

  test('conflit sur la même ligne : pas de fusion, la raison est dite', async () => {
    await write('notes.md', 'v1\n');
    render(<App />);
    const editorRegion = await openFromTree('notes.md');
    fireEvent.change(await within(editorRegion).findByLabelText('Contenu de notes.md', undefined, partage), { target: { value: 'v1 moi\n' } });
    await waitFor(() => expect(within(editorRegion).getByText('Brouillon sur cet ordinateur')).toBeInTheDocument(), partage);
    await write('notes.md', 'v1 collègue\n');
    fireEvent.click(within(editorRegion).getByRole('button', { name: 'Enregistrer sur le partage' }));
    const alert = await within(sharedEditor()).findByRole('alert', undefined, partage);
    expect(await within(alert).findByText('Fusion impossible : vous avez modifié tous les deux la ligne 1.', undefined, partage)).toBeInTheDocument();
    expect(within(alert).queryByRole('button', { name: 'Fusionner' })).not.toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Garder ma version' })).toBeInTheDocument();
  });

  test('chercher dans le partage : un fichier s’ouvre, un dossier se déplie dans l’arbre', async () => {
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, 'Global', 'MURGAT INGENIERIE', '00. PROCEDURE'), { recursive: true });
    await write('Global/MURGAT INGENIERIE/00. PROCEDURE/Procédure filtration.md', '# Filtration\n');
    await write('notes.md', 'x');
    render(<App />);
    const field = await screen.findByLabelText('Chercher dans le partage', undefined, partage);
    fireEvent.change(field, { target: { value: 'procedure' } });
    const results = await screen.findByRole('region', { name: 'Résultats de la recherche' });
    expect(await within(results).findByText('2 résultats.', undefined, partage)).toBeInTheDocument();
    const hit = within(results).getByRole('button', { name: 'Ouvrir Global/MURGAT INGENIERIE/00. PROCEDURE/Procédure filtration.md' });
    expect(hit.querySelector('.file-icon.is-text')).toHaveTextContent('MD');
    // Le chemin s'abrège par le début (direction droite-à-gauche) sans que « 00. » se retourne : il est isolé.
    expect(within(hit).getByText('Global/MURGAT INGENIERIE/00. PROCEDURE', { selector: 'bdi' })).toHaveAttribute('dir', 'ltr');
    fireEvent.click(hit);
    const editorRegion = await screen.findByRole('region', { name: 'Fichier partagé' });
    expect(await within(editorRegion).findByLabelText('Contenu de Procédure filtration.md', undefined, partage)).toHaveValue('# Filtration\n');

    fireEvent.click(within(screen.getByRole('region', { name: 'Résultats de la recherche' })).getByRole('button', { name: 'Afficher le dossier Global/MURGAT INGENIERIE/00. PROCEDURE' }));
    expect(field).toHaveValue('');
    expect(await screen.findByRole('list', { name: 'Contenu de Global/MURGAT INGENIERIE/00. PROCEDURE' }, partage)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dossier 00. PROCEDURE' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Dossier 00. PROCEDURE' }).querySelector('.file-icon.is-folder')).toHaveClass('is-open');
    expect(screen.getByRole('button', { name: 'Dossier Global' }).querySelector('.file-icon.is-folder')).toHaveClass('is-open');
  });

  test('une recherche échouée le dit dans ses résultats ; la suivante l’efface', async () => {
    await write('notes.md', 'x');
    vi.spyOn(clientApi, 'searchShared').mockRejectedValueOnce(new Error('Le partage ne répond pas.'));
    render(<App />);
    const field = await screen.findByLabelText('Chercher dans le partage', undefined, partage);
    fireEvent.change(field, { target: { value: 'notes' } });
    const results = await screen.findByRole('region', { name: 'Résultats de la recherche' });
    expect(await within(results).findByRole('alert', undefined, partage)).toHaveTextContent('Le partage ne répond pas.');
    fireEvent.change(field, { target: { value: 'note' } });
    expect(await within(results).findByText('1 résultat.', undefined, partage)).toBeInTheDocument();
    expect(screen.queryByText('Le partage ne répond pas.')).not.toBeInTheDocument();
  });

  test('hors ligne : l’arbre reste celui vu en dernier, les fichiers non gardés ici sont signalés', async () => {
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, 'Global'));
    await write('Global/Procédure filtration.md', '# Filtration\n');
    await write('Global/relevés.csv', 'a;b\n');
    render(<App />);
    fireEvent.click((await tree()).getByRole('button', { name: 'Dossier Global' }));
    const editorRegion = await openFromTree('relevés.csv');
    // Ouvert pour de bon (lu, donc gardé ici) avant que le partage ne tombe.
    await within(editorRegion).findByRole('grid', { name: 'Tableau relevés.csv' }, partage);
    fs.renameSync(share, share + '-ailleurs');
    try {
      act(() => { window.dispatchEvent(new Event('focus')); });
      expect(await screen.findAllByText(/^Hors ligne — liste vue /, undefined, partage)).not.toHaveLength(0);
      const missing = await (await tree()).findByRole('button', { name: /^Ouvrir Procédure filtration\.md — pas gardé sur cet ordinateur/ }, partage);
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
    expect(await within(editorRegion).findByLabelText('Contenu de notes.md', undefined, partage)).toHaveValue('v1\n');
    await write('notes.md', 'v2 du collègue\n');
    act(() => { window.dispatchEvent(new Event('focus')); });
    // Pas `partage` : l'éditeur relit aussi le partage toutes les 5 s, et une attente plus
    // longue verrait la version du collègue arriver sans le retour sur la fenêtre.
    await waitFor(() => expect(within(sharedEditor()).getByLabelText('Contenu de notes.md')).toHaveValue('v2 du collègue\n'), { timeout: 3_000 });
    expect(within(sharedEditor()).getByText('Mis à jour depuis le partage.')).toBeInTheDocument();
  });

  test('un brouillon survit à la fermeture et se retrouve à la réouverture', async () => {
    await write('notes.md', 'v1\n');
    const { unmount } = render(<App />);
    const editorRegion = await openFromTree('notes.md');
    fireEvent.change(await within(editorRegion).findByLabelText('Contenu de notes.md', undefined, partage), { target: { value: 'v1\nen cours\n' } });
    await flushPendingSaves();
    unmount();
    render(<App />);
    expect(await within(await screen.findByRole('region', { name: 'Fichier partagé' })).findByLabelText('Contenu de notes.md', undefined, partage)).toHaveValue('v1\nen cours\n');
    expect(await read('notes.md')).toBe('v1\n');
  });

  const exists = async (rel: string) => {
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    return fs.existsSync(path.join(share, rel));
  };
  const typeIn = async (name: string, value: string) => {
    const area = await within(sharedEditor()).findByLabelText(`Contenu de ${name}`, undefined, partage);
    fireEvent.change(area, { target: { value } });
    return area;
  };

  test('la première frappe prend la main (verrou à mon nom) ; fermer avec un brouillon pose la question', async () => {
    await write('notes.md', 'v1\n');
    render(<App />);
    await openFromTree('notes.md');
    expect(await exists('.~lock.notes.md#')).toBe(false);
    await typeIn('notes.md', 'v1\nmoi\n');
    await waitFor(async () => expect(await exists('.~lock.notes.md#')).toBe(true), partage);
    expect(await read('.~lock.notes.md#')).toMatch(/\(WorkLogs\),.*worklogs:test:/);
    expect(await within(sharedEditor()).findByText('Tu as la main', undefined, partage)).toBeInTheDocument();

    fireEvent.click(within(sharedEditor()).getByRole('button', { name: 'Fermer' }));
    // La question attend l'écriture du brouillon en attente.
    const question = await screen.findByRole('dialog', { name: 'Tes modifications ne sont pas sur le partage' }, partage);
    fireEvent.click(within(question).getByRole('button', { name: 'Garder le brouillon ici' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Fichier partagé' })).not.toBeInTheDocument());
    await waitFor(async () => expect(await exists('.~lock.notes.md#')).toBe(false), partage);
    expect(await read('notes.md')).toBe('v1\n');

    await openFromTree('notes.md');
    expect(await within(sharedEditor()).findByLabelText('Contenu de notes.md', undefined, partage)).toHaveValue('v1\nmoi\n');
  });

  test('quitter vers une entrée : « Envoyer sur le partage » l’enregistre, puis ouvre l’entrée', async () => {
    seedData(api.db, { entries: [{ id: 'en_1', title: 'Compte rendu' }] });
    await write('notes.md', 'v1\n');
    render(<App />);
    await openFromTree('notes.md');
    await typeIn('notes.md', 'v1\nenvoyé\n');
    await waitFor(() => expect(within(sharedEditor()).getByText('Brouillon sur cet ordinateur')).toBeInTheDocument(), partage);
    fireEvent.click(await within(journal()).findByText('Compte rendu'));
    const question = await screen.findByRole('dialog', { name: 'Tes modifications ne sont pas sur le partage' });
    // Hors de l'écriture : la question se voit même quand celle-ci n'est pas à l'écran
    // (autre vue sur téléphone, panneau replié sur desktop).
    expect(question.closest('#workspace-editor')).toBeNull();
    fireEvent.click(within(question).getByRole('button', { name: 'Envoyer sur le partage' }));
    expect(await screen.findByRole('region', { name: 'Entrée' }, partage)).toBeInTheDocument();
    expect(await read('notes.md')).toBe('v1\nenvoyé\n');
  });

  test('« Annuler » garde le fichier ouvert', async () => {
    seedData(api.db, { entries: [{ id: 'en_1', title: 'Compte rendu' }] });
    await write('notes.md', 'v1\n');
    render(<App />);
    await openFromTree('notes.md');
    await typeIn('notes.md', 'v1\nen cours\n');
    fireEvent.click(await within(journal()).findByText('Compte rendu'));
    fireEvent.click(within(await screen.findByRole('dialog', undefined, partage)).getByRole('button', { name: 'Annuler' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(sharedEditor()).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Entrée' })).not.toBeInTheDocument();
  });

  test('changer de projet referme le fichier du projet précédent', async () => {
    seedData(api.db, { projects: [{ id: 'pr_p', name: 'Piscine' }, { id: 'pr_t', name: 'TSE' }] });
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, 'Piscine'));
    fs.mkdirSync(path.join(share, 'TSE'));
    await write('Piscine/consignes.md', '# Piscine\n');
    await write('TSE/notes.md', '# TSE\n');
    api.db.prepare("UPDATE projects SET shared_dir='Piscine' WHERE id='pr_p'").run();
    api.db.prepare("UPDATE projects SET shared_dir='TSE' WHERE id='pr_t'").run();
    render(<App />);

    fireEvent.click(await within(filters()).findByRole('button', { name: /Piscine/ }));
    const piscine = within(await screen.findByRole('list', { name: 'Contenu de Piscine' }, partage));
    fireEvent.click(await piscine.findByRole('button', { name: /^Ouvrir consignes\.md/ }, partage));
    const open = await screen.findByRole('region', { name: 'Fichier partagé' }, partage);
    expect(await within(open).findByLabelText('Contenu de consignes.md', undefined, partage)).toHaveValue('# Piscine\n');

    fireEvent.click(within(filters()).getByRole('button', { name: /^TSE/ }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Fichier partagé' })).not.toBeInTheDocument(), partage);
    // L'arbre suit bien le nouveau projet ; le fichier qui n'y est plus n'est plus au centre.
    expect(await screen.findByRole('button', { name: /^Ouvrir notes\.md/ }, partage)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Ouvrir consignes\.md/ })).not.toBeInTheDocument();
  });

  test('« Annuler » au changement de projet garde le fichier et le projet', async () => {
    seedData(api.db, { projects: [{ id: 'pr_p', name: 'Piscine' }, { id: 'pr_t', name: 'TSE' }] });
    await write('notes.md', 'v1\n');
    render(<App />);
    fireEvent.click(await within(filters()).findByRole('button', { name: /Piscine/ }));
    await openFromTree('notes.md');
    await typeIn('notes.md', 'v1\nen cours\n');

    fireEvent.click(within(filters()).getByRole('button', { name: /^TSE/ }));
    fireEvent.click(within(await screen.findByRole('dialog', undefined, partage)).getByRole('button', { name: 'Annuler' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(sharedEditor()).toBeInTheDocument();
    expect(within(filters()).getByRole('button', { name: /^Piscine/ })).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem('worklogs-project')).toBe('pr_p');
  });

  test('« Annuler » en ouvrant un document d’un autre projet ne change pas le filtre', async () => {
    seedData(api.db, {
      projects: [{ id: 'pr_p', name: 'Piscine' }, { id: 'pr_t', name: 'TSE' }],
      entries: [{ id: 'en_doc', title: 'Compte rendu TSE', project_id: 'pr_t' }],
      tasks: [{ id: 'tk_1', title: 'Tâche Piscine', project_id: 'pr_p' }],
    });
    api.db.prepare('INSERT INTO task_entries (task_id,entry_id,created_at) VALUES (?,?,?)').run('tk_1', 'en_doc', new Date().toISOString());
    await write('notes.md', 'v1\n');
    render(<App />);
    fireEvent.click(await within(filters()).findByRole('button', { name: /Piscine/ }));
    await openFromTree('notes.md');
    await typeIn('notes.md', 'v1\nen cours\n');

    const card = (await within(board()).findByText('Tâche Piscine')).closest('.card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Ouvrir Compte rendu TSE' }));
    fireEvent.click(within(await screen.findByRole('dialog', undefined, partage)).getByRole('button', { name: 'Annuler' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(sharedEditor()).toBeInTheDocument();
    expect(within(filters()).getByRole('button', { name: /^Piscine/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('region', { name: 'Entrée' })).not.toBeInTheDocument();
  });

  test('ouvrir un document Google depuis « Documents Google » suit son projet', async () => {
    const user = userEvent.setup();
    seedData(api.db, {
      projects: [{ id: 'pr_p', name: 'Piscine' }, { id: 'pr_t', name: 'TSE' }],
      entries: [{ id: 'en_g', title: 'Compte rendu TSE', project_id: 'pr_t' }],
    });
    const opened = await clientApi.entry('en_g');
    vi.spyOn(clientApi, 'googleStatus').mockResolvedValue({
      available: true, configured: true, connected: true, pending: false, error: '', selectedIds: [],
      account: { email: 'timo@example.com', name: 'Timo' },
    });
    vi.spyOn(clientApi, 'googleSync').mockResolvedValue({ state: 'idle', error: '', lastSyncedAt: null, revision: 0 });
    vi.spyOn(clientApi, 'googleDocuments').mockResolvedValue({
      files: [{ id: 'doc-1', name: 'Compte rendu TSE', modifiedTime: '', linked: true, project_id: 'pr_t' }],
    });
    vi.spyOn(clientApi, 'openGoogleDocument').mockResolvedValue(opened);
    localStorage.setItem('worklogs-project', 'pr_p');
    render(<App />);

    const header = await screen.findByRole('banner');
    await user.click(await within(header).findByRole('button', { name: /Compte Google : Timo/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Documents Google' }));
    const dialog = await screen.findByRole('dialog', { name: 'Documents Google' });
    await user.click(await within(dialog).findByRole('button', { name: 'Ouvrir Compte rendu TSE' }));

    // Comme une carte de tâche : le filtre passe au projet du document ouvert.
    await waitFor(() => expect(within(filters()).getByRole('button', { name: /^TSE/ })).toHaveAttribute('aria-pressed', 'true'));
    expect(await screen.findByLabelText('Titre de l’entrée')).toHaveValue('Compte rendu TSE');
    expect(localStorage.getItem('worklogs-project')).toBe('pr_t');
  });

  test('un collègue ouvre le fichier dans LibreOffice après moi : ma frappe passe en lecture seule, gardée en brouillon', async () => {
    await write('planning.txt', 'lundi\n');
    render(<App />);
    await openFromTree('planning.txt');
    await write('.~lock.planning.txt#', 'Hélène Martin,hmartin,TSE01,05.10.2026 09:00,file:///C:/x;');
    const area = await typeIn('planning.txt', 'lundi\nmardi\n');
    expect(await within(sharedEditor()).findByText(/Lecture seule — Ouvert par Hélène Martin dans LibreOffice/, undefined, partage)).toBeInTheDocument();
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
    expect((await tree()).getByRole('button', { name: /^Ouvrir autre\.md/ })).toBeInTheDocument();
    // Un clic dès le commit du projet doit survivre aux effets encore en attente :
    // l'ancien reset passif fermait le choix juste après ce premier clic.
    let clicked = false;
    const observer = new MutationObserver(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('.shared-project-link button')]
        .find((candidate) => candidate.textContent === 'Relier Piscine à un dossier…');
      if (clicked || !button || button.disabled) return;
      clicked = true;
      fireEvent.click(button);
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    try {
      fireEvent.click(within(filters()).getByRole('button', { name: /Piscine/ }));
      fireEvent.click(await screen.findByRole('button', { name: 'Relier Piscine au dossier Piscine' }, { timeout: 5000 }));
      expect(clicked).toBe(true);
    } finally {
      observer.disconnect();
    }
    const piscine = within(await screen.findByRole('list', { name: 'Contenu de Piscine' }, partage));
    expect(piscine.getByRole('button', { name: /^Ouvrir consignes\.md/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Ouvrir autre\.md/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Délier Piscine de son dossier' }));
    expect((await tree()).getByRole('button', { name: /^Ouvrir autre\.md/ })).toBeInTheDocument();
  });

  test('le dossier relié est porté par le projet (synchronisé par Drive), pas par cet ordinateur', async () => {
    seedData(api.db, { projects: [{ id: 'pr_p', name: 'Piscine' }] });
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, 'Piscine'));
    await write('Piscine/consignes.md', '# Consignes');
    render(<App />);
    fireEvent.click(await within(filters()).findByRole('button', { name: /Piscine/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Relier Piscine à un dossier…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Relier Piscine au dossier Piscine' }, { timeout: 5000 }));
    expect(await screen.findByRole('button', { name: /^Ouvrir consignes\.md/ })).toBeInTheDocument();
    expect(api.db.prepare("SELECT shared_dir FROM projects WHERE id='pr_p'").get()).toEqual({ shared_dir: 'Piscine' });
    expect(api.db.prepare('SELECT COUNT(*) n FROM shared_project_folders').get()).toEqual({ n: 0 });
  });

  test('lien d’avant (table de cet ordinateur) : repris une fois sur le projet', async () => {
    seedData(api.db, { projects: [{ id: 'pr_p', name: 'Piscine' }] });
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, 'Piscine'));
    api.db.prepare('INSERT INTO shared_project_folders (project_id, rel_dir, updated_at) VALUES (?,?,?)').run('pr_p', 'Piscine', new Date().toISOString());
    render(<App />);
    await waitFor(() => expect(api.db.prepare("SELECT shared_dir FROM projects WHERE id='pr_p'").get()).toEqual({ shared_dir: 'Piscine' }));
    await waitFor(() => expect(api.db.prepare('SELECT COUNT(*) n FROM shared_project_folders').get()).toEqual({ n: 0 }));
  });

  test('dossier relié depuis un autre appareil (adresse, autre nom du serveur, autre casse) : le bon dossier ici', async () => {
    seedData(api.db, { projects: [{ id: 'pr_t', name: 'TSE' }] });
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, '2. TSE'));
    await write('2. TSE/Redémarrage.md', '# x');
    await write('autre.md', 'y');
    // Cet ordinateur monte « \\172.16.1.20\d\…\00. PROCEDURE » ; le téléphone a relié le projet par « SRVMURGAT » et « D ».
    api.db.prepare("INSERT INTO local_settings (key, value, updated_at) VALUES ('shared.address', ?, ?)").run('\\\\172.16.1.20\\d\\Global\\00. PROCEDURE', new Date().toISOString());
    api.db.prepare("UPDATE projects SET shared_dir=? WHERE id='pr_t'").run('\\\\SRVMURGAT\\D\\Global\\00. PROCEDURE\\2. TSE');
    render(<App />);
    fireEvent.click(await within(filters()).findByRole('button', { name: /TSE/ }));
    expect(await screen.findByRole('button', { name: /^Ouvrir Redémarrage\.md/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Ouvrir autre\.md/ })).not.toBeInTheDocument();
  });

  test('projet relié à un dossier absent du partage : on le dit, « Délier » rend tout le partage', async () => {
    seedData(api.db, { projects: [{ id: 'pr_w', name: 'work-logs' }] });
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, 'Global'));
    await write('notes.md', 'x');
    await clientApi.linkSharedFolder('pr_w', 'Global');
    // Le dossier disparaît du partage (ou la racine a changé) : le lien ne mène plus nulle part.
    fs.rmdirSync(path.join(share, 'Global'));
    // La reprise de l'ancien lien commence sous « Tout », puis le projet est
    // choisi avant sa fin : le rafraîchissement doit suivre le filtre courant.
    let resumeMigration!: () => void;
    const migrationGate = new Promise<void>((resolve) => { resumeMigration = resolve; });
    const updateProject = clientApi.updateProject;
    const migration = vi.spyOn(clientApi, 'updateProject').mockImplementation(async (id, body) => {
      if (id === 'pr_w' && body.shared_dir) await migrationGate;
      return updateProject(id, body);
    });
    let filteredRead = false;
    const readState = clientApi.state;
    vi.spyOn(clientApi, 'state').mockImplementation(async (...args) => {
      const next = await readState(...args);
      if (args[1] === 'pr_w') filteredRead = true;
      return next;
    });
    render(<App />);
    await waitFor(() => expect(migration).toHaveBeenCalledWith('pr_w', { shared_dir: 'Global' }), partage);
    fireEvent.click(await within(filters()).findByRole('button', { name: /work-logs/ }));
    await waitFor(() => expect(filteredRead).toBe(true), partage);
    await act(async () => { resumeMigration(); await migrationGate; });
    expect(await screen.findByText('Le dossier relié à work-logs (« Global ») n’est pas dans ce partage. « Délier work-logs de son dossier » affiche tout le partage.', undefined, partage)).toHaveAttribute('role', 'alert');
    fireEvent.click(screen.getByRole('button', { name: 'Délier work-logs de son dossier' }));
    expect((await tree()).getByRole('button', { name: /^Ouvrir notes\.md/ })).toBeInTheDocument();
  });

  test('nouveau fichier : créé dans le dossier déplié, ouvert au centre ; un nom pris n’écrase rien', async () => {
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, '00. PROCEDURE'));
    await write('00. PROCEDURE/existant.md', 'à garder\n');
    render(<App />);
    const files = await tree();
    fireEvent.click(files.getByRole('button', { name: 'Dossier 00. PROCEDURE' }));
    await files.findByRole('button', { name: /^Ouvrir existant\.md/ }, partage);

    fireEvent.click(screen.getByRole('button', { name: '＋ Nouveau fichier…' }));
    const form = screen.getByRole('form', { name: 'Nouveau fichier' });
    expect(within(form).getByLabelText('Dossier du nouveau fichier')).toHaveValue('00. PROCEDURE');
    fireEvent.change(within(form).getByLabelText('Type de fichier'), { target: { value: 'md' } });
    fireEvent.change(within(form).getByLabelText('Nom du fichier'), { target: { value: 'Procédure sauvegarde' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Créer' }));
    const editorRegion = await screen.findByRole('region', { name: 'Fichier partagé' }, partage);
    expect(await within(editorRegion).findByLabelText('Contenu de Procédure sauvegarde.md', undefined, partage)).toHaveValue('# Procédure sauvegarde\n\n');
    expect(await read('00. PROCEDURE/Procédure sauvegarde.md')).toBe('# Procédure sauvegarde\n\n');
    expect(screen.getByRole('button', { name: /^Ouvrir Procédure sauvegarde\.md/ })).toBeInTheDocument();

    // Un nom déjà pris : refusé, l'existant intact.
    fireEvent.click(screen.getByRole('button', { name: '＋ Nouveau fichier…' }));
    const again = screen.getByRole('form', { name: 'Nouveau fichier' });
    fireEvent.change(within(again).getByLabelText('Type de fichier'), { target: { value: 'md' } });
    fireEvent.change(within(again).getByLabelText('Nom du fichier'), { target: { value: 'existant' } });
    fireEvent.click(within(again).getByRole('button', { name: 'Créer' }));
    expect(await screen.findByText('« existant.md » existe déjà dans ce dossier : rien n’a été écrasé. Choisis un autre nom.', undefined, partage)).toBeInTheDocument();
    expect(await read('00. PROCEDURE/existant.md')).toBe('à garder\n');
  });

  test('un refus reste affiché quand l’arbre se relit ; « Annuler » l’efface', async () => {
    await write('existant.md', 'à garder\n');
    render(<App />);
    await tree();
    fireEvent.click(screen.getByRole('button', { name: '＋ Nouveau fichier…' }));
    const form = screen.getByRole('form', { name: 'Nouveau fichier' });
    fireEvent.change(within(form).getByLabelText('Type de fichier'), { target: { value: 'md' } });
    fireEvent.change(within(form).getByLabelText('Nom du fichier'), { target: { value: 'existant' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Créer' }));
    const refusal = '« existant.md » existe déjà dans ce dossier : rien n’a été écrasé. Choisis un autre nom.';
    expect(await screen.findByText(refusal, undefined, partage)).toBeInTheDocument();

    // Retour au premier plan (comme le sondage) : l'arbre est relu jusqu'au bout, le refus reste.
    const listed = vi.spyOn(clientApi, 'sharedList');
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(listed).toHaveBeenCalled(), partage);
    await act(async () => { await Promise.allSettled(listed.mock.results.map((result) => result.value)); });
    expect(screen.getByText(refusal)).toBeInTheDocument();

    fireEvent.click(within(form).getByRole('button', { name: 'Annuler' }));
    expect(screen.queryByText(refusal)).not.toBeInTheDocument();
  });

  test('nouveau document Word à la racine : il s’ouvre dans l’éditeur Word, titré de son nom', async () => {
    await write('notes.md', 'x');
    render(<App />);
    await tree();
    fireEvent.click(screen.getByRole('button', { name: '＋ Nouveau fichier…' }));
    const form = screen.getByRole('form', { name: 'Nouveau fichier' });
    expect(within(form).getByLabelText('Type de fichier')).toHaveValue('docx');
    fireEvent.change(within(form).getByLabelText('Nom du fichier'), { target: { value: 'Compte rendu' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Créer' }));
    const editorRegion = await screen.findByRole('region', { name: 'Fichier partagé' }, partage);
    const content = await within(editorRegion).findByRole('textbox', { name: 'Contenu du document Word' }, partage);
    expect(content.querySelector('h1')).toHaveTextContent('Compte rendu');
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    expect(fs.existsSync(path.join(share, 'Compte rendu.docx'))).toBe(true);
  });

  test('depuis une procédure : la procédure locale part sur le TSE en docx, dans le dossier choisi', async () => {
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, '00. PROCEDURE'));
    seedData(api.db, { entries: [{ id: 'en_proc', title: 'Sauvegarde chaudière', content_md: '## Objectif\n\nCouper le courant.\n\n- Filtre lavé\n', kind: 'procedure' }] });
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Modifier la procédure Sauvegarde chaudière' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Dossier 00. PROCEDURE' }));

    fireEvent.click(await screen.findByRole('button', { name: '＋ Depuis une procédure…' }));
    const form = screen.getByRole('form', { name: 'Depuis une procédure' });
    expect(within(form).getByLabelText('Procédure à envoyer')).toHaveValue('en_proc');
    expect(within(form).getByLabelText('Format du fichier')).toHaveValue('docx');
    expect(within(form).getByLabelText('Nom du fichier envoyé')).toHaveValue('Sauvegarde chaudière');
    expect(within(form).getByLabelText('Dossier de destination')).toHaveValue('00. PROCEDURE');
    fireEvent.click(within(form).getByRole('button', { name: 'Envoyer vers le partage' }));

    const editorRegion = await screen.findByRole('region', { name: 'Fichier partagé' });
    const content = await within(editorRegion).findByRole('textbox', { name: 'Contenu du document Word' });
    expect(content.querySelector('h1')).toHaveTextContent('Sauvegarde chaudière');
    expect(content).toHaveTextContent('Couper le courant.');
    expect(fs.existsSync(path.join(share, '00. PROCEDURE', 'Sauvegarde chaudière.docx'))).toBe(true);
    // Copie par défaut : la procédure locale reste dans sa colonne.
    expect(screen.getByRole('button', { name: 'Modifier la procédure Sauvegarde chaudière' })).toBeInTheDocument();
  }, 15000);

  test('depuis une procédure : format Markdown au choix, un nom pris n’écrase rien', async () => {
    await write('existant.md', 'à garder\n');
    seedData(api.db, { entries: [{ id: 'en_proc', title: 'Consignes', content_md: '# Consignes\n\nLaver le filtre.\n', kind: 'procedure' }] });
    render(<App />);
    // L'arbre d'abord : une lecture du dossier qui aboutit efface le message d'erreur, et la
    // première, encore en route sous charge, effaçait le refus juste après son affichage.
    await screen.findByRole('button', { name: /^Ouvrir existant\.md/ }, { timeout: 10000 });
    fireEvent.click(await screen.findByRole('button', { name: '＋ Depuis une procédure…' }, { timeout: 10000 }));
    const form = screen.getByRole('form', { name: 'Depuis une procédure' });
    fireEvent.change(within(form).getByLabelText('Format du fichier'), { target: { value: 'md' } });
    fireEvent.change(within(form).getByLabelText('Nom du fichier envoyé'), { target: { value: 'existant' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Envoyer vers le partage' }));
    expect(await screen.findByText('« existant.md » existe déjà dans ce dossier : rien n’a été écrasé. Choisis un autre nom.', {}, { timeout: 10000 })).toBeInTheDocument();
    expect(await read('existant.md')).toBe('à garder\n');
  }, 30000);

  test('depuis une procédure : déplacer supprime la procédure locale après l’envoi', async () => {
    seedData(api.db, { entries: [{ id: 'en_proc', title: 'Consignes', content_md: '# Consignes\n\nLaver le filtre.\n', kind: 'procedure' }] });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '＋ Depuis une procédure…' }));
    const form = screen.getByRole('form', { name: 'Depuis une procédure' });
    fireEvent.change(within(form).getByLabelText('Format du fichier'), { target: { value: 'md' } });
    fireEvent.change(within(form).getByLabelText('Nom du fichier envoyé'), { target: { value: 'Consignes envoyées' } });
    fireEvent.click(within(form).getByLabelText('Supprimer la procédure locale après l’envoi'));
    fireEvent.click(within(form).getByRole('button', { name: 'Envoyer vers le partage' }));
    const editorRegion = await screen.findByRole('region', { name: 'Fichier partagé' });
    expect(await within(editorRegion).findByLabelText('Contenu de Consignes envoyées.md')).toHaveValue('# Consignes\n\nLaver le filtre.\n');
    expect(await read('Consignes envoyées.md')).toBe('# Consignes\n\nLaver le filtre.\n');
    // Déplacement : l’originale a quitté la colonne des procédures.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Modifier la procédure Consignes' })).not.toBeInTheDocument(), { timeout: 5000 });
    expect(row(api.db, 'SELECT id FROM entries WHERE id=?', 'en_proc')).toBeUndefined();
  }, 15000);

  test('l’historique restaure une ancienne version en brouillon, puis l’envoi la remet sur le partage', async () => {
    await write('notes.md', 'version 1\n');
    render(<App />);
    await openFromTree('notes.md');
    expect(await within(sharedEditor()).findByLabelText('Contenu de notes.md', undefined, partage)).toHaveValue('version 1\n');
    await write('notes.md', 'version 2 du collègue\n');
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(within(sharedEditor()).getByLabelText('Contenu de notes.md')).toHaveValue('version 2 du collègue\n'), partage);

    fireEvent.click(within(sharedEditor()).getByText('Historique sur cet ordinateur'));
    const buttons = await within(sharedEditor()).findAllByRole('button', { name: /^Restaurer la version du/ }, partage);
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]);
    await waitFor(() => expect(within(sharedEditor()).getByLabelText('Contenu de notes.md')).toHaveValue('version 1\n'), partage);
    expect(within(sharedEditor()).getByText(/restaurée en brouillon/)).toBeInTheDocument();
    expect(await read('notes.md')).toBe('version 2 du collègue\n');
    fireEvent.click(within(sharedEditor()).getByRole('button', { name: 'Enregistrer sur le partage' }));
    await waitFor(async () => expect(await read('notes.md')).toBe('version 1\n'), partage);
  });

  test('Paramètres › Dossier partagé : le nom affiché dans mes verrous', async () => {
    await write('notes.md', 'v1\n');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Compte et paramètres' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Paramètres' }));
    const settings = within(await screen.findByRole('region', { name: 'Dossier partagé' }, partage));
    const input = await settings.findByLabelText('Nom affiché dans les verrous');
    fireEvent.change(input, { target: { value: 'T. Grollier' } });
    fireEvent.click(settings.getByRole('button', { name: 'Enregistrer' }));
    expect(await settings.findByText('Enregistré.', undefined, partage)).toBeInTheDocument();
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
    const content = await within(editorRegion).findByRole('textbox', { name: 'Contenu du document Word' }, partage);
    expect(content).toHaveTextContent('Filtration');
    expect(content.querySelector('h1')).toHaveTextContent('Filtration');
    expect(within(editorRegion).getByText(/Image — conservé/)).toBeInTheDocument();
    expect(within(editorRegion).getByText(/Table des matières — conservé/)).toBeInTheDocument();
    await waitFor(() => expect(content.querySelector('[data-marker="1."]')).toHaveTextContent('Arrêter la pompe'));
    expect(content.querySelector('[data-marker="a)"]')).toHaveTextContent('Vanne fermée');

    const style = within(editorRegion).getByLabelText('Style du paragraphe');
    expect(style).toHaveValue('Titre1');
    fireEvent.change(style, { target: { value: '' } });
    await waitFor(() => expect(within(sharedEditor()).getByText('Brouillon sur cet ordinateur')).toBeInTheDocument(), partage);
    fireEvent.click(within(sharedEditor()).getByRole('button', { name: 'Enregistrer sur le partage' }));
    await waitFor(() => expect(within(sharedEditor()).getByText('Enregistré sur le partage.')).toBeInTheDocument(), partage);

    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    const sent = new Uint8Array(fs.readFileSync(path.join(share, 'Procédure filtration.docx')));
    const before = (await readZipText(readZip(original), 'word/document.xml'))!;
    const after = (await readZipText(readZip(sent), 'word/document.xml'))!;
    expect(after).toBe(before.replace('<w:pPr><w:pStyle w:val="Titre1"/><w:spacing w:after="120"/></w:pPr><w:bookmarkStart w:id="0" w:name="_Toc1"/><w:r><w:t>Filtration</w:t></w:r>',
      '<w:pPr><w:spacing w:after="120"/></w:pPr><w:bookmarkStart w:id="0" w:name="_Toc1"/><w:r><w:t xml:space="preserve">Filtration</w:t></w:r>'));
    expect(await readZipText(readZip(sent), 'docProps/core.xml')).toContain('<cp:lastModifiedBy>T. Grollier</cp:lastModifiedBy>');
  });

  test('document Word : ses images s’affichent ; une image insérée part dans le fichier du partage', async () => {
    const { pngImage, wordDocx, wordPicture } = await import('./test/docx-fixture');
    const { readZip, readZipText } = await import('./zip');
    await write('Schémas.docx', wordDocx({ body: wordPicture('rId10') + '<w:p><w:r><w:t>Fin</w:t></w:r></w:p>' }));
    render(<App />);
    const editorRegion = await openFromTree('Schémas.docx');
    const content = await within(editorRegion).findByRole('textbox', { name: 'Contenu du document Word' }, partage);
    await waitFor(() => expect(within(content).getByRole('img', { name: 'Image' })).toHaveAttribute('src', expect.stringMatching(/^data:image\/png;base64,/)), partage);

    // Ce que Word ne lit pas tel quel (SVG…) : refusé, rien n'est inséré.
    const input = within(editorRegion).getByLabelText('Insérer une image');
    fireEvent.change(input, { target: { files: [new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'dessin.svg', { type: 'image/svg+xml' })] } });
    expect(await within(editorRegion).findByText(/seules les images PNG, JPEG ou GIF/)).toBeInTheDocument();

    fireEvent.change(input, { target: { files: [new File([pngImage(40, 20) as BlobPart], 'capture.png', { type: 'image/png' })] } });
    expect(await within(content).findByRole('img', { name: 'capture.png' })).toHaveAttribute('src', expect.stringMatching(/^data:image\/png;base64,/));
    expect(within(editorRegion).queryByText(/seules les images PNG, JPEG ou GIF/)).toBeNull();
    // Une capture d'écran collée s'insère de même ; du texte copié depuis Word (qui l'accompagne d'une image), non.
    const screenshot = new File([pngImage(8, 8) as BlobPart], 'image.png', { type: 'image/png' });
    // jsdom ne mesure rien, et ProseMirror fait défiler jusqu'au texte collé.
    const ranges = Range.prototype as unknown as Record<string, unknown>;
    ranges.getClientRects = () => [];
    ranges.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
    fireEvent.paste(content, { clipboardData: { files: [screenshot], types: ['text/plain', 'Files'], getData: (type: string) => (type === 'text/plain' ? 'Texte copié' : '') } });
    delete ranges.getClientRects;
    delete ranges.getBoundingClientRect;
    expect(content).toHaveTextContent('Texte copié');
    expect(within(content).queryByRole('img', { name: 'image.png' })).toBeNull();
    fireEvent.paste(content, { clipboardData: { files: [screenshot], types: ['Files'], getData: () => '' } });
    expect(await within(content).findByRole('img', { name: 'image.png' })).toBeInTheDocument();
    await waitFor(() => expect(within(sharedEditor()).getByText('Brouillon sur cet ordinateur')).toBeInTheDocument(), partage);
    fireEvent.click(within(sharedEditor()).getByRole('button', { name: 'Enregistrer sur le partage' }));
    await waitFor(() => expect(within(sharedEditor()).getByText('Enregistré sur le partage.')).toBeInTheDocument(), partage);

    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    const sent = readZip(new Uint8Array(fs.readFileSync(path.join(share, 'Schémas.docx'))));
    expect(sent.byName.has('word/media/worklogs1.png') && sent.byName.has('word/media/worklogs2.png')).toBe(true);
    expect(await readZipText(sent, 'word/document.xml')).toContain('<a:blip r:embed="rIdWorkLogs1"/>');
  });

  test('une image du partage se voit sur place ; un fichier qui en usurpe le nom, non', async () => {
    const { pngImage } = await import('./test/docx-fixture');
    await write('schema.png', pngImage(4, 2));
    await write('faux.png', '<script>alert(1)</script>');
    render(<App />);
    const image = await openFromTree('schema.png');
    expect(await within(image).findByRole('img', { name: 'schema.png' }, partage)).toHaveAttribute('src', expect.stringMatching(/^data:image\/png;base64,/));
    await openFromTree('faux.png');
    await waitFor(() => expect(within(sharedEditor()).getByRole('heading', { name: 'faux.png' })).toBeInTheDocument(), partage);
    expect(await within(sharedEditor()).findByText(/ne modifie pas les fichiers \.png/, undefined, partage)).toBeInTheDocument();
    expect(within(sharedEditor()).queryByRole('img')).toBeNull();
  });

  test('document Word en suivi des modifications : lecture seule, raison donnée', async () => {
    const { wordDocx } = await import('./test/docx-fixture');
    await write('suivi.docx', wordDocx({ trackRevisions: true }));
    render(<App />);
    const editorRegion = await openFromTree('suivi.docx');
    expect(await within(editorRegion).findByText(/Le suivi des modifications est activé/, undefined, partage)).toBeInTheDocument();
    expect(within(editorRegion).getByLabelText('Style du paragraphe')).toBeDisabled();
    expect(within(editorRegion).getByRole('textbox', { name: 'Contenu du document Word' })).toHaveAttribute('contenteditable', 'false');
  });

  const aiUserMessage = () => (aiBodies.at(-1) as { messages: { role: string; content: string }[] }).messages[1].content;

  test('Markdown du partage : la proposition ne charge que les images déjà dans le fichier', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest('1. Ouvrir les paramètres\n\n![pixel](https://traceur.exemple/p.png)');
    // Le titre ne part pas à l'IA, mais l'aperçu le montre : son image reste celle du fichier.
    await write('Imprimante.md', '# ![logo](https://intranet.exemple/logo.png) Imprimante\n\nIP : 10.0.0.5\n');
    render(<App />);
    const editorRegion = await openFromTree('Imprimante.md');
    await within(editorRegion).findByLabelText('Contenu de Imprimante.md');

    fireEvent.click(await aiAction('Compléter', editorRegion));
    const proposal = await within(sharedEditor()).findByRole('region', { name: 'Procédure proposée' });
    expect([...proposal.querySelectorAll('img')].map((image) => image.getAttribute('src'))).toEqual(['https://intranet.exemple/logo.png']);
    expect(within(proposal).getByText('pixel')).toBeInTheDocument();
  });

  test('Markdown du partage : « Compléter » lit titre et contenu, s’applique en brouillon, part au geste', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest('```markdown\n# Imprimante du bureau\n\nAjouter l’imprimante du bureau.\n\n## Étapes\n\n1. Ouvrir les paramètres\n2. Saisir l’adresse 10.0.0.5\n```');
    await write('Imprimante.md', '# Imprimante du bureau\r\n\r\nIP : 10.0.0.5\r\n');
    render(<App />);
    const editorRegion = await openFromTree('Imprimante.md');
    const area = await within(editorRegion).findByLabelText('Contenu de Imprimante.md');

    fireEvent.click(await aiAction('Compléter', editorRegion));
    const proposal = await within(sharedEditor()).findByRole('region', { name: 'Procédure proposée' });
    // Le titre du fichier fait le titre de la procédure ; l'IA lit ce qui suit.
    expect(aiUserMessage()).toBe('Procédure : Imprimante du bureau\nDéjà écrit :\nIP : 10.0.0.5');
    expect(within(proposal).getAllByRole('heading', { name: 'Imprimante du bureau' })).toHaveLength(1);
    expect(within(proposal).getByText('Saisir l’adresse 10.0.0.5')).toBeInTheDocument();
    // Rien n'est écrit avant « Appliquer ».
    expect(area).toHaveValue('# Imprimante du bureau\n\nIP : 10.0.0.5\n');

    fireEvent.click(within(proposal).getByRole('button', { name: 'Appliquer la procédure' }));
    const proposed = '# Imprimante du bureau\n\nAjouter l’imprimante du bureau.\n\n## Étapes\n\n1. Ouvrir les paramètres\n2. Saisir l’adresse 10.0.0.5\n';
    expect(within(sharedEditor()).getByLabelText('Contenu de Imprimante.md')).toHaveValue(proposed);
    expect(within(sharedEditor()).queryByRole('region', { name: 'Procédure proposée' })).not.toBeInTheDocument();
    await waitFor(() => expect(within(sharedEditor()).getByText('Brouillon sur cet ordinateur')).toBeInTheDocument());
    // Un brouillon, pas un envoi : les collègues ne voient rien avant le geste.
    expect(await read('Imprimante.md')).toBe('# Imprimante du bureau\r\n\r\nIP : 10.0.0.5\r\n');
    fireEvent.click(within(sharedEditor()).getByRole('button', { name: 'Enregistrer sur le partage' }));
    await waitFor(async () => expect(await read('Imprimante.md')).toBe(proposed.replace(/\n/g, '\r\n')));
  });

  test('document Word : « Mettre en page » — objet perdu refusé ; appliquée, seuls les paragraphes changés sont réécrits', async () => {
    const { wordDocx } = await import('./test/docx-fixture');
    const { readZip, readZipText } = await import('./zip');
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    await write('Procédure filtration.docx', wordDocx());
    render(<App />);
    const editorRegion = await openFromTree('Procédure filtration.docx');
    const content = await within(editorRegion).findByRole('textbox', { name: 'Contenu du document Word' });

    // L'IA a perdu le tableau : rien n'est proposé.
    mockAiSuggest('# Filtration\n\nLaver le filtre chaque lundi.\n\n[[objet 1 : Image]]\n\n[[objet 3 : Table des matières]]');
    fireEvent.click(await aiAction('Mettre en page', editorRegion));
    expect(await within(sharedEditor()).findByRole('alert')).toHaveTextContent('La proposition a perdu un objet du document (tableau) : relance-la.');
    // Le document part en Markdown, ses objets en marqueurs.
    expect(aiUserMessage()).toContain('Procédure : Filtration\n\nTexte :\n# Filtration\n\n*Laver* **le filtre** chaque lundi.');
    expect(aiUserMessage()).toContain('[[objet 2 : Tableau — Mesure | Valeur / pH | 7,2]]');
    expect(within(sharedEditor()).queryByRole('region', { name: 'Mise en page proposée' })).not.toBeInTheDocument();

    mockAiSuggest('# Filtration\n\nLaver le filtre chaque lundi.\n\nVoir [le guide](https://exemple.fr/guide).\n\n1. Arrêter la pompe\n2. Fermer la vanne\n\n[[objet 1 : Image]]\n\n[[objet 2 : Tableau]]\n\n[[objet 3 : Table des matières]]');
    fireEvent.click(await aiAction('Mettre en page', sharedEditor()));
    const proposal = await within(sharedEditor()).findByRole('region', { name: 'Mise en page proposée' });
    expect(within(proposal).getByText(/Image — conservé tel quel/)).toBeInTheDocument();
    fireEvent.click(within(proposal).getByRole('button', { name: 'Appliquer la mise en page' }));
    await waitFor(() => expect(content).toHaveTextContent('Fermer la vanne'));
    expect(content).not.toHaveTextContent('Vanne fermée');
    await waitFor(() => expect(within(sharedEditor()).getByText('Brouillon sur cet ordinateur')).toBeInTheDocument());

    fireEvent.click(within(sharedEditor()).getByRole('button', { name: 'Enregistrer sur le partage' }));
    await waitFor(() => expect(within(sharedEditor()).getByText('Enregistré sur le partage.')).toBeInTheDocument());
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    const sent = new Uint8Array(fs.readFileSync(path.join(share, 'Procédure filtration.docx')));
    const after = (await readZipText(readZip(sent), 'word/document.xml'))!;
    // Paragraphe gardé tel quel (le correcteur n'en part qu'à la réécriture), étape neuve dans la liste d'origine, image recopiée.
    expect(after).toContain('<w:proofErr w:type="spellStart"/><w:r><w:rPr><w:b/><w:bCs/></w:rPr><w:t>le filtre</w:t></w:r>');
    expect(after).toContain('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">Fermer la vanne</w:t></w:r>');
    expect(after).toContain('<w:drawing>');
    expect(after).not.toContain('Vanne fermée');
  });

  test('IA du partage : verrou d’un collègue, tableur sans IA, texte brut sans Markdown, fichier modifié avant d’appliquer', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest('Prérequis\n- Accès admin\n\nÉtapes\n1. Redémarrer le service');
    await write('planning.txt', 'lundi\n');
    await write('relevés.csv', 'a;b\n1;2\n');
    await write('Redémarrage.txt', 'service web\n');
    render(<App />);

    // Ouvert dans LibreOffice par une collègue : lecture seule, l'IA aussi. (Le sondage peut
    // montrer le verrou avant que le contenu soit lu : on attend le contenu, et les boutons avec.)
    await openFromTree('planning.txt');
    await within(sharedEditor()).findByLabelText('Contenu de planning.txt');
    await write('.~lock.planning.txt#', 'Hélène Martin,hmartin,TSE01,05.10.2026 09:00,file:///C:/x;');
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(await within(sharedEditor()).findByText(/Lecture seule — Ouvert par Hélène Martin dans LibreOffice/)).toBeInTheDocument();
    expect(await aiAction('Compléter', sharedEditor())).toBeDisabled();
    expect(await aiAction('Mettre en page', sharedEditor())).toBeDisabled();

    // Un tableur n'a pas de procédure à rédiger.
    await openFromTree('relevés.csv');
    await within(sharedEditor()).findByRole('grid', { name: 'Tableau relevés.csv' });
    expect(within(sharedEditor()).queryByRole('button', { name: 'Assistance IA' })).not.toBeInTheDocument();

    await openFromTree('Redémarrage.txt');
    const area = await within(sharedEditor()).findByLabelText('Contenu de Redémarrage.txt');
    fireEvent.click(await aiAction('Compléter', sharedEditor()));
    const proposal = await within(sharedEditor()).findByRole('region', { name: 'Procédure proposée' });
    expect((aiBodies.at(-1) as { messages: { content: string }[] }).messages[0].content).toMatch(/texte brut, sans syntaxe Markdown/);
    expect(aiUserMessage()).toBe('Procédure : Redémarrage\nDéjà écrit :\nservice web');
    // Un `.txt` se relit tel qu'il sera écrit, sans rendu Markdown.
    expect(proposal.querySelector('pre')!.textContent).toBe('Prérequis\n- Accès admin\n\nÉtapes\n1. Redémarrer le service\n');
    // Une frappe pendant la relecture : appliquer l'effacerait.
    fireEvent.change(area, { target: { value: 'service web et base\n' } });
    fireEvent.click(within(proposal).getByRole('button', { name: 'Appliquer la procédure' }));
    expect(within(sharedEditor()).getByRole('alert')).toHaveTextContent('Le fichier a changé pendant la suggestion : relance-la');
    expect(area).toHaveValue('service web et base\n');
  });

  test('IA du partage sans clé : le bouton l’explique, rien ne part', async () => {
    const calls: string[] = [];
    const diverted = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      return diverted(input, init);
    }));
    await write('notes.md', 'Laver le filtre.\n');
    render(<App />);
    await openFromTree('notes.md');
    fireEvent.click(await aiAction('Mettre en page', sharedEditor()));
    expect(await within(sharedEditor()).findByRole('alert')).toHaveTextContent('Colle ta clé IA dans ⚙ Paramètres pour activer la mise en page.');
    expect(calls.some((url) => url.includes('chat/completions'))).toBe(false);
  });

  test('un classeur Excel s’ouvre dans la grille ; une cellule modifiée, seule sa balise change', async () => {
    const { excelWorkbook } = await import('./test/xlsx-fixture');
    const { readZip, readZipText } = await import('./zip');
    const original = excelWorkbook();
    await write('Budget atelier.xlsx', original);
    await clientApi.setSharedDisplayName('T. Grollier');
    render(<App />);
    const editorRegion = await openFromTree('Budget atelier.xlsx');
    const grid = await within(editorRegion).findByRole('grid', { name: 'Feuille Suivi' }, partage);
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
    await waitFor(() => expect(within(sharedEditor()).getByText('Brouillon sur cet ordinateur')).toBeInTheDocument(), partage);

    fireEvent.click(within(sharedEditor()).getByRole('button', { name: 'Enregistrer sur le partage' }));
    await waitFor(() => expect(within(sharedEditor()).getByText('Enregistré sur le partage.')).toBeInTheDocument(), partage);
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    const sent = new Uint8Array(fs.readFileSync(path.join(share, 'Budget atelier.xlsx')));
    const sheet = (await readZipText(readZip(sent), 'xl/worksheets/sheet1.xml'))!;
    expect(sheet).toContain('<c r="B3" s="2"><v>250</v></c>');
    expect(sheet).toContain('<c r="B2" s="2"><v>1234.5</v></c>');
    expect(await readZipText(readZip(sent), 'xl/sharedStrings.xml')).toBe(await readZipText(readZip(original), 'xl/sharedStrings.xml'));
    expect(await readZipText(readZip(sent), 'docProps/core.xml')).toContain('<cp:lastModifiedBy>T. Grollier</cp:lastModifiedBy>');
    // Relu depuis le partage : la formule qui lit B3 attend son recalcul, WorkLogs la montre.
    await waitFor(() => expect(within(sharedEditor()).getByRole('gridcell', { name: 'B4 : =SOMME(B2:B3)' })).toBeInTheDocument(), partage);
  });

  test('classeur : feuille masquée et protégée, formule fautive signalée avant l’envoi', async () => {
    const { excelWorkbook } = await import('./test/xlsx-fixture');
    const original = excelWorkbook();
    await write('Budget.xlsx', original);
    render(<App />);
    const editorRegion = await openFromTree('Budget.xlsx');
    await within(editorRegion).findByRole('grid', { name: 'Feuille Suivi' }, partage);
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
      fireEvent.click((await tree()).getByRole('button', { name: 'Dossier Global' }));
      expect(await screen.findByText(/Accès refusé à ce dossier : le compte avec lequel le partage est monté n’y a pas droit/, undefined, partage)).toHaveAttribute('role', 'alert');
      expect(screen.queryByText('Lecture…')).not.toBeInTheDocument();
      // Le reste de l'arbre reste utilisable.
      expect(screen.getByRole('button', { name: /^Ouvrir notes\.md/ })).toBeInTheDocument();
    } finally {
      fs.chmodSync(path.join(share, 'Global'), 0o755);
    }
  });

  test('supprime un fichier du partage depuis l’éditeur, après confirmation', async () => {
    await write('notes.md', 'v1\n');
    render(<App />);
    const editorRegion = await openFromTree('notes.md');
    await within(editorRegion).findByLabelText('Contenu de notes.md', undefined, partage);
    fireEvent.click(within(editorRegion).getByRole('button', { name: 'Supprimer du partage' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Fichier partagé' })).not.toBeInTheDocument(), partage);
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    expect(fs.existsSync(path.join(share, 'notes.md'))).toBe(false);
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Ouvrir notes\.md/ })).not.toBeInTheDocument(), partage);
  });

  test('supprime un fichier du partage depuis l’arbre, sans l’ouvrir', async () => {
    await write('à-garder.md', 'gardé\n');
    await write('à-jeter.md', 'jeté\n');
    render(<App />);
    expect((await tree()).getByRole('button', { name: /^Ouvrir à-jeter\.md/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer à-jeter.md du partage' }));
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    await waitFor(() => expect(fs.existsSync(path.join(share, 'à-jeter.md'))).toBe(false), partage);
    expect(fs.existsSync(path.join(share, 'à-garder.md'))).toBe(true);
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Ouvrir à-jeter\.md/ })).not.toBeInTheDocument(), partage);
  });

  test('annule la suppression depuis l’arbre : rien ne part', async () => {
    await write('notes.md', 'v1\n');
    render(<App />);
    expect((await tree()).getByRole('button', { name: /^Ouvrir notes\.md/ })).toBeInTheDocument();
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer notes.md du partage' }));
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    expect(fs.existsSync(path.join(share, 'notes.md'))).toBe(true);
    expect(screen.getByRole('button', { name: /^Ouvrir notes\.md/ })).toBeInTheDocument();
  });

  test('suppression refusée avec un brouillon : le fichier reste, l’erreur se lit', async () => {
    await write('notes.md', 'v1\n');
    render(<App />);
    const editorRegion = await openFromTree('notes.md');
    fireEvent.change(await within(editorRegion).findByLabelText('Contenu de notes.md', undefined, partage), { target: { value: 'v1\nmoi\n' } });
    await waitFor(() => expect(within(editorRegion).getByText('Brouillon sur cet ordinateur')).toBeInTheDocument(), partage);
    fireEvent.click(within(editorRegion).getByRole('button', { name: 'Supprimer du partage' }));
    expect(await within(editorRegion).findByText(/Envoie ou abandonne d’abord ton brouillon/, undefined, partage)).toBeInTheDocument();
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    expect(fs.existsSync(path.join(share, 'notes.md'))).toBe(true);
  });

  test('nouveau dossier : créé où l’on est, déplié aussitôt, un nouveau fichier y va ; un nom pris n’écrase rien', async () => {
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, 'Procédures'));
    await write('Procédures/existant.md', 'x\n');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '＋ Nouveau dossier…' }, partage));
    const form = screen.getByRole('form', { name: 'Nouveau dossier' });
    expect(within(form).getByLabelText('Emplacement du nouveau dossier')).toHaveValue('');
    fireEvent.change(within(form).getByLabelText('Nom du dossier'), { target: { value: ' 3. Sauvegardes ' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Créer' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Dossier 3. Sauvegardes' })).toHaveAttribute('aria-expanded', 'true'));
    expect(fs.statSync(path.join(share, '3. Sauvegardes')).isDirectory()).toBe(true);
    expect(await screen.findByText('Dossier vide.')).toBeInTheDocument();
    // Le fichier neuf suivant va dans le dossier qu'on vient de créer.
    fireEvent.click(screen.getByRole('button', { name: '＋ Nouveau fichier…' }));
    const fileForm = screen.getByRole('form', { name: 'Nouveau fichier' });
    expect(within(fileForm).getByLabelText('Dossier du nouveau fichier')).toHaveValue('3. Sauvegardes');
    fireEvent.click(within(fileForm).getByRole('button', { name: 'Annuler' }));

    fireEvent.click(screen.getByRole('button', { name: '＋ Nouveau dossier…' }));
    const again = screen.getByRole('form', { name: 'Nouveau dossier' });
    fireEvent.change(within(again).getByLabelText('Emplacement du nouveau dossier'), { target: { value: '' } });
    fireEvent.change(within(again).getByLabelText('Nom du dossier'), { target: { value: 'Procédures' } });
    fireEvent.click(within(again).getByRole('button', { name: 'Créer' }));
    expect(await screen.findByText('« Procédures » existe déjà dans ce dossier : rien n’a été créé. Choisis un autre nom.')).toBeInTheDocument();
    expect(await read('Procédures/existant.md')).toBe('x\n');
  });

  test('renommer un dossier dans sa ligne : l’arbre et le fichier ouvert dedans suivent', async () => {
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, 'Projets'));
    await write('Projets/notes.md', 'v1\n');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dossier Projets' }));
    const editorRegion = await openFromTree('notes.md');
    expect(await within(editorRegion).findByLabelText('Contenu de notes.md')).toHaveValue('v1\n');

    fireEvent.click(screen.getByRole('button', { name: 'Renommer ou supprimer Projets' }));
    fireEvent.click(screen.getByRole('button', { name: 'Renommer Projets' }));
    const form = screen.getByRole('form', { name: 'Renommer le dossier Projets' });
    const field = within(form).getByLabelText('Nouveau nom du dossier');
    expect(field).toHaveValue('Projets');
    fireEvent.change(field, { target: { value: 'Chantiers' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Renommer' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Dossier Chantiers' })).toHaveAttribute('aria-expanded', 'true'));
    expect(fs.existsSync(path.join(share, 'Projets'))).toBe(false);
    expect(await screen.findByRole('button', { name: /^Ouvrir notes\.md/ })).toBeInTheDocument();

    // Le fichier ouvert a suivi : ce qu'on y écrit part dans le dossier renommé.
    const content = await within(sharedEditor()).findByLabelText('Contenu de notes.md');
    fireEvent.change(content, { target: { value: 'v1\nsuite\n' } });
    await waitFor(() => expect(within(sharedEditor()).getByText('Brouillon sur cet ordinateur')).toBeInTheDocument());
    fireEvent.click(within(sharedEditor()).getByRole('button', { name: 'Enregistrer sur le partage' }));
    await waitFor(() => expect(within(sharedEditor()).getByText('Enregistré sur le partage.')).toBeInTheDocument());
    expect(await read('Chantiers/notes.md')).toBe('v1\nsuite\n');
    expect(fs.existsSync(path.join(share, 'Projets'))).toBe(false);
  });

  test('renommer ou supprimer un dossier relié à un projet : le lien du projet suit', async () => {
    seedData(api.db, { projects: [{ id: 'pr_p', name: 'Piscine' }, { id: 'pr_a', name: 'Atelier' }, { id: 'pr_x', name: 'Bureau' }] });
    const linkOf = (id: string) => row(api.db, 'SELECT shared_dir FROM projects WHERE id=?', id).shared_dir;
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, 'Piscine', 'Filtres'), { recursive: true });
    fs.mkdirSync(path.join(share, 'Atelier'));
    fs.mkdirSync(path.join(share, 'Bureau'));
    api.db.prepare('UPDATE projects SET shared_dir=? WHERE id=?').run('Piscine/Filtres', 'pr_p');
    api.db.prepare('UPDATE projects SET shared_dir=? WHERE id=?').run('Atelier', 'pr_a');
    api.db.prepare('UPDATE projects SET shared_dir=? WHERE id=?').run('Bureau', 'pr_x');
    render(<App />);

    fireEvent.click(await (await tree()).findByRole('button', { name: 'Renommer ou supprimer Piscine' }));
    fireEvent.click(screen.getByRole('button', { name: 'Renommer Piscine' }));
    const form = screen.getByRole('form', { name: 'Renommer le dossier Piscine' });
    fireEvent.change(within(form).getByLabelText('Nouveau nom du dossier'), { target: { value: 'Bassin' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Renommer' }));
    // Relié à un sous-dossier : le lien suit le dossier renommé au-dessus de lui.
    await waitFor(() => expect(linkOf('pr_p')).toBe('Bassin/Filtres'), partage);

    fireEvent.click(await (await tree()).findByRole('button', { name: 'Renommer ou supprimer Atelier' }));
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer Atelier du partage' }));
    await waitFor(() => expect(linkOf('pr_a')).toBeNull(), partage);
    expect(linkOf('pr_x')).toBe('Bureau');
  });

  test('renommer refusé tant qu’un brouillon attend dedans : la raison sous le dossier, Échap annule', async () => {
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, 'Projets'));
    await write('Projets/notes.md', 'v1\n');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dossier Projets' }));
    const editorRegion = await openFromTree('notes.md');
    fireEvent.change(await within(editorRegion).findByLabelText('Contenu de notes.md'), { target: { value: 'v1\nmoi\n' } });
    await waitFor(() => expect(within(editorRegion).getByText('Brouillon sur cet ordinateur')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Renommer ou supprimer Projets' }));
    fireEvent.click(screen.getByRole('button', { name: 'Renommer Projets' }));
    const field = screen.getByLabelText('Nouveau nom du dossier');
    fireEvent.change(field, { target: { value: 'Chantiers' } });
    fireEvent.click(screen.getByRole('button', { name: 'Renommer' }));
    expect(await screen.findByText('« Projets/notes.md » a un brouillon sur cet ordinateur : envoie-le ou abandonne-le avant de renommer ce dossier.'))
      .toHaveAttribute('role', 'alert');
    expect(fs.existsSync(path.join(share, 'Projets', 'notes.md'))).toBe(true);
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByRole('form', { name: 'Renommer le dossier Projets' })).not.toBeInTheDocument();
    expect(screen.queryByText(/a un brouillon sur cet ordinateur/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dossier Projets' })).toBeInTheDocument();
  });

  test('supprimer un dossier : la confirmation dit ce qui part ; le fichier ouvert dedans se referme', async () => {
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, 'Archives', '2024'), { recursive: true });
    await write('Archives/2024/bilan.md', '# Bilan\n');
    await write('Archives/notes.md', 'v1\n');
    await write('garde.md', 'gardé\n');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dossier Archives' }, { timeout: 5000 }));
    await openFromTree('notes.md');
    fireEvent.click(screen.getByRole('button', { name: 'Renommer ou supprimer Archives' }));
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer Archives du partage' }));
    await waitFor(() => expect(fs.existsSync(path.join(share, 'Archives'))).toBe(false));
    expect(window.confirm).toHaveBeenLastCalledWith(
      'Supprimer le dossier « Archives » et tout son contenu (2 fichiers et 1 sous-dossier) du dossier partagé ? Cette action est immédiate pour toute l’équipe.',
    );
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Fichier partagé' })).not.toBeInTheDocument(), { timeout: 5000 });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Dossier Archives' })).not.toBeInTheDocument(), { timeout: 5000 });
    expect(await read('garde.md')).toBe('gardé\n');
  });

  test('supprimer un dossier : annulé, rien ne part ; un fichier ouvert par un collègue, refusé sans rien demander', async () => {
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, 'Archives'));
    await write('Archives/notes.md', 'v1\n');
    fs.mkdirSync(path.join(share, 'Planning'));
    await write('Planning/relevés.csv', 'a;b\n');
    await write('Planning/~$relevés.csv', excelOwner('Jean Dupont'));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Renommer ou supprimer Archives' }));
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer Archives du partage' }));
    await waitFor(() => expect(window.confirm).toHaveBeenCalledTimes(1));
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining('et tout son contenu (1 fichier)'));
    expect(fs.existsSync(path.join(share, 'Archives', 'notes.md'))).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Renommer ou supprimer Planning' }));
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer Planning du partage' }));
    expect(await screen.findByText('« Planning/relevés.csv » est ouvert par Jean Dupont dans Excel : il doit être fermé avant de supprimer ce dossier.'))
      .toHaveAttribute('role', 'alert');
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(share, 'Planning', 'relevés.csv'))).toBe(true);
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

  describe('« ✨ Trouver la doc » d’une tâche', () => {
    // Une procédure d'un autre projet, une note trouvée par son texte, une note déjà liée.
    const seedTask = () => {
      seedData(api.db, {
        projects: [{ id: 'pr_bureau', name: 'Bureau' }, { id: 'pr_info', name: 'Informatique' }],
        entries: [
          { id: 'en_proc', title: 'Installer une imprimante', kind: 'procedure', project_id: 'pr_info', content_md: 'Brancher le câble USB.' },
          { id: 'en_note', title: 'Compte rendu du lundi', project_id: 'pr_bureau', content_md: 'Le pilote fourni ne marche pas sous Windows 11.' },
          { id: 'en_lie', title: 'Imprimante du bureau 2', project_id: 'pr_bureau', content_md: 'Contenu de la note liée.' },
        ],
        tasks: [{ id: 'tk_imp', title: 'Brancher la nouvelle imprimante', project_id: 'pr_bureau' }],
      });
      api.db.prepare('INSERT INTO task_entries (task_id,entry_id,created_at) VALUES (?,?,?)').run('tk_imp', 'en_lie', new Date().toISOString());
      localStorage.setItem('worklogs-project', 'pr_bureau');
      localStorage.setItem('worklogs-ai-key', 'cle-test');
    };
    const findDocs = async () => {
      const card = (await within(board()).findByText('Brancher la nouvelle imprimante')).closest('.card') as HTMLElement;
      fireEvent.click(await aiAction('Trouver la doc', card, 'Assistance IA de la tâche'));
      return card;
    };

    test('Trouver la doc : WorkLogs et le partage répondent aux mots de l’IA ; lier une procédure, ouvrir un fichier', async () => {
      mockAiSuggest(JSON.stringify(['imprimante', 'pilote']));
      seedTask();
      const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
      fs.mkdirSync(path.join(share, 'Imprimantes'));
      await write('Imprimantes/Pilote HP.md', '# Pilote HP\n');
      render(<App />);

      const card = await findDocs();
      const found = await within(card).findByRole('region', { name: 'Documents trouvés' }, partage);
      expect(within(found).getByText('Cherché avec : imprimante, pilote')).toBeInTheDocument();
      // Mot du titre avant mot du texte ; à mot égal, la note de WorkLogs avant le fichier du
      // partage, trouvé par son seul nom. La note déjà liée n'est pas reproposée.
      expect(within(found).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
        'ProcédureInstaller une imprimanteInformatique · trouvé avec : imprimanteOuvrirLier',
        'NoteCompte rendu du lunditrouvé avec : piloteOuvrirLier',
        'PartagePilote HP.mdImprimantes · trouvé avec : piloteOuvrir',
      ]);
      // Des titres partent, jamais le texte d'un document.
      const sent = (aiBodies.at(-1) as { messages: { content: string }[] }).messages[1].content;
      expect(sent).toContain('Tâche : Brancher la nouvelle imprimante\nStatut : À faire\nProjet : Bureau');
      expect(sent).toContain('Documents déjà liés à la tâche : Imprimante du bureau 2');
      expect(sent).not.toContain('Contenu de la note liée');
      expect(sent).not.toContain('Le pilote fourni');

      fireEvent.click(within(found).getByRole('button', { name: 'Lier Installer une imprimante à la tâche' }));
      expect(await within(found).findByText('Liée')).toBeInTheDocument();
      expect(row(api.db, 'SELECT COUNT(*) n FROM task_entries WHERE task_id=? AND entry_id=?', 'tk_imp', 'en_proc').n).toBe(1);
      expect(within(card).getByRole('button', { name: 'Retirer Installer une imprimante de Brancher la nouvelle imprimante' })).toBeInTheDocument();

      fireEvent.click(within(found).getByRole('button', { name: 'Ouvrir Pilote HP.md' }));
      const opened = await screen.findByRole('region', { name: 'Fichier partagé' }, partage);
      expect(await within(opened).findByLabelText('Contenu de Pilote HP.md', undefined, partage)).toHaveValue('# Pilote HP\n');
    });

    test('Trouver la doc sans dossier partagé : WorkLogs seul, et « Ouvrir » suit le projet du document', async () => {
      await api.close();
      api = await useRealApi();
      mockAiSuggest(JSON.stringify(['imprimante', 'pilote']));
      seedTask();
      render(<App />);

      const found = await within(await findDocs()).findByRole('region', { name: 'Documents trouvés' }, partage);
      expect(within(found).getByText('Dossier partagé indisponible : recherche dans WorkLogs seulement.')).toBeInTheDocument();
      expect(within(found).getAllByRole('button', { name: /^Ouvrir / }).map((button) => button.getAttribute('aria-label')))
        .toEqual(['Ouvrir Installer une imprimante', 'Ouvrir Compte rendu du lundi']);

      // La procédure n'est ni dans le projet filtré ni liée : le filtre suit quand même son projet.
      fireEvent.click(within(found).getByRole('button', { name: 'Ouvrir Installer une imprimante' }));
      await waitFor(() => expect(within(filters()).getByRole('button', { name: /^Informatique/ })).toHaveAttribute('aria-pressed', 'true'));
      await waitFor(() => expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Installer une imprimante'));
    });

    test('Trouver la doc : Arrêter pendant les recherches abandonne les mots suivants, sans erreur ni liste', async () => {
      mockAiSuggest(JSON.stringify(['imprimante', 'pilote']));
      seedTask();
      const originalState = clientApi.state.bind(clientApi);
      const terms: string[] = [];
      let release!: () => void;
      vi.spyOn(clientApi, 'state').mockImplementation(async (q = '', projectId = '', categoryId = '') => {
        if (q) {
          terms.push(q);
          await new Promise<void>((resolve) => { release = resolve; });
        }
        return originalState(q, projectId, categoryId);
      });
      render(<App />);

      const card = await findDocs();
      await waitFor(() => expect(terms).toEqual(['imprimante']), partage);
      fireEvent.click(within(card).getByRole('button', { name: 'Arrêter la demande IA' }));
      await act(async () => release());
      expect(await within(card).findByRole('button', { name: 'Assistance IA de la tâche' }, partage)).toBeInTheDocument();
      expect(terms).toEqual(['imprimante']);
      expect(within(card).queryByRole('region', { name: 'Documents trouvés' })).not.toBeInTheDocument();
      expect(within(card).queryByRole('alert')).not.toBeInTheDocument();
    });

    test('Trouver la doc : une réponse IA illisible s’affiche en erreur, rien n’est cherché ni listé', async () => {
      mockAiSuggest('Voici quelques mots : imprimante, pilote.');
      seedTask();
      const search = vi.spyOn(clientApi, 'searchShared');
      render(<App />);

      const card = await findDocs();
      expect(await within(card).findByRole('alert')).toHaveTextContent('Réponse IA illisible : réessaie.');
      expect(within(card).queryByRole('region', { name: 'Documents trouvés' })).not.toBeInTheDocument();
      expect(await aiAction('Trouver la doc', card, 'Assistance IA de la tâche')).toBeEnabled();
      expect(search).not.toHaveBeenCalled();
    });
  });
});

describe('IA dans les notes : contexte, affinement et actions', () => {
  test('fusionner deux entrées cochées : l’IA propose une note relue, Valider la garde seule', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest('# Vanne et joint\n\nLa vanne fuit.\n\nLe joint est remplacé.');
    seedData(api.db, {
      entries: [
        { id: 'en_vanne', title: 'Vanne', content_md: 'La vanne fuit.' },
        { id: 'en_joint', title: 'Joint', content_md: 'Le joint est remplacé.' },
      ],
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Choisir Vanne pour une fusion' }));
    const bar = screen.getByRole('group', { name: 'Entrées choisies' });
    expect(within(bar).getByRole('button', { name: '✨ Fusionner' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Choisir Joint pour une fusion' }));
    fireEvent.click(within(bar).getByRole('button', { name: '✨ Fusionner' }));
    const panel = await screen.findByRole('form', { name: 'Fusion d’entrées' });
    expect(await within(panel).findByLabelText('Titre de l’entrée fusionnée')).toHaveValue('Vanne et joint');
    expect(aiBodies).toHaveLength(1);
    const sent = (aiBodies[0] as { messages: { content: string }[] }).messages[1].content;
    expect(sent).toContain('Le joint est remplacé.');
    expect(sent).not.toMatch(/en_vanne|en_joint/);
    // Rien n'est écrit avant la validation.
    expect(row(api.db, 'SELECT count(*) n FROM entries').n).toBe(2);
    fireEvent.click(within(panel).getByRole('button', { name: 'Valider la fusion' }));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Fusion d’entrées' })).not.toBeInTheDocument(), { timeout: 5000 });
    expect(await screen.findByDisplayValue('Vanne et joint')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Entrées choisies' })).not.toBeInTheDocument();
    expect(api.db.prepare('SELECT title, content_md FROM entries').all()).toEqual([
      { title: 'Vanne et joint', content_md: 'La vanne fuit.\n\nLe joint est remplacé.' },
    ]);
  });

  test('fusionner une entrée riche envoie son Markdown : le lien et son adresse arrivent au modèle', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest('# Accès et joint\n\nVoir le [wiki](https://wiki.exemple/p).');
    seedData(api.db, { entries: [{ id: 'en_joint', title: 'Joint', content_md: 'Le joint est remplacé.' }] });
    await clientApi.createEntry({ title: 'Accès', content_json: { type: 'doc', content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Procédure' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'wiki', marks: [{ type: 'link', attrs: { href: 'https://wiki.exemple/p' } }] }] },
    ] } });
    render(<App />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Choisir Accès pour une fusion' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Choisir Joint pour une fusion' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Entrées choisies' })).getByRole('button', { name: '✨ Fusionner' }));
    const panel = await screen.findByRole('form', { name: 'Fusion d’entrées' });
    expect(await within(panel).findByLabelText('Titre de l’entrée fusionnée')).toHaveValue('Accès et joint');
    const sent = (aiBodies[0] as { messages: { content: string }[] }).messages[1].content;
    expect(sent).toContain('[wiki](https://wiki.exemple/p)');
    expect(sent).toContain('## Procédure');
    expect(sent).toContain('Le joint est remplacé.');
    // Les clés des sources restent celles des entrées lues : la validation aboutit.
    fireEvent.click(within(panel).getByRole('button', { name: 'Valider la fusion' }));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Fusion d’entrées' })).not.toBeInTheDocument(), { timeout: 5000 });
    expect(api.db.prepare('SELECT title FROM entries').all()).toEqual([{ title: 'Accès et joint' }]);
  });

  test('fusionne deux notes de tâche et conserve les références', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest('# Remplacer le joint\n\nLa vanne fuit.\n\n- [ ] Commander le joint');
    const valve = await clientApi.createTask({ title: 'Vérifier la vanne', content_md: 'La vanne fuit.' });
    await clientApi.createTask({ title: 'Commander le joint', pinned: 1 });
    const reference = await clientApi.createEntry({ title: 'Notice', content_md: 'Document de référence.' });
    await clientApi.linkTaskDocument(valve.id, reference.id);
    render(<App />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Choisir la tâche Vérifier la vanne pour une fusion' }));
    const bar = screen.getByRole('group', { name: 'Tâches choisies' });
    expect(within(bar).getByRole('button', { name: '✨ Fusionner' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Choisir la tâche Commander le joint pour une fusion' }));
    fireEvent.click(within(bar).getByRole('button', { name: '✨ Fusionner' }));
    const panel = await screen.findByRole('form', { name: 'Fusion de tâches' });
    expect(await within(panel).findByLabelText('Titre de la tâche fusionnée')).toHaveValue('Remplacer le joint');
    expect(aiBodies).toHaveLength(1);
    const sent = (aiBodies[0] as { messages: { content: string }[] }).messages[1].content;
    expect(sent).toContain('La vanne fuit.');
    expect(sent).toContain('Commander le joint');
    expect(sent).not.toContain('Document de référence.');
    // Rien n'est écrit avant la validation.
    expect(row(api.db, 'SELECT count(*) n FROM tasks').n).toBe(2);
    expect(row(api.db, 'SELECT count(*) n FROM entries').n).toBe(3);
    fireEvent.click(within(panel).getByRole('button', { name: 'Valider la fusion' }));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Fusion de tâches' })).not.toBeInTheDocument(), { timeout: 5000 });
    expect(await screen.findByDisplayValue('Remplacer le joint')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Tâches choisies' })).not.toBeInTheDocument());
    expect(api.db.prepare('SELECT title, pinned FROM tasks').all()).toEqual([{ title: 'Remplacer le joint', pinned: 1 }]);
    expect(api.db.prepare('SELECT title, content_md FROM entries ORDER BY title').all()).toEqual([
      { title: 'Notice', content_md: 'Document de référence.' },
      { title: 'Remplacer le joint', content_md: 'La vanne fuit.\n\n- [ ] Commander le joint' },
    ]);
    expect(row(api.db, 'SELECT count(*) n FROM task_entries').n).toBe(2);
  });

  test('suggère des tâches depuis le brouillon en cours et crée seulement la sélection liée', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, {
      projects: [{ id: 'pr_bassin', name: 'Bassin' }],
      entries: [{ id: 'en_note', title: 'Panne', content_md: 'Ancien texte.', project_id: 'pr_bassin' }],
    });
    mockAiSuggest(JSON.stringify([
      { title: 'Vérifier la ventilation', priority: 'low', due_date: '2026-11-05', evidence: 'Le moteur surchauffe.' },
      { title: 'Contrôler le moteur', priority: 'high', due_date: '2026-10-30', evidence: 'Le moteur surchauffe.', planning_reason: 'Surchauffe : intervention rapide suggérée.' },
    ]));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Écrire' }));
    fireEvent.change(screen.getByLabelText('Contenu en Markdown'), { target: { value: 'Le moteur surchauffe.' } });
    fireEvent.click(await aiAction('Suggérer des tâches avec l’IA'));
    const proposal = await screen.findByRole('region', { name: 'Tâches suggérées' });
    expect(within(proposal).getByText(/Priorités et échéances sont des propositions à vérifier/)).toBeInTheDocument();
    expect(within(proposal).getByLabelText('Titre de l’action 1')).toHaveValue('Contrôler le moteur');
    expect(within(proposal).getByLabelText('Priorité de l’action 1')).toHaveValue('high');
    expect(within(proposal).getByLabelText('Priorité de l’action 2')).toHaveValue('low');
    expect(within(proposal).getByLabelText('Échéance de l’action 1')).toHaveValue('2026-10-30');
    expect(within(proposal).getByText('Surchauffe : intervention rapide suggérée.')).toBeInTheDocument();
    expect(JSON.stringify(aiBodies.at(-1))).toContain('Le moteur surchauffe.');
    expect(within(proposal).getAllByText('Le moteur surchauffe.', { selector: 'blockquote' })).toHaveLength(2);
    fireEvent.click(within(proposal).getByRole('checkbox', { name: 'Créer l’action Vérifier la ventilation' }));
    fireEvent.change(within(proposal).getByLabelText('Titre de l’action 1'), { target: { value: 'Contrôler le moteur du bassin' } });
    fireEvent.change(within(proposal).getByLabelText('Priorité de l’action 1'), { target: { value: 'normal' } });
    expect(within(proposal).getByLabelText('Priorité de l’action 1')).toHaveValue('normal');
    fireEvent.change(within(proposal).getByLabelText('Priorité de l’action 1'), { target: { value: 'high' } });
    fireEvent.change(within(proposal).getByLabelText('Échéance de l’action 1'), { target: { value: '2026-11-01' } });
    fireEvent.click(within(proposal).getByRole('button', { name: 'Créer les tâches sélectionnées' }));
    await within(proposal).findByText('1 tâche créée et liée à cette note.');
    const created = row(api.db, "SELECT id,project_id,priority,due_date,status FROM tasks WHERE title='Contrôler le moteur du bassin'");
    expect(created).toMatchObject({ project_id: 'pr_bassin', priority: 'high', due_date: '2026-11-01', status: 'doing' });
    expect(row(api.db, 'SELECT entry_id FROM task_entries WHERE task_id=? AND entry_id=?', created.id, 'en_note').entry_id).toBe('en_note');
    expect(row(api.db, "SELECT count(*) AS n FROM tasks WHERE title='Vérifier la ventilation'").n).toBe(0);
    expect(screen.getByLabelText('Contenu en Markdown')).toHaveValue('Le moteur surchauffe.');
  });

  test('met la tâche suggérée la plus urgente et à échéance la plus proche en cours', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, {
      entries: [{ id: 'en_note', title: 'Panne', content_md: 'La pompe chauffe.' }],
    });
    mockAiSuggest(JSON.stringify([
      { title: 'Urgente plus tard', priority: 'high', due_date: '2026-11-10', evidence: 'La pompe chauffe.' },
      { title: 'Urgente bientôt', priority: 'high', due_date: '2026-11-04', evidence: 'La pompe chauffe.' },
      { title: 'Normale aujourd’hui', priority: 'normal', due_date: '2026-11-01', evidence: 'La pompe chauffe.' },
    ]));
    render(<App />);
    fireEvent.click(await aiAction('Suggérer des tâches avec l’IA'));
    const proposal = await screen.findByRole('region', { name: 'Tâches suggérées' });
    fireEvent.click(within(proposal).getByRole('button', { name: 'Créer les tâches sélectionnées' }));
    await within(proposal).findByText('3 tâches créées et liées à cette note.');

    expect(row(api.db, "SELECT status FROM tasks WHERE title='Urgente bientôt'").status).toBe('doing');
    expect(row(api.db, "SELECT status FROM tasks WHERE title='Urgente plus tard'").status).toBe('todo');
    expect(row(api.db, "SELECT status FROM tasks WHERE title='Normale aujourd’hui'").status).toBe('todo');
  });

  test('changer le titre après une suggestion empêche de créer des tâches périmées', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, { entries: [{ id: 'en_note', title: 'Panne', content_md: 'La pompe chauffe.' }] });
    mockAiSuggest(JSON.stringify([{ title: 'Contrôler la pompe', due_date: null, evidence: 'La pompe chauffe.' }]));
    render(<App />);
    fireEvent.click(await aiAction('Suggérer des tâches avec l’IA'));
    const proposal = await screen.findByRole('region', { name: 'Tâches suggérées' });
    fireEvent.change(screen.getByLabelText('Titre de l’entrée'), { target: { value: 'Autre panne' } });
    fireEvent.click(within(proposal).getByRole('button', { name: 'Créer les tâches sélectionnées' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('a changé depuis la suggestion');
    expect(row(api.db, 'SELECT count(*) AS n FROM tasks').n).toBe(0);
  });

  test('modifier la date de la note invalide les échéances suggérées', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, { entries: [{ id: 'en_note', title: 'Panne', content_md: 'La pompe chauffe.' }] });
    mockAiSuggest(JSON.stringify([{ title: 'Contrôler la pompe', priority: 'high', due_date: '2026-11-01', evidence: 'La pompe chauffe.' }]));
    render(<App />);
    fireEvent.click(await aiAction('Suggérer des tâches avec l’IA'));
    const proposal = await screen.findByRole('region', { name: 'Tâches suggérées' });
    fireEvent.change(screen.getByLabelText('Date de l’entrée'), { target: { value: '2026-10-20' } });
    fireEvent.click(within(proposal).getByRole('button', { name: 'Créer les tâches sélectionnées' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('a changé depuis la suggestion');
    expect(row(api.db, 'SELECT count(*) AS n FROM tasks').n).toBe(0);
  });

  test('changer le titre pendant la suggestion écarte la réponse périmée', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, { entries: [{ id: 'en_note', title: 'Panne', content_md: 'La pompe chauffe.' }] });
    const diverted = globalThis.fetch;
    let finish: (() => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('chat/completions')) return new Promise<Response>((resolve) => {
        finish = () => resolve({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify([{ title: 'Contrôler la pompe', due_date: null, evidence: 'La pompe chauffe.' }]) } }] }) } as Response);
      });
      return diverted(input, init);
    }));
    render(<App />);
    fireEvent.click(await aiAction('Suggérer des tâches avec l’IA'));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    fireEvent.change(screen.getByLabelText('Titre de l’entrée'), { target: { value: 'Autre panne' } });
    await act(async () => { finish?.(); });
    expect(await screen.findByRole('alert')).toHaveTextContent('La note a changé pendant la demande');
    expect(screen.queryByRole('region', { name: 'Tâches suggérées' })).not.toBeInTheDocument();
    expect(row(api.db, 'SELECT count(*) AS n FROM tasks').n).toBe(0);
  });

  test('retirer une source ferme les tâches suggérées et exclut la source du nouvel appel', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, {
      projects: [{ id: 'pr_bassin', name: 'Bassin' }],
      entries: [
        { id: 'en_note', title: 'Pompe', content_md: 'Le moteur chauffe.', project_id: 'pr_bassin' },
        { id: 'en_proc', title: 'Purger la pompe', content_md: 'Instruction complémentaire privée.', project_id: 'pr_bassin', kind: 'procedure' },
      ],
    });
    mockAiSuggest(JSON.stringify([{ title: 'Contrôler le moteur', due_date: null, evidence: 'Le moteur chauffe.' }]));
    render(<App />);
    fireEvent.click(await aiAction('Suggérer des tâches avec l’IA'));
    await screen.findByRole('region', { name: 'Tâches suggérées' });
    expect(JSON.stringify(aiBodies.at(-1))).toContain('Instruction complémentaire privée.');
    fireEvent.click(screen.getByText('Contexte utilisé par l’IA'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Procédure : Purger la pompe' }));
    expect(screen.queryByRole('region', { name: 'Tâches suggérées' })).not.toBeInTheDocument();
    fireEvent.click(await aiAction('Suggérer des tâches avec l’IA'));
    await screen.findByRole('region', { name: 'Tâches suggérées' });
    expect(JSON.stringify(aiBodies.at(-1))).not.toContain('Instruction complémentaire privée.');
  });

  test('retirer une source pendant la création arrête les tâches restantes', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, {
      projects: [{ id: 'pr_bassin', name: 'Bassin' }],
      entries: [
        { id: 'en_note', title: 'Pompe', content_md: 'Le moteur chauffe.', project_id: 'pr_bassin' },
        { id: 'en_proc', title: 'Purger la pompe', content_md: 'Vérifier le moteur.', project_id: 'pr_bassin', kind: 'procedure' },
      ],
    });
    mockAiSuggest(JSON.stringify([
      { title: 'Contrôler le moteur', due_date: null, evidence: 'Le moteur chauffe.' },
      { title: 'Vérifier la ventilation', due_date: null, evidence: 'Le moteur chauffe.' },
    ]));
    const actualCreate = clientApi.createTaskFromEntry;
    let release: (() => void) | undefined;
    const create = vi.spyOn(clientApi, 'createTaskFromEntry').mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return actualCreate(...args);
    });
    render(<App />);
    fireEvent.click(await aiAction('Suggérer des tâches avec l’IA'));
    const proposal = await screen.findByRole('region', { name: 'Tâches suggérées' });
    fireEvent.click(within(proposal).getByRole('button', { name: 'Créer les tâches sélectionnées' }));
    await waitFor(() => expect(release).toBeTypeOf('function'));
    fireEvent.click(screen.getByText('Contexte utilisé par l’IA'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Procédure : Purger la pompe' }));
    await act(async () => { release?.(); });
    expect(await screen.findByRole('alert')).toHaveTextContent('les tâches restantes n’ont pas été créées');
    expect(create).toHaveBeenCalledTimes(1);
    expect(row(api.db, 'SELECT count(*) AS n FROM tasks').n).toBe(1);
    expect(row(api.db, "SELECT count(*) AS n FROM tasks WHERE title='Vérifier la ventilation'").n).toBe(0);
  });

  test('suggère des tâches explicites sélectionnables, modifiables et liées à leur note source', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    const text = 'Vérifier la pompe le 2026-11-01.\nAppeler le fournisseur.\nEnvoyer le devis.';
    seedData(api.db, {
      projects: [{ id: 'pr_bassin', name: 'Bassin' }],
      entries: [{ id: 'en_note', title: 'Compte rendu', content_md: text, project_id: 'pr_bassin' }],
      tasks: [{ id: 'tk_devis', title: 'Envoyer le devis', project_id: 'pr_bassin' }],
    });
    api.db.prepare('INSERT INTO task_entries (task_id,entry_id,created_at) VALUES (?,?,?)').run('tk_devis', 'en_note', new Date().toISOString());
    mockAiSuggest(JSON.stringify([
      { title: 'Vérifier la pompe', due_date: '2026-11-01', evidence: 'Vérifier la pompe le 2026-11-01.' },
      { title: 'Appeler le fournisseur', due_date: null, evidence: 'Appeler le fournisseur.' },
      { title: 'Envoyer le devis', due_date: null, evidence: 'Envoyer le devis.' },
    ]));
    render(<App />);
    // Le démarrage lit d'abord le journal puis le document sélectionné.
    await within(journal()).findByText('Compte rendu');
    fireEvent.click(await aiAction('Suggérer des tâches avec l’IA'));
    const proposal = await screen.findByRole('region', { name: 'Tâches suggérées' });
    expect(within(proposal).getAllByRole('checkbox')).toHaveLength(2);
    expect(within(proposal).getByText('Vérifier la pompe le 2026-11-01.')).toBeInTheDocument();
    expect(within(proposal).getByLabelText('Échéance de l’action 1')).toHaveValue('2026-11-01');
    fireEvent.click(within(proposal).getByRole('checkbox', { name: 'Créer l’action Appeler le fournisseur' }));
    fireEvent.change(within(proposal).getByLabelText('Titre de l’action 1'), { target: { value: 'Contrôler la pompe' } });
    fireEvent.change(within(proposal).getByLabelText('Échéance de l’action 1'), { target: { value: '2026-11-02' } });
    fireEvent.click(within(proposal).getByRole('button', { name: 'Créer les tâches sélectionnées' }));
    await within(proposal).findByText('1 tâche créée et liée à cette note.');
    const created = row(api.db, "SELECT id,title,project_id,due_date FROM tasks WHERE title='Contrôler la pompe'");
    expect(created).toMatchObject({ title: 'Contrôler la pompe', project_id: 'pr_bassin', due_date: '2026-11-02' });
    expect(row(api.db, 'SELECT entry_id FROM task_entries WHERE task_id=? AND entry_id=?', created.id, 'en_note').entry_id).toBe('en_note');
    expect(row(api.db, "SELECT count(*) AS n FROM tasks WHERE title='Appeler le fournisseur'").n).toBe(0);
    expect(row(api.db, "SELECT content_md FROM entries WHERE id='en_note'").content_md).toBe(text);
  });

  test('une création partielle conserve les réussites et réessaie seulement les tâches manquantes', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, { entries: [{ id: 'en_note', title: 'À faire', content_md: 'Appeler le client.\nVérifier le devis.' }] });
    mockAiSuggest(JSON.stringify([
      { title: 'Appeler le client', due_date: null, evidence: 'Appeler le client.' },
      { title: 'Vérifier le devis', due_date: null, evidence: 'Vérifier le devis.' },
    ]));
    const actualCreate = clientApi.createTaskFromEntry;
    const create = vi.spyOn(clientApi, 'createTaskFromEntry')
      .mockImplementationOnce(actualCreate)
      .mockRejectedValueOnce(new Error('Enregistrement temporairement indisponible.'));
    render(<App />);
    fireEvent.click(await aiAction('Suggérer des tâches avec l’IA'));
    const proposal = await screen.findByRole('region', { name: 'Tâches suggérées' });
    fireEvent.click(within(proposal).getByRole('button', { name: 'Créer les tâches sélectionnées' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enregistrement temporairement indisponible');
    expect(within(proposal).getByRole('checkbox', { name: 'Créer l’action Appeler le client' })).toBeDisabled();
    expect(within(proposal).getByRole('checkbox', { name: 'Créer l’action Vérifier le devis' })).toBeChecked();
    expect(within(proposal).getByLabelText('Titre de l’action 2')).toHaveValue('Vérifier le devis');
    fireEvent.click(within(proposal).getByRole('button', { name: 'Créer les tâches sélectionnées' }));
    await waitFor(() => expect(within(proposal).getAllByText('Créée et liée')).toHaveLength(2));
    expect(create.mock.calls.map((call) => call[1]?.title)).toEqual(['Appeler le client', 'Vérifier le devis', 'Vérifier le devis']);
    expect(row(api.db, 'SELECT count(*) AS n FROM tasks').n).toBe(2);
    expect(row(api.db, 'SELECT count(*) AS n FROM task_entries').n).toBe(4);
  });

  test('modifier la note après suggestion bloque la création des tâches devenues anciennes', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, { entries: [{ id: 'en_note', title: 'Note', content_md: 'Appeler le client.' }] });
    mockAiSuggest(JSON.stringify([{ title: 'Appeler le client', due_date: null, evidence: 'Appeler le client.' }]));
    render(<App />);
    fireEvent.click(await aiAction('Suggérer des tâches avec l’IA'));
    await screen.findByRole('region', { name: 'Tâches suggérées' });
    fireEvent.click(screen.getByRole('button', { name: 'Écrire' }));
    fireEvent.change(screen.getByLabelText('Contenu en Markdown'), { target: { value: 'Le client a été appelé.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Créer les tâches sélectionnées' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('a changé depuis la suggestion');
    expect(row(api.db, 'SELECT count(*) AS n FROM tasks').n).toBe(0);
    expect(screen.getByLabelText('Contenu en Markdown')).toHaveValue('Le client a été appelé.');
  });

  test('une note riche locale peut ne contenir aucune action, sans erreur ni création', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, { entries: [{ id: 'en_note', title: 'Bilan' }] });
    api.db.prepare('UPDATE entries SET content_json=? WHERE id=?').run(JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'La pompe a été réparée.' }] }] }), 'en_note');
    mockAiSuggest('[]');
    render(<App />);
    fireEvent.click(await aiAction('Suggérer des tâches avec l’IA'));
    const proposal = await screen.findByRole('region', { name: 'Tâches suggérées' });
    expect(within(proposal).getByText('Aucune nouvelle tâche suggérée pour cette note.')).toBeInTheDocument();
    expect(within(proposal).queryByRole('button', { name: 'Créer les tâches sélectionnées' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const sent = (aiBodies.at(-1) as { messages: { content: string }[] }).messages.map((message) => message.content).join('\n');
    expect(sent).toContain('La pompe a été réparée.');
  });

  test('affiner une mise en page transmet la demande et la proposition précédente en gardant la source intacte', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, { entries: [{ id: 'en_note', title: 'Note', content_md: 'texte original\n\n`cp fichier copie`' }] });
    mockAiSuggest('Une première proposition détaillée.');
    render(<App />);
    fireEvent.click(await aiAction('Mettre en page'));
    const proposal = await screen.findByRole('region', { name: 'Mise en page proposée' });
    mockAiSuggest('Une proposition plus courte.');
    fireEvent.change(within(proposal).getByLabelText('Ajuster la proposition'), { target: { value: 'Conserver la commande exactement.' } });
    fireEvent.click(within(proposal).getByRole('button', { name: 'Affiner' }));
    await within(proposal).findByText('Une proposition plus courte.');
    const sent = (aiBodies.at(-1) as { messages: { content: string }[] }).messages.map((message) => message.content).join('\n');
    expect(sent).toContain('texte original');
    expect(sent).toContain('cp fichier copie');
    expect(sent).toContain('Une première proposition détaillée.');
    expect(sent).toContain('Conserver la commande exactement.');
    fireEvent.click(screen.getByRole('button', { name: 'Écrire' }));
    expect(screen.getByLabelText('Contenu en Markdown')).toHaveValue('texte original\n\n`cp fichier copie`');
    expect(row(api.db, "SELECT content_md FROM entries WHERE id='en_note'").content_md).toBe('texte original\n\n`cp fichier copie`');
    mockAiSuggest('Encore plus court.');
    fireEvent.click(within(proposal).getByRole('button', { name: 'Plus court' }));
    await within(proposal).findByText('Encore plus court.');
    expect(JSON.stringify(aiBodies.at(-1))).toContain('Plus court');
  });

  test('les sous-tâches gardent la frappe arrivée pendant l’appel et utilisent le contexte du projet', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, {
      projects: [{ id: 'pr_bassin', name: 'Bassin' }, { id: 'pr_autre', name: 'Autre projet' }],
      entries: [
        { id: 'en_note', title: 'Pompe : diagnostic', content_md: 'Vérifier la pompe.', project_id: 'pr_bassin', date: '2026-10-21' },
        { id: 'en_proc', title: 'Purger la pompe', content_md: 'Fermer la vanne avant purge.', project_id: 'pr_bassin', kind: 'procedure' },
        { id: 'en_secret', title: 'Pompe SECRET', content_md: 'SECRET AUTRE PROJET', project_id: 'pr_autre', date: '2026-10-20' },
      ],
    });
    const diverted = globalThis.fetch;
    let finish: (() => void) | undefined;
    let request: { messages: { content: string }[] } | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('chat/completions')) {
        request = JSON.parse(init?.body as string);
        return new Promise<Response>((resolve) => { finish = () => resolve({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Purger la pompe' } }] }) } as Response); });
      }
      return diverted(input, init);
    }));
    render(<App />);
    fireEvent.click(await within(await screen.findByRole('region', { name: 'Journal' })).findByText('Pompe : diagnostic'));
    fireEvent.click(await screen.findByRole('button', { name: 'Écrire' }));
    fireEvent.change(screen.getByLabelText('Contenu en Markdown'), { target: { value: 'Vérifier la pompe. Brouillon récent.' } });
    fireEvent.click(await aiAction('Suggérer des sous-tâches'));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    fireEvent.change(screen.getByLabelText('Contenu en Markdown'), { target: { value: 'Vérifier la pompe. Brouillon récent. Frappe pendant IA.' } });
    await act(async () => { finish?.(); });
    await waitFor(() => expect(screen.getByLabelText('Contenu en Markdown')).toHaveValue('Vérifier la pompe. Brouillon récent. Frappe pendant IA.\n## Sous-tâches\n- [ ] Purger la pompe\n'));
    expect(JSON.stringify(request)).toContain('Brouillon récent.');
    expect(JSON.stringify(request)).toContain('Fermer la vanne avant purge.');
    expect(JSON.stringify(request)).not.toContain('SECRET');
  });

  test('quitter une note ignore la procédure qui revient après son démontage', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, { entries: [
      { id: 'en_a', title: 'Source', content_md: 'Réparer la pompe.', date: '2026-10-21' },
      { id: 'en_b', title: 'Autre note', content_md: 'Texte conservé.', date: '2026-10-20' },
    ] });
    const diverted = globalThis.fetch;
    let finish: (() => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('chat/completions')) return new Promise<Response>((resolve) => { finish = () => resolve({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '# Réparer la pompe\n\n1. Couper le courant' } }] }) } as Response); });
      return diverted(input, init);
    }));
    render(<App />);
    fireEvent.click(await aiAction('Créer une procédure'));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    fireEvent.click(within(journal()).getByText('Autre note'));
    await waitFor(() => expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Autre note'));
    await act(async () => { finish?.(); });
    expect(screen.queryByRole('form', { name: 'Procédure rédigée' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Autre note');
  });

  test('sans clé, suggérer des tâches explique le réglage requis avant de charger le contexte', async () => {
    seedData(api.db, { entries: [{ id: 'en_note', title: 'Note', content_md: 'Appeler le client.' }] });
    render(<App />);
    const button = await aiAction('Suggérer des tâches avec l’IA');
    const state = vi.spyOn(clientApi, 'state');
    const readEntry = vi.spyOn(clientApi, 'entry');
    fireEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('Colle ta clé IA');
    expect(state).not.toHaveBeenCalled();
    expect(readEntry).not.toHaveBeenCalled();
  });

  test('retirer une source ferme sa proposition et empêche sa réutilisation dans la demande suivante', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, {
      projects: [{ id: 'pr_bassin', name: 'Bassin' }],
      entries: [
        { id: 'en_note', title: 'Pompe', content_md: 'Examiner le moteur.', project_id: 'pr_bassin' },
        { id: 'en_proc', title: 'Purger la pompe', content_md: 'Instruction privée du document complémentaire.', project_id: 'pr_bassin', kind: 'procedure' },
      ],
    });
    mockAiSuggest('Première proposition dérivée du document complémentaire.');
    render(<App />);
    fireEvent.click(await aiAction('Mettre en page'));
    await screen.findByRole('region', { name: 'Mise en page proposée' });
    // La mise en page ne reçoit d'une source que son vocabulaire : « purger » vient de son titre.
    expect(JSON.stringify(aiBodies.at(-1))).toContain('Vocabulaire du métier : pompe, purger');
    expect(JSON.stringify(aiBodies.at(-1))).not.toContain('Instruction privée du document complémentaire.');
    fireEvent.click(screen.getByText('Contexte utilisé par l’IA'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Procédure : Purger la pompe' }));
    expect(screen.queryByRole('region', { name: 'Mise en page proposée' })).not.toBeInTheDocument();
    mockAiSuggest('Proposition indépendante.');
    fireEvent.click(await aiAction('Mettre en page'));
    await within(await screen.findByRole('region', { name: 'Mise en page proposée' })).findByText('Proposition indépendante.');
    const sent = JSON.stringify(aiBodies.at(-1));
    expect(sent).not.toContain('purger');
    expect(sent).not.toContain('Purger la pompe');
    expect(sent).not.toContain('Première proposition dérivée');
  });

  test('un aller-retour de projet pendant la suggestion invalide aussi son ancienne réponse', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, {
      projects: [{ id: 'pr_a', name: 'Bassin' }, { id: 'pr_b', name: 'Atelier' }],
      entries: [{ id: 'en_note', title: 'Note', content_md: 'Texte conservé.', project_id: 'pr_a' }],
    });
    const diverted = globalThis.fetch;
    let finish: (() => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('chat/completions')) return new Promise<Response>((resolve) => { finish = () => resolve({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Suggestion ancienne' } }] }) } as Response); });
      return diverted(input, init);
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Écrire' }));
    fireEvent.click(await aiAction('Suggérer des sous-tâches'));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    fireEvent.change(screen.getByLabelText('Projet de l’entrée'), { target: { value: 'pr_b' } });
    fireEvent.change(screen.getByLabelText('Projet de l’entrée'), { target: { value: 'pr_a' } });
    await act(async () => { finish?.(); });
    expect(await aiAction('Suggérer des sous-tâches')).toBeEnabled();
    expect(screen.getByLabelText('Contenu en Markdown')).toHaveValue('Texte conservé.');
    expect(screen.queryByRole('button', { name: 'Retirer la suggestion' })).not.toBeInTheDocument();
  });

  test.each([
    { feature: 'les sous-tâches', button: 'Suggérer des sous-tâches', reply: 'Purger la pompe' },
    { feature: 'les tâches suggérées', button: 'Suggérer des tâches avec l’IA', reply: JSON.stringify([{ title: 'Appeler le client', due_date: null, evidence: 'Appeler le client.' }]) },
  ])('retirer une source pendant la réponse invalide aussi $feature', async ({ button, reply }) => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, {
      projects: [{ id: 'pr_bassin', name: 'Bassin' }],
      entries: [
        { id: 'en_note', title: 'Pompe', content_md: 'Appeler le client.', project_id: 'pr_bassin' },
        { id: 'en_proc', title: 'Purger la pompe', content_md: 'Instruction complémentaire.', project_id: 'pr_bassin', kind: 'procedure' },
      ],
    });
    const diverted = globalThis.fetch;
    let finish: (() => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('chat/completions')) return new Promise<Response>((resolve) => { finish = () => resolve({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: reply } }] }) } as Response); });
      return diverted(input, init);
    }));
    render(<App />);
    fireEvent.click(await aiAction(button));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    fireEvent.click(screen.getByText('Contexte utilisé par l’IA'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Procédure : Purger la pompe' }));
    await act(async () => { finish?.(); });
    expect(await aiAction(button)).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Retirer la suggestion' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Tâches suggérées' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Écrire' }));
    expect(screen.getByLabelText('Contenu en Markdown')).toHaveValue('Appeler le client.');
  });

  test('une réponse de création perdue est réconciliée avant retry, et un état illisible bloque toute création', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, { entries: [{ id: 'en_note', title: 'Note', content_md: 'Appeler le client.' }] });
    mockAiSuggest(JSON.stringify([{ title: 'Appeler le client', due_date: null, evidence: 'Appeler le client.' }]));
    const actualCreate = clientApi.createTaskFromEntry;
    const create = vi.spyOn(clientApi, 'createTaskFromEntry').mockImplementationOnce(async (...args) => {
      await actualCreate(...args);
      throw new Error('Réponse perdue après enregistrement.');
    });
    render(<App />);
    fireEvent.click(await aiAction('Suggérer des tâches avec l’IA'));
    const proposal = await screen.findByRole('region', { name: 'Tâches suggérées' });
    fireEvent.click(within(proposal).getByRole('button', { name: 'Créer les tâches sélectionnées' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Réponse perdue après enregistrement');
    expect(row(api.db, 'SELECT count(*) AS n FROM tasks').n).toBe(1);
    expect(within(proposal).getByRole('checkbox', { name: 'Créer l’action Appeler le client' })).toBeChecked();

    vi.spyOn(clientApi, 'state').mockRejectedValueOnce(new Error('État indisponible.'));
    fireEvent.click(within(proposal).getByRole('button', { name: 'Créer les tâches sélectionnées' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de vérifier les tâches déjà liées');
    expect(create).toHaveBeenCalledTimes(1);

    fireEvent.click(within(proposal).getByRole('button', { name: 'Créer les tâches sélectionnées' }));
    await within(proposal).findByText('Créée et liée');
    expect(within(proposal).getByRole('checkbox', { name: 'Créer l’action Appeler le client' })).toBeDisabled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(row(api.db, 'SELECT count(*) AS n FROM tasks').n).toBe(1);
    expect(row(api.db, 'SELECT count(*) AS n FROM task_entries').n).toBe(2);
  });

  test('une case ajoutée pendant la suggestion ne devient pas une sous-tâche en double', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, { entries: [{ id: 'en_note', title: 'Pompe', content_md: 'Vérifier la pompe.' }] });
    const diverted = globalThis.fetch;
    let finish: (() => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('chat/completions')) return new Promise<Response>((resolve) => { finish = () => resolve({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Purger la pompe' } }] }) } as Response); });
      return diverted(input, init);
    }));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Écrire' }));
    fireEvent.click(await aiAction('Suggérer des sous-tâches'));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    fireEvent.change(screen.getByLabelText('Contenu en Markdown'), { target: { value: 'Vérifier la pompe.\n- [ ] Purger la pompe' } });
    await act(async () => { finish?.(); });
    expect(await aiAction('Suggérer des sous-tâches')).toBeEnabled();
    expect(screen.getByLabelText('Contenu en Markdown')).toHaveValue('Vérifier la pompe.\n- [ ] Purger la pompe');
    expect(screen.queryByRole('button', { name: 'Retirer la suggestion' })).not.toBeInTheDocument();
  });

  test('le texte saisi dans une note au titre générique retrouve une procédure pertinente pour l’IA', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, {
      projects: [{ id: 'pr_bassin', name: 'Bassin' }, { id: 'pr_autre', name: 'Autre' }],
      entries: [
        { id: 'en_note', title: 'Compte rendu', content_md: 'Brouillon précédent.', project_id: 'pr_bassin' },
        { id: 'en_proc', title: 'Entretien de la pompe', content_md: 'Purger le filtre avant le redémarrage.', project_id: 'pr_bassin', kind: 'procedure' },
        { id: 'en_secret', title: 'Pompe confidentielle', content_md: 'Texte hors projet.', project_id: 'pr_autre', kind: 'procedure' },
      ],
    });
    mockAiSuggest('Le moteur de la pompe chauffe.');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Écrire' }));
    fireEvent.change(screen.getByLabelText('Contenu en Markdown'), { target: { value: 'Le moteur de la pompe chauffe.' } });
    fireEvent.click(await aiAction('Mettre en page'));
    await screen.findByRole('region', { name: 'Mise en page proposée' });
    const sent = JSON.stringify(aiBodies.at(-1));
    expect(sent).toContain('Le moteur de la pompe chauffe.');
    // La mise en page ne reçoit d'une source que son vocabulaire : « entretien » vient de son titre.
    expect(sent).toContain('Vocabulaire du métier : entretien, pompe');
    expect(sent).not.toContain('Purger le filtre avant le redémarrage.');
    expect(sent).not.toContain('confidentielle');
    fireEvent.click(screen.getByText('Contexte utilisé par l’IA'));
    expect(screen.getByText(/Vocabulaire du projet :/)).toHaveTextContent('entretien');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Procédure : Entretien de la pompe' }));
    expect(screen.queryByText(/Vocabulaire du projet :.*entretien/)).not.toBeInTheDocument();
    fireEvent.click(await aiAction('Mettre en page'));
    await screen.findByRole('region', { name: 'Mise en page proposée' });
    expect(JSON.stringify(aiBodies.at(-1))).not.toContain('entretien');
  });

  test('le contexte des suggestions inclut la priorité et l’échéance des tâches pertinentes', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, {
      projects: [{ id: 'pr_bassin', name: 'Bassin' }, { id: 'pr_autre', name: 'Autre' }],
      entries: [{ id: 'en_note', title: 'Pompe', content_md: 'La pompe fuit.', project_id: 'pr_bassin' }],
      tasks: [
        { id: 'tk_voisine', title: 'Réparer la pompe', project_id: 'pr_bassin', due_date: '2026-11-01' },
        { id: 'tk_sans_rapport', title: 'Commander des fournitures', project_id: 'pr_bassin', due_date: '2026-12-01' },
        { id: 'tk_autre', title: 'Pompe secrète', project_id: 'pr_autre', due_date: '2026-11-02' },
        { id: 'tk_fini', title: 'Pompe terminée', project_id: 'pr_bassin', status: 'done', due_date: '2026-11-03' },
      ],
    });
    api.db.prepare("UPDATE tasks SET priority='high' WHERE id='tk_voisine'").run();
    mockAiSuggest('[]');
    render(<App />);
    fireEvent.click(await aiAction('Suggérer des tâches avec l’IA'));
    await screen.findByRole('region', { name: 'Tâches suggérées' });
    const sent = JSON.stringify(aiBodies.at(-1));
    expect(sent).toContain('Réparer la pompe — priorité haute ; échéance 2026-11-01');
    // Une tâche du projet sans mot commun avec la note n'est plus envoyée du tout.
    expect(sent).not.toContain('Commander des fournitures');
    expect(sent).not.toContain('2026-12-01');
    expect(sent).not.toContain('Pompe secrète');
    expect(sent).not.toContain('Pompe terminée');
    fireEvent.click(screen.getByText('Contexte utilisé par l’IA'));
    expect(screen.getByText('Réparer la pompe — priorité haute ; échéance 2026-11-01')).toBeInTheDocument();
    // Le contexte affiché est celui envoyé.
    expect(screen.getByText(/Tâches en cours :/)).not.toHaveTextContent('Commander des fournitures');
  });

  // Service IA qui ne répond qu'aux appels prévus : les autres attendent qu'on les coupe.
  const hangingAi = (answer: (call: number) => string | null = () => null) => {
    const signals: AbortSignal[] = [];
    const diverted = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes('chat/completions')) return diverted(input, init);
      const signal = init!.signal!;
      signals.push(signal);
      const content = answer(signals.length);
      if (content !== null) return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) } as Response;
      return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    }));
    return signals;
  };

  test('« Arrêter » coupe la demande en cours d’une note : ni attente, ni message d’erreur, le focus revient au menu', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, { entries: [{ id: 'en_note', title: 'Réunion', content_md: 'Points notés.' }] });
    const signals = hangingAi();
    render(<App />);
    fireEvent.click(await aiAction('Compléter'));
    const stop = await screen.findByRole('button', { name: 'Arrêter la demande IA' });
    expect(screen.getByRole('button', { name: 'Rédaction…' })).toBeInTheDocument();
    // L'attente se voit là où la note proposée va venir, et s'annonce.
    expect(screen.getByText('L’IA rédige la note…').closest('[role="status"]')).toBeInTheDocument();
    // Coupée en vol, pas seulement avant le départ.
    await waitFor(() => expect(signals).toHaveLength(1));
    await user.click(stop);
    const trigger = await screen.findByRole('button', { name: 'Assistance IA' });
    expect(trigger).toHaveFocus();
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(true);
    expect(screen.queryByRole('button', { name: 'Arrêter la demande IA' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Note proposée' })).not.toBeInTheDocument();
    expect(screen.queryByText('L’IA rédige la note…')).not.toBeInTheDocument();
    expect(await aiAction('Compléter')).toBeEnabled();
  });

  test('« Arrêter » dans une carte : sous-tâches, recherche de doc et procédure rafraîchie, coupées sans erreur', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    seedData(api.db, { tasks: [{ id: 'tk_filtre', title: 'Changer le filtre' }] });
    const signals = hangingAi((call) => (call === 3 ? '# Remplacer le filtre\n\n1. Couper l’eau.' : null));
    render(<App />);
    const card = (await within(board()).findByText('Changer le filtre')).closest('.card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Créer une entrée liée' }));
    fireEvent.click(within(card).getByRole('button', { name: '✨ Suggérer' }));
    await waitFor(() => expect(signals).toHaveLength(1));
    fireEvent.click(within(card).getByRole('button', { name: 'Arrêter la demande IA' }));
    expect(await within(card).findByRole('button', { name: '✨ Suggérer' })).toBeEnabled();
    fireEvent.click(within(card).getByRole('button', { name: 'Annuler' }));

    fireEvent.click(await aiAction('Trouver la doc', card, 'Assistance IA de la tâche'));
    expect(await within(card).findByRole('button', { name: 'Recherche…' })).toBeInTheDocument();
    await waitFor(() => expect(signals).toHaveLength(2));
    fireEvent.click(within(card).getByRole('button', { name: 'Arrêter la demande IA' }));
    expect(await within(card).findByRole('button', { name: 'Assistance IA de la tâche' })).toBeInTheDocument();
    expect(within(card).queryByRole('region', { name: 'Documents trouvés' })).not.toBeInTheDocument();

    // Le pied de carte et son menu sont masqués sous une proposition : elle porte son propre « Arrêter ».
    fireEvent.click(await aiAction('Créer une procédure', card, 'Assistance IA de la tâche'));
    const draft = await within(card).findByRole('form', { name: 'Procédure rédigée' });
    fireEvent.click(within(draft).getByRole('button', { name: 'Rafraîchir' }));
    await waitFor(() => expect(signals).toHaveLength(4));
    expect(draft).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(within(draft).getByRole('button', { name: 'Arrêter la demande IA' }));
    expect(await within(draft).findByRole('button', { name: 'Rafraîchir' })).toBeEnabled();
    expect(draft).toHaveAttribute('aria-busy', 'false');
    expect(within(draft).getByRole('button', { name: 'Ignorer' })).toBeEnabled();
    expect(within(draft).getByLabelText('Titre de la procédure')).toHaveValue('Remplacer le filtre');
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true, false, true]);
    expect(within(card).queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('suivi IA des entrées et tâches', () => {
  const backend = { timeout: 5000 };
  const report = (summary: string) => JSON.stringify({ status: 'blocked', summary, completed: ['Pompe montée.'], next_steps: ['Recevoir le joint.'], blockers: ['Joint manquant.'], warnings: [] });
  const follow = () => screen.getByRole('region', { name: 'Suivi IA de Note évolutive' });
  const response = (summary: string) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: report(summary) } }] }) }) as Response;
  const prepare = () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    localStorage.setItem('worklogs-ai-endpoint', 'https://ia.example/v1');
    seedData(api.db, {
      entries: [{ id: 'en_suivi', title: 'Note évolutive', content_md: 'Pompe montée ; il manque le joint.' }],
      tasks: [{ id: 'tk_suivi', title: 'Remonter la pompe', status: 'doing' }],
    });
    api.db.prepare('INSERT INTO task_entries (task_id,entry_id,created_at) VALUES (?,?,?)').run('tk_suivi', 'en_suivi', new Date().toISOString());
  };
  // Une entrée sans suivi n’a plus de bouton d’activation : seul
  // « + Ajouter au suivi IA » de la vue d’ensemble peut la suivre.
  const activateEntryViaOverview = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Vue d’ensemble des tâches' }));
    const overview = await screen.findByRole('region', { name: 'Vue d’ensemble des projets' }, backend);
    fireEvent.click(within(overview).getByRole('button', { name: 'Ajouter au suivi IA' }));
    const picker = within(overview).getByRole('region', { name: 'Choisir les suivis IA' });
    fireEvent.click(within(picker).getByRole('checkbox', { name: /Note évolutive/ }));
    fireEvent.click(within(picker).getByRole('button', { name: 'Suivre la sélection (1)' }));
    const reports = await within(overview).findByRole('region', { name: 'Bilans et suivis IA' }, backend);
    fireEvent.click(within(reports).getByRole('button', { name: 'Ouvrir l’entrée Note évolutive' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Vue d’ensemble des projets' })).not.toBeInTheDocument(), backend);
    // L’activation par la sélection lance tout de suite la première demande :
    // pas besoin d’attendre la pause automatique ni de cliquer « Actualiser ».
    await screen.findByRole('region', { name: 'Suivi IA de Note évolutive' }, backend);
  };

  test('une version venue de la synchro reste « À actualiser » sans appel ; une modification de la session repart', async () => {
    prepare();
    mockAiSuggest(report('Bilan actualisé.'));
    const enabled = await clientApi.saveFollowUp('entry', 'en_suivi', { enabled: true });
    await clientApi.saveFollowUp('entry', 'en_suivi', { report: JSON.parse(report('Bilan de départ.')), source_key: enabled.source_key });
    // Seule la durée change : le relevé de synchro (5 s) et la pause d’écriture (8 s).
    const { setInterval: interval, setTimeout: timeout } = globalThis;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((run: () => void, ms?: number, ...rest: unknown[]) => interval(run, ms === 5000 ? 50 : ms, ...rest)) as typeof setInterval);
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((run: () => void, ms?: number, ...rest: unknown[]) => timeout(run, ms === 8000 ? 50 : ms, ...rest)) as typeof setTimeout);
    const calm = () => act(async () => { await new Promise((resolve) => timeout(resolve, 300)); });
    const remote = (text: string) => api.db.prepare('UPDATE entries SET content_md=? WHERE id=?').run(text, 'en_suivi');
    let connect!: (status: Awaited<ReturnType<typeof clientApi.googleStatus>>) => void;
    vi.spyOn(clientApi, 'googleStatus').mockReturnValue(new Promise((resolve) => { connect = resolve; }));
    let revision = 1;
    vi.spyOn(clientApi, 'googleSync').mockImplementation(async () => ({ state: 'idle', error: '', lastSyncedAt: null, revision }));
    render(<App />);
    await screen.findByDisplayValue('Note évolutive');

    // Passage d’ouverture : l’écran est déjà chargé quand la première révision connue arrive.
    remote('Version de l’autre appareil.');
    connect({ available: true, configured: true, connected: true, pending: false, error: '', selectedIds: [], account: { email: 'timo@example.com', name: 'Timo' } });
    await within(follow()).findByText('À actualiser', undefined, backend);
    await calm();
    expect(aiBodies).toHaveLength(0);

    // Synchro pendant la session.
    remote('Encore une autre version.');
    revision = 2;
    await within(journal()).findByText(/Encore une autre version/, undefined, backend);
    await calm();
    expect(aiBodies).toHaveLength(0);
    expect(within(follow()).getByText('À actualiser')).toBeVisible();

    // Un geste local supplante la relecture de synchro : celle qui répond à sa place porte la marque.
    const readState = clientApi.state;
    const answers: (() => void)[] = [];
    const held = vi.spyOn(clientApi, 'state').mockImplementation(async (...args) => {
      const next = await readState(...args);
      await new Promise<void>((answer) => answers.push(answer));
      return next;
    });
    remote('Version reçue pendant un geste.');
    revision = 3;
    await waitFor(() => expect(answers).toHaveLength(1), backend);
    fireEvent.click(within(board()).getByRole('button', { name: 'Épingler Remonter la pompe' }));
    await waitFor(() => expect(answers).toHaveLength(2), backend);
    held.mockRestore();
    await act(async () => answers[0]());
    await act(async () => answers[1]());
    await within(journal()).findByText(/Version reçue pendant un geste/, undefined, backend);
    await calm();
    expect(aiBodies).toHaveLength(0);

    fireEvent.change(screen.getByLabelText('Titre de l’entrée'), { target: { value: 'Note évolutive modifiée' } });
    await waitFor(() => expect(aiBodies).toHaveLength(1), backend);
  });

  test('la sélection commune active plusieurs suivis et indique les notes déjà incluses avec leur tâche', async () => {
    prepare();
    mockAiSuggest(report('Le montage attend son joint.'));
    render(<App />);
    await screen.findByDisplayValue('Note évolutive');
    fireEvent.click(screen.getByRole('button', { name: 'Vue d’ensemble des tâches' }));
    const overview = await screen.findByRole('region', { name: 'Vue d’ensemble des projets' }, backend);
    // Une tâche ouverte non terminée suffit : le bilan lit la totalité des tâches.
    expect(within(overview).getByRole('button', { name: 'Bilan du jour' })).toBeEnabled();
    fireEvent.click(within(overview).getByRole('button', { name: 'Ajouter au suivi IA' }));
    const picker = within(overview).getByRole('region', { name: 'Choisir les suivis IA' });
    fireEvent.click(within(picker).getByRole('checkbox', { name: /Remonter la pompe/ }));
    expect(within(picker).getByText(/Déjà incluse avec « Remonter la pompe »/)).toBeInTheDocument();
    fireEvent.click(within(picker).getByRole('checkbox', { name: /Note évolutive/ }));
    fireEvent.click(within(picker).getByRole('button', { name: 'Suivre la sélection (2)' }));
    const reports = await within(overview).findByRole('region', { name: 'Bilans et suivis IA' }, backend);
    await waitFor(() => expect(within(reports).getAllByText('Le montage attend son joint.')).toHaveLength(2), backend);
    expect(within(overview).queryByRole('region', { name: 'Choisir les suivis IA' })).not.toBeInTheDocument();
    await waitFor(() => expect(within(overview).getByRole('button', { name: 'Bilan du jour' })).toBeEnabled(), backend);
    expect((await clientApi.followUp('task', 'tk_suivi')).follow_up?.enabled).toBe(true);
    expect((await clientApi.followUp('entry', 'en_suivi')).follow_up?.enabled).toBe(true);
    expect(row(api.db, 'SELECT status FROM tasks WHERE id=?', 'tk_suivi').status).toBe('doing');
    expect(aiBodies).toHaveLength(2);
  }, 20_000);

  test('pendant qu’un suivi s’actualise, Bilan du jour et Replanifier attendent, puis redeviennent disponibles', async () => {
    prepare();
    const diverted = globalThis.fetch;
    let finish!: (value: Response) => void;
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes('chat/completions')) return diverted(input, init);
      calls++;
      return new Promise<Response>((resolve) => { finish = resolve; });
    }));
    render(<App />);
    await screen.findByDisplayValue('Note évolutive');
    fireEvent.click(screen.getByRole('button', { name: 'Vue d’ensemble des tâches' }));
    const overview = await screen.findByRole('region', { name: 'Vue d’ensemble des projets' }, backend);
    fireEvent.click(within(overview).getByRole('button', { name: 'Ajouter au suivi IA' }));
    const picker = within(overview).getByRole('region', { name: 'Choisir les suivis IA' });
    fireEvent.click(within(picker).getByRole('checkbox', { name: /Note évolutive/ }));
    fireEvent.click(within(picker).getByRole('button', { name: 'Suivre la sélection (1)' }));
    // L’activation part sans pause : il ne reste que les allers-retours du serveur.
    await waitFor(() => expect(calls).toBe(1), { timeout: 10_000 });
    const daily = () => within(overview).getByRole('button', { name: 'Bilan du jour' });
    const replan = () => within(overview).getByRole('button', { name: 'Replanifier avec l’IA' });
    const hint = /Bilans de suivi en cours d’actualisation/;
    await waitFor(() => expect(daily()).toBeDisabled(), backend);
    expect(replan()).toBeDisabled();
    expect(within(overview).getByText(hint)).toBeInTheDocument();
    await act(async () => finish(response('Bilan prêt.')));
    await within(overview).findByText('Bilan prêt.', {}, backend);
    await waitFor(() => expect(daily()).toBeEnabled(), backend);
    expect(replan()).toBeEnabled();
    expect(within(overview).queryByText(hint)).not.toBeInTheDocument();
    expect(calls).toBe(1);
  }, 20_000);

  test('une réponse perdue à l’activation est réconciliée sans redater le suivi', async () => {
    prepare();
    mockAiSuggest(report('Suivi préparé.'));
    const original = clientApi.saveFollowUp.bind(clientApi);
    const save = vi.spyOn(clientApi, 'saveFollowUp').mockImplementation(async (kind, id, body) => {
      const result = await original(kind, id, body);
      if (body.enabled) throw new Error('Réponse perdue');
      return result;
    });
    render(<App />);
    await screen.findByDisplayValue('Note évolutive');
    fireEvent.click(screen.getByRole('button', { name: 'Vue d’ensemble des tâches' }));
    const overview = await screen.findByRole('region', { name: 'Vue d’ensemble des projets' }, backend);
    fireEvent.click(within(overview).getByRole('button', { name: 'Ajouter au suivi IA' }));
    const picker = within(overview).getByRole('region', { name: 'Choisir les suivis IA' });
    fireEvent.click(within(picker).getByRole('checkbox', { name: /^Remonter la pompe/ }));
    fireEvent.click(within(picker).getByRole('button', { name: 'Suivre la sélection (1)' }));
    const reports = await within(overview).findByRole('region', { name: 'Bilans et suivis IA' }, backend);
    expect(within(reports).getByRole('button', { name: 'Ouvrir la tâche Remonter la pompe' })).toBeInTheDocument();
    expect(within(overview).queryByRole('alert')).not.toBeInTheDocument();
    expect(save.mock.calls.filter(([, , body]) => body.enabled === true)).toHaveLength(1);
  }, 20_000);

  test('un refus partiel de la sélection garde les éléments restants et ne réactive pas les succès', async () => {
    prepare();
    mockAiSuggest(report('Suivi préparé.'));
    const original = clientApi.saveFollowUp.bind(clientApi);
    const save = vi.spyOn(clientApi, 'saveFollowUp');
    let refused = true;
    save.mockImplementation((kind, id, body) => kind === 'entry' && body.enabled && refused ? Promise.reject(new Error('Activation refusée')) : original(kind, id, body));
    render(<App />);
    await screen.findByDisplayValue('Note évolutive');
    fireEvent.click(screen.getByRole('button', { name: 'Vue d’ensemble des tâches' }));
    const overview = await screen.findByRole('region', { name: 'Vue d’ensemble des projets' }, backend);
    fireEvent.click(within(overview).getByRole('button', { name: 'Ajouter au suivi IA' }));
    const picker = within(overview).getByRole('region', { name: 'Choisir les suivis IA' });
    fireEvent.click(within(picker).getByRole('checkbox', { name: /Remonter la pompe/ }));
    fireEvent.click(within(picker).getByRole('checkbox', { name: /Note évolutive/ }));
    fireEvent.click(within(picker).getByRole('button', { name: 'Suivre la sélection (2)' }));
    expect(await within(overview).findByRole('alert', {}, backend)).toHaveTextContent('Activation refusée');
    await waitFor(() => expect(within(picker).queryByRole('checkbox', { name: /^Remonter la pompe/ })).not.toBeInTheDocument(), backend);
    expect(within(picker).getByRole('checkbox', { name: /Note évolutive/ })).toBeChecked();
    refused = false;
    fireEvent.click(within(picker).getByRole('button', { name: 'Suivre la sélection (1)' }));
    await waitFor(() => expect(within(overview).queryByRole('region', { name: 'Choisir les suivis IA' })).not.toBeInTheDocument(), backend);
    expect(save.mock.calls.filter(([kind, , body]) => kind === 'task' && body.enabled === true)).toHaveLength(1);
  }, 20_000);

  test('la sélection annonce l’activation sans promettre un bilan que rien ne prépare', async () => {
    prepare();
    localStorage.removeItem('worklogs-ai-key');
    render(<App />);
    await screen.findByDisplayValue('Note évolutive');
    fireEvent.click(screen.getByRole('button', { name: 'Vue d’ensemble des tâches' }));
    const overview = await screen.findByRole('region', { name: 'Vue d’ensemble des projets' }, backend);
    fireEvent.click(within(overview).getByRole('button', { name: 'Ajouter au suivi IA' }));
    const picker = within(overview).getByRole('region', { name: 'Choisir les suivis IA' });
    fireEvent.click(within(picker).getByRole('checkbox', { name: /^Remonter la pompe/ }));
    fireEvent.click(within(picker).getByRole('button', { name: 'Suivre la sélection (1)' }));
    expect(await within(overview).findByRole('alert', {}, backend)).toHaveTextContent('Colle ta clé IA');
    expect(within(overview).getByText('1 suivi activé.')).toBeInTheDocument();
  }, 20_000);

  test('conserve des bilans distincts pour la note et sa tâche, visibles dans la vue d’ensemble sans changer leur texte ni leur statut', async () => {
    prepare();
    mockAiSuggest(report('Le montage attend son joint.'));
    const view = render(<App />);
    expect(screen.queryByRole('button', { name: 'Activer le suivi IA de Note évolutive' })).not.toBeInTheDocument();
    await activateEntryViaOverview();
    await within(follow()).findByText('Le montage attend son joint.', {}, backend);
    const card = document.getElementById('task-tk_suivi')!;
    fireEvent.click(within(card).getByRole('button', { name: 'Activer le suivi IA de Remonter la pompe' }));
    await within(card).findByText('Le montage attend son joint.', {}, backend);
    const linkedFollow = within(editor()).getByRole('group', { name: 'Suivi de la tâche liée Remonter la pompe' });
    expect(within(linkedFollow).getByText('Le montage attend son joint.')).toBeInTheDocument();
    expect(aiBodies).toHaveLength(2);
    expect(JSON.stringify(aiBodies[1])).toContain('Pompe montée ; il manque le joint.');
    expect(row(api.db, 'SELECT status FROM tasks WHERE id=?', 'tk_suivi').status).toBe('doing');
    expect(row(api.db, 'SELECT content_md,archived FROM entries WHERE id=?', 'en_suivi')).toMatchObject({ content_md: 'Pompe montée ; il manque le joint.', archived: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Vue d’ensemble des tâches' }));
    const overview = await screen.findByRole('region', { name: 'Bilans et suivis IA' }, backend);
    expect(within(overview).getAllByText('Le montage attend son joint.')).toHaveLength(2);
    fireEvent.click(within(overview).getByRole('button', { name: 'Ouvrir l’entrée Note évolutive' }));
    await within(await screen.findByRole('region', { name: 'Suivi IA de Note évolutive' }, backend)).findByText('Le montage attend son joint.');
    view.unmount();
    render(<App />);
    await within(await screen.findByRole('region', { name: 'Suivi IA de Note évolutive' }, backend)).findByText('Le montage attend son joint.');
    expect(aiBodies).toHaveLength(2);
  }, 20_000);

  test('« Désactiver » retire d’un clic le suivi d’une entrée qui n’en a pas besoin, dans l’entrée comme dans la vue d’ensemble', async () => {
    prepare();
    mockAiSuggest(report('Rien à suivre.'));
    render(<App />);
    expect(screen.queryByRole('button', { name: 'Activer le suivi IA de Note évolutive' })).not.toBeInTheDocument();
    await activateEntryViaOverview();
    await within(follow()).findByText('Rien à suivre.', {}, backend);
    const off = within(follow()).getByRole('button', { name: 'Désactiver le suivi IA de Note évolutive' });
    off.focus();
    fireEvent.click(off);
    // Le bloc disparaît, sans bouton d’activation : ni bilan ni automatisme, le texte ne bouge pas.
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Suivi IA de Note évolutive' })).not.toBeInTheDocument(), backend);
    expect(screen.queryByRole('button', { name: 'Activer le suivi IA de Note évolutive' })).not.toBeInTheDocument();
    expect((await clientApi.followUp('entry', 'en_suivi')).follow_up).toMatchObject({ enabled: false, report: null });
    expect(row(api.db, 'SELECT content_md FROM entries WHERE id=?', 'en_suivi').content_md).toBe('Pompe montée ; il manque le joint.');

    // Réactivé, puis désactivé depuis la liste des bilans : il en sort, sans nouvel appel.
    await activateEntryViaOverview();
    await within(follow()).findByText('Rien à suivre.', {}, backend);
    fireEvent.click(screen.getByRole('button', { name: 'Vue d’ensemble des tâches' }));
    const reports = await screen.findByRole('region', { name: 'Bilans et suivis IA' }, backend);
    const offInList = within(reports).getByRole('button', { name: 'Désactiver le suivi IA de Note évolutive' });
    offInList.focus();
    fireEvent.click(offInList);
    // Plus aucun suivi : le bloc disparaît au lieu de laisser une colonne vide.
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Bilans et suivis IA' })).not.toBeInTheDocument(), backend);
    const page = screen.getByRole('region', { name: 'Vue d’ensemble des projets' });
    // La carte retirée avait le focus : il revient au titre de la vue, pas en haut de page.
    await waitFor(() => expect(document.activeElement).toBe(within(page).getByRole('heading', { name: 'Vue d’ensemble' })), backend);
    expect(aiBodies).toHaveLength(2);
  }, 20_000);

  test('rejette une réponse dépassée par la saisie, puis permet d’actualiser manuellement avec l’automatisme coupé', async () => {
    prepare();
    const diverted = globalThis.fetch;
    let finish!: (value: Response) => void;
    const signals: AbortSignal[] = [];
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes('chat/completions')) return diverted(input, init);
      calls++;
      if (calls === 2) {
        signals.push(init!.signal as AbortSignal);
        return new Promise<Response>((resolve) => { finish = resolve; });
      }
      return Promise.resolve(response(calls === 1 ? 'Premier bilan conservé.' : 'Le joint est reçu.'));
    }));
    render(<App />);
    await activateEntryViaOverview();
    await within(follow()).findByText('Premier bilan conservé.', {}, backend);
    fireEvent.click(within(follow()).getByRole('checkbox', { name: 'Actualisation automatique de Note évolutive' }));
    await waitFor(() => expect(within(follow()).getByRole('checkbox')).not.toBeChecked(), backend);
    fireEvent.click(within(follow()).getByRole('button', { name: 'Actualiser le bilan de Note évolutive' }));
    await waitFor(() => expect(calls).toBe(2), backend);
    fireEvent.click(within(editor()).getByRole('button', { name: 'Écrire', pressed: false }));
    fireEvent.change(screen.getByLabelText('Contenu en Markdown'), { target: { value: 'Pompe montée.\n02/11 : le joint est reçu.' } });
    await act(() => flushPendingSaves());
    await waitFor(() => expect(signals[0].aborted).toBe(true), backend);
    await act(async () => finish(response('Réponse dépassée à écarter.')));
    await waitFor(() => expect(within(follow()).getByRole('button', { name: 'Actualiser le bilan de Note évolutive' })).toBeEnabled(), backend);
    expect(within(follow()).getByText('Premier bilan conservé.')).toBeInTheDocument();
    expect(within(follow()).queryByText('Réponse dépassée à écarter.')).not.toBeInTheDocument();
    expect(within(follow()).getByText(/À actualiser/)).toBeInTheDocument();
    fireEvent.click(within(follow()).getByRole('button', { name: 'Actualiser le bilan de Note évolutive' }));
    await within(follow()).findByText('Le joint est reçu.', {}, backend);
    expect((await clientApi.followUp('entry', 'en_suivi')).follow_up?.enabled).toBe(false);
    expect(calls).toBe(3);
  }, 20_000);

  test('Arrêter et un refus du fournisseur conservent le dernier bilan et ne relancent pas la même version', async () => {
    prepare();
    const diverted = globalThis.fetch;
    let finish!: (value: Response) => void;
    let calls = 0;
    let signal!: AbortSignal;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).includes('chat/completions')) return diverted(input, init);
      calls++;
      if (calls === 1) return Promise.resolve(response('Bilan à garder.'));
      if (calls === 2) {
        signal = init!.signal as AbortSignal;
        return new Promise<Response>((resolve) => { finish = resolve; });
      }
      return Promise.resolve({ ok: false, status: 401, json: async () => ({ error: { message: 'Clé refusée' } }) } as Response);
    }));
    render(<App />);
    await activateEntryViaOverview();
    await within(follow()).findByText('Bilan à garder.', {}, backend);
    fireEvent.click(within(follow()).getByRole('button', { name: 'Actualiser le bilan de Note évolutive' }));
    await waitFor(() => expect(calls).toBe(2), backend);
    fireEvent.click(within(follow()).getByRole('button', { name: 'Arrêter le suivi IA de Note évolutive' }));
    expect(signal.aborted).toBe(true);
    await act(async () => finish(response('Résultat arrêté.')));
    expect(within(follow()).getByText('Bilan à garder.')).toBeInTheDocument();
    expect(within(follow()).queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(within(follow()).getByRole('button', { name: 'Actualiser le bilan de Note évolutive' }));
    await within(follow()).findByRole('alert', {}, backend);
    expect(within(follow()).getByText('Bilan à garder.')).toBeInTheDocument();
    expect((await clientApi.followUp('entry', 'en_suivi')).follow_up?.report?.summary).toBe('Bilan à garder.');
    expect(calls).toBe(3);
  }, 20_000);

  test('une réponse perdue du bilan est relue sans nouvel appel IA et Actualiser reste une nouvelle demande', async () => {
    prepare();
    mockAiSuggest(report('Bilan enregistré malgré la réponse perdue.'));
    const original = clientApi.saveFollowUp.bind(clientApi);
    const save = vi.spyOn(clientApi, 'saveFollowUp').mockImplementation(async (kind, id, body) => {
      const result = await original(kind, id, body);
      if (body.report) throw new Error('Réponse du bilan perdue');
      return result;
    });
    render(<App />);
    await activateEntryViaOverview();
    await within(follow()).findByText('Bilan enregistré malgré la réponse perdue.', {}, backend);
    expect(within(follow()).queryByRole('alert')).not.toBeInTheDocument();
    expect(aiBodies).toHaveLength(1);
    expect(save.mock.calls.filter(([, , body]) => body.report)).toHaveLength(1);

    mockAiSuggest(report('Bilan actualisé volontairement.'));
    fireEvent.click(within(follow()).getByRole('button', { name: 'Actualiser le bilan de Note évolutive' }));
    await within(follow()).findByText('Bilan actualisé volontairement.', {}, backend);
    expect(within(follow()).queryByRole('alert')).not.toBeInTheDocument();
    expect(aiBodies).toHaveLength(1);
    expect(save.mock.calls.filter(([, , body]) => body.report)).toHaveLength(2);
  }, 20_000);

  test.each(['ancien bilan identique', 'bilan différent', 'source modifiée', 'relecture indisponible'])('un enregistrement de bilan incertain garde son erreur : %s', async (scenario) => {
    prepare();
    mockAiSuggest(report('Bilan à garder.'));
    render(<App />);
    await activateEntryViaOverview();
    await within(follow()).findByText('Bilan à garder.', {}, backend);
    const original = clientApi.saveFollowUp.bind(clientApi);
    const originalRead = clientApi.followUp.bind(clientApi);
    let refuseRead = false;
    vi.spyOn(clientApi, 'followUp').mockImplementation((kind, id) => refuseRead
      ? Promise.reject(new Error('Relecture refusée')) : originalRead(kind, id));
    const save = vi.spyOn(clientApi, 'saveFollowUp').mockImplementation(async (kind, id, body) => {
      if (scenario === 'bilan différent' && body.report) await original(kind, id, { ...body, report: { ...body.report, summary: 'Autre bilan enregistré ailleurs.' } });
      if (scenario === 'source modifiée') {
        await original(kind, id, body);
        await clientApi.updateEntry('en_suivi', { content_md: 'Le joint est maintenant reçu.' });
      }
      if (scenario === 'relecture indisponible') {
        await original(kind, id, body);
        refuseRead = true;
      }
      throw new Error('Enregistrement du bilan non confirmé');
    });
    mockAiSuggest(report('Bilan à garder.'));
    fireEvent.click(within(follow()).getByRole('button', { name: 'Actualiser le bilan de Note évolutive' }));
    expect(await within(follow()).findByRole('alert', {}, backend)).toHaveTextContent('Enregistrement du bilan non confirmé');
    expect(within(follow()).getByText('Bilan à garder.')).toBeInTheDocument();
    expect(aiBodies).toHaveLength(1);
    expect(save).toHaveBeenCalledOnce();
  }, 20_000);

  test('une entrée sans suivi n’a pas de bouton d’activation et n’envoie rien à l’IA', async () => {
    prepare();
    mockAiSuggest(report('Ne doit pas être demandé.'));
    render(<App />);
    await screen.findByDisplayValue('Note évolutive');
    // Retiré : l’entrée sans suivi n’affiche ni bouton ni panneau.
    expect(screen.queryByRole('button', { name: 'Activer le suivi IA de Note évolutive' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Suivi IA de Note évolutive' })).not.toBeInTheDocument();
    fireEvent.click(within(editor()).getByRole('button', { name: 'Écrire', pressed: false }));
    fireEvent.change(screen.getByLabelText('Contenu en Markdown'), { target: { value: 'Dernière avancée non enregistrée.' } });
    await act(() => flushPendingSaves());
    expect(aiBodies).toHaveLength(0);
    expect((await clientApi.followUp('entry', 'en_suivi')).follow_up).toBeNull();
    expect(screen.getByLabelText('Contenu en Markdown')).toHaveValue('Dernière avancée non enregistrée.');
  }, 20_000);
});

describe('assistant IA', () => {
  const backend = { timeout: 5000 };
  const chatDialog = () => screen.findByRole('dialog', { name: 'Assistant IA' }, backend);
  const chatOpener = async () => within(await screen.findByRole('banner', {}, backend)).findByRole('button', { name: 'Ouvrir l’assistant IA' }, backend);
  function ask(chat: HTMLElement, text: string) {
    const field = within(chat).getByRole('textbox', { name: 'Message pour l’assistant' });
    fireEvent.change(field, { target: { value: text } });
    fireEvent.keyDown(field, { key: 'Enter' });
  }
  const assistantReply = (reply: object) => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest(JSON.stringify(reply));
  };

  test('le bouton de l’en-tête ouvre l’assistant, Échap referme, le focus revient et la conversation reste', async () => {
    seedData(api.db, { tasks: [{ id: 'tk_pompe', title: 'Réparer la pompe' }] });
    assistantReply({ reply: 'La pompe reste à réparer.' });
    render(<App />);
    const opener = await chatOpener();
    fireEvent.click(opener);
    const chat = await chatDialog();
    ask(chat, 'Où en est la pompe ?');
    expect(await within(chat).findByText('La pompe reste à réparer.', undefined, backend)).toBeInTheDocument();
    expect(aiBodies).toHaveLength(1);
    expect((aiBodies[0] as { messages: { content: string }[] }).messages[1].content).toContain('Réparer la pompe');

    fireEvent(chat, new Event('cancel', { cancelable: true }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Assistant IA' })).not.toBeInTheDocument());
    expect(opener).toHaveFocus();

    fireEvent.click(opener);
    const log = within(await chatDialog()).getByRole('log');
    expect(await within(log).findByText('Où en est la pompe ?')).toBeInTheDocument();
    expect(JSON.stringify({ ...localStorage })).not.toContain('Où en est la pompe');
  }, 20_000);

  test('une proposition appliquée arrive en base et sur l’écran ; rien n’est écrit sans clic', async () => {
    seedData(api.db, { projects: [{ id: 'pj_a', name: 'Atelier' }], tasks: [{ id: 'tk_pompe', title: 'Réparer la pompe', project_id: 'pj_a' }] });
    localStorage.setItem('worklogs-project', 'pj_a');
    assistantReply({
      reply: 'Voici ce que je propose.',
      actions: [
        { kind: 'create_task', title: 'Commander le joint', priority: 'high', due_date: '2026-12-01' },
        { kind: 'update_task', n: 1, status: 'doing' },
        { kind: 'create_note', title: 'Suivi de la pompe', content: 'Joint à commander.' },
      ],
    });
    render(<App />);
    await within(board()).findByText('Réparer la pompe', undefined, backend);
    fireEvent.click(await chatOpener());
    const chat = await chatDialog();
    ask(chat, 'Que faire pour la pompe ?');
    await within(chat).findByText('Voici ce que je propose.', undefined, backend);
    expect(row(api.db, 'SELECT COUNT(*) AS n FROM tasks').n).toBe(1);
    expect(row(api.db, 'SELECT status FROM tasks WHERE id = ?', 'tk_pompe').status).toBe('todo');

    fireEvent.click(within(chat).getByRole('button', { name: /^Appliquer : Créer la tâche « Commander le joint »/ }));
    await within(chat).findByText('✓ Appliqué', undefined, backend);
    expect(row(api.db, 'SELECT status, priority, due_date, project_id FROM tasks WHERE title = ?', 'Commander le joint'))
      .toEqual({ status: 'todo', priority: 'high', due_date: '2026-12-01', project_id: 'pj_a' });
    expect(await within(board()).findByRole('button', { name: 'Commander le joint' }, backend)).toBeInTheDocument();

    fireEvent.click(within(chat).getByRole('button', { name: 'Tout appliquer (2)' }));
    await waitFor(() => expect(within(chat).getAllByText('✓ Appliqué')).toHaveLength(3), backend);
    expect(row(api.db, 'SELECT status FROM tasks WHERE id = ?', 'tk_pompe').status).toBe('doing');
    expect(row(api.db, 'SELECT content_md, project_id FROM entries WHERE title = ?', 'Suivi de la pompe')).toEqual({ content_md: 'Joint à commander.', project_id: 'pj_a' });
    expect(await within(journal()).findByText('Suivi de la pompe', undefined, backend)).toBeInTheDocument();
    expect(aiBodies).toHaveLength(1);
  }, 20_000);

  test('une tâche changée entre-temps ne s’écrit pas : le message propose de redemander', async () => {
    seedData(api.db, { tasks: [{ id: 'tk_pompe', title: 'Réparer la pompe' }] });
    assistantReply({ reply: 'Voici.', actions: [{ kind: 'update_task', n: 1, status: 'doing' }] });
    render(<App />);
    fireEvent.click(await chatOpener());
    const chat = await chatDialog();
    ask(chat, 'Passe la pompe en cours');
    await within(chat).findByText('Voici.', undefined, backend);
    api.db.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('Remplacer la pompe', 'tk_pompe');

    fireEvent.click(within(chat).getByRole('button', { name: /^Appliquer : « Réparer la pompe »/ }));
    expect(await within(chat).findByRole('alert', {}, backend)).toHaveTextContent('Cette tâche a changé depuis la proposition : redemande à l’assistant.');
    expect(row(api.db, 'SELECT status FROM tasks WHERE id = ?', 'tk_pompe').status).toBe('todo');
    expect(within(chat).getByRole('button', { name: /^Réessayer : « Réparer la pompe »/ })).toBeInTheDocument();
  }, 20_000);

  test('ouvrir une tâche masquée lève la recherche et le filtre, puis révèle sa carte', async () => {
    seedData(api.db, {
      projects: [{ id: 'pj_a', name: 'Atelier' }, { id: 'pj_b', name: 'Bureau' }],
      tasks: [{ id: 'tk_facture', title: 'Classer les factures', project_id: 'pj_b' }, { id: 'tk_pompe', title: 'Réparer la pompe', project_id: 'pj_a' }],
    });
    localStorage.setItem('worklogs-project', 'pj_a');
    assistantReply({ reply: 'Elle est dans Bureau.', show_tasks: [1] });
    render(<App />);
    await within(board()).findByText('Réparer la pompe', undefined, backend);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Rechercher' }), { target: { value: 'pompe' } });
    await waitFor(() => expect(within(board()).queryByText('Réparer la pompe')).toBeInTheDocument(), backend);
    expect(within(board()).queryByText('Classer les factures')).not.toBeInTheDocument();

    fireEvent.click(await chatOpener());
    const chat = await chatDialog();
    ask(chat, 'Où sont les factures ?');
    fireEvent.click(await within(chat).findByRole('button', { name: 'Ouvrir la tâche Classer les factures' }, backend));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Assistant IA' })).not.toBeInTheDocument());

    expect(await within(board()).findByDisplayValue('Classer les factures', undefined, backend)).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Rechercher' })).toHaveValue('');
    await waitFor(() => expect(localStorage.getItem('worklogs-project')).toBe(''));
    expect(aiBodies).toHaveLength(1);
  }, 20_000);

  test('ouvrir un document referme l’assistant et affiche la note en suivant son projet', async () => {
    seedData(api.db, {
      projects: [{ id: 'pj_a', name: 'Atelier' }, { id: 'pj_b', name: 'Bureau' }],
      entries: [{ id: 'en_ici', title: 'Note de l’atelier', project_id: 'pj_a' }, { id: 'en_facture', title: 'Factures de mars', content_md: 'Trois factures.', project_id: 'pj_b' }],
    });
    localStorage.setItem('worklogs-project', 'pj_a');
    localStorage.setItem('worklogs-entry', 'en_ici');
    assistantReply({ reply: 'Voici la note.', show_documents: [1] });
    render(<App />);
    fireEvent.click(await chatOpener());
    const chat = await chatDialog();
    ask(chat, 'Où sont les factures ?');
    fireEvent.click(await within(chat).findByRole('button', { name: 'Ouvrir le document Factures de mars' }, backend));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Assistant IA' })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Factures de mars'), backend);
    expect(localStorage.getItem('worklogs-project')).toBe('pj_b');
  }, 20_000);

  test('le titre de la note ouverte et le projet affiché accompagnent la demande', async () => {
    seedData(api.db, { projects: [{ id: 'pj_a', name: 'Atelier' }], entries: [{ id: 'en_ici', title: 'Note de l’atelier', project_id: 'pj_a' }] });
    localStorage.setItem('worklogs-project', 'pj_a');
    localStorage.setItem('worklogs-entry', 'en_ici');
    assistantReply({ reply: 'Vu.' });
    render(<App />);
    await screen.findByDisplayValue('Note de l’atelier', undefined, backend);
    fireEvent.click(await chatOpener());
    const chat = await chatDialog();
    ask(chat, 'Résume');
    await within(chat).findByText('Vu.', undefined, backend);
    const prompt = (aiBodies[0] as { messages: { content: string }[] }).messages[1].content;
    expect(prompt).toContain('Note ouverte : « Note de l’atelier »');
    expect(prompt).toContain('Projet affiché : P1, Atelier');
  }, 20_000);

  test('la vue d’ensemble cache la note : son titre ne part pas', async () => {
    seedData(api.db, { entries: [{ id: 'en_ici', title: 'Note de l’atelier' }] });
    localStorage.setItem('worklogs-entry', 'en_ici');
    assistantReply({ reply: 'Vu.' });
    render(<App />);
    await screen.findByDisplayValue('Note de l’atelier', undefined, backend);
    fireEvent.click(screen.getByRole('button', { name: 'Vue d’ensemble des tâches' }));
    await screen.findByRole('region', { name: 'Vue d’ensemble des projets' }, backend);
    fireEvent.click(await chatOpener());
    const chat = await chatDialog();
    ask(chat, 'Résume');
    await within(chat).findByText('Vu.', undefined, backend);
    expect((aiBodies[0] as { messages: { content: string }[] }).messages[1].content).not.toContain('Note ouverte');
  }, 20_000);

  test('la note renommée part sous son nouveau titre', async () => {
    seedData(api.db, { entries: [{ id: 'en_ici', title: 'Note de l’atelier' }] });
    localStorage.setItem('worklogs-entry', 'en_ici');
    assistantReply({ reply: 'Vu.' });
    render(<App />);
    fireEvent.change(await screen.findByDisplayValue('Note de l’atelier', undefined, backend), { target: { value: 'Note renommée' } });
    await within(journal()).findByText('Note renommée', undefined, backend);
    fireEvent.click(await chatOpener());
    const chat = await chatDialog();
    ask(chat, 'Résume');
    await within(chat).findByText('Vu.', undefined, backend);
    expect((aiBodies[0] as { messages: { content: string }[] }).messages[1].content).toContain('Note ouverte : « Note renommée »');
  }, 20_000);

  test('ouvrir une tâche déjà affichée ne touche ni à la recherche ni au filtre', async () => {
    seedData(api.db, { projects: [{ id: 'pj_a', name: 'Atelier' }], tasks: [{ id: 'tk_pompe', title: 'Réparer la pompe', project_id: 'pj_a' }] });
    localStorage.setItem('worklogs-project', 'pj_a');
    assistantReply({ reply: 'La voici.', show_tasks: [1] });
    render(<App />);
    await within(board()).findByText('Réparer la pompe', undefined, backend);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Rechercher' }), { target: { value: 'pompe' } });
    fireEvent.click(await chatOpener());
    const chat = await chatDialog();
    ask(chat, 'Où en est la pompe ?');
    fireEvent.click(await within(chat).findByRole('button', { name: 'Ouvrir la tâche Réparer la pompe' }, backend));
    expect(await within(board()).findByDisplayValue('Réparer la pompe', undefined, backend)).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Rechercher' })).toHaveValue('pompe');
    expect(localStorage.getItem('worklogs-project')).toBe('pj_a');
  }, 20_000);

  test('une tâche supprimée depuis la réponse : le filtre reste et un message le dit', async () => {
    seedData(api.db, { projects: [{ id: 'pj_a', name: 'Atelier' }], tasks: [{ id: 'tk_pompe', title: 'Réparer la pompe', project_id: 'pj_a' }] });
    localStorage.setItem('worklogs-project', 'pj_a');
    assistantReply({ reply: 'La voici.', show_tasks: [1] });
    render(<App />);
    await within(board()).findByText('Réparer la pompe', undefined, backend);
    const opener = await chatOpener();
    fireEvent.click(opener);
    const chat = await chatDialog();
    ask(chat, 'Où est la pompe ?');
    await within(chat).findByRole('button', { name: 'Ouvrir la tâche Réparer la pompe' }, backend);
    fireEvent(chat, new Event('cancel', { cancelable: true }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Assistant IA' })).not.toBeInTheDocument());

    fireEvent.click(within(board()).getByRole('button', { name: 'Supprimer Réparer la pompe' }));
    await waitFor(() => expect(within(board()).queryByText('Réparer la pompe')).not.toBeInTheDocument(), backend);
    fireEvent.click(opener);
    fireEvent.click(await within(await chatDialog()).findByRole('button', { name: 'Ouvrir la tâche Réparer la pompe' }, backend));

    expect(await screen.findByText('tâche introuvable', undefined, backend)).toBeInTheDocument();
    expect(localStorage.getItem('worklogs-project')).toBe('pj_a');
  }, 20_000);

  test('une tâche créée sous une vue rapide la lève pour apparaître', async () => {
    seedData(api.db, { tasks: [{ id: 'tk_retard', title: 'Tâche en retard', due_date: '2026-01-05' }] });
    assistantReply({ reply: 'Voici.', actions: [{ kind: 'create_task', title: 'Commander le joint' }] });
    render(<App />);
    fireEvent.click(await within(board()).findByRole('button', { name: 'En retard 1' }, backend));
    fireEvent.click(await chatOpener());
    const chat = await chatDialog();
    ask(chat, 'Ajoute le joint');
    fireEvent.click(await within(chat).findByRole('button', { name: /^Appliquer : Créer la tâche « Commander le joint »/ }, backend));
    await within(chat).findByText('✓ Appliqué', undefined, backend);
    expect(await within(board()).findByRole('button', { name: 'Commander le joint' }, backend)).toBeInTheDocument();
  }, 20_000);

  test('une création demandée sous une catégorie filtrée en hérite et reste affichée', async () => {
    seedData(api.db, { projects: [{ id: 'pj_a', name: 'Atelier' }] });
    const category = await clientApi.createCategory({ name: 'Devis', project_id: 'pj_a' });
    localStorage.setItem('worklogs-project', 'pj_a');
    assistantReply({ reply: 'Voici.', actions: [{ kind: 'create_task', title: 'Chiffrer le lot' }, { kind: 'create_note', title: 'Notes du lot', content: 'Trois postes.' }] });
    render(<App />);
    await within(filters()).findByRole('button', { name: /Atelier/ }, backend);
    fireEvent.click(document.querySelector<HTMLButtonElement>('.category-trigger')!);
    fireEvent.click(await within(document.querySelector<HTMLElement>('.category-sheet')!).findByRole('button', { name: 'Afficher la catégorie Devis' }, backend));
    await waitFor(() => expect(document.querySelector('.category-trigger')).toHaveAccessibleName('Catégories : Devis'), backend);

    fireEvent.click(await chatOpener());
    const chat = await chatDialog();
    ask(chat, 'Prépare le lot');
    fireEvent.click(await within(chat).findByRole('button', { name: 'Tout appliquer (2)' }, backend));
    await waitFor(() => expect(within(chat).getAllByText('✓ Appliqué')).toHaveLength(2), backend);

    expect(row(api.db, 'SELECT category_id FROM tasks WHERE title = ?', 'Chiffrer le lot').category_id).toBe(category.id);
    expect(row(api.db, 'SELECT category_id FROM entries WHERE title = ?', 'Notes du lot').category_id).toBe(category.id);
    expect(await within(board()).findByRole('button', { name: 'Chiffrer le lot' }, backend)).toBeInTheDocument();
    expect(await within(journal()).findByText('Notes du lot', undefined, backend)).toBeInTheDocument();
  }, 20_000);
});
