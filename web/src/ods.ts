/**
 * OpenDocument Spreadsheet (`.ods`) : lecture et édition cellule par cellule,
 * exactement comme `xlsx.ts` pour Excel.
 *
 * Le format ODF est un zip contenant `content.xml` (les données des feuilles),
 * `styles.xml`, `meta.xml`, etc. On ne touche que `content.xml` à l'envoi :
 * seules les cellules modifiées sont réécrites, le reste du fichier reste
 * octet pour octet identique.
 */

import { readZip, readZipText, writeZip } from './zip';
import { elements, escapeAttr, escapeText, scanXml, type XmlElement } from './xml-scan';
import { textOf } from './ooxml';
import { FormatError } from './file-formats';
import { parseFrenchDate, parseInput, plainNumber } from './xlsx-format';
import { GRID_LIMITS, MAX_COLUMNS, MAX_ROWS, cellRef, parseRef } from './xlsx';


const OFFICE_NS = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0';

export interface OdsCell {
  row: number;
  col: number;
  ref: string;
  el: XmlElement;
  display: string;
  input: string;
  formula: string | null;
  valueType: string | null;
  readOnly: string | null;
  repeat: number;
}

interface OdsRow {
  row: number;
  el: XmlElement;
  repeat: number;
}

interface OdsLockedArea {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  reason: string;
}

export interface OdsSheet {
  name: string;
  hidden: boolean;
  kind: 'worksheet' | 'other';
  part: 'content.xml';
  table: XmlElement;
  xml: string;
  rowCount: number;
  colCount: number;
  readOnly: string | null;
  locked: OdsLockedArea[];
  rows: Map<number, OdsRow>;
  cells: Map<number, OdsCell>;
}

const cellKey = (row: number, col: number) => row * MAX_COLUMNS + col;
export { cellRef, columnLetters, GRID_LIMITS, MAX_COLUMNS, parseRef } from './xlsx';

export interface OdsWorkbook {
  sheets: OdsSheet[];
  activeSheet: number;
  author: string | null;
  readOnly: string | null;
}

export type OdsEdits = Record<string, Record<string, string>>;

export interface OdsDraft {
  format: 'ods';
  v: 1;
  edits: OdsEdits;
}

const READ_ONLY = {
  merged: (anchor: string) => `Cellule fusionnée avec ${anchor} : seule ${anchor} se modifie.`,
  protected: 'Feuille protégée : cette cellule est verrouillée.',
};
const nsOf = (el: XmlElement) => el.ns ?? '';
const isTable = (el: XmlElement) => nsOf(el) === OFFICE_NS && el.local === 'table';
const isTableRow = (el: XmlElement) => nsOf(el) === OFFICE_NS && el.local === 'table-row';
const isTableCell = (el: XmlElement) => nsOf(el) === OFFICE_NS && el.local === 'table-cell';
const isCoveredCell = (el: XmlElement) => nsOf(el) === OFFICE_NS && el.local === 'covered-table-cell';
const rowRepeatOf = (el: XmlElement): number => Number(el.attrs['table:number-rows-repeated'] ?? 1);
const cellRepeatOf = (el: XmlElement): number => Number(el.attrs['table:number-columns-repeated'] ?? 1);
function descendants(root: XmlElement): XmlElement[] {
  const found: XmlElement[] = [];
  const visit = (parent: XmlElement) => {
    for (const child of elements(parent)) {
      found.push(child);
      visit(child);
    }
  };
  visit(root);
  return found;
}
const valueOf = (el: XmlElement): string | null => {
  const boolean = el.attrs['office:boolean-value'];
  if (boolean !== undefined) return boolean;
  const value = el.attrs['office:value'];
  if (value !== undefined) return value;
  const date = el.attrs['office:date-value'];
  if (date !== undefined) return date;
  const text = cellText(el);
  return text === '' ? null : text;
};
const formulaOf = (el: XmlElement): string | null => el.attrs['table:formula'] ?? null;

const boolOf = (value: string | null): boolean | null => {
  if (value === null) return null;
  const v = value.trim().toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return null;
};

function cellText(el: XmlElement): string {
  const paragraphs = elements(el).filter((child) => child.local === 'p').map((paragraph) => nestedText(paragraph));
  return paragraphs.join('\n');
}

function nestedText(el: XmlElement): string {
  return el.children.map((child) => child.kind === 'text' ? child.value : nestedText(child)).join('');
}

function formulaInput(formula: string): string {
  return formula.replace(/^of:=/, '=')
    .replace(/\[\.(\$?[A-Z]+\$?\d+):\.(\$?[A-Z]+\$?\d+)\]/gi, '$1:$2')
    .replace(/\[\.(\$?[A-Z]+\$?\d+)\]/gi, '$1')
    .replace(/;/g, ',');
}

function tableRows(table: XmlElement): XmlElement[] {
  const rows: XmlElement[] = [];
  const visit = (parent: XmlElement) => {
    for (const child of elements(parent)) {
      if (isTableRow(child)) rows.push(child);
      else if (nsOf(child) === OFFICE_NS && ['table-header-rows', 'table-row-group', 'table-rows'].includes(child.local)) visit(child);
    }
  };
  visit(table);
  return rows;
}

export async function readOdsWorkbook(bytes: Uint8Array): Promise<OdsWorkbook> {
  const archive = readZip(bytes);
  const content = await readZipText(archive, 'content.xml');
  if (!content) throw new FormatError("Ce fichier n'est pas un classeur ODS lisible : content.xml introuvable.");

  const root = scanXml(content);
  const meta = await readZipText(archive, 'meta.xml');
  let author: string | null = null;
  if (meta) {
    const metaRoot = scanXml(meta);
    const metaNS = 'urn:oasis:names:tc:opendocument:xmlns:meta:1.0';
    const creator = descendants(metaRoot).find((el) => nsOf(el) === metaNS && el.local === 'initial-creator');
    if (creator) author = textOf(creator).trim() || null;
    if (!author) {
      const last = descendants(metaRoot).find((el) => nsOf(el) === metaNS && el.local === 'creator');
      if (last) author = textOf(last).trim() || null;
    }
  }

  const tables = descendants(root).filter(isTable);
  const sheets: OdsSheet[] = [];
  for (const table of tables) {
    const name = table.attrs['table:name'] ?? 'Feuille ' + (sheets.length + 1);
    const hidden = table.attrs['table:is-hidden'] === 'true';
    const xml = content.slice(table.start, table.end);
    const sheet = readOdsSheet(table, name, hidden, xml);
    sheets.push(sheet);
  }

  if (!sheets.length) throw new FormatError('Classeur ODS sans feuille.');

  let activeSheet = 0;
  for (let i = 0; i < sheets.length; i++) {
    if (!sheets[i].hidden) { activeSheet = i; break; }
  }

  return { sheets, activeSheet, author, readOnly: null };
}


function readOdsSheet(table: XmlElement, name: string, hidden: boolean, xml: string): OdsSheet {
  const locked: { r1: number; c1: number; r2: number; c2: number; reason: string }[] = [];
  let maxRow = -1;
  let maxCol = -1;
  const cells = new Map<number, OdsCell>();

  const rows = tableRows(table);
  const rowElements = new Map<number, OdsRow>();
  let rowIndex = 0;
  for (const rowEl of rows) {
    const rowRepeat = rowRepeatOf(rowEl);
    if (!Number.isSafeInteger(rowRepeat) || rowRepeat < 1 || rowRepeat > MAX_ROWS) throw new FormatError(`Répétition de lignes invalide dans « ${name} ».`);
    rowElements.set(rowIndex, { row: rowIndex, el: rowEl, repeat: rowRepeat });
    const cellsInRow = elements(rowEl).filter((child) => isTableCell(child) || isCoveredCell(child));
    let colIndex = 0;
    for (const cellEl of cellsInRow) {
      if (isCoveredCell(cellEl)) {
        colIndex += cellRepeatOf(cellEl);
        continue;
      }
      const cellRepeat = cellRepeatOf(cellEl);
      if (!Number.isSafeInteger(cellRepeat) || cellRepeat < 1 || cellRepeat > MAX_COLUMNS) throw new FormatError(`Répétition de cellules invalide dans « ${name} ».`);
      const readOnly = cellReadOnlyReason(cellEl);
      const formula = formulaOf(cellEl);
      const valueType = cellEl.attrs['office:value-type'] ?? null;
      const value = valueOf(cellEl);
      const bool = boolOf(value);
      const rawText = cellText(cellEl);
      const display = bool !== null ? (bool ? 'VRAI' : 'FAUX')
        : formula && value === null ? formulaInput(formula)
          : rawText || value || '';
      const numeric = value !== null && value !== '' && Number.isFinite(Number(value));
      const input = formula ? formulaInput(formula)
        : bool !== null ? value
          : numeric ? plainNumber(Number(value))
            : display;
      const ref = cellRef(rowIndex, colIndex);

      const cell: OdsCell = {
        row: rowIndex,
        col: colIndex,
        ref,
        el: cellEl,
        display,
        input: input ?? '',
        formula,
        valueType,
        readOnly,
        repeat: cellRepeat,
      };
      cells.set(rowIndex * MAX_COLUMNS + colIndex, cell);

      if (display !== '' || formula) {
        maxRow = Math.max(maxRow, rowIndex);
        maxCol = Math.max(maxCol, Math.min(MAX_COLUMNS - 1, colIndex + cellRepeat - 1));
      }
      if (cellRepeat > 1) locked.push({
        r1: rowIndex, c1: colIndex, r2: rowIndex, c2: colIndex + cellRepeat - 1,
        reason: 'Cellule répétée : cette plage est conservée telle quelle.',
      });

      const colSpan = Number(cellEl.attrs['table:number-columns-spanned'] ?? 1);
      const rowSpan = Number(cellEl.attrs['table:number-rows-spanned'] ?? 1);
      if (colSpan > 1 || rowSpan > 1) {
        const anchor = cellRef(rowIndex, colIndex);
        locked.push({
          r1: rowIndex, c1: colIndex + (colSpan > 1 ? 1 : 0),
          r2: Math.min(MAX_ROWS - 1, rowIndex + Math.max(0, rowSpan - 1)),
          c2: Math.min(MAX_COLUMNS - 1, colIndex + Math.max(0, colSpan - 1)),
          reason: READ_ONLY.merged(anchor),
        });
      }

      colIndex += cellRepeat;
    }
    if (rowRepeat > 1) {
      locked.push({
        r1: rowIndex, c1: 0, r2: Math.min(MAX_ROWS - 1, rowIndex + rowRepeat - 1), c2: MAX_COLUMNS - 1,
        reason: 'Ligne répétée : cette plage est conservée telle quelle.',
      });
    }
    rowIndex += rowRepeat;
  }

  const readOnly = table.attrs['table:protected'] === 'true' ? READ_ONLY.protected : null;
  if (readOnly) {
    for (const cell of cells.values()) cell.readOnly = readOnly;
  }

  return {
    name,
    hidden,
    kind: 'worksheet',
    part: 'content.xml',
    table,
    xml,
    rowCount: maxRow + 1,
    colCount: maxCol + 1,
    readOnly,
    locked,
    rows: rowElements,
    cells,
  };
}

function cellReadOnlyReason(_cell: XmlElement): string | null {
  return null;
}

export function gridSize(sheet: OdsSheet, edits?: Record<string, string>) {
  let rows = sheet.rowCount;
  let cols = sheet.colCount;
  for (const [ref, value] of Object.entries(edits ?? {})) {
    const position = parseRef(ref);
    if (!position || value === '') continue;
    rows = Math.max(rows, position.row + 1);
    cols = Math.max(cols, position.col + 1);
  }
  return {
    rows: Math.min(rows + 1, GRID_LIMITS.rows),
    cols: Math.min(cols + 1, GRID_LIMITS.columns),
    truncated: rows + 1 > GRID_LIMITS.rows || cols + 1 > GRID_LIMITS.columns,
  };
}

export function cellReadOnly(workbook: OdsWorkbook, sheet: OdsSheet, row: number, col: number): string | null {
  if (workbook.readOnly) return workbook.readOnly;
  if (sheet.readOnly) return sheet.readOnly;
  for (const area of sheet.locked) {
    if (row >= area.r1 && row <= area.r2 && col >= area.c1 && col <= area.c2) return area.reason;
  }
  return null;
}

export interface CellView {
  display: string;
  input: string;
  readOnly: string | null;
  numeric: boolean;
}

export function cellView(workbook: OdsWorkbook, sheet: OdsSheet, row: number, col: number, edits?: Record<string, string>): CellView {
  const cell = sheet.cells?.get(cellKey(row, col));
  const readOnly = cellReadOnly(workbook, sheet, row, col);
  const typed = edits?.[cellRef(row, col)];
  if (typed === undefined) {
    const numeric = Boolean(cell && cell.display !== '' && !cell.display.startsWith('=') && !isNaN(Number(cell.display)));
    return { display: cell?.display ?? '', input: cell?.input ?? '', readOnly, numeric };
  }
  return { display: typed, input: typed, readOnly, numeric: false };
}

/**
 * Modifications effectives (différentes de l'original), feuille par feuille ; problèmes en clair.
 */
function plan(workbook: OdsWorkbook, edits: OdsEdits) {
  const problems: string[] = [];
  const bySheet = new Map<OdsSheet, { row: number; col: number; value: string }[]>();
  for (const [name, cells] of Object.entries(edits)) {
    const sheet = workbook.sheets.find((candidate) => candidate.name === name);
    if (!sheet) {
      if (Object.keys(cells).length) problems.push("La feuille « " + name + " » n'existe plus dans ce classeur.");
      continue;
    }
    for (const [ref, typed] of Object.entries(cells)) {
      const position = parseRef(ref);
      if (!position) continue;
      const { row, col } = position;
      const reason = cellReadOnly(workbook, sheet, row, col);
      if (reason) {
        problems.push(name + '!' + ref + ' : ' + reason);
        continue;
      }
      const list = bySheet.get(sheet) ?? [];
      list.push({ row, col, value: typed });
      bySheet.set(sheet, list);
    }
  }
  return { problems, bySheet };
}

/** Ce qui empêcherait l'envoi du brouillon (cellule protégée…). */
export function odsProblems(workbook: OdsWorkbook, edits: OdsEdits): string[] {
  return plan(workbook, edits).problems;
}

/** Seules les cellules réellement modifiées (différentes de l'original). */
export function effectiveEdits(workbook: OdsWorkbook, edits: OdsEdits): OdsEdits {
  const out: OdsEdits = {};
  for (const [name, cells] of Object.entries(edits)) {
    const sheet = workbook.sheets.find((candidate) => candidate.name === name);
    if (!sheet) continue;
    const mine: Record<string, string> = {};
    for (const [ref, typed] of Object.entries(cells)) {
      const position = parseRef(ref);
      if (!position) continue;
      const { row, col } = position;
      const cell = sheet.cells?.get(cellKey(row, col));
      if (cell && cell.input === typed) continue;
      mine[ref] = typed;
    }
    if (Object.keys(mine).length) out[name] = mine;
  }
  return out;
}

/**
 * Réécrit un fichier ODS avec les cellules modifiées. Rien de modifié : les
 * octets d'origine, à l'identique.
 */
export async function writeOds(bytes: Uint8Array, edits: OdsEdits, { author, now = new Date() }: { author: string; now?: Date }): Promise<Uint8Array> {
  const workbook = await readOdsWorkbook(bytes);
  if (workbook.readOnly) throw new FormatError(workbook.readOnly);
  const { problems, bySheet } = plan(workbook, edits);
  if (problems.length) throw new FormatError(problems.join('\n'));
  if (!bySheet.size) return bytes;

  const archive = readZip(bytes);
  const content = await readZipText(archive, 'content.xml');
  if (!content) throw new FormatError('content.xml introuvable : rien n’est envoyé.');

  const encoder = new TextEncoder();
  const zipEdits = new Map<string, Uint8Array | null>();
  const contentRoot = scanXml(content);
  const tables = descendants(contentRoot).filter(isTable);
  let patchedContent = content;
  const ordered = workbook.sheets.slice().sort((a, b) => b.table.start - a.table.start);
  for (const sheet of ordered) {
    const changes = bySheet.get(sheet) ?? [];
    if (!changes.length && ![...sheet.cells.values()].some((cell) => cell.formula)) continue;
    const table = tables.find((candidate) => (candidate.attrs['table:name'] ?? '') === sheet.name);
    if (!table) throw new FormatError(`La feuille « ${sheet.name} » n’existe plus dans content.xml.`);
    patchedContent = patchOdsSheet(patchedContent, sheet, changes);
  }
  zipEdits.set('content.xml', encoder.encode(patchedContent));

  // Mettre à jour meta.xml (dernier auteur, date de modification).
  const meta = await readZipText(archive, 'meta.xml');
  if (meta) zipEdits.set('meta.xml', encoder.encode(patchOdsMeta(meta, author, now)));

  const decoder = new TextDecoder();
  for (const [part, data] of zipEdits) {
    if (data && !isWellFormed(decoder.decode(data))) {
      throw new FormatError("WorkLogs a produit un classeur invalide (" + part + ") : rien n’est envoyé. Signale-le.");
    }
  }

  interface OdsChange {
    row: number;
    col: number;
    value: string;
  }

  function setXmlAttribute(tag: string, name: string, value: string | null): string {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\s${escaped}\\s*=\\s*(["'])[^"']*\\1`);
    if (pattern.test(tag)) return value === null
      ? tag.replace(pattern, '')
      : tag.replace(pattern, ` ${name}="${escapeAttr(value)}"`);
    if (value === null) return tag;
    return tag.replace(/\s*\/?>$/, (close) => ` ${name}="${escapeAttr(value)}"${close}`);
  }

  function writeCell(xml: string, cell: OdsCell | null, change: OdsChange): string {
    const currentTag = cell ? xml.slice(cell.el.start, cell.el.openEnd) : '<table:table-cell>';
    let tag = currentTag.replace(/\s*\/>$/, '>');
    for (const attr of ['office:value-type', 'office:value', 'office:string-value', 'office:boolean-value', 'office:date-value', 'office:time-value', 'table:formula']) {
      tag = setXmlAttribute(tag, attr, null);
    }

    const parsed = parseInput(change.value, 'General');
    let valueText = '';
    const date = cell?.valueType === 'date' && !change.value.startsWith("'") && parsed.kind !== 'formula'
      ? parseFrenchDate(change.value)
      : null;
    if (cell?.valueType === 'date' && !change.value.startsWith("'") && parsed.kind !== 'formula') {
      if (!date) throw new FormatError(`« ${change.value} » n’est pas une date valide.`);
      tag = setXmlAttribute(tag, 'office:value-type', 'date');
      tag = setXmlAttribute(tag, 'office:date-value', date.toISOString());
      valueText = change.value;
    } else if (parsed.kind === 'text') {
      tag = setXmlAttribute(tag, 'office:value-type', 'string');
      valueText = parsed.value;
    } else if (parsed.kind === 'number') {
      tag = setXmlAttribute(tag, 'office:value-type', 'float');
      tag = setXmlAttribute(tag, 'office:value', String(parsed.value));
      valueText = change.value;
    } else if (parsed.kind === 'boolean') {
      tag = setXmlAttribute(tag, 'office:value-type', 'boolean');
      tag = setXmlAttribute(tag, 'office:boolean-value', String(parsed.value));
      valueText = parsed.value ? 'TRUE' : 'FALSE';
    } else if (parsed.kind === 'formula') {
      const formula = odfFormula(parsed.value);
      tag = setXmlAttribute(tag, 'office:value-type', 'float');
      tag = setXmlAttribute(tag, 'table:formula', `of:=${formula}`);
    }
    const name = cell?.el.name ?? 'table:table-cell';
    const paragraph = valueText === '' ? '' : `<text:p>${escapeText(valueText)}</text:p>`;
    if (cell && !cell.el.selfClosing) {
      const contents = elements(cell.el).filter((child) => child.local === 'p');
      if (contents.length) {
        let inner = xml.slice(cell.el.openEnd, cell.el.closeStart);
        const ranges = contents.slice(1).map((child) => ({
          start: child.start - cell.el.openEnd,
          end: child.end - cell.el.openEnd,
        })).sort((a, b) => b.start - a.start);
        for (const range of ranges) inner = inner.slice(0, range.start) + inner.slice(range.end);
        const first = contents[0];
        const start = first.openEnd - cell.el.openEnd;
        const end = first.closeStart - cell.el.openEnd;
        inner = inner.slice(0, start) + escapeText(valueText) + inner.slice(end);
        return `${tag}${inner}</${name}>`;
      }
      const inner = xml.slice(cell.el.openEnd, cell.el.closeStart);
      const firstChild = elements(cell.el)[0];
      const at = firstChild ? firstChild.start - cell.el.openEnd : inner.length;
      return `${tag}${inner.slice(0, at)}${paragraph}${inner.slice(at)}</${name}>`;
    }
    if (cell?.el.selfClosing) return paragraph ? `${tag}${paragraph}</${name}>` : `${tag.slice(0, -1)}/>`;
    return paragraph ? `${tag}${paragraph}</${name}>` : `${tag.slice(0, -1)}/>`;
  }

  function clearFormulaCache(xml: string, cell: OdsCell): string {
    let tag = xml.slice(cell.el.start, cell.el.openEnd);
    if (cell.el.selfClosing) return `${tag.replace(/\s*\/>$/, '>')}</${cell.el.name}>`;
    for (const attr of ['office:value', 'office:string-value', 'office:boolean-value', 'office:date-value', 'office:time-value']) {
      tag = setXmlAttribute(tag, attr, null);
    }
    let inner = xml.slice(cell.el.openEnd, cell.el.closeStart);
    const paragraphs = elements(cell.el).filter((child) => child.local === 'p').sort((a, b) => b.start - a.start);
    for (const paragraph of paragraphs) {
      const start = paragraph.openEnd - cell.el.openEnd;
      const end = paragraph.closeStart - cell.el.openEnd;
      inner = inner.slice(0, start) + inner.slice(end);
    }
    return `${tag}${inner}</${cell.el.name}>`;
  }

  function odfFormula(formula: string): string {
    if (/!|\[[^\]]/.test(formula)) throw new FormatError('Les références à une autre feuille ne sont pas encore prises en charge pour les formules ODS.');
    return formula
      .replace(/(?<![\w.$])(\$?[A-Za-z]{1,3}\$?\d+)(?::(\$?[A-Za-z]{1,3}\$?\d+))?/g, (_all, from: string, to?: string) =>
        `[.${from}${to ? `:.${to}` : ''}]`)
      .replace(/,/g, ';');
  }

  function patchOdsSheet(xml: string, sheet: OdsSheet, changes: OdsChange[]): string {
    const byRow = new Map<number, OdsChange[]>();
    for (const change of changes) byRow.set(change.row, [...(byRow.get(change.row) ?? []), change]);
    const splices: { start: number; end: number; text: string }[] = [];
    const edited = new Set(changes.map(({ row, col }) => cellKey(row, col)));
    for (const cell of sheet.cells.values()) {
      if (!cell.formula || edited.has(cellKey(cell.row, cell.col))) continue;
      splices.push({ start: cell.el.start, end: cell.el.end, text: clearFormulaCache(xml, cell) });
    }
    const appendedRows: { row: number; xml: string }[] = [];
    const newRows = new Map<number, OdsChange[]>();
    for (const [rowIndex, rowChanges] of byRow) {
      const row = sheet.rows.get(rowIndex);
      if (!row) {
        newRows.set(rowIndex, rowChanges);
        continue;
      }
      if (row.repeat !== 1) throw new FormatError(`${sheet.name}!${cellRef(rowIndex, rowChanges[0].col)} : WorkLogs ne peut pas ajouter une cellule à une ligne répétée.`);
      const cells = elements(row.el).filter((child) => isTableCell(child) || isCoveredCell(child));
      if (row.el.selfClosing) {
        const last = rowChanges.reduce((max, change) => change.value === '' ? max : Math.max(max, change.col), -1);
        const additions = Array.from({ length: last + 1 }, (_, col) => {
          const change = rowChanges.find((candidate) => candidate.col === col);
          return change ? writeCell(xml, null, change) : '<table:table-cell/>';
        }).join('');
        if (additions) {
          const open = xml.slice(row.el.start, row.el.openEnd).replace(/\s*\/>$/, '>');
          splices.push({ start: row.el.start, end: row.el.end, text: `${open}${additions}</${row.el.name}>` });
        }
        continue;
      }
      const insertions = new Map<number, { at: number; column: number; changes: OdsChange[] }>();
      for (const change of rowChanges) {
        const source = sheet.cells.get(cellKey(change.row, change.col));
        if (source) {
          if (source.repeat !== 1) throw new FormatError(`${sheet.name}!${cellRef(change.row, change.col)} : la cellule est répétée.`);
          splices.push({ start: source.el.start, end: source.el.end, text: writeCell(xml, source, change) });
        } else {
          let column = 0;
          let preceding = 0;
          const next = cells.find((candidate) => {
            if (column > change.col) return true;
            column += cellRepeatOf(candidate);
            preceding = column;
            return false;
          });
          const at = next?.start ?? row.el.closeStart;
          const group = insertions.get(at) ?? { at, column: next ? preceding : column, changes: [] };
          group.changes.push(change);
          insertions.set(at, group);
        }
      }
      for (const insertion of insertions.values()) {
        let column = insertion.column;
        let text = '';
        for (const change of insertion.changes.sort((a, b) => a.col - b.col)) {
          if (change.value === '') continue;
          text += '<table:table-cell/>'.repeat(Math.max(0, change.col - column));
          text += writeCell(xml, null, change);
          column = change.col + 1;
        }
        if (text) splices.push({ start: insertion.at, end: insertion.at, text });
      }
    }
    const firstNewRow = Math.max(0, ...[...sheet.rows.values()].map((row) => row.row + row.repeat));
    const lastNewRow = Math.max(-1, ...newRows.keys());
    for (let rowIndex = firstNewRow; rowIndex <= lastNewRow; rowIndex++) {
      const rowChanges = newRows.get(rowIndex) ?? [];
      const last = rowChanges.reduce((max, change) => change.value === '' ? max : Math.max(max, change.col), -1);
      const cells = Array.from({ length: last + 1 }, (_, col) => {
        const change = rowChanges.find((candidate) => candidate.col === col);
        return change ? writeCell(xml, null, change) : '<table:table-cell/>';
      }).join('');
      appendedRows.push({ row: rowIndex, xml: `<table:table-row>${cells ? cells : ''}</table:table-row>` });
    }
    if (appendedRows.length) {
      const shapes = elements(sheet.table).find((child) => nsOf(child) === OFFICE_NS && child.local === 'shapes');
      const at = shapes?.start ?? sheet.table.closeStart;
      splices.push({ start: at, end: at, text: appendedRows.sort((a, b) => a.row - b.row).map((row) => row.xml).join('') });
    }
    let out = xml;
    for (const splice of splices.sort((a, b) => b.start - a.start || b.end - a.end)) {
      out = out.slice(0, splice.start) + splice.text + out.slice(splice.end);
    }
    if (!isWellFormed(out)) throw new FormatError(`WorkLogs a produit un classeur ODS invalide (${sheet.name}) : rien n’est envoyé. Signale-le.`);
    return out;
  }

  return writeZip(archive, zipEdits);
}


export function patchOdsMeta(xml: string, author: string, now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const w3cdtf = (date: Date) =>
    date.getUTCFullYear() + '-' + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate()) + 'T' + pad(date.getUTCHours()) + ':' + pad(date.getUTCMinutes()) + ':' + pad(date.getUTCSeconds()) + 'Z';

  const root = scanXml(xml);
  const edits: { start: number; end: number; text: string }[] = [];
  const metaNS = 'urn:oasis:names:tc:opendocument:xmlns:meta:1.0';

  const replaceText = (local: string, value: string) => {
    const el = descendants(root).find((child) => nsOf(child) === metaNS && child.local === local);
    if (!el) return false;
    if (el.selfClosing) edits.push({ start: el.start, end: el.end, text: '<' + el.name + '>' + escapeText(value) + '</' + el.name + '>' });
    else edits.push({ start: el.openEnd, end: el.closeStart, text: escapeText(value) });
    return true;
  };

  if (author) replaceText('creator', author);
  replaceText('date', w3cdtf(now));

  let out = xml;
  for (const edit of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

function isWellFormed(xml: string): boolean {
  const check = new DOMParser().parseFromString(xml, 'application/xml');
  return !check.getElementsByTagName('parsererror').length;
}