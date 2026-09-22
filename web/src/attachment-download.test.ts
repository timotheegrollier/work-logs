import { afterEach, expect, test, vi } from 'vitest';
import { downloadAttachment } from './attachment-download';
import { api } from './lib';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function capture() {
  const clicks: { href: string; download: string }[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicks.push({ href: this.href, download: this.download });
  });
  URL.createObjectURL = vi.fn(() => 'blob:worklogs/1');
  URL.revokeObjectURL = vi.fn();
  return clicks;
}
const file = { id: 'at_1', filename: 'plan terrasse.pdf', stored: 'x_plan.pdf' };

test('passe par fetch (service worker / protocole de l’app), pas par le gestionnaire de téléchargements', async () => {
  const clicks = capture();
  const fetch = vi.fn(async () => new Response('pdf'));
  vi.stubGlobal('fetch', fetch);
  await downloadAttachment(file);
  expect(fetch).toHaveBeenCalledWith('/api/files/x_plan.pdf');
  expect(clicks).toEqual([{ href: 'blob:worklogs/1', download: 'plan terrasse.pdf' }]);
  expect(document.querySelector('a[download]')).toBeNull();
});

test('binaire absent ici mais sur Drive : rapatrié puis enregistré', async () => {
  const clicks = capture();
  const responses = [new Response('introuvable', { status: 404 }), new Response('pdf')];
  vi.stubGlobal('fetch', vi.fn(async () => responses.shift()!));
  const pull = vi.spyOn(api, 'fetchDriveAttachment').mockResolvedValue({} as never);
  await downloadAttachment({ ...file, driveFileId: 'drive-1' });
  expect(pull).toHaveBeenCalledWith('at_1');
  expect(clicks).toHaveLength(1);
});

test('nulle part : message clair, rien d’enregistré', async () => {
  const clicks = capture();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
  await expect(downloadAttachment(file)).rejects.toThrow(/n’est que sur l’appareil qui l’a ajouté/);
  vi.spyOn(api, 'fetchDriveAttachment').mockResolvedValue({} as never);
  await expect(downloadAttachment({ ...file, driveFileId: 'drive-1' })).rejects.toThrow(/introuvable, même sur Google Drive/);
  expect(clicks).toHaveLength(0);
});
