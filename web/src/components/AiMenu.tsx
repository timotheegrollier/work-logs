import { Children, useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';

/**
 * Les actions IA d'une note, d'un fichier ou d'une tâche derrière un seul « ✨ IA » :
 * une pastille par action encombrait la rangée. Même clavier que le menu du compte.
 * Le menu se referme dès qu'on choisit : le bouton affiche alors l'attente (`busy`).
 */
export function AiMenu({ label, busy, className = 'ghost', children }: {
  label: string;
  busy?: string | null;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    // Tout le menu à l'écran (au pied d'une carte, sur mobile au-dessus de la barre du bas), puis le clavier dedans.
    menuRef.current?.scrollIntoView?.({ block: 'nearest' });
    (menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? menuRef.current)?.focus({ preventScroll: true });
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  if (Children.toArray(children).length === 0) return null;

  const closeToTrigger = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const onMenuClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[role="menuitem"]')) closeToTrigger();
  };
  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      closeToTrigger();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div className="ai-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        className={className}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={busy || label}
        onClick={() => setOpen((value) => !value)}
      >
        {busy || <><span aria-hidden="true">✨ </span>IA<span className="ai-menu-caret" aria-hidden="true">▾</span></>}
      </button>
      {open && (
        <div className="ai-menu-popover" id={menuId} role="menu" aria-label={label} tabIndex={-1} ref={menuRef} onClick={onMenuClick} onKeyDown={onMenuKey}>
          {children}
        </div>
      )}
    </div>
  );
}
