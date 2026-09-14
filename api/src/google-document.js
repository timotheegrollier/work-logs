import { validateDocument } from './rich-document.js';

const unsupported = (feature) => { throw Object.assign(new Error(`Synchronisation Google non prise en charge pour ${feature}. Le document original reste intact.`), { status: 422 }); };
const color = (rgb) => rgb ? '#' + ['red', 'green', 'blue'].map(key => Math.round((rgb[key] || 0) * 255).toString(16).padStart(2, '0')).join('') : null;
const rgb = (hex) => {
  if (!/^#[\da-f]{6}$/i.test(hex || '')) unsupported('cette couleur (utilise le sélecteur de couleurs)');
  return { red: parseInt(hex.slice(1, 3), 16) / 255, green: parseInt(hex.slice(3, 5), 16) / 255, blue: parseInt(hex.slice(5, 7), 16) / 255 };
};
/**
 * Noir « par défaut » de Google Docs. Les valeurs très sombres sont traitées
 * comme une absence de choix : c'est ce que produit un document jamais colorié.
 */
export function isDefaultInk(hex) {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
  if (!match) return false;
  return match.slice(1).every((part) => parseInt(part, 16) <= 0x22);
}

const alignment = { START: 'left', CENTER: 'center', END: 'right', JUSTIFIED: 'justify' };
const alignmentBack = { left: 'START', center: 'CENTER', right: 'END', justify: 'JUSTIFIED' };

export function documentTabs(source) {
  const result = [];
  function visit(tabs, depth = 0) {
    for (const tab of tabs || []) {
      result.push({ id: tab.tabProperties.tabId, title: tab.tabProperties.title || 'Onglet', depth });
      visit(tab.childTabs, depth + 1);
    }
  }
  visit(source.tabs);
  return result;
}

/** Réduit le travail à l'onglet choisi ; chaque écriture conserve son tabId explicite. */
export function selectDocumentTab(source, tabId = '') {
  if (!source.tabs?.length) {
    if (tabId) unsupported('cet onglet Google introuvable');
    return source;
  }
  const tabs = documentTabs(source);
  if (!tabId && tabs.length > 1) unsupported('les documents Google à plusieurs onglets : choisis un onglet dans la liste Drive');
  const chosenId = tabId || tabs[0].id;
  let chosen;
  function visit(nodes) {
    for (const tab of nodes || []) {
      if (tab.tabProperties.tabId === chosenId) chosen = tab;
      visit(tab.childTabs);
    }
  }
  visit(source.tabs);
  if (!chosen) unsupported('cet onglet supprimé ou inaccessible');
  return { ...source, tabs: [{ ...chosen, childTabs: [] }] };
}

export function documentBody(source) {
  if (source.tabs) {
    if (source.tabs.length !== 1 || source.tabs[0].childTabs?.length) unsupported('les documents Google à plusieurs onglets');
    const tab = source.tabs[0];
    return { ...tab.documentTab, tabId: tab.tabProperties.tabId };
  }
  return { body: source.body, lists: source.lists };
}

function rejectSuggestions(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith('suggested') && child && typeof child === 'object' && Object.keys(child).length) unsupported('les suggestions en cours');
    rejectSuggestions(child);
  }
}

function readMarks(style = {}) {
  const marks = [];
  for (const [key, type] of [['bold', 'bold'], ['italic', 'italic'], ['underline', 'underline'], ['strikethrough', 'strike']]) if (style[key]) marks.push({ type });
  if (style.baselineOffset && style.baselineOffset !== 'NORMAL') unsupported('les exposants et indices');
  if (style.weightedFontFamily?.weight && ![400, 700].includes(style.weightedFontFamily.weight)) unsupported('les graisses de police intermédiaires');
  if (style.link) {
    if (!style.link.url) unsupported('les liens vers un signet ou un titre interne');
    marks.push({ type: 'link', attrs: { href: style.link.url } });
  }
  const attrs = {};
  if (style.weightedFontFamily?.fontFamily) attrs.fontFamily = style.weightedFontFamily.fontFamily;
  if (style.fontSize?.magnitude) attrs.fontSize = `${style.fontSize.magnitude}${style.fontSize.unit?.toLowerCase() || 'pt'}`;
  const foreground = color(style.foregroundColor?.color?.rgbColor);
  // Le noir par défaut de Google n'est pas importé : sans couleur explicite, le
  // texte prend celle du thème et reste lisible en sombre comme en clair. À
  // l'écriture, l'absence de couleur laisse Google sur son noir — le document
  // d'origine n'est donc pas modifié. Seules les couleurs vraiment choisies
  // sont conservées.
  if (foreground && !isDefaultInk(foreground)) attrs.color = foreground;
  const background = color(style.backgroundColor?.color?.rgbColor);
  if (background) attrs.backgroundColor = background;
  if (Object.keys(attrs).length) marks.push({ type: 'textStyle', attrs });
  return marks;
}

/** Import fidèle du sous-ensemble pris en charge ; refuse avant toute écriture. */
export function googleToDocument(source) {
  rejectSuggestions(source);
  const part = documentBody(source);
  if (!part.body?.content) unsupported('ce document sans corps éditable');
  const content = [];
  for (const block of part.body.content) {
    if (block.sectionBreak && !block.startIndex) continue;
    if (!block.paragraph) unsupported('les tableaux, images, objets ou sauts de section du document');
    const paragraph = block.paragraph;
    const children = [];
    const elements = paragraph.elements || [];
    for (let index = 0; index < elements.length; index++) {
      const element = elements[index];
      if (!element.textRun) unsupported('les images, notes de bas de page ou objets intégrés');
      let text = element.textRun.content;
      if (index === elements.length - 1) text = text.replace(/\n$/, '');
      if (text) children.push({ type: 'text', text, marks: readMarks(element.textRun.textStyle) });
    }
    const style = paragraph.paragraphStyle || {};
    if (!paragraph.bullet && ['indentStart', 'indentEnd', 'indentFirstLine'].some(k => style[k]?.magnitude)) unsupported('les retraits de paragraphe personnalisés');
    const heading = /^HEADING_([1-6])$/.exec(style.namedStyleType || '');
    if (['TITLE', 'SUBTITLE'].includes(style.namedStyleType)) unsupported('les styles Google Titre et Sous-titre (les Titres 1 à 6 sont pris en charge)');
    const attrs = { ...(heading ? { level: Number(heading[1]) } : {}), ...(alignment[style.alignment] ? { textAlign: alignment[style.alignment] } : {}) };
    const node = { type: heading ? 'heading' : 'paragraph', ...(Object.keys(attrs).length ? { attrs } : {}), ...(children.length ? { content: children } : {}) };
    if (paragraph.bullet) {
      if (paragraph.bullet.nestingLevel > 0 || heading) unsupported('les listes imbriquées ou les titres dans une liste');
      const list = part.lists?.[paragraph.bullet.listId]?.listProperties?.nestingLevels?.[0];
      const type = list?.glyphType && list.glyphType !== 'GLYPH_TYPE_UNSPECIFIED' ? 'orderedList' : 'bulletList';
      if (type === 'orderedList' && list.glyphType !== 'DECIMAL') unsupported('cette numérotation de liste');
      const previous = content.at(-1);
      if (previous?.type === type && previous.listId === paragraph.bullet.listId) previous.content.push({ type: 'listItem', content: [node] });
      else content.push({ type, listId: paragraph.bullet.listId, content: [{ type: 'listItem', content: [node] }] });
    } else content.push(node);
  }
  for (const node of content) delete node.listId;
  return validateDocument({ type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] });
}

function textStyle(marks = []) {
  const style = {};
  for (const mark of marks) {
    if (['bold', 'italic', 'underline'].includes(mark.type)) style[mark.type] = true;
    else if (mark.type === 'strike') style.strikethrough = true;
    else if (mark.type === 'link') style.link = { url: mark.attrs.href };
    else if (mark.type === 'code') style.weightedFontFamily = { fontFamily: 'Courier New' };
    else if (mark.type === 'highlight') style.backgroundColor = { color: { rgbColor: rgb(mark.attrs?.color || '#fff59d') } };
    else if (mark.type === 'textStyle') {
      const a = mark.attrs || {};
      if (a.color) style.foregroundColor = { color: { rgbColor: rgb(a.color) } };
      if (a.backgroundColor) style.backgroundColor = { color: { rgbColor: rgb(a.backgroundColor) } };
      if (a.fontFamily) style.weightedFontFamily = { fontFamily: a.fontFamily };
      if (a.fontSize) style.fontSize = { magnitude: parseFloat(a.fontSize), unit: 'PT' };
      if (a.fontSize?.endsWith('px')) style.fontSize.magnitude *= 0.75;
    }
  }
  return style;
}

function flatten(document) {
  validateDocument(document);
  let text = '';
  const runs = [], paragraphs = [], lists = [];
  function paragraph(node) {
    if (!['paragraph', 'heading'].includes(node.type)) unsupported('les tableaux, images et blocs de code (ils restent disponibles localement)');
    const startIndex = text.length + 1;
    for (const child of node.content || []) {
      if (child.type !== 'text') unsupported('les images ou sauts de ligne internes (utilise Entrée)');
      runs.push({ startIndex: text.length + 1, endIndex: text.length + child.text.length + 1, style: textStyle(child.marks) });
      text += child.text;
    }
    text += '\n';
    paragraphs.push({ startIndex, endIndex: text.length + 1, style: { namedStyleType: node.type === 'heading' ? `HEADING_${node.attrs.level}` : 'NORMAL_TEXT', alignment: alignmentBack[node.attrs?.textAlign] || 'START', indentStart: { magnitude: 0, unit: 'PT' }, indentEnd: { magnitude: 0, unit: 'PT' }, indentFirstLine: { magnitude: 0, unit: 'PT' } } });
  }
  for (const node of document.content) {
    if (['bulletList', 'orderedList'].includes(node.type)) {
      if (node.attrs?.start && node.attrs.start !== 1) unsupported('les listes commençant à un autre nombre que 1');
      const startIndex = text.length + 1;
      for (const item of node.content) {
        if (item.content.length !== 1 || item.content[0].type !== 'paragraph') unsupported('les listes imbriquées ou à plusieurs paragraphes');
        paragraph(item.content[0]);
      }
      lists.push({ startIndex, endIndex: text.length + 1, preset: node.type === 'orderedList' ? 'NUMBERED_DIGIT_ALPHA_ROMAN' : 'BULLET_DISC_CIRCLE_SQUARE' });
    } else paragraph(node);
  }
  return { text, runs, paragraphs, lists };
}

/** Écrit sur une révision précise. Le texte inchangé conserve ses positions autant que possible. */
export function buildGoogleUpdate(source, document) {
  // Un document distant devenu incompatible ne doit pas être aplati lors de la sauvegarde.
  googleToDocument(source);
  const part = documentBody(source);
  const old = part.body.content.flatMap(b => b.paragraph?.elements || []).map(e => e.textRun.content).join('');
  const next = flatten(document);
  if (!source.revisionId) throw Object.assign(new Error('Révision Google absente : écriture refusée.'), { status: 409 });
  const range = (startIndex, endIndex) => ({ startIndex, endIndex, ...(part.tabId ? { tabId: part.tabId } : {}) });
  const requests = [];
  let prefix = 0, suffix = 1; // le dernier saut de paragraphe ne peut pas être supprimé
  while (prefix < Math.min(old.length, next.text.length) - 1 && old[prefix] === next.text[prefix]) prefix++;
  if (prefix && /[\uD800-\uDBFF]/.test(old[prefix - 1])) prefix--;
  while (suffix < Math.min(old.length, next.text.length) - prefix && old[old.length - suffix - 1] === next.text[next.text.length - suffix - 1]) suffix++;
  if (/[\uDC00-\uDFFF]/.test(old[old.length - suffix] || '')) suffix--;
  if (old.length - suffix > prefix) requests.push({ deleteContentRange: { range: range(prefix + 1, old.length - suffix + 1) } });
  const inserted = next.text.slice(prefix, next.text.length - suffix);
  if (inserted) requests.push({ insertText: { location: { index: prefix + 1, ...(part.tabId ? { tabId: part.tabId } : {}) }, text: inserted } });
  const whole = range(1, Math.max(2, next.text.length));
  requests.push({ deleteParagraphBullets: { range: whole } });
  if (next.text.length > 1) requests.push({ updateTextStyle: { range: whole, textStyle: {}, fields: 'bold,italic,underline,strikethrough,link,foregroundColor,backgroundColor,weightedFontFamily,fontSize' } });
  for (const p of next.paragraphs) requests.push({ updateParagraphStyle: { range: range(p.startIndex, p.endIndex), paragraphStyle: p.style, fields: 'namedStyleType,alignment,indentStart,indentEnd,indentFirstLine' } });
  for (const run of next.runs) if (Object.keys(run.style).length) requests.push({ updateTextStyle: { range: range(run.startIndex, run.endIndex), textStyle: run.style, fields: Object.keys(run.style).join(',') } });
  for (const list of next.lists) requests.push({ createParagraphBullets: { range: range(list.startIndex, list.endIndex), bulletPreset: list.preset } });
  if (requests.length > 900) unsupported('les documents contenant plus de 900 opérations de mise en forme');
  return { requests, writeControl: { requiredRevisionId: source.revisionId } };
}
