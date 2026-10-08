import { afterEach, describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';

// Garde-fou de `setup.ts` : quand un `afterEach` lève, vitest saute ceux qui
// restent ; l'écran du test fautif ne doit pas rester monté sous le suivant.
let rendered = false;

describe('un afterEach qui lève', () => {
  afterEach(() => { throw new Error('afterEach en échec, voulu'); });

  test.fails('fait échouer son test', () => {
    render(<p>Écran du test fautif</p>);
    expect(screen.getByText('Écran du test fautif')).toBeInTheDocument();
    rendered = true;
  });
});

test('le test suivant repart d’un écran vide', () => {
  expect(rendered).toBe(true);
  expect(document.body).toBeEmptyDOMElement();
});
