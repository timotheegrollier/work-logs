import { describe, expect, test } from 'vitest';
import { previewKind, previewNotice } from './file-preview';

describe('classement des pièces jointes pour l’aperçu', () => {
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