import { describe, expect, it } from 'vitest';
import { MAX_CHAT_ATTACHMENT_BYTES, MAX_CHAT_ATTACHMENT_TEXT, chatAttachmentBytes, createChatLink, readChatAttachment } from './ai-chat-attachments';
import { pngImage, wordDocx } from './test/docx-fixture';
import { excelWorkbook } from './test/xlsx-fixture';

describe('pièces jointes de l’assistant', () => {
  it('conserve les caractères et l’indentation du code et lit le texte Windows-1252', async () => {
    const code = 'def été():\n    return "<aside>"\n';
    const script = await readChatAttachment(new File([code], 'analyse.py'));
    expect(script).toMatchObject({ kind: 'text', name: 'analyse.py', text: code });
    expect(chatAttachmentBytes(script)).toBe(new TextEncoder().encode(code).length);
    await expect(readChatAttachment(new File([new Uint8Array([0xe9, 0x74, 0xe9])], 'équipe.csv')))
      .resolves.toMatchObject({ kind: 'text', text: 'été' });
  });

  it('signale un extrait borné qui garde le début et la fin', async () => {
    const attachment = await readChatAttachment(new File(['entête\n', 'x'.repeat(MAX_CHAT_ATTACHMENT_TEXT), '\nconclusion'], 'rapport.log'));
    expect(attachment).toMatchObject({ kind: 'text', truncated: true, text: expect.stringMatching(/^entête\n[\s\S]*conclusion$/) });
    expect(attachment.text?.length).toBe(MAX_CHAT_ATTACHMENT_TEXT);
  });

  it('extrait des paragraphes et titres Word et des cellules visibles Excel', async () => {
    const word = await readChatAttachment(new File([new Uint8Array(wordDocx())], 'Consignes.docx'));
    expect(word).toMatchObject({ kind: 'text', name: 'Consignes.docx' });
    expect(word.text).toContain('# Filtration');
    expect(word.text).toContain('chaque lundi');

    const excel = await readChatAttachment(new File([new Uint8Array(excelWorkbook())], 'Suivi.xlsx'));
    expect(excel).toMatchObject({ kind: 'text', name: 'Suivi.xlsx', truncated: true });
    expect(excel.text).toContain('Feuille « Suivi »\nA1 : "Tâche"');
    expect(excel.text).toContain('Feuille « Résumé »');
    expect(excel.text).not.toContain('Feuille « Paramètres »');
  });

  it('conserve les octets du PDF et d’une image, avec leur MIME détecté', async () => {
    const pdf = '%PDF-1.7\n1 0 obj\n<< >>\nendobj\n%%EOF\n';
    const document = await readChatAttachment(new File([pdf], 'plan.pdf', { type: 'application/octet-stream' }));
    expect(document).toMatchObject({ kind: 'pdf', file: { type: 'application/pdf' } });
    await expect(document.file?.text()).resolves.toBe(pdf);
    expect(chatAttachmentBytes(document)).toBe(pdf.length);

    const png = new Uint8Array(pngImage(2, 3));
    const image = await readChatAttachment(new File([png], 'capture'));
    expect(image).toMatchObject({ kind: 'image', file: { type: 'image/png' } });
    expect(new Uint8Array(await image.file!.arrayBuffer())).toEqual(png);
  });

  it('refuse un binaire, un PDF invalide, et une image mal déclarée', async () => {
    await expect(readChatAttachment(new File([new Uint8Array([0x00, 0x1f, 0xff])], 'binary')))
      .rejects.toThrow(/format/);
    await expect(readChatAttachment(new File(['texte'], 'faux.pdf'))).rejects.toThrow(/PDF lisible/);
    await expect(readChatAttachment(new File(['<svg/>'], 'faux.png', { type: 'image/png' })))
      .rejects.toThrow(/image PNG, JPEG ou WebP/);
    const huge = new Uint8Array(pngImage(2, 3));
    new DataView(huge.buffer).setUint32(16, 100_000_000);
    await expect(readChatAttachment(new File([huge], 'énorme.png'))).rejects.toThrow(/résolution/);
  });

  it('vérifie la taille avant de lire un fichier', async () => {
    const file = new File(['%PDF-1.7', new Uint8Array(MAX_CHAT_ATTACHMENT_BYTES)], 'trop-grand.pdf');
    await expect(readChatAttachment(file)).rejects.toThrow(/10 Mio/);
    await expect(readChatAttachment(new File([], 'vide.txt'))).rejects.toThrow(/vide/);
  });
});

describe('liens joints', () => {
  it('normalise une adresse web publique', () => {
    expect(createChatLink(' https://EXAMPLE.org/guide?q=filtre#étapes ')).toMatchObject({
      kind: 'link', name: 'https://example.org/guide?q=filtre#%C3%A9tapes', text: 'https://example.org/guide?q=filtre#%C3%A9tapes',
    });
  });

  it.each([
    'file:///tmp/info', 'javascript:alert(1)', 'https://utilisateur@exemple.fr', 'https://127.1/',
    'https://[::1]/', 'http://serveur.local/', 'http://service-intranet/', 'https://exemple.fr/d du texte',
  ])('refuse %s', (address) => {
    expect(() => createChatLink(address)).toThrow(/adresse web publique/);
  });
});
