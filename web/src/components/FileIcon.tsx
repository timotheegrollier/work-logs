import { extensionOf, fileFamily, type FileFamily } from '../file-preview';

const LABELS: Partial<Record<FileFamily, string>> = { word: 'W', excel: 'X', powerpoint: 'P', pdf: 'PDF', image: 'IMG', archive: 'ZIP' };
// Un tableau CSV n'est pas un classeur Excel ; « markdown » ne tient pas sur la page.
const EXT_LABELS: Record<string, string> = { csv: 'CSV', tsv: 'TSV', markdown: 'MD' };

/**
 * Pictogramme du type d'un fichier — une page teintée au coin plié, le sigle du
 * format dessus — ou d'un dossier. Décoratif : le nom reste à côté, et le bouton
 * qui le porte garde son `aria-label`.
 */
export function FileIcon({ name = '', folder = false, open = false }: { name?: string; folder?: boolean; open?: boolean }) {
  if (folder) return <span className={'file-icon is-folder' + (open ? ' is-open' : '')} aria-hidden="true" />;
  const family = fileFamily(name);
  const ext = extensionOf(name);
  return (
    <span className={'file-icon is-' + family} aria-hidden="true">
      {EXT_LABELS[ext] ?? LABELS[family] ?? ext.slice(0, 3).toUpperCase()}
    </span>
  );
}
