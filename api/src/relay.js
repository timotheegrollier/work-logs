import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { openDb } from './db.js';
import { createSharedService, instanceId } from './shared-service.js';
import { registerSharedRoutes } from './shared-routes.js';

/**
 * Relais du dossier partagé pour la PWA (téléphone). Tourne sur une machine du
 * réseau de l'entreprise qui monte le partage du TSE (la VM 172.16.1.203, montage
 * CIFS) ; le téléphone le joint par Tailscale, en HTTPS (`tailscale serve`).
 * Mêmes routes et mêmes garde-fous que le desktop (`shared-service.js` : verrous,
 * envoi gardé, conflits, versions) ; à la place de « cet ordinateur seulement »,
 * un **code d'accès** (en-tête `Authorization: Bearer …`) et les seules origines
 * de la PWA (CORS). Voir docs/05-DECISIONS.md §29 et docs/09-RELAIS.md.
 */

const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();

/** Compare deux codes en temps constant (empreintes de même longueur). */
export function sameToken(given, expected) {
  if (!given || !expected) return false;
  return crypto.timingSafeEqual(digest(given), digest(expected));
}

/** Code d'accès neuf : 32 octets aléatoires, en base64url (43 caractères). */
export const newToken = () => crypto.randomBytes(32).toString('base64url');

export function createRelayApp({ shared, token, origins }) {
  const allowed = new Set(origins);
  const app = express();
  app.disable('x-powered-by');

  // CORS : la PWA est servie depuis une autre adresse (le Worker Cloudflare).
  // `Access-Control-Allow-Private-Network` : une page publique qui appelle une
  // adresse privée (Tailscale) — Chrome le demande en préliminaire.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const known = Boolean(origin && allowed.has(origin));
    if (known) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
      if (req.headers['access-control-request-private-network'] === 'true') res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    if (req.method === 'OPTIONS') return res.status(known ? 204 : 403).end();
    next();
  });

  // Sans code : seulement de quoi vérifier que le relais tourne.
  app.get('/health', (_req, res) => res.json({ ok: true, service: 'worklogs-relais' }));

  const guard = (req, res, next) => {
    const header = String(req.headers.authorization || '');
    const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!sameToken(given, token)) {
      return res.status(401).json({ error: 'Relais du dossier partagé : code d’accès absent ou incorrect.', code: 'RELAY_UNAUTHORIZED' });
    }
    next();
  };
  app.use(express.json({ limit: '5mb' }));
  registerSharedRoutes(app, { shared, guard });
  app.use((_req, res) => res.status(404).json({ error: 'Introuvable.', code: 'NOT_FOUND' }));
  return app;
}

/** Réglages lus dans l'environnement (fichier `/etc/worklogs-relais/env` sur la VM). */
export function relayConfig(env = process.env) {
  const root = env.WORKLOGS_SHARED_ROOT ? path.resolve(env.WORKLOGS_SHARED_ROOT) : null;
  if (!root) throw new Error('WORKLOGS_SHARED_ROOT manquant : le dossier du partage monté (ex. /mnt/tse-d/Global/…/00. PROCEDURE).');
  const tokenFile = env.WORKLOGS_RELAY_TOKEN_FILE || '/etc/worklogs-relais/code';
  const token = env.WORKLOGS_RELAY_TOKEN || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '');
  if (token.length < 32) throw new Error(`Code d’accès manquant ou trop court (${tokenFile}) : node src/relay.js --nouveau-code > ${tokenFile}`);
  const origins = (env.WORKLOGS_RELAY_ORIGINS || 'https://worklogs-google.cocodexcocoder.workers.dev')
    .split(',').map((origin) => origin.trim()).filter(Boolean);
  return {
    root,
    token,
    origins,
    dataDir: path.resolve(env.WORKLOGS_RELAY_DATA || '/var/lib/worklogs-relais'),
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 8420),
    displayName: env.WORKLOGS_RELAY_NAME || '',
  };
}

export function startRelay(config) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(path.join(config.dataDir, 'relais.db'), { withSeed: false });
  const shared = createSharedService({
    db, blobDir: path.join(config.dataDir, 'shared-blobs'), root: config.root,
    instance: instanceId(config.dataDir), projectsKnown: false,
  });
  if (config.displayName && !shared.status().displayName?.trim()) shared.setDisplayName(config.displayName);
  const app = createRelayApp({ shared, token: config.token, origins: config.origins });
  const server = app.listen(config.port, config.host);
  const stop = async () => {
    server.close();
    await shared.stop();
    db.close();
  };
  return { app, server, shared, stop };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (process.argv.includes('--nouveau-code')) {
    process.stdout.write(newToken() + '\n');
  } else {
    const config = relayConfig();
    const relay = startRelay(config);
    relay.server.on('listening', () => {
      console.log(`[worklogs-relais] http://${config.host}:${config.port} → ${config.root}`);
      console.log(`[worklogs-relais] origines : ${config.origins.join(', ')}`);
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void relay.stop().then(() => process.exit(0)); });
  }
}
