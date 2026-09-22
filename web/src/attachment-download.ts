import { api, type Attachment } from './lib';

type DownloadableFile = Pick<Attachment, 'id' | 'filename' | 'stored'> & { driveFileId?: string | null };

/**
 * Télécharge une pièce jointe sans passer par un lien `download` direct : sur la
 * PWA, le navigateur envoie ces liens à son gestionnaire de téléchargements, qui
 * contourne le service worker — la requête tombait sur le site statique (« Fichier
 * non disponible sur le site »). Ici, `fetch` passe par le service worker (PWA) ou
 * le protocole de l'app (desktop). Binaire absent de l'appareil mais présent sur
 * Drive : il est rapatrié d'abord, puis enregistré.
 */
export async function downloadAttachment(file: DownloadableFile): Promise<void> {
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
  saveBlob(await response.blob(), file.filename);
}

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
