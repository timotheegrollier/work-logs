import type { Category } from '../lib';
import { categoryOptions, categoryPath } from '../categories';

export function CategoryBadge({ categories, categoryId }: { categories: Category[]; categoryId?: string | null }) {
  const category = categories.find((row) => row.id === categoryId);
  if (!category) return null;
  return <span className="category-badge" title={categoryPath(categories, categoryId)}>
    <span className="dot" style={{ background: category.color }} aria-hidden="true" />
    {categoryPath(categories, categoryId)}
  </span>;
}

export function CategoryPicker({ categories, projectId, value, onChange, label = 'Catégorie', disabled = false }: {
  categories: Category[]; projectId: string | null; value: string | null;
  onChange: (value: string) => void; label?: string; disabled?: boolean;
}) {
  return <select aria-label={label} value={value || ''} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
    <option value="">Sans catégorie</option>
    {categoryOptions(categories, projectId || '').map(({ category, label: path }) => <option key={category.id} value={category.id}>{path}</option>)}
  </select>;
}
