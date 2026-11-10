import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AiBudgetError, AiCancelled, AiError, generateFollowUp } from './ai-suggest';
import { nextAiReset, pacificDay, readAiUsage, saveDailyLimit } from './ai-budget';
import { Autosave, discardPendingSaves } from './autosave';
import { FollowUpPanel } from './components/FollowUpPanel';
import { FollowUpProvider, useFollowUp, useFollowUpBusy, useFollowUpHold } from './follow-up-controller';
import { api, ApiError, type AppState, type EntrySummary, type FollowUp, type FollowUpReportDraft } from './lib';

vi.mock('./ai-suggest', async (original) => ({
  ...await original<typeof import('./ai-suggest')>(),
  generateFollowUp: vi.fn(),
}));

const draft: FollowUpReportDraft = { status: 'doing', summary: 'Bilan.', completed: [], next_steps: [], blockers: [], warnings: [] };
const report = (source_key: string) => ({ ...draft, generated_at: '2026-11-01T10:00:00Z', source_key });
const followed = (value: FollowUp['report'] = null): FollowUp => ({ enabled: true, enabled_at: '2026-11-01T09:00:00Z', report: value });
const entry = (id: string, follow_up_key: string, follow_up = followed()): EntrySummary => ({
  id, title: id, entry_date: '2026-11-01', project_id: null, archived: 0, kind: 'note', updated_at: '2026-11-01T09:00:00Z',
  excerpt: '', attachments: 0, follow_up, follow_up_key,
});
const stateOf = (entries: EntrySummary[]): AppState => ({
  projects: [], entries, tasks: [], procedure_attachments: [],
  stats: { entries: entries.length, entriesThisWeek: 0, tasks: { todo: 0, doing: 0, done: 0 }, overdue: 0 },
});

function Item({ item }: { item: EntrySummary }) {
  const { refresh, stop, disable, error } = useFollowUp('entry', item);
  return <><button aria-label={`Actualiser ${item.id}`} onClick={refresh} /><button aria-label={`Arrêter ${item.id}`} onClick={stop} /><button aria-label={`Désactiver ${item.id}`} onClick={disable} />{error && <p role="alert">{error}</p>}</>;
}
function Screen({ entries }: { entries: EntrySummary[] }) {
  return <><output aria-label="suivis en cours">{String(useFollowUpBusy())}</output>{entries.map((item) => <Item key={item.id} item={item} />)}</>;
}

let current: AppState;
const onChanged = vi.fn();
const tree = () => <FollowUpProvider state={current} onChanged={onChanged}><Screen entries={current.entries} /></FollowUpProvider>;
const mount = (entries: EntrySummary[]) => {
  current = stateOf(entries);
  const view = render(tree());
  return (next: EntrySummary[]) => { current = stateOf(next); view.rerender(tree()); };
};
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const sent = () => vi.mocked(generateFollowUp).mock.calls.map(([settings, source]) => [source.id, settings.background]);
const busy = () => screen.getByLabelText('suivis en cours').textContent;
// En deux temps : React n'applique la reprise, donc ne réarme les délais, qu'à la fin d'un act ; un seul long act masquerait une boucle.
const afterResume = async () => { await advance(60_000); await advance(8_000); };
/** État de départ puis version modifiée pendant la session : la seule voie d'un travail automatique. */
const edited = async (entries: EntrySummary[]) => {
  const change = mount(entries.map((item) => ({ ...item, follow_up_key: `${item.follow_up_key}-avant` })));
  change(entries);
  await advance(8_000);
  return change;
};
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const spend = (background: number) => localStorage.setItem('worklogs-ai-usage', JSON.stringify({ day: pacificDay(), requests: background, tokens: 0, background }));
const refusal = () => new AiBudgetError('Actualisation automatique suspendue pour aujourd’hui.');
const stoppable: typeof generateFollowUp = (settings) => new Promise((_, reject) => {
  settings.signal!.addEventListener('abort', () => reject(new AiCancelled()));
});
/** Le vrai contrôle du plafond, seul le fournisseur est simulé. */
const realTransport = async () => {
  const { generateFollowUp: real } = await vi.importActual<typeof import('./ai-suggest')>('./ai-suggest');
  vi.mocked(generateFollowUp).mockImplementation(real);
  localStorage.setItem('worklogs-ai-key', 'cle-test');
  localStorage.setItem('worklogs-ai-endpoint', 'https://ia.example/v1');
  const transport = vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ status: 'doing', summary: 'Bilan.', completed: [], next_steps: [], blockers: [] }) } }] }),
  }) as Response);
  vi.stubGlobal('fetch', transport);
  return transport;
};

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  onChanged.mockReset();
  vi.mocked(generateFollowUp).mockReset().mockResolvedValue(draft);
  vi.spyOn(api, 'followUp').mockImplementation(async (_kind, id) => {
    const item = current.entries.find((candidate) => candidate.id === id)!;
    return { follow_up: item.follow_up ?? null, source_key: item.follow_up_key!, source: { kind: 'entry', id, title: item.title, project: null, documents: [] } };
  });
  vi.spyOn(api, 'saveFollowUp').mockImplementation(async (_kind, id) => ({ follow_up: followed(), source_key: id, source: { kind: 'entry', id, title: id, project: null, documents: [] } }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('un bilan déjà périmé au chargement ne part pas tout seul ; une modification de la session le fait', async () => {
  const stale = () => followed(report('ancienne'));
  const change = mount([entry('a', 'new', stale())]);
  await advance(9_000);
  expect(sent()).toEqual([]);
  change([entry('a', 'newer', stale())]);
  await advance(9_000);
  expect(sent()).toEqual([['a', true]]);
});

test('une version arrivée par la synchro attend un clic ; la modification suivante de la session repart', async () => {
  const stale = () => followed(report('ancienne'));
  current = stateOf([entry('a', 'v0', stale())]);
  const view = render(tree());
  current = { ...stateOf([entry('a', 'v1', stale())]), fromSync: true };
  view.rerender(tree());
  await advance(9_000);
  expect(sent()).toEqual([]);
  current = stateOf([entry('a', 'v2', stale())]);
  view.rerender(tree());
  await advance(9_000);
  expect(sent()).toEqual([['a', true]]);
});

test('deux actualisations automatiques du même élément restent espacées d’une minute', async () => {
  const stale = () => followed(report('ancienne'));
  const change = mount([entry('a', 'new', stale())]);
  change([entry('a', 'newer', stale())]);
  await advance(9_000);
  expect(sent()).toHaveLength(1);
  change([entry('a', 'newest', stale())]);
  await advance(9_000);
  expect(sent()).toHaveLength(1);
  await advance(60_000);
  expect(sent()).toHaveLength(2);
});

test.each([['Actualiser', 2], ['Arrêter', 1]] as const)('« %s » agit tout de suite sans rouvrir la minute entre deux actualisations automatiques', async (gesture, calls) => {
  if (gesture === 'Arrêter') vi.mocked(generateFollowUp).mockImplementationOnce(stoppable);
  const stale = () => followed(report('ancienne'));
  const change = mount([entry('a', 'v0', stale())]);
  change([entry('a', 'v1', stale())]);
  await advance(8_000);
  click(`${gesture} a`);
  await advance(1_000);
  expect(sent()).toHaveLength(calls);
  change([entry('a', 'v2', stale())]);
  await advance(9_000);
  expect(sent()).toHaveLength(calls);
  await advance(60_000);
  expect(sent()).toHaveLength(calls + 1);
  expect(sent().at(-1)).toEqual(['a', true]);
});

test('un « Actualiser » n’ouvre pas la période de calme : seule une actualisation automatique la déclenche', async () => {
  const stale = () => followed(report('ancienne'));
  const change = mount([entry('a', 'v1', stale())]);
  click('Actualiser a');
  await advance(0);
  change([entry('a', 'v2', stale())]);
  await advance(8_000);
  expect(sent()).toEqual([['a', false], ['a', true]]);
});

test('une actualisation attend huit secondes de silence, chaque changement d’état réarme le délai', async () => {
  const stale = () => followed(report('ancienne'));
  const change = mount([entry('a', 'v0', stale())]);
  change([entry('a', 'v1', stale())]);
  await advance(7_999);
  expect(sent()).toEqual([]);
  change([entry('a', 'v2', stale())]);
  await advance(7_999);
  expect(sent()).toEqual([]);
  await advance(1);
  expect(sent()).toEqual([['a', true]]);
});

test('un suivi sans bilan attend un geste ou une modification, jamais le simple chargement', async () => {
  mount([entry('a', 'v1')]);
  await advance(60 * 60_000);
  expect(sent()).toEqual([]);
  click('Actualiser a');
  await advance(0);
  expect(sent()).toEqual([['a', false]]);
});

test('une sauvegarde en attente retarde l’actualisation jusqu’à la pause d’écriture', async () => {
  let finish!: () => void;
  const saves = new Autosave<string>(() => new Promise<void>((resolve) => { finish = resolve; }));
  saves.update('frappe');
  try {
    await edited([entry('a', 'v1')]);
    expect(busy()).toBe('false');
    expect(sent()).toEqual([]);
    finish();
    await advance(8_000);
    expect(sent()).toEqual([['a', true]]);
  } finally {
    discardPendingSaves();
  }
});

test('au déclenchement, seuls les éléments modifiés partent ; un bilan à jour reste au repos', async () => {
  const items = (modified: string) => [entry('modifie', modified, followed(report('m0'))), entry('perime', 'p2', followed(report('p1'))), entry('frais', 'f1', followed(report('f1')))];
  const change = mount(items('m1'));
  change(items('m2'));
  await advance(8_000);
  expect(sent()).toEqual([['modifie', true]]);
  await advance(60 * 60_000);
  expect(sent()).toHaveLength(1);
});

test.each([
  ['déjà à jour', followed(report('v1'))],
  ['désactivée', { ...followed(report('v0')), enabled: false }],
])('relue juste avant l’appel, une source %s ailleurs ne paie rien', async (_, stored) => {
  vi.spyOn(api, 'followUp').mockImplementation(async (_kind, id) => ({ follow_up: stored, source_key: 'v1', source: { kind: 'entry', id, title: id, project: null, documents: [] } }));
  await edited([entry('a', 'v1', followed(report('v0')))]);
  expect(api.followUp).toHaveBeenCalledOnce();
  expect(sent()).toEqual([]);
  expect(api.saveFollowUp).not.toHaveBeenCalled();
});

test('une fenêtre masquée replanifie au lieu d’envoyer', async () => {
  let hidden = true;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  try {
    await edited([entry('a', 'v1'), entry('b', 'v2', followed(report('ancienne')))]);
    await advance(10 * 60_000);
    expect(sent()).toEqual([]);
    hidden = false;
    await advance(8_000);
    expect(sent()).toEqual([['a', true], ['b', true]]);
  } finally {
    delete (document as { hidden?: boolean }).hidden;
  }
});

test('un 409 sur une actualisation automatique attend la fin de la période de calme', async () => {
  vi.spyOn(api, 'saveFollowUp').mockRejectedValueOnce(new ApiError('Le contenu a changé pendant le bilan. Actualise le suivi.', 'FOLLOW_UP_STALE'));
  const change = mount([entry('a', 'v0')]);
  onChanged.mockImplementationOnce(() => change([entry('a', 'v2')]));
  change([entry('a', 'v1')]);
  await advance(8_000);
  expect(sent()).toEqual([['a', true]]);
  await advance(60_000 - 1);
  expect(sent()).toHaveLength(1);
  await advance(1);
  expect(sent()).toHaveLength(2);
});

test('un « Actualiser » cliqué juste après une frappe survit à l’état que son enregistrement recharge', async () => {
  let saved!: () => void;
  const saves = new Autosave<string>(() => new Promise<void>((resolve) => { saved = resolve; }));
  saves.update('frappe');
  try {
    const stale = () => followed(report('ancienne'));
    const change = mount([entry('a', 'v1', stale())]);
    click('Actualiser a');
    await advance(0);
    change([entry('a', 'v2', stale())]);
    await advance(0);
    saved();
    await advance(0);
    expect(sent()).toEqual([['a', false]]);
  } finally {
    discardPendingSaves();
  }
});

test('un échec isolé ne concerne que son élément : les suivants partent', async () => {
  vi.mocked(generateFollowUp).mockRejectedValueOnce(new AiError('Réponse IA illisible.'));
  await edited([entry('a', 'a1'), entry('b', 'b1'), entry('c', 'c1')]);
  expect(sent()).toEqual([['a', true], ['b', true], ['c', true]]);
  expect(screen.getByRole('alert')).toHaveTextContent('Réponse IA illisible.');
  expect(busy()).toBe('false');
});

test('une réussite remet à zéro les échecs consécutifs', async () => {
  vi.mocked(generateFollowUp).mockRejectedValueOnce(new AiError('Illisible.')).mockResolvedValueOnce(draft).mockRejectedValueOnce(new AiError('Coupée.'));
  await edited([entry('a', 'a1'), entry('b', 'b1'), entry('c', 'c1'), entry('d', 'd1')]);
  expect(sent()).toEqual([['a', true], ['b', true], ['c', true], ['d', true]]);
});

test('un échec sans suivant n’entame pas la file d’après', async () => {
  vi.mocked(generateFollowUp).mockRejectedValueOnce(new AiError('Illisible.')).mockRejectedValueOnce(new AiError('Illisible.'));
  const all = (a: string, b: string, c: string) => [entry('a', a), entry('b', b), entry('c', c)];
  const change = mount(all('a0', 'b0', 'c0'));
  change(all('a1', 'b0', 'c0'));
  await advance(8_000);
  change(all('a1', 'b1', 'c1'));
  await advance(8_000);
  expect(sent()).toEqual([['a', true], ['b', true], ['c', true]]);
});

test('le deuxième échec de suite vide la file automatique sans la rejouer', async () => {
  vi.mocked(generateFollowUp).mockRejectedValue(new AiError('Service indisponible.'));
  const change = await edited([entry('a', 'a1'), entry('b', 'b1'), entry('c', 'c1')]);
  expect(sent()).toEqual([['a', true], ['b', true]]);
  expect(busy()).toBe('false');
  await advance(60 * 60_000);
  expect(sent()).toHaveLength(2);
  // Seule une nouvelle version retente sa chance.
  change([entry('a', 'a1'), entry('b', 'b1'), entry('c', 'c2')]);
  await advance(8_000);
  expect(sent()).toEqual([['a', true], ['b', true], ['c', true]]);
});

test('un refus du plafond vide la file dès le premier élément, mais laisse partir un « Actualiser » déjà en file', async () => {
  let fail!: (error: Error) => void;
  vi.mocked(generateFollowUp).mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
  spend(50);
  await edited([entry('a', 'a1'), entry('b', 'b1'), entry('frais', 'f1', followed(report('f1')))]);
  fireEvent.click(screen.getByRole('button', { name: 'Actualiser frais' }));
  await act(async () => { fail(refusal()); await vi.advanceTimersByTimeAsync(0); });
  expect(sent()).toEqual([['a', true], ['frais', false]]);
  await advance(60 * 60_000);
  expect(sent()).toHaveLength(2);
});

test('l’échec d’un « Actualiser » juste après un échec automatique ne vide pas la file', async () => {
  let fail!: (error: Error) => void;
  vi.mocked(generateFollowUp)
    .mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }))
    .mockRejectedValueOnce(new AiError('Illisible.'));
  await edited([entry('a', 'a1'), entry('b', 'b1'), entry('c', 'c1'), entry('frais', 'f1', followed(report('f1')))]);
  click('Actualiser frais');
  await act(async () => { fail(new AiError('Illisible.')); await vi.advanceTimersByTimeAsync(0); });
  expect(sent()).toEqual([['a', true], ['frais', false], ['b', true], ['c', true]]);
});

test('Arrêter un travail automatique ne vide pas la file', async () => {
  vi.mocked(generateFollowUp).mockImplementationOnce((settings) => new Promise((_, reject) => {
    settings.signal!.addEventListener('abort', () => reject(new AiCancelled()));
  }));
  await edited([entry('a', 'a1'), entry('b', 'b1')]);
  expect(sent()).toEqual([['a', true]]);
  fireEvent.click(screen.getByRole('button', { name: 'Arrêter a' }));
  await advance(0);
  expect(sent()).toEqual([['a', true], ['b', true]]);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('un « Actualiser » passe devant les travaux automatiques, et l’état occupé dure jusqu’à la fin de la file', async () => {
  let release!: (value: FollowUpReportDraft) => void;
  vi.mocked(generateFollowUp).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  await edited([entry('a', 'a1'), entry('b', 'b1'), entry('frais', 'f1', followed(report('f1')))]);
  expect(sent()).toEqual([['a', true]]);
  expect(busy()).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Actualiser frais' }));
  await act(async () => { release(draft); await vi.advanceTimersByTimeAsync(0); });
  expect(sent()).toEqual([['a', true], ['frais', false], ['b', true]]);
  expect(busy()).toBe('false');
});

test('le travail automatique est compté à part jusqu’au transport, jamais un geste manuel', async () => {
  const { generateFollowUp: real } = await vi.importActual<typeof import('./ai-suggest')>('./ai-suggest');
  vi.mocked(generateFollowUp).mockImplementation(real);
  localStorage.setItem('worklogs-ai-key', 'cle-test');
  localStorage.setItem('worklogs-ai-endpoint', 'https://ia.example/v1');
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ status: 'doing', summary: 'Bilan.', completed: [], next_steps: [], blockers: [] }) } }] }),
  }) as Response));
  await edited([entry('a', 'a1')]);
  expect(readAiUsage()).toMatchObject({ requests: 1, background: 1 });
  fireEvent.click(screen.getByRole('button', { name: 'Actualiser a' }));
  await advance(0);
  expect(readAiUsage()).toMatchObject({ requests: 2, background: 1 });
});

test('un refus du tiers automatique reprend seul le lendemain, message effacé', async () => {
  const transport = await realTransport();
  spend(50);
  await edited([entry('a', 'a1'), entry('b', 'b1')]);
  expect(sent()).toEqual([['a', true]]);
  expect(transport).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('suspendue pour aujourd’hui');
  // Tant que le refus dure, les relevés ne retentent rien.
  await afterResume();
  await afterResume();
  expect(sent()).toHaveLength(1);
  vi.setSystemTime(nextAiReset());
  await advance(60_000);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  await advance(8_000);
  expect(transport).toHaveBeenCalledTimes(2);
  await advance(60 * 60_000);
  expect(transport).toHaveBeenCalledTimes(2);
});

test('un plafond relevé le même jour relance les éléments refusés, sans changement d’état', async () => {
  const transport = await realTransport();
  spend(150);
  await edited([entry('a', 'a1')]);
  expect(screen.getByRole('alert')).toHaveTextContent('Plafond quotidien');
  saveDailyLimit(1000);
  await afterResume();
  expect(transport).toHaveBeenCalledOnce();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('à la reprise, le tiers borne la rafale ; les suivants attendent le jour d’après, sans boucle', async () => {
  const transport = await realTransport();
  saveDailyLimit(10);
  spend(4);
  await edited(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => entry(id, `${id}1`)));
  expect(transport).not.toHaveBeenCalled();
  vi.setSystemTime(nextAiReset());
  await afterResume();
  expect(transport).toHaveBeenCalledTimes(4);
  expect(readAiUsage().background).toBe(4);
  // « e » est refusé, « f » écarté avec lui : les relevés suivants ne retentent rien.
  const attempts = sent().length;
  await afterResume();
  await afterResume();
  expect(sent()).toHaveLength(attempts);
  expect(transport).toHaveBeenCalledTimes(4);
  vi.setSystemTime(nextAiReset());
  await afterResume();
  expect(transport).toHaveBeenCalledTimes(6);
});

test('la reprise ne relance pas un élément arrêté, seulement celui que le plafond a refusé', async () => {
  vi.mocked(generateFollowUp).mockImplementationOnce(stoppable).mockRejectedValueOnce(refusal());
  await edited([entry('a', 'a1'), entry('b', 'b1')]);
  click('Arrêter a');
  await advance(0);
  expect(sent()).toEqual([['a', true], ['b', true]]);
  await afterResume();
  expect(sent()).toEqual([['a', true], ['b', true], ['b', true]]);
  await advance(60 * 60_000);
  expect(sent()).toHaveLength(3);
});

test('un élément refusé puis arrêté pendant son « Actualiser » n’est plus relancé', async () => {
  vi.mocked(generateFollowUp).mockRejectedValueOnce(refusal()).mockImplementationOnce(stoppable);
  const change = await edited([entry('a', 'a1')]);
  click('Actualiser a');
  await advance(0);
  click('Arrêter a');
  // Mot tapé puis retiré : même contenu, donc même empreinte, de retour parmi les versions modifiées.
  change([entry('a', 'a2')]);
  change([entry('a', 'a1')]);
  await afterResume();
  await afterResume();
  expect(sent()).toEqual([['a', true], ['a', false]]);
});

test('une reprise ne coupe pas un « Actualiser » en cours sur un élément refusé', async () => {
  let release!: (value: FollowUpReportDraft) => void;
  vi.mocked(generateFollowUp).mockRejectedValueOnce(refusal()).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  await edited([entry('a', 'a1')]);
  click('Actualiser a');
  await advance(2 * 60_000);
  expect(busy()).toBe('true');
  await act(async () => { release(draft); await vi.advanceTimersByTimeAsync(0); });
  expect(sent()).toEqual([['a', true], ['a', false]]);
});

test('après une reprise, un échec isolé laisse toujours partir le suivant', async () => {
  vi.mocked(generateFollowUp).mockRejectedValueOnce(refusal()).mockRejectedValueOnce(new AiError('Illisible.'));
  await edited([entry('a', 'a1'), entry('b', 'b1'), entry('c', 'c1')]);
  expect(sent()).toEqual([['a', true]]);
  await afterResume();
  // « a » a ouvert sa période de calme : « b » et « c » partent ensemble avant lui, l'échec de « b » n'écarte pas « c ».
  expect(sent()).toEqual([['a', true], ['b', true], ['c', true], ['a', true]]);
});

test('un « Actualiser » refusé par le plafond ne repart pas seul le lendemain', async () => {
  const transport = await realTransport();
  spend(150);
  mount([entry('a', 'a2', followed(report('a1')))]);
  click('Actualiser a');
  await advance(0);
  vi.setSystemTime(nextAiReset());
  await afterResume();
  await advance(6 * 60_000);
  expect(transport).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('Plafond quotidien');
});

test('au démontage, le relevé du plafond s’arrête', () => {
  current = stateOf([entry('a', 'a1')]);
  const view = render(tree());
  const cleared = vi.spyOn(globalThis, 'clearInterval');
  view.unmount();
  expect(cleared).toHaveBeenCalledOnce();
});

test('un bilan raté ne se repaie qu’une fois par minute, pas à chaque pause de frappe', async () => {
  vi.mocked(generateFollowUp).mockRejectedValue(new AiError('Réponse IA illisible.'));
  const change = await edited([entry('a', 'v0')]);
  expect(sent()).toHaveLength(1);
  for (let version = 1; version <= 3; version += 1) {
    change([entry('a', `v${version}`)]);
    await advance(8_000);
  }
  expect(sent()).toHaveLength(1);
  await advance(60_000);
  expect(sent()).toHaveLength(2);
  await advance(60 * 60_000);
  expect(sent()).toHaveLength(2);
});

function Held({ active }: { active: boolean }) {
  useFollowUpHold(active);
  return null;
}

test('une synthèse affichée retient l’actualisation d’un bilan existant, jamais le premier bilan', async () => {
  const held = (active: boolean) => <FollowUpProvider state={current} onChanged={onChanged}><Held active={active} /><Screen entries={current.entries} /></FollowUpProvider>;
  current = stateOf([entry('premier', 'p0'), entry('perime', 'b1', followed(report('b0')))]);
  const view = render(held(true));
  current = stateOf([entry('premier', 'p1'), entry('perime', 'b2', followed(report('b0')))]);
  view.rerender(held(true));
  await advance(8_000);
  expect(sent()).toEqual([['premier', true]]);
  await advance(30 * 60_000);
  expect(sent()).toHaveLength(1);
  // Même état : seul le relevé réarmé pendant la retenue peut repartir.
  view.rerender(held(false));
  await advance(8_000);
  expect(sent()).toEqual([['premier', true], ['perime', true]]);
});

test('une file annonce « En attente… » derrière le seul travail actif', async () => {
  vi.mocked(generateFollowUp).mockImplementation(() => new Promise(() => {}));
  const panels = (suffix: string) => {
    current = stateOf(['a', 'b', 'c'].map((id) => entry(id, id + suffix)));
    return <FollowUpProvider state={current} onChanged={onChanged}>{current.entries.map((item) => <FollowUpPanel key={item.id} kind="entry" item={item} />)}</FollowUpProvider>;
  };
  const view = render(panels('0'));
  view.rerender(panels('1'));
  await advance(8_000);
  expect(sent()).toHaveLength(1);
  expect(screen.getAllByText('Actualisation en cours…')).toHaveLength(1);
  expect(screen.getAllByText('En attente…')).toHaveLength(2);
});

test('un aller-retour de filtre ne rouvre pas la période de calme', async () => {
  const stale = () => followed(report('ancienne'));
  const change = await edited([entry('a', 'a1', stale())]);
  expect(sent()).toHaveLength(1);
  change([]);
  change([entry('a', 'a1', stale())]);
  change([entry('a', 'a2', stale())]);
  await advance(50_000);
  expect(sent()).toHaveLength(1);
  await advance(10_000);
  expect(sent()).toHaveLength(2);
});

test('un refus du plafond masqué par un filtre reprend au retour du budget', async () => {
  const transport = await realTransport();
  spend(50);
  const change = await edited([entry('a', 'a1')]);
  expect(transport).not.toHaveBeenCalled();
  change([]);
  change([entry('a', 'a1')]);
  vi.setSystemTime(nextAiReset());
  await afterResume();
  expect(transport).toHaveBeenCalledOnce();
});

test('un filtre qui masque un élément ne perd pas un bilan demandé par un geste', async () => {
  const all = [entry('a', 'a1'), entry('supprimé', 's1'), entry('b', 'b1'), entry('c', 'c1')];
  // Le serveur connaît toujours les éléments masqués ; seul l’élément supprimé répond 404.
  vi.mocked(api.followUp).mockImplementation(async (_kind, id) => {
    if (id === 'supprimé') throw new ApiError('entrée introuvable', 'NOT_FOUND');
    return { follow_up: followed(), source_key: `${id}1`, source: { kind: 'entry', id, title: id, project: null, documents: [] } };
  });
  const answers: (() => void)[] = [];
  vi.mocked(generateFollowUp).mockImplementation((settings) => new Promise((resolve, reject) => {
    settings.signal!.addEventListener('abort', () => reject(new AiCancelled()));
    answers.push(() => resolve(draft));
  }));
  const change = mount(all);
  for (const { id } of all) click(`Actualiser ${id}`);
  await advance(0);
  // « a » en vol et « c » en file sont masqués, « b » reste affiché.
  change([all[2]]);
  await advance(0);
  for (let turn = 0; turn < 3; turn++) { answers[turn]?.(); await advance(0); }
  expect(sent()).toEqual([['a', false], ['b', false], ['c', false]]);
  expect(vi.mocked(api.saveFollowUp).mock.calls.map(([, id]) => id)).toEqual(['a', 'b', 'c']);
  expect(busy()).toBe('false');
});

test('un filtre qui masque un élément coupe son actualisation automatique en vol', async () => {
  vi.mocked(generateFollowUp).mockImplementationOnce(stoppable);
  const change = await edited([entry('a', 'a1')]);
  expect(sent()).toEqual([['a', true]]);
  change([]);
  await advance(0);
  expect(busy()).toBe('false');
});
