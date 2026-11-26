import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type GithubAccounts, type GithubItem, type GithubList, type GithubLogin, type GithubSection, type Project, type Task } from '../lib';

const SECTIONS: { id: GithubSection; label: string }[] = [
  { id: 'pulls', label: 'Pull requests' },
  { id: 'actions', label: 'Actions' },
  { id: 'issues', label: 'Issues' },
  { id: 'commits', label: 'Commits' },
  { id: 'releases', label: 'Releases' },
];

/** Rubriques dont un élément ouvert se suit comme tâche : il reste du travail à faire dessus. */
const TRACKABLE: GithubSection[] = ['pulls', 'issues'];
const OPEN_STATES = ['ouverte', 'brouillon'];

const dateText = (iso: string | null) => {
  const date = iso ? new Date(iso) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString('fr-FR') : '';
};

const itemLabel = (item: GithubItem) => {
  const title = item.title ?? '(sans titre)';
  return item.number !== null ? `#${item.number} ${title}` : title;
};

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

/** Une ligne de rubrique : titre cliquable (ouvre github.com), puis état, auteur, branche et date. */
function GithubRow({ item }: { item: GithubItem }) {
  const label = itemLabel(item);
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
 * Colonne « GitHub » du projet choisi (desktop) : relie un dépôt au projet, puis affiche ses
 * pull requests, actions, tickets, commits et versions. Lecture seule, via GitHub CLI sur cet
 * ordinateur ; chaque élément s'ouvre sur github.com, et une PR ou une issue se suit comme tâche.
 */
export function ProjectGithub({ project, tasks, onChanged, onOpenTask, onCreateTask }: {
  project: Project;
  /** Tâches de l'état : une PR ou une issue déjà suivie ouvre sa tâche au lieu d'en créer une. */
  tasks: Task[];
  /** Lien modifié : l'appelant recharge les projets. */
  onChanged: () => void;
  onOpenTask: (task: Task) => void;
  /** Crée la tâche `title` dans le projet, sa note portant le lien, puis l'ouvre. */
  onCreateTask: (title: string, url: string | null) => Promise<void>;
}) {
  const repo = project.github_repo ?? null;
  const [draft, setDraft] = useState(repo ?? '');
  const [section, setSection] = useState<GithubSection>('pulls');
  const [list, setList] = useState<GithubList | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [showAccount, setShowAccount] = useState(false);
  const reread = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!repo) return;
    let alive = true;
    // Changer de rubrique ou fermer la colonne arrête aussi `gh` sur le serveur.
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setList(null);
    void api.githubList(project.id, section, controller.signal).then((next) => {
      if (alive) setList(next);
    }).catch((e: Error & { code?: string }) => {
      if (!alive) return;
      setError(e.message);
      if (ACCOUNT_ERRORS.includes(e.code ?? '')) setShowAccount(true);
    }).finally(() => {
      if (alive) setLoading(false);
    });
    return () => { alive = false; controller.abort(); };
  }, [project.id, repo, section, revision]);

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

  const save = (value: string | null) => run(async () => {
    await api.updateProject(project.id, { github_repo: value });
    if (value === null) setDraft('');
    onChanged();
  });

  const link = (event: FormEvent) => {
    event.preventDefault();
    void save(draft.trim() || null);
  };

  // shortcut: rapprochement par titre dans l'état filtré (recherche, catégorie) ; une tâche renommée
  // ou masquée laisse en recréer une. Passer à l'URL de la note si ça gêne.
  const trackedTask = (label: string) => tasks.find((task) => task.project_id === project.id && fold(task.title) === fold(label));

  const sectionLabel = SECTIONS.find((item) => item.id === section)?.label ?? '';

  return (
    <section className="github-panel" aria-label={`GitHub du projet ${project.name}`}>
      <h2 className="github-panel-title">GitHub · {project.name}</h2>
      {repo ? (
        <>
          <div className="github-head">
            <a href={`https://github.com/${repo}`} target="_blank" rel="noreferrer">{repo} ↗</a>
            <button type="button" className="ghost" disabled={loading} onClick={reread}>Actualiser</button>
            <button type="button" className="ghost" aria-expanded={showAccount} onClick={() => setShowAccount((value) => !value)}>Compte</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => void save(null)}>Délier</button>
          </div>
          {showAccount && <GithubAccount onChanged={reread} />}
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
                {list.items.map((item) => {
                  const label = itemLabel(item);
                  const followable = TRACKABLE.includes(list.section) && item.number !== null;
                  const tracked = followable ? trackedTask(label) : undefined;
                  return (
                    <li key={item.id}>
                      <GithubRow item={item} />
                      {tracked && (
                        <button type="button" className="ghost github-task" aria-label={`Ouvrir la tâche ${label}`}
                          onClick={() => onOpenTask(tracked)}>
                          Ouvrir la tâche
                        </button>
                      )}
                      {followable && !tracked && OPEN_STATES.includes(item.state ?? '') && (
                        <button type="button" className="ghost github-task" aria-label={`Suivre ${label} comme tâche`} disabled={busy}
                          onClick={() => void run(() => onCreateTask(label, item.url))}>
                          ＋ Tâche
                        </button>
                      )}
                    </li>
                  );
                })}
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
    </section>
  );
}
