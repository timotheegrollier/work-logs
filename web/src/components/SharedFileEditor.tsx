import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, formatSize, type SharedFile, type SharedSendResult } from '../lib';
import { Autosave } from '../autosave';
import { editorKind, MAX_EDITABLE_TEXT, type FileEditorHandle } from '../file-formats';
import { bannerFor, lockBlocks, lockMessage } from '../shared-session';
import { TextFileEditor } from './TextFileEditor';
import { CsvFileEditor } from './CsvFileEditor';

type LocalSave = 'saved' | 'dirty' | 'saving' | 'error';
const POLL_MS = 5000;

interface Loaded {
  bytes: Uint8Array;
  /** Empreinte des octets dont part l'éditeur. */
  template: string;
  draft: unknown;
  /** Change à chaque rechargement : l'éditeur repart de zéro. */
  version: number;
}

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/**
 * Un fichier du dossier partagé, ouvert dans la colonne centrale. Le brouillon
 * s'enregistre seul **sur cet ordinateur** ; il ne part sur le partage que sur
 * « Enregistrer sur le partage » (ou Ctrl+S), et jamais par-dessus une version
 * que WorkLogs n'a pas vue. Monté avec `key={path}` : rien ne fuit d'un fichier
 * à l'autre.
 */
export function SharedFileEditor({ path, onOpenPath, onChanged, onClose }: {
  path: string;
  onOpenPath: (path: string) => void;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [file, setFile] = useState<SharedFile | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copyPath, setCopyPath] = useState('');
  const [save, setSave] = useState<LocalSave>('saved');
  const [sending, setSending] = useState(false);
  const [override, setOverride] = useState(false);
  const [dirty, setDirty] = useState(false);
  const handleRef = useRef<FileEditorHandle | null>(null);
  const fileRef = useRef(file);
  fileRef.current = file;
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const dirtyRef = useRef(false);
  const sendingRef = useRef(false);
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;

  const markDirty = (value: boolean) => {
    dirtyRef.current = value;
    setDirty(value);
  };

  // Le brouillon : le modèle de l'éditeur, gardé ici, jamais envoyé seul sur le partage.
  const autosave = useMemo(() => new Autosave<() => unknown>(async (model) => {
    const current = loadedRef.current;
    if (!current) return;
    const born = !fileRef.current?.draft;
    const next = await api.saveSharedDraft(path, {
      model: model(),
      template_hash: current.template,
      base_hash: fileRef.current?.base_hash ?? current.template,
    });
    setFile((previous) => ({ ...next, lock: previous?.lock ?? next.lock }));
    // Seule la naissance du brouillon change l'arbre (pastille ✎) : pas de relecture
    // du partage à chaque pause de frappe.
    if (born) changedRef.current();
  }), [path]);
  useEffect(() => {
    autosave.onState = (state, message) => {
      setSave(state);
      if (message) setError(message);
    };
    return () => {
      autosave.onState = () => {};
      void autosave.flush().catch(() => {});
    };
  }, [autosave]);

  const load = useCallback(async (message = '') => {
    const next = await api.sharedFile(path);
    const template = next.draft?.template_hash || next.base_hash || next.hash;
    if (!template) throw new Error('Aucune version de ce fichier n’est disponible sur cet ordinateur.');
    const bytes = await api.sharedContent(template);
    setFile(next);
    setLoaded((previous) => ({ bytes, template, draft: next.draft?.model ?? null, version: (previous?.version ?? 0) + 1 }));
    markDirty(Boolean(next.draft));
    setNotice(message);
  }, [path]);

  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, [load]);

  // Sondage : le partage ne prévient pas (inotify ne voit pas le TSE).
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      if (document.visibilityState === 'hidden' || sendingRef.current) return;
      try {
        const next = await api.sharedFile(path);
        if (!alive) return;
        const current = loadedRef.current;
        const untouched = !dirtyRef.current && !next.draft && !next.state;
        // Rien de modifié ici : la version du collègue s'affiche d'elle-même.
        if (untouched && current && next.source === 'share' && next.hash && next.hash !== current.template) {
          await load('Mis à jour depuis le partage.');
          changedRef.current();
          return;
        }
        setFile(next);
      } catch {
        // Erreur passagère : le prochain passage ou le retour du focus réessaiera.
      }
    };
    const timer = setInterval(() => { void poll(); }, POLL_MS);
    const onFocus = () => { void poll(); };
    window.addEventListener('focus', onFocus);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [path, load]);

  const settle = async (result: SharedSendResult, messages: Partial<Record<string, string>> = {}) => {
    changedRef.current();
    if (result.copyPath) setCopyPath(result.copyPath);
    if (result.state === 'written' || result.state === 'theirs' || result.state === 'copied') {
      if (result.deleted) {
        if (result.copyPath) onOpenPath(result.copyPath);
        else onClose();
        return;
      }
      await load(messages[result.state] ?? '');
      return;
    }
    if (result.file) setFile((previous) => ({ ...result.file!, lock: result.lock ?? result.file!.lock ?? previous?.lock ?? null }));
  };

  const sendToShare = async () => {
    const handle = handleRef.current;
    if (!handle || sendingRef.current) return;
    setError('');
    setNotice('');
    setCopyPath('');
    if (!dirtyRef.current && !fileRef.current?.draft && !handle.isDirty()) {
      setNotice('Aucune modification à envoyer.');
      return;
    }
    const problems = handle.problems();
    if (problems.length) {
      setError(problems[0]);
      return;
    }
    sendingRef.current = true;
    setSending(true);
    try {
      await autosave.flush();
      const bytes = await handle.serialize();
      const result = await api.pushShared(path, fileRef.current?.base_hash ?? null, bytes);
      await settle(result, { written: 'Enregistré sur le partage.' });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };
  const sendRef = useRef(sendToShare);
  sendRef.current = sendToShare;

  // Ctrl+S envoie sur le partage : c'est le seul enregistrement qui compte pour l'équipe.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void sendRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const resolve = async (choice: 'mine' | 'theirs' | 'both') => {
    sendingRef.current = true;
    setSending(true);
    setError('');
    setNotice('');
    try {
      await autosave.flush();
      const result = await api.resolveShared(path, choice, fileRef.current?.theirs?.hash ?? null);
      await settle(result, {
        written: 'Ta version est sur le partage.',
        theirs: 'Leur version est affichée ; la tienne reste dans l’historique de cet ordinateur.',
        copied: 'Leur version est affichée ; la tienne est enregistrée à côté.',
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const discard = async () => {
    if (!confirm('Abandonner tes modifications de ce fichier ? Elles restent dans l’historique de cet ordinateur.')) return;
    setError('');
    try {
      await autosave.flush();
      const bytes = await handleRef.current?.serialize().catch(() => undefined);
      await api.discardSharedDraft(path, bytes);
      await load('Modifications abandonnées.');
      changedRef.current();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onEdit = useCallback(() => {
    markDirty(true);
    setNotice('');
    autosave.update(() => handleRef.current?.draft() ?? null);
  }, [autosave]);

  const name = file?.name ?? basename(path);
  const kind = file ? editorKind(file.ext) : null;
  const tooBig = Boolean(loaded && loaded.bytes.length > MAX_EDITABLE_TEXT);
  const blocked = lockBlocks(file?.lock) && !override;
  const readOnly = sending ? 'Envoi en cours…'
    : file?.state === 'conflict' ? 'Règle d’abord le conflit.'
      : blocked && file?.lock ? `${lockMessage(file.lock)}.`
        : tooBig ? 'Fichier trop volumineux pour être modifié ici (4 Mo au plus).'
          : null;
  const banner = file ? bannerFor(file, { dirty, override }) : null;
  const hasDraft = Boolean(file?.draft) || dirty;
  const status = sending ? 'Envoi…'
    : save === 'saving' ? 'Brouillon…'
      : save === 'error' ? 'Échec du brouillon'
        : save === 'dirty' ? 'Modifications en cours…'
          : hasDraft ? 'Brouillon sur cet ordinateur'
            : 'À jour avec le partage';

  const downloadUrl = useMemo(
    () => (loaded && !kind ? URL.createObjectURL(new Blob([loaded.bytes as BlobPart])) : ''),
    [loaded, kind],
  );
  useEffect(() => () => { if (downloadUrl) URL.revokeObjectURL(downloadUrl); }, [downloadUrl]);

  const deletedConflict = banner?.kind === 'conflict' && banner.deleted;

  return (
    <section className="editor shared-editor" aria-label="Fichier partagé">
      <div className="editor-bar no-print">
        <div className="shared-title">
          <span className="document-eyebrow">Dossier partagé{parentOf(path) ? ` · ${parentOf(path)}` : ''}</span>
          <h1>{name}</h1>
        </div>
        <span className={'save ' + (sending || save === 'saving' ? 'save-saving' : save === 'error' ? 'save-error' : hasDraft ? 'save-dirty' : 'save-saved')}>{status}</span>
      </div>
      <div className="editor-meta no-print">
        <button className="task-primary" disabled={sending || !kind || !loaded || file?.state === 'conflict'} onClick={() => void sendToShare()}>
          Enregistrer sur le partage
        </button>
        {hasDraft && file?.state !== 'conflict' && (
          <button className="ghost" disabled={sending} onClick={() => void discard()}>Abandonner mes modifications</button>
        )}
        <span className="grow" />
        {file?.size !== null && file?.size !== undefined && <span className="shared-meta">{formatSize(file.size)}</span>}
        <button className="ghost" onClick={onClose}>Fermer</button>
      </div>

      {banner && (
        <div className={'shared-banner no-print is-' + banner.kind} role={banner.kind === 'conflict' ? 'alert' : 'status'}>
          <p>{banner.message}</p>
          {banner.kind === 'readonly' && (
            <button className="ghost" onClick={() => setOverride(true)}>Écrire un brouillon quand même</button>
          )}
          {banner.kind === 'pending' && (
            <button className="ghost" disabled={sending} onClick={() => void sendToShare()}>Réessayer maintenant</button>
          )}
          {banner.kind === 'conflict' && (
            <div className="shared-choices">
              <button className="task-primary" disabled={sending} onClick={() => void resolve('mine')}>
                {deletedConflict ? 'Le remettre avec ma version' : 'Garder ma version'}
              </button>
              <button className="ghost" disabled={sending} onClick={() => void resolve('theirs')}>
                {deletedConflict ? 'Accepter la suppression' : 'Prendre la leur'}
              </button>
              <button className="ghost" disabled={sending} onClick={() => void resolve('both')}>
                {deletedConflict ? 'Garder ma version sous un autre nom' : 'Garder les deux'}
              </button>
            </div>
          )}
        </div>
      )}
      {copyPath && (
        <p className="shared-notice no-print" role="status">
          Ta version est enregistrée à côté :{' '}
          <button className="link-button" onClick={() => onOpenPath(copyPath)}>{basename(copyPath)}</button>
        </p>
      )}
      {notice && <p className="shared-notice no-print" role="status">{notice}</p>}
      {error && <p className="error" role="alert">{error}</p>}

      {!loaded ? (
        !error && <p className="empty">Ouverture…</p>
      ) : !kind ? (
        <div className="notice">
          <p>WorkLogs ne modifie pas encore les fichiers .{file?.ext || '?'} : les documents Word et les classeurs Excel arrivent dans les prochains lots.</p>
          <a className="ghost" href={downloadUrl} download={name}>Télécharger cette version</a>
        </div>
      ) : kind === 'csv' ? (
        <CsvFileEditor key={loaded.version} name={name} bytes={loaded.bytes} initialDraft={loaded.draft} readOnly={readOnly} onEdit={onEdit} handleRef={handleRef} />
      ) : (
        <TextFileEditor key={loaded.version} name={name} bytes={loaded.bytes} initialDraft={loaded.draft} readOnly={readOnly} onEdit={onEdit} handleRef={handleRef} markdown={kind === 'markdown'} />
      )}
    </section>
  );
}
