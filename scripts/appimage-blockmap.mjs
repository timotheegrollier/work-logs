/**
 * Génère le `.blockmap` externe de chaque AppImage de `release/`.
 * electron-builder n'embarque le blockmap que DANS l'AppImage ; or
 * electron-updater télécharge `{fichier}.blockmap` pour calculer le delta —
 * sans ce fichier, repli silencieux sur le téléchargement complet.
 * On recalcule donc le blockmap sur le fichier final publié (avec son
 * blockmap embarqué), via le module du builder lui-même, sans dépendance.
 *
 * Usage : `node scripts/appimage-blockmap.mjs [release/]`
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireFile = createRequire(import.meta.url);
const { buildBlockMap } = requireFile(
  path.join(root, 'node_modules/app-builder-lib/out/targets/blockmap/blockmap.js'),
);

const dir = path.resolve(root, process.argv[2] ?? 'release');
const images = fs.readdirSync(dir).filter((f) => f.endsWith('.AppImage')).map((f) => path.join(dir, f));
if (!images.length) throw new Error(`aucune AppImage dans ${dir}`);
for (const image of images) {
  await buildBlockMap(image, 'gzip', `${image}.blockmap`);
  const { size } = fs.statSync(`${image}.blockmap`);
  console.log(`${path.basename(image)}.blockmap : ${(size / 1024).toFixed(0)} Ko`);
}
