import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSw, readRootVersion, SW_VERSION_PLACEHOLDER } from './pwa-sw.mjs';

test('injecte la version racine à chaque occurrence du marqueur', () => {
  const rendered = renderSw(`const VERSION = '${SW_VERSION_PLACEHOLDER}'; // ${SW_VERSION_PLACEHOLDER}`, '0.15.1');
  assert.equal(rendered, "const VERSION = '0.15.1'; // 0.15.1");
  assert.ok(!rendered.includes(SW_VERSION_PLACEHOLDER));
});

test('refuse un gabarit sans marqueur ou une version mal formée', () => {
  assert.throws(() => renderSw('sans marqueur', '0.15.1'), /marqueur/);
  assert.throws(() => renderSw(SW_VERSION_PLACEHOLDER, '0.15'), /Version/);
  assert.throws(() => renderSw(SW_VERSION_PLACEHOLDER, 'v0.15.1'), /Version/);
});

test('lit la version du paquet racine', () => {
  assert.equal(readRootVersion(JSON.stringify({ version: '0.15.1' })), '0.15.1');
  assert.throws(() => readRootVersion('{invalide'), /illisible/);
  assert.throws(() => readRootVersion(JSON.stringify({ version: '0.15' })), /invalide/);
});

const SW_TEMPLATE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'src', 'sw-template.js'), 'utf8');

/** Charge le gabarit rendu avec des globaux stubés, comme dans un worker. */
function loadSw({ fetchImpl, files = [] }) {
  const listeners = {};
  const cached = new Map();
  const sandbox = {
    self: {
      addEventListener: (type, handler) => { listeners[type] = handler; },
      skipWaiting: () => {},
      clients: { claim: () => {} },
      location: { origin: 'https://pwa.test' },
    },
    caches: {
      open: async () => ({
        put: async (key, value) => { cached.set(String(key.url || key), value); },
        match: async (key) => cached.get(String(key.url || key)),
        addAll: async () => {},
      }),
      keys: async () => [],
      delete: async () => true,
      match: async (key) => cached.get(String(key.url || key)),
    },
    fetch: fetchImpl,
    indexedDB: {
      open: () => {
        const request = {};
        queueMicrotask(() => {
          request.result = {
            transaction: () => ({
              objectStore: () => ({
                getAll: () => {
                  const got = {};
                  queueMicrotask(() => {
                    got.result = files;
                    got.onsuccess();
                  });
                  return got;
                },
              }),
            }),
          };
          request.onsuccess();
        });
        return request;
      },
    },
    Response,
    URL,
  };
  vm.createContext(sandbox);
  vm.runInContext(renderSw(SW_TEMPLATE, '9.9.9'), sandbox, { filename: 'sw-template.js' });
  return { listeners, cached };
}

const getEvent = (url, mode = 'cors') => {
  const event = { request: { method: 'GET', mode, url }, responses: [],
    respondWith(promise) { this.responses.push(promise); } };
  return event;
};

describe('routage fetch du service worker', () => {
  test("l'API hors fichiers n'est jamais interceptée", async () => {
    const { listeners } = loadSw({ fetchImpl: async () => new Response('{}') });
    for (const url of ['https://pwa.test/api/state', 'https://pwa.test/api/uploads']) {
      const event = getEvent(url);
      listeners.fetch(event);
      assert.equal(event.responses.length, 0);
    }
  });

  test('navigation : réseau d’abord, repli hors-ligne sur la coquille', async () => {
    const shell = new Response('<html></html>');
    const online = loadSw({ fetchImpl: async () => new Response('frais') });
    const nav = getEvent('https://pwa.test/', 'navigate');
    online.listeners.fetch(nav);
    assert.equal(await nav.responses[0].then((r) => r.text()), 'frais');

    const offline = loadSw({ fetchImpl: async () => { throw new Error('hors-ligne'); } });
    offline.cached.set('./index.html', shell);
    const retry = getEvent('https://pwa.test/', 'navigate');
    offline.listeners.fetch(retry);
    assert.equal(await retry.responses[0].then((r) => r.text()), '<html></html>');
  });

  test('ressource : cache d’abord, puis réseau mis en cache', async () => {
    const env = loadSw({ fetchImpl: async () => new Response('asset') });
    const first = getEvent('https://pwa.test/assets/app.js');
    env.listeners.fetch(first);
    assert.equal(await first.responses[0].then((r) => r.text()), 'asset');
    const failing = loadSw({ fetchImpl: async () => { throw new Error('hors-ligne'); } });
    failing.cached.set('https://pwa.test/assets/app.js', new Response('asset'));
    const second = getEvent('https://pwa.test/assets/app.js');
    failing.listeners.fetch(second);
    assert.equal(await second.responses[0].then((r) => r.text()), 'asset');
  });

  test('pièce jointe : réseau d’abord, sinon blob IndexedDB, sinon 404', async () => {
    const file = { stored: 'abc.pdf', mime: 'application/pdf', blob: new Blob(['contenu']) };
    const online = loadSw({ fetchImpl: async () => new Response('serveur'), files: [file] });
    const hit = getEvent('https://pwa.test/api/files/abc.pdf');
    online.listeners.fetch(hit);
    assert.equal(hit.responses.length, 1);
    assert.equal(await hit.responses[0].then((r) => r.text()), 'serveur');

    const offline = loadSw({ fetchImpl: async () => { throw new Error('hors-ligne'); }, files: [file] });
    const local = getEvent('https://pwa.test/api/files/abc.pdf');
    offline.listeners.fetch(local);
    const response = await local.responses[0];
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
    assert.equal(await response.text(), 'contenu');

    const missing = getEvent('https://pwa.test/api/files/absent.pdf');
    offline.listeners.fetch(missing);
    assert.equal((await missing.responses[0]).status, 404);
  });

  test('hébergement statique : une 404 réseau replie vers le blob local', async () => {
    const file = { stored: 'archi.ods', filename: 'archi.ods', mime: 'application/vnd.oasis.opendocument.spreadsheet', blob: new Blob(['tableur']) };
    const pages = loadSw({ fetchImpl: async () => new Response('<h1>404</h1>', { status: 404 }), files: [file] });
    const local = getEvent('https://pwa.test/api/files/archi.ods');
    pages.listeners.fetch(local);
    const response = await local.responses[0];
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'tableur');

    const unknown = getEvent('https://pwa.test/api/files/inconnu.ods');
    pages.listeners.fetch(unknown);
    assert.equal((await unknown.responses[0]).status, 404);
  });

  test('aperçu : mêmes octets servis `inline` et nommés, téléchargement toujours `attachment`', async () => {
    const file = { stored: 'abc.pdf', filename: 'devis é.pdf', mime: 'application/pdf', blob: new Blob(['contenu']) };

    // Hors-ligne : seuls les binaires locaux peuvent répondre, c'est le cas réel.
    const offline = loadSw({ fetchImpl: async () => { throw new Error('hors-ligne'); }, files: [file] });
    const preview = getEvent('https://pwa.test/api/files/abc.pdf/preview');
    offline.listeners.fetch(preview);
    const inline = await preview.responses[0];
    assert.equal(inline.status, 200);
    assert.equal(inline.headers.get('content-type'), 'application/pdf');
    assert.match(inline.headers.get('content-disposition'), /^inline; /);
    assert.match(inline.headers.get('content-disposition'), /filename="devis é\.pdf"/);
    assert.equal(await inline.text(), 'contenu');

    const download = getEvent('https://pwa.test/api/files/abc.pdf');
    offline.listeners.fetch(download);
    assert.match((await download.responses[0]).headers.get('content-disposition'), /^attachment; /);
  });
});
