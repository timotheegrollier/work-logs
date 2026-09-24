// WorkLogs — service worker PWA, généré au build (`scripts/emit-sw.mjs`).
// `0.38.0` est remplacé par la version du paquet racine : un
// déploiement change le nom du cache, l'ancienne coquille est purgée et la
// mise à jour est transparente au rechargement suivant.
const VERSION = '0.38.0';
const CACHE = `worklogs-${VERSION}`;
const CORE = ['./', './index.html', './manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(CORE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// Miroir du schéma `web/src/store/schema.ts` (base `worklogs`, magasin
// `attachments` en clé `id`) : tout changement de schéma se répercute ici.
function serveLocalFile(pathname) {
  // `/api/files/:stored` ou `/api/files/:stored/preview` : mêmes octets, mais
  // servis pour l'affichage dans le second cas.
  const inline = /\/preview$/.test(pathname);
  const segment = pathname.replace(/\/preview$/, '');
  const stored = segment.slice(segment.lastIndexOf('/') + 1);
  if (!stored || stored.length > 500) return Promise.resolve(new Response('fichier introuvable', { status: 404 }));
  return new Promise((resolve) => {
    let settled = false;
    const done = (response) => {
      if (!settled) {
        settled = true;
        resolve(response);
      }
    };
    const missing = () => done(new Response('fichier introuvable', { status: 404 }));
    try {
      const open = indexedDB.open('worklogs', 1);
      open.onerror = missing;
      open.onsuccess = () => {
        try {
          const got = open.result.transaction('attachments', 'readonly').objectStore('attachments').getAll();
          got.onerror = missing;
          got.onsuccess = () => {
            const found = (got.result || []).find((row) => row && row.stored === stored);
            if (found && found.blob) {
              done(new Response(found.blob, {
                headers: {
                  'Content-Type': found.mime || 'application/octet-stream',
                  'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${String(found.filename || stored).replace(/["\\]/g, '_')}"`,
                },
              }));
            } else missing();
          };
        } catch {
          missing();
        }
      };
    } catch {
      missing();
    }
  });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Pièces jointes : en PWA (aucun serveur) le réseau échoue et le binaire est
  // servi depuis IndexedDB, avec les mêmes URL canoniques `/api/files/…` que
  // le serveur. Avec serveur, le réseau répond d'abord : comportement inchangé.
  // Sur un hébergement statique (GitHub Pages), le réseau répond 404 au lieu
  // d'échouer : on replie aussi vers IndexedDB quand la réponse n'est pas OK,
  // sinon aucun fichier local ne serait jamais servi en ligne.
  if (url.pathname.includes('/api/files/')) {
    event.respondWith(
      fetch(request).then(
        (response) => (response.ok ? response : serveLocalFile(url.pathname)),
        () => serveLocalFile(url.pathname)
      )
    );
    return;
  }
  // L'API ne se met jamais en cache : les données restent toujours fraîches.
  if (url.pathname.includes('/api/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('./index.html', copy));
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
    )
  );
});
