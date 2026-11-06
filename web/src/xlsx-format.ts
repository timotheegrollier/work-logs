/**
 * Formats de nombre d'Excel, affichés **à la française** (virgule décimale,
 * espace des milliers, dates jj/mm/aaaa), et lecture de ce qu'on tape dans une
 * cellule. Volontairement partiel : les formats courants d'un classeur de bureau
 * (nombres, pourcentages, monnaie, dates, heures, texte). Un format inconnu
 * retombe sur « Standard » — l'affichage peut différer d'Excel, jamais la valeur.
 */

/** Formats intégrés d'Excel (identifiants sans `<numFmt>` dans le classeur), vus d'un poste français. */
export const BUILTIN_FORMATS: Record<number, string> = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00',
  5: '#,##0 "€";-#,##0 "€"', 6: '#,##0 "€";[Red]-#,##0 "€"', 7: '#,##0.00 "€";-#,##0.00 "€"', 8: '#,##0.00 "€";[Red]-#,##0.00 "€"',
  9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
  14: 'dd/mm/yyyy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'dd/mm/yyyy h:mm',
  37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)', 39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)',
  45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mm:ss.0', 48: '##0.0E+0', 49: '@',
};

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const MONTHS_SHORT = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const DAYS_SHORT = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];

/** Séparateur des milliers affiché : espace insécable, comme Excel en français. */
export const GROUP = '\u00a0';

const ERRORS_FR: Record<string, string> = {
  '#NAME?': '#NOM?', '#VALUE!': '#VALEUR!', '#NUM!': '#NOMBRE!', '#NULL!': '#NUL!', '#SPILL!': '#PROPAGATION!',
  '#GETTING_DATA': '#CHARGEMENT_DONNEES', '#N/A': '#N/A', '#REF!': '#REF!', '#DIV/0!': '#DIV/0!', '#CALC!': '#CALC!',
};
export const errorLabel = (code: string) => ERRORS_FR[code] ?? code;

// ------------------------------------------------------------------ dates

const DAY_MS = 86400000;
const EPOCH_1900 = Date.UTC(1899, 11, 30);
const EPOCH_1904 = Date.UTC(1904, 0, 1);

/**
 * Numéro de série Excel → date (UTC, heure comprise). Le système 1900 hérite de
 * Lotus un 29 février 1900 qui n'a pas existé : avant le 1er mars, un jour d'écart.
 */
export function serialToDate(serial: number, date1904 = false): Date | null {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2958465) return null;
  const whole = Math.floor(serial);
  const ms = Math.round((serial - whole) * DAY_MS / 1000) * 1000;
  if (date1904) return new Date(EPOCH_1904 + whole * DAY_MS + ms);
  const days = whole < 60 ? whole + 1 : whole;
  return new Date(EPOCH_1900 + days * DAY_MS + ms);
}

export function dateToSerial(date: Date, date1904 = false): number {
  const ms = date.getTime();
  if (date1904) return (ms - EPOCH_1904) / DAY_MS;
  const serial = (ms - EPOCH_1900) / DAY_MS;
  return serial < 61 ? serial - 1 : serial;
}

// ------------------------------------------------------------ format code

/** Découpe en sections (`positif;négatif;zéro;texte`), hors guillemets et crochets. */
function sections(code: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let bracket = false;
  for (let i = 0; i < code.length; i++) {
    const char = code[i];
    if (char === '\\' && !quoted) { current += char + (code[i + 1] ?? ''); i++; continue; }
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === '[') bracket = true;
    else if (!quoted && char === ']') bracket = false;
    if (char === ';' && !quoted && !bracket) { out.push(current); current = ''; continue; }
    current += char;
  }
  out.push(current);
  return out;
}

/** Retire couleurs et conditions, garde `[h]`/`[mm]`/`[ss]`, déplie `[$€-40C]` en `"€"`. */
function cleanSection(raw: string): string {
  return raw.replace(/\[([^\]]*)\]/g, (all, inner: string) => {
    if (/^(h+|m+|s+)$/i.test(inner)) return all;
    if (inner.startsWith('$')) {
      const symbol = inner.slice(1).split('-')[0];
      return symbol ? `"${symbol}"` : '';
    }
    return '';
  });
}

/** Le code hors texte littéral : ce qui décide « date », « nombre » ou « texte ». */
const unquoted = (code: string) => code.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/_./g, '').replace(/\*./g, '');

export function isDateFormat(code: string): boolean {
  if (/^general$/i.test(code.trim())) return false;
  const first = cleanSection(sections(code)[0]);
  return /[dmyhs]/i.test(unquoted(first).replace(/\[(h+|m+|s+)\]/gi, 'h').replace(/(AM\/PM|A\/P)/gi, '').replace(/E[+-]/g, ''));
}

export const isTextFormat = (code: string) => unquoted(sections(code)[0]).trim() === '@';

/** Le format ne montre que l'heure (pas de jour, mois ni année). */
export const isTimeOnly = (code: string) => isDateFormat(code) && !/[dy]/i.test(unquoted(cleanSection(sections(code)[0])));

// -------------------------------------------------------------- nombres

/** « 1234,5 » : la saisie d'un nombre, à la française, sans groupes ni arrondi. */
export function plainNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const text = String(Number(value.toPrecision(15)));
  return text.replace('.', ',').replace(/e([+-])/, 'E$1');
}

/** Format « Standard » d'Excel : au plus 10 chiffres significatifs, notation scientifique au-delà de 11 caractères. */
export function generalNumber(value: number): string {
  if (!Number.isFinite(value)) return '#NOMBRE!';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1e11 || abs < 1e-9) {
    const [mantissa, exponent] = value.toExponential(5).split('e');
    const trimmed = mantissa.replace(/\.?0+$/, '');
    const exp = Number(exponent);
    return `${trimmed.replace('.', ',')}E${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  const digits = Math.max(0, 10 - Math.floor(Math.log10(abs)) - 1);
  return String(Number(value.toFixed(Math.min(digits, 15)))).replace('.', ',');
}

/** Arrondi d'Excel : au plus proche, la moitié en s'éloignant de zéro, sur l'écriture décimale. */
function roundHalfUp(value: number, decimals: number): number {
  const shifted = Number(`${Math.abs(value)}e${decimals}`);
  return Math.sign(value) * Number(`${Math.round(Number(shifted.toPrecision(15)))}e-${decimals}`);
}

function groupDigits(integer: string): string {
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, GROUP);
}

/** Applique une section numérique (`#,##0.00 "€"`, `0%`, `0.00E+00`) à une valeur positive. */
function numberSection(value: number, code: string): string {
  // Littéraux et espacements : on les garde de côté avant d'analyser les chiffres.
  const parts: { literal: boolean; text: string }[] = [];
  for (let i = 0; i < code.length; i++) {
    const char = code[i];
    if (char === '"') {
      const close = code.indexOf('"', i + 1);
      parts.push({ literal: true, text: code.slice(i + 1, close === -1 ? code.length : close) });
      i = close === -1 ? code.length : close;
    } else if (char === '\\') {
      parts.push({ literal: true, text: code[i + 1] ?? '' });
      i++;
    } else if (char === '_') {
      parts.push({ literal: true, text: ' ' });
      i++;
    } else if (char === '*') {
      i++;
    } else if ((char === 'E' || char === 'e') && (code[i + 1] === '+' || code[i + 1] === '-')) {
      parts.push({ literal: false, text: `E${code[i + 1]}` });
      i++;
    } else if ('$-+/():!^&\'~{}<>= '.includes(char) || char === '€') {
      parts.push({ literal: true, text: char });
    } else {
      parts.push({ literal: false, text: char });
    }
  }
  const pattern = parts.filter((part) => !part.literal).map((part) => part.text).join('');
  // Fractions (`# ?/?`) et formats exotiques : « Standard ».
  if (/^general$/i.test(pattern) || parts.some((part) => part.literal && part.text === '/')) return generalNumber(value);
  const percent = (pattern.match(/%/g) ?? []).length;
  let scaled = value * 100 ** percent;
  const exponentMatch = /E([+-])([0#]+)/i.exec(pattern);
  const numberPart = pattern.replace(/%/g, '').replace(/E[+-][0#]+/i, '');
  // Virgules finales (`#,##0,`) : divise par mille chacune.
  const trailing = /,+$/.exec(numberPart.split('.')[0])?.[0].length ?? 0;
  scaled /= 1000 ** trailing;
  const [intPattern, decPattern = ''] = numberPart.split('.');
  const decimals = (decPattern.match(/[0#?]/g) ?? []).length;
  const minDecimals = (decPattern.match(/0/g) ?? []).length;
  const grouping = /[0#?],[0#?]/.test(intPattern);
  const minInt = (intPattern.match(/0/g) ?? []).length;
  let formatted: string;
  if (exponentMatch) {
    const exponent = scaled === 0 ? 0 : Math.floor(Math.log10(Math.abs(scaled)));
    const mantissa = scaled / 10 ** exponent;
    let text = roundHalfUp(mantissa, decimals).toFixed(decimals);
    if (decimals > minDecimals) text = text.replace(/0+$/, '').padEnd(text.indexOf('.') + 1 + minDecimals, '0').replace(/\.$/, '');
    const sign = exponent < 0 ? '-' : exponentMatch[1] === '+' ? '+' : '';
    formatted = `${text.replace('.', ',')}E${sign}${String(Math.abs(exponent)).padStart(exponentMatch[2].length, '0')}`;
  } else {
    let text = roundHalfUp(scaled, decimals).toFixed(decimals);
    let [integer, fraction = ''] = text.split('.');
    if (decimals > minDecimals) fraction = fraction.replace(/0+$/, '').padEnd(minDecimals, '0');
    if (integer === '0' && minInt === 0) integer = '';
    else integer = integer.padStart(minInt, '0');
    if (grouping) integer = groupDigits(integer);
    text = integer + (fraction ? `,${fraction}` : '');
    formatted = text || (decimals ? '' : '0');
  }
  // Recoller les littéraux autour des chiffres, dans l'ordre du code.
  let out = '';
  let placed = false;
  for (const part of parts) {
    if (part.literal) out += part.text;
    else if (part.text === '%') out += '%';
    else if (!placed && /[0#?.,E]/i.test(part.text)) { out += formatted; placed = true; }
  }
  // Une section sans chiffres (`"néant"`) n'affiche que son texte.
  if (!placed && /[0#?]/.test(pattern)) out += formatted;
  return out;
}

/** Applique une section date/heure. */
function dateSection(serial: number, code: string, date1904: boolean): string {
  const date = serialToDate(serial, date1904);
  if (!date) return '#'.repeat(8);
  const tokens = code.match(/"[^"]*"|\\.|\[h+\]|\[m+\]|\[s+\]|y{3,4}|y{1,2}|mmmmm|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|AM\/PM|A\/P|\.0+|./gi) ?? [];
  const ampm = tokens.some((token) => /^(AM\/PM|A\/P)$/i.test(token));
  const out: string[] = [];
  const kinds: string[] = [];
  const hours = date.getUTCHours();
  const totalHours = Math.floor(serial * 24 + 1e-9);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const lower = token.toLowerCase();
    let text = token;
    let kind = '';
    if (token.startsWith('"')) text = token.slice(1, -1);
    else if (token.startsWith('\\')) text = token.slice(1);
    else if (/^\[h+\]$/i.test(token)) { text = String(totalHours).padStart(token.length - 2, '0'); kind = 'h'; }
    else if (/^\[m+\]$/i.test(token)) { text = String(Math.floor(serial * 1440 + 1e-9)).padStart(token.length - 2, '0'); kind = 'm'; }
    else if (/^\[s+\]$/i.test(token)) { text = String(Math.round(serial * 86400)).padStart(token.length - 2, '0'); kind = 's'; }
    else if (lower.length >= 3 && lower[0] === 'y') text = String(date.getUTCFullYear());
    else if (lower[0] === 'y') text = String(date.getUTCFullYear() % 100).padStart(2, '0');
    else if (lower === 'mmmmm') text = MONTHS[date.getUTCMonth()][0].toUpperCase();
    else if (lower === 'mmmm') text = MONTHS[date.getUTCMonth()];
    else if (lower === 'mmm') text = MONTHS_SHORT[date.getUTCMonth()];
    else if (lower === 'mm' || lower === 'm') { text = lower; kind = 'm?'; }
    else if (lower === 'dddd') text = DAYS[date.getUTCDay()];
    else if (lower === 'ddd') text = DAYS_SHORT[date.getUTCDay()];
    else if (lower === 'dd') text = String(date.getUTCDate()).padStart(2, '0');
    else if (lower === 'd') text = String(date.getUTCDate());
    else if (lower === 'hh' || lower === 'h') {
      const value = ampm ? (hours % 12 || 12) : hours;
      text = lower === 'hh' ? String(value).padStart(2, '0') : String(value);
      kind = 'h';
    } else if (lower === 'ss' || lower === 's') {
      text = lower === 'ss' ? String(date.getUTCSeconds()).padStart(2, '0') : String(date.getUTCSeconds());
      kind = 's';
    } else if (lower === 'am/pm') text = hours < 12 ? 'AM' : 'PM';
    else if (lower === 'a/p') text = hours < 12 ? 'A' : 'P';
    else if (/^\.0+$/.test(token)) text = ',' + String(Math.round((serial * 86400 % 1) * 10 ** (token.length - 1))).padStart(token.length - 1, '0');
    out.push(text);
    kinds.push(kind);
  }
  // `m` : minutes juste après une heure ou juste avant des secondes, mois sinon.
  for (let i = 0; i < out.length; i++) {
    if (kinds[i] !== 'm?') continue;
    const before = kinds.slice(0, i).reverse().find((kind) => kind && kind !== '');
    const after = kinds.slice(i + 1).find((kind) => kind && kind !== '');
    const minutes = before === 'h' || after === 's';
    const value = minutes ? date.getUTCMinutes() : date.getUTCMonth() + 1;
    out[i] = out[i] === 'mm' ? String(value).padStart(2, '0') : String(value);
    kinds[i] = minutes ? 'm' : 'M';
  }
  return out.join('');
}

/** Valeur numérique telle qu'Excel l'afficherait avec ce format. */
export function formatNumber(value: number, formatCode: string, date1904 = false): string {
  const raw = sections(formatCode || 'General');
  // Section des négatifs : elle affiche la valeur absolue, à sa façon (« -5 € », « (5) »).
  const index = value < 0 && raw.length >= 2 ? 1 : value === 0 && raw.length >= 3 ? 2 : 0;
  const code = cleanSection(raw[index]);
  if (/^general$/i.test(code.trim()) || !code.trim()) return generalNumber(value);
  if (isDateFormat(code)) return value < 0 ? '#'.repeat(8) : dateSection(value, code, date1904);
  if (unquoted(code).trim() === '@') return generalNumber(value);
  const body = numberSection(Math.abs(value), code);
  return value < 0 && index === 0 && body !== '0' ? `-${body}` : body;
}

/** Texte avec la quatrième section éventuelle (`"Réf. "@`). */
export function formatText(text: string, formatCode: string): string {
  const raw = sections(formatCode || 'General');
  const section = raw.length >= 4 ? raw[3] : raw.length === 1 && raw[0].includes('@') ? raw[0] : null;
  if (!section) return text;
  return section.replace(/"([^"]*)"|\\(.)|_.|\*.|@|([^"\\_*@]+)/g, (_all, quoted?: string, escaped?: string, plain?: string) => {
    if (quoted !== undefined) return quoted;
    if (escaped !== undefined) return escaped;
    if (plain !== undefined) return plain;
    return _all === '@' ? text : _all.startsWith('_') ? ' ' : '';
  });
}

// ---------------------------------------------------------------- saisie

export type ParsedInput =
  | { kind: 'empty' }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'text'; value: string }
  | { kind: 'formula'; value: string };

const SPACES = /[\s\u00a0\u202f]/g;

/** « 1 234,5 », « -12,5 % », « 12,50 € », « 1,5E3 » → nombre ; `null` sinon. */
export function parseFrenchNumber(input: string): number | null {
  let text = input.trim();
  let scale = 1;
  if (text.endsWith('%')) { scale = 0.01; text = text.slice(0, -1).trim(); }
  else if (text.endsWith('€')) text = text.slice(0, -1).trim();
  const compact = text.replace(SPACES, '');
  // Groupes : uniquement par trois, uniquement avec des espaces.
  if (/\s/.test(text.replace(/[\u00a0\u202f]/g, ' ')) && !/^[+-]?\d{1,3}([\s\u00a0\u202f]\d{3})+([,.]\d+)?(E[+-]?\d+)?$/i.test(text)) return null;
  const match = /^([+-]?)(\d*)(?:[,.](\d*))?(?:E([+-]?\d+))?$/i.exec(compact);
  if (!match || (!match[2] && !match[3])) return null;
  const [, sign, integer, fraction = '', exponent] = match;
  // Zéros de tête (« 0123 », un code postal) : c'est du texte.
  if (integer.length > 1 && integer.startsWith('0')) return null;
  // Au-delà de 15 chiffres, Excel arrondit : un numéro (IBAN, carte…) reste du texte.
  if ((integer + fraction).replace(/^0+/, '').length > 15) return null;
  const value = Number(`${sign}${integer || '0'}.${fraction || '0'}${exponent ? `e${exponent}` : ''}`) * scale;
  return Number.isFinite(value) ? Number(value.toPrecision(15)) : null;
}

/** « 05/10/2026 », « 5/10/26 », « 05/10 », « 05/10/2026 14:30 », « 14:30 » → date UTC. */
export function parseFrenchDate(input: string, now = new Date()): Date | null {
  const text = input.trim();
  const match = /^(?:(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?)?\s*(?:(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (!match || (!match[1] && !match[4])) return null;
  const [, day, month, year, hour, minute, second] = match;
  let y = 1899;
  let m = 12;
  let d = 30;
  if (day) {
    d = Number(day);
    m = Number(month);
    y = year ? Number(year) : now.getFullYear();
    if (year?.length === 2) y += y < 30 ? 2000 : 1900;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  }
  const h = hour ? Number(hour) : 0;
  const min = minute ? Number(minute) : 0;
  const s = second ? Number(second) : 0;
  if (h > 23 || min > 59 || s > 59) return null;
  const date = new Date(Date.UTC(y, m - 1, d, h, min, s));
  if (day && date.getUTCDate() !== d) return null;
  return date;
}

/**
 * Ce qu'on tape dans une cellule, lu comme Excel en français le ferait, sans
 * jamais deviner contre l'utilisateur : `'` force le texte, une cellule au format
 * texte garde le texte, les zéros de tête et les longs numéros restent du texte,
 * une date n'est reconnue que dans une cellule déjà au format date.
 */
export function parseInput(input: string, formatCode: string, { date1904 = false, now = new Date() } = {}): ParsedInput {
  if (input === '') return { kind: 'empty' };
  if (input.startsWith("'")) return { kind: 'text', value: input.slice(1) };
  if (isTextFormat(formatCode)) return { kind: 'text', value: input };
  if (input.startsWith('=') && input.length > 1) return { kind: 'formula', value: input.slice(1) };
  const upper = input.trim().toUpperCase();
  if (upper === 'VRAI' || upper === 'FAUX') return { kind: 'boolean', value: upper === 'VRAI' };
  if (isDateFormat(formatCode)) {
    const date = parseFrenchDate(input, now);
    if (date) {
      const serial = dateToSerial(date, date1904);
      // Heure seule (« 14:30 ») : la fraction du jour, sans date.
      return { kind: 'number', value: Number((/^\s*\d{1,2}:/.test(input) ? serial - Math.floor(serial) : serial).toPrecision(15)) };
    }
  }
  const number = parseFrenchNumber(input);
  if (number !== null) return { kind: 'number', value: number };
  return { kind: 'text', value: input };
}

/** La saisie qui redonne cette valeur numérique dans cette cellule (barre de formule). */
export function numberInput(value: number, formatCode: string, date1904 = false): string {
  if (isDateFormat(formatCode)) {
    const date = serialToDate(value, date1904);
    if (date) {
      const pad = (n: number) => String(n).padStart(2, '0');
      const time = date.getUTCHours() || date.getUTCMinutes() || date.getUTCSeconds()
        ? `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}${date.getUTCSeconds() ? `:${pad(date.getUTCSeconds())}` : ''}`
        : '';
      if (value < 1 && isTimeOnly(formatCode)) return time || '00:00';
      const day = `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${date.getUTCFullYear()}`;
      return time ? `${day} ${time}` : day;
    }
  }
  if (/%/.test(unquoted(sections(formatCode)[0] ?? ''))) return `${plainNumber(value * 100)}%`;
  return plainNumber(value);
}
