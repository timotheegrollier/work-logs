import { expect, test } from '@playwright/test';
import type { AppState, GithubList } from '../web/src/lib';

const projectName = 'Intégration GitHub E2E';
const repo = 'worklogs-fixtures/repository-with-a-long-name-for-the-github-panel';
const url = `https://github.com/${repo}/pull/42`;
const pullTitle = '#42 Déploiement de la recette';
const filePath = 'api/src/deployment/a-very-long-file-name-for-the-github-panel.ts';
const pullList: GithubList = {
  repo,
  section: 'pulls',
  items: [
    {
      id: '42', number: 42, title: 'Déploiement de la recette', url,
      state: 'ouverte', status: 'open', author: 'lea-reviewer', date: '2026-11-26T10:00:00Z',
      ref: 'feature/prepare-deployment-with-a-very-long-branch-name', baseRef: 'main',
      labels: [{ name: 'automatisation', color: '0969da' }],
      changedFiles: 1, additions: 12, deletions: 3, checksStatus: 'success', reviewDecision: 'approved',
    },
    {
      id: '41', number: 41, title: 'Prépare les données', url: `https://github.com/${repo}/pull/41`,
      state: 'fusionnée', status: 'merged', author: 'camille', date: '2026-11-25T10:00:00Z', ref: 'fixture',
    },
  ],
};

test('GitHub : filtre une PR, consulte ses vérifications et suit sa note dans une colonne redimensionnable', async ({ page, request, context }) => {
  const created = await request.post('/api/projects', { data: { name: projectName, github_repo: repo } });
  expect(created.ok()).toBe(true);
  const { id } = await created.json();

  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.route(`**/api/projects/${id}/github/pulls`, (route) => route.fulfill({ json: pullList }));
    let detailRequests = 0;
    await page.route(`**/api/projects/${id}/github/pulls/42`, (route) => {
      detailRequests++;
      return route.fulfill({ json: {
        body: 'Vérifier le déploiement avant la mise en production.',
        checks: [{ name: 'Validation de la recette', status: 'success', url: `https://github.com/${repo}/actions/runs/21` }],
        reviews: [{ author: 'camille', state: 'approved', date: '2026-11-26T10:30:00Z', url: null }],
        files: [{ path: filePath, status: 'modified', additions: 12, deletions: 3 }],
        checksCount: 1, reviewsCount: 1, filesCount: 1,
      } });
    });
    await page.addInitScript(() => {
      localStorage.setItem('worklogs-show-procedures', '0');
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await page.getByRole('group', { name: 'Filtrer par projet' }).getByRole('button', { name: projectName }).click();
    await page.getByRole('group', { name: 'Panneaux latéraux' }).getByRole('button', { name: 'GitHub', exact: true }).click();

    const panel = page.getByRole('region', { name: `GitHub du projet ${projectName}` });
    const open = panel.getByRole('link', { name: pullTitle });
    const merged = panel.getByRole('link', { name: '#41 Prépare les données' });
    const filter = panel.getByRole('combobox', { name: 'Filtrer par état' });
    const search = panel.getByRole('searchbox', { name: 'Rechercher dans Pull requests' });
    await expect(open).toHaveAttribute('href', url);
    expect(detailRequests).toBe(0);

    await filter.selectOption('merged');
    await expect(merged).toBeVisible();
    await expect(open).toHaveCount(0);
    await filter.selectOption('');
    await search.fill('DEPLOIEMENT');
    await expect(open).toBeVisible();
    await expect(merged).toHaveCount(0);
    await expect(panel.getByText('1/2 résultat', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: `Copier le lien de ${pullTitle}` }).click();
    await expect(panel.getByText('Lien copié.', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);

    const details = panel.getByRole('button', { name: `Détails de ${pullTitle}` });
    await details.click();
    await expect(details).toHaveAttribute('aria-expanded', 'true');
    await expect(panel.getByRole('link', { name: 'Validation de la recette' })).toBeVisible();
    await expect(panel.getByText(filePath, { exact: true })).toBeVisible();
    expect(detailRequests).toBe(1);

    const edge = page.getByRole('separator', { name: 'Redimensionner la colonne GitHub' });
    const sidebar = page.locator('#workspace-github');
    await edge.press('Home');
    await expect(sidebar).toHaveCSS('width', '120px');
    await page.getByRole('button', { name: 'Changer de thème' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(panel.getByRole('button', { name: 'Releases' })).toBeVisible();
    const layout = await panel.evaluate((element) => {
      const { left, right } = element.getBoundingClientRect();
      return {
        fitsDocument: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        fitsPanel: element.scrollWidth <= element.clientWidth,
        controlsInside: [...element.querySelectorAll('button, a, input, select')]
          .filter((control) => control.getClientRects().length > 0)
          .every((control) => {
            const bounds = control.getBoundingClientRect();
            return bounds.left >= left - 1 && bounds.right <= right + 1;
          }),
      };
    });
    expect(layout).toEqual({ fitsDocument: true, fitsPanel: true, controlsInside: true });
    await edge.press('End');
    await expect(sidebar).toHaveCSS('width', '600px');

    const taskResponse = page.waitForResponse((response) => (
      response.url().endsWith('/api/tasks') && response.request().method() === 'POST'
    ));
    await panel.getByRole('button', { name: `Suivre ${pullTitle} comme tâche` }).click();
    const task = await taskResponse;
    expect(task.ok()).toBe(true);
    const { entry_id } = await task.json();
    await expect(page.getByLabel('Titre de l’entrée')).toHaveValue(pullTitle);
    const entry = await (await request.get(`/api/entries/${entry_id}`)).json();
    expect(entry.content_md).toBe(`[${pullTitle}](${url})`);
    await expect(panel.getByRole('button', { name: `Ouvrir la tâche ${pullTitle}` })).toBeVisible();
  } finally {
    const state: AppState = await (await request.get('/api/state')).json();
    for (const task of state.tasks.filter((task) => task.project_id === id)) {
      if (task.entry_id) await request.delete(`/api/entries/${task.entry_id}`);
      else await request.delete(`/api/tasks/${task.id}`);
    }
    await request.delete(`/api/projects/${id}`);
  }
});
