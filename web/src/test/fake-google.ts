import { vi } from 'vitest';

export const FAKE_CLIENT = '123456789012-abc.apps.googleusercontent.com';
export const FAKE_PROXY = 'https://relais.test';

const key = (byte: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** Le Worker rend une clé par compte (et une autre si son secret change). */
const KEYS: Record<string, string> = { 'acces-timo': key(1), 'acces-secret-change': key(9) };

/**
 * Faux Google pour la PWA : Drive (fichiers retrouvés par étiquette `worklogs_type`,
 * envoi multipart, corbeille, dossiers) et le Worker `/relay-key`. Toute autre
 * adresse (un vrai relais local, par exemple) part sur le vrai réseau.
 */
export function fakeGoogle() {
  const realFetch = globalThis.fetch;
  const drive = {
    files: new Map<string, { type: string; name: string; text: string; trashed: boolean; parents?: string[] }>(),
    keyCalls: 0,
  };
  let next = 0;
  const live = (type: string) => [...drive.files.entries()].filter(([, file]) => file.type === type && !file.trashed);
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    const target = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (target === `${FAKE_PROXY}/relay-key`) {
      drive.keyCalls++;
      const token = (headers.Authorization ?? '').replace(/^Bearer /, '');
      return KEYS[token] ? Response.json({ key: KEYS[token] }) : Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    if (!target.startsWith('https://www.googleapis.com/')) return realFetch(url as RequestInfo, init);
    if (target.includes('/upload/drive/v3/files')) {
      const body = await (init?.body as Blob).text();
      const [, metaPart, contentPart] = body.split(/--worklogs-[\w-]+\r\n/);
      const meta = JSON.parse(metaPart.slice(metaPart.indexOf('\r\n\r\n') + 4).trim());
      const text = contentPart.slice(contentPart.indexOf('\r\n\r\n') + 4, contentPart.lastIndexOf('\r\n--'));
      const existing = /\/upload\/drive\/v3\/files\/([^?]+)/.exec(target)?.[1];
      const id = existing ? decodeURIComponent(existing) : `file-${++next}`;
      drive.files.set(id, { ...drive.files.get(id), type: meta.appProperties.worklogs_type, name: meta.name, text, trashed: false, parents: meta.parents });
      return Response.json({ id, name: meta.name, modifiedTime: `2026-10-21T10:00:${String(next).padStart(2, '0')}.000Z` });
    }
    const fileId = /\/drive\/v3\/files\/([^?]+)/.exec(target)?.[1];
    if (fileId && init?.method === 'PATCH') {
      drive.files.get(decodeURIComponent(fileId))!.trashed = true;
      return Response.json({ id: fileId, trashed: true });
    }
    if (fileId && target.includes('alt=media')) return new Response(drive.files.get(decodeURIComponent(fileId))!.text);
    if (target.includes('/drive/v3/files?supportsAllDrives=true&fields=id') && init?.method === 'POST') {
      const meta = JSON.parse(String(init.body));
      const id = `folder-${++next}`;
      drive.files.set(id, { type: meta.appProperties.worklogs_type, name: meta.name, text: '', trashed: false });
      return Response.json({ id });
    }
    if (target.includes('/drive/v3/files?')) {
      const type = /value='([\w-]+)'/.exec(decodeURIComponent(target))?.[1] ?? '';
      return Response.json({ files: live(type).map(([id, file]) => ({ id, name: file.name, mimeType: 'application/json' })) });
    }
    throw new Error(`appel inattendu : ${target}`);
  });
  return { ...drive, relayFiles: () => live('relay').map(([, file]) => file) };
}

/** Compte Google connecté avec le client intégré (jeton valide une heure). */
export function connectGoogle(access = 'acces-timo') {
  localStorage.setItem('worklogs-google-web-tokens', JSON.stringify({
    access_token: access, refresh_token: 'r', expires_at: Date.now() + 3600_000, account: { email: 'timo@example.com', name: 'Timo' },
  }));
}
