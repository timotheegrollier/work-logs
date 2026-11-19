import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import express from 'express';
import { registerGithubRoutes } from '../src/github-routes.js';
import { startApi } from './helpers.js';

const address = 'https://github.com/Murgat-Ingenierie/deployer';

async function serverFor(read) {
  const app = express();
  registerGithubRoutes(app, { read });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/api/github/link?url=${encodeURIComponent(address)}`,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeIdleConnections(); }) };
}

test('la route GitHub est enregistrée sur l’API et valide l’adresse avant gh', async () => {
  const api = await startApi();
  try {
    const result = await api.get('/api/github/link?url=https%3A%2F%2Fevil.example%2Frepo');
    assert.equal(result.status, 400);
    assert.equal(result.body.code, 'GITHUB_INVALID_URL');
  } finally { await api.close(); }
});

test('la route GitHub livre un extrait privé à WorkLogs local et interdit sa mise en cache', async () => {
  const server = await serverFor(async (url, { signal }) => {
    assert.equal(url, address);
    assert.equal(signal.aborted, false);
    return { url, text: 'Déploiement des postes', private: true };
  });
  try {
    const response = await fetch(server.url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { url: address, text: 'Déploiement des postes', private: true });
  } finally { await server.close(); }
});

test('la route GitHub bloque une page distante et un hôte non local avant de consulter le compte', async () => {
  let called = false;
  const server = await serverFor(async () => { called = true; return {}; });
  try {
    const response = await fetch(server.url, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'GITHUB_LOCAL_ONLY');
    const foreignHost = await new Promise((resolve, reject) => {
      http.get(server.url, { headers: { Host: 'foreign.example' } }, (result) => {
        result.resume();
        resolve(result.statusCode);
      }).on('error', reject);
    });
    assert.equal(foreignHost, 403);
    assert.equal(called, false);
  } finally { await server.close(); }
});

test('la route GitHub conserve le refus d’accès précis et masque les erreurs internes', async () => {
  for (const [cause, status, code] of [
    [Object.assign(new Error('GitHub : connecte le compte local.'), { status: 401, code: 'GITHUB_AUTH_REQUIRED' }), 401, 'GITHUB_AUTH_REQUIRED'],
    [new Error('secret interne'), 502, 'GITHUB_READ_FAILED'],
  ]) {
    const server = await serverFor(async () => { throw cause; });
    try {
      const response = await fetch(server.url);
      assert.equal(response.status, status);
      const body = await response.json();
      assert.equal(body.code, code);
      assert.doesNotMatch(body.error, /secret interne/);
    } finally { await server.close(); }
  }
});
