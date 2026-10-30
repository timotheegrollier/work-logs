import { describe, expect, test } from 'vitest';
import { dayLabel, formatSize, groupByDay, groupTabs, isOverdue, overviewOrder, plainText, projectProgress, subtasksMd, type EntrySummary, type Project, type Task } from './lib';

const task = (over: Partial<Task>): Task => ({
  id: 'tk_1',
  title: 'Tâche',
  status: 'todo',
  due_date: null,
  pinned: 0,
  position: 0,
  priority: 'normal',
  project_id: null,
  documents: [],
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  ...over,
});

describe('dayLabel', () => {
  const now = new Date('2026-09-11T10:00:00.000Z');

  test('nomme les deux derniers jours en toutes lettres', () => {
    expect(dayLabel('2026-09-11', now)).toBe("aujourd'hui");
    expect(dayLabel('2026-09-10', now)).toBe('hier');
  });

  test('donne le jour et le mois pour l’année en cours', () => {
    expect(dayLabel('2026-09-08', now)).toMatch(/sept/);
    expect(dayLabel('2026-09-08', now)).not.toMatch(/2026/);
  });

  test('ajoute l’année quand elle diffère', () => {
    expect(dayLabel('2025-12-24', now)).toMatch(/2025/);
  });

  test('ne décale pas la date selon le fuseau horaire', () => {
    expect(dayLabel('2026-01-01', now)).toMatch(/1.*janv/);
  });
});

describe('isOverdue', () => {
  const today = '2026-09-11';

  test('signale une échéance dépassée', () => {
    expect(isOverdue(task({ due_date: '2026-09-10' }), today)).toBe(true);
  });

  test('ne signale ni le jour même ni le futur', () => {
    expect(isOverdue(task({ due_date: today }), today)).toBe(false);
    expect(isOverdue(task({ due_date: '2026-09-12' }), today)).toBe(false);
  });

  test('ignore les tâches terminées et celles sans échéance', () => {
    expect(isOverdue(task({ due_date: '2026-01-01', status: 'done' }), today)).toBe(false);
    expect(isOverdue(task({ due_date: null }), today)).toBe(false);
  });
});

describe('plainText', () => {
  test('retire le balisage pour l’aperçu d’une ligne', () => {
    expect(plainText('## Titre\n\n- **gras** et `code`')).toBe('Titre gras et code');
  });

  test('garde le texte des liens, jette l’URL', () => {
    expect(plainText('voir [la doc](https://exemple.fr/page)')).toBe('voir la doc');
  });

  test('retire images, blocs de code et cases à cocher', () => {
    expect(plainText('![photo](a.png)texte')).toBe('texte');
    expect(plainText('```js\nconst a = 1;\n```\napres')).toBe('apres');
    expect(plainText('- [ ] à faire')).toBe('à faire');
  });

  test('accepte une chaîne vide', () => {
    expect(plainText('')).toBe('');
  });
});

describe('formatSize', () => {
  test('choisit l’unité lisible', () => {
    expect(formatSize(512)).toBe('512 o');
    expect(formatSize(2048)).toBe('2 Ko');
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 Mo');
  });
});

describe('groupByDay', () => {
  test('regroupe en conservant l’ordre reçu', () => {
    const grouped = groupByDay([
      { entry_date: '2026-09-11', id: 'a' },
      { entry_date: '2026-09-11', id: 'b' },
      { entry_date: '2026-09-09', id: 'c' },
    ]);
    expect(grouped.map(([date, items]) => [date, items.map((i) => i.id)])).toEqual([
      ['2026-09-11', ['a', 'b']],
      ['2026-09-09', ['c']],
    ]);
  });

  test('renvoie une liste vide sans entrée', () => {
    expect(groupByDay([])).toEqual([]);
  });
});



describe('groupTabs', () => {
  const entry = (over: Partial<EntrySummary>): EntrySummary => ({
    id: 'en_1', title: 'Titre', entry_date: '2026-09-14', project_id: null, archived: 0, kind: 'note',
    updated_at: '2026-09-14T10:00:00.000Z', excerpt: '', attachments: 0, ...over,
  });

  test('laisse les entrées ordinaires telles quelles', () => {
    const items = groupTabs([entry({ id: 'a', title: 'Note' }), entry({ id: 'b', title: 'Autre' })]);
    expect(items.map((i) => [i.title, i.tabs.length])).toEqual([['Note', 0], ['Autre', 0]]);
  });

  test('réunit les onglets d’un même document sous une seule ligne', () => {
    // Sans ce regroupement, chaque onglet Google apparaissait comme un document
    // distinct : le journal se remplissait d'un même fichier répété.
    const items = groupTabs([
      entry({ id: 'a', google_document_id: 'doc1', google_tab_id: 't.0', google_document_title: 'Chantier', google_tab_title: 'Devis', google_tab_order: 0 }),
      entry({ id: 'c', title: 'Note libre' }),
      entry({ id: 'b', google_document_id: 'doc1', google_tab_id: 't.1', google_document_title: 'Chantier', google_tab_title: 'Suivi', google_tab_order: 1 }),
    ]);

    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('Chantier');
    expect(items[0].tabs.map((t) => t.google_tab_title)).toEqual(['Devis', 'Suivi']);
    expect(items[1].title).toBe('Note libre');
  });

  test('ouvre le document sur son premier onglet, quel que soit l’ordre reçu', () => {
    const items = groupTabs([
      entry({ id: 'second', google_document_id: 'd', google_tab_order: 2, google_document_title: 'D' }),
      entry({ id: 'premier', google_document_id: 'd', google_tab_order: 0, google_document_title: 'D' }),
    ]);
    expect(items[0].entry.id).toBe('premier');
  });

  test('sépare deux documents Google différents', () => {
    const items = groupTabs([
      entry({ id: 'a', google_document_id: 'doc1', google_document_title: 'Un' }),
      entry({ id: 'b', google_document_id: 'doc2', google_document_title: 'Deux' }),
    ]);
    expect(items.map((i) => i.title)).toEqual(['Un', 'Deux']);
  });
});

describe('subtasksMd', () => {
  test('chaque ligne non vide devient une case à cocher sous un titre', () => {
    expect(subtasksMd('Relire\nAppeler le client\n')).toBe('## Sous-tâches\n- [ ] Relire\n- [ ] Appeler le client\n');
  });

  test('les lignes vides sautent et un tiret seul devient une case', () => {
    expect(subtasksMd('\n- Commander\n\n* Payer ')).toBe('## Sous-tâches\n- [ ] Commander\n- [ ] Payer\n');
  });

  test('un - [x] collé garde son statut coché', () => {
    expect(subtasksMd('- [x] Payé\n- [ ] Relancer')).toBe('## Sous-tâches\n- [x] Payé\n- [ ] Relancer\n');
  });

  test('une liste numérotée collée depuis l’IA devient des cases', () => {
    expect(subtasksMd('1. Relire\n2) Payer')).toBe('## Sous-tâches\n- [ ] Relire\n- [ ] Payer\n');
  });

  test('sans sous-tâche, pas de contenu prérempli', () => {
    expect(subtasksMd('  \n ')).toBe('');
  });
});

describe('projectProgress', () => {
  const task = (id: string, extra: Partial<Task>): Task =>
    ({ id, title: id, status: 'todo', due_date: null, pinned: 0, position: 0, priority: 'normal', project_id: 'p', created_at: '2026-10-01', updated_at: '2026-10-01', documents: [], ...extra });
  const project = (id: string): Project => ({ id, name: id, color: '#000', created_at: '2026-01-01', entries: 0, open_tasks: 0 });

  test('une voie par projet dans l’ordre du bandeau, puis les sans-projet s’il y en a ; les ouvertes rangées, les terminées comptées', () => {
    const tasks = [
      task('todo2', { position: 2 }),
      task('todo1', { position: 1, due_date: '2026-10-29' }),
      task('doing', { status: 'doing', due_date: '2026-10-30' }),
      task('doneB', { status: 'done', updated_at: '2026-10-20' }),
      task('doneA', { status: 'done', updated_at: '2026-10-10' }),
      task('free', { project_id: null, due_date: '2026-01-01' }),
    ];
    const entries = [
      { project_id: 'p', entry_date: '2026-10-12', kind: 'note' as const },
      { project_id: 'p', entry_date: '2026-10-28', kind: 'procedure' as const },
      { project_id: 'p', entry_date: '2026-10-25', kind: 'note' as const },
    ];
    const lanes = projectProgress([project('p'), project('q')], tasks, entries, '2026-10-30');
    expect(lanes.map((lane) => lane.project?.id ?? null)).toEqual(['p', 'q', null]);
    expect(lanes[0].open.map((item) => item.id)).toEqual(['doing', 'todo1', 'todo2']);
    expect(lanes[0]).toMatchObject({ done: 2, doing: 1, todo: 2, late: 1, lastEntry: '2026-10-25' });
    expect(lanes[1]).toMatchObject({ open: [], done: 0, doing: 0, todo: 0, late: 0, lastEntry: null });
    expect(lanes[2]).toMatchObject({ project: null, done: 0, todo: 1, late: 1 });
  });

  test('sans tâche libre, pas de voie « sans projet »', () => {
    expect(projectProgress([project('p')], [task('a', {})], [])).toHaveLength(1);
  });
});

describe('overviewOrder', () => {
  const task = (id: string, extra: Partial<Task>): Task =>
    ({ id, title: id, status: 'todo', due_date: null, pinned: 0, position: 0, priority: 'normal', project_id: 'p', created_at: '2026-10-01', updated_at: '2026-10-01', documents: [], ...extra });

  test('en cours, en retard, épinglées, priorité, échéance proche, puis l’ordre des colonnes', () => {
    const tasks = [
      task('late-normal', { position: 5, due_date: '2026-10-01' }),
      task('high-no-due', { position: 4, priority: 'high' }),
      task('pinned-low', { position: 3, priority: 'low', pinned: 1 }),
      task('doing-low', { position: 9, status: 'doing', priority: 'low' }),
      task('high-due', { position: 6, priority: 'high', due_date: '2026-11-02' }),
      task('normal-first', { position: 1 }),
      task('normal-second', { position: 2 }),
    ];
    expect(overviewOrder(tasks, undefined, '2026-10-30').map((item) => item.id)).toEqual(['doing-low', 'late-normal', 'pinned-low', 'high-due', 'high-no-due', 'normal-first', 'normal-second']);
    expect(tasks[0].id).toBe('late-normal');
  });

  test('une proposition IA ouverte remplace la priorité et son rang départage avant l’échéance', () => {
    const tasks = [task('a', { position: 1, due_date: '2026-10-01' }), task('b', { position: 2, priority: 'high' }), task('c', { position: 3 })];
    const proposal = new Map([
      ['a', { priority: 'low' as const, rank: 0 }],
      ['b', { priority: 'normal' as const, rank: 2 }],
      ['c', { priority: 'normal' as const, rank: 1 }],
    ]);
    expect(overviewOrder(tasks, proposal, '2026-09-01').map((item) => item.id)).toEqual(['c', 'b', 'a']);
  });

  test('une réponse IA partielle garde un ordre cohérent quel que soit l’ordre initial', () => {
    const a = task('a', { due_date: '2026-12-01' });
    const b = task('b', { due_date: '2026-11-01' });
    const c = task('c', { due_date: '2026-10-01' });
    const proposal = new Map([
      ['a', { priority: 'normal' as const, rank: 0 }],
      ['c', { priority: 'normal' as const, rank: 1 }],
    ]);
    for (const tasks of [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]]) {
      expect(overviewOrder(tasks, proposal, '2026-09-01').map((item) => item.id)).toEqual(['a', 'c', 'b']);
    }
  });
});
