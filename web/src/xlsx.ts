import { readZip, readZipText, writeZip, ZipError, type ZipArchive } from './zip';
import { attrNS, elements, escapeAttr, escapeText, findChild, scanXml, XmlScanError, type XmlElement } from './xml-scan';
import { coreAuthor, isWellFormed, packageParts, partRelsPath, patchCoreProperties, relationships, resolveTarget, textOf } from './ooxml';
import { FormatError } from './file-formats';
import { BUILTIN_FORMATS, dateToSerial, errorLabel, formatNumber, formatText, numberInput, parseInput, type ParsedInput } from './xlsx-format';
import { formulaDependencies, formulaToFrench, FormulaError, normalizeFormula, type FormulaDependencies } from './xlsx-formula';

/**
 * Classeurs Excel (.xlsx) du dossier partagé, **réécrits cellule par cellule** :
 * seules les balises `<c>` des cellules modifiées changent dans la feuille ; une
 * chaîne nouvelle s'ajoute à la fin des chaînes partagées (jamais une chaîne
 * existante modifiée : d'autres cellules la partagent) ; le classeur demande à
 * Excel de tout recalculer à l'ouverture. Graphiques, mises en forme,
 * validations, commentaires, tableaux : recopiés tels quels. Rien de modifié :
 * le fichier d'origine, à l'identique.
 */

const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const S_STRICT = 'http://purl.oclc.org/ooxml/spreadsheetml/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export const MAX_ROWS = 1048576;
export const MAX_COLUMNS = 16384;
/** Au-delà, la grille n'affiche pas (les cellules restent dans le fichier). */
export const GRID_LIMITS = { rows: 100000, columns: 256 };

export interface XlsxCell {
  row: number;
  col: number;
  el: XmlElement;
  style: number;
  type: string;
  display: string;
  /** Ce que montre la barre de formule (formule en français, nombre sans format). */
  input: string;
  /** La cellule porte une formule : la remplacer rend la chaîne de calcul caduque. */
  formula: boolean;
  /** Formule telle qu'enregistrée (anglais) ; vide pour une copie de formule partagée. */
  f: { text: string; type: string; si: string | null } | null;
  /** Indice de chaîne partagée qu'elle référence, s'il y en a un. */
  shared: number | null;
}

interface XlsxRow {
  el: XmlElement;
  index: number;
  style: number | null;
}

interface LockedArea {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  reason: string;
}

export interface XlsxSheet {
  name: string;
  hidden: boolean;
  kind: 'worksheet' | 'chartsheet' | 'other';
  part: string | null;
  xml: string;
  root: XmlElement | null;
  sheetData: XmlElement | null;
  rows: Map<number, XlsxRow>;
  cells: Map<number, XlsxCell>;
  /** Étendue utile (cellules avec une valeur ou une formule, fusions, tableaux). */
  rowCount: number;
  colCount: number;
  readOnly: string | null;
  locked: LockedArea[];
  protected: boolean;
  colStyles: { min: number; max: number; style: number }[];
  /** Préfixe de l'espace de noms principal dans cette feuille (`''` chez Excel). */
  p: string;
}

interface SharedStrings {
  part: string | null;
  xml: string | null;
  root: XmlElement | null;
  strings: string[];
  /** Texte → indice, pour les chaînes sans mise en forme (réutilisables telles quelles). */
  plain: Map<string, number>;
}

export interface XlsxWorkbook {
  archive: ZipArchive;
  mainPart: string;
  corePart: string | null;
  workbookXml: string;
  workbookRoot: XmlElement;
  sheets: XlsxSheet[];
  activeSheet: number;
  date1904: boolean;
  readOnly: string | null;
  sst: SharedStrings;
  formats: string[];
  locked: boolean[];
  calcChainPart: string | null;
  author: string | null;
  /** Noms définis (`Taux` → `Paramètres!$B$1`), pour suivre ce que lisent les formules. */
  names: { name: string; text: string }[];
}

/** Feuille → référence A1 → ce qui a été tapé. */
export type XlsxEdits = Record<string, Record<string, string>>;

export interface XlsxDraft {
  format: 'xlsx';
  v: 1;
  edits: XlsxEdits;
}

// ------------------------------------------------------------- références

export function columnLetters(index: number): string {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rest = (n - 1) % 26;
    name = String.fromCharCode(65 + rest) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

export const cellRef = (row: number, col: number) => `${columnLetters(col)}${row + 1}`;

export function parseRef(ref: string): { row: number; col: number } | null {
  const match = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref.trim());
  if (!match) return null;
  let col = 0;
  for (const char of match[1].toUpperCase()) col = col * 26 + char.charCodeAt(0) - 64;
  const row = Number(match[2]);
  if (col < 1 || col > MAX_COLUMNS || row < 1 || row > MAX_ROWS) return null;
  return { row: row - 1, col: col - 1 };
}

function parseRange(ref: string): { r1: number; c1: number; r2: number; c2: number } | null {
  const [from, to = from] = ref.split(':');
  const a = parseRef(from);
  const b = parseRef(to);
  if (!a || !b) return null;
  return { r1: Math.min(a.row, b.row), c1: Math.min(a.col, b.col), r2: Math.max(a.row, b.row), c2: Math.max(a.col, b.col) };
}

const cellKey = (row: number, col: number) => row * MAX_COLUMNS + col;

// --------------------------------------------------------------- lecture

const isOn = (value: string | null | undefined) => value === '1' || value === 'true' || value === 'on';

/** `_x000D_` : Excel code ainsi les caractères de contrôle dans son XML. */
const decodeEscapes = (text: string) => text.replace(/_x([0-9A-Fa-f]{4})_/g, (_all, hex: string) => String.fromCharCode(parseInt(hex, 16)));
const encodeEscapes = (text: string) =>
  text.replace(/_x[0-9A-Fa-f]{4}_/g, (all) => `_x005F${all}`)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, (char) => `_x${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`);

/** Texte d'une chaîne (`<si>` ou `<is>`) : texte simple ou suite de runs, sans la phonétique. */
function richText(el: XmlElement): string {
  let out = '';
  for (const child of elements(el)) {
    if (child.ns !== S) continue;
    if (child.local === 't') out += textOf(child);
    else if (child.local === 'r') out += elements(child).filter((t) => t.ns === S && t.local === 't').map(textOf).join('');
  }
  return decodeEscapes(out);
}

async function readSharedStrings(archive: ZipArchive, part: string | null): Promise<SharedStrings> {
  const xml = part ? await readZipText(archive, part) : null;
  const out: SharedStrings = { part: xml === null ? null : part, xml, root: null, strings: [], plain: new Map() };
  if (xml === null) return out;
  out.root = scanXml(xml);
  for (const si of elements(out.root)) {
    if (si.ns !== S || si.local !== 'si') continue;
    const text = richText(si);
    const children = elements(si);
    if (children.length === 1 && children[0].local === 't' && !out.plain.has(text)) out.plain.set(text, out.strings.length);
    out.strings.push(text);
  }
  return out;
}

async function readStyles(archive: ZipArchive, part: string | null) {
  const formats: string[] = [];
  const locked: boolean[] = [];
  const xml = part ? await readZipText(archive, part) : null;
  if (!xml) return { formats, locked };
  const root = scanXml(xml);
  const custom = new Map<number, string>();
  for (const fmt of elements(findChild(root, S, 'numFmts') ?? root)) {
    if (fmt.local === 'numFmt') custom.set(Number(fmt.attrs.numFmtId), fmt.attrs.formatCode ?? 'General');
  }
  for (const xf of elements(findChild(root, S, 'cellXfs') ?? root)) {
    if (xf.local !== 'xf') continue;
    const id = Number(xf.attrs.numFmtId ?? 0);
    formats.push(custom.get(id) ?? BUILTIN_FORMATS[id] ?? 'General');
    const protection = findChild(xf, S, 'protection');
    locked.push(!(protection && ['0', 'false'].includes(protection.attrs.locked ?? '')));
  }
  return { formats, locked };
}

interface ReadContext {
  strings: string[];
  formats: string[];
  locked: boolean[];
  date1904: boolean;
}

const formatOf = (ctx: { formats: string[] }, style: number) => ctx.formats[style] ?? 'General';

/** La saisie qui redonne ce texte tel quel (une apostrophe s'il passerait pour un nombre). */
function textInput(text: string, format: string, date1904: boolean): string {
  const parsed = parseInput(text, format, { date1904 });
  return parsed.kind === 'text' && parsed.value === text ? text : `'${text}`;
}

function readCell(el: XmlElement, row: number, col: number, ctx: ReadContext): XlsxCell {
  const style = Number(el.attrs.s ?? 0) || 0;
  const type = el.attrs.t ?? 'n';
  const format = formatOf(ctx, style);
  const f = findChild(el, S, 'f');
  const v = findChild(el, S, 'v');
  const raw = v ? textOf(v) : null;
  const formulaText = f ? textOf(f) : '';
  let display = '';
  let input = '';
  let shared: number | null = null;
  switch (type) {
    case 's': {
      shared = raw === null ? null : Number(raw);
      const text = shared === null ? '' : ctx.strings[shared] ?? '';
      display = formatText(text, format);
      input = textInput(text, format, ctx.date1904);
      break;
    }
    case 'inlineStr': {
      const is = findChild(el, S, 'is');
      const text = is ? richText(is) : '';
      display = formatText(text, format);
      input = textInput(text, format, ctx.date1904);
      break;
    }
    case 'str':
      display = decodeEscapes(raw ?? '');
      input = textInput(display, format, ctx.date1904);
      break;
    case 'b':
      display = raw === '1' || raw === 'true' ? 'VRAI' : raw === null ? '' : 'FAUX';
      input = display;
      break;
    case 'e':
      display = raw === null ? '' : errorLabel(raw);
      input = display;
      break;
    case 'd': {
      const time = raw ? Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(raw) ? raw : `${raw}Z`) : NaN;
      if (Number.isFinite(time)) {
        const serial = dateToSerial(new Date(time), ctx.date1904);
        display = formatNumber(serial, format, ctx.date1904);
        input = numberInput(serial, format, ctx.date1904);
      }
      break;
    }
    default: {
      const value = raw === null || raw.trim() === '' ? null : Number(raw);
      if (value !== null && Number.isFinite(value)) {
        display = formatNumber(value, format, ctx.date1904);
        input = numberInput(value, format, ctx.date1904);
      }
    }
  }
  if (f && formulaText) {
    input = `=${formulaToFrench(formulaText)}`;
    // Formule jamais calculée (écrite par WorkLogs, pas encore ouverte dans Excel) : on la montre.
    if (raw === null) display = input;
  }
  return { row, col, el, style, type, display, input, formula: Boolean(f), shared, f: f ? { text: formulaText, type: f.attrs.t ?? 'normal', si: f.attrs.si ?? null } : null };
}

const READ_ONLY = {
  merged: (anchor: string) => `Cellule fusionnée avec ${anchor} : seule ${anchor} se modifie.`,
  header: (table: string) => `En-tête du tableau « ${table} » : à renommer dans Excel.`,
  totals: (table: string) => `Ligne des totaux du tableau « ${table} » : modifiable dans Excel.`,
  pivot: 'Tableau croisé dynamique : à modifier dans Excel.',
  array: (ref: string) => `Formule matricielle (${ref}) : à modifier dans Excel.`,
  sharedMaster: (ref: string) => `Formule recopiée sur ${ref} : à modifier dans Excel, les autres cellules en dépendent.`,
  richValue: 'Valeur riche (image dans la cellule, données liées) : à modifier dans Excel.',
  dynamic: 'Formule matricielle dynamique : à modifier dans Excel.',
  protectedCell: 'Feuille protégée dans Excel : cette cellule est verrouillée.',
};

async function readWorksheet(archive: ZipArchive, part: string, name: string, hidden: boolean, ctx: ReadContext): Promise<XlsxSheet> {
  const xml = await readZipText(archive, part);
  const sheet: XlsxSheet = {
    name, hidden, kind: 'worksheet', part, xml: xml ?? '', root: null, sheetData: null, rows: new Map(), cells: new Map(),
    rowCount: 0, colCount: 0, readOnly: null, locked: [], protected: false, colStyles: [], p: '',
  };
  if (xml === null) {
    sheet.readOnly = 'Feuille introuvable dans le classeur.';
    return sheet;
  }
  const root = scanXml(xml);
  sheet.root = root;
  sheet.p = root.name.includes(':') ? root.name.slice(0, root.name.indexOf(':') + 1) : '';
  const sheetData = findChild(root, S, 'sheetData');
  sheet.sheetData = sheetData;
  if (!sheetData) {
    sheet.readOnly = 'Feuille sans données lisibles : à modifier dans Excel.';
    return sheet;
  }
  const protection = findChild(root, S, 'sheetProtection');
  sheet.protected = Boolean(protection && isOn(protection.attrs.sheet));
  for (const col of elements(findChild(root, S, 'cols') ?? sheetData)) {
    if (col.local === 'col' && col.attrs.style) sheet.colStyles.push({ min: Number(col.attrs.min) - 1, max: Number(col.attrs.max) - 1, style: Number(col.attrs.style) });
  }
  let maxRow = -1;
  let maxCol = -1;
  const extend = (row: number, col: number) => {
    if (row > maxRow) maxRow = row;
    if (col > maxCol) maxCol = col;
  };
  let implicit = false;
  let previousRow = -1;
  for (const rowEl of elements(sheetData)) {
    if (rowEl.ns !== S || rowEl.local !== 'row') continue;
    const r = Number(rowEl.attrs.r);
    if (!rowEl.attrs.r) implicit = true;
    const rowIndex = rowEl.attrs.r && r >= 1 ? r - 1 : previousRow + 1;
    previousRow = rowIndex;
    sheet.rows.set(rowIndex, { el: rowEl, index: rowIndex, style: isOn(rowEl.attrs.customFormat) && rowEl.attrs.s ? Number(rowEl.attrs.s) : null });
    let previousCol = -1;
    for (const c of elements(rowEl)) {
      if (c.ns !== S || c.local !== 'c') continue;
      if (!c.attrs.r) implicit = true;
      const position = c.attrs.r ? parseRef(c.attrs.r) : null;
      const col = position ? position.col : previousCol + 1;
      previousCol = col;
      const cell = readCell(c, rowIndex, col, ctx);
      sheet.cells.set(cellKey(rowIndex, col), cell);
      if (cell.display !== '' || cell.formula) extend(rowIndex, col);
      const f = findChild(c, S, 'f');
      const ref = f?.attrs.ref;
      const range = ref ? parseRange(ref) : null;
      if (f?.attrs.t === 'array' || f?.attrs.t === 'dataTable') {
        sheet.locked.push({ ...(range ?? { r1: rowIndex, c1: col, r2: rowIndex, c2: col }), reason: READ_ONLY.array(ref ?? cellRef(rowIndex, col)) });
      } else if (f?.attrs.t === 'shared' && ref && range && (range.r2 > range.r1 || range.c2 > range.c1)) {
        sheet.locked.push({ r1: rowIndex, c1: col, r2: rowIndex, c2: col, reason: READ_ONLY.sharedMaster(ref) });
      }
      if (c.attrs.vm) sheet.locked.push({ r1: rowIndex, c1: col, r2: rowIndex, c2: col, reason: READ_ONLY.richValue });
      else if (c.attrs.cm) sheet.locked.push({ r1: rowIndex, c1: col, r2: rowIndex, c2: col, reason: READ_ONLY.dynamic });
    }
  }
  if (implicit) sheet.readOnly = 'Feuille écrite sans numéros de ligne ou de cellule (outil inhabituel) : à modifier dans Excel.';
  for (const merge of elements(findChild(root, S, 'mergeCells') ?? sheetData)) {
    if (merge.local !== 'mergeCell') continue;
    const range = parseRange(merge.attrs.ref ?? '');
    if (!range) continue;
    extend(range.r2, range.c2);
    const anchor = cellRef(range.r1, range.c1);
    for (let row = range.r1; row <= range.r2; row++) {
      // Toute la zone sauf la cellule d'ancrage, en bandes : une zone par ligne.
      const c1 = row === range.r1 ? range.c1 + 1 : range.c1;
      if (c1 <= range.c2) sheet.locked.push({ r1: row, c1, r2: row, c2: range.c2, reason: READ_ONLY.merged(anchor) });
    }
  }
  // Tableaux et tableaux croisés : relations de la feuille.
  for (const rel of await relationships(archive, part)) {
    if (rel.external) continue;
    const target = resolveTarget(part, rel.target);
    if (/\/table$/.test(rel.type)) {
      const tableXml = await readZipText(archive, target);
      if (!tableXml) continue;
      const table = scanXml(tableXml);
      const range = parseRange(table.attrs.ref ?? '');
      if (!range) continue;
      extend(range.r2, range.c2);
      const label = table.attrs.displayName ?? table.attrs.name ?? '';
      const headers = table.attrs.headerRowCount === undefined ? 1 : Number(table.attrs.headerRowCount);
      const totals = Number(table.attrs.totalsRowCount ?? 0);
      if (headers > 0) sheet.locked.push({ r1: range.r1, c1: range.c1, r2: range.r1 + headers - 1, c2: range.c2, reason: READ_ONLY.header(label) });
      if (totals > 0) sheet.locked.push({ r1: range.r2 - totals + 1, c1: range.c1, r2: range.r2, c2: range.c2, reason: READ_ONLY.totals(label) });
    } else if (/\/pivotTable$/.test(rel.type)) {
      const pivotXml = await readZipText(archive, target);
      const location = pivotXml ? findChild(scanXml(pivotXml), S, 'location') : null;
      const range = location ? parseRange(location.attrs.ref ?? '') : null;
      if (range) {
        extend(range.r2, range.c2);
        sheet.locked.push({ ...range, reason: READ_ONLY.pivot });
      }
    }
  }
  sheet.rowCount = maxRow + 1;
  sheet.colCount = maxCol + 1;
  return sheet;
}

function wrapError(error: unknown): never {
  if (error instanceof FormatError) throw error;
  if (error instanceof ZipError || error instanceof XmlScanError) throw new FormatError(`Classeur Excel illisible : ${error.message}`);
  throw error;
}

/** Lit un .xlsx : feuilles, cellules affichées à la française, et tout ce qu'il faut pour le réécrire. */
export async function readXlsxWorkbook(bytes: Uint8Array): Promise<XlsxWorkbook> {
  try {
    const archive = readZip(bytes);
    const { mainPart, corePart } = await packageParts(archive, 'xl/workbook.xml');
    const workbookXml = await readZipText(archive, mainPart);
    if (workbookXml === null) throw new FormatError('Ce fichier n’est pas un classeur Excel (.xlsx) : classeur introuvable.');
    const root = scanXml(workbookXml);
    if (root.ns === S_STRICT) {
      throw new FormatError('Classeur Excel au format « OOXML strict » : WorkLogs ne sait pas encore le modifier. « Ouvrir avec… » l’ouvre dans LibreOffice.');
    }
    if (root.ns !== S || root.local !== 'workbook') throw new FormatError('Ce fichier n’est pas un classeur Excel (.xlsx).');
    const rels = await relationships(archive, mainPart);
    const relById = new Map(rels.map((rel) => [rel.id, rel]));
    const partOf = (type: RegExp) => {
      const rel = rels.find((candidate) => type.test(candidate.type) && !candidate.external);
      return rel ? resolveTarget(mainPart, rel.target) : null;
    };
    const date1904 = isOn(findChild(root, S, 'workbookPr')?.attrs.date1904);
    const sst = await readSharedStrings(archive, partOf(/\/sharedStrings$/));
    const { formats, locked } = await readStyles(archive, partOf(/\/styles$/));
    const ctx: ReadContext = { strings: sst.strings, formats, locked, date1904 };

    let readOnly: string | null = null;
    const contentTypes = await readZipText(archive, '[Content_Types].xml');
    if (archive.byName.has('xl/vbaProject.bin') || (contentTypes && /macroEnabled/i.test(contentTypes))) {
      readOnly = 'Classeur avec macros (.xlsm) : lecture seule dans WorkLogs. « Ouvrir avec… » pour le modifier.';
    }
    const sharing = findChild(root, S, 'fileSharing');
    if (sharing && (sharing.attrs.reservationPassword || sharing.attrs.hashValue)) {
      readOnly = 'Classeur protégé par un mot de passe de modification : lecture seule dans WorkLogs.';
    }

    const sheets: XlsxSheet[] = [];
    for (const entry of elements(findChild(root, S, 'sheets') ?? root)) {
      if (entry.local !== 'sheet') continue;
      const name = entry.attrs.name ?? `Feuille ${sheets.length + 1}`;
      const hidden = entry.attrs.state === 'hidden' || entry.attrs.state === 'veryHidden';
      const rel = relById.get(attrNS(entry, R, 'id') ?? '');
      const part = rel && !rel.external ? resolveTarget(mainPart, rel.target) : null;
      if (rel && part && /\/worksheet$/.test(rel.type)) {
        sheets.push(await readWorksheet(archive, part, name, hidden, ctx));
      } else {
        sheets.push({
          name, hidden, kind: rel && /\/chartsheet$/.test(rel.type) ? 'chartsheet' : 'other', part, xml: '', root: null, sheetData: null,
          rows: new Map(), cells: new Map(), rowCount: 0, colCount: 0, readOnly: 'Cette feuille n’a pas de cellules : à modifier dans Excel.',
          locked: [], protected: false, colStyles: [], p: '',
        });
      }
    }
    if (!sheets.length) throw new FormatError('Classeur Excel sans feuille.');
    const view = findChild(findChild(root, S, 'bookViews'), S, 'workbookView');
    let activeSheet = Math.min(Number(view?.attrs.activeTab ?? 0) || 0, sheets.length - 1);
    if (sheets[activeSheet].hidden) activeSheet = Math.max(0, sheets.findIndex((sheet) => !sheet.hidden));
    return {
      archive, mainPart, corePart, workbookXml, workbookRoot: root, sheets, activeSheet, date1904, readOnly, sst, formats, locked,
      calcChainPart: partOf(/\/calcChain$/), author: await coreAuthor(archive, corePart),
      names: elements(findChild(root, S, 'definedNames') ?? root).filter((el) => el.local === 'definedName').map((el) => ({ name: el.attrs.name ?? '', text: textOf(el) })),
    };
  } catch (error) {
    wrapError(error);
  }
}

// ------------------------------------------------------------ cellules

/** Style d'une cellule absente du fichier : celui de sa ligne, sinon de sa colonne. */
function styleAt(sheet: XlsxSheet, row: number, col: number): number {
  const cell = sheet.cells.get(cellKey(row, col));
  if (cell) return cell.style;
  const rowStyle = sheet.rows.get(row)?.style;
  if (rowStyle !== null && rowStyle !== undefined) return rowStyle;
  return sheet.colStyles.find((range) => col >= range.min && col <= range.max)?.style ?? 0;
}

/** Pourquoi cette cellule ne se modifie pas ici, ou `null`. */
export function cellReadOnly(workbook: XlsxWorkbook, sheet: XlsxSheet, row: number, col: number): string | null {
  if (workbook.readOnly) return workbook.readOnly;
  if (sheet.readOnly) return sheet.readOnly;
  for (const area of sheet.locked) {
    if (row >= area.r1 && row <= area.r2 && col >= area.c1 && col <= area.c2) return area.reason;
  }
  // Feuille protégée : chaque cellule suit la protection de son style (verrouillée par défaut).
  if (sheet.protected && (workbook.locked[styleAt(sheet, row, col)] ?? true)) return READ_ONLY.protectedCell;
  return null;
}

export interface CellView {
  display: string;
  input: string;
  readOnly: string | null;
  /** Nombre ou date : aligné à droite, comme dans Excel. */
  numeric: boolean;
}

/** Ce que la grille montre d'une cellule, modification en cours comprise. */
export function cellView(workbook: XlsxWorkbook, sheet: XlsxSheet, row: number, col: number, edits?: Record<string, string>): CellView {
  const cell = sheet.cells.get(cellKey(row, col));
  const readOnly = cellReadOnly(workbook, sheet, row, col);
  const typed = edits?.[cellRef(row, col)];
  if (typed === undefined) {
    const numeric = Boolean(cell && (cell.type === 'n' || cell.type === 'd') && cell.display !== '' && !cell.display.startsWith('='));
    return { display: cell?.display ?? '', input: cell?.input ?? '', readOnly, numeric };
  }
  const format = formatOf(workbook, styleAt(sheet, row, col));
  const parsed = parseInput(typed, format, { date1904: workbook.date1904 });
  const display = parsed.kind === 'empty' ? ''
    : parsed.kind === 'number' ? formatNumber(parsed.value, format, workbook.date1904)
      : parsed.kind === 'boolean' ? (parsed.value ? 'VRAI' : 'FAUX')
        : parsed.kind === 'text' ? formatText(parsed.value, format)
          : typed;
  return { display, input: typed, readOnly, numeric: parsed.kind === 'number' };
}

/** Étendue à afficher : le contenu, les modifications, et une ligne et une colonne libres pour ajouter. */
export function gridSize(sheet: XlsxSheet, edits?: Record<string, string>) {
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

// --------------------------------------------------------------- écriture

type Change = { row: number; col: number; source: XlsxCell | null; style: number; value: Exclude<ParsedInput, { kind: 'formula' }> | { kind: 'formula'; value: string } };

/** Modifications effectives (différentes de l'original), feuille par feuille ; problèmes en clair. */
function plan(workbook: XlsxWorkbook, edits: XlsxEdits) {
  const problems: string[] = [];
  const bySheet = new Map<XlsxSheet, Change[]>();
  for (const [name, cells] of Object.entries(edits)) {
    const sheet = workbook.sheets.find((candidate) => candidate.name === name);
    if (!sheet) {
      if (Object.keys(cells).length) problems.push(`La feuille « ${name} » n’existe plus dans ce classeur.`);
      continue;
    }
    for (const [ref, typed] of Object.entries(cells)) {
      const position = parseRef(ref);
      if (!position) continue;
      const { row, col } = position;
      const source = sheet.cells.get(cellKey(row, col)) ?? null;
      if (typed === (source?.input ?? '')) continue;
      const reason = cellReadOnly(workbook, sheet, row, col);
      if (reason) {
        problems.push(`${name}!${ref} : ${reason}`);
        continue;
      }
      const style = styleAt(sheet, row, col);
      const parsed = parseInput(typed, formatOf(workbook, style), { date1904: workbook.date1904 });
      if (parsed.kind === 'empty' && !source) continue;
      let value: Change['value'] = parsed;
      if (parsed.kind === 'formula') {
        try {
          value = { kind: 'formula', value: normalizeFormula(parsed.value) };
        } catch (error) {
          if (!(error instanceof FormulaError)) throw error;
          problems.push(`${name}!${ref} : formule incomprise (${error.message}). Une formule commence par « = », par exemple =SOMME(A1:A3).`);
          continue;
        }
      }
      if (value.kind === 'text' && value.value.length > 32767) {
        problems.push(`${name}!${ref} : texte trop long pour une cellule Excel (32 767 caractères au plus).`);
        continue;
      }
      const list = bySheet.get(sheet) ?? [];
      list.push({ row, col, source, style, value });
      bySheet.set(sheet, list);
    }
  }
  return { problems, bySheet };
}

/** Ce qui empêcherait l'envoi du brouillon (formule fautive, cellule protégée…). */
export function xlsxProblems(workbook: XlsxWorkbook, edits: XlsxEdits): string[] {
  if (workbook.readOnly) return [workbook.readOnly];
  return plan(workbook, edits).problems;
}

/** Brouillon sans les saisies identiques à l'original (un aller-retour ne compte pas). */
export function effectiveEdits(workbook: XlsxWorkbook, edits: XlsxEdits): XlsxEdits {
  const out: XlsxEdits = {};
  for (const [name, cells] of Object.entries(edits)) {
    const sheet = workbook.sheets.find((candidate) => candidate.name === name);
    for (const [ref, typed] of Object.entries(cells)) {
      const position = parseRef(ref);
      const source = sheet && position ? sheet.cells.get(cellKey(position.row, position.col)) : undefined;
      if (typed === (source?.input ?? '')) continue;
      (out[name] ??= {})[ref] = typed;
    }
  }
  return out;
}

class StringTable {
  readonly added: string[] = [];
  private readonly addedIndex = new Map<string, number>();
  references = 0;

  constructor(private readonly sst: SharedStrings) {}

  get available() {
    return this.sst.part !== null && this.sst.root !== null;
  }

  index(text: string): number {
    this.references++;
    const existing = this.sst.plain.get(text) ?? this.addedIndex.get(text);
    if (existing !== undefined) return existing;
    const index = this.sst.strings.length + this.added.length;
    this.added.push(text);
    this.addedIndex.set(text, index);
    return index;
  }

  /** Les chaînes ajoutées à la fin, compteurs à jour ; les `<si>` existants restent intacts. */
  xml(): string | null {
    const { xml, root } = this.sst;
    if (!xml || !root || (!this.added.length && !this.references)) return null;
    const p = root.name.includes(':') ? root.name.slice(0, root.name.indexOf(':') + 1) : '';
    const items = this.added.map((text) => `<${p}si>${textElement(p, text)}</${p}si>`).join('');
    let startTag = xml.slice(root.start, root.openEnd);
    const bump = (name: string, delta: number) => {
      startTag = startTag.replace(new RegExp(`(\\s${name}\\s*=\\s*["'])(\\d+)(["'])`), (_all, before: string, value: string, after: string) => `${before}${Math.max(0, Number(value) + delta)}${after}`);
    };
    bump('count', this.references);
    bump('uniqueCount', this.added.length);
    if (root.selfClosing) return xml.slice(0, root.start) + startTag.replace(/\s*\/>$/, '>') + items + `</${root.name}>` + xml.slice(root.end);
    return xml.slice(0, root.start) + startTag + xml.slice(root.openEnd, root.closeStart) + items + xml.slice(root.closeStart);
  }
}

function textElement(p: string, text: string): string {
  const encoded = escapeText(encodeEscapes(text));
  const preserve = /^\s|\s$|\n|\t/.test(text) ? ' xml:space="preserve"' : '';
  return `<${p}t${preserve}>${encoded}</${p}t>`;
}

/** Number → texte XML (`xsd:double`) sans perte. */
const numberText = (value: number) => String(value);

/** La nouvelle balise `<c>` : référence, style et attributs d'origine gardés, valeur et type remplacés. */
function cellXml(sheet: XlsxSheet, change: Change, strings: StringTable): string {
  const { p } = sheet;
  const ref = cellRef(change.row, change.col);
  const kept = change.source
    ? Object.entries(change.source.el.attrs).filter(([key]) => !['r', 's', 't'].includes(key)).map(([key, value]) => ` ${key}="${escapeAttr(value)}"`).join('')
    : '';
  const style = change.style ? ` s="${change.style}"` : '';
  const extLst = change.source ? findChild(change.source.el, S, 'extLst') : null;
  const tail = extLst ? sheet.xml.slice(extLst.start, extLst.end) : '';
  const open = (type: string) => `<${p}c r="${ref}"${style}${type}${kept}>`;
  const { value } = change;
  switch (value.kind) {
    case 'empty':
      return tail ? `${open('')}${tail}</${p}c>` : `<${p}c r="${ref}"${style}${kept}/>`;
    case 'number':
      return `${open('')}<${p}v>${numberText(value.value)}</${p}v>${tail}</${p}c>`;
    case 'boolean':
      return `${open(' t="b"')}<${p}v>${value.value ? 1 : 0}</${p}v>${tail}</${p}c>`;
    case 'formula':
      return `${open('')}<${p}f>${escapeText(value.value)}</${p}f>${tail}</${p}c>`;
    case 'text':
      if (strings.available) return `${open(' t="s"')}<${p}v>${strings.index(value.value)}</${p}v>${tail}</${p}c>`;
      return `${open(' t="inlineStr"')}<${p}is>${textElement(p, value.value)}</${p}is>${tail}</${p}c>`;
  }
}

interface Splice { start: number; end: number; text: string }

function applySplices(xml: string, splices: Splice[]): string {
  let out = xml;
  // De la fin vers le début. À position égale : d'abord le remplacement (la balise
  // ouvrante d'une ligne ou d'une cellule), puis les insertions devant lui, dans leur ordre.
  const ordered = splices.map((splice, order) => ({ ...splice, order })).sort((a, b) => b.start - a.start || b.end - a.end || b.order - a.order);
  for (const splice of ordered) out = out.slice(0, splice.start) + splice.text + out.slice(splice.end);
  return out;
}

/** `spans="1:3"` : indication de largeur de la ligne, élargie si on écrit au-delà. */
function widenSpans(startTag: string, cols: number[]): string {
  return startTag.replace(/(\sspans\s*=\s*")(\d+):(\d+)(")/, (_all, before: string, from: string, to: string, after: string) => {
    const min = Math.min(Number(from), ...cols.map((col) => col + 1));
    const max = Math.max(Number(to), ...cols.map((col) => col + 1));
    return `${before}${min}:${max}${after}`;
  });
}

function patchSheet(sheet: XlsxSheet, changes: Change[], strings: StringTable, stale: XlsxCell[]): string {
  const { p, xml, sheetData } = sheet;
  if (!sheetData || !sheet.root) throw new FormatError(`Feuille « ${sheet.name} » illisible : rien n’est envoyé.`);
  const splices: Splice[] = [];
  // Formules qui lisent une cellule modifiée : leur valeur d'avant est retirée, Excel
  // et LibreOffice la recalculent à l'ouverture (et WorkLogs montre la formule).
  for (const cell of stale) {
    const v = findChild(cell.el, S, 'v');
    if (!v) continue;
    splices.push({ start: v.start, end: v.end, text: '' });
    const tag = xml.slice(cell.el.start, cell.el.openEnd);
    const untyped = tag.replace(/\st\s*=\s*["'][^"']*["']/, '');
    if (untyped !== tag) splices.push({ start: cell.el.start, end: cell.el.openEnd, text: untyped });
  }
  const byRow = new Map<number, Change[]>();
  for (const change of changes) {
    if (change.source && change.source.shared !== null) strings.references--;
    byRow.set(change.row, [...(byRow.get(change.row) ?? []), change]);
  }
  const existingRows = [...sheet.rows.values()].sort((a, b) => a.index - b.index);
  for (const [rowIndex, rowChanges] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
    rowChanges.sort((a, b) => a.col - b.col);
    const row = sheet.rows.get(rowIndex);
    if (!row) {
      const cells = rowChanges.filter((change) => change.value.kind !== 'empty').map((change) => cellXml(sheet, change, strings)).join('');
      if (!cells) continue;
      const text = `<${p}row r="${rowIndex + 1}">${cells}</${p}row>`;
      const next = existingRows.find((candidate) => candidate.index > rowIndex);
      if (next) splices.push({ start: next.el.start, end: next.el.start, text });
      else if (sheetData.selfClosing) splices.push({ start: sheetData.start, end: sheetData.end, text: `<${sheetData.name}>${text}</${sheetData.name}>` });
      else splices.push({ start: sheetData.closeStart, end: sheetData.closeStart, text });
      continue;
    }
    const sourceCells = elements(row.el).filter((child) => child.ns === S && child.local === 'c');
    const startTag = widenSpans(xml.slice(row.el.start, row.el.openEnd), rowChanges.map((change) => change.col));
    if (row.el.selfClosing) {
      const cells = rowChanges.filter((change) => change.value.kind !== 'empty').map((change) => cellXml(sheet, change, strings)).join('');
      if (cells) splices.push({ start: row.el.start, end: row.el.end, text: `${startTag.replace(/\s*\/>$/, '>')}${cells}</${row.el.name}>` });
      continue;
    }
    if (startTag !== xml.slice(row.el.start, row.el.openEnd)) splices.push({ start: row.el.start, end: row.el.openEnd, text: startTag });
    for (const change of rowChanges) {
      if (change.source) {
        splices.push({ start: change.source.el.start, end: change.source.el.end, text: cellXml(sheet, change, strings) });
        continue;
      }
      if (change.value.kind === 'empty') continue;
      const next = sourceCells.find((cell) => (parseRef(cell.attrs.r ?? '')?.col ?? -1) > change.col);
      const at = next ? next.start : row.el.closeStart;
      splices.push({ start: at, end: at, text: cellXml(sheet, change, strings) });
    }
  }
  // Dimension de la feuille : élargie aux nouvelles cellules.
  const dimension = findChild(sheet.root, S, 'dimension');
  const range = dimension ? parseRange(dimension.attrs.ref ?? '') : null;
  const filled = changes.filter((change) => change.value.kind !== 'empty');
  if (dimension && range && filled.length) {
    // Feuille vide : Excel écrit `A1`, qui n'est pas une cellule à garder dans l'étendue.
    const bounds = sheet.cells.size ? { ...range } : { r1: filled[0].row, c1: filled[0].col, r2: filled[0].row, c2: filled[0].col };
    for (const change of filled) {
      bounds.r1 = Math.min(bounds.r1, change.row);
      bounds.c1 = Math.min(bounds.c1, change.col);
      bounds.r2 = Math.max(bounds.r2, change.row);
      bounds.c2 = Math.max(bounds.c2, change.col);
    }
    const from = cellRef(bounds.r1, bounds.c1);
    const to = cellRef(bounds.r2, bounds.c2);
    const ref = from === to ? from : `${from}:${to}`;
    if (ref !== dimension.attrs.ref) {
      const tag = xml.slice(dimension.start, dimension.end).replace(/(\sref\s*=\s*["'])[^"']*(["'])/, `$1${ref}$2`);
      splices.push({ start: dimension.start, end: dimension.end, text: tag });
    }
  }
  return applySplices(xml, splices);
}

// ------------------------------------------------- formules à recalculer

function shift(deps: FormulaDependencies, dRow: number, dCol: number): FormulaDependencies {
  if (deps.kind !== 'ranges') return deps;
  const clamp = (value: number, max: number) => Math.max(0, Math.min(value, max - 1));
  return {
    ...deps,
    ranges: deps.ranges.map((range) => ({
      ...range,
      r1: range.abs.r1 ? range.r1 : clamp(range.r1 + dRow, MAX_ROWS),
      c1: range.abs.c1 ? range.c1 : clamp(range.c1 + dCol, MAX_COLUMNS),
      r2: range.abs.r2 ? range.r2 : clamp(range.r2 + dRow, MAX_ROWS),
      c2: range.abs.c2 ? range.c2 : clamp(range.c2 + dCol, MAX_COLUMNS),
    })),
  };
}

/**
 * Formules qui lisent, directement ou de proche en proche (autres feuilles,
 * noms définis, formules recopiées), une cellule modifiée. Prudent : ce qui ne
 * se déduit pas du texte (INDIRECT, tableaux structurés…) compte comme lu ; une
 * formule liée à un autre classeur garde sa valeur (elle ne se recalcule pas sans lui).
 */
function staleFormulas(workbook: XlsxWorkbook, bySheet: Map<XlsxSheet, Change[]>): Map<XlsxSheet, XlsxCell[]> {
  const dirty = new Map<string, Map<number, Set<number>>>();
  const mark = (sheet: string, row: number, col: number) => {
    const rows = dirty.get(sheet.toLowerCase()) ?? new Map<number, Set<number>>();
    dirty.set(sheet.toLowerCase(), rows);
    const cols = rows.get(row) ?? new Set<number>();
    rows.set(row, cols);
    cols.add(col);
  };
  const changed = new Set<XlsxCell>();
  for (const [sheet, changes] of bySheet) {
    for (const change of changes) {
      mark(sheet.name, change.row, change.col);
      if (change.source) changed.add(change.source);
    }
  }
  const touches = (sheet: string, range: { r1: number; c1: number; r2: number; c2: number }) => {
    const rows = dirty.get(sheet.toLowerCase());
    if (!rows) return false;
    if (range.r2 - range.r1 < rows.size) {
      for (let row = range.r1; row <= range.r2; row++) {
        for (const col of rows.get(row) ?? []) if (col >= range.c1 && col <= range.c2) return true;
      }
      return false;
    }
    for (const [row, cols] of rows) {
      if (row < range.r1 || row > range.r2) continue;
      for (const col of cols) if (col >= range.c1 && col <= range.c2) return true;
    }
    return false;
  };
  const names = workbook.names.map((name) => ({ name: name.name.toLowerCase(), deps: formulaDependencies(name.text), stale: false }));
  const staleNames = new Set<string>();
  const reads = (deps: FormulaDependencies, home: string | null): boolean => {
    if (deps.kind === 'unknown') return true;
    if (deps.kind === 'external') return false;
    return deps.ranges.some((range) => (range.sheet ?? home) === null
      ? workbook.sheets.some((sheet) => touches(sheet.name, range))
      : touches(range.sheet ?? home!, range))
      || deps.names.some((name) => staleNames.has(name.toLowerCase()));
  };
  const nodes: { sheet: XlsxSheet; cell: XlsxCell; deps: FormulaDependencies; stale: boolean }[] = [];
  for (const sheet of workbook.sheets) {
    const masters = new Map<string, { cell: XlsxCell; deps: FormulaDependencies }>();
    const cells = [...sheet.cells.values()].filter((cell) => cell.f && !changed.has(cell) && cell.f.type !== 'dataTable');
    for (const cell of cells) {
      if (cell.f!.type === 'shared' && cell.f!.text && cell.f!.si !== null) masters.set(cell.f!.si, { cell, deps: formulaDependencies(cell.f!.text) });
    }
    for (const cell of cells) {
      const { f } = cell;
      let deps: FormulaDependencies = { kind: 'unknown' };
      if (f!.text) deps = formulaDependencies(f!.text);
      else if (f!.type === 'shared' && f!.si !== null && masters.has(f!.si)) {
        const master = masters.get(f!.si)!;
        deps = shift(master.deps, cell.row - master.cell.row, cell.col - master.cell.col);
      }
      if (deps.kind !== 'external') nodes.push({ sheet, cell, deps, stale: false });
    }
  }
  for (let round = 0, progress = true; progress; round++) {
    progress = false;
    for (const name of names) {
      if (!name.stale && reads(name.deps, null)) {
        name.stale = true;
        staleNames.add(name.name);
        progress = true;
      }
    }
    for (const node of nodes) {
      // Garde-fou contre une chaîne interminable : au-delà, tout est recalculé.
      if (!node.stale && (round > 200 || reads(node.deps, node.sheet.name))) {
        node.stale = true;
        mark(node.sheet.name, node.cell.row, node.cell.col);
        progress = true;
      }
    }
  }
  const out = new Map<XlsxSheet, XlsxCell[]>();
  for (const node of nodes) {
    if (!node.stale || !findChild(node.cell.el, S, 'v')) continue;
    out.set(node.sheet, [...(out.get(node.sheet) ?? []), node.cell]);
  }
  return out;
}

/** `fullCalcOnLoad="1"` : Excel recalcule toutes les formules à l'ouverture (nos valeurs ont changé). */
function requestRecalculation(workbook: XlsxWorkbook): string {
  const { workbookXml: xml, workbookRoot: root } = workbook;
  const calcPr = findChild(root, S, 'calcPr');
  if (calcPr) {
    const tag = xml.slice(calcPr.start, calcPr.openEnd);
    const next = /\sfullCalcOnLoad\s*=/.test(tag)
      ? tag.replace(/(\sfullCalcOnLoad\s*=\s*["'])[^"']*(["'])/, '$11$2')
      : tag.replace(/(\s*\/?>)$/, ' fullCalcOnLoad="1"$1');
    return xml.slice(0, calcPr.start) + next + xml.slice(calcPr.openEnd);
  }
  // Pas de `<calcPr>` : il se place après `definedNames` (ordre du schéma).
  const before = ['fileVersion', 'fileSharing', 'workbookPr', 'workbookProtection', 'bookViews', 'sheets', 'functionGroups', 'externalReferences', 'definedNames'];
  const anchor = elements(root).filter((child) => child.ns === S && before.includes(child.local)).pop();
  const p = root.name.includes(':') ? root.name.slice(0, root.name.indexOf(':') + 1) : '';
  const at = anchor ? anchor.end : root.openEnd;
  return xml.slice(0, at) + `<${p}calcPr fullCalcOnLoad="1"/>` + xml.slice(at);
}

/** Retire une relation (par sa cible) d'un fichier `.rels`, sans toucher au reste. */
function withoutRelationship(xml: string, target: (value: string) => boolean): string {
  const root = scanXml(xml);
  const rel = elements(root).find((child) => child.local === 'Relationship' && target(child.attrs.Target ?? ''));
  return rel ? xml.slice(0, rel.start) + xml.slice(rel.end) : xml;
}

/** Réécrit le .xlsx d'origine avec les cellules modifiées. Rien de modifié : les octets d'origine. */
export async function writeXlsx(bytes: Uint8Array, edits: XlsxEdits, { author, now = new Date() }: { author: string; now?: Date }): Promise<Uint8Array> {
  const workbook = await readXlsxWorkbook(bytes);
  if (workbook.readOnly) throw new FormatError(workbook.readOnly);
  const { problems, bySheet } = plan(workbook, edits);
  if (problems.length) throw new FormatError(problems.join('\n'));
  if (!bySheet.size) return bytes;
  const encoder = new TextEncoder();
  const zipEdits = new Map<string, Uint8Array | null>();
  const strings = new StringTable(workbook.sst);
  let formulas = false;
  const stale = staleFormulas(workbook, bySheet);
  for (const sheet of new Set([...bySheet.keys(), ...stale.keys()])) {
    const changes = bySheet.get(sheet) ?? [];
    if (changes.some((change) => change.value.kind === 'formula' || change.source?.formula)) formulas = true;
    zipEdits.set(sheet.part!, encoder.encode(patchSheet(sheet, changes, strings, stale.get(sheet) ?? [])));
  }
  const sst = strings.xml();
  if (sst !== null) zipEdits.set(workbook.sst.part!, encoder.encode(sst));
  const workbookXml = requestRecalculation(workbook);
  // Une formule remplacée ou ajoutée : la chaîne de calcul d'Excel ne correspond plus.
  // Excel la refait seul ; la garder ferait proposer une « réparation ».
  if (formulas && workbook.calcChainPart && workbook.archive.byName.has(workbook.calcChainPart)) {
    const part = workbook.calcChainPart;
    zipEdits.set(part, null);
    const relsPath = partRelsPath(workbook.mainPart);
    const rels = await readZipText(workbook.archive, relsPath);
    if (rels) zipEdits.set(relsPath, encoder.encode(withoutRelationship(rels, (target) => resolveTarget(workbook.mainPart, target) === part)));
    const types = await readZipText(workbook.archive, '[Content_Types].xml');
    if (types) {
      const root = scanXml(types);
      const override = elements(root).find((child) => child.local === 'Override' && child.attrs.PartName === `/${part}`);
      if (override) zipEdits.set('[Content_Types].xml', encoder.encode(types.slice(0, override.start) + types.slice(override.end)));
    }
  }
  zipEdits.set(workbook.mainPart, encoder.encode(workbookXml));
  if (workbook.corePart) {
    const core = await readZipText(workbook.archive, workbook.corePart);
    if (core) zipEdits.set(workbook.corePart, encoder.encode(patchCoreProperties(core, author, now)));
  }
  const decoder = new TextDecoder();
  for (const [part, data] of zipEdits) {
    if (data && !isWellFormed(decoder.decode(data))) throw new FormatError(`WorkLogs a produit un classeur invalide (${part}) : rien n’est envoyé. Signale-le.`);
  }
  return writeZip(workbook.archive, zipEdits);
}
