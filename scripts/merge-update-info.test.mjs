import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mergeUpdateInfo } from './merge-update-info.mjs';

const NAMES = { AppImage: 'WorkLogs-1.2.3-linux-x86_64.AppImage', deb: 'WorkLogs-1.2.3-linux-amd64.deb', rpm: 'WorkLogs-1.2.3-linux-x86_64.rpm' };

/** Trois paquets factices et le `latest-linux.yml` qu'electron-builder écrit pour chacun, renommé par son job. */
function release({ version = { AppImage: '1.2.3', deb: '1.2.3', rpm: '1.2.3' }, skip = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-update-info-'));
  const entries = {};
  for (const [target, name] of Object.entries(NAMES)) {
    const body = Buffer.from(`paquet ${target}`);
    fs.writeFileSync(path.join(dir, name), body);
    const sha512 = createHash('sha512').update(body).digest('base64');
    entries[target] = { sha512, size: body.length };
    if (target === skip) continue;
    const extra = target === 'AppImage' ? '    blockMapSize: 131324\n' : '';
    fs.writeFileSync(path.join(dir, `latest-linux-${target}.yml`), `version: ${version[target]}
files:
  - url: ${name}
    sha512: ${sha512}
    size: ${body.length}
${extra}path: ${name}
sha512: ${sha512}
releaseDate: '2026-11-24T16:1${'AppImage deb rpm'.split(' ').indexOf(target)}:00.000Z'
`);
  }
  return { dir, entries };
}

test('les trois cibles réunies comme une construction commune : AppImage en tête, puis deb et rpm', async () => {
  const { dir, entries: e } = release();
  await mergeUpdateInfo(dir);
  assert.equal(fs.readFileSync(path.join(dir, 'latest-linux.yml'), 'utf8'), `version: 1.2.3
files:
  - url: ${NAMES.AppImage}
    sha512: ${e.AppImage.sha512}
    size: ${e.AppImage.size}
    blockMapSize: 131324
  - url: ${NAMES.deb}
    sha512: ${e.deb.sha512}
    size: ${e.deb.size}
  - url: ${NAMES.rpm}
    sha512: ${e.rpm.sha512}
    size: ${e.rpm.size}
path: ${NAMES.AppImage}
sha512: ${e.AppImage.sha512}
releaseDate: '2026-11-24T16:10:00.000Z'
`);
  // Les fichiers partiels ne partent pas dans l'artefact publié.
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.yml')), ['latest-linux.yml']);
});

test('jamais de latest-linux.yml incomplet, mélangé ou faux', async () => {
  await assert.rejects(mergeUpdateInfo(release({ skip: 'rpm' }).dir), /latest-linux-rpm\.yml manquant/);
  await assert.rejects(mergeUpdateInfo(release({ version: { AppImage: '1.2.3', deb: '1.2.2', rpm: '1.2.3' } }).dir), /versions différentes/);
  const changed = release();
  fs.writeFileSync(path.join(changed.dir, NAMES.deb), 'paquet DEB');
  await assert.rejects(mergeUpdateInfo(changed.dir), /amd64\.deb : sha512 différent/);
  assert.ok(!fs.existsSync(path.join(changed.dir, 'latest-linux.yml')), 'rien d’écrit après un refus');
  const missing = release();
  fs.rmSync(path.join(missing.dir, NAMES.AppImage));
  await assert.rejects(mergeUpdateInfo(missing.dir), /AppImage absent/);
});
