import { LOCAL_DB_NAME, LOCAL_DB_VERSION, LOCAL_STORES } from './schema';

/** Ligne de table : objet simple, clé portée par la colonne du schéma. */
export interface Table<T extends object> {
  all(): Promise<T[]>;
  get(key: string): Promise<T | undefined>;
  put(value: T): Promise<void>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
}

export interface Database {
  table<T extends object>(name: string): Table<T>;
  addAll(rows: { table: string; value: object }[]): Promise<void>;
}

function keyOf(table: string, value: object): string {
  const keyPath = LOCAL_STORES[table];
  if (!keyPath) throw new Error(`Table inconnue : ${table}.`);
  const key = (value as Record<string, unknown>)[keyPath];
  if (typeof key !== 'string' || !key) throw new Error(`Clé manquante pour ${table}.`);
  return key;
}

/** Backend volatil : tests et repli si IndexedDB est indisponible. */
export function createMemoryDatabase(): Database {
  const stores = new Map<string, Map<string, Record<string, unknown>>>();
  const store = (name: string) => {
    if (!(name in LOCAL_STORES)) throw new Error(`Table inconnue : ${name}.`);
    let map = stores.get(name);
    if (!map) {
      map = new Map();
      stores.set(name, map);
    }
    return map;
  };
  return {
    async addAll(rows) {
      const pending = new Map<string, Map<string, Record<string, unknown>>>();
      for (const { table, value } of rows) {
        const key = keyOf(table, value);
        const batch = pending.get(table) ?? new Map();
        if (store(table).has(key) || batch.has(key)) throw new Error(`Clé déjà présente dans ${table}.`);
        batch.set(key, { ...value });
        pending.set(table, batch);
      }
      for (const [table, batch] of pending) {
        const target = store(table);
        for (const [key, value] of batch) target.set(key, value);
      }
    },
    table<T extends object>(name: string): Table<T> {
      const map = store(name);
      return {
        all: async () => [...map.values()].map((row) => ({ ...row }) as T),
        get: async (key) => (map.has(key) ? ({ ...map.get(key) }) as T : undefined),
        put: async (value) => {
          map.set(keyOf(name, value), { ...value } as Record<string, unknown>);
        },
        remove: async (key) => {
          map.delete(key);
        },
        clear: async () => {
          map.clear();
        },
      };
    },
  };
}

function openIndexedDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB indisponible sur ce navigateur.'));
      return;
    }
    const request = indexedDB.open(LOCAL_DB_NAME, LOCAL_DB_VERSION);
    request.onupgradeneeded = () => {
      for (const [name, keyPath] of Object.entries(LOCAL_STORES)) {
        if (!request.result.objectStoreNames.contains(name)) {
          request.result.createObjectStore(name, { keyPath });
        }
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error('Ouverture IndexedDB impossible.'));
  });
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Accès IndexedDB impossible.'));
  });
}

/** Backend persistant du navigateur. Ouverture paresseuse et partagée : le
 * module ne touche jamais à `indexedDB` à l'import (tests, SSR, vieux navigateurs). */
export function createIndexedDbDatabase(): Database {
  let opened: Promise<IDBDatabase> | null = null;
  const db = () => (opened ??= openIndexedDb());
  const store = async (name: string, mode: IDBTransactionMode) =>
    (await db()).transaction(name, mode).objectStore(name);
  return {
    async addAll(rows) {
      if (!rows.length) return;
      const values = rows.map(({ table, value }) => {
        keyOf(table, value);
        return { table, value: structuredClone(value) };
      });
      const database = await db();
      const transaction = database.transaction([...new Set(values.map(({ table }) => table))], 'readwrite');
      return new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error('Écriture IndexedDB annulée.'));
        try {
          for (const { table, value } of values) transaction.objectStore(table).add(value);
        } catch (error) {
          transaction.abort();
          reject(error);
        }
      });
    },
    table<T extends object>(name: string): Table<T> {
      if (!(name in LOCAL_STORES)) throw new Error(`Table inconnue : ${name}.`);
      return {
        all: async () => idbRequest((await store(name, 'readonly')).getAll() as IDBRequest<T[]>),
        get: async (key) => (await idbRequest((await store(name, 'readonly')).get(key))) as T | undefined,
        put: async (value) => {
          keyOf(name, value);
          await idbRequest((await store(name, 'readwrite')).put(structuredClone(value)));
        },
        remove: async (key) => {
          await idbRequest((await store(name, 'readwrite')).delete(key));
        },
        clear: async () => {
          await idbRequest((await store(name, 'readwrite')).clear());
        },
      };
    },
  };
}
