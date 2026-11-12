import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkRelease } from './check-release.mjs';

/** Cas nominal : manifeste, lock et tag alignés. */
const aligned = (version = '0.6.12') => ({
  version,
  lockVersion: version,
  lockPackageVersion: version,
});

test('accepte une version alignée, avec ou sans tag', () => {
  assert.equal(checkRelease(aligned()), 'v0.6.12');
  assert.equal(checkRelease({ ...aligned(), tag: 'v0.6.12' }), 'v0.6.12');
  assert.equal(checkRelease(aligned('1.0.0-rc.2')), 'v1.0.0-rc.2');
});

test('refuse une version qui n’est pas du semver', () => {
  for (const version of ['0.6', 'v0.6.12', '0.6.12-dev', '', undefined]) {
    assert.throws(() => checkRelease({ ...aligned(), version, lockVersion: version, lockPackageVersion: version }), /Version invalide/);
  }
});

test('refuse un tag qui ne correspond pas au manifeste', () => {
  assert.throws(() => checkRelease({ ...aligned(), tag: 'v0.6.11' }), /doit correspondre à package\.json/);
});

test('refuse un package-lock.json resté en arrière', () => {
  assert.throws(
    () => checkRelease({ ...aligned(), lockVersion: '0.4.2' }),
    /désynchronisé \(version = 0\.4\.2, attendu 0\.6\.12\)/
  );
  assert.throws(
    () => checkRelease({ ...aligned(), lockPackageVersion: '0.4.2' }),
    /désynchronisé \(packages\[""\]\.version = 0\.4\.2/
  );
});

test('la remédiation proposée met bien à jour les deux fichiers', () => {
  assert.throws(() => checkRelease({ ...aligned(), lockVersion: '0.4.2' }), /npm version 0\.6\.12 --no-git-tag-version/);
});

test('refuse un lock dont la version manque', () => {
  assert.throws(() => checkRelease({ ...aligned(), lockPackageVersion: undefined }), /désynchronisé/);
});

test('en ligne de commande, un tag qui ne correspond pas arrête l’étape (code non nul)', () => {
  // La CI et le job `release` n'appellent que le script : sans cette exécution réelle, un
  // garde-fou devenu muet (détection du lancement direct cassée) sortirait en 0.
  const script = fileURLToPath(new URL('./check-release.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [script, 'v0.0.0'], { encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Le tag v0\.0\.0 doit correspondre à package\.json/);
});
