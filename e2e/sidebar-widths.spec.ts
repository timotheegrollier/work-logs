import { expect, test, type Page } from '@playwright/test';

// Une seule poignée latérale depuis §102 : Journal et Tâches partagent la colonne de gauche.
const handle = (page: Page) => page.getByRole('separator', { name: 'Redimensionner la colonne de gauche' });
const sideSwitch = (page: Page) => page.getByRole('group', { name: 'Notes ou tâches' });

/** Les champs au pixel près vivent dans Paramètres › Affichage. */
async function widthField(page: Page) {
  await page.getByRole('button', { name: 'Compte et paramètres' }).click();
  await page.getByRole('menuitem', { name: 'Paramètres' }).click();
  return page.getByRole('dialog', { name: 'Paramètres' }).getByLabel('Largeur de la colonne de gauche (px)');
}
async function closeSettings(page: Page) {
  await page.getByRole('dialog', { name: 'Paramètres' }).getByRole('button', { name: 'Fermer' }).click();
}

async function drag(page: Page, delta: number) {
  const box = (await handle(page).boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + delta, y, { steps: 8 });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Journal', exact: true })).toBeVisible();
});

test('redimensionne l’assistant au pointeur et au clavier et mémorise sa largeur', async ({ page }) => {
  const opener = page.getByRole('banner').getByRole('button', { name: 'Ouvrir l’assistant IA', exact: true });
  const chat = page.getByRole('dialog', { name: 'Assistant IA', exact: true });
  const resize = chat.getByRole('separator', { name: 'Redimensionner le panneau de l’assistant' });
  await opener.click();
  await expect(chat).toHaveCSS('width', '1460px');
  const edge = (await resize.boundingBox())!;
  const x = edge.x + edge.width / 2;
  const y = edge.y + edge.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 160, y, { steps: 8 });
  await expect(chat).toHaveCSS('width', '1300px');
  await page.mouse.up();
  await resize.press('Shift+ArrowLeft');
  await expect(chat).toHaveCSS('width', '1350px');
  await page.reload();
  await opener.click();
  await expect(chat).toHaveCSS('width', '1350px');
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(chat).toHaveCSS('width', '375px');
  await expect(resize).toHaveCount(0);
});

test('largeurs : glisser le bord ajuste le panneau en direct et survit au rechargement', async ({ page }, testInfo) => {
  await drag(page, 90);
  await expect(page.locator('.left')).toHaveCSS('width', '410px');
  await page.mouse.up();
  const field = await widthField(page);
  await expect(field).toHaveValue('410');
  // Plus de colonne de droite (§102) : un seul réglage latéral avec celui des procédures.
  await expect(page.getByRole('dialog', { name: 'Paramètres' }).getByLabel('Largeur de la colonne de droite (px)')).toHaveCount(0);
  await closeSettings(page);
  await page.mouse.move(700, 400);
  await expect(page.locator('.left')).toHaveCSS('width', '410px');
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
  await expect(page.locator('.column-resizer.is-dragging')).toHaveCount(0);

  await page.reload();
  await expect(page.locator('.left')).toHaveCSS('width', '410px');
  await page.screenshot({ path: testInfo.outputPath('sidebar-widths.png') });
  await widthField(page);
  await page.getByRole('button', { name: 'Largeurs par défaut' }).click();
  await closeSettings(page);
  await expect(page.locator('.left')).toHaveCSS('width', '320px');

  await drag(page, 20);
  await handle(page).dispatchEvent('pointercancel', { pointerId: 1 });
  await expect(page.locator('.column-resizer.is-dragging')).toHaveCount(0);
  await page.mouse.move(700, 400);
  await page.mouse.up();
  await expect(page.locator('.left')).toHaveCSS('width', '340px');
});

test('largeurs : limites au glissement, réglage au clavier et adaptation aux petits écrans', async ({ page }) => {
  await expect(page.getByRole('separator', { name: 'Redimensionner la colonne de droite' })).toHaveCount(0);
  await drag(page, 800);
  await page.mouse.up();
  await expect(page.locator('.left')).toHaveCSS('width', '600px');
  await drag(page, -550);
  await page.mouse.up();
  await expect(page.locator('.left')).toHaveCSS('width', '120px');

  await handle(page).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.left')).toHaveCSS('width', '130px');
  await page.keyboard.press('End');
  await expect(page.locator('.left')).toHaveCSS('width', '600px');
  await page.keyboard.press('Home');
  await expect(page.locator('.left')).toHaveCSS('width', '120px');

  await page.setViewportSize({ width: 1100, height: 900 });
  await handle(page).press('End');
  const before = (await page.locator('.left').boundingBox())!.width;
  await drag(page, -40);
  await page.mouse.up();
  await expect.poll(async () => (await page.locator('.left').boundingBox())!.width).toBeCloseTo(before - 40, 0);
  await handle(page).press('End');
  expect((await page.locator('.center').boundingBox())!.width).toBeGreaterThanOrEqual(320);
  expect(await page.locator('.columns').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('separator')).toHaveCount(0);
  await page.setViewportSize({ width: 1800, height: 1000 });
  await expect(handle(page)).toBeVisible();
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('separator')).toHaveCount(0);
});

test('panneaux : replier le journal et les tâches ne garde que l’écriture', async ({ page }) => {
  const toggles = page.getByRole('group', { name: 'Panneaux latéraux' });
  // Une seule colonne porte notes et tâches (§102) : l'en-tête n'a plus d'interrupteur « Tâches ».
  await expect(toggles.getByRole('button', { name: /^Tâches/ })).toHaveCount(0);
  await sideSwitch(page).getByRole('button', { name: /^Tâches/ }).click();
  await expect(page.getByRole('region', { name: 'Tâches', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Journal', exact: true })).toBeHidden();

  await toggles.getByRole('button', { name: 'Journal', exact: true }).click();
  await expect(toggles.getByRole('button', { name: 'Journal', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('region', { name: 'Tâches', exact: true })).toBeHidden();
  await expect(page.getByRole('region', { name: 'Journal', exact: true })).toBeHidden();
  await expect(page.getByRole('region', { name: 'Entrée', exact: true })).toBeVisible();
  await expect(page.locator('.columns')).toHaveClass(/hide-left/);

  // Rouverte, la colonne garde la liste choisie, rechargement compris.
  await toggles.getByRole('button', { name: 'Journal', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Tâches', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('region', { name: 'Tâches', exact: true })).toBeVisible();
  await sideSwitch(page).getByRole('button', { name: 'Notes', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('region', { name: 'Journal', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Tâches', exact: true })).toBeHidden();
});

test('panneaux : replier l’écriture garde le journal et les tâches', async ({ page }) => {
  await page.getByRole('button', { name: 'Écriture', exact: true }).click();
  await expect(page.locator('.columns')).toHaveClass(/hide-center/);
  await expect(page.getByRole('button', { name: 'Écriture', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('region', { name: 'Journal', exact: true })).toBeVisible();
  await sideSwitch(page).getByRole('button', { name: /^Tâches/ }).click();
  await expect(page.getByRole('region', { name: 'Tâches', exact: true })).toBeVisible();
  await expect(page.getByRole('separator')).toHaveCount(0);
  await sideSwitch(page).getByRole('button', { name: 'Notes', exact: true }).click();
  await page.getByRole('button', { name: 'Écriture', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Entrée', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Écriture', exact: true }).click();
  await page.reload();
  await expect(page.locator('.columns')).toHaveClass(/hide-center/);
  await expect(page.getByRole('region', { name: 'Journal', exact: true })).toBeVisible();
});

test('largeur des procédures : glisser le bord, clavier, limites, Paramètres et rechargement', async ({ page }) => {
  await page.getByRole('button', { name: 'Procédures', exact: true }).click();
  const bar = page.locator('#workspace-procedures');
  const edge = page.getByRole('separator', { name: 'Redimensionner la colonne des procédures' });
  await expect(bar).toHaveCSS('width', '320px');
  // La poignée est sur le bord gauche de la colonne.
  const [e, b] = [(await edge.boundingBox())!, (await bar.boundingBox())!];
  expect(Math.abs(e.x + e.width / 2 - b.x)).toBeLessThanOrEqual(1);

  const x = e.x + e.width / 2, y = e.y + e.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 100, y, { steps: 8 });
  await expect(bar).toHaveCSS('width', '420px');
  await page.mouse.up();

  await edge.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(bar).toHaveCSS('width', '430px');
  await page.keyboard.press('Home');
  await expect(bar).toHaveCSS('width', '260px');
  await page.keyboard.press('End');
  await expect(bar).toHaveCSS('width', '600px');

  await page.getByRole('button', { name: 'Compte et paramètres' }).click();
  await page.getByRole('menuitem', { name: 'Paramètres' }).click();
  const field = page.getByRole('dialog', { name: 'Paramètres' }).getByLabel('Largeur de la colonne des procédures (px)');
  await expect(field).toHaveValue('600');
  await field.fill('380');
  await closeSettings(page);
  await expect(bar).toHaveCSS('width', '380px');

  await page.reload();
  await expect(page.locator('#workspace-procedures')).toHaveCSS('width', '380px');
  await page.getByRole('button', { name: 'Compte et paramètres' }).click();
  await page.getByRole('menuitem', { name: 'Paramètres' }).click();
  await page.getByRole('button', { name: 'Largeurs par défaut' }).click();
  await closeSettings(page);
  await expect(page.locator('#workspace-procedures')).toHaveCSS('width', '320px');

  // Sur mobile, les colonnes s'empilent : pas de poignée.
  await page.setViewportSize({ width: 412, height: 900 });
  await expect(edge).toBeHidden();
});
