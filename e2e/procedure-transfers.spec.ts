import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test('les procédures copient leurs pièces vers le dossier lié, joignent depuis ses sous-dossiers et téléchargent sur le PC', async ({ page, request }) => {
  const project = await (await request.post('/api/projects', { data: { name: 'Transferts de procédures' } })).json();
  const dir = `transferts-${project.id}`;
  const share = path.resolve('.e2e-share', dir);
  const uploaded = Buffer.from([0, 128, 255, 10, 13, 7]);
  const remote = Buffer.from('Mesure relevée sur le serveur.\r\n', 'utf8');
  fs.mkdirSync(path.join(share, 'Mesures'), { recursive: true });
  fs.writeFileSync(path.join(share, 'Mesures', 'relevé.txt'), remote);
  fs.writeFileSync(path.join(share, 'consignes.md'), '# Consignes du serveur');
  await request.put(`/api/projects/${project.id}`, { data: { shared_dir: dir } });
  const entry = await (await request.post('/api/entries', { data: {
    title: 'Contrôle du circuit', kind: 'procedure', project_id: project.id, content_md: 'Vérifier la pression.',
  } })).json();
  try {
    await page.addInitScript(({ projectId, entryId }) => {
      localStorage.setItem('worklogs-project', projectId);
      localStorage.setItem('worklogs-entry', entryId);
      localStorage.setItem('worklogs-show-procedures', '1');
    }, { projectId: project.id, entryId: entry.id });
    await page.goto('/');
    await expect(page.getByLabel('Titre de l’entrée')).toHaveValue(entry.title);
    const panel = page.getByRole('region', { name: 'Procédures du projet', exact: true });
    const editor = page.getByRole('region', { name: 'Entrée', exact: true });
    await panel.getByLabel(`Joindre un fichier à ${entry.title}`).setInputFiles({ name: 'capture.bin', mimeType: 'application/octet-stream', buffer: uploaded });
    await expect(panel.getByRole('button', { name: 'Consulter capture.bin', exact: true })).toBeVisible();

    const copy = panel.getByRole('button', { name: 'Copier capture.bin vers le dossier lié', exact: true });
    await copy.click();
    await expect(panel.getByText('Copié dans le dossier lié.', { exact: true })).toBeVisible();
    expect(fs.readFileSync(path.join(share, 'capture.bin'))).toEqual(uploaded);
    await copy.click();
    await expect(panel.getByRole('alert')).toContainText('existe');
    expect(fs.readFileSync(path.join(share, 'capture.bin'))).toEqual(uploaded);

    await panel.getByRole('button', { name: `Joindre depuis le dossier lié à ${entry.title}`, exact: true }).click();
    const picker = panel.getByRole('region', { name: `Fichiers du dossier lié à ${entry.title}`, exact: true });
    await picker.getByRole('button', { name: 'Ouvrir le dossier Mesures', exact: true }).click();
    await picker.getByRole('button', { name: `Joindre relevé.txt à ${entry.title}`, exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Consulter relevé.txt', exact: true })).toBeVisible();
    await expect(editor.getByRole('button', { name: 'Aperçu de relevé.txt', exact: true })).toBeVisible();
    expect(fs.readFileSync(path.join(share, 'Mesures', 'relevé.txt'))).toEqual(remote);

    await editor.getByRole('button', { name: 'Copier relevé.txt vers le dossier lié', exact: true }).click();
    await expect(editor.getByText('Copié dans le dossier lié.', { exact: true })).toBeVisible();
    expect(fs.readFileSync(path.join(share, 'relevé.txt'))).toEqual(remote);

    await editor.getByRole('button', { name: `Joindre depuis le dossier lié à ${entry.title}`, exact: true }).click();
    await editor.getByRole('button', { name: `Joindre consignes.md à ${entry.title}`, exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Consulter consignes.md', exact: true })).toBeVisible();

    const download = page.waitForEvent('download');
    await panel.getByRole('link', { name: 'Télécharger capture.bin', exact: true }).click();
    const saved = await download;
    expect(saved.suggestedFilename()).toBe('capture.bin');
    expect(fs.readFileSync((await saved.path())!)).toEqual(uploaded);
    const persisted = await (await request.get(`/api/entries/${entry.id}`)).json();
    expect(persisted.attachments.map((file) => file.filename).sort()).toEqual(['capture.bin', 'consignes.md', 'relevé.txt']);
  } finally {
    await page.goto('about:blank');
    await request.delete(`/api/entries/${entry.id}`);
    await request.delete(`/api/projects/${project.id}`);
    fs.rmSync(share, { recursive: true, force: true });
  }
});
