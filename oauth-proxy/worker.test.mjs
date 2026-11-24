import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from './worker.mjs';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

const PWA = 'https://worklogs-google.cocodexcocoder.workers.dev';
const PWA_GITHUB = 'https://timotheegrollier.github.io';
const CLIENT = '123456789012-abc.apps.googleusercontent.com';
const ENV = { GOOGLE_CLIENT_SECRET: 'secret-relais' };
const EXCHANGE = {
  client_id: CLIENT, grant_type: 'authorization_code', code: '4/code', code_verifier: 'verificateur',
  redirect_uri: 'https://worklogs-google.cocodexcocoder.workers.dev/',
};
const EXCHANGE_GITHUB = { ...EXCHANGE, redirect_uri: 'https://timotheegrollier.github.io/work-logs/' };

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

test('transition GitHub Pages : l’ancienne origine et son retour restent acceptés', async () => {
  const calls = stubGoogle();
  const response = await post(EXCHANGE_GITHUB, { origin: PWA_GITHUB });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), PWA_GITHUB);
  assert.deepEqual(await response.json(), { access_token: 'acces', refresh_token: 'renouvellement', expires_in: 3599 });
  assert.deepEqual(calls, [{ url: GOOGLE_TOKEN_URL, fields: { ...EXCHANGE_GITHUB, client_secret: 'secret-relais' } }]);
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
  // En production `/` sert la PWA : la même sonde est exposée sur `/token`.
  const token = await worker.fetch(new Request('https://relais.test/token'), ENV);
  assert.deepEqual(await token.json(), { ok: true, configured: true });
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

const PDF_PATH = 'https://relais.test/ai/pdf';
// Lue dans `desktop/main.mjs` : le 2026-11-24, une valeur recopiée à tort a fait refuser
// toutes les demandes IA de l’application desktop (403).
const DESKTOP = readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8').match(/^const origin = '([^']+)';$/m)[1];
const DEV_SERVER = 'http://127.0.0.1:43127';
const PDF = '%PDF-1.7\n1 0 obj\n<< >>\nendobj\n%%EOF\n';
const MIB = 1024 * 1024;

function fakePdfBindings({ answer = { format: 'text', data: '  Texte du PDF.  ' }, allowed = true } = {}) {
  const conversions = [];
  const limits = [];
  const env = {
    AI: { async toMarkdown(document, options) {
      conversions.push({ document, options });
      if (answer instanceof Error) throw answer;
      return answer;
    } },
    PDF_LIMITER: { async limit(params) {
      limits.push(params);
      return { success: allowed };
    } },
  };
  return { env, conversions, limits };
}

const postPdf = (env, { origin = PWA, body = PDF, headers = {} } = {}) => worker.fetch(new Request(PDF_PATH, {
  method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/pdf', ...headers },
  body, duplex: 'half',
}), env);

test('PDF sans clé : le texte seul revient et le convertisseur reçoit la pièce sans son nom original', async () => {
  const { env, conversions, limits } = fakePdfBindings();
  const response = await postPdf(env, { origin: DESKTOP, headers: {
    'Content-Disposition': 'attachment; filename=confidentiel.pdf',
    'CF-Connecting-IP': '192.0.2.17',
  } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), DESKTOP);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), { text: 'Texte du PDF.', truncated: false });
  assert.deepEqual(limits, [{ key: '192.0.2.17' }]);
  assert.equal(conversions.length, 1);
  const [{ document, options }] = conversions;
  assert.deepEqual(Object.keys(document).sort(), ['blob', 'name']);
  assert.equal(document.name, 'document.pdf');
  assert.equal(document.blob.type, 'application/pdf');
  assert.equal(await document.blob.text(), PDF);
  assert.deepEqual(options, { conversionOptions: { pdf: { metadata: false }, output: { format: 'text' } } });
});

test('PDF : le texte renvoyé est borné et la coupe signalée', async () => {
  const { env } = fakePdfBindings({ answer: { format: 'text', data: 'a'.repeat(16_001) } });
  const response = await postPdf(env);
  assert.deepEqual(await response.json(), { text: 'a'.repeat(16_000), truncated: true });
});

test('PDF : seuls les clients WorkLogs peuvent envoyer une pièce en CORS, sans élargir les droits OAuth', async () => {
  const { env, conversions, limits } = fakePdfBindings();
  for (const origin of [PWA, PWA_GITHUB, DESKTOP, DEV_SERVER, 'http://localhost:8411']) {
    const response = await worker.fetch(new Request(PDF_PATH, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    }), env);
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'POST');
    assert.equal(response.headers.get('Access-Control-Allow-Headers'), 'Content-Type');
    assert.equal(response.headers.get('Access-Control-Allow-Credentials'), null);
  }
  for (const origin of ['', 'null', 'https://pirate.example', 'worklogs://pirate', 'http://127.0.0.1.pirate.example:8410', 'https://127.0.0.1:8410', 'http://192.168.1.10:8410']) {
    const response = await postPdf(env, { origin });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  }
  const oauth = await post(EXCHANGE, { origin: DESKTOP });
  assert.equal(oauth.status, 403);
  assert.equal(conversions.length, 0);
  assert.equal(limits.length, 0);
});

test('PDF : type et signature invalides sont refusés avant conversion', async () => {
  const { env, conversions } = fakePdfBindings();
  for (const [options, status] of [
    [{ body: '<html>', headers: { 'Content-Type': 'text/html' } }, 415],
    [{ body: '<html>' }, 400],
    [{ body: null }, 400],
  ]) {
    assert.equal((await postPdf(env, options)).status, status);
  }
  assert.equal(conversions.length, 0);
});

test('PDF : les 10 Mio sont vérifiés avec ou sans taille annoncée', async () => {
  const { env, conversions } = fakePdfBindings();
  const declared = await postPdf(env, { headers: { 'Content-Length': String(10 * MIB + 1) } });
  assert.equal(declared.status, 413);
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(PDF));
      controller.enqueue(new Uint8Array(6 * MIB));
      controller.enqueue(new Uint8Array(4 * MIB));
      controller.close();
    },
  });
  assert.equal((await postPdf(env, { body })).status, 413);
  assert.equal(conversions.length, 0);
});

test('PDF : la limite de débit refuse avant conversion sans demander de compte', async () => {
  const { env, conversions } = fakePdfBindings({ allowed: false });
  const response = await postPdf(env);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '60');
  assert.equal(conversions.length, 0);
});

test('PDF sans texte ou service indisponible : le client reçoit un motif sans diagnostic interne', async () => {
  for (const answer of [{ format: 'text', data: '\n ' }, { format: 'error', error: 'détails internes' }]) {
    const { env } = fakePdfBindings({ answer });
    const response = await postPdf(env);
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: 'Aucun texte lisible dans ce PDF.' });
  }
  const down = fakePdfBindings({ answer: new Error('détails internes') });
  for (const env of [{}, down.env]) {
    const response = await postPdf(env);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'La lecture des PDF est indisponible. Réessaie plus tard.' });
  }
});

const CHAT_PATH = 'https://relais.test/ai/chat/completions';
const CHAT_MODEL = '@cf/google/gemma-4-26b-a4b-it';
const CHAT_REQUEST = { messages: [{ role: 'user', content: 'Dis bonjour.' }] };
const CHAT_ANSWER = {
  choices: [{ index: 0, message: { role: 'assistant', content: 'Bonjour !' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
};

function fakeChatBindings({ answer = () => Response.json(CHAT_ANSWER), allowed = true } = {}) {
  const calls = [];
  const limits = [];
  const env = {
    AI: { async run(model, params, options) {
      calls.push({ model, params, options });
      return answer();
    } },
    CHAT_LIMITER: { async limit(params) {
      limits.push(params);
      return { success: allowed };
    } },
  };
  return { env, calls, limits };
}

const postChat = (env, { origin = PWA, body = JSON.stringify(CHAT_REQUEST), headers = {} } = {}) =>
  worker.fetch(new Request(CHAT_PATH, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
    body, duplex: 'half',
  }), env);

const imagePart = (url) => ({ type: 'image_url', image_url: { url } });
const mediaBody = (...parts) => JSON.stringify({ messages: [{ role: 'user', content: parts }] });

test('discussion sans clé : réponse OpenAI et modèle fixe avec des paramètres bornés', async () => {
  const { env, calls, limits } = fakeChatBindings();
  const response = await postChat(env, {
    origin: DESKTOP,
    headers: { 'CF-Connecting-IP': '192.0.2.17' },
    body: JSON.stringify({
      model: 'autre-modele', max_tokens: 9000, temperature: 0.25, store: true, stream: true,
      messages: [{ role: 'system', content: 'Réponds en français.', name: 'identifiant' }, ...CHAT_REQUEST.messages],
      response_format: { type: 'json_object', schema: { title: 'Champ ignoré' } },
      tools: [{ type: 'web_search' }], n: 4, metadata: { user: 'identifiant' },
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), DESKTOP);
  assert.deepEqual(await response.json(), CHAT_ANSWER);
  assert.deepEqual(limits, [{ key: '192.0.2.17' }]);
  assert.deepEqual(calls, [{
    model: CHAT_MODEL,
    params: {
      messages: [{ role: 'system', content: 'Réponds en français.' }, ...CHAT_REQUEST.messages],
      temperature: 0.25,
      max_completion_tokens: 8000,
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: 'json_object' },
    },
    options: { returnRawResponse: true },
  }]);
});

test('discussion : préflight pour les mêmes clients WorkLogs que l’extraction PDF', async () => {
  const { env, calls, limits } = fakeChatBindings();
  for (const origin of [PWA, PWA_GITHUB, DESKTOP, DEV_SERVER, 'http://localhost:8411']) {
    const response = await worker.fetch(new Request(CHAT_PATH, {
      method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    }), env);
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(response.headers.get('Access-Control-Allow-Headers'), 'Content-Type');
    assert.equal(response.headers.get('Access-Control-Allow-Credentials'), null);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  for (const origin of ['', 'null', 'https://pirate.example', 'worklogs://pirate', 'http://127.0.0.1.pirate.example:8410', 'https://127.0.0.1:8410', 'http://192.168.1.10:8410']) {
    const response = await postChat(env, { origin });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  }
  const otherMethod = await worker.fetch(new Request(CHAT_PATH, { headers: { Origin: PWA } }), env);
  assert.equal(otherMethod.status, 405);
  assert.equal(otherMethod.headers.get('Allow'), 'POST, OPTIONS');
  assert.deepEqual(limits, []);
  assert.deepEqual(calls, []);
});

test('discussion : les images intégrées arrivent au modèle, les URL et les autres médias sont refusés', async () => {
  const { env, calls } = fakeChatBindings();
  const image = imagePart('data:image/png;base64,iVBORw0KGgo=');
  const text = { type: 'text', text: 'Décris cette image.' };
  const response = await postChat(env, { body: mediaBody(text, { ...image, image_url: { ...image.image_url, detail: 'high' } }) });
  assert.equal(response.status, 200);
  assert.deepEqual(calls[0].params.messages, [{ role: 'user', content: [text, image] }]);
  for (const part of [
    imagePart('https://example.com/image.png'),
    imagePart('file:///tmp/image.png'),
    imagePart('data:image/svg+xml;base64,AAAA'),
    imagePart('data:image/png;base64,http://example.com'),
    imagePart('data:image/png;base64,AAA=AAAA'),
    { type: 'file', file: { file_data: 'data:application/pdf;base64,AAAA' } },
  ]) {
    const response = await postChat(env, { body: mediaBody(text, part) });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /demande IA est invalide/);
  }
  assert.equal(calls.length, 1);
});

test('discussion : le JSON et les limites de taille sont contrôlés avant l’inférence', async () => {
  const { env, calls } = fakeChatBindings();
  const huge = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8 * MIB));
      controller.enqueue(new Uint8Array(7 * MIB));
      controller.close();
    },
  });
  const largeImage = (size) => imagePart(`data:image/webp;base64,${'A'.repeat(4 * Math.ceil(size / 3))}`);
  for (const [options, status] of [
    [{ headers: { 'Content-Type': 'text/plain' } }, 415],
    [{ body: '{' }, 400],
    [{ body: null }, 400],
    [{ body: JSON.stringify({ messages: [{ role: 'tool', content: 'Résultat' }] }) }, 400],
    [{ body: JSON.stringify({ ...CHAT_REQUEST, max_tokens: -10 }) }, 400],
    [{ body: JSON.stringify({ ...CHAT_REQUEST, response_format: { type: 'json_schema' } }) }, 400],
    [{ headers: { 'Content-Length': String(14 * MIB + 1) } }, 413],
    [{ body: huge }, 413],
    [{ body: JSON.stringify({ messages: [{ role: 'user', content: 'a'.repeat(128_001) }] }) }, 413],
    [{ body: mediaBody(largeImage(5 * MIB + 1)) }, 413],
    [{ body: mediaBody(...Array(3).fill(largeImage(4 * MIB))) }, 413],
    [{ body: mediaBody(...Array(6).fill(imagePart('data:image/jpeg;base64,AAAA'))) }, 413],
  ]) {
    assert.equal((await postChat(env, options)).status, status);
  }
  assert.deepEqual(calls, []);
});

test('discussion : quotas IP et Cloudflare remontent en 429 avec délai accessible en CORS', async () => {
  const limited = fakeChatBindings({ allowed: false });
  const dailyLimit = () => Response.json({ internalCode: 3036, description: 'Détail fournisseur' }, { status: 429 });
  const globalLimit = () => Response.json({ errors: [{ code: 3021, message: 'Détail fournisseur' }] }, {
    status: 429, headers: { 'Retry-After': '17' },
  });
  for (const [env, expectedDelay, message] of [
    [limited.env, '60', /Trop de demandes/],
    [fakeChatBindings({ answer: dailyLimit }).env, /^\d+$/, /Quota gratuit/],
    [fakeChatBindings({ answer: globalLimit }).env, '17', /Limite du service/],
  ]) {
    const response = await postChat(env);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('Access-Control-Expose-Headers'), 'Retry-After');
    const delay = response.headers.get('Retry-After');
    if (typeof expectedDelay === 'string') assert.equal(delay, expectedDelay);
    else assert.match(delay, expectedDelay);
    assert.match((await response.json()).error.message, message);
  }
  assert.deepEqual(limited.calls, []);
});

test('discussion : indisponibilité et réponse invalide restent des erreurs 503 sans détail interne', async () => {
  for (const env of [
    {},
    fakeChatBindings({ answer: () => { throw new Error('détail interne'); } }).env,
    fakeChatBindings({ answer: () => Response.json(null) }).env,
    fakeChatBindings({ answer: () => Response.json({ internalCode: 3040 }, { status: 429 }) }).env,
  ]) {
    const response = await postChat(env);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: { message: 'Le service IA est temporairement indisponible. Réessaie plus tard.' } });
  }
});
