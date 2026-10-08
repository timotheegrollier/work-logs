import express from 'express';
import { SharedError, toSharedError } from './shared-service.js';
import { inlineHeader } from './disposition.js';

/**
 * Routes du dossier partagé (`/api/shared`). Elles exposent des fichiers
 * d'équipe : **réservées à cet ordinateur**, quel que soit l'hôte d'écoute du
 * serveur (l'API de dev écoute sur toutes les interfaces). Le chemin du partage
 * ne se règle jamais ici : seulement par le dialogue natif du desktop ou par
 * `WORKLOGS_SHARED_ROOT`.
 */

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function localOnly(req, res, next) {
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1');
  const hostIsLocal = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host.endsWith('.localhost');
  if (!LOOPBACK.has(req.socket.remoteAddress) || !hostIsLocal || req.headers['sec-fetch-site'] === 'cross-site') {
    return res.status(403).json({ error: 'Dossier partagé : accès réservé à cet ordinateur.', code: 'SHARED_LOCAL_ONLY' });
  }
  next();
}

const text = (value) => (typeof value === 'string' ? value : '');
const bytesOf = (body) => (Buffer.isBuffer(body) ? body : Buffer.alloc(0));
const raw = express.raw({ type: () => true, limit: '100mb' });

function fail(res, error) {
  const shared = toSharedError(error);
  res.status(shared.status).json({ error: shared.message, code: shared.code, ...shared.extra });
}

/** Une méthode du service peut rendre une valeur, ou `{ status, body }` pour un statut précis. */
const handle = (task) => async (req, res) => {
  try {
    const result = await task(req);
    if (result && typeof result.status === 'number' && result.body) res.status(result.status).json(result.body);
    else res.json(result);
  } catch (error) {
    fail(res, error);
  }
};

export function registerSharedRoutes(app, { shared }) {
  const router = express.Router();
  router.use(localOnly);

  if (!shared) {
    router.get('/status', (_req, res) => res.json({ available: false }));
    router.use((_req, res) => res.status(404).json({ error: 'Dossier partagé : disponible dans l’application desktop.', code: 'SHARED_UNAVAILABLE' }));
    app.use('/api/shared', router);
    return;
  }

  router.get('/status', handle(() => shared.status()));
  router.get('/list', handle((req) => shared.list(text(req.query.dir))));
  router.get('/file', handle((req) => shared.file(text(req.query.path))));
  router.get('/content', (req, res) => {
    const bytes = shared.content(text(req.query.hash));
    if (!bytes) return fail(res, new SharedError(404, 'SHARED_NO_CONTENT', 'Version introuvable sur cet ordinateur.'));
    res.setHeader('Content-Type', 'application/octet-stream');
    // Adressé par son empreinte : le contenu d'une URL ne change jamais.
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.send(bytes);
  });
  /**
   * Mêmes octets, lisibles dans la visionneuse PDF intégrée (`inline`, sous le nom
   * du fichier). **PDF seulement** : servi depuis l'origine de l'app, un fichier
   * d'équipe quelconque pourrait être du HTML actif. `name` ne sert qu'à l'en-tête.
   */
  router.get('/preview', (req, res) => {
    const bytes = shared.content(text(req.query.hash));
    if (!bytes) return fail(res, new SharedError(404, 'SHARED_NO_CONTENT', 'Version introuvable sur cet ordinateur.'));
    // La norme tolère quelques octets avant l'en-tête `%PDF-` : les lecteurs le cherchent dans le premier Ko.
    if (!bytes.subarray(0, 1024).includes('%PDF-')) {
      return fail(res, new SharedError(415, 'SHARED_NOT_PDF', 'Aperçu intégré réservé aux PDF.'));
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', inlineHeader(text(req.query.name).split(/[\\/]/).pop() || 'document.pdf'));
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.send(bytes);
  });
  router.put('/draft', handle((req) => shared.saveDraft(text(req.query.path), req.body || {})));
  router.post('/draft/discard', raw, handle((req) => shared.discardDraft(text(req.query.path), bytesOf(req.body))));
  router.post('/push', raw, handle((req) => shared.push(text(req.query.path), text(req.query.base) || null, bytesOf(req.body))));
  // « Fusionner » : les octets réunis par le front, envoyés avec leur version pour base.
  router.post('/merge', raw, handle((req) => shared.merge(text(req.query.path), text(req.query.theirs) || null, bytesOf(req.body))));
  router.get('/search', handle((req) => shared.search(text(req.query.q), text(req.query.dir))));
  // Fichier neuf (octets du modèle, faits par le front) : créé sans jamais écraser.
  router.post('/create', raw, handle((req) => shared.create(text(req.query.path), bytesOf(req.body))));
  router.post('/resolve', handle((req) => {
    const body = req.body || {};
    return shared.resolve(text(body.path), text(body.choice), text(body.theirs) || null);
  }));
  router.get('/versions', handle((req) => shared.versions(text(req.query.path))));
  router.post('/versions/:id/restore', handle((req) => shared.restoreVersion(text(req.query.path), req.params.id)));
  // Prendre la main (première frappe), la renouveler (chaque minute), la rendre.
  router.post('/lock', handle((req) => shared.acquireLock(text(req.query.path), { takeOver: (req.body || {}).take_over === true })));
  router.delete('/lock', handle((req) => shared.releaseLock(text(req.query.path))));
  router.put('/projects/:id/folder', handle((req) => shared.linkProject(req.params.id, text((req.body || {}).dir))));
  router.delete('/projects/:id/folder', handle((req) => shared.unlinkProject(req.params.id)));
  router.put('/settings', handle((req) => shared.setDisplayName((req.body || {}).display_name)));

  app.use('/api/shared', router);
}
