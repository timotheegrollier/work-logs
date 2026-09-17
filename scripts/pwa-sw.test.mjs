import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSw, readRootVersion, SW_VERSION_PLACEHOLDER } from './pwa-sw.mjs';

test('injecte la version racine à chaque occurrence du marqueur', () => {
  const rendered = renderSw(`const VERSION = '${SW_VERSION_PLACEHOLDER}'; // ${SW_VERSION_PLACEHOLDER}`, '0.15.1');
  assert.equal(rendered, "const VERSION = '0.15.1'; // 0.15.1");
  assert.ok(!rendered.includes(SW_VERSION_PLACEHOLDER));
});

test('refuse un gabarit sans marqueur ou une version mal formée', () => {
  assert.throws(() => renderSw('sans marqueur', '0.15.1'), /marqueur/);
  assert.throws(() => renderSw(SW_VERSION_PLACEHOLDER, '0.15'), /Version/);
  assert.throws(() => renderSw(SW_VERSION_PLACEHOLDER, 'v0.15.1'), /Version/);
});

test('lit la version du paquet racine', () => {
  assert.equal(readRootVersion(JSON.stringify({ version: '0.15.1' })), '0.15.1');
  assert.throws(() => readRootVersion('{invalide'), /illisible/);
  assert.throws(() => readRootVersion(JSON.stringify({ version: '0.15' })), /invalide/);
});
