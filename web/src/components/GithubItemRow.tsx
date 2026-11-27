import { useEffect, useId, useState, type ReactNode } from 'react';
import { api, type GithubItem, type GithubPullDetail, type GithubSection } from '../lib';
import { GithubIcon, type GithubIconName } from './GithubIcon';

export const GITHUB_SECTIONS = {
  pulls: { label: 'Pull requests', icon: 'pull' },
  actions: { label: 'Actions', icon: 'action' },
  issues: { label: 'Issues', icon: 'issue' },
  commits: { label: 'Commits', icon: 'commit' },
  releases: { label: 'Releases', icon: 'tag' },
} satisfies Record<GithubSection, { label: string; icon: GithubIconName }>;

const STATE_LABELS: Record<string, { label: string; tone: string; icon?: GithubIconName }> = {
  open: { label: 'Ouverte', tone: 'open' },
  closed: { label: 'Fermée', tone: 'closed' },
  draft: { label: 'Brouillon', tone: 'neutral', icon: 'draft' },
  merged: { label: 'Fusionnée', tone: 'merged', icon: 'merge' },
  published: { label: 'Publiée', tone: 'success' },
  prerelease: { label: 'Préversion', tone: 'pending' },
  success: { label: 'Réussie', tone: 'success', icon: 'check' },
  failure: { label: 'Échouée', tone: 'failure', icon: 'close' },
  error: { label: 'En erreur', tone: 'failure', icon: 'close' },
  cancelled: { label: 'Annulée', tone: 'neutral', icon: 'close' },
  skipped: { label: 'Ignorée', tone: 'neutral' },
  timed_out: { label: 'Expirée', tone: 'failure', icon: 'clock' },
  stale: { label: 'Obsolète', tone: 'neutral' },
  action_required: { label: 'Action requise', tone: 'pending', icon: 'alert' },
  neutral: { label: 'Neutre', tone: 'neutral' },
  in_progress: { label: 'En cours', tone: 'pending', icon: 'clock' },
  queued: { label: 'En attente', tone: 'pending', icon: 'clock' },
  completed: { label: 'Terminée', tone: 'neutral' },
  approved: { label: 'Approuvée', tone: 'success', icon: 'check' },
  changes_requested: { label: 'Modifications demandées', tone: 'failure', icon: 'alert' },
  review_required: { label: 'Revue requise', tone: 'pending', icon: 'clock' },
  commented: { label: 'Commentaire', tone: 'neutral', icon: 'comment' },
  dismissed: { label: 'Avis écarté', tone: 'neutral' },
  dirty: { label: 'Conflits', tone: 'failure', icon: 'alert' },
  behind: { label: 'Branche en retard', tone: 'pending' },
};

const STATUS_ALIASES: Record<string, string> = {
  ouverte: 'open', fermée: 'closed', brouillon: 'draft', fusionnée: 'merged', publiée: 'published', préversion: 'prerelease',
  réussie: 'success', échouée: 'failure', annulée: 'cancelled', ignorée: 'skipped', expirée: 'timed_out',
  'action requise': 'action_required', neutre: 'neutral', 'en cours': 'in_progress', 'en attente': 'queued',
  pending: 'queued', expected: 'queued', waiting: 'queued', requested: 'queued', startup_failure: 'failure',
};

export const FILTER_STATES: Record<GithubSection, string[]> = {
  pulls: ['open', 'draft', 'merged', 'closed'],
  issues: ['open', 'closed'],
  actions: ['success', 'failure', 'in_progress', 'queued', 'cancelled', 'skipped'],
  commits: [],
  releases: ['published', 'prerelease', 'draft'],
};

const normalizedStatus = (status: string) => Object.hasOwn(STATUS_ALIASES, status) ? STATUS_ALIASES[status] : status;
const stateInfo = (status: string) => Object.hasOwn(STATE_LABELS, status) ? STATE_LABELS[status] : { label: status, tone: 'neutral' };
export const stateLabel = (status: string) => stateInfo(normalizedStatus(status)).label;
export const githubStatus = (item: GithubItem) => normalizedStatus(item.status ?? item.state ?? '');

const dateFormatter = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' });
function GithubDate({ value }: { value: string | null }) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : <time dateTime={value}>{dateFormatter.format(date)}</time>;
}

export function githubItemLabel(item: GithubItem) {
  const title = item.title ?? '(sans titre)';
  return item.number === null ? title : `#${item.number} ${title}`;
}

function StateBadge({ state, prefix }: { state: string; prefix?: string }) {
  const { label, tone, icon } = stateInfo(normalizedStatus(state));
  return (
    <span className="github-badge" data-tone={tone}>
      {icon && <GithubIcon name={icon} />}
      {prefix ? `${prefix} ${label.toLocaleLowerCase('fr-FR')}` : label}
    </span>
  );
}

function GithubStats({ additions, deletions }: { additions?: number | null; deletions?: number | null }) {
  if (additions == null && deletions == null) return null;
  return (
    <span className="github-stats">
      {additions != null && <span data-tone="open" aria-label={`${additions} ajouts`}>+{additions}</span>}
      {deletions != null && <span data-tone="closed" aria-label={`${deletions} suppressions`}>−{deletions}</span>}
    </span>
  );
}

function countLabel(shown: number, total: number) {
  return shown < total ? `${shown}/${total}` : String(total);
}

function GithubPullDetails({ projectId, number, url, id }: { projectId: string; number: number; url: string | null; id: string }) {
  const [detail, setDetail] = useState<GithubPullDetail | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api.githubPullDetail(projectId, number, controller.signal).then((next) => {
      if (!controller.signal.aborted) setDetail(next);
    }).catch((cause: Error) => {
      if (!controller.signal.aborted) setError(cause.message);
    });
    return () => controller.abort();
  }, [projectId, number, revision]);

  return (
    <div className="github-details" id={id}>
      {error ? (
        <div className="github-message">
          <p role="alert">{error}</p>
          <button type="button" className="ghost" onClick={() => { setError(''); setRevision((value) => value + 1); }}>Réessayer les détails</button>
        </div>
      ) : !detail ? <p className="github-message" role="status">Chargement des détails…</p> : (
        <>
          {detail.body && <p className="github-description">{detail.body}</p>}
          <section className="github-detail-group" aria-label="Vérifications">
            <h3>Vérifications <span>{countLabel(detail.checks.length, detail.checksCount)}</span></h3>
            {detail.checks.length ? (
              <ul className="github-detail-list">
                {detail.checks.map((check, index) => (
                  <li key={index} className="github-detail-row">
                    {check.url ? <a href={check.url} target="_blank" rel="noreferrer">{check.name}</a> : <span>{check.name}</span>}
                    {check.status && <StateBadge state={check.status} />}
                  </li>
                ))}
              </ul>
            ) : <p>Aucune vérification affichée.</p>}
            {url && detail.checksCount > detail.checks.length && <a href={`${url}/checks`} target="_blank" rel="noreferrer">Toutes les vérifications sur GitHub</a>}
          </section>
          <section className="github-detail-group" aria-label="Revues">
            <h3>Revues <span>{countLabel(detail.reviews.length, detail.reviewsCount)}</span></h3>
            {detail.reviews.length ? (
              <ul className="github-detail-list">
                {detail.reviews.map((review, index) => (
                  <li key={index} className="github-detail-row">
                    <span>
                      {review.url ? <a href={review.url} target="_blank" rel="noreferrer">{review.author ?? 'Compte GitHub'}</a> : review.author ?? 'Compte GitHub'}
                      {review.date && <> · <GithubDate value={review.date} /></>}
                    </span>
                    {review.state && <StateBadge state={review.state} />}
                  </li>
                ))}
              </ul>
            ) : <p>Aucune revue affichée.</p>}
            {url && detail.reviewsCount > detail.reviews.length && <a href={url} target="_blank" rel="noreferrer">Toutes les revues sur GitHub</a>}
          </section>
          <section className="github-detail-group" aria-label="Fichiers modifiés">
            <h3>Fichiers modifiés <span>{countLabel(detail.files.length, detail.filesCount)}</span></h3>
            {detail.files.length ? (
              <ul className="github-detail-list">
                {detail.files.map((file) => (
                  <li key={file.path} className="github-detail-row">
                    <code>{file.path}</code>
                    <GithubStats additions={file.additions} deletions={file.deletions} />
                  </li>
                ))}
              </ul>
            ) : <p>Aucun fichier modifié affiché.</p>}
            {url && <a href={`${url}/files`} target="_blank" rel="noreferrer">Voir les modifications sur GitHub</a>}
          </section>
        </>
      )}
    </div>
  );
}

export function GithubItemRow({ item, section, projectId, expanded, onToggle, children }: {
  item: GithubItem;
  section: GithubSection;
  projectId: string;
  expanded: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  const detailsId = useId();
  const [feedback, setFeedback] = useState('');
  const label = githubItemLabel(item);
  const status = githubStatus(item);
  const { tone, icon } = stateInfo(status);
  const rowIcon = section === 'pulls' && (status === 'merged' || status === 'draft') ? icon : undefined;
  const name = (
    <>
      {item.number !== null && <span className="github-number">#{item.number} </span>}
      {item.title ?? '(sans titre)'}
    </>
  );

  async function copyLink() {
    if (!item.url) return;
    try {
      await navigator.clipboard.writeText(item.url);
      setFeedback('Lien copié.');
    } catch {
      setFeedback('La copie du lien a échoué.');
    }
  }

  return (
    <li className="github-card">
      <div className="github-row-head">
        <span className="github-item-icon" data-tone={tone}><GithubIcon name={rowIcon ?? GITHUB_SECTIONS[section].icon} /></span>
        {item.url
          ? <a href={item.url} target="_blank" rel="noreferrer" className="github-title" aria-label={label}>{name}</a>
          : <span className="github-title">{name}</span>}
      </div>
      <div className="github-badges">
        {status && <StateBadge state={status} />}
        {item.checksStatus && <StateBadge state={item.checksStatus} prefix="CI" />}
        {item.reviewDecision && <StateBadge state={item.reviewDecision} />}
        {(item.mergeStatus === 'dirty' || item.mergeStatus === 'behind') && <StateBadge state={item.mergeStatus} />}
        {item.comments != null && item.comments > 0 && <span className="github-badge" title="Commentaires"><GithubIcon name="comment" />{item.comments}<span className="github-sr-only"> commentaires</span></span>}
        {item.changedFiles != null && <span className="github-badge" title="Fichiers modifiés"><GithubIcon name="file" />{item.changedFiles}<span className="github-sr-only"> fichiers modifiés</span></span>}
        <GithubStats additions={item.additions} deletions={item.deletions} />
        {item.sha && <code className="github-badge" title={item.sha}>{item.sha.slice(0, 7)}</code>}
      </div>
      {(item.author || item.date || item.workflow || item.event) && (
        <div className="github-meta">
          {item.author && <span>{item.author}</span>}
          <GithubDate value={item.date} />
          {item.workflow && item.workflow !== item.title && <span>{item.workflow}</span>}
          {item.event && <code>{item.event}</code>}
        </div>
      )}
      {(item.ref || item.baseRef) && (
        <div className="github-refs">
          <GithubIcon name={section === 'releases' ? 'tag' : 'branch'} />
          {item.ref && <code title={item.ref}>{item.ref}</code>}
          {item.ref && item.baseRef && <><GithubIcon name="arrow" /><span className="github-sr-only">vers</span></>}
          {item.baseRef && <code title={item.baseRef}>{item.baseRef}</code>}
        </div>
      )}
      {!!item.labels?.length && (
        <ul className="github-labels" aria-label="Étiquettes">
          {item.labels.map(({ name, color }) => (
            <li className="github-label" key={name} data-color={color && /^[0-9a-f]{6}$/i.test(color) ? `#${color}` : undefined}>{name}</li>
          ))}
        </ul>
      )}
      {!!item.assignees?.length && <div className="github-meta">Assignée à {item.assignees.join(', ')}</div>}
      {(children || item.url || (section === 'pulls' && item.number !== null)) && (
        <div className="github-row-actions">
          {section === 'pulls' && item.number !== null && (
            <button type="button" className="ghost" aria-label={`Détails de ${label}`} aria-expanded={expanded}
              aria-controls={expanded ? detailsId : undefined} onClick={onToggle}>
              <GithubIcon name={expanded ? 'collapse' : 'chevron'} /> Détails
            </button>
          )}
          {children}
          {item.url && (
            <button type="button" className="github-icon-button" aria-label={`Copier le lien de ${label}`} title="Copier le lien" onClick={() => void copyLink()}>
              <GithubIcon name={feedback === 'Lien copié.' ? 'check' : 'copy'} />
            </button>
          )}
        </div>
      )}
      {feedback && <p role="status" className="github-message">{feedback}</p>}
      {expanded && item.number !== null && <GithubPullDetails projectId={projectId} number={item.number} url={item.url} id={detailsId} />}
    </li>
  );
}
