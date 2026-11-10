import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { FollowUp } from '../lib';
import { FollowUpContext } from '../follow-up-controller';
import { FollowUpPanel } from './FollowUpPanel';

const followUp: FollowUp = {
  enabled: true,
  enabled_at: '2026-11-10T09:00:00.000Z',
  report: {
    status: 'doing',
    summary: 'Le joint est livré.',
    completed: ['Pompe remontée.'],
    next_steps: ['Poser le joint.'],
    blockers: [],
    warnings: [],
    generated_at: '2026-11-10T10:00:00.000Z',
    source_key: 'version-avant-edition',
  },
};

const item = {
  id: 'en_1',
  title: 'Note évolutive',
  follow_up: followUp,
  follow_up_key: 'version-apres-edition',
};

const control = (background: boolean) => ({
  runtime: { 'entry:en_1': { busy: true, error: '', background } },
  toggle: vi.fn(),
  refresh: vi.fn(),
  stop: vi.fn(),
  hold: () => () => {},
});

test('une actualisation automatique reste discrète et laisse le bilan affiché', () => {
  render(
    <FollowUpContext.Provider value={control(true)}>
      <FollowUpPanel kind="entry" item={item} />
    </FollowUpContext.Provider>,
  );
  // Le bilan précédent reste lisible pendant que la nouvelle version se prépare.
  expect(screen.getByText('Le joint est livré.')).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Actualisation en cours…');
  expect(screen.queryByText('L’IA prépare le bilan…')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Actualiser le bilan de Note évolutive' })).toBeDisabled();
});

test('une actualisation demandée garde l’attente visible sous le bilan', () => {
  render(
    <FollowUpContext.Provider value={control(false)}>
      <FollowUpPanel kind="entry" item={item} />
    </FollowUpContext.Provider>,
  );
  expect(screen.getByText('Le joint est livré.')).toBeInTheDocument();
  expect(screen.getByText('L’IA prépare le bilan…')).toBeInTheDocument();
  expect(screen.queryByText('Actualisation en cours…')).not.toBeInTheDocument();
});

test('une demande en file annonce son attente plutôt qu’un travail en cours', () => {
  render(
    <FollowUpContext.Provider value={{ ...control(false), runtime: { 'entry:en_1': { busy: true, queued: true, error: '', background: false } } }}>
      <FollowUpPanel kind="entry" item={item} />
    </FollowUpContext.Provider>,
  );
  expect(screen.getByText('En attente…')).toBeInTheDocument();
  expect(screen.queryByText('L’IA prépare le bilan…')).not.toBeInTheDocument();
});
