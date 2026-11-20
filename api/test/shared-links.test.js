import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApi, make } from './helpers.js';
import { buildBackup, restoreBackup } from '../src/backup.js';
import { validateBackup } from '../src/backup-format.js';
import { mergeSnapshots } from '../src/sync-merge.js';
import { addressFromGvfsPath, addressFromMountinfo } from '../src/shared-address.js';
import { openDb } from '../src/db.js';
import { createSharedService } from '../src/shared-service.js';

const LINK = '\\\\172.16.1.20\\d\\Global\\MURGAT INGENIERIE\\13. SI\\00. PROCEDURE\\2. TSE';

describe('dossier du TSE relié à un projet : porté par le projet, synchronisé par Drive', () => {
  test('créé, modifié, effacé avec le projet ; exporté et restauré (sauvegarde Drive)', async () => {
    const api = await startApi();
    try {
      const project = await make.project(api, 'TSE');
      assert.equal(project.shared_dir ?? null, null);
      const linked = await api.put(`/api/projects/${project.id}`, { shared_dir: LINK });
      assert.equal(linked.body.shared_dir, LINK);
      assert.equal(linked.body.name, 'TSE', 'le reste du projet est intact');
      const state = (await api.get('/api/state')).body;
      assert.equal(state.projects.find((row) => row.id === project.id).shared_dir, LINK);

      const backup = buildBackup(api.db);
      assert.equal(backup.projects.find((row) => row.id === project.id).shared_dir, LINK);
      restoreBackup(api.db, validateBackup(JSON.parse(JSON.stringify(backup))));
      assert.equal(api.db.prepare('SELECT shared_dir FROM projects WHERE id=?').get(project.id).shared_dir, LINK);

      assert.equal((await api.put(`/api/projects/${project.id}`, { shared_dir: null })).body.shared_dir, null);
      assert.equal((await api.put(`/api/projects/${project.id}`, { shared_dir: 'a\u0001b' })).status, 400);
      assert.equal((await api.post('/api/projects', { name: 'Bassins', shared_dir: LINK })).body.shared_dir, LINK);
    } finally {
      await api.close();
    }
  });

  test('plusieurs dossiers ordonnés survivent aux éditions, à la sauvegarde et au retour au contrat historique', async () => {
    const api = await startApi();
    try {
      const second = `${LINK}\\Archives`;
      const created = await api.post('/api/projects', { name: 'TSE', shared_dirs: [LINK, second, LINK] });
      assert.equal(created.status, 201);
      const { id } = created.body;
      assert.deepEqual(created.body.shared_dirs, [LINK, second]);
      assert.equal(created.body.shared_dir, LINK);
      assert.deepEqual((await api.put(`/api/projects/${id}`, { name: 'TSE renommé' })).body.shared_dirs, [LINK, second]);
      assert.deepEqual((await api.get('/api/state')).body.projects.find((row) => row.id === id).shared_dirs, [LINK, second]);
      const backup = buildBackup(api.db);
      assert.deepEqual(backup.projects[0].shared_dirs, [LINK, second]);
      restoreBackup(api.db, JSON.parse(JSON.stringify(backup)));
      assert.deepEqual((await api.get('/api/state')).body.projects[0].shared_dirs, [LINK, second]);
      assert.equal(api.db.prepare('SELECT shared_dir FROM projects WHERE id=?').get(id).shared_dir, LINK);
      assert.deepEqual((await api.put(`/api/projects/${id}`, { shared_dirs: [second, LINK] })).body.shared_dirs, [second, LINK]);
      const legacy = await api.put(`/api/projects/${id}`, { shared_dir: LINK });
      assert.deepEqual(legacy.body.shared_dirs, [LINK]);
      const cleared = await api.put(`/api/projects/${id}`, { shared_dirs: [], shared_dir: LINK });
      assert.equal(cleared.body.shared_dir, null);
      assert.deepEqual(cleared.body.shared_dirs, []);
      for (const shared_dirs of [null, LINK, [17], ['bad\u0001folder']]) {
        assert.equal((await api.put(`/api/projects/${id}`, { shared_dirs })).status, 400);
      }
    } finally { await api.close(); }
  });

  test('ancienne base : le lien singulier est repris au redémarrage sans modifier son horloge', async () => {
    const api = await startApi();
    try {
      const created = await make.project(api, 'Ancien');
      api.db.prepare('UPDATE projects SET shared_dir=? WHERE id=?').run(LINK, created.id);
      api.db.exec('ALTER TABLE projects DROP COLUMN shared_dirs');
      const file = path.join(api.dir, 'worklogs.db');
      const reopened = openDb(file, { withSeed: false });
      try {
        const project = buildBackup(reopened).projects[0];
        assert.deepEqual(project.shared_dirs, [LINK]);
        assert.equal(project.shared_dir, LINK);
        assert.equal(project.updated_at, created.updated_at);
      } finally { reopened.close(); }
    } finally { await api.close(); }
  });

  test('les instantanés récents remplacent toute la liste, anciennes éditions et déliaison comprises', () => {
    const project = { id: 'pr_multi', name: 'TSE', color: '#000', created_at: '2026-10-01T00:00:00Z' };
    const second = `${LINK}\\Archives`;
    const empty = { entries: [], tasks: [], task_entries: [], google_documents: [], attachments: [], deleted: [] };
    const snapshot = (fields) => ({ ...empty, projects: [{ ...project, ...fields }] });
    const old = snapshot({ shared_dir: LINK, updated_at: '2026-10-06T10:00:00Z' });
    const multiple = snapshot({ shared_dir: LINK, shared_dirs: [LINK, second], updated_at: '2026-10-07T09:00:00Z' });
    assert.deepEqual(mergeSnapshots(old, multiple).merged.projects[0].shared_dirs, [LINK, second]);
    const renamedByOldClient = validateBackup({ version: 2, ...snapshot({ name: 'Renommé', shared_dir: LINK, updated_at: '2026-10-07T09:30:00Z' }) });
    assert.deepEqual(mergeSnapshots(multiple, renamedByOldClient).merged.projects[0].shared_dirs, [LINK, second]);
    assert.deepEqual(mergeSnapshots(renamedByOldClient, multiple).merged.projects[0].shared_dirs, [LINK, second]);
    const explicitSingleton = snapshot({ shared_dirs: [LINK], updated_at: '2026-10-07T09:45:00Z' });
    assert.deepEqual(mergeSnapshots(multiple, explicitSingleton).merged.projects[0].shared_dirs, [LINK]);
    const legacy = snapshot({ shared_dir: second, updated_at: '2026-10-07T10:00:00Z' });
    assert.deepEqual(mergeSnapshots(multiple, legacy).merged.projects[0].shared_dirs, [second]);
    const cleared = snapshot({ shared_dirs: [], updated_at: '2026-10-07T11:00:00Z' });
    assert.deepEqual(mergeSnapshots(multiple, cleared).merged.projects[0].shared_dirs, []);
    assert.equal(mergeSnapshots(multiple, cleared).merged.projects[0].shared_dir, null);
    const backup = validateBackup({ version: 2, ...multiple });
    assert.deepEqual(backup.projects[0].shared_dirs, [LINK, second]);
    const singleton = validateBackup({ version: 2, ...legacy });
    assert.equal(singleton.projects[0].shared_dir, second);
    assert.equal(Object.hasOwn(singleton.projects[0], 'shared_dirs'), false);
  });

  test('synchro Drive : le dossier relié sur le téléphone arrive sur le PC (la version la plus récente gagne)', () => {
    const project = (shared_dir, updated_at) => ({ id: 'pr_t', name: 'TSE', color: '#000', created_at: '2026-10-01T00:00:00Z', updated_at, shared_dir });
    const empty = { entries: [], tasks: [], task_entries: [], google_documents: [], attachments: [], deleted: [] };
    const pc = { ...empty, projects: [project(null, '2026-10-06T10:00:00Z')] };
    const phone = { ...empty, projects: [project(LINK, '2026-10-07T09:00:00Z')] };
    assert.equal(mergeSnapshots(pc, phone).merged.projects[0].shared_dir, LINK);
    // Délié ensuite sur le PC : la suppression du lien gagne à son tour.
    const unlinked = { ...empty, projects: [project(null, '2026-10-07T10:00:00Z')] };
    assert.equal(mergeSnapshots(unlinked, phone).merged.projects[0].shared_dir, null);
  });

  test('ancienne sauvegarde sans le champ : acceptée, aucun dossier relié', () => {
    const backup = validateBackup({
      version: 2, projects: [{ id: 'pr_a', name: 'A', color: '#000', created_at: '2026-01-01T00:00:00Z' }],
      entries: [], tasks: [], task_entries: [], attachments: [],
    });
    assert.equal(backup.projects[0].shared_dir, null);
  });
});

describe('adresse Windows de la racine de cet appareil', () => {
  test('montage GVFS (desktop) : déduite du nom du montage', () => {
    assert.equal(
      addressFromGvfsPath('/run/user/1000/gvfs/smb-share:domain=SRVMURGAT,server=172.16.1.20,share=d,user=Timoth%C3%A9eG/Global/MURGAT INGENIERIE/13. SI/00. PROCEDURE'),
      '\\\\172.16.1.20\\d\\Global\\MURGAT INGENIERIE\\13. SI\\00. PROCEDURE',
    );
    assert.equal(addressFromGvfsPath('/run/user/1000/gvfs/smb-share:server=tse01,share=commun'), '\\\\tse01\\commun');
    assert.equal(addressFromGvfsPath('/home/timo/partage'), null);
  });

  test('montage CIFS (relais) : lue dans /proc/self/mountinfo, sous-dossiers et espaces compris', () => {
    const mountinfo = [
      '35 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw',
      '510 30 0:52 / /mnt/tse-procedures rw,relatime shared:298 - autofs systemd-1 rw,fd=71',
      '512 510 0:93 / /mnt/tse-procedures rw,relatime shared:300 - cifs //172.16.1.20/D/Global/MURGAT\\040INGENIERIE/13.\\040SI/00.\\040PROCEDURE rw,vers=3.0',
    ].join('\n');
    assert.equal(addressFromMountinfo('/mnt/tse-procedures', mountinfo), '\\\\172.16.1.20\\D\\Global\\MURGAT INGENIERIE\\13. SI\\00. PROCEDURE');
    assert.equal(addressFromMountinfo('/mnt/tse-procedures/2. TSE', mountinfo), '\\\\172.16.1.20\\D\\Global\\MURGAT INGENIERIE\\13. SI\\00. PROCEDURE\\2. TSE');
    assert.equal(addressFromMountinfo('/srv/local', mountinfo), null);
  });

  test('le statut du dossier partagé la donne : déduite d’un chemin GVFS, ou fournie (relais)', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-adresse-'));
    const root = path.join(base, 'gvfs', 'smb-share:server=172.16.1.20,share=d', 'Global');
    fs.mkdirSync(root, { recursive: true });
    const db = openDb(path.join(base, 'w.db'), { withSeed: false });
    const derived = createSharedService({ db, blobDir: path.join(base, 'b1'), root });
    const given = createSharedService({ db, blobDir: path.join(base, 'b2'), root, address: '\\\\SRVMURGAT\\D\\Global' });
    try {
      assert.equal((await derived.status()).address, '\\\\172.16.1.20\\d\\Global');
      assert.equal((await given.status()).address, '\\\\SRVMURGAT\\D\\Global');
    } finally {
      await derived.stop();
      await given.stop();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
