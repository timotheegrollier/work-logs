import { createGithubReader } from './github-links.js';
import { localOnly } from './shared-routes.js';

export function registerGithubRoutes(app, { read = createGithubReader() } = {}) {
  app.get('/api/github/link', (req, res, next) => {
    // Même frontière locale que les fichiers d’équipe. L’authentification reste dans gh.
    localOnly(req, res, next, { error: 'GitHub : accès réservé à cet ordinateur.', code: 'GITHUB_LOCAL_ONLY' });
  }, async (req, res) => {
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnect);
    res.setHeader('Cache-Control', 'no-store');
    try {
      const source = await read(req.query.url, { signal: controller.signal });
      if (!controller.signal.aborted) res.json(source);
    } catch (cause) {
      if (!controller.signal.aborted) res.status(cause.status || 502).json({
        error: cause.code?.startsWith('GITHUB_') ? cause.message : 'GitHub : impossible de lire ce contenu.',
        code: cause.code?.startsWith('GITHUB_') ? cause.code : 'GITHUB_READ_FAILED',
      });
    } finally {
      res.off('close', disconnect);
    }
  });
}
