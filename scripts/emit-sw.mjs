// Émet `web/dist/sw.js` après `vite build`, versionné comme le paquet racine.
// Exécuté par `npm --prefix web run build` : `tsc -b && vite build && node ../scripts/emit-sw.mjs`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSw, readRootVersion } from './pwa-sw.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = readRootVersion(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const template = fs.readFileSync(path.join(root, 'web', 'src', 'sw-template.js'), 'utf8');
const dist = path.join(root, 'web', 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  throw new Error('web/dist/index.html absent : lance `vite build` avant emit-sw.');
}
// Tout le build est précaché : les morceaux chargés à la demande restent lisibles hors ligne.
const assetsDir = path.join(dist, 'assets');
const assets = (fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : []).filter((name) => /\.(js|css)$/.test(name)).sort().map((name) => `./assets/${name}`);
fs.writeFileSync(path.join(dist, 'sw.js'), renderSw(template, version, assets));
console.log(`sw.js émis (version ${version}, ${assets.length} fichier(s) précaché(s))`);
