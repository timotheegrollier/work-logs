import { decodeText, encodeText, encodingProblem } from './text-codec';
import { cellRef, cellView, parseRef, readXlsxWorkbook, writeXlsx, type XlsxDraft } from './xlsx';
import { FormatError } from './file-formats';

/**
 * « Fusionner » un conflit : quand tes modifications et celles du collègue ne se
 * touchent pas, WorkLogs les réunit au lieu de te faire choisir. Fusion à trois
 * voies — la version de départ, la tienne, la leur — à la ligne pour le texte et
 * les CSV, à la cellule pour les classeurs Excel. Au moindre recouvrement, pas de
 * fusion : on le dit, avec où, et les trois choix habituels restent.
 */

export type MergeOutcome =
  | { ok: true; bytes: Uint8Array; summary: string }
  | { ok: false; reason: string };

/** Un remplacement : les lignes `[start, end)` de la version de départ deviennent `lines`. */
export interface Hunk {
  start: number;
  end: number;
  lines: string[];
}

/** Lignes avec leur fin d'origine (`\r\n`, `\n`, ou rien pour la dernière). */
export const splitKeepingEol = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** Au-delà, la table de comparaison coûterait trop : pas de fusion automatique. */
const MAX_CELLS = 4_000_000;

/** Différences ligne à ligne (plus longue sous-suite commune), en blocs de remplacement. */
export function diffLines(a: string[], b: string[]): Hunk[] | null {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const x = a.slice(prefix, a.length - suffix);
  const y = b.slice(prefix, b.length - suffix);
  if (!x.length && !y.length) return [];
  if (!x.length || !y.length) return [{ start: prefix, end: prefix + x.length, lines: y }];
  if (x.length * y.length > MAX_CELLS) return null;
  const n = x.length;
  const m = y.length;
  const rows = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) rows[i][j] = x[i] === y[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
  }
  const hunks: Hunk[] = [];
  let open: Hunk | null = null;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      if (open) { hunks.push(open); open = null; }
      i++;
      j++;
    } else if (j < m && (i === n || rows[i][j + 1] >= rows[i + 1][j])) {
      open ??= { start: prefix + i, end: prefix + i, lines: [] };
      open.lines.push(y[j++]);
    } else {
      open ??= { start: prefix + i, end: prefix + i, lines: [] };
      open.end = prefix + i + 1;
      i++;
    }
  }
  if (open) hunks.push(open);
  return hunks;
}

const sameHunk = (a: Hunk, b: Hunk) => a.start === b.start && a.end === b.end && a.lines.length === b.lines.length && a.lines.every((line, k) => line === b.lines[k]);

/**
 * Deux modifications se touchent si elles remplacent des lignes communes, ou
 * insèrent au même endroit (l'ordre serait arbitraire). Deux lignes voisines
 * modifiées chacune de son côté ne se touchent pas.
 */
function overlap(a: Hunk, b: Hunk): boolean {
  const aInsert = a.start === a.end;
  const bInsert = b.start === b.end;
  if (aInsert && bInsert) return a.start === b.start;
  if (aInsert) return b.start < a.start && a.start < b.end;
  if (bInsert) return a.start < b.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}

export type Merge3 =
  | { ok: true; lines: string[] }
  | { ok: false; conflicts: number[] }
  | { ok: false; tooBig: true };

/** Fusion à trois voies, à la ligne. `conflicts` : numéros de ligne (1…) de la version de départ. */
export function merge3(base: string[], mine: string[], theirs: string[]): Merge3 {
  const ours = diffLines(base, mine);
  const others = diffLines(base, theirs);
  if (!ours || !others) return { ok: false, tooBig: true };
  const conflicts = new Set<number>();
  const kept = [...ours];
  for (const hunk of others) {
    if (ours.some((candidate) => sameHunk(candidate, hunk))) continue; // le même changement des deux côtés
    for (const candidate of ours) if (!sameHunk(candidate, hunk) && overlap(candidate, hunk)) conflicts.add(Math.min(candidate.start, hunk.start) + 1);
    kept.push(hunk);
  }
  if (conflicts.size) return { ok: false, conflicts: [...conflicts].sort((a, b) => a - b) };
  // À position égale, une insertion passe devant le remplacement qui commence là.
  kept.sort((a, b) => a.start - b.start || (a.end - a.start) - (b.end - b.start));
  const out: string[] = [];
  let cursor = 0;
  for (const hunk of kept) {
    out.push(...base.slice(cursor, hunk.start), ...hunk.lines);
    cursor = hunk.end;
  }
  out.push(...base.slice(cursor));
  return { ok: true, lines: out };
}

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;
const linesLabel = (numbers: number[]) =>
  numbers.length === 1 ? `la ligne ${numbers[0]}` : `les lignes ${numbers.slice(0, 5).join(', ')}${numbers.length > 5 ? '…' : ''}`;

/** Texte, Markdown, CSV : fusion à la ligne, encodage et fins de ligne gardés. */
export function mergeText(base: Uint8Array, mine: Uint8Array, theirs: Uint8Array): MergeOutcome {
  const b = decodeText(base);
  const m = decodeText(mine);
  const t = decodeText(theirs);
  const result = merge3(splitKeepingEol(b.text), splitKeepingEol(m.text), splitKeepingEol(t.text));
  if (!result.ok) {
    return { ok: false, reason: 'tooBig' in result ? 'Fusion impossible : trop de différences entre les versions.' : `Fusion impossible : vous avez modifié tous les deux ${linesLabel(result.conflicts)}.` };
  }
  // L'encodage du fichier du partage, sauf si tu l'as changé toi-même.
  const encoding = m.encoding !== b.encoding ? m.encoding : t.encoding;
  const text = result.lines.join('');
  const problem = encodingProblem(text, encoding);
  if (problem) return { ok: false, reason: `Fusion impossible : ${problem}` };
  const mineChanged = diffLines(splitKeepingEol(b.text), splitKeepingEol(m.text))?.length ?? 0;
  return { ok: true, bytes: encodeText(text, encoding), summary: `${plural(mineChanged, 'modification')} de ta part ajoutée${mineChanged > 1 ? 's' : ''} à leur version.` };
}

/**
 * Classeur Excel : tes cellules tapées, posées sur leur version — à condition
 * qu'ils n'aient pas changé ces mêmes cellules (ni renommé la feuille).
 */
export async function mergeXlsx(base: Uint8Array, theirs: Uint8Array, draft: XlsxDraft | null, author: string): Promise<MergeOutcome> {
  if (draft?.format !== 'xlsx' || !draft.edits) return { ok: false, reason: 'Fusion impossible : tes modifications ne sont plus détaillées cellule par cellule.' };
  try {
    const [before, after] = await Promise.all([readXlsxWorkbook(base), readXlsxWorkbook(theirs)]);
    const clashes: string[] = [];
    let count = 0;
    for (const [name, cells] of Object.entries(draft.edits)) {
      const source = before.sheets.find((sheet) => sheet.name === name);
      const target = after.sheets.find((sheet) => sheet.name === name);
      if (!target) {
        clashes.push(`la feuille « ${name} » a été renommée ou supprimée`);
        continue;
      }
      for (const [ref, typed] of Object.entries(cells)) {
        const position = parseRef(ref);
        if (!position) continue;
        count++;
        const was = source ? cellView(before, source, position.row, position.col).input : '';
        const now = cellView(after, target, position.row, position.col).input;
        if (now !== was && now !== typed) clashes.push(`${name}!${cellRef(position.row, position.col)}`);
      }
    }
    if (clashes.length) {
      return { ok: false, reason: `Fusion impossible : vous avez modifié tous les deux ${clashes.length > 1 ? 'les cellules' : 'la cellule'} ${clashes.slice(0, 5).join(', ')}${clashes.length > 5 ? '…' : ''}.` };
    }
    const bytes = await writeXlsx(theirs, draft.edits, { author: author || 'WorkLogs' });
    return { ok: true, bytes, summary: `${plural(count, 'cellule')} de ta part posée${count > 1 ? 's' : ''} sur leur version.` };
  } catch (error) {
    if (error instanceof FormatError) return { ok: false, reason: `Fusion impossible : ${error.message}` };
    throw error;
  }
}
