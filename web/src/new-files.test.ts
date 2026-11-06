import { describe, expect, it } from 'vitest';
import { fileNameProblem, newFileBytes, procedureFileBytes, withExtension } from './new-files';
import { readZip, readZipText } from './zip';
import { readDocxDocument, writeDocx } from './docx';
import { cellView, readXlsxWorkbook, writeXlsx } from './xlsx';
import { decodeText } from './text-codec';
import { parseCsvFile } from './csv-file';

const now = new Date(Date.UTC(2026, 9, 6, 9, 30));

async function wellFormed(bytes: Uint8Array) {
  const archive = readZip(bytes);
  for (const entry of archive.entries) {
    const doc = new DOMParser().parseFromString((await readZipText(archive, entry.name))!, 'application/xml');
    expect(doc.getElementsByTagName('parsererror').length, entry.name).toBe(0);
  }
  return archive;
}

describe('fichiers neufs du dossier partagé', () => {
  it('nom accepté par Windows, extension ajoutée si besoin', () => {
    expect(fileNameProblem('Procédure sauvegarde')).toBeNull();
    expect(fileNameProblem('  ')).toBe('Donne un nom au fichier.');
    expect(fileNameProblem('a/b')).toMatch(/Caractère refusé par Windows.*« \/ »/);
    expect(fileNameProblem('Rapport?')).toMatch(/« \? »/);
    expect(fileNameProblem('notes.')).toMatch(/finir par un point/);
    expect(fileNameProblem('CON')).toMatch(/réservé par Windows/);
    expect(fileNameProblem('nul.txt')).toMatch(/réservé par Windows/);
    expect(fileNameProblem('~$brouillon')).toMatch(/fichier technique/);
    expect(withExtension('Procédure sauvegarde', 'docx')).toBe('Procédure sauvegarde.docx');
    expect(withExtension('Budget.XLSX', 'xlsx')).toBe('Budget.XLSX');
  });

  it('nom de dossier : mêmes règles de Windows, caché refusé, « ~ » et chiffres admis', () => {
    expect(fileNameProblem('3. Sauvegardes', 'dossier')).toBeNull();
    expect(fileNameProblem('20241231', 'dossier')).toBeNull();
    expect(fileNameProblem('~Archives', 'dossier')).toBeNull();
    expect(fileNameProblem('', 'dossier')).toBe('Donne un nom au dossier.');
    expect(fileNameProblem('a:b', 'dossier')).toBe('Caractère refusé par Windows dans un nom de dossier : « : ».');
    expect(fileNameProblem('Archives.', 'dossier')).toBe('Un nom de dossier ne peut pas finir par un point ou une espace sous Windows.');
    expect(fileNameProblem('.git', 'dossier')).toMatch(/resterait caché/);
    expect(fileNameProblem('AUX', 'dossier')).toMatch(/réservé par Windows/);
  });

  it('document Word : titre du fichier en Titre 1, auteur, se relit et se modifie', async () => {
    const bytes = await newFileBytes('docx', { title: 'Procédure sauvegarde', author: 'T. Grollier', now });
    const archive = await wellFormed(bytes);
    expect(archive.entries[0].name).toBe('[Content_Types].xml');
    const doc = await readDocxDocument(bytes);
    expect(doc.readOnly).toBeNull();
    expect(doc.author).toBe('T. Grollier');
    expect(doc.doc.content?.[0]).toMatchObject({ type: 'docxParagraph', attrs: { styleId: 'Titre1', level: 1 }, content: [{ text: 'Procédure sauvegarde' }] });
    expect(doc.styles.map((style) => style.label)).toEqual(expect.arrayContaining(['Normal', 'Titre']));
    // Un paragraphe tapé dans l'éditeur : le fichier se réécrit sans encombre.
    const edited = { ...doc.doc, content: [...doc.doc.content!.slice(0, 1), { type: 'docxParagraph', attrs: { id: null }, content: [{ type: 'text', text: 'Arrêter le service.' }] }] };
    const out = await writeDocx(bytes, edited, { author: 'T. Grollier', now });
    await wellFormed(out);
    expect(await readZipText(readZip(out), 'word/document.xml')).toContain('Arrêter le service.');
  });

  it('classeur Excel : une feuille vide, du texte et des nombres s’y écrivent', async () => {
    const bytes = await newFileBytes('xlsx', { title: 'Budget', author: 'T. Grollier', now });
    await wellFormed(bytes);
    const workbook = await readXlsxWorkbook(bytes);
    expect(workbook.readOnly).toBeNull();
    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual(['Feuil1']);
    const out = await writeXlsx(bytes, { Feuil1: { A1: 'Poste', B1: 'Montant', A2: 'Achat', B2: '1 234,5' } }, { author: 'T. Grollier', now });
    await wellFormed(out);
    const again = await readXlsxWorkbook(out);
    const sheet = again.sheets[0];
    expect(cellView(again, sheet, 0, 0).display).toBe('Poste');
    expect(cellView(again, sheet, 1, 1).display).toBe('1234,5');
    expect(await readZipText(readZip(out), 'xl/worksheets/sheet1.xml')).toContain('<dimension ref="A1:B2"/>');
    expect(await readZipText(readZip(out), 'xl/sharedStrings.xml')).toContain('count="3" uniqueCount="3"');
  });

  it('Markdown : le titre ; texte et CSV : UTF-8 avec BOM, pour les accents dans le Bloc-notes et Excel', async () => {
    expect(new TextDecoder().decode(await newFileBytes('md', { title: 'Consignes', author: '' }))).toBe('# Consignes\n\n');
    const txt = await newFileBytes('txt', { title: 'Notes', author: '' });
    expect(decodeText(txt).encoding).toBe('utf-8-bom');
    const csv = parseCsvFile(await newFileBytes('csv', { title: 'Relevés', author: '' }), 'Relevés.csv');
    expect(csv.encoding).toBe('utf-8-bom');
    expect(csv.delimiter).toBe(';');
  });
});

describe('procédure locale envoyée vers le partage', () => {
  it('Markdown : le titre en tête, sans doublon quand le texte a déjà son `# …`', async () => {
    const plain = new TextDecoder().decode(await procedureFileBytes('md', { title: 'Sauvegarde', markdown: '## Objectif\n\nCouper le courant.\n', author: '' }));
    expect(plain).toBe('# Sauvegarde\n\n## Objectif\n\nCouper le courant.\n');
    const headed = new TextDecoder().decode(await procedureFileBytes('md', { title: 'Sauvegarde', markdown: '# Sauvegarde\n\nCouper le courant.\n', author: '' }));
    expect(headed).toBe('# Sauvegarde\n\nCouper le courant.\n');
    expect(new TextDecoder().decode(await procedureFileBytes('md', { title: 'Vide', markdown: '', author: '' }))).toBe('# Vide\n\n');
  });

  it('Texte : titre puis contenu, UTF-8 avec BOM pour les accents du TSE', async () => {
    const bytes = await procedureFileBytes('txt', { title: 'Sauvegarde', markdown: 'Couper le courant : **vérifié**.\n', author: '' });
    const decoded = decodeText(bytes);
    expect(decoded.encoding).toBe('utf-8-bom');
    expect(decoded.text).toBe('Sauvegarde\n\nCouper le courant : vérifié.\n');
  });

  it('Word : titre en Titre 1, sections, puces et numéros lisibles, bien formé', async () => {
    const markdown = '# Sauvegarde\n\n## Objectif\n\nCouper le courant.\n\n- Filtre lavé\n- [x] pH vérifié\n\n1. Arrêter le service\n2. Rincer\n\n```\nsystemctl stop\n```\n\n> Décision : le lundi.\n';
    const bytes = await procedureFileBytes('docx', { title: 'Sauvegarde', markdown, author: 'T. Grollier', now });
    const archive = await wellFormed(bytes);
    expect(archive.entries[0].name).toBe('[Content_Types].xml');
    const xmlDoc = (await readZipText(readZip(bytes), 'word/document.xml'))!;
    expect(xmlDoc).toContain('<w:pStyle w:val="Titre1"/><');
    expect(xmlDoc).toContain('Sauvegarde');
    expect(xmlDoc).toContain('Objectif');
    expect(xmlDoc).toContain('• Filtre lavé');
    expect(xmlDoc).toContain('☑ pH vérifié');
    expect(xmlDoc).toContain('1. Arrêter le service');
    expect(xmlDoc).toContain('systemctl stop');
    expect(xmlDoc).not.toContain('```');
    // Le `# …` du texte ne fait pas doublon : un seul `Titre1`, celui du titre.
    expect(xmlDoc.match(/Titre1/g)!.length).toBe(1);
    expect(xmlDoc.match(/Sauvegarde/g)!.length).toBe(1);
    const doc = await readDocxDocument(bytes);
    expect(doc.readOnly).toBeNull();
    expect(doc.doc.content?.[0]).toMatchObject({ type: 'docxParagraph', attrs: { styleId: 'Titre1', level: 1 } });
  });

  it('Word : caractères spéciaux échappés, vide réduit au titre', async () => {
    const bytes = await procedureFileBytes('docx', { title: 'A & B <test>', markdown: '', author: '', now });
    const xmlDoc = (await readZipText(readZip(bytes), 'word/document.xml'))!;
    expect(xmlDoc).toContain('A &amp; B &lt;test&gt;');
    await wellFormed(bytes);
  });
});
