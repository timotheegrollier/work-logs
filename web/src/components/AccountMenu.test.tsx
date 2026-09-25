import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AccountMenu, sinceLabel } from './AccountMenu';
import type { GoogleStatus } from '../lib';

const base: GoogleStatus = { available: true, configured: true, connected: false, pending: false, error: '', selectedIds: [] };
const connected: GoogleStatus = {
  ...base, connected: true,
  account: { email: 'timo@example.com', name: 'Timo Grollier', picture: 'https://lh3.googleusercontent.com/a/photo' },
};

function setup(status: GoogleStatus | null, sync = null as Parameters<typeof AccountMenu>[0]['sync']) {
  const handlers = { onSettings: vi.fn(), onDocuments: vi.fn(), onConnect: vi.fn(), onSwitch: vi.fn(), onDisconnect: vi.fn(), onSyncNow: vi.fn() };
  render(<><AccountMenu status={status} sync={sync} {...handlers} /><p>Ailleurs</p></>);
  return handlers;
}

describe('menu du compte', () => {
  test('déconnecté : le bouton reste l’accès aux Paramètres et propose la connexion', async () => {
    const user = userEvent.setup();
    const handlers = setup(base);
    const trigger = screen.getByRole('button', { name: 'Compte et paramètres' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menu', { name: 'Compte et paramètres' })).toHaveTextContent('Non connecté');
    expect(screen.queryByRole('menuitem', { name: 'Documents Google' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Se déconnecter' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Se connecter avec Google' }));
    expect(handlers.onConnect).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  test('déconnecté : l’échec de connexion reste visible dans le menu', async () => {
    const user = userEvent.setup();
    setup(base, { state: 'error', lastSyncedAt: null, error: 'Google a refusé la connexion' });
    await user.click(screen.getByRole('button', { name: 'Compte et paramètres' }));
    expect(screen.getByRole('menu')).toHaveTextContent('Google a refusé la connexion');
  });

  test('sans client configuré : seulement les Paramètres', async () => {
    const user = userEvent.setup();
    setup({ ...base, configured: false });
    await user.click(screen.getByRole('button', { name: 'Compte et paramètres' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Paramètres']);
  });

  test('connecté : photo, nom, e-mail, état de synchro et toutes les actions', async () => {
    const user = userEvent.setup();
    const handlers = setup(connected, { state: 'idle', lastSyncedAt: new Date().toISOString() });
    const trigger = screen.getByRole('button', { name: 'Compte Google : Timo Grollier' });
    expect(trigger.querySelector('img.avatar')).toHaveAttribute('src', connected.account!.picture);
    expect(trigger.querySelector('img.avatar')).toHaveAttribute('referrerpolicy', 'no-referrer');
    await user.click(trigger);
    const menu = screen.getByRole('menu');
    expect(menu).toHaveTextContent('Timo Grollier');
    expect(menu).toHaveTextContent('timo@example.com');
    expect(menu).toHaveTextContent('Synchronisé à l’instant');
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Documents Google', 'Synchroniser maintenant', 'Paramètres', 'Changer de compte', 'Se déconnecter',
    ]);
    await user.click(screen.getByRole('menuitem', { name: 'Documents Google' }));
    expect(handlers.onDocuments).toHaveBeenCalledOnce();
    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: 'Changer de compte' }));
    expect(handlers.onSwitch).toHaveBeenCalledOnce();
    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: 'Se déconnecter' }));
    expect(handlers.onDisconnect).toHaveBeenCalledOnce();
  });

  test('session expirée : la reprise vient en premier, sans synchro manuelle', async () => {
    const user = userEvent.setup();
    const handlers = setup({ ...connected, expired: true }, { state: 'off', lastSyncedAt: null });
    await user.click(screen.getByRole('button', { name: 'Compte Google : Timo Grollier' }));
    expect(screen.getAllByRole('menuitem')[0]).toHaveTextContent('Reprendre la session Google');
    expect(screen.queryByRole('menuitem', { name: 'Synchroniser maintenant' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Reprendre la session Google' }));
    expect(handlers.onConnect).toHaveBeenCalledOnce();
  });

  test('clavier : focus sur le premier choix, flèches, Échap rend le focus', async () => {
    const user = userEvent.setup();
    setup(connected);
    const trigger = screen.getByRole('button', { name: 'Compte Google : Timo Grollier' });
    await user.click(trigger);
    const items = screen.getAllByRole('menuitem');
    expect(items[0]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(items[1]).toHaveFocus();
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(items.at(-1)).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  test('un clic ailleurs ferme le menu', async () => {
    const user = userEvent.setup();
    setup(connected);
    await user.click(screen.getByRole('button', { name: 'Compte Google : Timo Grollier' }));
    await user.click(screen.getByText('Ailleurs'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  test('photo introuvable : initiale sur une pastille', () => {
    setup(connected);
    const trigger = screen.getByRole('button', { name: 'Compte Google : Timo Grollier' });
    fireEvent.error(trigger.querySelector('img.avatar')!);
    expect(trigger.querySelector('.avatar.is-initial')).toHaveTextContent('T');
  });

  test('libellés de temps relatifs', () => {
    const now = Date.parse('2026-09-22T10:00:00Z');
    expect(sinceLabel('2026-09-22T09:59:40Z', now)).toBe('à l’instant');
    expect(sinceLabel('2026-09-22T09:55:00Z', now)).toBe('il y a 5 min');
    expect(sinceLabel('2026-09-22T07:00:00Z', now)).toMatch(/^à \d{2}:\d{2}$/);
  });
});
