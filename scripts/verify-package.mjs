import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

// Utilise l’outil ASAR déjà fourni par electron-builder, sans dépendance supplémentaire.
const builderRequire = createRequire(import.meta.resolve('electron-builder'));
const { listPackage, extractFile } = builderRequire('@electron/asar');
const archive = 'release/linux-unpacked/resources/app.asar';
const files = listPackage(archive);
for (const file of files) {
  assert.doesNotMatch(file, /(?:^|\/)(?:api\/data|\.env|\.git)(?:\/|$)|\.db(?:-|$)|\.sqlite(?:$|\/)/, `Donnée privée empaquetée : ${file}`);
}
for (const required of ['/desktop/main.mjs', '/desktop/preload.cjs', '/desktop/icon.png', '/desktop/update.mjs', '/api/src/app.js', '/web/dist/index.html', '/node_modules/express/package.json', '/node_modules/electron-updater/package.json'])
  assert.ok(files.includes(required), `Fichier manquant : ${required}`);
const packaged = JSON.parse(extractFile(archive, 'package.json'));
assert.equal(packaged.version, JSON.parse(fs.readFileSync('package.json')).version);
console.log(`Paquet ${packaged.version} vérifié : application et dépendances, aucune donnée utilisateur.`);
