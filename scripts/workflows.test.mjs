// Tests unitaires des workflows GitHub Actions.
// Validation statique : YAML parse, structure attendue, variables/secrets présents.
// Ces tests compensent l'absence d'analyseur de workflows (actionlint) dans les outils.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Pas de repli silencieux : sans js-yaml (dépendance transitive d'electron-builder), les
// assertions de structure sautaient et un YAML cassé passait.
const yaml = await import(pathToFileURL('./node_modules/js-yaml/dist/js-yaml.mjs').href);

describe('workflow Worker Cloudflare (relais de jetons et IA, sans front : la PWA est sur Pages)', () => {
  test('le workflow existe et est un YAML valide', () => {
    const content = readFileSync('./.github/workflows/worker-cloudflare.yml', 'utf8');
    assert.ok(content.trim().length > 0, 'fichier non vide');
    const wf = yaml.load(content);
    assert.equal(wf.name, 'Worker Cloudflare');
    assert.equal(wf.on.push.branches?.[0], 'master');
    assert.ok(wf.on.push.paths.some(p => p === 'oauth-proxy/**'), 'déclenche sur oauth-proxy/**');
    assert.ok(!wf.on.push.paths.includes('web/**'), 'un changement web ne redéploie pas le Worker');
    assert.equal(wf.jobs['deploy-cloudflare']['runs-on'], 'ubuntu-24.04');
    // Pas le groupe « gh-pages » de « Dépôts » : ce workflow ne pousse pas sur gh-pages,
    // et un run de « Dépôts » en attente serait annulé par le sien.
    assert.equal(wf.concurrency?.group, 'worker-cloudflare');
  });

  test('les credentials Cloudflare sont des secrets, pas en dur', () => {
    const content = readFileSync('./.github/workflows/worker-cloudflare.yml', 'utf8');
    assert.ok(content.includes('secrets.CLOUDFLARE_API_TOKEN'), 'CLOUDFLARE_API_TOKEN est un secret GitHub');
    assert.ok(content.includes('secrets.CLOUDFLARE_ACCOUNT_ID'), 'CLOUDFLARE_ACCOUNT_ID est un secret GitHub');
    assert.ok(
      !content.match(/CLOUDFLARE_API_TOKEN:\s*['"][A-Za-z0-9]{40,}/),
      'pas de token en dur',
    );
    assert.ok(
      !content.match(/CLOUDFLARE_ACCOUNT_ID:\s*['"][0-9]{1,20}/),
      'pas d\'ID en dur',
    );
  });

  test('le deploy part de oauth-proxy/ (wrangler lit le wrangler.toml du relais)', () => {
    const content = readFileSync('./.github/workflows/worker-cloudflare.yml', 'utf8');
    // Sans `cd oauth-proxy`, wrangler verrait un dossier sans wrangler.toml et
    // lancerait un setup interactif (« wrangler init ») qui échoue en CI.
    assert.ok(content.includes('cd oauth-proxy'), 'deploy depuis oauth-proxy/');
    assert.ok(/npx --yes "wrangler@\$WRANGLER" deploy/.test(content), 'wrangler épinglé sur le lockfile');
    // Ni le groupe de « Dépôts » (gh-pages), qui seul pousse encore sur gh-pages.
    assert.ok(!content.includes('group: gh-pages'), 'pas de groupe gh-pages partagé');
  });

  test('aucun front construit ni publié : la PWA vit sur GitHub Pages', () => {
    const content = readFileSync('./.github/workflows/worker-cloudflare.yml', 'utf8');
    assert.ok(!content.includes('npm --prefix web'), 'pas de build web');
    assert.ok(!readFileSync('./oauth-proxy/wrangler.toml', 'utf8').includes('[assets]'), 'pas d’assets dans wrangler.toml');
  });
});

describe('workflow Dépôts (vérification des URLs publiques)', () => {
  const content = readFileSync('./.github/workflows/repos.yml', 'utf8');

  test('est un YAML valide, déclenché par la fin de « Release Linux »', () => {
    assert.ok(content.trim().length > 0, 'fichier non vide');
    const wf = yaml.load(content);
    assert.equal(wf.name, 'Dépôts');
    assert.equal(wf.on.workflow_run.workflows?.[0], 'Release Linux');
    assert.equal(wf.concurrency?.group, 'gh-pages');
    assert.equal(wf.jobs.repos['timeout-minutes'], 35);
  assert.ok(content.includes('filter: blob:none'), 'checkout partiel (D8)');
  });

  test('vérifie les URLs publiques après le push, avec un échec explicite', () => {
    const push = content.indexOf('git push origin gh-pages');
    const verify = content.indexOf('node scripts/verify-repo.mjs');
    assert.ok(push >= 0, 'le push gh-pages existe');
    assert.ok(verify > push, 'la vérification suit le push');
    assert.match(content, /"\$TAG" "\$PAGES"/);
    assert.match(content, /--skip-deb/);
  });

  test('le vérificateur attend un délai borné et échoue explicitement', () => {
    const script = readFileSync('./scripts/verify-repo.mjs', 'utf8');
    assert.match(script, /DEFAULT_TIMEOUT_MS = 10 \* 60 \* 1000/);
    assert.match(script, /::error::/);
  });

  test('le checkout n’a plus à télécharger les blobs de gh-pages', () => {
    assert.ok(content.includes('filter: blob:none'), 'checkout partiel (D8)');
  });
});

describe('workflow CI Linux (tests et paquets en parallèle)', () => {
  const content = readFileSync('./.github/workflows/ci.yml', 'utf8');
  const wf = yaml.load(content);

  test('est un YAML valide, mêmes déclencheurs', () => {
    assert.equal(wf.name, 'CI Linux');
    assert.ok(wf.on.push.branches?.includes('**'));
    assert.ok('pull_request' in wf.on, 'toujours déclenché sur pull_request');
  });

  test('les paquets se construisent sans attendre les tests', () => {
    assert.ok(wf.jobs.build, 'job build présent');
    assert.equal(wf.jobs.build['timeout-minutes'], 15);
    const validate = JSON.stringify(wf.jobs.validate);
    assert.ok(!validate.includes('desktop:dist'), 'validate ne construit plus les paquets');
    assert.ok(JSON.stringify(wf.jobs.build).includes('desktop:dist'), 'build les construit');
    assert.ok(JSON.stringify(wf.jobs.build).includes('verify-package.mjs'), 'paquet vérifié');
    assert.ok(JSON.stringify(wf.jobs.build).includes('appimage-blockmap.mjs'), 'blockmap vérifié');
  });

  test('les installations attendent les paquets et reçoivent leur artefact', () => {
    assert.equal(wf.jobs.packages.needs, 'build');
    const uploads = wf.jobs.build.steps.filter((step) => step.uses?.startsWith('actions/upload-artifact'));
    assert.ok(uploads.some((step) => step.with?.name === 'linux-packages'), 'artefact linux-packages');
    assert.ok(uploads.some((step) => step.with?.['if-no-files-found'] === 'error'), 'artefact exigé');
  });
});

describe('workflow Release Linux (réutilise la CI de la branche)', () => {
  const wf = yaml.load(readFileSync('./.github/workflows/release.yml', 'utf8'));
  const precheck = wf.jobs.precheck.steps[0].run;

  test('le commit tagué doit appartenir à master', () => {
    assert.match(precheck, /compare\/\$SHA\.\.\.master/);
    assert.match(precheck, /identical/);
    assert.match(precheck, /ahead/);
  });

  test('un run de push vert sur ce SHA suffit, branche ou master', () => {
    assert.match(precheck, /\.event == "push"/);
    assert.ok(!precheck.includes('headBranch == "master"'), 'plus de seconde CI imposée sur master');
  });

  test('le checkout ne télécharge plus les blobs de gh-pages', () => {
    assert.ok(JSON.stringify(wf.jobs.release).includes('"filter":"blob:none"'));
  });
});
