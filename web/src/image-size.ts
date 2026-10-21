/**
 * Dimensions d'une image, lues dans son en-tête — **sans dépendance** et sans
 * décoder l'image entière. Word et LibreOffice les recalculent eux-mêmes ;
 * WorkLogs s'en sert pour écrire la taille d'une image insérée (`<wp:extent>`)
 * et pour annoncer la bonne hauteur dans l'éditeur.
 *
 * Formats lus : PNG, JPEG, GIF, WebP (VP8, VP8L, VP8X) et BMP. Les autres
 * (SVG, TIFF, HEIC…) sont renvoyés `null` : on ne devine pas.
 */

export interface ImageSize {
  width: number;
  height: number;
}

/** Une image PNG : la largeur et la hauteur sont dans le bloc `IHDR`. */
function pngSize(bytes: Uint8Array): ImageSize | null {
  // Signature PNG (8 octets) + longueur (4) + type « IHDR » (4) + largeur (4) + hauteur (4).
  if (bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(12) !== 0x49484452) return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Une image JPEG : les dimensions sont dans un segment `SOFn` (hors `SOF` de restarted). */
function jpegSize(bytes: Uint8Array): ImageSize | null {
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) { at++; continue; }
    const marker = bytes[at + 1];
    // Les marqueurs « tout seul » (RSTn, TEM) n'ont pas de longueur.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    if (at + 4 > bytes.length) return null;
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    // `SOF0`–`SOF15`, sauf `DHT` (c4), `JPG` (c8) et `DAC` (cc).
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (at + 9 > bytes.length) return null;
      return { height: (bytes[at + 5] << 8) | bytes[at + 6], width: (bytes[at + 7] << 8) | bytes[at + 8] };
    }
    if (length < 2) return null;
    at += 2 + length;
  }
  return null;
}

/** Une image GIF : les dimensions sont dans l'en-tête, en little-endian. */
function gifSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 10) return null;
  return { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) };
}

/** Une image WebP : trois variantes de flux (`VP8`, `VP8L`, `VP8X`). */
function webpSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 30) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  if (chunk === 'VP8 ') {
    // Flux lossy : 14 bits de largeur, 14 bits de hauteur, après la clé.
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    // Flux sans perte : 14 bits de largeur puis 14 bits de hauteur, 1 bit après.
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    // Image étendue : largeur et hauteur 24 bits, moins un.
    const width = bytes[24] | (bytes[25] << 8) | (bytes[26] << 16);
    const height = bytes[27] | (bytes[28] << 8) | (bytes[29] << 16);
    return { width: width + 1, height: height + 1 };
  }
  return null;
}

/** Une image BMP : dimensions 32 bits signées dans l'en-tête `DIB`. */
function bmpSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 26) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) };
}

/**
 * Dimensions d'une image, ou `null` si le format n'est pas connu (ou si le
 * fichier est abîmé) : on ne devine jamais une taille fausse.
 */
export function imageSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 4) return null;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (isPng) return pngSize(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes);
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return gifSize(bytes);
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return bmpSize(bytes);
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return webpSize(bytes);
  }
  return null;
}
