import { beforeEach, describe, expect, test } from 'vitest';
import { ApiError, type Entry, type EntryEditSnapshot } from '../lib';
import {
  applySyncSnapshot,
  clearLocalOutbox,
  exportLocalOutbox,
  fetchMissingDriveAttachments,
  importLocalBackup,
  listPendingUploads,
  localApi,
  localSyncSnapshot,
  markAttachmentUploaded,
  outboxSize,
  readLocalOutbox,
  setLocalDatabase,
} from './localApi';
import { createMemoryDatabase } from './storage';
// @ts-expect-error — même clé de source que l'API.
import { entryMergeSourceKey, taskMergeSourceKey } from '../../../api/src/entry-merge.js';

beforeEach(() => {
  setLocalDatabase(createMemoryDatabase());
});

async function projectId(name = 'Chantier'): Promise<string> {
  return (await localApi.createProject({ name })).id;
}

const expectedEntry = (entry: Entry): EntryEditSnapshot => ({
  title: entry.title, entry_date: entry.entry_date, project_id: entry.project_id, category_id: entry.category_id ?? null,
  archived: entry.archived, kind: entry.kind, status: entry.status ?? 'todo', updated_at: entry.updated_at,
  google_document_id: entry.google_sync?.document_id ?? null,
});

describe('amorçage et état', () => {
  test('même amorçage que le serveur : 2 projets, le mode d’emploi, 3 tâches', async () => {
    const state = await localApi.state();
    expect(state.projects.map((p) => p.name).sort()).toEqual(['Perso', 'Pro']);
    expect(state.entries.map((e) => e.title)).toContain('Comment ça marche');
    expect(state.tasks.map((t) => t.title)).toContain('Écrire ma première entrée');
    expect(state.stats.entries).toBe(4);
    expect(state.stats.tasks).toEqual({ todo: 2, doing: 1, done: 0 });
  });

  test('recherche insensible à la casse, filtre projet et extrait à 240 caractères', async () => {
    const id = await projectId();
    await localApi.createEntry({ title: 'Toiture TER', entry_date: '2026-09-10', project_id: id, content_md: 'Devis x'.repeat(100) });
    expect((await localApi.state('toiture')).entries.map((e) => e.title)).toEqual(['Toiture TER']);
    expect((await localApi.state('', id)).entries).toHaveLength(1);
    expect((await localApi.state('absent')).entries).toHaveLength(0);
    const found = (await localApi.state('toiture')).entries[0];
    expect(found.excerpt.length).toBe(240);
    expect(found.attachments).toBe(0);
    expect(found.google_dirty).toBe(false);
  });

  test('recherche sans accents ni capitales, comme le serveur, et à jour après une modification', async () => {
    const note = await localApi.createEntry({ title: 'Procédure ÉLECTRICITÉ', content_md: 'Vétérinaire' });
    await localApi.createTask({ title: 'Relire la procédure' });
    const found = async (q: string) => (await localApi.state(q)).entries.map((e) => e.title);
    expect((await found('procedure')).sort()).toEqual(['Procédure ÉLECTRICITÉ', 'Relire la procédure'].sort());
    expect(await found('electricite')).toEqual(['Procédure ÉLECTRICITÉ']);
    expect(await found('VETERINAIRE')).toEqual(['Procédure ÉLECTRICITÉ']);
    expect((await localApi.state('procedure')).tasks.map((t) => t.title)).toEqual(['Relire la procédure']);
    await localApi.updateEntry(note.id, { title: 'Pompe', content_md: 'Bassin' });
    expect(await found('procedure')).toEqual(['Relire la procédure']);
    expect(await found('bassin')).toEqual(['Pompe']);
  });
});

describe('entrées', () => {
  test('les propositions de statut concurrentes sont comparées à la version en cours dans IndexedDB', async () => {
    const entry = await localApi.createEntry({ title: 'Bilan', status: 'doing' });
    expect(entry.status).toBe('doing');
    const task = await localApi.createTask({ title: 'Préparer le bilan' });
    await localApi.linkTaskDocument(task.id, entry.id);
    const results = await Promise.allSettled((['done', 'todo'] as const).map((status) =>
      localApi.updateEntry(entry.id, { status, expected_entry: expectedEntry(entry) })));
    expect(results[0]).toMatchObject({ status: 'fulfilled', value: { status: 'done', archived: 0 } });
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'ENTRY_EDIT_STALE' } });
    const state = await localApi.state();
    expect(state.entries.find(({ id }) => id === entry.id)?.status).toBe('done');
    const updatedTask = state.tasks.find(({ id }) => id === task.id);
    expect(updatedTask?.status).toBe('todo');
    expect(updatedTask?.documents).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: entry.id, status: 'done' }),
      expect.objectContaining({ id: task.documents[0].id, status: 'todo' }),
    ]));
    await expect(localApi.updateEntry(entry.id, { archived: 1 })).resolves.toMatchObject({ status: 'done', archived: 1 });
    await expect(localApi.updateEntry(entry.id, { status: 'blocked' as never })).rejects.toThrow('statut invalide');
    await expect(localApi.createEntry({ title: 'Invalide', status: 'blocked' as never })).rejects.toThrow('statut invalide');
  });

  test('une édition du corps compare le texte complet même à date égale', async () => {
    const database = createMemoryDatabase();
    setLocalDatabase(database);
    const entry = await localApi.createEntry({ title: 'Compte-rendu', content_md: 'Texte initial' });
    const entries = database.table<{ id: string; content_md: string }>('entries');
    const initial = (await entries.get(entry.id))!;
    await entries.put({ ...initial, content_md: 'Modification locale' });
    await expect(localApi.updateEntry(entry.id, { content_md: 'Texte proposé', expected_entry: expectedEntry(entry) }))
      .rejects.toThrow('état attendu de l’entrée invalide');
    await expect(localApi.updateEntry(entry.id, { content_md: 'Texte proposé', expected_entry: { ...expectedEntry(entry), source_key: entryMergeSourceKey(entry) } }))
      .rejects.toMatchObject({ code: 'ENTRY_EDIT_STALE' });
    const current = await localApi.entry(entry.id);
    expect(current.content_md).toBe('Modification locale');
    await expect(localApi.updateEntry(entry.id, { content_md: 'Texte relu', expected_entry: { ...expectedEntry(current), source_key: entryMergeSourceKey(current) } }))
      .resolves.toMatchObject({ content_md: 'Texte relu' });
  });

  test('la synchro et la sauvegarde gardent le statut et reconnaissent une entrée IndexedDB ancienne', async () => {
    const database = createMemoryDatabase();
    setLocalDatabase(database);
    const { id } = await localApi.createEntry({ title: 'Compte-rendu' });
    const entries = database.table<{ id: string; status?: string }>('entries');
    const legacy = (await entries.get(id))!;
    delete legacy.status;
    await entries.put(legacy);
    expect((await localApi.entry(id)).status).toBe('todo');
    const base = await localSyncSnapshot();
    const merged = { ...base, entries: base.entries.map((entry) => entry.id === id ? { ...entry, status: 'doing' as const } : entry) };
    await expect(applySyncSnapshot(merged, base)).resolves.toMatchObject({ changed: 1, skipped: 0 });
    const exported = JSON.parse(await (await localApi.exportBackup()).blob.text());
    expect(exported.entries.find((entry: Entry) => entry.id === id).status).toBe('doing');
    await localApi.updateEntry(id, { status: 'done' });
    await importLocalBackup(exported);
    expect((await localApi.entry(id)).status).toBe('doing');
  });

  test('création, relecture, modification, suppression et erreurs en français', async () => {
    await expect(localApi.createEntry({ title: '  ' })).rejects.toThrow('titre requis');
    await expect(localApi.createEntry({ title: 'X', entry_date: '10/09/2026' })).rejects.toThrow('date invalide');
    await expect(localApi.createEntry({ title: 'X', project_id: 'pr_inconnu' })).rejects.toThrow('projet introuvable');
    const created = await localApi.createEntry({ title: 'Note', content_md: 'corps' });
    expect((await localApi.entry(created.id)).content_md).toBe('corps');
    await expect(localApi.entry('en_inconnu')).rejects.toThrow('entrée introuvable');
    await expect(localApi.updateEntry(created.id, { title: '' })).rejects.toThrow('titre requis');
    const updated = await localApi.updateEntry(created.id, { title: 'Note 2' });
    expect(updated.title).toBe('Note 2');
    expect(await localApi.deleteEntry(created.id)).toEqual({ ok: true });
    await expect(localApi.entry(created.id)).rejects.toThrow('entrée introuvable');
  });

  test('une tâche créée localement reçoit une entrée de contenu liée', async () => {
    clearLocalOutbox();
    const project_id = await projectId();
    const task = await localApi.createTask({ title: 'Préparer le devis', project_id });
    expect(task.documents).toHaveLength(1);
    const entry = await localApi.entry(task.documents[0].id);
    expect(entry).toMatchObject({ title: task.title, project_id, content_md: '' });
    expect((await localApi.state()).tasks.find(({ id }) => id === task.id)?.documents).toHaveLength(1);
    clearLocalOutbox();
  });

  test('archivage visible par défaut, masquable et restaurable (miroir du serveur)', async () => {
    const created = await localApi.createEntry({ title: 'À ranger' });
    expect(created.archived).toBe(0);
    expect((await localApi.state()).entries.find((row) => row.id === created.id)?.archived).toBe(0);
    const archived = await localApi.updateEntry(created.id, { archived: 1 });
    expect(archived.archived).toBe(1);
    const kept = await localApi.updateEntry(created.id, { title: 'Autre nom' });
    expect(kept.archived).toBe(1);
    expect(kept.title).toBe('Autre nom');
    expect((await localApi.updateEntry(created.id, { archived: 0 })).archived).toBe(0);
  });

  test('document riche validé, refus de redescendre vers Markdown', async () => {
    const rich = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bonjour' }] }] } as never;
    const created = await localApi.createEntry({ title: 'Riche', content_json: rich });
    expect(created.content_md).toBe('Bonjour');
    await expect(localApi.createEntry({ title: 'X', content_json: { type: 'nope' } as never })).rejects.toThrow();
    await expect(localApi.updateEntry(created.id, { content_json: null })).rejects.toThrow('la conversion d’un document riche en Markdown n’est pas prise en charge');
  });

  test('copie locale et suppression en cascade', async () => {
    const id = await projectId();
    const original = await localApi.createEntry({ title: 'Orig', entry_date: '2026-09-10', project_id: id, content_md: 'brouillon' });
    const file = new File(['données'], 'plan.pdf', { type: 'application/pdf' });
    const stored = (await localApi.upload(file, original.id)).stored;
    await localApi.updateEntry(original.id, { content_md: `voir /api/files/${stored}` });
    const copy = await localApi.copyEntry(original.id);
    expect(copy.title).toBe('Orig — copie locale');
    expect(copy.attachments).toHaveLength(1);
    expect(copy.attachments[0].stored).not.toBe(stored);
    expect(copy.content_md).toContain(copy.attachments[0].stored);
    expect(copy.content_md).not.toContain(stored);
    await localApi.deleteEntry(original.id);
    expect((await localApi.state()).stats.entries).toBe(5); // amorçage + copie
  });

  test('fusion : même contrat que l’API, fichiers et tâches suivent, source modifiée refusée', async () => {
    const id = await projectId();
    const a = await localApi.createEntry({ title: 'A', project_id: id, content_md: 'a' });
    const b = await localApi.createEntry({ title: 'B', project_id: id, content_md: 'b' });
    await localApi.upload(new File(['pixels'], 'photo.jpg', { type: 'image/jpeg' }), a.id);
    const task = await localApi.createTask({ title: 'Joint' });
    await localApi.linkTaskDocument(task.id, b.id);
    const request = async () => ({
      request_id: crypto.randomUUID(),
      sources: await Promise.all([a, b].map(async (entry) => ({ id: entry.id, source_key: entryMergeSourceKey(await localApi.entry(entry.id)) }))),
      title: 'A et B', content_md: 'a\nb',
    });
    const stale = await request();
    await localApi.updateEntry(b.id, { content_md: 'b modifié' });
    await expect(localApi.mergeEntries(stale)).rejects.toThrow(/a changé/);
    const body = await request();
    const merged = await localApi.mergeEntries(body);
    expect(merged).toMatchObject({ title: 'A et B', project_id: id });
    expect(merged.attachments.map((file) => file.filename)).toEqual(['photo.jpg']);
    expect((await localApi.mergeEntries(body)).id).toBe(merged.id);
    const state = await localApi.state();
    expect(state.entries.map((entry) => entry.title)).not.toContain('A');
    expect(state.tasks.find((t) => t.id === task.id)?.documents?.map((d) => d.id).sort()).toEqual([merged.id, task.documents[0].id].sort());
    expect(readLocalOutbox().entries).toContain(merged.id);
  });

  test('fusion de tâches : même contrat que l’API, procédures gardées, source modifiée refusée', async () => {
    const id = await projectId();
    const a = await localApi.createTask({ title: 'A', project_id: id, priority: 'high', due_date: '2026-12-10' });
    const b = await localApi.createTask({ title: 'B', project_id: id, due_date: '2026-12-05', pinned: 1 });
    const note = await localApi.createEntry({ title: 'Note', project_id: id, content_md: 'n' });
    await localApi.upload(new File(['pixels'], 'photo.jpg', { type: 'image/jpeg' }), a.entry_id);
    const procedure = await localApi.createEntry({ title: 'Mode opératoire', kind: 'procedure', content_md: 'étapes' });
    await localApi.linkTaskDocument(a.id, note.id);
    await localApi.linkTaskDocument(b.id, procedure.id);
    const request = async () => {
      const { tasks } = await localApi.state();
      return {
        request_id: crypto.randomUUID(),
        sources: await Promise.all([a, b].map(async ({ id: taskId }) => {
          const task = tasks.find((candidate) => candidate.id === taskId)!;
          return { id: taskId, source_key: taskMergeSourceKey(task, await Promise.all(task.documents.map((document) => localApi.entry(document.id)))) };
        })),
        title: 'Tâche commune', content_md: 'Note commune',
      };
    };
    const stale = await request();
    await localApi.updateEntry(note.id, { content_md: 'n modifiée' });
    await expect(localApi.mergeTasks(stale)).rejects.toThrow(/a changé/);
    const body = await request();
    const merged = await localApi.mergeTasks(body);
    expect(merged).toMatchObject({ title: 'Tâche commune', content_md: 'Note commune', project_id: id });
    expect(merged.attachments.map((file) => file.filename)).toEqual(['photo.jpg']);
    expect((await localApi.mergeTasks(body)).id).toBe(merged.id);
    const state = await localApi.state();
    expect(state.tasks.map((task) => task.title)).toEqual(expect.not.arrayContaining(['A', 'B']));
    const task = state.tasks.find((candidate) => candidate.title === 'Tâche commune')!;
    expect(task).toMatchObject({ status: 'todo', due_date: '2026-12-05', priority: 'high', pinned: 1 });
    expect(task.documents.map((document) => document.id).sort()).toEqual([merged.id, note.id, procedure.id].sort());
    expect(state.entries.map((entry) => entry.title)).toContain('Note');
    expect(task.entry_id).toBe(merged.id);
    expect(readLocalOutbox().tasks).toContain(task.id);
  });
});

describe('procédures', () => {
  test('type note par défaut, invalide refusé, conversion conservée', async () => {
    const note = await localApi.createEntry({ title: 'Simple note' });
    expect(note.kind).toBe('note');
    await expect(localApi.createEntry({ title: 'X', kind: 'mode-emploi' as never })).rejects.toThrow(
      'type de document invalide (note ou procédure attendu)'
    );
    const procedure = await localApi.createEntry({ title: 'Montage', kind: 'procedure' });
    expect(procedure.kind).toBe('procedure');
    const renamed = await localApi.updateEntry(procedure.id, { title: 'Montage v2' });
    expect(renamed.kind).toBe('procedure');
    expect((await localApi.updateEntry(procedure.id, { kind: 'note' })).kind).toBe('note');
    expect((await localApi.copyEntry(procedure.id)).kind).toBe('note');
  });

  test('state() expose le type et rassemble les pièces jointes des procédures', async () => {
    const id = await projectId('Villa');
    const procedure = await localApi.createEntry({ title: 'Dallage', project_id: id, kind: 'procedure' });
    const note = await localApi.createEntry({ title: 'Pense-bête', project_id: id });
    await localApi.upload(new File(['contenu'], 'devis.pdf', { type: 'application/pdf' }), procedure.id);
    await localApi.upload(new File(['pixels'], 'photo.jpg', { type: 'image/jpeg' }), note.id);
    const state = await localApi.state('', id);
    const summaries = new Map(state.entries.map((row) => [row.id, row]));
    expect(summaries.get(procedure.id)?.kind).toBe('procedure');
    expect(summaries.get(note.id)?.kind).toBe('note');
    expect(state.procedure_attachments).toHaveLength(1);
    expect(state.procedure_attachments[0]).toMatchObject({ filename: 'devis.pdf', entry_title: 'Dallage' });
    expect((await localApi.state()).procedure_attachments.some((file) => file.filename === 'devis.pdf')).toBe(true);
  });
});

describe('tâches', () => {
  test('la note liée conserve le Markdown de création et les trois lignes partent ensemble', async () => {
    clearLocalOutbox();
    const id = await projectId();
    const category = await localApi.createCategory({ name: 'Préparation', project_id: id });
    const content_md = '## Préparation\n\n- [ ] Relire les journaux\n';
    const task = await localApi.createTask({ title: 'Déployer', content_md, project_id: id, category_id: category.id });
    expect(task.documents).toHaveLength(1);
    const note = await localApi.entry(task.documents[0].id);
    expect(note).toMatchObject({ title: task.title, project_id: id, category_id: category.id, content_md });
    const outbox = await exportLocalOutbox(null);
    expect(outbox).toMatchObject({ tasks: [{ id: task.id }], entries: [{ id: note.id, content_md }], task_entries: [{ task_id: task.id, entry_id: note.id }] });

    const prior = await localApi.state();
    await expect(localApi.createTask({ title: 'Invalide', content_md: null as never })).rejects.toThrow('contenu Markdown invalide');
    const state = await localApi.state();
    expect(state.entries).toEqual(prior.entries);
    expect(state.tasks).toEqual(prior.tasks);
  });

  test('création, priorités, statuts et erreurs', async () => {
    await expect(localApi.createTask({ title: '' })).rejects.toThrow('titre requis');
    await expect(localApi.createTask({ title: 'X', status: 'zzz' as never })).rejects.toThrow('statut invalide');
    await expect(localApi.createTask({ title: 'X', priority: 'urgente' as never })).rejects.toThrow('priorité invalide');
    const task = await localApi.createTask({ title: 'Faire', priority: 'high', pinned: 1 });
    expect(task).toMatchObject({ status: 'todo', priority: 'high', pinned: 1, position: 2 });
    expect((await localApi.entry(task.documents[0].id)).content_md).toBe('');
    const updated = await localApi.updateTask(task.id, { status: 'doing', priority: 'low' });
    expect(updated).toMatchObject({ status: 'doing', priority: 'low' });
    await expect(localApi.updateTask('tk_inconnu', { title: 'X' })).rejects.toThrow('tâche introuvable');
  });

  test('termine une tâche et archive les documents liés sans supprimer le lien', async () => {
    const entry = await localApi.createEntry({ title: 'Compte rendu' });
    const task = await localApi.createTask({ title: 'Terminer' });
    await localApi.linkTaskDocument(task.id, entry.id);

    await localApi.updateTask(task.id, { status: 'done' });
    expect((await localApi.entry(entry.id)).archived).toBe(1);
    expect((await localApi.state()).entries.find((item) => item.id === entry.id)?.archived).toBe(1);
    expect((await localApi.state()).tasks.find((item) => item.id === task.id)?.documents.map((item) => item.id).sort()).toEqual([entry.id, task.documents[0].id].sort());

    await localApi.updateTask(task.id, { status: 'todo' });
    expect((await localApi.entry(entry.id)).archived).toBe(1);
  });

  test('déplacement kanban vers Terminé archive les documents liés', async () => {
    const entry = await localApi.createEntry({ title: 'Plan' });
    const task = await localApi.createTask({ title: 'Livrer' });
    await localApi.linkTaskDocument(task.id, entry.id);

    await localApi.moveTask(task.id, 'done', 0);
    expect((await localApi.entry(entry.id)).archived).toBe(1);
  });

  test('lier un document à une tâche déjà terminée l’archive immédiatement', async () => {
    const entry = await localApi.createEntry({ title: 'Document tardif' });
    const task = await localApi.createTask({ title: 'Déjà terminé', status: 'done' });

    await localApi.linkTaskDocument(task.id, entry.id);
    expect((await localApi.entry(entry.id)).archived).toBe(1);
  });

  test('déplacement kanban renumérote les deux colonnes sans trou', async () => {
    const state = await localApi.state();
    const first = state.tasks.find((t) => t.status === 'todo') as { id: string };
    const moved = await localApi.moveTask(first.id, 'doing', 0);
    expect(moved.status).toBe('doing');
    expect(moved.position).toBe(0);
    const after = await localApi.state();
    const positions = (status: string) =>
      after.tasks.filter((t) => t.status === status).map((t) => t.position);
    expect(positions('todo')).toEqual([0]);
    expect(positions('doing')).toEqual([0, 1]);
    await expect(localApi.moveTask(first.id, 'zzz' as never, 0)).rejects.toThrow('statut invalide');
  });

  test('associations tâche-documents : doublon, retraits et erreurs', async () => {
    const task = await localApi.createTask({ title: 'Lien' });
    const entry = await localApi.createEntry({ title: 'Doc' });
    expect(await localApi.linkTaskDocument(task.id, entry.id)).toEqual({ task_id: task.id, entry_id: entry.id });
    expect(await localApi.linkTaskDocument(task.id, entry.id)).toEqual({ task_id: task.id, entry_id: entry.id });
    await expect(localApi.linkTaskDocument('tk_x', entry.id)).rejects.toThrow('tâche introuvable');
    expect(await localApi.unlinkTaskDocument(task.id, entry.id)).toEqual({ ok: true });
    await expect(localApi.unlinkTaskDocument(task.id, entry.id)).rejects.toThrow('association introuvable');
  });

  test('création depuis une entrée, avec projet et lien repris', async () => {
    const id = await projectId();
    const entry = await localApi.createEntry({ title: 'Contexte', project_id: id });
    const task = await localApi.createTaskFromEntry(entry.id, { due_date: '2026-09-20' });
    expect(task).toMatchObject({ title: 'Contexte', project_id: id, due_date: '2026-09-20', priority: 'normal' });
    expect(task.documents.map((d) => d.id)).toEqual([entry.id]);
    await expect(localApi.createTaskFromEntry('en_x')).rejects.toThrow('entrée introuvable');
    expect(await localApi.deleteTask(task.id)).toEqual({ ok: true });
  });

  test('création liée : priorité conservée et valeur invalide refusée sans écriture', async () => {
    const entry = await localApi.createEntry({ title: 'Maintenance' });
    for (const priority of ['high', 'low'] as const) {
      const task = await localApi.createTaskFromEntry(entry.id, { title: `Tâche ${priority}`, priority });
      expect(task.priority).toBe(priority);
      expect(task.documents.map((document) => document.id).sort()).toEqual([entry.id, task.entry_id].sort());
      expect((await localApi.state()).tasks.find((item) => item.id === task.id)?.priority).toBe(priority);
    }
    const before = (await localApi.state()).tasks;
    await expect(localApi.createTaskFromEntry(entry.id, { title: 'Invalide', priority: 'urgente' as never }))
      .rejects.toThrow('priorité invalide (basse, normale ou haute attendue)');
    expect((await localApi.state()).tasks).toEqual(before);
  });

  test('création liée dans la colonne en cours', async () => {
    const entry = await localApi.createEntry({ title: 'Intervention urgente' });
    const task = await localApi.createTaskFromEntry(entry.id, { title: 'Purger la pompe', status: 'doing', priority: 'high' });
    expect(task).toMatchObject({ status: 'doing', priority: 'high' });
    await expect(localApi.createTaskFromEntry(entry.id, { title: 'Statut invalide', status: 'in_progress' as never }))
      .rejects.toThrow('statut invalide');
  });

  test('une tâche créée possède une seule note éditable', async () => {
    const id = await projectId();
    const task = await localApi.createTask({ title: 'Dossier', project_id: id });
    await expect(localApi.createEntryFromTask(task.id, { content_md: 'Nouvelle description' })).rejects.toThrow('Cette tâche a déjà une note');
    const entry = await localApi.updateEntry(task.entry_id, { content_md: 'Nouvelle description' });
    expect(entry).toMatchObject({ title: 'Dossier', project_id: id, content_md: 'Nouvelle description', task: { id: task.id } });
    expect((await localApi.state()).tasks.find((t) => t.id === task.id)?.documents.map((d) => d.id)).toEqual([entry.id]);
    await expect(localApi.createEntryFromTask('tk_x')).rejects.toThrow('tâche introuvable');
    await expect(localApi.createEntryFromTask(task.id, { title: ' ' })).rejects.toThrow('titre requis');
  });

  test('convertir conserve le document ; statut et avancement restent partagés jusqu’au retrait du suivi', async () => {
    const entry = await localApi.createEntry({ title: 'Pompe', content_md: 'Contrôler le joint' });
    const attachment = await localApi.upload(new File(['plan'], 'plan.txt'), entry.id);
    const tasks = await Promise.all([localApi.createTaskFromEntry(entry.id), localApi.createTaskFromEntry(entry.id)]);
    const [task] = tasks;
    expect(tasks.map(({ id, entry_id }) => [id, entry_id])).toEqual([[task.id, entry.id], [task.id, entry.id]]);
    expect((await localApi.state('pompe')).entries).toHaveLength(1);
    await localApi.updateEntry(entry.id, { title: 'Contrôle pompe' });
    await expect(localApi.updateTask(task.id, { progress: 35 })).resolves.toMatchObject({ title: 'Contrôle pompe', status: 'doing', progress: 35 });
    await expect(localApi.updateTask(task.id, { progress: 35.5 })).rejects.toThrow(/avancement/i);
    expect((await localApi.state('joint')).tasks[0]).toMatchObject({ id: task.id, progress: 35 });
    await expect(localApi.unlinkTaskDocument(task.id, entry.id)).rejects.toThrow(/cette note contient la tâche/i);
    await localApi.updateEntry(entry.id, { status: 'done' });
    expect(await localApi.entry(entry.id)).toMatchObject({ status: 'done', archived: 1, task: { progress: 100 }, attachments: [{ id: attachment.id }] });
    await localApi.updateTask(task.id, { status: 'doing' });
    expect(await localApi.entry(entry.id)).toMatchObject({ status: 'doing', archived: 0 });
    await localApi.moveTask(task.id, 'done', 0);
    expect(await localApi.entry(entry.id)).toMatchObject({ status: 'done', archived: 1 });
    await localApi.deleteTask(task.id);
    expect(await localApi.entry(entry.id)).toMatchObject({ content_md: 'Contrôler le joint', task: null });
    const trackedAgain = await localApi.createTaskFromEntry(entry.id);
    await localApi.deleteEntry(entry.id);
    expect((await localApi.state()).tasks.some(({ id }) => id === trackedAgain.id)).toBe(false);
  });

  test('la boîte mobile et la restauration gardent la note et l’avancement', async () => {
    const task = await localApi.createTask({ title: 'Travaux', content_md: 'Préparer les outils' });
    clearLocalOutbox();
    await localApi.updateTask(task.id, { progress: 62 });
    const payload = await exportLocalOutbox();
    expect(payload).toMatchObject({
      entries: [{ id: task.entry_id, content_md: 'Préparer les outils', status: 'doing' }],
      tasks: [{ id: task.id, entry_id: task.entry_id, progress: 62 }],
      task_entries: [{ task_id: task.id, entry_id: task.entry_id }],
    });
    const { blob } = await localApi.exportBackup();
    await importLocalBackup(JSON.parse(await blob.text()));
    expect(await localApi.entry(task.entry_id)).toMatchObject({ task: { id: task.id, progress: 62 }, status: 'doing' });
  });
});

describe('projets et fichiers', () => {
  test('projets : création, renommage, suppression qui détache sans perdre', async () => {
    await expect(localApi.createProject({ name: '' })).rejects.toThrow('nom requis');
    const project = await localApi.createProject({ name: 'Villa' });
    expect(project.color).toBe('#4f7cff');
    const entry = await localApi.createEntry({ title: 'E', project_id: project.id });
    await localApi.deleteProject(project.id);
    expect((await localApi.entry(entry.id)).project_id).toBeNull();
    await expect(localApi.updateProject(project.id, { name: 'X' })).rejects.toThrow('projet introuvable');
  });

  test('pièces jointes : envoi, relecture, erreurs et suppression', async () => {
    const entry = await localApi.createEntry({ title: 'PJ' });
    const file = new File(['abc'], 'devis.pdf', { type: 'application/pdf' });
    const saved = await localApi.upload(file, entry.id);
    expect(saved).toMatchObject({ filename: 'devis.pdf', size: 3, entry_id: entry.id });
    expect(localApi.fileUrl(saved.stored)).toBe(`/api/files/${saved.stored}`);
    expect(localApi.previewUrl(saved.stored)).toBe(`/api/files/${saved.stored}/preview`);
    expect((await localApi.entry(entry.id)).attachments).toHaveLength(1);
    expect((await localApi.state()).entries.find((e) => e.id === entry.id)?.attachments).toBe(1);
    await expect(localApi.upload(file, 'en_x')).rejects.toThrow('entry_id requis et valide');
    await expect(localApi.upload({ ...file, size: 200 * 1024 * 1024 } as File, entry.id)).rejects.toThrow('100 Mo max');
    expect(await localApi.deleteAttachment(saved.id)).toEqual({ ok: true, driveTrashed: false });
    await expect(localApi.deleteAttachment(saved.id)).rejects.toThrow('pièce jointe introuvable');
  });

  test('URL de pièce jointe reste dans le sous-dossier de la PWA', () => {
    const originalPath = window.location.pathname;
    window.history.replaceState(null, '', '/work-logs/');
    try {
      expect(localApi.fileUrl('archi.ods')).toBe('/work-logs/api/files/archi.ods');
      expect(localApi.previewUrl('archi.ods')).toBe('/work-logs/api/files/archi.ods/preview');
    } finally {
      window.history.replaceState(null, '', originalPath || '/');
    }
  });

  test('export local au format sauvegarde v2, sans binaires', async () => {
    const { filename, blob } = await localApi.exportBackup();
    expect(filename).toBe('worklogs.json');
    const backup = JSON.parse(await blob.text());
    expect(backup.version).toBe(2);
    expect(backup.entries.map((e: { id: string }) => e.id)).toContain('en_welcome');
    expect(backup.tasks).toHaveLength(3);
    expect(JSON.stringify(backup)).not.toContain('données');
  });
});

describe('import de sauvegarde', () => {
  test('aller-retour export puis import sur base vide', async () => {
    const id = await projectId('Atelier');
    const entry = await localApi.createEntry({ title: 'Devis', project_id: id });
    const task = await localApi.createTask({ title: 'Relire', project_id: id });
    await localApi.linkTaskDocument(task.id, entry.id);
    await localApi.upload(new File(['x'], 'note.txt', { type: 'text/plain' }), entry.id);
    const { blob } = await localApi.exportBackup();

    setLocalDatabase(createMemoryDatabase());
    const result = await importLocalBackup(JSON.parse(await blob.text()));
    expect(result).toEqual({ ok: true, projects: 3, entries: 6, tasks: 4 });
    const state = await localApi.state();
    expect(state.entries.map((e) => e.title)).toContain('Devis');
    expect(state.tasks.find((t) => t.title === 'Relire')?.documents.map((d) => d.id).sort()).toEqual([entry.id, task.documents[0].id].sort());
    const imported = await localApi.entry(entry.id);
    expect(imported.attachments).toHaveLength(1);
    expect(imported.attachments[0].filename).toBe('note.txt');
  });

  test('sauvegarde invalide refusée sans rien écrire', async () => {
    await expect(importLocalBackup({ version: 999 })).rejects.toThrow('Version de sauvegarde');
    expect((await localApi.state()).stats.entries).toBe(4);
    await expect(importLocalBackup('{malformé')).rejects.toThrow();
  });
});

describe('file d’envoi', () => {
  test('créations et modifications suivies, suppressions retirées', async () => {
    clearLocalOutbox();
    expect(outboxSize()).toBe(0);
    const project = await localApi.createProject({ name: 'Suivi' });
    const entry = await localApi.createEntry({ title: 'Brouillon', project_id: project.id });
    const task = await localApi.createTask({ title: 'Relire' });
    await localApi.linkTaskDocument(task.id, entry.id);
    await localApi.updateEntry(entry.id, { title: 'Brouillon 2' });
    const file = new File(['photo'], 'img.jpg', { type: 'image/jpeg' });
    const saved = await localApi.upload(file, entry.id);
    let outbox = readLocalOutbox();
    expect(outbox.projects).toEqual([project.id]);
    expect(outbox.entries.sort()).toEqual([entry.id, task.documents[0].id].sort());
    expect(outbox.tasks).toEqual([task.id]);
    expect(outbox.attachments).toEqual([saved.id]);
    expect(outbox.links).toHaveLength(2);
    expect(outboxSize()).toBe(7);

    await localApi.unlinkTaskDocument(task.id, entry.id);
    await localApi.deleteAttachment(saved.id);
    outbox = readLocalOutbox();
    expect(outbox.links).toEqual([`${task.id}\0${task.documents[0].id}`]);
    expect(outbox.attachments).toEqual([]);
    await localApi.deleteTask(task.id);
    await localApi.deleteEntry(entry.id);
    await localApi.deleteEntry(task.documents[0].id);
    await localApi.deleteProject(project.id);
    expect(outboxSize()).toBe(0);
  });

  test('export de la boîte : lignes décodées, binaires exclus', async () => {
    const entry = await localApi.createEntry({ title: 'À envoyer' });
    const file = new File(['pixels'], 'photo.jpg', { type: 'image/jpeg' });
    await localApi.upload(file, entry.id);
    const payload = await exportLocalOutbox('2026-09-18T10:00:00.000Z');
    expect(payload.version).toBe(1);
    expect(payload.device).toBe('pwa');
    expect(payload.base_exported_at).toBe('2026-09-18T10:00:00.000Z');
    expect(payload.entries.map((e) => e.title)).toContain('À envoyer');
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0].driveFileId).toBeNull();
    expect(JSON.stringify(payload)).not.toContain('pixels');
  });

  test('binaires en attente puis marqués envoyés', async () => {
    const entry = await localApi.createEntry({ title: 'Photo' });
    const file = new File(['pixels'], 'photo.jpg', { type: 'image/jpeg' });
    const saved = await localApi.upload(file, entry.id);
    expect((await listPendingUploads()).map((row) => row.stored)).toEqual([saved.stored]);
    await markAttachmentUploaded(saved.stored, 'drive-abc');
    expect(await listPendingUploads()).toEqual([]);
    const payload = await exportLocalOutbox();
    expect(payload.attachments[0].driveFileId).toBe('drive-abc');
  });

  test('import efface la file d’envoi', async () => {
    await localApi.createEntry({ title: 'Local' });
    expect(outboxSize()).toBeGreaterThan(0);
    const { blob } = await localApi.exportBackup();
    await importLocalBackup(JSON.parse(await blob.text()));
    expect(outboxSize()).toBe(0);
    clearLocalOutbox();
  });

  test('import conserve le driveFileId, le statut compte les manquants', async () => {
    const T = '2026-09-18T10:00:00.000Z';
    await importLocalBackup({
      version: 2, projects: [],
      entries: [{ id: 'en_1', title: 'Note', content_md: '', content_json: null, entry_date: '2026-09-18', project_id: null, archived: 0, created_at: T, updated_at: T }],
      tasks: [], task_entries: [], google_documents: [],
      attachments: [{ id: 'at_1', filename: 'doc.txt', stored: 'doc.txt', mime: 'text/plain', size: 3, entry_id: 'en_1', created_at: T, driveFileId: 'drive-doc-1' }],
    });
    const entry = await localApi.entry('en_1');
    expect(entry.attachments[0].driveFileId).toBe('drive-doc-1');
    const status = await localApi.driveAttachmentStatus();
    expect(status).toMatchObject({ total: 1, onDrive: 1, missingLocal: 1 });
    // Sans connexion Google, la récupération échoue en français sans rien casser.
    await expect(localApi.fetchDriveAttachment('at_1')).rejects.toThrow(/Connecte Google Drive/);
    expect((await fetchMissingDriveAttachments())).toMatchObject({ fetched: 0, missing: 1 });
  });
});

describe('documents Google multi-onglets', () => {
  const T = '2026-09-18T10:00:00.000Z';
  const rich = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
  const entryRow = (id: string, tab: string, text: string) => ({
    id, title: `Doc multi — ${tab}`, content_md: text, content_json: rich(text),
    entry_date: '2026-09-18', project_id: null, created_at: T, updated_at: T,
  });
  const linkRow = (id: string, tab: string, order: number, text: string) => ({
    entry_id: id, document_id: 'gdoc-multi', tab_id: `tab-${tab}`, revision_id: 'r1',
    synced_content_json: JSON.stringify(rich(text)), synced_at: T,
    document_title: 'Doc multi', tab_title: `Onglet ${tab}`, tab_order: order, tab_depth: 0, readonly_reason: '',
  });
  async function importTwoTabs() {
    await importLocalBackup({
      version: 2, projects: [],
      entries: [entryRow('en_a', 'A', 'Contenu A'), entryRow('en_b', 'B', 'Contenu B')],
      tasks: [], task_entries: [],
      google_documents: [linkRow('en_a', 'A', 0, 'Contenu A'), linkRow('en_b', 'B', 1, 'Contenu B')],
      attachments: [],
    });
  }

  test('state() porte les associations, comme la jointure serveur', async () => {
    await importTwoTabs();
    const summaries = (await localApi.state()).entries;
    const a = summaries.find((e) => e.id === 'en_a');
    expect(a).toMatchObject({ google_document_id: 'gdoc-multi', google_tab_id: 'tab-A', google_document_title: 'Doc multi', google_tab_title: 'Onglet A', google_tab_order: 0, google_dirty: false });
    await localApi.updateEntry('en_a', { content_json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Modifié' }] }] } as never });
    expect((await localApi.state()).entries.find((e) => e.id === 'en_a')?.google_dirty).toBe(true);
  });

  test('le journal regroupe les onglets en une seule ligne', async () => {
    await importTwoTabs();
    const { groupTabs } = await import('../lib');
    const items = groupTabs((await localApi.state()).entries);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Doc multi');
    expect(items[0].tabs.map((t) => t.google_tab_id)).toEqual(['tab-A', 'tab-B']);
  });

  test('fullEntry expose les onglets frères et compte les éléments conservés', async () => {
    await importTwoTabs();
    const sync = (await localApi.entry('en_a')).google_sync;
    expect(sync?.tabs?.map((t) => t.id)).toEqual(['en_a', 'en_b']);
    expect(sync?.dirty).toBe(false);
    expect(sync?.preserved_elements).toBe(0);
    const kept = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [
        { type: 'text', text: 'Vu ' },
        { type: 'googleInline', attrs: { googleId: 'object-0', label: 'Menu Google' } },
      ] }],
    } as never;
    await localApi.updateEntry('en_a', { content_json: kept });
    expect((await localApi.entry('en_a')).google_sync?.preserved_elements).toBe(1);
  });
});

describe('Google sans serveur (lots suivants couverts ailleurs)', () => {
  test('état réel du navigateur et refus explicite des flux desktop', async () => {
    // Même forme que le desktop : le menu du compte lit un seul état.
    expect(await localApi.googleStatus()).toMatchObject({ available: true, configured: false, connected: false, account: null });
    await expect(localApi.configureGoogle({})).rejects.toThrow('disponible dans l’application desktop');
    await expect(localApi.connectGoogle()).rejects.toThrow('Aucun client Google configuré');
    await expect(localApi.googleBackups()).rejects.toThrow('disponible dans l’application desktop');
    await expect(localApi.googleDocumentTabs('x')).rejects.toThrow('disponible dans l’application desktop');
  });

  test('les flux Docs directs exigent un identifiant valide puis une connexion', async () => {
    await expect(localApi.openGoogleDocument('mauvais id!')).rejects.toThrow('Identifiant de document Google invalide');
    await expect(localApi.openGoogleDocument('gdoc-1')).rejects.toThrow('Connecte Google Drive pour continuer');
    await expect(localApi.pushGoogleDocument('en_x')).rejects.toThrow('entrée introuvable');
  });

  test('les refus sont des ApiError reconnues par le front', async () => {
    const error = await localApi.entry('en_x').catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
  });
});
