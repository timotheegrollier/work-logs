import { useEffect, useRef, useState } from 'react';
import { api, formatSize, type Attachment } from '../lib';
import { downloadAttachment, driveViewUrl, openAttachmentWith, readAttachmentBlob } from '../attachment-download';
import { extensionOf, previewKind, previewNotice } from '../file-preview';
import type { FileEditorHandle } from '../file-formats';
import { DocxView } from './DocxView';
import { FileIcon } from './FileIcon';
import { XlsxFileEditor } from './XlsxFileEditor';

/**
 * Aperçu intégré des pièces jointes. Les classeurs XLSX réutilisent la grille
 * du partage et peuvent être enregistrés dans une nouvelle pièce jointe.
 *
 * Le dialogue est rendu par `EntryEditor` avec `key` sur la pièce jointe : un
 * changement de fichier remonte le composant, donc jamais d'aperçu périmé.
 */
export function FileViewer({ file: initialFile, onClose, onFetch, fetching, fetchError, onSaved }: { file: Attachment; onClose: () => void; onFetch?: () => void; fetching?: boolean; fetchError?: string; onSaved?: (file: Attachment) => void }) {
  const [file, setFile] = useState(initialFile);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const kind = previewKind(file);
  const spreadsheet = kind === 'sheet' && (['xlsx', 'xlsm'].includes(extensionOf(file.filename))
    || file.mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const editorRef = useRef<FileEditorHandle | null>(null);
  const savingRef = useRef(false);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [editorVersion, setEditorVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [opening, setOpening] = useState(false);

  const close = () => {
    if (savingRef.current) return;
    if (editorRef.current?.isDirty() && !confirm(`Fermer sans enregistrer la copie modifiée de « ${file.filename} » ?`)) return;
    onClose();
  };

  const saveWorkbook = async () => {
    const editor = editorRef.current;
    if (savingRef.current) return;
    if (!editor?.isDirty()) { setDirty(false); return; }
    const problems = editor.problems();
    if (problems.length) { setError(problems.join('\n')); return; }
    savingRef.current = true;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const content = await editor.serialize();
      const stem = file.filename.replace(/\.(xlsx|xlsm)$/i, '').replace(/ - modifié$/i, '');
      const uploaded = await api.upload(new File([new Uint8Array(content)], `${stem} - modifié.xlsx`, {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }), file.entry_id);
      setFile(uploaded);
      setBytes(content);
      setEditorVersion((version) => version + 1);
      setDirty(false);
      setNotice('Copie modifiée enregistrée dans cette entrée.');
      onSaved?.(uploaded);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

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

  useEffect(() => {
    if (!spreadsheet) return;
    let alive = true;
    setBytes(null);
    setError('');
    readAttachmentBlob(file).then((blob) => blob.arrayBuffer()).then((content) => {
      if (alive) setBytes(new Uint8Array(content));
    }, (cause: Error) => { if (alive) setError(cause.message); });
    return () => { alive = false; };
  }, [spreadsheet, file]);

  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => {
      if (editorRef.current?.isDirty()) event.preventDefault();
    };
    const unsubscribe = window.worklogsDesktop?.onBeforeClose(async () => {
      if (editorRef.current?.isDirty()) {
        throw new Error(`Le classeur « ${file.filename} » contient des modifications. Reviens à WorkLogs pour enregistrer une copie modifiée.`);
      }
    });
    window.addEventListener('beforeunload', guard);
    return () => {
      unsubscribe?.();
      window.removeEventListener('beforeunload', guard);
    };
  }, [dirty, file.filename]);

  // Images et PDF sont rendus par le navigateur à partir de l’URL.
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
      onCancel={(event) => { event.preventDefault(); close(); }}
      onClose={onClose}
      onKeyDown={(event) => {
        if (spreadsheet && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          event.stopPropagation();
          void saveWorkbook();
        }
      }}
    >
      <div className="viewer-heading">
        <div className="viewer-title">
          <strong><FileIcon name={file.filename} />{file.filename}</strong>
          <small>{formatSize(file.size)}</small>
        </div>
        <div className="viewer-actions">
          {spreadsheet && <button className="task-primary" type="button" disabled={!dirty || saving} onClick={() => void saveWorkbook()}>
            {saving ? 'Enregistrement…' : 'Enregistrer une copie modifiée'}
          </button>}
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
          <button className="ghost" type="button" disabled={saving} onClick={close}>Fermer</button>
        </div>
      </div>
      <div className={'viewer-body' + (spreadsheet ? ' viewer-workbook' : '')}>
        {fetchError && <p className="error" role="alert">{fetchError}</p>}
        {notice && <p className="viewer-notice" role="status">{notice}</p>}
        {error && kind !== 'text' && <p className="error" role="alert">{error}</p>}
        {file.driveFileId && <p className="viewer-notice">☁ Conservé sur Google Drive — l’aperçu fonctionne après récupération, même sur un autre appareil.</p>}
        {kind === 'image' && <img src={url} alt={file.filename} />}
        {kind === 'pdf' && <iframe className="viewer-frame" src={url} title={file.filename} />}
        {kind === 'docx' && <DocxView url={url} filename={file.filename} />}
        {spreadsheet && (bytes
          ? <XlsxFileEditor key={editorVersion} name={file.filename} bytes={bytes} initialDraft={null}
            readOnly={saving ? 'Enregistrement en cours…' : null} handleRef={editorRef} onEdit={() => {
              setDirty(true);
              setNotice('');
            }} />
          : !error && <p>Lecture du classeur…</p>)}
        {kind === 'text' && (
          error
            ? <p role="alert">{error}</p>
            : text === null
              ? <p>Chargement…</p>
              : <pre className="viewer-text">{text}</pre>
        )}
        {((!spreadsheet && kind === 'sheet') || kind === 'other') && (
          <p className="viewer-notice">{previewNotice(kind, file.filename)}</p>
        )}
      </div>
    </dialog>
  );
}
