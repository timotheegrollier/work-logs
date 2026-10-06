import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, formatSize, type SharedFile, type SharedSendResult, type SharedVersion } from '../lib';
import { Autosave } from '../autosave';
import { editorKind, MAX_EDITABLE_TEXT, type FileEditorHandle } from '../file-formats';
import { bannerFor, idleExpired, lockBlocks, lockForgotten, lockMessage } from '../shared-session';
import { requestLeave, setLeaveGuard } from '../shared-leave';
import { TextFileEditor } from './TextFileEditor';
import { CsvFileEditor } from './CsvFileEditor';
import { DocxFileEditor } from './DocxFileEditor';
import { XlsxFileEditor } from './XlsxFileEditor';
import { officeAuthor } from '../ooxml';
import { mergeText, mergeXlsx, type MergeOutcome } from '../shared-merge';
import type { XlsxDraft } from '../xlsx';

type LocalSave = 'saved' | 'dirty' | 'saving' | 'error';
const POLL_MS = 5000;
/** Notre verrou se renouvelle chaque minute tant qu'on écrit (le serveur le rend après 3 min sans nouvelles). */
const RENEW_MS = 60_000;

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
const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (iso: string) => {
  const date = new Date(iso);
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${pad(date.getHours())}h${pad(date.getMinutes())}`;
};
const ORIGINS: Record<SharedVersion['origin'], string> = {
  base: 'Lue sur le partage', mine: 'Ta version', theirs: 'Leur version', restored: 'Restaurée', merged: 'Fusion',
};
const STATES: Record<string, string> = {
  written: 'envoyée', archived: 'mise de côté', conflict: 'conflit', pending: 'en attente', read: '',
};

/**
 * Un fichier du dossier partagé, ouvert dans la colonne centrale. Le brouillon
 * s'enregistre seul **sur cet ordinateur** ; il ne part sur le partage que sur
 * « Enregistrer sur le partage » (ou Ctrl+S), et jamais par-dessus une version
 * que WorkLogs n'a pas vue. La première frappe prend la main (notre verrou) ; elle
 * se rend à la fermeture ou après 10 min sans frappe. Monté avec `key={path}`.
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
  const [held, setHeld] = useState(false);
  const [leaving, setLeaving] = useState<((proceed: boolean) => void) | null>(null);
  const [versions, setVersions] = useState<SharedVersion[] | null>(null);
  /** Nom affiché dans les verrous : aussi le dernier auteur inscrit dans un .docx envoyé. */
  const [author, setAuthor] = useState('');
  /** Qui a enregistré la version du collègue (propriétés du document Word). */
  const [theirsAuthor, setTheirsAuthor] = useState<string | null>(null);
  /** Conflit : peut-on réunir les deux versions (et quoi), ou pourquoi pas. */
  const [mergePlan, setMergePlan] = useState<MergeOutcome | null>(null);
  const handleRef = useRef<FileEditorHandle | null>(null);
  const fileRef = useRef(file);
  fileRef.current = file;
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const overrideRef = useRef(override);
  overrideRef.current = override;
  const dirtyRef = useRef(false);
  const sendingRef = useRef(false);
  const heldRef = useRef(false);
  const acquiringRef = useRef(false);
  const lastEditRef = useRef(Date.now());
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;

  const markDirty = (value: boolean) => {
    dirtyRef.current = value;
    setDirty(value);
  };
  const markHeld = (value: boolean) => {
    heldRef.current = value;
    setHeld(value);
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
    markHeld(Boolean(next.held));
    setNotice(message);
  }, [path]);

  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, [load]);

  useEffect(() => {
    let alive = true;
    api.sharedStatus().then((status) => { if (alive) setAuthor(status.displayName ?? ''); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Conflit sur un document Word ou un classeur Excel : son dernier auteur dit qui a enregistré entre-temps.
  const theirsHash = file?.state === 'conflict' && ['docx', 'xlsx', 'xlsm'].includes(file.ext.toLowerCase()) ? file.theirs?.hash ?? null : null;
  useEffect(() => {
    setTheirsAuthor(null);
    if (!theirsHash) return;
    let alive = true;
    api.sharedContent(theirsHash).then(officeAuthor).then((name) => { if (alive) setTheirsAuthor(name); }).catch(() => {});
    return () => { alive = false; };
  }, [theirsHash]);

  // Conflit : on prépare la fusion (texte, CSV à la ligne ; classeur à la cellule) pour la proposer.
  const mergeTheirs = file?.state === 'conflict' && !file.theirs?.deleted ? file.theirs?.hash ?? null : null;
  const mergeKind = file ? editorKind(file.ext) : null;
  const mergeBase = file?.draft?.template_hash ?? file?.base_hash ?? null;
  const mergeMine = file?.send.hash ?? null;
  // Le modèle est recréé à chaque sondage : sa date suffit à savoir s'il a changé.
  const mergeDraftAt = file?.draft?.updated_at ?? null;
  useEffect(() => {
    setMergePlan(null);
    if (!mergeTheirs || !mergeKind || !mergeBase) return;
    if (mergeKind === 'docx') {
      setMergePlan({ ok: false, reason: 'Pas de fusion automatique pour un document Word : choisis une version, ou garde les deux.' });
      return;
    }
    let alive = true;
    const plan = async (): Promise<MergeOutcome> => {
      if (mergeKind === 'xlsx') {
        const [base, theirs] = await Promise.all([api.sharedContent(mergeBase), api.sharedContent(mergeTheirs)]);
        return mergeXlsx(base, theirs, (fileRef.current?.draft?.model ?? null) as XlsxDraft | null, author);
      }
      if (!mergeMine) return { ok: false, reason: 'Fusion impossible : ta version est introuvable sur cet ordinateur.' };
      const [base, mine, theirs] = await Promise.all([api.sharedContent(mergeBase), api.sharedContent(mergeMine), api.sharedContent(mergeTheirs)]);
      return mergeText(base, mine, theirs);
    };
    plan().then((result) => { if (alive) setMergePlan(result); }, () => { if (alive) setMergePlan(null); });
    return () => { alive = false; };
  }, [mergeTheirs, mergeKind, mergeBase, mergeMine, mergeDraftAt, author]);

  // ------------------------------------------------------------ notre verrou
  /** Prendre la main. Refusée : on affiche qui la tient, le texte tapé reste en brouillon. */
  const acquire = useCallback(async (takeOver = false) => {
    if (acquiringRef.current) return false;
    acquiringRef.current = true;
    try {
      const result = await api.lockShared(path, takeOver);
      if (result.ok) {
        markHeld(true);
        setFile(result.file);
        return true;
      }
      markHeld(false);
      setFile((previous) => (previous ? { ...previous, lock: result.lock, held: false } : previous));
      if (!result.lock) setError(result.error);
      return false;
    } catch {
      // Partage injoignable : on continue sans verrou ; l'envoi gardé protège quand même.
      return false;
    } finally {
      acquiringRef.current = false;
    }
  }, [path]);

  const release = useCallback(async () => {
    if (!heldRef.current) return;
    markHeld(false);
    await api.unlockShared(path).catch(() => {});
  }, [path]);

  // Renouvellement chaque minute tant qu'on écrit ; 10 min sans frappe : la main est rendue.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!heldRef.current) return;
      if (idleExpired(lastEditRef.current, Date.now())) {
        void release();
        return;
      }
      void api.lockShared(path).then((result) => {
        if (!result.ok) {
          markHeld(false);
          setFile((previous) => (previous ? { ...previous, lock: result.lock, held: false } : previous));
        }
      }).catch(() => {});
    }, RENEW_MS);
    return () => clearInterval(timer);
  }, [path, release]);

  // Quitter le fichier rend la main (le brouillon, lui, reste ici).
  useEffect(() => () => {
    if (heldRef.current) {
      heldRef.current = false;
      void api.unlockShared(path).catch(() => {});
    }
  }, [path]);

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
        // Bail expiré côté serveur (veille, coupure) : la prochaine frappe reprendra la main.
        if (heldRef.current && !next.held) markHeld(false);
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

  /** Envoi explicite. Rend l'issue (`written`, `pending`, `conflict`…), ou `null` si rien n'est parti. */
  const sendToShare = async (): Promise<string | null> => {
    const handle = handleRef.current;
    if (!handle || sendingRef.current) return null;
    setError('');
    setNotice('');
    setCopyPath('');
    if (!dirtyRef.current && !fileRef.current?.draft && !handle.isDirty()) {
      setNotice('Aucune modification à envoyer.');
      return null;
    }
    const problems = handle.problems();
    if (problems.length) {
      setError(problems[0]);
      return null;
    }
    sendingRef.current = true;
    setSending(true);
    try {
      await autosave.flush();
      const bytes = await handle.serialize();
      const result = await api.pushShared(path, fileRef.current?.base_hash ?? null, bytes);
      await settle(result, { written: 'Enregistré sur le partage.' });
      return result.state;
    } catch (e) {
      setError((e as Error).message);
      return null;
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

  // Quitter avec un brouillon non envoyé : Envoyer · Garder le brouillon ici · Annuler.
  useEffect(() => setLeaveGuard(async () => {
    await autosave.flush().catch(() => {});
    const current = fileRef.current;
    const unsent = (dirtyRef.current || Boolean(current?.draft)) && !current?.send.requested
      && !['conflict', 'pending', 'offline', 'interrupted'].includes(current?.state ?? '');
    if (!unsent) return true;
    return new Promise<boolean>((resolve) => setLeaving(() => resolve));
  }), [autosave]);

  const leaveWith = async (choice: 'send' | 'keep' | 'cancel') => {
    const answer = leaving;
    if (!answer) return;
    if (choice === 'send') {
      const outcome = await sendRef.current();
      // Conflit ou échec : on reste, pour que le choix soit fait ici.
      setLeaving(null);
      answer(outcome !== null && outcome !== 'conflict');
      return;
    }
    setLeaving(null);
    answer(choice === 'keep');
  };

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

  /** « Fusionner » : la version réunie part sur le partage, avec la leur pour base. */
  const merge = async () => {
    if (!mergePlan?.ok) return;
    sendingRef.current = true;
    setSending(true);
    setError('');
    setNotice('');
    try {
      await autosave.flush();
      const result = await api.mergeShared(path, fileRef.current?.theirs?.hash ?? null, mergePlan.bytes);
      changedRef.current();
      // Les octets fusionnés deviennent le point de départ de l'éditeur, qu'ils soient partis ou en attente.
      await load(result.state === 'written' ? `Fusionné et enregistré sur le partage — ${mergePlan.summary}` : '');
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

  const takeOver = async () => {
    const lock = fileRef.current?.lock;
    if (!lock || !confirm(`Reprendre la main sur « ${basename(path)} » ? ${lock.by} semble l’avoir laissé ouvert sans y toucher.`)) return;
    if (await acquire(true)) {
      // Un `~$` de Word resté après un plantage ne se retire pas : on écrit quand même.
      setOverride(true);
      setNotice('Tu as repris la main.');
    }
  };

  const openWith = async () => {
    const bridge = window.worklogsDesktop?.shared;
    if (!bridge) return;
    setError('');
    setNotice('');
    const failure = await bridge.openWith(path);
    if (failure) setError(failure);
    else {
      markHeld(false);
      setNotice('Ouvert dans l’application du système, sur le vrai fichier du partage. WorkLogs verra son verrou (LibreOffice) et relira le fichier dès qu’il aura changé.');
    }
  };

  const loadVersions = async () => {
    try {
      setVersions((await api.sharedVersions(path)).versions);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const restore = async (version: SharedVersion) => {
    if (!confirm(`Reprendre la version du ${stamp(version.created_at)} comme brouillon ? Rien ne part sur le partage avant ton envoi.`)) return;
    setError('');
    try {
      await autosave.flush();
      await api.restoreSharedVersion(path, version.id);
      await load(`Version du ${stamp(version.created_at)} restaurée en brouillon : envoie-la pour la remettre sur le partage.`);
      lastEditRef.current = Date.now();
      if (!heldRef.current && !overrideRef.current) void acquire();
      changedRef.current();
      void loadVersions();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onEdit = useCallback(() => {
    markDirty(true);
    setNotice('');
    lastEditRef.current = Date.now();
    autosave.update(() => handleRef.current?.draft() ?? null);
    // Première frappe : on prend la main. Refusée, l'éditeur passe en lecture seule.
    if (!heldRef.current && !overrideRef.current) void acquire();
  }, [autosave, acquire]);

  const name = file?.name ?? basename(path);
  const kind = file ? editorKind(file.ext) : null;
  // Les formats zip (Word, Excel) ont leurs propres bornes, à la lecture de l'archive.
  const tooBig = Boolean(loaded && kind !== 'docx' && kind !== 'xlsx' && loaded.bytes.length > MAX_EDITABLE_TEXT);
  const blocked = (lockBlocks(file?.lock) || (lockForgotten(file?.lock) && !held)) && !override;
  const readOnly = sending ? 'Envoi en cours…'
    : file?.state === 'conflict' ? 'Règle d’abord le conflit.'
      : blocked && file?.lock ? `${lockMessage(file.lock)}.`
        : tooBig ? 'Fichier trop volumineux pour être modifié ici (4 Mo au plus).'
          : null;
  const banner = file
    ? bannerFor(theirsAuthor && file.theirs ? { ...file, theirs: { ...file.theirs, author: theirsAuthor } } : file, { dirty, override })
    : null;
  const hasDraft = Boolean(file?.draft) || dirty;
  const status = sending ? 'Envoi…'
    : save === 'saving' ? 'Brouillon…'
      : save === 'error' ? 'Échec du brouillon'
        : save === 'dirty' ? 'Modifications en cours…'
          : hasDraft ? 'Brouillon sur cet ordinateur'
            : 'À jour avec le partage';
  const canOpenWith = Boolean(window.worklogsDesktop?.shared);

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
        {held && <span className="shared-held" title="Ton verrou est posé : LibreOffice et les autres WorkLogs voient que tu modifies ce fichier.">Tu as la main</span>}
        <span className={'save ' + (sending || save === 'saving' ? 'save-saving' : save === 'error' ? 'save-error' : hasDraft ? 'save-dirty' : 'save-saved')}>{status}</span>
      </div>
      <div className="editor-meta no-print">
        <button className="task-primary" disabled={sending || !kind || !loaded || file?.state === 'conflict'} onClick={() => void sendToShare()}>
          Enregistrer sur le partage
        </button>
        {hasDraft && file?.state !== 'conflict' && (
          <button className="ghost" disabled={sending} onClick={() => void discard()}>Abandonner mes modifications</button>
        )}
        {canOpenWith && (
          <button
            className="ghost"
            disabled={sending || (hasDraft && !file?.send.requested)}
            title={hasDraft ? 'Envoie ou abandonne d’abord ton brouillon : l’autre application ouvrirait la version du partage.' : 'Ouvrir le vrai fichier du partage dans LibreOffice ou une autre application'}
            onClick={() => void openWith()}
          >
            Ouvrir avec…
          </button>
        )}
        <span className="grow" />
        {file?.size !== null && file?.size !== undefined && <span className="shared-meta">{formatSize(file.size)}</span>}
        <button className="ghost" onClick={() => void requestLeave().then((ok) => { if (ok) onClose(); })}>Fermer</button>
      </div>

      {banner && (
        <div className={'shared-banner no-print is-' + banner.kind} role={banner.kind === 'conflict' ? 'alert' : 'status'}>
          <p>{banner.message}</p>
          {banner.kind === 'readonly' && banner.forgotten && (
            <button className="task-primary" onClick={() => void takeOver()}>Prendre la main</button>
          )}
          {banner.kind === 'readonly' && (
            <button className="ghost" onClick={() => setOverride(true)}>Écrire un brouillon quand même</button>
          )}
          {banner.kind === 'pending' && (
            <button className="ghost" disabled={sending} onClick={() => void sendToShare()}>Réessayer maintenant</button>
          )}
          {banner.kind === 'conflict' && mergePlan && (
            <p className="shared-merge-note">
              {mergePlan.ok ? `Vos modifications ne se touchent pas : « Fusionner » garde les deux (${mergePlan.summary.replace(/\.$/, '')}).` : mergePlan.reason}
            </p>
          )}
          {banner.kind === 'conflict' && (
            <div className="shared-choices">
              {mergePlan?.ok && (
                <button className="task-primary" disabled={sending} onClick={() => void merge()}>Fusionner</button>
              )}
              <button className={mergePlan?.ok ? 'ghost' : 'task-primary'} disabled={sending} onClick={() => void resolve('mine')}>
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
          <p>
            WorkLogs ne modifie pas les fichiers .{file?.ext || '?'}.
            {canOpenWith && ' « Ouvrir avec… » les ouvre dans LibreOffice, sur le vrai fichier du partage.'}
          </p>
          <a className="ghost" href={downloadUrl} download={name}>Télécharger cette version</a>
        </div>
      ) : kind === 'docx' ? (
        <DocxFileEditor key={loaded.version} name={name} bytes={loaded.bytes} initialDraft={loaded.draft} readOnly={readOnly} onEdit={onEdit} handleRef={handleRef} author={author} />
      ) : kind === 'xlsx' ? (
        <XlsxFileEditor key={loaded.version} name={name} bytes={loaded.bytes} initialDraft={loaded.draft} readOnly={readOnly} onEdit={onEdit} handleRef={handleRef} author={author} />
      ) : kind === 'csv' ? (
        <CsvFileEditor key={loaded.version} name={name} bytes={loaded.bytes} initialDraft={loaded.draft} readOnly={readOnly} onEdit={onEdit} handleRef={handleRef} />
      ) : (
        <TextFileEditor key={loaded.version} name={name} bytes={loaded.bytes} initialDraft={loaded.draft} readOnly={readOnly} onEdit={onEdit} handleRef={handleRef} markdown={kind === 'markdown'} />
      )}

      <details className="archives shared-versions no-print" onToggle={(event) => { if (event.currentTarget.open) void loadVersions(); }}>
        <summary>Historique sur cet ordinateur</summary>
        {!versions ? <p className="empty">Lecture…</p> : !versions.length ? <p className="empty">Aucune version gardée.</p> : (
          <ol className="shared-version-list">
            {versions.map((version) => (
              <li key={version.id}>
                <span>
                  <strong>{stamp(version.created_at)}</strong> · {ORIGINS[version.origin] ?? version.origin}
                  {STATES[version.state] ? ` (${STATES[version.state]})` : ''}
                  {version.author ? ` · ${version.author}` : ''} · {formatSize(version.size)}
                </span>
                <button
                  className="ghost"
                  disabled={sending || file?.state === 'conflict' || !kind}
                  aria-label={`Restaurer la version du ${stamp(version.created_at)}`}
                  onClick={() => void restore(version)}
                >
                  Restaurer
                </button>
              </li>
            ))}
          </ol>
        )}
      </details>

      {leaving && (
        <div className="shared-leave-backdrop no-print">
          <div className="shared-leave" role="dialog" aria-modal="true" aria-labelledby="shared-leave-title">
            <h2 id="shared-leave-title">Tes modifications ne sont pas sur le partage</h2>
            <p>« {name} » a un brouillon gardé sur cet ordinateur : les collègues ne le voient pas encore.</p>
            <div className="shared-choices">
              <button className="task-primary" disabled={sending} onClick={() => void leaveWith('send')}>Envoyer sur le partage</button>
              <button className="ghost" disabled={sending} onClick={() => void leaveWith('keep')}>Garder le brouillon ici</button>
              <button className="ghost" disabled={sending} onClick={() => void leaveWith('cancel')}>Annuler</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
