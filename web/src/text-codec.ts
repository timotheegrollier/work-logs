import { FormatError } from './file-formats';

/**
 * Encodages des fichiers texte du partage, à l'aller comme au retour. Un CSV
 * enregistré par Excel français ou un `.txt` du Bloc-notes est souvent en
 * Windows-1252 : le réécrire en UTF-8 le ferait afficher « Ã© » sur le TSE.
 */
export type TextEncodingName = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'windows-1252';

export const ENCODING_LABELS: Record<TextEncodingName, string> = {
  'utf-8': 'UTF-8',
  'utf-8-bom': 'UTF-8 (BOM)',
  'utf-16le': 'UTF-16 LE',
  'utf-16be': 'UTF-16 BE',
  'windows-1252': 'Windows-1252',
};

export interface DecodedText {
  text: string;
  encoding: TextEncodingName;
}

const isAscii = (bytes: Uint8Array) => bytes.every((byte) => byte < 0x80);

/**
 * BOM d'abord, puis UTF-8 strict, sinon Windows-1252. Un fichier purement ASCII
 * est compatible avec tout : `legacyDefault` décide de ce qu'il deviendra si l'on
 * y tape un accent (Windows-1252 pour un CSV, comme Excel ; UTF-8 sinon).
 */
export function decodeText(bytes: Uint8Array, { legacyDefault = false } = {}): DecodedText {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8-bom' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes), encoding: 'utf-16le' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes), encoding: 'utf-16be' };
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { text, encoding: legacyDefault && isAscii(bytes) ? 'windows-1252' : 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
  }
}

let windows1252: Map<string, number> | null = null;
/** Table construite en décodant les 256 octets : l'aller-retour est exact par construction. */
function windows1252Table() {
  if (!windows1252) {
    const decoder = new TextDecoder('windows-1252');
    windows1252 = new Map();
    for (let byte = 0; byte < 256; byte++) windows1252.set(decoder.decode(new Uint8Array([byte])), byte);
  }
  return windows1252;
}

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;

function encodeUtf16(text: string, littleEndian: boolean) {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes.set(littleEndian ? [0xff, 0xfe] : [0xfe, 0xff]);
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    bytes[2 + i * 2] = littleEndian ? unit & 0xff : unit >> 8;
    bytes[3 + i * 2] = littleEndian ? unit >> 8 : unit & 0xff;
  }
  return bytes;
}

/** Encode le texte ; un caractère absent de l'encodage est refusé, nommé, jamais remplacé. */
export function encodeText(text: string, encoding: TextEncodingName): Uint8Array {
  if (encoding === 'utf-8') return new TextEncoder().encode(text);
  if (encoding === 'utf-8-bom') {
    const body = new TextEncoder().encode(text);
    const bytes = new Uint8Array(body.length + 3);
    bytes.set([0xef, 0xbb, 0xbf]);
    bytes.set(body, 3);
    return bytes;
  }
  if (encoding === 'utf-16le' || encoding === 'utf-16be') return encodeUtf16(text, encoding === 'utf-16le');
  const table = windows1252Table();
  const bytes = new Uint8Array(text.length);
  let length = 0;
  let index = 0;
  for (const char of text) {
    const byte = table.get(char);
    if (byte === undefined) {
      throw new FormatError(`Le caractère « ${char} » (ligne ${lineOf(text, index)}) n’existe pas en Windows-1252, l’encodage de ce fichier. Retire-le, ou choisis « UTF-8 (BOM) » dans Encodage.`);
    }
    bytes[length++] = byte;
    index += char.length;
  }
  return bytes.subarray(0, length);
}

/** Message d'erreur si l'encodage ne peut pas porter ce texte, sinon `null`. */
export function encodingProblem(text: string, encoding: TextEncodingName): string | null {
  if (encoding !== 'windows-1252') return null;
  try {
    encodeText(text, encoding);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}
