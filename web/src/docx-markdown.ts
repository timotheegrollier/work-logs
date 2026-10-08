import { marked, type Token, type Tokens } from 'marked';
import type { JSONContent } from '@tiptap/core';
import { normalizeDocx, type DocxDocument } from './docx';
import { decodeEntities as decode, elements, scanXml } from './xml-scan';
import { FormatError } from './file-formats';

/**
 * Pont document Word du partage ⇄ Markdown, pour l'IA (« Suggérer une procédure »,
 * « Mettre en page »). Le Markdown est ce que les modèles manient le mieux ; le
 * document Word, lui, ne doit rien perdre :
 * - images, tableaux, champs, tables des matières partent en **marqueurs**
 *   `[[objet N : …]]` et reviennent tels quels ; une proposition qui en perd un est refusée ;
 * - un paragraphe dont l'IA garde le texte **reste celui d'origine** (runs, polices,
 *   liens, signets), octet pour octet s'il garde aussi sa place dans la structure ;
 * - un paragraphe neuf prend les styles du document (titres, paragraphe de liste,
 *   listes numérotées existantes) et la mise en forme d'un paragraphe du même genre
 *   (`basedOn`), jamais celle d'un voisin quelconque.
 * Ce que le document n'a pas (style de titre, liste numérotée) devient du gras ou
 * une numérotation écrite (« 1. ») : rien n'est ajouté à styles.xml ni à numbering.xml.
 */

type Marks = NonNullable<JSONContent['marks']>;

export interface DocxAiSource {
  /** Ce que lit l'IA : le document en Markdown, ses objets en marqueurs. */
  markdown: string;
  /** Titre du document (son premier titre de niveau 1), ou `''`. */
  title: string;
  /** Gardés en tête de la proposition, hors de l'IA : le titre, pour une suggestion. */
  keep: JSONContent[];
  /** Numéro de marqueur → objet ou tableau d'origine. */
  objects: Map<number, JSONContent>;
  /** Le document au moment de la demande, normalisé. */
  doc: JSONContent;
  document: DocxDocument;
}

/** Un morceau de texte proposé, avec sa mise en forme Markdown. */
interface Piece {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  href?: string;
  br?: boolean;
}

const MONOSPACE = /consolas|courier|lucida console|menlo|monaco|mono\b|monospace|source code/i;
const EXCERPT = 120;
/** Marqueur interne, seul dans son paragraphe une fois la réponse normalisée. */
const OBJECT_MARK = /⟦objet (\d+)⟧/;

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
/** Cible d'un lien telle qu'écrite en Markdown : parenthèses et blancs ne doivent pas fermer `(…)`. */
const linkTarget = (href: string) => href.replace(/[()\s]/g, encodeURIComponent);
const plainText = (node: JSONContent): string =>
  (node.content ?? []).map((child) => (child.type === 'hardBreak' ? '\n' : child.text ?? '')).join('');
const runProperties = (node: JSONContent) => String(node.marks?.find((mark) => mark.type === 'docxRun')?.attrs?.rPr ?? '');
const isMonospace = (node: JSONContent) => {
  const font = /:(?:ascii|hAnsi)="([^"]*)"/.exec(runProperties(node));
  return Boolean(font && MONOSPACE.test(font[1]));
};

type ListKind = 'ordered' | 'bullet';
function listKind(document: DocxDocument, numId: string, ilvl: number): ListKind | null {
  const format = document.numbering[numId]?.[ilvl]?.format;
  if (!format || format === 'none') return null;
  return format === 'bullet' ? 'bullet' : 'ordered';
}

// ------------------------------------------------------------ Word → Markdown

/** Garde les blancs hors des délimiteurs : `** mot**` ne serait pas du gras. */
function wrap(text: string, left: string, right = left): string {
  const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text) as RegExpExecArray;
  return core ? `${lead}${left}${core}${right}${trail}` : text;
}

function pieceMarkdown(node: JSONContent): string {
  if (node.type === 'hardBreak') return '\n';
  if (node.type !== 'text') return '';
  const has = (type: string) => node.marks?.some((mark) => mark.type === type);
  let text = node.text ?? '';
  if (isMonospace(node)) text = wrap(text, text.includes('`') ? '`` ' : '`', text.includes('`') ? ' ``' : '`');
  if (has('italic')) text = wrap(text, '*');
  if (has('bold')) text = wrap(text, '**');
  if (has('strike')) text = wrap(text, '~~');
  return text;
}

/** Texte d'un paragraphe en Markdown ; un lien garde sa cible, `[texte](cible)`. */
function inlineMarkdown(nodes: JSONContent[] = []): string {
  const linkOf = (node: JSONContent) => node.marks?.find((mark) => mark.type === 'docxLink')?.attrs;
  let out = '';
  for (let i = 0; i < nodes.length;) {
    const link = linkOf(nodes[i]);
    let inner = '';
    let j = i;
    for (; j < nodes.length; j++) {
      const other = linkOf(nodes[j]);
      if ((other?.open ?? null) !== (link?.open ?? null) || (other?.href ?? null) !== (link?.href ?? null)) break;
      inner += pieceMarkdown(nodes[j]);
    }
    out += link?.href ? `[${inner.replace(/[[\]]/g, '\\$&')}](${linkTarget(String(link.href))})` : inner;
    i = j;
  }
  return out;
}

function objectLabel(node: JSONContent): { label: string; text: string } {
  if (node.type === 'table') {
    const cell = (content: JSONContent[] = []) =>
      normalize(content.map((child) => (child.type === 'docxParagraph' ? plainText(child) : String(child.attrs?.text ?? ''))).join(' '));
    const rows = (node.content ?? []).map((row) => (row.content ?? []).map((item) => cell(item.content)).join(' | '));
    return { label: 'Tableau', text: rows.join(' / ') };
  }
  return { label: String(node.attrs?.label ?? 'Objet Word'), text: String(node.attrs?.text ?? '') };
}

function excerpt(text: string): string {
  const cleaned = normalize(text).replace(/[[\]⟦⟧]/g, '');
  return cleaned.length > EXCERPT ? cleaned.slice(0, EXCERPT - 1) + '…' : cleaned;
}

/**
 * Blocs du document → Markdown. Titres par niveau de style, listes Word en listes
 * Markdown (numéros comptés par liste, comme Word : une image entre deux étapes ne
 * remet pas le compte à 1), paragraphes vides omis, objets rendus par `object`.
 */
function writeMarkdown(nodes: JSONContent[], document: DocxDocument, object: (node: JSONContent) => string): string {
  const blocks: { text: string; item: boolean }[] = [];
  const counters = new Map<string, number[]>();
  let widths: number[] | null = null;
  for (const node of nodes) {
    if (node.type !== 'docxParagraph') {
      widths = null;
      const text = object(node);
      if (text) blocks.push({ text, item: false });
      continue;
    }
    const text = inlineMarkdown(node.content);
    const level = Number(node.attrs?.level) || 0;
    const numId = node.attrs?.numId ? String(node.attrs.numId) : null;
    if (!text.trim()) {
      widths = null;
      continue;
    }
    if (level >= 1) {
      widths = null;
      blocks.push({ text: `${'#'.repeat(Math.min(6, level))} ${normalize(text)}`, item: false });
      continue;
    }
    if (!numId) {
      widths = null;
      blocks.push({ text, item: false });
      continue;
    }
    const ilvl = Math.max(0, Math.min(8, Number(node.attrs?.ilvl) || 0));
    const count = counters.get(numId) ?? [];
    for (let i = 0; i <= ilvl; i++) if (count[i] === undefined) count[i] = (document.numbering[numId]?.[i]?.start ?? 1) - 1;
    count[ilvl] += 1;
    count.length = ilvl + 1;
    counters.set(numId, count);
    const marker = listKind(document, numId, ilvl) === 'bullet' ? '- ' : `${count[ilvl]}. `;
    widths ??= [];
    const indent = Array.from({ length: ilvl }, (_, i) => widths![i] ?? 3).reduce((sum, width) => sum + width, 0);
    widths[ilvl] = marker.length;
    widths.length = ilvl + 1;
    const pad = ' '.repeat(indent + marker.length);
    blocks.push({ text: ' '.repeat(indent) + marker + text.split('\n').map((line, i) => (i ? pad + line : line)).join('\n'), item: true });
  }
  return blocks.map((block, i) => (i ? (block.item && blocks[i - 1].item ? '\n' : '\n\n') : '') + block.text).join('');
}

/**
 * Ce que l'IA lit d'un document Word. Pour une suggestion de procédure, le premier
 * titre de niveau 1 est le titre du document : il reste en tête, l'IA écrit la suite.
 */
export function docxToAi(doc: JSONContent, document: DocxDocument, { procedure = false } = {}): DocxAiSource {
  const normalized = normalizeDocx(doc);
  const blocks = normalized.content ?? [];
  const first = blocks.findIndex((node) => node.type !== 'docxParagraph' || normalize(plainText(node)));
  const head = first >= 0 ? blocks[first] : undefined;
  const title = head?.type === 'docxParagraph' && Number(head.attrs?.level) === 1 ? normalize(plainText(head)) : '';
  const keep = procedure && title ? blocks.slice(0, first + 1) : [];
  const objects = new Map<number, JSONContent>();
  const markdown = writeMarkdown(blocks.slice(keep.length), document, (node) => {
    const n = objects.size + 1;
    objects.set(n, node);
    const { label, text } = objectLabel(node);
    const short = excerpt(text);
    return `[[objet ${n} : ${label}${short ? ` — ${short}` : ''}]]`;
  });
  return { markdown, title, keep, objects, doc: normalized, document };
}

/** Document Word → Markdown à relire : ce qui s'appliquera, objets annoncés comme conservés. */
export function docxPreview(doc: JSONContent, document: DocxDocument): string {
  return writeMarkdown(doc.content ?? [], document, (node) => `*[${objectLabel(node).label} — conservé tel quel]*`);
}

// ------------------------------------------------------------ Markdown → Word

type Proposed =
  | { kind: 'object'; n: number }
  | {
    kind: 'p';
    level: number;
    pieces: Piece[];
    list: { kind: ListKind; depth: number; group: number; number: number } | null;
  };

function inline(tokens: Token[] = [], style: Omit<Piece, 'text'> = {}): Piece[] {
  const out: Piece[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'text':
        if ('tokens' in token && token.tokens?.length) out.push(...inline(token.tokens, style));
        else out.push({ ...style, text: decode(token.text) });
        break;
      case 'escape':
        out.push({ ...style, text: token.text });
        break;
      case 'strong':
        out.push(...inline(token.tokens, { ...style, bold: true }));
        break;
      case 'em':
        out.push(...inline(token.tokens, { ...style, italic: true }));
        break;
      case 'del':
        out.push(...inline(token.tokens, { ...style, strike: true }));
        break;
      case 'codespan':
        out.push({ ...style, code: true, text: token.text });
        break;
      case 'link':
        out.push(...inline(token.tokens, { ...style, href: token.href }));
        break;
      case 'image':
        // Une image ne se crée pas ici : son texte de remplacement, s'il y en a un.
        if (token.text) out.push({ ...style, text: token.text });
        break;
      case 'br':
        out.push({ ...style, text: '', br: true });
        break;
      case 'html':
        // `<adresse IP>` dans une commande est du texte, pas une balise à jeter.
        if (/^<br\s*\/?>$/i.test(token.text.trim())) out.push({ ...style, text: '', br: true });
        else out.push({ ...style, text: token.text });
        break;
      case 'checkbox':
        out.push({ ...style, text: token.checked ? '☑ ' : '☐ ' });
        break;
      default:
        if ('text' in token && typeof token.text === 'string') out.push({ ...style, text: decode(token.text) });
    }
  }
  return out;
}

/** Réponse de l'IA → blocs proposés : paragraphes typés (titre, élément de liste, corps) et objets. */
function parseProposal(markdown: string): Proposed[] {
  // Chaque marqueur devient un paragraphe à part, même écrit en gras, échappé ou au milieu d'une phrase.
  const source = markdown.replace(
    /[ \t]*(?:\*\*|__|\*|_|`)?\\?\[\\?\[\s*objet\s+(\d+)\b[^\]\n]*?\\?\]\\?\](?:\*\*|__|\*|_|`)?/gi,
    (_all, n: string) => `\n\n⟦objet ${Number(n)}⟧\n\n`,
  );
  const out: Proposed[] = [];
  let groups = 0;
  // Une liste numérotée qui reprend au numéro suivant (« 3. » après « 1. », « 2. » et une image)
  // continue la même liste Word.
  let lastOrdered: { group: number; next: number } | null = null;

  const emit = (pieces: Piece[], level: number, list: Extract<Proposed, { kind: 'p' }>['list']) => {
    let current: Piece[] = [];
    const flush = () => {
      if (current.some((piece) => piece.text.trim())) out.push({ kind: 'p', level, pieces: current, list });
      current = [];
    };
    for (const piece of pieces) {
      const parts = piece.text.split(/(⟦objet \d+⟧)/);
      parts.forEach((part, index) => {
        const mark = index % 2 ? OBJECT_MARK.exec(part) : null;
        if (mark) {
          flush();
          out.push({ kind: 'object', n: Number(mark[1]) });
        } else if (part || piece.br) {
          current.push({ ...piece, text: part });
        }
      });
    }
    flush();
  };

  const block = (token: Token) => {
    switch (token.type) {
      case 'heading':
        emit(inline(token.tokens), Math.max(1, Math.min(6, token.depth)), null);
        break;
      case 'paragraph':
      case 'text':
        emit('tokens' in token && token.tokens?.length ? inline(token.tokens) : [{ text: decode(token.text) }], 0, null);
        break;
      case 'list':
        list(token as Tokens.List, 0, null);
        break;
      case 'blockquote':
        token.tokens?.forEach(block);
        break;
      case 'code':
        // Une commande par ligne, en police à chasse fixe : Word n'a pas de bloc de code.
        for (const line of token.text.split('\n')) emit([{ text: line, code: !OBJECT_MARK.test(line) }], 0, null);
        break;
      case 'table': {
        const table = token as Tokens.Table;
        const row = (cells: Tokens.TableCell[], bold = false) =>
          emit(cells.flatMap((cell, i) => [...(i ? [{ text: ' | ' }] : []), ...inline(cell.tokens, bold ? { bold: true } : {})]), 0, null);
        row(table.header, true);
        table.rows.forEach((cells) => row(cells));
        break;
      }
      case 'html':
        emit([{ text: token.text.trim() }], 0, null);
        break;
      default:
        // Espaces, séparateurs, définitions de liens : rien à écrire.
        break;
    }
  };

  const list = (token: Tokens.List, depth: number, parent: { group: number } | null) => {
    const start = Number(token.start) || 1;
    const kind: ListKind = token.ordered ? 'ordered' : 'bullet';
    const group = parent ? parent.group
      : kind === 'ordered' && lastOrdered && start > 1 && start === lastOrdered.next ? lastOrdered.group
        : ++groups;
    token.items.forEach((item, index) => {
      let prefix: Piece[] = [];
      let written = false;
      for (const child of item.tokens) {
        if (child.type === 'checkbox') prefix = inline([child]);
        else if (child.type === 'list') list(child as Tokens.List, depth + 1, { group });
        else if ((child.type === 'text' || child.type === 'paragraph') && !written) {
          written = true;
          const pieces = 'tokens' in child && child.tokens?.length ? inline(child.tokens) : [{ text: decode(child.text) }];
          emit([...prefix, ...pieces], 0, { kind, depth, group, number: start + index });
        } else block(child);
      }
    });
    if (!parent && kind === 'ordered') lastOrdered = { group, next: start + token.items.length };
  };

  marked.lexer(source, { gfm: true, breaks: true }).forEach(block);
  return out;
}

interface Original {
  node: JSONContent;
  id: string;
  text: string;
  level: number;
  styleId: string | null;
  numId: string | null;
  ilvl: number;
  /** Longueur des propriétés de paragraphe d'origine : le plus sobre sert de modèle. */
  weight: number;
}

/** Forme Word retenue pour un paragraphe proposé. */
interface Resolved {
  styleId: string | null;
  level: number;
  numId: string | null;
  ilvl: number;
  /** Numérotation écrite (« 1. », « • ») quand le document n'a pas de liste à reprendre. */
  prefix: string;
  /** Titre sans style de ce niveau dans le document : écrit en gras. */
  bold: boolean;
}

const KEEP_RUN = new Set(['rFonts', 'sz', 'szCs', 'lang']);

/** Police, taille et langue d'un run modèle : ni gras, ni couleur, ni surlignage. */
function bodyRunProperties(rPr: string): string {
  if (!rPr) return '';
  try {
    const root = scanXml(rPr);
    const kept = elements(root).filter((child) => KEEP_RUN.has(child.local)).map((child) => rPr.slice(child.start, child.end));
    return kept.length ? `<${root.name}>${kept.join('')}</${root.name}>` : '';
  } catch {
    return '';
  }
}

function codeRunProperties(rPr: string, w: string): string {
  const fonts = `<${w}:rFonts ${w}:ascii="Consolas" ${w}:hAnsi="Consolas" ${w}:cs="Consolas"/>`;
  if (!rPr) return `<${w}:rPr>${fonts}</${w}:rPr>`;
  const root = scanXml(rPr);
  const rest = elements(root).filter((child) => child.local !== 'rFonts').map((child) => rPr.slice(child.start, child.end));
  return `<${root.name}>${fonts}${rest.join('')}</${root.name}>`;
}

function mostFrequent<T>(values: T[]): T | null {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: T | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) if (count > bestCount) { best = value; bestCount = count; }
  return best;
}

/**
 * Réponse de l'IA → document Word pour l'éditeur, à relire avant application.
 * Erreur explicite si elle a perdu un objet du document (image, tableau…).
 */
export function docxFromAi(markdown: string, source: DocxAiSource): JSONContent {
  const { document } = source;
  const plan = parseProposal(markdown);
  const keepIds = new Set(source.keep.map((node) => String(node.attrs?.id ?? '')));
  const originals: Original[] = (source.doc.content ?? [])
    .filter((node) => node.type === 'docxParagraph' && node.attrs?.id)
    .map((node) => {
      const id = String(node.attrs!.id);
      const found = document.sources.get(id);
      return {
        node,
        id,
        text: normalize(plainText(node)),
        level: Number(node.attrs?.level) || 0,
        styleId: (node.attrs?.styleId as string | null) ?? null,
        numId: node.attrs?.numId ? String(node.attrs.numId) : null,
        ilvl: Number(node.attrs?.ilvl) || 0,
        weight: found?.kind === 'p' ? found.pPr.length : 0,
      };
    });
  const kindOf = (original: Original) => (original.numId ? listKind(document, original.numId, original.ilvl) : null);

  // ---- styles et listes du document
  const labelOf = (styleId: string) => document.styles.find((style) => style.id === styleId)?.label ?? '';
  const headingStyle = (level: number): string | null => {
    const used = originals.filter((original) => original.level === level && original.styleId).map((original) => original.styleId!);
    const named = `Titre ${level}`;
    return used.find((id) => labelOf(id) === named)
      ?? document.styles.find((style) => style.level === level && style.label === named)?.id
      ?? mostFrequent(used)
      ?? null;
  };
  const listStyle = mostFrequent(originals.filter((original) => original.numId && original.styleId).map((original) => original.styleId!))
    ?? document.styles.find((style) => style.label === 'Paragraphe de liste')?.id ?? null;
  // Style du texte courant (« Corps de texte »…), `null` pour Normal.
  const bodyStyle = mostFrequent(originals.filter((original) => !original.numId && !original.level && original.text)
    .map((original) => original.styleId ?? '')) || null;
  const preferredNumId = (kind: ListKind): string | null => {
    const used = mostFrequent(originals.filter((original) => kindOf(original) === kind).map((original) => original.numId!));
    if (used) return used;
    const ids = Object.keys(document.numbering).filter((numId) => listKind(document, numId, 0) === kind);
    return ids.find((numId) => document.numbering[numId][0]?.format === 'decimal') ?? ids[0] ?? null;
  };
  const levelOk = (numId: string, depth: number, kind: ListKind) => listKind(document, numId, depth) === kind;

  // ---- 1. le texte gardé retrouve son paragraphe d'origine
  const used = new Set<string>(keepIds);
  const matchFor = (text: string) => {
    const key = normalize(text);
    if (!key) return null;
    const found = originals.find((original) => !used.has(original.id) && original.text === key);
    if (found) used.add(found.id);
    return found ?? null;
  };
  const piecesText = (pieces: Piece[]) => pieces.map((piece) => (piece.br ? ' ' : piece.text)).join('');
  const matches = plan.map((block) => (block.kind === 'p' ? matchFor(piecesText(block.pieces)) : null));

  // ---- 2. une liste Word par liste proposée ; deux listes numérotées n'en partagent jamais une
  // (Word continuerait la numérotation de la première dans la seconde).
  const groupKinds = new Map<number, ListKind>();
  const groupNumIds = new Map<number, string | null>();
  const takenOrdered = new Set<string>();
  for (const block of plan) {
    if (block.kind !== 'p' || !block.list || block.list.depth || groupKinds.has(block.list.group)) continue;
    const { kind, group } = block.list;
    groupKinds.set(group, kind);
    // La liste d'origine dont l'IA a gardé des éléments, sinon la plus utilisée du document.
    const candidates = plan.flatMap((other, i) => {
      const original = matches[i];
      return other.kind === 'p' && other.list?.group === group && !other.list.depth && original?.numId && kindOf(original) === kind
        ? [original.numId] : [];
    });
    const free = (numId: string | null) => (numId && (kind === 'bullet' || !takenOrdered.has(numId)) ? numId : null);
    const numId = candidates.map(free).find(Boolean) ?? free(preferredNumId(kind));
    if (numId && kind === 'ordered') takenOrdered.add(numId);
    groupNumIds.set(group, numId);
  }

  const resolve = (block: Extract<Proposed, { kind: 'p' }>): Resolved => {
    const plainShape: Resolved = { styleId: bodyStyle, level: 0, numId: null, ilvl: 0, prefix: '', bold: false };
    if (block.level >= 1) {
      const styleId = headingStyle(block.level);
      if (!styleId) return { ...plainShape, bold: true };
      const level = document.styles.find((style) => style.id === styleId)?.level
        ?? originals.find((original) => original.styleId === styleId)?.level ?? block.level;
      // Titres numérotés par le document (numérotation directe) : le nouveau suit les autres.
      const numbered = originals.find((original) => original.styleId === styleId && original.numId);
      return { ...plainShape, styleId, level, numId: numbered?.numId ?? null, ilvl: numbered?.ilvl ?? 0 };
    }
    if (!block.list) return plainShape;
    const { kind, depth, group, number } = block.list;
    const groupNumId = groupNumIds.get(group) ?? null;
    let numId: string | null = null;
    if (groupNumId && groupKinds.get(group) === kind && levelOk(groupNumId, depth, kind)) numId = groupNumId;
    else if (kind === 'bullet') {
      const bullet = preferredNumId('bullet');
      if (bullet && levelOk(bullet, depth, 'bullet')) numId = bullet;
    }
    if (numId) return { ...plainShape, styleId: listStyle, numId, ilvl: depth };
    return { ...plainShape, styleId: listStyle ?? bodyStyle, prefix: kind === 'ordered' ? `${number}. ` : depth ? '– ' : '• ' };
  };
  const resolved = plan.map((block) => (block.kind === 'p' ? resolve(block) : null));

  // Numérotation écrite : le paragraphe d'origine écrit de même (« 1. Couper ») est retrouvé.
  plan.forEach((block, i) => {
    const shape = resolved[i];
    if (block.kind === 'p' && shape?.prefix && !matches[i]) matches[i] = matchFor(shape.prefix + piecesText(block.pieces));
  });

  // ---- 3. modèles des paragraphes neufs, liens d'origine
  const templateFor = (shape: Resolved): Original | null => {
    const candidates = originals.filter((original) => (shape.numId ? original.numId === shape.numId
      : shape.level >= 1 ? original.styleId === shape.styleId
        // Numérotation écrite : un élément de liste du document sert de modèle (son numPr part).
        : original.styleId === shape.styleId && original.level === 0 && (Boolean(shape.prefix) || !original.numId)));
    const score = (original: Original) => (original.text ? 0 : 1000000) + (shape.numId && original.ilvl !== shape.ilvl ? 100000 : 0) + original.weight;
    return candidates.reduce<Original | null>((best, original) => (!best || score(original) < score(best) ? original : best), null);
  };
  // Liens du document : balise d'origine, et propriétés de leur run (style « Lien hypertexte »).
  const links = new Map<string, { attrs: { href: string; open: string }; rPr: string }>();
  for (const original of originals) {
    for (const child of original.node.content ?? []) {
      const link = child.marks?.find((mark) => mark.type === 'docxLink')?.attrs;
      const target = link?.href ? linkTarget(String(link.href)) : '';
      if (target && !links.has(target)) {
        links.set(target, { attrs: { href: String(link!.href), open: String(link!.open ?? '') }, rPr: runProperties(child) });
      }
    }
  }

  const inlineNodes = (pieces: Piece[], rPr: string, extra: Marks): JSONContent[] => {
    const code = codeRunProperties(rPr, document.w);
    const nodes: JSONContent[] = [];
    for (const piece of pieces) {
      // Un lien ne se crée pas ici (il lui faudrait une relation) : seule une cible du document le reste.
      const link = piece.href ? links.get(linkTarget(piece.href)) : undefined;
      const runProps = piece.code ? code : link ? link.rPr : rPr;
      const run: Marks = runProps ? [{ type: 'docxRun', attrs: { rPr: runProps } }] : [];
      if (piece.br) {
        nodes.push({ type: 'hardBreak', ...(run.length ? { marks: run } : {}) });
        continue;
      }
      const text = piece.text.replace(/\n/g, ' ');
      if (!text) continue;
      const marks: Marks = [...extra];
      if (piece.bold && !extra.some((mark) => mark.type === 'bold')) marks.push({ type: 'bold' });
      if (piece.italic && !extra.some((mark) => mark.type === 'italic')) marks.push({ type: 'italic' });
      if (piece.strike) marks.push({ type: 'strike' });
      marks.push(...run);
      if (link) marks.push({ type: 'docxLink', attrs: link.attrs });
      nodes.push({ type: 'text', text, ...(marks.length ? { marks } : {}) });
    }
    return nodes;
  };

  // ---- 4. le document proposé
  const usedObjects = new Set<number>();
  const content: JSONContent[] = [...source.keep];
  plan.forEach((block, i) => {
    if (block.kind === 'object') {
      const node = source.objects.get(block.n);
      if (node && !usedObjects.has(block.n)) {
        usedObjects.add(block.n);
        content.push(node);
      }
      return;
    }
    const shape = resolved[i]!;
    const original = matches[i];
    const attrs = { styleId: shape.styleId, level: shape.level, numId: shape.numId, ilvl: shape.numId ? shape.ilvl : null };
    if (original) {
      const sameShape = shape.level >= 1
        ? original.level === shape.level
        : original.level === 0 && original.numId === shape.numId && (!shape.numId || original.ilvl === shape.ilvl);
      if (sameShape) {
        content.push(original.node);
        return;
      }
      const run = original.node.content?.find((child) => child.type === 'text')?.marks ?? [];
      const prefix = shape.prefix && !original.text.startsWith(normalize(shape.prefix))
        ? [{ type: 'text', text: shape.prefix, marks: run.filter((mark) => mark.type === 'docxRun') }] : [];
      content.push({ ...original.node, attrs: { ...original.node.attrs, ...attrs }, content: [...prefix, ...(original.node.content ?? [])] });
      return;
    }
    const template = templateFor(shape);
    const first = template?.node.content?.find((child) => child.type === 'text');
    const rPr = bodyRunProperties(first ? runProperties(first) : '');
    // Un titre neuf reprend le gras, l'italique ou le soulignement direct des titres du document.
    const extra: Marks = [
      ...(shape.bold ? [{ type: 'bold' }] : []),
      ...(shape.level >= 1 ? (first?.marks ?? []).filter((mark) => ['bold', 'italic', 'underline'].includes(mark.type)) : []),
    ];
    const pieces = shape.prefix ? [{ text: shape.prefix }, ...block.pieces] : block.pieces;
    const inlineContent = inlineNodes(pieces, rPr, extra);
    content.push({
      type: 'docxParagraph',
      attrs: { id: null, align: null, basedOn: template?.id ?? '', ...attrs },
      ...(inlineContent.length ? { content: inlineContent } : {}),
    });
  });

  const missing = [...source.objects.keys()].filter((n) => !usedObjects.has(n));
  if (missing.length) {
    const labels = [...new Set(missing.map((n) => objectLabel(source.objects.get(n)!).label.toLowerCase()))].join(', ');
    throw new FormatError(`La proposition a perdu ${missing.length > 1 ? `${missing.length} objets` : 'un objet'} du document (${labels}) : relance-la. Rien n’a été modifié.`);
  }
  if (!content.length) content.push({ type: 'docxParagraph', attrs: { id: null } });
  return normalizeDocx({ type: 'doc', content });
}
