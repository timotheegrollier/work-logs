/**
 * Types d'image reconnus par leurs **octets d'en-tête** (pas par leur nom) :
 * c'est ce qui permet de servir un aperçu intégré sans jamais transformer du
 * HTML en image. Un fichier d'équipe est du HTML, du SVG ou un script : servi
 * depuis l'origine de l'app, il deviendrait actif. On ne sert donc que ce que
 * le navigateur affichera comme une image, jamais comme un document.
 */

/** Signature → type MIME. Les octets sont ceux du début du fichier. */
const MAGIC = [
  { mime: 'image/png', test: (bytes) => bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 },
  { mime: 'image/jpeg', test: (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  { mime: 'image/gif', test: (bytes) => bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 },
  { mime: 'image/bmp', test: (bytes) => bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d },
  { mime: 'image/webp', test: (bytes) => bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 },
  { mime: 'image/avif', test: (bytes) => bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70 && (bytes[8] === 0x61 && bytes[9] === 0x76 && bytes[10] === 0x69 && bytes[11] === 0x66) },
  { mime: 'image/x-icon', test: (bytes) => bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00 },
];

/**
 * Type MIME d'une image, d'après ses premiers octets, ou `null` : ce n'est pas
 * une image (ou c'est un format que le navigateur ne rend pas).
 */
export function imageMime(bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) return null;
  const head = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const entry of MAGIC) if (entry.test(head)) return entry.mime;
  return null;
}
