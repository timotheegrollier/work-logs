// Tests unitaires des workflows GitHub Actions.
// Validation statique : YAML parse, structure attendue, variables/secrets présents.
// Ces tests compensent l'absence d'analyseur de workflows (actionlint) dans les outils.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const yaml = await import(pathToFileURL('./node_modules/js-yaml/dist/js-yaml.mjs').href).catch(() => null);

describe('workflow PWA Cloudflare (option B — PWA + relais sur le même Worker)', () => {
  test('le workflow existe et est un YAML valide', () => {
    const content = readFileSync('./.github/workflows/pwa-cloudflare.yml', 'utf8');
    assert.ok(content.trim().length > 0, 'fichier non vide');
    if (yaml) {
      const wf = yaml.load(content);
      assert.equal(wf.name, 'PWA Cloudflare');
      assert.equal(wf.on.push.branches?.[0], 'master');
      assert.ok(wf.on.push.paths.some(p => p === 'web/**'), 'déclenche sur web/**');
      assert.ok(wf.on.push.paths.some(p => p === 'oauth-proxy/**'), 'déclenche sur oauth-proxy/**');
      assert.equal(wf.jobs['deploy-cloudflare']['runs-on'], 'ubuntu-24.04');
      // Pas le groupe « gh-pages » : ce workflow ne pousse pas sur gh-pages et
      // ne doit pas annuler le déploiement gh-pages (« PWA »).
      assert.equal(wf.concurrency?.group, 'pwa-cloudflare');
    }
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
    assert.ok(content.includes('npx wrangler deploy'), 'wrangler deploy présent');
    // La concurrency ne doit pas annuler le déploiement gh-pages (« PWA »).
    assert.ok(!content.includes('group: gh-pages'), 'pas de groupe gh-pages partagé');
  });
});
