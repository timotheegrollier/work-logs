import { describe, expect, it } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { readDocxDocument, writeDocx } from './docx';
import { docxFromAi, docxPreview, docxToAi } from './docx-markdown';
import { newFileBytes } from './new-files';
import { readZip, readZipText } from './zip';
import { wordDocx } from './test/docx-fixture';

const now = new Date(Date.UTC(2026, 9, 8, 9, 30, 0));
const mainXml = async (bytes: Uint8Array) => (await readZipText(readZip(bytes), 'word/document.xml'))!;
const write = (bytes: Uint8Array, doc: JSONContent) => writeDocx(bytes, doc, { author: 'T. Grollier', now });
const blocks = (doc: JSONContent) => (doc.content ?? []).map((node) => `${node.type}:${node.attrs?.id ?? 'neuf'}`);
const textOf = (node: JSONContent) => (node.content ?? []).map((child) => child.text ?? '').join('');

async function fixture() {
  const bytes = wordDocx();
  const document = await readDocxDocument(bytes);
  return { bytes, document };
}

describe('document Word → Markdown pour l’IA', () => {
  it('titres et listes du document, liens avec leur cible, objets en marqueurs numérotés', async () => {
    const { document } = await fixture();
    const source = docxToAi(document.doc, document);
    expect(source.markdown).toBe([
      '# Filtration',
      '*Laver* **le filtre** chaque lundi.',
      'Voir [le guide](https://exemple.fr/guide).',
      '1. Arrêter la pompe\n   1. Vanne fermée',
      '[[objet 1 : Image — schéma]]',
      '[[objet 2 : Tableau — Mesure | Valeur / pH | 7,2]]',
      '[[objet 3 : Table des matières — Table des matières]]',
    ].join('\n\n'));
    expect(source.title).toBe('Filtration');
    expect(source.keep).toEqual([]);
    expect([...source.objects.values()].map((node) => node.attrs?.id)).toEqual(['b5', 'b6', 'b7']);
  });

  it('suggestion de procédure : le titre du document reste en tête, l’IA écrit la suite', async () => {
    const { document } = await fixture();
    const source = docxToAi(document.doc, document, { procedure: true });
    expect(source.title).toBe('Filtration');
    expect(source.keep.map((node) => node.attrs?.id)).toEqual(['b0']);
    expect(source.markdown.startsWith('*Laver* **le filtre** chaque lundi.')).toBe(true);
  });
});

describe('proposition de l’IA → document Word', () => {
  it('texte inchangé : chaque paragraphe reste celui d’origine, octet pour octet', async () => {
    const { bytes, document } = await fixture();
    const source = docxToAi(document.doc, document);
    const proposed = docxFromAi(source.markdown, source);
    expect(blocks(proposed)).toEqual(['docxParagraph:b0', 'docxParagraph:b1', 'docxParagraph:b2', 'docxParagraph:b3', 'docxParagraph:b4',
      'docxAtom:b5', 'table:b6', 'docxAtom:b7']);
    // Seul le paragraphe vide de la fin disparaît : le Markdown n'en a pas.
    const before = await mainXml(bytes);
    expect(await mainXml(await write(bytes, proposed))).toBe(before.replace('<w:p/><w:sectPr', '<w:sectPr'));
  });

  it('styles propres au document : un paragraphe gardé garde le sien, un neuf prend celui du texte courant', async () => {
    const bytes = wordDocx({ body: [
      '<w:p><w:pPr><w:pStyle w:val="Corpsdetexte"/></w:pPr><w:r><w:rPr><w:sz w:val="24"/><w:color w:val="1F3864"/></w:rPr><w:t>Vérifier la pression.</w:t></w:r></w:p>',
      '<w:p><w:pPr><w:pStyle w:val="Corpsdetexte"/></w:pPr><w:r><w:t>Purger le circuit.</w:t></w:r></w:p>',
      '<w:p><w:pPr><w:pStyle w:val="Citation"/></w:pPr><w:r><w:t>Ne jamais ouvrir sous pression.</w:t></w:r></w:p>',
    ].join('') });
    const document = await readDocxDocument(bytes);
    const source = docxToAi(document.doc, document);
    expect(source.markdown).toBe('Vérifier la pression.\n\nPurger le circuit.\n\nNe jamais ouvrir sous pression.');
    const proposed = docxFromAi('Vérifier la pression.\n\nNe jamais ouvrir sous pression.\n\nNoter la valeur.', source);
    expect(proposed.content!.slice(0, 2)).toEqual([document.doc.content![0], document.doc.content![2]]);
    expect(proposed.content![2].attrs).toMatchObject({ id: null, styleId: 'Corpsdetexte', basedOn: 'b0' });
    // Le neuf prend la taille du texte courant, pas sa couleur.
    expect(await mainXml(await write(bytes, proposed))).toContain('<w:p><w:pPr><w:pStyle w:val="Corpsdetexte"/></w:pPr><w:r><w:rPr><w:sz w:val="24"/></w:rPr><w:t xml:space="preserve">Noter la valeur.</w:t></w:r></w:p>');
  });

  it('paragraphes neufs : styles du document, liste numérotée existante, mise en forme d’un paragraphe du même genre', async () => {
    const { bytes, document } = await fixture();
    const source = docxToAi(document.doc, document);
    const proposed = docxFromAi([
      '# Filtration', 'Laver le filtre chaque lundi.', '## Étapes',
      '1. Arrêter la pompe\n2. Fermer la vanne', '[[objet 1 : Image]]', '[[objet 2 : Tableau]]', '[[objet 3 : Table des matières]]',
    ].join('\n\n'), source);
    expect(blocks(proposed)).toEqual(['docxParagraph:b0', 'docxParagraph:b1', 'docxParagraph:neuf', 'docxParagraph:b3', 'docxParagraph:neuf',
      'docxAtom:b5', 'table:b6', 'docxAtom:b7']);
    const [heading, step] = proposed.content!.filter((node) => !node.attrs?.id);
    expect(heading.attrs).toMatchObject({ styleId: 'Titre2', level: 2, numId: null, basedOn: '' });
    expect(step.attrs).toMatchObject({ styleId: 'Paragraphedeliste', numId: '1', ilvl: 0, basedOn: 'b3' });

    const after = await mainXml(await write(bytes, proposed));
    expect(after).toContain('<w:p><w:pPr><w:pStyle w:val="Titre2"/></w:pPr><w:r><w:t xml:space="preserve">Étapes</w:t></w:r></w:p>');
    expect(after).toContain('<w:p><w:pPr><w:pStyle w:val="Paragraphedeliste"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">Fermer la vanne</w:t></w:r></w:p>');
    // Le paragraphe gardé garde ses runs (Arial, rouge, italique) ; l'image et le sommaire sont recopiés.
    expect(after).toContain('<w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:i/><w:color w:val="FF0000"/>');
    expect(after).toContain('<w:drawing>');
    expect(after.match(/_Toc1/g)).toHaveLength(1);
  });

  it('marqueurs en gras, échappés ou entre deux étapes : retrouvés ; la numérotation continue après l’image', async () => {
    const { document } = await fixture();
    const source = docxToAi(document.doc, document);
    const proposed = docxFromAi('1. Arrêter la pompe\n**[[objet 1 : Image]]**\n2. Fermer la vanne\n\n\\[\\[objet 2\\]\\]\n\n[[Objet 3 : sommaire]]', source);
    expect(blocks(proposed)).toEqual(['docxParagraph:b3', 'docxAtom:b5', 'docxParagraph:neuf', 'table:b6', 'docxAtom:b7']);
    expect(proposed.content![2].attrs).toMatchObject({ numId: '1', ilvl: 0 });
  });

  it('objet perdu par l’IA : la proposition est refusée', async () => {
    const { document } = await fixture();
    const source = docxToAi(document.doc, document);
    expect(() => docxFromAi('Texte.\n\n[[objet 1 : Image]]\n\n[[objet 3]]', source)).toThrow(/a perdu un objet du document \(tableau\) : relance-la/);
  });

  it('liens d’origine gardés avec leur style, commandes en chasse fixe, <balises> gardées en texte', async () => {
    const { bytes, document } = await fixture();
    const source = docxToAi(document.doc, document);
    const proposed = docxFromAi(`${source.markdown}\n\nVoir [le guide](https://exemple.fr/guide), lancer \`ping <serveur>\` puis [ailleurs](https://autre.fr) ; ssh <compte>@hôte.`, source);
    const after = await mainXml(await write(bytes, proposed));
    expect(after).toContain('<w:hyperlink r:id="rId9" w:history="1"><w:r><w:rPr><w:rStyle w:val="Lienhypertexte"/></w:rPr><w:t xml:space="preserve">le guide</w:t></w:r></w:hyperlink>');
    expect(after).toContain('<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/></w:rPr><w:t xml:space="preserve">ping &lt;serveur&gt;</w:t></w:r>');
    // Une cible inconnue du document : son texte seul (WorkLogs ne crée pas de lien).
    expect(after).toContain('<w:t xml:space="preserve"> puis ailleurs ; ssh &lt;compte&gt;@hôte.</w:t>');
  });

  it('document sans liste ni titre de ce niveau (modèle « Nouveau fichier ») : numérotation écrite, gras', async () => {
    const bytes = await newFileBytes('docx', { title: 'Changer le filtre', author: 'T. Grollier', now });
    const document = await readDocxDocument(bytes);
    const source = docxToAi(document.doc, document, { procedure: true });
    expect(source.title).toBe('Changer le filtre');
    expect(source.markdown).toBe('');
    const proposed = docxFromAi('Remplacer la cartouche du bassin 3.\n\n## Étapes\n\n1. Couper l’eau\n2. Changer la cartouche\n\n#### Contrôle\n\n- Joint en place', source);
    expect(proposed.content!.map(textOf)).toEqual(['Changer le filtre', 'Remplacer la cartouche du bassin 3.', 'Étapes',
      '1. Couper l’eau', '2. Changer la cartouche', 'Contrôle', '• Joint en place']);
    expect(proposed.content![0].attrs?.id).toBe('b0');
    expect(proposed.content![2].attrs).toMatchObject({ styleId: 'Titre2', level: 2 });
    const after = await mainXml(await write(bytes, proposed));
    expect(after).toContain('<w:p><w:pPr><w:pStyle w:val="Titre1"/></w:pPr><w:r><w:t xml:space="preserve">Changer le filtre</w:t></w:r></w:p>');
    expect(after).toContain('<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Contrôle</w:t></w:r></w:p>');
    expect(after).not.toContain('numPr');
    // Le résultat se relit, et la même proposition rejouée ne change plus rien.
    const reread = await readDocxDocument(await write(bytes, proposed));
    const again = docxToAi(reread.doc, reread, { procedure: true });
    expect(blocks(docxFromAi(again.markdown, again)).every((block) => !block.endsWith('neuf'))).toBe(true);
  });

  it('aperçu : ce qui s’appliquera, objets annoncés comme conservés', async () => {
    const { document } = await fixture();
    const source = docxToAi(document.doc, document);
    const preview = docxPreview(docxFromAi(source.markdown, source), document);
    expect(preview).toContain('1. Arrêter la pompe\n   1. Vanne fermée');
    expect(preview).toContain('*[Image — conservé tel quel]*');
    expect(preview).not.toContain('[[objet');
  });
});
