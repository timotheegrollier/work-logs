/**
 * Aperçu d'un document Word (.docx) sans dépendance : un .docx est une archive
 * zip de XML. Le navigateur sait décompresser (`DecompressionStream`) et lire du
 * XML (`DOMParser`) ; on en tire un modèle simple — titres, paragraphes, listes,
 * tableaux, images, liens, gras/italique/souligné/barré — rendu en éléments React,
 * jamais en HTML brut. La mise en page fine (colonnes, marges, polices, zones de
 * texte) est volontairement laissée de côté : « Ouvrir avec… » reste là pour ça.
 */

export interface DocxListItem { depth: number; ordered: boolean; runs: DocxRun[] }

export interface DocxRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  href?: string;
  /** Image intégrée, en `data:` (les CSP de l'app autorisent `data:`, pas `blob:`). */
  image?: { src: string; alt: string };
}
export type DocxBlock =
  | { kind: 'paragraph'; level: 0 | 1 | 2 | 3 | 4 | 5 | 6; runs: DocxRun[]; align?: 'center' | 'right' | 'justify' }
  /** Éléments consécutifs d'une même liste ; chaque niveau garde son type (numéroté ou puces). */
  | { kind: 'list'; items: DocxListItem[] }
  | { kind: 'table'; rows: DocxBlock[][][] };

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';

// Garde-fous contre une archive piégée : tailles et nombre d'entrées bornés.
const MAX_ENTRIES = 5000;
const MAX_ENTRY_BYTES = 40 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_BLOCKS = 20000;

export class DocxError extends Error {}

interface ZipEntry { name: string; method: number; compressed: number; size: number; offset: number }

/** Répertoire central d'une archive zip (sans zip64 : un .docx de plus de 4 Go n'a rien à faire ici). */
function readZipDirectory(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new DocxError('Ce fichier n’est pas un document Word lisible (archive introuvable).');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (count > MAX_ENTRIES) throw new DocxError('Document Word trop complexe pour l’aperçu.');
  const entries = new Map<string, ZipEntry>();
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw new DocxError('Document Word abîmé (répertoire de l’archive).');
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    entries.set(name, { name, method, compressed, size, offset: local });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function inflate(data: Uint8Array, limit: number): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(data); controller.close(); } });
  const stream = source.pipeThrough(new DecompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    // Taille annoncée mensongère (bombe de décompression) : on coupe.
    if (total > limit) { await reader.cancel(); throw new DocxError('Document Word trop volumineux pour l’aperçu.'); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

async function readEntry(bytes: Uint8Array, entry: ZipEntry, limit = MAX_ENTRY_BYTES): Promise<Uint8Array> {
  if (entry.size > limit) throw new DocxError('Document Word trop volumineux pour l’aperçu.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = entry.offset;
  if (at + 30 > bytes.length || view.getUint32(at, true) !== 0x04034b50) throw new DocxError('Document Word abîmé (entrée de l’archive).');
  const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  const data = bytes.subarray(start, start + entry.compressed);
  if (entry.method === 0) return data.slice(0, limit);
  if (entry.method === 8) return inflate(data, limit);
  throw new DocxError('Document Word compressé d’une façon que l’aperçu ne connaît pas.');
}

const children = (node: Element, ns: string, name: string) =>
  Array.from(node.children).filter((child) => child.namespaceURI === ns && child.localName === name);
const child = (node: Element | null | undefined, ns: string, name: string) =>
  (node ? children(node, ns, name)[0] : undefined);
const attr = (node: Element | null | undefined, name: string) => node?.getAttributeNS(W, name) ?? node?.getAttribute(`w:${name}`) ?? null;
/** `<w:b/>` vaut vrai, `<w:b w:val="0"/>` ou `"false"` vaut faux. */
const on = (props: Element | undefined, name: string) => {
  const flag = child(props, W, name);
  if (!flag) return undefined;
  const value = attr(flag, 'val');
  return !(value === '0' || value === 'false' || value === 'none');
};

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new DocxError('Document Word abîmé (XML illisible).');
  return doc;
}

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' };

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Lit un .docx et rend son modèle d'aperçu. Lève `DocxError` avec un message français. */
export async function readDocx(buffer: ArrayBuffer): Promise<DocxBlock[]> {
  const bytes = new Uint8Array(buffer);
  const entries = readZipDirectory(bytes);
  const text = async (name: string) => {
    const entry = entries.get(name);
    return entry ? new TextDecoder().decode(await readEntry(bytes, entry)) : null;
  };
  const main = await text('word/document.xml');
  if (main === null) throw new DocxError('Ce fichier n’est pas un document Word (.docx) : contenu principal absent.');
  const document = parseXml(main);

  // Relations : images (`r:embed`) et liens (`r:id` d'un w:hyperlink).
  const relations = new Map<string, { target: string; external: boolean }>();
  const rels = await text('word/_rels/document.xml.rels');
  if (rels) {
    for (const rel of Array.from(parseXml(rels).getElementsByTagName('Relationship'))) {
      relations.set(rel.getAttribute('Id') ?? '', { target: rel.getAttribute('Target') ?? '', external: rel.getAttribute('TargetMode') === 'External' });
    }
  }
  // Styles : le nom anglais canonique (« heading 2 ») survit aux traductions (« Titre2 »).
  const headingOf = new Map<string, number>();
  const styles = await text('word/styles.xml');
  if (styles) {
    for (const style of Array.from(parseXml(styles).getElementsByTagNameNS(W, 'style'))) {
      const name = (attr(child(style, W, 'name'), 'val') ?? '').toLowerCase();
      const match = /^heading (\d)$/.exec(name);
      const level = match ? Number(match[1]) : name === 'title' ? 1 : 0;
      if (level) headingOf.set(attr(style, 'styleId') ?? '', Math.min(6, level));
    }
  }
  // Numérotation : une liste est « ordonnée » si son niveau n'est pas une puce.
  const orderedOf = new Map<string, boolean>();
  const numbering = await text('word/numbering.xml');
  if (numbering) {
    const xml = parseXml(numbering);
    const abstract = new Map<string, Map<string, boolean>>();
    for (const node of Array.from(xml.getElementsByTagNameNS(W, 'abstractNum'))) {
      const levels = new Map<string, boolean>();
      for (const lvl of children(node, W, 'lvl')) levels.set(attr(lvl, 'ilvl') ?? '0', attr(child(lvl, W, 'numFmt'), 'val') !== 'bullet');
      abstract.set(attr(node, 'abstractNumId') ?? '', levels);
    }
    for (const num of Array.from(xml.getElementsByTagNameNS(W, 'num'))) {
      const levels = abstract.get(attr(child(num, W, 'abstractNumId'), 'val') ?? '');
      for (const [ilvl, ordered] of levels ?? []) orderedOf.set(`${attr(num, 'numId')}:${ilvl}`, ordered);
    }
  }

  const images = new Map<string, string>();
  const image = async (id: string): Promise<string | null> => {
    if (images.has(id)) return images.get(id)!;
    const rel = relations.get(id);
    if (!rel || rel.external) return null;
    const name = rel.target.startsWith('/') ? rel.target.slice(1) : `word/${rel.target}`.replace(/\/[^/]+\/\.\.\//g, '/');
    const mime = IMAGE_TYPES[name.split('.').pop()?.toLowerCase() ?? ''];
    const entry = entries.get(name);
    // EMF/WMF et images géantes : ignorées plutôt que de bloquer l'aperçu.
    if (!mime || !entry || entry.size > MAX_IMAGE_BYTES) return null;
    const src = `data:${mime};base64,${toBase64(await readEntry(bytes, entry, MAX_IMAGE_BYTES))}`;
    images.set(id, src);
    return src;
  };

  let blocks = 0;
  const count = () => { if (++blocks > MAX_BLOCKS) throw new DocxError('Document Word trop long pour l’aperçu.'); };

  async function runsOf(paragraph: Element): Promise<DocxRun[]> {
    const out: DocxRun[] = [];
    const walk = async (node: Element, href?: string) => {
      for (const item of Array.from(node.children)) {
        if (item.namespaceURI !== W) continue;
        if (item.localName === 'hyperlink') {
          const rel = relations.get(item.getAttributeNS(R, 'id') ?? '');
          const target = rel?.external && /^(https?:|mailto:)/i.test(rel.target) ? rel.target : undefined;
          await walk(item, target);
        } else if (['ins', 'smartTag', 'sdt', 'sdtContent', 'fldSimple'].includes(item.localName)) {
          await walk(item, href);
        } else if (item.localName === 'r') {
          const props = child(item, W, 'rPr');
          const style = {
            bold: on(props, 'b'), italic: on(props, 'i'),
            underline: child(props, W, 'u') ? attr(child(props, W, 'u'), 'val') !== 'none' : undefined,
            strike: on(props, 'strike') || on(props, 'dstrike'), href,
          };
          for (const part of Array.from(item.children)) {
            if (part.namespaceURI === W && part.localName === 't') out.push({ text: part.textContent ?? '', ...style });
            else if (part.namespaceURI === W && part.localName === 'tab') out.push({ text: '\t', ...style });
            else if (part.namespaceURI === W && (part.localName === 'br' || part.localName === 'cr')) out.push({ text: '\n', ...style });
            else if (part.namespaceURI === W && part.localName === 'drawing') {
              const blip = part.getElementsByTagNameNS(A, 'blip')[0];
              const id = blip?.getAttributeNS(R, 'embed');
              const src = id ? await image(id) : null;
              const alt = part.getElementsByTagNameNS(WP, 'docPr')[0]?.getAttribute('descr') ?? '';
              if (src) out.push({ text: '', image: { src, alt } });
            }
          }
        }
        // w:del (texte supprimé en révision) et le reste : ignorés.
      }
    };
    await walk(paragraph);
    return out;
  }

  async function body(container: Element): Promise<DocxBlock[]> {
    const out: DocxBlock[] = [];
    for (const node of Array.from(container.children)) {
      if (node.namespaceURI !== W) continue;
      if (node.localName === 'p') {
        count();
        const props = child(node, W, 'pPr');
        const runs = await runsOf(node);
        const numPr = child(props, W, 'numPr');
        const numId = attr(child(numPr, W, 'numId'), 'val');
        if (numPr && numId && numId !== '0') {
          const depth = Number(attr(child(numPr, W, 'ilvl'), 'val') ?? 0) || 0;
          const ordered = orderedOf.get(`${numId}:${depth}`) ?? false;
          const last = out.at(-1);
          if (last?.kind === 'list') last.items.push({ depth, ordered, runs });
          else out.push({ kind: 'list', items: [{ depth, ordered, runs }] });
          continue;
        }
        const jc = attr(child(props, W, 'jc'), 'val');
        const align = jc === 'center' ? 'center' : jc === 'right' || jc === 'end' ? 'right' : jc === 'both' ? 'justify' : undefined;
        const level = (headingOf.get(attr(child(props, W, 'pStyle'), 'val') ?? '') ?? 0) as 0 | 1 | 2 | 3 | 4 | 5 | 6;
        out.push({ kind: 'paragraph', level, runs, ...(align ? { align } : {}) });
      } else if (node.localName === 'tbl') {
        count();
        const rows: DocxBlock[][][] = [];
        for (const row of children(node, W, 'tr')) {
          rows.push(await Promise.all(children(row, W, 'tc').map((cell) => body(cell))));
        }
        out.push({ kind: 'table', rows });
      } else if (node.localName === 'sdt') {
        const content = child(node, W, 'sdtContent');
        if (content) out.push(...(await body(content)));
      }
    }
    return out;
  }

  const root = document.getElementsByTagNameNS(W, 'body')[0];
  if (!root) throw new DocxError('Document Word vide ou abîmé.');
  return body(root);
}
