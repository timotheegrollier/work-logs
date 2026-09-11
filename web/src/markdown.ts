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
 */
export function renderMarkdown(source: string): string {
  const html = marked.parse(source || '', { async: false });
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
}
