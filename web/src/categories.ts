import type { Category, Project } from './lib';

export const UNCATEGORIZED = '__none__';

/** Chemin lisible et borné même pendant la réconciliation d'une synchro. */
export function categoryPath(categories: Category[], id?: string | null): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  let current = categories.find((category) => category.id === id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    parts.unshift(current.name);
    current = categories.find((category) => category.id === current!.parent_id);
  }
  return parts.join(' / ');
}

export function categoryOptions(categories: Category[], projectId: string) {
  const rows = categories.filter((category) => category.project_id === projectId);
  const output: { category: Category; depth: number; label: string }[] = [];
  const seen = new Set<string>();
  const visit = (parent: string | null, depth: number) => {
    for (const category of rows.filter((row) => row.parent_id === parent).sort((a, b) => a.name.localeCompare(b.name, 'fr'))) {
      if (seen.has(category.id)) continue;
      seen.add(category.id);
      output.push({ category, depth, label: categoryPath(rows, category.id) });
      visit(category.id, depth + 1);
    }
  };
  visit(null, 0);
  return output;
}

export function categoryDescendants(categories: Category[], id: string): Set<string> {
  const ids = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const category of categories) {
      if (category.parent_id && ids.has(category.parent_id) && !ids.has(category.id)) {
        ids.add(category.id);
        changed = true;
      }
    }
  }
  return ids;
}

export function groupByCategory<T extends { category_id?: string | null; project_id: string | null }>(items: T[], categories: Category[], projects: Project[]) {
  const groups = new Map<string, { id: string; label: string; items: T[] }>();
  for (const item of items) {
    const id = item.category_id || `${UNCATEGORIZED}:${item.project_id || ''}`;
    let group = groups.get(id);
    if (!group) {
      const project = projects.find((row) => row.id === item.project_id)?.name;
      const path = categoryPath(categories, item.category_id) || 'Sans catégorie';
      group = { id, label: project ? `${project} · ${path}` : path, items: [] };
      groups.set(id, group);
    }
    group.items.push(item);
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, 'fr'));
}
