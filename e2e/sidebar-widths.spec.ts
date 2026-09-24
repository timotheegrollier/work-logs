import { expect, test, type Page } from '@playwright/test';

const handle = (page: Page, side: 'gauche' | 'droite') =>
  page.getByRole('separator', { name: `Redimensionner la colonne de ${side}` });

/** Les champs au pixel près vivent dans Paramètres › Affichage. */
async function widthField(page: Page, side: 'gauche' | 'droite') {
  await page.getByRole('button', { name: 'Compte et paramètres' }).click();
  await page.getByRole('menuitem', { name: 'Paramètres' }).click();
  return page.getByRole('dialog', { name: 'Paramètres' }).getByLabel(`Largeur de la colonne de ${side} (px)`);
}
async function closeSettings(page: Page) {
  await page.getByRole('dialog', { name: 'Paramètres' }).getByRole('button', { name: 'Fermer' }).click();
}

async function drag(page: Page, side: 'gauche' | 'droite', delta: number) {
  const box = (await handle(page, side).boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + delta, y, { steps: 8 });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Journal' })).toBeVisible();
});

test('largeurs : glisser les deux bords ajuste les panneaux en direct et survit au rechargement', async ({ page }, testInfo) => {
  await drag(page, 'gauche', 90);
  await expect(page.locator('.left')).toHaveCSS('width', '380px');
  await page.mouse.up();
  await expect(await widthField(page, 'gauche')).toHaveValue('380');
  await closeSettings(page);
  await page.mouse.move(700, 400);
  await expect(page.locator('.left')).toHaveCSS('width', '380px');

  await drag(page, 'droite', -100);
  await expect(page.locator('.right')).toHaveCSS('width', '420px');
  await page.mouse.up();
  await expect(await widthField(page, 'droite')).toHaveValue('420');
  await closeSettings(page);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
  await expect(page.locator('.column-resizer.is-dragging')).toHaveCount(0);

  await page.reload();
  await expect(page.locator('.left')).toHaveCSS('width', '380px');
  await expect(page.locator('.right')).toHaveCSS('width', '420px');
  await page.screenshot({ path: testInfo.outputPath('sidebar-widths.png') });
  await widthField(page, 'gauche');
  await page.getByRole('button', { name: 'Largeurs par défaut' }).click();
  await closeSettings(page);
  await expect(page.locator('.left')).toHaveCSS('width', '290px');
  await expect(page.locator('.right')).toHaveCSS('width', '320px');

  await drag(page, 'gauche', 20);
  await handle(page, 'gauche').dispatchEvent('pointercancel', { pointerId: 1 });
  await expect(page.locator('.column-resizer.is-dragging')).toHaveCount(0);
  await page.mouse.move(700, 400);
  await page.mouse.up();
  await expect(page.locator('.left')).toHaveCSS('width', '310px');
});

test('largeurs : limites au glissement, réglage au clavier et adaptation aux petits écrans', async ({ page }) => {
  await drag(page, 'gauche', 800);
  await page.mouse.up();
  await expect(page.locator('.left')).toHaveCSS('width', '600px');
  await drag(page, 'gauche', -550);
  await page.mouse.up();
  await expect(page.locator('.left')).toHaveCSS('width', '120px');
  await drag(page, 'droite', 280);
  await page.mouse.up();
  await expect(page.locator('.right')).toHaveCSS('width', '120px');
  await drag(page, 'droite', -800);
  await page.mouse.up();
  await expect(page.locator('.right')).toHaveCSS('width', '600px');

  await handle(page, 'gauche').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.left')).toHaveCSS('width', '130px');
  await page.keyboard.press('End');
  await expect(page.locator('.left')).toHaveCSS('width', '600px');
  await handle(page, 'droite').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.right')).toHaveCSS('width', '590px');
  await page.keyboard.press('Home');
  await expect(page.locator('.right')).toHaveCSS('width', '120px');

  await page.setViewportSize({ width: 1100, height: 900 });
  const before = (await page.locator('.left').boundingBox())!.width;
  await drag(page, 'gauche', -40);
  await page.mouse.up();
  await expect.poll(async () => (await page.locator('.left').boundingBox())!.width).toBeCloseTo(before - 40, 0);
  await handle(page, 'droite').press('End');
  expect((await page.locator('.center').boundingBox())!.width).toBeGreaterThanOrEqual(320);
  expect(await page.locator('.columns').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('separator')).toHaveCount(0);
  await page.setViewportSize({ width: 1800, height: 1000 });
  await expect(handle(page, 'gauche')).toBeVisible();
  await expect(handle(page, 'droite')).toBeVisible();
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('separator')).toHaveCount(0);
});

test('panneaux : replier le journal et les tâches ne garde que l’écriture', async ({ page }) => {
  await page.getByRole('button', { name: 'Journal', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Journal' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Journal', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Tâches', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Tâches' })).toBeHidden();
  await expect(page.getByRole('region', { name: 'Entrée' })).toBeVisible();
  await expect(page.locator('.columns')).toHaveClass(/hide-left hide-right/);
  await page.getByRole('button', { name: 'Journal', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Journal' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('region', { name: 'Journal' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Tâches' })).toBeHidden();
});

test('panneaux : replier l’écriture garde le journal et les tâches', async ({ page }) => {
  await page.getByRole('button', { name: 'Écriture', exact: true }).click();
  await expect(page.locator('.columns')).toHaveClass(/hide-center/);
  await expect(page.getByRole('button', { name: 'Écriture', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('region', { name: 'Journal' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Tâches' })).toBeVisible();
  await expect(page.getByRole('separator')).toHaveCount(0);
  await page.getByRole('button', { name: 'Écriture', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Entrée' })).toBeVisible();
  await page.getByRole('button', { name: 'Écriture', exact: true }).click();
  await page.reload();
  await expect(page.locator('.columns')).toHaveClass(/hide-center/);
  await expect(page.getByRole('region', { name: 'Journal' })).toBeVisible();
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
