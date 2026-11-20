import { describe, expect, test } from 'vitest';
import { odsWorkbook } from './test/ods-fixture';
import { readOdsWorkbook, writeOds } from './ods';
import { readZip, readZipText } from './zip';

describe('classeur OpenDocument', () => {
  test('lit les feuilles, cellules, formules et groupes de lignes', async () => {
    const workbook = await readOdsWorkbook(odsWorkbook());
    expect(workbook.sheets.map(({ name, hidden }) => [name, hidden])).toEqual([
      ['Données', false],
      ['Résumé', true],
    ]);
    const sheet = workbook.sheets[0];
    expect(sheet.cells.get(0)?.display).toBe('Libellé');
    expect(sheet.cells.get(1)?.display).toBe('12,5');
    expect(sheet.cells.get(1)?.input).toBe('12,5');
    expect(sheet.cells.get(2)?.input).toBe('=SUM(B1:B2)');
    expect(sheet.cells.get(16384)?.display).toBe('Deuxième');
  });

  test('écrit seulement les cellules modifiées et conserve les autres feuilles', async () => {
    const original = odsWorkbook();
    const changed = await writeOds(original, {
      Données: { A1: 'Atelier & pièces', B1: '1 234,5', D1: '21/11/2026', D4: 'ajouté', E1: 'un', F1: 'deux' },
      Résumé: { A1: 'Mis à jour' },
    }, { author: 'Timo', now: new Date('2026-11-20T10:00:00Z') });
    const workbook = await readOdsWorkbook(changed);
    expect(workbook.sheets[0].cells.get(0)?.display).toBe('Atelier & pièces');
    expect(workbook.sheets[0].cells.get(1)?.display).toBe('1 234,5');
    expect(workbook.sheets[0].cells.get(2)?.display).toBe('=SUM(B1:B2)');
    expect(workbook.sheets[0].cells.get(3)?.display).toBe('21/11/2026');
    expect(workbook.sheets[0].cells.get(3 * 16384 + 3)?.display).toBe('ajouté');
    expect(workbook.sheets[0].cells.get(4)?.display).toBe('un');
    expect(workbook.sheets[0].cells.get(5)?.display).toBe('deux');
    expect(workbook.sheets[1].cells.get(0)?.display).toBe('Mis à jour');
    const archive = readZip(changed);
    const content = await readZipText(archive, 'content.xml');
    expect(content).toContain('Atelier &amp; pièces');
    expect(content).toContain('office:value="1234.5"');
    expect(content).toContain('office:date-value="2026-11-21T00:00:00.000Z"');
    expect(content).not.toContain('office:value="30"');
    expect(await readZipText(archive, 'meta.xml')).toContain('<meta:creator>Timo</meta:creator>');
    expect(original).not.toEqual(changed);
  });

  test('sans modification, retourne exactement les octets d’origine', async () => {
    const original = odsWorkbook();
    const workbook = await readOdsWorkbook(original);
    expect(await writeOds(original, {}, { author: 'Timo' })).toBe(original);
    expect(workbook.sheets).toHaveLength(2);
  });
});
