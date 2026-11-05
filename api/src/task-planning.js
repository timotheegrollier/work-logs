/** Comparaison pure partagée entre SQLite et la PWA pour les dates proposées par l'IA. */
const keys = new Set(['status', 'priority', 'due_date', 'title', 'project_id', 'pinned', 'follow_up_key']);
const invalid = () => { throw Object.assign(new Error('état attendu de planification invalide'), { status: 400 }); };

export function assertExpectedTaskPlanning(value, current) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.has(key))
    || !Object.hasOwn(value, 'status') || !['todo', 'doing', 'done'].includes(value.status)
    || !Object.hasOwn(value, 'priority') || !['low', 'normal', 'high'].includes(value.priority)
    || !Object.hasOwn(value, 'due_date') || (value.due_date !== null && typeof value.due_date !== 'string')
    || (Object.hasOwn(value, 'title') && (typeof value.title !== 'string' || !value.title.trim()))
    || (Object.hasOwn(value, 'project_id') && value.project_id !== null && typeof value.project_id !== 'string')
    || (Object.hasOwn(value, 'pinned') && value.pinned !== 0 && value.pinned !== 1)
    || (Object.hasOwn(value, 'follow_up_key') && value.follow_up_key !== null && (typeof value.follow_up_key !== 'string' || !value.follow_up_key))) invalid();
  for (const [key, raw] of Object.entries(value)) {
    const expected = (key === 'due_date' || key === 'project_id') && raw === '' ? null : raw;
    const actual = key === 'follow_up_key' ? current[key] ?? null : current[key];
    if (expected !== actual) throw Object.assign(new Error('La tâche a changé depuis la proposition. Relance la replanification.'), { status: 409, code: 'TASK_PLANNING_STALE' });
  }
}
