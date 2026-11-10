import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { discardPendingSaves, flushPendingSaves } from '../autosave';
import { api as clientApi } from '../lib';
import { seedData, useRealApi } from '../test/server';
import { AiContextDetails } from './AiContextDetails';
import { EntryEditor } from './EntryEditor';

const VOCABULARY_ONLY = 'Pour la mise en page, seul le vocabulaire de ces documents est envoyé, pas leur texte.';
// Chaque geste IA relit le contexte sur la vraie API : sous charge, plus d'une seconde.
const backend = { timeout: 5000 };
const prompts: string[] = [];
let server: Awaited<ReturnType<typeof useRealApi>>;

beforeEach(async () => {
  server = await useRealApi();
  localStorage.clear();
  localStorage.setItem('worklogs-ai-key', 'cle-test');
  prompts.length = 0;
  const diverted = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).includes('chat/completions')) return diverted(input, init);
    prompts.push(JSON.parse(init?.body as string).messages[1].content);
    return new Response(JSON.stringify({ choices: [{ message: { content: '[]' }, finish_reason: 'stop' }] }), { status: 200 });
  }));
});

afterEach(async () => {
  try {
    await flushPendingSaves();
  } finally {
    discardPendingSaves();
    vi.restoreAllMocks();
    await server.close();
  }
});

/** La note `en_note`, ouverte seule dans l'éditeur, à côté d'une procédure du même projet. */
async function openNote(content_md: string) {
  seedData(server.db, {
    projects: [{ id: 'pr_bassin', name: 'Bassin' }],
    entries: [
      { id: 'en_note', title: 'Pompe', content_md, project_id: 'pr_bassin' },
      { id: 'en_proc', title: 'Purger la pompe', content_md: 'Fermer la vanne.', project_id: 'pr_bassin', kind: 'procedure' },
    ],
  });
  const [entry, state] = await Promise.all([clientApi.entry('en_note'), clientApi.state()]);
  render(<EntryEditor entry={entry} projects={state.projects} onChanged={() => {}} onDeleted={() => {}} />);
}

async function runAi(name: string) {
  const trigger = await screen.findByRole('button', { name: 'Assistance IA' }, backend);
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
  const count = prompts.length;
  fireEvent.click(await screen.findByRole('menuitem', { name }));
  await waitFor(() => expect(prompts).toHaveLength(count + 1), backend);
}

test('la mise en page ne prétend pas envoyer les tâches voisines', () => {
  const panel = (vocabularyOnly: boolean) => <AiContextDetails context={{ relatedTasks: ['Changer le joint'] }} excludedIds={[]} vocabularyOnly={vocabularyOnly} onExcludedChange={() => {}} />;
  const { rerender } = render(panel(false));
  expect(screen.getByText(/Changer le joint/)).toBeInTheDocument();
  rerender(panel(true));
  expect(screen.queryByText(/Changer le joint/)).not.toBeInTheDocument();
});

test('après « Mettre en page », le panneau précise que seul le vocabulaire des documents part', async () => {
  await openNote('Le moteur chauffe.');
  await runAi('Mettre en page');
  expect(await screen.findByText(VOCABULARY_ONLY, {}, backend)).toBeInTheDocument();
  expect(prompts[0]).not.toContain('Fermer la vanne.');
  // Les autres gestes envoient bien le texte : la mention disparaît.
  await runAi('Suggérer des tâches avec l’IA');
  expect(prompts[1]).toContain('Fermer la vanne.');
  await waitFor(() => expect(screen.queryByText(VOCABULARY_ONLY)).not.toBeInTheDocument(), backend);
}, 30_000);

test('« Suggérer des tâches » n’annonce qu’une fois une case déjà cochée', async () => {
  await openNote('- [x] Vidanger le bassin\n- [ ] Rincer le filtre');
  await runAi('Suggérer des tâches avec l’IA');
  expect(prompts[0].split('\n').filter((line) => line === '- Vidanger le bassin')).toHaveLength(1);
}, 30_000);
