import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker, { AiUsage } from './worker.mjs';
import { applyEvent, geminiRefusal, nextReset, pickGemini, quotaDay, rateRefusal } from './ai-engines.mjs';

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
  const configured = await worker.fetch(new Request('https://relais.test/token'), ENV);
  assert.deepEqual(await configured.json(), { ok: true, configured: true });
  const empty = await worker.fetch(new Request('https://relais.test/token'), {});
  assert.deepEqual(await empty.json(), { ok: true, configured: false });
});

test('plus de front sur le Worker : chaque page renvoie vers la même page de GitHub Pages', async () => {
  for (const [path, target] of [
    ['/', 'https://timotheegrollier.github.io/work-logs/'],
    ['/confidentialite.html', 'https://timotheegrollier.github.io/work-logs/confidentialite.html'],
    ['/?code=abc&state=x', 'https://timotheegrollier.github.io/work-logs/?code=abc&state=x'],
  ]) {
    for (const method of ['GET', 'HEAD']) {
      const response = await worker.fetch(new Request('https://relais.test' + path, { method }), ENV);
      assert.equal(response.status, 301);
      assert.equal(response.headers.get('Location'), target);
    }
  }
  // Les routes du relais et de l'IA ne sont pas redirigées.
  const post = await worker.fetch(new Request('https://relais.test/', { method: 'POST', headers: { Origin: PWA } }), ENV);
  assert.equal(post.status, 404);
  const ai = await worker.fetch(new Request('https://relais.test/ai/chat/completions', { headers: { Origin: PWA } }), ENV);
  assert.equal(ai.status, 405);
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
  assert.deepEqual(await response.json(), { model: CHAT_MODEL, ...CHAT_ANSWER });
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

// ── Gemini Flash avec la clé du Worker, compteur partagé et `/ai/status` (décision §98) ──

const STATUS_PATH = 'https://relais.test/ai/status';
const GEMINI_CHAT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const geminiAnswer = (model = 'gemini-3.5-flash-lite', content = '{"reply":"ok"}') => Response.json({
  model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
});

/** Objet durable en mémoire : la vraie classe, un stockage simulé. */
function fakeUsage() {
  const data = new Map();
  const object = new AiUsage({ storage: {
    get: async (key) => structuredClone(data.get(key)),
    put: async (key, value) => { data.set(key, structuredClone(value)); },
  } });
  return { idFromName: (name) => name, get: () => ({ fetch: (url, init) => object.fetch(new Request(url, init)) }) };
}

/** Google simulé : chaque appel noté (adresse, en-têtes, corps JSON), réponses jouées dans l'ordre. */
function stubGemini(...answers) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: new Headers(init.headers), body: init.body ? JSON.parse(init.body) : null });
    const next = answers.length > 1 ? answers.shift() : answers[0];
    return next(String(url));
  };
  return calls;
}

function geminiEnv(gemma = fakeChatBindings()) {
  return { ...gemma, env: { ...gemma.env, GEMINI_API_KEY: 'cle-gemini-test', AI_USAGE: fakeUsage() } };
}

const status = async (env, origin = PWA) => (await worker.fetch(new Request(STATUS_PATH, { headers: { Origin: origin } }), env)).json();
const quota429 = (quotaId, value, retry = '17s') => Response.json([{ error: {
  code: 429, status: 'RESOURCE_EXHAUSTED', message: `Quota exceeded for metric: generate_content_free_tier_requests, limit: ${value}`,
  details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId, quotaValue: String(value) }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: retry },
  ],
} }], { status: 429 });

test('Gemini : la clé reste dans le Worker, sans température, et le modèle qui a répondu revient au client', async () => {
  const { env, calls: gemma } = geminiEnv();
  const google = stubGemini(() => geminiAnswer());
  const response = await postChat(env, { body: JSON.stringify({
    temperature: 0.3, max_tokens: 900, response_format: { type: 'json_object' }, messages: CHAT_REQUEST.messages,
  }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.model, 'gemini-3.5-flash-lite');
  assert.equal(body.choices[0].message.content, '{"reply":"ok"}');
  assert.equal(google.length, 1);
  assert.equal(google[0].url, GEMINI_CHAT);
  assert.equal(google[0].headers.get('Authorization'), 'Bearer cle-gemini-test');
  assert.deepEqual(google[0].body, {
    model: 'gemini-flash-lite-latest', messages: CHAT_REQUEST.messages, max_tokens: 900,
    reasoning_effort: 'low', response_format: { type: 'json_object' },
  });
  assert.deepEqual(gemma, []);
  const view = await status(env);
  assert.equal(view.gemini_configured, true);
  assert.deepEqual(view.models.map((m) => m.id), ['gemini-flash-lite-latest', 'gemini-flash-latest', CHAT_MODEL]);
  assert.deepEqual(view.models[0].today, { requests: 1, input_tokens: 120, output_tokens: 30 });
  assert.equal(view.models[0].resolved, 'gemini-3.5-flash-lite');
  assert.equal(view.models[0].last_minute, 1);
});

test('Gemini : quota du jour cité par Google → Flash, limite retenue, Flash-Lite écarté jusqu’à minuit (Pacifique)', async () => {
  const { env } = geminiEnv();
  const google = stubGemini(() => quota429('GenerateRequestsPerDayPerProjectPerModel-FreeTier', 20), () => geminiAnswer('gemini-3.8-flash'));
  const first = await postChat(env);
  assert.equal((await first.json()).model, 'gemini-3.8-flash');
  assert.deepEqual(google.map((c) => c.body.model), ['gemini-flash-lite-latest', 'gemini-flash-latest']);
  const view = await status(env);
  const lite = view.models[0];
  assert.equal(lite.blocked_reason, 'quota du jour atteint');
  assert.equal(Date.parse(lite.blocked_until), nextReset('google', Date.parse(view.updated_at)));
  assert.equal(lite.limits.requests_per_day.value, 20);
  assert.equal(view.models[1].today.requests, 1);
  // Demande suivante : Flash-Lite n'est plus essayé avant minuit.
  google.length = 0;
  await postChat(env);
  assert.deepEqual(google.map((c) => c.body.model), ['gemini-flash-latest']);
});

test('Gemini : limite par minute, clé refusée et refus d’une demande mènent à Gemma, avec le motif affiché', async () => {
  const { env, calls: gemma } = geminiEnv();
  stubGemini(
    () => quota429('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', 15, '17.2s'),
    () => Response.json({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } }, { status: 400 }),
  );
  const response = await postChat(env);
  assert.equal((await response.json()).model, CHAT_MODEL);
  assert.equal(gemma.length, 1);
  const before = Date.now();
  const [lite, flash, cloudflare] = (await status(env)).models;
  assert.equal(lite.blocked_reason, 'limite par minute atteinte');
  assert.ok(Date.parse(lite.blocked_until) - before <= 18_000 && Date.parse(lite.blocked_until) - before > 15_000);
  assert.equal(lite.limits.requests_per_minute.value, 15);
  assert.equal(flash.blocked_reason, 'clé Gemini refusée');
  assert.equal(cloudflare.today.requests, 1);
  assert.deepEqual(cloudflare.neurons, { used: 0, limit: 10_000 });

  // Refus propre à une demande : noté, le modèle reste disponible pour la suivante.
  const other = geminiEnv();
  const google = stubGemini(() => Response.json({ error: { code: 400, message: 'Invalid image' } }, { status: 400 }));
  await postChat(other.env);
  await postChat(other.env);
  assert.equal(google.filter((c) => c.body.model === 'gemini-flash-lite-latest').length, 2);
  assert.equal((await status(other.env)).models[0].last_error.reason, 'demande refusée par Google (400)');

  // Panne de Google : le code et le statut s'affichent, le modèle est écarté une minute.
  const overloaded = geminiEnv();
  stubGemini(() => Response.json([{ error: { code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded.' } }], { status: 503 }));
  await postChat(overloaded.env);
  const [lite503] = (await status(overloaded.env)).models;
  assert.equal(lite503.blocked_reason, 'Google indisponible (503 UNAVAILABLE)');

  // Trop lent : écarté 5 min, Flash répond tout de suite.
  const slow = geminiEnv();
  stubGemini(() => { throw new DOMException('délai dépassé', 'TimeoutError'); }, () => geminiAnswer('gemini-flash-latest'));
  assert.equal((await (await postChat(slow.env)).json()).model, 'gemini-flash-latest');
  const [late] = (await status(slow.env)).models;
  assert.equal(late.blocked_reason, 'Google trop lent (plus de 20 s)');
  const away = Date.parse(late.blocked_until) - Date.now();
  assert.ok(away > 4.9 * 60_000 && away <= 5 * 60_000);
});

// ── Mistral puis Groq avant Gemini (décision §100) ──

const MISTRAL_CHAT = 'https://api.mistral.ai/v1/chat/completions';
const GROQ_CHAT = 'https://api.groq.com/openai/v1/chat/completions';
function allKeysEnv() {
  const base = geminiEnv();
  return { ...base, env: { ...base.env, MISTRAL_API_KEY: 'cle-mistral-test', GROQ_API_KEY: 'cle-groq-test' } };
}

test('Mistral répond en premier avec sa clé, sans réflexion ; l’ordre complet s’affiche', async () => {
  const { env, calls: gemma } = allKeysEnv();
  const calls = stubGemini(() => geminiAnswer('mistral-medium-2508'));
  const body = await (await postChat(env, { body: JSON.stringify({ ...CHAT_REQUEST, reasoning_effort: 'medium', response_format: { type: 'json_object' } }) })).json();
  assert.equal(body.model, 'mistral-medium-2508');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, MISTRAL_CHAT);
  assert.equal(calls[0].headers.get('Authorization'), 'Bearer cle-mistral-test');
  assert.deepEqual(calls[0].body, { model: 'mistral-medium-latest', messages: CHAT_REQUEST.messages, max_tokens: 1024, response_format: { type: 'json_object' } });
  assert.deepEqual(gemma, []);
  const view = await status(env);
  assert.deepEqual(view.models.map((m) => m.id), [
    'mistral-medium-latest', 'mistral-small-latest', 'openai/gpt-oss-120b', 'llama-3.3-70b-versatile',
    'gemini-flash-lite-latest', 'gemini-flash-latest', CHAT_MODEL,
  ]);
  assert.deepEqual(view.missing_providers, []);
  assert.equal(view.models[0].provider, 'mistral');
  assert.equal(view.models[0].resolved, 'mistral-medium-2508');
  assert.equal(view.models[0].today.requests, 1);
});

test('Mistral au quota → Groq : réflexion pour GPT-OSS seulement, limite et délai cités par Groq retenus', async () => {
  const { env } = allKeysEnv();
  const mistral429 = () => Response.json({ message: 'Requests rate limit exceeded' }, { status: 429, headers: { 'Retry-After': '30' } });
  const groqDaily = () => Response.json({ error: {
    message: 'Rate limit reached for model `openai/gpt-oss-120b` on tokens per day (TPD): Limit 200000, Used 199500, Requested 1500. Please try again in 7m30.5s.',
    type: 'tokens', code: 'rate_limit_exceeded',
  } }, { status: 429 });
  const calls = stubGemini(mistral429, mistral429, groqDaily, () => geminiAnswer('llama-3.3-70b-versatile'));
  const before = Date.now();
  assert.equal((await (await postChat(env, { body: JSON.stringify({ ...CHAT_REQUEST, reasoning_effort: 'medium' }) })).json()).model, 'llama-3.3-70b-versatile');
  assert.deepEqual(calls.map((c) => [c.url, c.body.model, c.body.reasoning_effort]), [
    [MISTRAL_CHAT, 'mistral-medium-latest', undefined], [MISTRAL_CHAT, 'mistral-small-latest', undefined],
    [GROQ_CHAT, 'openai/gpt-oss-120b', 'medium'], [GROQ_CHAT, 'llama-3.3-70b-versatile', undefined],
  ]);
  assert.equal(calls[2].headers.get('Authorization'), 'Bearer cle-groq-test');
  const [medium, , oss, llama] = (await status(env)).models;
  assert.equal(medium.blocked_reason, 'limite par minute atteinte');
  assert.ok(Math.abs(Date.parse(medium.blocked_until) - before - 30_000) < 2_000);
  assert.equal(oss.blocked_reason, 'quota du jour atteint');
  assert.ok(Math.abs(Date.parse(oss.blocked_until) - before - 451_000) < 2_000);
  assert.deepEqual(oss.limits.tokens_per_day.value, 200000);
  assert.equal(llama.today.requests, 1);
  assert.equal(llama.provider, 'groq');
});

test('Groq : demande trop longue (413) sautée sans écarter le modèle ; clé refusée écartée 1 h ; sans clé, rien n’est appelé', async () => {
  const { env } = allKeysEnv();
  const tooLarge = () => Response.json({ error: { message: 'Request too large for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000, Requested 9500' } }, { status: 413 });
  const refused = () => Response.json({ error: { message: 'Invalid API Key', code: 'invalid_api_key' } }, { status: 401 });
  const calls = stubGemini(() => new Response('{}', { status: 503 }), () => new Response('{}', { status: 503 }), tooLarge, refused, () => geminiAnswer());
  await postChat(env);
  assert.deepEqual(calls.map((c) => c.body.model), ['mistral-medium-latest', 'mistral-small-latest', 'openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'gemini-flash-lite-latest']);
  const [medium, , oss, llama] = (await status(env)).models;
  assert.equal(medium.blocked_reason, 'Mistral indisponible (503)');
  assert.equal(oss.blocked_until, null);
  assert.equal(oss.last_error.reason, 'demande trop longue pour Groq (413)');
  assert.equal(llama.blocked_reason, 'clé Groq refusée');

  const geminiOnly = geminiEnv();
  const google = stubGemini(() => geminiAnswer());
  await postChat(geminiOnly.env);
  assert.deepEqual(google.map((c) => c.url), [GEMINI_CHAT]);
  assert.deepEqual((await status(geminiOnly.env)).missing_providers, ['Mistral', 'Groq']);
});

test('budget borné : un modèle qui traîne laisse Gemma répondre avant que l’app abandonne', async () => {
  const { env, calls: gemma } = allKeysEnv();
  const realNow = Date.now;
  let shift = 0;
  Date.now = () => realNow() + shift;
  try {
    const urls = [];
    // Mistral Medium épuise presque tout le budget : plus aucun autre modèle à clé n'est essayé.
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      shift += 19_000;
      throw new DOMException('délai dépassé', 'TimeoutError');
    };
    assert.equal((await (await postChat(env)).json()).model, CHAT_MODEL);
    assert.deepEqual(urls, [MISTRAL_CHAT]);
    assert.equal(gemma.length, 1);
    const [medium] = (await status(env)).models;
    assert.equal(medium.blocked_reason, 'Mistral trop lent (plus de 20 s)');
  } finally {
    Date.now = realNow;
  }
});

test('pannes passagères : écart doublé à chaque échec d’affilée, une heure au plus, remis à zéro au succès', () => {
  const now = Date.parse('2026-11-24T12:00:00Z');
  const state = { models: {}, catalog: null };
  const fail = () => applyEvent(state, { type: 'blocked', model: 'gemini-3.8-flash', provider: 'google', backoff: 60_000, reason: 'Google indisponible (503 UNAVAILABLE)' }, now);
  const away = () => (state.models['gemini-3.8-flash'].blocked_until - now) / 60_000;
  fail(); assert.equal(away(), 1);
  fail(); assert.equal(away(), 2);
  fail(); assert.equal(away(), 4);
  for (let i = 0; i < 6; i++) fail();
  assert.equal(away(), 60);
  applyEvent(state, { type: 'success', model: 'gemini-3.8-flash', provider: 'google' }, now);
  fail(); assert.equal(away(), 1);
  // Un quota du jour garde son échéance exacte, sans doublement.
  applyEvent(state, { type: 'blocked', model: 'gemini-3.8-flash', provider: 'google', until: now + 7_200_000, reason: 'quota du jour atteint' }, now);
  assert.equal(away(), 120);
});

test('Gemma aussi au bout de son quota : 429 avec l’heure de retour, sans appeler personne', async () => {
  const dailyLimit = () => Response.json({ internalCode: 3036 }, { status: 429 });
  const { env, calls: gemma } = geminiEnv(fakeChatBindings({ answer: dailyLimit }));
  stubGemini(() => quota429('GenerateRequestsPerDayPerProjectPerModel-FreeTier', 20));
  assert.equal((await postChat(env)).status, 429);
  assert.equal(gemma.length, 1);
  const google = stubGemini(() => geminiAnswer());
  const blocked = await postChat(env);
  assert.equal(blocked.status, 429);
  assert.match((await blocked.json()).error.message, /Quotas gratuits atteints\. L’IA revient vers \d\d:\d\d\./);
  assert.ok(Number(blocked.headers.get('Retry-After')) > 0);
  assert.deepEqual(google, []);
  assert.equal(gemma.length, 1);
});

test('/ai/status : catalogue relu avec la clé, sans elle seul Gemma, et réservé aux clients WorkLogs', async () => {
  const { env } = geminiEnv();
  const google = stubGemini(() => Response.json({ models: [
    { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', version: '3.8', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.10-flash-lite', displayName: 'Gemini 3.10 Flash-Lite', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.8-flash-lite', displayName: 'Gemini 3.8 Flash-Lite', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/text-embedding-9', supportedGenerationMethods: ['embedContent'] },
  ] }));
  const view = await status(env, DESKTOP);
  assert.equal(google[0].url, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000');
  assert.equal(google[0].headers.get('x-goog-api-key'), 'cle-gemini-test');
  assert.deepEqual(view.models.map((m) => [m.id, m.label]), [
    ['gemini-3.10-flash-lite', 'Gemini 3.10 Flash-Lite'], ['gemini-3.8-flash', 'Gemini 3.8 Flash'],
    [CHAT_MODEL, 'Gemma 4 26B (Cloudflare Workers AI)'],
  ]);
  assert.ok(view.catalog_checked_at);
  // Relu au plus toutes les 6 h : un second affichage n'appelle pas Google.
  await status(env);
  assert.equal(google.length, 1);
  // Le catalogue lu décide aussi des modèles essayés.
  stubGemini(() => geminiAnswer('gemini-3.10-flash-lite'));
  await postChat(env);
  assert.equal((await status(env)).models[0].today.requests, 1);

  const keyless = await status({ AI_USAGE: fakeUsage() });
  assert.equal(keyless.gemini_configured, false);
  assert.deepEqual(keyless.models.map((m) => m.id), [CHAT_MODEL]);
  const denied = await worker.fetch(new Request(STATUS_PATH, { headers: { Origin: 'https://pirate.example' } }), env);
  assert.equal(denied.status, 403);
  const preflight = await worker.fetch(new Request(STATUS_PATH, { method: 'OPTIONS', headers: { Origin: DESKTOP } }), env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), DESKTOP);
});

test('quotas : jour du Pacifique pour Google, UTC pour Cloudflare ; refus 429 lu dans le corps ou le message', () => {
  const now = Date.parse('2026-11-24T07:30:00Z'); // 23 h 30 la veille à Los Angeles
  assert.equal(quotaDay('google', now), '2026-11-23');
  assert.equal(quotaDay('cloudflare', now), '2026-11-24');
  assert.equal(new Date(nextReset('google', now)).toISOString(), '2026-11-24T08:00:00.000Z');
  assert.equal(new Date(nextReset('cloudflare', now)).toISOString(), '2026-11-25T00:00:00.000Z');
  assert.deepEqual(geminiRefusal({ error: { message: 'Quota exceeded for metric: input_token_count, limit: 250000. Please retry in 41.5s.' } }),
    { kind: 'tokens_per_minute', value: 250000, retrySeconds: 42 });
  assert.deepEqual(geminiRefusal([{ error: { details: [{ violations: [{ quotaId: 'GenerateContentInputTokensPerModelPerDay-FreeTier', quotaValue: '1000000' }] }] } }]),
    { kind: 'tokens_per_day', value: 1000000, retrySeconds: null });
  assert.deepEqual(rateRefusal(new Headers(), { error: { message: 'on requests per minute (RPM): Limit 30, Used 30. Please try again in 1m2.5s.' } }),
    { kind: 'requests_per_minute', value: 30, retrySeconds: 63, daily: false });
  assert.deepEqual(rateRefusal(new Headers({ 'Retry-After': '12' }), { message: 'Requests rate limit exceeded' }),
    { kind: null, value: null, retrySeconds: 12, daily: false });
  const generate = ['generateContent'];
  assert.deepEqual(pickGemini([{ name: 'models/gemini-flash-latest', displayName: 'Gemini Flash Latest', supportedGenerationMethods: generate }]),
    [{ id: 'gemini-flash-latest', label: 'Gemini Flash Latest', version: null }]);
  // Une version stable passe avant l'alias, que Google déconseille en production.
  assert.deepEqual(pickGemini([
    { name: 'models/gemini-flash-latest', supportedGenerationMethods: generate },
    { name: 'models/gemini-3.6-flash', displayName: 'Gemini 3.6 Flash', supportedGenerationMethods: generate },
    { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: generate },
    { name: 'models/gemini-flash-lite-latest', displayName: 'Gemini Flash-Lite Latest', supportedGenerationMethods: generate },
  ]).map(({ id }) => id), ['gemini-flash-lite-latest', 'gemini-3.8-flash']);
});

test('Gemini : l’effort de réflexion demandé est transmis, borné, et jamais envoyé à Gemma', async () => {
  const { env, calls: gemma } = geminiEnv();
  const google = stubGemini(() => geminiAnswer());
  await postChat(env, { body: JSON.stringify({ ...CHAT_REQUEST, reasoning_effort: 'medium' }) });
  await postChat(env, { body: JSON.stringify({ ...CHAT_REQUEST, reasoning_effort: 'maximal' }) });
  assert.deepEqual(google.map((c) => c.body.reasoning_effort), ['medium', 'low']);
  const keyless = fakeChatBindings();
  await postChat(keyless.env, { body: JSON.stringify({ ...CHAT_REQUEST, reasoning_effort: 'high' }) });
  assert.equal('reasoning_effort' in keyless.calls[0].params, false);
  assert.deepEqual(gemma, []);
});
