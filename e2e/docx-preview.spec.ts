import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test('un .docx joint se lit dans l’aperçu, sans quitter l’app', async ({ page, request }, testInfo) => {
  const entry = await (await request.post('/api/entries', { data: { title: 'Étiqueteuse', entry_date: '2026-09-24' } })).json();
  try {
    await page.goto('/');
    await page.getByRole('region', { name: 'Journal' }).getByText('Étiqueteuse', { exact: true }).click();
    await page.getByLabel('Joindre un fichier', { exact: true }).setInputFiles({
      name: 'Changer format balance etiqueteuse.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: fs.readFileSync(path.resolve('web/src/__fixtures__/procedure.docx')),
    });
    await page.getByRole('button', { name: 'Aperçu de Changer format balance etiqueteuse.docx' }).click();
    const doc = page.getByRole('article', { name: 'Contenu de Changer format balance etiqueteuse.docx' });
    await expect(doc.getByRole('heading', { level: 1 })).toHaveText('Changer le format de la balance');
    // Numérotation continue autour de la sous-liste : « Valider » est bien le 3e.
    await expect(doc.locator('ol > li')).toHaveCount(3);
    await expect(doc.locator('ol > li ul > li')).toHaveText(['60 x 40 mm', '80 x 50 mm']);
    await expect(doc.getByRole('img', { name: 'schéma' })).toBeVisible();
    await expect(doc.locator('table td')).toHaveCount(4);
    await page.screenshot({ path: testInfo.outputPath('docx-sombre.png') });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.screenshot({ path: testInfo.outputPath('docx-clair.png') });
    await page.setViewportSize({ width: 412, height: 900 });
    await page.screenshot({ path: testInfo.outputPath('docx-mobile.png') });
  } finally {
    await request.delete(`/api/entries/${entry.id}`);
  }
});
