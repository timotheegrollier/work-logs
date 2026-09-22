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
