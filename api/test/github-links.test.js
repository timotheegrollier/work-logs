import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGithubPullReader, createGithubReader, createGithubRepoReader } from '../src/github-links.js';
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
  const execFile = async (file, args, options) => {
    assert.equal(file, 'gh');
    assert.equal(options.env.GH_PROMPT_DISABLED, '1');
    assert.equal(options.env.GH_TOKEN, 'fake-local-account-token');
    calls.push(args);
    const response = responses[calls.length - 1];
    if (response instanceof Error) throw response;
    assert.notEqual(response, undefined, `appel inattendu ${args[5]}`);
    return { stdout: JSON.stringify(response) };
  };
  const options = { execFile, auth: async () => ({ GH_TOKEN: 'fake-local-account-token' }) };
  return { list: createGithubRepoReader(options), pull: createGithubPullReader(options), calls };
}

test('les rubriques d’un dépôt relié sont lues en lecture seule et bornées', async () => {
  const { list, calls } = listFixture([
    { data: { repository: { pullRequests: { nodes: [
      { id: 'PR_7', number: 7, title: 'Ajoute le déploiement', url: 'https://github.com/a/b/pull/7', state: 'MERGED',
        author: { login: 'timo' }, updatedAt: '2026-11-21T10:00:00Z', headRefName: 'feat', baseRefName: 'main', headRefOid: 'f'.repeat(40),
        labels: { nodes: [{ name: 'API', color: 'a1b2c3' }, { name: 'Important', color: '#bad' }, { name: '', color: 'a1b2c3' }] },
        assignees: { nodes: [{ login: 'ana' }, null] }, reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN',
        statusCheckRollup: { state: 'SUCCESS' }, comments: { totalCount: 2 }, changedFiles: 5, additions: 33, deletions: 8 },
      { id: 'PR_8', number: 8, title: 'Brouillon', url: 'https://evil.example/pull/8', state: 'OPEN', isDraft: true,
        updatedAt: '2026-11-22T10:00:00Z', headRefName: 'wip', statusCheckRollup: { state: 'PENDING' } },
      ...Array.from({ length: 30 }, (_, index) => ({ id: `PR_${index + 20}`, number: index + 20, state: 'CLOSED' })),
    ] } } } },
    [{ id: 3, number: 9, title: 'Bug', html_url: 'https://github.com/a/b/issues/9', state: 'open', user: { login: 'ana' },
      updated_at: '2026-11-19T08:00:00Z', labels: [{ name: 'bug', color: 'abcdef' }], assignees: [{ login: 'li' }], comments: 4 },
      { id: 4, number: 10, title: 'PR déguisée', pull_request: {}, state: 'open' }],
    { workflow_runs: [{ id: 5, run_number: 12, display_title: 'CI', name: 'Validation', html_url: 'https://github.com/a/b/actions/runs/5',
      status: 'completed', conclusion: 'failure', actor: { login: 'timo' }, created_at: '2026-11-18T09:00:00Z', head_branch: 'main', event: 'push' },
    { id: 6, run_number: 13, name: 'Tests', status: 'in_progress', conclusion: null }] },
    [{ sha: 'abc123', commit: { message: 'Corrige le rapport\n\nDétails', author: { name: 'Timo', date: '2026-11-17T07:00:00Z' } }, html_url: 'https://github.com/a/b/commit/abc123', author: { login: 'timo' } }],
    [{ id: 8, name: '', tag_name: 'v1.2.0', html_url: 'https://github.com/a/b/releases/tag/v1.2.0', draft: false, prerelease: true, author: { login: 'timo' }, published_at: '2026-11-16T06:00:00Z' }],
  ]);
  const pulls = await list('a/b', 'pulls');
  assert.equal(pulls.items.length, 30);
  assert.deepEqual(pulls.items[0], {
    id: 'PR_7', number: 7, title: 'Ajoute le déploiement', url: 'https://github.com/a/b/pull/7', state: 'fusionnée', status: 'merged',
    author: 'timo', date: '2026-11-21T10:00:00Z', ref: 'feat', baseRef: 'main', sha: 'f'.repeat(40),
    labels: [{ name: 'API', color: 'a1b2c3' }, { name: 'Important', color: null }], assignees: ['ana'], comments: 2,
    reviewDecision: 'approved', mergeStatus: 'clean', checksStatus: 'success', changedFiles: 5, additions: 33, deletions: 8,
  });
  assert.deepEqual(pulls.items.slice(1, 3).map((pr) => [pr.status, pr.url, pr.checksStatus]), [['draft', null, 'pending'], ['closed', null, null]]);
  assert.deepEqual(calls[0].slice(0, 7), ['api', '--hostname', 'github.com', '--method', 'POST', 'graphql', '--raw-field']);
  assert.match(calls[0][7], /^query=query\(/);
  assert.match(calls[0][7], /pullRequests\(first: 30/);
  assert.deepEqual(calls[0].slice(8), ['--raw-field', 'owner=a', '--raw-field', 'repo=b']);

  const issues = (await list('a/b', 'issues')).items;
  assert.equal(issues.length, 1);
  assert.deepEqual([issues[0].status, issues[0].labels, issues[0].assignees, issues[0].comments],
    ['open', [{ name: 'bug', color: 'abcdef' }], ['li'], 4]);
  assert.deepEqual((await list('a/b', 'actions')).items.map((run) => [run.title, run.state, run.status, run.ref, run.workflow, run.event]),
    [['CI', 'échouée', 'failure', 'main', 'Validation', 'push'], ['Tests', 'en cours', 'in_progress', null, 'Tests', null]]);
  assert.deepEqual((await list('a/b', 'commits')).items, [{ id: 'abc123', number: null, title: 'Corrige le rapport', url: 'https://github.com/a/b/commit/abc123', state: null, author: 'timo', date: '2026-11-17T07:00:00Z', ref: null, sha: 'abc123' }]);
  assert.deepEqual((await list('a/b', 'releases')).items, [{ id: '8', number: null, title: 'v1.2.0', url: 'https://github.com/a/b/releases/tag/v1.2.0', state: 'préversion', status: 'prerelease', author: 'timo', date: '2026-11-16T06:00:00Z', ref: 'v1.2.0' }]);
  assert.equal(calls.length, 5);
});

test('la liste des pull requests reste disponible via REST si GraphQL la refuse', async () => {
  const { list, calls } = listFixture([
    Object.assign(new Error('gh: Forbidden (HTTP 403)'), { code: 1 }),
    [{ id: 1, number: 7, title: 'Ajoute le déploiement', html_url: 'https://github.com/a/b/pull/7', state: 'closed',
      merged_at: '2026-11-20', user: { login: 'timo' }, updated_at: '2026-11-21T10:00:00Z', head: { ref: 'feat' }, base: { ref: 'main' } }],
  ]);
  assert.deepEqual((await list('a/b', 'pulls')).items[0], {
    id: '1', number: 7, title: 'Ajoute le déploiement', url: 'https://github.com/a/b/pull/7', state: 'fusionnée', status: 'merged',
    author: 'timo', date: '2026-11-21T10:00:00Z', ref: 'feat', baseRef: 'main', sha: null, labels: [], assignees: [], comments: null,
  });
  assert.match(calls[1][5], /^\/repos\/a\/b\/pulls\?state=all/);
});

test('le détail d’une PR réunit contrôles, avis et fichiers sans transmettre de diff', async () => {
  const timestamp = '2026-11-21T10:00:00Z';
  const { pull, calls } = listFixture([{ data: { repository: { pullRequest: {
    body: 'Déploie le nouveau rapport.\n' + 'x'.repeat(9000), changedFiles: 42,
    files: { nodes: Array.from({ length: 42 }, (_, index) => ({ path: `src/file-${index}.js`, changeType: 'MODIFIED', additions: 2, deletions: 1 })) },
    reviews: { totalCount: 2, nodes: [{ author: { login: 'ana' }, state: 'CHANGES_REQUESTED', submittedAt: timestamp },
      { author: { login: 'timo' }, state: 'APPROVED', submittedAt: timestamp, url: 'https://github.com/a/b/pull/7#pullrequestreview-10' }] },
    statusCheckRollup: { contexts: { totalCount: 35, nodes: [
      { name: 'Tests', status: 'COMPLETED', conclusion: 'SUCCESS', url: 'https://github.com/a/b/runs/4', detailsUrl: 'https://ci.example/checks/1' },
      { context: 'Analyse', state: 'PENDING', targetUrl: 'https://ci.example/checks/2' },
      { context: 'Lien invalide', state: 'FAILURE', targetUrl: 'javascript:alert(1)' },
      { context: 'Lien avec identifiants', state: 'ERROR', targetUrl: 'https://user:password@ci.example/checks/4' },
    ] } },
  } } } }]);
  const result = await pull('a/b', '7');
  assert.equal(result.body.length <= 8000, true);
  assert.match(result.body, /Extrait tronqué/);
  assert.deepEqual(result.checks, [
    { name: 'Tests', status: 'success', url: 'https://github.com/a/b/runs/4' },
    { name: 'Analyse', status: 'pending', url: 'https://ci.example/checks/2' },
    { name: 'Lien invalide', status: 'failure', url: null },
    { name: 'Lien avec identifiants', status: 'error', url: null },
  ]);
  assert.deepEqual(result.reviews, [
    { author: 'timo', state: 'approved', date: timestamp, url: 'https://github.com/a/b/pull/7#pullrequestreview-10' },
    { author: 'ana', state: 'changes_requested', date: timestamp, url: null },
  ]);
  assert.equal(result.files.length, 30);
  assert.deepEqual(result.files[0], { path: 'src/file-0.js', status: 'modified', additions: 2, deletions: 1 });
  assert.deepEqual([result.checksCount, result.reviewsCount, result.filesCount], [35, 2, 42]);
  assert.match(calls[0][7], /pullRequest\(number: \$number\)/);
  assert.doesNotMatch(calls[0][7], /diff|patch|mutation/);
  assert.deepEqual(calls[0].slice(8), ['--raw-field', 'owner=a', '--raw-field', 'repo=b', '--field', 'number=7']);
  assert.equal(calls.length, 1);
});

test('le détail refuse les numéros invalides et signale une pull request absente', async () => {
  const { pull, calls } = listFixture([{ data: { repository: { pullRequest: null } } }]);
  for (const number of ['0', '-2', '2.5', '0007', '2147483648', '7/files']) {
    await assert.rejects(pull('a/b', number), { status: 400, code: 'GITHUB_INVALID_PULL' });
  }
  await assert.rejects(pull('a/b/../c', '7'), { status: 400, code: 'GITHUB_INVALID_REPO' });
  assert.equal(calls.length, 0);
  await assert.rejects(pull('a/b', '7'), { status: 404, code: 'GITHUB_NOT_FOUND' });
});

test('le détail traduit aussi un refus GraphQL NOT_FOUND sans réponse HTTP 404', async () => {
  const { pull } = listFixture([Object.assign(new Error('commande GitHub en échec'), {
    code: 1, stderr: 'gh: Could not resolve to a PullRequest with the number of 42.',
  })]);
  await assert.rejects(pull('a/b', '42'), { status: 404, code: 'GITHUB_NOT_FOUND' });
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
