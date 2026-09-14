import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, planPrune, versionOf } from './prune-repo.mjs';

const rpm = (v) => `WorkLogs-${v}-linux-x86_64.rpm`;
const deb = (v) => `WorkLogs-${v}-linux-amd64.deb`;

test('versionOf lit la version dans les deux formats de nom', () => {
  assert.equal(versionOf(rpm('0.6.13')), '0.6.13');
  assert.equal(versionOf(deb('0.6.13')), '0.6.13');
  assert.equal(versionOf('/chemin/absolu/' + deb('0.10.2')), '0.10.2');
  assert.equal(versionOf('Packages.gz'), null);
  assert.equal(versionOf('worklogs.repo'), null);
});

test('compareVersions trie en semver, pas en texte', () => {
  // Le piège : en tri texte, « 0.6.9 » passerait après « 0.6.10 » et la purge
  // supprimerait la mauvaise version.
  assert.deepEqual(['0.6.9', '0.6.10', '0.6.2'].sort(compareVersions), ['0.6.2', '0.6.9', '0.6.10']);
  assert.deepEqual(['1.0.0', '0.9.9'].sort(compareVersions), ['0.9.9', '1.0.0']);
});

test('planPrune garde les N versions les plus récentes', () => {
  const files = ['0.6.9', '0.6.10', '0.6.11', '0.6.12', '0.6.13'].map(rpm);
  const { keep, remove, keptVersions } = planPrune(files, 3);

  assert.deepEqual(keptVersions, ['0.6.11', '0.6.12', '0.6.13']);
  assert.deepEqual(keep, [rpm('0.6.11'), rpm('0.6.12'), rpm('0.6.13')]);
  assert.deepEqual(remove, [rpm('0.6.9'), rpm('0.6.10')]);
});

test('planPrune ne supprime rien quand il y a moins de versions que demandé', () => {
  const files = [rpm('0.6.12'), rpm('0.6.13')];
  assert.deepEqual(planPrune(files, 3).remove, []);
  assert.deepEqual(planPrune([], 3).remove, []);
});

test('planPrune garde les fichiers sans version : index, clés, descripteurs', () => {
  // Supprimer Packages, Release ou worklogs.repo casserait le dépôt en silence.
  const files = [rpm('0.6.9'), rpm('0.6.13'), 'worklogs.repo', 'Packages.gz', 'Release'];
  const { keep, remove } = planPrune(files, 1);

  assert.deepEqual(remove, [rpm('0.6.9')]);
  for (const kept of ['worklogs.repo', 'Packages.gz', 'Release']) assert.ok(keep.includes(kept));
});

test('planPrune traite chaque format indépendamment du nom de fichier', () => {
  const files = [deb('0.6.11'), deb('0.6.12'), deb('0.6.13'), deb('0.7.0')];
  assert.deepEqual(planPrune(files, 2).keptVersions, ['0.6.13', '0.7.0']);
});
