import type { RefObject } from 'react';

/**
 * Contrat commun des éditeurs de fichiers du dossier partagé.
 *
 * Le **brouillon** est le modèle de l'éditeur (JSON, enregistré sur cet
 * ordinateur toutes les 600 ms) ; les **octets** ne sont produits qu'à l'envoi
 * explicite (`serialize`). Rien de modifié → les octets d'origine, à l'identique.
 */
export interface FileEditorHandle {
  isDirty(): boolean;
  /** Modèle à garder en brouillon (petit : les lignes intactes sont des références). */
  draft(): unknown;
  /** Ce qui empêcherait l'envoi (caractère non représentable…), en clair. */
  problems(): string[];
  serialize(): Promise<Uint8Array>;
}

export interface FileEditorProps {
  name: string;
  /** Octets dont part l'édition (la version de base, ou celle du brouillon). */
  bytes: Uint8Array;
  initialDraft: unknown;
  /** Raison de la lecture seule, ou `null` : le modèle garde ce qui a été tapé. */
  readOnly: string | null;
  onEdit(): void;
  handleRef: RefObject<FileEditorHandle | null>;
}

export class FormatError extends Error {}

export type EditorKind = 'text' | 'markdown' | 'csv';

const KINDS: Record<string, EditorKind> = {
  txt: 'text', text: 'text', log: 'text',
  md: 'markdown', markdown: 'markdown',
  csv: 'csv', tsv: 'csv',
};

/** Éditeur maison pour cette extension, ou `null` (ouvrir avec une autre application). */
export const editorKind = (ext: string): EditorKind | null => KINDS[ext.toLowerCase()] ?? null;

/** Un éditeur texte n'a pas vocation à porter des dizaines de Mo : au-delà, lecture seule. */
export const MAX_EDITABLE_TEXT = 4 * 1024 * 1024;
