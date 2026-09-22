import { api, type Attachment } from './lib';

type DownloadableFile = Pick<Attachment, 'id' | 'filename' | 'stored'> & { driveFileId?: string | null; mime?: string };

/** Lit le binaire sur cet appareil ; absent mais sur Drive : rapatrié d'abord. */
async function fetchAttachment(file: DownloadableFile): Promise<Response> {
  let response = await fetch(api.fileUrl(file.stored));
  if (!response.ok && file.driveFileId) {
    await api.fetchDriveAttachment(file.id);
    response = await fetch(api.fileUrl(file.stored));
  }
  if (!response.ok) {
    throw new Error(file.driveFileId
      ? `« ${file.filename} » est introuvable, même sur Google Drive.`
      : `« ${file.filename} » n’est que sur l’appareil qui l’a ajouté. Connecte Google Drive des deux côtés : il y sera envoyé et se retrouvera ici.`);
  }
  return response;
}

/**
 * Télécharge une pièce jointe sans passer par un lien `download` direct : sur la
 * PWA, le navigateur envoie ces liens à son gestionnaire de téléchargements, qui
 * contourne le service worker — la requête tombait sur le site statique (« Fichier
 * non disponible sur le site »). Ici, `fetch` passe par le service worker (PWA) ou
 * le protocole de l'app (desktop). Binaire absent de l'appareil mais présent sur
 * Drive : il est rapatrié d'abord, puis enregistré.
 */
export async function downloadAttachment(file: DownloadableFile): Promise<void> {
  saveBlob(await (await fetchAttachment(file)).blob(), file.filename);
}

/**
 * « Ouvrir avec… » : desktop, une copie en lecture seule part vers l'application du
 * système (LibreOffice…) ; téléphone, la feuille de partage propose les applications
 * installées ; ailleurs, repli sur le téléchargement. Renvoie ce qui s'est passé.
 */
export async function openAttachmentWith(file: DownloadableFile): Promise<'opened' | 'shared' | 'downloaded' | 'cancelled'> {
  const response = await fetchAttachment(file);
  const desktop = window.worklogsDesktop?.openAttachment;
  if (desktop) {
    const failure = await desktop(file.stored, file.filename);
    if (failure) throw new Error(failure);
    return 'opened';
  }
  const blob = await response.blob();
  const shared = new File([blob], file.filename, { type: file.mime || blob.type || 'application/octet-stream' });
  if (typeof navigator.share === 'function' && navigator.canShare?.({ files: [shared] })) {
    try {
      await navigator.share({ files: [shared], title: file.filename });
      return 'shared';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'cancelled';
      // Partage refusé par le système : le téléchargement reste possible.
    }
  }
  saveBlob(blob, file.filename);
  return 'downloaded';
}

/** Page Google Drive du fichier : Drive affiche tableurs, documents Office, vidéos… */
export const driveViewUrl = (driveFileId: string): string =>
  `https://drive.google.com/file/d/${encodeURIComponent(driveFileId)}/view`;

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  // Laisser au navigateur le temps de lire l'URL avant de la libérer.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
