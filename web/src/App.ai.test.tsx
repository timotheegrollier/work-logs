import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { seedData } from './test/server';
import { flushPendingSaves } from './autosave';
import { api as clientApi } from './lib';
import { useAppHarness, api, journal, board, editor, aiAction, row, aiBodies, mockAiSuggest } from './test/app-harness';

useAppHarness();

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

  test('un service personnalisé sans clé explique le réglage requis avant de charger le contexte des suggestions', async () => {
    localStorage.setItem('worklogs-ai-endpoint', 'https://ia.example/v1');
    seedData(api.db, { entries: [{ id: 'en_note', title: 'Note', content_md: 'Appeler le client.' }] });
    render(<App />);
    const button = await aiAction('Suggérer des tâches avec l’IA');
    const state = vi.spyOn(clientApi, 'state');
    const readEntry = vi.spyOn(clientApi, 'entry');
    fireEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Aucune IA intégrée/);
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
    expect(await screen.findByLabelText('Titre de l’entrée', {}, { timeout: 5000 })).toHaveValue('Pompe');
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
    localStorage.setItem('worklogs-ai-endpoint', 'https://ia.example/v1');
    render(<App />);
    await screen.findByDisplayValue('Note évolutive');
    fireEvent.click(screen.getByRole('button', { name: 'Vue d’ensemble des tâches' }));
    const overview = await screen.findByRole('region', { name: 'Vue d’ensemble des projets' }, backend);
    fireEvent.click(within(overview).getByRole('button', { name: 'Ajouter au suivi IA' }));
    const picker = within(overview).getByRole('region', { name: 'Choisir les suivis IA' });
    fireEvent.click(within(picker).getByRole('checkbox', { name: /^Remonter la pompe/ }));
    fireEvent.click(within(picker).getByRole('button', { name: 'Suivre la sélection (1)' }));
    expect(await within(overview).findByRole('alert', {}, backend)).toHaveTextContent(/Aucune IA intégrée/);
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
    localStorage.setItem('worklogs-ai-endpoint', 'https://ia.example/v1');
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
