import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApi, make, officeOwnerFile } from './helpers.js';
import { createSharedIo } from '../src/shared-io.js';

const q = encodeURIComponent;
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/**
 * Dossiers du partage : créer, renommer, supprimer (`/api/shared/dir`). Le
 * « partage » est un dossier temporaire : le test y joue le collègue du TSE.
 * `hook` laisse un test agir au milieu d'une opération (un collègue qui
 * enregistre pendant la suppression).
 */
describe('dossier partagé : les dossiers', () => {
  let api;
  let share;
  let hook;

  const write = (rel, contents) => {
    fs.mkdirSync(path.dirname(path.join(share, rel)), { recursive: true });
    fs.writeFileSync(path.join(share, rel), contents);
  };
  const exists = (rel) => fs.existsSync(path.join(share, rel));
  const read = (rel) => fs.readFileSync(path.join(share, rel), 'utf8');
  const open = (rel) => api.get(`/api/shared/file?path=${q(rel)}`);
  const list = async (dir = '') => (await api.get(`/api/shared/list${dir ? `?dir=${q(dir)}` : ''}`)).body.entries.map((entry) => entry.name);
  const mkdir = (rel) => api.post(`/api/shared/dir?path=${q(rel)}`);
  const rename = (rel, name) => api.post(`/api/shared/dir/rename?path=${q(rel)}`, { name });
  const summary = (rel) => api.get(`/api/shared/dir?path=${q(rel)}`);
  const removeDir = (rel, expect) => api.del(`/api/shared/dir?path=${q(rel)}${expect ? `&expect=${q(expect)}` : ''}`);
  const removeChecked = async (rel) => removeDir(rel, (await summary(rel)).body.token);
  const draft = (rel, model, file) =>
    api.put(`/api/shared/draft?path=${q(rel)}`, { model, template_hash: file.hash, base_hash: file.base_hash });

  beforeEach(async () => {
    share = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-share-dirs-'));
    hook = null;
    const real = createSharedIo();
    const io = {
      ...real,
      async call(op, args, options) {
        if (hook) await hook(op, args);
        return real.call(op, args, options);
      },
    };
    api = await startApi({ shared: { root: share, io } });
  });
  afterEach(async () => {
    await api.close();
    fs.rmSync(share, { recursive: true, force: true });
  });

  describe('créer', () => {
    test('à la racine et dans un sous-dossier : 201, visible dans l’arbre', async () => {
      const created = await mkdir('Sauvegardes');
      assert.equal(created.status, 201);
      assert.deepEqual(created.body, { path: 'Sauvegardes', name: 'Sauvegardes', type: 'dir' });
      assert.ok(fs.statSync(path.join(share, 'Sauvegardes')).isDirectory());
      assert.equal((await mkdir('Sauvegardes/2026')).status, 201);
      assert.deepEqual(await list('Sauvegardes'), ['2026']);
      // Un nom de dossier fait de chiffres (une date) est un vrai dossier, pas un temporaire de Word.
      assert.equal((await mkdir('20241231')).status, 201);
      assert.deepEqual(await list(), ['20241231', 'Sauvegardes']);
    });

    test('nom déjà pris, par un dossier ou un fichier : 409, rien n’est touché', async () => {
      write('Procédures/consignes.md', 'à garder\n');
      write('notes.md', 'x\n');
      const taken = await mkdir('Procédures');
      assert.equal(taken.status, 409);
      assert.equal(taken.body.code, 'SHARED_EXISTS');
      assert.match(taken.body.error, /« Procédures » existe déjà/);
      assert.equal(read('Procédures/consignes.md'), 'à garder\n');
      assert.equal((await mkdir('notes.md')).body.code, 'SHARED_EXISTS');
      assert.equal(read('notes.md'), 'x\n');
    });

    test('nom refusé par Windows, dossier caché, parent introuvable, chemin invalide', async () => {
      for (const name of ['a:b', 'Rapport.', 'Rapport ', 'CON', '.git']) {
        const refused = await mkdir(name);
        assert.equal(refused.status, 400, name);
        assert.equal(refused.body.code, 'SHARED_BAD_NAME', name);
      }
      assert.match((await mkdir('Rapport.')).body.error, /nom de dossier ne peut pas finir par un point/);
      assert.equal((await mkdir('Absent/Nouveau')).status, 404);
      assert.equal((await mkdir('../dehors')).status, 400);
      assert.equal((await api.post('/api/shared/dir?path=')).status, 400);
      assert.deepEqual(fs.readdirSync(share), []);
    });
  });

  describe('renommer', () => {
    test('au même endroit, contenu intact, arbre à jour', async () => {
      write('Projets/Filtration/procédure.md', '# Filtration\n');
      const { status, body } = await rename('Projets', 'Chantiers');
      assert.equal(status, 200);
      assert.deepEqual(body, { path: 'Chantiers', name: 'Chantiers' });
      assert.equal(exists('Projets'), false);
      assert.equal(read('Chantiers/Filtration/procédure.md'), '# Filtration\n');
      assert.deepEqual(await list(), ['Chantiers']);
      // Sous-dossier : il reste dans son parent.
      assert.deepEqual((await rename('Chantiers/Filtration', 'Traitement')).body, { path: 'Chantiers/Traitement', name: 'Traitement' });
      assert.equal(read('Chantiers/Traitement/procédure.md'), '# Filtration\n');
    });

    test('ce qui est gardé ici suit : historique, fichier ouvert, projet relié, arbre hors ligne', async () => {
      write('Projets/Filtration/procédure.md', '# Filtration\n');
      await list('Projets/Filtration');
      const opened = (await open('Projets/Filtration/procédure.md')).body;
      const project = await make.project(api, 'Station');
      await api.put(`/api/shared/projects/${project.id}/folder`, { dir: 'Projets/Filtration' });

      assert.equal((await rename('Projets', 'Chantiers')).status, 200);
      const versions = (await api.get(`/api/shared/versions?path=${q('Chantiers/Filtration/procédure.md')}`)).body.versions;
      assert.ok(versions.some((version) => version.hash === opened.hash), 'l’historique suit le fichier');
      assert.equal((await api.get(`/api/shared/versions?path=${q('Projets/Filtration/procédure.md')}`)).body.versions.length, 0);
      const reopened = (await open('Chantiers/Filtration/procédure.md')).body;
      assert.equal(reopened.base_hash, opened.hash);
      assert.equal((await api.get('/api/shared/status')).body.projects[project.id], 'Chantiers/Filtration');
      assert.ok(api.db.prepare("SELECT 1 FROM shared_dirs WHERE rel_dir='Chantiers/Filtration'").get(), 'la liste gardée suit');
      assert.equal(api.db.prepare("SELECT COUNT(*) n FROM shared_dirs WHERE rel_dir LIKE 'Projets%'").get().n, 0);
    });

    test('nom déjà pris ou refusé : rien n’est renommé ; même nom : rien à faire', async () => {
      write('A/a.md', 'a\n');
      write('B/b.md', 'b\n');
      const taken = await rename('A', 'B');
      assert.equal(taken.status, 409);
      assert.equal(taken.body.code, 'SHARED_EXISTS');
      assert.equal(read('A/a.md'), 'a\n');
      assert.equal(read('B/b.md'), 'b\n');
      // Un dossier vide du même nom n'est pas remplacé non plus (rename(2) le ferait).
      fs.mkdirSync(path.join(share, 'Vide'));
      assert.equal((await rename('A', 'Vide')).body.code, 'SHARED_EXISTS');
      assert.equal(read('A/a.md'), 'a\n');
      for (const name of ['a/b', 'A.', '', '.cache']) assert.equal((await rename('A', name)).status, 400, name);
      assert.deepEqual((await rename('A', 'A')).body, { path: 'A', name: 'A' });
      assert.equal((await rename('Absent', 'C')).status, 404);
      assert.equal((await rename('A/a.md', 'C')).body.code, 'SHARED_NOT_DIR');
      assert.equal((await rename('', 'C')).status, 400);
    });

    test('changer seulement la casse : par un nom provisoire (Windows ne distingue pas les deux)', async () => {
      write('procedures/a.md', 'a\n');
      const renames = [];
      hook = (op, args) => { if (op === 'renameDir') renames.push(args[2]); };
      const { status, body } = await rename('procedures', 'Procedures');
      assert.equal(status, 200);
      assert.equal(body.path, 'Procedures');
      assert.deepEqual(fs.readdirSync(share), ['Procedures']);
      assert.equal(read('Procedures/a.md'), 'a\n');
      assert.match(path.basename(renames[0]), /^\.~worklogs-[0-9a-f]{12}$/);
      await rename('Procedures', 'Consignes');
      assert.equal(renames[1], null, 'un vrai changement de nom se fait directement');
    });

    test('un brouillon dans le dossier : refusé, rien n’est renommé', async () => {
      write('Projets/notes.md', 'v1\n');
      const file = (await open('Projets/notes.md')).body;
      await draft('Projets/notes.md', { text: 'v2' }, file);
      const refused = await rename('Projets', 'Chantiers');
      assert.equal(refused.status, 409);
      assert.equal(refused.body.code, 'SHARED_DRAFT_OPEN');
      assert.match(refused.body.error, /« Projets\/notes\.md » a un brouillon/);
      assert.equal(exists('Projets/notes.md'), true);
    });

    test('un fichier ouvert par un collègue : refusé avec son nom', async () => {
      write('Projets/Sous/relevés.xlsx', 'xlsx');
      write('Projets/Sous/~$relevés.xlsx', officeOwnerFile('Jean Dupont', { excel: true }));
      const refused = await rename('Projets', 'Chantiers');
      assert.equal(refused.status, 409);
      assert.equal(refused.body.code, 'SHARED_LOCKED');
      assert.match(refused.body.error, /« Projets\/Sous\/relevés\.xlsx » est ouvert par Jean Dupont dans Excel/);
      assert.equal(exists('Projets'), true);
    });

    test('notre propre main sur un fichier du dossier est rendue avant de renommer', async () => {
      write('Projets/notes.md', 'v1\n');
      await open('Projets/notes.md');
      assert.equal((await api.post(`/api/shared/lock?path=${q('Projets/notes.md')}`, {})).status, 200);
      assert.equal(exists('Projets/.~lock.notes.md#'), true);
      assert.equal((await rename('Projets', 'Chantiers')).status, 200);
      assert.deepEqual(fs.readdirSync(path.join(share, 'Chantiers')), ['notes.md']);
      assert.equal(api.db.prepare('SELECT lock_nonce FROM shared_files WHERE rel_path=?').get('Chantiers/notes.md').lock_nonce, null);
    });
  });

  describe('supprimer', () => {
    test('le bilan dit ce qui partirait ; un dossier vide se supprime', async () => {
      write('Archives/2024/bilan.md', '# Bilan\n');
      write('Archives/lisez-moi.txt', 'x');
      write('Archives/Thumbs.db', 'vignettes');
      const { status, body } = await summary('Archives');
      assert.equal(status, 200);
      assert.equal(body.name, 'Archives');
      assert.equal(body.files, 2, 'les fichiers techniques ne comptent pas');
      assert.equal(body.dirs, 1);
      assert.equal(body.size, 9);
      assert.match(body.token, /^[0-9a-f]{64}$/);

      fs.mkdirSync(path.join(share, 'Vide'));
      const empty = (await summary('Vide')).body;
      assert.deepEqual([empty.files, empty.dirs], [0, 0]);
      const removed = await removeDir('Vide', empty.token);
      assert.equal(removed.status, 200);
      assert.equal(removed.body.deleted, true);
      assert.equal(exists('Vide'), false);
    });

    test('avec son contenu : tout part, chaque fichier reste gardé sur cet ordinateur', async () => {
      write('Archives/2024/bilan.md', '# Bilan\n');
      write('Archives/lisez-moi.txt', 'x');
      write('Archives/Thumbs.db', 'vignettes');
      write('garde.md', 'gardé\n');
      const project = await make.project(api, 'Archives');
      await api.put(`/api/shared/projects/${project.id}/folder`, { dir: 'Archives/2024' });
      await open('Archives/lisez-moi.txt');

      const { status, body } = await removeChecked('Archives');
      assert.equal(status, 200);
      assert.deepEqual({ files: body.files, dirs: body.dirs }, { files: 2, dirs: 2 });
      assert.equal(exists('Archives'), false);
      assert.equal(read('garde.md'), 'gardé\n');
      const versions = (await api.get(`/api/shared/versions?path=${q('Archives/2024/bilan.md')}`)).body.versions;
      const kept = await fetch(`${api.base}/api/shared/content?hash=${versions[0].hash}`);
      assert.equal(await kept.text(), '# Bilan\n', 'les octets supprimés restent ici');
      assert.equal(api.db.prepare("SELECT COUNT(*) n FROM shared_files WHERE rel_path LIKE 'Archives/%'").get().n, 0);
      assert.equal((await api.get('/api/shared/status')).body.projects[project.id], undefined, 'le lien vers le dossier tombe');
    });

    test('sans empreinte, ou dossier changé depuis le bilan : rien n’est supprimé', async () => {
      write('Archives/a.md', 'a\n');
      const before = (await summary('Archives')).body;
      assert.equal((await removeDir('Archives')).body.code, 'SHARED_STALE');
      write('Archives/b.md', 'arrivé après le bilan\n');
      const stale = await removeDir('Archives', before.token);
      assert.equal(stale.status, 409);
      assert.equal(stale.body.code, 'SHARED_STALE');
      assert.equal(read('Archives/a.md'), 'a\n');
      assert.equal(read('Archives/b.md'), 'arrivé après le bilan\n');
    });

    test('un fichier modifié pendant la suppression : on s’arrête, il est gardé, le reste est dit', async () => {
      write('Archives/a.md', 'a\n');
      write('Archives/b.md', 'b\n');
      const { token } = (await summary('Archives')).body;
      // Un collègue enregistre l'autre fichier juste après le premier effacement demandé.
      let first = null;
      hook = (op, args) => {
        if (op !== 'deleteSeen' || first) return;
        first = path.basename(args[0]);
        write(`Archives/${first === 'a.md' ? 'b.md' : 'a.md'}`, 'version du collègue, plus longue\n');
      };
      const stopped = await removeDir('Archives', token);
      assert.equal(stopped.status, 409);
      assert.equal(stopped.body.code, 'SHARED_DIR_PARTIAL');
      assert.match(stopped.body.error, /a changé entre-temps : il est gardé\. 1 fichier déjà supprimé \(gardé sur cet ordinateur\), le reste est intact\./);
      const other = first === 'a.md' ? 'b.md' : 'a.md';
      assert.equal(exists(`Archives/${first}`), false);
      assert.equal(read(`Archives/${other}`), 'version du collègue, plus longue\n');
      const versions = (await api.get(`/api/shared/versions?path=${q(`Archives/${first}`)}`)).body.versions;
      assert.equal(versions[0].hash, sha256(Buffer.from(first === 'a.md' ? 'a\n' : 'b\n')));
    });

    test('un fichier arrivé dans un sous-dossier pendant la suppression : ce dossier est gardé', async () => {
      write('Archives/2024/bilan.md', '# Bilan\n');
      const { token } = (await summary('Archives')).body;
      hook = (op, args) => {
        if (op === 'rmdir' && args[0].endsWith(`${path.sep}2024`) && !exists('Archives/2024/nouveau.md')) write('Archives/2024/nouveau.md', 'nouveau\n');
      };
      const stopped = await removeDir('Archives', token);
      assert.equal(stopped.body.code, 'SHARED_DIR_PARTIAL');
      assert.match(stopped.body.error, /« Archives\/2024 » n’est pas vide : un fichier y est arrivé entre-temps, ou ton compte ne le voit pas\. Ce dossier est gardé\./);
      assert.equal(read('Archives/2024/nouveau.md'), 'nouveau\n');
      assert.equal(exists('Archives/2024/bilan.md'), false);
    });

    test('un fichier ouvert par un collègue, un brouillon ici : refusé avant de rien toucher', async () => {
      write('Archives/planning.txt', 'lundi\n');
      write('Archives/.~lock.planning.txt#', 'Hélène Martin,hmartin,TSE01,05.10.2026 09:00,file:///C:/Users/hmartin;');
      const locked = await summary('Archives');
      assert.equal(locked.status, 409);
      assert.equal(locked.body.code, 'SHARED_LOCKED');
      assert.match(locked.body.error, /« Archives\/planning\.txt » est ouvert par Hélène Martin dans LibreOffice/);
      fs.rmSync(path.join(share, 'Archives/.~lock.planning.txt#'));
      const { token } = (await summary('Archives')).body;
      write('Archives/.~lock.planning.txt#', 'Hélène Martin,hmartin,TSE01,05.10.2026 09:00,file:///C:/Users/hmartin;');
      assert.equal((await removeDir('Archives', token)).body.code, 'SHARED_LOCKED');
      assert.equal(read('Archives/planning.txt'), 'lundi\n');

      write('Brouillons/notes.md', 'v1\n');
      const file = (await open('Brouillons/notes.md')).body;
      await draft('Brouillons/notes.md', { text: 'v2' }, file);
      const refused = await summary('Brouillons');
      assert.equal(refused.body.code, 'SHARED_DRAFT_OPEN');
      assert.match(refused.body.error, /envoie-le ou abandonne-le avant de supprimer ce dossier/);
      assert.equal(read('Brouillons/notes.md'), 'v1\n');
    });

    test('un lien ou un dossier caché dedans, ou trop de fichiers : à faire depuis Windows', async () => {
      write('Outils/.git/HEAD', 'ref\n');
      const hidden = await summary('Outils');
      assert.equal(hidden.body.code, 'SHARED_DIR_SPECIAL');
      assert.match(hidden.body.error, /« Outils\/\.git » est un lien ou un dossier caché/);

      write('Liens/a.md', 'a\n');
      fs.symlinkSync(path.join(share, 'Outils'), path.join(share, 'Liens', 'raccourci'));
      assert.equal((await summary('Liens')).body.code, 'SHARED_DIR_SPECIAL');
      assert.equal(exists('Outils/.git/HEAD'), true);

      for (let i = 0; i <= 300; i++) write(`Gros/f${i}.txt`, 'x');
      const big = await summary('Gros');
      assert.equal(big.body.code, 'SHARED_DIR_TOO_BIG');
      assert.equal(fs.readdirSync(path.join(share, 'Gros')).length, 301);
      // Un seul fichier trop lourd pour être gardé ici (fichier creux : rien n'est écrit sur le disque).
      write('Lourd/image.iso', '');
      fs.truncateSync(path.join(share, 'Lourd', 'image.iso'), 101 * 1024 * 1024);
      assert.equal((await summary('Lourd')).body.code, 'SHARED_DIR_TOO_BIG');
    });

    test('ni la racine, ni un fichier, ni un dossier absent', async () => {
      write('notes.md', 'x\n');
      assert.equal((await summary('')).status, 400);
      assert.equal((await removeDir('', 'x')).status, 400);
      assert.equal((await summary('notes.md')).body.code, 'SHARED_NOT_DIR');
      assert.equal((await summary('Absent')).status, 404);
      assert.equal((await summary('../dehors')).status, 400);
      assert.equal(read('notes.md'), 'x\n');
    });
  });
});
