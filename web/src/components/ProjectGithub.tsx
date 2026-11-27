import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type GithubAccounts, type GithubList, type GithubLogin, type GithubSection, type Project, type Task } from '../lib';

import { GithubIcon } from './GithubIcon';
import { FILTER_STATES, GITHUB_SECTIONS, GithubItemRow, githubItemLabel, githubStatus, stateLabel } from './GithubItemRow';

const SECTIONS: GithubSection[] = ['pulls', 'actions', 'issues', 'commits', 'releases'];

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

/** Refus qui tiennent souvent au compte : la colonne propose alors d'en changer ou d'en connecter un. */
const ACCOUNT_ERRORS = ['GITHUB_NOT_FOUND', 'GITHUB_FORBIDDEN', 'GITHUB_AUTH_REQUIRED'];
const LOGIN_POLL_MS = 2000;

/**
 * Compte GitHub de WorkLogs sur ce poste : un des comptes de GitHub CLI, sans changer son compte
 * actif, ou un nouveau compte connecté par code d'appareil dans le navigateur système.
 */
function GithubAccount({ onChanged }: { onChanged: () => void }) {
  const [accounts, setAccounts] = useState<GithubAccounts | null>(null);
  const [login, setLogin] = useState<GithubLogin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = login?.state === 'pending';

  useEffect(() => {
    let alive = true;
    void Promise.all([api.githubAccounts(), api.githubLogin()]).then(([nextAccounts, nextLogin]) => {
      if (!alive) return;
      setAccounts(nextAccounts);
      // Une connexion lancée avant de refermer la colonne reprend avec son code.
      if (nextLogin.state === 'pending') setLogin(nextLogin);
    }).catch((e: Error) => {
      if (alive) setError(e.message);
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!pending) return;
    let alive = true;
    const timer = setInterval(() => {
      void api.githubLogin().then(async (next) => {
        if (!alive) return;
        // Encore en cours : le code peut n'être arrivé qu'après l'ouverture du panneau.
        if (next.state === 'pending') { setLogin((shown) => (shown?.code === next.code ? shown : next)); return; }
        // Relire les comptes avant de quitter l'attente : ce sondage s'arrête avec elle.
        if (next.state === 'done') {
          const nextAccounts = await api.githubAccounts().catch(() => null);
          if (!alive) return;
          if (nextAccounts) setAccounts(nextAccounts);
          onChanged();
        }
        setLogin(next);
      }).catch(() => {});
    }, LOGIN_POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [pending, onChanged]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const choose = (value: string) => run(async () => {
    setAccounts(await api.chooseGithubAccount(value || null));
    setLogin(null);
    onChanged();
  });

  const active = accounts?.accounts.find((account) => account.active)?.login;
  const chosen = accounts?.chosen ?? null;
  return (
    <section className="github-account" aria-label="Compte GitHub">
      {accounts && (
        <label>
          Compte GitHub de WorkLogs
          <select value={chosen ?? ''} disabled={busy || pending} onChange={(event) => void choose(event.target.value)}>
            <option value="">{active ? `Compte actif de GitHub CLI (${active})` : 'Compte actif de GitHub CLI'}</option>
            {accounts.accounts.map((account) => (
              <option key={account.login} value={account.login}>{account.ok ? account.login : `${account.login} (à reconnecter)`}</option>
            ))}
            {chosen && !accounts.accounts.some((account) => account.login === chosen) && (
              <option value={chosen}>{`${chosen} (plus connecté)`}</option>
            )}
          </select>
        </label>
      )}
      {pending ? (
        <div className="github-login" role="status">
          <p>
            Connecte-toi sur github.com avec le compte à ajouter, puis saisis ce code :{' '}
            <strong className="github-code">{login.code}</strong>
          </p>
          <a href={login.url ?? 'https://github.com/login/device'} target="_blank" rel="noreferrer">Ouvrir github.com ↗</a>
          <button type="button" className="ghost" disabled={busy}
            onClick={() => void run(async () => { await api.cancelGithubLogin(); setLogin(null); })}>
            Annuler
          </button>
        </div>
      ) : (
        <button type="button" className="ghost" disabled={busy || !accounts}
          onClick={() => void run(async () => { setLogin(await api.startGithubLogin()); })}>
          Connecter un compte GitHub
        </button>
      )}
      {login?.state === 'done' && <p className="ai-hint" role="status">Compte {login.account} connecté : WorkLogs lit maintenant avec lui.</p>}
      {login?.state === 'failed' && <p className="error" role="alert">{login.error}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

/** Colonne GitHub du projet choisi, lue par GitHub CLI sur cet ordinateur. */
export function ProjectGithub({ project, tasks, onChanged, onOpenTask, onCreateTask }: {
  project: Project;
  tasks: Task[];
  onChanged: () => void;
  onOpenTask: (task: Task) => void;
  onCreateTask: (title: string, url: string | null) => Promise<void>;
}) {
  const repo = project.github_repo ?? null;
  const [draft, setDraft] = useState(repo ?? '');
  const [section, setSection] = useState<GithubSection>('pulls');
  const [list, setList] = useState<GithubList | null>(null);
  const [loading, setLoading] = useState(Boolean(repo));
  const [listError, setListError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [showAccount, setShowAccount] = useState(false);
  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [expandedPull, setExpandedPull] = useState<string | null>(null);
  const reread = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!repo) return;
    // Changer de rubrique ou fermer la colonne arrête aussi `gh` sur le serveur.
    const controller = new AbortController();
    setLoading(true);
    setListError('');
    setList(null);
    void api.githubList(project.id, section, controller.signal).then((next) => {
      if (!controller.signal.aborted) setList(next);
    }).catch((cause: Error & { code?: string }) => {
      if (controller.signal.aborted) return;
      setListError(cause.message);
      if (ACCOUNT_ERRORS.includes(cause.code ?? '')) setShowAccount(true);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [project.id, repo, section, revision]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = (value: string | null) => run(async () => {
    await api.updateProject(project.id, { github_repo: value });
    if (value === null) {
      setDraft('');
      selectSection('pulls');
      setShowAccount(false);
    }
    onChanged();
  });

  const link = (event: FormEvent) => {
    event.preventDefault();
    void save(draft.trim() || null);
  };

  function selectSection(value: GithubSection) {
    setSection(value);
    setQuery('');
    setStateFilter('');
    setExpandedPull(null);
    setError('');
  }

  // Le rapprochement historique par titre permet aussi de retrouver les tâches existantes.
  const trackedTask = (label: string) => tasks.find((task) => task.project_id === project.id && fold(task.title) === fold(label));
  const { label: sectionLabel, icon: sectionIcon } = GITHUB_SECTIONS[section];
  const items = list?.section === section ? list.items : [];
  const states = [...new Set([...FILTER_STATES[section], ...items.map(githubStatus).filter(Boolean)])];
  const terms = fold(query).split(/\s+/).filter(Boolean);
  const results = items.filter((item) => {
    if (stateFilter && githubStatus(item) !== stateFilter) return false;
    if (!terms.length) return true;
    const searchable = fold([githubItemLabel(item), item.author, item.ref, item.baseRef, item.sha, item.workflow, item.event,
      [githubStatus(item), item.checksStatus, item.reviewDecision].map((state) => stateLabel(state ?? '')).join(' '), ...(item.labels ?? []).map((value) => value.name), ...(item.assignees ?? [])]
      .filter(Boolean).join(' '));
    return terms.every((term) => searchable.includes(term));
  });
  const filtered = Boolean(terms.length || stateFilter);

  return (
    <section className="github-panel" aria-label={`GitHub du projet ${project.name}`}>
      <header className="github-head">
        <div className="github-heading">
          <span className="github-brand"><GithubIcon name="github" /></span>
          <div>
            <h2 className="github-panel-title">GitHub</h2>
            {repo && <a className="github-repo" title={repo} href={`https://github.com/${repo}`} target="_blank" rel="noreferrer">
              <span>{repo}</span><GithubIcon name="external" />
            </a>}
          </div>
        </div>
        {repo && (
          <div className="github-toolbar">
            <button type="button" className="github-icon-button" aria-label="Actualiser" title="Actualiser"
              disabled={loading} onClick={reread}><GithubIcon name="reload" /></button>
            <button type="button" className="github-icon-button" aria-label="Compte" title="Compte GitHub"
              aria-expanded={showAccount} onClick={() => setShowAccount((value) => !value)}><GithubIcon name="account" /></button>
            <button type="button" className="github-icon-button" aria-label="Délier" title="Délier le dépôt"
              disabled={busy} onClick={() => void save(null)}><GithubIcon name="unlink" /></button>
          </div>
        )}
      </header>
      {repo ? (
        <>
          {showAccount && <GithubAccount onChanged={reread} />}
          <div className="github-nav" role="group" aria-label="Rubriques GitHub">
            {SECTIONS.map((id) => {
              const { label, icon } = GITHUB_SECTIONS[id];
              return (
                <button key={id} type="button" className="github-tab" aria-label={label} title={label}
                  aria-pressed={section === id} onClick={() => { if (section !== id) selectSection(id); }}>
                  <GithubIcon name={icon} /> <span className="github-tab-label">{label}</span>
                </button>
              );
            })}
          </div>
          <section className="github-section" aria-label={`${sectionLabel} de ${repo}`}>
            <div className="github-filters">
              <label className="github-search">
                <GithubIcon name="search" />
                <input type="search" aria-label={`Rechercher dans ${sectionLabel}`} placeholder="Rechercher…"
                  value={query} onChange={(event) => setQuery(event.target.value)} />
              </label>
              {states.length > 0 && <select className="github-filter" aria-label="Filtrer par état"
                value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}>
                <option value="">Tous les états</option>
                {states.map((state) => <option key={state} value={state}>{stateLabel(state)}</option>)}
              </select>}
            </div>
            <div className="github-results">
              <span role="status">{loading ? 'Chargement…' : list && !listError ?
                `${results.length}${filtered ? `/${items.length}` : ''} résultat${results.length === 1 ? '' : 's'}` : ''}</span>
              <a className="github-external" href={`https://github.com/${repo}/${section}`} target="_blank" rel="noreferrer"
                title={`Voir ${sectionLabel} sur GitHub`} aria-label={`Voir ${sectionLabel} sur GitHub`}>
                <span>Sur GitHub</span><GithubIcon name="external" />
              </a>
            </div>
            {listError && (
              <div className="github-message">
                <p role="alert">{listError}</p>
                <button type="button" className="ghost" onClick={reread}>Réessayer</button>
              </div>
            )}
            {list && !loading && !listError && results.length === 0 && (
              <div className="github-empty">
                <GithubIcon name={filtered ? 'search' : sectionIcon} />
                <p>{filtered ? 'Aucun résultat pour ces filtres.' : 'Aucun élément dans cette rubrique.'}</p>
                {filtered && <button type="button" className="ghost" onClick={() => { setQuery(''); setStateFilter(''); }}>Effacer les filtres</button>}
              </div>
            )}
            {results.length > 0 && (
              <ul className="github-list">
                {results.map((item) => {
                  const label = githubItemLabel(item);
                  const followable = (section === 'pulls' || section === 'issues') && item.number !== null;
                  const tracked = followable ? trackedTask(label) : undefined;
                  const state = githubStatus(item);
                  return (
                    <GithubItemRow key={item.id} item={item} section={section} projectId={project.id} expanded={expandedPull === item.id}
                      onToggle={() => setExpandedPull((previous) => previous === item.id ? null : item.id)}>
                      {tracked ? (
                        <button type="button" className="ghost github-task" aria-label={`Ouvrir la tâche ${label}`}
                          onClick={() => onOpenTask(tracked)}>
                          <GithubIcon name="check" /> Ouvrir la tâche
                        </button>
                      ) : followable && (state === 'open' || state === 'draft') && (
                        <button type="button" className="ghost github-task" aria-label={`Suivre ${label} comme tâche`} disabled={busy}
                          onClick={() => void run(() => onCreateTask(label, item.url))}>
                          <GithubIcon name="plus" /> Tâche
                        </button>
                      )}
                    </GithubItemRow>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      ) : (
        <form className="github-link" onSubmit={link}>
          <p className="ai-hint">Relie un dépôt pour consulter son activité dans WorkLogs.</p>
          <label>
            Dépôt GitHub
            <input value={draft} disabled={busy} placeholder="propriétaire/dépôt ou lien github.com"
              onChange={(event) => setDraft(event.target.value)} />
          </label>
          <button type="submit" disabled={busy || !draft.trim()}>Relier le dépôt</button>
        </form>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
