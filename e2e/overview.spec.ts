import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// La vue d'ensemble des projets : au centre, une voie par projet (§60). jsdom ne voit ni
// la largeur de la page ni la vue d'une tâche de téléphone : on les vérifie ici.
const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

test('une voie par projet qui tient en largeur, sur desktop comme sur téléphone', async ({ page, request }) => {
  const project = await post(request, '/api/projects', { name: 'Bassins vue', color: '#d9486e' });
  const other = await post(request, '/api/projects', { name: 'Compta vue', color: '#e0912a' });
  const tasks: { id: string }[] = [];
  try {
    for (let i = 0; i < 15; i++) tasks.push(await post(request, '/api/tasks', { title: `Étude ${i + 1}`, project_id: project.id, status: i === 0 ? 'doing' : 'todo' }));
    for (let i = 0; i < 3; i++) tasks.push(await post(request, '/api/tasks', { title: `Faite ${i + 1}`, project_id: project.id, status: 'done' }));
    tasks.push(await post(request, '/api/tasks', { title: 'Déclaration vue', project_id: other.id, due_date: '2020-01-01' }));

    // Tablette : la liste fusionnée ne doit pas occuper seulement un tiers du panneau.
    await page.setViewportSize({ width: 800, height: 1000 });
    await page.goto('/');
    const lists = page.locator('.board-lists.is-overview');
    const listBox = (await lists.boundingBox())!;
    const columnBox = (await lists.locator('.column').first().boundingBox())!;
    expect(columnBox.width).toBeGreaterThan(listBox.width * 0.9);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Vue d’ensemble', exact: true }).click();
    const overview = page.getByRole('region', { name: 'Vue d’ensemble des projets' });
    await expect(overview).toBeVisible();
    const lane = overview.getByRole('listitem', { name: /^Bassins vue :/ });
    await expect(lane.getByRole('listitem').or(lane).first()).toBeVisible();
    await expect(lane.locator('.lane-node')).toHaveCount(12);
    await expect(lane.getByText('+3')).toBeVisible();
    await expect(lane.getByText('3/18 · 17 %')).toBeVisible();
    await expect(lane.getByText('Étude 1', { exact: true })).toBeVisible();
    await expect(overview.getByRole('listitem', { name: /^Compta vue :/ }).locator('.lane-node.is-late')).toHaveCount(1);
    expect(await noHorizontalScroll(page)).toBe(true);
    // Les nœuds d'une voie restent sur sa ligne, dans la page.
    const box = (await lane.boundingBox())!;
    const main = (await page.locator('main.center').boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(main.x + main.width + 1);

    // Téléphone : la vue s'ouvre dans Écriture, en une colonne, sans débordement.
    await page.setViewportSize({ width: 412, height: 860 });
    await page.reload();
    const nav = (name: string) => page.getByRole('group', { name: 'Panneaux latéraux' }).getByRole('button', { name, exact: true });
    await nav('Tâches').click();
    await page.getByRole('button', { name: 'Vue d’ensemble', exact: true }).click();
    await expect(overview).toBeVisible();
    await expect(nav('Écriture')).toHaveAttribute('aria-pressed', 'true');
    expect(await noHorizontalScroll(page)).toBe(true);
    await lane.locator('.lane-node').first().click();
    await expect(nav('Tâches')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('region', { name: 'Tâches' }).getByRole('button', { name: 'Étude 1', exact: true })).toBeFocused();
  } finally {
    for (const task of tasks) await request.delete(`/api/tasks/${task.id}`);
    await request.delete(`/api/projects/${project.id}`);
    await request.delete(`/api/projects/${other.id}`);
  }
});

test.describe('tactile', () => {
  test.use({ hasTouch: true });
  test('le bouton pour mettre en cours reste visible sans survol', async ({ page, request }) => {
    const task = await post(request, '/api/tasks', { title: 'Tâche tactile vue' });
    try {
      await page.setViewportSize({ width: 412, height: 860 });
      await page.goto('/');
      await page.getByRole('group', { name: 'Panneaux latéraux' }).getByRole('button', { name: 'Tâches', exact: true }).click();
      const button = page.getByRole('button', { name: 'Mettre en cours Tâche tactile vue' });
      await expect(button).toBeVisible();
      await expect(button).toHaveCSS('opacity', '1');
    } finally {
      await request.delete(`/api/tasks/${task.id}`);
    }
  });
});
