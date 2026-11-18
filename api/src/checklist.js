const listMarker = /^ {0,3}([-+*]|\d{1,9}[.)])([ \t]+|$)/;
const checkbox = /^\[([ xX])\][ \t]+(\S.*)$/;
const fenceMarker = /^( {0,3})(`{3,}(?!`)(?=[^`]*$)|~{3,})/;
const quoteMarker = /^ {0,3}>[ \t]?/;
const thematicBreak = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const htmlBlock = /^ {0,3}<\/?(?:address|article|aside|base|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|nav|ol|optgroup|option|p|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|ul)(?=[\t />]|$)/i;
const htmlEnd = [
  [/^ {0,3}<(pre|script|style|textarea)(?=[\s>]|$)/i, (match) => new RegExp(`</${match[1]}>`, 'i')],
  [/^ {0,3}<!--/, () => /-->/],
  [/^ {0,3}<\?/, () => /\?>/],
  [/^ {0,3}<!\[CDATA\[/, () => /\]\]>/],
  [/^ {0,3}<![A-Z]/, () => />/],
];

/** Repère les marqueurs dans la source sans réécrire le Markdown (indentation, CRLF, etc.). */
function checklistPositions(source) {
  if (!source.includes('[')) return [];
  const items = [];
  /** @type {number[]} 0 = citation, nombre positif = retrait d'une puce. */
  const containers = [];
  let paragraph = false;
  /** @type {{ marker: string; depth: number } | null} */
  let fence = null;
  /** @type {{ end: RegExp | null; depth: number } | null} */
  let html = null;

  lines: for (const line of source.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
    let body = line[0].replace(/[\r\n]+$/, '');
    let extraColumns = 0;
    const indentation = /^[ \t]*/.exec(body)[0];
    if (indentation.includes('\t')) {
      let columns = 0;
      for (const character of indentation) columns += character === '\t' ? 4 - columns % 4 : 1;
      extraColumns = columns - indentation.length;
      body = ' '.repeat(columns) + body.slice(indentation.length);
    }
    let offset = line.index - extraColumns;
    let depth = 0;
    for (const margin of containers) {
      const length = margin === 0 ? quoteMarker.exec(body)?.[0].length
        : body.startsWith(' '.repeat(margin)) ? margin : !body.trim() ? body.length : undefined;
      if (length === undefined) break;
      body = body.slice(length);
      offset += length;
      depth += 1;
    }
    if (depth < containers.length) paragraph = false;
    containers.length = depth;
    if (fence && depth < fence.depth) fence = null;
    if (html && depth < html.depth) html = null;
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(body);
      if (close && close[1][0] === fence.marker[0] && close[1].length >= fence.marker.length) fence = null;
      continue;
    }
    if (html) {
      if (html.end?.test(body) || (!html.end && !body.trim())) html = null;
      continue;
    }

    // Une puce ou une citation peut ouvrir un autre bloc sur la même ligne.
    while (true) {
      const quote = quoteMarker.exec(body);
      if (quote) {
        containers.push(0);
        offset += quote[0].length;
        body = body.slice(quote[0].length);
        paragraph = false;
        continue;
      }
      const marker = listMarker.exec(body);
      if (!marker || thematicBreak.test(body)) break;
      if (paragraph && /^\d/.test(marker[1]) && !/^1[.)]$/.test(marker[1])) break;
      const padding = marker[2].length > 4 ? marker[0].length - marker[2].length + 1 : marker[0].length;
      containers.push(padding);
      offset += padding;
      body = body.slice(padding);
      paragraph = false;
      const box = checkbox.exec(body);
      if (!box) continue;
      items.push({ index: items.length, offset: offset + 1, text: box[2].trimEnd(), checked: /[xX]/.test(box[1]) });
      paragraph = true;
      continue lines;
    }

    const open = fenceMarker.exec(body);
    if (open) {
      fence = { marker: open[2], depth: containers.length };
      paragraph = false;
      continue;
    }
    const rawHtml = htmlEnd.find(([start]) => start.test(body));
    if (rawHtml) {
      const end = rawHtml[1](rawHtml[0].exec(body));
      if (!end.test(body)) html = { end, depth: containers.length };
      paragraph = false;
      continue;
    }
    if (htmlBlock.test(body) || (!paragraph && /^ {0,3}<\/?[a-z][\w-]*(?:\s[^>]*)?\/?>[ \t]*$/i.test(body))) {
      html = { end: null, depth: containers.length };
      paragraph = false;
      continue;
    }
    const setextHeading = paragraph && /^ {0,3}=+ *$/.test(body);
    const indentedCode = !paragraph && /^ {4}/.test(body);
    paragraph = Boolean(body.trim()) && !indentedCode && !setextHeading && !thematicBreak.test(body) && !/^ {0,3}#{1,6}(?:\s|$)/.test(body);
  }
  return items;
}

export function getChecklistItems(source) {
  return checklistPositions(source).map(({ offset, ...item }) => item);
}

/** Part des cases cochées, en pourcentage arrondi, ou null sans checklist. */
export function checklistProgress(source) {
  const items = checklistPositions(source);
  if (!items.length) return null;
  const completed = items.filter(({ checked }) => checked).length;
  return completed === items.length ? 100 : Math.min(99, Math.round(100 * completed / items.length));
}

/** Change seulement le caractère entre crochets des cases ciblées. */
export function updateChecklistItems(source, changes) {
  const requested = new Map(changes.map(({ index, checked }) => [index, checked]));
  const parts = [];
  let start = 0;
  for (const { index, offset, checked } of checklistPositions(source)) {
    if (!requested.has(index) || requested.get(index) === checked) continue;
    parts.push(source.slice(start, offset), requested.get(index) ? 'x' : ' ');
    start = offset + 1;
  }
  return parts.length ? parts.join('') + source.slice(start) : source;
}
