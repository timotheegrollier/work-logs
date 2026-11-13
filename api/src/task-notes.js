import { taskIdForNote } from './task-state.js';

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const compareId = (a, b) => byText(a.id, b.id);
const substantive = (entry) => Boolean(entry.content_json || entry.content_md?.trim());

export const legacyTaskNoteId = (taskId) => taskIdForNote(taskId).replace(/^tk_note_/, 'en_task_');
export const storedTaskProgress = ({ status, progress }) => {
  if (status === 'done') return 100;
  return status === 'doing' && Number.isInteger(progress) && progress > 0 && progress < 100 ? progress : 0;
};

/**
 * Rattache chaque tâche à une note unique. Une ancienne association peut devenir
 * la note principale si elle correspond à la tâche. Les autres restent des références.
 * Le texte, les dates et les pièces jointes des notes existantes restent intacts.
 */
export function normalizeTaskNotes(snapshot) {
  const { entries, tasks, task_entries: links, google_documents: google = [] } = snapshot;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const references = new Map();
  const googleIds = new Set(google.map((row) => row.entry_id));
  for (const link of links) {
    const group = references.get(link.task_id) ?? new Map();
    group.set(link.entry_id, link);
    references.set(link.task_id, group);
  }
  const localNote = (entry) => entry && (entry.kind ?? 'note') === 'note' && !googleIds.has(entry.id);
  const ordered = [...tasks].sort(compareId);
  const owners = new Map();
  const claimed = new Set();
  for (const task of ordered) {
    if (!localNote(byId.get(task.entry_id)) || claimed.has(task.entry_id)) continue;
    owners.set(task.id, task.entry_id);
    claimed.add(task.entry_id);
  }
  const normalized = new Map();
  const newLinks = [];
  for (const task of ordered) {
    const group = references.get(task.id) ?? new Map();
    let primary = byId.get(owners.get(task.id));
    if (!primary) {
      const candidates = [...group.values()]
        .map((link) => ({ link, note: byId.get(link.entry_id) }))
        .filter(({ note }) => localNote(note));
      const matching = candidates
        .filter(({ note }) => !claimed.has(note.id) && note.title === task.title && note.project_id === task.project_id
          && (!note.category_id || !task.category_id || note.category_id === task.category_id))
        .sort((a, b) => Number(substantive(b.note)) - Number(substantive(a.note))
          || byText(a.link.created_at, b.link.created_at) || compareId(a.note, b.note));
      primary = matching[0]?.note;
      if (primary && !primary.category_id && task.category_id) primary = { ...primary, category_id: task.category_id };
      if (!primary) {
        const seed = legacyTaskNoteId(task.id);
        let id = seed;
        for (let suffix = 2; byId.has(id); suffix++) {
          const tail = `_${suffix}`;
          id = seed.slice(0, 200 - tail.length) + tail;
        }
        const date = [task.created_at, task.updated_at].find((value) => /^\d{4}-\d{2}-\d{2}/.test(value))?.slice(0, 10) ?? '1970-01-01';
        const contextual = candidates.filter(({ note }) => substantive(note));
        primary = {
          id, title: task.title,
          content_md: contextual.length === 1 ? `Note de référence : ${contextual[0].note.title.replace(/\s+/g, ' ')}` : '',
          content_json: null, entry_date: date, project_id: task.project_id ?? null,
          category_id: task.category_id ?? null, archived: 0, kind: 'note', status: task.status,
          follow_up: null, created_at: task.created_at, updated_at: task.updated_at,
        };
      }
      claimed.add(primary.id);
    }
    if (primary.status !== task.status) primary = { ...primary, status: task.status };
    byId.set(primary.id, primary);
    const progress = storedTaskProgress(task);
    const categoryId = primary.category_id ?? null;
    const projectId = primary.project_id ?? null;
    normalized.set(task.id, task.entry_id === primary.id && task.progress === progress && task.title === primary.title
      && task.project_id === projectId && (task.category_id ?? null) === categoryId
      ? task : { ...task, entry_id: primary.id, progress, title: primary.title, project_id: projectId, category_id: categoryId });
    if (!group.has(primary.id)) newLinks.push({ task_id: task.id, entry_id: primary.id, created_at: task.created_at });
  }
  return {
    ...snapshot, entries: [...byId.values()], tasks: tasks.map((task) => normalized.get(task.id)),
    task_entries: newLinks.length ? [...links, ...newLinks] : links,
  };
}
