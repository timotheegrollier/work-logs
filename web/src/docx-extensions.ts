import { Extension, Mark, Node, mergeAttributes } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Fragment, Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model';

/**
 * Schéma de l'éditeur des documents Word du dossier partagé. Volontairement
 * étroit : ce qui se ramène à Word sans perte (texte, gras, italique, souligné,
 * barré, style de paragraphe, alignement, niveau de liste, texte des liens et des
 * cellules). Le reste — images, champs, tables des matières, zones de texte… —
 * est un **objet conservé** : affiché, recopié tel quel à l'envoi.
 */

export interface DocxNumbering {
  /** numId → niveaux : format et motif (`%1.`) de chacun. */
  [numId: string]: { format: string; text: string; start: number }[];
}

/** Un paragraphe Word : un nœud par `<w:p>`, la liste en attributs (pas de nœuds de liste). */
export const DocxParagraph = Node.create({
  name: 'docxParagraph',
  priority: 1100,
  group: 'block',
  content: 'inline*',
  defining: true,
  addAttributes() {
    return {
      // Identité dans le document d'origine : un paragraphe neuf n'en a pas.
      id: { default: null, keepOnSplit: false, rendered: false },
      styleId: { default: null, keepOnSplit: false, rendered: false },
      level: { default: 0, keepOnSplit: false, rendered: false },
      align: { default: null, rendered: false },
      numId: { default: null, rendered: false },
      ilvl: { default: null, rendered: false },
    };
  },
  addKeyboardShortcuts() {
    // Tab / Maj+Tab : niveau de liste, comme dans Word. Hors liste, la touche suit son cours (cellule suivante…).
    const shift = (delta: number) => () => {
      const { state, view } = this.editor;
      const { $from } = state.selection;
      for (let depth = $from.depth; depth > 0; depth--) {
        const node = $from.node(depth);
        if (node.type.name !== 'docxParagraph') continue;
        if (!node.attrs.numId || !this.editor.isEditable) return false;
        const ilvl = Math.max(0, Math.min(8, (Number(node.attrs.ilvl) || 0) + delta));
        view.dispatch(state.tr.setNodeMarkup($from.before(depth), undefined, { ...node.attrs, ilvl }));
        return true;
      }
      return false;
    };
    return { Tab: shift(1), 'Shift-Tab': shift(-1) };
  },
  parseHTML() {
    return [{ tag: 'p' }, { tag: 'h1', attrs: { level: 1 } }, { tag: 'h2', attrs: { level: 2 } }, { tag: 'h3', attrs: { level: 3 } },
      { tag: 'h4', attrs: { level: 4 } }, { tag: 'h5', attrs: { level: 5 } }, { tag: 'h6', attrs: { level: 6 } }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const level = Number(node.attrs.level) || 0;
    const tag = level >= 1 && level <= 6 ? `h${level}` : 'p';
    return [tag, mergeAttributes(HTMLAttributes, {
      class: 'docx-paragraph' + (node.attrs.numId ? ' is-list' : ''),
      style: [
        node.attrs.align ? `text-align:${node.attrs.align}` : '',
        node.attrs.numId ? `--docx-ilvl:${Number(node.attrs.ilvl) || 0}` : '',
      ].filter(Boolean).join(';') || undefined,
      'data-style': node.attrs.styleId || undefined,
    }), 0];
  },
});

/** Propriétés d'origine du run (`<w:rPr>`), invisibles : le texte tapé hérite de son voisin. */
export const DocxRun = Mark.create({
  name: 'docxRun',
  inclusive: true,
  excludes: '',
  addAttributes() {
    return { rPr: { default: '', rendered: false } };
  },
  parseHTML() { return []; },
  renderHTML() { return ['span', { class: 'docx-run' }, 0]; },
});

/** Lien existant du document : son texte se modifie, sa cible et sa balise d'origine sont gardées. */
export const DocxLink = Mark.create({
  name: 'docxLink',
  inclusive: false,
  addAttributes() {
    return {
      href: { default: '', rendered: false },
      open: { default: '', rendered: false },
    };
  },
  parseHTML() { return []; },
  renderHTML({ mark }) {
    return ['a', { class: 'docx-link', title: mark.attrs.href || undefined }, 0];
  },
});

/** Objet Word conservé tel quel (image, champ, table des matières, section…) : affiché, jamais réécrit. */
export const DocxAtom = Node.create({
  name: 'docxAtom',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      id: { default: null, rendered: false },
      label: { default: 'Objet Word', rendered: false },
      text: { default: '', rendered: false },
    };
  },
  parseHTML() { return []; },
  renderHTML({ node }) {
    return ['div', { class: 'docx-atom', contenteditable: 'false', 'data-label': node.attrs.label },
      ['span', { class: 'docx-atom-label' }, `${node.attrs.label} — conservé, modifiable dans Word`],
      ['span', { class: 'docx-atom-text' }, node.attrs.text || '']];
  },
});

/** Tableau Word : la structure (lignes, colonnes, fusions) reste celle d'origine ; le texte des cellules se modifie. */
const DocxTable = TableKit.configure({ table: { resizable: false } });
const TableIdentity = Extension.create({
  name: 'docxTableIdentity',
  addGlobalAttributes() {
    return [{ types: ['table'], attributes: { id: { default: null, rendered: false } } }];
  },
});

const ROMAN: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
function formatNumber(value: number, format: string): string {
  if (format === 'lowerLetter' || format === 'upperLetter') {
    let n = value;
    let out = '';
    while (n > 0) { n--; out = String.fromCharCode(97 + (n % 26)) + out; n = Math.floor(n / 26); }
    return format === 'upperLetter' ? out.toUpperCase() : out;
  }
  if (format === 'lowerRoman' || format === 'upperRoman') {
    let n = value;
    let out = '';
    for (const [amount, letters] of ROMAN) while (n >= amount) { out += letters; n -= amount; }
    return format === 'upperRoman' ? out.toUpperCase() : out;
  }
  return String(value);
}
const BULLETS = ['•', '◦', '▪'];

/** Numéros et puces des listes, recalculés à chaque modification (décoration, jamais enregistrée). */
function listMarkers(numbering: DocxNumbering) {
  return new Plugin({
    key: new PluginKey('docxListMarkers'),
    props: {
      decorations(state) {
        const counters = new Map<string, number[]>();
        const decorations: Decoration[] = [];
        state.doc.descendants((node: ProseMirrorNode, pos: number) => {
          if (node.type.name !== 'docxParagraph' || !node.attrs.numId) return node.type.name !== 'docxParagraph';
          const numId = String(node.attrs.numId);
          const ilvl = Math.max(0, Math.min(8, Number(node.attrs.ilvl) || 0));
          const levels = numbering[numId] ?? [];
          const counts = counters.get(numId) ?? [];
          for (let i = 0; i <= ilvl; i++) if (counts[i] === undefined) counts[i] = (levels[i]?.start ?? 1) - 1;
          counts[ilvl] += 1;
          counts.length = ilvl + 1;
          counters.set(numId, counts);
          const level = levels[ilvl];
          let marker = BULLETS[ilvl % BULLETS.length];
          if (level && level.format !== 'bullet' && level.format !== 'none') {
            marker = level.text.replace(/%(\d)/g, (_all, digit: string) => {
              const index = Number(digit) - 1;
              return formatNumber(counts[index] ?? 1, levels[index]?.format ?? 'decimal');
            }) || `${counts[ilvl]}.`;
          } else if (level?.format === 'none') {
            marker = '';
          }
          decorations.push(Decoration.node(pos, pos + node.nodeSize, { 'data-marker': marker }));
          return false;
        });
        return DecorationSet.create(state.doc, decorations);
      },
    },
  });
}

/** Coller ne duplique jamais un objet conservé (identités en double = document à réparer pour Word). */
function noAtomPaste() {
  const strip = (fragment: Fragment): Fragment => {
    const nodes: ProseMirrorNode[] = [];
    fragment.forEach((node) => {
      if (node.type.name === 'docxAtom') return;
      nodes.push(node.copy(strip(node.content)));
    });
    return Fragment.from(nodes);
  };
  return new Plugin({
    key: new PluginKey('docxNoAtomPaste'),
    props: { transformPasted: (slice) => new Slice(strip(slice.content), slice.openStart, slice.openEnd) },
  });
}

export function docxExtensions(numbering: DocxNumbering = {}) {
  return [
    StarterKit.configure({
      paragraph: false, heading: false, blockquote: false, bulletList: false, orderedList: false, listItem: false,
      listKeymap: false, code: false, codeBlock: false, horizontalRule: false, link: false, trailingNode: false,
      dropcursor: false,
    }),
    DocxParagraph, DocxRun, DocxLink, DocxAtom, DocxTable, TableIdentity,
    Extension.create({
      name: 'docxPlugins',
      addProseMirrorPlugins: () => [listMarkers(numbering), noAtomPaste()],
    }),
  ];
}
