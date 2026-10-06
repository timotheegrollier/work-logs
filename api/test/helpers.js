import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { createSharedService } from '../src/shared-service.js';

/**
 * Démarre une API isolée : base SQLite et dossier d'uploads jetables dans /tmp,
 * port éphémère. Chaque test repart d'un état propre, rien ne touche `api/data`.
 */
export async function startApi({ withSeed = false, google = null, autoSync = false, shared: sharedOptions = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-test-'));
  const uploadDir = path.join(dir, 'uploads');
  const db = openDb(path.join(dir, 'worklogs.db'), { withSeed });
  // `shared: { root, … }` : dossier partagé joué par un dossier temporaire.
  const shared = sharedOptions
    ? createSharedService({ db, blobDir: path.join(dir, 'shared-blobs'), retryMs: 0, probeMs: 0, mountCheckMs: 0, instance: 'test-instance', ...sharedOptions })
    : null;
  const app = createApp({ db, uploadDir, google, autoSync, shared });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  /** Appelle l'API et renvoie toujours `{ status, body }`. */
  const call = async (method, route, body) => {
    const res = await fetch(base + route, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  return {
    app,
    db,
    shared,
    base,
    dir,
    uploadDir,
    call,
    get: (route) => call('GET', route),
    post: (route, body) => call('POST', route, body ?? {}),
    put: (route, body) => call('PUT', route, body ?? {}),
    patch: (route, body) => call('PATCH', route, body ?? {}),
    del: (route) => call('DELETE', route),
    /** Envoie un fichier en multipart, comme le ferait le navigateur. */
    async upload(filename, contents, fields = {}) {
      const form = new FormData();
      form.append('file', new Blob([contents], { type: 'text/plain' }), filename);
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      const res = await fetch(base + '/api/uploads', { method: 'POST', body: form });
      return { status: res.status, body: await res.json() };
    },
    async close() {
      app.locals.googleSync?.stop();
      await shared?.stop();
      server.close();
      await once(server, 'close');
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Raccourcis pour préparer un jeu de données dans un test. */
export const make = {
  project: (api, name = 'Projet', color = '#ff0000') =>
    api.post('/api/projects', { name, color }).then((r) => r.body),
  entry: (api, body = {}) =>
    api.post('/api/entries', { title: 'Entrée', ...body }).then((r) => r.body),
  task: (api, body = {}) => api.post('/api/tasks', { title: 'Tâche', ...body }).then((r) => r.body),
};

/**
 * Fichier propriétaire Office tel que Word (162 octets, nom UTF-16 à l'octet 54)
 * ou Excel (165 octets, octet 55) le laisse à côté d'un fichier ouvert.
 */
export function officeOwnerFile(name, { excel = false } = {}) {
  const bytes = Buffer.alloc(excel ? 165 : 162, 0x20);
  bytes[0] = name.length;
  bytes.write(name, 1, 'latin1');
  const offset = excel ? 55 : 54;
  bytes[offset] = name.length;
  bytes[offset + 1] = 0;
  bytes.write(name, offset + 2, 'utf16le');
  return bytes;
}
