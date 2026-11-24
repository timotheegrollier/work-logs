import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { seedData } from './test/server';
import { flushPendingSaves } from './autosave';
import { setLeaveGuard } from './shared-leave';
import { api as clientApi } from './lib';
import { useAppHarness, api, reopenApi, journal, board, filters, aiAction, row, aiBodies, mockAiSuggest } from './test/app-harness';

useAppHarness();

describe('dossier partagé', { timeout: 30_000 }, () => {
  // Le « partage » est un dossier temporaire : le test y joue le collègue du TSE.
  let share: string;
  const nodeFs = () => import('node:fs');
  const nodePath = () => import('node:path');
  const write = async (rel: string, contents: string | Uint8Array) => {
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.writeFileSync(path.join(share, rel), contents);
  };
  const read = async (rel: string, encoding: BufferEncoding = 'utf8') => {
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    return fs.readFileSync(path.join(share, rel), encoding);
  };
  const latin1 = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));
  /** Fichier `~$` qu'Excel laisse à côté d'un fichier ouvert (nom UTF-16 à l'octet 55). */
  const excelOwner = (name: string) => {
    const bytes = new Uint8Array(165).fill(0x20);
    bytes[0] = name.length;
    bytes[55] = name.length;
    bytes[56] = 0;
    [...name].forEach((char, i) => { bytes[57 + i * 2] = char.charCodeAt(0); bytes[58 + i * 2] = 0; });
    return bytes;
  };
  const partage = { timeout: 10_000 };
  const sharedEditor = () => screen.getByRole('region', { name: 'Fichier partagé' });
  /** L'arbre du partage, une fois lu. Ses boutons s'y cherchent : `getByRole` sur tout l'écran coûte cher dans jsdom. */
  const tree = async () => within(await screen.findByRole('list', { name: 'Contenu du dossier partagé' }, partage));
  const openFromTree = async (name: string) => {
    // Un fichier d'un dossier déplié attend en plus la liste de ce dossier.
    fireEvent.click(await (await tree()).findByRole('button', { name: new RegExp(`^Ouvrir ${name.replace(/[.()]/g, '\\$&')}`) }, partage));
    return screen.findByRole('region', { name: 'Fichier partagé' }, partage);
  };

  beforeEach(async () => {
    const [fs, os, path] = await Promise.all([nodeFs(), import('node:os'), nodePath()]);
    share = fs.mkdtempSync(path.join(os.tmpdir(), 'worklogs-share-front-'));
    await api.close();
    await reopenApi({ sharedRoot: share });
    // La section vit dans la colonne Procédures : elle ne lit le partage qu'affichée.
    localStorage.setItem('worklogs-show-procedures', '1');
  });
  afterEach(async () => {
    const fs = await nodeFs();
    fs.rmSync(share, { recursive: true, force: true });
  });

  test('un fichier choisi pendant l’attente de la vue d’ensemble reste au centre', async () => {
    await write('choisi.md', '# Fichier choisi');
    render(<App />);
    const file = await (await tree()).findByRole('button', { name: /^Ouvrir choisi\.md/ }, partage);
    let finish!: (ok: boolean) => void;
    let calls = 0;
    const removeGuard = setLeaveGuard(() => ++calls === 1 ? new Promise<boolean>((resolve) => { finish = resolve; }) : Promise.resolve(true));
    try {
      fireEvent.click(await screen.findByRole('button', { name: 'Vue d’ensemble des tâches' }));
      await waitFor(() => expect(calls).toBe(1));
      fireEvent.click(file);
      await screen.findByRole('region', { name: 'Fichier partagé' }, partage);
      await act(async () => finish(true));
      expect(screen.queryByRole('region', { name: 'Vue d’ensemble des projets' })).not.toBeInTheDocument();
      expect(sharedEditor()).toBeInTheDocument();
    } finally {
      removeGuard();
    }
  });

  test('colonne Procédures masquée : aucune lecture du partage', async () => {
    localStorage.setItem('worklogs-show-procedures', '0');
    const spy = vi.spyOn(clientApi, 'sharedStatus');
    render(<App />);
    await screen.findByRole('region', { name: 'Journal' });
    expect(spy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Procédures/ }));
    expect(await screen.findByText('Dossier partagé', undefined, partage)).toBeInTheDocument();
  });

  test('sans partage configuré, la section n’existe pas', async () => {
    await api.close();
    await reopenApi();
    render(<App />);
    await screen.findByRole('region', { name: 'Journal' });
    await waitFor(() => expect(screen.queryByText('Dossier partagé')).not.toBeInTheDocument());
  });

  test('un CSV d’Excel s’ouvre au centre ; il ne part sur le partage qu’au geste, ligne touchée seule', async () => {
    const original = 'Date;Mesure;Commentaire\r\n05/10/2026;12,5;"pH ; chlore"\r\n06/10/2026;0123;\r\n';
    await write('relevés.csv', latin1(original));
    render(<App />);
    expect(await screen.findByText('Dossier partagé', undefined, partage)).toBeInTheDocument();
    const editorRegion = await openFromTree('relevés.csv');

    const grid = await within(editorRegion).findByRole('grid', { name: 'Tableau relevés.csv' }, partage);
    fireEvent.click(within(grid).getByRole('gridcell', { name: 'C3 : vide' }));
    fireEvent.change(within(editorRegion).getByLabelText('Contenu de la cellule'), { target: { value: 'Filtre lavé' } });
    await waitFor(() => expect(within(editorRegion).getByText('Brouillon sur cet ordinateur')).toBeInTheDocument(), partage);
    expect(await read('relevés.csv', 'latin1')).toBe(original);

    fireEvent.click(within(editorRegion).getByRole('button', { name: 'Enregistrer sur le partage' }));
    await waitFor(() => expect(within(sharedEditor()).getByText('Enregistré sur le partage.')).toBeInTheDocument(), partage);
    expect(await read('relevés.csv', 'latin1')).toBe('Date;Mesure;Commentaire\r\n05/10/2026;12,5;"pH ; chlore"\r\n06/10/2026;0123;Filtre lavé\r\n');
    expect(within(sharedEditor()).getByText('À jour avec le partage')).toBeInTheDocument();
  });

  test('Ctrl+S envoie un fichier texte, encodage et fins de ligne gardés', async () => {
    await write('notes.md', '# Consignes\r\n\r\nLaver le filtre.\r\n');
    render(<App />);
    const editorRegion = await openFromTree('notes.md');
    const area = await within(editorRegion).findByLabelText('Contenu de notes.md', undefined, partage);
    expect(area).toHaveValue('# Consignes\n\nLaver le filtre.\n');
    fireEvent.change(area, { target: { value: '# Consignes\n\nLaver le filtre.\nContrôler le pH.\n' } });
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await waitFor(async () => expect(await read('notes.md')).toBe('# Consignes\r\n\r\nLaver le filtre.\r\nContrôler le pH.\r\n'), partage);
  });

  test('Ctrl+S derrière l’assistant ne publie pas le brouillon', async () => {
    await write('notes.md', '# Consignes\n');
    render(<App />);
    const editorRegion = await openFromTree('notes.md');
    const area = await within(editorRegion).findByLabelText('Contenu de notes.md', undefined, partage);
    fireEvent.change(area, { target: { value: '# Consignes\n\nBrouillon pas fini.\n' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Ouvrir l’assistant IA' }, partage));
    const chat = await screen.findByRole('dialog', { name: 'Assistant IA' }, partage);

    // Le navigateur n'ouvre pas sa fenêtre d'enregistrement pour autant ; un envoi afficherait « Envoi… » dès le geste.
    expect(fireEvent.keyDown(window, { key: 's', ctrlKey: true })).toBe(false);
    expect(within(editorRegion).queryByText('Envoi…')).not.toBeInTheDocument();
    expect(await read('notes.md')).toBe('# Consignes\n');

    fireEvent.click(within(chat).getByRole('button', { name: 'Fermer l’assistant' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Assistant IA' })).not.toBeInTheDocument());
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    await waitFor(async () => expect(await read('notes.md')).toBe('# Consignes\n\nBrouillon pas fini.\n'), partage);
  });

  test('un PDF du partage se lit au centre, sous son nom, sans être modifiable', async () => {
    await write('notice pompe.pdf', '%PDF-1.4\n% notice\n');
    await write('archive.zip', 'PK\u0003\u0004');
    render(<App />);
    expect(await screen.findByText('Dossier partagé')).toBeInTheDocument();
    // Grisé dans l'arbre = WorkLogs ne l'ouvre pas lui-même : plus le cas d'un PDF.
    expect(await screen.findByRole('button', { name: /^Ouvrir notice pompe\.pdf/ })).not.toHaveClass('is-foreign');
    expect(screen.getByRole('button', { name: /^Ouvrir archive\.zip/ })).toHaveClass('is-foreign');
    // Le type se lit au pictogramme (décoratif : le nom du bouton ne change pas).
    expect(screen.getByRole('button', { name: /^Ouvrir notice pompe\.pdf/ }).querySelector('.file-icon.is-pdf')).toHaveTextContent('PDF');
    expect(screen.getByRole('button', { name: /^Ouvrir archive\.zip/ }).querySelector('.file-icon.is-archive')).toHaveTextContent('ZIP');

    const editorRegion = await openFromTree('notice pompe.pdf');
    const frame = await within(editorRegion).findByTitle('Aperçu de notice pompe.pdf');
    const src = frame.getAttribute('src') ?? '';
    expect(src).toMatch(/^\/api\/shared\/preview\?hash=[0-9a-f]{64}&name=notice%20pompe\.pdf$/);
    const served = await fetch(src);
    expect(served.headers.get('content-type')).toBe('application/pdf');
    expect(served.headers.get('content-disposition')).toMatch(/^inline; filename="notice pompe\.pdf"/);
    expect(within(editorRegion).getByRole('button', { name: 'Enregistrer sur le partage' })).toBeDisabled();
    expect(within(editorRegion).queryByText(/WorkLogs ne modifie pas/)).not.toBeInTheDocument();

    // Un autre format garde l'explication et le téléchargement, sans visionneuse.
    await openFromTree('archive.zip');
    // Changer de fichier passe par la garde de sortie (asynchrone) : on relit la région à chaque essai.
    await waitFor(() => expect(within(sharedEditor()).getByText(/WorkLogs ne modifie pas les fichiers \.zip/)).toBeInTheDocument());
    expect(within(sharedEditor()).getByRole('link', { name: 'Télécharger cette version' })).toBeInTheDocument();
    expect(within(sharedEditor()).queryByTitle(/^Aperçu de/)).not.toBeInTheDocument();
  });

  test('un faux PDF (octets d’un autre format) n’ouvre pas la visionneuse', async () => {
    await write('rapport.pdf', '<html>pas un PDF</html>');
    render(<App />);
    const editorRegion = await openFromTree('rapport.pdf');
    expect(await within(editorRegion).findByText(/WorkLogs ne modifie pas les fichiers \.pdf/)).toBeInTheDocument();
    expect(within(editorRegion).queryByTitle('Aperçu de rapport.pdf')).not.toBeInTheDocument();
  });

  test('ouvert dans Excel par un collègue : lecture seule avec son nom, brouillon possible sur demande', async () => {
    await write('relevés.csv', 'a;b\n1;2\n');
    await write('~$relevés.csv', excelOwner('Jean Dupont'));
    render(<App />);
    expect((await tree()).getByRole('button', { name: /^Ouvrir relevés\.csv — Ouvert par Jean Dupont dans Excel/ })).toBeInTheDocument();
    const editorRegion = await openFromTree('relevés.csv');
    expect(await within(editorRegion).findByText(/Lecture seule — Ouvert par Jean Dupont dans Excel/, undefined, partage)).toBeInTheDocument();
    expect(within(editorRegion).getByRole('grid')).toHaveAttribute('aria-readonly', 'true');
    fireEvent.click(within(editorRegion).getByRole('button', { name: 'Écrire un brouillon quand même' }));
    expect(within(editorRegion).getByRole('grid')).not.toHaveAttribute('aria-readonly');
  });

  test('conflit : un collègue enregistre pendant mon brouillon — rien n’est écrasé, « garder les deux »', async () => {
    await write('notes.md', 'v1\n');
    render(<App />);
    const editorRegion = await openFromTree('notes.md');
    fireEvent.change(await within(editorRegion).findByLabelText('Contenu de notes.md', undefined, partage), { target: { value: 'v1\nmoi\n' } });
    await waitFor(() => expect(within(editorRegion).getByText('Brouillon sur cet ordinateur')).toBeInTheDocument(), partage);
    await write('notes.md', 'v1\ncollègue\n');

    fireEvent.click(within(editorRegion).getByRole('button', { name: 'Enregistrer sur le partage' }));
    const alert = await within(sharedEditor()).findByRole('alert', undefined, partage);
    expect(alert).toHaveTextContent('Rien n’a été écrasé');
    expect(await read('notes.md')).toBe('v1\ncollègue\n');

    fireEvent.click(within(alert).getByRole('button', { name: 'Garder les deux' }));
    await waitFor(() => expect(within(sharedEditor()).getByLabelText('Contenu de notes.md')).toHaveValue('v1\ncollègue\n'), partage);
    const [fs] = await Promise.all([nodeFs()]);
    const copy = fs.readdirSync(share).find((name) => name.startsWith('notes (copie '));
    expect(copy).toBeDefined();
    expect(await read(copy!)).toBe('v1\nmoi\n');
    expect(within(sharedEditor()).getByRole('button', { name: copy })).toBeInTheDocument();
  });

  test('conflit sur des lignes différentes : « Fusionner » garde les deux modifications', async () => {
    await write('relevés.csv', 'Date;Mesure\n05/10;12,5\n06/10;13\n');
    render(<App />);
    const editorRegion = await openFromTree('relevés.csv');
    const grid = await within(editorRegion).findByRole('grid', { name: 'Tableau relevés.csv' }, partage);
    fireEvent.click(within(grid).getByRole('gridcell', { name: 'B3 : 13' }));
    fireEvent.change(within(editorRegion).getByLabelText('Contenu de la cellule'), { target: { value: '14,2' } });
    await waitFor(() => expect(within(editorRegion).getByText('Brouillon sur cet ordinateur')).toBeInTheDocument(), partage);
    // Le collègue corrige l'autre ligne dans Excel.
    await write('relevés.csv', 'Date;Mesure\n05/10;12,8\n06/10;13\n');

    fireEvent.click(within(editorRegion).getByRole('button', { name: 'Enregistrer sur le partage' }));
    const alert = await within(sharedEditor()).findByRole('alert', undefined, partage);
    expect(await within(alert).findByText(/Vos modifications ne se touchent pas : « Fusionner » garde les deux \(1 modification de ta part ajoutée à leur version\)/, undefined, partage)).toBeInTheDocument();
    fireEvent.click(within(alert).getByRole('button', { name: 'Fusionner' }));
    await waitFor(async () => expect(await read('relevés.csv')).toBe('Date;Mesure\n05/10;12,8\n06/10;14,2\n'), partage);
    expect(await within(sharedEditor()).findByText(/Fusionné et enregistré sur le partage/, undefined, partage)).toBeInTheDocument();
    expect(within(sharedEditor()).getByRole('grid', { name: 'Tableau relevés.csv' })).toBeInTheDocument();
    expect(within(sharedEditor()).getByRole('gridcell', { name: 'B2 : 12,8' })).toBeInTheDocument();
    expect(within(sharedEditor()).getByRole('gridcell', { name: 'B3 : 14,2' })).toBeInTheDocument();
  });

  test('conflit sur la même ligne : pas de fusion, la raison est dite', async () => {
    await write('notes.md', 'v1\n');
    render(<App />);
    const editorRegion = await openFromTree('notes.md');
    fireEvent.change(await within(editorRegion).findByLabelText('Contenu de notes.md', undefined, partage), { target: { value: 'v1 moi\n' } });
    await waitFor(() => expect(within(editorRegion).getByText('Brouillon sur cet ordinateur')).toBeInTheDocument(), partage);
    await write('notes.md', 'v1 collègue\n');
    fireEvent.click(within(editorRegion).getByRole('button', { name: 'Enregistrer sur le partage' }));
    const alert = await within(sharedEditor()).findByRole('alert', undefined, partage);
    expect(await within(alert).findByText('Fusion impossible : vous avez modifié tous les deux la ligne 1.', undefined, partage)).toBeInTheDocument();
    expect(within(alert).queryByRole('button', { name: 'Fusionner' })).not.toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Garder ma version' })).toBeInTheDocument();
  });

  test('chercher dans le partage : un fichier s’ouvre, un dossier se déplie dans l’arbre', async () => {
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, 'Global', 'MURGAT INGENIERIE', '00. PROCEDURE'), { recursive: true });
    await write('Global/MURGAT INGENIERIE/00. PROCEDURE/Procédure filtration.md', '# Filtration\n');
    await write('notes.md', 'x');
    render(<App />);
    const field = await screen.findByLabelText('Chercher dans le partage', undefined, partage);
    fireEvent.change(field, { target: { value: 'procedure' } });
    const results = await screen.findByRole('region', { name: 'Résultats de la recherche' });
    expect(await within(results).findByText('2 résultats.', undefined, partage)).toBeInTheDocument();
    const hit = within(results).getByRole('button', { name: 'Ouvrir Global/MURGAT INGENIERIE/00. PROCEDURE/Procédure filtration.md' });
    expect(hit.querySelector('.file-icon.is-text')).toHaveTextContent('MD');
    // Le chemin s'abrège par le début (direction droite-à-gauche) sans que « 00. » se retourne : il est isolé.
    expect(within(hit).getByText('Global/MURGAT INGENIERIE/00. PROCEDURE', { selector: 'bdi' })).toHaveAttribute('dir', 'ltr');
    fireEvent.click(hit);
    const editorRegion = await screen.findByRole('region', { name: 'Fichier partagé' });
    expect(await within(editorRegion).findByLabelText('Contenu de Procédure filtration.md', undefined, partage)).toHaveValue('# Filtration\n');

    fireEvent.click(within(screen.getByRole('region', { name: 'Résultats de la recherche' })).getByRole('button', { name: 'Afficher le dossier Global/MURGAT INGENIERIE/00. PROCEDURE' }));
    expect(field).toHaveValue('');
    expect(await screen.findByRole('list', { name: 'Contenu de Global/MURGAT INGENIERIE/00. PROCEDURE' }, partage)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dossier 00. PROCEDURE' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Dossier 00. PROCEDURE' }).querySelector('.file-icon.is-folder')).toHaveClass('is-open');
    expect(screen.getByRole('button', { name: 'Dossier Global' }).querySelector('.file-icon.is-folder')).toHaveClass('is-open');
  });

  test('une recherche échouée le dit dans ses résultats ; la suivante l’efface', async () => {
    await write('notes.md', 'x');
    vi.spyOn(clientApi, 'searchShared').mockRejectedValueOnce(new Error('Le partage ne répond pas.'));
    render(<App />);
    const field = await screen.findByLabelText('Chercher dans le partage', undefined, partage);
    fireEvent.change(field, { target: { value: 'notes' } });
    const results = await screen.findByRole('region', { name: 'Résultats de la recherche' });
    expect(await within(results).findByRole('alert', undefined, partage)).toHaveTextContent('Le partage ne répond pas.');
    fireEvent.change(field, { target: { value: 'note' } });
    expect(await within(results).findByText('1 résultat.', undefined, partage)).toBeInTheDocument();
    expect(screen.queryByText('Le partage ne répond pas.')).not.toBeInTheDocument();
  });

  test('hors ligne : l’arbre reste celui vu en dernier, les fichiers non gardés ici sont signalés', async () => {
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, 'Global'));
    await write('Global/Procédure filtration.md', '# Filtration\n');
    await write('Global/relevés.csv', 'a;b\n');
    render(<App />);
    fireEvent.click((await tree()).getByRole('button', { name: 'Dossier Global' }));
    const editorRegion = await openFromTree('relevés.csv');
    // Ouvert pour de bon (lu, donc gardé ici) avant que le partage ne tombe.
    await within(editorRegion).findByRole('grid', { name: 'Tableau relevés.csv' }, partage);
    fs.renameSync(share, share + '-ailleurs');
    try {
      act(() => { window.dispatchEvent(new Event('focus')); });
      expect(await screen.findAllByText(/^Hors ligne — liste vue /, undefined, partage)).not.toHaveLength(0);
      const missing = await (await tree()).findByRole('button', { name: /^Ouvrir Procédure filtration\.md — pas gardé sur cet ordinateur/ }, partage);
      expect(missing).toBeDisabled();
      expect(screen.getByRole('button', { name: /^Ouvrir relevés\.csv/ })).toBeEnabled();
    } finally {
      fs.renameSync(share + '-ailleurs', share);
    }
  });

  test('sans brouillon, la version du collègue s’affiche d’elle-même au retour sur la fenêtre', async () => {
    await write('notes.md', 'v1\n');
    render(<App />);
    const editorRegion = await openFromTree('notes.md');
    expect(await within(editorRegion).findByLabelText('Contenu de notes.md', undefined, partage)).toHaveValue('v1\n');
    await write('notes.md', 'v2 du collègue\n');
    act(() => { window.dispatchEvent(new Event('focus')); });
    // Pas `partage` : l'éditeur relit aussi le partage toutes les 5 s, et une attente plus
    // longue verrait la version du collègue arriver sans le retour sur la fenêtre.
    await waitFor(() => expect(within(sharedEditor()).getByLabelText('Contenu de notes.md')).toHaveValue('v2 du collègue\n'), { timeout: 3_000 });
    expect(within(sharedEditor()).getByText('Mis à jour depuis le partage.')).toBeInTheDocument();
  });

  test('un brouillon survit à la fermeture et se retrouve à la réouverture', async () => {
    await write('notes.md', 'v1\n');
    const { unmount } = render(<App />);
    const editorRegion = await openFromTree('notes.md');
    fireEvent.change(await within(editorRegion).findByLabelText('Contenu de notes.md', undefined, partage), { target: { value: 'v1\nen cours\n' } });
    await flushPendingSaves();
    unmount();
    render(<App />);
    expect(await within(await screen.findByRole('region', { name: 'Fichier partagé' })).findByLabelText('Contenu de notes.md', undefined, partage)).toHaveValue('v1\nen cours\n');
    expect(await read('notes.md')).toBe('v1\n');
  });

  const exists = async (rel: string) => {
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    return fs.existsSync(path.join(share, rel));
  };
  const typeIn = async (name: string, value: string) => {
    const area = await within(sharedEditor()).findByLabelText(`Contenu de ${name}`, undefined, partage);
    fireEvent.change(area, { target: { value } });
    return area;
  };

  test('la première frappe prend la main (verrou à mon nom) ; fermer avec un brouillon pose la question', async () => {
    await write('notes.md', 'v1\n');
    render(<App />);
    await openFromTree('notes.md');
    expect(await exists('.~lock.notes.md#')).toBe(false);
    await typeIn('notes.md', 'v1\nmoi\n');
    await waitFor(async () => expect(await exists('.~lock.notes.md#')).toBe(true), partage);
    expect(await read('.~lock.notes.md#')).toMatch(/\(WorkLogs\),.*worklogs:test:/);
    expect(await within(sharedEditor()).findByText('Tu as la main', undefined, partage)).toBeInTheDocument();

    fireEvent.click(within(sharedEditor()).getByRole('button', { name: 'Fermer' }));
    // La question attend l'écriture du brouillon en attente.
    const question = await screen.findByRole('dialog', { name: 'Tes modifications ne sont pas sur le partage' }, partage);
    fireEvent.click(within(question).getByRole('button', { name: 'Garder le brouillon ici' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Fichier partagé' })).not.toBeInTheDocument());
    await waitFor(async () => expect(await exists('.~lock.notes.md#')).toBe(false), partage);
    expect(await read('notes.md')).toBe('v1\n');

    await openFromTree('notes.md');
    expect(await within(sharedEditor()).findByLabelText('Contenu de notes.md', undefined, partage)).toHaveValue('v1\nmoi\n');
  });

  test('quitter vers une entrée : « Envoyer sur le partage » l’enregistre, puis ouvre l’entrée', async () => {
    seedData(api.db, { entries: [{ id: 'en_1', title: 'Compte rendu' }] });
    await write('notes.md', 'v1\n');
    render(<App />);
    await openFromTree('notes.md');
    await typeIn('notes.md', 'v1\nenvoyé\n');
    await waitFor(() => expect(within(sharedEditor()).getByText('Brouillon sur cet ordinateur')).toBeInTheDocument(), partage);
    fireEvent.click(await within(journal()).findByText('Compte rendu'));
    const question = await screen.findByRole('dialog', { name: 'Tes modifications ne sont pas sur le partage' });
    // Hors de l'écriture : la question se voit même quand celle-ci n'est pas à l'écran
    // (autre vue sur téléphone, panneau replié sur desktop).
    expect(question.closest('#workspace-editor')).toBeNull();
    fireEvent.click(within(question).getByRole('button', { name: 'Envoyer sur le partage' }));
    expect(await screen.findByRole('region', { name: 'Entrée' }, partage)).toBeInTheDocument();
    expect(await read('notes.md')).toBe('v1\nenvoyé\n');
  });

  test('« Annuler » garde le fichier ouvert', async () => {
    seedData(api.db, { entries: [{ id: 'en_1', title: 'Compte rendu' }] });
    await write('notes.md', 'v1\n');
    render(<App />);
    await openFromTree('notes.md');
    await typeIn('notes.md', 'v1\nen cours\n');
    fireEvent.click(await within(journal()).findByText('Compte rendu'));
    fireEvent.click(within(await screen.findByRole('dialog', undefined, partage)).getByRole('button', { name: 'Annuler' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(sharedEditor()).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Entrée' })).not.toBeInTheDocument();
  });

  test('changer de projet referme le fichier du projet précédent', async () => {
    seedData(api.db, { projects: [{ id: 'pr_p', name: 'Piscine' }, { id: 'pr_t', name: 'TSE' }] });
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, 'Piscine'));
    fs.mkdirSync(path.join(share, 'TSE'));
    await write('Piscine/consignes.md', '# Piscine\n');
    await write('TSE/notes.md', '# TSE\n');
    api.db.prepare("UPDATE projects SET shared_dir='Piscine' WHERE id='pr_p'").run();
    api.db.prepare("UPDATE projects SET shared_dir='TSE' WHERE id='pr_t'").run();
    render(<App />);

    fireEvent.click(await within(filters()).findByRole('button', { name: /Piscine/ }));
    const piscine = within(await screen.findByRole('list', { name: 'Contenu de Piscine' }, partage));
    fireEvent.click(await piscine.findByRole('button', { name: /^Ouvrir consignes\.md/ }, partage));
    const open = await screen.findByRole('region', { name: 'Fichier partagé' }, partage);
    expect(await within(open).findByLabelText('Contenu de consignes.md', undefined, partage)).toHaveValue('# Piscine\n');

    fireEvent.click(within(filters()).getByRole('button', { name: /^TSE/ }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Fichier partagé' })).not.toBeInTheDocument(), partage);
    // L'arbre suit bien le nouveau projet ; le fichier qui n'y est plus n'est plus au centre.
    expect(await screen.findByRole('button', { name: /^Ouvrir notes\.md/ }, partage)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Ouvrir consignes\.md/ })).not.toBeInTheDocument();
  });

  test('« Annuler » au changement de projet garde le fichier et le projet', async () => {
    seedData(api.db, { projects: [{ id: 'pr_p', name: 'Piscine' }, { id: 'pr_t', name: 'TSE' }] });
    await write('notes.md', 'v1\n');
    render(<App />);
    fireEvent.click(await within(filters()).findByRole('button', { name: /Piscine/ }));
    await openFromTree('notes.md');
    await typeIn('notes.md', 'v1\nen cours\n');

    fireEvent.click(within(filters()).getByRole('button', { name: /^TSE/ }));
    fireEvent.click(within(await screen.findByRole('dialog', undefined, partage)).getByRole('button', { name: 'Annuler' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(sharedEditor()).toBeInTheDocument();
    expect(within(filters()).getByRole('button', { name: /^Piscine/ })).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem('worklogs-project')).toBe('pr_p');
  });

  test('« Annuler » en ouvrant un document d’un autre projet ne change pas le filtre', async () => {
    seedData(api.db, {
      projects: [{ id: 'pr_p', name: 'Piscine' }, { id: 'pr_t', name: 'TSE' }],
      entries: [{ id: 'en_doc', title: 'Compte rendu TSE', project_id: 'pr_t' }],
      tasks: [{ id: 'tk_1', title: 'Tâche Piscine', project_id: 'pr_p' }],
    });
    api.db.prepare('INSERT INTO task_entries (task_id,entry_id,created_at) VALUES (?,?,?)').run('tk_1', 'en_doc', new Date().toISOString());
    await write('notes.md', 'v1\n');
    render(<App />);
    fireEvent.click(await within(filters()).findByRole('button', { name: /Piscine/ }));
    await openFromTree('notes.md');
    await typeIn('notes.md', 'v1\nen cours\n');

    const card = (await within(board()).findByText('Tâche Piscine')).closest('.card') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Ouvrir Compte rendu TSE' }));
    fireEvent.click(within(await screen.findByRole('dialog', undefined, partage)).getByRole('button', { name: 'Annuler' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(sharedEditor()).toBeInTheDocument();
    expect(within(filters()).getByRole('button', { name: /^Piscine/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('region', { name: 'Entrée' })).not.toBeInTheDocument();
  });

  test('ouvrir un document Google depuis « Documents Google » suit son projet', async () => {
    const user = userEvent.setup();
    seedData(api.db, {
      projects: [{ id: 'pr_p', name: 'Piscine' }, { id: 'pr_t', name: 'TSE' }],
      entries: [{ id: 'en_g', title: 'Compte rendu TSE', project_id: 'pr_t' }],
    });
    const opened = await clientApi.entry('en_g');
    vi.spyOn(clientApi, 'googleStatus').mockResolvedValue({
      available: true, configured: true, connected: true, pending: false, error: '', selectedIds: [],
      account: { email: 'timo@example.com', name: 'Timo' },
    });
    vi.spyOn(clientApi, 'googleSync').mockResolvedValue({ state: 'idle', error: '', lastSyncedAt: null, revision: 0 });
    vi.spyOn(clientApi, 'googleDocuments').mockResolvedValue({
      files: [{ id: 'doc-1', name: 'Compte rendu TSE', modifiedTime: '', linked: true, project_id: 'pr_t' }],
    });
    vi.spyOn(clientApi, 'openGoogleDocument').mockResolvedValue(opened);
    localStorage.setItem('worklogs-project', 'pr_p');
    render(<App />);

    const header = await screen.findByRole('banner');
    await user.click(await within(header).findByRole('button', { name: /Compte Google : Timo/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Documents Google' }));
    const dialog = await screen.findByRole('dialog', { name: 'Documents Google' });
    await user.click(await within(dialog).findByRole('button', { name: 'Ouvrir Compte rendu TSE' }));

    // Comme une carte de tâche : le filtre passe au projet du document ouvert.
    await waitFor(() => expect(within(filters()).getByRole('button', { name: /^TSE/ })).toHaveAttribute('aria-pressed', 'true'));
    expect(await screen.findByLabelText('Titre de l’entrée')).toHaveValue('Compte rendu TSE');
    expect(localStorage.getItem('worklogs-project')).toBe('pr_t');
  });

  test('un collègue ouvre le fichier dans LibreOffice après moi : ma frappe passe en lecture seule, gardée en brouillon', async () => {
    await write('planning.txt', 'lundi\n');
    render(<App />);
    await openFromTree('planning.txt');
    await write('.~lock.planning.txt#', 'Hélène Martin,hmartin,TSE01,05.10.2026 09:00,file:///C:/x;');
    const area = await typeIn('planning.txt', 'lundi\nmardi\n');
    expect(await within(sharedEditor()).findByText(/Lecture seule — Ouvert par Hélène Martin dans LibreOffice/, undefined, partage)).toBeInTheDocument();
    expect(area).toHaveAttribute('readonly');
    await flushPendingSaves();
    expect((await clientApi.sharedFile('planning.txt')).draft?.model).toMatchObject({ text: 'lundi\nmardi\n' });
    expect(await read('.~lock.planning.txt#')).toMatch(/^Hélène Martin/);
  });

  test('relier un projet à un sous-dossier : son filtre n’affiche que lui', async () => {
    seedData(api.db, { projects: [{ id: 'pr_p', name: 'Piscine' }] });
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, 'Piscine'));
    await write('Piscine/consignes.md', '# Consignes');
    await write('autre.md', 'x');
    render(<App />);
    expect((await tree()).getByRole('button', { name: /^Ouvrir autre\.md/ })).toBeInTheDocument();
    // Un clic dès le commit du projet doit survivre aux effets encore en attente :
    // l'ancien reset passif fermait le choix juste après ce premier clic.
    let clicked = false;
    const observer = new MutationObserver(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('.shared-project-link button')]
        .find((candidate) => candidate.textContent === 'Relier Piscine à un dossier…');
      if (clicked || !button || button.disabled) return;
      clicked = true;
      fireEvent.click(button);
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    try {
      fireEvent.click(within(filters()).getByRole('button', { name: /Piscine/ }));
      fireEvent.click(await screen.findByRole('button', { name: 'Relier Piscine au dossier Piscine' }, { timeout: 5000 }));
      expect(clicked).toBe(true);
    } finally {
      observer.disconnect();
    }
    const piscine = within(await screen.findByRole('list', { name: 'Contenu de Piscine' }, partage));
    expect(piscine.getByRole('button', { name: /^Ouvrir consignes\.md/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Ouvrir autre\.md/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Délier Piscine de son dossier' }));
    expect((await tree()).getByRole('button', { name: /^Ouvrir autre\.md/ })).toBeInTheDocument();
  });

  test('le dossier relié est porté par le projet (synchronisé par Drive), pas par cet ordinateur', async () => {
    seedData(api.db, { projects: [{ id: 'pr_p', name: 'Piscine' }] });
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, 'Piscine'));
    await write('Piscine/consignes.md', '# Consignes');
    render(<App />);
    fireEvent.click(await within(filters()).findByRole('button', { name: /Piscine/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Relier Piscine à un dossier…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Relier Piscine au dossier Piscine' }, { timeout: 5000 }));
    expect(await screen.findByRole('button', { name: /^Ouvrir consignes\.md/ })).toBeInTheDocument();
    expect(api.db.prepare("SELECT shared_dir FROM projects WHERE id='pr_p'").get()).toEqual({ shared_dir: 'Piscine' });
    expect(api.db.prepare('SELECT COUNT(*) n FROM shared_project_folders').get()).toEqual({ n: 0 });
  });

  test('lien d’avant (table de cet ordinateur) : repris une fois sur le projet', async () => {
    seedData(api.db, { projects: [{ id: 'pr_p', name: 'Piscine' }] });
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, 'Piscine'));
    api.db.prepare('INSERT INTO shared_project_folders (project_id, rel_dir, updated_at) VALUES (?,?,?)').run('pr_p', 'Piscine', new Date().toISOString());
    render(<App />);
    await waitFor(() => expect(api.db.prepare("SELECT shared_dir FROM projects WHERE id='pr_p'").get()).toEqual({ shared_dir: 'Piscine' }));
    await waitFor(() => expect(api.db.prepare('SELECT COUNT(*) n FROM shared_project_folders').get()).toEqual({ n: 0 }));
  });

  test('dossiers reliés depuis un autre appareil : ouvrir celui que ce montage atteint', async () => {
    seedData(api.db, { projects: [{ id: 'pr_t', name: 'TSE' }] });
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, '2. TSE'));
    await write('2. TSE/Redémarrage.md', '# x');
    await write('autre.md', 'y');
    // Le téléphone a relié le projet depuis un montage plus large, avec un autre nom de serveur.
    api.db.prepare("INSERT INTO local_settings (key, value, updated_at) VALUES ('shared.address', ?, ?)").run('\\\\172.16.1.20\\d\\Global\\00. PROCEDURE', new Date().toISOString());
    const outside = '\\\\SRVMURGAT\\D\\Archives';
    await clientApi.updateProject('pr_t', { shared_dirs: [outside, '\\\\SRVMURGAT\\D\\Global\\00. PROCEDURE\\2. TSE'] });
    render(<App />);
    fireEvent.click(await within(filters()).findByRole('button', { name: /TSE/ }));
    expect(await screen.findByRole('button', { name: /^Ouvrir Redémarrage\.md/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Afficher le dossier lié ${outside}` })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Afficher le dossier lié 2. TSE' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: /^Ouvrir autre\.md/ })).not.toBeInTheDocument();
  });

  test('projet relié à un dossier absent du partage : on le dit, « Délier » rend tout le partage', async () => {
    seedData(api.db, { projects: [{ id: 'pr_w', name: 'work-logs' }] });
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, 'Global'));
    await write('notes.md', 'x');
    await clientApi.linkSharedFolder('pr_w', 'Global');
    // Le dossier disparaît du partage (ou la racine a changé) : le lien ne mène plus nulle part.
    fs.rmdirSync(path.join(share, 'Global'));
    // La reprise de l'ancien lien commence sous « Tout », puis le projet est
    // choisi avant sa fin : le rafraîchissement doit suivre le filtre courant.
    let resumeMigration!: () => void;
    const migrationGate = new Promise<void>((resolve) => { resumeMigration = resolve; });
    const updateProject = clientApi.updateProject;
    const migration = vi.spyOn(clientApi, 'updateProject').mockImplementation(async (id, body) => {
      if (id === 'pr_w' && body.shared_dir) await migrationGate;
      return updateProject(id, body);
    });
    let filteredRead = false;
    const readState = clientApi.state;
    vi.spyOn(clientApi, 'state').mockImplementation(async (...args) => {
      const next = await readState(...args);
      if (args[1] === 'pr_w') filteredRead = true;
      return next;
    });
    render(<App />);
    await waitFor(() => expect(migration).toHaveBeenCalledWith('pr_w', { shared_dir: 'Global' }), partage);
    fireEvent.click(await within(filters()).findByRole('button', { name: /work-logs/ }));
    await waitFor(() => expect(filteredRead).toBe(true), partage);
    expect(screen.getByRole('button', { name: 'Relier work-logs à un dossier…' })).toBeDisabled();
    await act(async () => { resumeMigration(); await migrationGate; });
    expect(await screen.findByText('Le dossier relié à work-logs (« Global ») n’est pas dans ce partage. « Délier work-logs de son dossier » affiche tout le partage.', undefined, partage)).toHaveAttribute('role', 'alert');
    fireEvent.click(screen.getByRole('button', { name: 'Délier work-logs de son dossier' }));
    expect((await tree()).getByRole('button', { name: /^Ouvrir notes\.md/ })).toBeInTheDocument();
  });

  test('nouveau fichier : créé dans le dossier déplié, ouvert au centre ; un nom pris n’écrase rien', async () => {
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, '00. PROCEDURE'));
    await write('00. PROCEDURE/existant.md', 'à garder\n');
    render(<App />);
    const files = await tree();
    fireEvent.click(files.getByRole('button', { name: 'Dossier 00. PROCEDURE' }));
    await files.findByRole('button', { name: /^Ouvrir existant\.md/ }, partage);

    fireEvent.click(screen.getByRole('button', { name: '＋ Nouveau fichier…' }));
    const form = screen.getByRole('form', { name: 'Nouveau fichier' });
    expect(within(form).getByLabelText('Dossier du nouveau fichier')).toHaveValue('00. PROCEDURE');
    fireEvent.change(within(form).getByLabelText('Type de fichier'), { target: { value: 'md' } });
    fireEvent.change(within(form).getByLabelText('Nom du fichier'), { target: { value: 'Procédure sauvegarde' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Créer' }));
    const editorRegion = await screen.findByRole('region', { name: 'Fichier partagé' }, partage);
    expect(await within(editorRegion).findByLabelText('Contenu de Procédure sauvegarde.md', undefined, partage)).toHaveValue('# Procédure sauvegarde\n\n');
    expect(await read('00. PROCEDURE/Procédure sauvegarde.md')).toBe('# Procédure sauvegarde\n\n');
    expect(screen.getByRole('button', { name: /^Ouvrir Procédure sauvegarde\.md/ })).toBeInTheDocument();

    // Un nom déjà pris : refusé, l'existant intact.
    fireEvent.click(screen.getByRole('button', { name: '＋ Nouveau fichier…' }));
    const again = screen.getByRole('form', { name: 'Nouveau fichier' });
    fireEvent.change(within(again).getByLabelText('Type de fichier'), { target: { value: 'md' } });
    fireEvent.change(within(again).getByLabelText('Nom du fichier'), { target: { value: 'existant' } });
    fireEvent.click(within(again).getByRole('button', { name: 'Créer' }));
    expect(await screen.findByText('« existant.md » existe déjà dans ce dossier : rien n’a été écrasé. Choisis un autre nom.', undefined, partage)).toBeInTheDocument();
    expect(await read('00. PROCEDURE/existant.md')).toBe('à garder\n');
  });

  test('un refus reste affiché quand l’arbre se relit ; « Annuler » l’efface', async () => {
    await write('existant.md', 'à garder\n');
    render(<App />);
    await tree();
    fireEvent.click(screen.getByRole('button', { name: '＋ Nouveau fichier…' }));
    const form = screen.getByRole('form', { name: 'Nouveau fichier' });
    fireEvent.change(within(form).getByLabelText('Type de fichier'), { target: { value: 'md' } });
    fireEvent.change(within(form).getByLabelText('Nom du fichier'), { target: { value: 'existant' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Créer' }));
    const refusal = '« existant.md » existe déjà dans ce dossier : rien n’a été écrasé. Choisis un autre nom.';
    expect(await screen.findByText(refusal, undefined, partage)).toBeInTheDocument();

    // Retour au premier plan (comme le sondage) : l'arbre est relu jusqu'au bout, le refus reste.
    const listed = vi.spyOn(clientApi, 'sharedList');
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(listed).toHaveBeenCalled(), partage);
    await act(async () => { await Promise.allSettled(listed.mock.results.map((result) => result.value)); });
    expect(screen.getByText(refusal)).toBeInTheDocument();

    fireEvent.click(within(form).getByRole('button', { name: 'Annuler' }));
    expect(screen.queryByText(refusal)).not.toBeInTheDocument();
  });

  test('nouveau document Word à la racine : il s’ouvre dans l’éditeur Word, titré de son nom', async () => {
    await write('notes.md', 'x');
    render(<App />);
    await tree();
    fireEvent.click(screen.getByRole('button', { name: '＋ Nouveau fichier…' }));
    const form = screen.getByRole('form', { name: 'Nouveau fichier' });
    expect(within(form).getByLabelText('Type de fichier')).toHaveValue('docx');
    fireEvent.change(within(form).getByLabelText('Nom du fichier'), { target: { value: 'Compte rendu' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Créer' }));
    const editorRegion = await screen.findByRole('region', { name: 'Fichier partagé' }, partage);
    const content = await within(editorRegion).findByRole('textbox', { name: 'Contenu du document Word' }, partage);
    expect(content.querySelector('h1')).toHaveTextContent('Compte rendu');
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    expect(fs.existsSync(path.join(share, 'Compte rendu.docx'))).toBe(true);
  });

  test('depuis une procédure : la procédure locale part sur le TSE en docx, dans le dossier choisi', async () => {
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, '00. PROCEDURE'));
    seedData(api.db, { entries: [{ id: 'en_proc', title: 'Sauvegarde chaudière', content_md: '## Objectif\n\nCouper le courant.\n\n- Filtre lavé\n', kind: 'procedure' }] });
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Modifier la procédure Sauvegarde chaudière' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Dossier 00. PROCEDURE' }));

    fireEvent.click(await screen.findByRole('button', { name: '＋ Depuis une procédure…' }));
    const form = screen.getByRole('form', { name: 'Depuis une procédure' });
    expect(within(form).getByLabelText('Procédure à envoyer')).toHaveValue('en_proc');
    expect(within(form).getByLabelText('Format du fichier')).toHaveValue('docx');
    expect(within(form).getByLabelText('Nom du fichier envoyé')).toHaveValue('Sauvegarde chaudière');
    expect(within(form).getByLabelText('Dossier de destination')).toHaveValue('00. PROCEDURE');
    fireEvent.click(within(form).getByRole('button', { name: 'Envoyer vers le partage' }));

    const editorRegion = await screen.findByRole('region', { name: 'Fichier partagé' });
    const content = await within(editorRegion).findByRole('textbox', { name: 'Contenu du document Word' });
    expect(content.querySelector('h1')).toHaveTextContent('Sauvegarde chaudière');
    expect(content).toHaveTextContent('Couper le courant.');
    expect(fs.existsSync(path.join(share, '00. PROCEDURE', 'Sauvegarde chaudière.docx'))).toBe(true);
    // Copie par défaut : la procédure locale reste dans sa colonne.
    expect(screen.getByRole('button', { name: 'Modifier la procédure Sauvegarde chaudière' })).toBeInTheDocument();
  }, 15000);

  test('depuis une procédure : format Markdown au choix, un nom pris n’écrase rien', async () => {
    await write('existant.md', 'à garder\n');
    seedData(api.db, { entries: [{ id: 'en_proc', title: 'Consignes', content_md: '# Consignes\n\nLaver le filtre.\n', kind: 'procedure' }] });
    render(<App />);
    // L'arbre d'abord : une lecture du dossier qui aboutit efface le message d'erreur, et la
    // première, encore en route sous charge, effaçait le refus juste après son affichage.
    await screen.findByRole('button', { name: /^Ouvrir existant\.md/ }, { timeout: 10000 });
    fireEvent.click(await screen.findByRole('button', { name: '＋ Depuis une procédure…' }, { timeout: 10000 }));
    const form = screen.getByRole('form', { name: 'Depuis une procédure' });
    fireEvent.change(within(form).getByLabelText('Format du fichier'), { target: { value: 'md' } });
    fireEvent.change(within(form).getByLabelText('Nom du fichier envoyé'), { target: { value: 'existant' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Envoyer vers le partage' }));
    expect(await screen.findByText('« existant.md » existe déjà dans ce dossier : rien n’a été écrasé. Choisis un autre nom.', {}, { timeout: 10000 })).toBeInTheDocument();
    expect(await read('existant.md')).toBe('à garder\n');
  }, 30000);

  test('depuis une procédure : déplacer supprime la procédure locale après l’envoi', async () => {
    seedData(api.db, { entries: [{ id: 'en_proc', title: 'Consignes', content_md: '# Consignes\n\nLaver le filtre.\n', kind: 'procedure' }] });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '＋ Depuis une procédure…' }));
    const form = screen.getByRole('form', { name: 'Depuis une procédure' });
    fireEvent.change(within(form).getByLabelText('Format du fichier'), { target: { value: 'md' } });
    fireEvent.change(within(form).getByLabelText('Nom du fichier envoyé'), { target: { value: 'Consignes envoyées' } });
    fireEvent.click(within(form).getByLabelText('Supprimer la procédure locale après l’envoi'));
    fireEvent.click(within(form).getByRole('button', { name: 'Envoyer vers le partage' }));
    const editorRegion = await screen.findByRole('region', { name: 'Fichier partagé' });
    expect(await within(editorRegion).findByLabelText('Contenu de Consignes envoyées.md')).toHaveValue('# Consignes\n\nLaver le filtre.\n');
    expect(await read('Consignes envoyées.md')).toBe('# Consignes\n\nLaver le filtre.\n');
    // Déplacement : l’originale a quitté la colonne des procédures.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Modifier la procédure Consignes' })).not.toBeInTheDocument(), { timeout: 5000 });
    expect(row(api.db, 'SELECT id FROM entries WHERE id=?', 'en_proc')).toBeUndefined();
  }, 15000);

  test('l’historique restaure une ancienne version en brouillon, puis l’envoi la remet sur le partage', async () => {
    await write('notes.md', 'version 1\n');
    render(<App />);
    await openFromTree('notes.md');
    expect(await within(sharedEditor()).findByLabelText('Contenu de notes.md', undefined, partage)).toHaveValue('version 1\n');
    await write('notes.md', 'version 2 du collègue\n');
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(within(sharedEditor()).getByLabelText('Contenu de notes.md')).toHaveValue('version 2 du collègue\n'), partage);

    fireEvent.click(within(sharedEditor()).getByText('Historique sur cet ordinateur'));
    const buttons = await within(sharedEditor()).findAllByRole('button', { name: /^Restaurer la version du/ }, partage);
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]);
    await waitFor(() => expect(within(sharedEditor()).getByLabelText('Contenu de notes.md')).toHaveValue('version 1\n'), partage);
    expect(within(sharedEditor()).getByText(/restaurée en brouillon/)).toBeInTheDocument();
    expect(await read('notes.md')).toBe('version 2 du collègue\n');
    fireEvent.click(within(sharedEditor()).getByRole('button', { name: 'Enregistrer sur le partage' }));
    await waitFor(async () => expect(await read('notes.md')).toBe('version 1\n'), partage);
  });

  test('Paramètres › Dossier partagé : le nom affiché dans mes verrous', async () => {
    await write('notes.md', 'v1\n');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Compte et paramètres' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Paramètres' }));
    const settings = within(await screen.findByRole('region', { name: 'Dossier partagé' }, partage));
    const input = await settings.findByLabelText('Nom affiché dans les verrous');
    fireEvent.change(input, { target: { value: 'T. Grollier' } });
    fireEvent.click(settings.getByRole('button', { name: 'Enregistrer' }));
    expect(await settings.findByText('Enregistré.', undefined, partage)).toBeInTheDocument();
    expect((await clientApi.sharedStatus()).displayName).toBe('T. Grollier');
  });

  test('un document Word s’ouvre dans son éditeur ; changer un style ne réécrit que ce paragraphe', async () => {
    const { wordDocx } = await import('./test/docx-fixture');
    const { readZip, readZipText } = await import('./zip');
    const original = wordDocx();
    await write('Procédure filtration.docx', original);
    await clientApi.setSharedDisplayName('T. Grollier');
    render(<App />);
    const editorRegion = await openFromTree('Procédure filtration.docx');
    const content = await within(editorRegion).findByRole('textbox', { name: 'Contenu du document Word' }, partage);
    expect(content).toHaveTextContent('Filtration');
    expect(content.querySelector('h1')).toHaveTextContent('Filtration');
    expect(within(editorRegion).getByText(/Image — conservé/)).toBeInTheDocument();
    expect(within(editorRegion).getByText(/Table des matières — conservé/)).toBeInTheDocument();
    await waitFor(() => expect(content.querySelector('[data-marker="1."]')).toHaveTextContent('Arrêter la pompe'));
    expect(content.querySelector('[data-marker="a)"]')).toHaveTextContent('Vanne fermée');

    const style = within(editorRegion).getByLabelText('Style du paragraphe');
    expect(style).toHaveValue('Titre1');
    fireEvent.change(style, { target: { value: '' } });
    await waitFor(() => expect(within(sharedEditor()).getByText('Brouillon sur cet ordinateur')).toBeInTheDocument(), partage);
    fireEvent.click(within(sharedEditor()).getByRole('button', { name: 'Enregistrer sur le partage' }));
    await waitFor(() => expect(within(sharedEditor()).getByText('Enregistré sur le partage.')).toBeInTheDocument(), partage);

    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    const sent = new Uint8Array(fs.readFileSync(path.join(share, 'Procédure filtration.docx')));
    const before = (await readZipText(readZip(original), 'word/document.xml'))!;
    const after = (await readZipText(readZip(sent), 'word/document.xml'))!;
    expect(after).toBe(before.replace('<w:pPr><w:pStyle w:val="Titre1"/><w:spacing w:after="120"/></w:pPr><w:bookmarkStart w:id="0" w:name="_Toc1"/><w:r><w:t>Filtration</w:t></w:r>',
      '<w:pPr><w:spacing w:after="120"/></w:pPr><w:bookmarkStart w:id="0" w:name="_Toc1"/><w:r><w:t xml:space="preserve">Filtration</w:t></w:r>'));
    expect(await readZipText(readZip(sent), 'docProps/core.xml')).toContain('<cp:lastModifiedBy>T. Grollier</cp:lastModifiedBy>');
  });

  test('document Word : ses images s’affichent ; une image insérée part dans le fichier du partage', async () => {
    const { pngImage, wordDocx, wordPicture } = await import('./test/docx-fixture');
    const { readZip, readZipText } = await import('./zip');
    await write('Schémas.docx', wordDocx({ body: wordPicture('rId10') + '<w:p><w:r><w:t>Fin</w:t></w:r></w:p>' }));
    render(<App />);
    const editorRegion = await openFromTree('Schémas.docx');
    const content = await within(editorRegion).findByRole('textbox', { name: 'Contenu du document Word' }, partage);
    await waitFor(() => expect(within(content).getByRole('img', { name: 'Image' })).toHaveAttribute('src', expect.stringMatching(/^data:image\/png;base64,/)), partage);

    // Ce que Word ne lit pas tel quel (SVG…) : refusé, rien n'est inséré.
    const input = within(editorRegion).getByLabelText('Insérer une image');
    fireEvent.change(input, { target: { files: [new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'dessin.svg', { type: 'image/svg+xml' })] } });
    expect(await within(editorRegion).findByText(/seules les images PNG, JPEG ou GIF/)).toBeInTheDocument();

    fireEvent.change(input, { target: { files: [new File([pngImage(40, 20) as BlobPart], 'capture.png', { type: 'image/png' })] } });
    expect(await within(content).findByRole('img', { name: 'capture.png' })).toHaveAttribute('src', expect.stringMatching(/^data:image\/png;base64,/));
    expect(within(editorRegion).queryByText(/seules les images PNG, JPEG ou GIF/)).toBeNull();
    // Une capture d'écran collée s'insère de même ; du texte copié depuis Word (qui l'accompagne d'une image), non.
    const screenshot = new File([pngImage(8, 8) as BlobPart], 'image.png', { type: 'image/png' });
    // jsdom ne mesure rien, et ProseMirror fait défiler jusqu'au texte collé.
    const ranges = Range.prototype as unknown as Record<string, unknown>;
    ranges.getClientRects = () => [];
    ranges.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
    fireEvent.paste(content, { clipboardData: { files: [screenshot], types: ['text/plain', 'Files'], getData: (type: string) => (type === 'text/plain' ? 'Texte copié' : '') } });
    delete ranges.getClientRects;
    delete ranges.getBoundingClientRect;
    expect(content).toHaveTextContent('Texte copié');
    expect(within(content).queryByRole('img', { name: 'image.png' })).toBeNull();
    fireEvent.paste(content, { clipboardData: { files: [screenshot], types: ['Files'], getData: () => '' } });
    expect(await within(content).findByRole('img', { name: 'image.png' })).toBeInTheDocument();
    await waitFor(() => expect(within(sharedEditor()).getByText('Brouillon sur cet ordinateur')).toBeInTheDocument(), partage);
    fireEvent.click(within(sharedEditor()).getByRole('button', { name: 'Enregistrer sur le partage' }));
    await waitFor(() => expect(within(sharedEditor()).getByText('Enregistré sur le partage.')).toBeInTheDocument(), partage);

    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    const sent = readZip(new Uint8Array(fs.readFileSync(path.join(share, 'Schémas.docx'))));
    expect(sent.byName.has('word/media/worklogs1.png') && sent.byName.has('word/media/worklogs2.png')).toBe(true);
    expect(await readZipText(sent, 'word/document.xml')).toContain('<a:blip r:embed="rIdWorkLogs1"/>');
  });

  test('une image du partage se voit sur place ; un fichier qui en usurpe le nom, non', async () => {
    const { pngImage } = await import('./test/docx-fixture');
    await write('schema.png', pngImage(4, 2));
    await write('faux.png', '<script>alert(1)</script>');
    render(<App />);
    const image = await openFromTree('schema.png');
    expect(await within(image).findByRole('img', { name: 'schema.png' }, partage)).toHaveAttribute('src', expect.stringMatching(/^data:image\/png;base64,/));
    await openFromTree('faux.png');
    await waitFor(() => expect(within(sharedEditor()).getByRole('heading', { name: 'faux.png' })).toBeInTheDocument(), partage);
    expect(await within(sharedEditor()).findByText(/ne modifie pas les fichiers \.png/, undefined, partage)).toBeInTheDocument();
    expect(within(sharedEditor()).queryByRole('img')).toBeNull();
  });

  test('document Word en suivi des modifications : lecture seule, raison donnée', async () => {
    const { wordDocx } = await import('./test/docx-fixture');
    await write('suivi.docx', wordDocx({ trackRevisions: true }));
    render(<App />);
    const editorRegion = await openFromTree('suivi.docx');
    expect(await within(editorRegion).findByText(/Le suivi des modifications est activé/, undefined, partage)).toBeInTheDocument();
    expect(within(editorRegion).getByLabelText('Style du paragraphe')).toBeDisabled();
    expect(within(editorRegion).getByRole('textbox', { name: 'Contenu du document Word' })).toHaveAttribute('contenteditable', 'false');
  });

  const aiUserMessage = () => (aiBodies.at(-1) as { messages: { role: string; content: string }[] }).messages[1].content;

  test('Markdown du partage : la proposition ne charge que les images déjà dans le fichier', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest('1. Ouvrir les paramètres\n\n![pixel](https://traceur.exemple/p.png)');
    // Le titre ne part pas à l'IA, mais l'aperçu le montre : son image reste celle du fichier.
    await write('Imprimante.md', '# ![logo](https://intranet.exemple/logo.png) Imprimante\n\nIP : 10.0.0.5\n');
    render(<App />);
    const editorRegion = await openFromTree('Imprimante.md');
    await within(editorRegion).findByLabelText('Contenu de Imprimante.md');

    fireEvent.click(await aiAction('Compléter', editorRegion));
    const proposal = await within(sharedEditor()).findByRole('region', { name: 'Procédure proposée' });
    expect([...proposal.querySelectorAll('img')].map((image) => image.getAttribute('src'))).toEqual(['https://intranet.exemple/logo.png']);
    expect(within(proposal).getByText('pixel')).toBeInTheDocument();
  });

  test('Markdown du partage : « Compléter » lit titre et contenu, s’applique en brouillon, part au geste', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest('```markdown\n# Imprimante du bureau\n\nAjouter l’imprimante du bureau.\n\n## Étapes\n\n1. Ouvrir les paramètres\n2. Saisir l’adresse 10.0.0.5\n```');
    await write('Imprimante.md', '# Imprimante du bureau\r\n\r\nIP : 10.0.0.5\r\n');
    render(<App />);
    const editorRegion = await openFromTree('Imprimante.md');
    const area = await within(editorRegion).findByLabelText('Contenu de Imprimante.md');

    fireEvent.click(await aiAction('Compléter', editorRegion));
    const proposal = await within(sharedEditor()).findByRole('region', { name: 'Procédure proposée' });
    // Le titre du fichier fait le titre de la procédure ; l'IA lit ce qui suit.
    expect(aiUserMessage()).toBe('Procédure : Imprimante du bureau\nDéjà écrit :\nIP : 10.0.0.5');
    expect(within(proposal).getAllByRole('heading', { name: 'Imprimante du bureau' })).toHaveLength(1);
    expect(within(proposal).getByText('Saisir l’adresse 10.0.0.5')).toBeInTheDocument();
    // Rien n'est écrit avant « Appliquer ».
    expect(area).toHaveValue('# Imprimante du bureau\n\nIP : 10.0.0.5\n');

    fireEvent.click(within(proposal).getByRole('button', { name: 'Appliquer la procédure' }));
    const proposed = '# Imprimante du bureau\n\nAjouter l’imprimante du bureau.\n\n## Étapes\n\n1. Ouvrir les paramètres\n2. Saisir l’adresse 10.0.0.5\n';
    expect(within(sharedEditor()).getByLabelText('Contenu de Imprimante.md')).toHaveValue(proposed);
    expect(within(sharedEditor()).queryByRole('region', { name: 'Procédure proposée' })).not.toBeInTheDocument();
    await waitFor(() => expect(within(sharedEditor()).getByText('Brouillon sur cet ordinateur')).toBeInTheDocument());
    // Un brouillon, pas un envoi : les collègues ne voient rien avant le geste.
    expect(await read('Imprimante.md')).toBe('# Imprimante du bureau\r\n\r\nIP : 10.0.0.5\r\n');
    fireEvent.click(within(sharedEditor()).getByRole('button', { name: 'Enregistrer sur le partage' }));
    await waitFor(async () => expect(await read('Imprimante.md')).toBe(proposed.replace(/\n/g, '\r\n')));
  });

  test('document Word : « Mettre en page » — objet perdu refusé ; appliquée, seuls les paragraphes changés sont réécrits', async () => {
    const { wordDocx } = await import('./test/docx-fixture');
    const { readZip, readZipText } = await import('./zip');
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    await write('Procédure filtration.docx', wordDocx());
    render(<App />);
    const editorRegion = await openFromTree('Procédure filtration.docx');
    const content = await within(editorRegion).findByRole('textbox', { name: 'Contenu du document Word' });

    // L'IA a perdu le tableau : rien n'est proposé.
    mockAiSuggest('# Filtration\n\nLaver le filtre chaque lundi.\n\n[[objet 1 : Image]]\n\n[[objet 3 : Table des matières]]');
    fireEvent.click(await aiAction('Mettre en page', editorRegion));
    expect(await within(sharedEditor()).findByRole('alert')).toHaveTextContent('La proposition a perdu un objet du document (tableau) : relance-la.');
    // Le document part en Markdown, ses objets en marqueurs.
    expect(aiUserMessage()).toContain('Procédure : Filtration\n\nTexte :\n# Filtration\n\n*Laver* **le filtre** chaque lundi.');
    expect(aiUserMessage()).toContain('[[objet 2 : Tableau — Mesure | Valeur / pH | 7,2]]');
    expect(within(sharedEditor()).queryByRole('region', { name: 'Mise en page proposée' })).not.toBeInTheDocument();

    mockAiSuggest('# Filtration\n\nLaver le filtre chaque lundi.\n\nVoir [le guide](https://exemple.fr/guide).\n\n1. Arrêter la pompe\n2. Fermer la vanne\n\n[[objet 1 : Image]]\n\n[[objet 2 : Tableau]]\n\n[[objet 3 : Table des matières]]');
    fireEvent.click(await aiAction('Mettre en page', sharedEditor()));
    const proposal = await within(sharedEditor()).findByRole('region', { name: 'Mise en page proposée' });
    expect(within(proposal).getByText(/Image — conservé tel quel/)).toBeInTheDocument();
    fireEvent.click(within(proposal).getByRole('button', { name: 'Appliquer la mise en page' }));
    await waitFor(() => expect(content).toHaveTextContent('Fermer la vanne'));
    expect(content).not.toHaveTextContent('Vanne fermée');
    await waitFor(() => expect(within(sharedEditor()).getByText('Brouillon sur cet ordinateur')).toBeInTheDocument());

    fireEvent.click(within(sharedEditor()).getByRole('button', { name: 'Enregistrer sur le partage' }));
    await waitFor(() => expect(within(sharedEditor()).getByText('Enregistré sur le partage.')).toBeInTheDocument());
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    const sent = new Uint8Array(fs.readFileSync(path.join(share, 'Procédure filtration.docx')));
    const after = (await readZipText(readZip(sent), 'word/document.xml'))!;
    // Paragraphe gardé tel quel (le correcteur n'en part qu'à la réécriture), étape neuve dans la liste d'origine, image recopiée.
    expect(after).toContain('<w:proofErr w:type="spellStart"/><w:r><w:rPr><w:b/><w:bCs/></w:rPr><w:t>le filtre</w:t></w:r>');
    expect(after).toContain('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">Fermer la vanne</w:t></w:r>');
    expect(after).toContain('<w:drawing>');
    expect(after).not.toContain('Vanne fermée');
  });

  test('IA du partage : verrou d’un collègue, tableur sans IA, texte brut sans Markdown, fichier modifié avant d’appliquer', async () => {
    localStorage.setItem('worklogs-ai-key', 'cle-test');
    mockAiSuggest('Prérequis\n- Accès admin\n\nÉtapes\n1. Redémarrer le service');
    await write('planning.txt', 'lundi\n');
    await write('relevés.csv', 'a;b\n1;2\n');
    await write('Redémarrage.txt', 'service web\n');
    render(<App />);

    // Ouvert dans LibreOffice par une collègue : lecture seule, l'IA aussi. (Le sondage peut
    // montrer le verrou avant que le contenu soit lu : on attend le contenu, et les boutons avec.)
    await openFromTree('planning.txt');
    await within(sharedEditor()).findByLabelText('Contenu de planning.txt');
    await write('.~lock.planning.txt#', 'Hélène Martin,hmartin,TSE01,05.10.2026 09:00,file:///C:/x;');
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(await within(sharedEditor()).findByText(/Lecture seule — Ouvert par Hélène Martin dans LibreOffice/)).toBeInTheDocument();
    expect(await aiAction('Compléter', sharedEditor())).toBeDisabled();
    expect(await aiAction('Mettre en page', sharedEditor())).toBeDisabled();

    // Un tableur n'a pas de procédure à rédiger.
    await openFromTree('relevés.csv');
    await within(sharedEditor()).findByRole('grid', { name: 'Tableau relevés.csv' });
    expect(within(sharedEditor()).queryByRole('button', { name: 'Assistance IA' })).not.toBeInTheDocument();

    await openFromTree('Redémarrage.txt');
    const area = await within(sharedEditor()).findByLabelText('Contenu de Redémarrage.txt');
    fireEvent.click(await aiAction('Compléter', sharedEditor()));
    const proposal = await within(sharedEditor()).findByRole('region', { name: 'Procédure proposée' });
    expect((aiBodies.at(-1) as { messages: { content: string }[] }).messages[0].content).toMatch(/texte brut, sans syntaxe Markdown/);
    expect(aiUserMessage()).toBe('Procédure : Redémarrage\nDéjà écrit :\nservice web');
    // Un `.txt` se relit tel qu'il sera écrit, sans rendu Markdown.
    expect(proposal.querySelector('pre')!.textContent).toBe('Prérequis\n- Accès admin\n\nÉtapes\n1. Redémarrer le service\n');
    // Une frappe pendant la relecture : appliquer l'effacerait.
    fireEvent.change(area, { target: { value: 'service web et base\n' } });
    fireEvent.click(within(proposal).getByRole('button', { name: 'Appliquer la procédure' }));
    expect(within(sharedEditor()).getByRole('alert')).toHaveTextContent('Le fichier a changé pendant la suggestion : relance-la');
    expect(area).toHaveValue('service web et base\n');
  });

  test('IA du partage avec un service personnalisé sans clé : le bouton l’explique, rien ne part', async () => {
    const calls: string[] = [];
    const diverted = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      return diverted(input, init);
    }));
    localStorage.setItem('worklogs-ai-endpoint', 'https://ia.example/v1');
    await write('notes.md', 'Laver le filtre.\n');
    render(<App />);
    await openFromTree('notes.md');
    fireEvent.click(await aiAction('Mettre en page', sharedEditor()));
    expect(await within(sharedEditor()).findByRole('alert')).toHaveTextContent(/Aucune IA intégrée.*mise en page/);
    expect(calls.some((url) => url.includes('chat/completions'))).toBe(false);
  });

  test('un classeur Excel s’ouvre dans la grille ; une cellule modifiée, seule sa balise change', async () => {
    const { excelWorkbook } = await import('./test/xlsx-fixture');
    const { readZip, readZipText } = await import('./zip');
    const original = excelWorkbook();
    await write('Budget atelier.xlsx', original);
    await clientApi.setSharedDisplayName('T. Grollier');
    render(<App />);
    const editorRegion = await openFromTree('Budget atelier.xlsx');
    const grid = await within(editorRegion).findByRole('grid', { name: 'Feuille Suivi' }, partage);
    expect(within(grid).getByRole('gridcell', { name: 'B2 : 1 234,50 €' })).toHaveClass('is-numeric');
    expect(within(grid).getByRole('gridcell', { name: 'C2 : 05/10/2026' })).toBeInTheDocument();
    const bar = within(editorRegion).getByLabelText('Contenu de la cellule');

    // La barre montre la formule, en français.
    fireEvent.click(within(grid).getByRole('gridcell', { name: 'B4 : 1 334,50 €' }));
    expect(bar).toHaveValue('=SOMME(B2:B3)');
    // Fusionnée : la raison, pas de saisie.
    fireEvent.click(within(grid).getByRole('gridcell', { name: 'B5 : vide' }));
    expect(within(editorRegion).getByText(/B5 : Cellule fusionnée avec A5/)).toBeInTheDocument();
    expect(bar).toHaveAttribute('readonly');

    const target = within(grid).getByRole('gridcell', { name: 'B3 : 100,00 €' });
    fireEvent.click(target);
    fireEvent.keyDown(target, { key: '2' });
    fireEvent.change(bar, { target: { value: '250' } });
    fireEvent.keyDown(bar, { key: 'Enter' });
    expect(within(grid).getByRole('gridcell', { name: 'B3 : 250,00 €' })).toBeInTheDocument();
    await waitFor(() => expect(within(sharedEditor()).getByText('Brouillon sur cet ordinateur')).toBeInTheDocument(), partage);

    fireEvent.click(within(sharedEditor()).getByRole('button', { name: 'Enregistrer sur le partage' }));
    await waitFor(() => expect(within(sharedEditor()).getByText('Enregistré sur le partage.')).toBeInTheDocument(), partage);
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    const sent = new Uint8Array(fs.readFileSync(path.join(share, 'Budget atelier.xlsx')));
    const sheet = (await readZipText(readZip(sent), 'xl/worksheets/sheet1.xml'))!;
    expect(sheet).toContain('<c r="B3" s="2"><v>250</v></c>');
    expect(sheet).toContain('<c r="B2" s="2"><v>1234.5</v></c>');
    expect(await readZipText(readZip(sent), 'xl/sharedStrings.xml')).toBe(await readZipText(readZip(original), 'xl/sharedStrings.xml'));
    expect(await readZipText(readZip(sent), 'docProps/core.xml')).toContain('<cp:lastModifiedBy>T. Grollier</cp:lastModifiedBy>');
    // Relu depuis le partage : la formule qui lit B3 attend son recalcul, WorkLogs la montre.
    await waitFor(() => expect(within(sharedEditor()).getByRole('gridcell', { name: 'B4 : =SOMME(B2:B3)' })).toBeInTheDocument(), partage);
  });

  test('classeur : feuille masquée et protégée, formule fautive signalée avant l’envoi', async () => {
    const { excelWorkbook } = await import('./test/xlsx-fixture');
    const original = excelWorkbook();
    await write('Budget.xlsx', original);
    render(<App />);
    const editorRegion = await openFromTree('Budget.xlsx');
    await within(editorRegion).findByRole('grid', { name: 'Feuille Suivi' }, partage);
    const sheets = within(editorRegion).getByLabelText('Feuille');
    expect([...(sheets as HTMLSelectElement).options].map((option) => option.text)).toEqual(['Suivi', 'Paramètres (masquée)', 'Résumé']);
    fireEvent.change(sheets, { target: { value: '1' } });
    const grid = await within(editorRegion).findByRole('grid', { name: 'Feuille Paramètres' });
    fireEvent.click(within(grid).getByRole('gridcell', { name: 'A1 : Taux' }));
    expect(within(editorRegion).getByText(/A1 : Feuille protégée dans Excel/)).toBeInTheDocument();

    fireEvent.change(sheets, { target: { value: '0' } });
    const suivi = await within(editorRegion).findByRole('grid', { name: 'Feuille Suivi' });
    fireEvent.click(within(suivi).getByRole('gridcell', { name: 'B3 : 100,00 €' }));
    fireEvent.change(within(editorRegion).getByLabelText('Contenu de la cellule'), { target: { value: '=SOMME(B2' } });
    const problems = await within(editorRegion).findByRole('alert', { name: 'À corriger avant l’envoi' });
    expect(problems).toHaveTextContent(/Suivi!B3 : formule incomprise \(parenthèse/);
    fireEvent.click(within(sharedEditor()).getByRole('button', { name: 'Enregistrer sur le partage' }));
    await waitFor(() => expect(within(sharedEditor()).getAllByText(/formule incomprise/).length).toBeGreaterThan(1));
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    expect(Buffer.from(fs.readFileSync(path.join(share, 'Budget.xlsx'))).equals(Buffer.from(original))).toBe(true);
  });

  test('dossier fermé au compte du montage : « accès refusé » sous ce dossier, pas « Lecture… » sans fin', async () => {
    if (process.getuid?.() === 0) return; // root lit partout : test sans objet.
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, 'Global', 'MURGAT INGENIERIE'), { recursive: true });
    await write('notes.md', 'y');
    fs.chmodSync(path.join(share, 'Global'), 0o000);
    try {
      render(<App />);
      fireEvent.click((await tree()).getByRole('button', { name: 'Dossier Global' }));
      expect(await screen.findByText(/Accès refusé à ce dossier : le compte avec lequel le partage est monté n’y a pas droit/, undefined, partage)).toHaveAttribute('role', 'alert');
      expect(screen.queryByText('Lecture…')).not.toBeInTheDocument();
      // Le reste de l'arbre reste utilisable.
      expect(screen.getByRole('button', { name: /^Ouvrir notes\.md/ })).toBeInTheDocument();
    } finally {
      fs.chmodSync(path.join(share, 'Global'), 0o755);
    }
  });

  test('supprime un fichier du partage depuis l’éditeur, après confirmation', async () => {
    await write('notes.md', 'v1\n');
    render(<App />);
    const editorRegion = await openFromTree('notes.md');
    await within(editorRegion).findByLabelText('Contenu de notes.md', undefined, partage);
    fireEvent.click(within(editorRegion).getByRole('button', { name: 'Supprimer du partage' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Fichier partagé' })).not.toBeInTheDocument(), partage);
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    expect(fs.existsSync(path.join(share, 'notes.md'))).toBe(false);
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Ouvrir notes\.md/ })).not.toBeInTheDocument(), partage);
  });

  test('supprime un fichier du partage depuis l’arbre, sans l’ouvrir', async () => {
    await write('à-garder.md', 'gardé\n');
    await write('à-jeter.md', 'jeté\n');
    render(<App />);
    expect((await tree()).getByRole('button', { name: /^Ouvrir à-jeter\.md/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer à-jeter.md du partage' }));
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    await waitFor(() => expect(fs.existsSync(path.join(share, 'à-jeter.md'))).toBe(false), partage);
    expect(fs.existsSync(path.join(share, 'à-garder.md'))).toBe(true);
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Ouvrir à-jeter\.md/ })).not.toBeInTheDocument(), partage);
  });

  test('annule la suppression depuis l’arbre : rien ne part', async () => {
    await write('notes.md', 'v1\n');
    render(<App />);
    expect((await tree()).getByRole('button', { name: /^Ouvrir notes\.md/ })).toBeInTheDocument();
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer notes.md du partage' }));
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    expect(fs.existsSync(path.join(share, 'notes.md'))).toBe(true);
    expect(screen.getByRole('button', { name: /^Ouvrir notes\.md/ })).toBeInTheDocument();
  });

  test('suppression refusée avec un brouillon : le fichier reste, l’erreur se lit', async () => {
    await write('notes.md', 'v1\n');
    render(<App />);
    const editorRegion = await openFromTree('notes.md');
    fireEvent.change(await within(editorRegion).findByLabelText('Contenu de notes.md', undefined, partage), { target: { value: 'v1\nmoi\n' } });
    await waitFor(() => expect(within(editorRegion).getByText('Brouillon sur cet ordinateur')).toBeInTheDocument(), partage);
    fireEvent.click(within(editorRegion).getByRole('button', { name: 'Supprimer du partage' }));
    expect(await within(editorRegion).findByText(/Envoie ou abandonne d’abord ton brouillon/, undefined, partage)).toBeInTheDocument();
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    expect(fs.existsSync(path.join(share, 'notes.md'))).toBe(true);
  });

  test('nouveau dossier : créé où l’on est, déplié aussitôt, un nouveau fichier y va ; un nom pris n’écrase rien', async () => {
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, 'Procédures'));
    await write('Procédures/existant.md', 'x\n');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '＋ Nouveau dossier…' }, partage));
    const form = screen.getByRole('form', { name: 'Nouveau dossier' });
    expect(within(form).getByLabelText('Emplacement du nouveau dossier')).toHaveValue('');
    fireEvent.change(within(form).getByLabelText('Nom du dossier'), { target: { value: ' 3. Sauvegardes ' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Créer' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Dossier 3. Sauvegardes' })).toHaveAttribute('aria-expanded', 'true'));
    expect(fs.statSync(path.join(share, '3. Sauvegardes')).isDirectory()).toBe(true);
    expect(await screen.findByText('Dossier vide.')).toBeInTheDocument();
    // Le fichier neuf suivant va dans le dossier qu'on vient de créer.
    fireEvent.click(screen.getByRole('button', { name: '＋ Nouveau fichier…' }));
    const fileForm = screen.getByRole('form', { name: 'Nouveau fichier' });
    expect(within(fileForm).getByLabelText('Dossier du nouveau fichier')).toHaveValue('3. Sauvegardes');
    fireEvent.click(within(fileForm).getByRole('button', { name: 'Annuler' }));

    fireEvent.click(screen.getByRole('button', { name: '＋ Nouveau dossier…' }));
    const again = screen.getByRole('form', { name: 'Nouveau dossier' });
    fireEvent.change(within(again).getByLabelText('Emplacement du nouveau dossier'), { target: { value: '' } });
    fireEvent.change(within(again).getByLabelText('Nom du dossier'), { target: { value: 'Procédures' } });
    fireEvent.click(within(again).getByRole('button', { name: 'Créer' }));
    expect(await screen.findByText('« Procédures » existe déjà dans ce dossier : rien n’a été créé. Choisis un autre nom.')).toBeInTheDocument();
    expect(await read('Procédures/existant.md')).toBe('x\n');
  });

  test('renommer un dossier dans sa ligne : l’arbre et le fichier ouvert dedans suivent', async () => {
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, 'Projets'));
    await write('Projets/notes.md', 'v1\n');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dossier Projets' }));
    const editorRegion = await openFromTree('notes.md');
    expect(await within(editorRegion).findByLabelText('Contenu de notes.md')).toHaveValue('v1\n');

    fireEvent.click(screen.getByRole('button', { name: 'Renommer ou supprimer Projets' }));
    fireEvent.click(screen.getByRole('button', { name: 'Renommer Projets' }));
    const form = screen.getByRole('form', { name: 'Renommer le dossier Projets' });
    const field = within(form).getByLabelText('Nouveau nom du dossier');
    expect(field).toHaveValue('Projets');
    fireEvent.change(field, { target: { value: 'Chantiers' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Renommer' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Dossier Chantiers' })).toHaveAttribute('aria-expanded', 'true'));
    expect(fs.existsSync(path.join(share, 'Projets'))).toBe(false);
    expect(await screen.findByRole('button', { name: /^Ouvrir notes\.md/ })).toBeInTheDocument();

    // Le fichier ouvert a suivi : ce qu'on y écrit part dans le dossier renommé.
    const content = await within(sharedEditor()).findByLabelText('Contenu de notes.md');
    fireEvent.change(content, { target: { value: 'v1\nsuite\n' } });
    await waitFor(() => expect(within(sharedEditor()).getByText('Brouillon sur cet ordinateur')).toBeInTheDocument());
    fireEvent.click(within(sharedEditor()).getByRole('button', { name: 'Enregistrer sur le partage' }));
    await waitFor(() => expect(within(sharedEditor()).getByText('Enregistré sur le partage.')).toBeInTheDocument());
    expect(await read('Chantiers/notes.md')).toBe('v1\nsuite\n');
    expect(fs.existsSync(path.join(share, 'Projets'))).toBe(false);
  });

  test('renommer ou supprimer un dossier partagé : tous les liens concernés suivent', async () => {
    seedData(api.db, { projects: [{ id: 'pr_p', name: 'Piscine' }, { id: 'pr_a', name: 'Atelier' }, { id: 'pr_x', name: 'Bureau' }] });
    const linksOf = async (id: string) => (await clientApi.state()).projects.find((project) => project.id === id)?.shared_dirs;
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, 'Piscine', 'Filtres'), { recursive: true });
    fs.mkdirSync(path.join(share, 'Piscine', 'Pompes'));
    fs.mkdirSync(path.join(share, 'Atelier'));
    fs.mkdirSync(path.join(share, 'Bureau'));
    await clientApi.updateProject('pr_p', { shared_dirs: ['Piscine/Filtres', 'Piscine/Pompes'] });
    await clientApi.updateProject('pr_a', { shared_dirs: ['Atelier', 'Bureau'] });
    await clientApi.updateProject('pr_x', { shared_dirs: ['Bureau'] });
    render(<App />);

    fireEvent.click(await (await tree()).findByRole('button', { name: 'Renommer ou supprimer Piscine' }));
    fireEvent.click(screen.getByRole('button', { name: 'Renommer Piscine' }));
    const form = screen.getByRole('form', { name: 'Renommer le dossier Piscine' });
    fireEvent.change(within(form).getByLabelText('Nouveau nom du dossier'), { target: { value: 'Bassin' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Renommer' }));
    await waitFor(async () => expect(await linksOf('pr_p')).toEqual(['Bassin/Filtres', 'Bassin/Pompes']), partage);

    fireEvent.click(await (await tree()).findByRole('button', { name: 'Renommer ou supprimer Atelier' }));
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer Atelier du partage' }));
    await waitFor(async () => expect(await linksOf('pr_a')).toEqual(['Bureau']), partage);
    expect(await linksOf('pr_x')).toEqual(['Bureau']);
  });

  test('renommer refusé tant qu’un brouillon attend dedans : la raison sous le dossier, Échap annule', async () => {
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, 'Projets'));
    await write('Projets/notes.md', 'v1\n');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dossier Projets' }));
    const editorRegion = await openFromTree('notes.md');
    fireEvent.change(await within(editorRegion).findByLabelText('Contenu de notes.md'), { target: { value: 'v1\nmoi\n' } });
    await waitFor(() => expect(within(editorRegion).getByText('Brouillon sur cet ordinateur')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Renommer ou supprimer Projets' }));
    fireEvent.click(screen.getByRole('button', { name: 'Renommer Projets' }));
    const field = screen.getByLabelText('Nouveau nom du dossier');
    fireEvent.change(field, { target: { value: 'Chantiers' } });
    fireEvent.click(screen.getByRole('button', { name: 'Renommer' }));
    expect(await screen.findByText('« Projets/notes.md » a un brouillon sur cet ordinateur : envoie-le ou abandonne-le avant de renommer ce dossier.'))
      .toHaveAttribute('role', 'alert');
    expect(fs.existsSync(path.join(share, 'Projets', 'notes.md'))).toBe(true);
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByRole('form', { name: 'Renommer le dossier Projets' })).not.toBeInTheDocument();
    expect(screen.queryByText(/a un brouillon sur cet ordinateur/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dossier Projets' })).toBeInTheDocument();
  });

  test('supprimer un dossier : la confirmation dit ce qui part ; le fichier ouvert dedans se referme', async () => {
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, 'Archives', '2024'), { recursive: true });
    await write('Archives/2024/bilan.md', '# Bilan\n');
    await write('Archives/notes.md', 'v1\n');
    await write('garde.md', 'gardé\n');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dossier Archives' }, { timeout: 5000 }));
    await openFromTree('notes.md');
    fireEvent.click(screen.getByRole('button', { name: 'Renommer ou supprimer Archives' }));
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer Archives du partage' }));
    await waitFor(() => expect(fs.existsSync(path.join(share, 'Archives'))).toBe(false));
    expect(window.confirm).toHaveBeenLastCalledWith(
      'Supprimer le dossier « Archives » et tout son contenu (2 fichiers et 1 sous-dossier) du dossier partagé ? Cette action est immédiate pour toute l’équipe.',
    );
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Fichier partagé' })).not.toBeInTheDocument(), { timeout: 5000 });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Dossier Archives' })).not.toBeInTheDocument(), { timeout: 5000 });
    expect(await read('garde.md')).toBe('gardé\n');
  });

  test('supprimer un dossier : annulé, rien ne part ; un fichier ouvert par un collègue, refusé sans rien demander', async () => {
    const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
    fs.mkdirSync(path.join(share, 'Archives'));
    await write('Archives/notes.md', 'v1\n');
    fs.mkdirSync(path.join(share, 'Planning'));
    await write('Planning/relevés.csv', 'a;b\n');
    await write('Planning/~$relevés.csv', excelOwner('Jean Dupont'));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Renommer ou supprimer Archives' }));
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer Archives du partage' }));
    await waitFor(() => expect(window.confirm).toHaveBeenCalledTimes(1));
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining('et tout son contenu (1 fichier)'));
    expect(fs.existsSync(path.join(share, 'Archives', 'notes.md'))).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Renommer ou supprimer Planning' }));
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer Planning du partage' }));
    expect(await screen.findByText('« Planning/relevés.csv » est ouvert par Jean Dupont dans Excel : il doit être fermé avant de supprimer ce dossier.'))
      .toHaveAttribute('role', 'alert');
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(share, 'Planning', 'relevés.csv'))).toBe(true);
  });

  test('choisir une entrée referme le fichier partagé', async () => {
    seedData(api.db, { entries: [{ id: 'en_1', title: 'Compte rendu' }] });
    await write('notes.md', 'v1\n');
    render(<App />);
    await openFromTree('notes.md');
    fireEvent.click(await within(journal()).findByText('Compte rendu'));
    expect(await screen.findByRole('region', { name: 'Entrée' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Fichier partagé' })).not.toBeInTheDocument();
  });

  describe('« ✨ Trouver la doc » d’une tâche', () => {
    // Une procédure d'un autre projet, une note trouvée par son texte, une note déjà liée.
    const seedTask = () => {
      seedData(api.db, {
        projects: [{ id: 'pr_bureau', name: 'Bureau' }, { id: 'pr_info', name: 'Informatique' }],
        entries: [
          { id: 'en_proc', title: 'Installer une imprimante', kind: 'procedure', project_id: 'pr_info', content_md: 'Brancher le câble USB.' },
          { id: 'en_note', title: 'Compte rendu du lundi', project_id: 'pr_bureau', content_md: 'Le pilote fourni ne marche pas sous Windows 11.' },
          { id: 'en_lie', title: 'Imprimante du bureau 2', project_id: 'pr_bureau', content_md: 'Contenu de la note liée.' },
        ],
        tasks: [{ id: 'tk_imp', title: 'Brancher la nouvelle imprimante', project_id: 'pr_bureau' }],
      });
      api.db.prepare('INSERT INTO task_entries (task_id,entry_id,created_at) VALUES (?,?,?)').run('tk_imp', 'en_lie', new Date().toISOString());
      localStorage.setItem('worklogs-project', 'pr_bureau');
      localStorage.setItem('worklogs-ai-key', 'cle-test');
    };
    const findDocs = async () => {
      const card = (await within(board()).findByText('Brancher la nouvelle imprimante')).closest('.card') as HTMLElement;
      fireEvent.click(await aiAction('Trouver la doc', card, 'Assistance IA de la tâche'));
      return card;
    };

    test('Trouver la doc : WorkLogs et le partage répondent aux mots de l’IA ; lier une procédure, ouvrir un fichier', async () => {
      mockAiSuggest(JSON.stringify(['imprimante', 'pilote']));
      seedTask();
      const [fs, path] = await Promise.all([nodeFs(), nodePath()]);
      fs.mkdirSync(path.join(share, 'Imprimantes'));
      await write('Imprimantes/Pilote HP.md', '# Pilote HP\n');
      render(<App />);

      const card = await findDocs();
      const found = await within(card).findByRole('region', { name: 'Documents trouvés' }, partage);
      expect(within(found).getByText('Cherché avec : imprimante, pilote')).toBeInTheDocument();
      // Mot du titre avant mot du texte ; à mot égal, la note de WorkLogs avant le fichier du
      // partage, trouvé par son seul nom. La note déjà liée n'est pas reproposée.
      expect(within(found).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
        'ProcédureInstaller une imprimanteInformatique · trouvé avec : imprimanteOuvrirLier',
        'NoteCompte rendu du lunditrouvé avec : piloteOuvrirLier',
        'PartagePilote HP.mdImprimantes · trouvé avec : piloteOuvrir',
      ]);
      // Des titres partent, jamais le texte d'un document.
      const sent = (aiBodies.at(-1) as { messages: { content: string }[] }).messages[1].content;
      expect(sent).toContain('Tâche : Brancher la nouvelle imprimante\nStatut : À faire\nProjet : Bureau');
      expect(sent).toContain('Documents déjà liés à la tâche : Imprimante du bureau 2');
      expect(sent).not.toContain('Contenu de la note liée');
      expect(sent).not.toContain('Le pilote fourni');

      fireEvent.click(within(found).getByRole('button', { name: 'Lier Installer une imprimante à la tâche' }));
      expect(await within(found).findByText('Liée')).toBeInTheDocument();
      expect(row(api.db, 'SELECT COUNT(*) n FROM task_entries WHERE task_id=? AND entry_id=?', 'tk_imp', 'en_proc').n).toBe(1);
      expect(within(card).getByRole('button', { name: 'Retirer Installer une imprimante de Brancher la nouvelle imprimante' })).toBeInTheDocument();

      fireEvent.click(within(found).getByRole('button', { name: 'Ouvrir Pilote HP.md' }));
      const opened = await screen.findByRole('region', { name: 'Fichier partagé' }, partage);
      expect(await within(opened).findByLabelText('Contenu de Pilote HP.md', undefined, partage)).toHaveValue('# Pilote HP\n');
    });

    test('Trouver la doc sans dossier partagé : WorkLogs seul, et « Ouvrir » suit le projet du document', async () => {
      await api.close();
      await reopenApi();
      mockAiSuggest(JSON.stringify(['imprimante', 'pilote']));
      seedTask();
      render(<App />);

      const found = await within(await findDocs()).findByRole('region', { name: 'Documents trouvés' }, partage);
      expect(within(found).getByText('Dossier partagé indisponible : recherche dans WorkLogs seulement.')).toBeInTheDocument();
      expect(within(found).getAllByRole('button', { name: /^Ouvrir / }).map((button) => button.getAttribute('aria-label')))
        .toEqual(['Ouvrir Installer une imprimante', 'Ouvrir Compte rendu du lundi']);

      // La procédure n'est ni dans le projet filtré ni liée : le filtre suit quand même son projet.
      fireEvent.click(within(found).getByRole('button', { name: 'Ouvrir Installer une imprimante' }));
      await waitFor(() => expect(within(filters()).getByRole('button', { name: /^Informatique/ })).toHaveAttribute('aria-pressed', 'true'));
      await waitFor(() => expect(screen.getByLabelText('Titre de l’entrée')).toHaveValue('Installer une imprimante'));
    });

    test('Trouver la doc : Arrêter pendant les recherches abandonne les mots suivants, sans erreur ni liste', async () => {
      mockAiSuggest(JSON.stringify(['imprimante', 'pilote']));
      seedTask();
      const originalState = clientApi.state.bind(clientApi);
      const terms: string[] = [];
      let release!: () => void;
      vi.spyOn(clientApi, 'state').mockImplementation(async (q = '', projectId = '', categoryId = '') => {
        if (q) {
          terms.push(q);
          await new Promise<void>((resolve) => { release = resolve; });
        }
        return originalState(q, projectId, categoryId);
      });
      render(<App />);

      const card = await findDocs();
      await waitFor(() => expect(terms).toEqual(['imprimante']), partage);
      fireEvent.click(within(card).getByRole('button', { name: 'Arrêter la demande IA' }));
      await act(async () => release());
      expect(await within(card).findByRole('button', { name: 'Assistance IA de la tâche' }, partage)).toBeInTheDocument();
      expect(terms).toEqual(['imprimante']);
      expect(within(card).queryByRole('region', { name: 'Documents trouvés' })).not.toBeInTheDocument();
      expect(within(card).queryByRole('alert')).not.toBeInTheDocument();
    });

    test('Trouver la doc : une réponse IA illisible s’affiche en erreur, rien n’est cherché ni listé', async () => {
      mockAiSuggest('Voici quelques mots : imprimante, pilote.');
      seedTask();
      const search = vi.spyOn(clientApi, 'searchShared');
      render(<App />);

      const card = await findDocs();
      expect(await within(card).findByRole('alert')).toHaveTextContent('Réponse IA illisible : réessaie.');
      expect(within(card).queryByRole('region', { name: 'Documents trouvés' })).not.toBeInTheDocument();
      expect(await aiAction('Trouver la doc', card, 'Assistance IA de la tâche')).toBeEnabled();
      expect(search).not.toHaveBeenCalled();
    });
  });
});
