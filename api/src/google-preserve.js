import { buildGoogleUpdate, documentBody, readMarks, textStyle } from './google-document.js';
import { validateDocument } from './rich-document.js';

const fail = (message) => { throw Object.assign(new Error(`${message} Le brouillon local est conservé. Ouvre cet onglet dans Google Docs pour cette modification.`), { status: 422 }); };
const align = { START: 'left', CENTER: 'center', END: 'right', JUSTIFIED: 'justify' };
const alignBack = { left: 'START', center: 'CENTER', right: 'END', justify: 'JUSTIFIED' };
const hasSuggestions = value => value && typeof value === 'object' && Object.entries(value).some(([key, child]) =>
  (key.startsWith('suggested') && child && Object.keys(child).length) || hasSuggestions(child));
const stable = value => JSON.stringify(value, (_key, v) => v && !Array.isArray(v) && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).filter(([, item]) => item !== null && item !== undefined).sort(([a], [b]) => a.localeCompare(b))) : v);

/** Import avec conservation : les éléments propres à Google restent des repères,
 * les paragraphes et cellules restent éditables. Les indices viennent uniquement
 * de la réponse Google courante, jamais des attributs envoyés par le navigateur. */
function read(source) {
  const part = documentBody(source), origins = new WeakMap();
  let object = 0;
  const protectedNode = (type, label, raw, src) => {
    const node = { type, attrs: { googleId: `object-${object++}`, label: label.slice(0, 1000), ...(src && /^https:\/\//.test(src) ? { src } : {}) } };
    origins.set(node, raw);
    return node;
  };
  function blocks(elements) {
    const result = [];
    let cursor = elements?.[0]?.startIndex || 1;
    for (const raw of elements || []) {
      if (raw.sectionBreak && !raw.startIndex) continue;
      const start = raw.startIndex ?? cursor;
      if (raw.paragraph && !hasSuggestions(raw)) {
        const p = raw.paragraph, style = p.paragraphStyle || {}, content = [];
        let index = start;
        for (const [i, run] of (p.elements || []).entries()) {
          const runStart = run.startIndex ?? index;
          index = runStart;
          if (run.textRun) {
            let text = run.textRun.content || '';
            if (i === p.elements.length - 1) text = text.replace(/\n$/, '');
            // Google représente certains widgets par un caractère privé. Il ne
            // doit jamais être réinséré comme du texte (Docs le supprimerait).
            for (const piece of text.split(/([\uE000-\uF8FF\uFFFC])/)) {
              if (!piece) continue;
              if (/^[\uE000-\uF8FF\uFFFC]$/.test(piece)) content.push(protectedNode('googleInline', 'Élément Google', { startIndex: index, endIndex: index + 1 }));
              else content.push({ type: 'text', text: piece, marks: readMarks(run.textRun.textStyle, true) });
              index += piece.length;
            }
            index = run.endIndex ?? runStart + run.textRun.content.length;
          } else {
            const embedded = part.inlineObjects?.[run.inlineObjectElement?.inlineObjectId]?.inlineObjectProperties?.embeddedObject;
            const label = run.richLink?.richLinkProperties?.title || run.person?.personProperties?.name ||
              (run.footnoteReference ? `Note ${run.footnoteReference.footnoteNumber || ''}` : embedded?.title || (run.inlineObjectElement ? 'Image Google' : run.equation ? 'Équation Google' : run.dateElement ? 'Date Google' : 'Élément Google'));
            content.push(protectedNode('googleInline', label, { ...run, startIndex: runStart, endIndex: run.endIndex ?? runStart + 1 }, embedded?.imageProperties?.contentUri));
            index = run.endIndex ?? runStart + 1;
          }
        }
        const heading = /^HEADING_([1-6])$/.exec(style.namedStyleType || '');
        const attrs = { ...(heading ? { level: Number(heading[1]) } : {}), ...(align[style.alignment] ? { textAlign: align[style.alignment] } : {}) };
        if (['TITLE', 'SUBTITLE'].includes(style.namedStyleType)) attrs.googleNamedStyle = style.namedStyleType;
        for (const [google, local] of [['indentStart', 'googleIndentStart'], ['indentEnd', 'googleIndentEnd'], ['indentFirstLine', 'googleIndentFirstLine']]) {
          if (!p.bullet && style[google]?.magnitude) attrs[local] = style[google].magnitude;
        }
        const node = { type: heading ? 'heading' : 'paragraph', ...(Object.keys(attrs).length ? { attrs } : {}), ...(content.length ? { content } : {}) };
        origins.set(node, { ...raw, startIndex: start, endIndex: raw.endIndex ?? index });
        if (p.bullet) {
          const depth = p.bullet.nestingLevel || 0;
          const level = part.lists?.[p.bullet.listId]?.listProperties?.nestingLevels?.[depth];
          const ordered = level?.glyphType && level.glyphType !== 'GLYPH_TYPE_UNSPECIFIED';
          const type = ordered ? 'orderedList' : 'bulletList';
          // Chaque groupe conserve sa profondeur et sa numérotation dans Google.
          // La hiérarchie locale utilise les listes natives de l'éditeur.
          let parent = result;
          for (let d = 0; d < depth; d++) {
            let list = parent.at(-1);
            if (!list || !['orderedList', 'bulletList'].includes(list.type)) {
              list = { type, content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] };
              parent.push(list);
            }
            parent = list.content.at(-1).content;
          }
          let list = parent.at(-1);
          if (list?.type !== type || list._listId !== p.bullet.listId) {
            list = { type, _listId: p.bullet.listId, ...(ordered && level?.startNumber ? { attrs: { start: level.startNumber } } : {}), content: [] };
            parent.push(list);
          }
          list.content.push({ type: 'listItem', content: [node] });
        } else result.push(node);
        cursor = raw.endIndex ?? index;
      } else if (raw.table && !hasSuggestions(raw) && raw.table.tableRows?.length) {
        const table = { type: 'table', content: raw.table.tableRows.map(row => ({ type: 'tableRow', content: (row.tableCells || []).map(cell => ({
          type: 'tableCell', attrs: { colspan: cell.tableCellStyle?.columnSpan || 1, rowspan: cell.tableCellStyle?.rowSpan || 1 }, content: blocks(cell.content),
        })) })) };
        origins.set(table, raw); result.push(table); cursor = raw.endIndex ?? start;
      } else {
        const preview = JSON.stringify(raw).match(/"content":"([^"\\]*)/g)?.map(s => s.slice(11)).join(' ') || '';
        result.push(protectedNode('googleBlock', hasSuggestions(raw) ? `Suggestion Google · ${preview}` : raw.tableOfContents ? 'Table des matières Google' : raw.sectionBreak ? 'Saut de section Google' : 'Bloc Google conservé', raw));
        cursor = raw.endIndex ?? start;
      }
    }
    return result.length ? result : [{ type: 'paragraph' }];
  }
  if (!part.body?.content) fail('Ce document ne contient pas de corps éditable.');
  const document = { type: 'doc', content: blocks(part.body.content) };
  const clean = node => { delete node._listId; node.content?.forEach(clean); };
  clean(document);
  validateDocument(document);
  return { document, origins, part };
}
export const importGoogleDocument = source => read(source).document;
export function googlePreservedCount(document) {
  return (document.type === 'googleInline' || document.type === 'googleBlock' ? 1 : 0) + (document.content || []).reduce((sum, child) => sum + googlePreservedCount(child), 0);
}

/** Petits changements Unicode, pour ne pas supprimer les plages inchangées entre
 * deux corrections. Le calcul quadratique ne porte que sur le milieu modifié. */
export function diff(before, after) {
  const a = Array.from(before), b = Array.from(after);
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix++;
  while (suffix < Math.min(a.length, b.length) - prefix && a[a.length - suffix - 1] === b[b.length - suffix - 1]) suffix++;
  const x = a.slice(prefix, a.length - suffix), y = b.slice(prefix, b.length - suffix);
  const edits = [];
  const add = (kind, text) => { if (!text) return; if (edits.at(-1)?.kind === kind) edits.at(-1).text += text; else edits.push({ kind, text }); };
  add('equal', a.slice(0, prefix).join(''));
  if (!x.length || !y.length || x.length * y.length > 1_000_000) { add('delete', x.join('')); add('insert', y.join('')); }
  else {
    const rows = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) rows[i][j] = x[i] === y[j] ? 1 + rows[i + 1][j + 1] : Math.max(rows[i + 1][j], rows[i][j + 1]);
    let i = 0, j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) { add('equal', x[i++]); j++; }
      else if (j < y.length && (i === x.length || rows[i][j + 1] >= rows[i + 1][j])) add('insert', y[j++]);
      else add('delete', x[i++]);
    }
  }
  add('equal', suffix ? a.slice(-suffix).join('') : '');
  return edits;
}

const paragraphs = (nodes, list = null, depth = -1) => nodes.flatMap(node => {
  if (['bulletList', 'orderedList'].includes(node.type)) return paragraphs(node.content || [], { type: node.type, depth: depth + 1, start: node.attrs?.start ?? 1 }, depth + 1);
  if (node.type === 'listItem') return paragraphs(node.content || [], list, depth);
  return [{ node, list }];
});
const chars = nodes => (nodes || []).flatMap(node => {
  if (node.type === 'text') return Array.from(node.text, char => ({ char, style: textStyle(node.marks) }));
  if (node.type === 'hardBreak') return [{ char: '\n', style: {} }];
  fail('Cet élément ajouté ne peut pas encore être envoyé à Google.');
});

/** Patch du texte et des seuls styles modifiés. Tables/objets/ancres et styles
 * Google non représentés ne sont jamais effacés par un reset de l'onglet. */
export function buildPreservingUpdate(source, document) {
  validateDocument(document);
  if (!source.revisionId) throw Object.assign(new Error('Révision Google absente : écriture refusée.'), { status: 409 });
  const { document: original, origins, part } = read(source);
  const jobs = [];
  const range = (startIndex, endIndex) => ({ startIndex, endIndex, ...(part.tabId ? { tabId: part.tabId } : {}) });
  const location = index => ({ index, ...(part.tabId ? { tabId: part.tabId } : {}) });
  function textJob(oldNodes, newNodes, start) {
    const a = chars(oldNodes), b = chars(newNodes), oldText = a.map(c => c.char).join(''), newText = b.map(c => c.char).join('');
    const operations = diff(oldText, newText), edits = [], styles = [];
    let oldOffset = 0, newOffset = 0, ai = 0, bi = 0;
    const styleAt = (before, after, offset, length, inserted) => {
      const fields = Object.keys({ ...before, ...after }).filter(key => inserted || stable(before[key]) !== stable(after[key]));
      if (inserted) for (const key of ['bold', 'italic', 'underline', 'strikethrough', 'foregroundColor', 'backgroundColor', 'weightedFontFamily', 'fontSize', 'link', 'baselineOffset']) if (!fields.includes(key)) fields.push(key);
      if (!fields.length) return;
      const value = Object.fromEntries(fields.filter(key => after[key] !== undefined).map(key => [key, after[key]]));
      const last = styles.at(-1);
      if (last && last.end === offset && stable(last.value) === stable(value) && last.fields === fields.join(',')) last.end += length;
      else styles.push({ start: offset, end: offset + length, value, fields: fields.join(',') });
    };
    for (const op of operations) {
      if (op.kind === 'delete') { edits.push({ deleteContentRange: { range: range(start + oldOffset, start + oldOffset + op.text.length) } }); oldOffset += op.text.length; ai += Array.from(op.text).length; }
      else if (op.kind === 'insert') {
        if (/[\u0000-\u0008\u000c-\u001f\uE000-\uF8FF]/.test(op.text)) fail('Ce texte contient un caractère que Google ne peut pas insérer.');
        edits.push({ insertText: { location: location(start + oldOffset), text: op.text } });
        for (const char of op.text) { styleAt({}, b[bi++].style, newOffset, char.length, true); newOffset += char.length; }
      } else for (const char of op.text) { styleAt(a[ai++].style, b[bi++].style, newOffset, char.length, false); oldOffset += char.length; newOffset += char.length; }
    }
    // Reverse edits: their positions all refer to the source revision.
    return [...edits.reverse(), ...styles.map(s => ({ updateTextStyle: { range: range(start + s.start, start + s.end), textStyle: s.value, fields: s.fields } }))];
  }
  function paragraph(before, after, oldList, newList) {
    const raw = origins.get(before);
    if (!raw) { if (stable(before) !== stable(after)) fail('La structure de cette liste a changé.'); return; }
    const split = node => {
      const segments = [[]], objects = [];
      for (const child of node.content || []) {
        if (child.type === 'googleInline') { objects.push(child); segments.push([]); } else segments.at(-1).push(child);
      }
      return { segments, objects };
    };
    const a = split(before), b = split(after);
    // src is an expiring preview URL, not object identity.
    const identity = node => ({ type: node.type, id: node.attrs?.googleId, label: node.attrs?.label });
    if (stable(a.objects.map(identity)) !== stable(b.objects.map(identity))) fail('La suppression ou le déplacement d’un élément Google intégré nécessite Google Docs.');
    let start = raw.startIndex;
    const requests = [], segments = [];
    for (let i = 0; i < a.segments.length; i++) {
      segments.push({ start, a: a.segments[i], b: b.segments[i] });
      start = i < a.objects.length ? origins.get(a.objects[i]).endIndex : start;
    }
    for (const s of segments.reverse()) requests.push(...textJob(s.a, s.b, s.start));
    const style = {};
    for (const [google, local] of [['indentStart', 'googleIndentStart'], ['indentEnd', 'googleIndentEnd'], ['indentFirstLine', 'googleIndentFirstLine']]) {
      if ((before.attrs?.[local] || 0) !== (after.attrs?.[local] || 0)) style[google] = { magnitude: after.attrs?.[local] || 0, unit: 'PT' };
    }
    const named = node => node.type === 'heading' ? `HEADING_${node.attrs.level}` : node.attrs?.googleNamedStyle || 'NORMAL_TEXT';
    if (named(before) !== named(after)) style.namedStyleType = named(after);
    if ((before.attrs?.textAlign || 'left') !== (after.attrs?.textAlign || 'left')) style.alignment = alignBack[after.attrs?.textAlign] || 'START';
    if (Object.keys(style).length) requests.push({ updateParagraphStyle: { range: range(raw.startIndex, raw.startIndex + 1), paragraphStyle: style, fields: Object.keys(style).join(',') } });
    if (stable(oldList) !== stable(newList)) {
      if (newList && (newList.depth || newList.start !== 1)) fail('La modification des niveaux ou du départ de numérotation nécessite Google Docs.');
      requests.push({ deleteParagraphBullets: { range: range(raw.startIndex, raw.startIndex + 1) } });
      if (newList) requests.push({ createParagraphBullets: { range: range(raw.startIndex, raw.startIndex + 1), bulletPreset: newList.type === 'orderedList' ? 'NUMBERED_DIGIT_ALPHA_ROMAN' : 'BULLET_DISC_CIRCLE_SQUARE' } });
    }
    jobs.push({ index: raw.startIndex, requests });
  }
  function walk(before, after, singleStructure = false) {
    const structural = node => ['table', 'googleBlock'].includes(node.type);
    if (!singleStructure && [...before, ...after].some(structural)) {
      const split = nodes => {
        const regions = [[]], structures = [];
        for (const node of nodes) { if (structural(node)) { structures.push(node); regions.push([]); } else regions.at(-1).push(node); }
        return { regions, structures };
      };
      const a = split(before), b = split(after);
      if (a.structures.length !== b.structures.length || a.structures.some((node, i) => node.type !== b.structures[i].type)) fail('L’ajout ou la suppression d’une structure Google nécessite Google Docs.');
      a.structures.forEach((node, i) => walk([node], [b.structures[i]], true));
      a.regions.forEach((region, i) => { if (region.length || b.regions[i].length) walk(region, b.regions[i]); });
      return;
    }
    const a = paragraphs(before), b = paragraphs(after);
    if (a.length !== b.length) {
      // Structural text edits are safe inside a plain region only. The strict
      // converter checks styles before constructing the bounded replacement.
      const raws = a.map(p => origins.get(p.node));
      const format = p => stable({ type: p.node.type, attrs: p.node.attrs || {}, list: p.list });
      if (a.length && b.length && [...a, ...b].every(p => ['paragraph', 'heading'].includes(p.node.type) && format(p) === format(a[0])) && raws.every(raw => raw?.paragraph)) {
        const combine = rows => ({ ...rows[0].node, content: rows.flatMap((p, i) => [...(i ? [{ type: 'hardBreak' }] : []), ...(p.node.content || [])]) });
        const old = combine(a), next = combine(b);
        origins.set(old, { ...raws[0], endIndex: raws.at(-1).endIndex });
        paragraph(old, next, a[0].list, b[0].list);
        return;
      }
      if (raws.some(raw => !raw?.paragraph) || a.some(p => p.list) || b.some(p => p.list)) fail('La structure du tableau ou de la liste a changé.');
      const start = raws[0]?.startIndex;
      if (!Number.isInteger(start)) fail('Cette insertion nécessite Google Docs.');
      try {
        const update = buildGoogleUpdate({ revisionId: source.revisionId, body: { content: raws } }, { type: 'doc', content: after });
        for (const request of update.requests) {
          const op = Object.values(request)[0];
          if (op.range) op.range = range(op.range.startIndex + start - 1, op.range.endIndex + start - 1);
          if (op.location) op.location = location(op.location.index + start - 1);
        }
        jobs.push({ index: start, requests: update.requests });
      } catch { fail('Cette modification de structure contient des éléments Google à conserver.'); }
      return;
    }
    a.forEach(({ node: old, list }, i) => {
      const next = b[i].node;
      if (['paragraph', 'heading'].includes(old.type) && ['paragraph', 'heading'].includes(next.type)) paragraph(old, next, list, b[i].list);
      else if (old.type === 'table' && next.type === 'table') {
        if (old.content.length !== next.content?.length) fail('L’ajout ou la suppression de lignes du tableau nécessite Google Docs.');
        old.content.forEach((row, r) => {
          const cells = next.content[r].content;
          if (row.content.length !== cells?.length) fail('L’ajout ou la suppression de colonnes nécessite Google Docs.');
          row.content.forEach((cell, c) => {
            if (cell.type !== cells[c].type || cells[c].attrs?.colwidth?.some((width, i) => width !== cell.attrs?.colwidth?.[i])) fail('La modification des en-têtes ou de la largeur des colonnes nécessite Google Docs.');
            if (['colspan', 'rowspan'].some(k => (cell.attrs?.[k] || 1) !== (cells[c].attrs?.[k] || 1))) fail('La fusion de cellules nécessite Google Docs.');
            walk(cell.content, cells[c].content);
          });
        });
      } else if (old.type === 'googleBlock' && stable(old) === stable(next)) { /* conserver le bloc natif */ }
      else fail('Cette modification de structure nécessite Google Docs.');
    });
  }
  walk(original.content, document.content);
  const requests = jobs.sort((a, b) => b.index - a.index).flatMap(job => job.requests);
  if (requests.length > 900) fail('Ce changement dépasse 900 opérations Google. Envoie-le en plusieurs étapes.');
  return { requests, writeControl: { requiredRevisionId: source.revisionId } };
}
