import type { SharedEntry, SharedFile, SharedLock, SharedReach } from './lib';

/**
 * Ce que l'éditeur d'un fichier partagé doit dire, d'après l'état renvoyé par
 * l'API. Fonctions pures : l'écran ne fait qu'afficher leur résultat.
 */

const APPS: Record<SharedLock['app'], string> = {
  word: 'Word', excel: 'Excel', powerpoint: 'PowerPoint', office: 'Office', libreoffice: 'LibreOffice', worklogs: 'WorkLogs',
};

const pad = (n: number) => String(n).padStart(2, '0');
/** « 10h42 » aujourd'hui, « le 03/10 à 10h42 » sinon. */
export function sinceLabel(iso: string | null, now = new Date()): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const time = `${pad(date.getHours())}h${pad(date.getMinutes())}`;
  return date.toDateString() === now.toDateString() ? time : `le ${pad(date.getDate())}/${pad(date.getMonth() + 1)} à ${time}`;
}

export function lockMessage(lock: SharedLock, now = new Date()): string {
  const since = sinceLabel(lock.since, now);
  return `Ouvert par ${lock.by} dans ${APPS[lock.app] ?? 'une autre application'}${since ? ` depuis ${since}` : ''}`;
}

/**
 * Ce verrou donne-t-il la main à quelqu'un d'autre ? Seul le nôtre (WorkLogs, cette
 * installation) ne bloque pas ; LibreOffice ouvert sur cet ordinateur, si.
 */
export const lockBlocks = (lock: SharedLock | null | undefined): lock is SharedLock =>
  Boolean(lock && !lock.stale && !(lock.app === 'worklogs' && lock.self));

/** Un verrou oublié (plantage, coupure) : il se reprend, sur demande explicite. */
export const lockForgotten = (lock: SharedLock | null | undefined): lock is SharedLock =>
  Boolean(lock && lock.stale && !(lock.app === 'worklogs' && lock.self));

/** La main se rend après 10 min sans frappe ; le brouillon, lui, reste. */
export const IDLE_MS = 10 * 60 * 1000;
export const idleExpired = (lastEdit: number, now: number) => now - lastEdit >= IDLE_MS;

export const REACH_LABELS: Record<SharedReach, string> = {
  ok: 'Joignable',
  offline: 'Injoignable',
  unmounted: 'Non monté',
  blocked: 'Bloqué',
  unconfigured: 'Non choisi',
};

export const REACH_HELP: Record<SharedReach, string> = {
  ok: '',
  offline: 'Le dossier partagé ne répond pas (réseau ou VPN ?). Les fichiers déjà ouverts restent modifiables ici ; leurs envois partiront au retour.',
  unmounted: 'Le dossier partagé n’est pas monté sur cet ordinateur. Monte-le (Fichiers → Autres emplacements), WorkLogs le retrouvera seul.',
  blocked: 'Le dossier partagé ne répond plus du tout. WorkLogs attend qu’il se libère ; rien n’est perdu.',
  unconfigured: '',
};

export type SharedBanner =
  | { kind: 'conflict'; message: string; deleted: boolean }
  | { kind: 'readonly'; message: string; forgotten: boolean }
  | { kind: 'pending'; message: string }
  | { kind: 'offline'; message: string }
  | { kind: 'interrupted'; message: string }
  | { kind: 'deleted'; message: string }
  | { kind: 'changed'; message: string };

/**
 * Le bandeau le plus important d'abord : un conflit à régler prime sur tout,
 * puis la lecture seule (le tour de quelqu'un d'autre), puis l'envoi en attente.
 */
export function bannerFor(file: SharedFile, { dirty, override, now = new Date() }: { dirty: boolean; override: boolean; now?: Date }): SharedBanner | null {
  if (file.state === 'conflict') {
    if (file.theirs?.deleted) {
      return { kind: 'conflict', deleted: true, message: 'Ce fichier a été supprimé du dossier partagé pendant que tu le modifiais.' };
    }
    const when = sinceLabel(file.theirs?.mtime ?? null, now);
    const who = file.theirs?.author ? `${file.theirs.author} a` : 'Quelqu’un a';
    return { kind: 'conflict', deleted: false, message: `${who} enregistré ce fichier sur le partage${when ? ` (${when})` : ''} pendant que tu le modifiais. Rien n’a été écrasé.` };
  }
  if (lockBlocks(file.lock) && !override) return { kind: 'readonly', forgotten: false, message: `Lecture seule — ${lockMessage(file.lock, now)}.` };
  if (lockForgotten(file.lock) && !override && !file.held) {
    return { kind: 'readonly', forgotten: true, message: `Lecture seule — ${lockMessage(file.lock, now)}, sans signe de vie depuis plusieurs minutes : verrou probablement oublié.` };
  }
  if (file.state === 'pending') return { kind: 'pending', message: `Envoi en attente — ${file.note || 'le fichier est ouvert ailleurs'}. Il partira quand le fichier sera libre.` };
  if (file.state === 'offline' || (file.source === 'cache' && file.send.requested)) {
    return { kind: 'offline', message: 'Hors ligne — ta version est gardée sur cet ordinateur et partira dès que le partage répond.' };
  }
  if (file.state === 'interrupted') return { kind: 'interrupted', message: 'Envoi interrompu — WorkLogs le reprendra sans écraser une autre version.' };
  if (file.source === 'cache') return { kind: 'offline', message: 'Hors ligne — copie gardée sur cet ordinateur. Tes modifications restent ici en attendant le partage.' };
  if (file.deleted) return { kind: 'deleted', message: 'Ce fichier n’est plus sur le dossier partagé. Ton brouillon est gardé ici.' };
  if ((dirty || file.draft) && file.hash && file.base_hash && file.hash !== file.base_hash) {
    return { kind: 'changed', message: 'Modifié sur le partage depuis que tu as commencé. Ton envoi le détectera et te laissera choisir.' };
  }
  return null;
}

export interface SharedBadge {
  icon: string;
  label: string;
}

/** Pastilles d'un fichier dans l'arbre, avec leur libellé accessible. */
export function badgesFor(entry: SharedEntry, now = new Date()): SharedBadge[] {
  const badges: SharedBadge[] = [];
  if (entry.lock && !(entry.lock.app === 'worklogs' && entry.lock.self)) badges.push({ icon: '🔒', label: lockMessage(entry.lock, now) + (entry.lock.stale ? ' (probablement oublié)' : '') });
  const state = entry.local?.state;
  if (state === 'conflict') badges.push({ icon: '⚠', label: 'Conflit à régler' });
  else if (state === 'pending' || state === 'offline' || state === 'interrupted') badges.push({ icon: '⇡', label: 'Envoi en attente' });
  else if (entry.local?.draft) badges.push({ icon: '✎', label: 'Brouillon sur cet ordinateur' });
  if (entry.local?.modified) badges.push({ icon: '↻', label: 'Modifié sur le partage depuis ta dernière lecture' });
  if (entry.cached) badges.push({ icon: '⌂', label: 'Gardé sur cet ordinateur' });
  return badges;
}
