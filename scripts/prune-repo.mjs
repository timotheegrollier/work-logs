/**
 * Rétention des dépôts : ne garder que les N versions les plus récentes.
 *
 * Sans purge, gh-pages grossit sans fin — constaté le 2026-09-14 : 16 RPM jamais
 * supprimés, 1,3 Go, au-delà de la limite d'1 Go d'un site GitHub Pages. Les
 * versions écartées restent téléchargeables depuis les releases GitHub, qui ne
 * comptent pas dans cette limite.
 *
 * Usage : `node scripts/prune-repo.mjs <dossier> <extension> [nombre]`
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** `WorkLogs-0.6.13-linux-amd64.deb` → `0.6.13`, ou null si le nom ne dit rien. */
export function versionOf(filename) {
  return /-(\d+\.\d+\.\d+)-/.exec(path.basename(filename))?.[1] ?? null;
}

/** Tri semver croissant : `0.6.9` vient bien avant `0.6.10`, contrairement au tri texte. */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/**
 * Répartit les fichiers en `keep` / `remove` selon les `count` versions les plus
 * récentes. Un fichier dont le nom ne porte pas de version est **gardé** : mieux
 * vaut un fichier de trop qu'une suppression à l'aveugle.
 */
export function planPrune(files, count) {
  const versions = [...new Set(files.map(versionOf).filter(Boolean))].sort(compareVersions);
  const kept = new Set(versions.slice(-count));
  const keep = [];
  const remove = [];
  for (const file of files) {
    const version = versionOf(file);
    (version === null || kept.has(version) ? keep : remove).push(file);
  }
  return { keep, remove, keptVersions: [...kept].sort(compareVersions) };
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  const [dir, extension, count = '3'] = process.argv.slice(2);
  if (!dir || !extension) throw new Error('Usage : prune-repo.mjs <dossier> <extension> [nombre]');
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.' + extension))
    : [];
  const { remove, keptVersions } = planPrune(files, Number(count));
  for (const file of remove) {
    fs.rmSync(path.join(dir, file));
    console.log('purge', file);
  }
  console.log(`${dir} : ${keptVersions.join(', ') || 'aucune version'} gardée(s), ${remove.length} fichier(s) purgé(s)`);
}
