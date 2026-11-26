import { createGithubReader, createGithubRepoReader } from './github-links.js';
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
      error: cause.code?.startsWith('GITHUB_') ? cause.message : 'GitHub : impossible de lire ce contenu.',
      code: cause.code?.startsWith('GITHUB_') ? cause.code : 'GITHUB_READ_FAILED',
    });
  } finally {
    res.off('close', disconnect);
  }
}

export function registerGithubRoutes(app, { db, read = createGithubReader(), list = createGithubRepoReader() } = {}) {
  app.get('/api/github/link', (req, res, next) => {
    // Même frontière locale que les fichiers d’équipe. L’authentification reste dans gh.
    localOnly(req, res, next, LOCAL_ONLY);
  }, (req, res) => answer(req, res, (signal) => read(req.query.url, { signal })));

  // Rubriques (pull requests, Actions, issues, commits, releases) du dépôt relié au projet.
  app.get('/api/projects/:id/github/:section', (req, res, next) => {
    localOnly(req, res, next, LOCAL_ONLY);
  }, (req, res) => answer(req, res, async (signal) => {
    const project = db.prepare('SELECT github_repo FROM projects WHERE id=?').get(req.params.id);
    if (!project) throw Object.assign(new Error('GitHub : projet introuvable.'), { status: 404, code: 'GITHUB_PROJECT_NOT_FOUND' });
    if (!project.github_repo) {
      throw Object.assign(new Error('GitHub : ce projet n’est relié à aucun dépôt. Relie-le depuis la gestion des projets.'), { status: 409, code: 'GITHUB_NOT_LINKED' });
    }
    return list(project.github_repo, req.params.section, { signal });
  }));
}
