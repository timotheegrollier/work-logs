/**
 * Formules tapées dans une cellule. Excel les **enregistre en anglais**
 * (`SUM(A1:A3,2.5)`) et les **affiche en français** (`SOMME(A1:A3;2,5)`).
 * WorkLogs ne calcule rien — Excel recalcule à l'ouverture — mais il vérifie la
 * syntaxe avant d'écrire : une formule mal formée dans le fichier ferait
 * proposer à Excel de « réparer » le classeur. On accepte les deux écritures ;
 * les fonctions courantes sont traduites, les autres gardent leur nom.
 */

export class FormulaError extends Error {}

const FR_TO_EN: Record<string, string> = {
  SOMME: 'SUM', MOYENNE: 'AVERAGE', SI: 'IF', 'SI.CONDITIONS': 'IFS', SIERREUR: 'IFERROR', 'SI.NON.DISP': 'IFNA',
  NB: 'COUNT', NBVAL: 'COUNTA', 'NB.VIDE': 'COUNTBLANK', 'NB.SI': 'COUNTIF', 'NB.SI.ENS': 'COUNTIFS',
  'SOMME.SI': 'SUMIF', 'SOMME.SI.ENS': 'SUMIFS', 'MOYENNE.SI': 'AVERAGEIF', 'MOYENNE.SI.ENS': 'AVERAGEIFS',
  'MAX.SI.ENS': 'MAXIFS', 'MIN.SI.ENS': 'MINIFS', SOMMEPROD: 'SUMPRODUCT', PRODUIT: 'PRODUCT',
  ARRONDI: 'ROUND', 'ARRONDI.SUP': 'ROUNDUP', 'ARRONDI.INF': 'ROUNDDOWN', ENT: 'INT', TRONQUE: 'TRUNC',
  PLAFOND: 'CEILING', PLANCHER: 'FLOOR', PUISSANCE: 'POWER', RACINE: 'SQRT', SIGNE: 'SIGN', ALEA: 'RAND',
  'ALEA.ENTRE.BORNES': 'RANDBETWEEN', MEDIANE: 'MEDIAN', ECARTYPE: 'STDEV', 'GRANDE.VALEUR': 'LARGE',
  'PETITE.VALEUR': 'SMALL', RANG: 'RANK', 'SOUS.TOTAL': 'SUBTOTAL',
  AUJOURDHUI: 'TODAY', MAINTENANT: 'NOW', ANNEE: 'YEAR', MOIS: 'MONTH', JOUR: 'DAY', HEURE: 'HOUR', SECONDE: 'SECOND',
  TEMPS: 'TIME', JOURSEM: 'WEEKDAY', 'NO.SEMAINE': 'WEEKNUM', 'NO.SEMAINE.ISO': 'ISOWEEKNUM', 'FIN.MOIS': 'EOMONTH',
  'MOIS.DECALER': 'EDATE', 'NB.JOURS.OUVRES': 'NETWORKDAYS', 'SERIE.JOUR.OUVRE': 'WORKDAY', JOURS: 'DAYS',
  DATEVAL: 'DATEVALUE', TEMPSVAL: 'TIMEVALUE',
  CONCATENER: 'CONCATENATE', JOINDRE: 'TEXTJOIN', GAUCHE: 'LEFT', DROITE: 'RIGHT', STXT: 'MID', NBCAR: 'LEN',
  MAJUSCULE: 'UPPER', MINUSCULE: 'LOWER', NOMPROPRE: 'PROPER', SUPPRESPACE: 'TRIM', EPURAGE: 'CLEAN', TEXTE: 'TEXT',
  CNUM: 'VALUE', CHERCHE: 'SEARCH', TROUVE: 'FIND', SUBSTITUE: 'SUBSTITUTE', REMPLACER: 'REPLACE', EXACT: 'EXACT',
  CAR: 'CHAR', CTXT: 'FIXED',
  RECHERCHEV: 'VLOOKUP', RECHERCHEH: 'HLOOKUP', RECHERCHEX: 'XLOOKUP', RECHERCHE: 'LOOKUP', EQUIV: 'MATCH',
  EQUIVX: 'XMATCH', DECALER: 'OFFSET', LIGNE: 'ROW', COLONNE: 'COLUMN', LIGNES: 'ROWS', COLONNES: 'COLUMNS', CHOISIR: 'CHOOSE',
  ET: 'AND', OU: 'OR', NON: 'NOT', OUX: 'XOR',
  ESTVIDE: 'ISBLANK', ESTERREUR: 'ISERROR', ESTERR: 'ISERR', ESTNUM: 'ISNUMBER', ESTTEXTE: 'ISTEXT', ESTNA: 'ISNA',
  ESTLOGIQUE: 'ISLOGICAL', 'EST.PAIR': 'ISEVEN', 'EST.IMPAIR': 'ISODD',
};
const EN_TO_FR = Object.fromEntries(Object.entries(FR_TO_EN).map(([fr, en]) => [en, fr]));

/** Fonctions arrivées après Excel 2007 : le fichier les écrit avec le préfixe `_xlfn.`. */
const FUTURE = new Set(['CONCAT', 'TEXTJOIN', 'IFS', 'SWITCH', 'MAXIFS', 'MINIFS', 'IFNA', 'XLOOKUP', 'XMATCH', 'DAYS', 'ISOWEEKNUM']);

const ERRORS = ['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#GETTING_DATA', '#SPILL!', '#CALC!'];
const ERRORS_FR: Record<string, string> = { '#NUL!': '#NULL!', '#VALEUR!': '#VALUE!', '#NOM?': '#NAME?', '#NOMBRE!': '#NUM!', '#PROPAGATION!': '#SPILL!' };
const ERRORS_TO_FR = Object.fromEntries(Object.entries(ERRORS_FR).map(([fr, en]) => [en, fr]));

type Kind = 'number' | 'string' | 'bool' | 'error' | 'ref' | 'name' | 'func' | 'op' | 'sep' | 'open' | 'close' | 'arrayOpen' | 'arrayClose' | 'arrayRow' | 'percent';
interface Token { kind: Kind; text: string; space: string }

const MAX_COLUMN = 16384;
const MAX_ROW = 1048576;

function columnNumber(letters: string): number {
  let n = 0;
  for (const char of letters.toUpperCase()) n = n * 26 + char.charCodeAt(0) - 64;
  return n;
}

const CELL = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})(?![\w(.[!])/;
const COLUMNS = /^\$?([A-Za-z]{1,3}):\$?([A-Za-z]{1,3})(?![\w(.[!])/;
const ROWS = /^\$?(\d{1,7}):\$?(\d{1,7})(?![\w(.[!])/;
const WORD = /^[A-Za-z_\\À-ɏ][\w.\\À-ɏ]*/;

/** Une référence (A1, $B$2, A:C, 3:5) à cette position, bornes d'Excel comprises. */
function matchReference(rest: string): string | null {
  const cell = CELL.exec(rest);
  if (cell && columnNumber(cell[1]) <= MAX_COLUMN && Number(cell[2]) >= 1 && Number(cell[2]) <= MAX_ROW) return cell[0];
  const columns = COLUMNS.exec(rest);
  if (columns && columnNumber(columns[1]) <= MAX_COLUMN && columnNumber(columns[2]) <= MAX_COLUMN) return columns[0];
  const rows = ROWS.exec(rest);
  if (rows && Number(rows[1]) >= 1 && Number(rows[2]) <= MAX_ROW) return rows[0];
  return null;
}

/** `Table1[Colonne]`, `[@Colonne]`, `Table1[[#En-têtes],[Col]]` : crochets équilibrés. */
function bracketEnd(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "'" && i + 1 < text.length) { i++; continue; }
    if (text[i] === '[') depth++;
    else if (text[i] === ']' && --depth === 0) return i + 1;
  }
  throw new FormulaError('crochet non refermé');
}

function tokenize(text: string, french: boolean): Token[] {
  const tokens: Token[] = [];
  let space = '';
  let arrayDepth = 0;
  let i = 0;
  const push = (kind: Kind, value: string, length: number) => {
    tokens.push({ kind, text: value, space });
    space = '';
    i += length;
  };
  while (i < text.length) {
    const rest = text.slice(i);
    const char = text[i];
    if (/\s/.test(char)) { space += char; i++; continue; }
    if (char === '"') {
      let j = i + 1;
      for (;;) {
        const close = text.indexOf('"', j);
        if (close === -1) throw new FormulaError('guillemet non refermé');
        if (text[close + 1] === '"') { j = close + 2; continue; }
        j = close + 1;
        break;
      }
      push('string', text.slice(i, j), j - i);
      continue;
    }
    if (char === '#') {
      const upper = rest.toUpperCase();
      const code = ERRORS.find((error) => upper.startsWith(error)) ?? Object.keys(ERRORS_FR).find((error) => upper.startsWith(error));
      if (!code) throw new FormulaError(`valeur d’erreur inconnue « ${rest.slice(0, 8)} »`);
      push('error', ERRORS_FR[code] ?? code, code.length);
      continue;
    }
    // Feuille : `Feuil1!A1`, `'Mes chiffres'!A1:B2`.
    let sheet = '';
    if (char === "'") {
      let j = i + 1;
      for (;;) {
        const close = text.indexOf("'", j);
        if (close === -1) throw new FormulaError('apostrophe non refermée');
        if (text[close + 1] === "'") { j = close + 2; continue; }
        j = close + 1;
        break;
      }
      if (text[j] !== '!') throw new FormulaError('nom de feuille sans « ! »');
      sheet = text.slice(i, j + 1);
    } else {
      const prefixed = /^[A-Za-z_À-ɏ][\w.À-ɏ]*!/.exec(rest);
      if (prefixed) sheet = prefixed[0];
    }
    if (sheet) {
      const after = text.slice(i + sheet.length);
      const reference = matchReference(after) ?? (after.toUpperCase().startsWith('#REF!') ? '#REF!' : null);
      if (!reference) throw new FormulaError(`référence attendue après « ${sheet} »`);
      push('ref', sheet + reference, sheet.length + reference.length);
      continue;
    }
    const reference = matchReference(rest);
    if (reference) { push('ref', reference, reference.length); continue; }
    const number = (french ? /^\d+(?:,\d+)?(?:[eE][+-]?\d+)?/ : /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/).exec(rest);
    if (number) { push('number', number[0].replace(',', '.'), number[0].length); continue; }
    const word = WORD.exec(rest);
    if (word) {
      const next = text[i + word[0].length];
      if (next === '[') {
        const end = bracketEnd(text, i + word[0].length);
        push('ref', text.slice(i, end), end - i);
      } else if (next === '(') {
        push('func', word[0], word[0].length);
      } else if (/^(TRUE|FALSE)$/i.test(word[0]) || (french && /^(VRAI|FAUX)$/i.test(word[0]))) {
        push('bool', /^(TRUE|VRAI)$/i.test(word[0]) ? 'TRUE' : 'FALSE', word[0].length);
      } else {
        push('name', word[0], word[0].length);
      }
      continue;
    }
    if (char === '[') {
      const end = bracketEnd(text, i);
      push('ref', text.slice(i, end), end - i);
      continue;
    }
    const two = rest.slice(0, 2);
    if (two === '<>' || two === '<=' || two === '>=') { push('op', two, 2); continue; }
    if ('+-*/^&=<>:'.includes(char)) { push('op', char, 1); continue; }
    if (char === '%') { push('percent', '%', 1); continue; }
    if (char === '(') { push('open', '(', 1); continue; }
    if (char === ')') { push('close', ')', 1); continue; }
    if (char === '{') {
      if (french) throw new FormulaError('constantes de tableau {…} : écris la formule en syntaxe anglaise');
      arrayDepth++;
      push('arrayOpen', '{', 1);
      continue;
    }
    if (char === '}') { arrayDepth--; push('arrayClose', '}', 1); continue; }
    if (arrayDepth > 0 && (char === ',' || char === ';')) { push(char === ';' ? 'arrayRow' : 'sep', char, 1); continue; }
    if (char === (french ? ';' : ',')) { push('sep', ',', 1); continue; }
    throw new FormulaError(`caractère inattendu « ${char} »`);
  }
  if (space) tokens.push({ kind: 'op', text: '', space });
  return tokens.filter((token) => token.text !== '' || token.space);
}

/** Vérifie la grammaire d'Excel (expressions, appels, plages, constantes de tableau). */
function validate(tokens: Token[]) {
  const list = tokens.filter((token) => token.text !== '');
  let at = 0;
  const peek = () => list[at];
  const take = () => list[at++];
  const fail = (message: string): never => { throw new FormulaError(message); };
  const isOp = (...ops: string[]) => peek()?.kind === 'op' && ops.includes(peek()!.text);

  const constant = () => {
    if (isOp('-', '+')) take();
    const token = take();
    if (!token || !['number', 'string', 'bool', 'error'].includes(token.kind)) fail('constante de tableau attendue');
  };
  const primary = (): void => {
    const token = take();
    if (!token) return fail('formule incomplète');
    switch (token.kind) {
      case 'number': case 'string': case 'bool': case 'error': case 'ref': case 'name':
        return;
      case 'func': {
        if (take()?.kind !== 'open') fail('parenthèse attendue');
        if (peek()?.kind === 'close') { take(); return; }
        for (;;) {
          if (peek()?.kind !== 'sep' && peek()?.kind !== 'close') expression();
          const next = take();
          if (next?.kind === 'close') return;
          if (next?.kind !== 'sep') fail(`parenthèse manquante après les arguments de ${token.text}`);
        }
      }
      case 'open':
        expression();
        if (take()?.kind !== 'close') fail('parenthèse non refermée');
        return;
      case 'arrayOpen':
        for (;;) {
          constant();
          const next = take();
          if (next?.kind === 'arrayClose') return;
          if (next?.kind !== 'sep' && next?.kind !== 'arrayRow') fail('constante de tableau mal formée');
        }
      default:
        return fail(token.text === ')' ? 'parenthèse fermante en trop' : token.kind === 'sep' ? 'séparateur inattendu' : `« ${token.text} » inattendu`);
    }
  };
  const range = () => {
    primary();
    while (isOp(':')) { take(); primary(); }
    while (peek()?.kind === 'percent') take();
  };
  const unary = (): void => {
    if (isOp('+', '-')) { take(); unary(); return; }
    range();
  };
  const levels = [['^'], ['*', '/'], ['+', '-'], ['&'], ['=', '<>', '<', '>', '<=', '>=']];
  const binary = (level: number): void => {
    const next = () => (level === 0 ? unary() : binary(level - 1));
    next();
    while (isOp(...levels[level])) { take(); next(); }
  };
  const expression = () => binary(levels.length - 1);

  if (!list.length) fail('formule vide');
  expression();
  if (at < list.length) fail(list[at].kind === 'close' ? 'parenthèse fermante en trop' : list[at].kind === 'sep' ? 'séparateur hors d’une fonction' : `« ${list[at].text} » inattendu`);
}

const outsideStrings = (text: string) => text.replace(/"(?:[^"]|"")*"?/g, '""').replace(/'(?:[^']|'')*'?!/g, "''!");

/** La formule semble écrite en français (`;`, fonctions traduites). */
function looksFrench(text: string): boolean {
  const bare = outsideStrings(text);
  if (bare.includes(';') && !bare.includes('{')) return true;
  return [...bare.matchAll(/([A-Za-z_À-ɏ][\w.À-ɏ]*)\s*\(/g)].some((match) => {
    const name = match[1].toUpperCase();
    return name in FR_TO_EN && FR_TO_EN[name] !== name;
  });
}

function render(tokens: Token[], french: boolean): string {
  return tokens.map((token) => {
    let text = token.text;
    if (token.kind === 'func') {
      const upper = text.toUpperCase();
      if (french) {
        const english = FR_TO_EN[upper] ?? upper;
        text = FUTURE.has(english) ? `_xlfn.${english}` : FR_TO_EN[upper] ? english : text;
      } else if (FUTURE.has(upper)) {
        text = `_xlfn.${upper}`;
      }
    }
    return token.space + text;
  }).join('');
}

/**
 * Formule tapée (sans le `=`), en français ou en anglais → formule à enregistrer
 * (anglais, préfixes `_xlfn.`). Erreur de syntaxe : `FormulaError` en clair.
 */
export function normalizeFormula(input: string): string {
  const attempt = (french: boolean) => {
    const tokens = tokenize(input, french);
    validate(tokens);
    return render(tokens, french).trim();
  };
  if (looksFrench(input)) return attempt(true);
  try {
    return attempt(false);
  } catch (english) {
    try {
      return attempt(true);
    } catch {
      throw english;
    }
  }
}

/** Formule enregistrée → telle qu'Excel l'affiche en français. Illisible : telle quelle. */
export function formulaToFrench(stored: string): string {
  if (stored.includes('{')) return stored;
  try {
    const tokens = tokenize(stored, false);
    return tokens.map((token) => {
      let text = token.text;
      if (token.kind === 'func') {
        const english = text.toUpperCase().replace(/^_XLFN\./, '');
        text = EN_TO_FR[english] ?? (text.toUpperCase().startsWith('_XLFN.') ? english : text);
      } else if (token.kind === 'sep') text = ';';
      else if (token.kind === 'number') text = text.replace('.', ',');
      else if (token.kind === 'bool') text = text === 'TRUE' ? 'VRAI' : 'FAUX';
      else if (token.kind === 'error') text = ERRORS_TO_FR[text] ?? text;
      return token.space + text;
    }).join('');
  } catch {
    return stored;
  }
}

// ------------------------------------------------------------ dépendances

export interface FormulaRange {
  /** Feuille nommée dans la formule, sinon `null` (la feuille de la cellule). */
  sheet: string | null;
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  /** `$` devant chaque bord : un bord absolu ne se décale pas quand la formule est recopiée. */
  abs: { r1: boolean; c1: boolean; r2: boolean; c2: boolean };
}

export type FormulaDependencies =
  | { kind: 'ranges'; ranges: FormulaRange[]; names: string[] }
  /** Ce qu'elle lit ne se déduit pas du texte (INDIRECT, DECALER, tableaux structurés…). */
  | { kind: 'unknown' }
  /** Liée à un autre classeur : sa valeur ne se recalcule pas sans lui. */
  | { kind: 'external' };

const INDIRECT = new Set(['INDIRECT', 'OFFSET', 'CELL', 'INFO']);

function endpoint(text: string) {
  const cell = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/.exec(text);
  if (cell) return { row: Number(cell[4]) - 1, col: columnNumber(cell[2]) - 1, absRow: cell[3] === '$', absCol: cell[1] === '$' };
  return null;
}

/** Une référence écrite (`'Feuil 1'!$A$1`, `A:C`, `3:5`) en plage. */
function rangeOf(text: string): FormulaRange | null {
  let sheet: string | null = null;
  let ref = text;
  const bang = text.lastIndexOf('!');
  if (bang !== -1) {
    const raw = text.slice(0, bang);
    sheet = raw.startsWith("'") ? raw.slice(1, -1).replace(/''/g, "'") : raw;
    ref = text.slice(bang + 1);
  }
  const columns = /^(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})$/.exec(ref);
  if (columns) {
    return { sheet, r1: 0, c1: columnNumber(columns[2]) - 1, r2: MAX_ROW - 1, c2: columnNumber(columns[4]) - 1, abs: { r1: true, c1: columns[1] === '$', r2: true, c2: columns[3] === '$' } };
  }
  const rows = /^(\$?)(\d+):(\$?)(\d+)$/.exec(ref);
  if (rows) {
    return { sheet, r1: Number(rows[2]) - 1, c1: 0, r2: Number(rows[4]) - 1, c2: MAX_COLUMN - 1, abs: { r1: rows[1] === '$', c1: true, r2: rows[3] === '$', c2: true } };
  }
  const single = endpoint(ref);
  if (!single) return null;
  return { sheet, r1: single.row, c1: single.col, r2: single.row, c2: single.col, abs: { r1: single.absRow, c1: single.absCol, r2: single.absRow, c2: single.absCol } };
}

/** Les plages et noms qu'une formule enregistrée (anglais) lit. */
export function formulaDependencies(stored: string): FormulaDependencies {
  if (/\[\d+\]/.test(outsideStrings(stored))) return { kind: 'external' };
  let tokens: Token[];
  try {
    tokens = tokenize(stored, false).filter((token) => token.text !== '');
  } catch {
    return { kind: 'unknown' };
  }
  const ranges: FormulaRange[] = [];
  const names: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === 'func' && INDIRECT.has(token.text.toUpperCase().replace(/^_XLFN\./, ''))) return { kind: 'unknown' };
    if (token.kind === 'name') names.push(token.text);
    if (token.kind !== 'ref') continue;
    if (token.text.includes('[') || /#REF!$/i.test(token.text)) {
      if (token.text.includes('[')) return { kind: 'unknown' };
      continue;
    }
    const range = rangeOf(token.text);
    if (!range) return { kind: 'unknown' };
    // `A1:B2` : deux jetons reliés par « : », le second hérite de la feuille du premier.
    if (tokens[i + 1]?.kind === 'op' && tokens[i + 1].text === ':' && tokens[i + 2]?.kind === 'ref') {
      const end = rangeOf(tokens[i + 2].text);
      if (!end) return { kind: 'unknown' };
      ranges.push({
        sheet: range.sheet,
        r1: Math.min(range.r1, end.r1), c1: Math.min(range.c1, end.c1), r2: Math.max(range.r2, end.r2), c2: Math.max(range.c2, end.c2),
        abs: { r1: range.abs.r1, c1: range.abs.c1, r2: end.abs.r2, c2: end.abs.c2 },
      });
      i += 2;
      continue;
    }
    ranges.push(range);
  }
  return { kind: 'ranges', ranges, names };
}
