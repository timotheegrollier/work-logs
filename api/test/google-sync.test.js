import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, make } from './helpers.js';

/** Faux Drive : un seul fichier canonique en mémoire, réécrit par PATCH/POST multipart. */
function fakeDrive() {
  const drive = { text: null, modifiedTime: '', writes: 0, connected: true, folders: [], attachments: [] };
  let tick = 0;
  drive.google = {
    status: () => ({ available: true, configured: true, connected: drive.connected, pending: false, error: '', selectedIds: [] }),
    async request(url, options = {}) {
      // Dossiers WorkLogs, retrouvés par étiquette puis créés au besoin.
      const folderType = /value='(root-folder|attachments-folder)'/.exec(decodeURIComponent(url))?.[1];
      if (folderType) return { files: drive.folders.filter((f) => f.type === folderType) };
      if (url.startsWith('/drive/v3/files?supportsAllDrives=true&fields=id') && options.method === 'POST') {
        const meta = JSON.parse(options.body);
        const folder = { id: `folder-${drive.folders.length + 1}`, type: meta.appProperties.worklogs_type, name: meta.name, parents: meta.parents };
        drive.folders.push(folder);
        return { id: folder.id };
      }
      if (url.startsWith('/upload/') && String(options.body).includes('"worklogs_type":"attachment"')) {
        const meta = JSON.parse(/\{"name".*?\}\}?(?=\r\n)/.exec(options.body.toString('utf8'))[0]);
        drive.attachments.push(meta);
        return { id: `drive-att-${drive.attachments.length}` };
      }
      if (url.startsWith('/drive/v3/files?')) {
        return { files: drive.text ? [{ id: 'bk1', name: 'WorkLogs backup.json', modifiedTime: drive.modifiedTime, mimeType: 'application/json' }] : [] };
      }
      if (url.startsWith('/drive/v3/files/bk1?alt=media')) return drive.text;
      if (url.startsWith('/upload/drive/v3/files')) {
        const body = Buffer.isBuffer(options.body) ? options.body.toString('utf8') : String(options.body);
        const start = body.indexOf('{"version"');
        drive.text = body.slice(start, body.lastIndexOf('}') + 1);
        drive.modifiedTime = `2026-09-22T10:00:${String(++tick).padStart(2, '0')}.000Z`;
        drive.writes++;
        return { id: 'bk1', name: 'WorkLogs backup.json', modifiedTime: drive.modifiedTime };
      }
      throw new Error(`appel inattendu : ${url}`);
    },
  };
  drive.json = () => JSON.parse(drive.text);
  /** Le téléphone réécrit le fichier (il a fusionné de son côté). */
  drive.phoneWrites = (mutate) => {
    const data = drive.json();
    mutate(data);
    drive.text = JSON.stringify(data);
    drive.modifiedTime = `2026-09-22T11:00:${String(++tick).padStart(2, '0')}.000Z`;
  };
  return drive;
}

test('synchro desktop : envoi initial, réception du téléphone, suppression propagée, sauvegarde fusionnée', async () => {
  const drive = fakeDrive();
  const api = await startApi({ google: drive.google, autoSync: true });
  try {
    const pc = await make.entry(api, { title: 'Note du PC' });
    let status = (await api.post('/api/google/sync')).body;
    assert.equal(status.state, 'idle');
    assert.ok(status.lastSyncedAt);
    assert.deepEqual(drive.json().entries.map((e) => e.title), ['Note du PC']);
    const writes = drive.writes;

    // Rien de neuf : ni réécriture ni changement local.
    status = (await api.post('/api/google/sync')).body;
    assert.equal(drive.writes, writes);
    const revision = status.revision;

    // Le téléphone ajoute une note.
    drive.phoneWrites((data) => data.entries.push({ ...data.entries[0], id: 'en_phone', title: 'Note du téléphone', updated_at: new Date().toISOString() }));
    status = (await api.post('/api/google/sync')).body;
    assert.equal(status.revision, revision + 1, 'le front sait qu’il doit recharger');
    assert.equal((await api.get('/api/entries/en_phone')).body.title, 'Note du téléphone');
    assert.equal(drive.writes, writes, 'déjà à jour sur Drive : pas de réécriture');

    // Suppression sur le PC : elle part avec sa pierre tombale.
    await api.del(`/api/entries/${pc.id}`);
    await api.post('/api/google/sync');
    assert.deepEqual(drive.json().entries.map((e) => e.id), ['en_phone']);
    assert.ok(drive.json().deleted.some((t) => t.kind === 'entry' && t.id === pc.id));

    // « Sauvegarder » fusionne : la note du téléphone arrivée entre-temps n'est pas écrasée.
    drive.phoneWrites((data) => data.entries.push({ ...data.entries[0], id: 'en_phone2', title: 'Encore le téléphone', updated_at: new Date().toISOString() }));
    const saved = await api.post('/api/google/backup/export');
    assert.equal(saved.status, 201);
    assert.equal(saved.body.name, 'WorkLogs backup.json');
    assert.deepEqual(drive.json().entries.map((e) => e.id).sort(), ['en_phone', 'en_phone2']);
    assert.equal((await api.get('/api/entries/en_phone2')).status, 200);

    // L'état de synchro voyage avec le statut Google.
    assert.equal((await api.get('/api/google/status')).body.sync.state, 'idle');
  } finally { await api.close(); }
});

test('synchro desktop : déconnecté, rien ne part ; un fichier illisible met la synchro en erreur sans rien toucher', async () => {
  const drive = fakeDrive();
  drive.connected = false;
  const api = await startApi({ google: drive.google, autoSync: true });
  try {
    await make.entry(api, { title: 'Locale' });
    assert.equal((await api.post('/api/google/sync')).body.state, 'off');
    assert.equal(drive.writes, 0);

    drive.connected = true;
    drive.text = '{"version":2,"projects":"cassé"}';
    drive.modifiedTime = '2026-09-22T09:00:00.000Z';
    const status = (await api.post('/api/google/sync')).body;
    assert.equal(status.state, 'error');
    assert.match(status.error, /invalide/);
    assert.equal((await api.get('/api/state')).body.entries.length, 1, 'la base locale reste intacte');
  } finally { await api.close(); }
});

test('sans synchro auto (web, tests) : la route explique et l’état reste « off »', async () => {
  const drive = fakeDrive();
  const api = await startApi({ google: drive.google });
  try {
    assert.equal((await api.get('/api/google/sync')).body.state, 'off');
    assert.equal((await api.post('/api/google/sync')).status, 503);
  } finally { await api.close(); }
});

test('pièce jointe de procédure : envoyée dans WorkLogs/Pièces jointes, dossiers créés une seule fois', async () => {
  const drive = fakeDrive();
  const api = await startApi({ google: drive.google, autoSync: true });
  try {
    const procedure = await make.entry(api, { title: 'Dallage', kind: 'procedure' });
    await api.upload('plan.pdf', '%PDF', { entry_id: procedure.id });
    await api.post('/api/google/sync');
    assert.deepEqual(drive.folders.map((f) => [f.name, f.type, f.parents?.[0] ?? null]), [
      ['WorkLogs', 'root-folder', null],
      ['Pièces jointes', 'attachments-folder', 'folder-1'],
    ]);
    assert.equal(drive.attachments.length, 1);
    assert.deepEqual(drive.attachments[0].parents, ['folder-2']);
    assert.equal(drive.attachments[0].name, 'plan.pdf');
    // L'identifiant Drive voyage avec la fiche : l'autre appareil pourra le rapatrier.
    assert.equal(drive.json().attachments[0].driveFileId, 'drive-att-1');
    const listed = (await api.get('/api/state')).body.procedure_attachments;
    assert.equal(listed[0].driveFileId, 'drive-att-1');

    // Deuxième fichier : même dossier, rien de recréé.
    await api.upload('devis.pdf', '%PDF', { entry_id: procedure.id });
    await api.post('/api/google/sync');
    assert.equal(drive.folders.length, 2);
    assert.deepEqual(drive.attachments[1].parents, ['folder-2']);
  } finally { await api.close(); }
});
