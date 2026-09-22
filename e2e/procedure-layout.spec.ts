import { expect, test, type Page } from '@playwright/test';

const createdIds: string[] = [];
test.afterEach(async ({ request }) => {
  for (const id of createdIds.splice(0)) await request.delete(`/api/entries/${id}`);
});

async function showPanels(page: Page, mask: number) {
  for (const [index, name] of ['Journal', 'Écriture', 'Tâches'].entries()) {
    const toggle = page.getByRole('button', { name, exact: true });
    if ((await toggle.getAttribute('aria-pressed') === 'true') !== Boolean(mask & (1 << index))) {
      await toggle.click();
    }
  }
}

for (const mode of ['local', 'google', 'google-tasks'] as const) {
  test(`Procédures : largeur et panneaux repliables en mode ${mode}, du desktop au mobile`, async ({ page, request }, testInfo) => {
    const title = `Procédure-${'opérations'.repeat(12)}`;
    const procedure = await (await request.post('/api/entries', { data: {
      title, kind: 'procedure', content_md: 'Vérifier les documents associés.', entry_date: '2026-09-22',
    } })).json();
    const document = await (await request.post('/api/entries', { data: {
      title: 'Document de travail', entry_date: '2026-09-22',
      content_json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Document de contrôle.' }] }] },
    } })).json();
    createdIds.push(procedure.id, document.id);
    const upload = await request.post('/api/uploads', { multipart: {
      entry_id: procedure.id,
      file: { name: `${'document-associe-'.repeat(10)}.txt`, mimeType: 'text/plain', buffer: Buffer.from('Document de contrôle.') },
    } });
    expect(upload.ok()).toBe(true);

    // Le rendu Google utilise les vraies entrées locales avec les métadonnées du
    // fournisseur, sans dépendre d'un compte Google ou d'un appel externe.
    if (mode !== 'local') {
      const google = { google_document_id: 'layout-google', google_document_title: document.title,
        google_tab_id: 't.0', google_tab_title: 'Document', google_tab_order: 0, google_tab_depth: 0 };
      await page.route('**/api/state*', async route => {
        const response = await route.fetch(), state = await response.json();
        await route.fulfill({ json: { ...state, entries: state.entries.map((entry: { id: string }) =>
          entry.id === document.id ? { ...entry, ...google } : entry) } });
      });
      await page.route(`**/api/entries/${document.id}`, async route => {
        const response = await route.fetch(), entry = await response.json();
        await route.fulfill({ json: { ...entry, google_sync: {
          document_id: google.google_document_id, document_title: document.title, tab_id: 't.0', tab_title: 'Document',
          tabs: [{ ...document, ...google }], dirty: false, synced_at: '2026-09-22T09:00:00Z',
        } } });
      });
    }
    await page.addInitScript(id => {
      localStorage.setItem('worklogs-entry', id);
      localStorage.setItem('worklogs-show-procedures', '1');
    }, document.id);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    const sidebar = page.locator('#workspace-procedures');
    await expect(sidebar.locator('.entry-title')).toContainText(title);
    await expect(page.getByRole('textbox', { name: 'Contenu du document' })).toBeVisible();
    if (mode === 'google-tasks') await page.getByRole('button', { name: 'Afficher les tâches', exact: true }).click();

    for (const width of [1440, 1024, 412]) {
      await page.setViewportSize({ width, height: 1000 });
      // Les huit combinaisons des trois autres panneaux : une assertion de
      // visibilité seule ne détectait pas une sidebar de seulement huit pixels.
      for (let mask = 7; mask >= 0; mask--) {
        await test.step(`${width}px, panneaux ${mask.toString(2).padStart(3, '0')}`, async () => {
          await showPanels(page, mask);
          const visible = [Boolean(mask & 1), Boolean(mask & 2), Boolean(mask & 4) && mode !== 'google'];
          for (const [index, id] of ['journal', 'editor', 'tasks'].entries()) {
            await expect(page.locator(`#workspace-${id}`))[visible[index] ? 'toBeVisible' : 'toBeHidden']();
          }
          const dimensions = await page.locator('.columns').evaluate(columns => {
            const procedures = document.querySelector('#workspace-procedures')!;
            const rect = (element: Element) => {
              const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
              return { x, y, width, height, right, bottom };
            };
            return {
              columns: rect(columns), sidebar: rect(procedures),
              fits: columns.scrollWidth <= columns.clientWidth && procedures.scrollWidth <= procedures.clientWidth,
              pageFits: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
              panels: [...columns.querySelectorAll(':scope > aside, :scope > main')]
                .filter(element => getComputedStyle(element).display !== 'none').map(rect),
              controls: [...procedures.querySelectorAll('button, a, label.file-button')].map(rect),
            };
          });
          expect(dimensions.fits).toBe(true);
          expect(dimensions.pageFits).toBe(true);
          expect(dimensions.sidebar.width).toBeGreaterThanOrEqual(260);
          for (const control of dimensions.controls) {
            expect(control.x).toBeGreaterThanOrEqual(dimensions.sidebar.x);
            expect(control.right).toBeLessThanOrEqual(dimensions.sidebar.right);
          }
          if (width > 900) {
            expect(dimensions.sidebar.right).toBeCloseTo(dimensions.columns.right, 0);
            for (const panel of dimensions.panels.slice(0, -1)) {
              expect(panel.right).toBeLessThanOrEqual(dimensions.sidebar.x + 1);
            }
            if (visible[1]) expect((await page.locator('#workspace-editor').boundingBox())!.width).toBeGreaterThanOrEqual(320);
          } else {
            for (let index = 1; index < dimensions.panels.length; index++) {
              expect(dimensions.panels[index].y).toBeGreaterThanOrEqual(dimensions.panels[index - 1].bottom);
            }
          }
          if ((width === 1440 && mask === 7) || (width === 412 && mask === 0)) {
            await page.screenshot({ path: testInfo.outputPath(`procedures-${mode}-${width}.png`), fullPage: true });
          }
        });
      }
    }
    // Même le nom de fichier sans espaces et les actions du dialogue tiennent
    // sur mobile lorsque le document s'ouvre depuis la sidebar.
    await sidebar.getByRole('button', { name: /^Consulter / }).click();
    const viewer = page.getByRole('dialog', { name: /^Aperçu de / });
    await expect(viewer).toBeVisible();
    expect(await viewer.evaluate(dialog => {
      const boundary = dialog.getBoundingClientRect();
      return dialog.scrollWidth <= dialog.clientWidth && [...dialog.querySelectorAll('.viewer-heading button, .viewer-heading a')]
        .every(control => { const box = control.getBoundingClientRect(); return box.x >= boundary.x && box.right <= boundary.right; });
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`procedure-preview-${mode}-mobile.png`), fullPage: true });
    await viewer.getByRole('button', { name: 'Fermer', exact: true }).click();
  });
}
