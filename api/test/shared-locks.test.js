import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  describeLock, formatWorkLogsLock, isTechnicalName, lockDate, ownerFileName, parseLibreOfficeLock, parseOwnerFile,
} from '../src/shared-locks.js';
import { createSharedIo } from '../src/shared-io.js';
import { copyName, relativeParts } from '../src/shared-service.js';
import { officeOwnerFile } from './helpers.js';

describe('verrous du dossier partagé', () => {
  test('nom du fichier propriétaire : Word raccourcit les noms longs, Excel jamais', () => {
    assert.equal(ownerFileName('Document.docx'), '~$cument.docx', '8 caractères : 2 retirés');
    assert.equal(ownerFileName('Documen.docx'), '~$ocumen.docx', '7 caractères : 1 retiré');
    assert.equal(ownerFileName('Docume.docx'), '~$Docume.docx', '6 caractères : aucun');
    assert.equal(ownerFileName('Procédure filtration.docx'), '~$océdure filtration.docx');
    assert.equal(ownerFileName('Budget 2026.xlsx'), '~$Budget 2026.xlsx');
    assert.equal(ownerFileName('relevés.csv'), '~$relevés.csv');
  });

  test('lit le nom dans un fichier propriétaire Word ou Excel, accents compris', () => {
    assert.equal(parseOwnerFile(officeOwnerFile('Jean Dupont')), 'Jean Dupont');
    assert.equal(parseOwnerFile(officeOwnerFile('Hélène Martin', { excel: true })), 'Hélène Martin');
    // Sans partie UTF-16 lisible : repli sur le nom ANSI du début.
    const ansiOnly = Buffer.alloc(54, 0x20);
    ansiOnly[0] = 5;
    ansiOnly.write('Ma\xeflé', 1, 'latin1');
    assert.equal(parseOwnerFile(ansiOnly), 'Maïlé');
    assert.equal(parseOwnerFile(Buffer.alloc(0)), null);
  });

  test('verrou LibreOffice : champs échappés, et celui de WorkLogs se reconnaît', () => {
    const parsed = parseLibreOfficeLock(Buffer.from('Dupont\\, Jean,jdupont,TSE01,05.10.2026 10:42,file:///C:/Users/jdupont;'));
    assert.deepEqual(parsed, { name: 'Dupont, Jean', user: 'jdupont', host: 'TSE01', date: '05.10.2026 10:42', url: 'file:///C:/Users/jdupont' });

    const date = new Date(2026, 9, 5, 10, 47);
    const ours = formatWorkLogsLock({ displayName: 'Timothée Grollier', user: 'timo', host: 'pc-timo', instance: 'abc', nonce: 'n1', date });
    assert.equal(ours, 'Timothée Grollier (WorkLogs),timo,pc-timo,05.10.2026 10:47,worklogs:abc:n1;');
    assert.equal(lockDate(date), '05.10.2026 10:47');
    const mine = describeLock({ name: 'a.csv', libre: { bytes: Buffer.from(ours), mtimeMs: date.getTime() }, instance: 'abc', now: date.getTime() });
    assert.equal(mine.app, 'worklogs');
    assert.equal(mine.by, 'Timothée Grollier');
    assert.equal(mine.self, true);
    const theirs = describeLock({ name: 'a.csv', libre: { bytes: Buffer.from(ours), mtimeMs: date.getTime() }, instance: 'other', now: date.getTime() });
    assert.equal(theirs.self, false);
  });

  test('un verrou LibreOffice de plus de 24 h est signalé comme probablement oublié', () => {
    const now = Date.now();
    const lock = describeLock({ name: 'a.ods', libre: { bytes: Buffer.from(',jdupont,TSE01,01.10.2026 08:00,file:///x;'), mtimeMs: now - 25 * 3600e3 }, now });
    assert.equal(lock.app, 'libreoffice');
    assert.equal(lock.by, 'jdupont', 'sans nom LibreOffice, l’identifiant du compte');
    assert.equal(lock.stale, true);
  });

  test('le fichier propriétaire Office désigne Word ou Excel selon le type', () => {
    const owner = { bytes: officeOwnerFile('Jean Dupont'), mtimeMs: Date.now() };
    assert.equal(describeLock({ name: 'Note.docx', owner }).app, 'word');
    assert.equal(describeLock({ name: 'Budget.xlsx', owner }).app, 'excel');
    assert.equal(describeLock({ name: 'Budget.xlsx', owner }).by, 'Jean Dupont');
  });

  test('masque verrous, temporaires Office et LibreOffice, vignettes', () => {
    for (const name of ['~$cument.docx', '.~lock.a.csv#', '~WRL0001.tmp', 'lu12345.tmp', 'A1B2C3D4', 'A1B2C3D4.tmp', 'Thumbs.db', 'desktop.ini', '.cache']) {
      assert.equal(isTechnicalName(name), true, name);
    }
    for (const name of ['Procédure.docx', 'relevés.csv', 'notes.md', 'Budget 2026.xlsx']) assert.equal(isTechnicalName(name), false, name);
  });

  test('chemins relatifs : ni remontée, ni absolu, ni segment vide', () => {
    assert.deepEqual(relativeParts('Procédures/filtration.docx'), ['Procédures', 'filtration.docx']);
    assert.deepEqual(relativeParts('', { allowRoot: true }), []);
    for (const bad of ['', '../etc/passwd', '/etc/passwd', 'a//b', 'a/./b', 'a\\b', 'a\nb', 'a/']) {
      assert.throws(() => relativeParts(bad), /Chemin/, JSON.stringify(bad));
    }
  });

  test('nom de copie « garder les deux » : auteur, date, numéro, sans caractère interdit', () => {
    const date = new Date(2026, 9, 5, 10, 47);
    assert.equal(copyName('Procédure.docx', 'T. Grollier', date), 'Procédure (copie T. Grollier 2026-10-05 10h47).docx');
    assert.equal(copyName('relevés.csv', 'A/B:C', date, 2), 'relevés (copie ABC 2026-10-05 10h47 2).csv');
  });
});

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

describe('entrées/sorties bornées', () => {
  test('un appel figé ouvre le disjoncteur ; seule une sonde le referme', async () => {
    const io = createSharedIo({ timeoutMs: 150 });
    try {
      await assert.rejects(io.call('sleep', [600]), { code: 'SHARED_OFFLINE' });
      assert.equal(io.state().breaker, 'open');
      assert.equal(io.state().stuck, 1);
      // Disjoncteur ouvert : échec immédiat, sans attendre de délai.
      const started = Date.now();
      await assert.rejects(io.call('stat', [os.tmpdir()]), { code: 'SHARED_OFFLINE' });
      assert.ok(Date.now() - started < 100);
      // La sonde passe sur un nouveau worker et referme le disjoncteur.
      const stat = await io.call('stat', [os.tmpdir()], { probe: true });
      assert.equal(stat.isDir, true);
      assert.equal(io.state().breaker, 'closed');
      // Le worker abandonné finit par rendre la main : il est libéré.
      await new Promise((resolve) => setTimeout(resolve, 700));
      assert.equal(io.state().stuck, 0);
    } finally {
      await io.close();
    }
  });

  test('le démarrage d’un worker ne compte pas dans le délai : une machine chargée ne fait pas « injoignable »', async () => {
    // Un worker met ~70 ms à démarrer, bien plus sous charge : avec un délai de 20 ms,
    // compter son démarrage ferait croire le partage injoignable.
    const io = createSharedIo({ timeoutMs: 20 });
    try {
      const stat = await io.call('stat', [os.tmpdir()]);
      assert.equal(stat.isDir, true);
      assert.equal(io.state().breaker, 'closed');
    } finally {
      await io.close();
    }
  });

  test('au-delà de deux workers figés, l’état passe à « bloqué »', async () => {
    const io = createSharedIo({ timeoutMs: 100, maxStuck: 2 });
    try {
      await assert.rejects(io.call('sleep', [500]), { code: 'SHARED_OFFLINE' });
      await assert.rejects(io.call('sleep', [500], { probe: true }), { code: 'SHARED_OFFLINE' });
      assert.equal(io.state().breaker, 'blocked');
      await assert.rejects(io.call('stat', [os.tmpdir()], { probe: true }), { code: 'SHARED_BLOCKED' });
    } finally {
      await io.close();
    }
  });

  test('un worker inactif ne retient pas le processus (fermeture de WorkLogs)', () => {
    const module = new URL('../src/shared-io.js', import.meta.url).href;
    const script = `const { createSharedIo } = await import(${JSON.stringify(module)});
      const io = createSharedIo();
      await io.call('stat', [${JSON.stringify(os.tmpdir())}]);`;
    const started = Date.now();
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 10_000 });
    assert.equal(child.status, 0, String(child.stderr));
    assert.ok(Date.now() - started < 5000);
  });

  test('écriture gardée : refuse d’écraser une version qu’on n’a pas vue', async () => {
    const io = createSharedIo();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-io-'));
    try {
      const file = path.join(dir, 'a.txt');
      fs.writeFileSync(file, 'v1');
      const { hash: base } = await io.call('readFile', [file, 1000]);
      fs.writeFileSync(file, 'v2 du collègue');
      const mine = Buffer.from('v1 + moi');
      const mineHash = sha256(mine);
      const refused = await io.call('writeGuarded', [file, mine, base, mineHash, false]);
      assert.equal(refused.result, 'changed');
      assert.equal(Buffer.from(refused.theirs).toString(), 'v2 du collègue');
      assert.equal(fs.readFileSync(file, 'utf8'), 'v2 du collègue', 'rien d’écrasé');

      const accepted = await io.call('writeGuarded', [file, mine, refused.hash, mineHash, false]);
      assert.equal(accepted.result, 'written');
      assert.equal(fs.readFileSync(file, 'utf8'), 'v1 + moi');
      assert.equal((await io.call('writeGuarded', [file, mine, refused.hash, mineHash, false])).result, 'same');
      assert.equal((await io.call('writeGuarded', [path.join(dir, 'absent.txt'), mine, base, mineHash, false])).result, 'missing');
    } finally {
      await io.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('écriture interrompue : reprise seulement si le partage contient un début de notre version', async () => {
    const io = createSharedIo();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-io-'));
    try {
      const file = path.join(dir, 'a.txt');
      const mine = Buffer.from('version complète');
      fs.writeFileSync(file, mine.subarray(0, 7));
      const resumed = await io.call('writeGuarded', [file, mine, 'base-perdue', sha256(mine), true]);
      assert.equal(resumed.result, 'written');
      assert.equal(fs.readFileSync(file, 'utf8'), 'version complète');
      fs.writeFileSync(file, 'autre chose');
      const refused = await io.call('writeGuarded', [file, mine, 'base-perdue', sha256(mine), true]);
      assert.equal(refused.result, 'changed');
      assert.equal(fs.readFileSync(file, 'utf8'), 'autre chose');
    } finally {
      await io.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
