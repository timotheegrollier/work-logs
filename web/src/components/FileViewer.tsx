import { useEffect, useRef, useState } from 'react';
import { api, formatSize, type Attachment } from '../lib';
import { downloadAttachment, driveViewUrl, openAttachmentWith } from '../attachment-download';
import { previewKind, previewNotice } from '../file-preview';
import { DocxView } from './DocxView';

/**
 * Aperçu intégré d'une pièce jointe : image, PDF ou texte s'affichent dans un
 * dialogue au premier plan (comme « Gérer Google Drive »), le téléchargement
 * restant à un clic. Les formats qu'on ne sait pas rendre honnêtement — les
 * tableurs notamment — sont annoncés tels quels plutôt que montrés de travers.
 *
 * Le dialogue est rendu par `EntryEditor` avec `key` sur la pièce jointe : un
 * changement de fichier remonte le composant, donc jamais d'aperçu périmé.
 */
export function FileViewer({ file, onClose, onFetch, fetching, fetchError }: { file: Attachment; onClose: () => void; onFetch?: () => void; fetching?: boolean; fetchError?: string }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const kind = previewKind(file);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [opening, setOpening] = useState(false);

  const openWith = async () => {
    setError('');
    setNotice('');
    setOpening(true);
    try {
      const outcome = await openAttachmentWith(file);
      if (outcome === 'opened') setNotice('Ouvert dans l’application du système, en lecture seule : « Enregistrer sous » pour garder une version modifiée, puis joins-la ici.');
      if (outcome === 'downloaded') setNotice('Fichier téléchargé : ouvre-le depuis tes téléchargements.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setOpening(false);
    }
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    try { dialog.showModal(); }
    catch { dialog.setAttribute('open', ''); }
  }, []);

  // Seul le texte a besoin d'être rapatrié : images et PDF sont rendus par le
  // navigateur à partir de l'URL, sans passer par la mémoire du renderer.
  useEffect(() => {
    if (kind !== 'text') return;
    let alive = true;
    setText(null);
    setError('');
    fetch(api.previewUrl(file.stored))
      .then((res) => {
        if (!res.ok) throw new Error(file.driveFileId ? 'fichier local absent — récupérez-le depuis Drive' : 'fichier introuvable');
        return res.text();
      })
      .then((body) => { if (alive) setText(body); })
      .catch((e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [kind, file.stored, file.driveFileId]);

  const url = api.previewUrl(file.stored);

  return (
    <dialog
      className="viewer-dialog"
      aria-label={`Aperçu de ${file.filename}`}
      aria-modal="true"
      ref={dialogRef}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClose={onClose}
    >
      <div className="viewer-heading">
        <div className="viewer-title">
          <strong>{file.filename}</strong>
          <small>{formatSize(file.size)}</small>
        </div>
        <div className="viewer-actions">
          <button className="ghost" type="button" disabled={opening} onClick={() => void openWith()}>
            {opening ? 'Ouverture…' : 'Ouvrir avec…'}
          </button>
          {file.driveFileId && (
            <a className="ghost" href={driveViewUrl(file.driveFileId)} target="_blank" rel="noopener noreferrer">Ouvrir dans Drive</a>
          )}
          {file.driveFileId && onFetch && <button className="ghost" type="button" disabled={fetching} onClick={onFetch}>{fetching ? 'Récupération…' : '⬇ Récupérer depuis Drive'}</button>}
          <a
            className="ghost"
            href={api.fileUrl(file.stored)}
            download={file.filename}
            onClick={(event) => {
              event.preventDefault();
              void downloadAttachment(file).catch((e: Error) => setError(e.message));
            }}
          >
            Télécharger
          </a>
          <button className="ghost" type="button" onClick={onClose}>Fermer</button>
        </div>
      </div>
      <div className="viewer-body">
        {fetchError && <p className="error" role="alert">{fetchError}</p>}
        {notice && <p className="viewer-notice" role="status">{notice}</p>}
        {error && kind !== 'text' && <p className="error" role="alert">{error}</p>}
        {file.driveFileId && <p className="viewer-notice">☁ Conservé sur Google Drive — l’aperçu fonctionne après récupération, même sur un autre appareil.</p>}
        {kind === 'image' && <img src={url} alt={file.filename} />}
        {kind === 'pdf' && <iframe className="viewer-frame" src={url} title={file.filename} />}
        {kind === 'docx' && <DocxView url={url} filename={file.filename} />}
        {kind === 'text' && (
          error
            ? <p role="alert">{error}</p>
            : text === null
              ? <p>Chargement…</p>
              : <pre className="viewer-text">{text}</pre>
        )}
        {(kind === 'sheet' || kind === 'other') && (
          <p className="viewer-notice">{previewNotice(kind, file.filename)}</p>
        )}
      </div>
    </dialog>
  );
}
