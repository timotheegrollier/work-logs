import { getSchema, type JSONContent } from '@tiptap/core';
import { readZip, readZipText, writeZip, ZipError, type ZipArchive } from './zip';
import { attrNS, elements, escapeAttr, escapeText, findChild, scanXml, XmlScanError, type XmlElement } from './xml-scan';
import { coreAuthor, isWellFormed, packageParts, patchCoreProperties, relationships, resolveTarget, textOf } from './ooxml';
import { docxExtensions, type DocxNumbering } from './docx-extensions';
import { FormatError } from './file-formats';

/**
 * Documents Word (.docx) du dossier partagé, **réécrits au plus juste** : un bloc
 * qu'on n'a pas touché ressort octet pour octet (tranche XML d'origine), un
 * paragraphe modifié est reconstruit sur ses propriétés d'origine (`<w:pPr>`,
 * `<w:rPr>`), et tout ce que WorkLogs ne sait pas éditer (images, champs, tables
 * des matières, zones de texte…) est un objet conservé, recopié tel quel. Les
 * autres parties de l'archive (styles, en-têtes, numérotation, médias) ne sont
 * jamais réécrites. Rien de modifié : le fichier d'origine, à l'identique.
 */

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const W_STRICT = 'http://purl.oclc.org/ooxml/wordprocessingml/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export interface DocxStyle {
  id: string;
  label: string;
  level: number;
}

export interface DocxDraft {
  format: 'docx';
  v: 1;
  doc: JSONContent;
}

interface ParagraphAttrs {
  styleId: string | null;
  align: string | null;
  numId: string | null;
  ilvl: number | null;
}

interface SourceParagraph {
  kind: 'p';
  el: XmlElement;
  pPr: string;
  anchorsStart: string;
  anchorsEnd: string;
  attrs: ParagraphAttrs;
}
interface SourceCell { el: XmlElement; contentStart: number; key: string; colspan: number }
interface SourceTable { kind: 'tbl'; el: XmlElement; rows: SourceCell[][] }
interface SourceAtom { kind: 'atom'; el: XmlElement }
type Source = SourceParagraph | SourceTable | SourceAtom;

export interface DocxDocument {
  archive: ZipArchive;
  mainPart: string;
  corePart: string | null;
  xml: string;
  body: XmlElement;
  /** Préfixe utilisé pour l'espace de noms de Word dans ce document (`w` en pratique). */
  w: string;
  sources: Map<string, Source>;
  /** Empreinte JSON de chaque bloc tel qu'importé (paragraphes, cellules, tableaux). */
  baselines: Map<string, string>;
  finalSectPr: XmlElement | null;
  doc: JSONContent;
  styles: DocxStyle[];
  numbering: DocxNumbering;
  readOnly: string | null;
  author: string | null;
}

const RPR_ORDER = ['rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline', 'shadow', 'emboss',
  'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern', 'position', 'sz', 'szCs', 'highlight',
  'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath', 'rPrChange'];
const PPR_ORDER = ['pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl', 'numPr', 'suppressLineNumbers', 'pBdr',
  'shd', 'tabs', 'suppressAutoHyphens', 'kinsoku', 'wordWrap', 'overflowPunct', 'topLinePunct', 'autoSpaceDE', 'autoSpaceDN', 'bidi',
  'adjustRightInd', 'snapToGrid', 'spacing', 'ind', 'contextualSpacing', 'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection',
  'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr', 'sectPr', 'pPrChange'];

const JC_TO_ALIGN: Record<string, string> = { center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify' };
const ALIGN_TO_JC: Record<string, string> = { center: 'center', right: 'right', justify: 'both' };

const STYLE_LABELS: Record<string, string> = {
  normal: 'Normal', title: 'Titre', subtitle: 'Sous-titre', quote: 'Citation', 'intense quote': 'Citation intense',
  'list paragraph': 'Paragraphe de liste', 'no spacing': 'Sans interligne', caption: 'Légende',
};

const isOn = (el: XmlElement | null) => {
  if (!el) return false;
  const value = attrNS(el, W, 'val');
  return !(value === '0' || value === 'false' || value === 'off' || value === 'none');
};

/** Texte lisible d'un élément (ses `w:t`), pour les objets conservés. */
function plainText(el: XmlElement): string {
  let out = '';
  const walk = (node: XmlElement) => {
    for (const child of node.children) {
      if (child.kind === 'text') {
        if (node.ns === W && node.local === 't') out += child.value;
      } else {
        if (child.ns === W && (child.local === 'tab')) out += ' ';
        walk(child);
      }
    }
    if (node.ns === W && node.local === 'p') out += ' ';
  };
  walk(el);
  return out.replace(/\s+/g, ' ').trim();
}

function readStyles(xml: string | null): { styles: DocxStyle[]; byId: Map<string, DocxStyle>; defaultId: string | null } {
  const styles: DocxStyle[] = [];
  const byId = new Map<string, DocxStyle>();
  let defaultId: string | null = null;
  if (!xml) return { styles, byId, defaultId };
  for (const style of elements(scanXml(xml))) {
    if (style.ns !== W || style.local !== 'style' || attrNS(style, W, 'type') !== 'paragraph') continue;
    const id = attrNS(style, W, 'styleId');
    if (!id) continue;
    const name = attrNS(findChild(style, W, 'name'), W, 'val') ?? id;
    const heading = /^heading (\d)$/i.exec(name);
    const level = heading ? Number(heading[1]) : /^title$/i.test(name) ? 1 : 0;
    const label = heading ? `Titre ${heading[1]}` : STYLE_LABELS[name.toLowerCase()] ?? name;
    const entry = { id, label, level };
    if (attrNS(style, W, 'default') === '1' || attrNS(style, W, 'default') === 'true') defaultId = id;
    // Styles masqués ou « semi-masqués » de Word : connus pour l'affichage, absents de la liste.
    if (isOn(findChild(style, W, 'hidden')) || isOn(findChild(style, W, 'semiHidden'))) {
      byId.set(id, entry);
      continue;
    }
    styles.push(entry);
    byId.set(id, entry);
  }
  return { styles, byId, defaultId };
}

function readNumbering(xml: string | null): DocxNumbering {
  const numbering: DocxNumbering = {};
  if (!xml) return numbering;
  const abstract = new Map<string, DocxNumbering[string]>();
  const root = scanXml(xml);
  for (const el of elements(root)) {
    if (el.ns !== W || el.local !== 'abstractNum') continue;
    const levels: DocxNumbering[string] = [];
    for (const lvl of elements(el)) {
      if (lvl.ns !== W || lvl.local !== 'lvl') continue;
      const index = Number(attrNS(lvl, W, 'ilvl') ?? 0);
      levels[index] = {
        format: attrNS(findChild(lvl, W, 'numFmt'), W, 'val') ?? 'decimal',
        text: attrNS(findChild(lvl, W, 'lvlText'), W, 'val') ?? '',
        start: Number(attrNS(findChild(lvl, W, 'start'), W, 'val') ?? 1),
      };
    }
    abstract.set(attrNS(el, W, 'abstractNumId') ?? '', levels);
  }
  for (const el of elements(root)) {
    if (el.ns !== W || el.local !== 'num') continue;
    const numId = attrNS(el, W, 'numId');
    const abstractId = attrNS(findChild(el, W, 'abstractNumId'), W, 'val');
    if (numId && abstractId !== null) numbering[numId] = abstract.get(abstractId) ?? [];
  }
  return numbering;
}

const ANCHOR_STARTS = new Set(['bookmarkStart', 'commentRangeStart', 'permStart']);
const ANCHOR_ENDS = new Set(['bookmarkEnd', 'commentRangeEnd', 'permEnd']);

type Marks = NonNullable<JSONContent['marks']>;

/** Contenu d'un run simple → nœuds en ligne ; `null` si le run porte autre chose que du texte. */
function runInline(run: XmlElement, xml: string, link: { href: string; open: string } | null): JSONContent[] | null {
  const rPrEl = findChild(run, W, 'rPr');
  const marks: Marks = [];
  if (rPrEl) {
    if (isOn(findChild(rPrEl, W, 'b'))) marks.push({ type: 'bold' });
    if (isOn(findChild(rPrEl, W, 'i'))) marks.push({ type: 'italic' });
    if (isOn(findChild(rPrEl, W, 'u'))) marks.push({ type: 'underline' });
    if (isOn(findChild(rPrEl, W, 'strike')) || isOn(findChild(rPrEl, W, 'dstrike'))) marks.push({ type: 'strike' });
  }
  marks.push({ type: 'docxRun', attrs: { rPr: rPrEl ? xml.slice(rPrEl.start, rPrEl.end) : '' } });
  if (link) marks.push({ type: 'docxLink', attrs: link });
  const out: JSONContent[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ type: 'text', text, marks });
    text = '';
  };
  for (const child of elements(run)) {
    if (child.ns !== W) return null;
    switch (child.local) {
      case 'rPr':
      case 'lastRenderedPageBreak':
        break;
      case 't':
        text += textOf(child);
        break;
      case 'tab':
        text += '\t';
        break;
      case 'noBreakHyphen':
        text += '‑';
        break;
      case 'softHyphen':
        text += '­';
        break;
      case 'br': {
        const type = attrNS(child, W, 'type');
        if (type && type !== 'textWrapping') return null;
        flush();
        out.push({ type: 'hardBreak', marks });
        break;
      }
      case 'cr':
        flush();
        out.push({ type: 'hardBreak', marks });
        break;
      default:
        return null;
    }
  }
  flush();
  return out;
}

const COMPLEX_LABELS: [RegExp, string][] = [
  [/^(drawing|pict|object)$/, 'Image'],
  [/^(fldChar|instrText|fldSimple)$/, 'Champ'],
  [/^(ins|del|moveFrom|moveTo)$/, 'Modification suivie'],
  [/^commentReference$/, 'Commentaire'],
  [/^(footnoteReference|endnoteReference)$/, 'Note'],
  [/^sdt$/, 'Contrôle de contenu'],
  [/^(oMath|oMathPara)$/, 'Équation'],
];

function complexLabel(el: XmlElement): string {
  let label = '';
  const walk = (node: XmlElement) => {
    for (const child of elements(node)) {
      if (label) return;
      if (child.local === 'br' && ['page', 'column'].includes(attrNS(child, W, 'type') ?? '')) label = 'Saut de page';
      for (const [pattern, name] of COMPLEX_LABELS) if (pattern.test(child.local)) label = name;
      if (!label) walk(child);
    }
  };
  walk(el);
  return label || 'Objet Word';
}

interface ParseContext {
  xml: string;
  styles: Map<string, DocxStyle>;
  sources: Map<string, Source>;
  rels: Map<string, string>;
}

function paragraph(el: XmlElement, id: string, ctx: ParseContext): JSONContent {
  const { xml } = ctx;
  const content: JSONContent[] = [];
  let pPr = '';
  let anchorsStart = '';
  let anchorsEnd = '';
  let simple = true;
  let pPrEl: XmlElement | null = null;
  for (const child of elements(el)) {
    if (child.ns !== W) { simple = false; break; }
    if (child.local === 'pPr') {
      pPrEl = child;
      pPr = xml.slice(child.start, child.end);
    } else if (child.local === 'r') {
      const inline = runInline(child, xml, null);
      if (!inline) { simple = false; break; }
      content.push(...inline);
    } else if (child.local === 'hyperlink') {
      const rid = attrNS(child, R, 'id');
      const anchor = attrNS(child, W, 'anchor');
      const link = { href: rid ? ctx.rels.get(rid) ?? '' : anchor ? `#${anchor}` : '', open: xml.slice(child.start, child.openEnd) };
      if (child.selfClosing) continue;
      for (const inner of elements(child)) {
        if (inner.ns === W && inner.local === 'proofErr') continue;
        const inline = inner.ns === W && inner.local === 'r' ? runInline(inner, xml, link) : null;
        if (!inline) { simple = false; break; }
        content.push(...inline);
      }
      if (!simple) break;
    } else if (ANCHOR_STARTS.has(child.local)) {
      anchorsStart += xml.slice(child.start, child.end);
    } else if (ANCHOR_ENDS.has(child.local)) {
      anchorsEnd += xml.slice(child.start, child.end);
    } else if (child.local === 'proofErr') {
      // Marqueurs du correcteur : jetables.
    } else {
      simple = false;
      break;
    }
  }
  // Un saut de section dans le paragraphe : on n'y touche pas.
  if (pPrEl && (findChild(pPrEl, W, 'sectPr') || findChild(pPrEl, W, 'pPrChange'))) simple = false;
  if (!simple) {
    ctx.sources.set(id, { kind: 'atom', el });
    return { type: 'docxAtom', attrs: { id, label: complexLabel(el), text: plainText(el).slice(0, 240) } };
  }
  const styleId = attrNS(findChild(pPrEl, W, 'pStyle'), W, 'val');
  const jc = attrNS(findChild(pPrEl, W, 'jc'), W, 'val');
  const numPr = findChild(pPrEl, W, 'numPr');
  const numId = attrNS(findChild(numPr, W, 'numId'), W, 'val');
  const ilvl = attrNS(findChild(numPr, W, 'ilvl'), W, 'val');
  const attrs: ParagraphAttrs = {
    styleId: styleId ?? null,
    align: jc ? JC_TO_ALIGN[jc] ?? null : null,
    numId: numId && numId !== '0' ? numId : null,
    ilvl: numId && numId !== '0' ? Number(ilvl ?? 0) : null,
  };
  ctx.sources.set(id, { kind: 'p', el, pPr, anchorsStart, anchorsEnd, attrs });
  return {
    type: 'docxParagraph',
    attrs: { id, ...attrs, level: styleId ? ctx.styles.get(styleId)?.level ?? 0 : 0 },
    ...(content.length ? { content } : {}),
  };
}

function table(el: XmlElement, id: string, ctx: ParseContext): JSONContent {
  const atom = () => {
    ctx.sources.set(id, { kind: 'atom', el });
    return { type: 'docxAtom', attrs: { id, label: 'Tableau', text: plainText(el).slice(0, 240) } };
  };
  const rows: SourceCell[][] = [];
  const rowJson: JSONContent[] = [];
  for (const rowEl of elements(el)) {
    if (rowEl.ns !== W) return atom();
    if (rowEl.local === 'tblPr' || rowEl.local === 'tblGrid') continue;
    if (rowEl.local !== 'tr') return atom();
    const cells: SourceCell[] = [];
    const cellJson: JSONContent[] = [];
    for (const cellEl of elements(rowEl)) {
      if (cellEl.ns !== W) return atom();
      if (cellEl.local === 'trPr' || cellEl.local === 'tblPrEx') continue;
      if (cellEl.local !== 'tc' || cellEl.selfClosing) return atom();
      const tcPr = findChild(cellEl, W, 'tcPr');
      // Fusion verticale : la structure ne se ramène pas à la grille de l'éditeur.
      if (tcPr && findChild(tcPr, W, 'vMerge')) return atom();
      const colspan = Number(attrNS(findChild(tcPr, W, 'gridSpan'), W, 'val') ?? 1) || 1;
      const key = `${id}/r${rows.length}/c${cells.length}`;
      const blocks: JSONContent[] = [];
      for (const inner of elements(cellEl)) {
        if (inner.ns !== W) return atom();
        if (inner.local === 'tcPr') continue;
        if (inner.local !== 'p') return atom();
        blocks.push(paragraph(inner, `${key}/p${blocks.length}`, ctx));
      }
      if (!blocks.length) return atom();
      cells.push({ el: cellEl, contentStart: tcPr ? tcPr.end : cellEl.openEnd, key, colspan });
      cellJson.push({ type: 'tableCell', attrs: { colspan, rowspan: 1, colwidth: null }, content: blocks });
    }
    if (!cells.length) return atom();
    rows.push(cells);
    rowJson.push({ type: 'tableRow', content: cellJson });
  }
  if (!rows.length) return atom();
  ctx.sources.set(id, { kind: 'tbl', el, rows });
  return { type: 'table', attrs: { id }, content: rowJson };
}

function block(el: XmlElement, id: string, ctx: ParseContext): JSONContent {
  if (el.ns === W && el.local === 'p') return paragraph(el, id, ctx);
  if (el.ns === W && el.local === 'tbl') return table(el, id, ctx);
  ctx.sources.set(id, { kind: 'atom', el });
  let label = 'Objet Word';
  if (el.ns === W && el.local === 'sdt') {
    const gallery = attrNS(findChild(findChild(findChild(el, W, 'sdtPr'), W, 'docPartObj'), W, 'docPartGallery'), W, 'val');
    label = gallery === 'Table of Contents' ? 'Table des matières' : 'Contrôle de contenu';
  }
  return { type: 'docxAtom', attrs: { id, label, text: plainText(el).slice(0, 240) } };
}

const schemaCache = new Map<string, ReturnType<typeof getSchema>>();
function schemaFor(numbering: DocxNumbering) {
  // Le schéma ne dépend pas de la numérotation (plugins seulement) : un seul suffit.
  void numbering;
  let schema = schemaCache.get('docx');
  if (!schema) {
    schema = getSchema(docxExtensions());
    schemaCache.set('docx', schema);
  }
  return schema;
}

/** Normalise un document JSON comme le ferait l'éditeur (attributs par défaut, ordre des marques). */
export function normalizeDocx(doc: JSONContent): JSONContent {
  return schemaFor({}).nodeFromJSON(doc).toJSON() as JSONContent;
}

function wrapError(error: unknown): never {
  if (error instanceof FormatError) throw error;
  if (error instanceof ZipError || error instanceof XmlScanError) throw new FormatError(`Document Word illisible : ${error.message}`);
  throw error;
}

/** Lit un .docx : document pour l'éditeur, et tout ce qu'il faut pour le réécrire. */
export async function readDocxDocument(bytes: Uint8Array): Promise<DocxDocument> {
  try {
    const archive = readZip(bytes);
    const { mainPart, corePart } = await packageParts(archive, 'word/document.xml');
    const xml = await readZipText(archive, mainPart);
    if (xml === null) throw new FormatError('Ce fichier n’est pas un document Word (.docx) : contenu principal absent.');
    const root = scanXml(xml);
    if (root.ns === W_STRICT) {
      throw new FormatError('Document Word au format « OOXML strict » : WorkLogs ne sait pas encore le modifier. « Ouvrir avec… » l’ouvre dans LibreOffice.');
    }
    const body = findChild(root, W, 'body');
    if (!body) throw new FormatError('Document Word sans corps de texte.');
    const w = root.name.includes(':') ? root.name.slice(0, root.name.indexOf(':')) : '';
    if (!w) throw new FormatError('Document Word inhabituel (espace de noms par défaut) : modification non prise en charge.');
    const mainRels = await relationships(archive, mainPart);
    const rels = new Map(mainRels.map((rel) => [rel.id, rel.target]));
    const partOf = (type: RegExp) => {
      const rel = mainRels.find((candidate) => type.test(candidate.type));
      return rel ? resolveTarget(mainPart, rel.target) : null;
    };
    const stylesPart = partOf(/\/styles$/);
    const numberingPart = partOf(/\/numbering$/);
    const settingsPart = partOf(/\/settings$/);
    const { styles, byId } = readStyles(stylesPart ? await readZipText(archive, stylesPart) : null);
    const numbering = readNumbering(numberingPart ? await readZipText(archive, numberingPart) : null);

    let readOnly: string | null = null;
    const settingsXml = settingsPart ? await readZipText(archive, settingsPart) : null;
    if (settingsXml) {
      const settings = scanXml(settingsXml);
      if (isOn(findChild(settings, W, 'trackRevisions'))) {
        readOnly = 'Le suivi des modifications est activé dans ce document : accepte ou refuse les modifications et désactive le suivi dans Word (ou « Ouvrir avec… ») avant de le modifier ici.';
      }
      const protection = findChild(settings, W, 'documentProtection');
      if (protection && ['1', 'true', 'on'].includes(attrNS(protection, W, 'enforcement') ?? '')) {
        readOnly = 'Ce document est protégé contre les modifications dans Word.';
      }
    }

    const sources = new Map<string, Source>();
    const ctx: ParseContext = { xml, styles: byId, sources, rels };
    const children = elements(body);
    const last = children[children.length - 1];
    const finalSectPr = last && last.ns === W && last.local === 'sectPr' ? last : null;
    const blocks = children.filter((child) => child !== finalSectPr).map((child, index) => block(child, `b${index}`, ctx));
    if (!blocks.length) blocks.push({ type: 'docxParagraph', attrs: { id: null } });
    const doc = normalizeDocx({ type: 'doc', content: blocks });

    const baselines = new Map<string, string>();
    const remember = (node: JSONContent) => {
      if (node.attrs?.id) baselines.set(String(node.attrs.id), JSON.stringify(node));
      if (node.type === 'table') {
        node.content?.forEach((row, r) => row.content?.forEach((cell, c) => {
          baselines.set(`${node.attrs!.id}/r${r}/c${c}`, JSON.stringify(cell.content ?? []));
          cell.content?.forEach(remember);
        }));
      }
    };
    doc.content?.forEach(remember);

    const author = await coreAuthor(archive, corePart);
    return { archive, mainPart, corePart, xml, body, w, sources, baselines, finalSectPr, doc, styles, numbering, readOnly, author };
  } catch (error) {
    wrapError(error);
  }
}

// ---------------------------------------------------------------- écriture

/** Enfants directs d'un fragment (`<w:pPr>…</w:pPr>`) : nom local et position. */
function fragmentChildren(fragment: string) {
  const root = scanXml(fragment);
  return { root, children: elements(root) };
}

/** Remplace, retire ou insère (à sa place dans l'ordre du schéma) un enfant direct. */
function setChild(fragment: string, wrapper: string, order: string[], local: string, replacement: string | null): string {
  if (!fragment) return replacement ? `<${wrapper}>${replacement}</${wrapper}>` : '';
  let text = fragment;
  let { root, children } = fragmentChildren(text);
  if (root.selfClosing) {
    if (!replacement) return text;
    text = `<${wrapper}></${wrapper}>`;
    ({ root, children } = fragmentChildren(text));
  }
  const existing = children.find((child) => child.local === local);
  if (existing) return text.slice(0, existing.start) + (replacement ?? '') + text.slice(existing.end);
  if (!replacement) return text;
  const rank = order.indexOf(local);
  const after = children.find((child) => {
    const childRank = order.indexOf(child.local);
    // Un élément d'un autre espace de noms (w14:…) se place après ceux du schéma de base.
    return childRank === -1 ? child.name.split(':')[0] !== root.name.split(':')[0] : childRank > rank;
  });
  const at = after ? after.start : root.closeStart;
  return text.slice(0, at) + replacement + text.slice(at);
}

function patchParagraphProperties(pPr: string, w: string, from: ParagraphAttrs, to: ParagraphAttrs): string {
  let out = pPr;
  const wrapper = `${w}:pPr`;
  if ((from.styleId ?? null) !== (to.styleId ?? null)) {
    out = setChild(out, wrapper, PPR_ORDER, 'pStyle', to.styleId ? `<${w}:pStyle ${w}:val="${escapeAttr(to.styleId)}"/>` : null);
  }
  if ((from.align ?? null) !== (to.align ?? null)) {
    const jc = to.align ? ALIGN_TO_JC[to.align] : null;
    out = setChild(out, wrapper, PPR_ORDER, 'jc', jc ? `<${w}:jc ${w}:val="${jc}"/>` : null);
  }
  if (to.numId && from.numId === to.numId && (from.ilvl ?? 0) !== (to.ilvl ?? 0) && out) {
    const { children } = fragmentChildren(out);
    const numPr = children.find((child) => child.local === 'numPr');
    if (numPr) {
      const ilvl = elements(numPr).find((child) => child.local === 'ilvl');
      const tag = `<${w}:ilvl ${w}:val="${Math.max(0, Math.min(8, to.ilvl ?? 0))}"/>`;
      out = ilvl ? out.slice(0, ilvl.start) + tag + out.slice(ilvl.end) : out.slice(0, numPr.openEnd) + tag + out.slice(numPr.openEnd);
    }
  }
  if (out && /^<[^>]+><\/[^>]+>$/.test(out)) return '';
  return out;
}

interface RunFlags { b: boolean; i: boolean; u: boolean; strike: boolean }

function directFlags(rPr: string): RunFlags {
  const flags = { b: false, i: false, u: false, strike: false };
  if (!rPr) return flags;
  const { children } = fragmentChildren(rPr);
  const flag = (local: string) => {
    const el = children.find((child) => child.local === local);
    if (!el) return false;
    const value = Object.entries(el.attrs).find(([key]) => key.endsWith(':val') || key === 'val')?.[1];
    return !(value === '0' || value === 'false' || value === 'off' || value === 'none');
  };
  flags.b = flag('b');
  flags.i = flag('i');
  flags.u = flag('u');
  flags.strike = flag('strike') || flag('dstrike');
  return flags;
}

/** Bascule gras/italique/souligné/barré dans `<w:rPr>`, à leur place dans l'ordre exigé par Word. */
function applyFlags(rPr: string, w: string, wanted: RunFlags): string {
  const current = directFlags(rPr);
  let out = rPr;
  const wrapper = `${w}:rPr`;
  const set = (local: string, replacement: string | null) => { out = setChild(out, wrapper, RPR_ORDER, local, replacement); };
  if (wanted.b !== current.b) { set('b', wanted.b ? `<${w}:b/>` : null); if (!wanted.b) set('bCs', null); }
  if (wanted.i !== current.i) { set('i', wanted.i ? `<${w}:i/>` : null); if (!wanted.i) set('iCs', null); }
  if (wanted.u !== current.u) set('u', wanted.u ? `<${w}:u ${w}:val="single"/>` : null);
  if (wanted.strike !== current.strike) { set('strike', wanted.strike ? `<${w}:strike/>` : null); if (!wanted.strike) set('dstrike', null); }
  if (out && /^<[^>]+><\/[^>]+>$/.test(out)) return '';
  return out;
}

const INVALID_XML = /[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/g;

function runContent(text: string, w: string): string {
  return text.replace(INVALID_XML, '').split('\t').map((piece, index) =>
    (index ? `<${w}:tab/>` : '') + (piece ? `<${w}:t xml:space="preserve">${escapeText(piece)}</${w}:t>` : '')).join('');
}

function inlineXml(content: JSONContent[] | undefined, w: string): string {
  const pieces: { rPr: string; link: string; xml: string }[] = [];
  for (const node of content ?? []) {
    const marks = node.marks ?? [];
    const has = (type: string) => marks.some((mark) => mark.type === type);
    const base = String(marks.find((mark) => mark.type === 'docxRun')?.attrs?.rPr ?? '');
    const link = String(marks.find((mark) => mark.type === 'docxLink')?.attrs?.open ?? '');
    const rPr = applyFlags(base, w, { b: has('bold'), i: has('italic'), u: has('underline'), strike: has('strike') });
    const xml = node.type === 'hardBreak' ? `<${w}:br/>` : node.type === 'text' ? runContent(node.text ?? '', w) : '';
    if (!xml) continue;
    const last = pieces[pieces.length - 1];
    if (last && last.rPr === rPr && last.link === link) last.xml += xml;
    else pieces.push({ rPr, link, xml });
  }
  let out = '';
  for (let i = 0; i < pieces.length; i++) {
    const { link } = pieces[i];
    let runs = '';
    let j = i;
    for (; j < pieces.length && pieces[j].link === link; j++) runs += `<${w}:r>${pieces[j].rPr}${pieces[j].xml}</${w}:r>`;
    out += link ? `${link}${runs}</${link.slice(1).split(/[\s>]/)[0]}>` : runs;
    i = j - 1;
  }
  return out;
}

interface ExportContext {
  doc: DocxDocument;
  used: Set<string>;
  previous: SourceParagraph | null;
}

const NO_ATTRS: ParagraphAttrs = { styleId: null, align: null, numId: null, ilvl: null };
const paragraphAttrs = (node: JSONContent): ParagraphAttrs => ({
  styleId: (node.attrs?.styleId as string | null) ?? null,
  align: (node.attrs?.align as string | null) ?? null,
  numId: (node.attrs?.numId as string | null) ?? null,
  ilvl: node.attrs?.numId ? Number(node.attrs?.ilvl ?? 0) : null,
});

function paragraphXml(node: JSONContent, ctx: ExportContext): string {
  const { doc } = ctx;
  const { w, xml } = doc;
  const id = node.attrs?.id ? String(node.attrs.id) : null;
  const found = id ? doc.sources.get(id) : undefined;
  const source = found?.kind === 'p' ? found : null;
  const first = Boolean(source && id && !ctx.used.has(id));
  if (id) ctx.used.add(id);
  if (source && first && JSON.stringify(node) === doc.baselines.get(id!)) {
    ctx.previous = source;
    return xml.slice(source.el.start, source.el.end);
  }
  // Paragraphe neuf : il hérite des propriétés de celui d'où il vient (Entrée), comme dans Word.
  const base = source ?? ctx.previous;
  const pPr = patchParagraphProperties(base?.pPr ?? '', w, base?.attrs ?? NO_ATTRS, paragraphAttrs(node));
  let open = `<${w}:p>`;
  if (source && first) {
    open = xml.slice(source.el.start, source.el.openEnd);
    if (source.el.selfClosing) open = open.replace(/\s*\/>$/, '>');
  }
  const anchors = source && first ? [source.anchorsStart, source.anchorsEnd] : ['', ''];
  if (source) ctx.previous = source;
  return `${open}${pPr}${anchors[0]}${inlineXml(node.content, w)}${anchors[1]}</${w}:p>`;
}

function blockXml(node: JSONContent, ctx: ExportContext): string {
  const id = node.attrs?.id ? String(node.attrs.id) : null;
  if (node.type === 'docxParagraph') return paragraphXml(node, ctx);
  const source = id ? ctx.doc.sources.get(id) : undefined;
  // Objet ou tableau collé une seconde fois : on n'écrit jamais deux fois la même identité.
  if (!source || ctx.used.has(id!)) return '';
  ctx.used.add(id!);
  if (node.type === 'docxAtom' && source.kind === 'atom') return ctx.doc.xml.slice(source.el.start, source.el.end);
  if (node.type === 'table' && source.kind === 'tbl') return tableXml(node, source, ctx);
  return '';
}

function tableXml(node: JSONContent, source: SourceTable, ctx: ExportContext): string {
  const { xml, baselines, w } = ctx.doc;
  const id = String(node.attrs?.id);
  if (JSON.stringify(node) === baselines.get(id)) return xml.slice(source.el.start, source.el.end);
  const rows = node.content ?? [];
  const sameShape = rows.length === source.rows.length && rows.every((row, r) =>
    (row.content?.length ?? 0) === source.rows[r].length
    && (row.content ?? []).every((cell, c) => Number(cell.attrs?.colspan ?? 1) === source.rows[r][c].colspan && Number(cell.attrs?.rowspan ?? 1) === 1));
  if (!sameShape) throw new FormatError('Les lignes et colonnes des tableaux se modifient dans Word pour l’instant (« Ouvrir avec… ») : WorkLogs n’en change que le texte.');
  let out = '';
  let cursor = source.el.start;
  rows.forEach((row, r) => row.content?.forEach((cell, c) => {
    const cellSource = source.rows[r][c];
    const blocks = cell.content ?? [];
    if (JSON.stringify(blocks) === baselines.get(cellSource.key)) return;
    const saved = ctx.previous;
    ctx.previous = null;
    let inner = blocks.map((child) => blockXml(child, ctx)).join('');
    ctx.previous = saved;
    // Word exige qu'une cellule se termine par un paragraphe.
    if (!/<\/[^>]*:p>$|<[^>]*:p\/>$/.test(inner)) inner += `<${w}:p/>`;
    out += xml.slice(cursor, cellSource.contentStart) + inner;
    cursor = cellSource.el.closeStart;
  }));
  return out + xml.slice(cursor, source.el.end);
}

/** Vérifie la structure d'un brouillon avant envoi (tableaux, notamment), sans écrire. */
export function docxProblems(doc: DocxDocument, edited: JSONContent): string[] {
  const problems: string[] = [];
  for (const node of edited.content ?? []) {
    if (node.type !== 'table') continue;
    const source = doc.sources.get(String(node.attrs?.id));
    if (source?.kind !== 'tbl') continue;
    const rows = node.content ?? [];
    const sameShape = rows.length === source.rows.length && rows.every((row, r) => (row.content?.length ?? 0) === source.rows[r].length);
    if (!sameShape) {
      problems.push('Les lignes et colonnes des tableaux se modifient dans Word pour l’instant (« Ouvrir avec… ») : annule ce changement de structure pour envoyer.');
      break;
    }
  }
  return problems;
}

/** Réécrit le .docx d'origine avec le document modifié. Rien de modifié : les octets d'origine. */
export async function writeDocx(bytes: Uint8Array, edited: JSONContent, { author, now = new Date() }: { author: string; now?: Date }): Promise<Uint8Array> {
  const doc = await readDocxDocument(bytes);
  if (doc.readOnly) throw new FormatError(doc.readOnly);
  const normalized = normalizeDocx(edited);
  if (JSON.stringify(normalized) === JSON.stringify(doc.doc)) return bytes;
  const ctx: ExportContext = { doc, used: new Set(), previous: null };
  let body = (normalized.content ?? []).map((node) => blockXml(node, ctx)).join('');
  if (!body) body = `<${doc.w}:p/>`;
  if (doc.finalSectPr) body += doc.xml.slice(doc.finalSectPr.start, doc.finalSectPr.end);
  const xml = doc.body.selfClosing
    ? doc.xml.slice(0, doc.body.start) + `<${doc.body.name}>${body}</${doc.body.name}>` + doc.xml.slice(doc.body.end)
    : doc.xml.slice(0, doc.body.openEnd) + body + doc.xml.slice(doc.body.closeStart);
  if (!isWellFormed(xml)) throw new FormatError('WorkLogs a produit un document Word invalide : rien n’est envoyé. Signale-le.');
  const edits = new Map<string, Uint8Array>([[doc.mainPart, new TextEncoder().encode(xml)]]);
  if (doc.corePart) {
    const core = await readZipText(doc.archive, doc.corePart);
    if (core) edits.set(doc.corePart, new TextEncoder().encode(patchCoreProperties(core, author, now)));
  }
  return writeZip(doc.archive, edits);
}
