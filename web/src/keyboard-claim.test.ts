import { afterEach, describe, expect, test, vi } from 'vitest';
import { claimKeyboardOnFocus, isEditableTarget } from './keyboard-claim';

describe('déclaration du clavier aux champs WorkLogs', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  test('reconnaît les champs où l’on écrit, et rien d’autre', () => {
    document.body.innerHTML = '<input id="a"><textarea id="b"></textarea><select id="c"></select>'
      + '<div id="d" contenteditable="true"><p id="d2"><span id="d3">texte</span></p></div>'
      + '<div id="d4" contenteditable="false"><span id="d5">figé</span></div>'
      + '<button id="e"></button><div id="f"></div>';
    expect(isEditableTarget(document.getElementById('a'))).toBe(true);
    expect(isEditableTarget(document.getElementById('b'))).toBe(true);
    expect(isEditableTarget(document.getElementById('c'))).toBe(true);
    // L'éditeur riche est un ProseMirror : `contenteditable`, pas une balise connue.
    expect(isEditableTarget(document.getElementById('d'))).toBe(true);
    // La frappe atterrit sur un nœud interne, pas sur le `div` éditable lui-même.
    expect(isEditableTarget(document.getElementById('d3'))).toBe(true);
    expect(isEditableTarget(document.getElementById('d4'))).toBe(false);
    expect(isEditableTarget(document.getElementById('d5'))).toBe(false);
    expect(isEditableTarget(document.getElementById('e'))).toBe(false);
    expect(isEditableTarget(document.getElementById('f'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  test('déclare le clavier dès qu’un champ prend le focus', () => {
    document.body.innerHTML = '<input id="a"><div id="b"></div>';
    const claim = vi.fn();
    const stop = claimKeyboardOnFocus(claim);
    document.getElementById('a')!.focus();
    expect(claim).toHaveBeenCalledTimes(1);
    // Un clic ailleurs ne doit rien déclarer : le clavier ne se vole pas tout seul.
    document.getElementById('b')!.focus();
    expect(claim).toHaveBeenCalledTimes(1);
    stop();
    document.getElementById('a')!.blur();
    document.getElementById('a')!.focus();
    expect(claim).toHaveBeenCalledTimes(1);
  });

  test('ne s’abonne à rien hors desktop', () => {
    document.body.innerHTML = '<input id="a">';
    // Sans pontage, la PWA et le navigateur ne paient aucun écouteur.
    const stop = claimKeyboardOnFocus(undefined);
    document.getElementById('a')!.focus();
    expect(() => stop()).not.toThrow();
  });
});
