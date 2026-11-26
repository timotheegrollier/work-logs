import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import express from 'express';
import { registerGithubRoutes } from '../src/github-routes.js';
import { startApi } from './helpers.js';
import { createGithubRepoReader } from '../src/github-links.js';

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
    [Object.assign(new Error('secret interne'), { code: 1 }), 502, 'GITHUB_READ_FAILED'],
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

test('les rubriques GitHub d’un projet relié sont servies sans cache', async () => {
  const api = await startApi();
  const calls = [];
  const app = express();
  registerGithubRoutes(app, { db: api.db, list: async (repo, section) => {
    calls.push([repo, section]);
    return { repo, section, items: [{ id: '1', title: 'Liste' }] };
  } });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const project = await api.post('/api/projects', { name: 'Déploiement', github_repo: 'a/b' });
    const response = await fetch(`${base}/api/projects/${project.body.id}/github/releases`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { repo: 'a/b', section: 'releases', items: [{ id: '1', title: 'Liste' }] });
    assert.deepEqual(calls, [['a/b', 'releases']]);

    const unlinked = await api.post('/api/projects', { name: 'Sans dépôt' });
    const notLinked = await fetch(`${base}/api/projects/${unlinked.body.id}/github/pulls`);
    assert.equal(notLinked.status, 409);
    assert.equal((await notLinked.json()).code, 'GITHUB_NOT_LINKED');

    const missing = await fetch(`${base}/api/projects/pr_inconnu/github/pulls`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, 'GITHUB_PROJECT_NOT_FOUND');
  } finally {
    await new Promise((resolve) => { server.close(resolve); server.closeIdleConnections(); });
    await api.close();
  }
});

test('la vraie lecture par rubrique refuse une rubrique inconnue avec un message français', async () => {
  const api = await startApi();
  const app = express();
  registerGithubRoutes(app, { db: api.db, list: createGithubRepoReader({ execFile: async () => { throw new Error('gh ne doit pas être appelé'); } }) });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const project = await api.post('/api/projects', { name: 'Déploiement', github_repo: 'a/b' });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/projects/${project.body.id}/github/wiki`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, 'GITHUB_UNKNOWN_SECTION');
  } finally {
    await new Promise((resolve) => { server.close(resolve); server.closeIdleConnections(); });
    await api.close();
  }
});
