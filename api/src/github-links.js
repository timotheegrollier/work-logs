import { execFile as runFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GITHUB_REPO_MESSAGE, normalizeGithubRepo } from './github-repo.js';

const execute = promisify(runFile);
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_EXCERPT = 16_000;
const MAX_LISTED = 60;
const error = (status, code, message) => Object.assign(new Error(message), { status, code });
// `code` vaut aussi le code de sortie (un nombre) quand `gh` échoue.
export const isGithubError = (cause) => typeof cause?.code === 'string' && cause.code.startsWith('GITHUB_');
const invalidUrl = () => error(400, 'GITHUB_INVALID_URL', 'Saisis un lien https://github.com vers un dépôt, un dossier ou un fichier.');
const clip = (text, max) => text.length > max ? text.slice(0, max - 20) + '\n[Extrait tronqué.]' : text;
const encodePath = (value) => value.split('/').map(encodeURIComponent).join('/');

function sourceUrl(value) {
  if (typeof value !== 'string' || value.length > 2000 || /[\u0000-\u0020\u007f\\]/.test(value)) throw invalidUrl();
  let url;
  try { url = new URL(value); } catch { throw invalidUrl(); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port) throw invalidUrl();
  let parts;
  try { parts = url.pathname.replace(/\/$/, '').slice(1).split('/').map(decodeURIComponent); }
  catch { throw invalidUrl(); }
  const [owner, rawRepo, kind, ...suffix] = parts;
  const repo = rawRepo?.replace(/\.git$/, '');
  if (!/^[a-z\d](?:[a-z\d-]{0,38})$/i.test(owner ?? '') || !/^[\w.-]{1,100}$/.test(repo ?? '') || /^\.+$/.test(repo)
    || parts.some((part) => !part || part.split('/').some((segment) => !segment || segment === '.' || segment === '..')
      || /[\u0000-\u001f\u007f?#\\]/.test(part))) throw invalidUrl();
  if (kind && !['tree', 'blob'].includes(kind)) {
    throw error(400, 'GITHUB_UNSUPPORTED_URL', 'Ce lien GitHub doit désigner un dépôt, un dossier (tree) ou un fichier (blob).');
  }
  if ((kind && !suffix.length) || (kind === 'blob' && suffix.length < 2)) throw invalidUrl();
  return { url: url.href, owner, repo, kind, suffix };
}

function commandError(cause) {
  const detail = String(cause.stderr ?? cause.message ?? '');
  if (cause.code === 'ENOENT') return error(503, 'GITHUB_UNAVAILABLE', 'GitHub : GitHub CLI (gh) est nécessaire sur cet ordinateur pour lire un dépôt privé.');
  if (cause.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return error(413, 'GITHUB_TOO_LARGE', 'GitHub : cette réponse dépasse la limite de lecture.');
  if (['AbortError', 'TimeoutError'].includes(cause.name) || cause.killed || cause.code === 'ABORT_ERR') return error(504, 'GITHUB_TIMEOUT', 'GitHub : la lecture a été arrêtée ou a dépassé le délai.');
  if (/HTTP 401|gh auth login|not logged|authentication|GH_TOKEN/i.test(detail)) {
    return error(401, 'GITHUB_AUTH_REQUIRED', 'GitHub : connecte GitHub CLI sur cet ordinateur avec gh auth login pour lire les dépôts privés autorisés.');
  }
  if (/HTTP 404|Could not resolve to a (Repository|PullRequest)/i.test(detail)) {
    return error(404, 'GITHUB_NOT_FOUND', 'GitHub : dépôt ou contenu introuvable, ou inaccessible au compte connecté dans GitHub CLI.');
  }
  if (/HTTP 403/.test(detail)) return error(403, 'GITHUB_FORBIDDEN', 'GitHub : le compte connecté dans GitHub CLI ne peut pas lire ce contenu, ou sa limite de requêtes est atteinte.');
  return error(502, 'GITHUB_READ_FAILED', 'GitHub : impossible de lire ce contenu depuis cet ordinateur.');
}

function fileText(file) {
  if (!file || file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string') {
    throw error(415, 'GITHUB_UNREADABLE', 'GitHub : ce contenu ne peut pas être lu comme un fichier texte.');
  }
  if (file.size > MAX_FILE_BYTES || file.content.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 4000) {
    throw error(413, 'GITHUB_TOO_LARGE', 'GitHub : seuls les fichiers texte de 128 Kio au plus peuvent être lus.');
  }
  const bytes = Buffer.from(file.content, 'base64');
  if (bytes.length > MAX_FILE_BYTES) throw error(413, 'GITHUB_TOO_LARGE', 'GitHub : seuls les fichiers texte de 128 Kio au plus peuvent être lus.');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw error(415, 'GITHUB_UNREADABLE', 'GitHub : ce fichier doit contenir du texte UTF-8.'); }
  if (/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/.test(text)) throw error(415, 'GITHUB_UNREADABLE', 'GitHub : ce fichier contient des données binaires.');
  return text;
}

function directoryText(items, path) {
  if (!Array.isArray(items)) throw error(415, 'GITHUB_UNREADABLE', 'GitHub : ce lien ne désigne pas un dossier.');
  const listed = items.filter((item) => item && typeof item.name === 'string' && ['file', 'dir', 'symlink', 'submodule'].includes(item.type));
  const lines = listed.slice(0, MAX_LISTED).map(({ name, type }) => `${type === 'dir' ? 'Dossier' : 'Fichier'} ${JSON.stringify(clip(name, 120))}`);
  return [`Contenu de ${path || 'la racine'} (${Math.min(listed.length, MAX_LISTED)} éléments affichés sur ${listed.length} renvoyés par GitHub).`,
    ...lines, 'Cette liste présente les noms uniquement. Le contenu des fichiers listés doit être lu depuis leurs liens.'].join('\n');
}

/** Un appel à l’API GitHub par `gh`, avec l’authentification déjà présente sur cet ordinateur. */
async function ghJson(execFile, args, requestSignal, auth) {
  try {
    requestSignal.throwIfAborted();
    const { stdout } = await execFile('gh', ['api', '--hostname', 'github.com', ...args], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: MAX_OUTPUT_BYTES, signal: requestSignal, windowsHide: true,
      env: { ...process.env, ...auth, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', PAGER: 'cat' },
    });
    requestSignal.throwIfAborted();
    if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) throw error(413, 'GITHUB_TOO_LARGE', 'GitHub : cette réponse dépasse la limite de lecture.');
    return JSON.parse(stdout);
  } catch (cause) {
    if (isGithubError(cause)) throw cause;
    throw commandError(cause);
  }
}

const ghGet = (execFile, endpoint, requestSignal, auth) => ghJson(execFile, ['--method', 'GET', endpoint,
  '--header', 'Accept: application/vnd.github+json'], requestSignal, auth);

const requestSignalFor = (signal) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000));

/**
 * Lecture ciblée avec l’authentification GitHub CLI déjà présente sur cet ordinateur.
 * `auth()` donne l’environnement du compte choisi dans WorkLogs (`github-account.js`).
 */
export function createGithubReader({ execFile = execute, auth = async () => ({}) } = {}) {
  return async (value, { signal } = {}) => {
    const source = sourceUrl(value);
    const requestSignal = requestSignalFor(signal);
    const env = await auth();
    const api = (endpoint) => ghGet(execFile, endpoint, requestSignal, env);
    const base = `/repos/${source.owner}/${source.repo}`;
    const metadata = await api(base);
    const heading = `Dépôt ${source.owner}/${source.repo}${metadata.private ? ' (privé)' : ''}.`;
    let ref = metadata.default_branch;
    let path = '';
    if (source.kind) {
      const suffix = source.suffix.join('/');
      const first = source.suffix[0];
      if (first.includes('/') || /^[a-f\d]{7,40}$/i.test(first)) ref = first;
      else {
        const references = await api(`${base}/git/matching-refs/heads/${encodeURIComponent(first)}`);
        const branches = Array.isArray(references) ? references.map(({ ref }) => String(ref).replace(/^refs\/heads\//, '')) : [];
        ref = branches.filter((branch) => suffix === branch || suffix.startsWith(branch + '/')).sort((a, b) => b.length - a.length)[0];
        if (!ref) {
          const references = await api(`${base}/git/matching-refs/tags/${encodeURIComponent(first)}`);
          ref = (Array.isArray(references) ? references : []).map(({ ref }) => String(ref).replace(/^refs\/tags\//, ''))
            .filter((tag) => suffix === tag || suffix.startsWith(tag + '/')).sort((a, b) => b.length - a.length)[0];
        }
        if (!ref) throw error(404, 'GITHUB_NOT_FOUND', 'GitHub : branche ou version introuvable dans ce dépôt.');
      }
      path = suffix.slice(ref.length).replace(/^\//, '');
      if (source.kind === 'blob' && !path) throw invalidUrl();
    }
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    let text;
    if (source.kind === 'blob') {
      const content = await api(`${base}/contents/${encodePath(path)}${query}`);
      text = [heading, `Fichier ${path}, référence ${ref}.`, fileText(content)].join('\n\n');
    } else {
      const files = await api(`${base}/contents${path ? '/' + encodePath(path) : ''}${query}`);
      let readme = '';
      try {
        const content = await api(`${base}/readme${path ? '/' + encodePath(path) : ''}${query}`);
        readme = `README ${content.path || 'du dépôt'}\n${clip(fileText(content), 8000)}`;
      } catch (cause) {
        if (!['GITHUB_NOT_FOUND', 'GITHUB_UNREADABLE', 'GITHUB_TOO_LARGE'].includes(cause.code)) throw cause;
        readme = cause.code === 'GITHUB_NOT_FOUND' ? 'Aucun README trouvé dans ce dossier.' : cause.message;
      }
      text = [heading, metadata.description && `Description ${clip(String(metadata.description), 1000)}`,
        `Référence ${ref || 'par défaut'}.`, directoryText(files, path), readme].filter(Boolean).join('\n\n');
    }
    return { url: source.url, text: clip(text, MAX_EXCERPT), private: metadata.private === true };
  };
}

/** Rubriques d’un dépôt relié à un projet : 30 éléments au plus, en lecture seule. */
const LIST_SIZE = 30;
const LABELS_SIZE = 12;
const ASSIGNEES_SIZE = 8;
const REVIEWS_SIZE = 20;
const MAX_PULL_BODY = 8_000;
const text = (value, max = 300) => (typeof value === 'string' && value ? value.slice(0, max) : null);

function checkUrl(value) {
  if (typeof value !== 'string' || value.length > 1000 || !/^https?:\/\//i.test(value)
    || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.username || url.password ? null : url.href;
  } catch { return null; }
}

const webUrl = (value) => {
  const url = checkUrl(value);
  return url?.startsWith('https://github.com/') ? url : null;
};
const login = (user) => text(user?.login, 100);
const rowsOf = (body) => (Array.isArray(body) ? body : []).filter((row) => row && typeof row === 'object');
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const statusOf = (value) => text(value, 40)?.toLowerCase() ?? null;
const names = (users) => rowsOf(users).slice(0, ASSIGNEES_SIZE).map(login).filter(Boolean);

function labelsOf(labels) {
  return rowsOf(labels).slice(0, LABELS_SIZE).flatMap((label) => {
    const name = text(label.name, 100);
    const color = typeof label.color === 'string' && /^[\da-f]{6}$/i.test(label.color) ? label.color : null;
    return name ? [{ name, color }] : [];
  });
}

const ITEM_STATES = { open: 'ouverte', closed: 'fermée', merged: 'fusionnée', draft: 'brouillon',
  prerelease: 'préversion', published: 'publiée' };
const RUN_STATES = { success: 'réussie', failure: 'échouée', cancelled: 'annulée', skipped: 'ignorée', timed_out: 'expirée',
  action_required: 'action requise', neutral: 'neutre', in_progress: 'en cours', queued: 'en attente',
  waiting: 'en attente', requested: 'en attente', pending: 'en attente', stale: 'obsolète', completed: 'terminée',
  startup_failure: 'échec au démarrage' };
const runState = (status) => Object.hasOwn(RUN_STATES, status) ? RUN_STATES[status] : status;
const pullStatus = (state, draft) => state === 'open' ? (draft ? 'draft' : 'open') : (state === 'merged' ? 'merged' : 'closed');

const PULL_LIST_QUERY = `query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(first: ${LIST_SIZE}, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        id number title url state isDraft updatedAt headRefName baseRefName headRefOid
        author { login }
        labels(first: ${LABELS_SIZE}) { nodes { name color } }
        assignees(first: ${ASSIGNEES_SIZE}) { nodes { login } }
        comments(first: 1) { totalCount }
        reviewDecision mergeStateStatus changedFiles additions deletions
        statusCheckRollup { state }
      }
    }
  }
}`;

const PULL_DETAIL_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      body changedFiles
      files(first: ${LIST_SIZE}) { nodes { path changeType additions deletions } }
      reviews(last: ${REVIEWS_SIZE}) { totalCount nodes { author { login } state submittedAt url } }
      statusCheckRollup {
        contexts(first: ${LIST_SIZE}) {
          totalCount
          nodes {
            ... on CheckRun { name status conclusion url detailsUrl }
            ... on StatusContext { context state targetUrl }
          }
        }
      }
    }
  }
}`;

async function ghRepository(execFile, name, query, requestSignal, auth, number) {
  const [owner, repo] = name.split('/');
  const args = ['--method', 'POST', 'graphql', '--raw-field', `query=${query}`,
    '--raw-field', `owner=${owner}`, '--raw-field', `repo=${repo}`];
  if (number !== undefined) args.push('--field', `number=${number}`);
  const body = await ghJson(execFile, args, requestSignal, auth);
  if (!body?.data?.repository) throw error(502, 'GITHUB_READ_FAILED', 'GitHub : impossible de lire ce dépôt depuis cet ordinateur.');
  return body.data.repository;
}

function graphqlPull(pr) {
  const status = pullStatus(statusOf(pr.state), pr.isDraft);
  return { id: String(pr.id), number: pr.number ?? null, title: text(pr.title), url: webUrl(pr.url),
    state: ITEM_STATES[status], status, author: login(pr.author), date: text(pr.updatedAt, 40), ref: text(pr.headRefName, 200),
    baseRef: text(pr.baseRefName, 200), sha: text(pr.headRefOid, 64), labels: labelsOf(pr.labels?.nodes),
    assignees: names(pr.assignees?.nodes), comments: count(pr.comments?.totalCount),
    reviewDecision: statusOf(pr.reviewDecision), mergeStatus: statusOf(pr.mergeStateStatus),
    checksStatus: statusOf(pr.statusCheckRollup?.state), changedFiles: count(pr.changedFiles),
    additions: count(pr.additions), deletions: count(pr.deletions) };
}

const SECTIONS = {
  pulls: {
    path: 'pulls?state=all&sort=updated&direction=desc&per_page=30',
    rows: rowsOf,
    map: (pr) => {
      const status = pullStatus(pr.merged_at ? 'merged' : pr.state, pr.draft);
      return { id: String(pr.id), number: pr.number ?? null, title: text(pr.title), url: webUrl(pr.html_url),
        state: ITEM_STATES[status], status, author: login(pr.user), date: text(pr.updated_at, 40), ref: text(pr.head?.ref, 200),
        baseRef: text(pr.base?.ref, 200), sha: text(pr.head?.sha, 64), labels: labelsOf(pr.labels),
        assignees: names(pr.assignees), comments: count(pr.comments) };
    },
  },
  issues: {
    path: 'issues?state=all&sort=updated&direction=desc&per_page=30',
    rows: (body) => rowsOf(body).filter((issue) => !issue.pull_request),
    map: (issue) => {
      const status = issue.state === 'open' ? 'open' : 'closed';
      return { id: String(issue.id), number: issue.number ?? null, title: text(issue.title), url: webUrl(issue.html_url),
        state: ITEM_STATES[status], status, author: login(issue.user), date: text(issue.updated_at, 40), ref: null,
        labels: labelsOf(issue.labels), assignees: names(issue.assignees), comments: count(issue.comments) };
    },
  },
  actions: {
    path: 'actions/runs?per_page=30',
    rows: (body) => rowsOf(body?.workflow_runs),
    map: (run) => {
      const status = statusOf(run.conclusion) ?? statusOf(run.status);
      return { id: String(run.id), number: run.run_number ?? null, title: text(run.display_title) ?? text(run.name), url: webUrl(run.html_url),
        state: runState(status), status, author: login(run.actor), date: text(run.created_at, 40), ref: text(run.head_branch, 200),
        workflow: text(run.name), event: statusOf(run.event), sha: text(run.head_sha, 64) };
    },
  },
  commits: {
    path: 'commits?per_page=30',
    rows: rowsOf,
    map: (commit) => ({ id: String(commit.sha), number: null, title: text(String(commit.commit?.message ?? '').split('\n')[0]), url: webUrl(commit.html_url),
      state: null, author: login(commit.author) ?? text(commit.commit?.author?.name, 100), date: text(commit.commit?.author?.date, 40), ref: null,
      sha: text(commit.sha, 64) }),
  },
  releases: {
    path: 'releases?per_page=30',
    rows: rowsOf,
    map: (release) => {
      const status = release.draft ? 'draft' : release.prerelease ? 'prerelease' : 'published';
      return { id: String(release.id), number: null, title: text(release.name) ?? text(release.tag_name), url: webUrl(release.html_url),
        state: ITEM_STATES[status], status, author: login(release.author), date: text(release.published_at ?? release.created_at, 40),
        ref: text(release.tag_name, 200) };
    },
  },
};

export const GITHUB_SECTION_IDS = Object.keys(SECTIONS);

/** Lecture d’une rubrique (`pulls`, `actions`, `issues`, `commits`, `releases`) d’un dépôt relié. */
export function createGithubRepoReader({ execFile = execute, auth = async () => ({}) } = {}) {
  return async (repo, section, { signal } = {}) => {
    const spec = Object.hasOwn(SECTIONS, section) ? SECTIONS[section] : null;
    if (!spec) throw error(404, 'GITHUB_UNKNOWN_SECTION', 'GitHub : cette rubrique n’existe pas.');
    const name = normalizeGithubRepo(repo);
    if (!name) throw error(400, 'GITHUB_INVALID_REPO', GITHUB_REPO_MESSAGE);
    const requestSignal = requestSignalFor(signal);
    const env = await auth();
    if (section === 'pulls') {
      try {
        const repository = await ghRepository(execFile, name, PULL_LIST_QUERY, requestSignal, env);
        if (Array.isArray(repository.pullRequests?.nodes)) {
          return { repo: name, section, items: rowsOf(repository.pullRequests.nodes).slice(0, LIST_SIZE).map(graphqlPull) };
        }
      } catch (cause) {
        // Certains comptes accèdent au dépôt via REST même si GraphQL refuse les données enrichies.
        if (!['GITHUB_FORBIDDEN', 'GITHUB_READ_FAILED'].includes(cause.code)) throw cause;
      }
    }
    const body = await ghGet(execFile, `/repos/${name}/${spec.path}`, requestSignal, env);
    return { repo: name, section, items: spec.rows(body).slice(0, LIST_SIZE).map(spec.map) };
  };
}

/** Détail à la demande d’une PR. La requête GraphQL est fixe et ne demande aucun diff. */
export function createGithubPullReader({ execFile = execute, auth = async () => ({}) } = {}) {
  return async (repo, number, { signal } = {}) => {
    const name = normalizeGithubRepo(repo);
    if (!name) throw error(400, 'GITHUB_INVALID_REPO', GITHUB_REPO_MESSAGE);
    if (!/^[1-9]\d{0,9}$/.test(number) || Number(number) > 2_147_483_647) {
      throw error(400, 'GITHUB_INVALID_PULL', 'GitHub : le numéro de la pull request doit être un entier positif.');
    }
    const requestSignal = requestSignalFor(signal);
    const repository = await ghRepository(execFile, name, PULL_DETAIL_QUERY, requestSignal, await auth(), number);
    const pr = repository.pullRequest;
    if (!pr) throw error(404, 'GITHUB_NOT_FOUND', 'GitHub : pull request introuvable dans ce dépôt.');

    const contexts = pr.statusCheckRollup?.contexts;
    const checks = rowsOf(contexts?.nodes).slice(0, LIST_SIZE).flatMap((check) => {
      const name = text(check.name ?? check.context);
      return name ? [{ name, status: statusOf(check.conclusion ?? check.status ?? check.state),
        url: webUrl(check.url) ?? checkUrl(check.detailsUrl ?? check.targetUrl) }] : [];
    });
    const reviews = rowsOf(pr.reviews?.nodes).slice(-REVIEWS_SIZE).reverse().map((review) => ({
      author: login(review.author), state: statusOf(review.state), date: text(review.submittedAt, 40), url: webUrl(review.url),
    }));
    const files = rowsOf(pr.files?.nodes).slice(0, LIST_SIZE).flatMap((file) => {
      const path = text(file.path, 1024);
      return path ? [{ path, status: statusOf(file.changeType), additions: count(file.additions) ?? 0,
        deletions: count(file.deletions) ?? 0 }] : [];
    });
    return {
      body: typeof pr.body === 'string' && pr.body ? clip(pr.body, MAX_PULL_BODY) : null,
      checks, reviews, files, checksCount: count(contexts?.totalCount) ?? checks.length,
      reviewsCount: count(pr.reviews?.totalCount) ?? reviews.length, filesCount: count(pr.changedFiles) ?? files.length,
    };
  };
}
