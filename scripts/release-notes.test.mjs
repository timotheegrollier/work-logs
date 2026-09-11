import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categorize, previousTag, renderNotes } from './release-notes.mjs';

test('categorize range les sujets par section', () => {
  assert.equal(categorize('feat(desktop): propose la mise à jour'), 'new');
  assert.equal(categorize('fix: débloque le desktop Linux'), 'fixes');
  assert.equal(categorize("chore(deps): bump jsdom via dependabot"), 'deps');
  assert.equal(categorize('build(deps): bump express'), 'deps');
  assert.equal(categorize('ci: déclenche la CI'), 'other');
  assert.equal(categorize('release: prépare la 0.4.0'), 'other');
});

test('previousTag retient la release précédente, pas le tag courant', () => {
  assert.equal(previousTag('v0.4.1', ['v0.2.0', 'v0.4.0', 'v0.3.0', 'v0.4.1']), 'v0.4.0');
  assert.equal(previousTag('v0.2.0', ['v0.2.0']), null);
  assert.equal(previousTag('v1.0.0', ['v0.9.9', 'v0.10.0']), 'v0.10.0');
});

test('renderNotes produit des sections anglaises stables', () => {
  const notes = renderNotes({
    tag: 'v0.4.1', prev: 'v0.4.0', releaseDir: null,
    subjects: ['feat: nouvelle icône', 'fix: inclut update.mjs', 'chore(deps): bump jsdom', 'ci: cache'],
  });
  assert.match(notes, /## WorkLogs 0\.4\.1 for Linux/);
  assert.match(notes, /### What's new/);
  assert.match(notes, /### Fixes/);
  assert.match(notes, /### Dependencies/);
  assert.match(notes, /### Other changes/);
  assert.match(notes, /### Download/);
  assert.match(notes, /sha256sum -c SHA256SUMS/);
  assert.match(notes, /compare\/v0\.4\.0\.\.\.v0\.4\.1/);
});

test('renderNotes omet les sections vides', () => {
  const notes = renderNotes({ tag: 'v0.4.1', prev: 'v0.4.0', releaseDir: null, subjects: ['ci: cache'] });
  assert.doesNotMatch(notes, /What's new/);
  assert.match(notes, /### Other changes/);
});
