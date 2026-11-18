// @ts-expect-error — contrat partagé avec SQLite, en JS.
import { entryMergeSourceKey } from '../../api/src/entry-merge.js';
import { api, type Entry, type EntryEditSnapshot } from './lib';
import { updateChecklistItems, type ChecklistChange } from './markdown';

function entryEditSnapshot(entry: Entry): EntryEditSnapshot {
  return {
    title: entry.title, entry_date: entry.entry_date, updated_at: entry.updated_at,
    project_id: entry.project_id ?? null, category_id: entry.category_id ?? null,
    archived: entry.archived, kind: entry.kind, status: entry.status ?? 'todo',
    google_document_id: entry.google_sync?.document_id ?? null,
    source_key: entryMergeSourceKey(entry),
  };
}

/** Un changement de case est une modification ciblée du texte relu. */
export async function applyChecklistChanges(entry: Entry, changes: readonly ChecklistChange[]): Promise<Entry> {
  if (entry.content_json || entry.google_sync) throw new Error('Cette liste doit être modifiée dans son éditeur.');
  const content_md = updateChecklistItems(entry.content_md, changes);
  if (content_md === entry.content_md) return entry;
  try {
    return await api.updateEntry(entry.id, { content_md, expected_entry: entryEditSnapshot(entry) });
  } catch (error) {
    // Une réponse perdue peut cacher une écriture réussie.
    const saved = await api.entry(entry.id).catch(() => null);
    if (saved && !saved.content_json && !saved.google_sync && saved.content_md === content_md) return saved;
    throw error;
  }
}
