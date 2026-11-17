import { extensionOf, fileFamily, imageMime, looksLikePdf, previewKind } from './file-preview';
import { imageSize } from './image-size';
import { decodeText } from './text-codec';

const MIB = 1024 * 1024;
export const MAX_CHAT_ATTACHMENTS = 5;
export const MAX_CHAT_ATTACHMENT_BYTES = 10 * MIB;
export const MAX_CHAT_ATTACHMENT_TEXT = 12_000;

const MAX_IMAGE_BYTES = 5 * MIB;
const MAX_IMAGE_PIXELS = 32 * MIB;
const MAX_OFFICE_BYTES = 4 * MIB;
const MAX_TEXT_BYTES = 2 * MIB;
const MAX_URL_LENGTH = 2000;
const OFFICE_ZIP_LIMITS = { archive: MAX_OFFICE_BYTES, entries: 1000, entry: 2 * MIB, expanded: 8 * MIB };
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const UNSUPPORTED = 'Ce format ne peut pas être lu par l’assistant. Joins un PDF, un document Word (.docx), un classeur Excel (.xlsx), une image PNG, JPEG ou WebP, ou un fichier texte.';

export type ChatAttachment = { id: string; name: string; truncated?: boolean } & (
  | { kind: 'text' | 'link'; text: string; file?: never }
  | { kind: 'pdf' | 'image'; file: Blob; text?: never }
);

const attachmentId = () => crypto.randomUUID?.() ?? `attachment-${Date.now()}-${Math.random()}`;

export function chatAttachmentBytes(attachment: ChatAttachment): number {
  return attachment.file?.size ?? new TextEncoder().encode(attachment.text).length;
}

export function createChatLink(value: string): ChatAttachment {
  const text = value.trim();
  const invalid = 'Saisis une adresse web publique commençant par https:// ou http://.';
  if (text.length > MAX_URL_LENGTH || !/^https?:\/\//i.test(text) || /[\u0000-\u0020\u007f\\]/.test(text)) {
    throw new Error(invalid);
  }
  let url: URL;
  try { url = new URL(text); }
  catch { throw new Error(invalid); }
  const host = url.hostname.replace(/\.$/, '');
  // Écarte les adresses locales manifestes avant de transmettre l’adresse au fournisseur.
  if (url.username || url.password || url.href.length > MAX_URL_LENGTH
    || !host.includes('.') || /^[\d.]+$/.test(host) || /\.(?:localhost|local|internal|test|invalid|onion)$|\.home\.arpa$/.test(host)) {
    throw new Error(invalid);
  }
  return { id: attachmentId(), kind: 'link', name: url.href, text: url.href };
}

function checkSize(file: File, limit: number) {
  if (file.size > limit) throw new Error(`Ce fichier dépasse la limite de ${limit / MIB} Mio.`);
}

function textAttachment(name: string, text: string, truncated = false): ChatAttachment {
  if (!text.trim()) throw new Error('Ce fichier ne contient aucun texte lisible.');
  if (text.length > MAX_CHAT_ATTACHMENT_TEXT) {
    const omission = '\n[…]\n';
    const budget = MAX_CHAT_ATTACHMENT_TEXT - omission.length;
    const tail = Math.floor(budget / 3);
    text = text.slice(0, budget - tail) + omission + text.slice(-tail);
    truncated = true;
  }
  return { id: attachmentId(), kind: 'text', name, text, ...(truncated && { truncated: true }) };
}

async function readWord(bytes: Uint8Array): Promise<string> {
  const [{ readDocxDocument }, { docxToAi }] = await Promise.all([import('./docx'), import('./docx-markdown')]);
  const document = await readDocxDocument(bytes, OFFICE_ZIP_LIMITS);
  return docxToAi(document.doc, document).markdown;
}

async function readExcel(bytes: Uint8Array): Promise<{ text: string; truncated: boolean }> {
  const { cellRef, readXlsxWorkbook } = await import('./xlsx');
  const workbook = await readXlsxWorkbook(bytes, OFFICE_ZIP_LIMITS);
  let text = '';
  let truncated = false;
  for (const sheet of workbook.sheets) {
    if (sheet.hidden) {
      truncated ||= sheet.cells.size > 0;
      continue;
    }
    let heading = `\nFeuille « ${sheet.name} »\n`;
    for (const cell of sheet.cells.values()) {
      const value = cell.display || cell.input;
      if (!value) continue;
      const formula = cell.formula && cell.input !== value ? ` (formule ${cell.input})` : '';
      text += `${heading}${cellRef(cell.row, cell.col)} : ${JSON.stringify(value)}${formula}\n`;
      heading = '';
      if (text.length > MAX_CHAT_ATTACHMENT_TEXT) return { text, truncated: true };
    }
  }
  return { text: text.trim(), truncated };
}

export async function readChatAttachment(file: File): Promise<ChatAttachment> {
  if (!file.size) throw new Error('Ce fichier est vide.');
  checkSize(file, MAX_CHAT_ATTACHMENT_BYTES);
  const name = file.name.trim().replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200) || 'Fichier joint';
  const declared = previewKind({ filename: file.name, mime: file.type });
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());

  if (declared === 'pdf' || new TextDecoder().decode(head.subarray(0, 5)) === '%PDF-') {
    if (!looksLikePdf(head)) throw new Error('Ce fichier ne contient pas un PDF lisible.');
    return { id: attachmentId(), kind: 'pdf', name, file: file.slice(0, file.size, 'application/pdf') };
  }

  const raster = imageMime(head);
  if (raster || declared === 'image' || fileFamily(file.name) === 'image') {
    if (!raster || !IMAGE_MIMES.has(raster)) throw new Error('Joins une image PNG, JPEG ou WebP valide.');
    checkSize(file, MAX_IMAGE_BYTES);
    // Les métadonnées JPEG peuvent précéder le segment qui indique ses dimensions.
    const size = imageSize(raster === 'image/jpeg' ? new Uint8Array(await file.arrayBuffer()) : head);
    if (!size?.width || !size.height) throw new Error('Impossible de lire les dimensions de cette image.');
    if (size.width * size.height > MAX_IMAGE_PIXELS) throw new Error('La résolution de cette image dépasse 32 mégapixels.');
    return { id: attachmentId(), kind: 'image', name, file: file.slice(0, file.size, raster) };
  }

  const excel = extensionOf(file.name) === 'xlsx' || file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (declared === 'docx' || excel) {
    checkSize(file, MAX_OFFICE_BYTES);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (excel) {
      const { text, truncated } = await readExcel(bytes);
      return textAttachment(name, text, truncated);
    }
    return textAttachment(name, await readWord(bytes));
  }
  if (declared === 'sheet' || ['word', 'powerpoint', 'archive'].includes(fileFamily(file.name))) throw new Error(UNSUPPORTED);

  checkSize(file, MAX_TEXT_BYTES);
  const { text, encoding } = decodeText(new Uint8Array(await file.arrayBuffer()));
  // Le décodage de secours Windows-1252 donnerait aussi du texte pour des octets binaires.
  if (/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/.test(text) || (encoding === 'windows-1252' && declared !== 'text')) {
    throw new Error(UNSUPPORTED);
  }
  return textAttachment(name, text);
}
