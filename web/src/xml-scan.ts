/**
 * Analyseur XML qui **garde les positions** dans le texte source. `DOMParser` lit
 * très bien un document Word, mais le réécrire avec `XMLSerializer` changerait des
 * octets partout (espaces de noms, guillemets…). Pour ne réécrire que ce qui a
 * changé, il faut savoir où commence et finit chaque élément : on recolle alors
 * les tranches d'origine telles quelles. `DOMParser` reste le contrôle de
 * validité, à l'entrée comme à la sortie.
 */

export interface XmlText {
  kind: 'text';
  start: number;
  end: number;
  /** Texte décodé (entités, CDATA). */
  value: string;
}

export interface XmlElement {
  kind: 'element';
  /** Nom tel qu'écrit, préfixe compris (`w:p`). */
  name: string;
  /** Espace de noms résolu (préfixes déclarés par `xmlns:…`). */
  ns: string;
  local: string;
  /** Attributs par nom écrit, valeurs décodées. */
  attrs: Record<string, string>;
  /** Mêmes attributs, espace de noms résolu (`w:val` → ns de Word, `val`). */
  attrsNS: { ns: string; local: string; value: string }[];
  start: number;
  /** Juste après le `>` de la balise ouvrante. */
  openEnd: number;
  /** Début de la balise fermante (`openEnd` pour une balise auto-fermante). */
  closeStart: number;
  end: number;
  selfClosing: boolean;
  children: (XmlElement | XmlText)[];
}

export class XmlScanError extends Error {}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(raw: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_all, code: string) => {
    if (code[0] !== '#') return ENTITIES[code];
    const point = code[1] === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : '';
  });
}

export const escapeText = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const escapeAttr = (value: string) => escapeText(value).replace(/"/g, '&quot;');

const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Lit tout le document ; rend l'élément racine. Refuse DOCTYPE (entités externes). */
export function scanXml(text: string): XmlElement {
  const stack: { element: XmlElement; prefixes: Map<string, string> }[] = [];
  let root: XmlElement | null = null;
  let i = 0;
  const n = text.length;
  const pushText = (start: number, end: number, value: string) => {
    const top = stack[stack.length - 1];
    if (top && end > start) top.element.children.push({ kind: 'text', start, end, value });
  };
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt === -1) {
      pushText(i, n, decodeEntities(text.slice(i)));
      break;
    }
    if (lt > i) pushText(i, lt, decodeEntities(text.slice(i, lt)));
    if (text.startsWith('<?', lt)) {
      const close = text.indexOf('?>', lt + 2);
      if (close === -1) throw new XmlScanError('Instruction XML non terminée.');
      i = close + 2;
    } else if (text.startsWith('<!--', lt)) {
      const close = text.indexOf('-->', lt + 4);
      if (close === -1) throw new XmlScanError('Commentaire XML non terminé.');
      i = close + 3;
    } else if (text.startsWith('<![CDATA[', lt)) {
      const close = text.indexOf(']]>', lt + 9);
      if (close === -1) throw new XmlScanError('Section CDATA non terminée.');
      pushText(lt, close + 3, text.slice(lt + 9, close));
      i = close + 3;
    } else if (text.startsWith('<!', lt)) {
      throw new XmlScanError('Déclaration DOCTYPE refusée.');
    } else if (text[lt + 1] === '/') {
      const close = text.indexOf('>', lt);
      if (close === -1) throw new XmlScanError('Balise fermante non terminée.');
      const name = text.slice(lt + 2, close).trim();
      const top = stack.pop();
      if (!top || top.element.name !== name) throw new XmlScanError(`Balise fermante inattendue : ${name}.`);
      top.element.closeStart = lt;
      top.element.end = close + 1;
      i = close + 1;
    } else {
      // Balise ouvrante : chercher le `>` final hors des valeurs entre guillemets.
      let j = lt + 1;
      let quote = '';
      for (; j < n; j++) {
        const char = text[j];
        if (quote) {
          if (char === quote) quote = '';
        } else if (char === '"' || char === "'") {
          quote = char;
        } else if (char === '>') {
          break;
        }
      }
      if (j >= n) throw new XmlScanError('Balise ouvrante non terminée.');
      const selfClosing = text[j - 1] === '/';
      const inner = text.slice(lt + 1, selfClosing ? j - 1 : j);
      const nameMatch = /^[^\s/>]+/.exec(inner);
      if (!nameMatch) throw new XmlScanError('Balise sans nom.');
      const name = nameMatch[0];
      const attrs: Record<string, string> = {};
      ATTRIBUTE.lastIndex = name.length;
      for (let match = ATTRIBUTE.exec(inner); match; match = ATTRIBUTE.exec(inner)) {
        attrs[match[1]] = decodeEntities(match[2] ?? match[3] ?? '');
      }
      const parentPrefixes = stack.length ? stack[stack.length - 1].prefixes : new Map<string, string>();
      let prefixes = parentPrefixes;
      for (const [key, value] of Object.entries(attrs)) {
        if (key === 'xmlns' || key.startsWith('xmlns:')) {
          if (prefixes === parentPrefixes) prefixes = new Map(parentPrefixes);
          prefixes.set(key === 'xmlns' ? '' : key.slice(6), value);
        }
      }
      const colon = name.indexOf(':');
      const prefix = colon === -1 ? '' : name.slice(0, colon);
      // Un attribut sans préfixe n'a pas d'espace de noms (règle XML), contrairement à l'élément.
      const attrsNS = Object.entries(attrs).filter(([key]) => key !== 'xmlns' && !key.startsWith('xmlns:')).map(([key, value]) => {
        const at = key.indexOf(':');
        return { ns: at === -1 ? '' : prefixes.get(key.slice(0, at)) ?? '', local: at === -1 ? key : key.slice(at + 1), value };
      });
      const element: XmlElement = {
        kind: 'element', name, ns: prefixes.get(prefix) ?? '', local: colon === -1 ? name : name.slice(colon + 1),
        attrs, attrsNS, start: lt, openEnd: j + 1, closeStart: j + 1, end: j + 1, selfClosing, children: [],
      };
      if (stack.length) stack[stack.length - 1].element.children.push(element);
      else if (root) throw new XmlScanError('Plusieurs éléments racine.');
      else root = element;
      if (!selfClosing) stack.push({ element, prefixes });
      i = j + 1;
    }
  }
  if (stack.length) throw new XmlScanError(`Élément non fermé : ${stack[stack.length - 1].element.name}.`);
  if (!root) throw new XmlScanError('Document XML vide.');
  return root;
}

export const elements = (element: XmlElement) => element.children.filter((child): child is XmlElement => child.kind === 'element');
export const findChild = (element: XmlElement | null | undefined, ns: string, local: string) =>
  element ? elements(element).find((child) => child.ns === ns && child.local === local) ?? null : null;
export const sliceOf = (text: string, element: XmlElement) => text.slice(element.start, element.end);
/** Valeur d'un attribut par espace de noms et nom local (`w:val`), quel que soit le préfixe. */
export const attrNS = (element: XmlElement | null | undefined, ns: string, local: string): string | null =>
  element?.attrsNS.find((attribute) => attribute.ns === ns && attribute.local === local)?.value ?? null;
