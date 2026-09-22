// Fusion par élément de deux instantanés WorkLogs (desktop ⇄ Drive ⇄ PWA).
// JavaScript pur, sans dépendance : partagé avec la PWA comme backup-format.js.
//
// Règles (docs/05-DECISIONS.md §20) :
// - entrées, tâches, projets : la version au `updated_at` le plus récent gagne ;
// - une suppression (pierre tombale) gagne sur toute version antérieure, mais
//   une modification postérieure à la suppression ressuscite l'élément ;
// - le contenu d'amorçage jamais modifié ne gagne jamais sur une version modifiée
//   (le téléphone installé après le PC ne doit pas écraser le mode d'emploi édité) ;
// - liens tâche ⇄ document et pièces jointes : union, moins les suppressions ;
// - deux copies locales du même onglet Google (ouvert sur les deux appareils) :
//   la plus récente est gardée, l'autre supprimée proprement.

export const TOMBSTONE_KINDS = ['project', 'entry', 'task', 'link', 'attachment'];
export const TOMBSTONE_TTL_MS = 60 * 24 * 3600 * 1000;
export const SEED_IDS = new Set(['pr_perso', 'pr_pro', 'en_welcome', 'tk_1', 'tk_2', 'tk_3']);
const MAX_TOMBSTONES = 100_000;

export const linkKey = (link) => `${link.task_id}|${link.entry_id}`;
const tombKey = (kind, id) => `${kind}:${id}`;
const stamp = (row) => row.updated_at || row.created_at || '';
const pristine = (row) => SEED_IDS.has(row.id) && (!row.updated_at || row.updated_at === row.created_at);

/** Pierres tombales venues d'un fichier distant : on ne garde que le bien formé. */
export function validateTombstones(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.length > MAX_TOMBSTONES) throw new Error('Suppressions synchronisées invalides.');
  return input.filter((item) => item && TOMBSTONE_KINDS.includes(item.kind) && typeof item.id === 'string'
    && item.id.length > 0 && item.id.length <= 500 && typeof item.deleted_at === 'string' && !Number.isNaN(Date.parse(item.deleted_at)))
    .map(({ kind, id, deleted_at }) => ({ kind, id, deleted_at }));
}

function mergeTombstones(local, remote, now) {
  const map = new Map();
  for (const item of [...local, ...remote]) {
    if (now - Date.parse(item.deleted_at) > TOMBSTONE_TTL_MS) continue;
    const key = tombKey(item.kind, item.id);
    const current = map.get(key);
    if (!current || item.deleted_at > current.deleted_at) map.set(key, item);
  }
  return map;
}

/** Choisit une version par identifiant, puis applique les suppressions. */
function mergeRows(kind, localRows, remoteRows, tombs, keyOf = (row) => row.id) {
  const byKey = new Map();
  for (const row of remoteRows) byKey.set(keyOf(row), row);
  for (const row of localRows) {
    const key = keyOf(row);
    const other = byKey.get(key);
    if (!other) { byKey.set(key, row); continue; }
    // Amorçage intact contre version modifiée : la modifiée gagne, quelle que soit l'heure.
    if (pristine(row) !== pristine(other)) { if (pristine(other)) byKey.set(key, row); continue; }
    if (stamp(row) >= stamp(other)) byKey.set(key, row); // égalité : le local, stable
  }
  const kept = [];
  for (const [key, row] of byKey) {
    const tomb = tombs.get(tombKey(kind, key));
    if (tomb && (pristine(row) || tomb.deleted_at >= stamp(row))) continue;
    if (tomb) tombs.delete(tombKey(kind, key)); // modifié après la suppression : ressuscité
    kept.push(row);
  }
  return kept;
}

/** Représentation canonique pour comparer deux instantanés sans faux positifs d'ordre. */
export function canonical(snapshot) {
  const sortBy = (rows, keyOf) => [...rows].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
  const clean = (row) => JSON.stringify(Object.keys(row).sort().reduce((out, key) => {
    if (row[key] !== undefined) out[key] = row[key];
    return out;
  }, {}));
  return JSON.stringify({
    projects: sortBy(snapshot.projects, (r) => r.id).map(clean),
    entries: sortBy(snapshot.entries, (r) => r.id).map(clean),
    tasks: sortBy(snapshot.tasks, (r) => r.id).map(clean),
    task_entries: sortBy(snapshot.task_entries, linkKey).map(clean),
    google_documents: sortBy(snapshot.google_documents || [], (r) => r.entry_id).map(clean),
    attachments: sortBy(snapshot.attachments, (r) => r.id).map(clean),
    deleted: sortBy(snapshot.deleted || [], (r) => tombKey(r.kind, r.id)).map(clean),
  });
}

/**
 * Fusionne `local` et `remote` (déjà validés, avec leurs `deleted`). `remote`
 * peut être `null` (aucun fichier encore sur Drive). Renvoie l'instantané fusionné
 * et ce qui doit être réécrit de chaque côté.
 */
export function mergeSnapshots(local, remote, now = Date.now()) {
  const empty = { projects: [], entries: [], tasks: [], task_entries: [], google_documents: [], attachments: [], deleted: [] };
  const other = remote || empty;
  const tombs = mergeTombstones(local.deleted || [], other.deleted || [], now);

  const projects = mergeRows('project', local.projects, other.projects, tombs);
  const projectIds = new Set(projects.map((row) => row.id));
  const detach = (row) => (row.project_id && !projectIds.has(row.project_id) ? { ...row, project_id: null } : row);
  let entries = mergeRows('entry', local.entries, other.entries, tombs).map(detach);
  const tasks = mergeRows('task', local.tasks, other.tasks, tombs).map(detach);

  // Un même onglet Google ouvert sur deux appareils = deux copies locales : on garde la plus récente.
  const entryById = new Map(entries.map((row) => [row.id, row]));
  const docs = new Map();
  for (const row of [...(other.google_documents || []), ...(local.google_documents || [])]) {
    if (!entryById.has(row.entry_id)) continue;
    docs.set(row.entry_id, row); // le local remplace le distant pour la même entrée
  }
  const byTab = new Map();
  const dropped = new Set();
  for (const row of docs.values()) {
    const key = `${row.document_id}|${row.tab_id || ''}`;
    const seen = byTab.get(key);
    if (!seen) { byTab.set(key, row); continue; }
    const keep = stamp(entryById.get(row.entry_id)) > stamp(entryById.get(seen.entry_id)) ? row : seen;
    const lose = keep === row ? seen : row;
    byTab.set(key, keep);
    dropped.add(lose.entry_id);
  }
  const deletedAt = new Date(now).toISOString();
  for (const id of dropped) tombs.set(tombKey('entry', id), { kind: 'entry', id, deleted_at: deletedAt });
  entries = entries.filter((row) => !dropped.has(row.id));
  const entryIds = new Set(entries.map((row) => row.id));
  const taskIds = new Set(tasks.map((row) => row.id));
  const google_documents = [...byTab.values()].filter((row) => entryIds.has(row.entry_id));

  const task_entries = mergeRows('link', local.task_entries, other.task_entries, tombs, linkKey)
    .filter((row) => taskIds.has(row.task_id) && entryIds.has(row.entry_id));

  // Pièces jointes : même fichier des deux côtés, on garde l'identifiant Drive connu.
  const remoteAttachments = new Map(other.attachments.map((row) => [row.id, row]));
  const attachments = mergeRows('attachment', local.attachments, other.attachments, tombs)
    .filter((row) => entryIds.has(row.entry_id))
    .map((row) => (row.driveFileId ? row : { ...row, driveFileId: remoteAttachments.get(row.id)?.driveFileId || local.attachments.find((a) => a.id === row.id)?.driveFileId || null }));

  const merged = {
    projects, entries, tasks, task_entries, google_documents, attachments,
    deleted: [...tombs.values()],
  };
  const text = canonical(merged);
  return {
    merged,
    changedLocal: text !== canonical({ ...empty, ...local }),
    changedRemote: !remote || text !== canonical({ ...empty, ...remote }),
  };
}
