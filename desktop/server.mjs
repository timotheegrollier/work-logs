import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { createApp } from '../api/src/app.js';
import { openDb } from '../api/src/db.js';

/** Serveur privé de la fenêtre desktop, indépendant des ports du mode web. */
export async function startDesktopServer({ dataDir, staticDir, withSeed = true, google = null }) {
  const db = openDb(path.join(dataDir, 'worklogs.db'), { withSeed });
  const token = randomBytes(32).toString('hex');
  const application = createApp({ db, uploadDir: path.join(dataDir, 'uploads'), staticDir, google });
  const server = createServer((req, res) => {
    if (req.headers['x-worklogs-token'] !== token) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'accès réservé à l’application desktop' }));
      return;
    }
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https: http:",
      // Le renderer appelle l'endpoint IA en direct (`web/src/ai-suggest.ts`) :
      // sans cet hôte, la CSP coupe l'appel et Suggérer échoue en « injoignable ».
      // Volontairement restreint à l'hôte par défaut : un endpoint personnalisé
      // (Paramètres → IA) reste bloqué côté desktop, sans affaiblir la garde.
      "connect-src 'self' https://generativelanguage.googleapis.com", "object-src 'none'",
      "base-uri 'none'", "frame-ancestors 'none'", "form-action 'none'",
    ].join('; '));
    application(req, res);
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    db.close();
    throw error;
  }
  let closing;
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    token,
    close() {
      closing ??= new Promise((resolve, reject) => {
        server.close((error) => {
          db.close();
          if (error) reject(error);
          else resolve();
        });
        server.closeIdleConnections();
      });
      return closing;
    },
  };
}
