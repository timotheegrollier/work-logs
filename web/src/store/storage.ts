import { LOCAL_DB_NAME, LOCAL_DB_VERSION, LOCAL_STORES } from './schema';

/** Ligne de table : objet simple, clé portée par la colonne du schéma. */
export interface Table<T extends object> {
  all(): Promise<T[]>;
  get(key: string): Promise<T | undefined>;
  put(value: T): Promise<void>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
}

export type StoreWrite =
  | { table: string; value: object; operation?: 'add' | 'put' }
  | { table: string; key: string; operation: 'delete' }
  | { table: string; operation: 'clear' };

export interface Database {
  table<T extends object>(name: string): Table<T>;
  addAll(rows: { table: string; value: object }[]): Promise<void>;
  writeAll(rows: StoreWrite[]): Promise<void>;
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
  const writeAll = async (rows: StoreWrite[]) => {
    const pending = new Map<string, Map<string, Record<string, unknown> | null>>();
    const cleared = new Set<string>();
    for (const row of rows) {
      const target = store(row.table);
      let batch = pending.get(row.table);
      if (!batch) {
        batch = new Map();
        pending.set(row.table, batch);
      }
      if (row.operation === 'clear') {
        cleared.add(row.table);
        batch.clear();
      } else if (row.operation === 'delete') {
        batch.set(row.key, null);
      } else {
        const key = keyOf(row.table, row.value);
        const exists = batch.has(key) ? batch.get(key) !== null : !cleared.has(row.table) && target.has(key);
        if (row.operation === 'add' && exists) throw new Error(`Clé déjà présente dans ${row.table}.`);
        batch.set(key, { ...row.value });
      }
    }
    for (const [table, batch] of pending) {
      const target = store(table);
      if (cleared.has(table)) target.clear();
      for (const [key, value] of batch) {
        if (value === null) target.delete(key);
        else target.set(key, value);
      }
    }
  };
  return {
    addAll: (rows) => writeAll(rows.map((row) => ({ ...row, operation: 'add' }))),
    writeAll,
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
  const writeAll = async (rows: StoreWrite[]) => {
    if (!rows.length) return;
    const database = await db();
    const transaction = database.transaction([...new Set(rows.map(({ table }) => table))], 'readwrite');
    return new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error('Écriture IndexedDB annulée.'));
      try {
        for (const row of rows) {
          const target = transaction.objectStore(row.table);
          if (row.operation === 'clear') target.clear();
          else if (row.operation === 'delete') target.delete(row.key);
          else {
            keyOf(row.table, row.value);
            if (row.operation === 'add') target.add(row.value);
            else target.put(row.value);
          }
        }
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    });
  };
  return {
    addAll: (rows) => writeAll(rows.map((row) => ({ ...row, operation: 'add' }))),
    writeAll,
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
