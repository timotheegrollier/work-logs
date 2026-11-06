import { describe, expect, it } from 'vitest';
import { diffLines, merge3, mergeText, mergeXlsx, splitKeepingEol } from './shared-merge';
import { readZip, readZipText } from './zip';
import { readXlsxWorkbook, writeXlsx } from './xlsx';
import { excelWorkbook } from './test/xlsx-fixture';

const latin1 = (text: string) => new Uint8Array(Buffer.from(text, 'latin1'));
const utf8 = (text: string) => new TextEncoder().encode(text);
const lines = (...items: string[]) => items.map((item) => `${item}\n`);

describe('fusion à trois voies, à la ligne', () => {
  it('différences en blocs : remplacement, insertion, suppression', () => {
    expect(diffLines(lines('a', 'b', 'c'), lines('a', 'B', 'c'))).toEqual([{ start: 1, end: 2, lines: ['B\n'] }]);
    expect(diffLines(lines('a', 'c'), lines('a', 'b', 'c'))).toEqual([{ start: 1, end: 1, lines: ['b\n'] }]);
    expect(diffLines(lines('a', 'b', 'c'), lines('a', 'c'))).toEqual([{ start: 1, end: 2, lines: [] }]);
    expect(diffLines(lines('a'), lines('a'))).toEqual([]);
  });

  it('modifications qui ne se touchent pas, voisines comprises : réunies', () => {
    const base = lines('1', '2', '3', '4', '5');
    expect(merge3(base, lines('1', 'deux', '3', '4', '5'), lines('1', '2', 'trois', '4', '5'))).toEqual({ ok: true, lines: lines('1', 'deux', 'trois', '4', '5') });
    expect(merge3(base, lines('0', '1', '2', '3', '4', '5'), lines('1', '2', '3', '4', '5', '6'))).toEqual({ ok: true, lines: lines('0', '1', '2', '3', '4', '5', '6') });
    // Le même changement des deux côtés : pris une fois.
    expect(merge3(base, lines('1', 'X', '3', '4', '5'), lines('1', 'X', '3', '4', '5'))).toEqual({ ok: true, lines: lines('1', 'X', '3', '4', '5') });
    // Une ligne supprimée d'un côté, une autre modifiée de l'autre.
    expect(merge3(base, lines('1', '3', '4', '5'), lines('1', '2', '3', '4', 'cinq'))).toEqual({ ok: true, lines: lines('1', '3', '4', 'cinq') });
  });

  it('modifications qui se touchent : pas de fusion, et où', () => {
    const base = lines('1', '2', '3');
    expect(merge3(base, lines('1', 'deux', '3'), lines('1', 'DEUX', '3'))).toEqual({ ok: false, conflicts: [2] });
    expect(merge3(base, lines('1', 'a', '2', '3'), lines('1', 'b', '2', '3'))).toEqual({ ok: false, conflicts: [2] });
    expect(merge3(base, lines('1', '3'), lines('1', 'deux', '3'))).toEqual({ ok: false, conflicts: [2] });
  });
});

describe('fusion d’un fichier du partage', () => {
  it('CSV d’Excel : deux lignes différentes, encodage Windows-1252 et fins de ligne gardés', () => {
    const base = 'Date;Mesure;Commentaire\r\n05/10;12,5;\r\n06/10;13;\r\n';
    const mine = 'Date;Mesure;Commentaire\r\n05/10;12,5;\r\n06/10;13;Filtre lavé\r\n';
    const theirs = 'Date;Mesure;Commentaire\r\n05/10;12,8;pH corrigé\r\n06/10;13;\r\n';
    const result = mergeText(latin1(base), latin1(mine), latin1(theirs));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Buffer.from(result.bytes).toString('latin1')).toBe('Date;Mesure;Commentaire\r\n05/10;12,8;pH corrigé\r\n06/10;13;Filtre lavé\r\n');
    expect(result.summary).toBe('1 modification de ta part ajoutée à leur version.');
  });

  it('même ligne modifiée des deux côtés : raison donnée', () => {
    const result = mergeText(utf8('a\nb\n'), utf8('a\nB\n'), utf8('a\nbé\n'));
    expect(result).toEqual({ ok: false, reason: 'Fusion impossible : vous avez modifié tous les deux la ligne 2.' });
  });

  it('classeur Excel : mes cellules posées sur leur version, sauf si elles ont changé là aussi', async () => {
    const base = excelWorkbook();
    // Le collègue a changé B2 dans Excel.
    const theirs = await writeXlsx(base, { Suivi: { B2: '2000' } }, { author: 'Jean Dupont' });
    const merged = await mergeXlsx(base, theirs, { format: 'xlsx', v: 1, edits: { Suivi: { B3: '250' } } }, 'T. Grollier');
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    const sheet = (await readZipText(readZip(merged.bytes), 'xl/worksheets/sheet1.xml'))!;
    expect(sheet).toContain('<c r="B2" s="2"><v>2000</v></c>');
    expect(sheet).toContain('<c r="B3" s="2"><v>250</v></c>');
    expect(merged.summary).toBe('1 cellule de ta part posée sur leur version.');
    expect((await readXlsxWorkbook(merged.bytes)).author).toBe('T. Grollier');

    const clash = await mergeXlsx(base, theirs, { format: 'xlsx', v: 1, edits: { Suivi: { B2: '1500' } } }, 'T. Grollier');
    expect(clash).toEqual({ ok: false, reason: 'Fusion impossible : vous avez modifié tous les deux la cellule Suivi!B2.' });
    // La même valeur des deux côtés n'est pas un conflit.
    expect((await mergeXlsx(base, theirs, { format: 'xlsx', v: 1, edits: { Suivi: { B2: '2000' } } }, 'T. Grollier')).ok).toBe(true);
  });

  it('lignes gardées avec leur fin, dernière ligne sans retour comprise', () => {
    expect(splitKeepingEol('a\r\nb\nc')).toEqual(['a\r\n', 'b\n', 'c']);
    expect(splitKeepingEol('')).toEqual([]);
  });
});
