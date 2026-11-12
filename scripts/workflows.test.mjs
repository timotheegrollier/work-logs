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

describe('workflow PWA Cloudflare (option B — PWA + relais sur le même Worker)', () => {
  test('le workflow existe et est un YAML valide', () => {
    const content = readFileSync('./.github/workflows/pwa-cloudflare.yml', 'utf8');
    assert.ok(content.trim().length > 0, 'fichier non vide');
    const wf = yaml.load(content);
    assert.equal(wf.name, 'PWA Cloudflare');
    assert.equal(wf.on.push.branches?.[0], 'master');
    assert.ok(wf.on.push.paths.some(p => p === 'web/**'), 'déclenche sur web/**');
    assert.ok(wf.on.push.paths.some(p => p === 'oauth-proxy/**'), 'déclenche sur oauth-proxy/**');
    assert.equal(wf.jobs['deploy-cloudflare']['runs-on'], 'ubuntu-24.04');
    // Pas le groupe « gh-pages » de « Dépôts » : ce workflow ne pousse pas sur gh-pages,
    // et un run de « Dépôts » en attente serait annulé par le sien.
    assert.equal(wf.concurrency?.group, 'pwa-cloudflare');
  });

  test('les credentials Cloudflare sont des secrets, pas en dur', () => {
    const content = readFileSync('./.github/workflows/pwa-cloudflare.yml', 'utf8');
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
    const content = readFileSync('./.github/workflows/pwa-cloudflare.yml', 'utf8');
    // Sans `cd oauth-proxy`, wrangler verrait un dossier sans wrangler.toml et
    // lancerait un setup interactif (« wrangler init ») qui échoue en CI.
    assert.ok(content.includes('cd oauth-proxy'), 'deploy depuis oauth-proxy/');
    assert.ok(/npx --yes "wrangler@\$WRANGLER" deploy/.test(content), 'wrangler épinglé sur le lockfile');
    // Ni le groupe de « Dépôts » (gh-pages), qui seul pousse encore sur gh-pages.
    assert.ok(!content.includes('group: gh-pages'), 'pas de groupe gh-pages partagé');
  });

  test('le build est celui de la PWA (VITE_PWA), pas la version web /api', () => {
    const content = readFileSync('./.github/workflows/pwa-cloudflare.yml', 'utf8');
    assert.match(content, /VITE_PWA: '1'/);
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
});
