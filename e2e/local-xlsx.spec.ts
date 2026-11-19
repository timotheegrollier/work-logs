import { expect, test } from '@playwright/test';
import { excelWorkbook } from '../web/src/test/xlsx-fixture';
import { readZip, readZipText } from '../web/src/zip';

test('une pièce Excel de procédure se lit et se modifie dans WorkLogs puis se retrouve après rechargement', async ({ page, request }) => {
  const original = excelWorkbook();
  const response = await request.post('/api/entries', { data: { title: 'Budget du contrôle', kind: 'procedure' } });
  expect(response.ok()).toBeTruthy();
  const entry = await response.json();
  const uploaded = await request.post('/api/uploads', { multipart: {
    entry_id: entry.id,
    file: { name: 'budget.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(original) },
  } });
  expect(uploaded.ok()).toBeTruthy();
  const source = await uploaded.json();
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Procédures', exact: true }).click();
    const procedures = page.getByRole('region', { name: 'Procédures du projet' });
    await procedures.getByRole('button', { name: 'Consulter budget.xlsx', exact: true }).click();
    const viewer = page.getByRole('dialog', { name: 'Aperçu de budget.xlsx', exact: true });
    await expect(viewer.getByRole('grid', { name: 'Feuille Suivi' })).toBeVisible();
    await expect(viewer.getByRole('button', { name: 'Enregistrer une copie modifiée' })).toBeDisabled();
    await viewer.getByRole('gridcell', { name: 'B3 : 100,00 €', exact: true }).click();
    await page.keyboard.type('250');
    await page.keyboard.press('Enter');
    await expect(viewer.getByRole('gridcell', { name: 'B3 : 250,00 €', exact: true })).toBeVisible();
    await page.keyboard.press('Control+s');
    const saved = page.getByRole('dialog', { name: 'Aperçu de budget - modifié.xlsx', exact: true });
    await expect(saved.getByRole('gridcell', { name: 'B3 : 250,00 €', exact: true })).toBeVisible();
    const attachments = (await (await request.get(`/api/entries/${entry.id}`)).json()).attachments;
    expect(attachments).toHaveLength(2);
    const copy = attachments.find((file) => file.filename === 'budget - modifié.xlsx');
    expect(copy).toBeTruthy();
    const unchanged = await (await request.get(`/api/files/${source.stored}`)).body();
    expect(unchanged.equals(Buffer.from(original))).toBeTruthy();
    const edited = new Uint8Array(await (await request.get(`/api/files/${copy.stored}`)).body());
    expect(await readZipText(readZip(edited), 'xl/worksheets/sheet1.xml')).toContain('<c r="B3" s="2"><v>250</v></c>');
    expect(await readZipText(readZip(edited), 'xl/styles.xml')).toBe(await readZipText(readZip(original), 'xl/styles.xml'));

    await saved.getByRole('button', { name: 'Fermer', exact: true }).click();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole('group', { name: 'Panneaux latéraux' }).getByRole('button', { name: 'Procédures', exact: true }).click();
    await procedures.getByRole('button', { name: 'Consulter budget - modifié.xlsx', exact: true }).click();
    await expect(saved.getByRole('gridcell', { name: 'B3 : 250,00 €', exact: true })).toBeVisible();
    expect(await saved.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBeTruthy();
    await saved.getByRole('button', { name: 'Fermer', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload();
    await procedures.getByRole('button', { name: 'Consulter budget - modifié.xlsx', exact: true }).click();
    await expect(saved.getByRole('gridcell', { name: 'B3 : 250,00 €', exact: true })).toBeVisible();
  } finally {
    await request.delete(`/api/entries/${entry.id}`);
  }
});
