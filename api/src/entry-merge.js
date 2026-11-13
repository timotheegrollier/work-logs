/** Contrat pur de fusion, partagé entre SQLite et le navigateur. */
const error = (message, status = 400, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
const stale = () => error('Une entrée a changé ou a déjà été remplacée. Relance la fusion.', 409, 'ENTRY_MERGE_STALE');
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])])) : value;
const decoded = (value) => typeof value === 'string' ? JSON.parse(value) : value ?? null;

/** Instantané local : ne doit jamais être envoyé au fournisseur IA. */
export function entryMergeSourceKey(entry) {
  return JSON.stringify(canonical([
    'entry-merge-v1', entry.id, entry.title, entry.entry_date, entry.project_id ?? null, entry.category_id ?? null,
    entry.archived ?? 0, entry.kind ?? 'note', entry.created_at, entry.updated_at,
    entry.content_md ?? '', decoded(entry.content_json),
    ...(entry.status && entry.status !== 'todo' ? [entry.status] : []),
    ...(entry.task ? [entry.task.id] : []),
  ]));
}

export function validateEntryMerge(body, what = 'entrées') {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || typeof body.request_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.request_id)
    || typeof body.title !== 'string' || !body.title.trim()
    || typeof body.content_md !== 'string' || !body.content_md.trim()
    || !Array.isArray(body.sources) || body.sources.length < 2 || body.sources.length > 8) {
    throw error(`Fusion invalide : titre, texte, identifiant de demande et deux à huit ${what} requis.`);
  }
  const ids = new Set();
  for (const source of body.sources) {
    if (!source || typeof source.id !== 'string' || !source.id || typeof source.source_key !== 'string' || !source.source_key || ids.has(source.id)) {
      throw error('Sources de fusion invalides ou répétées.');
    }
    ids.add(source.id);
  }
  return { request_id: body.request_id.toLowerCase(), title: body.title.trim(), content_md: body.content_md,
    sources: body.sources.map(({ id, source_key }) => ({ id, source_key })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
}

/** L'identifiant atteste le payload complet sans ajouter de schéma de provenance. */
export async function entryMergeTargetId(body) {
  const normalized = validateEntryMerge(body);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(normalized)));
  return 'en_merge_' + [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function assertEntryMergeSources(body, entries) {
  for (const source of body.sources) {
    const entry = entries.find((item) => item?.id === source.id);
    if (!entry) throw stale();
    if (entry.google_sync || entry.google_document_id || entry.google_tab_id) throw error('Les documents Google ne peuvent pas être fusionnés.');
    if (entryMergeSourceKey(entry) !== source.source_key) throw stale();
  }
}

export function assertEntryMergeReplay(body, entry) {
  if (entry.title !== body.title || entry.content_md !== body.content_md || entry.content_json) throw stale();
}

export function entryMergeClassification(entries) {
  const common = (key) => entries.every((entry) => (entry[key] ?? null) === (entries[0][key] ?? null)) ? entries[0][key] ?? null : null;
  const project_id = common('project_id');
  return { project_id, category_id: project_id ? common('category_id') : null, kind: common('kind') === 'procedure' ? 'procedure' : 'note' };
}

/** Une note locale peut contenir l’état d’une tâche. */
export const isRewritableNote = (entry) => !entry.google_sync && !entry.google_document_id && !entry.google_tab_id && (entry.kind ?? 'note') === 'note';

/** Couvre la tâche et tous ses documents : un lien ajouté ou retiré périme aussi la proposition. */
export function taskMergeSourceKey(task, documents) {
  return JSON.stringify(canonical([
    'task-merge-v1', task.id, task.title, task.status, task.due_date ?? null, task.pinned ? 1 : 0, task.priority ?? 'normal',
    task.project_id ?? null, task.category_id ?? null, task.created_at, task.updated_at, task.entry_id ?? null, task.progress ?? 0,
    documents.map(entryMergeSourceKey).sort(),
  ]));
}

export function assertTaskMergeSources(body, tasks, documentsOf) {
  for (const source of body.sources) {
    const task = tasks.find((item) => item?.id === source.id);
    if (!task || taskMergeSourceKey(task, documentsOf(task.id)) !== source.source_key) {
      throw error('Une tâche ou un de ses documents a changé ou a déjà été remplacé. Relance la fusion.', 409, 'ENTRY_MERGE_STALE');
    }
  }
}

/** La tâche fusionnée dérive de la même demande que sa note. */
export const taskMergeTaskId = (entryId) => entryId.replace('en_merge_', 'tk_merge_');

/** Seules les tâches ouvertes décident : une ancienne terminée ne met pas la nouvelle en retard. */
export function taskMergeAttributes(tasks) {
  const open = tasks.filter((task) => task.status !== 'done');
  const deciding = open.length ? open : tasks;
  const { project_id, category_id } = entryMergeClassification(tasks);
  const status = deciding.some((task) => task.status === 'doing') ? 'doing' : deciding[0].status;
  return {
    project_id, category_id, status,
    progress: status === 'done' ? 100 : status === 'doing' ? Math.max(...deciding.map((task) => task.progress ?? 0)) : 0,
    due_date: deciding.map((task) => task.due_date).filter(Boolean).sort()[0] ?? null,
    pinned: deciding.some((task) => task.pinned) ? 1 : 0,
    priority: ['high', 'normal', 'low'].find((level) => deciding.some((task) => task.priority === level)) ?? 'normal',
  };
}
