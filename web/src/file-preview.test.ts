import { describe, expect, test } from 'vitest';
import { imageMime, looksLikePdf, previewKind, previewNotice } from './file-preview';

describe('classement des pièces jointes pour l’aperçu', () => {
  test('un PDF se reconnaît à ses octets, en-tête dans le premier Ko', () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    expect(looksLikePdf(bytes('%PDF-1.7\n…'))).toBe(true);
    // La norme tolère quelques octets avant l'en-tête.
    expect(looksLikePdf(bytes('\ufeff  %PDF-1.4\n'))).toBe(true);
    expect(looksLikePdf(bytes(' '.repeat(1100) + '%PDF-1.4'))).toBe(false);
    expect(looksLikePdf(bytes('<html>pas un PDF</html>'))).toBe(false);
    expect(looksLikePdf(new Uint8Array())).toBe(false);
  });

  test('une image se reconnaît à ses octets, jamais à son nom', () => {
    const bytes = (values: number[]) => new Uint8Array(values);
    expect(imageMime(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(imageMime(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(imageMime(bytes([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif');
    expect(imageMime(bytes([0x42, 0x4d, 0x00, 0x00]))).toBe('image/bmp');
    // Du HTML, même dans un fichier nommé « image.png » : ce n'est pas une image.
    expect(imageMime(new TextEncoder().encode('<script>alert(1)</script>'))).toBeNull();
    expect(imageMime(new Uint8Array())).toBeNull();
  });

  test('reconnaît images, PDF et texte sur l’extension', () => {
    expect(previewKind({ filename: 'photo.png' })).toBe('image');
    expect(previewKind({ filename: 'plan.jpeg' })).toBe('image');
    expect(previewKind({ filename: 'devis.pdf' })).toBe('pdf');
    expect(previewKind({ filename: 'notes.md' })).toBe('text');
    expect(previewKind({ filename: 'releve.csv' })).toBe('text');
  });

  test('s’appuie aussi sur le type MIME quand l’extension ne dit rien', () => {
    expect(previewKind({ filename: 'capture', mime: 'image/webp' })).toBe('image');
    expect(previewKind({ filename: 'piece', mime: 'application/pdf' })).toBe('pdf');
    expect(previewKind({ filename: 'journal', mime: 'text/plain' })).toBe('text');
  });

  test('les tableurs sont annoncés, jamais rendus de travers', () => {
    expect(previewKind({ filename: 'budget.xlsx' })).toBe('sheet');
    expect(previewKind({ filename: 'Changer format balance.DOCX' })).toBe('docx');
    expect(previewKind({ filename: 'sans-extension', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })).toBe('docx');
    // L'ancien format binaire n'a pas d'aperçu.
    expect(previewKind({ filename: 'ancien.doc' })).toBe('other');
    expect(previewKind({ filename: 'budget.ods' })).toBe('sheet');
    expect(previewKind({ filename: 'budget', mime: 'application/vnd.oasis.opendocument.spreadsheet' })).toBe('sheet');
    // Un CSV reste du texte : il s’affiche très bien tel quel.
    expect(previewKind({ filename: 'budget.csv' })).toBe('text');
  });

  test('le reste est classé « autre » et renvoyé au téléchargement', () => {
    expect(previewKind({ filename: 'archive.zip' })).toBe('other');
    expect(previewKind({ filename: 'sans-extension' })).toBe('other');
    expect(previewNotice('sheet', 'budget.xlsx')).toContain('tableur');
    expect(previewNotice('other', 'archive.zip')).toContain('archive.zip');
  });
});