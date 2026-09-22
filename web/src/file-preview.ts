/**
 * Ce que WorkLogs sait afficher directement, sans dépendance supplémentaire :
 * le navigateur (ou Electron) rend déjà les images, les PDF et le texte. Le
 * classement se fait sur l'extension **et** le type MIME, car un fichier
 * déposé par glisser-déposer peut arriver sans type.
 */
export type PreviewKind = 'image' | 'pdf' | 'text' | 'sheet' | 'other';

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
  if (IMAGE_EXT.includes(ext) || mime.startsWith('image/')) return 'image';
  if (TEXT_EXT.includes(ext) || mime.startsWith('text/')) return 'text';
  return 'other';
}

/** Message affiché pour les formats qu'on ne peut pas rendre honnêtement. */
export function previewNotice(kind: PreviewKind, filename: string): string {
  if (kind === 'sheet') {
    return `« ${filename} » est un tableur : WorkLogs ne l’affiche pas lui-même. « Ouvrir avec… » le confie à ton tableur (LibreOffice, Google Sheets…), « Ouvrir dans Drive » l’affiche dans Google Drive.`;
  }
  return `L’aperçu intégré ne prend pas en charge « ${filename} ». « Ouvrir avec… » le confie à l’application qui sait le lire.`;
}
