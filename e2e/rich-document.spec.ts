import { expect, test } from '@playwright/test';

// Chaque document est retiré après le test : la recette historique garde son amorçage.
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Nouveau document', exact: false }).click();
  await expect(page.getByRole('textbox', { name: 'Contenu du document' })).toBeVisible();
});
test.afterEach(async ({ page }) => {
  const field = page.getByLabel('Titre de l’entrée');
  if (!(await field.count())) return;
  const name = await field.inputValue();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('region', { name: 'Entrée' }).getByRole('button', { name: 'Supprimer', exact: true }).click();
  // Attendre la disparition effective : sans ça, la recette suivante démarre
  // pendant la suppression et voit encore le document dans le journal.
  await expect(page.getByRole('region', { name: 'Journal' }).getByText(name, { exact: true })).toHaveCount(0);
});

test('édition riche : styles, raccourcis, persistance et impression', async ({ page }, testInfo) => {
  const content = page.getByRole('textbox', { name: 'Contenu du document' });
  await page.getByLabel('Titre de l’entrée').fill('Document riche');
  await content.fill('Décisions du jour');
  await content.press('Control+a');
  await page.getByRole('button', { name: 'Gras', exact: true }).click();
  await page.getByRole('button', { name: 'Souligné', exact: true }).click();
  await page.getByLabel('Style du paragraphe').selectOption('2');
  await page.getByRole('button', { name: 'Centrer', exact: true }).click();
  await content.press('Control+s');
  await expect(page.getByText('Enregistré', { exact: true })).toBeVisible();
  await page.reload();
  await expect(content.locator('h2 strong u, h2 u strong')).toHaveText('Décisions du jour');
  await expect(content.locator('h2')).toHaveCSS('text-align', 'center');
  await page.screenshot({ path: testInfo.outputPath('rich-editor.png'), fullPage: true });
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('toolbar', { name: 'Mise en forme du document' })).toBeHidden();
  await expect(content).toBeVisible();
  await page.emulateMedia({ media: 'screen' });
});

test('liste, lien, annuler et rétablir fonctionnent dans l’éditeur', async ({ page }) => {
  const content = page.getByRole('textbox', { name: 'Contenu du document' });
  await content.fill('Compte rendu');
  await content.press('Control+a');
  await page.getByRole('button', { name: 'Lien', exact: true }).click();
  await page.getByLabel('Adresse du lien').fill('https://example.com/compte-rendu');
  await page.getByRole('button', { name: 'Appliquer le lien' }).click();
  await expect(content.locator('a')).toHaveAttribute('href', 'https://example.com/compte-rendu');
  await page.getByRole('button', { name: 'Liste à puces', exact: true }).click();
  await expect(content.locator('ul li')).toHaveText('Compte rendu');
  await page.getByRole('button', { name: 'Annuler', exact: true }).click();
  await expect(content.locator('ul')).toHaveCount(0);
  await page.getByRole('button', { name: 'Rétablir', exact: true }).click();
  await expect(content.locator('ul li')).toHaveText('Compte rendu');
});

test('tableau et image locale survivent au rechargement', async ({ page }) => {
  const content = page.getByRole('textbox', { name: 'Contenu du document' });
  await content.click();
  await page.getByRole('button', { name: 'Tableau', exact: true }).click();
  await expect(content.locator('tr')).toHaveCount(3);
  await content.locator('th').first().click();
  await page.keyboard.type('Échéance');
  await page.getByRole('button', { name: 'Ajouter une ligne', exact: true }).click();
  await expect(content.locator('tr')).toHaveCount(4);
  await content.press('Control+End');
  await page.getByLabel('Insérer une image').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64') });
  await expect(content.locator('img')).toBeVisible();
  await content.locator('img').click();
  await page.getByLabel('Description de l’image').fill('Image de test');
  await page.getByLabel('Largeur de l’image (px)').fill('120');
  await content.press('Control+s');
  await expect(page.getByText('Enregistré', { exact: true })).toBeVisible();
  await page.reload();
  await expect(content.locator('tr')).toHaveCount(4);
  await expect(content.locator('img')).toHaveAttribute('alt', 'Image de test');
  await expect(content.locator('img')).toHaveAttribute('width', '120');
  await expect(page.getByText('Enregistré', { exact: true })).toBeVisible();
});

test('le panneau Drive explique la disponibilité desktop sans bloquer le document local', async ({ page }) => {
  await page.getByRole('button', { name: 'Google Drive', exact: false }).click();
  await expect(page.getByText('La connexion Drive est disponible dans l’application desktop Linux.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Contenu du document' })).toBeEditable();
  await page.getByRole('dialog', { name: 'Gestion Google Drive' }).getByRole('button', { name: 'Fermer' }).click();
});

test('recherche et remplacement : casse, navigation, annulation et sauvegarde du texte littéral', async ({ page }) => {
  const content = page.getByRole('textbox', { name: 'Contenu du document' });
  await content.fill('Bonjour bonjour BONJOUR 😀');
  await content.press('Control+f');
  const search = page.getByRole('search', { name: 'Rechercher dans le document' });
  await search.getByLabel('Rechercher', { exact: true }).fill('bonjour');
  await expect(search.locator('output')).toHaveText('1 / 3');
  await expect(content.locator('.search-match')).toHaveCount(3);
  await page.getByRole('button', { name: 'Résultat suivant' }).click();
  await expect(search.locator('output')).toHaveText('2 / 3');
  await search.getByLabel('Respecter la casse').check();
  await expect(search.locator('output')).toHaveText('1 / 1');
  await search.getByLabel('Respecter la casse').uncheck();
  await search.getByLabel('Remplacer par').fill('<b>$&</b>');
  await search.getByRole('button', { name: 'Tout remplacer' }).click();
  await expect(content).toHaveText('<b>$&</b> <b>$&</b> <b>$&</b> 😀');
  await expect(content.locator('b')).toHaveCount(0);
  await page.getByRole('button', { name: 'Annuler', exact: true }).click();
  await expect(content).toHaveText('Bonjour bonjour BONJOUR 😀');
  await search.getByLabel('Remplacer par').fill('Salut');
  await search.getByRole('button', { name: 'Remplacer', exact: true }).click();
  await expect(content).toHaveText('Salut bonjour BONJOUR 😀');
  await search.getByRole('button', { name: 'Fermer la recherche' }).click();
  await expect(content.locator('.search-match')).toHaveCount(0);
  await content.press('Control+s');
  await expect(page.getByText('Enregistré', { exact: true })).toBeVisible();
  await page.reload();
  await expect(content).toHaveText('Salut bonjour BONJOUR 😀');
});

test('plan : rendre le focus ne rétablit pas une ancienne position du curseur', async ({ page }) => {
  const content = page.getByRole('textbox', { name: 'Contenu du document' });
  await content.fill('Prochaines étapes');
  await page.getByLabel('Style du paragraphe').selectOption('4');
  await page.getByRole('button', { name: 'Plan du document', exact: true }).click();
  const heading = page.getByRole('navigation', { name: 'Plan du document' }).getByRole('button', { name: 'Prochaines étapes' });
  await heading.focus();
  const offsets = await heading.evaluate(button => {
    // Rejouer l'ordre observé en CI : clic, End natif, callback de focus,
    // puis seulement selectionchange. Aucun délai arbitraire ni retry.
    const frame = window.requestAnimationFrame;
    const queued: FrameRequestCallback[] = [];
    window.requestAnimationFrame = callback => { queued.push(callback); return 0; };
    try { (button as HTMLButtonElement).click(); }
    finally { window.requestAnimationFrame = frame; }
    const editor = document.querySelector<HTMLElement>('[aria-label="Contenu du document"]')!;
    editor.focus();
    const text = editor.querySelector('h4')!.firstChild!;
    const selection = window.getSelection()!;
    selection.collapse(text, text.textContent!.length);
    const before = selection.focusOffset;
    for (const callback of queued) callback(performance.now());
    return { before, after: selection.focusOffset };
  });
  expect(offsets).toEqual({ before: 17, after: 17 });
  await content.press('Enter');
  await page.keyboard.type('Suite');
  await expect(content.locator('h4')).toHaveText('Prochaines étapes');
  await expect(content.locator('p').filter({ hasText: 'Suite' })).toHaveText('Suite');
});

test('titres 4–6, plan, couleurs et effacement du format', async ({ page }, testInfo) => {
  const content = page.getByRole('textbox', { name: 'Contenu du document' });
  await content.fill('Prochaines étapes');
  await content.press('Control+a');
  await page.getByLabel('Style du paragraphe').selectOption('4');
  await page.getByLabel('Police', { exact: true }).selectOption('Verdana');
  await page.getByLabel('Taille du texte').selectOption('24pt');
  await page.getByLabel('Couleur du surlignage').fill('#aaffcc');
  await expect(content.locator('h4 mark')).toHaveText('Prochaines étapes');
  await page.getByRole('button', { name: 'Plan du document', exact: true }).click();
  const plan = page.getByRole('navigation', { name: 'Plan du document' });
  await plan.getByRole('button', { name: 'Prochaines étapes' }).click();
  await content.press('End');
  await content.press('Enter');
  await page.keyboard.type('Préparer la prochaine version');
  await page.getByLabel('Style du paragraphe').selectOption('6');
  await expect(plan.getByRole('button', { name: 'Préparer la prochaine version' })).toBeVisible();
  const saveRequest = page.waitForRequest(request => request.method() === 'PUT' && /\/api\/entries\/[^/]+$/.test(request.url()) && request.postData()?.includes('aaffcc') && request.postData()?.includes('Préparer la prochaine version'));
  await content.press('Control+s');
  const request = await saveRequest;
  expect((await request.response())?.ok()).toBe(true);
  const persisted = await page.request.get(request.url());
  expect(persisted.ok()).toBe(true);
  expect(JSON.stringify((await persisted.json()).content_json)).toContain('aaffcc');
  await expect(page.getByText('Enregistré', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('rich-editor-expanded.png'), fullPage: true });
  await page.reload();
  await expect(content.locator('h4 mark')).toHaveText('Prochaines étapes');
  await expect(content.locator('h6')).toHaveText('Préparer la prochaine version');
  await content.click();
  await content.press('Control+a');
  await page.getByRole('button', { name: 'Effacer la mise en forme' }).click();
  await expect(content.locator('h4, h6, mark, span[style]')).toHaveCount(0);
  await expect(content.locator('p').filter({ hasText: /\S/ })).toHaveCount(2);
});

test('citations, code, séparateur et retraits de listes', async ({ page }) => {
  const content = page.getByRole('textbox', { name: 'Contenu du document' });
  await content.fill('Une citation');
  await page.getByRole('button', { name: 'Citation', exact: true }).click();
  await expect(content.locator('blockquote')).toHaveText('Une citation');
  await page.getByRole('button', { name: 'Citation', exact: true }).click();
  await page.getByRole('button', { name: 'Bloc de code', exact: true }).click();
  await expect(content.locator('pre code')).toHaveText('Une citation');
  await page.getByRole('button', { name: 'Bloc de code', exact: true }).click();
  await content.press('Control+a');
  await page.getByRole('button', { name: 'Code en ligne' }).click();
  await expect(content.locator('p code')).toHaveText('Une citation');
  await page.getByRole('button', { name: 'Effacer la mise en forme' }).click();
  await content.press('End');
  await content.press('Enter');
  await page.keyboard.type('Deuxième');
  await content.press('Control+a');
  await page.getByRole('button', { name: 'Liste à puces' }).click();
  await content.locator('li p').filter({ hasText: 'Deuxième' }).click();
  await page.keyboard.press('End');
  await page.getByRole('button', { name: 'Augmenter le retrait de liste' }).click();
  await expect(content.locator('li li')).toHaveText('Deuxième');
  await page.getByRole('button', { name: 'Diminuer le retrait de liste' }).click();
  await expect(content.locator('li li')).toHaveCount(0);
  await content.press('Control+End');
  await content.press('Enter'); await content.press('Enter');
  await page.getByRole('button', { name: 'Séparateur', exact: true }).click();
  await expect(content.locator('hr')).toHaveCount(1);
  await content.press('Control+s');
  await expect(page.getByText('Enregistré', { exact: true })).toBeVisible();
  await page.reload();
  await expect(content.locator('hr')).toHaveCount(1);
});

test('tableaux : lignes, colonnes, en-têtes, fusion et scission conservent le contenu', async ({ page }) => {
  const content = page.getByRole('textbox', { name: 'Contenu du document' });
  await content.click();
  await page.getByRole('button', { name: 'Tableau', exact: true }).click();
  await content.locator('th').first().click(); await page.keyboard.type('A');
  await content.locator('th').nth(1).click(); await page.keyboard.type('B');
  await content.locator('th').first().click();
  await content.locator('th').nth(1).click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Fusionner les cellules' }).click();
  await expect(content.locator('th[colspan="2"]')).toContainText('A');
  await expect(content.locator('th[colspan="2"]')).toContainText('B');
  await page.getByRole('button', { name: 'Scinder la cellule' }).click();
  await expect(content.locator('th[colspan="2"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Ligne avant', exact: true }).click();
  await expect(content.locator('tr')).toHaveCount(4);
  await page.getByRole('button', { name: 'Supprimer la ligne', exact: true }).click();
  await expect(content.locator('tr')).toHaveCount(3);
  await page.getByRole('button', { name: 'Colonne avant', exact: true }).click();
  await expect(content.locator('tr').first().locator('td,th')).toHaveCount(4);
  await page.getByRole('button', { name: 'Supprimer la colonne', exact: true }).click();
  await expect(content.locator('tr').first().locator('td,th')).toHaveCount(3);
  await content.locator('tr').first().locator('td,th').first().click();
  await page.getByRole('button', { name: 'En-tête de ligne', exact: true }).click();
  await page.getByRole('button', { name: 'En-tête de colonne', exact: true }).click();
  // Les colonnes insérées/supprimées peuvent laisser un en-tête de ligne mixte.
  // Vérifier la colonne choisie et la persistance de toute la structure résultante.
  await expect(content.locator('tr > th:first-child')).toHaveCount(3);
  const tableBeforeReload = await content.locator('table').innerHTML();
  await content.press('Control+s');
  await expect(page.getByText('Enregistré', { exact: true })).toBeVisible();
  await page.reload();
  await expect(content.locator('tr')).toHaveCount(3);
  await expect(content.locator('table')).toHaveJSProperty('innerHTML', tableBeforeReload);
});
