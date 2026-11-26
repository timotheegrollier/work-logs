import { expect, test, type Page } from '@playwright/test';

const createdIds: string[] = [];
test.afterEach(async ({ request }) => {
  for (const id of createdIds.splice(0)) await request.delete(`/api/entries/${id}`);
});

/** Bits : Journal, Écriture (interrupteurs de l'en-tête), puis la liste Tâches dans la colonne Journal (§102). */
async function showPanels(page: Page, mask: number) {
  const toggle = (name: string) => page.getByRole('group', { name: 'Panneaux latéraux' }).getByRole('button', { name, exact: true });
  // La bascule vit dans la colonne Journal : la montrer, choisir la liste, puis replier selon le masque.
  if (await toggle('Journal').getAttribute('aria-pressed') !== 'true') await toggle('Journal').click();
  await page.getByRole('group', { name: 'Notes ou tâches' })
    .getByRole('button', mask & 4 ? { name: /^Tâches/ } : { name: 'Notes', exact: true }).click();
  for (const [index, name] of ['Journal', 'Écriture'].entries()) {
    if ((await toggle(name).getAttribute('aria-pressed') === 'true') !== Boolean(mask & (1 << index))) {
      await toggle(name).click();
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
    await page.addInitScript(([id, github]) => {
      localStorage.setItem('worklogs-entry', id);
      localStorage.setItem('worklogs-show-procedures', '1');
      // La colonne GitHub (§101) s'ajoute au cas le plus chargé : document, tâches et procédures.
      localStorage.setItem('worklogs-show-github', github ? '1' : '0');
    }, [document.id, mode === 'google-tasks'] as const);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    const sidebar = page.locator('#workspace-procedures');
    await expect(sidebar.locator('.entry-title')).toContainText(title);
    await expect(page.getByRole('textbox', { name: 'Contenu du document' })).toBeVisible();

    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 1000 });
      // Les huit combinaisons des autres panneaux et de la bascule Notes | Tâches : une
      // assertion de visibilité seule ne détectait pas une sidebar de seulement huit pixels.
      for (let mask = 7; mask >= 0; mask--) {
        await test.step(`${width}px, panneaux ${mask.toString(2).padStart(3, '0')}`, async () => {
          await showPanels(page, mask);
          const visible = [Boolean(mask & 1) && !(mask & 4), Boolean(mask & 2), Boolean(mask & 1) && Boolean(mask & 4)];
          for (const [index, id] of ['#journal-notes', '#workspace-editor', '#workspace-tasks'].entries()) {
            await expect(page.locator(id))[visible[index] ? 'toBeVisible' : 'toBeHidden']();
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
          if (mode === 'google-tasks') expect((await page.locator('#workspace-github').boundingBox())!.width).toBeGreaterThanOrEqual(120);
          for (const control of dimensions.controls) {
            expect(control.x).toBeGreaterThanOrEqual(dimensions.sidebar.x);
            expect(control.right).toBeLessThanOrEqual(dimensions.sidebar.right);
          }
          expect(dimensions.sidebar.right).toBeCloseTo(dimensions.columns.right, 0);
          for (const panel of dimensions.panels.slice(0, -1)) {
            expect(panel.right).toBeLessThanOrEqual(dimensions.sidebar.x + 1);
          }
          if (visible[1]) expect((await page.locator('#workspace-editor').boundingBox())!.width).toBeGreaterThanOrEqual(320);
          if (width === 1440 && mask === 7) {
            await page.screenshot({ path: testInfo.outputPath(`procedures-${mode}-${width}.png`), fullPage: true });
          }
        });
      }
    }
    // Téléphone : une vue à la fois (§53), choisie par la barre du bas ; les tâches sont
    // dans le Journal, derrière sa bascule (§102).
    await page.setViewportSize({ width: 412, height: 1000 });
    const fitsPage = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    for (const [name, id] of [['Journal', 'journal'], ['Écriture', 'editor'], ['Procédures', 'procedures']]) {
      await test.step(`412px, vue ${name}`, async () => {
        await page.getByRole('group', { name: 'Panneaux latéraux' }).getByRole('button', { name, exact: true }).click();
        for (const other of ['journal', 'editor', 'procedures']) {
          await expect(page.locator(`#workspace-${other}`))[other === id ? 'toBeVisible' : 'toBeHidden']();
        }
        expect(await fitsPage()).toBe(true);
      });
    }
    await test.step('412px, liste Tâches du Journal', async () => {
      await page.getByRole('group', { name: 'Panneaux latéraux' }).getByRole('button', { name: 'Journal', exact: true }).click();
      await page.getByRole('group', { name: 'Notes ou tâches' }).getByRole('button', { name: /^Tâches/ }).click();
      await expect(page.locator('#workspace-tasks')).toBeVisible();
      for (const other of ['#journal-notes', '#workspace-editor', '#workspace-procedures']) await expect(page.locator(other)).toBeHidden();
      expect(await fitsPage()).toBe(true);
    });
    // Les mesures qui suivent portent sur la vue Procédures.
    await page.getByRole('group', { name: 'Panneaux latéraux' }).getByRole('button', { name: 'Procédures', exact: true }).click();
    const phone = await sidebar.evaluate((procedures) => ({
      sidebar: procedures.getBoundingClientRect().toJSON(),
      fits: procedures.scrollWidth <= procedures.clientWidth,
      controls: [...procedures.querySelectorAll('button, a, label.file-button')].map((control) => control.getBoundingClientRect().toJSON()),
    }));
    expect(phone.fits).toBe(true);
    expect(phone.sidebar.width).toBeCloseTo(412, 0);
    for (const control of phone.controls) {
      expect(control.x).toBeGreaterThanOrEqual(phone.sidebar.x);
      expect(control.right).toBeLessThanOrEqual(phone.sidebar.right);
    }
    await page.screenshot({ path: testInfo.outputPath(`procedures-${mode}-412.png`), fullPage: true });
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
