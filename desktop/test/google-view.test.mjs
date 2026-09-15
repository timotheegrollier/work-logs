import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedGoogleNavigation, googleViewUrl, viewBounds } from '../google-view.mjs';

test('googleViewUrl compose l’adresse de l’onglet demandé et refuse tout le reste', () => {
  assert.equal(googleViewUrl('google-123'), 'https://docs.google.com/document/d/google-123/edit');
  assert.equal(googleViewUrl('google-123', 't.2'), 'https://docs.google.com/document/d/google-123/edit?tab=t.2');
  // L'identifiant vient de SQLite, mais il finit dans une URL : aucun chemin ni requête.
  for (const bad of ['../../secret', 'a/b', 'doc?x=1', 'doc#x', 'doc%2e%2e', '', 'a'.repeat(201), null, undefined, 42])
    assert.throws(() => googleViewUrl(bad), /Document Google invalide/, String(bad));
  for (const bad of ['../x', 'on/glet', 'x'.repeat(201), null, 7])
    assert.throws(() => googleViewUrl('google-123', bad), /Document Google invalide/, String(bad));
});

test('allowedGoogleNavigation n’ouvre que Google en HTTPS, jamais l’OAuth des API', () => {
  for (const url of ['https://docs.google.com/document/d/abc/edit', 'https://accounts.google.com/v3/signin/identifier',
    'https://drive.google.com/drive/my-drive', 'https://myaccount.google.com/', 'https://DOCS.GOOGLE.COM/document/d/abc/edit'])
    assert.equal(allowedGoogleNavigation(url), true, url);
  for (const url of [
    'http://docs.google.com/document/d/abc/edit',          // en clair
    'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'about:blank', '',
    'https://docs.google.com.evil.example/x',              // sous-domaine trompeur
    'https://evil.example/docs.google.com',
    'https://user:motdepasse@docs.google.com/',            // identifiants dans l’URL
    'https://docs.google.com:8443/document/d/abc/edit',    // port détourné
    // La politique Google interdit l’OAuth en vue embarquée : il reste au navigateur.
    'https://accounts.google.com/o/oauth2/v2/auth?client_id=x', 'https://accounts.google.com/o/oauth2',
  ]) assert.equal(allowedGoogleNavigation(url), false, url);
});

test('viewBounds garde la vue Google à l’intérieur de la fenêtre', () => {
  assert.deepEqual(viewBounds({ x: 320.4, y: 96.6, width: 800.2, height: 600.8 }, [1440, 900]), { x: 320, y: 97, width: 800, height: 601 });
  // Défilement ou fenêtre réduite : une zone hors cadre est ramenée, jamais négative.
  assert.deepEqual(viewBounds({ x: -40, y: -40, width: 200, height: 200 }, [1440, 900]), { x: 0, y: 0, width: 200, height: 200 });
  assert.deepEqual(viewBounds({ x: 1400, y: 880, width: 800, height: 600 }, [1440, 900]), { x: 1400, y: 880, width: 40, height: 20 });
  assert.deepEqual(viewBounds({ x: 2000, y: 2000, width: 800, height: 600 }, [1440, 900]), { x: 1440, y: 900, width: 0, height: 0 });
  assert.deepEqual(viewBounds({ x: 10, y: 10, width: -5, height: -5 }, [1440, 900]), { x: 10, y: 10, width: 0, height: 0 });
  for (const bad of [null, undefined, {}, { x: 0, y: 0, width: 10 }, { x: NaN, y: 0, width: 1, height: 1 }, { x: Infinity, y: 0, width: 1, height: 1 }])
    assert.throws(() => viewBounds(bad, [1440, 900]), /Zone du document invalide/, JSON.stringify(bad));
});
