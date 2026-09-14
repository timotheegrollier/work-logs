/** Format JSON de l'éditeur riche. Indépendant de la bibliothèque d'affichage. */
const BLOCKS = ['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote', 'codeBlock', 'horizontalRule', 'table', 'image'];
const CHILDREN = {
  doc: BLOCKS,
  paragraph: ['text', 'hardBreak', 'image'], heading: ['text', 'hardBreak'],
  bulletList: ['listItem'], orderedList: ['listItem'],
  listItem: BLOCKS,
  blockquote: BLOCKS, codeBlock: ['text'],
  table: ['tableRow'], tableRow: ['tableCell', 'tableHeader'],
  tableCell: BLOCKS,
  tableHeader: BLOCKS,
  text: [], hardBreak: [], horizontalRule: [], image: [],
};
const MARKS = new Set(['bold', 'italic', 'underline', 'strike', 'code', 'link', 'textStyle', 'highlight']);
const COLOR = /^(#[\da-f]{3,8}|rgba?\([\d.,%\s]+\)|[a-z]{1,20})$/i;
export const EMPTY_DOCUMENT = { type: 'doc', content: [{ type: 'paragraph' }] };

function safeUrl(value, image = false) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x20\x7f]/.test(value)) return false;
  return /^(https?:\/\/)/i.test(value) || (!image && /^mailto:/i.test(value)) ||
    (image && /^\/api\/files\/[\w.-]+$/.test(value));
}

/** Rejette les structures inconnues : aucune perte silencieuse à la relecture. */
export function validateDocument(document) {
  let count = 0;
  const fail = () => { throw Object.assign(new Error('document riche invalide'), { status: 400 }); };
  function attrs(value, type) {
    if (value === undefined) return;
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
    for (const [key, v] of Object.entries(value)) {
      if (v === null) continue;
      if (key === 'href') { if (type !== 'link' || !safeUrl(v)) fail(); }
      else if (key === 'src') { if (type !== 'image' || !safeUrl(v, true)) fail(); }
      else if (key === 'textAlign') { if (!['left', 'center', 'right', 'justify'].includes(v)) fail(); }
      else if (['color', 'backgroundColor'].includes(key)) { if (typeof v !== 'string' || !COLOR.test(v)) fail(); }
      else if (key === 'fontSize') { if (typeof v !== 'string' || !/^\d{1,3}(\.\d{1,3})?(px|pt)$/.test(v)) fail(); }
      else if (key === 'fontFamily') { if (typeof v !== 'string' || !/^[\w\s,'-]{1,100}$/.test(v)) fail(); }
      else if (key === 'level') { if (![1, 2, 3, 4, 5, 6].includes(v)) fail(); }
      else if (['start', 'colspan', 'rowspan', 'width', 'height'].includes(key)) { if (!Number.isInteger(v) || v < 1 || v > 10000) fail(); }
      else if (key === 'colwidth') { if (!Array.isArray(v) || v.length > 50 || v.some(n => !Number.isInteger(n) || n < 1 || n > 10000)) fail(); }
      else if (['alt', 'title', 'language', 'target', 'rel', 'class'].includes(key)) { if (typeof v !== 'string' || v.length > 1000) fail(); }
      else fail();
    }
  }
  function node(n, depth = 0) {
    if (++count > 20000 || depth > 30 || !n || typeof n !== 'object' || Array.isArray(n) || !Object.hasOwn(CHILDREN, n.type)) fail();
    if (Object.keys(n).some(k => !['type', 'text', 'attrs', 'content', 'marks'].includes(k))) fail();
    attrs(n.attrs, n.type);
    if (n.type === 'text') { if (typeof n.text !== 'string' || !n.text.length) fail(); }
    else if (n.text !== undefined) fail();
    if (n.type === 'image' && !safeUrl(n.attrs?.src, true)) fail();
    if (n.marks !== undefined) {
      if (n.type !== 'text' || !Array.isArray(n.marks) || n.marks.length > 10) fail();
      for (const mark of n.marks) {
        if (!mark || !MARKS.has(mark.type) || Object.keys(mark).some(k => !['type', 'attrs'].includes(k))) fail();
        attrs(mark.attrs, mark.type);
        if (mark.type === 'link' && !safeUrl(mark.attrs?.href)) fail();
      }
    }
    if (n.content !== undefined) {
      if (!Array.isArray(n.content)) fail();
      for (const child of n.content) {
        if (!CHILDREN[n.type].includes(child?.type)) fail();
        node(child, depth + 1);
      }
    }
    if (['doc', 'bulletList', 'orderedList', 'listItem', 'table', 'tableRow', 'tableCell', 'tableHeader'].includes(n.type) && !n.content?.length) fail();
  }
  if (document?.type !== 'doc') fail();
  node(document);
  return document;
}

/** Texte de recherche/export de secours ; le JSON reste la source de vérité. */
export function documentText(node) {
  if (node.type === 'text') return node.text;
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'image') return node.attrs?.alt || '';
  const separator = ['paragraph', 'heading', 'codeBlock'].includes(node.type) ? '' : '\n';
  return (node.content || []).map(documentText).join(separator);
}

export function decodeEntry(entry) {
  return entry ? { ...entry, content_json: entry.content_json ? JSON.parse(entry.content_json) : null } : entry;
}
