/**
 * Adresse Windows (`\\serveur\partage\dossier`) d'un dossier monté sur cet appareil.
 * C'est elle que porte un projet relié à un dossier du TSE (`projects.shared_dir`,
 * synchronisé par Drive) : chaque appareil la traduit vers sa propre racine, que ce
 * soit un montage GVFS (desktop, Nemo) ou CIFS (relais de la PWA). §25, §29.
 */

/** Champs d'un nom de montage GVFS : `smb-share:domain=X,server=tse01,share=commun,user=timo`. */
export function gvfsFields(name) {
  if (!name.startsWith('smb-share:')) return null;
  const fields = {};
  for (const pair of name.slice('smb-share:'.length).split(',')) {
    const index = pair.indexOf('=');
    if (index === -1) continue;
    let value = pair.slice(index + 1);
    try { value = decodeURIComponent(value); } catch {}
    fields[pair.slice(0, index)] = value;
  }
  return fields;
}

/** `/run/user/1000/gvfs/smb-share:server=172.16.1.20,share=d/Global/…` → `\\172.16.1.20\d\Global\…`. */
export function addressFromGvfsPath(dir) {
  const parts = String(dir || '').split('/');
  const index = parts.findIndex((part) => part.startsWith('smb-share:'));
  if (index === -1) return null;
  const fields = gvfsFields(parts[index]);
  if (!fields?.server || !fields.share) return null;
  const rest = parts.slice(index + 1).filter(Boolean);
  return `\\\\${fields.server}\\${fields.share}${rest.length ? '\\' + rest.join('\\') : ''}`;
}

/** `\040` (espace) et les autres échappements octaux de `/proc/self/mountinfo`. */
const unescapeMount = (value) => value.replace(/\\([0-7]{3})/g, (_all, octal) => String.fromCharCode(parseInt(octal, 8)));

/**
 * Montage CIFS qui contient `root`, lu dans `/proc/self/mountinfo` → son adresse
 * Windows, sous-dossiers compris (`//172.16.1.20/D/Global/…` monté sur
 * `/mnt/tse-procedures` → `\\172.16.1.20\D\Global\…`). `null` si `root` n'est pas sur un partage.
 */
export function addressFromMountinfo(root, mountinfo) {
  let best = null;
  for (const line of String(mountinfo || '').split('\n')) {
    const [left, right] = line.split(' - ');
    if (!left || !right) continue;
    const mountPoint = unescapeMount(left.split(' ')[4] || '');
    const [fstype, source] = right.split(' ');
    if (!['cifs', 'smb3'].includes(fstype) || !source?.startsWith('//')) continue;
    if (root !== mountPoint && !root.startsWith(mountPoint.replace(/\/$/, '') + '/')) continue;
    if (!best || mountPoint.length > best.mountPoint.length) best = { mountPoint, source: unescapeMount(source) };
  }
  if (!best) return null;
  const rest = root.slice(best.mountPoint.length).split('/').filter(Boolean);
  const base = best.source.replace(/^\/\//, '').split('/').filter(Boolean);
  return `\\\\${[...base, ...rest].join('\\')}`;
}
