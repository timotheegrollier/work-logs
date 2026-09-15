import { diff } from './google-preserve.js';

const conflict = () => { throw Object.assign(new Error('Le même contenu a été modifié ici et sur Google. Ton brouillon est conservé. Garde une copie locale puis actualise cet onglet pour choisir la version à garder.'), { status: 409 }); };
const same = (a, b) => JSON.stringify(a, (key, value) => key === 'src' ? undefined : value) === JSON.stringify(b, (key, value) => key === 'src' ? undefined : value);

/** Ignore only renderer defaults; meaningful text/style/structure stays compared. */
function normalize(value, context = '') {
  if (Array.isArray(value)) {
    const result = value.map(item => normalize(item, context));
    if (context === 'marks') return result.sort((a, b) => a.type.localeCompare(b.type));
    if (context === 'content') return result.reduce((nodes, node) => {
      const previous = nodes.at(-1);
      if (node.type === 'text' && previous?.type === 'text' && same(node.marks, previous.marks)) previous.text += node.text;
      else nodes.push(node);
      return nodes;
    }, []);
    return result;
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).flatMap(([key, child]) => {
    if (child === null || child === undefined || ['target', 'rel', 'class'].includes(key)) return [];
    if (['colspan', 'rowspan', 'start'].includes(key) && child === 1) return [];
    const normalized = normalize(child, key);
    if (typeof normalized === 'object' && !Object.keys(normalized).length) return [];
    return [[key, normalized]];
  }));
}
function patches(base, next) {
  const edits = [];
  let position = 0, current;
  for (const op of diff(base, next)) {
    if (op.kind === 'equal') { current = null; position += op.text.length; continue; }
    if (!current) { current = { start: position, end: position, text: '' }; edits.push(current); }
    if (op.kind === 'delete') { position += op.text.length; current.end = position; }
    else current.text += op.text;
  }
  return edits;
}
function mergeText(base, local, remote) {
  const left = patches(base, local), right = patches(base, remote);
  const edits = [...left];
  for (const r of right) {
    if (left.some(l => same(l, r))) continue;
    for (const l of left) {
      const intersects = l.start === l.end || r.start === r.end
        ? l.start <= r.end && r.start <= l.end
        : l.start < r.end && r.start < l.end;
      if (intersects) conflict();
    }
    edits.push(r);
  }
  let text = base;
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return text;
}

/** Three-way merge: only independent changes are reconciled automatically. */
export function mergeGoogleChanges(base, local, remote) {
  function merge(b, l, r, key = '') {
    if (same(l, b)) return r;
    if (same(r, b) || same(l, r)) return l;
    if (key === 'text' && [b, l, r].every(v => typeof v === 'string')) return mergeText(b, l, r);
    if (key === 'marks') {
      const byType = marks => Object.fromEntries((marks || []).map(mark => [mark.type, mark]));
      return Object.values(merge(byType(b), byType(l), byType(r)));
    }
    if (Array.isArray(b) && Array.isArray(l) && Array.isArray(r)) {
      if (b.length !== l.length || b.length !== r.length) conflict();
      return b.map((item, i) => merge(item, l[i], r[i]));
    }
    if ([b, l, r].every(v => v === undefined || (v && typeof v === 'object' && !Array.isArray(v)))) {
      const keys = new Set([...Object.keys(b || {}), ...Object.keys(l || {}), ...Object.keys(r || {})]);
      return Object.fromEntries([...keys].map(k => [k, merge(b?.[k], l?.[k], r?.[k], k)]).filter(([, value]) => value !== undefined));
    }
    conflict();
  }
  return merge(normalize(base), normalize(local), normalize(remote));
}
