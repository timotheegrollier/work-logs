import { describe, expect, test } from 'vitest';
import { insertCodeFence, renderMarkdown, toggleChecklistItem } from './markdown';

describe('rendu Markdown', () => {
  test('produit les titres et le gras', () => {
    expect(renderMarkdown('## Réunion')).toContain('<h2>Réunion</h2>');
    expect(renderMarkdown('du **gras**')).toContain('<strong>gras</strong>');
  });

  test('produit les listes à puces et numérotées', () => {
    expect(renderMarkdown('- un\n- deux')).toContain('<li>un</li>');
    expect(renderMarkdown('1. un\n2. deux')).toContain('<ol>');
  });

  test('produit les tableaux GitHub', () => {
    const html = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>a</th>');
    expect(html).toContain('<td>1</td>');
  });

  test('produit des cases à cocher pour les listes de tâches', () => {
    const html = renderMarkdown('- [ ] à faire\n- [x] fait');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked');
  });

  test('produit les blocs de code, les citations et les liens', () => {
    expect(renderMarkdown('```js\nconst a = 1;\n```')).toContain('<pre>');
    expect(renderMarkdown('> note')).toContain('<blockquote>');
    expect(renderMarkdown('[doc](https://exemple.fr)')).toContain('href="https://exemple.fr"');
  });

  test('traite un simple retour à la ligne comme un saut de ligne', () => {
    expect(renderMarkdown('ligne 1\nligne 2')).toContain('<br>');
  });

  test('échappe les balises HTML dangereuses', () => {
    const html = renderMarkdown('<script>alert(1)</script>texte');
    expect(html).not.toContain('<script>');
    expect(html).toContain('texte');
  });

  test('retire les attributs d’événement injectés', () => {
    const html = renderMarkdown('<img src="x" onerror="alert(1)">');
    expect(html).not.toContain('onerror');
  });

  test('neutralise les liens javascript:', () => {
    expect(renderMarkdown('[clic](javascript:alert(1))')).not.toContain('javascript:alert');
  });

  test('rend une chaîne vide sans casser', () => {
    expect(renderMarkdown('')).toBe('');
  });

  test('les cases restent inertes par défaut', () => {
    const html = renderMarkdown('- [ ] à faire\n- [x] fait');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('disabled');
  });

  test('le mode Lire rend des cases cliquables, sans autre changement', () => {
    const html = renderMarkdown('- [ ] à faire\n- [x] fait', { interactiveCheckboxes: true });
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('disabled');
    expect(html).toContain('checked');
  });

  test('les autres attributs survivent au retrait de `disabled`', () => {
    const html = renderMarkdown('- [x] fait', { interactiveCheckboxes: true });
    expect(html).toContain('checked');
    expect(html).not.toMatch(/disabled/i);
  });
});

describe('insertCodeFence', () => {
  test('sans sélection : un bloc vide au curseur, le curseur sur sa ligne vide', () => {
    expect(insertCodeFence('', 0, 0)).toEqual({ text: '```\n\n```', start: 4, end: 4 });
    const source = 'Relancer :';
    expect(insertCodeFence(source, source.length, source.length)).toEqual({ text: 'Relancer :\n```\n\n```', start: 15, end: 15 });
    // Au milieu d'un texte, les clôtures prennent leurs propres lignes.
    expect(insertCodeFence('Avant\nAprès', 6, 6).text).toBe('Avant\n```\n\n```\nAprès');
  });

  test('entoure toutes les lignes touchées par la sélection, et sélectionne le code', () => {
    const source = 'Avant\nsudo systemctl stop app\n\nsudo systemctl start app\nAprès';
    // De « systemctl » (ligne 2) à « start » (ligne 4) : les lignes entières partent.
    const fenced = insertCodeFence(source, source.indexOf('systemctl'), source.indexOf('start') + 2);
    expect(fenced.text).toBe('Avant\n```\nsudo systemctl stop app\n\nsudo systemctl start app\n```\nAprès');
    expect(fenced.text.slice(fenced.start, fenced.end)).toBe('sudo systemctl stop app\n\nsudo systemctl start app');
    expect(renderMarkdown(fenced.text)).toContain('<pre><code>sudo systemctl stop app\n\nsudo systemctl start app\n</code></pre>');
    // Sélection partie d'une première ligne vide : elle reste dans le bloc.
    expect(insertCodeFence('\nls', 0, 3).text).toBe('```\n\nls\n```');
  });

  test('une sélection qui finit en début de ligne n’emporte pas cette ligne', () => {
    const source = 'ls -la\nTexte';
    expect(insertCodeFence(source, 0, 7).text).toBe('```\nls -la\n```\nTexte');
  });

  test('une clôture plus longue que les ``` déjà présents dans le code', () => {
    const source = 'Exemple :\n```\necho 1\n```';
    const fenced = insertCodeFence(source, 0, source.length);
    expect(fenced.text).toBe('````\nExemple :\n```\necho 1\n```\n````');
    expect(renderMarkdown(fenced.text)).toContain('<pre><code>Exemple :\n```\necho 1\n```\n</code></pre>');
  });
});

describe('toggleChecklistItem', () => {
  test('coche la Nième case en gardant le texte intact', () => {
    expect(toggleChecklistItem('- [ ] Relire\n- [ ] Payer', 1)).toBe('- [ ] Relire\n- [x] Payer');
  });

  test('décoche une case déjà cochée, quelle que soit la casse', () => {
    expect(toggleChecklistItem('- [X] Payé', 0)).toBe('- [ ] Payé');
  });

  test('ignore les lignes sans case et les index inconnus', () => {
    const source = 'Intro.\n- Simple puce\n- [ ] Garder';
    expect(toggleChecklistItem(source, 0)).toBe('Intro.\n- Simple puce\n- [x] Garder');
    expect(toggleChecklistItem(source, 5)).toBe(source);
    expect(toggleChecklistItem(source, -1)).toBe(source);
    expect(toggleChecklistItem('Sans case', 0)).toBe('Sans case');
  });
});
