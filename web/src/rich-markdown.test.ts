import { describe, expect, test } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { markdownToRich, richToMarkdown } from './rich-markdown';

const text = (value: string, ...marks: JSONContent['marks'] & object[]) => ({ type: 'text', text: value, ...(marks.length ? { marks } : {}) });
const paragraph = (...content: JSONContent[]) => ({ type: 'paragraph', ...(content.length ? { content } : {}) });
const item = (...content: JSONContent[]) => ({ type: 'listItem', content });

/** Squelette lisible d'un document : type, texte, marques, et les attributs qui comptent. */
function outline(node: JSONContent): unknown {
  return {
    type: node.type,
    ...(node.text ? { text: node.text } : {}),
    ...(node.marks ? { marks: node.marks.map((mark) => (mark.attrs?.href ? `${mark.type}:${mark.attrs.href}` : mark.type)) } : {}),
    ...(node.type === 'heading' ? { level: node.attrs?.level } : {}),
    ...(node.type === 'orderedList' ? { start: node.attrs?.start } : {}),
    ...(node.type === 'image' ? { src: node.attrs?.src, width: node.attrs?.width ?? null } : {}),
    ...(node.content ? { content: node.content.map(outline) } : {}),
  };
}

describe('document riche → Markdown pour l’IA', () => {
  test('titres, marques, listes imbriquées, citation, code, image et tableau', () => {
    const document = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [text('Étapes')] },
        paragraph(
          text('Couper '), text('l’eau', { type: 'bold' }), text(' puis voir '),
          text('la notice', { type: 'link', attrs: { href: 'https://exemple.fr/notice' } }), text(' et '), text('pompe.cfg', { type: 'code' }),
        ),
        paragraph(),
        { type: 'orderedList', attrs: { start: 1 }, content: [
          item(paragraph(text('Vider le bassin'))),
          item(paragraph(text('Contrôler')), { type: 'bulletList', content: [item(paragraph(text('le pH')))] }),
        ] },
        { type: 'blockquote', content: [paragraph(text('Attention', { type: 'italic' }))] },
        { type: 'codeBlock', attrs: { language: 'sh' }, content: [text('pompe --stop')] },
        { type: 'horizontalRule' },
        { type: 'image', attrs: { src: '/api/files/photo.jpg', alt: 'Vanne [A]' } },
        { type: 'table', content: [
          { type: 'tableRow', content: [
            { type: 'tableHeader', content: [paragraph(text('Bassin'))] },
            { type: 'tableHeader', content: [paragraph(text('Débit'))] },
          ] },
          { type: 'tableRow', content: [
            { type: 'tableCell', content: [paragraph(text('B3'))] },
            { type: 'tableCell', content: [paragraph(text('2 | 3 m³/h'))] },
          ] },
        ] },
      ],
    };
    expect(richToMarkdown(document)).toBe([
      '## Étapes',
      'Couper **l’eau** puis voir [la notice](https://exemple.fr/notice) et `pompe.cfg`',
      '1. Vider le bassin\n2. Contrôler\n   - le pH',
      '> *Attention*',
      '```sh\npompe --stop\n```',
      '---',
      '![Vanne A](/api/files/photo.jpg)',
      '| Bassin | Débit |\n| --- | --- |\n| B3 | 2 \\| 3 m³/h |',
    ].join('\n\n'));
  });

  test('blancs hors des délimiteurs, saut de ligne gardé, document vide', () => {
    expect(richToMarkdown({ type: 'doc', content: [
      paragraph(text('Avant '), text('gras ', { type: 'bold' }), text('après'), { type: 'hardBreak' }, text('suite')),
    ] })).toBe('Avant **gras** après\nsuite');
    expect(richToMarkdown({ type: 'doc', content: [paragraph()] })).toBe('');
  });
});

describe('Markdown de l’IA → document riche', () => {
  test('procédure type : objectif, étapes numérotées, gras, lien, image de la pièce jointe, tableau', () => {
    const document = markdownToRich([
      'Remplacer le filtre sans arrêter l’élevage.',
      '## Étapes',
      '1. Couper **l’arrivée d’eau**\n2. Lire [la notice](https://exemple.fr/notice)',
      '![Vanne](/api/files/photo.jpg)',
      '| Bassin | Débit |\n| --- | --- |\n| B3 | à préciser |',
    ].join('\n\n'));
    const cell = (type: string, value: string) => ({ type, content: [{ type: 'paragraph', content: [{ type: 'text', text: value }] }] });
    expect(document.content?.map(outline)).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'Remplacer le filtre sans arrêter l’élevage.' }] },
      { type: 'heading', level: 2, content: [{ type: 'text', text: 'Étapes' }] },
      { type: 'orderedList', start: 1, content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Couper ' }, { type: 'text', text: 'l’arrivée d’eau', marks: ['bold'] }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Lire ' }, { type: 'text', text: 'la notice', marks: ['link:https://exemple.fr/notice'] }] }] },
      ] },
      // Pas de paragraphe vide parasite avant l'image (découpage de `<p><img></p>`).
      { type: 'image', src: '/api/files/photo.jpg', width: null },
      { type: 'table', content: [
        { type: 'tableRow', content: [cell('tableHeader', 'Bassin'), cell('tableHeader', 'Débit')] },
        { type: 'tableRow', content: [cell('tableCell', 'B3'), cell('tableCell', 'à préciser')] },
      ] },
    ]);
  });

  test('liens et images hors règles retirés sans perdre le texte ; tailles et numérotation ramenées', () => {
    const document = markdownToRich([
      '![relative](photo.jpg) ![inline](data:image/png;base64,AAAA) ![ok](/api/files/ok.png)',
      '[relatif](page.html) [script](javascript:alert(1)) [mail](mailto:timo@example.com)',
      '0. zéro',
      '<img src="/api/files/x.png" width="300px"> <span style="color: red">rouge</span>',
    ].join('\n\n'));
    const images = JSON.stringify(document).match(/"src":"[^"]+"/g);
    expect(images).toEqual(['"src":"/api/files/ok.png"', '"src":"/api/files/x.png"']);
    expect(richToMarkdown(document)).toBe([
      '![ok](/api/files/ok.png)',
      'relatif script [mail](mailto:timo@example.com)',
      '1. zéro',
      '![](/api/files/x.png)',
      'rouge',
    ].join('\n\n'));
    // Largeur en texte (« 300px ») : l'éditeur attend un entier, elle est retirée.
    expect(JSON.stringify(document)).not.toContain('300px');
    // Couleur simple : gardée, le serveur l'accepte.
    expect(JSON.stringify(document)).toContain('"color":"red"');
  });

  test('aller-retour stable : ce que l’IA propose revient tel quel', () => {
    const markdown = [
      'Objectif : vidanger le bassin 3.',
      '## Prérequis',
      '- Pompe de relevage\n- Accès au local technique',
      '## Étapes',
      '1. Couper l’arrivée d’eau\n2. Démarrer la pompe\n   - surveiller le niveau\n3. Nettoyer le fond',
      '> Débit : à préciser',
      '```\nvanne --fermer\n```',
    ].join('\n\n');
    expect(richToMarkdown(markdownToRich(markdown))).toBe(markdown);
  });

  test('réponse vide : document vide valide ; style que l’éditeur refuse : erreur explicite', () => {
    expect(markdownToRich('').content?.map(outline)).toEqual([{ type: 'paragraph' }]);
    expect(() => markdownToRich('<span style="font-size: 12em">énorme</span>')).toThrow('ne sait pas garder');
  });
});
