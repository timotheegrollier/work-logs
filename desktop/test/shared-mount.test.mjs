import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectShare, findShareMount, parseShareAddress } from '../shared-mount.mjs';

test('adresse du partage : UNC Windows, smb://, //, sous-dossier ; refus des adresses incomplètes', () => {
  assert.deepEqual(parseShareAddress('\\\\TSE01\\Commun'), { uri: 'smb://TSE01/Commun', host: 'TSE01', share: 'Commun', subpath: '', label: '\\\\TSE01\\Commun' });
  assert.equal(parseShareAddress('smb://tse01/commun/Procédures/Piscine').subpath, 'Procédures/Piscine');
  assert.equal(parseShareAddress('//tse01.local/Équipe').uri, 'smb://tse01.local/%C3%89quipe');
  assert.equal(parseShareAddress('smb://ENTREPRISE;timo@tse01/commun').host, 'tse01', 'les identifiants de l’adresse sont écartés');
  assert.equal(parseShareAddress('  tse01/commun  ').label, '\\\\tse01\\commun');
  for (const bad of ['', '\\\\tse01', 'smb://', 'tse 01/commun']) assert.throws(() => parseShareAddress(bad), /Indique|incomplète|invalide/, bad);
});

test('retrouve le montage GVFS du partage, sans tenir compte de la casse', () => {
  const gvfs = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-gvfs-dir-'));
  try {
    fs.mkdirSync(path.join(gvfs, 'smb-share:domain=ENTREPRISE,server=tse01,share=commun,user=timo'));
    fs.mkdirSync(path.join(gvfs, 'smb-share:server=autre,share=commun'));
    fs.mkdirSync(path.join(gvfs, 'smb-share:server=tse01,share=%C3%A9quipe'));
    assert.equal(findShareMount({ host: 'TSE01', share: 'Commun' }, gvfs), path.join(gvfs, 'smb-share:domain=ENTREPRISE,server=tse01,share=commun,user=timo'));
    assert.equal(findShareMount({ host: 'tse01', share: 'Équipe' }, gvfs), path.join(gvfs, 'smb-share:server=tse01,share=%C3%A9quipe'));
    assert.equal(findShareMount({ host: 'tse02', share: 'commun' }, gvfs), null);
    assert.equal(findShareMount({ host: 'tse01', share: 'commun' }, path.join(gvfs, 'absent')), null);
  } finally {
    fs.rmSync(gvfs, { recursive: true, force: true });
  }
});

test('connexion : déjà monté, puis `gio mount` (trousseau), puis fenêtre du gestionnaire de fichiers', async () => {
  const gvfs = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-gvfs-dir-'));
  const mountDir = path.join(gvfs, 'smb-share:server=tse01,share=commun');
  try {
    // 1. `gio mount` réussit (mot de passe dans le trousseau).
    const mounted = await connectShare('\\\\tse01\\commun', {
      gvfsDir: gvfs,
      mount: async (uri) => { assert.equal(uri, 'smb://tse01/commun'); fs.mkdirSync(mountDir); return { ok: true }; },
      openLocation: async () => assert.fail('pas de fenêtre si gio suffit'),
    });
    assert.equal(mounted.path, mountDir);
    assert.equal(mounted.how, 'gio');

    // 2. Déjà monté : rien à faire, sous-dossier compris.
    fs.mkdirSync(path.join(mountDir, 'Procédures'));
    const again = await connectShare('smb://TSE01/Commun/Procédures', {
      gvfsDir: gvfs, mount: async () => assert.fail('déjà monté'),
    });
    assert.equal(again.path, path.join(mountDir, 'Procédures'));
    await assert.rejects(connectShare('\\\\tse01\\commun\\Absent', { gvfsDir: gvfs }), /n’existe pas/);

    // 3. Mot de passe à saisir : fenêtre de Nemo, puis le montage apparaît.
    fs.rmSync(mountDir, { recursive: true });
    let opened = '';
    const viaWindow = await connectShare('\\\\tse01\\commun', {
      gvfsDir: gvfs,
      mount: async () => ({ ok: false, message: 'Password required' }),
      openLocation: async (uri) => { opened = uri; setTimeout(() => fs.mkdirSync(mountDir), 30); },
      pollMs: 10,
      waitMs: 2000,
    });
    assert.equal(opened, 'smb://tse01/commun');
    assert.equal(viaWindow.how, 'fenêtre');

    // 4. Jamais monté : message clair.
    fs.rmSync(mountDir, { recursive: true });
    await assert.rejects(connectShare('\\\\tse01\\commun', {
      gvfsDir: gvfs, mount: async () => ({ ok: false, message: 'refusé' }), openLocation: async () => {}, pollMs: 5, waitMs: 20,
    }), /n’est toujours pas monté/);
  } finally {
    fs.rmSync(gvfs, { recursive: true, force: true });
  }
});
