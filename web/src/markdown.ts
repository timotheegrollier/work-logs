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
  if (!options.interactiveCheckboxes) return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
  // Sur le DOM assaini : une regex sur le HTML peut couper un attribut et en fabriquer d'autres.
  const body = DOMPurify.sanitize(html, { ADD_ATTR: ['target'], RETURN_DOM: true }) as HTMLElement;
  body.querySelectorAll('input[type="checkbox"]').forEach((box) => box.removeAttribute('disabled'));
  return body.innerHTML;
}

/** DOM assaini d'un Markdown, dans un document inerte, sans ce qui charge autrement que par `src`. */
function inertDom(markdown: string): HTMLElement {
  const body = DOMPurify.sanitize(renderMarkdown(markdown), {
    ADD_ATTR: ['target'],
    FORBID_TAGS: ['style', 'svg', 'math'],
    FORBID_ATTR: ['srcset', 'poster', 'background'],
    RETURN_DOM: true,
  }) as HTMLElement;
  // Sans fonction CSS (`url()`, `image-set()`…), un style ne charge rien : les tailles restent.
  body.querySelectorAll('[style*="("]').forEach((element) => element.removeAttribute('style'));
  return body;
}

/**
 * Aperçu d'un texte écrit par l'IA : le navigateur irait chercher ses images dès
 * l'affichage, avant tout clic, et révélerait l'adresse IP et le moment de la
 * lecture à qui le modèle désigne (§82). Seule se charge une adresse déjà
 * présente, entière, dans le texte d'origine ; sinon, son texte alternatif.
 */
export function renderAiProposal(proposal: string, original: string): string {
  const known = new Set([...inertDom(original).querySelectorAll('[src], [href]')]
    .flatMap((element) => [element.getAttribute('src'), element.getAttribute('href')]));
  const body = inertDom(proposal);
  body.querySelectorAll('[src]').forEach((element) => {
    if (!known.has(element.getAttribute('src'))) element.replaceWith(element.getAttribute('alt') || '[image non chargée]');
  });
  return body.innerHTML;
}

/** Sur les jetons : `<VirtualHost>` dans un bloc de code n'est pas du HTML. */
export function hasHtmlOrImage(source: string): boolean {
  let found = false;
  marked.walkTokens(marked.lexer(source), (token) => {
    found ||= token.type === 'html' || token.type === 'image';
  });
  return found;
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
const CHECKLIST_ITEM = /^\s*(?:[-*•]\s*)?\[([ xX])\]/;

/** Part des cases cochées, en pourcentage arrondi ; null sans case à cocher. */
export function checklistProgress(source: string): number | null {
  const items = source.split('\n').map((line) => CHECKLIST_ITEM.exec(line)?.[1]).filter((mark) => mark !== undefined);
  return items.length ? Math.round((items.filter((mark) => mark !== ' ').length / items.length) * 100) : null;
}

export function toggleChecklistItem(source: string, index: number): string {
  if (!Number.isInteger(index) || index < 0) return source;
  const lines = source.split('\n');
  let seen = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!CHECKLIST_ITEM.test(lines[i])) continue;
    seen += 1;
    if (seen !== index) continue;
    lines[i] = lines[i].replace(/\[[ xX]\]/, (match) => (match.toLowerCase() === '[x]' ? '[ ]' : '[x]'));
    break;
  }
  return lines.join('\n');
}
