import { useEffect, useRef, useState } from 'react';
import { api, formatSize, type Attachment } from '../lib';
import { previewKind, previewNotice } from '../file-preview';

/**
 * Aperçu intégré d'une pièce jointe : image, PDF ou texte s'affichent dans un
 * dialogue au premier plan (comme « Gérer Google Drive »), le téléchargement
 * restant à un clic. Les formats qu'on ne sait pas rendre honnêtement — les
 * tableurs notamment — sont annoncés tels quels plutôt que montrés de travers.
 *
 * Le dialogue est rendu par `EntryEditor` avec `key` sur la pièce jointe : un
 * changement de fichier remonte le composant, donc jamais d'aperçu périmé.
 */
export function FileViewer({ file, onClose }: { file: Attachment; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const kind = previewKind(file);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');

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
    fetch(api.previewUrl(file.stored))
      .then((res) => {
        if (!res.ok) throw new Error('fichier introuvable');
        return res.text();
      })
      .then((body) => { if (alive) setText(body); })
      .catch((e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [kind, file.stored]);

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
          <a className="ghost" href={api.fileUrl(file.stored)} download={file.filename}>Télécharger</a>
          <button className="ghost" type="button" onClick={onClose}>Fermer</button>
        </div>
      </div>
      <div className="viewer-body">
        {kind === 'image' && <img src={url} alt={file.filename} />}
        {kind === 'pdf' && <iframe className="viewer-frame" src={url} title={file.filename} />}
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
