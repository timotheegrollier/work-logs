import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGithubReader } from '../src/github-links.js';

const address = 'https://github.com/Murgat-Ingenierie/deployer';
const metadata = { private: true, description: 'Déploiement des postes', default_branch: 'main' };
const textFile = (text, path = 'README.md') => ({ type: 'file', path, encoding: 'base64', size: Buffer.byteLength(text), content: Buffer.from(text).toString('base64') });
const missing = () => Object.assign(new Error('gh: Not Found (HTTP 404)'), { stderr: 'gh: Not Found (HTTP 404)' });

function fixture(responses) {
  const calls = [];
  const read = createGithubReader({ execFile: async (file, args, options) => {
    assert.equal(file, 'gh');
    assert.deepEqual(args.slice(0, 5), ['api', '--hostname', 'github.com', '--method', 'GET']);
    assert.equal(options.timeout, 10_000);
    assert.equal(options.maxBuffer, 2 * 1024 * 1024);
    assert.equal(options.env.GH_PROMPT_DISABLED, '1');
    calls.push(args[5]);
    const response = responses[calls.length - 1];
    if (response instanceof Error) throw response;
    assert.notEqual(response, undefined, `appel inattendu ${args[5]}`);
    return { stdout: JSON.stringify(response) };
  } });
  return { read, calls };
}

test('GitHub lit un dépôt privé avec le compte local, son README et une liste bornée', async () => {
  const files = Array.from({ length: 100 }, (_, index) => ({ name: `document-${index}.md`, type: 'file' }));
  const { read, calls } = fixture([metadata, files, textFile('Consignes privées\n' + 'x'.repeat(10_000))]);
  const result = await read(address + '.git');
  assert.equal(result.private, true);
  assert.equal(result.url, address + '.git');
  assert.match(result.text, /Dépôt Murgat-Ingenierie\/deployer \(privé\)/);
  assert.match(result.text, /Consignes privées/);
  assert.match(result.text, /60 éléments affichés sur 100/);
  assert.doesNotMatch(result.text, /document-60\.md/);
  assert.ok(result.text.length <= 16_000);
  assert.match(result.text, /Extrait tronqué/);
  assert.deepEqual(calls, ['/repos/Murgat-Ingenierie/deployer', '/repos/Murgat-Ingenierie/deployer/contents?ref=main', '/repos/Murgat-Ingenierie/deployer/readme?ref=main']);
});

test('GitHub rend le contexte du dépôt lorsque ce dossier ne possède aucun README', async () => {
  const { read } = fixture([{ ...metadata, private: false }, [{ type: 'dir', name: 'src' }], missing()]);
  const result = await read(address);
  assert.equal(result.private, false);
  assert.match(result.text, /Dossier "src"/);
  assert.match(result.text, /Aucun README trouvé/);
});

test('GitHub résout une branche contenant une barre oblique avant de lire un fichier', async () => {
  const { read, calls } = fixture([metadata, [{ ref: 'refs/heads/feature' }, { ref: 'refs/heads/feature/deploy' }], textFile('const version = 4;\n', 'src/app.js')]);
  const result = await read(address + '/blob/feature/deploy/src/app.js#L1');
  assert.match(result.text, /Fichier src\/app.js, référence feature\/deploy/);
  assert.match(result.text, /const version = 4/);
  assert.equal(calls.at(-1), '/repos/Murgat-Ingenierie/deployer/contents/src/app.js?ref=feature%2Fdeploy');
});

test('GitHub lit un dossier depuis une étiquette et n’annonce que les fichiers réellement lus', async () => {
  const { read, calls } = fixture([metadata, [], [{ ref: 'refs/tags/v1.2' }], [{ name: 'guide.md', type: 'file' }], textFile('Manuel du déploiement', 'docs/README.md')]);
  const result = await read(address + '/tree/v1.2/docs');
  assert.equal(calls.at(-2), '/repos/Murgat-Ingenierie/deployer/contents/docs?ref=v1.2');
  assert.equal(calls.at(-1), '/repos/Murgat-Ingenierie/deployer/readme/docs?ref=v1.2');
  assert.match(result.text, /noms uniquement/);
  assert.match(result.text, /Manuel du déploiement/);
});

test('GitHub accepte une référence explicitement encodée et un commit sans recherche de branches', async () => {
  for (const [ref, expected] of [['feature%2Fdeploy', 'feature%2Fdeploy'], ['12abcdef', '12abcdef']]) {
    const { read, calls } = fixture([metadata, textFile('version = 1', 'config.ini')]);
    await read(address + `/blob/${ref}/config.ini?plain=1`);
    assert.equal(calls.at(-1), `/repos/Murgat-Ingenierie/deployer/contents/config.ini?ref=${expected}`);
    assert.equal(calls.length, 2);
  }
});

test('GitHub refuse les destinations et chemins non pris en charge avant toute commande', async () => {
  const { read, calls } = fixture([]);
  for (const url of [undefined, 'http://github.com/a/b', 'https://github.com.attacker.example/a/b', 'https://user:token@github.com/a/b',
    'https://github.com:444/a/b', 'https://github.com/a/b/issues/1', 'https://github.com/a/b/blob/main',
    'https://github.com/a/b/blob/main/%2E%2E%2Fx', 'https://github.com/a/b/blob/main/%00test', 'https://github.com/a/b/blob/main/x\\test']) {
    await assert.rejects(read(url), { status: 400 });
  }
  assert.deepEqual(calls, []);
});

test('GitHub refuse les fichiers binaires et trop volumineux', async () => {
  for (const [content, code] of [[textFile('\x00\x01binaire'), 'GITHUB_UNREADABLE'],
    [textFile('x'.repeat(128 * 1024 + 1)), 'GITHUB_TOO_LARGE'],
    [{ type: 'file', encoding: 'none', content: '' }, 'GITHUB_UNREADABLE']]) {
    const { read } = fixture([metadata, content]);
    await assert.rejects(read(address + '/blob/12abcdef/file'), { code });
  }
});

test('GitHub traduit les refus et les limites sans exposer les sorties de la commande', async () => {
  for (const [cause, code] of [
    [Object.assign(new Error('missing'), { code: 'ENOENT' }), 'GITHUB_UNAVAILABLE'],
    [Object.assign(new Error('gh auth login ghp_secret'), { stderr: 'gh auth login ghp_secret' }), 'GITHUB_AUTH_REQUIRED'],
    [missing(), 'GITHUB_NOT_FOUND'],
    [Object.assign(new Error('secret'), { stderr: 'HTTP 403 ghp_secret' }), 'GITHUB_FORBIDDEN'],
    [Object.assign(new Error('secret'), { killed: true }), 'GITHUB_TIMEOUT'],
    [Object.assign(new Error('secret'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }), 'GITHUB_TOO_LARGE'],
    [new Error('ghp_secret'), 'GITHUB_READ_FAILED'],
  ]) {
    const { read } = fixture([cause]);
    await assert.rejects(read(address), (failure) => failure.code === code && !failure.message.includes('ghp_secret'));
  }
});

test('GitHub arrête la commande lorsque la demande est annulée', async () => {
  const controller = new AbortController();
  let started;
  const pending = new Promise((resolve) => { started = resolve; });
  const read = createGithubReader({ execFile: (_file, _args, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('arrêt'), { name: 'AbortError' })), { once: true });
    started();
  }) });
  const result = read(address, { signal: controller.signal });
  await pending;
  controller.abort();
  await assert.rejects(result, { code: 'GITHUB_TIMEOUT' });
});
