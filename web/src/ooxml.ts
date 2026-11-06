import { readZip, readZipText, type ZipArchive } from './zip';
import { elements, escapeText, scanXml, type XmlElement, type XmlText } from './xml-scan';

/**
 * Ce que Word et Excel ont en commun : le paquet OPC (relations entre parties,
 * types de contenu) et les propriétés du document (`docProps/core.xml`).
 */

export const OFFICE_DOCUMENT = /\/officeDocument$/;
export const CORE_PROPERTIES = /\/(?:metadata\/)?core-properties$/;

/** Texte direct d'un élément (sans ses descendants). */
export const textOf = (el: XmlElement) => el.children.filter((child): child is XmlText => child.kind === 'text').map((child) => child.value).join('');

export function partRelsPath(part: string) {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

/** Cible d'une relation, relative à la partie qui la déclare, en chemin d'archive. */
export function resolveTarget(base: string, target: string) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const piece of target.split('/')) {
    if (piece === '..') parts.pop();
    else if (piece && piece !== '.') parts.push(piece);
  }
  return parts.join('/');
}

export interface Relationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

/** Relations d'une partie (`''` : celles du paquet, `_rels/.rels`). */
export async function relationships(archive: ZipArchive, part: string): Promise<Relationship[]> {
  const xml = await readZipText(archive, part === '' ? '_rels/.rels' : partRelsPath(part));
  const out: Relationship[] = [];
  if (!xml) return out;
  for (const rel of elements(scanXml(xml))) {
    if (rel.local !== 'Relationship') continue;
    out.push({ id: rel.attrs.Id ?? '', type: rel.attrs.Type ?? '', target: rel.attrs.Target ?? '', external: rel.attrs.TargetMode === 'External' });
  }
  return out;
}

/** Partie principale (document, classeur) et propriétés du document. */
export async function packageParts(archive: ZipArchive, fallback: string) {
  const packageRels = await relationships(archive, '');
  const mainRel = packageRels.find((rel) => OFFICE_DOCUMENT.test(rel.type));
  const mainPart = mainRel ? resolveTarget('', mainRel.target) : fallback;
  const coreRel = packageRels.find((rel) => CORE_PROPERTIES.test(rel.type));
  const corePart = coreRel ? resolveTarget('', coreRel.target) : archive.byName.has('docProps/core.xml') ? 'docProps/core.xml' : null;
  return { mainPart, corePart };
}

/** Dernier auteur inscrit dans les propriétés du document. */
export async function coreAuthor(archive: ZipArchive, corePart: string | null): Promise<string | null> {
  const xml = corePart ? await readZipText(archive, corePart) : null;
  if (!xml) return null;
  const lastBy = elements(scanXml(xml)).find((el) => el.local === 'lastModifiedBy');
  return lastBy ? textOf(lastBy).trim() || null : null;
}

/** Dernier auteur d'un fichier Word ou Excel (inscrit à chaque enregistrement), sinon `null`. */
export async function officeAuthor(bytes: Uint8Array): Promise<string | null> {
  try {
    const archive = readZip(bytes);
    const { corePart } = await packageParts(archive, '');
    return await coreAuthor(archive, corePart);
  } catch {
    return null;
  }
}

const pad = (n: number) => String(n).padStart(2, '0');
const w3cdtf = (date: Date) =>
  `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`;

/** Propriétés du document : dernier auteur, date, numéro de révision — seulement leur texte. */
export function patchCoreProperties(xml: string, author: string, now: Date): string {
  const root = scanXml(xml);
  const edits: { start: number; end: number; text: string }[] = [];
  const replaceText = (local: string, value: (current: string) => string) => {
    const el = elements(root).find((child) => child.local === local);
    if (!el) return false;
    const current = textOf(el);
    if (el.selfClosing) edits.push({ start: el.start, end: el.end, text: `<${el.name}>${escapeText(value(current))}</${el.name}>` });
    else edits.push({ start: el.openEnd, end: el.closeStart, text: escapeText(value(current)) });
    return true;
  };
  if (!replaceText('lastModifiedBy', () => author)) {
    const prefix = Object.entries(root.attrs).find(([, uri]) => uri === 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties')?.[0];
    if (prefix?.startsWith('xmlns:')) edits.push({ start: root.closeStart, end: root.closeStart, text: `<${prefix.slice(6)}:lastModifiedBy>${escapeText(author)}</${prefix.slice(6)}:lastModifiedBy>` });
  }
  replaceText('modified', () => w3cdtf(now));
  replaceText('revision', (current) => String((Number.parseInt(current, 10) || 0) + 1));
  let out = xml;
  for (const edit of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

/** Contrôle final : un XML que le navigateur refuse ne part jamais sur le partage. */
export function isWellFormed(xml: string): boolean {
  const check = new DOMParser().parseFromString(xml, 'application/xml');
  return !check.getElementsByTagName('parsererror').length;
}
