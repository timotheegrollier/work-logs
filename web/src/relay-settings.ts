/**
 * PWA : où joindre le relais du dossier partagé (VM du bureau, par Tailscale) et
 * son code d'accès. Gardés sur ce téléphone seulement (stockage de la PWA) —
 * jamais synchronisés par Drive : le code ouvre les fichiers de l'entreprise.
 */

const KEY = 'worklogs-relais';

export interface RelaySettings {
  url: string;
  token: string;
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
    if (settings) localStorage.setItem(KEY, JSON.stringify(settings));
    else localStorage.removeItem(KEY);
  } catch {
    // Stockage refusé (navigation privée) : le relais reste à saisir à chaque visite.
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
