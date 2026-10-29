import { expect, test, type Locator } from '@playwright/test';

async function fieldsFit(form: Locator) {
  const widths = await form.evaluate(element => {
    const card = element.closest('.card')!;
    const panel = element.closest('#workspace-tasks')!;
    const formBox = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const contentLeft = formBox.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
    const contentRight = formBox.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
    const cardBox = card.getBoundingClientRect();
    const panelBox = panel.getBoundingClientRect();
    const fields = [...element.querySelectorAll('input, textarea')].map(field => {
      const { left, right, width } = field.getBoundingClientRect();
      return { left, right, width };
    });
    const buttons = [...element.querySelectorAll('button')].map(button => {
      const { left, right } = button.getBoundingClientRect();
      return { left, right, name: button.textContent?.trim() };
    });
    return { formBox: { left: formBox.left, right: formBox.right }, contentLeft, contentRight, buttons,
      cardBox: { left: cardBox.left, right: cardBox.right },
      panelBox: { left: panelBox.left, right: panelBox.right }, fields };
  });
  expect(widths.fields.length).toBeGreaterThanOrEqual(2);
  expect(widths.formBox.left).toBeGreaterThanOrEqual(widths.cardBox.left - 1);
  expect(widths.formBox.right).toBeLessThanOrEqual(widths.cardBox.right + 1);
  expect(widths.cardBox.right).toBeLessThanOrEqual(widths.panelBox.right + 1);
  for (const field of widths.fields) {
    expect(field.width).toBeGreaterThan(0);
    expect(field.left).toBeCloseTo(widths.contentLeft, 0);
    expect(field.right).toBeCloseTo(widths.contentRight, 0);
  }
  for (const button of widths.buttons) {
    expect(button.left, button.name).toBeGreaterThanOrEqual(widths.contentLeft - 1);
    expect(button.right, button.name).toBeLessThanOrEqual(widths.contentRight + 1);
  }
  return (await form.getByLabel('Sous-tâches de l’entrée liée, une par ligne').boundingBox())!.width;
}

test('les champs de l’entrée liée suivent la largeur de leur panneau', async ({ page, request }) => {
  const response = await request.post('/api/tasks', { data: { title: 'Contrôle de la largeur des champs' } });
  expect(response.ok()).toBeTruthy();
  const task = await response.json();
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    const card = page.locator('.card').filter({ has: page.getByText('Contrôle de la largeur des champs', { exact: true }) });
    await card.getByRole('button', { name: 'Créer une entrée liée', exact: true }).click();
    const form = card.getByRole('form', { name: 'Créer une entrée liée à Contrôle de la largeur des champs' });
    const field = form.getByLabel('Sous-tâches de l’entrée liée, une par ligne');
    await field.fill('Sous-tâche à vérifier');
    const initial = await fieldsFit(form);
    const handle = page.getByRole('separator', { name: 'Redimensionner la colonne de droite' });
    await handle.focus();
    await handle.press('Home');
    const narrow = await fieldsFit(form);
    expect(narrow).toBeLessThan(initial);
    await handle.press('End');
    const wide = await fieldsFit(form);
    expect(wide).toBeGreaterThan(narrow);
    await page.getByRole('button', { name: 'Écriture', exact: true }).click();
    await fieldsFit(form);
    await page.getByRole('button', { name: 'Journal', exact: true }).click();
    await fieldsFit(form);
    await page.setViewportSize({ width: 412, height: 900 });
    // Téléphone : une vue à la fois (§53), la carte est dans Tâches.
    await page.getByRole('group', { name: 'Panneaux latéraux' }).getByRole('button', { name: 'Tâches', exact: true }).click();
    await fieldsFit(form);
    await expect(field).toHaveValue('Sous-tâche à vérifier');
  } finally {
    await request.delete(`/api/tasks/${task.id}`);
  }
});

test('les réglages d’une suggestion IA restent utilisables dans un panneau étroit', async ({ page, request }) => {
  const response = await request.post('/api/tasks', { data: { title: 'Contrôle de la suggestion IA' } });
  expect(response.ok()).toBeTruthy();
  const task = await response.json();
  try {
    await page.addInitScript(() => localStorage.setItem('worklogs-ai-key', 'cle-e2e'));
    await page.route('**/chat/completions', async route => {
      const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      await route.fulfill({ headers, json: { choices: [{ message: { content: 'Vérifier le dossier\nAppeler le client' } }] } });
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    const card = page.locator('.card').filter({ has: page.getByText('Contrôle de la suggestion IA', { exact: true }) });
    await card.getByRole('button', { name: 'Créer une entrée liée', exact: true }).click();
    const form = card.getByRole('form', { name: 'Créer une entrée liée à Contrôle de la suggestion IA' });
    await form.getByRole('button', { name: '✨ Suggérer', exact: true }).click();
    await expect(form.getByLabel('Sous-tâches de l’entrée liée, une par ligne')).toHaveValue('Vérifier le dossier\nAppeler le client');
    const refinement = form.locator('.ai-refinement');
    await expect(refinement.getByLabel('Ajuster la proposition')).toBeVisible();
    await page.getByRole('separator', { name: 'Redimensionner la colonne de droite' }).press('Home');
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
    await request.delete(`/api/tasks/${task.id}`);
  }
});
