import { describe, expect, it } from 'vitest';
import { readZip, readZipText } from './zip';
import { officeAuthor } from './ooxml';
import { cellReadOnly, cellView, effectiveEdits, gridSize, readXlsxWorkbook, writeXlsx, xlsxProblems, type XlsxWorkbook } from './xlsx';
import { excelWorkbook, miniWorkbook } from './test/xlsx-fixture';

const now = new Date(Date.UTC(2026, 9, 5, 10, 47));
const nb = (text: string) => text.replace(/ /g, ' ');
const write = (bytes: Uint8Array, edits: Record<string, Record<string, string>>) => writeXlsx(bytes, edits, { author: 'Timothée Grollier', now });
const part = async (bytes: Uint8Array, name: string) => readZipText(readZip(bytes), name);
const view = (workbook: XlsxWorkbook, sheet: string, ref: string, edits?: Record<string, string>) => {
  const target = workbook.sheets.find((candidate) => candidate.name === sheet)!;
  const match = /^([A-Z]+)(\d+)$/.exec(ref)!;
  const col = [...match[1]].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0) - 1;
  return cellView(workbook, target, Number(match[2]) - 1, col, edits);
};

/** Toutes les entrées de l'archive sauf celles nommées : octet pour octet identiques. */
async function untouchedExcept(before: Uint8Array, after: Uint8Array, changed: string[]) {
  const a = readZip(before);
  const b = readZip(after);
  for (const entry of a.entries) {
    if (changed.includes(entry.name)) continue;
    const other = b.byName.get(entry.name);
    expect(other, entry.name).toBeTruthy();
    expect(Buffer.from(after.subarray(other!.localOffset, other!.recordEnd)).equals(Buffer.from(before.subarray(entry.localOffset, entry.recordEnd))), entry.name).toBe(true);
  }
}

async function wellFormed(bytes: Uint8Array) {
  const archive = readZip(bytes);
  for (const entry of archive.entries) {
    if (!entry.name.endsWith('.xml') && !entry.name.endsWith('.rels')) continue;
    const doc = new DOMParser().parseFromString((await readZipText(archive, entry.name))!, 'application/xml');
    expect(doc.getElementsByTagName('parsererror').length, entry.name).toBe(0);
  }
}

describe('classeurs Excel (.xlsx) : lecture', () => {
  it('feuilles, valeurs affichées à la française, formules dans la barre', async () => {
    const workbook = await readXlsxWorkbook(excelWorkbook());
    expect(workbook.sheets.map((sheet) => [sheet.name, sheet.hidden])).toEqual([['Suivi', false], ['Paramètres', true], ['Résumé', false]]);
    expect(workbook.author).toBe('Jean Dupont');
    expect(view(workbook, 'Suivi', 'A1').display).toBe('Tâche');
    expect(view(workbook, 'Suivi', 'B2')).toMatchObject({ display: nb('1 234,50') + ' €', input: '1234,5' });
    expect(view(workbook, 'Suivi', 'C2')).toMatchObject({ display: '05/10/2026', input: '05/10/2026' });
    expect(view(workbook, 'Suivi', 'D2')).toMatchObject({ display: nb('2 469,00') + ' €', input: '=B2*2' });
    expect(view(workbook, 'Suivi', 'B4')).toMatchObject({ display: nb('1 334,50') + ' €', input: '=SOMME(B2:B3)' });
    expect(view(workbook, 'Suivi', 'A3').display).toBe('Location');
    expect(view(workbook, 'Suivi', 'A5').display).toBe('Note fusionnée');
    expect(view(workbook, 'Suivi', 'A6').display).toBe('VRAI');
    expect(view(workbook, 'Suivi', 'B6').display).toBe('#DIV/0!');
    expect(view(workbook, 'Suivi', 'C6')).toMatchObject({ display: '12,50%', input: '12,5%' });
    expect(view(workbook, 'Suivi', 'D6')).toMatchObject({ display: '0123', input: '0123' });
    expect(view(workbook, 'Résumé', 'A1').input).toBe('=SOMME(Suivi!B2:B3)*(1+Taux)');
    expect(gridSize(workbook.sheets[0])).toEqual({ rows: 7, cols: 5, truncated: false });
    expect(await officeAuthor(excelWorkbook({ author: 'Marie Curie' }))).toBe('Marie Curie');
  });

  it('lecture seule motivée : en-tête de tableau, fusion, formule recopiée, feuille protégée', async () => {
    const workbook = await readXlsxWorkbook(excelWorkbook());
    const [suivi, parametres, resume] = workbook.sheets;
    expect(cellReadOnly(workbook, suivi, 0, 1)).toMatch(/En-tête du tableau « Achats »/);
    expect(cellReadOnly(workbook, suivi, 4, 1)).toMatch(/fusionnée avec A5/);
    expect(cellReadOnly(workbook, suivi, 4, 0)).toBeNull();
    expect(cellReadOnly(workbook, suivi, 1, 3)).toMatch(/Formule recopiée sur D2:D3/);
    expect(cellReadOnly(workbook, suivi, 2, 3)).toBeNull();
    expect(cellReadOnly(workbook, parametres, 0, 0)).toMatch(/protégée/);
    expect(cellReadOnly(workbook, parametres, 0, 1)).toBeNull();
    expect(cellReadOnly(workbook, parametres, 4, 4)).toMatch(/protégée/);
    expect(cellReadOnly(workbook, resume, 0, 0)).toBeNull();
  });

  it('classeur à macros, protégé en modification, OOXML strict', async () => {
    expect((await readXlsxWorkbook(excelWorkbook({ macro: true }))).readOnly).toMatch(/macros/);
    expect((await readXlsxWorkbook(excelWorkbook({ reservation: true }))).readOnly).toMatch(/mot de passe de modification/);
    await expect(readXlsxWorkbook(excelWorkbook({ strict: true }))).rejects.toThrow(/strict/);
    await expect(write(excelWorkbook({ macro: true }), { Suivi: { B3: '1' } })).rejects.toThrow(/macros/);
  });
});

describe('classeurs Excel (.xlsx) : écriture cellule par cellule', () => {
  it('rien de modifié, ou une saisie identique : les octets d’origine', async () => {
    const bytes = excelWorkbook();
    expect(await write(bytes, {})).toBe(bytes);
    expect(await write(bytes, { Suivi: { B2: '1234,5', D2: '=B2*2', C2: '05/10/2026' } })).toBe(bytes);
    const workbook = await readXlsxWorkbook(bytes);
    expect(effectiveEdits(workbook, { Suivi: { B2: '1234,5', B3: '7' } })).toEqual({ Suivi: { B3: '7' } });
  });

  it('un nombre : sa balise <c> change, les formules qui le lisent perdent leur valeur d’avant', async () => {
    const bytes = excelWorkbook();
    const out = await write(bytes, { Suivi: { B3: '250' } });
    const before = (await part(bytes, 'xl/worksheets/sheet1.xml'))!;
    const after = (await part(out, 'xl/worksheets/sheet1.xml'))!;
    // D3 (copie de =B2*2, donc =B3*2) et B4 (=SUM(B2:B3)) lisent B3 ; D2 non.
    expect(after).toBe(before
      .replace('<c r="B3" s="2"><v>100</v></c>', '<c r="B3" s="2"><v>250</v></c>')
      .replace('<f t="shared" si="0"/><v>200</v>', '<f t="shared" si="0"/>')
      .replace('<f>SUM(B2:B3)</f><v>1334.5</v>', '<f>SUM(B2:B3)</f>'));
    // Autre feuille, à travers un nom défini : Résumé!A1 = SUM(Suivi!B2:B3)*(1+Taux).
    expect(await part(out, 'xl/worksheets/sheet3.xml')).toBe((await part(bytes, 'xl/worksheets/sheet3.xml'))!.replace('<v>1601.4</v>', ''));
    expect(await part(out, 'xl/workbook.xml')).toBe((await part(bytes, 'xl/workbook.xml'))!.replace('<calcPr calcId="191029"/>', '<calcPr calcId="191029" fullCalcOnLoad="1"/>'));
    const core = (await part(out, 'docProps/core.xml'))!;
    expect(core).toContain('<cp:lastModifiedBy>Timothée Grollier</cp:lastModifiedBy>');
    expect(core).toContain('<dcterms:modified xsi:type="dcterms:W3CDTF">2026-10-05T10:47:00Z</dcterms:modified>');
    await untouchedExcept(bytes, out, ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet3.xml', 'xl/workbook.xml', 'docProps/core.xml']);
    await wellFormed(out);
    const again = await readXlsxWorkbook(out);
    expect(view(again, 'Suivi', 'B3').display).toBe('250,00 €');
    // À recalculer : WorkLogs montre la formule plutôt qu'une valeur périmée.
    expect(view(again, 'Suivi', 'B4').display).toBe('=SOMME(B2:B3)');
    expect(view(again, 'Suivi', 'D2').display).toBe(nb('2 469,00') + ' €');
  });

  it('du texte : ajouté à la fin des chaînes partagées, jamais une chaîne existante modifiée', async () => {
    const bytes = excelWorkbook();
    const out = await write(bytes, { Suivi: { A3: 'Location longue durée', A2: 'Total' } });
    const sheet = (await part(out, 'xl/worksheets/sheet1.xml'))!;
    expect(sheet).toContain('<c r="A3" t="s"><v>9</v></c>');
    // « Total » existe déjà : réutilisé, sans nouvelle entrée.
    expect(sheet).toContain('<c r="A2" t="s"><v>4</v></c>');
    const sst = (await part(out, 'xl/sharedStrings.xml'))!;
    const original = (await part(bytes, 'xl/sharedStrings.xml'))!;
    expect(sst).toBe(original.replace('count="10" uniqueCount="9"', 'count="11" uniqueCount="10"').replace('</sst>', '<si><t>Location longue durée</t></si></sst>'));
    await wellFormed(out);
    expect(view(await readXlsxWorkbook(out), 'Suivi', 'A3').display).toBe('Location longue durée');
  });

  it('sans chaînes partagées : texte en ligne', async () => {
    const bytes = excelWorkbook({ sharedStrings: false });
    const out = await write(bytes, { Suivi: { A3: ' deux  espaces ' } });
    expect(await part(out, 'xl/worksheets/sheet1.xml')).toContain('<c r="A3" t="inlineStr"><is><t xml:space="preserve"> deux  espaces </t></is></c>');
    expect(view(await readXlsxWorkbook(out), 'Suivi', 'A3').display).toBe(' deux  espaces ');
  });

  it('formules : écrites en anglais sans valeur, chaîne de calcul retirée avec sa relation et son type', async () => {
    const bytes = excelWorkbook();
    const out = await write(bytes, { Suivi: { D3: '=B3*3', B4: '=SOMME(B2:B3;10)' } });
    const sheet = (await part(out, 'xl/worksheets/sheet1.xml'))!;
    expect(sheet).toContain('<c r="D3" s="2"><f>B3*3</f></c>');
    expect(sheet).toContain('<c r="B4" s="2"><f>SUM(B2:B3,10)</f></c>');
    const archive = readZip(out);
    expect(archive.byName.has('xl/calcChain.xml')).toBe(false);
    expect(await readZipText(archive, 'xl/_rels/workbook.xml.rels')).not.toContain('calcChain');
    expect(await readZipText(archive, '[Content_Types].xml')).not.toContain('calcChain');
    expect(await readZipText(archive, 'xl/workbook.xml')).toContain('fullCalcOnLoad="1"');
    await untouchedExcept(bytes, out, ['xl/worksheets/sheet1.xml', 'xl/workbook.xml', 'docProps/core.xml', 'xl/calcChain.xml', 'xl/_rels/workbook.xml.rels', '[Content_Types].xml']);
    await wellFormed(out);
    // Pas encore calculée par Excel : la formule s'affiche.
    expect(view(await readXlsxWorkbook(out), 'Suivi', 'D3')).toMatchObject({ display: '=B3*3', input: '=B3*3' });
  });

  it('formules à recalculer : de proche en proche ; une formule liée à un autre classeur garde sa valeur', async () => {
    const bytes = excelWorkbook();
    // Le taux (feuille masquée, cellule non verrouillée) : seul Résumé!A1 le lit, par le nom « Taux ».
    const out = await write(bytes, { Paramètres: { B1: '0,3' } });
    expect(await part(out, 'xl/worksheets/sheet1.xml')).toBe(await part(bytes, 'xl/worksheets/sheet1.xml'));
    expect(await part(out, 'xl/worksheets/sheet3.xml')).not.toContain('<v>1601.4</v>');
    // Une valeur modifiée hors de toute plage lue : aucune formule touchée.
    const quiet = await write(bytes, { Suivi: { A3: 'Loyer' } });
    expect(await part(quiet, 'xl/worksheets/sheet3.xml')).toBe(await part(bytes, 'xl/worksheets/sheet3.xml'));
    expect(await part(quiet, 'xl/worksheets/sheet1.xml')).toContain('<v>1334.5</v>');
  });

  it('cellule nouvelle juste devant une formule qui la lit : les deux retouches au même endroit, dans l’ordre', async () => {
    const out = await write(miniWorkbook('<row r="1" spans="2:2"><c r="B1" t="str"><f>A1&amp;"!"</f><v>!</v></c></row>'), { Feuil1: { A1: 'Bonjour' } });
    expect(await part(out, 'xl/worksheets/sheet1.xml')).toContain('<row r="1" spans="1:2"><c r="A1" t="inlineStr"><is><t>Bonjour</t></is></c><c r="B1"><f>A1&amp;"!"</f></c></row>');
    await wellFormed(out);
  });

  it('sans <calcPr> : ajouté à sa place dans le classeur', async () => {
    const out = await write(excelWorkbook({ calcPr: false, calcChain: false }), { Suivi: { B3: '1' } });
    expect(await part(out, 'xl/workbook.xml')).toContain('</definedNames><calcPr fullCalcOnLoad="1"/><extLst>');
  });

  it('cellules et lignes nouvelles : à leur place, étendue et largeur de ligne à jour', async () => {
    const bytes = excelWorkbook();
    const out = await write(bytes, { Suivi: { E2: 'x', C7: '3', A8: 'fin' }, Résumé: { B3: '1', A2: '2' } });
    const sheet = (await part(out, 'xl/worksheets/sheet1.xml'))!;
    expect(sheet).toContain('<dimension ref="A1:E8"/>');
    expect(sheet).toContain('<row r="2" spans="1:5" x14ac:dyDescent="0.3">');
    expect(sheet).toMatch(/<c r="D2" s="2"><f t="shared" ref="D2:D3" si="0">B2\*2<\/f><v>2469<\/v><\/c><c r="E2" t="s"><v>9<\/v><\/c><\/row>/);
    // C7 : style de la colonne C (date) ; « 3 » y devient le 3 janvier 1900.
    expect(sheet).toContain('</row><row r="7"><c r="C7" s="1"><v>3</v></c></row><row r="8"><c r="A8" t="s"><v>10</v></c></row></sheetData>');
    const resume = (await part(out, 'xl/worksheets/sheet3.xml'))!;
    expect(resume).toContain('<sheetData><row r="1"><c r="A1" s="2"><f>SUM(Suivi!B2:B3)*(1+Taux)</f><v>1601.4</v></c></row><row r="2"><c r="A2"><v>2</v></c></row><row r="3" ht="20" customHeight="1"><c r="B3"><v>1</v></c></row></sheetData>');
    expect(resume).toContain('<dimension ref="A1:B3"/>');
    await wellFormed(out);
  });

  it('saisie lue selon le format de la cellule : date, zéros de tête, effacement', async () => {
    const bytes = excelWorkbook();
    const out = await write(bytes, { Suivi: { C3: '06/10/2026', B3: '0456', C6: '' } });
    const sheet = (await part(out, 'xl/worksheets/sheet1.xml'))!;
    expect(sheet).toContain('<c r="C3" s="1"><v>46301</v></c>');
    expect(sheet).toContain('<c r="B3" s="2" t="s"><v>9</v></c>');
    expect(sheet).toContain('<c r="C6" s="3"/>');
    const workbook = await readXlsxWorkbook(out);
    expect(view(workbook, 'Suivi', 'C3').display).toBe('06/10/2026');
    expect(view(workbook, 'Suivi', 'B3').display).toBe('0456');
  });

  it('aperçu dans la grille avant envoi, au format de la cellule', async () => {
    const workbook = await readXlsxWorkbook(excelWorkbook());
    expect(view(workbook, 'Suivi', 'B3', { B3: '2500' })).toMatchObject({ display: nb('2 500,00') + ' €', input: '2500' });
    expect(view(workbook, 'Suivi', 'C3', { C3: '6/10/26' }).display).toBe('06/10/2026');
    expect(view(workbook, 'Suivi', 'D3', { D3: '=B3*3' }).display).toBe('=B3*3');
  });

  it('problèmes en clair : formule fautive, cellule protégée ; rien n’est écrit', async () => {
    const bytes = excelWorkbook();
    const workbook = await readXlsxWorkbook(bytes);
    const edits = { Suivi: { B3: '=SOMME(B2:B3', A1: 'Titre' }, Paramètres: { A1: 'x', B1: '0,3' } };
    const problems = xlsxProblems(workbook, edits);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/^Suivi!B3 : formule incomprise/);
    expect(problems[1]).toMatch(/^Suivi!A1 : En-tête du tableau/);
    expect(problems[2]).toMatch(/^Paramètres!A1 : Feuille protégée/);
    await expect(write(bytes, edits)).rejects.toThrow(/formule incomprise/);
    const ok = await write(bytes, { Paramètres: { B1: '0,3' } });
    expect(await part(ok, 'xl/worksheets/sheet2.xml')).toContain('<c r="B1" s="5"><v>0.3</v></c>');
  });
});
