import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkForUpdate, isNewer, parseVersion } from '../update.mjs';

const stubFetch = (payload, ok = true) => async () => ({ ok, json: async () => payload });

test('parseVersion ne retient que les versions stables', () => {
  assert.deepEqual(parseVersion('v0.3.0'), [0, 3, 0]);
  assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3]);
  assert.equal(parseVersion('v0.3.0-rc.1'), null);
  assert.equal(parseVersion('nawak'), null);
});

test('isNewer compare chaque segment', () => {
  assert.equal(isNewer('v0.3.0', '0.2.0'), true);
  assert.equal(isNewer('v0.2.1', '0.2.0'), true);
  assert.equal(isNewer('v1.0.0', '0.9.9'), true);
  assert.equal(isNewer('v0.2.0', '0.2.0'), false);
  assert.equal(isNewer('v0.1.9', '0.2.0'), false);
  assert.equal(isNewer('v0.10.0', '0.9.0'), true);
});

test('checkForUpdate signale une release plus récente', async () => {
  const found = await checkForUpdate({
    currentVersion: '0.2.0',
    fetchImpl: stubFetch({ tag_name: 'v0.3.0' }),
  });
  assert.deepEqual(found, {
    version: '0.3.0',
    url: 'https://github.com/timotheegrollier/work-logs/releases/tag/v0.3.0',
  });
});

test('checkForUpdate reste silencieuse quand il n’y a rien à signaler', async () => {
  assert.equal(
    await checkForUpdate({ currentVersion: '0.3.0', fetchImpl: stubFetch({ tag_name: 'v0.3.0' }) }),
    null,
  );
  assert.equal(
    await checkForUpdate({ currentVersion: '0.3.0', fetchImpl: stubFetch({ tag_name: 'v0.2.0' }) }),
    null,
  );
  assert.equal(
    await checkForUpdate({ currentVersion: '0.3.0', fetchImpl: async () => ({ ok: false }) }),
    null,
  );
  assert.equal(
    await checkForUpdate({ currentVersion: '0.3.0', fetchImpl: async () => { throw new Error('hors ligne'); } }),
    null,
  );
  assert.equal(
    await checkForUpdate({ currentVersion: '0.3.0', fetchImpl: stubFetch({ pas_de_tag: true }) }),
    null,
  );
});
