import { validateDocument } from './rich-document.js';

/** Format de sauvegarde : 100 % pur (aucun accès disque/réseau),
 *  partageable avec le front/PWA qui valide avant d'écrire en local. */
export const BACKUP_VERSION = 2;
export const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
/** Version des fichiers « boîte mobile » (créations PWA à fusionner, lot 4). */
export const OUTBOX_VERSION = 1;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = new Set(['todo', 'doing', 'done']);
const PRIORITIES = new Set(['low', 'normal', 'high']);

const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), { status });
};
const record = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} invalide.`);
  return value;
};
const requiredText = (value, label, max = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${label} invalide.`);
  return value;
};
const id = (value, label) => {
  const result = requiredText(value, label);
  if (!/^[\w.-]{1,200}$/.test(result)) fail(`${label} invalide.`);
  return result;
};
const optionalId = (value, label) => {
  if (value === null || value === undefined || value === '') return null;
  return id(value, label);
};
const timestamp = (value, label) => requiredText(value, label, 80);
const unique = (values, label) => {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) fail(`${label} dupliqué.`);
    seen.add(value);
  }
  return seen;
};

function contentValue(value, label) {
  if (value === null || value === undefined || value === '') return null;
  let content = value;
  if (typeof content === 'string') {
    try { content = JSON.parse(content); } catch { fail(`${label} invalide.`); }
  }
  try { return validateDocument(content); }
  catch { fail(`${label} invalide.`); }
}
/** Valide entièrement une sauvegarde avant toute écriture en base. */
export function validateBackup(input) {
  const data = record(input, 'Sauvegarde');
  if (data.version !== BACKUP_VERSION) fail(`Version de sauvegarde non prise en charge (attendu : ${BACKUP_VERSION}).`);
  for (const name of ['projects', 'entries', 'tasks', 'task_entries', 'attachments']) {
    if (!Array.isArray(data[name]) || data[name].length > 100_000) fail(`Liste ${name} invalide.`);
  }
  if (data.google_documents !== undefined && (!Array.isArray(data.google_documents) || data.google_documents.length > 100_000)) {
    fail('Liste google_documents invalide.');
  }

  const projects = data.projects.map((project) => {
    record(project, 'Projet');
    return {
      id: id(project.id, 'Identifiant de projet'),
      name: requiredText(project.name, 'Nom de projet', 500),
      color: requiredText(project.color, 'Couleur de projet', 100),
      created_at: timestamp(project.created_at, 'Date de création du projet'),
    };
  });
  const projectIds = unique(projects.map((project) => project.id), 'Identifiant de projet');

  const entries = data.entries.map((entry) => {
    record(entry, 'Entrée');
    const projectId = optionalId(entry.project_id, 'Projet de l’entrée');
    if (projectId && !projectIds.has(projectId)) fail('Une entrée référence un projet absent.');
    const date = requiredText(entry.entry_date, 'Date d’entrée', 10);
    if (!DATE_RE.test(date)) fail('Date d’entrée invalide.');
    // Les exports antérieurs n'ont pas d'archivage : ils reviennent visibles.
    if (entry.archived !== undefined && ![0, 1].includes(Number(entry.archived))) fail('Archivage d’entrée invalide.');
    return {
      id: id(entry.id, 'Identifiant d’entrée'),
      title: requiredText(entry.title, 'Titre d’entrée', 500),
      content_md: typeof entry.content_md === 'string' ? entry.content_md : fail('Contenu Markdown invalide.'),
      content_json: contentValue(entry.content_json, 'Document riche'),
      entry_date: date,
      project_id: projectId,
      archived: entry.archived === undefined ? 0 : Number(entry.archived),
      created_at: timestamp(entry.created_at, 'Date de création de l’entrée'),
      updated_at: timestamp(entry.updated_at, 'Date de modification de l’entrée'),
    };
  });
  const entryIds = unique(entries.map((entry) => entry.id), 'Identifiant d’entrée');

  const tasks = data.tasks.map((task) => {
    record(task, 'Tâche');
    const projectId = optionalId(task.project_id, 'Projet de la tâche');
    if (projectId && !projectIds.has(projectId)) fail('Une tâche référence un projet absent.');
    const dueDate = task.due_date === null || task.due_date === undefined || task.due_date === '' ? null : requiredText(task.due_date, 'Échéance', 10);
    if (dueDate && !DATE_RE.test(dueDate)) fail('Échéance invalide.');
    if (typeof task.status !== 'string' || !STATUSES.has(task.status)) fail('Statut de tâche invalide.');
    if (!Number.isInteger(task.position) || task.position < 0) fail('Position de tâche invalide.');
    if (![0, 1].includes(Number(task.pinned))) fail('Épinglage de tâche invalide.');
    // Les exports antérieurs n'ont pas de priorité : ils reviennent en « normale ».
    const priority = task.priority === undefined || task.priority === null || task.priority === '' ? 'normal' : task.priority;
    if (!PRIORITIES.has(priority)) fail('Priorité de tâche invalide.');
    return {
      id: id(task.id, 'Identifiant de tâche'),
      title: requiredText(task.title, 'Titre de tâche', 500),
      status: task.status,
      due_date: dueDate,
      pinned: Number(task.pinned),
      position: task.position,
      priority,
      project_id: projectId,
      created_at: timestamp(task.created_at, 'Date de création de la tâche'),
      updated_at: timestamp(task.updated_at, 'Date de modification de la tâche'),
    };
  });
  const taskIds = unique(tasks.map((task) => task.id), 'Identifiant de tâche');

  const taskEntries = data.task_entries.map((link) => {
    record(link, 'Association tâche-document');
    const taskId = id(link.task_id, 'Tâche associée');
    const entryId = id(link.entry_id, 'Document associé');
    if (!taskIds.has(taskId) || !entryIds.has(entryId)) fail('Une association tâche-document est orpheline.');
    return { task_id: taskId, entry_id: entryId, created_at: timestamp(link.created_at, 'Date de création de l’association') };
  });
  unique(taskEntries.map((link) => `${link.task_id}\u0000${link.entry_id}`), 'Association tâche-document');

  const googleDocuments = (data.google_documents || []).map((document) => {
    record(document, 'Association Google');
    const entryId = id(document.entry_id, 'Entrée Google');
    if (!entryIds.has(entryId)) fail('Une association Google est orpheline.');
    requiredText(document.document_id, 'Document Google', 200);
    const tabId = typeof document.tab_id === 'string' ? document.tab_id : '';
    if (tabId.length > 200) fail('Onglet Google invalide.');
    const synced = requiredText(document.synced_content_json, 'Instantané Google', MAX_BACKUP_BYTES);
    contentValue(synced, 'Instantané Google');
    return {
      entry_id: entryId,
      document_id: id(document.document_id, 'Document Google'),
      tab_id: tabId,
      revision_id: typeof document.revision_id === 'string' ? document.revision_id : '',
      synced_content_json: synced,
      synced_at: document.synced_at === null || document.synced_at === undefined ? null : timestamp(document.synced_at, 'Date de synchronisation Google'),
      document_title: typeof document.document_title === 'string' ? document.document_title : '',
      tab_title: typeof document.tab_title === 'string' ? document.tab_title : '',
      tab_order: Number.isInteger(document.tab_order) && document.tab_order >= 0 ? document.tab_order : 0,
      tab_depth: Number.isInteger(document.tab_depth) && document.tab_depth >= 0 ? document.tab_depth : 0,
      readonly_reason: typeof document.readonly_reason === 'string' ? document.readonly_reason : '',
    };
  });
  unique(googleDocuments.map((document) => document.entry_id), 'Association Google');
  unique(googleDocuments.map((document) => `${document.document_id}\u0000${document.tab_id}`), 'Onglet Google');

  const attachments = data.attachments.map((attachment) => {
    record(attachment, 'Pièce jointe');
    const entryId = id(attachment.entry_id, 'Entrée de la pièce jointe');
    if (!entryIds.has(entryId)) fail('Une pièce jointe est orpheline.');
    const stored = requiredText(attachment.stored, 'Fichier joint', 500);
    if (!/^[\w.-]+$/.test(stored)) fail('Fichier joint invalide.');
    if (!Number.isInteger(attachment.size) || attachment.size < 0) fail('Taille de pièce jointe invalide.');
    // Adossement Drive (2026-09-19) : optionnel, ancien exports sans ce champ
    // restent valides ; un identifiant Drive invalide est refusé en français.
    const driveRaw = attachment.driveFileId ?? attachment.drive_file_id ?? null;
    const driveFileId = driveRaw === null || driveRaw === undefined || driveRaw === ''
      ? null
      : requiredText(driveRaw, 'Fichier Drive', 200);
    if (driveFileId && !/^[\w-]{1,200}$/.test(driveFileId)) fail('Fichier Drive invalide.');
    return {
      id: id(attachment.id, 'Identifiant de pièce jointe'),
      filename: requiredText(attachment.filename, 'Nom de pièce jointe', 1000),
      stored,
      mime: typeof attachment.mime === 'string' ? attachment.mime : '',
      size: attachment.size,
      entry_id: entryId,
      created_at: timestamp(attachment.created_at, 'Date de création de la pièce jointe'),
      driveFileId,
    };
  });
  unique(attachments.map((attachment) => attachment.id), 'Identifiant de pièce jointe');

  return { version: BACKUP_VERSION, projects, entries, tasks, task_entries: taskEntries, google_documents: googleDocuments, attachments };
}

/**
 * Valide une « boîte mobile » (créations PWA à fusionner, jamais d'écrasement).
 * Les éléments reprennent exactement les formes d'une sauvegarde : la
 * validation est déléguée à `validateBackup`, seuls l'enveloppe et les
 * références Drive (`driveFileId`) sont vérifiés ici. Tout nouveau champ
 * d'élément s'ajoute donc d'un seul côté.
 */
export function validateOutbox(input) {
  const data = record(input, 'Boîte mobile');
  if (data.version !== OUTBOX_VERSION) fail(`Version de boîte mobile non prise en charge (attendu : ${OUTBOX_VERSION}).`);
  if (typeof data.device !== 'string' || !data.device.trim() || data.device.length > 100) fail('Appareil d’origine invalide.');
  const base = data.base_exported_at === null || data.base_exported_at === undefined || data.base_exported_at === ''
    ? null
    : timestamp(data.base_exported_at, 'Sauvegarde d’origine');
  if (Array.isArray(data.attachments)) {
    for (const attachment of data.attachments) {
      record(attachment, 'Pièce jointe');
      const drive = attachment.driveFileId;
      const clean = drive === null || drive === undefined || drive === '' ? null : requiredText(drive, 'Fichier Drive', 200);
      if (clean && !/^[\w-]{1,200}$/.test(clean)) fail('Fichier Drive invalide.');
    }
  }
  const backup = validateBackup({
    version: BACKUP_VERSION,
    projects: data.projects,
    entries: data.entries,
    tasks: data.tasks,
    task_entries: data.task_entries,
    attachments: data.attachments,
    google_documents: [],
  });
  const driveIds = new Map(
    (Array.isArray(data.attachments) ? data.attachments : []).map((attachment) => [attachment.id, attachment.driveFileId || null])
  );
  return {
    version: OUTBOX_VERSION,
    exported_at: timestamp(data.exported_at, 'Date d’envoi'),
    base_exported_at: base,
    device: data.device.trim(),
    projects: backup.projects,
    entries: backup.entries,
    tasks: backup.tasks,
    task_entries: backup.task_entries,
    google_documents: [],
    attachments: backup.attachments.map((attachment) => ({ ...attachment, driveFileId: driveIds.get(attachment.id) || null })),
  };
}

