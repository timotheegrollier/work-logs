import { useLayoutEffect } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { DraftedProcedure } from '../ai-suggest';
import { ProcedureDraft } from './ProcedureDraft';

const callbacks = () => ({ projectId: null, busy: false, onRefresh: vi.fn(), onCreated: vi.fn(), onClose: vi.fn() });

test('une saisie avant les effets de montage garde le titre vidé', async () => {
  const draft: DraftedProcedure = { title: 'Relancer la pompe', markdown: '1. Couper le courant', truncated: false };
  function ImmediateEdit() {
    // Rejouer l'ordre qui perdait la suppression : champ affiché, saisie, puis
    // effets passifs de montage. Aucun délai ni modification du scheduler React.
    useLayoutEffect(() => {
      const field = screen.getByLabelText('Titre de la procédure');
      // Déclencher l'entrée native dans le layout, sous l'act du montage : un
      // fireEvent envelopperait un deuxième act pendant le commit de React.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }, []);
    return <ProcedureDraft draft={draft} {...callbacks()} />;
  }
  await act(async () => { render(<ImmediateEdit />); });
  expect(screen.getByLabelText('Titre de la procédure')).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Créer la procédure' })).toBeDisabled();
});

test('une nouvelle proposition renouvelle le titre, un simple rendu garde sa correction', () => {
  const draft: DraftedProcedure = { title: 'Relancer la pompe', markdown: '1. Couper le courant', truncated: false };
  const props = callbacks();
  const { rerender } = render(<ProcedureDraft draft={draft} {...props} />);
  fireEvent.change(screen.getByLabelText('Titre de la procédure'), { target: { value: 'Pompe du bassin 3' } });
  rerender(<ProcedureDraft draft={draft} {...props} busy />);
  expect(screen.getByLabelText('Titre de la procédure')).toHaveValue('Pompe du bassin 3');

  // Même titre suggéré, mais nouveau texte après Rafraîchir : la relecture repart
  // de cette proposition, sans conserver la correction de la précédente.
  const refreshed = { ...draft, markdown: '1. Vérifier le disjoncteur' };
  rerender(<ProcedureDraft draft={refreshed} {...props} />);
  expect(screen.getByLabelText('Titre de la procédure')).toHaveValue('Relancer la pompe');
  fireEvent.change(screen.getByLabelText('Titre de la procédure'), { target: { value: '' } });
  rerender(<ProcedureDraft draft={refreshed} {...props} />);
  expect(screen.getByLabelText('Titre de la procédure')).toHaveValue('');
});
