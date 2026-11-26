import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGithubRepo } from '../src/github-repo.js';

test('un dépôt se normalise en propriétaire/dépôt, depuis le nom ou le lien', () => {
  assert.equal(normalizeGithubRepo('Timo/worklogs'), 'Timo/worklogs');
  assert.equal(normalizeGithubRepo('  Timo/worklogs/  '), 'Timo/worklogs');
  assert.equal(normalizeGithubRepo('https://github.com/Timo/worklogs'), 'Timo/worklogs');
  assert.equal(normalizeGithubRepo('https://github.com/Timo/worklogs.git'), 'Timo/worklogs');
  assert.equal(normalizeGithubRepo('https://github.com/Timo/worklogs/tree/master/api'), 'Timo/worklogs');
});

test('une valeur vide efface le lien', () => {
  assert.equal(normalizeGithubRepo(''), null);
  assert.equal(normalizeGithubRepo('   '), null);
  assert.equal(normalizeGithubRepo(null), null);
  assert.equal(normalizeGithubRepo(undefined), null);
});

test('une valeur qui ne désigne pas un dépôt GitHub est refusée', () => {
  for (const value of ['worklogs', 'a/b/c', 'https://gitlab.com/Timo/worklogs', 'https://github.com/Timo', '../x', 'Timo/..', 'Timo/a b', 42, 'x'.repeat(301)]) {
    assert.throws(() => normalizeGithubRepo(value), { code: 'GITHUB_INVALID_REPO', status: 400 }, String(value));
  }
});
