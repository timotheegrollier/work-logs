import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const rootVersion: string = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
).version;

test.use({ viewport: { width: 390, height: 844 } });

test('PWA installable : manifeste, icônes et service worker versionné', async ({ page, request }) => {
  const manifest = await (await request.get('/manifest.webmanifest')).json();
  expect(manifest.name).toBe('WorkLogs');
  expect(manifest.start_url).toBe('.');
  expect(manifest.display).toBe('standalone');
  const sizes = (manifest.icons as { sizes: string }[]).map((icon) => icon.sizes);
  expect(sizes).toContain('256x256');
  expect(sizes).toContain('512x512');
  for (const icon of manifest.icons as { src: string }[]) {
    expect(await (await request.get(icon.src)).ok()).toBe(true);
  }

  const sw = await request.get('/sw.js');
  expect(sw.ok()).toBe(true);
  const body = await sw.text();
  expect(body).toContain(`const VERSION = '${rootVersion}'`);
  expect(body).not.toContain('__WORKLOGS_VERSION__');

  await page.goto('/');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#0e1118');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', './manifest.webmanifest');
});

test('à 390 px les trois zones s’empilent en une page qui défile', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Journal' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Entrée' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Tâches' })).toBeVisible();
  // Modèle mobile : bloc unique à défilement, pas trois fenêtres fixes.
  const metrics = await page.evaluate(() => ({
    display: getComputedStyle(document.querySelector('.columns') as Element).display,
    overflow: getComputedStyle(document.querySelector('.columns') as Element).overflowY,
    center: getComputedStyle(document.querySelector('.center') as Element).overflowY,
    noHorizontalOverflow: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  }));
  expect(metrics).toEqual({ display: 'block', overflow: 'auto', center: 'visible', noHorizontalOverflow: true });
});
