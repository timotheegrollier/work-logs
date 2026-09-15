import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeGoogleChanges } from '../src/google-merge.js';
const doc = (...text) => ({ type: 'doc', content: text.map(text => ({ type: 'paragraph', content: [{ type: 'text', text }] })) });

test('réconcilie des paragraphes différents et des corrections indépendantes dans une phrase avec emoji', () => {
  assert.deepEqual(mergeGoogleChanges(doc('A', 'B'), doc('A local', 'B'), doc('A', 'B distant')), doc('A local', 'B distant'));
  assert.deepEqual(mergeGoogleChanges(doc('Bonjour 😀, budget 100 €'), doc('Bonjour 😃, budget 100 €'), doc('Bonjour 😀, budget 200 €')), doc('Bonjour 😃, budget 200 €'));
});
test('refuse deux modifications concurrentes de la même portion ou une insertion ambiguë', () => {
  assert.throws(() => mergeGoogleChanges(doc('Budget 100 €'), doc('Budget 200 €'), doc('Budget 300 €')), /même contenu/);
  assert.throws(() => mergeGoogleChanges(doc('AB'), doc('AXB'), doc('AYB')), /même contenu/);
});
test('accepte une révision modifiée dans un autre onglet et garde les nouveaux styles distants', () => {
  const base = doc('Texte');
  const local = doc('Texte ajouté');
  assert.deepEqual(mergeGoogleChanges(base, local, base), local);
  const remote = doc('Texte'); remote.content[0].content[0].marks = [{ type: 'bold' }];
  const merged = mergeGoogleChanges(base, local, remote);
  assert.equal(merged.content[0].content[0].text, 'Texte ajouté');
  assert.deepEqual(merged.content[0].content[0].marks, [{ type: 'bold' }]);
});
test('ignore les attributs nuls du renderer et conserve les modifications de cellules indépendantes', () => {
  const table = () => ({ type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: ['A', 'B'].map(text => ({ type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: doc(text).content })) }] }] });
  const base = table(), local = table(), remote = table();
  local.content[0].content[0].content[0].content[0].content[0].text = 'Local';
  remote.content[0].content[0].content[1].content[0].content[0].text = 'Distant';
  const merged = mergeGoogleChanges(base, local, remote);
  assert.equal(merged.content[0].content[0].content[0].content[0].content[0].text, 'Local');
  assert.equal(merged.content[0].content[0].content[1].content[0].content[0].text, 'Distant');
});
