/**
 * Ce que WorkLogs sait afficher directement, sans dépendance supplémentaire :
 * le navigateur (ou Electron) rend déjà les images, les PDF et le texte. Le
 * classement se fait sur l'extension **et** le type MIME, car un fichier
 * déposé par glisser-déposer peut arriver sans type.
 */
export type PreviewKind = 'image' | 'pdf' | 'text' | 'docx' | 'sheet' | 'other';

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico'];
const TEXT_EXT = [
  'txt', 'md', 'markdown', 'csv', 'tsv', 'log', 'json', 'yaml', 'yml',
  'xml', 'html', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'sh', 'sql', 'ini', 'toml',
];
// Formats tableur : les octets sont binaires (zip/OpenDocument) ou très
// structurés. Les décoder demanderait une bibliothèque : on le dit franchement
// plutôt que d'afficher du charabia, et on laisse le téléchargement.
const SHEET_EXT = ['xlsx', 'xls', 'ods', 'xlsm', 'numbers'];

const extensionOf = (filename: string): string => {
  const match = /\.([^.\\/]+)$/.exec(filename.trim().toLowerCase());
  return match ? match[1] : '';
};

export function previewKind(file: { filename: string; mime?: string }): PreviewKind {
  const ext = extensionOf(file.filename);
  const mime = (file.mime || '').toLowerCase();
  if (SHEET_EXT.includes(ext) || /spreadsheet|ms-excel|opendocument\.spreadsheet/.test(mime)) return 'sheet';
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  // Word moderne seulement : l'ancien .doc est un format binaire, sans aperçu.
  if (ext === 'docx' || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (IMAGE_EXT.includes(ext) || mime.startsWith('image/')) return 'image';
  if (TEXT_EXT.includes(ext) || mime.startsWith('text/')) return 'text';
  return 'other';
}

/**
 * Ce sont bien les octets d'un PDF : l'en-tête `%PDF-` dans le premier Ko (la
 * norme tolère quelques octets avant). Même contrôle que `/api/shared/preview`.
 */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return String.fromCharCode(...bytes.subarray(0, 1024)).includes('%PDF-');
}

/**
 * Type MIME d'une image, d'après ses premiers octets (jamais son nom), ou
 * `null` : un fichier nommé « image.png » qui contient du HTML n'est pas une image.
 */
export function imageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null;
  const head = bytes.subarray(0, 16);
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) return 'image/gif';
  if (head[0] === 0x42 && head[1] === 0x4d) return 'image/bmp';
  if (head.length >= 12 && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46
    && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return 'image/webp';
  if (head.length >= 12 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70
    && head[8] === 0x61 && head[9] === 0x76 && head[10] === 0x69 && head[11] === 0x66) return 'image/avif';
  if (head[0] === 0x00 && head[1] === 0x00 && head[2] === 0x01 && head[3] === 0x00) return 'image/x-icon';
  return null;
}

/** Message affiché pour les formats qu'on ne peut pas rendre honnêtement. */
export function previewNotice(kind: PreviewKind, filename: string): string {
  if (kind === 'sheet') {
    return `« ${filename} » est un tableur : WorkLogs ne l’affiche pas lui-même. « Ouvrir avec… » le confie à ton tableur (LibreOffice, Google Sheets…), « Ouvrir dans Drive » l’affiche dans Google Drive.`;
  }
  return `L’aperçu intégré ne prend pas en charge « ${filename} ». « Ouvrir avec… » le confie à l’application qui sait le lire.`;
}
