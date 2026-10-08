import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { JSONContent } from '@tiptap/core';
import { docxProblems, readDocxDocument, writeDocx } from './docx';
import { patchCoreProperties } from './ooxml';
import { readZip, readZipText } from './zip';
import { readDocx } from './docx-preview';
import { FormatError } from './file-formats';
import { wordDocx } from './test/docx-fixture';

const now = new Date(Date.UTC(2026, 9, 5, 10, 47, 0));
const write = (bytes: Uint8Array, doc: JSONContent) => writeDocx(bytes, doc, { author: 'T. Grollier', now });
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const block = (doc: JSONContent, id: string) => doc.content!.find((node) => node.attrs?.id === id)!;
const mainXml = async (bytes: Uint8Array) => (await readZipText(readZip(bytes), 'word/document.xml'))!;

/** Toutes les entrées sauf celles qui doivent changer : octets compressés identiques. */
function untouchedEntries(before: Uint8Array, after: Uint8Array, changed: string[]) {
  const a = readZip(before);
  const b = readZip(after);
  expect(b.entries.map((entry) => entry.name)).toEqual(a.entries.map((entry) => entry.name));
  for (const entry of a.entries) {
    if (changed.includes(entry.name)) continue;
    const other = b.byName.get(entry.name)!;
    expect(Buffer.from(after.subarray(other.localOffset, other.recordEnd)).equals(Buffer.from(before.subarray(entry.localOffset, entry.recordEnd))), entry.name).toBe(true);
  }
}

describe('documents Word : lecture', () => {
  it('titres, liens, listes, tableaux éditables ; image et table des matières conservées', async () => {
    const doc = await readDocxDocument(wordDocx());
    const types = doc.doc.content!.map((node) => `${node.type}:${node.attrs?.id}`);
    expect(types).toEqual(['docxParagraph:b0', 'docxParagraph:b1', 'docxParagraph:b2', 'docxParagraph:b3', 'docxParagraph:b4',
      'docxAtom:b5', 'table:b6', 'docxAtom:b7', 'docxParagraph:b8']);
    expect(block(doc.doc, 'b0').attrs).toMatchObject({ styleId: 'Titre1', level: 1 });
    expect(block(doc.doc, 'b4').attrs).toMatchObject({ numId: '1', ilvl: 1 });
    expect(block(doc.doc, 'b5').attrs).toMatchObject({ label: 'Image', text: 'schéma' });
    expect(block(doc.doc, 'b7').attrs).toMatchObject({ label: 'Table des matières' });
    const link = block(doc.doc, 'b2').content![1];
    expect(link.text).toBe('le guide');
    expect(link.marks!.find((mark) => mark.type === 'docxLink')!.attrs).toMatchObject({ href: 'https://exemple.fr/guide' });
    expect(doc.styles.map((style) => style.label)).toEqual(['Normal', 'Titre 1', 'Titre 2', 'Paragraphe de liste']);
    expect(doc.numbering['1'][1]).toMatchObject({ format: 'lowerLetter', text: '%2)' });
    expect(doc.author).toBe('Jean Dupont');
    expect(doc.readOnly).toBeNull();
  });

  it('suivi des modifications actif : lecture seule, et rien ne s’écrit', async () => {
    const bytes = wordDocx({ trackRevisions: true });
    const doc = await readDocxDocument(bytes);
    expect(doc.readOnly).toMatch(/suivi des modifications/);
    await expect(write(bytes, doc.doc)).rejects.toThrow(FormatError);
  });

  it('refuse un fichier qui n’est pas un document Word', async () => {
    await expect(readDocxDocument(new TextEncoder().encode('pas un zip'))).rejects.toThrow(/illisible/);
  });
});

describe('documents Word : écriture au plus juste', () => {
  it('rien de modifié : les octets d’origine, à l’identique', async () => {
    for (const bytes of [wordDocx(), wordDocx({ descriptor: true })]) {
      const doc = await readDocxDocument(bytes);
      expect(await write(bytes, clone(doc.doc))).toBe(bytes);
    }
  });

  it('un mot changé : seul son paragraphe et les propriétés du document changent', async () => {
    const bytes = wordDocx();
    const doc = await readDocxDocument(bytes);
    const edited = clone(doc.doc);
    block(edited, 'b1').content![2].text = ' chaque mardi.';
    const out = await write(bytes, edited);
    untouchedEntries(bytes, out, ['word/document.xml', 'docProps/core.xml']);

    const before = await mainXml(bytes);
    const after = await mainXml(out);
    const source = doc.sources.get('b1')!;
    expect(after.slice(0, source.el.start)).toBe(before.slice(0, source.el.start));
    const tail = before.slice(source.el.end);
    expect(after.endsWith(tail)).toBe(true);
    const paragraph = after.slice(source.el.start, after.length - tail.length);
    // Les propriétés d'origine des runs sont gardées ; le correcteur (proofErr) part.
    expect(paragraph).toContain('<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:i/><w:color w:val="FF0000"/><w:lang w:val="fr-FR"/></w:rPr><w:t xml:space="preserve">Laver </w:t>');
    expect(paragraph).toContain('<w:t xml:space="preserve"> chaque mardi.</w:t>');
    expect(paragraph.startsWith('<w:p w14:paraId="2B3C4D5E" w14:textId="77777777"><w:pPr><w:spacing w:before="60"/><w:ind w:left="0"/></w:pPr>')).toBe(true);

    const core = (await readZipText(readZip(out), 'docProps/core.xml'))!;
    expect(core).toContain('<cp:lastModifiedBy>T. Grollier</cp:lastModifiedBy>');
    expect(core).toContain('<cp:revision>4</cp:revision>');
    expect(core).toContain('<dcterms:modified xsi:type="dcterms:W3CDTF">2026-10-05T10:47:00Z</dcterms:modified>');
    expect(core).toContain('<dc:creator>Hélène Martin</dc:creator>');

    // Le résultat se relit, par l'aperçu comme par l'éditeur.
    const preview = await readDocx(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer);
    expect(JSON.stringify(preview)).toContain('chaque mardi.');
    expect((await readDocxDocument(out)).doc.content!.length).toBe(doc.doc.content!.length);
  });

  it('gras ajouté à sa place dans l’ordre exigé par Word ; gras retiré avec son jumeau', async () => {
    const bytes = wordDocx();
    const doc = await readDocxDocument(bytes);
    const edited = clone(doc.doc);
    const runs = block(edited, 'b1').content!;
    runs[0].marks!.push({ type: 'bold' });
    runs[1].marks = runs[1].marks!.filter((mark) => mark.type !== 'bold');
    const after = await mainXml(await write(bytes, edited));
    expect(after).toContain('<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:b/><w:i/><w:color w:val="FF0000"/><w:lang w:val="fr-FR"/></w:rPr><w:t xml:space="preserve">Laver </w:t>');
    // `<w:b/><w:bCs/>` retirés : la balise vide disparaît, et le run rejoint son voisin aux mêmes propriétés.
    expect(after).toContain('<w:r><w:t xml:space="preserve">le filtre</w:t><w:t xml:space="preserve"> chaque lundi.</w:t></w:r>');
  });

  it('Entrée : le nouveau paragraphe hérite des propriétés, sans identifiant Word ni signet en double', async () => {
    const bytes = wordDocx();
    const doc = await readDocxDocument(bytes);
    const edited = clone(doc.doc);
    const title = block(edited, 'b0');
    // Scission au milieu du titre : ProseMirror garde les attributs des deux côtés.
    const second = clone(title);
    title.content![0].text = 'Filtra';
    second.content![0].text = 'tion';
    edited.content!.splice(1, 0, second);
    const after = await mainXml(await write(bytes, edited));
    expect(after).toContain('<w:p w14:paraId="1A2B3C4D" w14:textId="77777777" w:rsidR="00A1"><w:pPr><w:pStyle w:val="Titre1"/><w:spacing w:after="120"/></w:pPr><w:bookmarkStart w:id="0" w:name="_Toc1"/><w:r><w:t xml:space="preserve">Filtra</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>');
    expect(after).toContain('<w:p><w:pPr><w:pStyle w:val="Titre1"/><w:spacing w:after="120"/></w:pPr><w:r><w:t xml:space="preserve">tion</w:t></w:r></w:p>');
    expect(after.match(/_Toc1/g)).toHaveLength(1);
  });

  it('style et alignement : pStyle en tête, jc à sa place ; niveau de liste', async () => {
    const bytes = wordDocx();
    const doc = await readDocxDocument(bytes);
    const edited = clone(doc.doc);
    Object.assign(block(edited, 'b1').attrs!, { styleId: 'Titre2', level: 2, align: 'center' });
    block(edited, 'b3').attrs!.ilvl = 1;
    const after = await mainXml(await write(bytes, edited));
    expect(after).toContain('<w:pPr><w:pStyle w:val="Titre2"/><w:spacing w:before="60"/><w:ind w:left="0"/><w:jc w:val="center"/></w:pPr>');
    expect(after).toContain('<w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">Arrêter la pompe</w:t></w:r>');
  });

  it('liste : numPr posé à sa place en y entrant, retiré en sortant ; paragraphe neuf sur le modèle donné (basedOn)', async () => {
    const bytes = wordDocx();
    const doc = await readDocxDocument(bytes);
    const edited = clone(doc.doc);
    Object.assign(block(edited, 'b1').attrs!, { numId: '1', ilvl: 0 });
    Object.assign(block(edited, 'b3').attrs!, { numId: null, ilvl: null });
    // Après le titre, deux paragraphes neufs proposés par l'IA : l'un sur le modèle d'un élément de liste, l'autre sur aucun.
    edited.content!.splice(1, 0,
      { type: 'docxParagraph', attrs: { styleId: 'Paragraphedeliste', numId: '1', ilvl: 1, basedOn: 'b4' }, content: [{ type: 'text', text: 'Purger' }] },
      { type: 'docxParagraph', attrs: { basedOn: '' }, content: [{ type: 'text', text: 'Sans modèle' }] });
    const after = await mainXml(await write(bytes, edited));
    expect(after).toContain('<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:spacing w:before="60"/><w:ind w:left="0"/></w:pPr>');
    expect(after).toContain('<w:p><w:pPr><w:pStyle w:val="Paragraphedeliste"/></w:pPr><w:r><w:t xml:space="preserve">Arrêter la pompe</w:t></w:r></w:p>');
    expect(after).toContain('<w:p><w:pPr><w:pStyle w:val="Paragraphedeliste"/><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">Purger</w:t></w:r></w:p>');
    // Sans `basedOn`, il aurait hérité du titre qui le précède (son espacement).
    expect(after).toContain('<w:p><w:r><w:t xml:space="preserve">Sans modèle</w:t></w:r></w:p>');
  });

  it('texte d’un lien modifié : la balise et la cible d’origine restent', async () => {
    const bytes = wordDocx();
    const doc = await readDocxDocument(bytes);
    const edited = clone(doc.doc);
    block(edited, 'b2').content![1].text = 'le guide 2026';
    const after = await mainXml(await write(bytes, edited));
    expect(after).toContain('<w:hyperlink r:id="rId9" w:history="1"><w:r><w:rPr><w:rStyle w:val="Lienhypertexte"/></w:rPr><w:t xml:space="preserve">le guide 2026</w:t></w:r></w:hyperlink>');
  });

  it('cellule de tableau modifiée : seule elle change ; structure modifiée refusée', async () => {
    const bytes = wordDocx();
    const doc = await readDocxDocument(bytes);
    const edited = clone(doc.doc);
    const table = block(edited, 'b6');
    table.content![1].content![1].content![0].content![0].text = '7,4';
    const before = await mainXml(bytes);
    const after = await mainXml(await write(bytes, edited));
    expect(after).toBe(before.replace('<w:p><w:r><w:t>7,2</w:t></w:r></w:p>', '<w:p><w:r><w:t xml:space="preserve">7,4</w:t></w:r></w:p>'));

    table.content!.push(clone(table.content![1]));
    expect(docxProblems(doc, edited)).toHaveLength(1);
    await expect(write(bytes, edited)).rejects.toThrow(/lignes et colonnes/);
  });

  it('objets conservés : recopiés tels quels, supprimés s’ils sont retirés, jamais en double', async () => {
    const bytes = wordDocx();
    const doc = await readDocxDocument(bytes);
    const before = await mainXml(bytes);
    const edited = clone(doc.doc);
    edited.content = edited.content!.filter((node) => node.attrs?.id !== 'b5');
    edited.content.push(clone(block(edited, 'b7')));
    block(edited, 'b8').content = [{ type: 'text', text: 'Fin' }];
    const after = await mainXml(await write(bytes, edited));
    expect(after).not.toContain('<w:drawing>');
    expect(after.match(/Table of Contents/g)).toHaveLength(1);
    const sdt = doc.sources.get('b7')!;
    expect(after).toContain(before.slice(sdt.el.start, sdt.el.end));
    // La section finale reste la dernière.
    expect(after).toMatch(/<w:p><w:r><w:t xml:space="preserve">Fin<\/w:t><\/w:r><\/w:p><w:sectPr w:rsidR="00A1">/);
  });

  it('échappe le texte tapé et ne laisse passer aucun caractère interdit en XML', async () => {
    const bytes = wordDocx();
    const doc = await readDocxDocument(bytes);
    const edited = clone(doc.doc);
    block(edited, 'b8').content = [{ type: 'text', text: 'pH < 7 & chlore > 1\u0001\tfin' }];
    const after = await mainXml(await write(bytes, edited));
    expect(after).toContain('<w:t xml:space="preserve">pH &lt; 7 &amp; chlore &gt; 1</w:t><w:tab/><w:t xml:space="preserve">fin</w:t>');
  });

  it('propriétés du document : seul le texte des trois champs change', () => {
    const core = '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dcterms="http://purl.org/dc/terms/"><cp:lastModifiedBy/><cp:revision>9</cp:revision><dcterms:modified>x</dcterms:modified></cp:coreProperties>';
    expect(patchCoreProperties(core, 'A & B', now)).toBe('<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dcterms="http://purl.org/dc/terms/"><cp:lastModifiedBy>A &amp; B</cp:lastModifiedBy><cp:revision>10</cp:revision><dcterms:modified>2026-10-05T10:47:00Z</dcterms:modified></cp:coreProperties>');
  });

  it('document de LibreOffice (fixture réelle) : identique sans modification, valide après une', async () => {
    const buffer = fs.readFileSync(path.resolve('src/__fixtures__/procedure.docx'));
    const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const doc = await readDocxDocument(bytes);
    expect(await write(bytes, clone(doc.doc))).toBe(bytes);
    const edited = clone(doc.doc);
    const first = edited.content!.find((node) => node.type === 'docxParagraph' && node.content?.length)!;
    first.content![0].text = `${first.content![0].text} (révisé)`;
    const out = await write(bytes, edited);
    untouchedEntries(bytes, out, ['word/document.xml', 'docProps/core.xml']);
    const preview = await readDocx(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer);
    expect(JSON.stringify(preview)).toContain('(révisé)');
  });
});
