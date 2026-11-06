import { generateJSON, type JSONContent } from '@tiptap/core';
import { renderMarkdown } from './markdown';
import { richExtensions } from './rich-extensions';
// @ts-expect-error — rich-document.js est du JavaScript pur partagé avec l'API.
import { validateDocument } from '../../api/src/rich-document.js';

/**
 * Pont Markdown ⇄ document riche pour l'IA : la mise en page et la suggestion
 * de procédure travaillent en Markdown (le format que les modèles manient le
 * mieux), l'éditeur garde son JSON. Ce que le Markdown ne porte pas (surlignage,
 * couleurs, soulignement, alignements) est remis à plat : la proposition se
 * relit avant d'être appliquée.
 */

/** Garde les blancs hors des délimiteurs : `** mot**` ne serait pas du gras. */
function wrap(text: string, left: string, right = left): string {
  const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text) as RegExpExecArray;
  return core ? `${lead}${left}${core}${right}${trail}` : text;
}

const image = (node: JSONContent) =>
  `![${String(node.attrs?.alt ?? '').replace(/[[\]]/g, '')}](${String(node.attrs?.src ?? '')})`;

function inline(nodes: JSONContent[] = []): string {
  return nodes.map((node) => {
    if (node.type === 'hardBreak') return '\n';
    if (node.type === 'image') return image(node);
    if (node.type !== 'text') return String(node.attrs?.label ?? '');
    const marks = node.marks ?? [];
    const has = (type: string) => marks.some((mark) => mark.type === type);
    let text = node.text ?? '';
    if (has('code')) text = `\`${text}\``;
    if (has('italic')) text = wrap(text, '*');
    if (has('bold')) text = wrap(text, '**');
    if (has('strike')) text = wrap(text, '~~');
    const href = marks.find((mark) => mark.type === 'link')?.attrs?.href;
    return typeof href === 'string' && href ? `[${text}](${href})` : text;
  }).join('');
}

function blocks(nodes: JSONContent[] = [], separator = '\n\n'): string {
  return nodes.map(block).filter((text) => text.trim()).join(separator);
}

function list(items: JSONContent[] = [], marker: (index: number) => string): string {
  return items.map((item, index) => {
    const prefix = marker(index);
    const pad = ' '.repeat(prefix.length);
    return prefix + blocks(item.content, '\n').split('\n').map((line, i) => (i && line ? pad + line : line)).join('\n');
  }).join('\n');
}

function table(rows: JSONContent[] = []): string {
  const cells = rows.map((row) => (row.content ?? []).map((cell) => blocks(cell.content, ' ').replace(/\n/g, ' ').replace(/\|/g, '\\|')));
  if (!cells.length) return '';
  const width = Math.max(...cells.map((row) => row.length));
  const line = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => row[i] ?? '').join(' | ')} |`;
  return [line(cells[0]), line(Array(width).fill('---')), ...cells.slice(1).map(line)].join('\n');
}

function block(node: JSONContent): string {
  switch (node.type) {
    case 'heading': return `${'#'.repeat(Math.min(6, Math.max(1, Number(node.attrs?.level) || 1)))} ${inline(node.content).replace(/\n/g, ' ')}`;
    case 'bulletList': return list(node.content, () => '- ');
    case 'orderedList': return list(node.content, (index) => `${(Number(node.attrs?.start) || 1) + index}. `);
    case 'blockquote': return blocks(node.content).split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n');
    case 'codeBlock': return `\`\`\`${String(node.attrs?.language ?? '')}\n${(node.content ?? []).map((child) => child.text ?? '').join('')}\n\`\`\``;
    case 'horizontalRule': return '---';
    case 'image': return image(node);
    case 'table': return table(node.content);
    case 'googleBlock': return String(node.attrs?.label ?? '');
    default: return inline(node.content);
  }
}

/** Document riche → Markdown envoyé à l'IA (paragraphes vides omis). */
export function richToMarkdown(document: JSONContent): string {
  return blocks(document.content).trim();
}

// Mêmes règles que `safeUrl` (api/src/rich-document.js) : le serveur refuserait le reste.
const SAFE_LINK = /^(https?:\/\/|mailto:)/i;
const SAFE_IMAGE = /^(https?:\/\/|\/api\/files\/[\w.-]+$)/i;
const safe = (value: unknown, pattern: RegExp) =>
  typeof value === 'string' && value.length <= 4096 && !/[\x00-\x20\x7f]/.test(value) && pattern.test(value);

/** Un style lu dans du HTML brut vaut `""` quand il est absent : c'est « aucun ». */
const withoutEmpty = (attrs: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(attrs).map(([key, value]) => [key, value === '' ? null : value]));

/** Retire ce que l'éditeur ne garderait pas : image ou lien hors règles, tailles en texte. */
function clean(node: JSONContent): JSONContent | null {
  if (node.type === 'image' && !safe(node.attrs?.src, SAFE_IMAGE)) return null;
  const next: JSONContent = { ...node };
  if (next.attrs) {
    const attrs = withoutEmpty(next.attrs);
    for (const key of ['width', 'height']) if (attrs[key] != null && !Number.isInteger(attrs[key])) attrs[key] = null;
    if (next.type === 'orderedList' && !(Number.isSafeInteger(attrs.start) && (attrs.start as number) >= 0)) attrs.start = 1;
    next.attrs = attrs;
  }
  if (next.marks) {
    const marks = next.marks
      .filter((mark) => mark.type !== 'link' || safe(mark.attrs?.href, SAFE_LINK))
      .map((mark) => (mark.attrs ? { ...mark, attrs: withoutEmpty(mark.attrs) } : mark));
    if (marks.length) next.marks = marks;
    else delete next.marks;
  }
  if (next.content) {
    let content = next.content.map(clean).filter((child): child is JSONContent => child !== null);
    // Le Markdown n'a pas de paragraphe vide : ceux-là viennent du découpage
    // `<p><img></p>`. On en garde un seul si le conteneur l'exige (liste, cellule).
    const filled = content.filter((child) => child.type !== 'paragraph' || child.content);
    content = filled.length ? filled : content.slice(0, 1);
    // `marked` termine chaque bloc de code par un saut de ligne.
    const last = content.at(-1);
    if (next.type === 'codeBlock' && last?.text?.endsWith('\n')) {
      content = last.text === '\n' ? content.slice(0, -1) : [...content.slice(0, -1), { ...last, text: last.text.slice(0, -1) }];
    }
    if (content.length) next.content = content;
    else delete next.content;
  }
  return next;
}

/**
 * Markdown proposé par l'IA → document riche, avec le schéma de l'éditeur et la
 * validation du serveur : ce qui passe ici s'enregistre, sinon erreur explicite.
 */
export function markdownToRich(markdown: string): JSONContent {
  const document = clean(generateJSON(renderMarkdown(markdown), richExtensions()) as JSONContent) as JSONContent;
  if (!document.content?.length) document.content = [{ type: 'paragraph' }];
  try {
    return validateDocument(document) as JSONContent;
  } catch {
    throw new Error('La proposition contient un élément que l’éditeur ne sait pas garder : relance-la ou ignore-la.');
  }
}
