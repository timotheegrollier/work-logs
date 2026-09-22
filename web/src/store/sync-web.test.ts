import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createMemoryDatabase } from './storage';

const CLIENT = '123456789012-abc.apps.googleusercontent.com';

/** Faux Drive : un fichier canonique, réécrit par multipart, avec un compteur de téléchargements. */
function fakeDrive() {
  const drive = { text: '', modifiedTime: '', downloads: 0, uploads: [] as string[], trashed: [] as string[], folders: [] as { id: string; type: string }[], files: [] as { name: string; parents?: string[] }[] };
  let tick = 0;
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    const target = String(url);
    if (init?.method === 'PATCH' && !target.includes('/upload/')) {
      drive.trashed.push(/\/drive\/v3\/files\/([^?]+)/.exec(target)![1]);
      return Response.json({ id: 'x', trashed: true });
    }
    const folderType = /value='(root-folder|attachments-folder)'/.exec(decodeURIComponent(target))?.[1];
    if (folderType) return Response.json({ files: drive.folders.filter((f) => f.type === folderType) });
    if (target.includes('/drive/v3/files?supportsAllDrives=true&fields=id') && init?.method === 'POST') {
      const meta = JSON.parse(String(init.body));
      drive.folders.push({ id: `folder-${drive.folders.length + 1}`, type: meta.appProperties.worklogs_type });
      return Response.json({ id: `folder-${drive.folders.length}` });
    }
    if (target.includes('/upload/') && (await (init?.body as Blob).text()).includes('"worklogs_type":"attachment"')) {
      const body = await (init?.body as Blob).text();
      drive.files.push(JSON.parse(body.slice(body.indexOf('{"name"'), body.indexOf('\r\n', body.indexOf('{"name"')))));
      return Response.json({ id: `drive-file-${drive.files.length}` });
    }
    if (target.includes('/upload/')) {
      const body = await (init?.body as Blob).text();
      drive.text = body.slice(body.indexOf('{"version"'), body.lastIndexOf('}') + 1);
      drive.uploads.push(drive.text);
      drive.modifiedTime = `2026-09-22T10:00:${String(++tick).padStart(2, '0')}.000Z`;
      return Response.json({ id: 'canon', name: 'WorkLogs backup.json', modifiedTime: drive.modifiedTime });
    }
    if (target.includes('alt=media')) {
      drive.downloads++;
      return new Response(drive.text);
    }
    if (target.includes('/drive/v3/files?')) {
      return Response.json({ files: drive.text ? [{ id: 'canon', name: 'WorkLogs backup.json', mimeType: 'application/json', modifiedTime: drive.modifiedTime }] : [] });
    }
    throw new Error(`appel inattendu : ${target}`);
  });
  return drive;
}

async function load() {
  vi.resetModules();
  const local = await import('./localApi');
  local.setLocalDatabase(createMemoryDatabase());
  const sync = await import('./sync-web');
  return { local, sync };
}
const connect = () => {
  localStorage.setItem('worklogs-google-web-client', CLIENT);
  localStorage.setItem('worklogs-google-web-tokens', JSON.stringify({ access_token: 'acces', expires_at: Date.now() + 3600_000 }));
};
const remoteBackup = (entries: object[]) => JSON.stringify({ version: 2, projects: [], entries, tasks: [], task_entries: [], google_documents: [], attachments: [], deleted: [] });
const entry = (id: string, title: string, updated_at: string) => ({ id, title, content_md: '', content_json: null, entry_date: '2026-09-22',
  project_id: null, archived: 0, kind: 'note', created_at: '2026-09-01T00:00:00.000Z', updated_at });

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('synchro PWA', () => {
  test('déconnecté : rien ne part, état « off »', async () => {
    const drive = fakeDrive();
    const { sync } = await load();
    await sync.syncWebNow();
    expect(sync.webSyncStatus().state).toBe('off');
    expect(drive.uploads).toHaveLength(0);
  });

  test('première connexion : la sauvegarde du compte est chargée ; le mode d’emploi édité au PC gagne', async () => {
    const drive = fakeDrive();
    drive.text = remoteBackup([entry('en_pc', 'Note du PC', '2026-09-20T08:00:00.000Z'), entry('en_welcome', 'Mode d’emploi à ma façon', '2026-09-02T00:00:00.000Z')]);
    drive.modifiedTime = '2026-09-20T08:00:00.000Z';
    connect();
    const { local, sync } = await load();
    const seen: number[] = [];
    sync.subscribeWebSync((s) => seen.push(s.revision));
    await sync.syncWebNow();
    const titles = (await local.localApi.state('', '')).entries.map((e) => e.title);
    expect(titles).toContain('Note du PC');
    expect(titles).toContain('Mode d’emploi à ma façon');
    expect(titles).not.toContain('Comment ça marche');
    expect(sync.webSyncStatus()).toMatchObject({ state: 'idle', revision: 1 });
    expect(seen.at(-1)).toBe(1);
  });

  test('chaque modification repart (regroupée), les suppressions aussi ; fichier inchangé = pas de retéléchargement', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const drive = fakeDrive();
    connect();
    const { local, sync } = await load();
    await sync.syncWebNow();
    expect(drive.uploads).toHaveLength(1);
    const downloads = drive.downloads;

    const stop = sync.startWebSync(() => {});
    await vi.advanceTimersByTimeAsync(0);
    const created = await local.localApi.createEntry({ title: 'Notée sur le téléphone' });
    await local.localApi.updateEntry(created.id, { content_md: 'premier jet' });
    await vi.advanceTimersByTimeAsync(3100);
    await vi.waitFor(() => expect(drive.text).toContain('premier jet'));
    // Le fichier n'a pas changé ailleurs : pas de retéléchargement.
    expect(drive.downloads).toBe(downloads);

    await local.localApi.deleteEntry(created.id);
    await vi.advanceTimersByTimeAsync(3100);
    await vi.waitFor(() => expect(JSON.parse(drive.text).deleted).toContainEqual(expect.objectContaining({ kind: 'entry', id: created.id })));
    expect(JSON.parse(drive.text).entries.map((e: { id: string }) => e.id)).not.toContain(created.id);
    stop();
  });

  test('pièce jointe ajoutée ici : envoyée dans WorkLogs/Pièces jointes, identifiant Drive gardé', async () => {
    const drive = fakeDrive();
    connect();
    const { local, sync } = await load();
    const procedure = await local.localApi.createEntry({ title: 'Dallage', kind: 'procedure' });
    await local.localApi.upload(new File(['pdf'], 'plan.pdf', { type: 'application/pdf' }), procedure.id);
    await sync.syncWebNow();
    expect(drive.folders.map((f) => f.type)).toEqual(['root-folder', 'attachments-folder']);
    expect(drive.files).toHaveLength(1);
    expect(drive.files[0]).toMatchObject({ name: 'plan.pdf', parents: ['folder-2'] });
    const sent = JSON.parse(drive.text).attachments[0];
    expect(sent.driveFileId).toBe('drive-file-1');
    // Le binaire reste aussi sur l'appareil.
    expect((await local.localApi.state('', '')).procedure_attachments[0].driveFileId).toBe('drive-file-1');
  });

  test('supprimer une pièce jointe : exemplaire Drive à la corbeille, sauf s’il est partagé ; la suppression part à la synchro', async () => {
    const drive = fakeDrive();
    connect();
    const { local, sync } = await load();
    const procedure = await local.localApi.createEntry({ title: 'Dallage', kind: 'procedure' });
    const plan = await local.localApi.upload(new File(['pdf'], 'plan.pdf', { type: 'application/pdf' }), procedure.id);
    await sync.syncWebNow();
    expect(drive.files).toHaveLength(1);

    expect(await local.localApi.deleteAttachment(plan.id)).toEqual({ ok: true, driveTrashed: true });
    expect(drive.trashed).toEqual(['drive-file-1']);
    await sync.syncWebNow();
    const sent = JSON.parse(drive.text);
    expect(sent.attachments).toHaveLength(0);
    expect(sent.deleted).toContainEqual(expect.objectContaining({ kind: 'attachment', id: plan.id }));

    // Deux fiches pour le même exemplaire Drive : on n'y touche pas.
    const a = await local.localApi.upload(new File(['x'], 'a.pdf'), procedure.id);
    const b = await local.localApi.upload(new File(['x'], 'b.pdf'), procedure.id);
    await local.markAttachmentUploaded(a.stored, 'drive-commun');
    await local.markAttachmentUploaded(b.stored, 'drive-commun');
    expect(await local.localApi.deleteAttachment(a.id)).toEqual({ ok: true, driveTrashed: false });
    expect(drive.trashed).toEqual(['drive-file-1']);
  });

  test('une saisie pendant la synchro n’est jamais écrasée par la version fusionnée', async () => {
    const { local } = await load();
    const created = await local.localApi.createEntry({ title: 'Brouillon' });
    const base = await local.localSyncSnapshot();
    const merged = structuredClone(base);
    const row = merged.entries.find((e) => e.id === created.id)!;
    row.title = 'Version distante';
    row.updated_at = '2099-01-01T00:00:00.000Z';
    await local.localApi.updateEntry(created.id, { title: 'Saisi pendant la synchro' });
    const result = await local.applySyncSnapshot(merged, base);
    expect(result.skipped).toBe(1);
    expect((await local.localApi.entry(created.id)).title).toBe('Saisi pendant la synchro');
  });
});
