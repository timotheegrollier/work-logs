import { describe, expect, test } from 'vitest';
import { categoryDescendants, categoryOptions, categoryPath, groupByCategory } from './categories';
import type { Category, Project } from './lib';

const category = (id: string, name: string, parent_id: string | null = null): Category => ({
  id, name, parent_id, project_id: 'p', color: '#64748b', created_at: '', updated_at: '',
});
const rows = [category('child', 'Livraison', 'parent'), category('parent', 'Chantier'), category('other', 'Administration')];

describe('classement par catégorie', () => {
  test('ordonne les parents avant leurs enfants et expose le chemin complet', () => {
    expect(categoryOptions(rows, 'p').map(({ category, depth }) => [category.id, depth])).toEqual([['other', 0], ['parent', 0], ['child', 1]]);
    expect(categoryPath(rows, 'child')).toBe('Chantier / Livraison');
    expect(categoryOptions(rows, 'absent')).toEqual([]);
    expect([...categoryDescendants(rows, 'parent')]).toEqual(['parent', 'child']);
  });

  test('regroupe séparément les contenus sans catégorie de projets différents', () => {
    const items = [{ id: 'a', category_id: 'child', project_id: 'p' }, { id: 'b', project_id: 'p' }, { id: 'c', project_id: 'q' }];
    const projects = [{ id: 'p', name: 'Pro' }, { id: 'q', name: 'Perso' }] as Project[];
    expect(groupByCategory(items, rows, projects).map((group) => [group.label, group.items.map((item) => item.id)])).toEqual([
      ['Perso · Sans catégorie', ['c']], ['Pro · Chantier / Livraison', ['a']], ['Pro · Sans catégorie', ['b']],
    ]);
  });

  test('un cycle transitoire ne bloque pas le rendu des chemins', () => {
    const cycle = [category('a', 'A', 'b'), category('b', 'B', 'a')];
    expect(categoryPath(cycle, 'a')).toBe('B / A');
    expect(categoryDescendants(cycle, 'a').size).toBe(2);
  });
});
