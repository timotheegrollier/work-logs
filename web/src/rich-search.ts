import { Extension, type Editor } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { closeHistory } from '@tiptap/pm/history';

export interface Match { from: number; to: number }
interface SearchState { query: string; caseSensitive: boolean; active: number; matches: Match[]; truncated: boolean }
export const searchKey = new PluginKey<SearchState>('worklogs-search');

/** Recherche littérale, y compris entre deux marques ; ne traverse pas les blocs/objets. */
export function findMatches(doc: Node, query: string, caseSensitive = false) {
  const matches: Match[] = [];
  let truncated = false;
  if (!query) return { matches, truncated };
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'gu' : 'giu');
  const search = (text: string, position: number) => {
    pattern.lastIndex = 0;
    for (let match; (match = pattern.exec(text));) {
      if (matches.length === 2000) { truncated = true; return; }
      matches.push({ from: position + match.index, to: position + match.index + match[0].length });
    }
  };
  doc.descendants((node, pos) => {
    if (truncated) return false;
    if (!node.isTextblock) return;
    let text = '', start = pos + 1;
    node.forEach((child, offset) => {
      if (child.isText) { if (!text) start = pos + 1 + offset; text += child.text; }
      else { search(text, start); text = ''; }
    });
    search(text, start);
    return false;
  });
  return { matches, truncated };
}

export const RichSearch = Extension.create({
  name: 'worklogsSearch',
  addProseMirrorPlugins() {
    return [new Plugin<SearchState>({
      key: searchKey,
      state: {
        init: () => ({ query: '', caseSensitive: false, active: 0, matches: [], truncated: false }),
        apply(tr, previous) {
          const meta = tr.getMeta(searchKey) as Partial<SearchState> | undefined;
          if (!meta && !tr.docChanged) return previous;
          const next = { ...previous, ...meta };
          if (tr.docChanged || next.query !== previous.query || next.caseSensitive !== previous.caseSensitive)
            Object.assign(next, findMatches(tr.doc, next.query, next.caseSensitive));
          next.active = Math.max(0, Math.min(next.active, next.matches.length - 1));
          return next;
        },
      },
      props: {
        decorations(state) {
          const search = searchKey.getState(state)!;
          return DecorationSet.create(state.doc, search.matches.map((match, index) => Decoration.inline(match.from, match.to,
            { class: index === search.active ? 'search-match search-current' : 'search-match' })));
        },
      },
    })];
  },
});

export function setSearch(editor: Editor, value: Partial<Pick<SearchState, 'query' | 'caseSensitive' | 'active'>>) {
  editor.view.dispatch(editor.state.tr.setMeta(searchKey, value).setMeta('addToHistory', false));
}

export function replaceMatches(editor: Editor, replacement: string, all = false) {
  const search = searchKey.getState(editor.state);
  if (!search?.matches.length || (all && search.truncated)) return;
  const matches = all ? search.matches : [search.matches[search.active]];
  const transaction = editor.state.tr;
  // Un seul geste d'annulation, aucun décalage des positions encore à remplacer.
  for (const match of [...matches].reverse()) transaction.insertText(replacement, match.from, match.to);
  editor.view.dispatch(closeHistory(transaction));
}
