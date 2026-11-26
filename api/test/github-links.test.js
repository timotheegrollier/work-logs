import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGithubReader, createGithubRepoReader } from '../src/github-links.js';
import { normalizeGithubRepo } from '../src/github-repo.js';

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
    // Ce que renvoie vraiment execFile : `code` est le code de sortie de gh.
    [Object.assign(new Error('Command failed: gh api'), { code: 1, stderr: 'gh: Not Found (HTTP 404)' }), 'GITHUB_NOT_FOUND'],
    [Object.assign(new Error('Command failed: gh api'), { code: 1, stderr: 'gh: Resource protected (HTTP 403)' }), 'GITHUB_FORBIDDEN'],
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

test('un dépôt relié accepte propriétaire/dépôt ou son lien et refuse le reste', () => {
  assert.equal(normalizeGithubRepo(' Murgat-Ingenierie/deployer '), 'Murgat-Ingenierie/deployer');
  assert.equal(normalizeGithubRepo('https://github.com/Murgat-Ingenierie/deployer.git'), 'Murgat-Ingenierie/deployer');
  assert.equal(normalizeGithubRepo('https://github.com/a/b/tree/main/docs'), 'a/b');
  assert.equal(normalizeGithubRepo(''), null);
  assert.equal(normalizeGithubRepo(null), null);
  for (const value of ['a', 'a/b/c', 'a/..', 'https://evil.example/a/b', 'https://github.com/a', 'a/b c', 42]) {
    assert.throws(() => normalizeGithubRepo(value), { code: 'GITHUB_INVALID_REPO', status: 400 }, value);
  }
});

function listFixture(responses) {
  const calls = [];
  const list = createGithubRepoReader({ execFile: async (file, args, options) => {
    assert.equal(file, 'gh');
    assert.equal(options.env.GH_PROMPT_DISABLED, '1');
    calls.push(args[5]);
    const response = responses[calls.length - 1];
    if (response instanceof Error) throw response;
    return { stdout: JSON.stringify(response) };
  } });
  return { list, calls };
}

test('les rubriques d’un dépôt relié sont lues en lecture seule et bornées', async () => {
  const { list, calls } = listFixture([
    [{ id: 1, number: 7, title: 'Ajoute le déploiement', html_url: 'https://github.com/a/b/pull/7', state: 'closed', merged_at: '2026-11-20', user: { login: 'timo' }, updated_at: '2026-11-21T10:00:00Z', head: { ref: 'feat' } },
      { id: 2, number: 8, title: 'Brouillon', html_url: 'https://evil.example/pull/8', state: 'open', draft: true, user: null, updated_at: '2026-11-22T10:00:00Z', head: { ref: 'wip' } }],
    [{ id: 3, number: 9, title: 'Bug', html_url: 'https://github.com/a/b/issues/9', state: 'open', user: { login: 'ana' }, updated_at: '2026-11-19T08:00:00Z' },
      { id: 4, number: 10, title: 'PR déguisée', pull_request: {}, state: 'open' }],
    { workflow_runs: [{ id: 5, run_number: 12, display_title: 'CI', html_url: 'https://github.com/a/b/actions/runs/5', conclusion: 'failure', actor: { login: 'timo' }, created_at: '2026-11-18T09:00:00Z', head_branch: 'main' }, { id: 6, run_number: 13, name: 'Tests', status: 'in_progress', conclusion: null }] },
    [{ sha: 'abc123', commit: { message: 'Corrige le rapport\n\nDétails', author: { name: 'Timo', date: '2026-11-17T07:00:00Z' } }, html_url: 'https://github.com/a/b/commit/abc123', author: { login: 'timo' } }],
    [{ id: 8, name: '', tag_name: 'v1.2.0', html_url: 'https://github.com/a/b/releases/tag/v1.2.0', draft: false, prerelease: true, author: { login: 'timo' }, published_at: '2026-11-16T06:00:00Z' }],
  ]);
  const pulls = await list('a/b', 'pulls');
  assert.deepEqual(pulls, { repo: 'a/b', section: 'pulls', items: [
    { id: '1', number: 7, title: 'Ajoute le déploiement', url: 'https://github.com/a/b/pull/7', state: 'fusionnée', author: 'timo', date: '2026-11-21T10:00:00Z', ref: 'feat' },
    { id: '2', number: 8, title: 'Brouillon', url: null, state: 'brouillon', author: null, date: '2026-11-22T10:00:00Z', ref: 'wip' },
  ] });
  assert.match(calls[0], /^\/repos\/a\/b\/pulls\?state=all/);
  assert.equal((await list('a/b', 'issues')).items.length, 1);
  assert.deepEqual((await list('a/b', 'actions')).items.map((run) => [run.title, run.state, run.ref]), [['CI', 'échouée', 'main'], ['Tests', 'en cours', null]]);
  assert.deepEqual((await list('a/b', 'commits')).items, [{ id: 'abc123', number: null, title: 'Corrige le rapport', url: 'https://github.com/a/b/commit/abc123', state: null, author: 'timo', date: '2026-11-17T07:00:00Z', ref: null }]);
  assert.deepEqual((await list('a/b', 'releases')).items, [{ id: '8', number: null, title: 'v1.2.0', url: 'https://github.com/a/b/releases/tag/v1.2.0', state: 'préversion', author: 'timo', date: '2026-11-16T06:00:00Z', ref: 'v1.2.0' }]);
  assert.equal(calls.length, 5);
});

test('une rubrique inconnue ou un dépôt invalide est refusé avant gh', async () => {
  const { list, calls } = listFixture([]);
  await assert.rejects(list('a/b', 'secrets'), { code: 'GITHUB_UNKNOWN_SECTION', status: 404 });
  await assert.rejects(list('a/b/../c', 'pulls'), { code: 'GITHUB_INVALID_REPO', status: 400 });
  assert.deepEqual(calls, []);
});

test('les erreurs GitHub de la lecture par dépôt gardent leur code sans fuite de jeton', async () => {
  const { list } = listFixture([Object.assign(new Error('secret'), { stderr: 'HTTP 404 ghp_secret' })]);
  await assert.rejects(list('a/b', 'pulls'), (failure) => failure.code === 'GITHUB_NOT_FOUND' && !failure.message.includes('ghp_secret'));
});
