import { expect, test } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { DecorationSet } from '@tiptap/pm/view';
import { RichSearch, findMatches, replaceMatches, searchKey, setSearch } from './rich-search';

test('recherche littérale entre marques, casse et positions UTF-16 sans traverser les paragraphes', () => {
  const editor = new Editor({ extensions: [StarterKit, RichSearch], content: '<p>😀 Bon<strong>jour</strong> bonjour .* $&amp;</p><p>Bonjour</p>' });
  try {
    const matches = findMatches(editor.state.doc, 'bonjour').matches;
    expect(matches).toHaveLength(3);
    expect(matches[0]).toEqual({ from: 4, to: 11 });
    expect(findMatches(editor.state.doc, 'Bonjour', true).matches).toHaveLength(2);
    expect(findMatches(editor.state.doc, '.*').matches).toHaveLength(1);
    expect(findMatches(editor.state.doc, '$&Bonjour').matches).toHaveLength(0);
    expect(findMatches(editor.state.doc, '').matches).toHaveLength(0);
  } finally { editor.destroy(); }
});

test('remplace par du texte littéral, en une annulation, et recalcule après modification', () => {
  const editor = new Editor({ extensions: [StarterKit, RichSearch], content: '<p><strong>chat</strong> chat 😀</p>' });
  try {
    editor.commands.insertContentAt(1, 'Un ');
    const original = editor.getJSON();
    setSearch(editor, { query: 'chat' });
    replaceMatches(editor, '<b>$&</b>', true);
    expect(editor.getText()).toBe('Un <b>$&</b> <b>$&</b> 😀');
    expect(editor.getHTML()).toContain('&lt;b&gt;');
    expect(searchKey.getState(editor.state)?.matches).toHaveLength(0);
    editor.commands.undo();
    expect(editor.getText()).toBe('Un chat chat 😀');
    expect(editor.getJSON()).toEqual(original);
    setSearch(editor, { active: 1 });
    replaceMatches(editor, '');
    expect(editor.getText()).toBe('Un chat  😀');
    setSearch(editor, { query: '' });
    expect(searchKey.getState(editor.state)?.matches).toHaveLength(0);
  } finally { editor.destroy(); }
});

test('borne les décorations et refuse un remplacement global partiel sur une recherche trop large', () => {
  // Sans vue : peindre 2 000 décorations dans jsdom prenait 0,5 s au repos et plus de 5 s sous
  // charge. Les extensions sont posées sur l'état comme le ferait le montage ; on lit le
  // DecorationSet que la vue peindrait.
  const editor = new Editor({ element: null, extensions: [StarterKit, RichSearch], content: `<p>${'a '.repeat(2001)}</p>` });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  try {
    setSearch(editor, { query: 'a' });
    expect(searchKey.getState(editor.state)?.truncated).toBe(true);
    const plugin = searchKey.get(editor.state)!;
    expect((plugin.props.decorations!.call(plugin, editor.state) as DecorationSet).find()).toHaveLength(2000);
    replaceMatches(editor, 'b', true);
    expect(editor.getText()).not.toContain('b');
  } finally { editor.destroy(); }
});
