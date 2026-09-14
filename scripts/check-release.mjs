import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/;

/**
 * Vérifie qu'une version est publiable : format semver, tag correspondant, et
 * `package-lock.json` aligné.
 *
 * Le lockfile porte la version à deux endroits (racine et `packages[""]`) et npm
 * ne les met à jour que via `npm version`. Un bump à la main dans `package.json`
 * laisse le lock en arrière sans que rien ne proteste : la dérive constatée le
 * 2026-09-14 atteignait huit versions (lock en 0.4.2, manifeste en 0.6.12).
 */
export function checkRelease({ version, lockVersion, lockPackageVersion, tag }) {
  if (!SEMVER_RE.test(version ?? '')) throw new Error(`Version invalide : ${version}`);
  if (tag && tag !== `v${version}`)
    throw new Error(`Le tag ${tag} doit correspondre à package.json : v${version}`);
  for (const [label, found] of [
    ['version', lockVersion],
    ['packages[""].version', lockPackageVersion],
  ]) {
    if (found !== version)
      throw new Error(
        `package-lock.json désynchronisé (${label} = ${found}, attendu ${version}). ` +
          `Bumper avec « npm version ${version} --no-git-tag-version », qui met à jour les deux fichiers.`
      );
  }
  return `v${version}`;
}

const read = (name) => JSON.parse(fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));

// Comparaison d'URL plutôt que `import.meta.main` : ce dernier n'existe qu'à partir
// de Node 24.2, et s'il vaut `undefined` le script sortirait en silence — soit un
// garde-fou de release muet, exactement ce qu'il est censé empêcher.
const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  const manifest = read('package.json');
  const lock = read('package-lock.json');
  console.log(
    'Version de release :',
    checkRelease({
      version: manifest.version,
      lockVersion: lock.version,
      lockPackageVersion: lock.packages?.['']?.version,
      tag: process.argv[2],
    })
  );
}
