/** Comparaison pure partagée entre SQLite et la PWA pour les dates proposées par l'IA. */
const nullableKeys = new Set(['due_date', 'project_id', 'category_id']);
const keys = new Set(['status', 'priority', 'due_date', 'title', 'project_id', 'category_id', 'pinned', 'follow_up_key', 'active_document_ids']);
const invalid = () => { throw Object.assign(new Error('état attendu de planification invalide'), { status: 400 }); };
const stale = () => { throw Object.assign(new Error('La tâche a changé depuis la proposition. Relance la replanification.'), { status: 409, code: 'TASK_PLANNING_STALE' }); };

export function assertExpectedTaskPlanning(value, current) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.has(key))
    || !Object.hasOwn(value, 'status') || !['todo', 'doing', 'done'].includes(value.status)
    || !Object.hasOwn(value, 'priority') || !['low', 'normal', 'high'].includes(value.priority)
    || !Object.hasOwn(value, 'due_date')
    || [...nullableKeys].some((key) => Object.hasOwn(value, key) && value[key] !== null && typeof value[key] !== 'string')
    || (Object.hasOwn(value, 'title') && (typeof value.title !== 'string' || !value.title.trim()))
    || (Object.hasOwn(value, 'pinned') && value.pinned !== 0 && value.pinned !== 1)
    || (Object.hasOwn(value, 'active_document_ids') && (!Array.isArray(value.active_document_ids)
      || value.active_document_ids.some((id) => typeof id !== 'string' || !id)
      || new Set(value.active_document_ids).size !== value.active_document_ids.length))
    || (Object.hasOwn(value, 'follow_up_key') && value.follow_up_key !== null && (typeof value.follow_up_key !== 'string' || !value.follow_up_key))) invalid();
  for (const [key, raw] of Object.entries(value)) {
    if (key === 'active_document_ids') {
      const actual = current.documents.filter((document) => !document.archived).map((document) => document.id).sort();
      if (JSON.stringify([...raw].sort()) !== JSON.stringify(actual)) stale();
    } else {
      const expected = nullableKeys.has(key) && raw === '' ? null : raw;
      if (expected !== (current[key] ?? null)) stale();
    }
  }
}
