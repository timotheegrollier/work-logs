import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = path.join(root, '.desktop-app');
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const project = read('package.json');
const api = read('api/package.json');
const lock = read('api/package-lock.json');
if (!fs.existsSync(path.join(root, 'web/dist/index.html'))) throw new Error('Construire le web avant le desktop : npm run build');

// Liste fermée : aucune base, pièce jointe, clé ou configuration personnelle.
fs.rmSync(stage, { recursive: true, force: true });
for (const name of ['api/src', 'api/package.json', 'web/dist']) {
  fs.mkdirSync(path.dirname(path.join(stage, name)), { recursive: true });
  fs.cpSync(path.join(root, name), path.join(stage, name), { recursive: true });
}
fs.mkdirSync(path.join(stage, 'desktop'), { recursive: true });
for (const name of ['main.mjs', 'preload.cjs', 'server.mjs', 'update.mjs', 'google.mjs', 'icon.png'])
  fs.copyFileSync(path.join(root, 'desktop', name), path.join(stage, 'desktop', name));
const manifest = {
  name: 'worklogs', productName: 'WorkLogs', desktopName: 'worklogs.desktop', version: project.version,
  description: project.description, main: 'desktop/main.mjs',
  author: project.author, homepage: project.homepage, license: project.license,
  // Dépendances runtime du main process : l'API + l'auto-update (dép. racine,
  // approuvée explicitement — voir 07-RELEASES.md §8). Le lock du stage doit
  // contenir la fermeture transitive, sinon `npm ci` échoue ou l'app plant.
  dependencies: { ...api.dependencies, 'electron-updater': project.dependencies['electron-updater'] },
};
// Recopie la fermeture transitive d'electron-updater depuis le lock racine,
// en miroir exact de la résolution npm : si le cran flat du stage est déjà
// occupé par une autre version (ex. debug 2.6.9 de l'API vs 4.4.3 de l'updater),
// l'entrée est nichée sous son parent, comme npm le ferait.
const rootLock = read('package-lock.json');
const queued = new Set();
function place(parentKey, dep) {
  const rootNested = `${parentKey}/node_modules/${dep}`;
  const flat = `node_modules/${dep}`;
  let target;
  if (rootLock.packages[rootNested]) {
    target = rootNested;
    lock.packages[target] ??= rootLock.packages[rootNested];
  } else if (!rootLock.packages[flat]) {
    throw new Error(`Dép introuvable dans le lock racine : ${flat} (via ${parentKey})`);
  } else if (!lock.packages[flat]) {
    target = flat;
    lock.packages[target] = rootLock.packages[flat];
  } else if (lock.packages[flat].version !== rootLock.packages[flat].version) {
    target = rootNested;
    lock.packages[target] ??= rootLock.packages[flat];
  } else {
    target = flat;
  }
  if (!queued.has(target)) {
    queued.add(target);
    for (const key of edges(target)) place(target, key);
  }
}
function edges(key) {
  const entry = lock.packages[key] ?? {};
  return new Set([
    ...Object.keys(entry.dependencies ?? {}),
    ...Object.keys(entry.optionalDependencies ?? {}),
    ...Object.keys(entry.peerDependencies ?? {}),
  ]);
}
place('node_modules/electron-updater', 'electron-updater');
lock.name = manifest.name;
lock.version = manifest.version;
lock.packages[''] = { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies };
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(stage, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage, stdio: 'inherit' });
console.log(`Desktop ${manifest.version} préparé dans ${stage}`);
