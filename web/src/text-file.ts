import { decodeText, encodeText, type TextEncodingName } from './text-codec';

/**
 * Fichier texte (.txt, .md) : l'éditeur travaille sur des fins de ligne `\n`,
 * le fichier garde les siennes. Les lignes inchangées en tête et en queue
 * reprennent leur fin de ligne d'origine ; les autres prennent la plus fréquente.
 */
export interface ParsedText {
  bytes: Uint8Array;
  encoding: TextEncodingName;
  /** Texte avec des `\n` seulement : ce que montre l'éditeur. */
  text: string;
  /** Lignes d'origine et leur fin de ligne (la dernière n'en a pas). */
  segments: { text: string; eol: string }[];
  eol: string;
}

export interface TextDraft {
  format: 'text';
  text: string;
  encoding: TextEncodingName;
}

export function splitLines(text: string): { text: string; eol: string }[] {
  const segments: { text: string; eol: string }[] = [];
  const pattern = /\r\n|\r|\n/g;
  let start = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    segments.push({ text: text.slice(start, match.index), eol: match[0] });
    start = match.index + match[0].length;
  }
  segments.push({ text: text.slice(start), eol: '' });
  return segments;
}

export function dominantEol(segments: { eol: string }[]): string {
  const counts = new Map<string, number>();
  for (const { eol } of segments) if (eol) counts.set(eol, (counts.get(eol) ?? 0) + 1);
  let best = '\n';
  let bestCount = 0;
  for (const [eol, count] of counts) {
    if (count > bestCount) {
      best = eol;
      bestCount = count;
    }
  }
  return best;
}

export function parseTextFile(bytes: Uint8Array): ParsedText {
  const { text, encoding } = decodeText(bytes);
  const segments = splitLines(text);
  return { bytes, encoding, text: segments.map((segment) => segment.text).join('\n'), segments, eol: dominantEol(segments) };
}

export function serializeTextFile(original: ParsedText, text: string, encoding: TextEncodingName = original.encoding): Uint8Array {
  const lines = text.split('\n');
  const source = original.segments;
  if (encoding === original.encoding && lines.length === source.length && lines.every((line, i) => line === source[i].text)) {
    return original.bytes;
  }
  let prefix = 0;
  while (prefix < lines.length && prefix < source.length && lines[prefix] === source[prefix].text) prefix++;
  let suffix = 0;
  while (suffix < lines.length - prefix && suffix < source.length - prefix
    && lines[lines.length - 1 - suffix] === source[source.length - 1 - suffix].text) suffix++;
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    out += lines[i];
    if (i === lines.length - 1) break;
    let eol = '';
    if (i < prefix) eol = source[i].eol;
    else if (i >= lines.length - suffix) eol = source[source.length - (lines.length - i)].eol;
    out += eol || original.eol;
  }
  return encodeText(out, encoding);
}
