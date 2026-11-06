import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.use({
  gfm: true, // tableaux, cases à cocher, barré
  breaks: true, // un retour à la ligne suffit, comme dans une note
});

/**
 * Markdown → HTML assaini. DOMPurify est indispensable : le contenu part
 * dans `dangerouslySetInnerHTML`, et rien n'empêche de coller du HTML
 * arbitraire dans une entrée.
 *
 * `marked` rend les cases à cocher avec `disabled` : c'est le bon défaut
 * (aperçu d'écriture, aperçu de relecture IA), mais le mode Lire de
 * l'éditeur veut des cases cliquables. `interactiveCheckboxes` retire ce
 * seul attribut, uniquement sur les `<input type="checkbox">`.
 */
export function renderMarkdown(source: string, options: { interactiveCheckboxes?: boolean } = {}): string {
  const html = marked.parse(source || '', { async: false });
  const sanitized = DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
  if (!options.interactiveCheckboxes) return sanitized;
  return sanitized.replace(
    /<input([^>]*?)type=(["']?)checkbox\2([^>]*?)>/gi,
    (_tag, before: string, _quote: string, after: string) => {
      const cleaned = `${before} ${after}`
        .replace(/\s*disabled(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return `<input type="checkbox"${cleaned ? ` ${cleaned}` : ''}>`;
    },
  );
}

/**
 * Bouton « Bloc de code » du mode Écrire : entoure de clôtures les lignes
 * touchées par la sélection, ou insère un bloc vide au curseur. Chaque clôture
 * tient sur sa propre ligne et dépasse tout ``` déjà présent dans le code, qui
 * sinon fermerait le bloc. Renvoie le texte et la sélection à rétablir : le
 * code entouré, ou la ligne vide du nouveau bloc.
 */
export function insertCodeFence(source: string, start: number, end: number): { text: string; start: number; end: number } {
  if (end > start) {
    if (start > 0) start = source.lastIndexOf('\n', start - 1) + 1;
    // Une sélection qui s'arrête en début de ligne n'emporte pas cette ligne.
    if (source[end - 1] === '\n') end -= 1;
    const lineEnd = source.indexOf('\n', end);
    end = lineEnd === -1 ? source.length : lineEnd;
  }
  const code = source.slice(start, end);
  const longest = Math.max(0, ...(code.match(/^ {0,3}`{3,}/gm) ?? []).map((run) => run.trim().length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const before = source.slice(0, start);
  const after = source.slice(end);
  const open = (before && !before.endsWith('\n') ? '\n' : '') + fence + '\n';
  const close = '\n' + fence + (after && !after.startsWith('\n') ? '\n' : '');
  const codeStart = before.length + open.length;
  return { text: before + open + code + close + after, start: codeStart, end: codeStart + code.length };
}

/**
 * Inverse le statut de la Nième case à cocher Markdown (`- [ ]` ↔ `- [x]`).
 * L'index suit l'ordre d'apparition des cases dans le texte, comme celui
 * des `<input type="checkbox">` dans le HTML rendu. Index inconnu ou texte
 * sans case : le contenu est renvoyé tel quel.
 */
export function toggleChecklistItem(source: string, index: number): string {
  if (!Number.isInteger(index) || index < 0) return source;
  const lines = source.split('\n');
  let seen = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*(?:[-*•]\s*)?\[[ xX]\]/.test(lines[i])) continue;
    seen += 1;
    if (seen !== index) continue;
    lines[i] = lines[i].replace(/\[[ xX]\]/, (match) => (match.toLowerCase() === '[x]' ? '[ ]' : '[x]'));
    break;
  }
  return lines.join('\n');
}
