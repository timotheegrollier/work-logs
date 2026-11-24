/**
 * Réunit les `latest-linux-<cible>.yml` des trois jobs de paquets en un seul `latest-linux.yml`.
 *
 * Chaque cible (AppImage, deb, rpm) se construit dans son propre job (§99) et electron-builder
 * n'y écrit que son fichier. Construites ensemble, il garde le premier (l'AppImage : `path` et
 * `sha512` de tête, lus par les anciens electron-updater) et y ajoute les `files` des autres.
 * On refait exactement cela, avec son propre sérialiseur, après avoir vérifié chaque fichier :
 * un `latest-linux.yml` incomplet ou faux casserait la mise à jour des postes en production.
 *
 * Usage : `node scripts/merge-update-info.mjs [release/]`
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builderRequire = createRequire(import.meta.resolve('electron-builder'));
const yaml = builderRequire('js-yaml');
const { serializeToYaml } = builderRequire('builder-util');

/** Ordre d'une construction commune : l'AppImage d'abord, comme dans les releases jusqu'à 0.90.2. */
export const TARGETS = ['AppImage', 'deb', 'rpm'];

const sha512 = (file) => new Promise((resolve, reject) => {
  const hash = createHash('sha512');
  fs.createReadStream(file).on('error', reject).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('base64')));
});

export async function mergeUpdateInfo(dir) {
  const parts = TARGETS.map((target) => {
    const file = path.join(dir, `latest-linux-${target}.yml`);
    if (!fs.existsSync(file)) throw new Error(`latest-linux-${target}.yml manquant dans ${dir}`);
    const info = yaml.load(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(info?.files) || info.files.length !== 1) throw new Error(`${target} : une seule entrée attendue dans files`);
    if (!info.files[0].url.endsWith(`.${target}`)) throw new Error(`${target} : ${info.files[0].url} n'est pas un .${target}`);
    return { file, info };
  });
  const [first] = parts.map(({ info }) => info);
  for (const { info } of parts) {
    if (info.version !== first.version) throw new Error(`versions différentes : ${first.version} et ${info.version}`);
  }
  const files = parts.map(({ info }) => info.files[0]);
  for (const entry of files) {
    const file = path.join(dir, entry.url);
    if (!fs.existsSync(file)) throw new Error(`${entry.url} absent de ${dir}`);
    if (fs.statSync(file).size !== entry.size) throw new Error(`${entry.url} : taille différente de celle annoncée`);
    if (await sha512(file) !== entry.sha512) throw new Error(`${entry.url} : sha512 différent de celui annoncé`);
  }
  const merged = { ...first, files };
  fs.writeFileSync(path.join(dir, 'latest-linux.yml'), serializeToYaml(merged, false, true));
  for (const { file } of parts) fs.rmSync(file);
  return merged;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(root, process.argv[2] ?? 'release');
  const merged = await mergeUpdateInfo(dir);
  console.log(`latest-linux.yml ${merged.version} : ${merged.files.map((f) => f.url).join(', ')}`);
}
