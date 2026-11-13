/** Règles d'avancement communes à SQLite et à la PWA. */
const statuses = new Set(['todo', 'doing', 'done']);
const invalid = (message) => { throw Object.assign(new Error(message), { status: 400 }); };

export function taskState(status, progress, current = { status: 'todo', progress: 0 }) {
  if (status !== undefined && !statuses.has(status)) invalid('statut invalide');
  if (progress !== undefined) {
    if (!Number.isInteger(progress) || progress < 0 || progress > 100) {
      invalid('avancement invalide (un entier de 0 à 100 est attendu)');
    }
    const next = status ?? (progress === 100 ? 'done' : progress === 0 ? 'todo' : 'doing');
    if ((next === 'done' && progress !== 100) || (next !== 'done' && progress === 100) || (next === 'todo' && progress !== 0)) {
      invalid('le statut et l’avancement sont incompatibles');
    }
    return { status: next, progress };
  }
  const next = status ?? current.status;
  return { status: next, progress: next === 'done' ? 100 : next === 'doing' && current.status === 'doing' ? current.progress ?? 0 : 0 };
}

/** Le suivi activé sur deux appareils pour la même note garde un seul identifiant. */
export function taskIdForNote(entryId) {
  const prefix = 'tk_note_';
  if (prefix.length + entryId.length <= 200) return prefix + entryId;
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (const character of entryId) {
    left = Math.imul(left ^ character.charCodeAt(0), 0x01000193);
    right = Math.imul(right ^ character.charCodeAt(0), 0x85ebca6b);
  }
  return prefix + entryId.slice(0, 175) + '_' + (left >>> 0).toString(16).padStart(8, '0') + (right >>> 0).toString(16).padStart(8, '0');
}

/** Une réactivation locale doit être plus récente que le retrait à synchroniser. */
export function taskCreationStamp(time, deletedAt) {
  return deletedAt === time ? new Date(Date.parse(time) + 1).toISOString() : time;
}
