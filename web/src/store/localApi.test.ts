import { beforeEach, describe, expect, test } from 'vitest';
import { ApiError } from '../lib';
import {
  clearLocalOutbox,
  exportLocalOutbox,
  importLocalBackup,
  listPendingUploads,
  localApi,
  markAttachmentUploaded,
  outboxSize,
  readLocalOutbox,
  setLocalDatabase,
} from './localApi';
import { createMemoryDatabase } from './storage';

beforeEach(() => {
  setLocalDatabase(createMemoryDatabase());
});

async function projectId(name = 'Chantier'): Promise<string> {
  return (await localApi.createProject({ name })).id;
}

describe('amorçage et état', () => {
  test('même amorçage que le serveur : 2 projets, le mode d’emploi, 3 tâches', async () => {
    const state = await localApi.state();
    expect(state.projects.map((p) => p.name).sort()).toEqual(['Perso', 'Pro']);
    expect(state.entries.map((e) => e.title)).toContain('Comment ça marche');
    expect(state.tasks.map((t) => t.title)).toContain('Écrire ma première entrée');
    expect(state.stats.entries).toBe(1);
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
});

describe('entrées', () => {
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
    expect((await localApi.state()).stats.entries).toBe(2); // amorçage + copie
  });
});

describe('tâches', () => {
  test('création, priorités, statuts et erreurs', async () => {
    await expect(localApi.createTask({ title: '' })).rejects.toThrow('titre requis');
    await expect(localApi.createTask({ title: 'X', status: 'zzz' as never })).rejects.toThrow('statut invalide');
    await expect(localApi.createTask({ title: 'X', priority: 'urgente' as never })).rejects.toThrow('priorité invalide');
    const task = await localApi.createTask({ title: 'Faire', priority: 'high', pinned: 1 });
    expect(task).toMatchObject({ status: 'todo', priority: 'high', pinned: 1, position: 2 });
    const updated = await localApi.updateTask(task.id, { status: 'doing', priority: 'low' });
    expect(updated).toMatchObject({ status: 'doing', priority: 'low' });
    await expect(localApi.updateTask('tk_inconnu', { title: 'X' })).rejects.toThrow('tâche introuvable');
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
    expect(task).toMatchObject({ title: 'Contexte', project_id: id, due_date: '2026-09-20' });
    expect(task.documents.map((d) => d.id)).toEqual([entry.id]);
    await expect(localApi.createTaskFromEntry('en_x')).rejects.toThrow('entrée introuvable');
    expect(await localApi.deleteTask(task.id)).toEqual({ ok: true });
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
    expect((await localApi.entry(entry.id)).attachments).toHaveLength(1);
    expect((await localApi.state()).entries.find((e) => e.id === entry.id)?.attachments).toBe(1);
    await expect(localApi.upload(file, 'en_x')).rejects.toThrow('entry_id requis et valide');
    await expect(localApi.upload({ ...file, size: 200 * 1024 * 1024 } as File, entry.id)).rejects.toThrow('100 Mo max');
    expect(await localApi.deleteAttachment(saved.id)).toEqual({ ok: true });
    await expect(localApi.deleteAttachment(saved.id)).rejects.toThrow('pièce jointe introuvable');
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
    expect(result).toEqual({ ok: true, projects: 3, entries: 2, tasks: 4 });
    const state = await localApi.state();
    expect(state.entries.map((e) => e.title)).toContain('Devis');
    expect(state.tasks.find((t) => t.title === 'Relire')?.documents.map((d) => d.id)).toEqual([entry.id]);
    const imported = await localApi.entry(entry.id);
    expect(imported.attachments).toHaveLength(1);
    expect(imported.attachments[0].filename).toBe('note.txt');
  });

  test('sauvegarde invalide refusée sans rien écrire', async () => {
    await expect(importLocalBackup({ version: 999 })).rejects.toThrow('Version de sauvegarde');
    expect((await localApi.state()).stats.entries).toBe(1);
    await expect(importLocalBackup('{malformé')).rejects.toThrow();
  });
});

describe('file d’envoi', () => {
  test('créations et modifications suivies, suppressions retirées', async () => {
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
    expect(outbox.entries).toEqual([entry.id]);
    expect(outbox.tasks).toEqual([task.id]);
    expect(outbox.attachments).toEqual([saved.id]);
    expect(outbox.links).toHaveLength(1);
    expect(outboxSize()).toBe(5);

    await localApi.unlinkTaskDocument(task.id, entry.id);
    await localApi.deleteAttachment(saved.id);
    outbox = readLocalOutbox();
    expect(outbox.links).toEqual([]);
    expect(outbox.attachments).toEqual([]);
    await localApi.deleteTask(task.id);
    await localApi.deleteEntry(entry.id);
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
});

describe('Google indisponible en local', () => {
  test('état non disponible et refus explicite', async () => {
    expect(await localApi.googleStatus()).toMatchObject({ available: false, connected: false });
    await expect(localApi.googleDocuments()).rejects.toThrow('disponible dans l’application desktop');
    await expect(localApi.pushGoogleDocument('en_x')).rejects.toThrow('disponible dans l’application desktop');
  });

  test('les refus sont des ApiError reconnues par le front', async () => {
    const error = await localApi.entry('en_x').catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
  });
});
