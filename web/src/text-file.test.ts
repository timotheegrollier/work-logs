import { describe, expect, it } from 'vitest';
import { decodeText, encodeText, encodingProblem } from './text-codec';
import { parseTextFile, serializeTextFile } from './text-file';
import { csvDraft, gridFromCsv, parseCsvFile, serializeCsv, type CsvGridRow } from './csv-file';

const bytes = (text: string) => new TextEncoder().encode(text);
const latin = (text: string) => new Uint8Array([...text].map((char) => char.charCodeAt(0)));
const decode = (data: Uint8Array) => new TextDecoder('windows-1252').decode(data);

describe('encodages', () => {
  it('reconnaît BOM UTF-8, UTF-16, UTF-8 sans BOM et Windows-1252', () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toEqual({ text: 'a', encoding: 'utf-8-bom' });
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x61, 0]))).toEqual({ text: 'a', encoding: 'utf-16le' });
    expect(decodeText(bytes('été'))).toEqual({ text: 'été', encoding: 'utf-8' });
    expect(decodeText(latin('\xe9t\xe9 \x80'))).toEqual({ text: 'été €', encoding: 'windows-1252' });
    expect(decodeText(bytes('abc'), { legacyDefault: true }).encoding).toBe('windows-1252');
  });

  it('Windows-1252 : les 256 octets font l’aller-retour à l’identique', () => {
    const all = new Uint8Array(256).map((_, i) => i);
    expect(encodeText(decode(all), 'windows-1252')).toEqual(all);
  });

  it('refuse un caractère absent de Windows-1252, en le nommant avec sa ligne', () => {
    expect(() => encodeText('ok\nœuf 😀', 'windows-1252')).toThrow(/« 😀 » \(ligne 2\)/);
    expect(encodingProblem('œuf €', 'windows-1252')).toBeNull();
    expect(encodingProblem('😀', 'utf-8')).toBeNull();
  });

  it('UTF-8 (BOM) et UTF-16 se réécrivent avec leur marque', () => {
    expect([...encodeText('a', 'utf-8-bom')]).toEqual([0xef, 0xbb, 0xbf, 0x61]);
    expect([...encodeText('a', 'utf-16le')]).toEqual([0xff, 0xfe, 0x61, 0]);
    expect(decodeText(encodeText('Hélène', 'utf-16be')).text).toBe('Hélène');
  });
});

describe('fichier texte', () => {
  it('sans modification, rend exactement les octets d’origine', () => {
    const original = latin('ligne 1\r\nligne 2\nfin');
    const parsed = parseTextFile(original);
    expect(parsed.text).toBe('ligne 1\nligne 2\nfin');
    expect(serializeTextFile(parsed, parsed.text)).toBe(original);
  });

  it('garde les fins de ligne des lignes intactes, CRLF pour les nouvelles', () => {
    const parsed = parseTextFile(bytes('a\r\nb\r\nc\nd\r\n'));
    const out = new TextDecoder().decode(serializeTextFile(parsed, 'a\nb\nNOUVEAU\nc\nd\n'));
    expect(out).toBe('a\r\nb\r\nNOUVEAU\r\nc\nd\r\n');
  });

  it('respecte l’absence de saut de ligne final', () => {
    const parsed = parseTextFile(bytes('un\ndeux'));
    expect(new TextDecoder().decode(serializeTextFile(parsed, 'un\ndeux\ntrois'))).toBe('un\ndeux\ntrois');
  });
});

describe('CSV', () => {
  const excel = latin('Date;Mesure;Commentaire\r\n05/10/2026;12,5;"pH ; chlore"\r\n06/10/2026;0123;\r\n');

  it('lit un CSV d’Excel français : point-virgule, Windows-1252, CRLF', () => {
    const parsed = parseCsvFile(excel, 'relevés.csv');
    expect(parsed.delimiter).toBe(';');
    expect(parsed.encoding).toBe('windows-1252');
    expect(parsed.eol).toBe('\r\n');
    expect(parsed.records.map((record) => record.fields)).toEqual([
      ['Date', 'Mesure', 'Commentaire'], ['05/10/2026', '12,5', 'pH ; chlore'], ['06/10/2026', '0123', ''],
    ]);
  });

  it('une cellule modifiée ne change qu’une ligne ; les autres restent octet pour octet', () => {
    const parsed = parseCsvFile(excel, 'relevés.csv');
    const rows = gridFromCsv(parsed);
    expect(serializeCsv(parsed, rows)).toBe(excel);
    rows[2] = { ...rows[2], fields: ['06/10/2026', '0123', 'Filtre lavé'] };
    const out = decode(serializeCsv(parsed, rows));
    expect(out).toBe('Date;Mesure;Commentaire\r\n05/10/2026;12,5;"pH ; chlore"\r\n06/10/2026;0123;Filtre lavé\r\n');
  });

  it('met entre guillemets ce qui l’exige, et seulement cela', () => {
    const parsed = parseCsvFile(bytes('a,b\n1,2\n'), 'x.csv');
    expect(parsed.delimiter).toBe(',');
    const rows: CsvGridRow[] = [...gridFromCsv(parsed), { src: null, fields: ['dit "bonjour"', 'x,y'] }];
    expect(new TextDecoder().decode(serializeCsv(parsed, rows, 'utf-8'))).toBe('a,b\n1,2\n"dit ""bonjour""","x,y"\n');
  });

  it('garde la ligne sep=; et lit les retours à la ligne dans une cellule', () => {
    const parsed = parseCsvFile(bytes('sep=;\nNom;Note\n"Dupont";"ligne 1\nligne 2"\n'), 'x.csv');
    expect(parsed.prefix).toBe('sep=;\n');
    expect(parsed.records[1].fields).toEqual(['Dupont', 'ligne 1\nligne 2']);
    const rows = gridFromCsv(parsed);
    rows.push({ src: null, fields: ['Martin', 'ok'] });
    expect(new TextDecoder().decode(serializeCsv(parsed, rows, 'utf-8'))).toBe('sep=;\nNom;Note\n"Dupont";"ligne 1\nligne 2"\nMartin;ok\n');
  });

  it('TSV : la tabulation est imposée par l’extension', () => {
    expect(parseCsvFile(bytes('a;b\tc\n'), 'x.tsv').delimiter).toBe('\t');
  });

  it('brouillon compact : une ligne intacte n’est que son numéro, et il se relit', () => {
    const parsed = parseCsvFile(excel, 'relevés.csv');
    const rows = gridFromCsv(parsed);
    rows[1] = { src: 1, fields: ['05/10/2026', '13', 'pH ; chlore'] };
    const draft = csvDraft(parsed, rows, 'windows-1252');
    expect(draft.rows).toEqual([0, { src: 1, fields: ['05/10/2026', '13', 'pH ; chlore'] }, 2]);
    expect(gridFromCsv(parsed, JSON.parse(JSON.stringify(draft)))).toEqual(rows);
  });
});
