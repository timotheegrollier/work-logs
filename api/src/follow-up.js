/** Contrat pur du suivi IA, commun à SQLite et au navigateur. */
const STATES = new Set(['unclear', 'todo', 'doing', 'blocked', 'done']);
const EPOCH = '1970-01-01T00:00:00.000Z';
const fail = (message = 'suivi IA invalide', status = 400, code) => {
  throw Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
};
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail();
  return value.trim();
};
const list = (value, max) => {
  if (!Array.isArray(value) || value.length > max) fail();
  return value.map((item) => text(item, 500));
};
const timestamp = (value) => {
  const clean = text(value, 80);
  if (!Number.isFinite(Date.parse(clean))) fail();
  return new Date(clean).toISOString();
};

export function validateFollowUpReport(value) {
  if (!object(value) || !STATES.has(value.status)) fail();
  return {
    status: value.status,
    summary: text(value.summary, 1500),
    completed: list(value.completed, 8),
    next_steps: list(value.next_steps, 8),
    blockers: list(value.blockers, 8),
    warnings: list(value.warnings, 12),
  };
}

/** Absence dans une ancienne sauvegarde = suivi non activé. */
export function readFollowUp(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { fail(); }
  }
  if (!object(value) || typeof value.enabled !== 'boolean') fail();
  let report = null;
  if (value.report !== null) {
    const draft = validateFollowUpReport(value.report);
    const generated = timestamp(value.report.generated_at);
    const key = text(value.report.source_key, 200);
    if (!/^[\w.-]+$/.test(key)) fail();
    report = { ...draft, generated_at: generated, source_key: key };
  }
  const enabledAt = value.enabled_at === undefined || value.enabled_at === null || value.enabled_at === ''
    ? report?.generated_at || EPOCH : timestamp(value.enabled_at);
  // Date du dernier « Désactiver » : absente tant qu'on n'a jamais retiré de bilan.
  const cleared = value.cleared_at ? { cleared_at: timestamp(value.cleared_at) } : {};
  return { enabled: value.enabled, enabled_at: enabledAt, report, ...cleared };
}

/**
 * Le choix de suivi et le bilan ont chacun leur horloge. Leur fusion ne doit
 * jamais rajeunir le texte d'une entrée ou les champs d'une tâche.
 */
export function mergeFollowUp(local, remote) {
  const left = readFollowUp(local);
  const right = readFollowUp(remote);
  if (!left || !right) return left || right;
  const leftConfigTime = Date.parse(left.enabled_at);
  const rightConfigTime = Date.parse(right.enabled_at);
  const config = leftConfigTime > rightConfigTime ? left : rightConfigTime > leftConfigTime ? right
    : !left.enabled ? left : right;
  const leftReport = left.report;
  const rightReport = right.report;
  let report = leftReport || rightReport;
  if (leftReport && rightReport) {
    const leftTime = Date.parse(leftReport.generated_at);
    const rightTime = Date.parse(rightReport.generated_at);
    // Les champs du rapport sont plats, leurs valeurs sont des chaînes ou listes.
    const canonical = (value) => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
    report = leftTime > rightTime ? leftReport : rightTime > leftTime ? rightReport
      : canonical(leftReport) >= canonical(rightReport) ? leftReport : rightReport;
  }
  // « Désactiver » efface tout bilan calculé avant lui, quelle que soit la copie : la fusion ne
  // le ressuscite pas. Le plus récent des deux, donc le même résultat dans les deux sens.
  const cleared = [left.cleared_at, right.cleared_at].filter(Boolean).sort().pop();
  if (cleared && report && Date.parse(report.generated_at) <= Date.parse(cleared)) report = null;
  return { enabled: config.enabled, enabled_at: config.enabled_at, report, ...(cleared ? { cleared_at: cleared } : {}) };
}

/** Ne laisse jamais une chaîne JSON SQL apparaître dans l'API ou un export. */
export function decodeFollowUpRow(row) {
  return row && Object.hasOwn(row, 'follow_up') ? { ...row, follow_up: readFollowUp(row.follow_up) } : row;
}

/**
 * Le contenu enregistré fait foi. Le rapport et updated_at ne sont jamais des
 * sources : écrire un bilan ne peut ni l'invalider ni déclencher une boucle.
 */
export function buildFollowUpSource(kind, entity, documents, project) {
  return {
    kind, id: entity.id, title: entity.title, project: project?.name ?? null,
    ...(kind === 'task' ? { status: entity.status, due_date: entity.due_date ?? null } : {}),
    documents: documents.map((entry) => ({
      id: entry.id, title: entry.title, kind: entry.kind || 'note', content_md: entry.content_md || '',
      content_json: typeof entry.content_json === 'string' ? JSON.parse(entry.content_json) : entry.content_json ?? null,
      entry_date: entry.entry_date, google: Boolean(entry.google),
    })).sort((a, b) => a.entry_date === b.entry_date ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.entry_date > b.entry_date ? -1 : 1),
  };
}

/** Deux empreintes FNV indépendantes, identiques dans Node et le navigateur. */
export function followUpKey(source) {
  const value = JSON.stringify(source);
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  return 'fu_' + (left >>> 0).toString(16).padStart(8, '0') + (right >>> 0).toString(16).padStart(8, '0');
}

/** Validation et garde d'obsolescence avant toute écriture. */
export function updateFollowUp(previous, body, sourceKey, generatedAt) {
  if (!object(body) || (body.enabled === undefined && body.report === undefined)) fail();
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') fail();
  const next = readFollowUp(previous) || { enabled: false, enabled_at: EPOCH, report: null };
  // « Désactiver » : le bilan part avec l'automatisme, jamais seul, et la date du retrait reste.
  if (body.report === null) {
    if (body.enabled !== false) fail();
    next.report = null;
    next.cleared_at = generatedAt;
  } else if (body.report !== undefined) {
    const report = validateFollowUpReport(body.report);
    if (body.source_key !== sourceKey) {
      fail('Le contenu a changé pendant le bilan. Actualise le suivi.', 409, 'FOLLOW_UP_STALE');
    }
    next.report = { ...report, generated_at: generatedAt, source_key: sourceKey };
  }
  if (body.enabled !== undefined) {
    next.enabled = body.enabled;
    next.enabled_at = generatedAt;
  }
  return next;
}
