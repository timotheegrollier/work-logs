import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, make } from './helpers.js';

/** Google simulé : note chaque mise à la corbeille, peut échouer ou être déconnecté. */
function fakeGoogle({ connected = true, failing = false } = {}) {
  const trashed = [];
  return {
    trashed,
    status: () => ({ available: true, configured: true, connected, pending: false, error: '', selectedIds: [] }),
    async request(url, options = {}) {
      if (failing) throw new Error('Drive injoignable');
      assert.equal(options.method, 'PATCH');
      assert.deepEqual(JSON.parse(options.body), { trashed: true });
      trashed.push(/\/drive\/v3\/files\/([^?]+)/.exec(url)[1]);
      return { id: 'x', trashed: true };
    },
  };
}

async function withDriveAttachment(api, driveId, title = 'Dallage') {
  const entry = await make.entry(api, { title, kind: 'procedure' });
  const upload = await api.upload('plan.pdf', '%PDF', { entry_id: entry.id });
  api.db.prepare('UPDATE attachments SET drive_file_id=? WHERE id=?').run(driveId, upload.body.id);
  return { entry, attachment: upload.body };
}

test('supprimer une pièce jointe adossée à Drive la met à la corbeille Drive', async () => {
  const google = fakeGoogle();
  const api = await startApi({ google });
  try {
    const { attachment } = await withDriveAttachment(api, 'drive-plan-1');
    const res = await api.del(`/api/attachments/${attachment.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, driveTrashed: true });
    assert.deepEqual(google.trashed, ['drive-plan-1']);
    assert.equal((await api.get(`/api/files/${attachment.stored}`)).status, 404);
    assert.equal((await api.get('/api/state')).body.procedure_attachments.length, 0);
  } finally { await api.close(); }
});

test('exemplaire Drive partagé par une copie locale : conservé', async () => {
  const google = fakeGoogle();
  const api = await startApi({ google });
  try {
    const { entry, attachment } = await withDriveAttachment(api, 'drive-partage');
    const copy = await api.post(`/api/entries/${entry.id}/copy`);
    assert.equal(copy.status, 201, JSON.stringify(copy.body));
    const res = await api.del(`/api/attachments/${attachment.id}`);
    assert.deepEqual(res.body, { ok: true, driveTrashed: false });
    assert.deepEqual(google.trashed, []);
  } finally { await api.close(); }
});

test('Drive injoignable ou déconnecté : la suppression locale réussit quand même', async () => {
  for (const google of [fakeGoogle({ failing: true }), fakeGoogle({ connected: false }), null]) {
    const api = await startApi({ google });
    try {
      const { attachment } = await withDriveAttachment(api, 'drive-hors-ligne');
      const res = await api.del(`/api/attachments/${attachment.id}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.driveTrashed, false);
      assert.equal(api.db.prepare('SELECT COUNT(*) n FROM attachments').get().n, 0);
    } finally { await api.close(); }
  }
});

test('pièce jointe locale seule : aucun appel à Drive', async () => {
  const google = fakeGoogle();
  const api = await startApi({ google });
  try {
    const entry = await make.entry(api, { title: 'Note' });
    const upload = await api.upload('note.txt', 'texte', { entry_id: entry.id });
    assert.deepEqual((await api.del(`/api/attachments/${upload.body.id}`)).body, { ok: true, driveTrashed: false });
    assert.deepEqual(google.trashed, []);
  } finally { await api.close(); }
});
