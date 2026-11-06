import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { AiMenu } from './AiMenu';

afterEach(() => vi.useRealTimers());

test('pendant l’attente, le bouton compte les secondes passé trois, sans changer son nom', () => {
  vi.useFakeTimers();
  const menu = (busy: string | null) => <AiMenu label="Assistance IA" busy={busy} onCancel={() => {}}><button role="menuitem">Compléter</button></AiMenu>;
  const { rerender } = render(menu('Rédaction…'));
  const trigger = screen.getByRole('button', { name: 'Rédaction…' });
  expect(trigger).toHaveClass('is-busy');
  act(() => { vi.advanceTimersByTime(2000); });
  expect(trigger).not.toHaveTextContent('s');
  act(() => { vi.advanceTimersByTime(2000); });
  expect(trigger).toHaveTextContent('Rédaction… 4 s');
  act(() => { vi.advanceTimersByTime(12_000); });
  expect(trigger).toHaveAttribute('title', 'Le modèle met du temps : « Arrêter » coupe la demande.');
  // Une nouvelle demande repart de zéro.
  rerender(menu(null));
  expect(screen.getByRole('button', { name: 'Assistance IA' })).not.toHaveClass('is-busy');
  rerender(menu('Mise en page…'));
  expect(screen.getByRole('button', { name: 'Mise en page…' })).toHaveTextContent(/^✨Mise en page…$/);
});
