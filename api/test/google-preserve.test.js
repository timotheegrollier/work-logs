import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPreservingUpdate, googlePreservedCount, importGoogleDocument } from '../src/google-preserve.js';
import { validateDocument } from '../src/rich-document.js';

const p = (text, style = {}) => ({ paragraph: { paragraphStyle: style, elements: [{ textRun: { content: text + '\n' } }] } });

// Real Google-style absolute UTF-16 indices, including structural table units.
function fixture(content) {
  let index = 1, tape = '\u0000';
  const reserve = (text) => { tape += text; index += text.length; };
  const walk = blocks => blocks.forEach(block => {
    block.startIndex = index;
    if (block.paragraph) for (const run of block.paragraph.elements) {
      run.startIndex = index;
      reserve(run.textRun?.content || '\uFFFC');
      run.endIndex = index;
    }
    if (block.table) {
      reserve('T');
      for (const row of block.table.tableRows) {
        reserve('R');
        for (const cell of row.tableCells) { reserve('C'); walk(cell.content); }
      }
      reserve('E');
    }
    if (block.tableOfContents) { reserve('O'); walk(block.tableOfContents.content); }
    block.endIndex = index;
  });
  walk(content);
  return { source: { documentId: 'doc', revisionId: 'r1', tabs: [{ tabProperties: { tabId: 't.child' }, documentTab: { body: { content: [{ sectionBreak: {}, endIndex: 1 }, ...content] } } }] }, tape };
}
function apply(tape, update) {
  for (const req of update.requests) {
    const op = Object.values(req)[0];
    assert.equal((op.range || op.location).tabId, 't.child');
    if (req.deleteContentRange) { const { startIndex, endIndex } = op.range; assert.ok(startIndex >= 1 && endIndex < tape.length, 'préserve la fin du corps'); tape = tape.slice(0, startIndex) + tape.slice(endIndex); }
    if (req.insertText) tape = tape.slice(0, op.location.index) + op.text + tape.slice(op.location.index);
    if (op.range) assert.ok(op.range.endIndex <= tape.length + (req.deleteContentRange ? op.range.endIndex - op.range.startIndex : 0));
  }
  return tape;
}

test('tableaux, titres Google, retraits, exposants : texte édité sans recréer les structures ni réinitialiser les styles', () => {
  const heading = p('Budget', { namedStyleType: 'TITLE', indentStart: { magnitude: 18, unit: 'PT' } });
  const cell = p('12 400 €');
  cell.paragraph.elements[0].textRun.textStyle = { baselineOffset: 'SUPERSCRIPT', weightedFontFamily: { fontFamily: 'Arial', weight: 500 } };
  const { source, tape } = fixture([heading, { table: { tableRows: [{ tableCells: [{ content: [p('Toiture')] }, { content: [cell] }] }] } }, p('Fin')]);
  const rich = importGoogleDocument(source);
  assert.equal(rich.content[0].attrs.googleNamedStyle, 'TITLE');
  assert.equal(rich.content[1].type, 'table');
  const revised = rich.content[1].content[0].content[1].content[0];
  revised.content[0].text = '14 900 €';
  const update = buildPreservingUpdate(source, rich);
  assert.equal(apply(tape, update), tape.replace('12 400', '14 900'));
  assert.equal(update.requests.some(r => r.insertTable || r.deleteParagraphBullets || r.updateParagraphStyle), false);
  assert.equal(update.requests.filter(r => r.deleteContentRange).some(r => r.deleteContentRange.range.endIndex > cell.endIndex), false);
  assert.deepEqual(update.writeControl, { requiredRevisionId: 'r1' });
});

test('objets Google et widgets privés : modifier de chaque côté conserve exactement leur unité et leur ordre', () => {
  const block = { paragraph: { elements: [{ textRun: { content: 'Avant 😀 ' } }, { richLink: { richLinkProperties: { title: 'Projet partagé' } } }, { textRun: { content: ' milieu \uE907 après\n' } }] } };
  const { source, tape } = fixture([block]);
  const rich = importGoogleDocument(source);
  assert.equal(googlePreservedCount(rich), 2);
  const children = rich.content[0].content;
  children[0].text = 'Devant 😃 ';
  children.at(-1).text = ' ensuite';
  const result = apply(tape, buildPreservingUpdate(source, rich));
  assert.equal(result, '\u0000Devant 😃 \uFFFC milieu \uE907 ensuite\n');
  children.splice(1, 1);
  assert.throws(() => buildPreservingUpdate(source, rich), /élément Google intégré/);
});

test('une suggestion reste protégée sans empêcher une correction dans un autre paragraphe', () => {
  const suggestion = p('Texte suggéré');
  suggestion.paragraph.elements[0].textRun.suggestedInsertionIds = ['s1'];
  const { source, tape } = fixture([suggestion, p('Texte libre')]);
  const rich = importGoogleDocument(source);
  assert.equal(rich.content[0].type, 'googleBlock');
  rich.content[1].content[0].text = 'Texte corrigé';
  assert.equal(apply(tape, buildPreservingUpdate(source, rich)), tape.replace('libre', 'corrigé'));
});

test('mise en forme seule : aucun texte ni style Google voisin effacé', () => {
  const { source, tape } = fixture([p('Texte inchangé', { indentFirstLine: { magnitude: 25, unit: 'PT' } })]);
  source.tabs[0].documentTab.body.content[1].paragraph.elements[0].textRun.textStyle = { link: { headingId: 'h.123' } };
  const rich = importGoogleDocument(source);
  rich.content[0].content[0].marks.push({ type: 'bold' });
  const update = buildPreservingUpdate(source, rich);
  assert.equal(apply(tape, update), tape);
  assert.equal(update.requests.length, 1);
  assert.equal(update.requests[0].updateTextStyle.fields, 'bold');
  assert.deepEqual(buildPreservingUpdate(source, importGoogleDocument(source)).requests, []);
});

test('plusieurs paragraphes édités avec emoji : indices descendants, pas de décalage des paragraphes suivants', () => {
  const { source, tape } = fixture([p('Bonjour 😀'), p('Deuxième 😀'), p('Fin')]);
  const rich = importGoogleDocument(source);
  rich.content[0].content[0].text = 'Bonjour 😃 et bienvenue';
  rich.content[1].content[0].text = 'Deuxième';
  rich.content[2].content[0].text = 'Conclusion';
  assert.equal(apply(tape, buildPreservingUpdate(source, rich)), '\u0000Bonjour 😃 et bienvenue\nDeuxième\nConclusion\n');
});

test('ajout de paragraphes avant un tableau et dans une cellule, sans aplatir le tableau', () => {
  const { source, tape } = fixture([p('Introduction'), { table: { tableRows: [{ tableCells: [{ content: [p('Cellule')] }] }] } }, p('Fin')]);
  const rich = importGoogleDocument(source);
  rich.content[1].content[0].content[0].content.push({ type: 'paragraph', content: [{ type: 'text', text: 'Suite' }] });
  rich.content.splice(1, 0, { type: 'paragraph', content: [{ type: 'text', text: 'Objectif' }] });
  assert.equal(apply(tape, buildPreservingUpdate(source, rich)), tape.replace('Introduction\n', 'Introduction\nObjectif\n').replace('Cellule\n', 'Cellule\nSuite\n'));
});

test('liste imbriquée : texte synchronisé et changement de profondeur jamais ignoré', () => {
  const a = p('Parent'), b = p('Enfant');
  a.paragraph.bullet = { listId: 'k', nestingLevel: 0 };
  b.paragraph.bullet = { listId: 'k', nestingLevel: 1 };
  const { source, tape } = fixture([a, b]);
  const rich = importGoogleDocument(source);
  rich.content[0].content[0].content[1].content[0].content[0].content[0].text = 'Enfant modifié';
  assert.equal(apply(tape, buildPreservingUpdate(source, rich)), tape.replace('Enfant', 'Enfant modifié'));
});

test('refuse structure détruite, identités forgées et attributs dangereux', () => {
  const { source } = fixture([{ table: { tableRows: [{ tableCells: [{ content: [p('A')] }] }] } }, p('Fin')]);
  const rich = importGoogleDocument(source);
  rich.content[0].content.push(structuredClone(rich.content[0].content[0]));
  assert.throws(() => buildPreservingUpdate(source, rich), /lignes/);
  for (const attrs of [{ googleId: 'object-0', label: 'x', src: 'javascript:alert(1)' }, { googleId: '../', label: 'x' }]) {
    assert.throws(() => validateDocument({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'googleInline', attrs }] }] }), /invalide/);
  }
});
