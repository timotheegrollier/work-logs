/**
 * Dossier du TSE relié à un projet. Le projet porte l'**adresse complète** du dossier
 * (`\\172.16.1.20\d\Global\…\00. PROCEDURE\2. TSE`) : synchronisée par Drive, elle vaut
 * sur le PC comme sur le téléphone, même si leurs racines diffèrent (le PC peut monter
 * tout `D`, le relais seulement `00. PROCEDURE`). Chaque appareil la traduit en chemin
 * sous sa propre racine. Sans adresse connue (dossier local, tests) : chemin relatif.
 */

/** Clé de comparaison : partage et chemin, sans le serveur (nom ou IP), sans casse. */
export function addressKey(address: string): string {
  const parts = address.replace(/\//g, '\\').replace(/^\\+/, '').split('\\').filter(Boolean);
  return parts.slice(1).join('/').normalize('NFC').toLowerCase();
}

const isAddress = (value: string) => /^(\\\\|\/\/)/.test(value);

/** Ce que le projet enregistre pour `rel` (chemin sous la racine de cet appareil). */
export function linkFor(rootAddress: string | null | undefined, rel: string): string {
  if (!rootAddress) return rel;
  return rel ? `${rootAddress.replace(/\\+$/, '')}\\${rel.split('/').join('\\')}` : rootAddress;
}

/**
 * Le dossier relié, en chemin sous la racine de cet appareil : `''` pour la racine
 * elle-même, `null` s'il est ailleurs (hors de ce partage, ou adresse sans racine connue).
 */
export function localDir(rootAddress: string | null | undefined, sharedDir: string | null | undefined): string | null {
  if (!sharedDir) return null;
  if (!isAddress(sharedDir)) return sharedDir;
  if (!rootAddress) return null;
  const root = addressKey(rootAddress);
  const target = addressKey(sharedDir);
  if (target === root) return '';
  if (!target.startsWith(root + '/')) return null;
  // Les noms tels qu'écrits dans l'adresse (casse et accents d'origine), après ceux de la racine.
  const depth = root.split('/').length;
  return sharedDir.replace(/\//g, '\\').replace(/^\\+/, '').split('\\').filter(Boolean).slice(1 + depth).join('/');
}
