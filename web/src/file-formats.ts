import type { RefObject } from 'react';
import type { AiTextFormat } from './ai-suggest';

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
  /** IA (« Suggérer une procédure », « Mettre en page ») : texte, Markdown et Word seulement. */
  ai?: FileAi;
}

export type FileAiMode = 'layout' | 'procedure';

/** Une proposition de l'IA, prête à relire puis à appliquer comme une frappe. */
export interface FileAiProposal {
  /** Ce qui s'appliquera, à relire : Markdown, ou texte brut pour un `.txt`. */
  preview: string;
  previewFormat: 'markdown' | 'text';
  /** Ce que l'enregistrement sur le partage refuserait (caractère hors encodage…), ou `''`. */
  warning: string;
  apply(): void;
}

export interface FileAi {
  format: AiTextFormat;
  /**
   * Fige le contenu au moment de la demande : ce que lit l'IA (le titre du document
   * à part, s'il en a un) et de quoi transformer sa réponse en proposition.
   * Erreur explicite si le fichier ne peut pas être modifié ici.
   */
  begin(mode: FileAiMode): { text: string; title: string; prepare(answer: string): FileAiProposal };
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
  /** Nom inscrit comme dernier auteur (propriétés d'un document Word ou d'un classeur Excel). */
  author?: string;
}

export class FormatError extends Error {}

export type EditorKind = 'text' | 'markdown' | 'csv' | 'docx' | 'xlsx';

const KINDS: Record<string, EditorKind> = {
  txt: 'text', text: 'text', log: 'text',
  md: 'markdown', markdown: 'markdown',
  csv: 'csv', tsv: 'csv',
  docx: 'docx',
  // Un classeur à macros s'affiche, en lecture seule (`xlsx.ts`).
  xlsx: 'xlsx', xlsm: 'xlsx',
};

/** Éditeur maison pour cette extension, ou `null` (ouvrir avec une autre application). */
export const editorKind = (ext: string): EditorKind | null => KINDS[ext.toLowerCase()] ?? null;

/** Un éditeur texte n'a pas vocation à porter des dizaines de Mo : au-delà, lecture seule. */
export const MAX_EDITABLE_TEXT = 4 * 1024 * 1024;
