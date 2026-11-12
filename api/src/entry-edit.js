import { entryMergeSourceKey } from './entry-merge.js';

const keys = new Set(['title', 'entry_date', 'project_id', 'category_id', 'archived', 'kind', 'status', 'updated_at', 'google_document_id', 'source_key']);
const nullableText = (value) => value === null || typeof value === 'string';
const invalid = () => { throw Object.assign(new Error('état attendu de l’entrée invalide'), { status: 400 }); };

/** La précondition compare les métadonnées lues, et le corps entier s'il est modifié. */
export function assertExpectedEntryEdit(value, current, editsContent) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.has(key))
    || typeof value.title !== 'string' || typeof value.entry_date !== 'string' || typeof value.updated_at !== 'string'
    || !nullableText(value.project_id) || !nullableText(value.category_id) || !nullableText(value.google_document_id)
    || ![0, 1].includes(value.archived) || !['note', 'procedure'].includes(value.kind)
    || !['todo', 'doing', 'done'].includes(value.status)
    || ((editsContent || Object.hasOwn(value, 'source_key')) && (typeof value.source_key !== 'string' || !value.source_key))) invalid();

  const actual = {
    title: current.title, entry_date: current.entry_date, updated_at: current.updated_at,
    project_id: current.project_id ?? null, category_id: current.category_id ?? null,
    archived: current.archived ?? 0, kind: current.kind ?? 'note', status: current.status ?? 'todo',
    google_document_id: current.google_sync?.document_id ?? null,
  };
  if (Object.entries(actual).some(([key, field]) => value[key] !== field)
    || (value.source_key !== undefined && value.source_key !== entryMergeSourceKey(current))) {
    throw Object.assign(new Error('L’entrée a changé depuis la proposition. Redemande à l’assistant.'), { status: 409, code: 'ENTRY_EDIT_STALE' });
  }
}
