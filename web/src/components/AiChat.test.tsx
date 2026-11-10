import { useRef, useState, type ComponentProps } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { applyChatProposal, askAssistant, type ChatAnswer, type ChatProposal } from '../ai-chat';
import { AiCancelled } from '../ai-suggest';
import type { EntrySummary, Task } from '../lib';
import { AiChat, type ChatTurn } from './AiChat';

vi.mock('../ai-chat', () => ({ askAssistant: vi.fn(), applyChatProposal: vi.fn() }));
const ask = vi.mocked(askAssistant);
const applyProposal = vi.mocked(applyChatProposal);

afterEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
});

const answer = (patch: Partial<ChatAnswer> = {}): ChatAnswer => ({ reply: 'Réponse de l’assistant.', notice: '', tasks: [], documents: [], proposals: [], usedAi: true, ...patch });
const createTask = (title: string): ChatProposal => ({ kind: 'create_task', title, priority: 'normal', status: 'todo', due_date: null, project_id: null, label: `Créer la tâche « ${title} »` });
const task = { id: 'tk_1', title: 'Réparer la pompe', status: 'doing' } as Task;
const documentSummary = { id: 'en_1', title: 'Réglage de la pompe', kind: 'note' } as EntrySummary;
const onChanged = vi.fn();
const onClose = vi.fn();
const onTask = vi.fn();
const onDocument = vi.fn();

/** `App` en réduction : la conversation et le brouillon survivent au dialogue. */
function Host({ open = true, ...props }: { open?: boolean } & Partial<ComponentProps<typeof AiChat>>) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const draft = useRef('');
  const opener = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={opener}>Ouvrir</button>
    {open && <AiChat turns={turns} onTurns={setTurns} draftStore={draft} projectId="pj_1" openTitle="Note ouverte" compact={false} opener={opener} onClose={onClose} onChanged={onChanged} onTask={onTask} onDocument={onDocument} {...props} />}
  </>;
}

const dialog = () => screen.getByRole('dialog', { name: 'Assistant IA' });
const chat = () => within(dialog());
const field = () => chat().getByRole('textbox', { name: 'Message pour l’assistant' });
function say(text: string) {
  fireEvent.change(field(), { target: { value: text } });
  fireEvent.keyDown(field(), { key: 'Enter' });
}
/** Une demande qui n'aboutit qu'à `resolve`, ou à son signal d'arrêt. */
function pendingAnswer() {
  let resolve!: (value: ChatAnswer) => void;
  let reject!: (cause: Error) => void;
  ask.mockImplementationOnce((settings) => new Promise<ChatAnswer>((done, fail) => {
    resolve = done;
    reject = fail;
    settings.signal?.addEventListener('abort', () => fail(new AiCancelled()));
  }));
  return { resolve: (value: ChatAnswer) => act(async () => resolve(value)), reject: (cause: Error) => act(async () => reject(cause)) };
}
async function answered(value: ChatAnswer, question = 'Une question') {
  ask.mockResolvedValueOnce(value);
  say(question);
  await chat().findByText(value.reply);
}
const proposalButton = (name: string) => chat().getByRole('button', { name });

describe('assistant : conversation', () => {
  test('l’historique garde ce qui était affiché, dans l’ordre de l’écran : « et la deuxième ? » a un référent', async () => {
    render(<Host />);
    const other = { ...documentSummary, id: 'en_2', title: 'Vidange' };
    await answered(answer({ reply: 'Voici.', tasks: [task], documents: [documentSummary, other], proposals: [createTask('A')] }), 'Où en est la pompe ?');
    await answered(answer({ reply: 'Ensuite.' }), 'Et la deuxième ?');
    expect(ask.mock.calls.at(-1)![1].history[1].text).toBe('[proposée] Créer la tâche « A »\n[affiché] « Réparer la pompe »\n[affiché] « Réglage de la pompe »\n[affiché] « Vidange »\nVoici.');
  });

  test('Entrée envoie, Maj+Entrée va à la ligne, et une réponse reste du texte brut', async () => {
    render(<Host />);
    expect(field()).toHaveFocus();
    fireEvent.change(field(), { target: { value: 'Première ligne' } });
    fireEvent.keyDown(field(), { key: 'Enter', shiftKey: true });
    expect(ask).not.toHaveBeenCalled();

    ask.mockResolvedValueOnce(answer({ reply: '<img src=x onerror=alert(1)> ![image](https://exemple.test/x.png)', notice: '1 action écartée : statut inconnu.' }));
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(await chat().findByText('<img src=x onerror=alert(1)> ![image](https://exemple.test/x.png)')).toBeInTheDocument();
    expect(dialog().querySelector('img')).toBeNull();
    expect(chat().getByText('1 action écartée : statut inconnu.')).toBeInTheDocument();
    expect(field()).toHaveValue('');
    expect(ask).toHaveBeenCalledOnce();
    expect(ask.mock.calls[0][1]).toEqual({ text: 'Première ligne', history: [], projectId: 'pj_1', openTitle: 'Note ouverte' });
  });

  test('Entrée pendant une composition IME n’envoie pas', () => {
    render(<Host />);
    fireEvent.change(field(), { target: { value: 'にほん' } });
    fireEvent.keyDown(field(), { key: 'Enter', isComposing: true });
    expect(ask).not.toHaveBeenCalled();
    expect(field()).toHaveValue('にほん');
  });

  test('la catégorie filtrée accompagne la demande', async () => {
    render(<Host categoryId="ct_devis" />);
    await answered(answer());
    expect(ask.mock.calls[0][1].categoryId).toBe('ct_devis');
  });

  test('« Envoyer » n’accepte ni un message vide, ni un second envoi pendant l’attente', async () => {
    render(<Host />);
    const send = chat().getByRole('button', { name: 'Envoyer' });
    expect(send).toBeDisabled();
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(ask).not.toHaveBeenCalled();

    const pending = pendingAnswer();
    say('Une question');
    expect(chat().getByRole('status')).toHaveTextContent('L’assistant cherche');
    fireEvent.change(field(), { target: { value: 'La suivante' } });
    expect(chat().getByRole('button', { name: 'Envoyer' })).toBeDisabled();
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(ask).toHaveBeenCalledOnce();
    expect(field()).toHaveValue('La suivante');
    await pending.resolve(answer());
    expect(chat().queryByRole('status')).not.toBeInTheDocument();
  });

  test('l’historique ne contient que les échanges où le modèle a répondu', async () => {
    render(<Host />);
    await answered(answer({ reply: 'Première réponse.' }), 'Question 1');
    await answered(answer({ reply: 'Recherche locale : 0 résultat.', usedAi: false, notice: 'Clé IA absente.' }), 'Question locale');
    pendingAnswer();
    say('Question coupée');
    fireEvent.click(chat().getByRole('button', { name: 'Arrêter la demande IA' }));
    await chat().findByText('Demande arrêtée.');

    await answered(answer({ reply: 'Deuxième réponse.' }), 'Question 2');
    expect(ask.mock.calls.at(-1)![1].history).toEqual([{ role: 'user', text: 'Question 1' }, { role: 'assistant', text: 'Première réponse.' }]);
  });

  test('« Arrêter » coupe la demande sans alerte et rend le champ', async () => {
    render(<Host />);
    pendingAnswer();
    say('Une question');
    const signal = ask.mock.calls[0][0].signal!;
    expect(signal.aborted).toBe(false);
    fireEvent.click(chat().getByRole('button', { name: 'Arrêter la demande IA' }));
    expect(signal.aborted).toBe(true);
    expect(await chat().findByText('Demande arrêtée.')).toBeInTheDocument();
    expect(chat().queryByRole('alert')).not.toBeInTheDocument();
    expect(chat().queryByRole('button', { name: 'Arrêter la demande IA' })).not.toBeInTheDocument();
    expect(field()).toHaveFocus();
    expect(chat().getByText('Une question')).toBeInTheDocument();
  });

  test('une erreur de lecture s’affiche dans le journal', async () => {
    render(<Host />);
    const pending = pendingAnswer();
    say('Une question');
    await pending.reject(new Error('Impossible de lire tes tâches et tes notes : réessaie.'));
    expect(chat().getByRole('alert')).toHaveTextContent('Impossible de lire tes tâches');
    expect(chat().getByRole('button', { name: 'Envoyer' })).toBeDisabled();
  });

  test('refermer coupe la demande en vol, garde la conversation et le brouillon', async () => {
    const view = render(<Host />);
    pendingAnswer();
    say('Une question');
    const signal = ask.mock.calls[0][0].signal!;
    fireEvent.change(field(), { target: { value: 'Brouillon à garder' } });

    view.rerender(<Host open={false} />);
    expect(signal.aborted).toBe(true);
    expect(screen.getByRole('button', { name: 'Ouvrir' })).toHaveFocus();
    await act(async () => {});

    view.rerender(<Host />);
    expect(chat().getByText('Une question')).toBeInTheDocument();
    expect(chat().getByText('Demande arrêtée.')).toBeInTheDocument();
    expect(field()).toHaveValue('Brouillon à garder');
  });

  test('« Nouvelle conversation » efface tout, coupe la demande et ignore une réponse tardive', async () => {
    render(<Host />);
    const reset = () => chat().getByRole('button', { name: 'Nouvelle conversation' });
    expect(reset()).toBeDisabled();
    await answered(answer({ reply: 'Ancienne réponse.' }));
    const pending = pendingAnswer();
    say('En vol');
    const signal = ask.mock.calls.at(-1)![0].signal!;
    fireEvent.click(reset());
    expect(signal.aborted).toBe(true);
    expect(chat().queryByText('Ancienne réponse.')).not.toBeInTheDocument();
    expect(chat().queryByText('En vol')).not.toBeInTheDocument();
    expect(chat().queryByRole('button', { name: 'Arrêter la demande IA' })).not.toBeInTheDocument();
    await pending.resolve(answer({ reply: 'Trop tard.' }));
    expect(chat().queryByText('Trop tard.')).not.toBeInTheDocument();
    expect(chat().queryByText('Demande arrêtée.')).not.toBeInTheDocument();
  });

  test('le téléphone n’ouvre pas le clavier tout seul', () => {
    render(<Host compact />);
    expect(field()).not.toHaveFocus();
  });

  test('sur téléphone, rouvrir une conversation place le focus sur « Fermer », pas sur « Nouvelle conversation »', async () => {
    const view = render(<Host compact />);
    await answered(answer());
    view.rerender(<Host compact open={false} />);
    view.rerender(<Host compact />);
    expect(chat().getByRole('button', { name: 'Fermer l’assistant' })).toHaveFocus();
  });

  test('rouvrir reprend le brouillon à sa suite', () => {
    const view = render(<Host />);
    fireEvent.change(field(), { target: { value: 'Brouillon gardé' } });
    view.rerender(<Host open={false} />);
    view.rerender(<Host />);
    expect(field()).toHaveFocus();
    expect((field() as HTMLTextAreaElement).selectionStart).toBe('Brouillon gardé'.length);
  });

  test('Échap et « Fermer » referment, le focus revient au bouton d’ouverture', () => {
    const view = render(<Host />);
    fireEvent(dialog(), new Event('cancel', { cancelable: true }));
    fireEvent.click(chat().getByRole('button', { name: 'Fermer l’assistant' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    view.rerender(<Host open={false} />);
    expect(screen.getByRole('button', { name: 'Ouvrir' })).toHaveFocus();
  });

  test('ouvrir une tâche ou un document passe par les gestes de l’application', async () => {
    render(<Host />);
    await answered(answer({ tasks: [task], documents: [documentSummary] }));
    fireEvent.click(chat().getByRole('button', { name: 'Ouvrir la tâche Réparer la pompe' }));
    expect(onTask).toHaveBeenCalledWith(task);
    fireEvent.click(chat().getByRole('button', { name: 'Ouvrir le document Réglage de la pompe' }));
    expect(onDocument).toHaveBeenCalledWith('en_1');
  });

  test('un document Google n’est pas étiqueté comme une note', async () => {
    render(<Host />);
    await answered(answer({ documents: [
      { ...documentSummary, id: 'en_2', title: 'Factures', google_document_id: 'doc_1' },
      { ...documentSummary, id: 'en_3', title: 'Onglet', google_tab_id: 'tab_1' },
      documentSummary,
      { ...documentSummary, id: 'en_4', title: 'Vidange', kind: 'procedure' },
    ] }));
    expect(chat().getByRole('button', { name: 'Ouvrir le document Factures' })).toHaveTextContent('Document Google');
    expect(chat().getByRole('button', { name: 'Ouvrir le document Onglet' })).toHaveTextContent('Document Google');
    expect(chat().getByRole('button', { name: 'Ouvrir le document Réglage de la pompe' })).toHaveTextContent(/Note$/);
    expect(chat().getByRole('button', { name: 'Ouvrir le document Vidange' })).toHaveTextContent(/Procédure$/);
  });

  test('le pied dit ce qui part et la consommation, et rien n’est gardé dans localStorage', async () => {
    render(<Host />);
    expect(chat().getByText(/le titre et la date seuls pour un document Google/)).toBeInTheDocument();
    expect(chat().getByText(/^Aujourd’hui : 0 \/ 150 requêtes/)).toBeInTheDocument();
    await answered(answer(), 'Une question confidentielle');
    expect(localStorage.length).toBe(0);
  });
});

describe('assistant : propositions', () => {
  const label = (title: string) => `Créer la tâche « ${title} »`;

  test('Appliquer écrit au clic, une seule fois, puis relit l’écran', async () => {
    render(<Host />);
    const proposal = createTask('A');
    await answered(answer({ proposals: [proposal] }));
    expect(applyProposal).not.toHaveBeenCalled();
    expect(chat().queryByRole('button', { name: /^Tout appliquer/ })).not.toBeInTheDocument();

    let finish!: () => void;
    applyProposal.mockImplementationOnce(() => new Promise<void>((done) => { finish = done; }));
    fireEvent.click(proposalButton(`Appliquer : ${label('A')}`));
    expect(chat().getByRole('status')).toHaveTextContent('En cours…');
    expect(chat().queryByRole('button', { name: `Appliquer : ${label('A')}` })).not.toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(applyProposal).toHaveBeenCalledExactlyOnceWith(proposal, undefined);
    expect(chat().getByRole('status')).toHaveTextContent('✓ Appliqué');
    expect(onChanged).toHaveBeenCalledOnce();
    expect(field()).toHaveFocus();
  });

  test('seule une tâche créée demande de lever la vue rapide', async () => {
    render(<Host />);
    const note: ChatProposal = { kind: 'create_note', title: 'N', content_md: '', project_id: null, label: 'Créer la note « N »' };
    await answered(answer({ proposals: [createTask('A'), note] }));
    applyProposal.mockResolvedValue();
    fireEvent.click(proposalButton('Appliquer : Créer la note « N »'));
    await waitFor(() => expect(onChanged).toHaveBeenLastCalledWith(false));
    fireEvent.click(proposalButton(`Appliquer : ${label('A')}`));
    await waitFor(() => expect(onChanged).toHaveBeenLastCalledWith(true));
  });

  test('l’historique garde les propositions et leur état : « mets-la en priorité haute » a un référent', async () => {
    render(<Host />);
    await answered(answer({ reply: 'Voici ce que je te propose.', proposals: ['Acheter un filtre', 'Nettoyer', 'Vidanger', 'Purger'].map(createTask) }), 'Prépare l’entretien');
    applyProposal.mockResolvedValueOnce();
    fireEvent.click(proposalButton(`Appliquer : ${label('Acheter un filtre')}`));
    await chat().findByText('✓ Appliqué');
    fireEvent.click(proposalButton(`Ignorer : ${label('Nettoyer')}`));
    applyProposal.mockRejectedValueOnce(new Error('Réseau coupé.'));
    fireEvent.click(proposalButton(`Appliquer : ${label('Vidanger')}`));
    await chat().findByRole('alert');

    await answered(answer({ reply: 'Ensuite.' }), 'Mets-la en priorité haute');
    expect(ask.mock.calls.at(-1)![1].history).toEqual([
      { role: 'user', text: 'Prépare l’entretien' },
      { role: 'assistant', text: `[appliquée] ${label('Acheter un filtre')}\n[ignorée] ${label('Nettoyer')}\n[échouée] ${label('Vidanger')}\n[proposée] ${label('Purger')}\nVoici ce que je te propose.` },
    ]);
  });

  test('« Nouvelle conversation » attend la fin des écritures en cours', async () => {
    render(<Host />);
    await answered(answer({ proposals: [createTask('A'), createTask('B')] }));
    const finished: (() => void)[] = [];
    applyProposal.mockImplementation(() => new Promise<void>((done) => { finished.push(done); }));
    fireEvent.click(chat().getByRole('button', { name: 'Tout appliquer (2)' }));
    const reset = chat().getByRole('button', { name: 'Nouvelle conversation' });
    expect(reset).toBeDisabled();
    await act(async () => finished[0]());
    expect(reset).toBeDisabled();
    await act(async () => finished[1]());
    expect(reset).toBeEnabled();
  });

  test('Ignorer écarte la proposition sans rien écrire', async () => {
    render(<Host />);
    await answered(answer({ proposals: [createTask('A'), createTask('B')] }));
    fireEvent.click(proposalButton(`Ignorer : ${label('A')}`));
    expect(chat().getByText('Ignorée')).toBeInTheDocument();
    expect(chat().queryByRole('button', { name: `Appliquer : ${label('A')}` })).not.toBeInTheDocument();
    expect(chat().queryByRole('button', { name: /^Tout appliquer/ })).not.toBeInTheDocument();
    expect(applyProposal).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  test('Tout appliquer avance une écriture à la fois, continue après un échec et relit une seule fois', async () => {
    render(<Host />);
    const proposals = [createTask('A'), createTask('B'), createTask('C')];
    await answered(answer({ proposals }));
    const finished: (() => void)[] = [];
    const refused: ((cause: Error) => void)[] = [];
    applyProposal.mockImplementation(() => new Promise<void>((done, fail) => { finished.push(done); refused.push(fail); }));

    fireEvent.click(chat().getByRole('button', { name: 'Tout appliquer (3)' }));
    expect(chat().getAllByText('En cours…')).toHaveLength(3);
    expect(chat().queryByRole('button', { name: `Appliquer : ${label('C')}` })).not.toBeInTheDocument();
    expect(applyProposal).toHaveBeenCalledTimes(1);

    await act(async () => finished[0]());
    expect(applyProposal).toHaveBeenCalledTimes(2);
    expect(applyProposal.mock.calls[1][0]).toBe(proposals[1]);
    await act(async () => refused[1](new Error('Cette tâche a changé depuis la proposition : redemande à l’assistant.')));
    expect(applyProposal).toHaveBeenCalledTimes(3);
    expect(onChanged).not.toHaveBeenCalled();
    await act(async () => finished[2]());

    expect(chat().getAllByText('✓ Appliqué')).toHaveLength(2);
    expect(chat().getByRole('alert')).toHaveTextContent('Cette tâche a changé');
    expect(chat().getByRole('button', { name: `Réessayer : ${label('B')}` })).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledOnce();
  });

  test('Réessayer transmet la date du premier essai, relit l’écran et efface l’échec', async () => {
    render(<Host />);
    const proposal = createTask('A');
    await answered(answer({ proposals: [proposal] }));
    applyProposal.mockRejectedValueOnce(new Error('Réseau coupé.'));
    fireEvent.click(proposalButton(`Appliquer : ${label('A')}`));
    expect(await chat().findByRole('alert')).toHaveTextContent('Réseau coupé.');
    expect(onChanged).toHaveBeenCalledOnce();

    applyProposal.mockResolvedValueOnce();
    fireEvent.click(proposalButton(`Réessayer : ${label('A')}`));
    await waitFor(() => expect(chat().getByRole('status')).toHaveTextContent('✓ Appliqué'));
    const since = applyProposal.mock.calls[1][1]?.since;
    expect(since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(applyProposal.mock.calls[1][0]).toBe(proposal);
    expect(chat().queryByRole('alert')).not.toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  test('« Tout appliquer » reprend aussi les échecs, avec leur première date', async () => {
    render(<Host />);
    await answered(answer({ proposals: [createTask('A'), createTask('B')] }));
    applyProposal.mockRejectedValueOnce(new Error('Réseau coupé.')).mockRejectedValueOnce(new Error('Réseau coupé.'));
    fireEvent.click(chat().getByRole('button', { name: 'Tout appliquer (2)' }));
    await waitFor(() => expect(chat().getAllByRole('alert')).toHaveLength(2));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());

    applyProposal.mockResolvedValue();
    fireEvent.click(chat().getByRole('button', { name: 'Tout appliquer (2)' }));
    await waitFor(() => expect(chat().getAllByText('✓ Appliqué')).toHaveLength(2));
    expect(applyProposal.mock.calls.slice(2).map(([, retry]) => retry?.since)).toEqual([expect.any(String), expect.any(String)]);
    expect(chat().queryByRole('button', { name: /^Tout appliquer/ })).not.toBeInTheDocument();
  });

  test('refermer ne coupe pas une écriture en cours : son résultat attend la réouverture', async () => {
    const view = render(<Host />);
    await answered(answer({ proposals: [createTask('A')] }));
    let finish!: () => void;
    applyProposal.mockImplementationOnce(() => new Promise<void>((done) => { finish = done; }));
    fireEvent.click(proposalButton(`Appliquer : ${label('A')}`));
    view.rerender(<Host open={false} />);
    await act(async () => finish());
    expect(onChanged).toHaveBeenCalledOnce();
    view.rerender(<Host />);
    expect(chat().getByRole('status')).toHaveTextContent('✓ Appliqué');
  });
});
