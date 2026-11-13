import { expect, test, type Locator } from '@playwright/test';

async function fieldsFit(form: Locator) {
  const widths = await form.evaluate(element => {
    const formBox = element.getBoundingClientRect();
    const fields = [...element.querySelectorAll('input, button, progress')].map(field => {
      const { left, right, width } = field.getBoundingClientRect();
      return { left, right, width };
    });
    return { left: formBox.left, right: formBox.right, fields };
  });
  expect(widths.fields).toHaveLength(3);
  for (const field of widths.fields) {
    expect(field.width).toBeGreaterThan(0);
    expect(field.left).toBeGreaterThanOrEqual(widths.left - 1);
    expect(field.right).toBeLessThanOrEqual(widths.right + 1);
  }
}

test('modifier l’avancement de la note fonctionne du panneau étroit au téléphone', async ({ page, request }) => {
  const response = await request.post('/api/entries', { data: { title: 'Vérifier la jauge', content_md: 'Mettre la jauge à jour.' } });
  expect(response.ok()).toBeTruthy();
  const note = await response.json();
  try {
    await page.addInitScript((id) => localStorage.setItem('worklogs-entry', id), note.id);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    const editor = page.getByRole('region', { name: 'Entrée', exact: true });
    await editor.getByRole('button', { name: 'Suivre comme tâche', exact: true }).click();
    const form = editor.locator('.task-progress-form');
    const field = form.getByLabel('Avancement (%)');
    const editorBar = form.getByRole('progressbar');
    const board = page.getByRole('region', { name: 'Tâches', exact: true });
    const cardBar = board.getByRole('progressbar', { name: 'Avancement de Vérifier la jauge' });
    await field.fill('65');
    await field.press('Enter');
    await expect(editorBar).toHaveAttribute('value', '65');
    await expect(cardBar).toHaveAttribute('value', '65');

    await page.getByRole('separator', { name: 'Redimensionner la colonne de gauche' }).press('End');
    await page.getByRole('separator', { name: 'Redimensionner la colonne de droite' }).press('End');
    await fieldsFit(form);
    await page.setViewportSize({ width: 320, height: 900 });
    const nav = page.getByRole('group', { name: 'Panneaux latéraux' });
    await nav.getByRole('button', { name: 'Tâches', exact: true }).click();
    await board.getByRole('button', { name: 'Vérifier la jauge', exact: true }).click();
    await expect(nav.getByRole('button', { name: 'Écriture', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await fieldsFit(form);
    await expect(field).toHaveValue('65');
    await expect(editor.getByText('Mettre la jauge à jour.')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  } finally {
    await request.delete(`/api/entries/${note.id}`);
  }
});

test('les réglages d’une suggestion IA restent utilisables dans une note étroite', async ({ page, request }) => {
  const response = await request.post('/api/tasks', { data: { title: 'Contrôle de la suggestion IA' } });
  expect(response.ok()).toBeTruthy();
  const task = await response.json();
  try {
    await page.addInitScript((id) => {
      localStorage.setItem('worklogs-ai-key', 'cle-e2e');
      localStorage.setItem('worklogs-entry', id);
    }, task.entry_id);
    await page.route('**/chat/completions', async route => {
      const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      await route.fulfill({ headers, json: { choices: [{ message: { content: 'Vérifier le dossier\nAppeler le client' } }] } });
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    const editor = page.getByRole('region', { name: 'Entrée', exact: true });
    await editor.getByRole('button', { name: 'Assistance IA', exact: true }).click();
    await editor.getByRole('menuitem', { name: 'Suggérer des sous-tâches', exact: true }).click();
    await expect(editor.getByRole('article', { name: 'Aperçu' })).toContainText('Vérifier le dossier');
    const refinement = editor.locator('.ai-refinement');
    await expect(refinement.getByLabel('Ajuster la proposition')).toBeVisible();
    await page.getByRole('separator', { name: 'Redimensionner la colonne de gauche' }).press('End');
    await page.getByRole('separator', { name: 'Redimensionner la colonne de droite' }).press('End');
    const dimensions = await refinement.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, controls: [...element.querySelectorAll('input, button')].map(control => {
        const { left, right, width } = control.getBoundingClientRect();
        return { left, right, width, name: control.getAttribute('placeholder') ?? control.textContent?.trim() };
      }) };
    });
    expect(dimensions.controls.length).toBe(4);
    for (const control of dimensions.controls) {
      expect(control.width, control.name).toBeGreaterThan(0);
      expect(control.left, control.name).toBeGreaterThanOrEqual(dimensions.left - 1);
      expect(control.right, control.name).toBeLessThanOrEqual(dimensions.right + 1);
    }
  } finally {
    await request.delete(`/api/entries/${task.entry_id}`);
  }
});
