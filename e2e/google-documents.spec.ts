import { test, expect } from '@playwright/test';

const createdIds: string[] = [];
test.afterEach(async ({ request }) => {
  for (const id of createdIds.splice(0)) await request.delete(`/api/entries/${id}`);
});

test('Google Docs : onglets nombreux, édition autour des objets et dans les cellules, synchronisation et affichage adaptatif', async ({ page, request }, testInfo) => {
  const names = ['Vue d’ensemble', 'Notes de réunion', 'Planning et prochaines étapes', 'Budget prévisionnel', 'Décisions', 'Ressources', 'Compte rendu détaillé de la phase de préparation', 'Archives'];
  const snapshots = new Map<string, unknown>();
  const entries = [];
  for (const [index, name] of names.entries()) {
    const rich = { type: 'doc', content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Préparer la prochaine étape' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Statut du projet : ' }, { type: 'googleInline', attrs: { googleId: 'object-0', label: 'Élément Google' } }, { type: 'text', text: ' · point de suivi hebdomadaire.' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Rassembler les informations, confirmer les échéances et préparer la réunion avec l’équipe.' }] },
      { type: 'table', content: [{ type: 'tableRow', content: [
        { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Conception' }] }] },
        { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '12 400 €' }] }] },
      ] }] },
    ] };
    const entry = await (await request.post('/api/entries', { data: { title: `Projet Atlas — ${name}`, content_json: rich, entry_date: '2026-09-15' } })).json();
    createdIds.push(entry.id);
    entries.push({ ...entry, google_document_id: 'atlas', google_tab_id: `t.${index}`, google_tab_title: name, google_document_title: 'Projet Atlas', google_tab_order: index, google_tab_depth: index === 2 || index === 3 ? 1 : 0 });
    snapshots.set(entry.id, rich);
  }
  const withGoogle = (entry: typeof entries[number]) => ({ ...entry, google_sync: {
    document_id: 'atlas', document_title: 'Projet Atlas', tab_id: entries.find(e => e.id === entry.id)!.google_tab_id,
    tab_title: entries.find(e => e.id === entry.id)!.google_tab_title, tabs: entries,
    dirty: JSON.stringify(snapshots.get(entry.id)) !== JSON.stringify(entry.content_json), synced_at: '2026-09-15T09:00:00Z', preserved_elements: 1,
  } });
  await page.route('**/api/state*', async route => {
    const response = await route.fetch(), state = await response.json();
    await route.fulfill({ json: { ...state, entries: state.entries.filter((entry: { id: string }) => entries.some(e => e.id === entry.id)).map((entry: { id: string }) => ({ ...entry, ...entries.find(e => e.id === entry.id) })) } });
  });
  await page.route(/\/api\/entries\/[^/]+$/, async route => {
    const response = await route.fetch(), entry = await response.json();
    await route.fulfill({ json: withGoogle(entry) });
  });
  let pushes = 0;
  await page.route('**/api/entries/*/google/push', async route => {
    const id = route.request().url().split('/').at(-3)!;
    const entry = await (await request.get(`/api/entries/${id}`)).json();
    snapshots.set(id, entry.content_json); pushes++;
    await route.fulfill({ json: withGoogle(entry) });
  });
  await page.addInitScript(id => localStorage.setItem('worklogs-entry', id), entries[0].id);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page.getByRole('tab')).toHaveCount(8);
  await expect(page.getByRole('region', { name: 'Tâches' })).toBeHidden();
  const leftHandle = page.getByRole('separator', { name: 'Redimensionner la colonne de gauche' });
  const rightHandle = page.getByRole('separator', { name: 'Redimensionner la colonne de droite' });
  await expect(leftHandle).toBeVisible();
  await expect(rightHandle).toBeHidden();
  await leftHandle.press('ArrowRight');
  await expect(page.locator('.left')).toHaveCSS('width', '300px');
  await page.getByRole('button', { name: 'Afficher les tâches' }).click();
  await expect(rightHandle).toBeVisible();
  await rightHandle.press('ArrowLeft');
  await expect(page.locator('.right')).toHaveCSS('width', '330px');
  await page.setViewportSize({ width: 1100, height: 1000 });
  await expect(leftHandle).toBeVisible();
  await expect(rightHandle).toBeHidden();
  await expect(page.getByRole('region', { name: 'Tâches' })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Masquer les tâches' }).click();
  const content = page.getByRole('textbox', { name: 'Contenu du document' });
  await content.locator('h2').click();
  await page.getByLabel('Style du paragraphe').selectOption('TITLE');
  await expect(content.locator('[data-google-style="TITLE"]')).toHaveText('Préparer la prochaine étape');
  await content.locator('td').last().click();
  await page.keyboard.press('Home');
  await page.keyboard.type('Budget : ');
  await expect(content.locator('td').last()).toContainText('Budget : 12 400 €');
  await content.locator(':scope > p').nth(1).click();
  await page.keyboard.press('Home');
  await page.keyboard.type('Suivi · ');
  await expect(content.locator(':scope > p').nth(1)).toContainText('Suivi · Statut du projet');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  await expect(page.getByRole('alert')).toContainText('Cet élément est conservé dans Google');
  await expect(content.locator('[data-google-node]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Enregistrer sur Drive' }).click();
  await expect(page.getByText('À jour sur Google Drive')).toBeVisible();
  expect(pushes).toBe(1);
  await expect(content.locator('[data-google-node]')).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('google-docs-desktop.png'), fullPage: true });
  await page.getByRole('searchbox', { name: 'Rechercher un onglet' }).fill('Budget');
  await expect(page.getByRole('tab')).toHaveCount(1);
  await page.getByRole('tab', { name: /Budget/ }).click();
  await expect(page.getByRole('tab', { name: /Budget/ })).toHaveAttribute('aria-selected', 'true');
  await expect(content.locator('td').last()).toHaveText('12 400 €');
  await page.getByRole('tab', { name: /Vue d’ensemble/ }).click();
  await expect(content.locator('td').last()).toContainText('Budget : 12 400 €');
  await page.getByRole('button', { name: 'Changer de thème' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(leftHandle).toBeHidden();
  await expect(rightHandle).toBeHidden();
  await expect(page.getByRole('tab', { name: /Vue d’ensemble/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('google-docs-mobile.png'), fullPage: true });
});
