import { expect, test, type Locator, type Page } from '@playwright/test';

/** Écriture au plus étroit, fenêtre inchangée : sans colonne Tâches (§102), le journal et les procédures élargis. */
async function narrowEditor(page: Page) {
  await page.getByRole('group', { name: 'Panneaux latéraux' }).getByRole('button', { name: 'Procédures', exact: true }).click();
  await page.getByRole('separator', { name: 'Redimensionner la colonne de gauche' }).press('End');
  await page.getByRole('separator', { name: 'Redimensionner la colonne des procédures' }).press('End');
}

async function fieldsFit(form: Locator) {
  const widths = await form.evaluate(element => {
    const formBox = element.getBoundingClientRect();
    const fields = [...element.querySelectorAll('select, button, progress')].map(field => {
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

test('cocher les sous-tâches actualise les jauges du panneau étroit au téléphone', async ({ page, request }) => {
  const response = await request.post('/api/entries', { data: { title: 'Vérifier la jauge', content_md: '- [ ] Mettre la jauge à jour.\n- [ ] Vérifier la mesure.' } });
  expect(response.ok()).toBeTruthy();
  const note = await response.json();
  try {
    await page.addInitScript((id) => localStorage.setItem('worklogs-entry', id), note.id);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    const editor = page.getByRole('region', { name: 'Entrée', exact: true });
    await editor.getByRole('button', { name: 'Suivre comme tâche', exact: true }).click();
    const tracker = editor.getByRole('region', { name: 'Suivi de tâche' });
    const editorBar = tracker.getByRole('progressbar');
    const boxes = editor.getByRole('article', { name: 'Aperçu' }).getByRole('checkbox');
    const board = page.getByRole('region', { name: 'Tâches', exact: true });
    const cardBar = board.getByRole('progressbar', { name: 'Avancement de Vérifier la jauge' });
    // La carte est dans la liste Tâches de la colonne de gauche (§102).
    await page.getByRole('group', { name: 'Notes ou tâches' }).getByRole('button', { name: /^Tâches/ }).click();
    await expect(editorBar).toHaveAttribute('value', '0');
    await expect(cardBar).toHaveAttribute('value', '0');
    await boxes.first().click();
    await expect(editorBar).toHaveAttribute('value', '50');
    await expect(cardBar).toHaveAttribute('value', '50');

    await narrowEditor(page);
    await fieldsFit(tracker);
    await page.setViewportSize({ width: 320, height: 900 });
    const nav = page.getByRole('group', { name: 'Panneaux latéraux' });
    // Téléphone : le Journal, resté sur sa liste Tâches.
    await nav.getByRole('button', { name: 'Journal', exact: true }).click();
    await board.getByRole('button', { name: 'Vérifier la jauge', exact: true }).click();
    await expect(nav.getByRole('button', { name: 'Écriture', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await fieldsFit(tracker);
    await expect(boxes.first()).toBeChecked();
    await boxes.last().click();
    await expect(editorBar).toHaveAttribute('value', '100');
    await expect(tracker.getByLabel('Statut de la tâche')).toHaveValue('doing');
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
    await narrowEditor(page);
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
