import { expect, test, type Page } from '@playwright/test';

const journal = (page: Page) => page.getByRole('region', { name: 'Journal' });
const board = (page: Page) => page.getByRole('region', { name: 'Tâches' });
const editor = (page: Page) => page.getByRole('region', { name: 'Entrée' });
const title = (page: Page) => page.getByLabel('Titre de l’entrée');

/** Crée une entrée et renseigne son titre, avec l'assurance qu'elle est enregistrée. */
async function newEntry(page: Page, name: string, markdown = '') {
  await page.getByRole('button', { name: 'Nouvelle entrée' }).click();
  await expect(title(page)).toHaveValue('Sans titre');
  await title(page).fill(name);
  if (markdown) {
    await editor(page).getByRole('button', { name: 'Écrire', exact: true }).click();
    await page.getByLabel('Contenu en Markdown').fill(markdown);
  }
  await expect(editor(page).getByText('Enregistré')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(journal(page)).toBeVisible();
});

test('tout tient sur un écran, sans navigation', async ({ page }) => {
  await expect(journal(page)).toBeVisible();
  await expect(editor(page)).toBeVisible();
  await expect(board(page)).toBeVisible();

  // Aucun onglet ni menu : la page ne propose qu'une seule vue.
  await expect(page.getByRole('navigation', { name: 'Projets' })).toBeVisible();
  for (const column of ['À faire', 'En cours', 'Terminé']) {
    await expect(board(page).getByRole('heading', { name: new RegExp(column) })).toBeVisible();
  }
});

test('la première visite montre le mode d’emploi', async ({ page }) => {
  // On sélectionne l'entrée explicitement : les recettes de `rich-document.spec.ts`
  // s'exécutent avant celle-ci dans la même base et y laissent des documents plus
  // récents, donc l'amorçage n'est pas forcément ce qui s'ouvre au démarrage.
  await journal(page).getByText('Comment ça marche').click();
  await expect(title(page)).toHaveValue('Comment ça marche');
  await expect(editor(page).getByRole('heading', { name: 'Écrire' })).toBeVisible();
});

test('écrire une entrée, la relire après rechargement', async ({ page }) => {
  await newEntry(page, 'Compte rendu chantier', '## Points\n\n- Devis signé\n- Livraison jeudi');

  await page.reload();

  await expect(title(page)).toHaveValue('Compte rendu chantier');
  await expect(editor(page).getByRole('heading', { name: 'Points' })).toBeVisible();
  await expect(editor(page).getByText('Devis signé')).toBeVisible();
  await expect(journal(page).getByText('Compte rendu chantier')).toBeVisible();
});

test('le Markdown est vraiment mis en page', async ({ page }) => {
  await newEntry(
    page,
    'Mise en page',
    [
      '# Titre',
      '',
      '| Poste | Montant |',
      '| --- | ---: |',
      '| Toiture | 1 200 € |',
      '',
      '- [x] Devis envoyé',
      '- [ ] Relance',
      '',
      '> Décision : on part là-dessus.',
      '',
      '```js',
      'const total = 1200;',
      '```',
    ].join('\n')
  );

  const preview = editor(page).getByRole('article', { name: 'Aperçu' });
  await expect(preview.getByRole('heading', { name: 'Titre' })).toBeVisible();
  await expect(preview.getByRole('table')).toBeVisible();
  await expect(preview.getByRole('cell', { name: 'Toiture' })).toBeVisible();
  // `| ---: |` doit vraiment aligner la colonne à droite (montants).
  await expect(preview.getByRole('cell', { name: '1 200 €' })).toHaveCSS('text-align', 'right');
  await expect(preview.getByRole('checkbox').first()).toBeChecked();
  await expect(preview.locator('blockquote')).toContainText('Décision');
  await expect(preview.locator('pre code')).toContainText('const total = 1200');

  // Une ligne à cocher ne doit pas porter en plus une puce de liste.
  const bullet = await preview
    .locator('li', { has: page.getByRole('checkbox').first() })
    .first()
    .evaluate((li) => getComputedStyle(li).listStyleType);
  expect(bullet).toBe('none');
});

test('une carte se déplace d’une colonne à l’autre au glisser-déposer', async ({ page }) => {
  await page.getByLabel('Nouvelle tâche').fill('Carte à glisser');
  await page.getByLabel('Nouvelle tâche').press('Enter');

  const card = board(page).locator('.card', { hasText: 'Carte à glisser' });
  await expect(card).toBeVisible();

  // Le glisser-déposer HTML5 ne se rejoue pas à la souris : on émet les
  // événements natifs avec un DataTransfer partagé, comme le ferait le navigateur.
  await page.evaluate(() => {
    const source = [...document.querySelectorAll('.card')].find((c) =>
      c.textContent?.includes('Carte à glisser')
    )!;
    const target = [...document.querySelectorAll('.column')].find((c) =>
      c.querySelector('h2')?.textContent?.includes('En cours')
    )!;
    const dataTransfer = new DataTransfer();
    const fire = (el: Element, type: string) =>
      el.dispatchEvent(new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true }));
    fire(source, 'dragstart');
    fire(target, 'dragover');
    fire(target, 'drop');
  });

  const doing = board(page).locator('.column', { has: page.getByRole('heading', { name: /En cours/ }) });
  await expect(doing.locator('.card', { hasText: 'Carte à glisser' })).toBeVisible();

  await page.reload();
  await expect(doing.locator('.card', { hasText: 'Carte à glisser' })).toBeVisible();
});

test('cocher une tâche la barre et la range dans Terminé', async ({ page }) => {
  await page.getByLabel('Nouvelle tâche').fill('À cocher');
  await page.getByLabel('Nouvelle tâche').press('Enter');

  await board(page).getByLabel('Terminer À cocher').click();

  const done = board(page).locator('.column', { has: page.getByRole('heading', { name: /Terminé/ }) });
  await expect(done.locator('.card', { hasText: 'À cocher' })).toHaveClass(/is-done/);
});

test('joindre un fichier à une entrée puis le récupérer', async ({ page }) => {
  await newEntry(page, 'Avec pièce jointe');

  await page.getByLabel('Joindre un fichier').setInputFiles({
    name: 'devis.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('montant : 1200 euros'),
  });

  const link = editor(page).getByRole('link', { name: 'devis.txt' });
  await expect(link).toBeVisible();
  await expect(journal(page).getByText('Avec pièce jointe')).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  expect(download.suggestedFilename()).toBe('devis.txt');

  page.once('dialog', (dialog) => dialog.accept());
  await editor(page).getByLabel('Supprimer devis.txt').click();
  await expect(link).toBeHidden();
});

test('la recherche filtre le journal et les tâches d’un coup', async ({ page }) => {
  await newEntry(page, 'Dossier ravalement');
  await page.getByLabel('Nouvelle tâche').fill('Devis ravalement');
  await page.getByLabel('Nouvelle tâche').press('Enter');
  await expect(board(page).getByText('Devis ravalement')).toBeVisible();

  await page.getByLabel('Rechercher').fill('ravalement');

  await expect(journal(page).getByText('Dossier ravalement')).toBeVisible();
  await expect(journal(page).getByText('Comment ça marche')).toBeHidden();
  await expect(board(page).getByText('Devis ravalement')).toBeVisible();
  await expect(board(page).getByText('Créer mes projets')).toBeHidden();
});

test('filtrer par projet restreint les deux colonnes', async ({ page }) => {
  const filters = page.getByRole('group', { name: 'Filtrer par projet' });
  await filters.getByRole('button', { name: /Pro/ }).click();

  await expect(journal(page).getByText('Comment ça marche')).toBeHidden();
  await expect(board(page).getByText('Prendre en main WorkLogs')).toBeVisible();
  await expect(board(page).getByText('Créer mes projets')).toBeHidden();

  await filters.getByRole('button', { name: 'Tout' }).click();
  await expect(journal(page).getByText('Comment ça marche')).toBeVisible();
});

test('le thème choisi est retenu', async ({ page }) => {
  await page.getByLabel('Changer de thème').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('à l’impression, seule la fiche reste', async ({ page }) => {
  await newEntry(page, 'Rapport à imprimer', '## Résumé\n\nTout va bien.\n\n> Point clé à retenir.');

  await page.emulateMedia({ media: 'print' });

  await expect(page.locator('header.head')).toBeHidden();
  await expect(journal(page)).toBeHidden();
  await expect(board(page)).toBeHidden();
  await expect(page.locator('.print-title')).toHaveText('Rapport à imprimer');
  await expect(editor(page).getByRole('heading', { name: 'Résumé' })).toBeVisible();

  // Sur papier, le gris clair de l'écran devient illisible.
  await expect(editor(page).locator('blockquote')).toHaveCSS('color', 'rgb(51, 51, 51)');
});

test('supprimer une entrée ouvre la suivante', async ({ page }) => {
  await newEntry(page, 'Entrée éphémère');

  page.once('dialog', (dialog) => dialog.accept());
  await editor(page).getByRole('button', { name: 'Supprimer' }).click();

  await expect(journal(page).getByText('Entrée éphémère')).toBeHidden();
  await expect(title(page)).not.toHaveValue('Entrée éphémère');
  await expect(editor(page)).toBeVisible();
});
