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
for (const name of ['main.mjs', 'preload.cjs', 'server.mjs', 'update.mjs', 'icon.png'])
  fs.copyFileSync(path.join(root, 'desktop', name), path.join(stage, 'desktop', name));
const manifest = {
  name: 'worklogs', productName: 'WorkLogs', desktopName: 'worklogs.desktop', version: project.version,
  description: project.description, main: 'desktop/main.mjs',
  author: project.author, homepage: project.homepage, license: project.license,
  dependencies: api.dependencies,
};
lock.name = manifest.name;
lock.version = manifest.version;
lock.packages[''] = { name: manifest.name, version: manifest.version, dependencies: api.dependencies };
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(stage, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage, stdio: 'inherit' });
console.log(`Desktop ${manifest.version} préparé dans ${stage}`);
