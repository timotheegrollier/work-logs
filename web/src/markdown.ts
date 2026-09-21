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
