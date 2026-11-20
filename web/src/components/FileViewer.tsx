import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, formatSize, type Attachment } from '../lib';
import { downloadAttachment, driveViewUrl, openAttachmentWith, readAttachmentBlob } from '../attachment-download';
import { extensionOf, previewKind, previewNotice } from '../file-preview';
import type { FileEditorHandle } from '../file-formats';
import { DocxView } from './DocxView';
import { FileIcon } from './FileIcon';
import { XlsxFileEditor } from './XlsxFileEditor';
import { ODSFileEditor } from './ODSFileEditor';
import { CsvFileEditor } from './CsvFileEditor';
import { setLeaveGuard } from '../shared-leave';

/**
 * Aperçu intégré des pièces jointes. Les classeurs s'ouvrent dans le panneau
 * Écriture et peuvent être enregistrés dans une nouvelle pièce jointe.
 *
 * Rendu par `EntryEditor` avec `key` sur la pièce jointe : un changement de
 * fichier remonte le composant, donc jamais d'aperçu périmé.
 */
export function FileViewer({ file: initialFile, onClose, onFetch, fetching, fetchError, onSaved, inlineSpreadsheet = false }: {
  file: Attachment;
  onClose: () => void;
  onFetch?: () => void;
  fetching?: boolean;
  fetchError?: string;
  onSaved?: (file: Attachment) => void;
  inlineSpreadsheet?: boolean;
}) {
  const [file, setFile] = useState(initialFile);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const kind = previewKind(file);
  const extension = extensionOf(file.filename);
  const delimited = ['csv', 'tsv'].includes(extension);
  const spreadsheet = (kind === 'sheet' && (
    ['xlsx', 'xlsm', 'ods'].includes(extension)
    || ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.oasis.opendocument.spreadsheet'].includes(file.mime ?? '')
  )) || (kind === 'text' && delimited);
  const inline = spreadsheet && inlineSpreadsheet;
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
      const format = extension === 'ods' || file.mime === 'application/vnd.oasis.opendocument.spreadsheet'
        ? 'ods'
        : delimited ? extension || 'csv' : 'xlsx';
      const stem = file.filename.replace(/\.(xlsx|xlsm|ods|csv|tsv)$/i, '').replace(/ - modifié$/i, '');
      const mime = format === 'ods' ? 'application/vnd.oasis.opendocument.spreadsheet'
        : format === 'csv' ? 'text/csv'
          : format === 'tsv' ? 'text/tab-separated-values'
            : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      const uploaded = await api.upload(new File([new Uint8Array(content)], `${stem} - modifié.${format}`, {
        type: mime,
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
    if (!dialog || inline || dialog.open) return;
    try { dialog.showModal(); }
    catch { dialog.setAttribute('open', ''); }
  }, [inline]);

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
        throw new Error(`Le tableur « ${file.filename} » contient des modifications. Reviens à WorkLogs pour enregistrer une copie modifiée.`);
      }
    });
    window.addEventListener('beforeunload', guard);
    return () => {
      unsubscribe?.();
      window.removeEventListener('beforeunload', guard);
    };
  }, [dirty, file.filename]);

  useEffect(() => {
    if (!inline || !dirty) return;
    return setLeaveGuard(async () => !editorRef.current?.isDirty()
      || confirm(`Quitter sans enregistrer la copie modifiée de « ${file.filename} » ?`));
  }, [inline, dirty, file.filename]);

  // Images et PDF sont rendus par le navigateur à partir de l’URL.
  useEffect(() => {
    if (kind !== 'text' || spreadsheet) return;
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
  }, [kind, file.stored, file.driveFileId, spreadsheet]);

  const url = api.previewUrl(file.stored);

  const onKeyDown = (event: KeyboardEvent) => {
    if (spreadsheet && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      event.stopPropagation();
      void saveWorkbook();
    }
  };
  const heading = (
      <div className="viewer-heading">
        <div className="viewer-title">
          <strong><FileIcon name={file.filename} />{file.filename}</strong>
          <small>{spreadsheet ? 'Tableur' : formatSize(file.size)}</small>
          {spreadsheet && dirty && <span className="viewer-dirty" role="status">non enregistré</span>}
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
  );
  const body = (
    <div className={'viewer-body' + (spreadsheet ? ' viewer-workbook' : '')}>
        {fetchError && <p className="error" role="alert">{fetchError}</p>}
        {notice && <p className="viewer-notice" role="status">{notice}</p>}
        {error && (kind !== 'text' || spreadsheet) && <p className="error" role="alert">{error}</p>}
        {file.driveFileId && <p className="viewer-notice">☁ Conservé sur Google Drive — l’aperçu fonctionne après récupération, même sur un autre appareil.</p>}
        {kind === 'image' && <img src={url} alt={file.filename} />}
        {kind === 'pdf' && <iframe className="viewer-frame" src={url} title={file.filename} />}
        {kind === 'docx' && <DocxView url={url} filename={file.filename} />}
        {spreadsheet && (bytes
          ? delimited
            ? <CsvFileEditor key={editorVersion} name={file.filename} bytes={bytes} initialDraft={null}
              readOnly={saving ? 'Enregistrement en cours…' : null} handleRef={editorRef} onEdit={() => {
                setDirty(true);
                setNotice('');
              }} />
            : extension === 'ods' || file.mime === 'application/vnd.oasis.opendocument.spreadsheet'
              ? <ODSFileEditor key={editorVersion} name={file.filename} bytes={bytes} initialDraft={null} sheetTabs
              readOnly={saving ? 'Enregistrement en cours…' : null} handleRef={editorRef} onEdit={() => {
                setDirty(true);
                setNotice('');
              }} />
              : <XlsxFileEditor key={editorVersion} name={file.filename} bytes={bytes} initialDraft={null} sheetTabs
              readOnly={saving ? 'Enregistrement en cours…' : null} handleRef={editorRef} onEdit={() => {
                setDirty(true);
                setNotice('');
              }} />
          : !error && <p>Lecture du classeur…</p>)}
        {kind === 'text' && !spreadsheet && (
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
  );
  return inline ? (
    <section className="workbook-panel" aria-label={`Édition de ${file.filename}`} onKeyDown={onKeyDown}>
      {heading}
      {body}
    </section>
  ) : (
    <dialog
      className={'viewer-dialog' + (spreadsheet ? ' is-workbook' : '')}
      aria-label={`Aperçu de ${file.filename}`}
      aria-modal="true"
      ref={dialogRef}
      onCancel={(event) => { event.preventDefault(); close(); }}
      onClose={onClose}
      onKeyDown={onKeyDown}
    >
      {heading}
      {body}
    </dialog>
  );
}
