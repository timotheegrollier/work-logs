import { describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { seedData } from './test/server';
import { flushPendingSaves, hasPendingSaves } from './autosave';
import { api as clientApi } from './lib';
import { useAppHarness, api, journal, board, editor, filters, aiAction, row, seedGoogleLink, aiBodies, mockAiSuggest } from './test/app-harness';

useAppHarness();

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
    expect(within(taskProgress).queryByRole('progressbar')).not.toBeInTheDocument();
    expect(within(card).queryByRole('progressbar')).not.toBeInTheDocument();
    const status = within(taskProgress).getByLabelText('Statut de la tâche');
    await user.selectOptions(status, 'doing');
    await waitFor(() => expect(status).toHaveValue('doing'));
    expect(row(api.db, 'SELECT status FROM tasks')).toEqual({ status: 'doing' });

    await user.selectOptions(status, 'done');
    // Terminer archive la note de la tâche ; la rouvrir la fait revenir.
    await waitFor(() => expect(row(api.db, 'SELECT status, archived FROM entries WHERE id=?', 'en_context')).toEqual({ status: 'done', archived: 1 }));
    expect(within(taskProgress).queryByRole('progressbar')).not.toBeInTheDocument();
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
    expect(await screen.findByRole('progressbar', { name: 'Avancement de l’entrée' })).toHaveAttribute('value', '33');
    await user.click(await screen.findByRole('button', { name: 'Suivre comme tâche' }));
    const taskProgress = await within(editor()).findByRole('region', { name: 'Suivi de tâche' });
    const cardProgress = () => within(board()).getByRole('progressbar', { name: 'Avancement de Contrôle pompe' });
    expect(within(taskProgress).getByRole('progressbar')).toHaveAttribute('value', '33');
    expect(row(api.db, 'SELECT status, progress FROM tasks')).toEqual({ status: 'doing', progress: 33 });

    await user.click(within(screen.getByRole('article', { name: 'Aperçu' })).getAllByRole('checkbox')[1]);
    expect(within(taskProgress).getByRole('progressbar')).toHaveAttribute('value', '67');
    await waitFor(() => expect(cardProgress()).toHaveAttribute('value', '67'));
    await user.click(within(screen.getByRole('article', { name: 'Aperçu' })).getAllByRole('checkbox')[2]);
    expect(within(taskProgress).getByRole('progressbar')).toHaveAttribute('value', '100');
    await waitFor(() => expect(cardProgress()).toHaveAttribute('value', '100'));
    // Terminer et archiver la tâche reste un geste explicite.
    expect(row(api.db, 'SELECT status, progress FROM tasks')).toEqual({ status: 'doing', progress: 99 });
    expect(row(api.db, 'SELECT archived FROM entries WHERE id=?', 'en_pompe')).toEqual({ archived: 0 });

    await user.click(within(editor()).getByRole('button', { name: 'Écrire' }));
    fireEvent.change(within(editor()).getByLabelText('Contenu en Markdown'), { target: { value: 'Texte sans liste' } });
    expect(within(taskProgress).queryByRole('progressbar')).not.toBeInTheDocument();
    await waitFor(() => expect(within(board()).queryByRole('progressbar')).not.toBeInTheDocument(), { timeout: 4000 });
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

  test('avec un service personnalisé sans clé, la suggestion renvoie aux Paramètres sans appeler personne', async () => {
    const user = userEvent.setup();
    localStorage.setItem('worklogs-ai-endpoint', 'https://ia.example/v1');
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

  test('pas de procédure tirée d’une procédure ni d’un document Google ; sans clé pour un service personnalisé, rien ne part', async () => {
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
    localStorage.setItem('worklogs-ai-endpoint', 'https://ia.example/v1');
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

  test('le menu du compte ouvre les fichiers des projets, groupés, et mène à leur entrée', async () => {
    const user = userEvent.setup();
    seedData(api.db, {
      projects: [{ id: 'p_villa', name: 'Villa' }],
      entries: [{ id: 'en_files', title: 'Sauvegarde', project_id: 'p_villa', kind: 'procedure' }],
    });
    await api.upload('plan.pdf', '%PDF', { entry_id: 'en_files' });
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Compte et paramètres' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Fichiers des projets' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Fichiers des projets' }));
    const group = within(await dialog.findByRole('region', { name: 'Fichiers du projet Villa' }));
    expect(group.getByRole('button', { name: 'Ouvrir plan.pdf' })).toBeInTheDocument();
    await user.click(group.getByRole('button', { name: 'Ouvrir l’entrée Sauvegarde' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Fichiers des projets' })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Sauvegarde'));
    expect(api.db.prepare('SELECT COUNT(*) n FROM attachments').get()).toEqual({ n: 1 });
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

  test('un ancien tableur XLS propose une ouverture dans l’application du système', async () => {
    const user = userEvent.setup();
    seedData(api.db, { entries: [{ id: 'en_xlsx', title: 'Budget' }] });
    const entry = row(api.db, 'SELECT * FROM entries WHERE id=?', 'en_xlsx') as { id: string };
    const upload = await api.upload('budget.xls', 'ancien binaire', { entry_id: entry.id });
    api.db.prepare('UPDATE attachments SET mime=? WHERE id=?').run(
      'application/vnd.ms-excel', upload.body.id
    );

    render(<App />);
    await user.click(await within(journal()).findByText('Budget'));
    await user.click(await screen.findByRole('button', { name: 'Aperçu de budget.xls' }));

    const dialog = await screen.findByRole('dialog', { name: 'Aperçu de budget.xls' });
    expect(within(dialog).getByText(/tableur/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('img')).not.toBeInTheDocument();
    // Pas encore sur Drive : seule l'ouverture par l'application du système est proposée.
    expect(within(dialog).queryByRole('link', { name: 'Ouvrir dans Drive' })).not.toBeInTheDocument();

    const openAttachment = vi.fn(async () => '');
    window.worklogsDesktop = { onBeforeClose: () => () => {}, openAttachment };
    try {
      await user.click(within(dialog).getByRole('button', { name: 'Ouvrir avec…' }));
      await waitFor(() => expect(openAttachment).toHaveBeenCalledWith(upload.body.stored, 'budget.xls'));
      expect(await within(dialog).findByRole('status')).toHaveTextContent(/lecture seule/);
    } finally {
      delete window.worklogsDesktop;
    }
  });

  test('modifie un XLSX local et enregistre une copie, en gardant les saisies après un refus', async () => {
    const { excelWorkbook } = await import('./test/xlsx-fixture');
    const { readZip, readZipText } = await import('./zip');
    const original = excelWorkbook();
    const user = userEvent.setup();
    seedData(api.db, { entries: [{ id: 'en_xlsx', title: 'Budget atelier' }] });
    const uploaded = await api.upload('budget.xlsx', Buffer.from(original), { entry_id: 'en_xlsx' });
    const upload = vi.spyOn(clientApi, 'upload').mockImplementation(async (file, entryId) => {
      const bytes = await new Promise<ArrayBuffer>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.readAsArrayBuffer(file);
      });
      return (await api.upload(file.name, Buffer.from(bytes), { entry_id: entryId })).body;
    }).mockRejectedValueOnce(new Error('Enregistrement indisponible.'));
    render(<App />);
    await user.click(await screen.findByRole('link', { name: 'budget.xlsx' }));
    const dialog = await screen.findByRole('region', { name: 'Édition de budget.xlsx' }, { timeout: 10_000 });
    // Feuilles en onglets sous la grille, comme dans Excel : la grille suit l'onglet choisi.
    await within(dialog).findByRole('grid', { name: 'Feuille Suivi' });
    const tabs = within(dialog).getByRole('tablist', { name: 'Feuilles du classeur' });
    expect(within(tabs).getByRole('tab', { name: /^Paramètres/ })).toHaveAccessibleName(/masquée/);
    await user.click(within(tabs).getByRole('tab', { name: 'Résumé' }));
    expect(await within(dialog).findByRole('grid', { name: 'Feuille Résumé' })).toBeInTheDocument();
    await user.click(within(tabs).getByRole('tab', { name: 'Suivi' }));
    const grid = await within(dialog).findByRole('grid', { name: 'Feuille Suivi' });
    expect(grid).toBeInTheDocument();
    fireEvent.click(within(grid).getByRole('gridcell', { name: 'B3 : 100,00 €' }));
    const input = within(dialog).getByLabelText('Contenu de la cellule');
    fireEvent.change(input, { target: { value: '250' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await user.click(within(dialog).getByRole('button', { name: 'Fermer' }));
    expect(dialog).toBeInTheDocument();
    expect(window.confirm).toHaveBeenCalledWith('Fermer sans enregistrer la copie modifiée de « budget.xlsx » ?');
    const save = within(dialog).getByRole('button', { name: 'Enregistrer une copie modifiée' });
    await user.click(save);
    expect(await within(dialog).findByRole('alert', {}, { timeout: 10_000 })).toHaveTextContent('Enregistrement indisponible.');
    expect(within(grid).getByRole('gridcell', { name: 'B3 : 250,00 €' })).toBeInTheDocument();
    expect(row(api.db, 'SELECT COUNT(*) n FROM attachments').n).toBe(1);

    await user.click(save);
    const saved = await screen.findByRole('region', { name: 'Édition de budget - modifié.xlsx' }, { timeout: 10_000 });
    expect(await within(saved).findByRole('gridcell', { name: 'B3 : 250,00 €' })).toBeInTheDocument();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(row(api.db, 'SELECT COUNT(*) n FROM attachments').n).toBe(2);
    const source = await (await fetch(clientApi.fileUrl(uploaded.body.stored))).arrayBuffer();
    expect(new Uint8Array(source)).toEqual(original);
    const copy = row(api.db, 'SELECT stored FROM attachments WHERE filename=?', 'budget - modifié.xlsx');
    const changed = new Uint8Array(await (await fetch(clientApi.fileUrl(String(copy.stored)))).arrayBuffer());
    const sheet = await readZipText(readZip(changed), 'xl/worksheets/sheet1.xml');
    expect(sheet).toContain('<c r="B3" s="2"><v>250</v></c>');
    expect(await readZipText(readZip(changed), 'xl/styles.xml')).toBe(await readZipText(readZip(original), 'xl/styles.xml'));
  }, 30_000);

  test('ouvre un ODS depuis son nom dans le panneau Écriture et enregistre une copie modifiée', async () => {
    const { odsWorkbook } = await import('./test/ods-fixture');
    const { readOdsWorkbook } = await import('./ods');
    const original = odsWorkbook();
    const user = userEvent.setup();
    seedData(api.db, { entries: [{ id: 'en_ods', title: 'Stock' }] });
    const uploaded = await api.upload('stock.ods', Buffer.from(original), { entry_id: 'en_ods' });
    const upload = vi.spyOn(clientApi, 'upload').mockImplementation(async (file, entryId) => {
      const bytes = await new Promise<ArrayBuffer>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.readAsArrayBuffer(file);
      });
      return (await api.upload(file.name, Buffer.from(bytes), { entry_id: entryId })).body;
    });

    render(<App />);
    await user.click(await within(journal()).findByText('Stock'));
    await user.click(await screen.findByRole('link', { name: 'stock.ods' }));
    const panel = await screen.findByRole('region', { name: 'Édition de stock.ods' });
    const grid = await within(panel).findByRole('grid', { name: 'Feuille Données' });
    expect(within(panel).getByRole('tab', { name: 'Résumé (masquée)' })).toBeInTheDocument();
    expect(within(grid).getByRole('gridcell', { name: 'B1 : 12,5' })).toBeInTheDocument();
    fireEvent.click(within(grid).getByRole('gridcell', { name: 'A1 : Libellé' }));
    const input = within(panel).getByLabelText('Contenu de la cellule');
    fireEvent.change(input, { target: { value: 'Stock modifié' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await user.click(within(panel).getByRole('button', { name: 'Enregistrer une copie modifiée' }));

    const savedPanel = await screen.findByRole('region', { name: 'Édition de stock - modifié.ods' });
    expect(await within(savedPanel).findByRole('gridcell', { name: 'A1 : Stock modifié' })).toBeInTheDocument();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(row(api.db, 'SELECT COUNT(*) n FROM attachments').n).toBe(2);
    const source = await (await fetch(clientApi.fileUrl(uploaded.body.stored))).arrayBuffer();
    expect(new Uint8Array(source)).toEqual(original);
    const copy = row(api.db, 'SELECT stored FROM attachments WHERE filename=?', 'stock - modifié.ods');
    const changed = new Uint8Array(await (await fetch(clientApi.fileUrl(String(copy.stored)))).arrayBuffer());
    const workbook = await readOdsWorkbook(changed);
    expect(workbook.sheets[0].cells.get(0)?.display).toBe('Stock modifié');
  });

  test('ouvre un CSV dans le même panneau et conserve son séparateur en enregistrant une copie', async () => {
    const user = userEvent.setup();
    seedData(api.db, { entries: [{ id: 'en_csv', title: 'Inventaire' }] });
    const uploaded = await api.upload('inventaire.csv', 'Article;Quantité\nVis;2\n', { entry_id: 'en_csv' });
    vi.spyOn(clientApi, 'upload').mockImplementation(async (file, entryId) => {
      const bytes = await new Promise<ArrayBuffer>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.readAsArrayBuffer(file);
      });
      return (await api.upload(file.name, Buffer.from(bytes), { entry_id: entryId })).body;
    });

    render(<App />);
    await user.click(await within(journal()).findByText('Inventaire'));
    await user.click(await screen.findByRole('link', { name: 'inventaire.csv' }));
    const panel = await screen.findByRole('region', { name: 'Édition de inventaire.csv' });
    expect(panel.closest('#workspace-editor')).not.toBeNull();
    const grid = await within(panel).findByRole('grid', { name: 'Tableau inventaire.csv' });
    fireEvent.click(within(grid).getByRole('gridcell', { name: 'B2 : 2' }));
    const input = within(panel).getByLabelText('Contenu de la cellule');
    fireEvent.change(input, { target: { value: '10' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await user.click(within(panel).getByRole('button', { name: 'Enregistrer une copie modifiée' }));
    expect(await screen.findByRole('region', { name: 'Édition de inventaire - modifié.csv' })).toBeInTheDocument();
    const copy = row(api.db, 'SELECT stored FROM attachments WHERE filename=?', 'inventaire - modifié.csv');
    const result = await (await fetch(clientApi.fileUrl(String(copy.stored)))).text();
    expect(result).toContain('Article;Quantité');
    expect(result).toContain('Vis;10');
    const original = await (await fetch(clientApi.fileUrl(uploaded.body.stored))).text();
    expect(original).toContain('Vis;2');
  });

  test('demande confirmation avant de quitter un tableur modifié dans Écriture', async () => {
    const user = userEvent.setup();
    seedData(api.db, { entries: [{ id: 'en_sheet', title: 'Tableau' }, { id: 'en_next', title: 'Entrée suivante' }] });
    await api.upload('tableau.csv', 'Article;Quantité\nVis;2\n', { entry_id: 'en_sheet' });
    render(<App />);
    await user.click(await within(journal()).findByText('Tableau'));
    await user.click(await screen.findByRole('link', { name: 'tableau.csv' }));
    const panel = await screen.findByRole('region', { name: 'Édition de tableau.csv' });
    const grid = await within(panel).findByRole('grid', { name: 'Tableau tableau.csv' });
    fireEvent.click(within(grid).getByRole('gridcell', { name: 'B2 : 2' }));
    fireEvent.change(within(panel).getByLabelText('Contenu de la cellule'), { target: { value: '8' } });

    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await user.click(await within(journal()).findByText('Entrée suivante'));
    expect(await screen.findByRole('region', { name: 'Édition de tableau.csv' })).toBeInTheDocument();
    expect(window.confirm).toHaveBeenCalledWith('Quitter sans enregistrer la copie modifiée de « tableau.csv » ?');

    await user.click(within(journal()).getByText('Entrée suivante'));
    await waitFor(() => expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Entrée suivante'));
  });

  test('un tableur déjà sur Drive propose « Ouvrir dans Drive »', async () => {
    const { odsWorkbook } = await import('./test/ods-fixture');
    const user = userEvent.setup();
    seedData(api.db, { entries: [{ id: 'en_ods', title: 'Stock' }] });
    const upload = await api.upload('stock.ods', Buffer.from(odsWorkbook()), { entry_id: 'en_ods' });
    api.db.prepare('UPDATE attachments SET drive_file_id=? WHERE id=?').run('drive-ods-1', upload.body.id);

    render(<App />);
    await user.click(await within(journal()).findByText('Stock'));
    await user.click(await screen.findByRole('link', { name: 'stock.ods' }));
    const dialog = await screen.findByRole('region', { name: 'Édition de stock.ods' });
    await within(dialog).findByRole('grid', { name: 'Feuille Données' });
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
