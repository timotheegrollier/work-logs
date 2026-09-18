import { expect, test, type Page } from '@playwright/test';

const handle = (page: Page, side: 'gauche' | 'droite') =>
  page.getByRole('separator', { name: `Redimensionner la colonne de ${side}` });

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
  await expect(page.getByLabel('Largeur de la colonne de gauche (px)')).toHaveValue('380');
  await page.mouse.up();
  await page.mouse.move(700, 400);
  await expect(page.locator('.left')).toHaveCSS('width', '380px');

  await drag(page, 'droite', -100);
  await expect(page.locator('.right')).toHaveCSS('width', '420px');
  await expect(page.getByLabel('Largeur de la colonne de droite (px)')).toHaveValue('420');
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
  await expect(page.locator('.column-resizer.is-dragging')).toHaveCount(0);

  await page.reload();
  await expect(page.locator('.left')).toHaveCSS('width', '380px');
  await expect(page.locator('.right')).toHaveCSS('width', '420px');
  await page.screenshot({ path: testInfo.outputPath('sidebar-widths.png') });
  await page.getByRole('button', { name: 'Largeurs par défaut' }).click();
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
  await page.getByRole('button', { name: 'Journal' }).click();
  await expect(page.getByRole('region', { name: 'Journal' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Journal' })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Tâches' }).click();
  await expect(page.getByRole('region', { name: 'Tâches' })).toBeHidden();
  await expect(page.getByRole('region', { name: 'Entrée' })).toBeVisible();
  await expect(page.locator('.columns')).toHaveClass(/hide-left hide-right/);
  await page.getByRole('button', { name: 'Journal' }).click();
  await expect(page.getByRole('region', { name: 'Journal' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('region', { name: 'Journal' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Tâches' })).toBeHidden();
});

test('panneaux : replier l’écriture garde le journal et les tâches', async ({ page }) => {
  await page.getByRole('button', { name: 'Écriture' }).click();
  await expect(page.locator('.columns')).toHaveClass(/hide-center/);
  await expect(page.getByRole('button', { name: 'Écriture' })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('region', { name: 'Journal' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Tâches' })).toBeVisible();
  await expect(page.getByRole('separator')).toHaveCount(0);
  await page.getByRole('button', { name: 'Écriture' }).click();
  await expect(page.getByRole('region', { name: 'Entrée' })).toBeVisible();
  await page.getByRole('button', { name: 'Écriture' }).click();
  await page.reload();
  await expect(page.locator('.columns')).toHaveClass(/hide-center/);
  await expect(page.getByRole('region', { name: 'Journal' })).toBeVisible();
});
