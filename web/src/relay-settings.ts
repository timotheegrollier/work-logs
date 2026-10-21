/**
 * PWA : où joindre le relais du dossier partagé (VM du bureau, par Tailscale) et
 * son code d'accès. Gardés sur ce téléphone (stockage de la PWA), et copiés dans
 * le compte Google connecté (`store/relay-drive.ts`, §29) pour revenir seuls
 * quand le téléphone les a perdus.
 */

const KEY = 'worklogs-relais';
/** Date du dernier « Oublier ce relais » : la copie Drive plus ancienne ne revient pas. */
const FORGOTTEN_KEY = 'worklogs-relais-oublie';

export interface RelaySettings {
  url: string;
  token: string;
  /** Moment de l'enregistrement : entre deux appareils, le plus récent gagne. */
  saved_at?: string;
}

export function readRelay(): RelaySettings | null {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? 'null') as RelaySettings | null;
    return value?.url && value.token ? value : null;
  } catch {
    return null;
  }
}

export function saveRelay(settings: RelaySettings | null) {
  try {
    if (settings) {
      localStorage.setItem(KEY, JSON.stringify({ ...settings, saved_at: settings.saved_at || new Date().toISOString() }));
      localStorage.removeItem(FORGOTTEN_KEY);
    } else {
      localStorage.removeItem(KEY);
      localStorage.setItem(FORGOTTEN_KEY, new Date().toISOString());
    }
  } catch {
    // Stockage refusé (navigation privée) : le relais reste à saisir à chaque visite.
  }
}

export function relayForgottenAt(): string {
  try {
    return localStorage.getItem(FORGOTTEN_KEY) || '';
  } catch {
    return '';
  }
}

export function clearRelayForgotten() {
  try {
    localStorage.removeItem(FORGOTTEN_KEY);
  } catch {
    // Rien à faire : la marque disparaîtra au prochain enregistrement.
  }
}

/**
 * « relais.tailnet.ts.net » → « https://relais.tailnet.ts.net » ; HTTPS exigé (la PWA
 * est en HTTPS : une adresse http serait bloquée), sauf l'adresse locale des tests.
 */
export function normalizeRelayUrl(input: string): string {
  let value = input.trim().replace(/\/+$/, '');
  if (!value) throw new Error('Indique l’adresse du relais.');
  if (!/^[a-z]+:\/\//i.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Adresse du relais invalide.');
  }
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('Le relais doit être en HTTPS (https://…).');
  return url.origin + url.pathname.replace(/\/+$/, '');
}
