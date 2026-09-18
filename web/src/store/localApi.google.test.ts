import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { importLocalBackup, localApi, readLocalOutbox, setLocalDatabase } from './localApi';
import { createMemoryDatabase } from './storage';
// @ts-expect-error — module Docs pur partagé avec l'API (comme test/server.ts).
import { importGoogleDocument } from '../../../api/src/google-preserve.js';

const T = '2026-09-18T10:00:00.000Z';
const paragraph = (text: string, start = 1) => ({
  startIndex: start,
  endIndex: start + text.length,
  paragraph: {
    elements: [{ startIndex: start, endIndex: start + text.length, textRun: { content: text } }],
    paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
  },
});
const docJson = (text: string, rev: string) => ({ title: 'D', revisionId: rev, body: { content: [paragraph(text)] } });
const doc2Json = (first: string, second: string, rev: string) => {
  const secondStart = 1 + first.length;
  return { title: 'D', revisionId: rev, body: { content: [paragraph(first), paragraph(second, secondStart)] } };
};
const rich = (text: string) => importGoogleDocument(docJson(`${text}\n`, 'r0'));
const rich2 = (first: string, second: string) => importGoogleDocument(doc2Json(`${first}\n`, `${second}\n`, 'r0'));

let currentDoc: unknown;
let batchResult: unknown;
const calls: { target: string; init?: RequestInit }[] = [];

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  setLocalDatabase(createMemoryDatabase());
  localStorage.setItem('worklogs-google-web-tokens', JSON.stringify({ access_token: 'acces', expires_at: Date.now() + 3600_000 }));
  currentDoc = docJson('Bonjour\n', 'r1');
  batchResult = { writeControl: { requiredRevisionId: 'r2' } };
  calls.length = 0;
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    const target = String(url);
    calls.push({ target, init });
    if (target.includes(':batchUpdate')) return Response.json(batchResult);
    if (target.includes('includeTabsContent')) return Response.json(currentDoc);
    if (target.endsWith('/v1/documents') && init?.method === 'POST') {
      return Response.json({ documentId: 'g-new', ...docJson('\n', 'r0') });
    }
    if (target.includes('/drive/v3/files?')) {
      return Response.json({ files: [{ id: 'd1', name: 'Doc', modifiedTime: T }], nextPageToken: 'p2' });
    }
    throw new Error(`appel inattendu : ${target}`);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function linkedEntry(paras: string[] = ['Bonjour'], rev = 'r1') {
  const content = importGoogleDocument(paras.length === 1 ? docJson(`${paras[0]}\n`, 'r0') : doc2Json(`${paras[0]}\n`, `${paras[1]}\n`, 'r0'));
  await importLocalBackup({
    version: 2,
    projects: [],
    entries: [{ id: 'en_g', title: 'Doc', content_md: paras.join('\n'), content_json: content, entry_date: '2026-09-18', project_id: null, created_at: T, updated_at: T }],
    tasks: [],
    task_entries: [],
    google_documents: [{
      entry_id: 'en_g', document_id: 'gdoc-1', tab_id: '', revision_id: rev,
      synced_content_json: JSON.stringify(content), synced_at: T,
      document_title: 'D', tab_title: '', tab_order: 0, tab_depth: 0, readonly_reason: '',
    }],
    attachments: [],
  });
}

const batchCalls = () => calls.filter((c) => c.target.includes(':batchUpdate'));

describe('synchronisation Docs dans le navigateur', () => {
  test('push envoie le patch, avance la révision et sort de la file', async () => {
    await linkedEntry();
    await localApi.updateEntry('en_g', { content_json: rich('Bonjour !') });
    expect(readLocalOutbox().entries).toEqual(['en_g']);
    const updated = await localApi.pushGoogleDocument('en_g');
    expect(batchCalls()).toHaveLength(1);
    const sent = JSON.parse(batchCalls()[0].init?.body as string) as { requests: { insertText?: { text?: string } }[] };
    expect(sent.requests.some((request) => request.insertText?.text === ' !')).toBe(true);
    expect(updated.google_sync?.dirty).toBe(false);
    expect((await localApi.state()).entries.find((e) => e.id === 'en_g')?.google_dirty).toBe(false);
    expect(readLocalOutbox().entries).toEqual([]);
  });

  test('push sans changement ne touche pas au réseau d’écriture', async () => {
    await linkedEntry();
    await localApi.pushGoogleDocument('en_g');
    expect(batchCalls()).toHaveLength(0);
  });

  test('modification distante indépendante réconciliée, même passage en conflit', async () => {
    await linkedEntry(['Bonjour', 'Second']);
    // Distant : autre paragraphe touché (même nombre de paragraphes).
    currentDoc = doc2Json('Bonjour\n', 'Second distant\n', 'r2');
    await localApi.updateEntry('en_g', { content_json: rich2('Bonjour !', 'Second') });
    await localApi.pushGoogleDocument('en_g');
    expect(batchCalls()).toHaveLength(1);

    // Même passage des deux côtés : conflit explicite, brouillon conservé.
    currentDoc = docJson('Bonjour distant\n', 'r3');
    await localApi.updateEntry('en_g', { content_json: rich('Bonjour local') });
    await expect(localApi.pushGoogleDocument('en_g')).rejects.toThrow('brouillon est conservé');
    expect((await localApi.entry('en_g')).content_md).toContain('Bonjour local');
  });

  test('pull recharge Google, refuse si le brouillon a changé', async () => {
    await linkedEntry();
    currentDoc = docJson('Version Google\n', 'r5');
    const before = await localApi.entry('en_g');
    const pulled = await localApi.pullGoogleDocument('en_g', before.content_json as never);
    expect(pulled.content_md).toContain('Version Google');
    expect(pulled.google_sync?.dirty).toBe(false);
    await expect(localApi.pullGoogleDocument('en_g', { type: 'doc' } as never)).rejects.toThrow('brouillon a changé');
  });

  test('refus explicites : Markdown seul, ancien import aplati', async () => {
    const md = await localApi.createEntry({ title: 'Note' });
    await expect(localApi.pushGoogleDocument(md.id)).rejects.toThrow('document riche');
    await importLocalBackup({
      version: 2,
      projects: [],
      entries: [{ id: 'en_old', title: 'Vieux', content_md: 'Vieux', content_json: rich('Vieux'), entry_date: '2026-09-18', project_id: null, created_at: T, updated_at: T }],
      tasks: [],
      task_entries: [],
      google_documents: [{
        entry_id: 'en_old', document_id: 'gdoc-old', tab_id: '', revision_id: '', synced_content_json: JSON.stringify(rich('Vieux')),
        synced_at: T, document_title: '', tab_title: '', tab_order: 0, tab_depth: 0, readonly_reason: 'ancien import',
      }],
      attachments: [],
    });
    await expect(localApi.pushGoogleDocument('en_old')).rejects.toThrow('aplati');
  });

  test('création et liste Drive depuis le navigateur', async () => {
    const created = await localApi.createGoogleDocument('  Neuf  ');
    expect(created.title).toBe('Neuf');
    expect(created.google_sync?.document_id).toBe('g-new');
    await expect(localApi.createGoogleDocument('   ')).rejects.toThrow('1 et 240');
    const listed = await localApi.googleDocuments();
    expect(listed.files).toEqual([{ id: 'd1', name: 'Doc', modifiedTime: T }]);
    expect(listed.nextPageToken).toBe('p2');
  });

  test('ouverture multi-onglets : deux entrées groupées, onglet demandé', async () => {
    const tabsDoc = (rev: string) => ({
      title: 'Doc', revisionId: rev,
      tabs: ['A', 'B'].map((tab, order) => ({
        tabProperties: { tabId: `tab-${tab.toLowerCase()}`, title: `Onglet ${tab}`, index: order },
        childTabs: [],
        documentTab: { body: { content: [paragraph(`Contenu ${tab}\n`)] } },
      })),
    });
    currentDoc = tabsDoc('r1');
    const first = await localApi.openGoogleDocument('gdoc-multi');
    expect(first.title).toBe('Doc — Onglet A');
    const state = await localApi.state();
    expect(state.entries.filter((e) => e.google_document_id === 'gdoc-multi')).toHaveLength(2);
    const asked = await localApi.openGoogleDocument('gdoc-multi', 'tab-b');
    expect(asked.google_sync?.tab_id).toBe('tab-b');
    await expect(localApi.openGoogleDocument('gdoc-multi', 'tab-x')).rejects.toThrow('Onglet Google introuvable');
    await expect(localApi.openGoogleDocument('mauvais id!')).rejects.toThrow('Identifiant de document Google invalide');
  });

  test('réouverture : brouillon propre actualisé, brouillon modifié conservé', async () => {
    const tabsDoc = (rev: string, textA: string) => ({
      title: 'Doc', revisionId: rev,
      tabs: [{ tabProperties: { tabId: 'tab-a', title: 'Onglet A', index: 0 }, childTabs: [], documentTab: { body: { content: [paragraph(textA)] } } }],
    });
    currentDoc = tabsDoc('r1', 'Contenu A\n');
    const opened = await localApi.openGoogleDocument('gdoc-multi');
    // Brouillon modifié localement : conservé tel quel à la réouverture.
    await localApi.updateEntry(opened.id, { content_json: rich('Modifié local') });
    currentDoc = tabsDoc('r2', 'Contenu distant\n');
    const kept = await localApi.openGoogleDocument('gdoc-multi');
    expect(kept.content_md).toContain('Modifié local');
    // Brouillon propre : actualisé depuis Google.
    await localApi.updateEntry(opened.id, { content_json: rich('Contenu distant') });
    const refreshed = await localApi.openGoogleDocument('gdoc-multi');
    expect(refreshed.content_md).toContain('Contenu distant');
  });
});
