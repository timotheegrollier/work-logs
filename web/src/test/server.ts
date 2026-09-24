import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
// @ts-expect-error — l'API est du JavaScript pur, hors du projet TypeScript du front.
import { createApp } from '../../../api/src/app.js';
// @ts-expect-error — idem.
import { openDb } from '../../../api/src/db.js';

/**
 * Démarre la vraie API sur une base jetable et redirige `fetch('/api/…')`
 * vers elle. Les tests du front exercent donc le backend réel : aucun faux
 * serveur à maintenir, aucune divergence possible.
 */
export async function useRealApi() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-web-'));
  const db = openDb(path.join(dir, 'worklogs.db'), { withSeed: false });
  const server = createApp({ db, uploadDir: path.join(dir, 'uploads') }).listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return realFetch(url.startsWith('/') ? base + url : url, init);
  }) as typeof fetch;

  return {
    db,
    base,
    /**
     * Envoie un fichier en multipart, comme le ferait le navigateur. Le corps
     * est construit à la main : en environnement jsdom, `FormData` est celui du
     * DOM et le `fetch` de Node ne sait pas l'encoder — multer ne verrait alors
     * aucun fichier. Un corps `Buffer` avec sa frontière marche dans les deux.
     */
    async upload(filename: string, contents: string | Buffer, fields: Record<string, string> = {}) {
      const boundary = '----worklogs' + Math.random().toString(36).slice(2);
      const chunks: Buffer[] = [];
      const part = (header: string, body: Buffer) => {
        chunks.push(Buffer.from(`--${boundary}\r\n${header}\r\n\r\n`), body, Buffer.from('\r\n'));
      };
      part(`Content-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain`,
        Buffer.from(contents));
      for (const [key, value] of Object.entries(fields)) {
        part(`Content-Disposition: form-data; name="${key}"`, Buffer.from(value));
      }
      chunks.push(Buffer.from(`--${boundary}--\r\n`));
      const res = await realFetch(`${base}/api/uploads`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body: Buffer.concat(chunks),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    async close() {
      globalThis.fetch = realFetch;
      server.close();
      await once(server, 'close');
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Insère un jeu de données directement en base, sans passer par l'UI. */
export function seedData(
  db: {
    prepare: (sql: string) => { run: (...args: unknown[]) => void };
    exec: (sql: string) => void;
  },
  {
    projects = [] as { id: string; name: string; color?: string }[],
    entries = [] as { id: string; title: string; content_md?: string; date?: string; project_id?: string | null; kind?: 'note' | 'procedure' }[],
    tasks = [] as { id: string; title: string; status?: string; due_date?: string | null; pinned?: 0 | 1; project_id?: string | null }[],
  }
) {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  for (const p of projects) {
    db.prepare('INSERT INTO projects (id,name,color,created_at) VALUES (?,?,?,?)').run(
      p.id,
      p.name,
      p.color ?? '#4f7cff',
      now
    );
  }
  entries.forEach((e) => {
    db.prepare(
      'INSERT INTO entries (id,title,content_md,entry_date,project_id,kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)'
    ).run(e.id, e.title, e.content_md ?? '', e.date ?? today, e.project_id ?? null, e.kind ?? 'note', now, now);
  });
  tasks.forEach((t, index) => {
    db.prepare(
      'INSERT INTO tasks (id,title,status,due_date,pinned,position,project_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(t.id, t.title, t.status ?? 'todo', t.due_date ?? null, t.pinned ?? 0, index, t.project_id ?? null, now, now);
  });
}
