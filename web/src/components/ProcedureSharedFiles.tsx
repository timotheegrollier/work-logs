import { useState } from 'react';
import { api, type Attachment, type Project, type SharedListing } from '../lib';
import { readAttachmentBlob } from '../attachment-download';
import { fileNameProblem } from '../new-files';
import { localDir } from '../shared-links';
import { readSharedFile } from '../shared-transfer';
import { FileIcon } from './FileIcon';

async function linkedDirectory(project: Project): Promise<string> {
  const status = await api.sharedStatus();
  if (!status.available) throw new Error('Configure le dossier partagé pour accéder au dossier lié.');
  const dir = localDir(status.address, project.shared_dir);
  if (dir === null) throw new Error('Le dossier lié à ce projet est hors du partage connecté. Vérifie le dossier partagé.');
  return dir;
}

/** Copie explicite de la pièce jointe enregistrée dans le dossier du projet. */
export function CopyAttachmentToLinkedFolder({ file, project, disabled, onCopied }: {
  file: Attachment;
  project: Project;
  disabled?: boolean;
  onCopied?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const copy = async () => {
    setBusy(true); setError(''); setMessage('');
    try {
      const problem = fileNameProblem(file.filename);
      if (problem) throw new Error(problem);
      const dir = await linkedDirectory(project);
      const path = dir ? `${dir}/${file.filename}` : file.filename;
      const bytes = new Uint8Array(await (await readAttachmentBlob(file)).arrayBuffer());
      await api.createShared(path, bytes);
      setMessage('Copié dans le dossier lié.');
      onCopied?.();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return <span className="procedure-file-transfer">
    <button className="ghost file-preview" type="button" disabled={disabled || busy}
      aria-label={`Copier ${file.filename} vers le dossier lié`} title={project.shared_dir ?? undefined}
      onClick={() => void copy()}>{busy ? 'Copie…' : '↑ Dossier lié'}</button>
    {message && <small role="status">{message}</small>}
    {error && <small className="error" role="alert">{error}</small>}
  </span>;
}

/** Parcourt le dossier lié et ses sous-dossiers pour joindre une copie locale. */
export function AttachFromLinkedFolder({ entryId, title, project, disabled, onAttached }: {
  entryId: string;
  title: string;
  project: Project;
  disabled?: boolean;
  onAttached: (attachment: Attachment) => void;
}) {
  const [open, setOpen] = useState(false);
  const [root, setRoot] = useState('');
  const [listing, setListing] = useState<SharedListing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const read = async (dir?: string) => {
    setOpen(true); setBusy(true); setError(''); setMessage(''); setListing(null);
    try {
      const base = await linkedDirectory(project);
      setRoot(base);
      const path = dir !== undefined && (dir === base || dir.startsWith(base ? base + '/' : '')) ? dir : base;
      setListing(await api.sharedList(path));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const attach = async (path: string) => {
    setBusy(true); setError(''); setMessage('');
    try {
      const base = await linkedDirectory(project);
      if (base && !path.startsWith(base + '/')) throw new Error('Ce fichier est hors du dossier lié au projet. Rouvre le dossier lié.');
      const { file, bytes } = await readSharedFile(path);
      const added = await api.upload(new File([new Uint8Array(bytes)], file.name), entryId);
      onAttached(added);
      setMessage(`« ${file.name} » joint à la procédure.`);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return <div className="procedure-linked-files">
    <button className="ghost file-preview" type="button" disabled={disabled || busy} aria-expanded={open}
      aria-label={`Joindre depuis le dossier lié à ${title}`} onClick={() => void read()}>↓ Depuis le dossier lié</button>
    {open && <section className="procedure-linked-picker" aria-label={`Fichiers du dossier lié à ${title}`}>
      <div className="procedure-linked-heading">
        <span>{listing?.dir && listing.dir !== root ? listing.dir.slice(root.length + (root ? 1 : 0)) : 'Dossier lié'}</span>
        {listing && listing.dir !== root && <button className="ghost" type="button" disabled={busy}
          onClick={() => void read(listing.dir.includes('/') ? listing.dir.slice(0, listing.dir.lastIndexOf('/')) : root)}>Dossier parent</button>}
        <button className="ghost" type="button" disabled={busy} onClick={() => setOpen(false)}>Fermer</button>
      </div>
      {busy && <p className="ai-hint" role="status">Transfert en cours…</p>}
      {listing?.offline && <p className="ai-hint">Dossier hors ligne. Les fichiers conservés sur cet appareil restent accessibles.</p>}
      {listing && <ul>
        {[...listing.entries].sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name, 'fr')).map((item) => <li key={item.path}>
          <button className="ghost" type="button" disabled={busy || item.unavailable}
            aria-label={item.type === 'dir' ? `Ouvrir le dossier ${item.name}` : `Joindre ${item.name} à ${title}`}
            onClick={() => { if (item.type === 'dir') void read(item.path); else void attach(item.path); }}>
            <FileIcon name={item.name} folder={item.type === 'dir'} />{item.name}
          </button>
        </li>)}
      </ul>}
      {listing && !listing.entries.length && <p className="empty">Ce dossier est vide.</p>}
      {listing?.truncated && <p className="ai-hint">Liste partielle. Ouvre un sous-dossier pour retrouver le fichier.</p>}
      {message && <p className="task-message" role="status">{message}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>}
  </div>;
}
