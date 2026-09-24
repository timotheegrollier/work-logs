import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareOpenCopy, safeFilename } from '../open-file.mjs';

function dirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-open-'));
  const uploadDir = path.join(root, 'uploads');
  fs.mkdirSync(uploadDir);
  return { root, uploadDir, tmpDir: path.join(root, 'tmp') };
}

test('copie en lecture seule, sous son vrai nom, l’original intact', () => {
  const { uploadDir, tmpDir } = dirs();
  fs.writeFileSync(path.join(uploadDir, 'at_x1.ods'), 'PK tableur');
  const opened = prepareOpenCopy({ uploadDir, tmpDir, stored: 'at_x1.ods', filename: 'Budget 2026.ods' });
  assert.equal(path.basename(opened), 'Budget 2026.ods');
  assert.equal(fs.readFileSync(opened, 'utf8'), 'PK tableur');
  assert.equal(fs.statSync(opened).mode & 0o777, 0o400);
  // Rouvrir après une mise à jour du fichier : la copie suit.
  fs.writeFileSync(path.join(uploadDir, 'at_x1.ods'), 'PK v2');
  assert.equal(fs.readFileSync(prepareOpenCopy({ uploadDir, tmpDir, stored: 'at_x1.ods', filename: 'Budget 2026.ods' }), 'utf8'), 'PK v2');
  assert.notEqual(opened, path.join(uploadDir, 'at_x1.ods'));
});

test('refuse la traversée, l’absent et les exécutables', () => {
  const { uploadDir, tmpDir } = dirs();
  fs.writeFileSync(path.join(uploadDir, 'at_x2.desktop'), '[Desktop Entry]');
  fs.writeFileSync(path.join(uploadDir, 'at_x3.txt'), 'texte');
  assert.throws(() => prepareOpenCopy({ uploadDir, tmpDir, stored: '../worklogs.db', filename: 'a' }), /invalide/);
  assert.throws(() => prepareOpenCopy({ uploadDir, tmpDir, stored: 'at_nope.pdf', filename: 'a.pdf' }), /absent/);
  assert.throws(() => prepareOpenCopy({ uploadDir, tmpDir, stored: 'at_x2.desktop', filename: 'lanceur.desktop' }), /\.desktop/);
  // Un nom trompeur ne suffit pas à contourner le refus.
  assert.throws(() => prepareOpenCopy({ uploadDir, tmpDir, stored: 'at_x3.txt', filename: 'script.sh' }), /\.sh/);
});

test('nom de fichier nettoyé', () => {
  assert.equal(safeFilename('../../etc/passwd', 'x'), 'passwd');
  assert.equal(safeFilename('.cache', 'x'), 'cache');
  assert.equal(safeFilename('', 'at_1.ods'), 'at_1.ods');
});

test('lancement détaché : répond sans attendre la fermeture de l’application', async () => {
  const { launchDetached } = await import('../open-file.mjs');
  const { EventEmitter } = await import('node:events');
  const fake = (behaviour) => (command, args, options) => {
    const child = Object.assign(new EventEmitter(), { unrefed: false, unref() { this.unrefed = true; } });
    fake.last = { command, args, options, child };
    setImmediate(() => behaviour(child));
    return child;
  };
  // L'application reste ouverte indéfiniment : réponse après le délai de grâce.
  const started = Date.now();
  assert.equal(await launchDetached('/tmp/a.docx', { platform: 'linux', settleMs: 50, spawnImpl: fake((c) => c.emit('spawn')) }), '');
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(fake.last.args, ['/tmp/a.docx']);
  assert.equal(fake.last.options.detached, true);
  assert.equal(fake.last.child.unrefed, true);
  // xdg-open qui rend la main tout de suite : succès ou échec lisible.
  assert.equal(await launchDetached('/tmp/a', { platform: 'linux', settleMs: 5000, spawnImpl: fake((c) => { c.emit('spawn'); c.emit('exit', 0); }) }), '');
  assert.match(await launchDetached('/tmp/a', { platform: 'linux', settleMs: 5000, spawnImpl: fake((c) => { c.emit('spawn'); c.emit('exit', 3); }) }), /code 3/);
  // Commande absente : repli, lui-même borné s'il ne répond jamais.
  assert.equal(await launchDetached('/tmp/a', { platform: 'linux', spawnImpl: fake((c) => c.emit('error', new Error('ENOENT'))), fallback: async () => 'refus' }), 'refus');
  assert.equal(await launchDetached('/tmp/a', { platform: 'darwin', fallback: () => new Promise(() => {}), fallbackTimeoutMs: 30 }), '');
  assert.match(await launchDetached('/tmp/a', { platform: 'linux', spawnImpl: fake((c) => c.emit('error', new Error('ENOENT'))) }), /aucun programme/);
});

test('lancement réel : un vrai processus détaché, sans attendre sa fin', async () => {
  const { launchDetached } = await import('../open-file.mjs');
  const started = Date.now();
  // `sleep 30` joue l'application qui reste ouverte.
  assert.equal(await launchDetached('30', { platform: 'linux', command: 'sleep', settleMs: 100 }), '');
  assert.ok(Date.now() - started < 2000);
  assert.match(await launchDetached('/nulle/part', { platform: 'linux', command: 'false', settleMs: 2000 }), /code 1/);
});
