import { describe, expect, test } from 'vitest';
import { dayLabel, formatSize, groupByDay, isOverdue, plainText, type Task } from './lib';

const task = (over: Partial<Task>): Task => ({
  id: 'tk_1',
  title: 'Tâche',
  status: 'todo',
  due_date: null,
  pinned: 0,
  position: 0,
  project_id: null,
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
