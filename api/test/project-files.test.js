import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, make } from './helpers.js';

test('les fichiers des projets portent leur entrée et leur projet, filtrables', async () => {
  const api = await startApi();
  try {
    const villa = await make.project(api, 'Villa');
    const notes = await make.project(api, 'Notes');
    const procedure = await make.entry(api, { title: 'Sauvegarde', kind: 'procedure', project_id: villa.id });
    const note = await make.entry(api, { title: 'Compte rendu', project_id: notes.id });
    const free = await make.entry(api, { title: 'Sans projet' });
    const plan = await api.upload('plan.pdf', '%PDF', { entry_id: procedure.id });
    const sheet = await api.upload('suivi.xlsx', 'xlsx', { entry_id: note.id });
    await api.upload('libre.txt', 'libre', { entry_id: free.id });
    api.db.prepare('UPDATE attachments SET drive_file_id=? WHERE id=?').run('drive-plan', plan.body.id);

    const all = await api.get('/api/project-files');
    assert.equal(all.status, 200);
    assert.equal(all.body.length, 3);
    const byName = new Map(all.body.map((file) => [file.filename, file]));
    assert.deepEqual(
      { title: byName.get('plan.pdf').entry_title, kind: byName.get('plan.pdf').entry_kind, project: byName.get('plan.pdf').project_name, drive: byName.get('plan.pdf').driveFileId },
      { title: 'Sauvegarde', kind: 'procedure', project: 'Villa', drive: 'drive-plan' }
    );
    assert.equal(byName.get('suivi.xlsx').project_id, notes.id);
    assert.equal(byName.get('libre.txt').project_id, null);
    assert.equal(byName.get('libre.txt').project_name, null);
    assert.equal('stored' in byName.get('plan.pdf'), true);
    assert.equal(byName.get('plan.pdf').stored, plan.body.stored);

    const filtered = await api.get(`/api/project-files?project_id=${villa.id}`);
    assert.deepEqual(filtered.body.map((file) => file.filename), ['plan.pdf']);
    const empty = await api.get(`/api/project-files?project_id=${villa.id}&project_id=`);
    assert.equal(empty.status, 200);
  } finally { await api.close(); }
});

test('une pièce jointe supprimée quitte la liste', async () => {
  const api = await startApi();
  try {
    const entry = await make.entry(api, { title: 'Note' });
    const file = await api.upload('a.txt', 'a', { entry_id: entry.id });
    assert.equal((await api.get('/api/project-files')).body.length, 1);
    await api.del(`/api/attachments/${file.body.id}`);
    assert.deepEqual((await api.get('/api/project-files')).body, []);
  } finally { await api.close(); }
});
