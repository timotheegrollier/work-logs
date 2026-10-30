import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { openDb } from './db.js';
import { createSharedService, instanceId } from './shared-service.js';
import { registerSharedRoutes } from './shared-routes.js';
import { addressFromMountinfo } from './shared-address.js';

/**
 * Relais du dossier partagé pour la PWA (téléphone). Tourne sur une machine du
 * réseau de l'entreprise qui monte le partage du TSE (la VM 172.16.1.203, montage
 * CIFS) ; le téléphone le joint par Tailscale, en HTTPS (`tailscale serve`).
 * Mêmes routes et mêmes garde-fous que le desktop (`shared-service.js` : verrous,
 * envoi gardé, conflits, versions) ; à la place de « cet ordinateur seulement »,
 * le **réseau Tailscale**, sans code d'accès, et pour un navigateur les seules
 * origines de la PWA. Voir docs/05-DECISIONS.md §29 et §55, docs/09-RELAIS.md.
 */

/**
 * Version de WorkLogs déployée, écrite à côté du code par la mise à jour automatique
 * (`relay/mise-a-jour.mjs` → `api/VERSION`) ; null quand le relais tourne depuis les sources.
 */
export function relayVersion(file = fileURLToPath(new URL('../VERSION', import.meta.url))) {
  try {
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function createRelayApp({ shared, origins, version = null }) {
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
      // `Authorization` : une PWA ouverte avant la fin du code d'accès (§55) l'envoie encore, ignoré.
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
      if (req.headers['access-control-request-private-network'] === 'true') res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    if (req.method === 'OPTIONS') return res.status(known ? 204 : 403).end();
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'worklogs-relais', ...(version ? { version } : {}) }));

  // Pas de code : le réseau Tailscale suffit (§55). Mais d'un navigateur, seule la PWA passe :
  // sinon n'importe quel site ouvert sur un appareil du réseau pourrait écrire dans le partage
  // (formulaire, `fetch` sans CORS). Le navigateur dit d'où vient l'appel (`Origin` sur toute
  // écriture, `Sec-Fetch-Site` partout) ; sans ces en-têtes (curl), ou l'adresse tapée dans la
  // barre (`none`), le relais répond.
  const guard = (req, res, next) => {
    const origin = req.headers.origin;
    const site = req.headers['sec-fetch-site'];
    if ((origin || (site && site !== 'none')) && !allowed.has(origin)) {
      return res.status(403).json({ error: 'Relais du dossier partagé : appel refusé depuis une autre page que WorkLogs.', code: 'RELAY_FOREIGN_ORIGIN' });
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
  const origins = (env.WORKLOGS_RELAY_ORIGINS || 'https://worklogs-google.cocodexcocoder.workers.dev')
    .split(',').map((origin) => origin.trim()).filter(Boolean);
  return {
    root,
    origins,
    dataDir: path.resolve(env.WORKLOGS_RELAY_DATA || '/var/lib/worklogs-relais'),
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 8420),
    displayName: env.WORKLOGS_RELAY_NAME || '',
    // Le nom du dossier tel que l'équipe le connaît (le point de montage s'appelle autrement).
    label: env.WORKLOGS_RELAY_LABEL || '',
    // Adresse Windows de la racine ; à défaut, lue dans le montage CIFS (`/proc/self/mountinfo`).
    address: env.WORKLOGS_RELAY_ADDRESS || '',
    version: relayVersion(),
  };
}

function mountAddress(root) {
  try {
    return addressFromMountinfo(root, fs.readFileSync('/proc/self/mountinfo', 'utf8'));
  } catch {
    return null;
  }
}

export function startRelay(config) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = openDb(path.join(config.dataDir, 'relais.db'), { withSeed: false });
  const shared = createSharedService({
    db, blobDir: path.join(config.dataDir, 'shared-blobs'), root: config.root,
    instance: instanceId(config.dataDir), projectsKnown: false, rootLabel: config.label || null,
    address: config.address || mountAddress(config.root),
  });
  // Nom des verrous : celui du réglage, sauf s'il a été changé depuis le téléphone (Paramètres).
  const chosen = db.prepare("SELECT value FROM local_settings WHERE key='shared.display_name'").get();
  if (config.displayName && !chosen) shared.setDisplayName(config.displayName);
  const app = createRelayApp({ shared, origins: config.origins, version: config.version });
  const server = app.listen(config.port, config.host);
  const stop = async () => {
    server.close();
    await shared.stop();
    db.close();
  };
  return { app, server, shared, stop };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const config = relayConfig();
  const relay = startRelay(config);
  relay.server.on('listening', () => {
    console.log(`[worklogs-relais] ${config.version ? `v${config.version} ` : ''}http://${config.host}:${config.port} → ${config.root}`);
    console.log(`[worklogs-relais] origines : ${config.origins.join(', ')}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void relay.stop().then(() => process.exit(0)); });
}
