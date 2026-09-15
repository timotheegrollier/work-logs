import { Extension, Node } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

/** These attributes round-trip through Tiptap without becoming arbitrary HTML. */
export const GoogleFormatting = Extension.create({
  name: 'googleFormatting',
  addGlobalAttributes() {
    return [
      { types: ['paragraph', 'heading'], attributes: {
        googleNamedStyle: { default: null, renderHTML: attrs => attrs.googleNamedStyle ? { 'data-google-style': attrs.googleNamedStyle } : {} },
        googleIndentStart: { default: null, renderHTML: attrs => attrs.googleIndentStart ? { 'data-indent-start': attrs.googleIndentStart } : {} },
        googleIndentEnd: { default: null, renderHTML: attrs => attrs.googleIndentEnd ? { 'data-indent-end': attrs.googleIndentEnd } : {} },
        googleIndentFirstLine: { default: null, renderHTML: attrs => attrs.googleIndentFirstLine ? { 'data-indent-first': attrs.googleIndentFirstLine } : {} },
      } },
      { types: ['textStyle'], attributes: {
        baselineOffset: { default: null, renderHTML: attrs => attrs.baselineOffset ? { 'data-baseline': attrs.baselineOffset } : {} },
      } },
    ];
  },
});

const googleNode = (name: 'googleInline' | 'googleBlock') => Node.create({
  name,
  group: name === 'googleInline' ? 'inline' : 'block',
  inline: name === 'googleInline',
  atom: true,
  selectable: false,
  draggable: false,
  addAttributes() { return { googleId: { default: null, rendered: false }, label: { default: 'Élément Google', rendered: false }, ...(name === 'googleInline' ? { src: { default: null, rendered: false } } : {}) }; },
  parseHTML() { return [{ tag: `[data-google-node="${name}"]` }]; },
  renderHTML({ node }) {
    const tag = name === 'googleInline' ? 'span' : 'div';
    const attributes = { 'data-google-node': name, class: 'google-preserved', 'aria-label': node.attrs.label as string, contenteditable: 'false', title: 'Conservé dans Google. Pour modifier cet élément, utilise « Ouvrir dans Google Docs ».' };
    return node.attrs.src && /^https:\/\//.test(node.attrs.src as string)
      ? [tag, attributes, ['img', { src: node.attrs.src, alt: node.attrs.label }]]
      : [tag, attributes, node.attrs.label === 'Élément Google' ? '⋯' : node.attrs.label as string];
  },
  renderText({ node }) { return node.attrs.label as string; },
});
export const GoogleInline = googleNode('googleInline');
export const GoogleBlock = googleNode('googleBlock');

// Reject deletion/movement of native Google objects before it becomes a local
// draft that cannot be sent. Edits on either side, undo and formatting still work.
const identities = (doc: ProseMirrorNode) => {
  const result: string[] = [];
  doc.descendants(node => { if (['googleInline', 'googleBlock'].includes(node.type.name)) result.push(`${node.type.name}:${node.attrs.googleId}`); });
  return result.join('|');
};
export const PreserveGoogleObjects = Extension.create({
  name: 'preserveGoogleObjects',
  addOptions() { return { enabled: true, onBlocked: () => {} }; },
  addProseMirrorPlugins() { const { onBlocked, enabled } = this.options; return [new Plugin({
    filterTransaction(transaction, state) {
      const allowed = !enabled || !transaction.docChanged || identities(transaction.doc) === identities(state.doc);
      if (!allowed) queueMicrotask(onBlocked);
      return allowed;
    },
  })]; },
});
