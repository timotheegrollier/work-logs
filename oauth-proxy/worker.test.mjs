import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.mjs';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const PWA = 'https://timotheegrollier.github.io';
const CLIENT = '123456789012-abc.apps.googleusercontent.com';
const ENV = { GOOGLE_CLIENT_SECRET: 'secret-relais' };
const EXCHANGE = {
  client_id: CLIENT, grant_type: 'authorization_code', code: '4/code', code_verifier: 'verificateur',
  redirect_uri: 'https://timotheegrollier.github.io/work-logs/',
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Google simulé : note chaque appel (adresse + champs envoyés) et répond `answer()`. */
function stubGoogle(answer = () => Response.json({ access_token: 'acces', refresh_token: 'renouvellement', expires_in: 3599 })) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), fields: Object.fromEntries(new URLSearchParams(String(init.body))) });
    return answer();
  };
  return calls;
}

const post = (fields, { origin = PWA, path = '/token', env = ENV } = {}) => worker.fetch(new Request(`https://relais.test${path}`, {
  method: 'POST',
  headers: { Origin: origin },
  body: new URLSearchParams(fields),
}), env);

test('échange du code : le secret est ajouté, la réponse de Google revient telle quelle à la PWA', async () => {
  const calls = stubGoogle();
  const response = await post({ ...EXCHANGE, client_secret: 'pirate', scope: 'https://mail.google.com/' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), PWA);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), { access_token: 'acces', refresh_token: 'renouvellement', expires_in: 3599 });
  // Seuls les champs attendus partent, avec le secret du relais (jamais celui de l'appelant).
  assert.deepEqual(calls, [{ url: GOOGLE_TOKEN_URL, fields: { ...EXCHANGE, client_secret: 'secret-relais' } }]);
});

test('renouvellement : le refresh_token part avec le secret', async () => {
  const calls = stubGoogle(() => Response.json({ access_token: 'neuf', expires_in: 3599 }));
  const response = await post({ client_id: CLIENT, grant_type: 'refresh_token', refresh_token: 'r' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { access_token: 'neuf', expires_in: 3599 });
  assert.deepEqual(calls[0].fields, { client_id: CLIENT, grant_type: 'refresh_token', refresh_token: 'r', client_secret: 'secret-relais' });
});

test('refus de Google transmis avec son statut : la PWA affiche son propre message', async () => {
  stubGoogle(() => Response.json({ error: 'invalid_grant', error_description: 'Bad Request' }, { status: 400 }));
  const response = await post(EXCHANGE);
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), PWA);
  assert.deepEqual(await response.json(), { error: 'invalid_grant', error_description: 'Bad Request' });
});

test('hors cadre : refusé sans rien envoyer à Google', async () => {
  const calls = stubGoogle();
  const cases = [
    [{ origin: 'https://pirate.example' }, EXCHANGE, 403],
    [{ origin: '' }, EXCHANGE, 403],
    [{ path: '/autre' }, EXCHANGE, 404],
    [{}, { ...EXCHANGE, redirect_uri: 'https://pirate.example/' }, 400],
    [{}, { ...EXCHANGE, code_verifier: '' }, 400],
    [{}, { ...EXCHANGE, client_id: 'pas-un-client' }, 400],
    [{}, { ...EXCHANGE, code: 'x'.repeat(9000) }, 400],
    [{}, { client_id: CLIENT, grant_type: 'client_credentials' }, 400],
    [{}, { client_id: CLIENT, grant_type: 'password', username: 'a', password: 'b' }, 400],
    [{}, { client_id: CLIENT, grant_type: 'refresh_token' }, 400],
  ];
  for (const [options, fields, status] of cases) {
    const response = await post(fields, options);
    assert.equal(response.status, status, JSON.stringify({ options, status }));
    if (status === 403) assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  }
  assert.equal(calls.length, 0);
});

test('préflight CORS réservé à la PWA', async () => {
  const preflight = (origin) => worker.fetch(new Request('https://relais.test/token', { method: 'OPTIONS', headers: { Origin: origin } }), ENV);
  const allowed = await preflight(PWA);
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), PWA);
  assert.equal(allowed.headers.get('Access-Control-Allow-Methods'), 'POST');
  const other = await preflight('https://pirate.example');
  assert.equal(other.status, 403);
  assert.equal(other.headers.get('Access-Control-Allow-Origin'), null);
});

test('adresse ouverte dans un navigateur : dit si le secret est en place, sans le révéler', async () => {
  const configured = await worker.fetch(new Request('https://relais.test/'), ENV);
  assert.deepEqual(await configured.json(), { ok: true, configured: true });
  const empty = await worker.fetch(new Request('https://relais.test/'), {});
  assert.deepEqual(await empty.json(), { ok: true, configured: false });
});

test('secret absent ou Google injoignable : erreur explicite, jamais de plantage', async () => {
  const calls = stubGoogle();
  const missing = await post(EXCHANGE, { env: {} });
  assert.equal(missing.status, 500);
  assert.deepEqual(await missing.json(), { error: 'relay_not_configured' });
  assert.equal(calls.length, 0);

  globalThis.fetch = async () => {
    throw new TypeError('réseau coupé');
  };
  const down = await post(EXCHANGE);
  assert.equal(down.status, 502);
  assert.deepEqual(await down.json(), { error: 'google_unreachable' });

  stubGoogle(() => new Response('<html>erreur</html>', { status: 503 }));
  const garbled = await post(EXCHANGE);
  assert.equal(garbled.status, 503);
  assert.deepEqual(await garbled.json(), { error: 'invalid_google_response' });
});
