import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { getChecklistItems, updateChecklistItems } from '../../api/src/checklist.js';

export { checklistProgress, getChecklistItems, updateChecklistItems, type ChecklistChange, type ChecklistItem } from '../../api/src/checklist.js';

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
 * l'éditeur veut des cases cliquables. `interactiveCheckboxes` retire cet
 * attribut sur les cases Markdown et les relie à leur position dans la note.
 */
export function renderMarkdown(source: string, options: { interactiveCheckboxes?: boolean } = {}): string {
  if (!options.interactiveCheckboxes) {
    return DOMPurify.sanitize(marked.parse(source || '', { async: false }), { ADD_ATTR: ['target'] });
  }
  // Seules les cases produites par le parseur sont reliées à un marqueur Markdown.
  const renderer = new marked.Renderer();
  let marker = 'data-worklogs-box';
  const lowerSource = source.toLowerCase();
  for (let suffix = 1; lowerSource.includes(marker); suffix++) marker = `data-worklogs-box-${suffix}`;
  const renderCheckbox = renderer.checkbox;
  renderer.checkbox = function (token) {
    return renderCheckbox.call(this, token).replace('<input ', '<input ' + marker + ' ');
  };
  const html = marked.parse(source || '', { async: false, renderer });
  const body = DOMPurify.sanitize(html, { ADD_ATTR: ['target'], RETURN_DOM: true }) as HTMLElement;
  body.querySelectorAll('[data-checklist-index]').forEach((box) => box.removeAttribute('data-checklist-index'));
  const boxes = [...body.querySelectorAll<HTMLInputElement>(`input[${marker}]`)];
  const items = getChecklistItems(source);
  const aligned = boxes.length === items.length && boxes.every((box, index) => box.checked === items[index].checked);
  boxes.forEach((box, index) => {
    box.removeAttribute(marker);
    if (aligned) {
      box.dataset.checklistIndex = String(index);
      box.removeAttribute('disabled');
    }
  });
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

/** Inverse la case Markdown dans l'ordre du rendu, en préservant le texte. */
export function toggleChecklistItem(source: string, index: number): string {
  const item = getChecklistItems(source)[index];
  return item ? updateChecklistItems(source, [{ index, checked: !item.checked }]) : source;
}
