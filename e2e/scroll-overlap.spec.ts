import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { WORD_BODY, wordDocx } from '../web/src/test/docx-fixture';

// « Quand je fais défiler les tâches, la saisie "Nouvelle tâche" et l'intitulé
// "En cours" passent devant la liste » (desktop comme mobile). Ils étaient
// collants, les cartes défilaient dessous et dépassaient autour. Même défaut
// relevé sur les jours du journal et, sur mobile, sur les barres d'outils des
// documents (à moitié sous le bandeau projets). Plus rien ne passe devant.

const share = path.resolve('.e2e-share');
let created: { tasks: string[]; entries: string[] } = { tasks: [], entries: [] };

test.beforeEach(async ({ request }) => {
  created = { tasks: [], entries: [] };
  for (let i = 1; i <= 14; i++) {
    const task = await (await request.post('/api/tasks', { data: { title: `Contrôle ${i} du parc` } })).json();
    created.tasks.push(task.id);
    const entry = await (await request.post('/api/entries', {
      data: { title: `Relevé ${i}`, entry_date: `2025-02-${String(i).padStart(2, '0')}`, content_md: 'Notes du jour.' },
    })).json();
    created.entries.push(entry.id);
  }
});
test.afterEach(async ({ request }) => {
  await cleanup(request);
});

async function cleanup(request: APIRequestContext) {
  for (const id of created.tasks) await request.delete(`/api/tasks/${id}`);
  for (const id of created.entries) await request.delete(`/api/entries/${id}`);
}

/** Ce qui est réellement peint en (x, y) appartient-il à `owner` ? */
const paintedBy = (page: Page, owner: Locator, x: number, y: number) =>
  owner.evaluate((el, [px, py]) => el.contains(document.elementFromPoint(px, py)), [x, y]);

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('tâches : la saisie reste en tête, la liste défile dessous sans jamais passer devant', async ({ page }) => {
    await page.goto('/');
    const board = page.getByRole('region', { name: 'Tâches' });
    await expect(board.getByText('Contrôle 14 du parc')).toBeAttached();
    const quick = board.locator('.quick');
    const lists = board.locator('.board-lists');
    expect(await lists.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

    const quickBefore = (await quick.boundingBox())!;
    const doing = board.getByRole('heading', { name: /En cours/ });
    const doingBefore = (await doing.boundingBox())!;
    await lists.evaluate((el) => el.scrollTo(0, 320));

    // La saisie ne bouge pas : c'est l'en-tête du panneau…
    const quickAfter = (await quick.boundingBox())!;
    expect(quickAfter.y).toBeCloseTo(quickBefore.y, 0);
    // …la liste commence sous elle, et l'intitulé « En cours » défile avec ses cartes.
    expect((await lists.boundingBox())!.y).toBeGreaterThanOrEqual(quickAfter.y + quickAfter.height - 1);
    expect((await doing.boundingBox())!.y).toBeCloseTo(doingBefore.y - 320, 0);
    // Partout sur la bande de saisie, c'est elle qu'on voit, pas une carte.
    for (const fx of [0.05, 0.5, 0.95]) {
      for (const fy of [0.1, 0.5, 0.9]) {
        expect(await paintedBy(page, quick, quickAfter.x + quickAfter.width * fx, quickAfter.y + quickAfter.height * fy)).toBe(true);
      }
    }
    // Et rien de la liste ne colle : aucun intitulé de colonne ne reste en place.
    expect(await board.locator('.column h2').evaluateAll((all) => all.map((h) => getComputedStyle(h).position)))
      .not.toContain('sticky');
  });

  test('journal : les jours défilent avec leurs entrées au lieu de les masquer', async ({ page }) => {
    await page.goto('/');
    const journal = page.getByRole('region', { name: 'Journal' });
    await expect(journal.getByText('Relevé 14')).toBeAttached();
    const left = page.locator('.left');
    await left.evaluate((el) => el.scrollTo(0, 260));

    expect(await page.locator('.day').evaluateAll((all) => all.map((d) => getComputedStyle(d).position)))
      .not.toContain('sticky');
    // Chaque entrée visible se voit en entier : aucun libellé de jour par-dessus.
    const panel = (await left.boundingBox())!;
    for (const entry of await journal.locator('.entry').all()) {
      const box = await entry.boundingBox();
      if (!box || box.y < panel.y || box.y + box.height > panel.y + panel.height) continue;
      expect(await paintedBy(page, entry, box.x + box.width / 2, box.y + 8)).toBe(true);
    }
  });
});

test.describe('mobile', () => {
  test.use({ viewport: { width: 412, height: 860 }, hasTouch: true });

  test('tâches : saisie et intitulés suivent la page, rien ne reste collé sur les cartes', async ({ page }) => {
    await page.goto('/');
    const board = page.getByRole('region', { name: 'Tâches' });
    await expect(board.getByText('Contrôle 14 du parc')).toBeAttached();
    const app = page.locator('.app');
    const quick = board.locator('.quick');
    const top = await quick.evaluate((el) => {
      const app = document.querySelector('.app')!;
      return el.getBoundingClientRect().top + app.scrollTop;
    });
    await app.evaluate((el, y) => el.scrollTo(0, y), top + 500);

    // La saisie est partie avec la page (elle ne colle plus sous le bandeau)…
    expect((await quick.boundingBox())!.y + (await quick.boundingBox())!.height).toBeLessThan(0);
    // …et sous le bandeau projets, c'est la liste qu'on voit, pas un intitulé figé.
    const strip = (await page.locator('.project-strip').boundingBox())!;
    expect(await board.locator('.column h2').evaluateAll((all) => all.map((h) => getComputedStyle(h).position)))
      .not.toContain('sticky');
    expect(await paintedBy(page, board.locator('.board-lists'), 206, strip.y + strip.height + 20)).toBe(true);
  });

  test('document Word du partage : la barre d’outils reste dans le texte, pas à moitié sous le bandeau', async ({ page }) => {
    const para = (i: number) => `<w:p><w:r><w:t>Paragraphe ${i} de la procédure.</w:t></w:r></w:p>`;
    fs.writeFileSync(path.join(share, 'défilement.docx'), wordDocx({ body: WORD_BODY + Array.from({ length: 50 }, (_, i) => para(i + 1)).join('') }));
    try {
      await page.addInitScript(() => localStorage.setItem('worklogs-shared-path', 'défilement.docx'));
      await page.goto('/');
      const editor = page.getByRole('region', { name: 'Fichier partagé' });
      const toolbar = editor.locator('.docx-toolbar');
      await expect(toolbar).toBeVisible();
      await page.locator('.app').evaluate((el) => {
        const bar = document.querySelector('.docx-toolbar')!;
        el.scrollTo(0, bar.getBoundingClientRect().top + el.scrollTop + 600);
      });
      expect(await toolbar.evaluate((el) => getComputedStyle(el).position)).toBe('static');
      const strip = (await page.locator('.project-strip').boundingBox())!;
      // Partie avec le texte, au lieu de rester coincée sous le bandeau.
      expect((await toolbar.boundingBox())!.y + (await toolbar.boundingBox())!.height).toBeLessThan(0);
      expect(strip.y).toBeCloseTo(0, 0);
    } finally {
      fs.rmSync(path.join(share, 'défilement.docx'), { force: true });
    }
  });
});
