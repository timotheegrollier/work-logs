import { expect, test } from 'vitest';
import { Editor, type JSONContent } from '@tiptap/core';
import { richExtensions } from './rich-extensions';
import { toggleCodeBlock } from './rich-code';

const line = (text: string): JSONContent => (text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' });
/** Le document vu bloc par bloc : type et texte. */
const blocks = (editor: Editor) => editor.state.doc.children.map((node) => [node.type.name, node.textContent]);

test('des lignes collées deviennent un seul bloc de code, sélectionné, en une annulation', () => {
  const editor = new Editor({ extensions: richExtensions(), content: { type: 'doc', content: [
    line('Relancer :'), line('sudo systemctl stop app'), line(''), line('sudo systemctl start app'),
  ] } });
  try {
    const before = editor.getJSON();
    // De « sudo » (deuxième paragraphe) à la fin du document.
    editor.commands.setTextSelection({ from: 13, to: editor.state.doc.content.size - 1 });
    expect(toggleCodeBlock(editor)).toBe(true);
    expect(blocks(editor)).toEqual([
      ['paragraph', 'Relancer :'],
      ['codeBlock', 'sudo systemctl stop app\n\nsudo systemctl start app'],
      ['paragraph', ''], // paragraphe de fin, ajouté par l'éditeur après un bloc
    ]);
    const { from, to } = editor.state.selection;
    expect(editor.state.doc.textBetween(from, to)).toBe('sudo systemctl stop app\n\nsudo systemctl start app');
    editor.commands.undo();
    expect(editor.getJSON()).toEqual(before);
  } finally { editor.destroy(); }
});

test('un saut de ligne manuel reste une ligne ; déjà du code ou une seule ligne : bascule ordinaire', () => {
  const editor = new Editor({ extensions: richExtensions(), content: { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'cd /srv' }, { type: 'hardBreak' }, { type: 'text', text: 'ls' }] },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'pwd' }] },
  ] } });
  try {
    // Ctrl+A emporte aussi le paragraphe vide de fin : il ne devient pas une ligne du code.
    editor.commands.selectAll();
    toggleCodeBlock(editor);
    expect(blocks(editor)).toEqual([['codeBlock', 'cd /srv\nls\npwd'], ['paragraph', '']]);
    // Déjà du code : le bouton le rend au texte, comme avant.
    editor.commands.setTextSelection(3);
    toggleCodeBlock(editor);
    expect(editor.state.doc.firstChild?.type.name).toBe('paragraph');
    // Une seule ligne : un bloc, comme avant.
    editor.commands.setContent({ type: 'doc', content: [line('npm test')] });
    editor.commands.setTextSelection(3);
    toggleCodeBlock(editor);
    expect(blocks(editor)[0]).toEqual(['codeBlock', 'npm test']);
  } finally { editor.destroy(); }
});

test('ne fusionne pas à travers une liste : la bascule de Tiptap s’applique', () => {
  const content: JSONContent = { type: 'doc', content: [
    line('Avant'),
    { type: 'bulletList', content: [{ type: 'listItem', content: [line('un')] }, { type: 'listItem', content: [line('deux')] }] },
  ] };
  const editor = new Editor({ extensions: richExtensions(), content });
  const reference = new Editor({ extensions: richExtensions(), content });
  try {
    editor.commands.selectAll();
    reference.commands.selectAll();
    toggleCodeBlock(editor);
    reference.chain().focus().toggleCodeBlock().run();
    expect(editor.getJSON()).toEqual(reference.getJSON());
  } finally { editor.destroy(); reference.destroy(); }
});
