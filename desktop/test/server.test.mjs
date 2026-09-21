import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDesktopServer } from '../server.mjs';

test('serveur desktop privé, persistant et fermé avec l’application', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-desktop-server-'));
  let server;
  try {
    server = await startDesktopServer({ dataDir, withSeed: false });
    assert.equal(new URL(server.origin).hostname, '127.0.0.1');
    assert.notEqual(new URL(server.origin).port, '8410');
    for (const headers of [{}, { 'x-worklogs-token': 'incorrect' }]) {
      const denied = await fetch(server.origin + '/api/export', { headers });
      assert.equal(denied.status, 403);
      assert.match((await denied.json()).error, /réservé/);
    }
    const headers = { 'x-worklogs-token': server.token, 'Content-Type': 'application/json' };
    const created = await fetch(server.origin + '/api/entries', {
      method: 'POST', headers, body: JSON.stringify({ title: 'Note desktop', content_md: '**Persistant**' }),
    });
    assert.equal(created.status, 201);
    assert.match(created.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    // Le renderer appelle l'endpoint IA en direct : la CSP doit le laisser passer,
    // sans ouvrir connect-src au-delà de l'hôte par défaut.
    assert.match(
      created.headers.get('content-security-policy'),
      /connect-src 'self' https:\/\/generativelanguage\.googleapis\.com/
    );
    const entry = await created.json();
    const oldOrigin = server.origin;
    const oldToken = server.token;
    await Promise.all([server.close(), server.close()]);
    await assert.rejects(fetch(oldOrigin + '/api/health', { headers }));
    server = await startDesktopServer({ dataDir, withSeed: false });
    assert.notEqual(server.token, oldToken);
    const loaded = await fetch(server.origin + '/api/entries/' + entry.id, {
      headers: { 'x-worklogs-token': server.token },
    });
    assert.equal((await loaded.json()).content_md, '**Persistant**');
  } finally {
    await server?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
