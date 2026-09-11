import { describe, expect, test } from 'vitest';
import { renderMarkdown } from './markdown';

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
});
