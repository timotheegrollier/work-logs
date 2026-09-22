import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { GoogleStatus } from '../lib';

export interface SyncInfo {
  state: 'idle' | 'syncing' | 'error' | 'off';
  lastSyncedAt: string | null;
  error?: string;
}

/**
 * Menu du compte : remplace le bouton ⚙ Paramètres de l'en-tête (même place,
 * même taille) pour ne pas ajouter de contrôle. Déconnecté, il reste l'accès
 * aux Paramètres ; connecté, il montre le compte Google et ses actions.
 */
export function AccountMenu({
  status,
  sync,
  onSettings,
  onDocuments,
  onConnect,
  onSwitch,
  onDisconnect,
  onSyncNow,
}: {
  status: GoogleStatus | null;
  sync?: SyncInfo | null;
  onSettings: () => void;
  onDocuments: () => void;
  onConnect: () => void;
  onSwitch: () => void;
  onDisconnect: () => void;
  onSyncNow?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const account = status?.connected ? status.account ?? null : null;
  const connected = Boolean(status?.connected);

  // Fermeture au clic extérieur : le menu ne doit jamais rester ouvert par-dessus l'écriture.
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  const label = account ? `Compte Google : ${account.name || account.email}` : 'Compte et paramètres';
  return (
    <div className="account-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        className={'ghost settings-btn' + (account ? ' has-account' : '')}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        title={account ? `${account.name || account.email} — compte et paramètres` : 'Compte et paramètres (dont Google Drive)'}
        onClick={() => setOpen((value) => !value)}
      >
        {account ? (
          <>
            <Avatar name={account.name} email={account.email} picture={account.picture} />
            <span className="settings-label">{(account.name || account.email).split(/[\s@]/)[0]}</span>
          </>
        ) : (
          <>
            <span className="settings-icon" aria-hidden="true">⚙</span>
            <span className="settings-label">Paramètres</span>
          </>
        )}
        {sync && connected && <span className={'sync-dot is-' + sync.state} aria-hidden="true" />}
      </button>
      {open && (
        <div className="account-popover" id={menuId} role="menu" aria-label="Compte et paramètres" ref={menuRef} onKeyDown={onMenuKey}>
          {account ? (
            <div className="account-card">
              <Avatar name={account.name} email={account.email} picture={account.picture} large />
              <div>
                <strong>{account.name || account.email}</strong>
                {account.name && <small>{account.email}</small>}
                {sync && <small className={'sync-line is-' + sync.state}>{syncLabel(sync)}</small>}
              </div>
            </div>
          ) : connected ? (
            <div className="account-card"><div><strong>Google connecté</strong><small>Reconnecte-toi pour afficher le compte.</small></div></div>
          ) : (
            <div className="account-card">
              <div>
                <strong>Non connecté</strong>
                <small>Facultatif : sauvegarde et synchronisation avec Google Drive.</small>
              </div>
            </div>
          )}
          {connected && status?.expired && (
            <button type="button" role="menuitem" className="is-primary" onClick={choose(onConnect)}>Reprendre la session Google</button>
          )}
          {!connected && status?.configured && (
            <button type="button" role="menuitem" className="is-primary" onClick={choose(onConnect)}>Se connecter avec Google</button>
          )}
          {connected && <button type="button" role="menuitem" onClick={choose(onDocuments)}>Documents Google</button>}
          {connected && onSyncNow && !status?.expired && (
            <button type="button" role="menuitem" disabled={sync?.state === 'syncing'} onClick={choose(onSyncNow)}>Synchroniser maintenant</button>
          )}
          <button type="button" role="menuitem" onClick={choose(onSettings)}>Paramètres</button>
          {connected && <button type="button" role="menuitem" onClick={choose(onSwitch)}>Changer de compte</button>}
          {connected && <button type="button" role="menuitem" className="is-danger" onClick={choose(onDisconnect)}>Se déconnecter</button>}
        </div>
      )}
    </div>
  );
}

function syncLabel(sync: SyncInfo): string {
  if (sync.state === 'syncing') return 'Synchronisation…';
  if (sync.state === 'error') return sync.error || 'Synchronisation en échec';
  if (sync.state === 'off') return 'Synchronisation en pause';
  if (!sync.lastSyncedAt) return 'Pas encore synchronisé';
  return `Synchronisé ${sinceLabel(sync.lastSyncedAt)}`;
}

export function sinceLabel(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 45) return 'à l’instant';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  return `à ${new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
}

/** Photo Google si disponible, sinon l'initiale sur une pastille stable. */
function Avatar({ name, email, picture, large = false }: { name: string; email: string; picture?: string; large?: boolean }) {
  const [broken, setBroken] = useState(false);
  const initial = (name || email).trim().charAt(0).toUpperCase() || '?';
  const hue = Array.from(email).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360;
  return picture && !broken ? (
    <img className={'avatar' + (large ? ' is-large' : '')} src={picture} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
  ) : (
    <span className={'avatar is-initial' + (large ? ' is-large' : '')} style={{ background: `hsl(${hue} 55% 45%)` }} aria-hidden="true">{initial}</span>
  );
}
