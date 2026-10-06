import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addressFromPath, connectShare, findFileManager, findShareMount, parseAccount, parseShareAddress } from '../shared-mount.mjs';

test('adresse du partage : UNC Windows, smb://, //, sous-dossier ; refus des adresses incomplètes', () => {
  assert.deepEqual(parseShareAddress('\\\\TSE01\\Commun'), { uri: 'smb://TSE01/Commun', host: 'TSE01', share: 'Commun', subpath: '', label: '\\\\TSE01\\Commun', account: null });
  assert.equal(parseShareAddress('smb://tse01/commun/Procédures/Piscine').subpath, 'Procédures/Piscine');
  assert.equal(parseShareAddress('//tse01.local/Équipe').uri, 'smb://tse01.local/%C3%89quipe');
  assert.equal(parseShareAddress('smb://ENTREPRISE;timo@tse01/commun').host, 'tse01');
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
      openLocation: async (uri) => { opened = uri; setTimeout(() => fs.mkdirSync(mountDir), 30); return ''; },
      pollMs: 10,
      waitMs: 2000,
    });
    assert.equal(opened, 'smb://tse01/commun');
    assert.equal(viaWindow.how, 'fenêtre');

    // 4. Jamais monté : message clair.
    fs.rmSync(mountDir, { recursive: true });
    await assert.rejects(connectShare('\\\\tse01\\commun', {
      gvfsDir: gvfs, mount: async () => ({ ok: false, message: 'refusé' }), openLocation: async () => '', pollMs: 5, waitMs: 20,
    }), /n’est toujours pas monté/);

    // 5. La fenêtre de connexion ne s'ouvre pas : on le dit aussitôt, sans attendre deux minutes.
    const started = Date.now();
    await assert.rejects(connectShare('\\\\tse01\\commun', {
      gvfsDir: gvfs, mount: async () => ({ ok: false, message: 'Password required' }),
      openLocation: async () => 'nemo a échoué, code 1', pollMs: 5, waitMs: 60_000,
    }), /fenêtre de connexion ne s’est pas ouverte \(nemo a échoué, code 1\)/);
    assert.ok(Date.now() - started < 1000);
  } finally {
    fs.rmSync(gvfs, { recursive: true, force: true });
  }
});

test('gestionnaire de fichiers pour la connexion : celui du bureau, sinon le premier installé, jamais xdg-open', () => {
  const only = (...commands) => (command) => commands.includes(command);
  assert.equal(findFileManager({ defaultHandler: 'nemo.desktop', exists: only('nemo', 'nautilus') }), 'nemo');
  assert.equal(findFileManager({ defaultHandler: 'org.gnome.Nautilus.desktop', exists: only('nemo', 'nautilus') }), 'nautilus');
  assert.equal(findFileManager({ defaultHandler: 'caja-folder-handler.desktop', exists: only('caja') }), 'caja');
  // Gestionnaire du bureau inconnu (Dolphin passe par KIO, pas GVFS) : le premier qui sait faire.
  assert.equal(findFileManager({ defaultHandler: 'org.kde.dolphin.desktop', exists: only('thunar') }), 'thunar');
  assert.equal(findFileManager({ defaultHandler: '', exists: only() }), null);
});

test('compte du partage : dans l’adresse donnée à GVFS, jamais de mot de passe ; seul un montage de ce compte convient', () => {
  assert.deepEqual(parseAccount('SRVMURGAT\\TimothéeG'), { domain: 'SRVMURGAT', user: 'TimothéeG', label: 'SRVMURGAT\\TimothéeG' });
  assert.deepEqual(parseAccount('TimotheeG'), { domain: null, user: 'TimotheeG', label: 'TimotheeG' });
  assert.equal(parseAccount('  '), null);
  for (const bad of ['a/b', 'x@y', 'a:b']) assert.throws(() => parseAccount(bad), /Compte invalide/, bad);

  const target = parseShareAddress('\\\\SRVMURGAT\\Global\\MURGAT INGENIERIE\\13. SI\\00. PROCEDURE', 'SRVMURGAT\\TimothéeG');
  assert.equal(target.uri, 'smb://SRVMURGAT;Timoth%C3%A9eG@SRVMURGAT/Global');
  assert.equal(target.subpath, 'MURGAT INGENIERIE/13. SI/00. PROCEDURE');
  assert.equal(target.label, '\\\\SRVMURGAT\\Global\\MURGAT INGENIERIE\\13. SI\\00. PROCEDURE');
  // Compte écrit dans l'adresse : gardé ; un mot de passe qui s'y trouverait : écarté.
  assert.equal(parseShareAddress('smb://SRVMURGAT;TimotheeG:secret@srvmurgat/global').uri, 'smb://SRVMURGAT;TimotheeG@srvmurgat/global');

  const gvfs = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-gvfs-dir-'));
  try {
    const guest = path.join(gvfs, 'smb-share:server=srvmurgat,share=global');
    fs.mkdirSync(guest);
    assert.equal(findShareMount({ host: 'SRVMURGAT', share: 'Global' }, gvfs), guest);
    assert.equal(findShareMount({ host: 'SRVMURGAT', share: 'Global', account: target.account }, gvfs), null, 'le montage invité ne vaut pas celui du compte');
    const mine = path.join(gvfs, 'smb-share:domain=SRVMURGAT,server=srvmurgat,share=global,user=Timoth%C3%A9eG');
    fs.mkdirSync(mine);
    assert.equal(findShareMount({ host: 'SRVMURGAT', share: 'Global', account: target.account }, gvfs), mine);
  } finally {
    fs.rmSync(gvfs, { recursive: true, force: true });
  }
});

test('connexion : un dossier fermé au compte du montage est dit « accès refusé », pas « n’existe pas »', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root lit partout');
  const gvfs = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-gvfs-dir-'));
  const mountDir = path.join(gvfs, 'smb-share:server=srvmurgat,share=global');
  try {
    fs.mkdirSync(path.join(mountDir, 'MURGAT INGENIERIE', '13. SI', '00. PROCEDURE'), { recursive: true });
    fs.chmodSync(path.join(mountDir, 'MURGAT INGENIERIE'), 0o000);
    await assert.rejects(connectShare('\\\\SRVMURGAT\\Global\\MURGAT INGENIERIE\\13. SI\\00. PROCEDURE', { gvfsDir: gvfs }),
      /Accès refusé à \\\\SRVMURGAT\\Global\\MURGAT INGENIERIE\\13\. SI\\00\. PROCEDURE pour le compte avec lequel le partage est monté \(souvent l’accès invité\)\. Indique dans « Compte »/);
    await assert.rejects(connectShare('\\\\SRVMURGAT\\Global\\Absent', { gvfsDir: gvfs }), /« Absent » n’existe pas/);
  } finally {
    fs.chmodSync(path.join(mountDir, 'MURGAT INGENIERIE'), 0o755);
    fs.rmSync(gvfs, { recursive: true, force: true });
  }
});

test('dossier choisi dans un montage GVFS : son adresse et son compte sont retrouvés (« Se reconnecter »)', () => {
  const gvfs = '/run/user/1000/gvfs';
  assert.deepEqual(addressFromPath(`${gvfs}/smb-share:domain=SRVMURGAT,server=172.16.1.20,share=d,user=Timoth%C3%A9eG/Global/MURGAT INGENIERIE/13. SI/00. PROCEDURE`, gvfs), {
    address: '\\\\172.16.1.20\\d\\Global\\MURGAT INGENIERIE\\13. SI\\00. PROCEDURE',
    account: 'SRVMURGAT\\TimothéeG',
  });
  assert.deepEqual(addressFromPath(`${gvfs}/smb-share:server=tse01,share=commun`, gvfs), { address: '\\\\tse01\\commun', account: null });
  assert.equal(addressFromPath('/home/timo/Documents', gvfs), null);
  assert.equal(addressFromPath(`${gvfs}/sftp:host=x/dossier`, gvfs), null);
});
