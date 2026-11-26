import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { api, type GithubItem, type GithubList, type GithubSection, type Project } from '../lib';

const SECTIONS: { id: GithubSection; label: string }[] = [
  { id: 'pulls', label: 'Pull requests' },
  { id: 'actions', label: 'Actions' },
  { id: 'issues', label: 'Issues' },
  { id: 'commits', label: 'Commits' },
  { id: 'releases', label: 'Releases' },
];

const dateText = (iso: string | null) => {
  const date = iso ? new Date(iso) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString('fr-FR') : '';
};

/** Une ligne de rubrique : titre cliquable (ouvre github.com), puis état, auteur, branche et date. */
function GithubRow({ item }: { item: GithubItem }) {
  const title = item.title ?? '(sans titre)';
  const label = item.number !== null ? `#${item.number} ${title}` : title;
  const details = [item.state, item.author, item.ref, dateText(item.date)].filter(Boolean).join(' · ');
  return (
    <>
      {item.url
        ? <a href={item.url} target="_blank" rel="noreferrer" className="github-title">{label}</a>
        : <span className="github-title">{label}</span>}
      {details && <small>{details}</small>}
    </>
  );
}

/**
 * Panneau « GitHub » d'un projet (barre des projets, desktop) : relie un dépôt au projet,
 * puis affiche ses pull requests, actions, tickets, commits et versions. Lecture seule,
 * via GitHub CLI sur cet ordinateur ; chaque élément s'ouvre sur github.com.
 */
export function ProjectGithub({ project, onClose, onChanged }: {
  project: Project;
  onClose: () => void;
  /** Lien modifié : l'appelant recharge les projets. */
  onChanged: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const repo = project.github_repo ?? null;
  const [draft, setDraft] = useState(repo ?? '');
  const [section, setSection] = useState<GithubSection>('pulls');
  const [list, setList] = useState<GithubList | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }
  }, []);

  useEffect(() => {
    if (!repo) return;
    let alive = true;
    setLoading(true);
    setError('');
    setList(null);
    void api.githubList(project.id, section).then((next) => {
      if (alive) setList(next);
    }).catch((e: Error) => {
      if (alive) setError(e.message);
    }).finally(() => {
      if (alive) setLoading(false);
    });
    return () => { alive = false; };
  }, [project.id, repo, section, revision]);

  const save = async (value: string | null) => {
    setBusy(true);
    setError('');
    try {
      await api.updateProject(project.id, { github_repo: value });
      if (value === null) setDraft('');
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const link = (event: FormEvent) => {
    event.preventDefault();
    void save(draft.trim() || null);
  };

  const sectionLabel = SECTIONS.find((item) => item.id === section)?.label ?? '';

  return createPortal((
    <dialog
      className="drive-dialog files-dialog github-dialog"
      aria-label={`GitHub du projet ${project.name}`}
      aria-modal="true"
      ref={dialogRef}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
    >
      <div className="drive-dialog-heading">
        <h2>GitHub · {project.name}</h2>
        <button className="ghost" type="button" onClick={onClose}>Fermer</button>
      </div>
      <div className="drive-content files-content">
        {repo ? (
          <>
            <div className="github-head">
              <a href={`https://github.com/${repo}`} target="_blank" rel="noreferrer">{repo} ↗</a>
              <button type="button" className="ghost" disabled={loading} onClick={() => setRevision((value) => value + 1)}>Actualiser</button>
              <button type="button" className="ghost" disabled={busy} onClick={() => void save(null)}>Délier</button>
            </div>
            <div className="files-chips" role="group" aria-label="Rubriques GitHub">
              {SECTIONS.map((item) => (
                <button key={item.id} type="button" className={'chip' + (section === item.id ? ' is-on' : '')}
                  aria-pressed={section === item.id} onClick={() => setSection(item.id)}>
                  {item.label}
                </button>
              ))}
            </div>
            <section className="github-section" aria-label={`${sectionLabel} de ${repo}`} aria-busy={loading}>
              {loading && <p className="ai-hint" role="status">Chargement…</p>}
              {list && list.items.length === 0 && <p className="ai-hint">Aucun élément dans cette rubrique.</p>}
              {list && list.items.length > 0 && (
                <ul className="github-list">
                  {list.items.map((item) => <li key={item.id}><GithubRow item={item} /></li>)}
                </ul>
              )}
            </section>
          </>
        ) : (
          <form className="github-link" onSubmit={link}>
            <p className="ai-hint">
              Relie un dépôt pour voir ici ses pull requests, ses actions, ses tickets, ses commits et ses versions.
              La lecture passe par GitHub CLI sur cet ordinateur, en lecture seule.
            </p>
            <label>
              Dépôt GitHub
              <input value={draft} disabled={busy} placeholder="propriétaire/dépôt ou lien github.com"
                onChange={(event) => setDraft(event.target.value)} />
            </label>
            <button type="submit" disabled={busy || !draft.trim()}>Relier le dépôt</button>
          </form>
        )}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
    </dialog>
  ), document.body);
}
