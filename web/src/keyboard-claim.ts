/**
 * Le renderer n'a aucun pouvoir sur le clavier du système : seule une
 * `WebContentsView` (le document Google intégré) peut le détenir, et le garder
 * même masquée. Une frappe dans un champ WorkLogs part alors dans le vide, et le
 * seul geste qui la redirigeait était réduire puis rouvrir la fenêtre.
 *
 * Le renderer ne peut donc pas *donner* le clavier, mais il peut **dire qu'il le
 * veut** : quand l'utilisateur amène le focus DOM sur un champ, c'est lui qui a
 * tranché — on le lui accorde. Un clic dans le document Google ne produit aucun
 * `focusin` ici (autre `webContents`), donc jamais de vol à l'envers.
 *
 * `focusin` est capturant : un champ dans une boîte de dialogue ou une vue Google
 * masquée compte aussi, et c'est exactement là que le défaut mordait.
 */

const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** Un champ où l'on écrit : les contrôles de formulaire et l'éditeur riche (ProseMirror). */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (EDITABLE.has(target.tagName)) return true;
  // L'éditeur riche est un `contenteditable`, et la frappe y atterrit sur un nœud
  // interne (paragraphe, texte) : `closest` attrape ce cas comme le `div` lui-même.
  // On lit l'attribut plutôt que `isContentEditable`, que jsdom n'implémente pas —
  // et `contenteditable="false"` nested dans une zone éditable reste non éditable.
  const editable = target.closest('[contenteditable]');
  return editable !== null && editable.getAttribute('contenteditable') !== 'false';
}

/**
 * Déclare le clavier à chaque fois qu'un champ WorkLogs prend le focus.
 * Sans pontage desktop (PWA, navigateur) : ne fait rien et ne s'abonne à rien.
 */
export function claimKeyboardOnFocus(claim?: () => void): () => void {
  if (!claim) return () => {};
  const listener = (event: FocusEvent) => { if (isEditableTarget(event.target)) claim(); };
  document.addEventListener('focusin', listener, true);
  return () => document.removeEventListener('focusin', listener, true);
}
