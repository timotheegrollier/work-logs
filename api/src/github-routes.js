import { createGithubAccounts } from './github-account.js';
import { createGithubReader, createGithubRepoReader, isGithubError } from './github-links.js';
import { localOnly } from './shared-routes.js';

const LOCAL_ONLY = { error: 'GitHub : accès réservé à cet ordinateur.', code: 'GITHUB_LOCAL_ONLY' };

/** Répond avec la lecture GitHub, ou son erreur ; rien n’est envoyé si la requête a été interrompue. */
async function answer(req, res, task) {
  const controller = new AbortController();
  const disconnect = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', disconnect);
  res.setHeader('Cache-Control', 'no-store');
  try {
    const body = await task(controller.signal);
    if (!controller.signal.aborted) res.json(body);
  } catch (cause) {
    if (!controller.signal.aborted) res.status(cause.status || 502).json({
      error: isGithubError(cause) ? cause.message : 'GitHub : impossible de lire ce contenu.',
      code: isGithubError(cause) ? cause.code : 'GITHUB_READ_FAILED',
    });
  } finally {
    res.off('close', disconnect);
  }
}

export function registerGithubRoutes(app, {
  db, accounts = createGithubAccounts({ db }),
  read = createGithubReader({ auth: accounts.env }), list = createGithubRepoReader({ auth: accounts.env }),
} = {}) {
  // Même frontière locale que les fichiers d’équipe. L’authentification reste dans gh.
  const local = (req, res, next) => localOnly(req, res, next, LOCAL_ONLY);
  app.get('/api/github/link', local, (req, res) => answer(req, res, (signal) => read(req.query.url, { signal })));

  // Compte GitHub de WorkLogs : choisi parmi ceux de GitHub CLI, ou connecté depuis l’application.
  app.get('/api/github/accounts', local, (req, res) => answer(req, res, () => accounts.list()));
  app.put('/api/github/account', local, (req, res) => answer(req, res, () => accounts.choose(req.body?.login ?? null)));
  app.post('/api/github/login', local, (req, res) => answer(req, res, () => accounts.startLogin()));
  app.get('/api/github/login', local, (req, res) => answer(req, res, async () => accounts.loginStatus()));
  app.delete('/api/github/login', local, (req, res) => answer(req, res, async () => accounts.cancelLogin()));

  // Rubriques (pull requests, Actions, issues, commits, releases) du dépôt relié au projet.
  app.get('/api/projects/:id/github/:section', local, (req, res) => answer(req, res, async (signal) => {
    const project = db.prepare('SELECT github_repo FROM projects WHERE id=?').get(req.params.id);
    if (!project) throw Object.assign(new Error('GitHub : projet introuvable.'), { status: 404, code: 'GITHUB_PROJECT_NOT_FOUND' });
    if (!project.github_repo) {
      throw Object.assign(new Error('GitHub : ce projet n’est relié à aucun dépôt. Relie-le depuis la colonne GitHub.'), { status: 409, code: 'GITHUB_NOT_LINKED' });
    }
    return list(project.github_repo, req.params.section, { signal });
  }));
}
