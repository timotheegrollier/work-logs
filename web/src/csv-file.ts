import { decodeText, encodeText, type TextEncodingName } from './text-codec';
import { dominantEol } from './text-file';

/**
 * CSV/TSV du partage. Excel français écrit des `;`, en Windows-1252, avec des
 * fins de ligne CRLF : on détecte tout cela et on le garde. Chaque enregistrement
 * conserve son texte brut — une ligne qu'on n'a pas touchée ressort **à
 * l'identique**, guillemets et espaces compris. Les valeurs ne sont jamais
 * interprétées : `0123` et `12,5` restent ce qu'ils sont.
 */
export interface CsvRecord {
  raw: string;
  eol: string;
  fields: string[];
}

export interface ParsedCsv {
  bytes: Uint8Array;
  encoding: TextEncodingName;
  delimiter: string;
  /** Plus de 90 % des champs entre guillemets : les lignes réécrites suivent ce style. */
  quoteAll: boolean;
  /** Ligne `sep=;` d'Excel, gardée telle quelle en tête. */
  prefix: string;
  records: CsvRecord[];
  finalNewline: boolean;
  eol: string;
}

/** Ligne de la grille : `src` = enregistrement d'origine (null pour une ligne ajoutée). */
export interface CsvGridRow {
  src: number | null;
  fields: string[];
}

/** Brouillon compact : une ligne intacte n'est que son numéro d'origine. */
export interface CsvDraft {
  format: 'csv';
  encoding: TextEncodingName;
  rows: (number | { src: number | null; fields: string[] })[];
}

const CANDIDATES = [';', '\t', ',', '|'];

interface ScanResult {
  records: CsvRecord[];
  quoted: number;
  total: number;
}

/** Lecture tolérante : un guillemet en tête de champ ouvre une citation, ailleurs il est littéral. */
export function scanCsv(text: string, delimiter: string, limit = Infinity): ScanResult {
  const records: CsvRecord[] = [];
  let quoted = 0;
  let total = 0;
  let i = 0;
  const n = text.length;
  while (i < n && records.length < limit) {
    const start = i;
    const fields: string[] = [];
    let field = '';
    let atStart = true;
    let inQuotes = false;
    for (;;) {
      if (i >= n) {
        fields.push(field);
        total++;
        records.push({ raw: text.slice(start, i), eol: '', fields });
        break;
      }
      const char = text[i];
      if (inQuotes) {
        if (char === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i++;
          continue;
        }
        field += char;
        i++;
        continue;
      }
      if (atStart && char === '"') {
        inQuotes = true;
        atStart = false;
        quoted++;
        i++;
        continue;
      }
      if (char === delimiter) {
        fields.push(field);
        total++;
        field = '';
        atStart = true;
        i++;
        continue;
      }
      if (char === '\r' || char === '\n') {
        const eol = char === '\r' && text[i + 1] === '\n' ? '\r\n' : char;
        fields.push(field);
        total++;
        records.push({ raw: text.slice(start, i), eol, fields });
        i += eol.length;
        break;
      }
      field += char;
      atStart = false;
      i++;
    }
  }
  return { records, quoted, total };
}

/** Le séparateur qui donne le nombre de champs le plus régulier (> 1) sur les premières lignes. */
export function detectDelimiter(text: string): string {
  let best = CANDIDATES[0];
  let bestScore = -1;
  for (const candidate of CANDIDATES) {
    const { records } = scanCsv(text.slice(0, 65536), candidate, 20);
    const counts = new Map<number, number>();
    for (const record of records) counts.set(record.fields.length, (counts.get(record.fields.length) ?? 0) + 1);
    let score = 0;
    for (const [fields, count] of counts) if (fields > 1 && count > score) score = count;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

export function parseCsvFile(bytes: Uint8Array, name: string): ParsedCsv {
  const { text, encoding } = decodeText(bytes, { legacyDefault: true });
  let prefix = '';
  let body = text;
  let delimiter = /\.tsv$/i.test(name) ? '\t' : '';
  const sep = /^sep=(.)(\r\n|\r|\n)/i.exec(text);
  if (sep) {
    prefix = sep[0];
    body = text.slice(sep[0].length);
    delimiter = sep[1];
  }
  delimiter ||= detectDelimiter(body);
  const { records, quoted, total } = scanCsv(body, delimiter);
  return {
    bytes,
    encoding,
    delimiter,
    quoteAll: total > 0 && quoted / total >= 0.9,
    prefix,
    records,
    finalNewline: records.length > 0 && records[records.length - 1].eol !== '',
    eol: dominantEol(records),
  };
}

export const sameFields = (a: string[], b: string[]) => a.length === b.length && a.every((value, i) => value === b[i]);

export function gridFromCsv(parsed: ParsedCsv, draft?: unknown): CsvGridRow[] {
  const saved = draft as CsvDraft | undefined;
  if (saved?.format === 'csv' && Array.isArray(saved.rows)) {
    const rows: CsvGridRow[] = [];
    for (const row of saved.rows) {
      if (typeof row === 'number') {
        const record = parsed.records[row];
        if (record) rows.push({ src: row, fields: record.fields.slice() });
      } else if (row && Array.isArray(row.fields)) {
        rows.push({ src: typeof row.src === 'number' && parsed.records[row.src] ? row.src : null, fields: row.fields.map(String) });
      }
    }
    return rows;
  }
  return parsed.records.map((record, src) => ({ src, fields: record.fields.slice() }));
}

export function csvDraft(parsed: ParsedCsv, rows: CsvGridRow[], encoding: TextEncodingName): CsvDraft {
  return {
    format: 'csv',
    encoding,
    rows: rows.map((row) => (row.src !== null && sameFields(row.fields, parsed.records[row.src].fields) ? row.src : { src: row.src, fields: row.fields })),
  };
}

export function isCsvUnchanged(parsed: ParsedCsv, rows: CsvGridRow[]) {
  return rows.length === parsed.records.length && rows.every((row, i) => row.src === i && sameFields(row.fields, parsed.records[i].fields));
}

function quoteField(value: string, delimiter: string, quoteAll: boolean) {
  if (quoteAll || value.includes(delimiter) || /["\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function serializeCsv(parsed: ParsedCsv, rows: CsvGridRow[], encoding: TextEncodingName = parsed.encoding): Uint8Array {
  if (encoding === parsed.encoding && isCsvUnchanged(parsed, rows)) return parsed.bytes;
  let out = parsed.prefix;
  rows.forEach((row, index) => {
    const record = row.src !== null ? parsed.records[row.src] : undefined;
    const untouched = record && sameFields(row.fields, record.fields);
    const text = untouched ? record.raw : row.fields.map((value) => quoteField(value, parsed.delimiter, parsed.quoteAll)).join(parsed.delimiter);
    const eol = (untouched && record.eol) || parsed.eol;
    const last = index === rows.length - 1;
    out += text + (last ? (parsed.finalNewline ? eol : '') : eol);
  });
  return encodeText(out, encoding);
}
