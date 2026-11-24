/**
 * IA intégrée au navigateur (Prompt API de Chrome) : gratuite, sans clé, sans compte,
 * et le texte ne quitte pas l'appareil. WorkLogs s'en sert en premier ; quand elle
 * n'existe pas (Firefox, Electron, appareil non compatible), les gestes IA retombent
 * sur la recherche locale, jamais sur un service payant.
 */

type Availability = 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported';

interface DeviceSession {
  prompt(text: string, options?: { signal?: AbortSignal }): Promise<string>;
  destroy?(): void;
}

interface DeviceApi {
  availability?: () => Promise<string>;
  capabilities?: () => Promise<{ available?: string } | null>;
  create?: (options?: Record<string, unknown>) => Promise<DeviceSession>;
  params?: () => Promise<unknown>;
}

/** Une seule forme de réponse pour l'écran de réglages et pour le transport. */
export interface DeviceStatus {
  state: Availability;
  /** Taille approximative du modèle quand le navigateur la publie (octets). */
  downloadBytes?: number;
}

const TIMEOUTS = { prompt: 45_000, create: 20_000 } as const;

function deviceApi(): DeviceApi | null {
  const scope = globalThis as unknown as {
    LanguageModel?: DeviceApi;
    ai?: { languageModel?: DeviceApi };
  };
  const api = scope.LanguageModel ?? scope.ai?.languageModel;
  return api && typeof api.create === 'function' ? api : null;
}

function normalize(value: string | undefined): Availability {
  switch (value) {
    case 'available':
    case 'readily':
      return 'available';
    case 'downloadable':
    case 'after-download':
    case 'downloadable-only':
      return 'downloadable';
    case 'downloading':
      return 'downloading';
    case 'unavailable':
    case 'no':
      return 'unavailable';
    default:
      return 'unsupported';
  }
}

/** État de l'IA intégrée, sans télécharger ni créer de session. */
export async function readDeviceAiStatus(): Promise<DeviceStatus> {
  const api = deviceApi();
  if (!api) return { state: 'unsupported' };
  try {
    if (api.availability) return { state: normalize(await api.availability()) };
    const caps = await api.capabilities?.();
    return { state: normalize(caps?.available) };
  } catch {
    return { state: 'unsupported' };
  }
}

/**
 * Prépare l'IA intégrée quand elle est seulement « téléchargeable ». Le navigateur
 * télécharge son modèle une fois ; WorkLogs ne le fait jamais dans le dos de
 * l'utilisateur, seuls les réglages appellent cette fonction.
 */
export async function prepareDeviceAi(): Promise<DeviceStatus> {
  const api = deviceApi();
  if (!api?.create) return { state: 'unsupported' };
  const before = await readDeviceAiStatus();
  if (before.state !== 'downloadable') return before;
  try {
    const session = await api.create({});
    session.destroy?.();
    return await readDeviceAiStatus();
  } catch {
    return { state: 'unavailable' };
  }
}

/** Coupe une promesse qui traîne : un modèle local peut rester bloqué sans réseau. */
function withTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('L’IA intégrée n’a pas répondu à temps.')), ms);
    const stop = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      reject(new DOMException('Demande arrêtée.', 'AbortError'));
    };
    signal?.addEventListener('abort', stop, { once: true });
    promise.then(
      (value) => { clearTimeout(timer); signal?.removeEventListener('abort', stop); resolve(value); },
      (error) => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(error); },
    );
  });
}

/** Retire les clôtures Markdown qu'un petit modèle ajoute autour d'un JSON. */
export function deviceText(raw: string, json: boolean): string {
  const text = raw.trim();
  if (!json) return text;
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.search(/[[{]/);
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}

/**
 * Réponse de l'IA intégrée, ou `null` quand elle n'est pas utilisable ici (absente,
 * seulement téléchargeable, ou média à lire). Aucun téléchargement implicite.
 */
export async function deviceCompletion(
  system: string,
  user: string,
  { json = false, signal, timeoutMs = TIMEOUTS.prompt }: { json?: boolean; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string | null> {
  const api = deviceApi();
  if (!api?.create) return null;
  const status = await readDeviceAiStatus();
  if (status.state !== 'available') return null;
  if (signal?.aborted) throw new DOMException('Demande arrêtée.', 'AbortError');
  let session: DeviceSession | null = null;
  try {
    session = await withTimeout(api.create({
      initialPrompts: [{ role: 'system', content: system }],
      temperature: 0.4,
      topK: 3,
      ...(signal && { signal }),
    }), TIMEOUTS.create, signal);
    const instruction = json && !/json/i.test(user)
      ? `${user}\n\nRéponds uniquement avec un objet JSON valide, sans texte autour.`
      : user;
    const answer = await withTimeout(session.prompt(instruction, { signal }), timeoutMs, signal);
    const text = deviceText(String(answer ?? ''), json);
    return text || null;
  } catch {
    if (signal?.aborted) throw new DOMException('Demande arrêtée.', 'AbortError');
    return null;
  } finally {
    try { session?.destroy?.(); } catch { /* déjà libérée par le navigateur. */ }
  }
}

/** Vrai quand un endpoint local (Ollama, LM Studio…) peut se passer de clé. */
export function isLocalAiEndpoint(endpoint: string): boolean {
  try {
    const { hostname } = new URL(endpoint.trim());
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
  } catch {
    return false;
  }
}
