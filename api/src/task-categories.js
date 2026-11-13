/** Remplissage unique de l'existant ; les choix ultérieurs restent intacts. */
export const TASK_CATEGORY_MIGRATION = 'worklogs-task-document-categories-v1';

/** Une tâche libre reprend un classement non ambigu de ses documents du même projet. */
export function inheritedTaskCategory(task, documents) {
  if (task.category_id) return task.category_id;
  const categories = new Set(documents
    .filter((document) => document.project_id === task.project_id && document.category_id)
    .map((document) => document.category_id));
  return categories.size === 1 ? categories.values().next().value : null;
}

/** Appelé dans la transaction de la mutation ou de la migration. */
export function inheritTaskCategories(db, time, { taskId = null, entryId = null, excludeTaskId = null } = {}) {
  const filters = ['t.category_id IS NULL', 'e.category_id IS NOT NULL', 'e.project_id=t.project_id'];
  const args = [];
  if (taskId) { filters.push('t.id=?'); args.push(taskId); }
  if (excludeTaskId) { filters.push('t.id!=?'); args.push(excludeTaskId); }
  if (entryId) {
    filters.push('t.id IN (SELECT task_id FROM task_entries WHERE entry_id=?)');
    args.push(entryId);
  }
  const candidates = db.prepare(`SELECT t.id,t.entry_id,MIN(e.category_id) category_id
    FROM tasks t JOIN task_entries te ON te.task_id=t.id JOIN entries e ON e.id=te.entry_id
    WHERE ${filters.join(' AND ')}
    GROUP BY t.id HAVING COUNT(DISTINCT e.category_id)=1`).all(...args);
  const update = db.prepare('UPDATE tasks SET category_id=?,updated_at=CASE WHEN entry_id IS NULL THEN ? ELSE updated_at END WHERE id=? AND category_id IS NULL');
  const updateNote = db.prepare('UPDATE entries SET category_id=?,updated_at=? WHERE id=?');
  for (const task of candidates) {
    update.run(task.category_id, time, task.id);
    if (task.entry_id) updateNote.run(task.category_id, time, task.entry_id);
  }
}
