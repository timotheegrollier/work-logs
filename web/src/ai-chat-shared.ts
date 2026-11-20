import { AiCancelled } from './ai-suggest';
import { editorKind } from './file-formats';
import { api, ApiError, sharedClient, type SharedClient, type SharedSearchResult, type SharedStatus } from './lib';
import { hasHtmlOrImage } from './markdown';
import { fileNameProblem, procedureFileBytes, withExtension } from './new-files';
import { readRelay } from './relay-settings';
import { localDir } from './shared-links';
import { decodeText } from './text-codec';

const UNAVAILABLE = 'Dossier partagé indisponible.';
const OFFLINE = 'Partage hors ligne : seules les dernières listes vues sont disponibles.';
const UNMOUNTED = 'Partage non monté sur cet ordinateur, souvent après un redémarrage : « Se reconnecter » dans le dossier partagé, puis redemande. Seules les dernières listes vues sont disponibles.';
const PARTIAL = 'Partage : recherche partielle.';
const MOVED = 'Le dossier partagé a changé depuis la proposition. Redemande à l’assistant.';
const OCCUPIED = 'Un autre fichier occupe ce nom sur le partage.';
const UNCONFIRMED = 'Impossible de vérifier si la procédure a été créée. Réessaie quand le partage répond.';
const MAX_RESULTS = 8;
const MAX_DIRECTORIES = 12;
const MAX_EXCERPT = 3000;
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_DOCX_BYTES = 4 * 1024 * 1024;
const READ_TIMEOUT_MS = 15_000;

interface ShareIdentity {
  root: string;
  address: string | null;
  relay: string | null;
}

export interface ChatShare {
  client: SharedClient;
  /** Première racine compatible, proposée par défaut pour les créations. */
  dirs: string[];
  available: boolean;
  notice: string;
  online: boolean;
  identity: ShareIdentity | null;
  indexedFiles: Set<string>;
  indexedDirectories: Set<string>;
}

export interface ChatSharedProposal {
  kind: 'create_shared_procedure';
  title: string;
  content_md: string;
  path: string;
  label: string;
  identity: ShareIdentity;
}

const relayUrl = (client: SharedClient) => client === api && import.meta.env.VITE_PWA === '1' ? readRelay()?.url ?? null : null;
const identify = (status: SharedStatus, relay: string | null): ShareIdentity | null =>
  status.available && status.root && !status.relayError ? { root: status.root, address: status.address ?? null, relay } : null;
const isOnline = (status: SharedStatus) => !status.reach || status.reach === 'ok';
// « Se reconnecter » n'existe que sur le desktop : derrière le relais, le montage est celui de la VM.
const offlineNotice = (status: SharedStatus | null, relay: string | null) => status?.reach === 'unmounted' && !relay ? UNMOUNTED : OFFLINE;
const sameShare = (left: ShareIdentity, right: ShareIdentity | null) =>
  left.root === right?.root && left.address === right.address && left.relay === right.relay;
const validPath = (path: string) => path === '' || (path.length <= 1024 && !/[\\\x00-\x1f\x7f]/.test(path) && path.split('/').every((part) => part && part !== '.' && part !== '..'));
const within = (path: string, dir: string) => validPath(path) && (!dir || path === dir || path.startsWith(`${dir}/`));
const withinShare = (path: string, share: ChatShare) => share.dirs.some((dir) => within(path, dir));
const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));

/** Les routes existantes ont leur propre délai. Arrêter ici rend aussi la main sans attendre leur réponse. */
async function readWithin<T>(read: () => Promise<T>, signal?: AbortSignal, timeout = READ_TIMEOUT_MS): Promise<T> {
  if (signal?.aborted) throw new AiCancelled();
  let abort: () => void = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([new Promise<never>((_, reject) => {
      abort = () => reject(new AiCancelled());
      timer = setTimeout(() => reject(new Error('Le dossier partagé ne répond pas.')), timeout);
      signal?.addEventListener('abort', abort, { once: true });
    }), read()]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

/** Fige le relais de la PWA pour toute la lecture. Le montage desktop reste vérifié par l’API. */
export async function readChatShare(client: SharedClient, projectSharedDir?: string | string[] | null, signal?: AbortSignal): Promise<ChatShare> {
  const relay = relayUrl(client);
  const bound = relay ? sharedClient(relay) : client;
  const status = await readWithin(() => bound.sharedStatus(), signal, 5000).catch((error: unknown) => {
    if (error instanceof AiCancelled) throw error;
    return null;
  });
  const identity = status && identify(status, relay);
  const links = (typeof projectSharedDir === 'string' ? [projectSharedDir] : projectSharedDir ?? []).filter(Boolean);
  const linked = links.map((link) => localDir(status?.address, link)).filter((dir): dir is string => dir !== null && validPath(dir));
  const dirs = links.length ? [...new Set(linked)] : [''];
  const compatible = dirs.length > 0;
  const available = Boolean(identity && compatible);
  const online = Boolean(available && status && isOnline(status));
  return {
    client: bound, dirs, available, online, identity,
    notice: !identity ? UNAVAILABLE : !compatible ? 'Les dossiers reliés au projet sont en dehors du partage configuré.'
      : !online ? offlineNotice(status, relay) : linked.length < links.length ? 'Certains dossiers reliés au projet sont en dehors du partage configuré.' : '',
    indexedFiles: new Set(), indexedDirectories: new Set(online ? dirs : []),
  };
}

/** Deux lectures simultanées au plus, dans le délai partagé de la recherche. */
async function readScopes<T>(dirs: string[], read: (dir: string) => Promise<T>, deadline: number, signal?: AbortSignal) {
  const results: { dir: string; value: T | null }[] = [];
  for (let index = 0; index < dirs.length; index += 2) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    results.push(...await Promise.all(dirs.slice(index, index + 2).map(async (dir) => {
      try {
        return { dir, value: await readWithin(() => read(dir), signal, remaining) };
      } catch (error) {
        if (error instanceof AiCancelled) throw error;
        return { dir, value: null };
      }
    })));
  }
  return { results, partial: results.length < dirs.length };
}

/** Recherche les noms dans le partage et conserve uniquement les chemins relatifs rendus par ce partage. */
export async function searchChatShare(share: ChatShare, terms: string[], signal?: AbortSignal): Promise<{ files: SharedSearchResult[]; directories: string[]; notice: string }> {
  if (!share.available) return { files: [], directories: [], notice: share.notice };
  const queries = [...new Set(terms.map((term) => term.trim()).filter((term) => term.length <= 100 && term.replace(/\s/g, '').length >= 2))].slice(0, 3);
  const found = new Map<string, { file: SharedSearchResult; matches: number }>();
  const directories = new Set(share.online ? share.dirs : []);
  const fileParents = new Set<string>();
  let notice = share.notice;
  const deadline = Date.now() + READ_TIMEOUT_MS;
  // Un parent couvre déjà ses sous-dossiers, même s’il arrive après eux dans les liens.
  const scopes = share.dirs.filter((dir) => !share.dirs.some((parent) => parent !== dir && within(dir, parent)));

  if (queries.length === 0 && share.online) {
    const listings = await readScopes(scopes, (dir) => share.client.sharedList(dir), deadline, signal);
    const listedScopes: string[] = [];
    const children = new Set<string>();
    for (const { dir, value: listing } of listings.results) {
      if (!listing || listing.offline || listing.reach !== 'ok') {
        notice ||= listing ? OFFLINE : UNAVAILABLE;
        continue;
      }
      listedScopes.push(dir);
      for (const entry of listing.entries) {
        if (entry.type === 'dir' && within(entry.path, dir) && parentOf(entry.path) === dir) children.add(entry.path);
      }
      if (listing.truncated) notice ||= PARTIAL;
    }
    directories.clear();
    share.dirs.filter((dir) => listedScopes.some((scope) => within(dir, scope))).forEach((dir) => directories.add(dir));
    children.forEach((dir) => directories.add(dir));
    if (listedScopes.length && listedScopes.length < listings.results.length && !share.notice) notice = PARTIAL;
    if (listings.partial) notice ||= PARTIAL;
  }

  for (const query of queries) {
    const searches = await readScopes(scopes, (dir) => share.client.searchShared(query, dir), deadline, signal);
    let offline = false;
    for (const { dir, value: search } of searches.results) {
      if (!search) { notice ||= found.size > 0 ? PARTIAL : UNAVAILABLE; continue; }
      if (search.offline) {
        notice = share.notice || OFFLINE;
        directories.clear();
        fileParents.clear();
        offline = true;
      } else if (search.partial || search.denied > 0) notice ||= PARTIAL;
      for (const file of search.results) {
        if (!file.path || !within(file.path, dir) || file.dir !== parentOf(file.path)) continue;
        if (file.type === 'file') {
          found.set(file.path, { file, matches: (found.get(file.path)?.matches ?? 0) + 1 });
          if (!search.offline) fileParents.add(file.dir);
        } else if (file.type === 'dir' && !search.offline) directories.add(file.path);
      }
    }
    if (notice === UNAVAILABLE && searches.results.some(({ value }) => value !== null)) notice = PARTIAL;
    if (searches.partial) notice ||= PARTIAL;
    if (offline || searches.partial || searches.results.every(({ value }) => value === null)) break;
  }

  const files = [...found.values()].sort((a, b) => b.matches - a.matches).slice(0, MAX_RESULTS).map(({ file }) => file);
  const destinations = [...new Set([...directories, ...fileParents])].slice(0, MAX_DIRECTORIES);
  files.forEach(({ path }) => share.indexedFiles.add(path));
  destinations.forEach((dir) => share.indexedDirectories.add(dir));
  return { files, directories: destinations, notice };
}

/** Extrait de la version visible sur le serveur. Les brouillons, envois et versions en cache restent locaux. */
export async function readChatSharedExcerpt(share: ChatShare, file: SharedSearchResult, signal?: AbortSignal): Promise<string> {
  if (!share.online || !share.identity) throw new Error(share.notice || OFFLINE);
  if (!share.indexedFiles.has(file.path) || !withinShare(file.path, share) || file.type !== 'file' || file.dir !== parentOf(file.path)) throw new Error('Fichier partagé inconnu.');
  const kind = editorKind(file.ext);
  if (kind !== 'text' && kind !== 'markdown' && kind !== 'docx') throw new Error('L’assistant peut lire le texte des documents Word, Markdown et texte.');
  const limit = kind === 'docx' ? MAX_DOCX_BYTES : MAX_TEXT_BYTES;
  // Les diagnostics d’E/S peuvent contenir un chemin absolu ou le nom d’un compte.
  // Ils ne doivent pas devenir un résultat de lecture envoyé au fournisseur.
  const read = <T>(operation: () => Promise<T>) => readWithin(operation, signal).catch((error: unknown) => {
    if (error instanceof AiCancelled) throw error;
    throw new Error('Lecture indisponible sur le dossier partagé.');
  });

  const status = await read(() => share.client.sharedStatus());
  if (!sameShare(share.identity, identify(status, share.identity.relay))) throw new Error(MOVED);
  if (!isOnline(status)) throw new Error(offlineNotice(status, share.identity.relay));
  const listing = await read(() => share.client.sharedList(file.dir));
  if (listing.offline || listing.reach !== 'ok') throw new Error(OFFLINE);
  const listed = listing.entries.find((item) => item.path === file.path && item.type === 'file');
  if (!listed || listed.size === null) throw new Error('Impossible de vérifier la taille du document sur le partage.');
  if (listed.size > limit) throw new Error('Ce document est trop volumineux pour l’assistant.');
  const remote = await read(() => share.client.sharedFile(file.path));
  const { hash } = remote;
  if (remote.source !== 'share' || remote.deleted || !hash || remote.path !== file.path || remote.size === null) throw new Error('Version actuelle du document indisponible sur le serveur.');
  if (remote.size > limit) throw new Error('Ce document est trop volumineux pour l’assistant.');
  const bytes = await read(() => share.client.sharedContent(hash));
  if (bytes.length > limit) throw new Error('Ce document est trop volumineux pour l’assistant.');

  const text = kind === 'docx' ? await readWordExcerpt(bytes) : decodeText(bytes).text;
  if (signal?.aborted) throw new AiCancelled();
  const excerpt = text
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/<!--[\s\S]*?-->|<\/?[A-Za-z][^<>]*>/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]+\)/g, '$1')
    .trim();
  if (!excerpt) throw new Error('Aucun texte lisible dans ce document.');
  return excerpt.length > MAX_EXCERPT ? `${excerpt.slice(0, MAX_EXCERPT - 1)}…` : excerpt;
}

async function readWordExcerpt(bytes: Uint8Array): Promise<string> {
  try {
    const [{ readDocxDocument }, { docxToAi }] = await Promise.all([import('./docx'), import('./docx-markdown')]);
    const document = await readDocxDocument(bytes);
    return docxToAi(document.doc, document).markdown;
  } catch {
    throw new Error('Document Word illisible par WorkLogs.');
  }
}

/** Une destination est un numéro de la liste envoyée, jamais un chemin fourni par le modèle. */
export function prepareChatSharedProcedure(share: ChatShare, directories: string[], { title: rawTitle, content, directory }: { title: unknown; content: unknown; directory?: unknown }): ChatSharedProposal {
  if (!share.identity || !share.online) throw new Error(share.notice || UNAVAILABLE);
  const dir = directory === undefined ? directories[0] : Number.isInteger(directory) ? directories[(directory as number) - 1] : undefined;
  if (dir === undefined || !share.indexedDirectories.has(dir) || !withinShare(dir, share)) throw new Error('Dossier de destination inconnu.');
  const title = typeof rawTitle === 'string' ? rawTitle.trim().replace(/\s+/g, ' ').replace(/\.docx$/i, '').trimEnd() : '';
  const name = withExtension(title, 'docx');
  const problem = fileNameProblem(title) || fileNameProblem(name);
  if (problem) throw new Error(problem);
  const path = dir ? `${dir}/${name}` : name;
  if (!validPath(path)) throw new Error('Chemin de destination invalide.');
  const content_md = typeof content === 'string' ? content.trim() : '';
  if (!content_md || content_md.length > 12_000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content_md) || hasHtmlOrImage(content_md)) {
    throw new Error('Contenu de procédure invalide : texte ou Markdown sans HTML ni images, 12 000 caractères au plus.');
  }
  return { kind: 'create_shared_procedure', title, content_md, path, label: `Créer la procédure Word « ${path} » sur le partage`, identity: share.identity };
}

/** Les octets restent les mêmes lors d’un nouvel essai après une réponse perdue. */
const unconfirmed = new WeakMap<ChatSharedProposal, Uint8Array>();

async function verifyCreation(client: SharedClient, path: string, bytes: Uint8Array): Promise<'written' | 'missing' | 'different' | 'unknown'> {
  try {
    const file = await readWithin(() => client.sharedFile(path));
    if (file.path !== path || file.source !== 'share' || file.deleted || !file.hash) return 'unknown';
    if (file.size !== bytes.length) return 'different';
    const hash = file.hash;
    const existing = await readWithin(() => client.sharedContent(hash));
    return existing.length === bytes.length && existing.every((byte, index) => byte === bytes[index]) ? 'written' : 'different';
  } catch (error) {
    return error instanceof ApiError && error.code === 'SHARED_NOT_FOUND' ? 'missing' : 'unknown';
  }
}

const definitive = new Set(['SHARED_EXISTS', 'SHARED_BAD_PATH', 'SHARED_BAD_NAME', 'SHARED_DENIED', 'SHARED_TOO_BIG']);

export async function applyChatSharedProcedure(client: SharedClient, proposal: ChatSharedProposal): Promise<void> {
  const relay = relayUrl(client);
  if (relay !== proposal.identity.relay) throw new Error(MOVED);
  const bound = relay ? sharedClient(relay) : client;
  const status = await readWithin(() => bound.sharedStatus());
  if (!sameShare(proposal.identity, identify(status, relay))) throw new Error(MOVED);
  if (!isOnline(status)) throw new Error(offlineNotice(status, relay));
  const listing = await readWithin(() => bound.sharedList(parentOf(proposal.path)));
  if (listing.offline || listing.reach !== 'ok') throw new Error(OFFLINE);
  const previous = unconfirmed.get(proposal);
  if (previous) {
    const verification = await verifyCreation(bound, proposal.path, previous);
    if (verification === 'written') { unconfirmed.delete(proposal); return; }
    if (verification === 'different') throw new Error(OCCUPIED);
    if (verification === 'unknown') throw new Error(UNCONFIRMED);
  }
  const bytes = previous ?? await procedureFileBytes('docx', { title: proposal.title, markdown: proposal.content_md, author: status.displayName ?? '' });
  try {
    await readWithin(() => bound.createShared(proposal.path, bytes));
    unconfirmed.delete(proposal);
  } catch (error) {
    // Une première création peut finir pendant le nouvel essai : le 409 déclenche alors une vérification.
    if (error instanceof ApiError && error.code && definitive.has(error.code) && !(previous && error.code === 'SHARED_EXISTS')) throw error;
    unconfirmed.set(proposal, bytes);
    const verification = await verifyCreation(bound, proposal.path, bytes);
    if (verification === 'written') { unconfirmed.delete(proposal); return; }
    if (verification === 'different') throw new Error(OCCUPIED);
    if (verification === 'missing') throw error instanceof ApiError ? error : new Error('La création n’a pas pu être confirmée sur le partage.');
    throw new Error(UNCONFIRMED);
  }
}
