import { afterEach, describe, expect, test, vi } from 'vitest';
import { downloadAttachment, driveViewUrl, openAttachmentWith } from './attachment-download';
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

describe('ouvrir avec…', () => {
  afterEach(() => {
    delete window.worklogsDesktop;
    Reflect.deleteProperty(navigator, 'share');
    Reflect.deleteProperty(navigator, 'canShare');
  });

  test('desktop : confié au système via le pont, rien de téléchargé', async () => {
    const clicks = capture();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('PK')));
    const openAttachment = vi.fn(async () => '');
    window.worklogsDesktop = { onBeforeClose: () => () => {}, openAttachment };
    expect(await openAttachmentWith({ ...file, filename: 'budget.ods', stored: 'x_budget.ods' })).toBe('opened');
    expect(openAttachment).toHaveBeenCalledWith('x_budget.ods', 'budget.ods');
    expect(clicks).toHaveLength(0);
  });

  test('desktop : le refus du système remonte tel quel', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('PK')));
    window.worklogsDesktop = { onBeforeClose: () => () => {}, openAttachment: async () => 'Aucune application ne sait ouvrir ce fichier.' };
    await expect(openAttachmentWith(file)).rejects.toThrow(/Aucune application/);
  });

  test('desktop : absent ici mais sur Drive, rapatrié avant d’ouvrir', async () => {
    const responses = [new Response('', { status: 404 }), new Response('PK')];
    vi.stubGlobal('fetch', vi.fn(async () => responses.shift()!));
    const pull = vi.spyOn(api, 'fetchDriveAttachment').mockResolvedValue({} as never);
    const openAttachment = vi.fn(async () => '');
    window.worklogsDesktop = { onBeforeClose: () => () => {}, openAttachment };
    await openAttachmentWith({ ...file, driveFileId: 'drive-1' });
    expect(pull).toHaveBeenCalledBefore(openAttachment);
  });

  test('téléphone : feuille de partage avec le fichier et son type ; annuler ne télécharge pas', async () => {
    const clicks = capture();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('PK')));
    const share = vi.fn(async (_data: ShareData) => {});
    Object.assign(navigator, { share, canShare: () => true });
    expect(await openAttachmentWith({ ...file, filename: 'budget.ods', mime: 'application/vnd.oasis.opendocument.spreadsheet' })).toBe('shared');
    const sent = share.mock.calls[0][0].files![0];
    expect(sent.name).toBe('budget.ods');
    expect(sent.type).toBe('application/vnd.oasis.opendocument.spreadsheet');
    share.mockRejectedValueOnce(Object.assign(new Error('annulé'), { name: 'AbortError' }));
    expect(await openAttachmentWith(file)).toBe('cancelled');
    expect(clicks).toHaveLength(0);
  });

  test('sans pont ni partage : repli sur le téléchargement', async () => {
    const clicks = capture();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('PK')));
    expect(await openAttachmentWith(file)).toBe('downloaded');
    expect(clicks).toHaveLength(1);
  });

  test('lien Drive', () => {
    expect(driveViewUrl('1AbC_d-2')).toBe('https://drive.google.com/file/d/1AbC_d-2/view');
  });
});
