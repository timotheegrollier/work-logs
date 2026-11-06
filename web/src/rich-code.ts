import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

/**
 * Bouton « Bloc de code » de l'éditeur riche. Sur plusieurs lignes
 * sélectionnées, un seul bloc, une ligne par paragraphe : Tiptap en ferait un
 * bloc par paragraphe, alors que c'est le geste naturel après avoir collé une
 * commande ou un script (le collage donne un paragraphe par ligne). Ailleurs
 * — une seule ligne, déjà du code, listes, tableaux — la bascule de Tiptap.
 */
export function toggleCodeBlock(editor: Editor): boolean {
  const { selection, schema } = editor.state;
  const codeBlock = schema.nodes.codeBlock;
  const range = editor.isActive('codeBlock') ? null : selection.$from.blockRange(selection.$to);
  const blocks = range ? Array.from({ length: range.endIndex - range.startIndex }, (_, i) => range.parent.child(range.startIndex + i)) : [];
  if (!range || blocks.length < 2 || !blocks.every((node) => ['paragraph', 'heading'].includes(node.type.name))
    || !range.parent.canReplaceWith(range.startIndex, range.endIndex, codeBlock)) {
    return editor.chain().focus().toggleCodeBlock().run();
  }
  // Un saut de ligne manuel reste une ligne ; une image n'a pas de place dans du
  // code. Les paragraphes vides aux bords (celui de fin après Ctrl+A) ne sont
  // pas des lignes du code.
  const text = blocks
    .map((node) => node.textBetween(0, node.content.size, '', (leaf) => (leaf.type.name === 'hardBreak' ? '\n' : '')))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
  return editor.chain().focus().command(({ tr }) => {
    tr.replaceWith(range.start, range.end, codeBlock.create(null, text ? schema.text(text) : null));
    tr.setSelection(TextSelection.create(tr.doc, range.start + 1, range.start + 1 + text.length));
    return true;
  }).run();
}
