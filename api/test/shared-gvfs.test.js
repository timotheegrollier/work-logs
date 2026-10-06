import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApi } from './helpers.js';
import { createSharedIo } from '../src/shared-io.js';

/**
 * Un partage ouvert par Nemo vit sous `/run/user/<uid>/gvfs` (FUSE). GVFS y refuse
 * les lectures positionnées (`ESPIPE`) : WorkLogs doit lire séquentiellement.
 * On le vérifie sur une archive montée par GVFS — même FUSE, sans serveur SMB.
 * Ignoré là où GVFS ne tourne pas (CI, conteneur).
 */
function mountArchive() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-gvfs-'));
  fs.writeFileSync(path.join(dir, 'notes.md'), '# Consignes\n');
  fs.writeFileSync(path.join(dir, 'relevés.csv'), 'a;b\r\n1;2\r\n');
  const zip = path.join(dir, 'partage.zip');
  try {
    execFileSync('zip', ['-q', '-j', zip, path.join(dir, 'notes.md'), path.join(dir, 'relevés.csv')]);
    const uri = 'archive://' + encodeURIComponent('file://' + zip);
    execFileSync('gio', ['mount', uri], { timeout: 10_000, stdio: 'ignore' });
    const gvfs = `/run/user/${os.userInfo().uid}/gvfs`;
    // Le nom du montage contient le chemin de l'archive : on vise exactement la nôtre.
    const mounted = fs.readdirSync(gvfs).map((name) => path.join(gvfs, name)).find((candidate) => candidate.includes(path.basename(dir)));
    if (!mounted) return null;
    return {
      root: mounted,
      cleanup: () => {
        try { execFileSync('gio', ['mount', '-u', mounted], { stdio: 'ignore', timeout: 10_000 }); } catch {}
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
}

test('montage GVFS (Nemo) : état, liste et lecture des fichiers, sans lecture positionnée', async (t) => {
  const archive = mountArchive();
  if (!archive) {
    t.skip('GVFS indisponible ici');
    return;
  }
  const api = await startApi({ shared: { root: archive.root, io: createSharedIo() } });
  try {
    const status = (await api.get('/api/shared/status')).body;
    assert.equal(status.reach, 'ok');
    assert.equal(status.mount, 'gvfs');
    const listing = (await api.get('/api/shared/list')).body;
    assert.deepEqual(listing.entries.map((entry) => entry.name).sort(), ['notes.md', 'relevés.csv']);
    const file = await api.get('/api/shared/file?path=notes.md');
    assert.equal(file.status, 200, JSON.stringify(file.body));
    const bytes = await (await fetch(`${api.base}/api/shared/content?hash=${file.body.hash}`)).text();
    assert.equal(bytes, '# Consignes\n');
  } finally {
    await api.close();
    archive.cleanup();
  }
});
