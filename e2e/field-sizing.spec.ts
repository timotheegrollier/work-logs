import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/** Hauteur d'une zone de texte, en vérifiant qu'elle montre tout son texte : pas d'ascenseur dedans. */
async function fitsText(field: Locator) {
  const { height, scroll, client } = await field.evaluate((element) => ({
    height: element.getBoundingClientRect().height, scroll: element.scrollHeight, client: element.clientHeight,
  }));
  expect(scroll).toBeLessThanOrEqual(client + 1);
  return height;
}

const resizer = (page: Page, side: 'gauche' | 'droite') =>
  page.getByRole('separator', { name: `Redimensionner la colonne de ${side}` });
const noSideScroll = (panel: Locator) => panel.evaluate((element) => element.scrollWidth <= element.clientWidth);

test('la zone Markdown suit son texte, à la frappe et quand un panneau ou la fenêtre change de largeur', async ({ page, request }) => {
  const markdown = Array.from({ length: 40 }, (_, i) => `- Point ${i + 1} : une phrase assez longue pour passer à la ligne quand la colonne rétrécit.`).join('\n');
  const entry = await (await request.post('/api/entries', { data: { title: 'Hauteur du Markdown', content_md: markdown } })).json();
  try {
    await page.addInitScript((id) => localStorage.setItem('worklogs-entry', id), entry.id);
    // ≤ 1 180 px, l'aperçu est masqué : la zone restait à 60 % de l'écran, texte caché sous un ascenseur.
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto('/');
    const editor = page.getByRole('region', { name: 'Entrée' });
    await editor.getByRole('button', { name: 'Écrire', exact: true }).click();
    const source = page.getByLabel('Contenu en Markdown');
    const initial = await fitsText(source);
    expect(initial).toBeGreaterThan(900 * 0.6);

    // Taper au bout : la zone grandit et la colonne suit le curseur.
    await source.press('Control+End');
    for (let i = 0; i < 4; i++) await source.press('Enter');
    await page.keyboard.type('Dernière ligne');
    const typed = await fitsText(source);
    expect(typed).toBeGreaterThan(initial);
    const belowView = await source.evaluate((element) => element.getBoundingClientRect().bottom - element.closest('.center')!.getBoundingClientRect().bottom);
    expect(belowView).toBeLessThan(40);

    // Élargir le journal rétrécit l'Écriture : plus de lignes, une zone plus haute, toujours sans ascenseur.
    await resizer(page, 'gauche').press('End');
    const narrow = await fitsText(source);
    expect(narrow).toBeGreaterThan(typed);
    await resizer(page, 'gauche').press('Home');
    expect(await fitsText(source)).toBeLessThan(narrow);

    // Fenêtre large : l'aperçu revient à côté, la zone suit toujours son texte.
    await page.setViewportSize({ width: 1800, height: 1000 });
    await expect(editor.getByRole('article', { name: 'Aperçu' })).toBeVisible();
    await fitsText(source);
    await expect(source).toHaveValue(`${markdown}\n\n\n\nDernière ligne`);
    await expect(editor.getByText('Enregistré', { exact: true })).toBeVisible();
  } finally {
    await request.delete(`/api/entries/${entry.id}`);
  }
});

test('les formulaires de l’Écriture se replient sur la largeur de la colonne, pas seulement sur celle de la fenêtre', async ({ page, request }) => {
  const entry = await (await request.post('/api/entries', { data: { title: 'Colonne étroite', content_md: 'Appeler le fournisseur.\n\nPréparer le devis.' } })).json();
  try {
    await page.addInitScript((id) => {
      localStorage.setItem('worklogs-entry', id);
      localStorage.setItem('worklogs-ai-key', 'cle-e2e');
    }, entry.id);
    await page.route('**/chat/completions', async (route) => {
      const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      return route.fulfill({ headers, json: { choices: [{ message: { content: JSON.stringify([
        { title: 'Appeler le fournisseur', due_date: null, evidence: 'Appeler le fournisseur.' },
      ]) } }] } });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const editor = page.getByRole('region', { name: 'Entrée' });
    await editor.getByRole('button', { name: 'Écrire', exact: true }).click();
    await editor.getByRole('button', { name: 'Créer une tâche liée' }).click();
    await editor.getByRole('button', { name: 'Assistance IA', exact: true }).click();
    await editor.getByRole('menuitem', { name: 'Suggérer des tâches avec l’IA', exact: true }).click();
    const preview = editor.getByRole('article', { name: 'Aperçu' });
    const rows = [
      [editor.getByLabel('Titre de la tâche liée'), editor.getByLabel('Échéance de la tâche liée')],
      [editor.getByLabel('Titre de l’action 1'), editor.getByLabel('Priorité de l’action 1')],
    ] as const;
    const middle = async (field: Locator) => { const box = (await field.boundingBox())!; return box.y + box.height / 2; };
    // Écart vertical entre deux champs : ~0 côte à côte, une hauteur de champ une fois empilés.
    const side = async ([first, second]: readonly [Locator, Locator]) => (await middle(second)) - (await middle(first));
    await expect(rows[1][0]).toHaveValue('Appeler le fournisseur');

    // Colonne large : le Markdown à côté de son aperçu, titre et échéance sur une rangée.
    await expect(preview).toBeVisible();
    for (const row of rows) expect(Math.abs(await side(row))).toBeLessThan(2);

    // Panneaux élargis, fenêtre inchangée : la colonne étroite empile tout et ne défile pas en largeur.
    await resizer(page, 'gauche').press('End');
    await resizer(page, 'droite').press('End');
    await expect(preview).toBeHidden();
    for (const row of rows) expect(await side(row)).toBeGreaterThan(20);
    expect(await noSideScroll(page.locator('#workspace-editor'))).toBe(true);

    await resizer(page, 'gauche').press('Home');
    await resizer(page, 'droite').press('Home');
    await expect(preview).toBeVisible();
    for (const row of rows) expect(Math.abs(await side(row))).toBeLessThan(2);
  } finally {
    await request.delete(`/api/entries/${entry.id}`);
  }
});

test('le panneau Tâches étroit garde ses champs dans la carte, les sous-tâches grandissent avec leur texte', async ({ page, request }) => {
  const task = await (await request.post('/api/tasks', { data: { title: 'Contrôle des champs du panneau' } })).json();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const card = page.locator('.card').filter({ has: page.getByText('Contrôle des champs du panneau', { exact: true }) });
    await card.getByRole('button', { name: 'Créer une entrée liée', exact: true }).click();
    const subtasks = card.getByLabel('Sous-tâches de l’entrée liée, une par ligne');
    // Au repos, quatre lignes comme avant ; au-delà, la zone grandit au lieu de défiler.
    const empty = await fitsText(subtasks);
    await subtasks.fill('Une\nDeux\nTrois\nQuatre');
    expect(await fitsText(subtasks)).toBeCloseTo(empty, 0);
    await subtasks.fill(Array.from({ length: 8 }, (_, i) => `Sous-tâche ${i + 1} avec un intitulé qui passe à la ligne`).join('\n'));
    const filled = await fitsText(subtasks);
    expect(filled).toBeGreaterThan(empty);

    await resizer(page, 'droite').press('Home');
    expect(await fitsText(subtasks)).toBeGreaterThan(filled);
    // « Nouvelle tâche » garde toute la rangée, « Ajouter » passe dessous.
    const input = (await page.getByLabel('Nouvelle tâche', { exact: true }).boundingBox())!;
    const add = (await page.getByRole('button', { name: 'Ajouter', exact: true }).boundingBox())!;
    const row = (await page.locator('.quick').boundingBox())!;
    expect(Math.abs(input.width - row.width)).toBeLessThan(1);
    expect(add.y).toBeGreaterThanOrEqual(input.y + input.height);

    await card.getByRole('button', { name: 'Annuler', exact: true }).click();
    await card.getByRole('button', { name: 'Lier des documents', exact: true }).click();
    const search = (await card.getByRole('searchbox').boundingBox())!;
    const cardBox = (await card.boundingBox())!;
    expect(search.x + search.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
  } finally {
    await request.delete(`/api/tasks/${task.id}`);
  }
});

test('les zones de texte des Paramètres et du partage grandissent aussi avec leur texte', async ({ page }) => {
  const share = path.resolve('.e2e-share');
  const file = path.join(share, 'consignes-longues.md');
  fs.writeFileSync(file, Array.from({ length: 50 }, (_, i) => `- Étape ${i + 1} : relever la mesure du bassin.`).join('\n'));
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Compte et paramètres' }).click();
    await page.getByRole('menuitem', { name: 'Paramètres' }).click();
    const settings = page.getByRole('dialog', { name: 'Paramètres' });
    const profile = settings.getByLabel('Mon contexte de travail');
    const empty = await fitsText(profile);
    await profile.fill('Pisciculture\nBassins\nDevis');
    expect(await fitsText(profile)).toBeCloseTo(empty, 0);
    await profile.fill('Pisciculture\nBassins\nDevis\nMaintenance\nRelevés\nFournisseurs');
    expect(await fitsText(profile)).toBeGreaterThan(empty);
    await profile.fill('');
    expect(await fitsText(profile)).toBeCloseTo(empty, 0);
    await settings.getByRole('button', { name: 'Fermer' }).click();

    if (await page.locator('#workspace-procedures').isHidden()) await page.getByRole('button', { name: 'Procédures', exact: true }).click();
    await page.getByRole('button', { name: /^Ouvrir consignes-longues\.md/ }).click();
    const content = page.getByRole('region', { name: 'Fichier partagé' }).getByLabel('Contenu de consignes-longues.md');
    expect(await fitsText(content)).toBeGreaterThan(900 * 0.6);
  } finally {
    fs.rmSync(file, { force: true });
  }
});
