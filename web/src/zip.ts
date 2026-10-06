/**
 * Archives zip (un .docx, un .xlsx) sans dépendance : `DecompressionStream` et
 * `CompressionStream('deflate-raw')` font le travail. La lecture est bornée
 * (archive piégée) ; l'écriture **recopie telles quelles** les entrées qu'on n'a
 * pas touchées — en-tête local, données compressées, enregistrement central —
 * et ne recompresse que celles qu'on remplace. Rien de modifié : les octets
 * d'origine, à l'identique.
 */

export class ZipError extends Error {}

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressed: number;
  size: number;
  /** Début de l'en-tête local. */
  localOffset: number;
  /** Début des données compressées. */
  dataStart: number;
  /** Fin de l'enregistrement local (descripteur de données compris). */
  recordEnd: number;
  /** Enregistrement central d'origine, recopié tel quel. */
  central: Uint8Array;
}

export interface ZipArchive {
  bytes: Uint8Array;
  /** Dans l'ordre du répertoire central. */
  entries: ZipEntry[];
  byName: Map<string, ZipEntry>;
  /** Fin du répertoire central (commentaire compris), recopiée telle quelle. */
  eocd: Uint8Array;
}

export const ZIP_LIMITS = {
  archive: 100 * 1024 * 1024,
  entries: 5000,
  entry: 40 * 1024 * 1024,
};

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** Un ancien .doc/.xls (OLE) ou un fichier protégé par mot de passe commence ainsi. */
const isOle = (bytes: Uint8Array) => bytes.length >= 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;

export function readZip(bytes: Uint8Array, limits = ZIP_LIMITS): ZipArchive {
  if (isOle(bytes)) throw new ZipError('Fichier protégé par mot de passe, ou ancien format Office (.doc, .xls) : WorkLogs ne sait pas l’ouvrir.');
  if (bytes.length > limits.archive) throw new ZipError('Archive trop volumineuse.');
  const data = view(bytes);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (data.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new ZipError('Ce fichier n’est pas une archive lisible (répertoire introuvable).');
  if (data.getUint16(end + 4, true) !== 0 || data.getUint16(end + 6, true) !== 0) throw new ZipError('Archive en plusieurs morceaux : non prise en charge.');
  const count = data.getUint16(end + 10, true);
  const directorySize = data.getUint32(end + 12, true);
  const directoryOffset = data.getUint32(end + 16, true);
  if (count === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff) throw new ZipError('Archive zip64 : non prise en charge.');
  if (count > limits.entries) throw new ZipError('Archive trop complexe (trop d’entrées).');
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  const byName = new Map<string, ZipEntry>();
  let at = directoryOffset;
  for (let index = 0; index < count; index++) {
    if (at + 46 > bytes.length || data.getUint32(at, true) !== 0x02014b50) throw new ZipError('Archive abîmée (répertoire central).');
    const flags = data.getUint16(at + 8, true);
    const method = data.getUint16(at + 10, true);
    const crc = data.getUint32(at + 16, true);
    const compressed = data.getUint32(at + 20, true);
    const size = data.getUint32(at + 24, true);
    const nameLength = data.getUint16(at + 28, true);
    const extraLength = data.getUint16(at + 30, true);
    const commentLength = data.getUint16(at + 32, true);
    const localOffset = data.getUint32(at + 42, true);
    if (flags & 1) throw new ZipError('Fichier chiffré (protégé par mot de passe) : WorkLogs ne sait pas l’ouvrir.');
    if (compressed === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new ZipError('Archive zip64 : non prise en charge.');
    const recordLength = 46 + nameLength + extraLength + commentLength;
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (byName.has(name)) throw new ZipError('Archive abîmée (entrée en double).');
    if (localOffset + 30 > bytes.length || data.getUint32(localOffset, true) !== 0x04034b50) throw new ZipError('Archive abîmée (entrée locale).');
    const dataStart = localOffset + 30 + data.getUint16(localOffset + 26, true) + data.getUint16(localOffset + 28, true);
    let recordEnd = dataStart + compressed;
    if (recordEnd > bytes.length) throw new ZipError('Archive abîmée (données tronquées).');
    if (flags & 8) {
      // Descripteur de données après les octets compressés (LibreOffice, Java…).
      recordEnd += recordEnd + 4 <= bytes.length && data.getUint32(recordEnd, true) === 0x08074b50 ? 16 : 12;
    }
    const entry: ZipEntry = {
      name, method, flags, crc, compressed, size, localOffset, dataStart, recordEnd,
      central: bytes.subarray(at, at + recordLength),
    };
    entries.push(entry);
    byName.set(name, entry);
    at += recordLength;
  }
  return { bytes, entries, byName, eocd: bytes.subarray(end) };
}

async function pipe(data: Uint8Array, transform: TransformStream<Uint8Array, Uint8Array>, limit: number): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(data); controller.close(); } });
  const reader = source.pipeThrough(transform).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    // Taille annoncée mensongère (bombe de décompression) : on coupe pendant la lecture.
    if (total > limit) { await reader.cancel(); throw new ZipError('Contenu trop volumineux.'); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

const inflate = (data: Uint8Array, limit: number) =>
  pipe(data, new DecompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>, limit);
const deflate = (data: Uint8Array) =>
  pipe(data, new CompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>, Number.MAX_SAFE_INTEGER);

export async function readZipEntry(archive: ZipArchive, entry: ZipEntry, limit = ZIP_LIMITS.entry): Promise<Uint8Array> {
  if (entry.size > limit) throw new ZipError('Contenu trop volumineux.');
  const raw = archive.bytes.subarray(entry.dataStart, entry.dataStart + entry.compressed);
  if (entry.method === 0) return raw.slice(0, limit);
  if (entry.method === 8) return inflate(raw, limit);
  throw new ZipError('Archive compressée d’une façon inconnue.');
}

export async function readZipText(archive: ZipArchive, name: string, limit = ZIP_LIMITS.entry): Promise<string | null> {
  const entry = archive.byName.get(name);
  if (!entry) return null;
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await readZipEntry(archive, entry, limit));
}

let crcTable: Uint32Array | null = null;
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Réécrit l'archive avec quelques entrées remplacées (`null` : retirée). L'ordre
 * des entrées, leurs noms, dates, champs supplémentaires et attributs sont
 * gardés ; une entrée remplacée garde sa méthode (stockée ou compressée). Aucune
 * modification : les octets d'origine.
 */
export async function writeZip(archive: ZipArchive, edits: Map<string, Uint8Array | null>): Promise<Uint8Array> {
  if (!edits.size) return archive.bytes;
  for (const name of edits.keys()) if (!archive.byName.has(name)) throw new ZipError(`Entrée absente de l’archive : ${name}.`);
  const source = archive.bytes;
  const parts: Uint8Array[] = [];
  const offsets = new Map<ZipEntry, number>();
  const replaced = new Map<ZipEntry, { crc: number; compressed: number; size: number }>();
  let position = 0;
  // Ordre physique d'origine des enregistrements locaux.
  const kept = archive.entries.filter((entry) => edits.get(entry.name) !== null);
  for (const entry of [...kept].sort((a, b) => a.localOffset - b.localOffset)) {
    offsets.set(entry, position);
    const edit = edits.get(entry.name);
    if (!edit) {
      const record = source.subarray(entry.localOffset, entry.recordEnd);
      parts.push(record);
      position += record.length;
      continue;
    }
    const body = entry.method === 0 ? edit : await deflate(edit);
    const header = source.slice(entry.localOffset, entry.dataStart);
    const headerView = view(header);
    const crc = crc32(edit);
    headerView.setUint16(6, entry.flags & ~8, true);
    headerView.setUint32(14, crc, true);
    headerView.setUint32(18, body.length, true);
    headerView.setUint32(22, edit.length, true);
    parts.push(header, body);
    position += header.length + body.length;
    replaced.set(entry, { crc, compressed: body.length, size: edit.length });
  }
  const directoryOffset = position;
  for (const entry of kept) {
    const record = entry.central.slice();
    const recordView = view(record);
    recordView.setUint32(42, offsets.get(entry)!, true);
    const change = replaced.get(entry);
    if (change) {
      recordView.setUint16(8, entry.flags & ~8, true);
      recordView.setUint32(16, change.crc, true);
      recordView.setUint32(20, change.compressed, true);
      recordView.setUint32(24, change.size, true);
    }
    parts.push(record);
    position += record.length;
  }
  const eocd = archive.eocd.slice();
  const eocdView = view(eocd);
  eocdView.setUint16(8, kept.length, true);
  eocdView.setUint16(10, kept.length, true);
  eocdView.setUint32(12, position - directoryOffset, true);
  eocdView.setUint32(16, directoryOffset, true);
  parts.push(eocd);
  position += eocd.length;
  const out = new Uint8Array(position);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
